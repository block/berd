use std::collections::BTreeSet;
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
const LEGACY_AGT_BUILDER_FILE_NAME: &str = "agt-builder.md";
const LEGACY_AGT_BUILDER_FILE_SHA256: &str =
    "15ac706dd4b14dced6368572f4f2f0b3e42d0263cafb5ec199e71cd034b14a9d";

#[derive(Debug, Default, PartialEq, Eq)]
pub struct SeedBundledAgentsResult {
    pub seeded_count: usize,
    pub avatar_refs_to_warm: Vec<String>,
}

#[derive(Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SeedMarker {
    seeded_files: BTreeSet<String>,
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
    let target = target_root.join(file_name);
    install_agent_file(&source, &target)?;
    marker.seeded_files.insert(file_name.to_string());
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

        let file_name = entry.file_name().to_string_lossy().into_owned();
        let target = target_root.join(&file_name);
        let was_previously_seeded = marker.seeded_files.contains(&file_name);
        let installed_or_refreshed =
            if should_install_agent(&source, &target, was_previously_seeded)? {
                install_agent_file(&source, &target)?;
                seeded_count += 1;
                true
            } else {
                false
            };

        if (installed_or_refreshed || was_previously_seeded)
            && target.exists()
            && is_installed_bundled_agent(&target)?
        {
            if let Some(avatar_ref) = source_agent_avatar_ref(&source)? {
                avatar_refs_to_warm.insert(avatar_ref);
            }
        }
        marker.seeded_files.insert(file_name);
    }

    if !marker.seeded_files.is_empty() {
        write_seed_marker(target_root, &marker)?;
    }

    Ok(SeedBundledAgentsResult {
        seeded_count,
        avatar_refs_to_warm: avatar_refs_to_warm.into_iter().collect(),
    })
}

fn has_known_legacy_agt_builder_contents(path: &Path) -> Result<bool, String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|err| format!("Failed to inspect legacy agent '{}': {err}", path.display()))?;
    if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
        return Ok(false);
    }
    let contents = fs::read(path)
        .map_err(|err| format!("Failed to read legacy agent '{}': {err}", path.display()))?;
    let digest = format!("{:x}", Sha256::digest(contents));
    Ok(digest == LEGACY_AGT_BUILDER_FILE_SHA256)
}

fn is_known_legacy_agt_builder(path: &Path) -> Result<bool, String> {
    if path.file_name().and_then(|name| name.to_str()) != Some(LEGACY_AGT_BUILDER_FILE_NAME) {
        return Ok(false);
    }
    has_known_legacy_agt_builder_contents(path)
}

fn should_install_agent(
    source: &Path,
    target: &Path,
    was_previously_seeded: bool,
) -> Result<bool, String> {
    if !target.exists() {
        return Ok(!was_previously_seeded);
    }
    if is_known_legacy_agt_builder(target)? {
        return Ok(true);
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
    ) && !is_known_legacy_agt_builder(target)?
    {
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
    let legacy_claim_path = parent.join(format!(
        ".berd-agent-legacy-claim-{}-{sequence}.tmp",
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
        let claimed_legacy = matches!(
            installed_agent_path_state(target)?,
            InstalledAgentPathState::UserOwned
        ) && is_known_legacy_agt_builder(target)?;
        if claimed_legacy {
            fs::rename(target, &legacy_claim_path).map_err(|err| {
                format!(
                    "Failed to claim legacy bundled agent '{}': {err}",
                    target.display()
                )
            })?;
            if !has_known_legacy_agt_builder_contents(&legacy_claim_path)? {
                let _ = fs::rename(&legacy_claim_path, target);
                return Err(format!(
                    "Legacy bundled agent changed before replacement at '{}'",
                    target.display()
                ));
            }
        } else if !matches!(
            installed_agent_path_state(target)?,
            InstalledAgentPathState::Missing | InstalledAgentPathState::Bundled
        ) {
            return Err(format!(
                "Cannot install bundled agent over user-owned file '{}'",
                target.display()
            ));
        }
        if let Err(err) = fs::rename(&temp_path, target) {
            if claimed_legacy {
                let _ = fs::rename(&legacy_claim_path, target);
            }
            return Err(format!(
                "Failed to install bundled agent '{}' at '{}': {err}",
                source.display(),
                target.display()
            ));
        }
        if claimed_legacy {
            let _ = fs::remove_file(&legacy_claim_path);
        }
        Ok(())
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
    serde_json::from_str::<SeedMarker>(&contents).map_err(|err| {
        format!(
            "Failed to parse bundled agent marker '{}': {err}",
            path.display()
        )
    })
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
    fn explicit_repair_preserves_an_unmarked_user_agent() {
        let source = tempdir().unwrap();
        let target = tempdir().unwrap();
        write_agent(
            source.path(),
            "berdy.md",
            "---\nname: Berdy\nmetadata:\n  berdBundled: true\n---\nBundled.",
        );
        write_agent(target.path(), "berdy.md", "---\nname: Mine\n---\nPersonal.");

        let error =
            repair_bundled_agent_from_dir(source.path(), target.path(), "berdy.md").unwrap_err();

        assert!(error.contains("user-owned"));
        assert_eq!(
            fs::read_to_string(target.path().join("berdy.md")).unwrap(),
            "---\nname: Mine\n---\nPersonal."
        );
        assert!(!target.path().join("berdy2.md").exists());
    }

    #[cfg(unix)]
    #[test]
    fn explicit_repair_rejects_a_broken_primary_symlink() {
        let source = tempdir().unwrap();
        let target = tempdir().unwrap();
        let outside = tempdir().unwrap().path().join("outside.md");
        write_agent(
            source.path(),
            "berdy.md",
            "---\nname: Berdy\nmetadata:\n  berdBundled: true\n---\nBundled.",
        );
        std::os::unix::fs::symlink(&outside, target.path().join("berdy.md")).unwrap();

        let error =
            repair_bundled_agent_from_dir(source.path(), target.path(), "berdy.md").unwrap_err();

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
    fn production_signature_recognizes_the_historical_agt_builder() {
        let target = tempdir().unwrap();
        let path = target.path().join(LEGACY_AGT_BUILDER_FILE_NAME);
        fs::write(
            &path,
            include_str!("../../test-fixtures/legacy-agt-builder.md"),
        )
        .unwrap();

        assert!(is_known_legacy_agt_builder(&path).unwrap());
    }

    #[test]
    fn preserves_a_legacy_agt_builder_with_a_custom_avatar() {
        let target = tempdir().unwrap();
        let path = target.path().join(LEGACY_AGT_BUILDER_FILE_NAME);
        let fixture = include_str!("../../test-fixtures/legacy-agt-builder.md");
        fs::write(
            &path,
            fixture.replacen("data:image/png;base64,", "data:image/png;base64,CUSTOM", 1),
        )
        .unwrap();

        assert!(!is_known_legacy_agt_builder(&path).unwrap());
    }

    #[test]
    fn preserves_a_legacy_agt_builder_with_different_line_endings() {
        let target = tempdir().unwrap();
        let path = target.path().join(LEGACY_AGT_BUILDER_FILE_NAME);
        let fixture = include_str!("../../test-fixtures/legacy-agt-builder.md");
        fs::write(&path, fixture.replace('\n', "\r\n")).unwrap();

        assert!(!is_known_legacy_agt_builder(&path).unwrap());
    }

    #[test]
    fn preserves_a_modified_legacy_agt_builder() {
        let target = tempdir().unwrap();
        let path = target.path().join(LEGACY_AGT_BUILDER_FILE_NAME);
        let fixture = include_str!("../../test-fixtures/legacy-agt-builder.md");
        fs::write(&path, fixture.replacen("name:", "# user note\nname:", 1)).unwrap();

        assert!(!is_known_legacy_agt_builder(&path).unwrap());
    }

    #[test]
    fn treats_existing_user_agent_as_already_handled() {
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

        assert_eq!(result.seeded_count, 0);
        assert!(result.avatar_refs_to_warm.is_empty());
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
    fn does_not_inspect_existing_unmarked_user_agent() {
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

        assert_eq!(result.seeded_count, 0);
        assert!(result.avatar_refs_to_warm.is_empty());
        assert_eq!(
            fs::read(target.path().join("builderbot.md")).unwrap(),
            [0xff]
        );

        let second_result = seed_bundled_agents_from_dir(source.path(), target.path()).unwrap();
        assert_eq!(second_result.seeded_count, 0);
        assert!(second_result.avatar_refs_to_warm.is_empty());
    }

    #[test]
    fn replaces_edited_seeded_agent_before_launch() {
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
            "---\nname: Builderbot\ndescription: Agent\nmetadata:\n  berdBundled: true\n---\nOriginal."
        );
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
