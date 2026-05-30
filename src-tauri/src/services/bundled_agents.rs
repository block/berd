use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::services::distro_bundle::DistroBundle;

const DISTRO_AGENTS_DIR_NAME: &str = "agents";
const GLOBAL_AGENTS_DIR_NAME: &str = ".agents";
const AGENTS_DIR_NAME: &str = "agents";
const MARKER_FILE_NAME: &str = ".goose-internal-bundled-agents.json";

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
    #[serde(rename = "gooseInternalBundled")]
    goose_internal_bundled: Option<bool>,
}

pub fn seed_bundled_agents(bundle: &DistroBundle) -> Result<SeedBundledAgentsResult, String> {
    let Some(home_dir) = dirs::home_dir() else {
        return Err("Failed to resolve home directory for bundled agents".to_string());
    };

    seed_bundled_agents_from_dir(
        &bundle.root_dir.join(DISTRO_AGENTS_DIR_NAME),
        &home_dir.join(GLOBAL_AGENTS_DIR_NAME).join(AGENTS_DIR_NAME),
    )
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
        if should_install_agent(&source, &target, was_previously_seeded)? {
            install_agent_file(&source, &target)?;
            seeded_count += 1;
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

    let contents = fs::read_to_string(agent_file).map_err(|err| {
        format!(
            "Failed to read installed agent '{}': {err}",
            agent_file.display()
        )
    })?;

    Ok(agent_frontmatter(&contents)
        .and_then(|frontmatter| serde_yaml::from_str::<AgentFrontmatter>(frontmatter).ok())
        .and_then(|frontmatter| frontmatter.metadata)
        .and_then(|metadata| metadata.goose_internal_bundled)
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

    Ok(agent_frontmatter(&contents)
        .and_then(|frontmatter| serde_yaml::from_str::<AgentFrontmatter>(frontmatter).ok())
        .and_then(|frontmatter| frontmatter.avatar)
        .map(|value| value.trim().to_string())
        .filter(|value| value.starts_with("app-avatar:")))
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
    fs::copy(source, target).map_err(|err| {
        format!(
            "Failed to copy bundled agent file '{}' to '{}': {err}",
            source.display(),
            target.display()
        )
    })?;
    Ok(())
}

fn marker_path(target_root: &Path) -> PathBuf {
    target_root.join(MARKER_FILE_NAME)
}

fn read_seed_marker(target_root: &Path) -> Result<SeedMarker, String> {
    let path = marker_path(target_root);
    if !path.exists() {
        return Ok(SeedMarker::default());
    }

    let contents = fs::read_to_string(&path).map_err(|err| {
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
    })
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
            "---\nname: Builderbot\ndescription: Agent\navatar: app-avatar:gloopies-20\nmetadata:\n  gooseInternalBundled: true\n---\nBuild carefully.",
        );

        let result = seed_bundled_agents_from_dir(source.path(), target.path()).unwrap();

        assert_eq!(result.seeded_count, 1);
        assert_eq!(result.avatar_refs_to_warm, vec!["app-avatar:gloopies-20"]);
        assert_eq!(
            fs::read_to_string(target.path().join("builderbot.md")).unwrap(),
            "---\nname: Builderbot\ndescription: Agent\navatar: app-avatar:gloopies-20\nmetadata:\n  gooseInternalBundled: true\n---\nBuild carefully."
        );
    }

    #[test]
    fn preserves_deleted_seeded_agent() {
        let source = tempdir().unwrap();
        let target = tempdir().unwrap();
        write_agent(
            source.path(),
            "builderbot.md",
            "---\nname: Builderbot\ndescription: Agent\nmetadata:\n  gooseInternalBundled: true\n---\nBuild carefully.",
        );

        seed_bundled_agents_from_dir(source.path(), target.path()).unwrap();
        fs::remove_file(target.path().join("builderbot.md")).unwrap();

        let result = seed_bundled_agents_from_dir(source.path(), target.path()).unwrap();

        assert_eq!(result.seeded_count, 0);
        assert!(result.avatar_refs_to_warm.is_empty());
        assert!(!target.path().join("builderbot.md").exists());
    }

    #[test]
    fn treats_existing_user_agent_as_already_handled() {
        let source = tempdir().unwrap();
        let target = tempdir().unwrap();
        write_agent(
            source.path(),
            "builderbot.md",
            "---\nname: Builderbot\ndescription: Agent\nmetadata:\n  gooseInternalBundled: true\n---\nBundled.",
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
    fn replaces_edited_seeded_agent_before_launch() {
        let source = tempdir().unwrap();
        let target = tempdir().unwrap();
        write_agent(
            source.path(),
            "builderbot.md",
            "---\nname: Builderbot\ndescription: Agent\nmetadata:\n  gooseInternalBundled: true\n---\nOriginal.",
        );

        seed_bundled_agents_from_dir(source.path(), target.path()).unwrap();
        fs::write(
            target.path().join("builderbot.md"),
            "---\nname: Builderbot\ndescription: Agent\nmetadata:\n  gooseInternalBundled: true\n---\nUser edited.",
        )
        .unwrap();

        let result = seed_bundled_agents_from_dir(source.path(), target.path()).unwrap();

        assert_eq!(result.seeded_count, 1);
        assert_eq!(
            fs::read_to_string(target.path().join("builderbot.md")).unwrap(),
            "---\nname: Builderbot\ndescription: Agent\nmetadata:\n  gooseInternalBundled: true\n---\nOriginal."
        );
    }

    #[test]
    fn skips_unchanged_seeded_agent() {
        let source = tempdir().unwrap();
        let target = tempdir().unwrap();
        write_agent(
            source.path(),
            "builderbot.md",
            "---\nname: Builderbot\ndescription: Agent\nmetadata:\n  gooseInternalBundled: true\n---\nOriginal.",
        );

        seed_bundled_agents_from_dir(source.path(), target.path()).unwrap();
        let result = seed_bundled_agents_from_dir(source.path(), target.path()).unwrap();

        assert_eq!(result.seeded_count, 0);
        assert!(result.avatar_refs_to_warm.is_empty());
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
