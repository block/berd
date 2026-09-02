use std::{
    collections::{hash_map::Entry, HashMap, HashSet},
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};

use super::find_project_hermit_bin_within;
use crate::services::{env_key, shell_env};

/// Windows has no general-purpose login shell. The inherited process
/// environment is the session environment; repository-local Hermit activation
/// is reconstructed only after Git identifies the requested repository.
pub(super) async fn capture_dir_env_uncached(
    dir: &Path,
    _timeout_duration: Duration,
) -> HashMap<String, String> {
    windows_process_env_for_dir(dir)
}

pub(crate) fn windows_process_env_for_dir(dir: &Path) -> HashMap<String, String> {
    let mut env = dedupe_env_case_insensitive(std::env::vars());
    strip_untrusted_windows_tool_state(&mut env);
    if let Some(hermit_bin) = find_project_hermit_bin(dir) {
        prepend_dir_to_windows_path(&mut env, &hermit_bin);
    }
    env
}

/// Remove repository-scoped tool state inherited from the directory that
/// launched Berd. The shared sanitizer owns the variable policy; this function
/// additionally removes Hermit PATH entries using Windows path semantics.
pub(crate) fn strip_untrusted_windows_tool_state(env: &mut HashMap<String, String>) {
    shell_env::sanitize_shell_env(env);
    let Some(path) = env_key::get(env, "PATH") else {
        return;
    };
    let paths = std::env::split_paths(path).filter(|entry| {
        !entry.components().any(|component| {
            component
                .as_os_str()
                .to_string_lossy()
                .eq_ignore_ascii_case(".hermit")
        })
    });
    if let Ok(path) = std::env::join_paths(paths) {
        env_key::upsert_map(env, "PATH", path.to_string_lossy().into_owned());
    }
}

/// Ask Git for the repository boundary instead of duplicating its `.git`,
/// worktree, and common-directory rules. Inherited Git controls are removed so
/// discovery describes `dir`, not the process that launched Berd.
pub(crate) fn find_project_hermit_bin(dir: &Path) -> Option<PathBuf> {
    let target = dir.canonicalize().ok()?;
    let start = if target.is_dir() {
        target.as_path()
    } else {
        target.parent()?
    };
    let mut env = dedupe_env_case_insensitive(std::env::vars());
    strip_untrusted_windows_tool_state(&mut env);
    env.retain(|key, _| !key.to_ascii_uppercase().starts_with("GIT_"));
    let git = find_file_on_windows_path("git.exe", env_key::get(&env, "PATH"))?;
    let mut command = Command::new(git);
    command
        .args(["rev-parse", "--show-toplevel"])
        .current_dir(start)
        .env_clear()
        .envs(&env);
    crate::services::process::apply_no_window(&mut command);
    let output = command.output().ok()?;
    if !output.status.success() {
        return None;
    }
    let repo_root = PathBuf::from(String::from_utf8(output.stdout).ok()?.trim());
    find_project_hermit_bin_within(start, &repo_root)
}

pub(crate) fn resolve_control_executable(name: &str) -> Option<PathBuf> {
    resolve_control_executable_in_env(name, dedupe_env_case_insensitive(std::env::vars()))
}

pub(crate) fn resolve_control_executable_in_env(
    name: &str,
    mut env: HashMap<String, String>,
) -> Option<PathBuf> {
    strip_untrusted_windows_tool_state(&mut env);
    let file_name = if name.to_ascii_lowercase().ends_with(".exe") {
        name.to_string()
    } else {
        format!("{name}.exe")
    };
    find_file_on_windows_path(&file_name, env_key::get(&env, "PATH"))
}

pub(crate) fn find_file_on_windows_path(file_name: &str, path: Option<&str>) -> Option<PathBuf> {
    std::env::split_paths(path?)
        .map(|dir| dir.join(file_name))
        .find(|candidate| candidate.is_file())?
        .canonicalize()
        .ok()
}

fn prepend_dir_to_windows_path(env: &mut HashMap<String, String>, dir: &Path) {
    let mut paths = vec![dir.to_path_buf()];
    if let Some(path) = env_key::get(env, "PATH") {
        paths.extend(std::env::split_paths(path));
    }
    let mut seen = HashSet::new();
    paths.retain(|path| seen.insert(path.to_string_lossy().to_ascii_lowercase()));
    if let Ok(path) = std::env::join_paths(paths) {
        env_key::upsert_map(env, "PATH", path.to_string_lossy().into_owned());
    }
}

pub(crate) fn dedupe_env_case_insensitive(
    vars: impl IntoIterator<Item = (String, String)>,
) -> HashMap<String, String> {
    let mut env = HashMap::new();
    let mut canonical_key = HashMap::new();
    for (key, value) in vars {
        match canonical_key.entry(key.to_ascii_lowercase()) {
            Entry::Occupied(_) => {}
            Entry::Vacant(slot) => {
                slot.insert(key.clone());
                env.insert(key, value);
            }
        }
    }
    env
}

pub(super) async fn capture_terminal_env(
    dir: &Path,
    _timeout_duration: Duration,
) -> HashMap<String, String> {
    windows_process_env_for_dir(dir)
}
