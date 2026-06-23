use std::fs;
use std::path::Path;

use serde::Deserialize;

use crate::services::distro_bundle::DistroBundle;

const DISTRO_SKILLS_DIR_NAME: &str = "skills";
const GLOBAL_AGENTS_DIR_NAME: &str = ".agents";
const SKILLS_DIR_NAME: &str = "skills";
const SKILL_FILE_NAME: &str = "SKILL.md";

pub fn seed_bundled_skills(bundle: &DistroBundle) -> Result<usize, String> {
    let Some(home_dir) = dirs::home_dir() else {
        return Err("Failed to resolve home directory for bundled skills".to_string());
    };

    seed_bundled_skills_from_dir(
        &bundle.root_dir.join(DISTRO_SKILLS_DIR_NAME),
        &home_dir.join(GLOBAL_AGENTS_DIR_NAME).join(SKILLS_DIR_NAME),
    )
}

fn seed_bundled_skills_from_dir(source_root: &Path, target_root: &Path) -> Result<usize, String> {
    if !source_root.is_dir() {
        return Ok(0);
    }

    let mut seeded = 0usize;
    for entry in fs::read_dir(source_root).map_err(|err| {
        format!(
            "Failed to read bundled skills directory '{}': {err}",
            source_root.display()
        )
    })? {
        let entry = entry.map_err(|err| {
            format!(
                "Failed to read bundled skills directory '{}': {err}",
                source_root.display()
            )
        })?;
        let source = entry.path();
        if !source.is_dir() || !source.join(SKILL_FILE_NAME).is_file() {
            continue;
        }

        let skill_name = entry.file_name();
        let target = target_root.join(&skill_name);
        fs::create_dir_all(target_root).map_err(|err| {
            format!(
                "Failed to create skills directory '{}': {err}",
                target_root.display()
            )
        })?;
        if !should_install_skill(&target)? {
            continue;
        }

        install_skill_dir(&source, &target)?;
        seeded += 1;
    }

    Ok(seeded)
}

fn should_install_skill(target: &Path) -> Result<bool, String> {
    if !target.exists() {
        return Ok(true);
    }

    is_installed_bundled_skill(target)
}

fn is_installed_bundled_skill(skill_dir: &Path) -> Result<bool, String> {
    let metadata = fs::symlink_metadata(skill_dir).map_err(|err| {
        format!(
            "Failed to inspect installed skill path '{}': {err}",
            skill_dir.display()
        )
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Ok(false);
    }

    let skill_file = skill_dir.join(SKILL_FILE_NAME);
    let contents = match fs::read_to_string(&skill_file) {
        Ok(contents) => contents,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(err) => {
            return Err(format!(
                "Failed to read installed skill '{}': {err}",
                skill_file.display()
            ));
        }
    };

    Ok(skill_frontmatter(&contents)
        .and_then(|frontmatter| yaml_serde::from_str::<SkillFrontmatter>(frontmatter).ok())
        .and_then(|frontmatter| frontmatter.metadata)
        .and_then(|metadata| metadata.goose_internal_bundled)
        .unwrap_or(false))
}

fn skill_frontmatter(contents: &str) -> Option<&str> {
    let contents = contents.strip_prefix("---\n")?;
    let end = contents.find("\n---")?;
    Some(&contents[..end])
}

#[derive(Deserialize)]
struct SkillFrontmatter {
    metadata: Option<SkillMetadata>,
}

#[derive(Deserialize)]
struct SkillMetadata {
    #[serde(rename = "gooseInternalBundled")]
    goose_internal_bundled: Option<bool>,
}

fn install_skill_dir(source: &Path, target: &Path) -> Result<(), String> {
    if target.exists() {
        fs::remove_dir_all(target).map_err(|err| {
            format!(
                "Failed to replace bundled skill '{}': could not remove existing target '{}': {err}",
                source.display(),
                target.display()
            )
        })?;
    }

    if let Err(err) = copy_dir_all(source, target) {
        let _ = fs::remove_dir_all(target);
        return Err(err);
    }

    Ok(())
}

fn copy_dir_all(source: &Path, target: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(source).map_err(|err| {
        format!(
            "Failed to inspect bundled skill path '{}': {err}",
            source.display()
        )
    })?;
    if metadata.file_type().is_symlink() {
        return Err(format!(
            "Bundled skill path '{}' must not be a symbolic link",
            source.display()
        ));
    }

    fs::create_dir_all(target).map_err(|err| {
        format!(
            "Failed to create bundled skill directory '{}': {err}",
            target.display()
        )
    })?;

    for entry in fs::read_dir(source)
        .map_err(|err| format!("Failed to read bundled skill '{}': {err}", source.display()))?
    {
        let entry = entry
            .map_err(|err| format!("Failed to read bundled skill '{}': {err}", source.display()))?;
        let source_path = entry.path();
        let target_path = target.join(entry.file_name());
        let metadata = fs::symlink_metadata(&source_path).map_err(|err| {
            format!(
                "Failed to inspect bundled skill path '{}': {err}",
                source_path.display()
            )
        })?;

        if metadata.file_type().is_symlink() {
            return Err(format!(
                "Bundled skill path '{}' must not be a symbolic link",
                source_path.display()
            ));
        }
        if metadata.is_dir() {
            copy_dir_all(&source_path, &target_path)?;
        } else if metadata.is_file() {
            fs::copy(&source_path, &target_path).map_err(|err| {
                format!(
                    "Failed to copy bundled skill file '{}' to '{}': {err}",
                    source_path.display(),
                    target_path.display()
                )
            })?;
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn write_skill(root: &Path, name: &str, skill_md: &str) {
        let dir = root.join(name);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(SKILL_FILE_NAME), skill_md).unwrap();
    }

    #[test]
    fn seeds_missing_bundled_skill() {
        let source = tempdir().unwrap();
        let target = tempdir().unwrap();
        write_skill(
            source.path(),
            "agent-builder",
            "---\nname: agent-builder\n---\n",
        );
        fs::write(
            source.path().join("agent-builder").join("notes.md"),
            "details",
        )
        .unwrap();

        let seeded = seed_bundled_skills_from_dir(source.path(), target.path()).unwrap();

        assert_eq!(seeded, 1);
        assert_eq!(
            fs::read_to_string(target.path().join("agent-builder").join(SKILL_FILE_NAME)).unwrap(),
            "---\nname: agent-builder\n---\n"
        );
        assert_eq!(
            fs::read_to_string(target.path().join("agent-builder").join("notes.md")).unwrap(),
            "details"
        );
    }

    #[test]
    fn preserves_existing_user_skill() {
        let source = tempdir().unwrap();
        let target = tempdir().unwrap();
        write_skill(source.path(), "agent-builder", "bundled");
        write_skill(target.path(), "agent-builder", "user edited");

        let seeded = seed_bundled_skills_from_dir(source.path(), target.path()).unwrap();

        assert_eq!(seeded, 0);
        assert_eq!(
            fs::read_to_string(target.path().join("agent-builder").join(SKILL_FILE_NAME)).unwrap(),
            "user edited"
        );
    }

    #[test]
    fn reinstalls_existing_bundled_skill() {
        let source = tempdir().unwrap();
        let target = tempdir().unwrap();
        write_skill(
            source.path(),
            "agent-builder",
            "---\nname: agent-builder\nmetadata:\n  gooseInternalBundled: true\n---\nupdated",
        );
        write_skill(
            target.path(),
            "agent-builder",
            "---\nname: agent-builder\nmetadata:\n  gooseInternalBundled: true\n---\nold",
        );

        let seeded = seed_bundled_skills_from_dir(source.path(), target.path()).unwrap();

        assert_eq!(seeded, 1);
        assert_eq!(
            fs::read_to_string(target.path().join("agent-builder").join(SKILL_FILE_NAME)).unwrap(),
            "---\nname: agent-builder\nmetadata:\n  gooseInternalBundled: true\n---\nupdated"
        );
    }

    #[test]
    fn ignores_non_skill_entries() {
        let source = tempdir().unwrap();
        let target = tempdir().unwrap();
        fs::write(source.path().join("loose.md"), "not a skill").unwrap();
        fs::create_dir_all(source.path().join("missing-skill-md")).unwrap();

        let seeded = seed_bundled_skills_from_dir(source.path(), target.path()).unwrap();

        assert_eq!(seeded, 0);
        assert!(!target.path().exists() || fs::read_dir(target.path()).unwrap().next().is_none());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinked_skill_contents() {
        let source = tempdir().unwrap();
        let target = tempdir().unwrap();
        write_skill(source.path(), "agent-builder", "skill");
        fs::write(source.path().join("outside.md"), "outside").unwrap();
        std::os::unix::fs::symlink(
            source.path().join("outside.md"),
            source.path().join("agent-builder").join("link.md"),
        )
        .unwrap();

        let err = seed_bundled_skills_from_dir(source.path(), target.path()).unwrap_err();

        assert!(err.contains("must not be a symbolic link"));
        assert!(!target.path().join("agent-builder").exists());
    }
}
