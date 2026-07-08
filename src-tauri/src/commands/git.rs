use serde::Serialize;
use std::collections::HashMap;
use std::io;
use std::path::{Path, PathBuf};
use std::process::Output;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::process::Command as TokioCommand;
use tokio::time::timeout;

use crate::services::dir_env;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitState {
    pub is_git_repo: bool,
    pub current_branch: Option<String>,
    pub dirty_file_count: u32,
    pub incoming_commit_count: u32,
    pub worktrees: Vec<WorktreeInfo>,
    pub is_worktree: bool,
    pub main_worktree_path: Option<String>,
    pub local_branches: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeInfo {
    pub path: String,
    pub branch: Option<String>,
    pub is_main: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedWorktree {
    pub path: String,
    pub branch: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct GitStateChangedPayload {
    operation: &'static str,
    path: String,
    affected_paths: Vec<String>,
    branch: Option<String>,
}

const GIT_STATE_CHANGED_EVENT: &str = "berd:git-state-changed";
pub(crate) const GIT_READ_COMMAND_TIMEOUT: Duration = Duration::from_secs(15);
pub(crate) const GIT_STATUS_COMMAND_TIMEOUT: Duration = Duration::from_secs(60);
pub(crate) const GIT_MUTATING_COMMAND_TIMEOUT: Duration = Duration::from_secs(300);
const GIT_STATE_OPERATION_TIMEOUT: Duration = Duration::from_secs(90);

fn dir_env_capture_timeout(command_timeout: Duration) -> Duration {
    command_timeout
        .checked_add(command_timeout / 2)
        .unwrap_or(command_timeout)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EnvSource {
    /// Try the inherited environment first and retry with captured env only for
    /// failures that plausibly depend on directory-scoped shell activation.
    Smart,
    /// Inherited process env with inherited `GIT_*` variables stripped.
    Lite,
    /// Per-directory interactive-login-shell env; falls back to Lite on
    /// capture failure.
    Captured,
}

enum GitRunError {
    TimedOut,
    Spawn(io::Error),
}

#[tauri::command]
pub async fn get_git_state(path: String) -> Result<GitState, String> {
    match timeout(GIT_STATE_OPERATION_TIMEOUT, get_git_state_inner(path)).await {
        Ok(result) => result,
        Err(_) => Err(format!(
            "Git status timed out after {} seconds",
            GIT_STATE_OPERATION_TIMEOUT.as_secs()
        )),
    }
}

async fn get_git_state_inner(path: String) -> Result<GitState, String> {
    let repo_path = PathBuf::from(&path);
    if !repo_path.exists() {
        return Err(format!("Path does not exist: {}", path));
    }

    if !is_git_repo_async(&repo_path).await? {
        return Ok(GitState {
            is_git_repo: false,
            current_branch: None,
            dirty_file_count: 0,
            incoming_commit_count: 0,
            worktrees: Vec::new(),
            is_worktree: false,
            main_worktree_path: None,
            local_branches: Vec::new(),
        });
    }

    let current_root = trim_to_option(
        run_git_success_async(
            &repo_path,
            &["rev-parse", "--show-toplevel"],
            GIT_READ_COMMAND_TIMEOUT,
        )
        .await?,
    )
    .ok_or("Could not determine repository root")?;
    let current_branch = trim_to_option(
        run_git_success_async(
            &repo_path,
            &["branch", "--show-current"],
            GIT_READ_COMMAND_TIMEOUT,
        )
        .await?,
    );
    let dirty_file_count = count_lines(
        &run_git_success_async(
            &repo_path,
            &["status", "--porcelain"],
            GIT_STATUS_COMMAND_TIMEOUT,
        )
        .await?,
    );
    let git_common_dir = trim_to_option(
        run_git_success_async(
            &repo_path,
            &["rev-parse", "--git-common-dir"],
            GIT_READ_COMMAND_TIMEOUT,
        )
        .await?,
    );
    let main_worktree_path = git_common_dir
        .as_deref()
        .and_then(|git_common_dir| resolve_main_worktree_path(git_common_dir, &current_root))
        .as_deref()
        .map(normalize_path_string);
    let worktrees_output = run_git_success_async(
        &repo_path,
        &["worktree", "list", "--porcelain"],
        GIT_READ_COMMAND_TIMEOUT,
    )
    .await?;
    let worktrees = parse_worktrees(&worktrees_output, main_worktree_path.as_deref());
    let is_worktree = main_worktree_path
        .as_deref()
        .map(|main_path| normalize_path_string(&current_root) != main_path)
        .unwrap_or(false);
    let incoming_commit_count = count_incoming_commits_async(&repo_path).await.unwrap_or(0);

    let local_branches = list_local_branches_async(&repo_path)
        .await
        .unwrap_or_default();

    Ok(GitState {
        is_git_repo: true,
        current_branch,
        dirty_file_count,
        incoming_commit_count,
        worktrees,
        is_worktree,
        main_worktree_path,
        local_branches,
    })
}

#[tauri::command]
pub async fn git_switch_branch(app: AppHandle, path: String, branch: String) -> Result<(), String> {
    let repo_path = resolve_repo_path(&path)?;
    run_git_success_async(
        &repo_path,
        &["switch", &branch],
        GIT_MUTATING_COMMAND_TIMEOUT,
    )
    .await?;
    emit_git_state_changed(&app, "switch_branch", &path, Vec::new(), Some(branch));
    Ok(())
}

#[tauri::command]
pub async fn git_stash(app: AppHandle, path: String) -> Result<(), String> {
    let repo_path = resolve_repo_path(&path)?;
    run_git_success_async(&repo_path, &["stash"], GIT_MUTATING_COMMAND_TIMEOUT).await?;
    emit_git_state_changed(&app, "stash", &path, Vec::new(), None);
    Ok(())
}

#[tauri::command]
pub async fn git_init(app: AppHandle, path: String) -> Result<(), String> {
    let repo_path = resolve_repo_path(&path)?;
    run_git_success_async(&repo_path, &["init"], GIT_MUTATING_COMMAND_TIMEOUT).await?;
    emit_git_state_changed(&app, "init", &path, Vec::new(), None);
    Ok(())
}

#[tauri::command]
pub async fn git_fetch(app: AppHandle, path: String) -> Result<(), String> {
    let repo_path = resolve_repo_path(&path)?;
    run_git_success_async(
        &repo_path,
        &["fetch", "--prune"],
        GIT_MUTATING_COMMAND_TIMEOUT,
    )
    .await?;
    emit_git_state_changed(&app, "fetch", &path, Vec::new(), None);
    Ok(())
}

#[tauri::command]
pub async fn git_pull(app: AppHandle, path: String) -> Result<(), String> {
    let repo_path = resolve_repo_path(&path)?;
    run_git_success_async(
        &repo_path,
        &["pull", "--ff-only"],
        GIT_MUTATING_COMMAND_TIMEOUT,
    )
    .await?;
    emit_git_state_changed(&app, "pull", &path, Vec::new(), None);
    Ok(())
}

#[tauri::command]
pub async fn git_create_branch(
    app: AppHandle,
    path: String,
    name: String,
    base_branch: String,
) -> Result<(), String> {
    let repo_path = resolve_repo_path(&path)?;
    let branch_name = require_nonempty(&name, "Branch name")?;
    let base_branch = require_nonempty(&base_branch, "Base branch")?;
    run_git_success_async(
        &repo_path,
        &["switch", "-c", branch_name.as_str(), base_branch.as_str()],
        GIT_MUTATING_COMMAND_TIMEOUT,
    )
    .await?;
    emit_git_state_changed(&app, "create_branch", &path, Vec::new(), Some(branch_name));
    Ok(())
}

#[tauri::command]
pub async fn git_create_worktree(
    app: AppHandle,
    path: String,
    name: String,
    branch: String,
    create_branch: bool,
    base_branch: Option<String>,
) -> Result<CreatedWorktree, String> {
    let repo_path = resolve_repo_path(&path)?;
    let worktree_name = validate_worktree_name(&name)?;
    let branch_name = require_nonempty(&branch, "Branch name")?;
    let (_, main_worktree_path) = git_repo_context_async(&repo_path).await?;
    let target_path = derive_worktree_path(
        main_worktree_path.as_deref().unwrap_or(path.as_str()),
        &worktree_name,
    )?;

    if let Some(parent) = target_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create worktree directory: {}", error))?;
    }

    let target_path_string = target_path.to_string_lossy().to_string();

    if create_branch {
        let base_branch =
            require_nonempty(base_branch.as_deref().unwrap_or_default(), "Base branch")?;
        run_git_success_async(
            &repo_path,
            &[
                "worktree",
                "add",
                "-b",
                branch_name.as_str(),
                target_path_string.as_str(),
                base_branch.as_str(),
            ],
            GIT_MUTATING_COMMAND_TIMEOUT,
        )
        .await?;
    } else {
        run_git_success_async(
            &repo_path,
            &[
                "worktree",
                "add",
                target_path_string.as_str(),
                branch_name.as_str(),
            ],
            GIT_MUTATING_COMMAND_TIMEOUT,
        )
        .await?;
    }

    let created_worktree = CreatedWorktree {
        path: normalize_path_string(&target_path_string),
        branch: branch_name,
    };
    emit_git_state_changed(
        &app,
        "create_worktree",
        &path,
        vec![created_worktree.path.clone()],
        Some(created_worktree.branch.clone()),
    );
    Ok(created_worktree)
}

fn emit_git_state_changed(
    app: &AppHandle,
    operation: &'static str,
    path: &str,
    affected_paths: Vec<String>,
    branch: Option<String>,
) {
    if let Err(error) = app.emit(
        GIT_STATE_CHANGED_EVENT,
        GitStateChangedPayload {
            operation,
            path: normalize_path_string(path),
            affected_paths,
            branch,
        },
    ) {
        log::warn!("Failed to emit git state changed event: {error}");
    }
}

pub(crate) async fn is_git_repo_async(path: &Path) -> Result<bool, String> {
    let output = run_git_output_async(
        path,
        &["rev-parse", "--is-inside-work-tree"],
        GIT_READ_COMMAND_TIMEOUT,
    )
    .await?;

    Ok(output.status.success() && String::from_utf8_lossy(&output.stdout).trim() == "true")
}

pub(crate) fn resolve_repo_path(path: &str) -> Result<PathBuf, String> {
    let repo_path = PathBuf::from(path);
    if !repo_path.exists() {
        return Err(format!("Path does not exist: {}", path));
    }
    Ok(repo_path)
}

async fn run_git_output_async(
    path: &Path,
    args: &[&str],
    command_timeout: Duration,
) -> Result<Output, String> {
    run_git_output_with_env_source_async(path, args, command_timeout, env_source_for_git_args(args))
        .await
}

async fn run_git_output_with_env_source_async(
    path: &Path,
    args: &[&str],
    command_timeout: Duration,
    env_source: EnvSource,
) -> Result<Output, String> {
    let rendered_args = args.join(" ");
    match env_source {
        EnvSource::Smart => {
            warm_dir_env_async(path, command_timeout);
            match run_git_once_async(path, args, command_timeout, EnvSource::Lite).await {
                Ok(output)
                    if output.status.success() || !should_retry_with_captured_output(&output) =>
                {
                    Ok(output)
                }
                Ok(_) => {
                    log::info!(
                        "Retrying git {} with captured env after lite-env failure in {}",
                        rendered_args,
                        path.display()
                    );
                    run_git_once_async(path, args, command_timeout, EnvSource::Captured)
                        .await
                        .map_err(|error| {
                            format_git_run_error(error, &rendered_args, command_timeout)
                        })
                }
                Err(error) if should_retry_with_captured_error(&error) => {
                    log::info!(
                        "Retrying git {} with captured env after lite-env spawn failure in {}",
                        rendered_args,
                        path.display()
                    );
                    run_git_once_async(path, args, command_timeout, EnvSource::Captured)
                        .await
                        .map_err(|error| {
                            format_git_run_error(error, &rendered_args, command_timeout)
                        })
                }
                Err(error) => Err(format_git_run_error(error, &rendered_args, command_timeout)),
            }
        }
        EnvSource::Lite | EnvSource::Captured => {
            run_git_once_async(path, args, command_timeout, env_source)
                .await
                .map_err(|error| format_git_run_error(error, &rendered_args, command_timeout))
        }
    }
}

async fn run_git_once_async(
    path: &Path,
    args: &[&str],
    command_timeout: Duration,
    env_source: EnvSource,
) -> Result<Output, GitRunError> {
    let mut command = TokioCommand::new("git");
    command.args(args).current_dir(path).kill_on_drop(true);

    apply_git_environment(
        &mut command,
        path,
        env_source,
        dir_env_capture_timeout(command_timeout),
    )
    .await;

    timeout(command_timeout, command.output())
        .await
        .map_err(|_| GitRunError::TimedOut)?
        .map_err(GitRunError::Spawn)
}

fn env_source_for_git_args(args: &[&str]) -> EnvSource {
    match args {
        ["switch", ..]
        | ["stash", ..]
        | ["init", ..]
        | ["fetch", ..]
        | ["pull", ..]
        | ["worktree", "add", ..] => EnvSource::Captured,
        _ => EnvSource::Smart,
    }
}

#[cfg(not(test))]
fn warm_dir_env_async(path: &Path, command_timeout: Duration) {
    let path = path.to_path_buf();
    let capture_timeout = dir_env_capture_timeout(command_timeout);
    if let Ok(handle) = tokio::runtime::Handle::try_current() {
        handle.spawn(async move {
            let _ = dir_env::capture_dir_env(&path, capture_timeout).await;
        });
    }
}

#[cfg(test)]
fn warm_dir_env_async(_path: &Path, _command_timeout: Duration) {}

fn should_retry_with_captured_error(error: &GitRunError) -> bool {
    matches!(error, GitRunError::Spawn(error) if error.kind() == io::ErrorKind::NotFound)
}

fn format_git_run_error(
    error: GitRunError,
    rendered_args: &str,
    command_timeout: Duration,
) -> String {
    match error {
        GitRunError::TimedOut => format!(
            "git {} timed out after {} seconds",
            rendered_args,
            command_timeout.as_secs()
        ),
        GitRunError::Spawn(error) => format!("Failed to run git: {}", error),
    }
}

async fn apply_git_environment(
    command: &mut TokioCommand,
    path: &Path,
    env_source: EnvSource,
    capture_timeout: Duration,
) {
    match env_source {
        EnvSource::Smart | EnvSource::Lite => apply_lite_git_env(command),
        EnvSource::Captured => {
            if let Some(env) = dir_env::capture_dir_env(path, capture_timeout).await {
                apply_captured_git_env(command, &env);
            } else {
                apply_lite_git_env(command);
            }
        }
    }

    force_non_interactive(command);
    pin_c_locale(command);
    detach_from_ctty(command);
}

fn apply_captured_git_env(command: &mut TokioCommand, env: &HashMap<String, String>) {
    command.env_clear();
    for (key, value) in env {
        command.env(key, value);
    }
}

fn apply_lite_git_env(command: &mut TokioCommand) {
    strip_inherited_git_env(command);
}

fn strip_inherited_git_env(command: &mut TokioCommand) {
    for (key, _) in std::env::vars_os() {
        if key.to_string_lossy().starts_with("GIT_") {
            command.env_remove(key);
        }
    }
}

fn force_non_interactive(command: &mut TokioCommand) {
    command.env("GIT_TERMINAL_PROMPT", "0");
    if !has_env(command, "GIT_SSH_COMMAND") {
        command.env(
            "GIT_SSH_COMMAND",
            "ssh -o BatchMode=yes -o ConnectTimeout=10",
        );
    }
}

fn has_env(command: &TokioCommand, key: &str) -> bool {
    command
        .as_std()
        .get_envs()
        .any(|(env_key, value)| value.is_some() && env_key == key)
}

fn pin_c_locale(command: &mut TokioCommand) {
    command.env("LC_ALL", "C");
    command.env("LANG", "C");
}

fn detach_from_ctty(command: &mut TokioCommand) {
    #[cfg(unix)]
    unsafe {
        // SAFETY: `setsid()` is async-signal-safe.
        command.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }
    #[cfg(not(unix))]
    let _ = command;
}

pub(crate) async fn run_git_success_async(
    path: &Path,
    args: &[&str],
    command_timeout: Duration,
) -> Result<String, String> {
    let output = run_git_output_async(path, args, command_timeout).await?;

    if !output.status.success() {
        let message = output_failure_message(&output);
        let rendered_args = args.join(" ");
        return Err(format!("git {} failed: {}", rendered_args, message));
    }

    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

fn should_retry_with_captured_output(output: &Output) -> bool {
    if output.status.success() {
        return false;
    }

    let message = output_failure_message(output);
    !is_not_git_repo_error(&message) && !is_missing_ref_or_object_error(&message)
}

fn output_failure_message(output: &Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if !stderr.is_empty() {
        return stderr;
    }

    String::from_utf8_lossy(&output.stdout).trim().to_string()
}

fn is_not_git_repo_error(message: &str) -> bool {
    message.contains("not a git repository")
}

fn is_missing_ref_or_object_error(message: &str) -> bool {
    const REF_RESOLVE_FAILURE_PATTERNS: &[&str] = &[
        "Needed a single revision",
        "unknown revision or path",
        "no upstream configured",
        "Not a valid object name",
        "Not a valid commit name",
        "bad revision",
        "bad object",
    ];

    REF_RESOLVE_FAILURE_PATTERNS
        .iter()
        .any(|pattern| message.contains(pattern))
}

pub(crate) fn trim_to_option(value: String) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn require_nonempty(value: &str, label: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        Err(format!("{} cannot be empty", label))
    } else {
        Ok(trimmed.to_string())
    }
}

fn count_lines(value: &str) -> u32 {
    value
        .lines()
        .filter(|line| !line.trim().is_empty())
        .count()
        .try_into()
        .unwrap_or(u32::MAX)
}

async fn count_incoming_commits_async(path: &Path) -> Result<u32, String> {
    let has_upstream = run_git_output_async(
        path,
        &[
            "rev-parse",
            "--abbrev-ref",
            "--symbolic-full-name",
            "@{upstream}",
        ],
        GIT_READ_COMMAND_TIMEOUT,
    )
    .await?;

    if !has_upstream.status.success() {
        return Ok(0);
    }

    let output = run_git_success_async(
        path,
        &["rev-list", "--count", "HEAD..@{upstream}"],
        GIT_READ_COMMAND_TIMEOUT,
    )
    .await?;
    let count = output
        .trim()
        .parse::<u32>()
        .map_err(|error| format!("Failed to parse incoming commit count: {}", error))?;
    Ok(count)
}

fn resolve_main_worktree_path(git_common_dir: &str, current_root: &str) -> Option<String> {
    let path = PathBuf::from(git_common_dir);
    let absolute = if path.is_absolute() {
        path
    } else {
        PathBuf::from(current_root).join(path)
    };

    if absolute.file_name().is_some_and(|name| name == ".git") {
        absolute
            .parent()
            .map(|parent| parent.to_string_lossy().into_owned())
    } else {
        None
    }
}

async fn git_repo_context_async(path: &Path) -> Result<(String, Option<String>), String> {
    let current_root = trim_to_option(
        run_git_success_async(
            path,
            &["rev-parse", "--show-toplevel"],
            GIT_READ_COMMAND_TIMEOUT,
        )
        .await?,
    )
    .ok_or("Could not determine repository root")?;
    let git_common_dir = trim_to_option(
        run_git_success_async(
            path,
            &["rev-parse", "--git-common-dir"],
            GIT_READ_COMMAND_TIMEOUT,
        )
        .await?,
    );
    let main_worktree_path = git_common_dir
        .as_deref()
        .and_then(|git_common_dir| resolve_main_worktree_path(git_common_dir, &current_root))
        .as_deref()
        .map(normalize_path_string);

    Ok((current_root, main_worktree_path))
}

fn validate_worktree_name(value: &str) -> Result<String, String> {
    let worktree_name = require_nonempty(value, "Worktree name")?;
    if worktree_name == "." || worktree_name == ".." {
        return Err("Worktree name must be a real folder name".to_string());
    }
    if worktree_name.contains('/') || worktree_name.contains('\\') {
        return Err("Worktree name cannot contain path separators".to_string());
    }
    Ok(worktree_name)
}

fn derive_worktree_path(main_worktree_path: &str, worktree_name: &str) -> Result<PathBuf, String> {
    let main_root = PathBuf::from(main_worktree_path);
    let repo_name = main_root
        .file_name()
        .ok_or("Could not determine repository name")?
        .to_string_lossy()
        .to_string();
    let repo_parent = main_root
        .parent()
        .ok_or("Could not determine repository parent")?;
    let target_path = repo_parent
        .join(format!("{}-worktrees", repo_name))
        .join(worktree_name);

    if target_path.exists() {
        return Err(format!(
            "Worktree path already exists: {}",
            target_path.to_string_lossy()
        ));
    }

    Ok(target_path)
}

fn parse_worktrees(output: &str, main_worktree_path: Option<&str>) -> Vec<WorktreeInfo> {
    let mut worktrees = Vec::new();
    let mut current_path: Option<String> = None;
    let mut current_branch: Option<String> = None;

    for line in output.lines() {
        if let Some(path) = line.strip_prefix("worktree ") {
            if let Some(path) = current_path.take() {
                worktrees.push(build_worktree(
                    path,
                    current_branch.take(),
                    main_worktree_path,
                ));
            }
            current_path = Some(path.to_string());
            current_branch = None;
            continue;
        }

        if let Some(branch) = line.strip_prefix("branch ") {
            current_branch = Some(branch_name(branch));
        }
    }

    if let Some(path) = current_path {
        worktrees.push(build_worktree(path, current_branch, main_worktree_path));
    }

    worktrees
}

fn build_worktree(
    path: String,
    branch: Option<String>,
    main_worktree_path: Option<&str>,
) -> WorktreeInfo {
    let normalized_path = normalize_path_string(&path);
    let is_main = main_worktree_path
        .map(|main_path| normalized_path == main_path)
        .unwrap_or(false);

    WorktreeInfo {
        path: normalized_path,
        branch,
        is_main,
    }
}

fn branch_name(branch_ref: &str) -> String {
    branch_ref
        .strip_prefix("refs/heads/")
        .unwrap_or(branch_ref)
        .to_string()
}

fn normalize_path_string(path: &str) -> String {
    path.replace('\\', "/").trim_end_matches('/').to_string()
}

async fn list_local_branches_async(path: &Path) -> Result<Vec<String>, String> {
    let output = run_git_success_async(
        path,
        &[
            "for-each-ref",
            "--sort=-committerdate",
            "--format=%(refname:short)",
            "refs/heads",
        ],
        GIT_READ_COMMAND_TIMEOUT,
    )
    .await?;
    Ok(output
        .lines()
        .map(|line| line.trim().to_string())
        .filter(|line| !line.is_empty())
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsString;

    fn env_value(command: &TokioCommand, key: &str) -> Option<OsString> {
        command.as_std().get_envs().find_map(|(env_key, value)| {
            if env_key == key {
                value.map(|value| value.to_os_string())
            } else {
                None
            }
        })
    }

    fn env_is_removed(command: &TokioCommand, key: &str) -> bool {
        command
            .as_std()
            .get_envs()
            .any(|(env_key, value)| env_key == key && value.is_none())
    }

    #[test]
    fn dir_env_capture_timeout_is_one_and_a_half_times_command_timeout() {
        assert_eq!(
            dir_env_capture_timeout(Duration::from_secs(10)),
            Duration::from_secs(15)
        );
    }

    #[test]
    fn captured_git_env_replaces_command_env_and_preserves_full_snapshot() {
        let mut command = TokioCommand::new("git");
        command.env("STALE_VAR", "remove-me");
        let env = HashMap::from([
            (
                "PATH".to_string(),
                "/repo/.hermit/bin:/repo/bin:/usr/bin".to_string(),
            ),
            ("CUSTOM_DIR_ENV".to_string(), "forwarded".to_string()),
        ]);

        apply_captured_git_env(&mut command, &env);

        assert_eq!(
            env_value(&command, "PATH"),
            Some(OsString::from("/repo/.hermit/bin:/repo/bin:/usr/bin"))
        );
        assert_eq!(
            env_value(&command, "CUSTOM_DIR_ENV"),
            Some(OsString::from("forwarded"))
        );
        assert_eq!(env_value(&command, "STALE_VAR"), None);
    }

    #[test]
    fn lite_git_env_strips_inherited_git_vars_without_overriding_path() {
        let inherited_key = format!("GIT_GOOSE_TEST_{}", std::process::id());
        std::env::set_var(&inherited_key, "unsafe");
        struct EnvGuard(String);
        impl Drop for EnvGuard {
            fn drop(&mut self) {
                std::env::remove_var(&self.0);
            }
        }
        let _guard = EnvGuard(inherited_key.clone());

        let mut command = TokioCommand::new("git");
        apply_lite_git_env(&mut command);

        assert_eq!(env_value(&command, "PATH"), None);
        assert!(env_is_removed(&command, &inherited_key));
    }

    #[tokio::test]
    async fn captured_env_failure_falls_back_to_lite_env() {
        let inherited_key = format!("GIT_GOOSE_CAPTURE_FALLBACK_TEST_{}", std::process::id());
        std::env::set_var(&inherited_key, "unsafe");
        struct EnvGuard(String);
        impl Drop for EnvGuard {
            fn drop(&mut self) {
                std::env::remove_var(&self.0);
            }
        }
        let _guard = EnvGuard(inherited_key.clone());
        let temp = tempfile::tempdir().expect("temp dir");
        let missing_dir = temp.path().join("missing");

        let mut command = TokioCommand::new("git");
        apply_git_environment(
            &mut command,
            &missing_dir,
            EnvSource::Captured,
            Duration::from_millis(50),
        )
        .await;

        assert!(env_is_removed(&command, &inherited_key));
        assert_eq!(env_value(&command, "PATH"), None);
        assert_eq!(
            env_value(&command, "GIT_TERMINAL_PROMPT"),
            Some(OsString::from("0"))
        );
    }

    #[test]
    fn env_source_policy_uses_captured_for_hook_sensitive_mutations() {
        assert_eq!(
            env_source_for_git_args(&["switch", "main"]),
            EnvSource::Captured
        );
        assert_eq!(env_source_for_git_args(&["stash"]), EnvSource::Captured);
        assert_eq!(env_source_for_git_args(&["init"]), EnvSource::Captured);
        assert_eq!(
            env_source_for_git_args(&["fetch", "--prune"]),
            EnvSource::Captured
        );
        assert_eq!(
            env_source_for_git_args(&["pull", "--ff-only"]),
            EnvSource::Captured
        );
        assert_eq!(
            env_source_for_git_args(&["worktree", "add", "../repo-worktrees/foo", "main"]),
            EnvSource::Captured
        );
    }

    #[test]
    fn env_source_policy_uses_smart_for_read_and_status_probes() {
        assert_eq!(
            env_source_for_git_args(&["rev-parse", "--show-toplevel"]),
            EnvSource::Smart
        );
        assert_eq!(
            env_source_for_git_args(&["status", "--porcelain"]),
            EnvSource::Smart
        );
        assert_eq!(
            env_source_for_git_args(&["worktree", "list", "--porcelain"]),
            EnvSource::Smart
        );
        assert_eq!(
            env_source_for_git_args(&["for-each-ref", "refs/heads"]),
            EnvSource::Smart
        );
    }

    #[test]
    fn retry_predicate_skips_missing_ref_object_and_revision_errors() {
        assert!(is_missing_ref_or_object_error(
            "fatal: Needed a single revision"
        ));
        assert!(is_missing_ref_or_object_error(
            "fatal: ambiguous argument 'origin/foo': unknown revision or path not in the working tree."
        ));
        assert!(is_missing_ref_or_object_error(
            "fatal: Not a valid object name origin/foo"
        ));
        assert!(is_missing_ref_or_object_error(
            "fatal: no upstream configured for branch 'main'"
        ));
        assert!(is_missing_ref_or_object_error(
            "fatal: Not a valid commit name origin/foo"
        ));
        assert!(is_missing_ref_or_object_error(
            "fatal: bad revision 'origin/foo'"
        ));
        assert!(is_missing_ref_or_object_error("fatal: bad object HEAD"));
    }

    #[test]
    fn retry_predicate_treats_spawn_not_found_as_env_sensitive() {
        assert!(should_retry_with_captured_error(&GitRunError::Spawn(
            io::Error::new(io::ErrorKind::NotFound, "git")
        )));
        assert!(!should_retry_with_captured_error(&GitRunError::Spawn(
            io::Error::new(io::ErrorKind::PermissionDenied, "git")
        )));
        assert!(!should_retry_with_captured_error(&GitRunError::TimedOut));
    }

    #[cfg(unix)]
    fn failed_output(stderr: &str) -> Output {
        use std::os::unix::process::ExitStatusExt;

        Output {
            status: std::process::ExitStatus::from_raw(1),
            stdout: Vec::new(),
            stderr: stderr.as_bytes().to_vec(),
        }
    }

    #[cfg(unix)]
    #[test]
    fn smart_retry_skips_env_independent_git_failures() {
        assert!(!should_retry_with_captured_output(&failed_output(
            "fatal: not a git repository (or any of the parent directories): .git"
        )));
        assert!(!should_retry_with_captured_output(&failed_output(
            "fatal: bad revision 'origin/foo'"
        )));
    }

    #[cfg(unix)]
    #[test]
    fn smart_retry_retries_unrecognized_git_failures() {
        assert!(should_retry_with_captured_output(&failed_output(
            "git-lfs: command not found"
        )));
    }

    #[test]
    fn force_non_interactive_sets_git_prompt_ssh_and_locale_defaults() {
        let mut command = TokioCommand::new("git");

        force_non_interactive(&mut command);
        pin_c_locale(&mut command);

        assert_eq!(
            env_value(&command, "GIT_TERMINAL_PROMPT"),
            Some(OsString::from("0"))
        );
        assert_eq!(
            env_value(&command, "GIT_SSH_COMMAND"),
            Some(OsString::from("ssh -o BatchMode=yes -o ConnectTimeout=10"))
        );
        assert_eq!(env_value(&command, "LC_ALL"), Some(OsString::from("C")));
        assert_eq!(env_value(&command, "LANG"), Some(OsString::from("C")));
    }

    #[test]
    fn force_non_interactive_respects_captured_git_ssh_command() {
        let mut command = TokioCommand::new("git");
        let env = HashMap::from([(
            "GIT_SSH_COMMAND".to_string(),
            "/usr/local/bin/company-ssh".to_string(),
        )]);

        apply_captured_git_env(&mut command, &env);
        force_non_interactive(&mut command);

        assert_eq!(
            env_value(&command, "GIT_SSH_COMMAND"),
            Some(OsString::from("/usr/local/bin/company-ssh"))
        );
    }
}
