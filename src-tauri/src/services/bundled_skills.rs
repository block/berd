use std::fs;
use std::path::Path;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tokio::sync::Notify;

use serde::Deserialize;

use crate::services::distro_bundle::DistroBundle;

const DISTRO_SKILLS_DIR_NAME: &str = "skills";
const BERD_LEGACY_DIR_NAME: &str = ".berd";
const GLOBAL_AGENTS_DIR_NAME: &str = ".agents";
const RECOVERY_DIR_NAME: &str = "recovery";
const SKILLS_DIR_NAME: &str = "skills";
const SKILLS_MIGRATION_DIR_NAME: &str = "skills-migration-v1";
const SKILL_FILE_NAME: &str = "SKILL.md";

#[derive(Clone, Default)]
pub struct BundledSkillsState {
    ready: Arc<AtomicBool>,
    notify: Arc<Notify>,
}

impl BundledSkillsState {
    pub fn mark_ready(&self) {
        self.ready.store(true, Ordering::Release);
        self.notify.notify_waiters();
    }

    pub async fn wait_until_ready(&self) {
        loop {
            let notified = self.notify.notified();
            if self.ready.load(Ordering::Acquire) {
                return;
            }
            notified.await;
        }
    }
}

pub fn seed_bundled_skills(
    bundle: &DistroBundle,
    app_data_dir: &Path,
    migrate_from_home: bool,
) -> Result<usize, String> {
    let source_root = bundle.root_dir.join(DISTRO_SKILLS_DIR_NAME);
    let target_root = bundled_skills_target(app_data_dir);
    let seeded = seed_bundled_skills_from_dir(&source_root, &target_root)?;

    if migrate_from_home {
        let Some(home_dir) = dirs::home_dir() else {
            return Err("Failed to resolve home directory for bundled skills".to_string());
        };
        migrate_legacy_bundled_skills(&source_root, &target_root, app_data_dir, &home_dir)?;
        migrate_spike_bundled_skills(&source_root, &target_root, app_data_dir, &home_dir)?;
    }

    Ok(seeded)
}

fn bundled_skills_target(app_data_dir: &Path) -> std::path::PathBuf {
    app_data_dir.join(SKILLS_DIR_NAME)
}

fn legacy_bundled_skills_root(home_dir: &Path) -> std::path::PathBuf {
    home_dir.join(GLOBAL_AGENTS_DIR_NAME).join(SKILLS_DIR_NAME)
}

pub fn migrated_legacy_skill_aliases(
    app_data_dir: &Path,
    include_home_aliases: bool,
) -> Vec<(String, String)> {
    if !include_home_aliases {
        return Vec::new();
    }
    let Some(home_dir) = dirs::home_dir() else {
        return Vec::new();
    };
    migrated_legacy_skill_aliases_for_home(app_data_dir, &home_dir)
}

fn migrated_legacy_skill_aliases_for_home(
    app_data_dir: &Path,
    home_dir: &Path,
) -> Vec<(String, String)> {
    let recovery_root = migration_recovery_root(app_data_dir);
    let Ok(entries) = fs::read_dir(recovery_root) else {
        return Vec::new();
    };

    entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            if !is_installed_bundled_skill(&path).ok()? {
                return None;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            let legacy_path = legacy_bundled_skills_root(home_dir).join(&name);
            if legacy_path.exists() && !is_installed_bundled_skill(&legacy_path).unwrap_or(false) {
                // A newly created unmarked Personal skill owns the historical
                // path now, so the migrated app skill must not claim its pin.
                return None;
            }
            Some((name, format!("global:{}", legacy_path.to_string_lossy())))
        })
        .collect()
}

fn migration_recovery_root(app_data_dir: &Path) -> std::path::PathBuf {
    app_data_dir
        .join(RECOVERY_DIR_NAME)
        .join(SKILLS_MIGRATION_DIR_NAME)
}

fn migrate_spike_bundled_skills(
    source_root: &Path,
    target_root: &Path,
    app_data_dir: &Path,
    home_dir: &Path,
) -> Result<usize, String> {
    migrate_marker_owned_skills(
        source_root,
        target_root,
        &home_dir.join(BERD_LEGACY_DIR_NAME).join(SKILLS_DIR_NAME),
        &app_data_dir
            .join(RECOVERY_DIR_NAME)
            .join("dot-berd-skills-migration"),
    )
}

fn migrate_legacy_bundled_skills(
    source_root: &Path,
    target_root: &Path,
    app_data_dir: &Path,
    home_dir: &Path,
) -> Result<usize, String> {
    migrate_marker_owned_skills(
        source_root,
        target_root,
        &legacy_bundled_skills_root(home_dir),
        &migration_recovery_root(app_data_dir),
    )
}

fn migrate_marker_owned_skills(
    source_root: &Path,
    target_root: &Path,
    legacy_root: &Path,
    recovery_root: &Path,
) -> Result<usize, String> {
    if !source_root.is_dir() {
        return Ok(0);
    }

    let mut migrated = 0usize;

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
        if !target.join(SKILL_FILE_NAME).is_file() {
            // Never remove the working legacy copy until the new canonical
            // Berd-owned installation is present and readable.
            continue;
        }

        let legacy = legacy_root.join(&skill_name);
        if !legacy.exists() || !is_installed_bundled_skill(&legacy)? {
            continue;
        }

        fs::create_dir_all(recovery_root).map_err(|err| {
            format!(
                "Failed to create bundled skill recovery directory '{}': {err}",
                recovery_root.display()
            )
        })?;
        let recovery = recovery_root.join(&skill_name);
        if recovery.exists() {
            if is_installed_bundled_skill(&recovery)? {
                // An older Berd can recreate the marker-owned global copy
                // after migration. The verified recovery copy remains the
                // source of truth, so remove only the reappeared managed copy.
                fs::remove_dir_all(&legacy).map_err(|err| {
                    format!(
                        "Failed to remove recreated legacy bundled skill '{}': {err}",
                        legacy.display()
                    )
                })?;
                migrated += 1;
            }
            continue;
        }

        copy_legacy_skill_to_recovery(&legacy, &recovery)?;
        migrated += 1;
    }

    Ok(migrated)
}

fn copy_legacy_skill_to_recovery(legacy: &Path, recovery: &Path) -> Result<(), String> {
    let recovery_root = recovery.parent().ok_or_else(|| {
        format!(
            "Bundled skill recovery path '{}' has no parent directory",
            recovery.display()
        )
    })?;
    let temp = recovery_root.join(format!(
        ".{}.migrating-{}",
        recovery
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("skill"),
        std::process::id()
    ));
    if temp.exists() {
        fs::remove_dir_all(&temp).map_err(|err| {
            format!(
                "Failed to remove stale bundled skill migration '{}': {err}",
                temp.display()
            )
        })?;
    }

    if let Err(error) = copy_dir_all(legacy, &temp) {
        let _ = fs::remove_dir_all(&temp);
        return Err(error);
    }
    if !is_installed_bundled_skill(&temp)? {
        let _ = fs::remove_dir_all(&temp);
        return Err(format!(
            "Copied bundled skill '{}' did not preserve its ownership marker",
            legacy.display()
        ));
    }
    fs::rename(&temp, recovery).map_err(|err| {
        let _ = fs::remove_dir_all(&temp);
        format!(
            "Failed to finalize bundled skill recovery '{}' to '{}': {err}",
            temp.display(),
            recovery.display()
        )
    })?;
    fs::remove_dir_all(legacy).map_err(|err| {
        format!(
            "Bundled skill recovery was created at '{}', but the legacy copy '{}' could not be removed: {err}",
            recovery.display(),
            legacy.display()
        )
    })?;
    Ok(())
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
        .map(|metadata| {
            metadata.berd_bundled.unwrap_or(false) || metadata.legacy_bundled.unwrap_or(false)
        })
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
    #[serde(rename = "berdBundled")]
    berd_bundled: Option<bool>,
    #[serde(rename = "gooseInternalBundled")]
    legacy_bundled: Option<bool>,
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

    #[tokio::test]
    async fn bundled_skill_discovery_waits_for_seeding_readiness() {
        let state = BundledSkillsState::default();
        let waiting_state = state.clone();
        let waiter = tokio::spawn(async move {
            waiting_state.wait_until_ready().await;
        });

        tokio::task::yield_now().await;
        assert!(!waiter.is_finished());

        state.mark_ready();
        waiter.await.unwrap();
    }

    #[test]
    fn bundled_skills_use_the_platform_app_data_root() {
        let app_data_dir = Path::new("/platform/app-data/xyz.block.berd");
        assert_eq!(
            bundled_skills_target(app_data_dir),
            app_data_dir.join("skills")
        );
    }

    #[test]
    fn migrated_alias_is_suppressed_when_a_personal_skill_reuses_the_path() {
        let home = tempdir().unwrap();
        let app_data = tempdir().unwrap();
        let name = "agent-builder";
        let recovery = migration_recovery_root(app_data.path());
        write_skill(
            &recovery,
            &name,
            &format!("---\nname: {name}\nmetadata:\n  berdBundled: true\n---\nrecovery"),
        );
        let personal_root = legacy_bundled_skills_root(home.path());
        write_skill(
            &personal_root,
            &name,
            &format!("---\nname: {name}\n---\npersonal"),
        );

        let aliases = migrated_legacy_skill_aliases_for_home(app_data.path(), home.path());

        assert!(!aliases.iter().any(|(alias_name, _)| alias_name == name));
    }

    #[test]
    fn migrates_only_marker_owned_legacy_skills_to_recovery() {
        let source = tempdir().unwrap();
        let home = tempdir().unwrap();
        let app_data = tempdir().unwrap();
        write_skill(
            source.path(),
            "agent-builder",
            "---\nname: agent-builder\nmetadata:\n  berdBundled: true\n---\ncurrent",
        );
        write_skill(
            source.path(),
            "goose-help",
            "---\nname: goose-help\nmetadata:\n  berdBundled: true\n---\ncurrent",
        );
        let legacy_root = legacy_bundled_skills_root(home.path());
        write_skill(
            &legacy_root,
            "agent-builder",
            "---\nname: agent-builder\nmetadata:\n  berdBundled: true\n---\npossibly edited",
        );
        write_skill(
            &legacy_root,
            "goose-help",
            "---\nname: goose-help\n---\npersonal",
        );

        seed_bundled_skills_from_dir(source.path(), &bundled_skills_target(app_data.path()))
            .unwrap();
        let migrated = migrate_legacy_bundled_skills(
            source.path(),
            &bundled_skills_target(app_data.path()),
            app_data.path(),
            home.path(),
        )
        .unwrap();

        assert_eq!(migrated, 1);
        assert!(!legacy_root.join("agent-builder").exists());
        let recovered_skill = migration_recovery_root(app_data.path()).join("agent-builder");
        assert!(recovered_skill.join(SKILL_FILE_NAME).is_file());
        assert_eq!(
            fs::read_to_string(recovered_skill.join(SKILL_FILE_NAME)).unwrap(),
            "---\nname: agent-builder\nmetadata:\n  berdBundled: true\n---\npossibly edited"
        );
        assert!(legacy_root
            .join("goose-help")
            .join(SKILL_FILE_NAME)
            .is_file());
    }

    #[test]
    fn migration_preserves_existing_recovery_and_removes_recreated_managed_copy() {
        let source = tempdir().unwrap();
        let home = tempdir().unwrap();
        let app_data = tempdir().unwrap();
        write_skill(
            source.path(),
            "agent-builder",
            "---\nname: agent-builder\nmetadata:\n  berdBundled: true\n---\ncurrent",
        );
        let legacy_root = legacy_bundled_skills_root(home.path());
        write_skill(
            &legacy_root,
            "agent-builder",
            "---\nname: agent-builder\nmetadata:\n  berdBundled: true\n---\nlegacy",
        );
        write_skill(
            &migration_recovery_root(app_data.path()),
            "agent-builder",
            "---\nname: agent-builder\nmetadata:\n  berdBundled: true\n---\nrecovery",
        );

        seed_bundled_skills_from_dir(source.path(), &bundled_skills_target(app_data.path()))
            .unwrap();
        let migrated = migrate_legacy_bundled_skills(
            source.path(),
            &bundled_skills_target(app_data.path()),
            app_data.path(),
            home.path(),
        )
        .unwrap();

        assert_eq!(migrated, 1);
        assert!(!legacy_root.join("agent-builder").exists());
        assert_eq!(
            fs::read_to_string(
                migration_recovery_root(app_data.path())
                    .join("agent-builder")
                    .join(SKILL_FILE_NAME)
            )
            .unwrap(),
            "---\nname: agent-builder\nmetadata:\n  berdBundled: true\n---\nrecovery"
        );
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
            "---\nname: agent-builder\nmetadata:\n  berdBundled: true\n---\nupdated",
        );
        write_skill(
            target.path(),
            "agent-builder",
            "---\nname: agent-builder\nmetadata:\n  berdBundled: true\n---\nold",
        );

        let seeded = seed_bundled_skills_from_dir(source.path(), target.path()).unwrap();

        assert_eq!(seeded, 1);
        assert_eq!(
            fs::read_to_string(target.path().join("agent-builder").join(SKILL_FILE_NAME)).unwrap(),
            "---\nname: agent-builder\nmetadata:\n  berdBundled: true\n---\nupdated"
        );
    }

    #[test]
    fn recognizes_legacy_bundled_skill_marker() {
        let target = tempdir().unwrap();
        write_skill(
            target.path(),
            "agent-builder",
            "---\nname: agent-builder\nmetadata:\n  gooseInternalBundled: true\n---\nold",
        );

        assert!(is_installed_bundled_skill(&target.path().join("agent-builder")).unwrap());
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
