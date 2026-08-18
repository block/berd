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
static INSTALL_TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Default, PartialEq, Eq)]
pub struct SeedBundledAgentsResult {
    pub seeded_count: usize,
    pub avatar_refs_to_warm: Vec<String>,
}

#[derive(Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SeedMarker {
    #[serde(default)]
    version: u32,
    #[serde(default)]
    install_state: InstallState,
    // Retained only so pre-manifest installations deserialize and fail closed.
    #[serde(default, skip_serializing_if = "BTreeSet::is_empty")]
    seeded_files: BTreeSet<String>,
    #[serde(default)]
    allocations: BTreeMap<String, AllocationRecord>,
}

#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum InstallState {
    #[default]
    Installing,
    Complete,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum AllocationStatus {
    Pending,
    Installed,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct AllocationRecord {
    target_file_name: String,
    installed_digest: String,
    status: AllocationStatus,
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

pub fn verified_managed_agent_allocations(
    bundle: &DistroBundle,
    target_root: Option<&Path>,
) -> Result<BTreeMap<String, String>, String> {
    let target_root = resolve_target_root(target_root)?;
    let marker = match read_current_seed_marker(&target_root)? {
        Some(marker) => marker,
        None => return Ok(BTreeMap::new()),
    };
    let source_root = bundle.root_dir.join(DISTRO_AGENTS_DIR_NAME);
    let mut verified = BTreeMap::new();
    for (source_name, allocation) in marker.allocations {
        if allocation.status != AllocationStatus::Installed {
            continue;
        }
        let source = source_root.join(&source_name);
        let target = target_root.join(&allocation.target_file_name);
        let metadata = match fs::symlink_metadata(&target) {
            Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => metadata,
            _ => continue,
        };
        let _ = metadata;
        if source.is_file() && regular_file_matches_digest(&target, &allocation.installed_digest)? {
            verified.insert(
                target.to_string_lossy().into_owned(),
                source_name.trim_end_matches(".md").to_string(),
            );
        }
    }
    Ok(verified)
}

fn resolve_target_root(target_root: Option<&Path>) -> Result<PathBuf, String> {
    match target_root {
        Some(root) => Ok(root.to_path_buf()),
        None => dirs::home_dir()
            .map(|home| home.join(GLOBAL_AGENTS_DIR_NAME).join(AGENTS_DIR_NAME))
            .ok_or_else(|| "Failed to resolve home directory for bundled agents".to_string()),
    }
}

pub fn seed_bundled_agents(
    bundle: &DistroBundle,
    target_root: Option<&Path>,
) -> Result<SeedBundledAgentsResult, String> {
    let target_root = resolve_target_root(target_root)?;

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
    let target_root = resolve_target_root(target_root)?;

    repair_bundled_agent_from_dir(
        &bundle.root_dir.join(DISTRO_AGENTS_DIR_NAME),
        &target_root,
        file_name,
    )
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

    let mut marker = read_current_seed_marker(target_root)?
        .filter(|marker| marker.version == 1)
        .ok_or_else(|| {
            "Bundled agent repair requires a valid managed allocation manifest".to_string()
        })?;
    let source_digest = digest_file(&source)?;
    let allocation = marker.allocations.get(file_name).cloned().ok_or_else(|| {
        format!("Bundled agent '{file_name}' has no managed allocation to repair")
    })?;
    if allocation.status != AllocationStatus::Installed {
        return Err(format!(
            "Bundled agent '{file_name}' repair is already pending"
        ));
    }
    let target = target_root.join(&allocation.target_file_name);
    match fs::symlink_metadata(&target) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => {
            return Err(format!(
                "Bundled agent '{}' was customized and requires an explicit restore decision",
                target.display()
            ));
        }
        Ok(_) => {
            return Err(format!(
                "Bundled agent target '{}' is occupied and cannot be repaired",
                target.display()
            ));
        }
        Err(error) => {
            return Err(format!(
                "Failed to inspect bundled agent target '{}': {error}",
                target.display()
            ));
        }
    }

    marker.allocations.get_mut(file_name).unwrap().status = AllocationStatus::Pending;
    marker
        .allocations
        .get_mut(file_name)
        .unwrap()
        .installed_digest = source_digest.clone();
    marker.install_state = InstallState::Installing;
    write_seed_marker(target_root, &marker)?;
    install_agent_file(&source, &target)?;
    marker.allocations.get_mut(file_name).unwrap().status = AllocationStatus::Installed;
    marker.install_state = if marker
        .allocations
        .values()
        .all(|record| record.status == AllocationStatus::Installed)
    {
        InstallState::Complete
    } else {
        InstallState::Installing
    };
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

fn is_plain_markdown_filename(value: &str) -> bool {
    let path = Path::new(value);
    path.file_name().and_then(|name| name.to_str()) == Some(value)
        && path.extension().and_then(|extension| extension.to_str()) == Some("md")
}

fn validate_manifest_shape(marker: &SeedMarker) -> Result<(), String> {
    if marker.version != 1 {
        return Ok(());
    }
    let mut targets = BTreeSet::new();
    for (source, allocation) in &marker.allocations {
        if !is_plain_markdown_filename(source)
            || !is_plain_markdown_filename(&allocation.target_file_name)
            || !targets.insert(&allocation.target_file_name)
        {
            return Err(
                "Bundled agent manifest contains an unsafe or duplicate allocation".to_string(),
            );
        }
    }
    Ok(())
}

fn digest_file(path: &Path) -> Result<String, String> {
    let bytes =
        fs::read(path).map_err(|error| format!("Failed to read '{}': {error}", path.display()))?;
    Ok(format!("sha256:{:x}", Sha256::digest(bytes)))
}

fn regular_file_matches_digest(path: &Path, expected_digest: &str) -> Result<bool, String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => {
            return Err(format!("Failed to inspect '{}': {error}", path.display()));
        }
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Ok(false);
    }
    Ok(digest_file(path)? == expected_digest)
}

fn allocate_target_name(
    source_name: &str,
    claimed: &BTreeSet<String>,
    target_root: &Path,
) -> Result<String, String> {
    let stem = source_name
        .strip_suffix(".md")
        .ok_or_else(|| "Bundled agent filename must end in .md".to_string())?;
    for index in 1..=1_000 {
        let candidate = if index == 1 {
            source_name.to_string()
        } else {
            format!("{stem}{index}.md")
        };
        if claimed.contains(&candidate) {
            continue;
        }
        match fs::symlink_metadata(target_root.join(&candidate)) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(candidate),
            Ok(_) => continue,
            Err(error) => {
                return Err(format!(
                    "Failed to inspect bundled agent target '{}': {error}",
                    target_root.join(&candidate).display()
                ));
            }
        }
    }
    Err(format!("No safe target is available for '{source_name}'"))
}

/// Extracts an agent file's `app-avatar:*` ref from its raw contents, if the
/// YAML frontmatter declares one.
fn avatar_ref_from_contents(contents: &str) -> Option<String> {
    agent_frontmatter(contents)
        .and_then(|frontmatter| yaml_serde::from_str::<AgentFrontmatter>(frontmatter).ok())
        .and_then(|frontmatter| frontmatter.avatar)
        .map(|value| value.trim().to_string())
        .filter(|value| value.starts_with("app-avatar:"))
}

fn bundled_sources(source_root: &Path) -> Result<Vec<(String, PathBuf, String)>, String> {
    let mut entries = fs::read_dir(source_root)
        .map_err(|error| {
            format!(
                "Failed to read bundled agents directory '{}': {error}",
                source_root.display()
            )
        })?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| {
            format!(
                "Failed to read bundled agents directory '{}': {error}",
                source_root.display()
            )
        })?;
    entries.sort_by_key(|entry| entry.file_name());
    let mut sources = Vec::new();
    for entry in entries {
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path).map_err(|error| {
            format!(
                "Failed to inspect bundled agent path '{}': {error}",
                path.display()
            )
        })?;
        if metadata.file_type().is_symlink() {
            return Err(format!(
                "Bundled agent path '{}' must not be a symbolic link",
                path.display()
            ));
        }
        if !metadata.is_file() || path.extension().and_then(|value| value.to_str()) != Some("md") {
            continue;
        }
        if !is_installed_bundled_agent(&path)? {
            return Err(format!(
                "Bundled agent '{}' is missing its bundled marker",
                path.display()
            ));
        }
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| "Bundled agent filenames must be valid UTF-8".to_string())?;
        sources.push((name, path.clone(), digest_file(&path)?));
    }
    Ok(sources)
}

fn seed_bundled_agents_from_dir(
    source_root: &Path,
    target_root: &Path,
) -> Result<SeedBundledAgentsResult, String> {
    if !source_root.is_dir() {
        return Ok(SeedBundledAgentsResult::default());
    }
    let sources = bundled_sources(source_root)?;
    let mut marker = match read_current_seed_marker(target_root)? {
        Some(marker) => marker,
        None => {
            let mut claimed = sources
                .iter()
                .map(|(name, _, _)| name.clone())
                .collect::<BTreeSet<_>>();
            let mut allocations = BTreeMap::new();
            for (name, _, digest) in &sources {
                claimed.remove(name);
                let target_file_name = allocate_target_name(name, &claimed, target_root)?;
                claimed.insert(target_file_name.clone());
                allocations.insert(
                    name.clone(),
                    AllocationRecord {
                        target_file_name,
                        installed_digest: digest.clone(),
                        status: AllocationStatus::Pending,
                    },
                );
            }
            let marker = SeedMarker {
                version: 1,
                install_state: InstallState::Installing,
                seeded_files: BTreeSet::new(),
                allocations,
            };
            // The complete allocation plan is durable before the first target write.
            write_seed_marker(target_root, &marker)?;
            marker
        }
    };

    // Existing digestless markers are intentionally not migrated by this clean-install feature.
    if marker.version != 1 {
        return Ok(SeedBundledAgentsResult::default());
    }

    let mut seeded_count = 0;
    let mut avatar_refs_to_warm = BTreeSet::new();

    // Adoption depends only on the durable allocation and already-written
    // bytes, not on whether the current package still contains that source.
    let pending_names = marker
        .allocations
        .iter()
        .filter(|(_, allocation)| allocation.status == AllocationStatus::Pending)
        .map(|(name, _)| name.clone())
        .collect::<Vec<_>>();
    for name in pending_names {
        let allocation = marker.allocations[&name].clone();
        let target = target_root.join(&allocation.target_file_name);
        if regular_file_matches_digest(&target, &allocation.installed_digest)? {
            marker.allocations.get_mut(&name).unwrap().status = AllocationStatus::Installed;
            write_seed_marker(target_root, &marker)?;
        }
    }

    for (name, source, source_digest) in sources {
        let Some(allocation) = marker.allocations.get(&name).cloned() else {
            // This is an established installation. New bundle entries are not retrofitted.
            continue;
        };
        let target = target_root.join(&allocation.target_file_name);
        match allocation.status {
            AllocationStatus::Pending => {
                let target_matches_recorded =
                    regular_file_matches_digest(&target, &allocation.installed_digest)?;
                if !target_matches_recorded {
                    // A package change cannot redefine bytes already promised by a durable
                    // pending record. Leave it pending unless the current source still matches.
                    if source_digest != allocation.installed_digest {
                        continue;
                    }
                    if fs::symlink_metadata(&target).is_ok() {
                        // A collision appeared after the plan was committed. Preserve it and
                        // durably reallocate before writing the bundled copy.
                        let claimed = marker
                            .allocations
                            .values()
                            .map(|record| record.target_file_name.clone())
                            .collect::<BTreeSet<_>>();
                        let replacement = allocate_target_name(&name, &claimed, target_root)?;
                        marker.allocations.get_mut(&name).unwrap().target_file_name = replacement;
                        write_seed_marker(target_root, &marker)?;
                    }
                    let target = target_root.join(&marker.allocations[&name].target_file_name);
                    install_agent_file(&source, &target)?;
                    seeded_count += 1;
                }
                marker.allocations.get_mut(&name).unwrap().status = AllocationStatus::Installed;
                write_seed_marker(target_root, &marker)?;
            }
            AllocationStatus::Installed => {
                let metadata = match fs::symlink_metadata(&target) {
                    Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => {
                        metadata
                    }
                    _ => continue, // Missing is deletion; other path types fail closed.
                };
                let _ = metadata;
                if digest_file(&target)? != allocation.installed_digest {
                    continue; // User edit or replacement: preserve and relinquish management.
                }
                // Packaged updates do not rewrite established copies in this
                // clean-install-only flow. The recorded digest remains the
                // ownership proof as long as the target still matches it.
                let _ = source_digest;
            }
        }
        if marker.allocations[&name].status == AllocationStatus::Installed {
            if let Some(avatar_ref) = source_agent_avatar_ref(&source)? {
                avatar_refs_to_warm.insert(avatar_ref);
            }
        }
    }
    if marker
        .allocations
        .values()
        .all(|record| record.status == AllocationStatus::Installed)
    {
        marker.install_state = InstallState::Complete;
        write_seed_marker(target_root, &marker)?;
    }
    Ok(SeedBundledAgentsResult {
        seeded_count,
        avatar_refs_to_warm: avatar_refs_to_warm.into_iter().collect(),
    })
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
        fs::hard_link(&temp_path, target).map_err(|err| {
            format!(
                "Failed to install bundled agent '{}' without replacing '{}' : {err}",
                source.display(),
                target.display()
            )
        })?;
        fs::remove_file(&temp_path).map_err(|err| {
            format!(
                "Failed to remove temporary bundled agent '{}': {err}",
                temp_path.display()
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

#[cfg(test)]
fn read_seed_marker(target_root: &Path) -> Result<SeedMarker, String> {
    read_current_seed_marker(target_root)?
        .ok_or_else(|| "Bundled agent manifest is unavailable".to_string())
}

fn read_current_seed_marker(target_root: &Path) -> Result<Option<SeedMarker>, String> {
    for path in [marker_path(target_root), legacy_marker_path(target_root)] {
        match fs::symlink_metadata(&path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => {}
            Ok(_) => {
                return Err(format!(
                    "Bundled agent manifest '{}' must be a regular non-symlink file",
                    path.display()
                ));
            }
            Err(error) => {
                return Err(format!(
                    "Failed to inspect bundled agent manifest '{}': {error}",
                    path.display()
                ));
            }
        }
        match read_seed_marker_file(&path) {
            Ok(marker) if marker.version == 1 => {
                validate_manifest_shape(&marker).map_err(|error| {
                    format!(
                        "Invalid bundled agent manifest '{}': {error}",
                        path.display()
                    )
                })?;
                return Ok(Some(marker));
            }
            Ok(_) => return Ok(Some(SeedMarker::default())), // Established pre-manifest install: fail closed.
            Err(error) => return Err(error),
        }
    }
    Ok(None)
}

fn read_seed_marker_file(path: &Path) -> Result<SeedMarker, String> {
    let contents = fs::read_to_string(path).map_err(|err| {
        format!(
            "Failed to read bundled agent marker '{}': {err}",
            path.display()
        )
    })?;
    serde_json::from_str::<SeedMarker>(&contents).map_err(|err| {
        format!(
            "Failed to parse bundled agent marker '{}': {err}",
            path.display()
        )
    })
}

#[cfg(not(target_os = "windows"))]
fn replace_marker_atomically(from: &Path, to: &Path) -> std::io::Result<()> {
    fs::rename(from, to)
}

#[cfg(target_os = "windows")]
fn replace_marker_atomically(from: &Path, to: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;

    const MOVEFILE_REPLACE_EXISTING: u32 = 0x1;
    const MOVEFILE_WRITE_THROUGH: u32 = 0x8;

    #[link(name = "kernel32")]
    extern "system" {
        fn MoveFileExW(from: *const u16, to: *const u16, flags: u32) -> i32;
    }

    let from = from
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let to = to
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let replaced = unsafe {
        MoveFileExW(
            from.as_ptr(),
            to.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if replaced == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
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
    let temp_path = target_root.join(format!(".berd-bundled-agents-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| -> Result<(), String> {
        let mut temp = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp_path)
            .map_err(|err| {
                format!(
                    "Failed to create temporary bundled agent marker '{}': {err}",
                    temp_path.display()
                )
            })?;
        temp.write_all(&contents).map_err(|err| {
            format!(
                "Failed to write temporary bundled agent marker '{}': {err}",
                temp_path.display()
            )
        })?;
        temp.sync_all().map_err(|err| {
            format!(
                "Failed to sync temporary bundled agent marker '{}': {err}",
                temp_path.display()
            )
        })?;
        replace_marker_atomically(&temp_path, &path).map_err(|err| {
            format!(
                "Failed to install bundled agent marker '{}' at '{}': {err}",
                temp_path.display(),
                path.display()
            )
        })?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp_path);
    }
    result?;

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
    fn initial_seed_ignores_unrelated_personal_agents() {
        let source = tempdir().unwrap();
        let target = tempdir().unwrap();
        let bundled = "---\nname: Tinker\nmetadata:\n  berdBundled: true\n---\nBundled.";
        write_agent(source.path(), "tinker.md", bundled);
        write_agent(
            target.path(),
            "personal.md",
            "---\nname: Mine\n---\nPersonal.",
        );

        let result = seed_bundled_agents_from_dir(source.path(), target.path()).unwrap();

        assert_eq!(result.seeded_count, 1);
        assert_eq!(
            fs::read_to_string(target.path().join("tinker.md")).unwrap(),
            bundled
        );
        assert_eq!(
            fs::read_to_string(target.path().join("personal.md")).unwrap(),
            "---\nname: Mine\n---\nPersonal."
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
    fn preserves_legacy_seed_marker_without_retrofitting() {
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
        assert!(!target.path().join(MARKER_FILE_NAME).exists());
        assert!(target.path().join(LEGACY_MARKER_FILE_NAME).exists());
    }

    #[test]
    fn preserves_existing_user_agent_and_allocates_bundled_copy() {
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
        assert!(target.path().join("builderbot2.md").exists());
        assert_eq!(
            fs::read_to_string(target.path().join("builderbot.md")).unwrap(),
            "---\nname: Builderbot\ndescription: Agent\n---\nUser edited."
        );

        fs::remove_file(target.path().join("builderbot.md")).unwrap();
        let second_result = seed_bundled_agents_from_dir(source.path(), target.path()).unwrap();

        assert_eq!(second_result.seeded_count, 0);
        assert!(second_result.avatar_refs_to_warm.is_empty());
        assert!(!target.path().join("builderbot.md").exists());
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
    #[test]
    fn resumes_a_pending_manifest_without_overwriting_a_collision() {
        let source = tempdir().unwrap();
        let target = tempdir().unwrap();
        let contents = "---\nname: Tinker\nmetadata:\n  berdBundled: true\n---\nBundled.";
        write_agent(source.path(), "tinker.md", contents);
        let digest = digest_file(&source.path().join("tinker.md")).unwrap();
        let mut marker = SeedMarker {
            version: 1,
            install_state: InstallState::Installing,
            ..Default::default()
        };
        marker.allocations.insert(
            "tinker.md".into(),
            AllocationRecord {
                target_file_name: "tinker.md".into(),
                installed_digest: digest,
                status: AllocationStatus::Pending,
            },
        );
        write_seed_marker(target.path(), &marker).unwrap();
        write_agent(target.path(), "tinker.md", "personal");

        let result = seed_bundled_agents_from_dir(source.path(), target.path()).unwrap();

        assert_eq!(result.seeded_count, 1);
        assert_eq!(
            fs::read_to_string(target.path().join("tinker.md")).unwrap(),
            "personal"
        );
        assert_eq!(
            fs::read_to_string(target.path().join("tinker2.md")).unwrap(),
            contents
        );
        assert_eq!(
            read_seed_marker(target.path()).unwrap().install_state,
            InstallState::Complete
        );
    }

    #[test]
    fn preserves_an_edited_managed_agent_without_creating_a_duplicate() {
        let source = tempdir().unwrap();
        let target = tempdir().unwrap();
        write_agent(
            source.path(),
            "tinker.md",
            "---\nname: Tinker\nmetadata:\n  berdBundled: true\n---\nOriginal.",
        );
        seed_bundled_agents_from_dir(source.path(), target.path()).unwrap();
        fs::write(target.path().join("tinker.md"), "user edit").unwrap();

        let result = seed_bundled_agents_from_dir(source.path(), target.path()).unwrap();

        assert_eq!(result.seeded_count, 0);
        assert_eq!(
            fs::read_to_string(target.path().join("tinker.md")).unwrap(),
            "user edit"
        );
        assert!(!target.path().join("tinker2.md").exists());
    }

    #[test]
    fn corrupt_manifest_fails_closed_and_exposes_no_allocations() {
        let source = tempdir().unwrap();
        let target = tempdir().unwrap();
        write_agent(
            source.path(),
            "tinker.md",
            "---\nname: Tinker\nmetadata:\n  berdBundled: true\n---\nBundled.",
        );
        fs::write(marker_path(target.path()), "{").unwrap();

        let error = seed_bundled_agents_from_dir(source.path(), target.path()).unwrap_err();

        assert!(error.contains("Failed to parse bundled agent marker"));
        assert!(!target.path().join("tinker.md").exists());
        assert_eq!(fs::read_to_string(marker_path(target.path())).unwrap(), "{");
    }

    #[test]
    fn packaged_source_change_preserves_managed_copy_and_verified_digest() {
        let source = tempdir().unwrap();
        let target = tempdir().unwrap();
        let original = "---\nname: Tinker\nmetadata:\n  berdBundled: true\n---\nOriginal.";
        write_agent(source.path(), "tinker.md", original);
        seed_bundled_agents_from_dir(source.path(), target.path()).unwrap();
        let recorded = read_seed_marker(target.path()).unwrap().allocations["tinker.md"]
            .installed_digest
            .clone();
        write_agent(
            source.path(),
            "tinker.md",
            "---\nname: Tinker\nmetadata:\n  berdBundled: true\n---\nUpdated package.",
        );

        let result = seed_bundled_agents_from_dir(source.path(), target.path()).unwrap();

        assert_eq!(result.seeded_count, 0);
        assert_eq!(
            fs::read_to_string(target.path().join("tinker.md")).unwrap(),
            original
        );
        assert_eq!(
            read_seed_marker(target.path()).unwrap().allocations["tinker.md"].installed_digest,
            recorded
        );
    }

    #[test]
    fn repair_keeps_corrupt_manifest_fail_closed() {
        let source = tempdir().unwrap();
        let target = tempdir().unwrap();
        write_agent(
            source.path(),
            "berdy.md",
            "---\nname: Berdy\nmetadata:\n  berdBundled: true\n---\nBundled.",
        );
        fs::write(marker_path(target.path()), "{").unwrap();
        let error =
            repair_bundled_agent_from_dir(source.path(), target.path(), "berdy.md").unwrap_err();

        assert!(error.contains("Failed to parse bundled agent marker"));
        assert_eq!(fs::read_to_string(marker_path(target.path())).unwrap(), "{");
        assert!(!target.path().join("berdy.md").exists());
    }

    #[test]
    fn repair_resumes_pending_allocation_without_duplicate() {
        let source = tempdir().unwrap();
        let target = tempdir().unwrap();
        let contents = "---\nname: Berdy\nmetadata:\n  berdBundled: true\n---\nBundled.";
        write_agent(source.path(), "berdy.md", contents);
        seed_bundled_agents_from_dir(source.path(), target.path()).unwrap();
        let mut marker = read_seed_marker(target.path()).unwrap();
        marker.allocations.get_mut("berdy.md").unwrap().status = AllocationStatus::Pending;
        marker.install_state = InstallState::Installing;
        write_seed_marker(target.path(), &marker).unwrap();

        write_agent(
            source.path(),
            "berdy.md",
            "---\nname: Berdy\nmetadata:\n  berdBundled: true\n---\nUpdated package.",
        );
        seed_bundled_agents_from_dir(source.path(), target.path()).unwrap();

        let marker = read_seed_marker(target.path()).unwrap();
        assert_eq!(
            marker.allocations["berdy.md"].status,
            AllocationStatus::Installed
        );
        assert_eq!(marker.install_state, InstallState::Complete);
        assert_eq!(
            fs::read_dir(target.path())
                .unwrap()
                .filter_map(Result::ok)
                .filter(
                    |entry| entry.path().extension().and_then(|value| value.to_str()) == Some("md")
                )
                .count(),
            1
        );
    }

    #[test]
    fn repair_does_not_duplicate_a_customized_agent() {
        let source = tempdir().unwrap();
        let target = tempdir().unwrap();
        write_agent(
            source.path(),
            "berdy.md",
            "---\nname: Berdy\nmetadata:\n  berdBundled: true\n---\nBundled.",
        );
        seed_bundled_agents_from_dir(source.path(), target.path()).unwrap();
        fs::write(target.path().join("berdy.md"), "customized").unwrap();

        let error =
            repair_bundled_agent_from_dir(source.path(), target.path(), "berdy.md").unwrap_err();

        assert!(error.contains("explicit restore decision"));
        assert_eq!(
            fs::read_to_string(target.path().join("berdy.md")).unwrap(),
            "customized"
        );
        assert!(!target.path().join("berdy2.md").exists());
        assert_eq!(
            read_seed_marker(target.path()).unwrap().allocations["berdy.md"].target_file_name,
            "berdy.md"
        );
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinked_manifest_without_mutating_it() {
        let source = tempdir().unwrap();
        let target = tempdir().unwrap();
        write_agent(
            source.path(),
            "berdy.md",
            "---\nname: Berdy\nmetadata:\n  berdBundled: true\n---\nBundled.",
        );
        let outside = target.path().join("outside.json");
        fs::write(&outside, "{}").unwrap();
        std::os::unix::fs::symlink(&outside, marker_path(target.path())).unwrap();

        let error = seed_bundled_agents_from_dir(source.path(), target.path()).unwrap_err();

        assert!(error.contains("regular non-symlink file"));
        assert!(marker_path(target.path())
            .symlink_metadata()
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(fs::read_to_string(outside).unwrap(), "{}");
    }

    #[test]
    fn adopts_pending_target_after_source_is_removed() {
        let source = tempdir().unwrap();
        let target = tempdir().unwrap();
        let contents = "---\nname: Berdy\nmetadata:\n  berdBundled: true\n---\nBundled.";
        write_agent(source.path(), "berdy.md", contents);
        seed_bundled_agents_from_dir(source.path(), target.path()).unwrap();
        let mut marker = read_seed_marker(target.path()).unwrap();
        marker.allocations.get_mut("berdy.md").unwrap().status = AllocationStatus::Pending;
        marker.install_state = InstallState::Installing;
        write_seed_marker(target.path(), &marker).unwrap();
        fs::remove_file(source.path().join("berdy.md")).unwrap();

        seed_bundled_agents_from_dir(source.path(), target.path()).unwrap();

        assert_eq!(
            read_seed_marker(target.path()).unwrap().allocations["berdy.md"].status,
            AllocationStatus::Installed
        );
        assert_eq!(
            fs::read_to_string(target.path().join("berdy.md")).unwrap(),
            contents
        );
    }
}
