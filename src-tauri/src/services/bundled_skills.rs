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

/// Bundled skills renamed in place (old app-owned skill directory name -> new
/// name). Adding an entry here retires an installed copy of the old name to
/// recovery (same safety rule as the legacy home-directory migrations: only a
/// copy that still carries the `berdBundled`/`gooseInternalBundled` marker is
/// touched, so a user's own edited copy is never silently replaced) before
/// normal seeding installs the new name fresh.
const RENAMED_BUNDLED_SKILLS: &[(&str, &str)] = &[("goose-help", "berd-help")];

pub fn seed_bundled_skills(
    bundle: &DistroBundle,
    app_data_dir: &Path,
    migrate_from_home: bool,
) -> Result<usize, String> {
    let source_root = bundle.root_dir.join(DISTRO_SKILLS_DIR_NAME);
    let target_root = bundled_skills_target(app_data_dir);
    migrate_renamed_bundled_skills(&target_root, app_data_dir)?;
    let seeded = seed_bundled_skills_from_dir(&source_root, &target_root)?;

    if migrate_from_home {
        let Some(home_dir) = dirs::home_dir() else {
            return Err("Failed to resolve home directory for bundled skills".to_string());
        };
        migrate_legacy_bundled_skills(&source_root, &target_root, app_data_dir, &home_dir)?;
        migrate_spike_bundled_skills(&source_root, &target_root, app_data_dir, &home_dir)?;
        migrate_renamed_legacy_home_skills(&target_root, app_data_dir, &home_dir)?;
        migrate_renamed_dot_berd_skills(&target_root, app_data_dir, &home_dir)?;
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

/// Pin-identity aliases for bundled skills renamed in place (see
/// `RENAMED_BUNDLED_SKILLS`). A user's Home pin on the old app skill id
/// (`app:<...>/skills/<old_name>`) must keep resolving to the renamed skill,
/// the same way a Home pin on a pre-migration Personal skill keeps resolving
/// after that migration (see `migrated_legacy_skill_aliases`).
///
/// Only produces an alias once the old name has actually been retired by
/// `migrate_renamed_bundled_skills` (a recovery copy exists) -- an install
/// that never had the old name installed has nothing to alias.
///
/// Also includes aliases for an old copy retired from a legacy home
/// directory (see `renamed_bundled_skill_legacy_home_pin_aliases`), unless
/// `include_home_aliases` is false (e.g. under e2e mode, matching how
/// `migrated_legacy_skill_aliases` gates its own home-directory lookups).
pub fn renamed_bundled_skill_pin_aliases(
    app_data_dir: &Path,
    include_home_aliases: bool,
) -> Vec<(String, String)> {
    let recovery_root = renamed_bundled_skills_recovery_root(app_data_dir);
    let target_root = bundled_skills_target(app_data_dir);

    let mut aliases: Vec<(String, String)> = RENAMED_BUNDLED_SKILLS
        .iter()
        .filter_map(|(old_name, new_name)| {
            let recovery = recovery_root.join(old_name);
            if !is_installed_bundled_skill(&recovery).unwrap_or(false) {
                return None;
            }
            let old_path = target_root.join(old_name);
            Some((new_name.to_string(), format!("app:{}", old_path.display())))
        })
        .collect();

    if include_home_aliases {
        if let Some(home_dir) = dirs::home_dir() {
            aliases.extend(renamed_bundled_skill_legacy_home_pin_aliases(
                app_data_dir,
                &home_dir,
            ));
        }
    }

    aliases
}

/// Pin-identity aliases for a bundled skill's old name when that old copy
/// was retired from a legacy home directory (`~/.agents/skills` or
/// `~/.berd/skills`), rather than from the app data directory -- see
/// `migrate_renamed_legacy_home_skills` / `migrate_renamed_dot_berd_skills`.
/// A Home pin on that legacy copy was a `global:<path>` id, not an
/// `app:<path>` id, so this produces the matching alias shape.
fn renamed_bundled_skill_legacy_home_pin_aliases(
    app_data_dir: &Path,
    home_dir: &Path,
) -> Vec<(String, String)> {
    let recovery_roots_and_legacy_root = [
        (
            renamed_bundled_skills_legacy_home_recovery_root(app_data_dir),
            legacy_bundled_skills_root(home_dir),
        ),
        (
            renamed_bundled_skills_dot_berd_recovery_root(app_data_dir),
            home_dir.join(BERD_LEGACY_DIR_NAME).join(SKILLS_DIR_NAME),
        ),
    ];

    recovery_roots_and_legacy_root
        .iter()
        .flat_map(|(recovery_root, legacy_root)| {
            RENAMED_BUNDLED_SKILLS
                .iter()
                .filter_map(|(old_name, new_name)| {
                    let recovery = recovery_root.join(old_name);
                    if !is_installed_bundled_skill(&recovery).unwrap_or(false) {
                        return None;
                    }
                    let legacy_path = legacy_root.join(old_name);
                    if legacy_path.exists()
                        && !is_installed_bundled_skill(&legacy_path).unwrap_or(false)
                    {
                        // A user has since created their own unmarked skill
                        // at the old legacy path -- the migrated app skill
                        // must not claim its pin (mirrors
                        // migrated_legacy_skill_aliases_for_home).
                        return None;
                    }
                    Some((
                        new_name.to_string(),
                        format!("global:{}", legacy_path.display()),
                    ))
                })
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

fn renamed_bundled_skills_recovery_root(app_data_dir: &Path) -> std::path::PathBuf {
    app_data_dir
        .join(RECOVERY_DIR_NAME)
        .join("skills-renamed-v1")
}

fn renamed_bundled_skills_legacy_home_recovery_root(app_data_dir: &Path) -> std::path::PathBuf {
    renamed_bundled_skills_recovery_root(app_data_dir).join("legacy-home")
}

fn renamed_bundled_skills_dot_berd_recovery_root(app_data_dir: &Path) -> std::path::PathBuf {
    renamed_bundled_skills_recovery_root(app_data_dir).join("dot-berd")
}

/// Retires an installed copy of a bundled skill's old name to recovery when
/// the skill has been renamed (see `RENAMED_BUNDLED_SKILLS`). Only touches an
/// old copy that still carries the app-bundled marker -- a user's own
/// same-named Personal skill, or one they've already edited into an
/// unmarked copy, is left alone. Safe to call on every launch: once the old
/// copy is gone (already migrated, or never installed), this is a no-op.
///
/// `old_root` is where old-named copies are looked for (the app-data skills
/// directory, or a legacy home directory). When `require_new_at` is set, the
/// old copy is only retired once the renamed skill's new canonical copy is
/// already present under that root -- the same "never remove the working
/// copy until the replacement is present and readable" invariant
/// `migrate_marker_owned_skills` applies for ordinary legacy migrations.
fn retire_renamed_skill_copies(
    old_root: &Path,
    recovery_root: &Path,
    require_new_at: Option<&Path>,
) -> Result<usize, String> {
    let mut migrated = 0usize;

    for (old_name, new_name) in RENAMED_BUNDLED_SKILLS {
        let old_path = old_root.join(old_name);
        if !old_path.join(SKILL_FILE_NAME).is_file() {
            continue;
        }
        if !is_installed_bundled_skill(&old_path)? {
            // Not (or no longer) app-owned -- a user's own skill has since
            // taken this name. Leave it alone; don't touch or rename it.
            continue;
        }
        if let Some(target_root) = require_new_at {
            if !target_root.join(new_name).join(SKILL_FILE_NAME).is_file() {
                continue;
            }
        }

        fs::create_dir_all(recovery_root).map_err(|err| {
            format!(
                "Failed to create bundled skill recovery directory '{}': {err}",
                recovery_root.display()
            )
        })?;
        let recovery = recovery_root.join(old_name);
        if recovery.exists() {
            // Already retired on a previous launch; just remove the
            // recreated managed copy (mirrors migrate_marker_owned_skills).
            if is_installed_bundled_skill(&recovery)? {
                fs::remove_dir_all(&old_path).map_err(|err| {
                    format!(
                        "Failed to remove renamed bundled skill '{}': {err}",
                        old_path.display()
                    )
                })?;
                migrated += 1;
            }
            continue;
        }

        // copy_legacy_skill_to_recovery removes old_path once the recovery
        // copy is verified and finalized.
        copy_legacy_skill_to_recovery(&old_path, &recovery)?;
        migrated += 1;
    }

    Ok(migrated)
}

fn migrate_renamed_bundled_skills(
    target_root: &Path,
    app_data_dir: &Path,
) -> Result<usize, String> {
    // The new name is installed fresh by the normal
    // seed_bundled_skills_from_dir call that follows this one in
    // seed_bundled_skills, so there's nothing to gate on here.
    retire_renamed_skill_copies(
        target_root,
        &renamed_bundled_skills_recovery_root(app_data_dir),
        None,
    )
}

/// Same rename retirement as `migrate_renamed_bundled_skills`, but for a
/// marker-owned old-named copy left behind in `~/.agents/skills` from before
/// PR #974 moved app-owned skills into the app data directory. Without this,
/// an install upgrading across that gap keeps a stale `goose-help` under
/// `~/.agents/skills` forever: the ordinary legacy-home migration
/// (`migrate_marker_owned_skills`) only ever looks up *current* distro skill
/// names there, so it never finds a copy sitting under the old name.
fn migrate_renamed_legacy_home_skills(
    target_root: &Path,
    app_data_dir: &Path,
    home_dir: &Path,
) -> Result<usize, String> {
    retire_renamed_skill_copies(
        &legacy_bundled_skills_root(home_dir),
        &renamed_bundled_skills_legacy_home_recovery_root(app_data_dir),
        Some(target_root),
    )
}

/// Same as `migrate_renamed_legacy_home_skills`, for the older `~/.berd`
/// spike location.
fn migrate_renamed_dot_berd_skills(
    target_root: &Path,
    app_data_dir: &Path,
    home_dir: &Path,
) -> Result<usize, String> {
    retire_renamed_skill_copies(
        &home_dir.join(BERD_LEGACY_DIR_NAME).join(SKILLS_DIR_NAME),
        &renamed_bundled_skills_dot_berd_recovery_root(app_data_dir),
        Some(target_root),
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
    fn renames_marker_owned_installed_skill_to_recovery() {
        let app_data = tempdir().unwrap();
        let target_root = bundled_skills_target(app_data.path());
        write_skill(
            &target_root,
            "goose-help",
            "---\nname: goose-help\nmetadata:\n  berdBundled: true\n---\ncurrent",
        );

        let migrated = migrate_renamed_bundled_skills(&target_root, app_data.path()).unwrap();

        assert_eq!(migrated, 1);
        assert!(!target_root.join("goose-help").exists());
        let recovered = renamed_bundled_skills_recovery_root(app_data.path()).join("goose-help");
        assert!(recovered.join(SKILL_FILE_NAME).is_file());
        assert_eq!(
            fs::read_to_string(recovered.join(SKILL_FILE_NAME)).unwrap(),
            "---\nname: goose-help\nmetadata:\n  berdBundled: true\n---\ncurrent"
        );
    }

    #[test]
    fn leaves_unmarked_skill_at_the_old_name_alone() {
        let app_data = tempdir().unwrap();
        let target_root = bundled_skills_target(app_data.path());
        // A user created their own unrelated "goose-help" skill; it doesn't
        // carry the app-bundled marker, so the rename must not touch it.
        write_skill(
            &target_root,
            "goose-help",
            "---\nname: goose-help\n---\nmy own notes",
        );

        let migrated = migrate_renamed_bundled_skills(&target_root, app_data.path()).unwrap();

        assert_eq!(migrated, 0);
        assert_eq!(
            fs::read_to_string(target_root.join("goose-help").join(SKILL_FILE_NAME)).unwrap(),
            "---\nname: goose-help\n---\nmy own notes"
        );
    }

    #[test]
    fn is_a_no_op_once_the_old_name_is_already_retired() {
        let app_data = tempdir().unwrap();
        let target_root = bundled_skills_target(app_data.path());

        write_skill(
            &target_root,
            "goose-help",
            "---\nname: goose-help\nmetadata:\n  berdBundled: true\n---\ncurrent",
        );
        assert_eq!(
            migrate_renamed_bundled_skills(&target_root, app_data.path()).unwrap(),
            1
        );
        assert!(!target_root.join("goose-help").exists());

        // Second launch: seeding has since installed berd-help, but nothing
        // reintroduced goose-help. Nothing to do.
        assert_eq!(
            migrate_renamed_bundled_skills(&target_root, app_data.path()).unwrap(),
            0
        );
    }

    #[test]
    fn removes_recreated_managed_copy_when_recovery_already_exists() {
        let app_data = tempdir().unwrap();
        let target_root = bundled_skills_target(app_data.path());
        write_skill(
            &renamed_bundled_skills_recovery_root(app_data.path()),
            "goose-help",
            "---\nname: goose-help\nmetadata:\n  berdBundled: true\n---\nrecovery",
        );
        // An older Berd reinstalled goose-help after a previous retirement.
        write_skill(
            &target_root,
            "goose-help",
            "---\nname: goose-help\nmetadata:\n  berdBundled: true\n---\nrecreated",
        );

        let migrated = migrate_renamed_bundled_skills(&target_root, app_data.path()).unwrap();

        assert_eq!(migrated, 1);
        assert!(!target_root.join("goose-help").exists());
        assert_eq!(
            fs::read_to_string(
                renamed_bundled_skills_recovery_root(app_data.path())
                    .join("goose-help")
                    .join(SKILL_FILE_NAME)
            )
            .unwrap(),
            "---\nname: goose-help\nmetadata:\n  berdBundled: true\n---\nrecovery"
        );
    }

    #[test]
    fn renamed_skill_pin_alias_resolves_only_after_retirement() {
        let app_data = tempdir().unwrap();

        // Before retirement: no alias yet, nothing installed at the old name.
        assert!(renamed_bundled_skill_pin_aliases(app_data.path(), false).is_empty());

        let target_root = bundled_skills_target(app_data.path());
        write_skill(
            &target_root,
            "goose-help",
            "---\nname: goose-help\nmetadata:\n  berdBundled: true\n---\ncurrent",
        );
        migrate_renamed_bundled_skills(&target_root, app_data.path()).unwrap();

        let aliases = renamed_bundled_skill_pin_aliases(app_data.path(), false);
        assert_eq!(aliases.len(), 1);
        let (new_name, old_pin_id) = &aliases[0];
        assert_eq!(new_name, "berd-help");
        assert_eq!(
            old_pin_id,
            &format!("app:{}", target_root.join("goose-help").display())
        );
    }

    #[test]
    fn retires_marker_owned_renamed_skill_left_in_legacy_agents_home() {
        let home = tempdir().unwrap();
        let app_data = tempdir().unwrap();
        let target_root = bundled_skills_target(app_data.path());

        // Upgrading across the pre-#974 gap: the old-named skill was never
        // migrated out of ~/.agents/skills, and berd-help has since been
        // seeded into the app data directory under its new name.
        let legacy_root = legacy_bundled_skills_root(home.path());
        write_skill(
            &legacy_root,
            "goose-help",
            "---\nname: goose-help\nmetadata:\n  berdBundled: true\n---\nold home copy",
        );
        write_skill(
            &target_root,
            "berd-help",
            "---\nname: berd-help\nmetadata:\n  berdBundled: true\n---\ncurrent",
        );

        let migrated =
            migrate_renamed_legacy_home_skills(&target_root, app_data.path(), home.path()).unwrap();

        assert_eq!(migrated, 1);
        assert!(!legacy_root.join("goose-help").exists());
        let recovered =
            renamed_bundled_skills_legacy_home_recovery_root(app_data.path()).join("goose-help");
        assert_eq!(
            fs::read_to_string(recovered.join(SKILL_FILE_NAME)).unwrap(),
            "---\nname: goose-help\nmetadata:\n  berdBundled: true\n---\nold home copy"
        );
    }

    #[test]
    fn does_not_retire_legacy_home_copy_until_the_new_name_is_seeded() {
        let home = tempdir().unwrap();
        let app_data = tempdir().unwrap();
        let target_root = bundled_skills_target(app_data.path());

        // berd-help has not been seeded yet (e.g. seeding failed, or this
        // runs before the seed step) -- don't remove the only working copy.
        let legacy_root = legacy_bundled_skills_root(home.path());
        write_skill(
            &legacy_root,
            "goose-help",
            "---\nname: goose-help\nmetadata:\n  berdBundled: true\n---\nold home copy",
        );

        let migrated =
            migrate_renamed_legacy_home_skills(&target_root, app_data.path(), home.path()).unwrap();

        assert_eq!(migrated, 0);
        assert!(legacy_root
            .join("goose-help")
            .join(SKILL_FILE_NAME)
            .is_file());
    }

    #[test]
    fn retires_marker_owned_renamed_skill_left_in_dot_berd_spike_dir() {
        let home = tempdir().unwrap();
        let app_data = tempdir().unwrap();
        let target_root = bundled_skills_target(app_data.path());

        let spike_root = home.path().join(BERD_LEGACY_DIR_NAME).join(SKILLS_DIR_NAME);
        write_skill(
            &spike_root,
            "goose-help",
            "---\nname: goose-help\nmetadata:\n  berdBundled: true\n---\nspike copy",
        );
        write_skill(
            &target_root,
            "berd-help",
            "---\nname: berd-help\nmetadata:\n  berdBundled: true\n---\ncurrent",
        );

        let migrated =
            migrate_renamed_dot_berd_skills(&target_root, app_data.path(), home.path()).unwrap();

        assert_eq!(migrated, 1);
        assert!(!spike_root.join("goose-help").exists());
    }

    #[test]
    fn legacy_home_rename_alias_is_suppressed_when_a_personal_skill_reuses_the_old_name() {
        let home = tempdir().unwrap();
        let app_data = tempdir().unwrap();
        let target_root = bundled_skills_target(app_data.path());

        let legacy_root = legacy_bundled_skills_root(home.path());
        write_skill(
            &legacy_root,
            "goose-help",
            "---\nname: goose-help\nmetadata:\n  berdBundled: true\n---\nold home copy",
        );
        write_skill(
            &target_root,
            "berd-help",
            "---\nname: berd-help\nmetadata:\n  berdBundled: true\n---\ncurrent",
        );
        migrate_renamed_legacy_home_skills(&target_root, app_data.path(), home.path()).unwrap();

        // A user then creates their own unmarked "goose-help" at the same
        // legacy path -- the alias must not claim their skill's pin.
        write_skill(
            &legacy_root,
            "goose-help",
            "---\nname: goose-help\n---\nmine",
        );

        let aliases = renamed_bundled_skill_legacy_home_pin_aliases(app_data.path(), home.path());
        assert!(aliases.is_empty());
    }

    #[test]
    fn renamed_skill_pin_aliases_include_legacy_home_alias_when_requested() {
        let home = tempdir().unwrap();
        let app_data = tempdir().unwrap();
        let target_root = bundled_skills_target(app_data.path());

        let legacy_root = legacy_bundled_skills_root(home.path());
        write_skill(
            &legacy_root,
            "goose-help",
            "---\nname: goose-help\nmetadata:\n  berdBundled: true\n---\nold home copy",
        );
        write_skill(
            &target_root,
            "berd-help",
            "---\nname: berd-help\nmetadata:\n  berdBundled: true\n---\ncurrent",
        );
        migrate_renamed_legacy_home_skills(&target_root, app_data.path(), home.path()).unwrap();

        // Excluded when the caller opts out of home aliases (e2e mode).
        assert!(renamed_bundled_skill_pin_aliases(app_data.path(), false).is_empty());

        // dirs::home_dir() drives include_home_aliases=true in production,
        // and isn't overridable in this test, so exercise the underlying
        // legacy-home helper directly for the "included" case instead of
        // going through the real home directory.
        let aliases = renamed_bundled_skill_legacy_home_pin_aliases(app_data.path(), home.path());
        assert_eq!(aliases.len(), 1);
        let (new_name, old_pin_id) = &aliases[0];
        assert_eq!(new_name, "berd-help");
        assert_eq!(
            old_pin_id,
            &format!("global:{}", legacy_root.join("goose-help").display())
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
