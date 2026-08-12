use std::env;
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};

use crate::preferences::BuilderBotPreferences;

pub const KGOOSE_SERVICE_PATH_ENV_VAR: &str = "KGOOSE_SERVICE_PATH";
pub const DEFAULT_KGOOSE_SERVICE_PATH: &str = "/cash-app/goose";
/// Public BuilderBot BFF prefix for BuilderLab-routed hosts.
///
/// The BFF rewrites this to KGoose's internal `/cash-app/goose` path.
/// Direct KGoose and local hosts use `DEFAULT_KGOOSE_SERVICE_PATH`.
pub const DEFAULT_BUILDERBOT_SERVICE_PATH: &str = "/api/goose";
pub const KGOOSE_SERVICE_PATH: &str = DEFAULT_KGOOSE_SERVICE_PATH;
pub const BB_HOME_ENV_VAR: &str = "BB_HOME";
pub const BB_SKILLS_PROFILE_ENV_VAR: &str = "BB_SKILLS_PROFILE";
pub const DEFAULT_PROFILE_NAME: &str = "default";
pub const PREFERENCES_FILE_NAME: &str = "config.yaml";

pub fn default_bb_home() -> PathBuf {
    env::var("HOME")
        .map(|home| PathBuf::from(home).join(".bb"))
        .unwrap_or_else(|_| PathBuf::from(".bb"))
}

pub fn default_preferences_path(bb_home: &Path) -> PathBuf {
    bb_home.join(PREFERENCES_FILE_NAME)
}

pub fn read_preferences_file(path: &Path) -> Result<BuilderBotPreferences> {
    if !path.exists() {
        return Ok(BuilderBotPreferences::default());
    }
    let bytes = fs::read(path).with_context(|| format!("read {}", path.display()))?;
    serde_yaml::from_slice(&bytes).with_context(|| format!("parse {}", path.display()))
}

pub fn write_preferences_file(path: &Path, preferences: &BuilderBotPreferences) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
    }
    let yaml = serde_yaml::to_string(preferences).context("serialize skills preferences")?;
    fs::write(path, yaml).with_context(|| format!("write {}", path.display()))
}

pub fn read_optional_env(name: &str) -> Result<Option<String>> {
    match env::var(name) {
        Ok(value) => Ok(Some(value)),
        Err(env::VarError::NotPresent) => Ok(None),
        Err(err) => anyhow::bail!("failed to read {name}: {err}"),
    }
}

pub fn normalize_kgoose_service_path(value: &str) -> Result<String> {
    canonical_kgoose_service_path(value)
        .ok_or_else(|| anyhow::anyhow!("{KGOOSE_SERVICE_PATH_ENV_VAR} must not be empty"))
}

fn kgoose_host(base_url: &str) -> &str {
    base_url
        .trim()
        .trim_start_matches("https://")
        .trim_start_matches("http://")
        .split('/')
        .next()
        .unwrap_or_default()
        .split(':')
        .next()
        .unwrap_or_default()
}

pub fn is_loopback_kgoose_base_url(base_url: &str) -> bool {
    matches!(kgoose_host(base_url), "localhost" | "127.0.0.1")
}

pub fn default_kgoose_service_path(local_dev: bool, base_url: &str) -> &'static str {
    let host = kgoose_host(base_url);
    let direct_host = matches!(
        host,
        "kgoose.sqprod.co"
            | "kgoose.stage.sqprod.co"
            | "kgoose.cashappservices.com"
            | "kgoose.cashappservicesstaging.com"
    );
    if local_dev || direct_host {
        DEFAULT_KGOOSE_SERVICE_PATH
    } else {
        DEFAULT_BUILDERBOT_SERVICE_PATH
    }
}

pub fn normalize_kgoose_base_url(value: &str) -> String {
    normalize_kgoose_base_url_with_service_path(value, DEFAULT_KGOOSE_SERVICE_PATH)
}

pub fn normalize_kgoose_base_url_with_service_path(value: &str, service_path: &str) -> String {
    let trimmed = value.trim().trim_end_matches('/');
    let service_path = canonical_kgoose_service_path(service_path);
    let base_url = [DEFAULT_KGOOSE_SERVICE_PATH, DEFAULT_BUILDERBOT_SERVICE_PATH]
        .into_iter()
        .chain(service_path.as_deref())
        .find_map(|suffix| trimmed.strip_suffix(suffix))
        .unwrap_or(trimmed);
    base_url.trim_end_matches('/').to_string()
}

pub fn kgoose_service_url(base_url: &str, service_path: &str) -> String {
    let service_path = canonical_kgoose_service_path(service_path).unwrap_or_default();
    format!(
        "{}{}",
        normalize_kgoose_base_url_with_service_path(base_url, &service_path),
        service_path
    )
}

fn canonical_kgoose_service_path(value: &str) -> Option<String> {
    let path = value.trim().trim_matches('/');
    if path.is_empty() {
        None
    } else {
        Some(format!("/{path}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_service_path_matches_the_endpoint_type() {
        for base_url in ["https://kgoose.sqprod.co", "https://kgoose.stage.sqprod.co"] {
            assert_eq!(
                default_kgoose_service_path(false, base_url),
                DEFAULT_KGOOSE_SERVICE_PATH
            );
        }
        assert_eq!(
            default_kgoose_service_path(false, "https://test.blockstaging.build"),
            DEFAULT_BUILDERBOT_SERVICE_PATH
        );
        assert_eq!(
            default_kgoose_service_path(false, "http://127.0.0.1:5173"),
            DEFAULT_BUILDERBOT_SERVICE_PATH
        );
        assert_eq!(
            default_kgoose_service_path(true, "http://127.0.0.1:5173"),
            DEFAULT_KGOOSE_SERVICE_PATH
        );
    }

    #[test]
    fn normalize_kgoose_base_url_strips_service_path() {
        assert_eq!(
            normalize_kgoose_base_url(" https://test.blockstaging.build/cash-app/goose/ "),
            "https://test.blockstaging.build"
        );
    }

    #[test]
    fn kgoose_service_url_appends_service_path() {
        assert_eq!(
            kgoose_service_url(
                "https://test.blockstaging.build/cash-app/goose",
                DEFAULT_KGOOSE_SERVICE_PATH
            ),
            "https://test.blockstaging.build/cash-app/goose"
        );
    }

    #[test]
    fn kgoose_service_url_normalizes_bare_service_path() {
        assert_eq!(
            kgoose_service_url("https://test.blockstaging.build", "cash-app/goose"),
            "https://test.blockstaging.build/cash-app/goose"
        );
    }

    #[test]
    fn normalize_kgoose_base_url_strips_custom_service_path() {
        assert_eq!(
            normalize_kgoose_base_url_with_service_path(
                " https://test.blockstaging.build/cash-app/goose-square/ ",
                "/cash-app/goose-square"
            ),
            "https://test.blockstaging.build"
        );
    }

    #[test]
    fn normalize_kgoose_base_url_strips_known_previous_service_paths() {
        assert_eq!(
            normalize_kgoose_base_url_with_service_path(
                "https://test.blockstaging.build/cash-app/goose",
                DEFAULT_BUILDERBOT_SERVICE_PATH
            ),
            "https://test.blockstaging.build"
        );
        assert_eq!(
            normalize_kgoose_base_url_with_service_path(
                "https://kgoose.sqprod.co/api/goose",
                DEFAULT_KGOOSE_SERVICE_PATH
            ),
            "https://kgoose.sqprod.co"
        );
    }
}
