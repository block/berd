//! Configuration and profile resolution for `bb skills`.
//!
//! Resolution order for every setting: CLI flag > environment variable >
//! selected profile > built-in default. `--local-dev` flips the profile and
//! path resolution to the checked-in `bb-local-dev-config.yaml`.

use std::collections::BTreeMap;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use clap::ArgMatches;
use serde::{Deserialize, Serialize};

use crate::kgoose::DEFAULT_KGOOSE_BASE_URL;

use super::display::Style;
use super::org_routing::resolve_org_kgoose_base_url;
use super::skills_models::SkillsPreferences;

pub const KGOOSE_BASE_URL_ENV_VAR: &str = "KGOOSE_BASE_URL";
pub const KGOOSE_SERVICE_PATH_ENV_VAR: &str = "KGOOSE_SERVICE_PATH";
pub const DEFAULT_KGOOSE_SERVICE_PATH: &str = "/cash-app/goose";
pub const LOCAL_DEV_CONFIG_FILE_NAME: &str = "bb-local-dev-config.yaml";
pub const BB_HOME_ENV_VAR: &str = "BB_HOME";
pub const BB_SKILLS_HOME_ENV_VAR: &str = "BB_SKILLS_HOME";
pub const BB_SKILLS_PACKAGES_DIR_ENV_VAR: &str = "BB_SKILLS_PACKAGES_DIR";
pub const BB_SKILLS_CONFIG_ENV_VAR: &str = "BB_SKILLS_CONFIG";
pub const BB_SKILLS_PROFILE_ENV_VAR: &str = "BB_SKILLS_PROFILE";
pub const BB_KGOOSE_PLAYPEN_ENV_VAR: &str = "BB_KGOOSE_PLAYPEN";
pub const KGOOSE_PLAYPEN_ENV_VAR: &str = "KGOOSE_PLAYPEN";
pub const DEFAULT_CONFIG_FILE_NAME: &str = "skills.yaml";
pub const DEFAULT_PROFILE_NAME: &str = "default";
pub const META_FILE_NAME: &str = ".bb-skills-meta.json";
pub const PREFERENCES_FILE_NAME: &str = "config.yaml";

#[derive(Debug, Clone)]
pub struct SkillsConfig {
    pub kgoose_base_url: String,
    pub kgoose_service_path: String,
    pub playpen: Option<String>,
    pub org: Option<String>,
    pub bb_home: PathBuf,
    pub skills_home: PathBuf,
    packages_dir: PathBuf,
    pub config_path: PathBuf,
    pub profile: String,
    pub local_dev: bool,
    pub json: bool,
    pub style: Style,
}

impl SkillsConfig {
    pub fn resolve(matches: &ArgMatches) -> Result<Self> {
        Self::resolve_with_org_routing(matches, true)
    }

    pub fn resolve_for_config(matches: &ArgMatches) -> Result<Self> {
        Self::resolve_with_org_routing(matches, false)
    }

    fn resolve_with_org_routing(matches: &ArgMatches, org_routing: bool) -> Result<Self> {
        let local_dev = matches.get_flag("local-dev");
        let bb_home = read_optional_env(BB_HOME_ENV_VAR)?
            .map(PathBuf::from)
            .unwrap_or_else(default_bb_home);
        let explicit_config_path = matches
            .get_one::<String>("skills-config")
            .map(PathBuf::from);
        let config_path = if let Some(path) = explicit_config_path {
            path
        } else if local_dev {
            discover_local_dev_config()?
        } else if let Some(path) = read_optional_env(BB_SKILLS_CONFIG_ENV_VAR)?.map(PathBuf::from) {
            path
        } else {
            bb_home.join(DEFAULT_CONFIG_FILE_NAME)
        };
        let file_config = SkillsFileConfig::read(&config_path)?;
        let explicit_profile = matches.get_one::<String>("skills-profile").cloned();
        let env_profile = read_optional_env(BB_SKILLS_PROFILE_ENV_VAR)?;
        let profile = explicit_profile
            .or_else(|| {
                local_dev
                    .then(|| file_config.current_profile.clone())
                    .flatten()
            })
            .or(env_profile)
            .or_else(|| file_config.current_profile.clone())
            .unwrap_or_else(|| DEFAULT_PROFILE_NAME.to_string());
        let profile_config = file_config.profiles.get(&profile);

        let kgoose_service_path = matches
            .get_one::<String>("kgoose-service-path")
            .cloned()
            .or(read_optional_env(KGOOSE_SERVICE_PATH_ENV_VAR)?)
            .map(|value| normalize_kgoose_service_path(&value))
            .transpose()?
            .unwrap_or_else(|| DEFAULT_KGOOSE_SERVICE_PATH.to_string());
        let raw_kgoose_base_url = read_optional_env(KGOOSE_BASE_URL_ENV_VAR)?
            .map(|value| normalize_kgoose_base_url_with_service_path(&value, &kgoose_service_path))
            .unwrap_or_else(|| DEFAULT_KGOOSE_BASE_URL.to_string());
        let playpen = read_optional_env(BB_KGOOSE_PLAYPEN_ENV_VAR)?
            .or(read_optional_env(KGOOSE_PLAYPEN_ENV_VAR)?)
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());

        let env_skills_home = read_optional_env(BB_SKILLS_HOME_ENV_VAR)?.map(PathBuf::from);
        let profile_skills_home = profile_config
            .and_then(|profile| profile.skills_home.clone().map(PathBuf::from))
            .map(|path| resolve_profile_path(local_dev, &config_path, path));
        let skills_home = local_dev
            .then(|| profile_skills_home.clone())
            .flatten()
            .or(env_skills_home)
            .or(profile_skills_home)
            .unwrap_or_else(|| bb_home.join("skills"));

        // Canonical skill files live in the shared agents skills directory
        // (`~/.agents/skills`); `skills_home` under `~/.bb` keeps only bb
        // state (downloads, cache, locks). `--local-dev` falls back to
        // `<skills_home>/packages` so dev runs never touch real agent dirs.
        let env_packages_dir =
            read_optional_env(BB_SKILLS_PACKAGES_DIR_ENV_VAR)?.map(PathBuf::from);
        let profile_packages_dir = profile_config
            .and_then(|profile| profile.packages_dir.clone().map(PathBuf::from))
            .map(|path| resolve_profile_path(local_dev, &config_path, path));
        let packages_dir = local_dev
            .then(|| profile_packages_dir.clone())
            .flatten()
            .or(env_packages_dir)
            .or(profile_packages_dir)
            .unwrap_or_else(|| {
                if local_dev {
                    skills_home.join("packages")
                } else {
                    default_agents_skills_dir()
                }
            });
        let json = matches.get_flag("json");
        let style = Style::new(
            matches.get_flag("no-color"),
            json,
            matches.get_flag("verbose"),
        );
        let preferences_path = default_preferences_path(&bb_home);
        let preferences = read_preferences_file(&preferences_path)?;
        let org = preferences.org.clone();
        let kgoose_base_url = if org_routing {
            resolve_org_kgoose_base_url(
                &raw_kgoose_base_url,
                org.as_deref(),
                local_dev,
                &kgoose_service_path,
            )?
        } else {
            raw_kgoose_base_url
        };

        Ok(Self {
            kgoose_base_url,
            kgoose_service_path,
            playpen,
            org,
            bb_home,
            skills_home,
            packages_dir,
            config_path,
            profile,
            local_dev,
            json,
            style,
        })
    }

    /// Canonical package directory: skills are real files here (default
    /// `~/.agents/skills`) and every other target gets a link into it.
    pub fn packages_dir(&self) -> PathBuf {
        self.packages_dir.clone()
    }

    pub fn downloads_dir(&self) -> PathBuf {
        self.skills_home.join("downloads")
    }

    pub fn cache_dir(&self) -> PathBuf {
        self.skills_home.join("cache")
    }

    pub fn locks_dir(&self) -> PathBuf {
        self.skills_home.join("locks")
    }

    /// Legacy Phase 1 copy location (`<skills_home>/targets/<target>`). Still
    /// cleaned up by `remove` and `doctor --fix` for older installs.
    pub fn legacy_target_dir(&self, target: &str) -> PathBuf {
        self.skills_home.join("targets").join(target)
    }

    /// `~/.bb/config.yaml` by default: preferences are bb configuration, so
    /// they sit next to `skills.yaml` rather than inside the skills state dir.
    pub fn preferences_path(&self) -> PathBuf {
        default_preferences_path(&self.bb_home)
    }

    pub fn read_preferences(&self) -> Result<SkillsPreferences> {
        read_preferences_file(&self.preferences_path())
    }

    pub fn write_preferences(&self, preferences: &SkillsPreferences) -> Result<()> {
        let path = self.preferences_path();
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
        }
        let yaml = serde_yaml::to_string(preferences).context("serialize skills preferences")?;
        fs::write(&path, yaml).with_context(|| format!("write {}", path.display()))
    }
}

pub fn default_preferences_path(bb_home: &Path) -> PathBuf {
    bb_home.join(PREFERENCES_FILE_NAME)
}

pub fn read_preferences_file(path: &Path) -> Result<SkillsPreferences> {
    if !path.exists() {
        return Ok(SkillsPreferences::default());
    }
    let bytes = fs::read(path).with_context(|| format!("read {}", path.display()))?;
    serde_yaml::from_slice(&bytes).with_context(|| format!("parse {}", path.display()))
}

fn discover_local_dev_config() -> Result<PathBuf> {
    let cwd = env::current_dir().context("read current directory")?;
    for dir in cwd.ancestors() {
        let candidate = dir.join(LOCAL_DEV_CONFIG_FILE_NAME);
        if candidate.exists() {
            return Ok(candidate);
        }
    }
    anyhow::bail!(
        "--local-dev could not find {LOCAL_DEV_CONFIG_FILE_NAME} in {} or an ancestor",
        cwd.display()
    )
}

fn resolve_profile_path(local_dev: bool, config_path: &Path, path: PathBuf) -> PathBuf {
    if !local_dev || path.is_absolute() {
        return path;
    }
    config_path
        .parent()
        .map(|parent| parent.join(&path))
        .unwrap_or(path)
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SkillsFileConfig {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_profile: Option<String>,
    #[serde(default)]
    pub profiles: BTreeMap<String, SkillsProfileConfig>,
}

impl SkillsFileConfig {
    pub fn read(path: &Path) -> Result<Self> {
        if !path.exists() {
            return Ok(Self::default());
        }
        let bytes = fs::read(path).with_context(|| format!("read {}", path.display()))?;
        serde_yaml::from_slice(&bytes).with_context(|| format!("parse {}", path.display()))
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SkillsProfileConfig {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skills_home: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub packages_dir: Option<String>,
}

pub fn default_bb_home() -> PathBuf {
    env::var("HOME")
        .map(|home| PathBuf::from(home).join(".bb"))
        .unwrap_or_else(|_| PathBuf::from(".bb"))
}

/// Shared agents skills directory: the canonical home for installed skill
/// files. Other agents (`~/.claude/skills`, ...) link here instead of each
/// holding their own copy.
pub fn default_agents_skills_dir() -> PathBuf {
    env::var("HOME")
        .map(|home| PathBuf::from(home).join(".agents").join("skills"))
        .unwrap_or_else(|_| PathBuf::from(".agents/skills"))
}

pub fn read_optional_env(name: &str) -> Result<Option<String>> {
    match env::var(name) {
        Ok(value) => Ok(Some(value)),
        Err(env::VarError::NotPresent) => Ok(None),
        Err(err) => anyhow::bail!("failed to read {name}: {err}"),
    }
}

pub fn normalize_kgoose_service_path(value: &str) -> Result<String> {
    let path = value.trim().trim_matches('/');
    if path.is_empty() {
        anyhow::bail!("{KGOOSE_SERVICE_PATH_ENV_VAR} must not be empty");
    }
    Ok(format!("/{path}"))
}

pub fn normalize_kgoose_base_url_with_service_path(value: &str, service_path: &str) -> String {
    let trimmed = value.trim().trim_end_matches('/');
    trimmed
        .strip_suffix(service_path.trim_end_matches('/'))
        .unwrap_or(trimmed)
        .trim_end_matches('/')
        .to_string()
}

pub fn kgoose_service_url(base_url: &str, service_path: &str) -> String {
    format!(
        "{}{}",
        normalize_kgoose_base_url_with_service_path(base_url, service_path),
        service_path.trim_end_matches('/')
    )
}
