use std::{
    env,
    ffi::{OsStr, OsString},
    path::{Path, PathBuf},
};

use etcetera::{choose_app_strategy, AppStrategy, AppStrategyArgs};

pub(crate) const ADDITIONAL_CONFIG_FILES_ENV: &str = "GOOSE_ADDITIONAL_CONFIG_FILES";
pub(crate) const GOOSE_PATH_ROOT_ENV: &str = "GOOSE_PATH_ROOT";
pub(crate) const CONFIG_FILE_NAME: &str = "config.yaml";

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AdditionalConfigFiles {
    pub configured: bool,
    pub paths: Vec<PathBuf>,
}

/// Resolve the upstream goose config file path. Matches
/// `crates/goose/src/config/paths.rs::Paths::config_dir`.
pub(crate) fn config_path() -> Result<PathBuf, String> {
    config_path_from_values(env::var_os(GOOSE_PATH_ROOT_ENV), None)
}

pub(crate) fn data_dir_from_values(
    process_path_root: Option<OsString>,
    shell_path_root: Option<OsString>,
) -> Result<PathBuf, String> {
    if let Some(root) = validated_path_root(shell_path_root.or(process_path_root)) {
        return Ok(root.join("data"));
    }

    let strategy = goose_app_strategy()?;
    Ok(strategy.data_dir())
}

fn config_path_from_values(
    process_path_root: Option<OsString>,
    shell_path_root: Option<OsString>,
) -> Result<PathBuf, String> {
    if let Some(root) = validated_path_root(shell_path_root.or(process_path_root)) {
        return Ok(root.join("config").join(CONFIG_FILE_NAME));
    }

    let strategy = goose_app_strategy()?;
    Ok(strategy.config_dir().join(CONFIG_FILE_NAME))
}

fn goose_app_strategy() -> Result<impl AppStrategy, String> {
    choose_app_strategy(AppStrategyArgs {
        top_level_domain: "Block".to_string(),
        author: "Block".to_string(),
        app_name: "goose".to_string(),
    })
    .map_err(|err| format!("Failed to resolve Goose application directory: {err}"))
}

fn validated_path_root(value: Option<OsString>) -> Option<PathBuf> {
    value.map(PathBuf::from).filter(|path| path.is_absolute())
}

pub(crate) fn additional_config_files_from_values(
    process_value: Option<&OsStr>,
    shell_value: Option<&OsStr>,
    distro_config_path: Option<&Path>,
) -> AdditionalConfigFiles {
    let mut configured = false;
    let mut paths = Vec::new();

    if let Some(value) = shell_value.or(process_value) {
        configured = true;
        extend_additional_config_paths(&mut paths, value);
    }

    if let Some(path) = distro_config_path {
        configured = true;
        push_unique_path(&mut paths, path.to_path_buf());
    }

    AdditionalConfigFiles { configured, paths }
}

pub(crate) fn join_additional_config_files(paths: &[PathBuf]) -> OsString {
    env::join_paths(paths).unwrap_or_else(|_| {
        let separator = if cfg!(windows) { ";" } else { ":" };
        let mut fallback = OsString::new();

        for path in paths {
            if !fallback.is_empty() {
                fallback.push(separator);
            }
            fallback.push(path.as_os_str());
        }

        fallback
    })
}

fn extend_additional_config_paths(paths: &mut Vec<PathBuf>, value: &OsStr) {
    if value.is_empty() {
        return;
    }

    for path in env::split_paths(value).filter(|path| !path.as_os_str().is_empty()) {
        push_unique_path(paths, path);
    }
}

fn push_unique_path(paths: &mut Vec<PathBuf>, path: PathBuf) {
    if !paths.contains(&path) {
        paths.push(path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_root_requires_an_absolute_path() {
        assert_eq!(validated_path_root(None), None);
        assert_eq!(validated_path_root(Some(OsString::new())), None);
        assert_eq!(
            validated_path_root(Some(OsString::from("relative/root"))),
            None
        );

        let absolute = std::env::current_dir()
            .unwrap()
            .join("nonexistent-goose-root");
        assert_eq!(
            validated_path_root(Some(absolute.clone().into_os_string())),
            Some(absolute)
        );
    }

    #[test]
    fn shell_path_root_matches_goose_serve_precedence() {
        let process = std::env::current_dir().unwrap().join("process-root");
        let shell = std::env::current_dir().unwrap().join("shell-root");

        assert_eq!(
            data_dir_from_values(
                Some(process.into_os_string()),
                Some(shell.clone().into_os_string()),
            )
            .unwrap(),
            shell.join("data")
        );
    }
}
