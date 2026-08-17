use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::services::distro_bundle::DistroBundle;

const DISTRO_AGENTS_DIR_NAME: &str = "agents";
const GLOBAL_AGENTS_DIR_NAME: &str = ".agents";
const AGENTS_DIR_NAME: &str = "agents";
const MARKER_FILE_NAME: &str = ".berd-bundled-agents.json";
const LEGACY_MARKER_FILE_NAME: &str = ".goose-internal-bundled-agents.json";
#[cfg(test)]
const BERDY_AGENT_FILE_NAME: &str = "berdy.md";
#[cfg(test)]
const BERDY_FALLBACK_FILE_NAME: &str = "berdy2.md";
static INSTALL_TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);
const KNOWN_LEGACY_BUNDLED_DIGESTS: &[&str] = &[
    // Berdy shipped before allocation digests were recorded.
    "sha256:326302ecd09ba0e720f33537848900d0399e7c33098d3a10ca0596697952afce",
];

#[derive(Debug, Default, PartialEq, Eq)]
pub struct SeedBundledAgentsResult {
    pub seeded_count: usize,
    pub avatar_refs_to_warm: Vec<String>,
}

pub fn verified_managed_agent_allocations(
    target_root: Option<&Path>,
) -> Result<BTreeMap<String, String>, String> {
    let target_root = match target_root {
        Some(root) => root.to_path_buf(),
        None => dirs::home_dir()
            .ok_or_else(|| "Failed to resolve home directory for bundled agents".to_string())?
            .join(GLOBAL_AGENTS_DIR_NAME)
            .join(AGENTS_DIR_NAME),
    };
    let marker = read_seed_marker(&target_root)?;
    let mut verified = BTreeMap::new();
    for (source_file_name, allocation) in marker.allocations {
        let Some(expected_digest) = allocation.installed_digest else {
            continue;
        };
        let target = target_root.join(&allocation.target_file_name);
        if target.exists() && digest_file(&target)? == expected_digest {
            let source_id = source_file_name
                .strip_suffix(".md")
                .unwrap_or(&source_file_name)
                .to_string();
            verified.insert(target.to_string_lossy().into_owned(), source_id);
        }
    }
    Ok(verified)
}

#[derive(Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SeedMarker {
    #[serde(default)]
    seeded_files: BTreeSet<String>,
    #[serde(default, deserialize_with = "deserialize_allocations")]
    allocations: BTreeMap<String, AllocationRecord>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct AllocationRecord {
    target_file_name: String,
    #[serde(default)]
    installed_digest: Option<String>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum RawAllocationRecord {
    Legacy(String),
    Current(AllocationRecord),
}

fn deserialize_allocations<'de, D>(
    deserializer: D,
) -> Result<BTreeMap<String, AllocationRecord>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let raw = BTreeMap::<String, RawAllocationRecord>::deserialize(deserializer)?;
    Ok(raw
        .into_iter()
        .map(|(source, allocation)| {
            let allocation = match allocation {
                RawAllocationRecord::Legacy(target_file_name) => AllocationRecord {
                    target_file_name,
                    installed_digest: None,
                },
                RawAllocationRecord::Current(allocation) => allocation,
            };
            (source, allocation)
        })
        .collect())
}

#[derive(Deserialize)]
struct AgentFrontmatter {
    avatar: Option<String>,
    metadata: Option<AgentMetadata>,
}

#[derive(Deserialize)]
struct AgentMetadata {
    #[serde(rename = "berdBundled")]
    berd_bundled: Option<bool>,
    #[serde(rename = "gooseInternalBundled")]
    legacy_bundled: Option<bool>,
}

pub fn seed_bundled_agents(
    bundle: &DistroBundle,
    target_root: Option<&Path>,
) -> Result<SeedBundledAgentsResult, String> {
    let target_root = match target_root {
        Some(target_root) => target_root.to_path_buf(),
        None => {
            let Some(home_dir) = dirs::home_dir() else {
                return Err("Failed to resolve home directory for bundled agents".to_string());
            };
            home_dir.join(GLOBAL_AGENTS_DIR_NAME).join(AGENTS_DIR_NAME)
        }
    };

    seed_bundled_agents_from_dir(&bundle.root_dir.join(DISTRO_AGENTS_DIR_NAME), &target_root)
}

/// Explicitly restores one bundled agent after a user invokes a feature that
/// depends on it. Unlike startup seeding, this may restore a previously seeded
/// file that is now missing. It never overwrites an unmarked user-owned file.
pub fn repair_bundled_agent(
    bundle: &DistroBundle,
    target_root: Option<&Path>,
    file_name: &str,
) -> Result<(), String> {
    let target_root = match target_root {
        Some(target_root) => target_root.to_path_buf(),
        None => {
            let Some(home_dir) = dirs::home_dir() else {
                return Err("Failed to resolve home directory for bundled agents".to_string());
            };
            home_dir.join(GLOBAL_AGENTS_DIR_NAME).join(AGENTS_DIR_NAME)
        }
    };

    repair_bundled_agent_from_dir(
        &bundle.root_dir.join(DISTRO_AGENTS_DIR_NAME),
        &target_root,
        file_name,
    )
}

fn bundled_source_names(source_root: &Path) -> Result<BTreeSet<String>, String> {
    let mut names = BTreeSet::new();
    for entry in fs::read_dir(source_root).map_err(|error| {
        format!(
            "Failed to read bundled agents directory '{}': {error}",
            source_root.display()
        )
    })? {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        if path.extension().and_then(|extension| extension.to_str()) == Some("md") {
            let name = entry
                .file_name()
                .into_string()
                .map_err(|_| "Bundled agent filenames must be valid UTF-8".to_string())?;
            names.insert(name);
        }
    }
    Ok(names)
}

fn repair_bundled_agent_from_dir(
    source_root: &Path,
    target_root: &Path,
    file_name: &str,
) -> Result<(), String> {
    let source_name = Path::new(file_name);
    if source_name.file_name().and_then(|name| name.to_str()) != Some(file_name)
        || source_name.extension().and_then(|ext| ext.to_str()) != Some("md")
    {
        return Err("Bundled agent filename must be a plain .md filename".to_string());
    }

    let source = source_root.join(file_name);
    let source_metadata = fs::symlink_metadata(&source).map_err(|err| {
        format!(
            "Failed to access bundled agent '{}': {err}",
            source.display()
        )
    })?;
    if source_metadata.file_type().is_symlink() || !source_metadata.is_file() {
        return Err(format!(
            "Bundled agent '{}' must be a regular file",
            source.display()
        ));
    }
    if !is_installed_bundled_agent(&source)? {
        return Err(format!(
            "Bundled agent '{}' is missing its bundled marker",
            source.display()
        ));
    }

    let mut marker = read_seed_marker(target_root)?;
    let source_names = bundled_source_names(source_root)?;
    if marker.allocations.is_empty() {
        for source_name in &source_names {
            let fallback_name = fallback_file_name(source_name)?;
            let target_name = if marker.seeded_files.contains(&fallback_name)
                && matches!(
                    installed_agent_path_state(&target_root.join(&fallback_name))?,
                    InstalledAgentPathState::Bundled
                ) {
                fallback_name
            } else if marker.seeded_files.contains(source_name)
                && !matches!(
                    installed_agent_path_state(&target_root.join(source_name))?,
                    InstalledAgentPathState::UserOwned
                )
            {
                source_name.clone()
            } else {
                continue;
            };
            marker.allocations.insert(
                source_name.clone(),
                AllocationRecord {
                    target_file_name: target_name,
                    installed_digest: None,
                },
            );
        }
    }
    let claimed_targets = marker
        .allocations
        .values()
        .map(|allocation| allocation.target_file_name.clone())
        .collect::<BTreeSet<_>>();
    let target_file_name = match marker.allocations.get(file_name) {
        Some(allocation) => {
            let allocated_target = target_root.join(&allocation.target_file_name);
            let digest_changed = match allocation.installed_digest.as_ref() {
                Some(digest) => {
                    allocated_target.exists()
                        && digest_file(&allocated_target).ok().as_ref() != Some(digest)
                }
                None => {
                    allocated_target.exists()
                        && !files_are_equal(&source, &allocated_target).unwrap_or(false)
                        && digest_file(&allocated_target).ok().is_none_or(|digest| {
                            !KNOWN_LEGACY_BUNDLED_DIGESTS.contains(&digest.as_str())
                        })
                }
            };
            if digest_changed {
                allocate_agent_target(file_name, &source_names, &claimed_targets, target_root)?
                    .ok_or_else(|| {
                        format!(
                            "Cannot restore bundled agent '{file_name}': no safe target is available"
                        )
                    })?
            } else {
                match installed_agent_path_state(&allocated_target)? {
                    InstalledAgentPathState::Missing | InstalledAgentPathState::Bundled => {
                        allocation.target_file_name.clone()
                    }
                    InstalledAgentPathState::UserOwned => allocate_agent_target(
                        file_name,
                        &source_names,
                        &claimed_targets,
                        target_root,
                    )?
                    .ok_or_else(|| {
                        format!(
                            "Cannot restore bundled agent '{file_name}': no safe target is available"
                        )
                    })?,
                }
            }
        }
        None => allocate_agent_target(file_name, &source_names, &claimed_targets, target_root)?
            .ok_or_else(|| {
                format!("Cannot restore bundled agent '{file_name}': no safe target is available")
            })?,
    };
    let target = target_root.join(&target_file_name);
    install_agent_file(&source, &target)?;
    marker.allocations.insert(
        file_name.to_string(),
        AllocationRecord {
            target_file_name: target_file_name.clone(),
            installed_digest: Some(digest_file(&target)?),
        },
    );
    marker.seeded_files.insert(file_name.to_string());
    marker.seeded_files.insert(target_file_name);
    write_seed_marker(target_root, &marker)
}

#[derive(Debug, PartialEq, Eq)]
enum InstalledAgentPathState {
    Missing,
    Bundled,
    UserOwned,
}

fn installed_agent_path_state(path: &Path) -> Result<InstalledAgentPathState, String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => Err(format!(
            "Bundled agent target '{}' must not be a symbolic link",
            path.display()
        )),
        Ok(metadata) if !metadata.is_file() => Err(format!(
            "Bundled agent target '{}' must be a regular file",
            path.display()
        )),
        Ok(_) if is_installed_bundled_agent(path)? => Ok(InstalledAgentPathState::Bundled),
        Ok(_) => Ok(InstalledAgentPathState::UserOwned),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Ok(InstalledAgentPathState::Missing)
        }
        Err(error) => Err(format!(
            "Failed to inspect bundled agent target '{}': {error}",
            path.display()
        )),
    }
}

fn is_plain_agent_file_name(value: &str) -> bool {
    !value.is_empty()
        && value.ends_with(".md")
        && Path::new(value).file_name().and_then(|name| name.to_str()) == Some(value)
        && !value.contains('/')
        && !value.contains('\\')
}

fn digest_bytes(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}

fn digest_file(path: &Path) -> Result<String, String> {
    let bytes =
        fs::read(path).map_err(|error| format!("Failed to read '{}': {error}", path.display()))?;
    Ok(digest_bytes(&bytes))
}

fn fallback_file_name(file_name: &str) -> Result<String, String> {
    file_name
        .strip_suffix(".md")
        .map(|stem| format!("{stem}2.md"))
        .ok_or_else(|| "Bundled agent filename must end in .md".to_string())
}

fn allocate_agent_target(
    source_name: &str,
    source_names: &BTreeSet<String>,
    claimed_targets: &BTreeSet<String>,
    target_root: &Path,
) -> Result<Option<String>, String> {
    let stem = source_name
        .strip_suffix(".md")
        .ok_or_else(|| "Bundled agent filename must end in .md".to_string())?;
    for suffix in 1..=1_000 {
        let candidate = if suffix == 1 {
            source_name.to_string()
        } else {
            format!("{stem}{suffix}.md")
        };
        if claimed_targets.contains(&candidate)
            || (candidate != source_name && source_names.contains(&candidate))
        {
            continue;
        }
        if matches!(
            installed_agent_path_state(&target_root.join(&candidate))?,
            InstalledAgentPathState::Missing
        ) {
            return Ok(Some(candidate));
        }
    }
    Ok(None)
}

/// Extracts an agent file's `app-avatar:*` ref from its raw contents, if the
/// YAML frontmatter declares one. Keeps the `frontmatter -> yaml -> avatar ->
/// app-avatar:` prefix contract in a single place; callers layer their own
/// read-error handling on top.
fn avatar_ref_from_contents(contents: &str) -> Option<String> {
    agent_frontmatter(contents)
        .and_then(|frontmatter| yaml_serde::from_str::<AgentFrontmatter>(frontmatter).ok())
        .and_then(|frontmatter| frontmatter.avatar)
        .map(|value| value.trim().to_string())
        .filter(|value| value.starts_with("app-avatar:"))
}

fn seed_bundled_agents_from_dir(
    source_root: &Path,
    target_root: &Path,
) -> Result<SeedBundledAgentsResult, String> {
    if !source_root.is_dir() {
        return Ok(SeedBundledAgentsResult::default());
    }

    let mut entries = fs::read_dir(source_root)
        .map_err(|err| {
            format!(
                "Failed to read bundled agents directory '{}': {err}",
                source_root.display()
            )
        })?
        .map(|entry| {
            entry.map_err(|err| {
                format!(
                    "Failed to read bundled agents directory '{}': {err}",
                    source_root.display()
                )
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
    entries.sort_by_key(|entry| entry.file_name());

    let mut marker = read_seed_marker(target_root)?;
    let source_names = entries
        .iter()
        .filter_map(|entry| entry.file_name().into_string().ok())
        .filter(|name| name.ends_with(".md"))
        .collect::<BTreeSet<_>>();
    if marker.allocations.is_empty() {
        for source_name in &source_names {
            let fallback_name = fallback_file_name(source_name)?;
            let fallback_path = target_root.join(&fallback_name);
            let target_name = if marker.seeded_files.contains(&fallback_name)
                && matches!(
                    installed_agent_path_state(&fallback_path)?,
                    InstalledAgentPathState::Bundled
                ) {
                fallback_name
            } else if marker.seeded_files.contains(source_name)
                && !matches!(
                    installed_agent_path_state(&target_root.join(source_name))?,
                    InstalledAgentPathState::UserOwned
                )
            {
                source_name.clone()
            } else {
                continue;
            };
            marker.allocations.insert(
                source_name.clone(),
                AllocationRecord {
                    target_file_name: target_name,
                    installed_digest: None,
                },
            );
        }
    }
    let mut claimed_targets = marker
        .allocations
        .values()
        .map(|allocation| allocation.target_file_name.clone())
        .collect::<BTreeSet<_>>();
    let mut seeded_count = 0usize;
    let mut avatar_refs_to_warm = BTreeSet::new();

    for entry in entries {
        let source = entry.path();
        let metadata = fs::symlink_metadata(&source).map_err(|err| {
            format!(
                "Failed to inspect bundled agent path '{}': {err}",
                source.display()
            )
        })?;
        if metadata.file_type().is_symlink() {
            return Err(format!(
                "Bundled agent path '{}' must not be a symbolic link",
                source.display()
            ));
        }
        if !metadata.is_file() || source.extension().and_then(|value| value.to_str()) != Some("md")
        {
            continue;
        }

        let file_name = entry
            .file_name()
            .into_string()
            .map_err(|_| "Bundled agent filenames must be valid UTF-8".to_string())?;
        let mut existing_allocation = marker.allocations.get(&file_name).cloned();
        if let Some(allocation) = existing_allocation.as_ref() {
            let target = target_root.join(&allocation.target_file_name);
            let modified = match allocation.installed_digest.as_ref() {
                Some(digest) => {
                    target.exists() && digest_file(&target).ok().as_ref() != Some(digest)
                }
                None => {
                    target.exists()
                        && !files_are_equal(&source, &target).unwrap_or(false)
                        && digest_file(&target).ok().is_none_or(|digest| {
                            !KNOWN_LEGACY_BUNDLED_DIGESTS.contains(&digest.as_str())
                        })
                }
            };
            if modified {
                // Keep the edited target claimed so the allocator preserves it
                // and installs the current bundled source at a distinct path.
                existing_allocation = None;
            }
        }
        let target_file_name = match existing_allocation.as_ref() {
            Some(allocation) => allocation.target_file_name.clone(),
            None => match allocate_agent_target(
                &file_name,
                &source_names,
                &claimed_targets,
                target_root,
            )? {
                Some(target) => target,
                None => continue,
            },
        };
        claimed_targets.insert(target_file_name.clone());
        let target = target_root.join(&target_file_name);
        let was_previously_seeded =
            existing_allocation.is_some() || marker.seeded_files.contains(&target_file_name);
        let installed_or_refreshed =
            if should_install_agent(&source, &target, was_previously_seeded)? {
                install_agent_file(&source, &target)?;
                seeded_count += 1;
                true
            } else {
                false
            };
        let target_is_bundled = target.exists() && is_installed_bundled_agent(&target)?;

        if (installed_or_refreshed || was_previously_seeded) && target_is_bundled {
            if let Some(avatar_ref) = source_agent_avatar_ref(&source)? {
                avatar_refs_to_warm.insert(avatar_ref);
            }
        }
        if target_is_bundled {
            marker.allocations.insert(
                file_name.clone(),
                AllocationRecord {
                    target_file_name: target_file_name.clone(),
                    installed_digest: Some(digest_file(&target)?),
                },
            );
            marker.seeded_files.insert(file_name);
            marker.seeded_files.insert(target_file_name);
        }
    }

    if !marker.seeded_files.is_empty() {
        write_seed_marker(target_root, &marker)?;
    }

    Ok(SeedBundledAgentsResult {
        seeded_count,
        avatar_refs_to_warm: avatar_refs_to_warm.into_iter().collect(),
    })
}

fn should_install_agent(
    source: &Path,
    target: &Path,
    was_previously_seeded: bool,
) -> Result<bool, String> {
    if !target.exists() {
        return Ok(!was_previously_seeded);
    }
    if !was_previously_seeded {
        return Ok(false);
    }
    if !is_installed_bundled_agent(target)? {
        return Ok(false);
    }

    Ok(!files_are_equal(source, target)?)
}

fn is_installed_bundled_agent(agent_file: &Path) -> Result<bool, String> {
    let metadata = fs::symlink_metadata(agent_file).map_err(|err| {
        format!(
            "Failed to inspect installed agent path '{}': {err}",
            agent_file.display()
        )
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Ok(false);
    }

    let contents = match fs::read_to_string(agent_file) {
        Ok(contents) => contents,
        Err(err) if err.kind() == std::io::ErrorKind::InvalidData => return Ok(false),
        Err(err) => {
            return Err(format!(
                "Failed to read installed agent '{}': {err}",
                agent_file.display()
            ));
        }
    };

    Ok(agent_frontmatter(&contents)
        .and_then(|frontmatter| yaml_serde::from_str::<AgentFrontmatter>(frontmatter).ok())
        .and_then(|frontmatter| frontmatter.metadata)
        .map(|metadata| {
            metadata.berd_bundled.unwrap_or(false) || metadata.legacy_bundled.unwrap_or(false)
        })
        .unwrap_or(false))
}

fn files_are_equal(left: &Path, right: &Path) -> Result<bool, String> {
    let left_bytes =
        fs::read(left).map_err(|err| format!("Failed to read '{}': {err}", left.display()))?;
    let right_bytes =
        fs::read(right).map_err(|err| format!("Failed to read '{}': {err}", right.display()))?;
    Ok(left_bytes == right_bytes)
}

fn source_agent_avatar_ref(agent_file: &Path) -> Result<Option<String>, String> {
    let contents = fs::read_to_string(agent_file).map_err(|err| {
        format!(
            "Failed to read bundled agent '{}': {err}",
            agent_file.display()
        )
    })?;

    Ok(avatar_ref_from_contents(&contents))
}

fn agent_frontmatter(contents: &str) -> Option<&str> {
    let contents = contents.strip_prefix("---\n")?;
    let end = contents.find("\n---")?;
    Some(&contents[..end])
}

fn install_agent_file(source: &Path, target: &Path) -> Result<(), String> {
    let parent = target
        .parent()
        .ok_or_else(|| "Bundled agent target has no parent".to_string())?;
    fs::create_dir_all(parent).map_err(|err| {
        format!(
            "Failed to create agents directory '{}': {err}",
            parent.display()
        )
    })?;

    if !matches!(
        installed_agent_path_state(target)?,
        InstalledAgentPathState::Missing | InstalledAgentPathState::Bundled
    ) {
        return Err(format!(
            "Cannot install bundled agent over user-owned file '{}'",
            target.display()
        ));
    }

    let contents =
        fs::read(source).map_err(|err| format!("Failed to read '{}': {err}", source.display()))?;
    let sequence = INSTALL_TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let temp_path = parent.join(format!(
        ".berd-agent-install-{}-{sequence}.tmp",
        std::process::id()
    ));
    let install_result = (|| -> Result<(), String> {
        let mut temp = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp_path)
            .map_err(|err| {
                format!(
                    "Failed to create temporary bundled agent '{}': {err}",
                    temp_path.display()
                )
            })?;
        temp.write_all(&contents).map_err(|err| {
            format!(
                "Failed to write temporary bundled agent '{}': {err}",
                temp_path.display()
            )
        })?;
        temp.sync_all().map_err(|err| {
            format!(
                "Failed to sync temporary bundled agent '{}': {err}",
                temp_path.display()
            )
        })?;
        match installed_agent_path_state(target)? {
            InstalledAgentPathState::Missing | InstalledAgentPathState::Bundled => {}
            InstalledAgentPathState::UserOwned => {
                return Err(format!(
                    "Cannot install bundled agent over user-owned file '{}'",
                    target.display()
                ));
            }
        }
        fs::rename(&temp_path, target).map_err(|err| {
            format!(
                "Failed to install bundled agent '{}' at '{}': {err}",
                source.display(),
                target.display()
            )
        })
    })();
    if install_result.is_err() {
        let _ = fs::remove_file(&temp_path);
    }
    install_result
}

fn marker_path(target_root: &Path) -> PathBuf {
    target_root.join(MARKER_FILE_NAME)
}

fn legacy_marker_path(target_root: &Path) -> PathBuf {
    target_root.join(LEGACY_MARKER_FILE_NAME)
}

fn read_seed_marker(target_root: &Path) -> Result<SeedMarker, String> {
    let path = marker_path(target_root);
    if path.exists() {
        return read_seed_marker_file(&path);
    }

    let legacy_path = legacy_marker_path(target_root);
    if legacy_path.exists() {
        return read_seed_marker_file(&legacy_path);
    }

    Ok(SeedMarker::default())
}

fn read_seed_marker_file(path: &Path) -> Result<SeedMarker, String> {
    let contents = fs::read_to_string(path).map_err(|err| {
        format!(
            "Failed to read bundled agent marker '{}': {err}",
            path.display()
        )
    })?;
    let mut marker = serde_json::from_str::<SeedMarker>(&contents).map_err(|err| {
        format!(
            "Failed to parse bundled agent marker '{}': {err}",
            path.display()
        )
    })?;
    let mut seen_targets = BTreeSet::new();
    marker.allocations.retain(|source, allocation| {
        is_plain_agent_file_name(source)
            && is_plain_agent_file_name(&allocation.target_file_name)
            && seen_targets.insert(allocation.target_file_name.clone())
    });
    Ok(marker)
}

fn write_seed_marker(target_root: &Path, marker: &SeedMarker) -> Result<(), String> {
    fs::create_dir_all(target_root).map_err(|err| {
        format!(
            "Failed to create agents directory '{}': {err}",
            target_root.display()
        )
    })?;
    let path = marker_path(target_root);
    let contents = serde_json::to_vec_pretty(marker)
        .map_err(|err| format!("Failed to serialize bundled agent marker: {err}"))?;
    fs::write(&path, contents).map_err(|err| {
        format!(
            "Failed to write bundled agent marker '{}': {err}",
            path.display()
        )
    })?;

    let legacy_path = legacy_marker_path(target_root);
    if legacy_path.exists() {
        let _ = fs::remove_file(legacy_path);
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn write_agent(root: &Path, name: &str, contents: &str) {
        fs::create_dir_all(root).unwrap();
        fs::write(root.join(name), contents).unwrap();
    }

    #[test]
    fn seeds_missing_bundled_agent() {
        let source = tempdir().unwrap();
        let target = tempdir().unwrap();
        write_agent(
            source.path(),
            "builderbot.md",
            "---\nname: Builderbot\ndescription: Agent\navatar: app-avatar:gloopies-20\nmetadata:\n  berdBundled: true\n---\nBuild carefully.",
        );

        let result = seed_bundled_agents_from_dir(source.path(), target.path()).unwrap();

        assert_eq!(result.seeded_count, 1);
        assert_eq!(result.avatar_refs_to_warm, vec!["app-avatar:gloopies-20"]);
        assert_eq!(
            fs::read_to_string(target.path().join("builderbot.md")).unwrap(),
            "---\nname: Builderbot\ndescription: Agent\navatar: app-avatar:gloopies-20\nmetadata:\n  berdBundled: true\n---\nBuild carefully."
        );
    }

    #[test]
    fn migrates_a_legacy_collision_to_a_safe_fallback() {
        let source = tempdir().unwrap();
        let target = tempdir().unwrap();
        let bundled = "---\nname: Berdy\nmetadata:\n  berdBundled: true\n---\nBundled.";
        write_agent(source.path(), "berdy.md", bundled);
        write_agent(target.path(), "berdy.md", "---\nname: Mine\n---\nPersonal.");
        fs::write(
            marker_path(target.path()),
            r#"{ "seededFiles": ["berdy.md"] }"#,
        )
        .unwrap();

        seed_bundled_agents_from_dir(source.path(), target.path()).unwrap();

        assert_eq!(
            fs::read_to_string(target.path().join("berdy.md")).unwrap(),
            "---\nname: Mine\n---\nPersonal."
        );
        assert_eq!(
            fs::read_to_string(target.path().join("berdy2.md")).unwrap(),
            bundled
        );
        assert_eq!(
            read_seed_marker(target.path())
                .unwrap()
                .allocations
                .get("berdy.md")
                .map(|allocation| allocation.target_file_name.as_str()),
            Some("berdy2.md")
        );
    }

    #[test]
    fn startup_uses_a_fallback_for_any_user_owned_bundled_agent_name() {
        let source = tempdir().unwrap();
        let target = tempdir().unwrap();
        let bundled = "---\nname: Tinker\nmetadata:\n  berdBundled: true\n---\nBundled.";
        write_agent(source.path(), "tinker.md", bundled);
        write_agent(
            target.path(),
            "tinker.md",
            "---\nname: Personal Tinker\n---\nPersonal.",
        );

        let result = seed_bundled_agents_from_dir(source.path(), target.path()).unwrap();

        assert_eq!(result.seeded_count, 1);
        assert_eq!(
            fs::read_to_string(target.path().join("tinker.md")).unwrap(),
            "---\nname: Personal Tinker\n---\nPersonal."
        );
        assert_eq!(
            fs::read_to_string(target.path().join("tinker2.md")).unwrap(),
            bundled
        );
        let marker = read_seed_marker(target.path()).unwrap();
        assert!(marker.seeded_files.contains("tinker.md"));
        assert!(marker.seeded_files.contains("tinker2.md"));
    }

    #[test]
    fn startup_keeps_refreshing_a_seeded_fallback_after_primary_is_removed() {
        let source = tempdir().unwrap();
        let target = tempdir().unwrap();
        write_agent(
            source.path(),
            "tinker.md",
            "---\nname: Tinker\nmetadata:\n  berdBundled: true\n---\nVersion one.",
        );
        write_agent(
            target.path(),
            "tinker.md",
            "---\nname: Mine\n---\nPersonal.",
        );
        seed_bundled_agents_from_dir(source.path(), target.path()).unwrap();
        fs::remove_file(target.path().join("tinker.md")).unwrap();
        write_agent(
            source.path(),
            "tinker.md",
            "---\nname: Tinker\nmetadata:\n  berdBundled: true\n---\nVersion two.",
        );

        let result = seed_bundled_agents_from_dir(source.path(), target.path()).unwrap();

        assert_eq!(result.seeded_count, 1);
        assert!(!target.path().join("tinker.md").exists());
        assert_eq!(
            fs::read_to_string(target.path().join("tinker2.md")).unwrap(),
            "---\nname: Tinker\nmetadata:\n  berdBundled: true\n---\nVersion two."
        );
    }

    #[test]
    fn allocates_distinct_targets_when_a_fallback_matches_another_source() {
        let source = tempdir().unwrap();
        let target = tempdir().unwrap();
        let foo = "---\nname: Foo\nmetadata:\n  berdBundled: true\n---\nFoo bundled.";
        let foo_two = "---\nname: Foo Two\nmetadata:\n  berdBundled: true\n---\nFoo two bundled.";
        write_agent(source.path(), "foo.md", foo);
        write_agent(source.path(), "foo2.md", foo_two);
        write_agent(target.path(), "foo.md", "---\nname: Mine\n---\nPersonal.");

        let result = seed_bundled_agents_from_dir(source.path(), target.path()).unwrap();

        assert_eq!(result.seeded_count, 2);
        assert_eq!(
            fs::read_to_string(target.path().join("foo2.md")).unwrap(),
            foo_two
        );
        assert_eq!(
            fs::read_to_string(target.path().join("foo3.md")).unwrap(),
            foo
        );
        let marker = read_seed_marker(target.path()).unwrap();
        assert_eq!(
            marker
                .allocations
                .get("foo.md")
                .map(|allocation| allocation.target_file_name.as_str()),
            Some("foo3.md")
        );
        assert_eq!(
            marker
                .allocations
                .get("foo2.md")
                .map(|allocation| allocation.target_file_name.as_str()),
            Some("foo2.md")
        );
    }

    #[test]
    fn allocates_the_next_safe_name_when_earlier_names_are_user_owned() {
        let source = tempdir().unwrap();
        let target = tempdir().unwrap();
        let bundled = "---\nname: Tinker\nmetadata:\n  berdBundled: true\n---\nBundled.";
        write_agent(source.path(), "tinker.md", bundled);
        write_agent(
            target.path(),
            "tinker.md",
            "---\nname: Mine\n---\nPersonal.",
        );
        write_agent(
            target.path(),
            "tinker2.md",
            "---\nname: Mine 2\n---\nPersonal.",
        );

        let result = seed_bundled_agents_from_dir(source.path(), target.path()).unwrap();

        assert_eq!(result.seeded_count, 1);
        let marker = read_seed_marker(target.path()).unwrap();
        assert_eq!(
            marker
                .allocations
                .get("tinker.md")
                .map(|allocation| allocation.target_file_name.as_str()),
            Some("tinker3.md")
        );
        assert_eq!(
            fs::read_to_string(target.path().join("tinker3.md")).unwrap(),
            bundled
        );
        assert_eq!(
            fs::read_to_string(target.path().join("tinker2.md")).unwrap(),
            "---\nname: Mine 2\n---\nPersonal."
        );
    }

    #[test]
    fn explicitly_repairs_a_deleted_seeded_agent() {
        let source = tempdir().unwrap();
        let target = tempdir().unwrap();
        let contents = "---\nname: Berdy\ndescription: Agent\nmetadata:\n  berdBundled: true\n---\nHelp carefully.";
        write_agent(source.path(), "berdy.md", contents);

        seed_bundled_agents_from_dir(source.path(), target.path()).unwrap();
        fs::remove_file(target.path().join("berdy.md")).unwrap();

        repair_bundled_agent_from_dir(source.path(), target.path(), "berdy.md").unwrap();

        assert_eq!(
            fs::read_to_string(target.path().join("berdy.md")).unwrap(),
            contents
        );
    }

    #[test]
    fn explicit_repair_uses_a_fallback_for_an_unmarked_user_agent() {
        let source = tempdir().unwrap();
        let target = tempdir().unwrap();
        write_agent(
            source.path(),
            "berdy.md",
            "---\nname: Berdy\nmetadata:\n  berdBundled: true\n---\nBundled.",
        );
        write_agent(target.path(), "berdy.md", "---\nname: Mine\n---\nPersonal.");

        repair_bundled_agent_from_dir(source.path(), target.path(), "berdy.md").unwrap();

        assert_eq!(
            fs::read_to_string(target.path().join("berdy.md")).unwrap(),
            "---\nname: Mine\n---\nPersonal."
        );
        assert_eq!(
            fs::read_to_string(target.path().join("berdy2.md")).unwrap(),
            "---\nname: Berdy\nmetadata:\n  berdBundled: true\n---\nBundled."
        );
    }

    #[test]
    fn explicit_repair_preserves_a_digestless_legacy_edit() {
        let source = tempdir().unwrap();
        let target = tempdir().unwrap();
        let bundled = "---\nname: Berdy\nmetadata:\n  berdBundled: true\n---\nCurrent.";
        let edited = "---\nname: Berdy\nmetadata:\n  berdBundled: true\n---\nEdited.";
        write_agent(source.path(), "berdy.md", bundled);
        write_agent(target.path(), "berdy.md", edited);
        fs::write(
            marker_path(target.path()),
            r#"{ "allocations": { "berdy.md": "berdy.md" } }"#,
        )
        .unwrap();

        repair_bundled_agent_from_dir(source.path(), target.path(), "berdy.md").unwrap();

        assert_eq!(
            fs::read_to_string(target.path().join("berdy.md")).unwrap(),
            edited
        );
        assert_eq!(
            fs::read_to_string(target.path().join("berdy2.md")).unwrap(),
            bundled
        );
    }

    #[test]
    fn unallocated_marker_bearing_fallback_is_never_adopted() {
        let source = tempdir().unwrap();
        let target = tempdir().unwrap();
        let bundled = "---\nname: Tinker\nmetadata:\n  berdBundled: true\n---\nCurrent.";
        let copied = "---\nname: Copy\nmetadata:\n  berdBundled: true\n---\nCustomized.";
        write_agent(source.path(), "tinker.md", bundled);
        write_agent(
            target.path(),
            "tinker.md",
            "---\nname: Mine\n---\nPersonal.",
        );
        write_agent(target.path(), "tinker2.md", copied);

        seed_bundled_agents_from_dir(source.path(), target.path()).unwrap();

        assert_eq!(
            fs::read_to_string(target.path().join("tinker2.md")).unwrap(),
            copied
        );
        assert_eq!(
            fs::read_to_string(target.path().join("tinker3.md")).unwrap(),
            bundled
        );
    }

    #[test]
    fn explicit_repair_keeps_using_a_seeded_fallback_after_primary_is_removed() {
        let source = tempdir().unwrap();
        let target = tempdir().unwrap();
        let bundled = "---\nname: Berdy\nmetadata:\n  berdBundled: true\n---\nBundled.";
        write_agent(source.path(), BERDY_AGENT_FILE_NAME, bundled);
        write_agent(
            target.path(),
            BERDY_AGENT_FILE_NAME,
            "---\nname: Personal Berdy\n---\nPersonal.",
        );
        repair_bundled_agent_from_dir(source.path(), target.path(), BERDY_AGENT_FILE_NAME).unwrap();
        fs::remove_file(target.path().join(BERDY_AGENT_FILE_NAME)).unwrap();

        repair_bundled_agent_from_dir(source.path(), target.path(), BERDY_AGENT_FILE_NAME).unwrap();

        assert!(!target.path().join(BERDY_AGENT_FILE_NAME).exists());
        assert_eq!(
            fs::read_to_string(target.path().join(BERDY_FALLBACK_FILE_NAME)).unwrap(),
            bundled
        );
    }

    #[test]
    fn startup_refreshes_the_repaired_fallback_without_touching_the_user_agent() {
        let source = tempdir().unwrap();
        let target = tempdir().unwrap();
        write_agent(
            source.path(),
            BERDY_AGENT_FILE_NAME,
            "---\nname: Berdy\nmetadata:\n  berdBundled: true\n---\nVersion one.",
        );
        write_agent(
            target.path(),
            BERDY_AGENT_FILE_NAME,
            "---\nname: Personal Berdy\n---\nPersonal.",
        );
        repair_bundled_agent_from_dir(source.path(), target.path(), BERDY_AGENT_FILE_NAME).unwrap();
        write_agent(
            source.path(),
            BERDY_AGENT_FILE_NAME,
            "---\nname: Berdy\nmetadata:\n  berdBundled: true\n---\nVersion two.",
        );

        let result = seed_bundled_agents_from_dir(source.path(), target.path()).unwrap();

        assert_eq!(result.seeded_count, 1);
        assert_eq!(
            fs::read_to_string(target.path().join(BERDY_AGENT_FILE_NAME)).unwrap(),
            "---\nname: Personal Berdy\n---\nPersonal."
        );
        assert_eq!(
            fs::read_to_string(target.path().join(BERDY_FALLBACK_FILE_NAME)).unwrap(),
            "---\nname: Berdy\nmetadata:\n  berdBundled: true\n---\nVersion two."
        );
    }

    #[cfg(unix)]
    #[test]
    fn explicit_repair_rejects_a_broken_primary_symlink() {
        let source = tempdir().unwrap();
        let target = tempdir().unwrap();
        let outside = tempdir().unwrap().path().join("outside.md");
        write_agent(
            source.path(),
            BERDY_AGENT_FILE_NAME,
            "---\nname: Berdy\nmetadata:\n  berdBundled: true\n---\nBundled.",
        );
        std::os::unix::fs::symlink(&outside, target.path().join(BERDY_AGENT_FILE_NAME)).unwrap();

        let error =
            repair_bundled_agent_from_dir(source.path(), target.path(), BERDY_AGENT_FILE_NAME)
                .unwrap_err();

        assert!(error.contains("must not be a symbolic link"));
        assert!(!outside.exists());
    }

    #[cfg(unix)]
    #[test]
    fn explicit_repair_rejects_a_broken_fallback_symlink() {
        let source = tempdir().unwrap();
        let target = tempdir().unwrap();
        let outside_dir = tempdir().unwrap();
        let outside = outside_dir.path().join("outside.md");
        write_agent(
            source.path(),
            BERDY_AGENT_FILE_NAME,
            "---\nname: Berdy\nmetadata:\n  berdBundled: true\n---\nBundled.",
        );
        write_agent(
            target.path(),
            BERDY_AGENT_FILE_NAME,
            "---\nname: Personal Berdy\n---\nPersonal.",
        );
        std::os::unix::fs::symlink(&outside, target.path().join(BERDY_FALLBACK_FILE_NAME)).unwrap();

        let error =
            repair_bundled_agent_from_dir(source.path(), target.path(), BERDY_AGENT_FILE_NAME)
                .unwrap_err();

        assert!(error.contains("must not be a symbolic link"));
        assert!(!outside.exists());
    }

    #[test]
    fn preserves_deleted_seeded_agent() {
        let source = tempdir().unwrap();
        let target = tempdir().unwrap();
        write_agent(
            source.path(),
            "builderbot.md",
            "---\nname: Builderbot\ndescription: Agent\nmetadata:\n  berdBundled: true\n---\nBuild carefully.",
        );

        seed_bundled_agents_from_dir(source.path(), target.path()).unwrap();
        fs::remove_file(target.path().join("builderbot.md")).unwrap();

        let result = seed_bundled_agents_from_dir(source.path(), target.path()).unwrap();

        assert_eq!(result.seeded_count, 0);
        assert!(result.avatar_refs_to_warm.is_empty());
        assert!(!target.path().join("builderbot.md").exists());
    }

    #[test]
    fn reads_and_migrates_legacy_seed_marker() {
        let source = tempdir().unwrap();
        let target = tempdir().unwrap();
        write_agent(
            source.path(),
            "builderbot.md",
            "---\nname: Builderbot\ndescription: Agent\nmetadata:\n  berdBundled: true\n---\nBundled.",
        );
        fs::write(
            target.path().join(LEGACY_MARKER_FILE_NAME),
            "{\"seededFiles\":[\"builderbot.md\"]}",
        )
        .unwrap();

        let result = seed_bundled_agents_from_dir(source.path(), target.path()).unwrap();

        assert_eq!(result.seeded_count, 0);
        assert!(!target.path().join("builderbot.md").exists());
        assert!(target.path().join(MARKER_FILE_NAME).exists());
        assert!(!target.path().join(LEGACY_MARKER_FILE_NAME).exists());
    }

    #[test]
    fn preserves_existing_user_agent_and_seeds_bundled_fallback() {
        let source = tempdir().unwrap();
        let target = tempdir().unwrap();
        write_agent(
            source.path(),
            "builderbot.md",
            "---\nname: Builderbot\ndescription: Agent\nmetadata:\n  berdBundled: true\n---\nBundled.",
        );
        write_agent(
            target.path(),
            "builderbot.md",
            "---\nname: Builderbot\ndescription: Agent\n---\nUser edited.",
        );

        let result = seed_bundled_agents_from_dir(source.path(), target.path()).unwrap();

        assert_eq!(result.seeded_count, 1);
        assert_eq!(
            fs::read_to_string(target.path().join("builderbot.md")).unwrap(),
            "---\nname: Builderbot\ndescription: Agent\n---\nUser edited."
        );
        assert!(target.path().join("builderbot2.md").exists());

        fs::remove_file(target.path().join("builderbot.md")).unwrap();
        let second_result = seed_bundled_agents_from_dir(source.path(), target.path()).unwrap();

        assert_eq!(second_result.seeded_count, 0);
        assert!(target.path().join("builderbot2.md").exists());
    }

    #[test]
    fn preserves_unreadable_user_agent_and_seeds_bundled_fallback() {
        let source = tempdir().unwrap();
        let target = tempdir().unwrap();
        write_agent(
            source.path(),
            "builderbot.md",
            "---\nname: Builderbot\ndescription: Agent\navatar: app-avatar:gloopies-20\nmetadata:\n  berdBundled: true\n---\nBundled.",
        );
        fs::create_dir_all(target.path()).unwrap();
        fs::write(target.path().join("builderbot.md"), [0xff]).unwrap();

        let result = seed_bundled_agents_from_dir(source.path(), target.path()).unwrap();

        assert_eq!(result.seeded_count, 1);
        assert_eq!(
            fs::read(target.path().join("builderbot.md")).unwrap(),
            [0xff]
        );
        assert!(target.path().join("builderbot2.md").exists());

        let second_result = seed_bundled_agents_from_dir(source.path(), target.path()).unwrap();
        assert_eq!(second_result.seeded_count, 0);
    }

    #[test]
    fn preserves_edited_seeded_agent_and_installs_a_fresh_bundle_copy() {
        let source = tempdir().unwrap();
        let target = tempdir().unwrap();
        write_agent(
            source.path(),
            "builderbot.md",
            "---\nname: Builderbot\ndescription: Agent\nmetadata:\n  berdBundled: true\n---\nOriginal.",
        );

        seed_bundled_agents_from_dir(source.path(), target.path()).unwrap();
        fs::write(
            target.path().join("builderbot.md"),
            "---\nname: Builderbot\ndescription: Agent\nmetadata:\n  berdBundled: true\n---\nUser edited.",
        )
        .unwrap();

        let result = seed_bundled_agents_from_dir(source.path(), target.path()).unwrap();

        assert_eq!(result.seeded_count, 1);
        assert_eq!(
            fs::read_to_string(target.path().join("builderbot.md")).unwrap(),
            "---\nname: Builderbot\ndescription: Agent\nmetadata:\n  berdBundled: true\n---\nUser edited."
        );
        assert_eq!(
            fs::read_to_string(target.path().join("builderbot2.md")).unwrap(),
            "---\nname: Builderbot\ndescription: Agent\nmetadata:\n  berdBundled: true\n---\nOriginal."
        );
    }

    #[test]
    fn preserves_a_digestless_legacy_edit_and_allocates_current_bundle() {
        let source = tempdir().unwrap();
        let target = tempdir().unwrap();
        let bundled = "---\nname: Builderbot\nmetadata:\n  berdBundled: true\n---\nCurrent.";
        let edited = "---\nname: Builderbot\nmetadata:\n  berdBundled: true\n---\nUser edited.";
        write_agent(source.path(), "builderbot.md", bundled);
        write_agent(target.path(), "builderbot.md", edited);
        fs::write(
            marker_path(target.path()),
            r#"{
              "seededFiles": ["builderbot.md"],
              "allocations": { "builderbot.md": "builderbot.md" }
            }"#,
        )
        .unwrap();

        seed_bundled_agents_from_dir(source.path(), target.path()).unwrap();

        assert_eq!(
            fs::read_to_string(target.path().join("builderbot.md")).unwrap(),
            edited
        );
        assert_eq!(
            fs::read_to_string(target.path().join("builderbot2.md")).unwrap(),
            bundled
        );
    }

    #[test]
    fn ignores_unsafe_and_duplicate_marker_allocations() {
        let target = tempdir().unwrap();
        let outside = target.path().parent().unwrap().join("outside.md");
        fs::write(
            marker_path(target.path()),
            r#"{
              "allocations": {
                "berdy.md": { "targetFileName": "../outside.md" },
                "tinker.md": { "targetFileName": "/tmp/outside.md" },
                "wildcard.md": { "targetFileName": "shared.md" },
                "choosey.md": { "targetFileName": "shared.md" }
              }
            }"#,
        )
        .unwrap();

        let marker = read_seed_marker(target.path()).unwrap();

        assert!(!outside.exists());
        assert!(!marker.allocations.contains_key("berdy.md"));
        assert!(!marker.allocations.contains_key("tinker.md"));
        assert_eq!(marker.allocations.len(), 1);
    }

    #[test]
    fn recognizes_legacy_bundled_agent_marker() {
        let target = tempdir().unwrap();
        write_agent(
            target.path(),
            "builderbot.md",
            "---\nname: Builderbot\ndescription: Agent\nmetadata:\n  gooseInternalBundled: true\n---\nOriginal.",
        );

        assert!(is_installed_bundled_agent(&target.path().join("builderbot.md")).unwrap());
    }

    #[test]
    fn skips_unchanged_seeded_agent() {
        let source = tempdir().unwrap();
        let target = tempdir().unwrap();
        write_agent(
            source.path(),
            "builderbot.md",
            "---\nname: Builderbot\ndescription: Agent\navatar: app-avatar:gloopies-20\nmetadata:\n  berdBundled: true\n---\nOriginal.",
        );

        seed_bundled_agents_from_dir(source.path(), target.path()).unwrap();
        let result = seed_bundled_agents_from_dir(source.path(), target.path()).unwrap();

        assert_eq!(result.seeded_count, 0);
        assert_eq!(result.avatar_refs_to_warm, vec!["app-avatar:gloopies-20"]);
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinked_agent_source() {
        let source = tempdir().unwrap();
        let target = tempdir().unwrap();
        fs::write(source.path().join("outside.md"), "outside").unwrap();
        std::os::unix::fs::symlink(
            source.path().join("outside.md"),
            source.path().join("builderbot.md"),
        )
        .unwrap();

        let err = seed_bundled_agents_from_dir(source.path(), target.path()).unwrap_err();

        assert!(err.contains("must not be a symbolic link"));
    }
}
