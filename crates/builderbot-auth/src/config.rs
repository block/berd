use std::env;
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};

use crate::preferences::BuilderBotPreferences;

pub const KGOOSE_SERVICE_PATH_ENV_VAR: &str = "KGOOSE_SERVICE_PATH";
pub const DEFAULT_KGOOSE_SERVICE_PATH: &str = "/cash-app/goose";
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

pub fn normalize_kgoose_base_url(value: &str) -> String {
    normalize_kgoose_base_url_with_service_path(value, DEFAULT_KGOOSE_SERVICE_PATH)
}

pub fn normalize_kgoose_base_url_with_service_path(value: &str, service_path: &str) -> String {
    let trimmed = value.trim().trim_end_matches('/');
    let Some(service_path) = canonical_kgoose_service_path(service_path) else {
        return trimmed.to_string();
    };
    trimmed
        .strip_suffix(&service_path)
        .unwrap_or(trimmed)
        .trim_end_matches('/')
        .to_string()
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
}
