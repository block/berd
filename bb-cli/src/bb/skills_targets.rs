//! Target registry resolution and package linking for `bb skills`.
//!
//! The server's `/v1/marketplace/capabilities` response defines which agent
//! targets exist (claude, codex, agents, ...) and where each one reads skills
//! from. Installs write one canonical copy into the shared agents skills
//! directory (default `~/.agents/skills/<slug>`) and then link it into every
//! other requested target's real directory (e.g. `~/.claude/skills/<slug>`),
//! preferring symlinks with a copy fallback — mirroring sq-agents' install
//! behavior. `~/.bb` keeps only bb state (downloads, cache, locks) and
//! configuration.

use std::collections::BTreeMap;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::Serialize;

use super::skills_api::{exit_codes, failure, MarketplaceClient};
use super::skills_config::{SkillsConfig, META_FILE_NAME};
use super::skills_models::{CapabilitiesResponse, TargetConfig};
use super::skills_slug::confined_skill_path;

const CAPABILITIES_CACHE_FILE: &str = "capabilities.json";

/// Install scope: global agent directories or project-local ones.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scope {
    Global,
    Project,
}

impl Scope {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Global => "global",
            Self::Project => "project",
        }
    }
}

#[derive(Debug, Clone)]
pub struct TargetRegistry {
    pub targets: BTreeMap<String, TargetConfig>,
    /// Where the registry came from: `server`, `cache`, or `builtin`.
    pub source: &'static str,
}

impl TargetRegistry {
    /// Loads the registry from the server, caching it locally; falls back to
    /// the cached copy and then to built-in defaults when offline.
    pub fn load(config: &SkillsConfig, client: &MarketplaceClient) -> Result<Self> {
        match client.get_json::<CapabilitiesResponse>("/v1/marketplace/capabilities") {
            Ok(capabilities) if !capabilities.target_registry.is_empty() => {
                let registry = Self {
                    targets: capabilities.target_registry,
                    source: "server",
                };
                registry.write_cache(config);
                Ok(registry)
            }
            Ok(_) => Ok(Self::builtin()),
            Err(err) => {
                config.style.verbose(&format!(
                    "capabilities fetch failed, using cached/builtin registry: {err:#}"
                ));
                Ok(Self::load_cache(config).unwrap_or_else(Self::builtin))
            }
        }
    }

    /// Loads only from the local cache or built-in defaults; never touches
    /// the network. Used by `remove` and `which` so they work offline.
    pub fn load_offline(config: &SkillsConfig) -> Self {
        Self::load_cache(config).unwrap_or_else(Self::builtin)
    }

    fn load_cache(config: &SkillsConfig) -> Option<Self> {
        let path = config.cache_dir().join(CAPABILITIES_CACHE_FILE);
        let bytes = fs::read(path).ok()?;
        let capabilities = serde_json::from_slice::<CapabilitiesResponse>(&bytes).ok()?;
        if capabilities.target_registry.is_empty() {
            return None;
        }
        Some(Self {
            targets: capabilities.target_registry,
            source: "cache",
        })
    }

    fn write_cache(&self, config: &SkillsConfig) {
        let cache_dir = config.cache_dir();
        if fs::create_dir_all(&cache_dir).is_err() {
            return;
        }
        let payload = serde_json::json!({ "target_registry": self.targets });
        let _ = fs::write(
            cache_dir.join(CAPABILITIES_CACHE_FILE),
            serde_json::to_vec_pretty(&payload).unwrap_or_default(),
        );
    }

    /// Built-in fallback mirroring the server's default registry.
    pub fn builtin() -> Self {
        let target = |name: &str| TargetConfig {
            enabled: true,
            global_paths: vec![format!("~/.{name}/skills")],
            project_paths: vec![format!("./.{name}/skills")],
            link_strategies: vec!["symlink".to_string(), "copy".to_string()],
        };
        Self {
            targets: BTreeMap::from([
                ("agents".to_string(), target("agents")),
                ("claude".to_string(), target("claude")),
                ("codex".to_string(), target("codex")),
            ]),
            source: "builtin",
        }
    }

    /// Validates requested target names against the registry and resolves
    /// their concrete directories for the given scope.
    pub fn resolve(&self, requested: &[String], scope: Scope) -> Result<Vec<ResolvedTarget>> {
        let mut resolved = Vec::new();
        for name in requested {
            let Some(target) = self.targets.get(name) else {
                let known = self.targets.keys().cloned().collect::<Vec<_>>().join(", ");
                return Err(failure(
                    exit_codes::PLAN_BLOCKED,
                    "unknown_target",
                    format!("unknown target `{name}`; known targets: {known}"),
                ));
            };
            if !target.enabled {
                return Err(failure(
                    exit_codes::PLAN_BLOCKED,
                    "target_disabled",
                    format!("target `{name}` is disabled in the target registry"),
                ));
            }
            let paths = match scope {
                Scope::Global => &target.global_paths,
                Scope::Project => &target.project_paths,
            };
            let base_dirs = paths
                .iter()
                .map(|path| expand_path(path))
                .collect::<Vec<_>>();
            resolved.push(ResolvedTarget {
                name: name.clone(),
                base_dirs,
                prefer_symlink: prefer_symlink(&target.link_strategies),
            });
        }
        Ok(resolved)
    }
}

/// Prefer symlinks whenever the registry allows them; `copy` is the fallback.
fn prefer_symlink(strategies: &[String]) -> bool {
    strategies.is_empty() || strategies.iter().any(|strategy| strategy == "symlink")
}

#[derive(Debug, Clone, Serialize)]
pub struct ResolvedTarget {
    pub name: String,
    pub base_dirs: Vec<PathBuf>,
    pub prefer_symlink: bool,
}

/// Expands `~/...` against `$HOME` and leaves other paths (including
/// `./project` relative paths) untouched.
pub fn expand_path(path: &str) -> PathBuf {
    if let Some(rest) = path.strip_prefix("~/") {
        if let Ok(home) = env::var("HOME") {
            return PathBuf::from(home).join(rest);
        }
    }
    PathBuf::from(path)
}

#[derive(Debug, Clone, Serialize)]
pub struct LinkOutcome {
    pub path: PathBuf,
    /// `symlink`, `copy`, or `existing` (already resolves to the package).
    pub strategy: &'static str,
    /// An unmanaged skill displaced while creating this link. Reported with
    /// the enclosing install/update result rather than nested under `links`.
    #[serde(skip)]
    pub backup: Option<BackupOutcome>,
    #[serde(skip)]
    rollback: Option<PathBuf>,
}

#[derive(Debug, Clone, Serialize)]
pub struct BackupOutcome {
    pub source_path: PathBuf,
    pub backup_path: PathBuf,
    pub created_at: String,
}

/// Links `package_dir` into `<base_dir>/<slug>` using the target's preferred
/// strategy. Handles the gnarly cases sq-agents handles: the base dir itself
/// being a symlink to the canonical location, tools replacing symlinks with
/// real directories, and missing parent directories.
pub fn link_into_target(
    package_dir: &Path,
    base_dir: &Path,
    slug: &str,
    prefer_symlink: bool,
) -> Result<LinkOutcome> {
    let link_path = confined_skill_path(base_dir, slug)?;

    // If the path already resolves to the canonical package (for example
    // ~/.claude/skills is itself a symlink into the packages dir), leave it.
    if let (Ok(resolved), Ok(canonical_package)) =
        (fs::canonicalize(&link_path), fs::canonicalize(package_dir))
    {
        if resolved == canonical_package {
            return Ok(LinkOutcome {
                path: link_path,
                strategy: "existing",
                backup: None,
                rollback: None,
            });
        }
    }

    fs::create_dir_all(base_dir).with_context(|| format!("create {}", base_dir.display()))?;
    let (backup, rollback) = prepare_target_path(&link_path, package_dir)?;

    if prefer_symlink {
        #[cfg(unix)]
        {
            match std::os::unix::fs::symlink(package_dir, &link_path) {
                Ok(()) => {
                    return Ok(LinkOutcome {
                        path: link_path,
                        strategy: "symlink",
                        backup,
                        rollback,
                    })
                }
                Err(err) => {
                    // Fall through to the copy strategy on filesystems that
                    // reject symlinks.
                    let _ = err;
                }
            }
        }
    }

    if let Err(error) = copy_dir_recursive(package_dir, &link_path) {
        restore_target_path(&link_path, &backup, &rollback)?;
        return Err(error).with_context(|| {
            format!(
                "link {} into {}",
                package_dir.display(),
                link_path.display()
            )
        });
    }
    Ok(LinkOutcome {
        path: link_path,
        strategy: "copy",
        backup,
        rollback,
    })
}

/// Removes an existing symlink, or a bb-owned directory that replaced one,
/// returning any unmanaged skill backup created while clearing the path
/// (some tools like Cursor materialize symlinks into real directories).
/// Unmanaged paths are moved under the skills directory's `.backups` folder
/// before the target link is installed.
fn prepare_target_path(
    path: &Path,
    package_dir: &Path,
) -> Result<(Option<BackupOutcome>, Option<PathBuf>)> {
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return Ok((None, None));
    };
    if metadata.file_type().is_symlink() {
        // A metadata file alone is not proof of ownership: a user may link
        // their own package which happens to contain one. Only replace a link
        // when both paths resolve to the canonical package we are installing.
        if matches!(
            (fs::canonicalize(path), fs::canonicalize(package_dir)),
            (Ok(target), Ok(package)) if target == package
        ) {
            fs::remove_file(path).with_context(|| format!("remove symlink {}", path.display()))?;
            return Ok((None, None));
        }
        return backup_unmanaged_path(path).map(|backup| (Some(backup), None));
    }
    if metadata.is_dir() {
        if path.join(META_FILE_NAME).is_file() {
            let rollback = target_rollback_path(path);
            fs::rename(path, &rollback)
                .with_context(|| format!("prepare to replace {}", path.display()))?;
            return Ok((None, Some(rollback)));
        }
        return backup_unmanaged_path(path).map(|backup| (Some(backup), None));
    }
    backup_unmanaged_path(path).map(|backup| (Some(backup), None))
}

fn target_rollback_path(path: &Path) -> PathBuf {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("skill");
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    path.with_file_name(format!(".{name}.previous-{}-{nanos}", std::process::id()))
}

fn restore_target_path(
    path: &Path,
    backup: &Option<BackupOutcome>,
    rollback: &Option<PathBuf>,
) -> Result<()> {
    remove_any(path).with_context(|| format!("remove failed target {}", path.display()))?;
    if let Some(backup) = backup {
        fs::rename(&backup.backup_path, &backup.source_path).with_context(|| {
            format!(
                "restore target backup {} to {} after link failure",
                backup.backup_path.display(),
                backup.source_path.display()
            )
        })?;
    } else if let Some(rollback) = rollback {
        fs::rename(rollback, path).with_context(|| {
            format!(
                "restore previous target {} to {} after link failure",
                rollback.display(),
                path.display()
            )
        })?;
    }
    Ok(())
}

pub fn rollback_link(outcome: &LinkOutcome) -> Result<()> {
    if outcome.strategy == "existing" {
        return Ok(());
    }
    restore_target_path(&outcome.path, &outcome.backup, &outcome.rollback)
}

pub fn finish_link(outcome: &LinkOutcome) {
    if let Some(rollback) = &outcome.rollback {
        let _ = remove_any(rollback);
    }
}

pub fn backup_unmanaged_path(path: &Path) -> Result<BackupOutcome> {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("skill");
    let parent = path.parent().context("skill path has no parent")?;
    let backup_root = parent.join(".backups");
    fs::create_dir_all(&backup_root)
        .with_context(|| format!("create backup directory {}", backup_root.display()))?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .context("system clock is before UNIX epoch")?;
    let created_at = iso8601_utc(now.as_secs());
    let created_at = format!("{}Z", &created_at[..16]);
    let timestamp = created_at.trim_end_matches('Z').replace(['-', ':'], "");
    let backup = available_backup_path(&backup_root, name, &format!("{timestamp}Z"))?;
    fs::rename(path, &backup).with_context(|| {
        format!(
            "backup unmanaged skill {} to {}",
            path.display(),
            backup.display()
        )
    })?;
    Ok(BackupOutcome {
        source_path: path.to_path_buf(),
        backup_path: backup,
        created_at,
    })
}

fn available_backup_path(root: &Path, name: &str, timestamp: &str) -> Result<PathBuf> {
    for sequence in 1_u64.. {
        let suffix = if sequence == 1 {
            String::new()
        } else {
            format!("-{sequence}")
        };
        let candidate = root.join(format!("{name}-{timestamp}{suffix}"));
        match fs::symlink_metadata(&candidate) {
            Ok(_) => continue,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(candidate),
            Err(error) => {
                return Err(error)
                    .with_context(|| format!("inspect backup path {}", candidate.display()))
            }
        }
    }
    unreachable!("backup sequence is unbounded")
}

/// Formats a UNIX timestamp as ISO-8601 UTC (`2026-06-10T12:34:56Z`) without
/// pulling in a date dependency. Uses Howard Hinnant's civil-date algorithm.
pub fn iso8601_utc(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let secs_of_day = secs % 86_400;
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { year + 1 } else { year };
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        secs_of_day / 3600,
        (secs_of_day % 3600) / 60,
        secs_of_day % 60
    )
}

/// Forcefully removes whatever is at `path` (used by `remove
/// --include-unmanaged --force`).
pub fn remove_any(path: &Path) -> Result<()> {
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return Ok(());
    };
    if metadata.file_type().is_symlink() || metadata.is_file() {
        fs::remove_file(path).with_context(|| format!("remove {}", path.display()))
    } else {
        fs::remove_dir_all(path).with_context(|| format!("remove {}", path.display()))
    }
}

/// Reports the state of one expected target link.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LinkState {
    Ok,
    Missing,
    Broken,
    Unmanaged,
}

pub fn inspect_link(link_path: &Path, package_dir: &Path) -> LinkState {
    let Ok(metadata) = fs::symlink_metadata(link_path) else {
        return LinkState::Missing;
    };
    if metadata.file_type().is_symlink() {
        match (fs::canonicalize(link_path), fs::canonicalize(package_dir)) {
            (Ok(resolved), Ok(canonical)) if resolved == canonical => LinkState::Ok,
            (Err(_), _) => LinkState::Broken,
            _ => LinkState::Broken,
        }
    } else if metadata.is_dir() {
        if link_path.join(META_FILE_NAME).is_file() {
            LinkState::Ok
        } else {
            LinkState::Unmanaged
        }
    } else {
        LinkState::Unmanaged
    }
}

pub fn copy_dir_recursive(source: &Path, destination: &Path) -> Result<()> {
    fs::create_dir_all(destination).with_context(|| format!("create {}", destination.display()))?;
    for entry in fs::read_dir(source).with_context(|| format!("read {}", source.display()))? {
        let entry = entry.with_context(|| format!("read entry in {}", source.display()))?;
        let file_type = entry
            .file_type()
            .with_context(|| format!("stat {}", entry.path().display()))?;
        let to = destination.join(entry.file_name());
        if file_type.is_dir() {
            copy_dir_recursive(&entry.path(), &to)?;
        } else if file_type.is_file() {
            fs::copy(entry.path(), &to).with_context(|| format!("copy {}", to.display()))?;
        } else {
            anyhow::bail!("refusing to copy special file {}", entry.path().display());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builtin_registry_covers_default_targets() {
        let registry = TargetRegistry::builtin();
        assert!(registry.targets.contains_key("agents"));
        assert!(registry.targets.contains_key("claude"));
        assert!(registry.targets.contains_key("codex"));
    }

    #[test]
    fn resolve_rejects_unknown_targets() {
        let registry = TargetRegistry::builtin();
        let error = registry
            .resolve(&["bogus".to_string()], Scope::Global)
            .expect_err("unknown target should fail");
        assert!(error.to_string().contains("unknown target `bogus`"));
        assert!(error.to_string().contains("agents"));
    }

    #[test]
    fn expand_path_resolves_home_prefix() {
        let home = env::var("HOME").expect("HOME set in tests");
        assert_eq!(
            expand_path("~/.claude/skills"),
            PathBuf::from(home).join(".claude/skills")
        );
        assert_eq!(
            expand_path("./.claude/skills"),
            PathBuf::from("./.claude/skills")
        );
    }

    #[cfg(unix)]
    #[test]
    fn link_into_target_creates_and_replaces_symlinks() {
        let temp = std::env::temp_dir().join(format!(
            "bb-link-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        let package = temp.join("packages/demo");
        fs::create_dir_all(&package).expect("create package");
        fs::write(package.join("SKILL.md"), "# Demo").expect("write skill");
        let base = temp.join("agent/skills");

        let outcome = link_into_target(&package, &base, "demo", true).expect("link into target");
        assert_eq!(outcome.strategy, "symlink");
        assert!(base.join("demo/SKILL.md").is_file());
        assert_eq!(inspect_link(&base.join("demo"), &package), LinkState::Ok);

        // Re-linking replaces the existing symlink without error.
        let outcome = link_into_target(&package, &base, "demo", true).expect("relink into target");
        assert_eq!(outcome.strategy, "existing");

        fs::remove_dir_all(temp).expect("cleanup");
    }

    #[cfg(unix)]
    #[test]
    fn link_into_target_backs_up_unmanaged_directories() {
        let temp = std::env::temp_dir().join(format!(
            "bb-link-unmanaged-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        let package = temp.join("packages/demo");
        fs::create_dir_all(&package).expect("create package");
        let base = temp.join("agent/skills");
        fs::create_dir_all(base.join("demo")).expect("create unmanaged dir");
        fs::write(base.join("demo/user.md"), "mine").expect("write user file");

        let outcome =
            link_into_target(&package, &base, "demo", true).expect("link should replace conflict");
        assert_eq!(outcome.strategy, "symlink");
        assert!(base.join("demo").is_symlink());
        let backup = outcome.backup.expect("backup outcome");
        assert_eq!(backup.source_path, base.join("demo"));
        assert_eq!(
            backup.backup_path.parent(),
            Some(base.join(".backups").as_path())
        );
        assert!(backup
            .backup_path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with("demo-")));
        assert!(backup.created_at.ends_with('Z'));
        assert!(backup.created_at.contains('T'));
        assert_eq!(backup.created_at.matches(':').count(), 1);
        let backups = fs::read_dir(base.join(".backups"))
            .expect("read backup directory")
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.path())
            .collect::<Vec<_>>();
        assert_eq!(backups.len(), 1);
        assert_eq!(
            fs::read_to_string(backups[0].join("user.md")).expect("read backup"),
            "mine"
        );

        fs::remove_dir_all(temp).expect("cleanup");
    }

    #[cfg(unix)]
    #[test]
    fn link_into_target_preserves_unmanaged_and_broken_symlinks() {
        let temp = std::env::temp_dir().join(format!(
            "bb-link-symlink-conflicts-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        let package = temp.join("packages/demo");
        let foreign = temp.join("packages/foreign");
        fs::create_dir_all(&package).expect("create package");
        fs::create_dir_all(&foreign).expect("create foreign package");
        fs::write(foreign.join(META_FILE_NAME), "{}").expect("write foreign marker");
        let base = temp.join("agent/skills");
        fs::create_dir_all(&base).expect("create target directory");

        for (slug, target) in [
            ("manual", foreign.as_path()),
            ("broken", Path::new("missing-package")),
        ] {
            let link = base.join(slug);
            std::os::unix::fs::symlink(target, &link).expect("create conflict link");
            let original = fs::read_link(&link).expect("read original link");

            let outcome = link_into_target(&package, &base, slug, true).expect("replace conflict");
            let backup = outcome.backup.expect("backup outcome");
            assert_eq!(
                fs::read_link(&backup.backup_path).expect("read backed up link"),
                original
            );
            assert!(base.join(slug).is_symlink());
        }

        let relative = base.join("relative");
        std::os::unix::fs::symlink("../../packages/foreign", &relative)
            .expect("create relative link");
        let outcome =
            link_into_target(&package, &base, "relative", true).expect("replace relative link");
        let backup = outcome.backup.expect("relative link backup");
        assert_eq!(
            fs::read_link(&backup.backup_path).expect("read relative backup"),
            PathBuf::from("../../packages/foreign")
        );

        fs::remove_dir_all(temp).expect("cleanup");
    }

    #[test]
    fn available_backup_path_adds_sequence_for_same_minute() {
        let temp = std::env::temp_dir().join(format!(
            "bb-backup-sequence-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        fs::create_dir_all(temp.join("demo-20260713T2248Z")).expect("create first backup");
        fs::create_dir_all(temp.join("demo-20260713T2248Z-2")).expect("create second backup");

        let available = available_backup_path(&temp, "demo", "20260713T2248Z")
            .expect("find available backup path");

        assert_eq!(available, temp.join("demo-20260713T2248Z-3"));
        fs::remove_dir_all(temp).expect("cleanup");
    }
}
