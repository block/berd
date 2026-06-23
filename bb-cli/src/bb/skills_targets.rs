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
    let link_path = base_dir.join(slug);

    // If the path already resolves to the canonical package (for example
    // ~/.claude/skills is itself a symlink into the packages dir), leave it.
    if let (Ok(resolved), Ok(canonical_package)) =
        (fs::canonicalize(&link_path), fs::canonicalize(package_dir))
    {
        if resolved == canonical_package {
            return Ok(LinkOutcome {
                path: link_path,
                strategy: "existing",
            });
        }
    }

    fs::create_dir_all(base_dir).with_context(|| format!("create {}", base_dir.display()))?;
    remove_link_or_managed_dir(&link_path)?;

    if prefer_symlink {
        #[cfg(unix)]
        {
            match std::os::unix::fs::symlink(package_dir, &link_path) {
                Ok(()) => {
                    return Ok(LinkOutcome {
                        path: link_path,
                        strategy: "symlink",
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

    copy_dir_recursive(package_dir, &link_path)?;
    Ok(LinkOutcome {
        path: link_path,
        strategy: "copy",
    })
}

/// Removes an existing symlink, or a managed directory that replaced one
/// (some tools like Cursor materialize symlinks into real directories).
/// Refuses to delete unmanaged real directories.
pub fn remove_link_or_managed_dir(path: &Path) -> Result<()> {
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return Ok(());
    };
    if metadata.file_type().is_symlink() {
        fs::remove_file(path).with_context(|| format!("remove symlink {}", path.display()))?;
        return Ok(());
    }
    if metadata.is_dir() {
        if path.join(META_FILE_NAME).is_file() {
            fs::remove_dir_all(path).with_context(|| format!("remove {}", path.display()))?;
            return Ok(());
        }
        return Err(failure(
            exit_codes::FS_CONFLICT,
            "unmanaged_target_dir",
            format!(
                "{} already exists and is not managed by bb skills; refusing to overwrite (pass --include-unmanaged --force to override on remove)",
                path.display()
            ),
        ));
    }
    Err(failure(
        exit_codes::FS_CONFLICT,
        "unmanaged_target_file",
        format!(
            "{} already exists and is not a directory or symlink; refusing to overwrite",
            path.display()
        ),
    ))
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
    fn link_into_target_refuses_unmanaged_directories() {
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

        let error = link_into_target(&package, &base, "demo", true)
            .expect_err("unmanaged dir should refuse");
        assert!(error.to_string().contains("refusing to overwrite"));
        assert!(base.join("demo/user.md").is_file());

        fs::remove_dir_all(temp).expect("cleanup");
    }
}
