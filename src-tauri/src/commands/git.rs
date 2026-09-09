use serde::Serialize;
use std::collections::HashMap;
use std::io;
use std::path::{Path, PathBuf};
use std::process::Output;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::process::Command as TokioCommand;
use tokio::time::timeout;

use crate::services::{dir_env, env_key};

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
// Large monorepo worktrees can legitimately spend 5–10 minutes in checkout
// hooks and generated-file setup; keep other Git mutations on the shorter cap.
const GIT_WORKTREE_CREATE_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const GIT_STATE_OPERATION_TIMEOUT: Duration = Duration::from_secs(90);

fn dir_env_capture_timeout(command_timeout: Duration) -> Duration {
    command_timeout
        .checked_add(command_timeout / 2)
        .unwrap_or(command_timeout)
        .min(GIT_MUTATING_COMMAND_TIMEOUT)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EnvSource {
    /// Try the inherited environment first and retry with captured env only for
    /// failures that plausibly depend on directory-scoped shell activation.
    Smart,
    /// Inherited process env with repository-targeting Git controls stripped.
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
pub async fn git_has_ignored_files(path: String) -> Result<bool, String> {
    let repo_path = resolve_repo_path(&path)?;
    let output = run_git_success_async(
        &repo_path,
        &[
            "ls-files",
            "--others",
            "--ignored",
            "--exclude-standard",
            "--directory",
            "--no-empty-directory",
        ],
        GIT_STATUS_COMMAND_TIMEOUT,
    )
    .await?;
    Ok(!output.trim().is_empty())
}

#[tauri::command]
pub async fn git_count_branch_commits_not_in_base(
    path: String,
    branch: String,
    base_branch: String,
) -> Result<u32, String> {
    let repo_path = resolve_repo_path(&path)?;
    let branch_name = require_nonempty(&branch, "Branch name")?;
    let base_branch_name = require_nonempty(&base_branch, "Base branch")?;
    let range = format!("refs/heads/{base_branch_name}..refs/heads/{branch_name}");
    let output = run_git_success_async(
        &repo_path,
        &["rev-list", "--count", &range],
        GIT_READ_COMMAND_TIMEOUT,
    )
    .await?;
    output
        .trim()
        .parse::<u32>()
        .map_err(|error| format!("Failed to parse branch commit count: {error}"))
}

#[tauri::command]
pub async fn git_delete_branch(
    path: String,
    branch: String,
    force: bool,
    switch_to_branch: Option<String>,
) -> Result<(), String> {
    let repo_path = resolve_repo_path(&path)?;
    let branch_name = require_nonempty(&branch, "Branch name")?;
    let current_branch = trim_to_option(
        run_git_success_async(
            &repo_path,
            &["branch", "--show-current"],
            GIT_READ_COMMAND_TIMEOUT,
        )
        .await?,
    );

    if current_branch.as_deref() == Some(branch_name.as_str()) {
        let target_branch = require_nonempty(
            switch_to_branch.as_deref().unwrap_or_default(),
            "Switch target branch",
        )?;
        if target_branch == branch_name {
            return Err(
                "Switch target branch must differ from the branch being deleted".to_string(),
            );
        }

        let switch_args = delete_branch_switch_args(force, target_branch.as_str());
        run_git_success_async(&repo_path, &switch_args, GIT_MUTATING_COMMAND_TIMEOUT).await?;
    }

    let delete_flag = if force { "-D" } else { "-d" };
    run_git_success_async(
        &repo_path,
        &["branch", delete_flag, "--", branch_name.as_str()],
        GIT_MUTATING_COMMAND_TIMEOUT,
    )
    .await?;
    Ok(())
}

fn delete_branch_switch_args(force: bool, target_branch: &str) -> Vec<&str> {
    let mut switch_args = vec!["switch"];
    if force {
        switch_args.push("-f");
    }
    if target_branch == "HEAD" {
        switch_args.push("--detach");
        switch_args.push(target_branch);
    } else {
        switch_args.push("--");
        switch_args.push(target_branch);
    }
    switch_args
}

async fn run_git_worktree_add_success(path: &Path, args: &[&str]) -> Result<String, String> {
    match timeout(
        GIT_WORKTREE_CREATE_TIMEOUT,
        run_git_success_async(path, args, GIT_WORKTREE_CREATE_TIMEOUT),
    )
    .await
    {
        Ok(result) => result,
        Err(_) => Err(format!(
            "git {} timed out after {} seconds",
            args.join(" "),
            GIT_WORKTREE_CREATE_TIMEOUT.as_secs()
        )),
    }
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
        run_git_worktree_add_success(
            &repo_path,
            &[
                "worktree",
                "add",
                "-b",
                branch_name.as_str(),
                target_path_string.as_str(),
                base_branch.as_str(),
            ],
        )
        .await?;
    } else {
        run_git_worktree_add_success(
            &repo_path,
            &[
                "worktree",
                "add",
                target_path_string.as_str(),
                branch_name.as_str(),
            ],
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

#[tauri::command]
pub async fn git_remove_worktree(
    path: String,
    worktree_path: String,
    force: bool,
) -> Result<(), String> {
    let repo_path = resolve_repo_path(&path)?;
    let worktree_path = require_nonempty(&worktree_path, "Worktree path")?;
    let mut args = vec!["worktree", "remove"];
    if force {
        args.push("--force");
    }
    args.push("--");
    args.push(worktree_path.as_str());
    run_git_success_async(&repo_path, &args, GIT_MUTATING_COMMAND_TIMEOUT).await?;
    Ok(())
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

fn build_git_command(git: &Path, path: &Path, args: &[&str]) -> TokioCommand {
    let mut command = TokioCommand::new(git);
    command.args(args).current_dir(path).kill_on_drop(true);
    command
}

async fn run_git_once_async(
    path: &Path,
    args: &[&str],
    command_timeout: Duration,
    env_source: EnvSource,
) -> Result<Output, GitRunError> {
    let git = dir_env::resolve_control_executable("git").ok_or_else(|| {
        GitRunError::Spawn(io::Error::new(
            io::ErrorKind::NotFound,
            "trusted Git executable was not found",
        ))
    })?;
    let mut command = build_git_command(&git, path, args);

    apply_git_environment(
        &mut command,
        path,
        env_source,
        dir_env_capture_timeout(command_timeout),
    )
    .await;

    crate::services::process::apply_no_window_async(&mut command);
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
        | ["branch", "-d" | "-D", ..]
        | ["worktree", "add", ..]
        | ["worktree", "remove", ..] => EnvSource::Captured,
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
            if let Some(mut env) = dir_env::capture_dir_env(path, capture_timeout).await {
                sanitize_git_env(&mut env);
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
    command.envs(env);
}

/// Git transport variables Berd deliberately carries across repository
/// boundaries. Every other inherited `GIT_*` variable is removed so newly
/// introduced Git controls fail closed instead of bypassing a stale denylist.
const PRESERVED_GIT_TRANSPORT_ENV_KEYS: &[&str] =
    &["GIT_SSH", "GIT_SSH_COMMAND", "GIT_SSH_VARIANT"];

fn sanitize_git_env(env: &mut HashMap<String, String>) {
    env.retain(|key, _| !is_git_env_key(key) || is_preserved_git_transport_key(key));
}

fn is_git_env_key(key: &str) -> bool {
    key.get(..4)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("GIT_"))
}

fn is_preserved_git_transport_key(key: &str) -> bool {
    PRESERVED_GIT_TRANSPORT_ENV_KEYS
        .iter()
        .any(|preserved| env_key::matches(key, preserved))
}

fn apply_lite_git_env(command: &mut TokioCommand) {
    let explicit_git_env = command
        .as_std()
        .get_envs()
        .filter_map(|(key, value)| {
            let key_text = key.to_str()?;
            is_git_env_key(key_text)
                .then(|| (key.to_os_string(), value.map(std::ffi::OsStr::to_os_string)))
        })
        .collect::<Vec<_>>();
    let explicitly_configured_transport_keys = explicit_git_env
        .iter()
        .filter_map(|(key, _)| {
            key.to_str()
                .filter(|key| is_preserved_git_transport_key(key))
        })
        .collect::<Vec<_>>();
    let inherited_transport = std::env::vars().filter(|(key, _)| {
        is_preserved_git_transport_key(key)
            && !explicitly_configured_transport_keys
                .iter()
                .any(|explicit| env_key::matches(explicit, key))
    });

    for key in std::env::vars_os()
        .map(|(key, _)| key)
        .chain(explicit_git_env.iter().map(|(key, _)| key.clone()))
    {
        if key.to_str().is_some_and(is_git_env_key) {
            command.env_remove(key);
        }
    }
    command.envs(inherited_transport);
    for (key, value) in explicit_git_env {
        if !key.to_str().is_some_and(is_preserved_git_transport_key) {
            continue;
        }
        if let Some(value) = value {
            command.env(key, value);
        } else {
            command.env_remove(key);
        }
    }
}

fn force_non_interactive(command: &mut TokioCommand) {
    command.env("GIT_TERMINAL_PROMPT", "0");
    if !has_env(command, "GIT_SSH_COMMAND") && !has_env(command, "GIT_SSH") {
        command.env(
            "GIT_SSH_COMMAND",
            "ssh -o BatchMode=yes -o ConnectTimeout=10",
        );
    }
}

fn has_env(command: &TokioCommand, key: &str) -> bool {
    command.as_std().get_envs().any(|(existing_key, value)| {
        value.is_some()
            && existing_key
                .to_str()
                .is_some_and(|existing| env_key::matches(existing, key))
    })
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

    #[tokio::test]
    async fn ignored_file_probe_reports_files_hidden_by_git_status() {
        let temp = tempfile::tempdir().expect("temp dir");
        run_git_success_async(temp.path(), &["init", "-q"], GIT_MUTATING_COMMAND_TIMEOUT)
            .await
            .expect("initialize git repo");
        let path = temp.path().to_string_lossy().to_string();

        assert!(!git_has_ignored_files(path.clone())
            .await
            .expect("probe empty repo"));

        std::fs::write(temp.path().join(".gitignore"), "*.secret\n").expect("write gitignore");
        std::fs::write(temp.path().join("local.secret"), "do not delete")
            .expect("write ignored file");

        assert!(git_has_ignored_files(path)
            .await
            .expect("probe ignored file"));
    }

    #[test]
    fn dir_env_capture_timeout_is_capped_for_extended_commands() {
        assert_eq!(
            dir_env_capture_timeout(Duration::from_secs(10)),
            Duration::from_secs(15)
        );
        assert_eq!(
            dir_env_capture_timeout(GIT_WORKTREE_CREATE_TIMEOUT),
            GIT_MUTATING_COMMAND_TIMEOUT
        );
    }

    #[test]
    fn captured_git_env_replaces_command_env_and_preserves_full_snapshot() {
        let mut command = TokioCommand::new("git");
        command.env("STALE_VAR", "remove-me");
        let mut env = HashMap::from([
            (
                "PATH".to_string(),
                "/repo/.hermit/bin:/repo/bin:/usr/bin".to_string(),
            ),
            ("CUSTOM_DIR_ENV".to_string(), "forwarded".to_string()),
            ("GIT_DIR".to_string(), "/wrong/repo/.git".to_string()),
            ("GIT_WORK_TREE".to_string(), "/wrong/repo".to_string()),
            ("GIT_INDEX_FILE".to_string(), "/wrong/index".to_string()),
            ("GIT_NAMESPACE".to_string(), "wrong-namespace".to_string()),
            (
                "GIT_CONFIG_GLOBAL".to_string(),
                "/wrong/global.gitconfig".to_string(),
            ),
            (
                "GIT_CONFIG_SYSTEM".to_string(),
                "/wrong/system.gitconfig".to_string(),
            ),
            ("GIT_CEILING_DIRECTORIES".to_string(), "/repo".to_string()),
            (
                "GIT_DISCOVERY_ACROSS_FILESYSTEM".to_string(),
                "false".to_string(),
            ),
            (
                "GIT_OBJECT_DIRECTORY".to_string(),
                "/wrong/objects".to_string(),
            ),
            (
                "GIT_ALTERNATE_OBJECT_DIRECTORIES".to_string(),
                "/wrong/alternate-objects".to_string(),
            ),
            (
                "GIT_SSH_COMMAND".to_string(),
                "/usr/local/bin/company-ssh".to_string(),
            ),
        ]);

        sanitize_git_env(&mut env);
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
        assert_eq!(env_value(&command, "GIT_DIR"), None);
        assert_eq!(env_value(&command, "GIT_WORK_TREE"), None);
        assert_eq!(env_value(&command, "GIT_INDEX_FILE"), None);
        assert_eq!(env_value(&command, "GIT_NAMESPACE"), None);
        assert_eq!(env_value(&command, "GIT_CONFIG_GLOBAL"), None);
        assert_eq!(env_value(&command, "GIT_CONFIG_SYSTEM"), None);
        assert_eq!(env_value(&command, "GIT_CEILING_DIRECTORIES"), None);
        assert_eq!(env_value(&command, "GIT_DISCOVERY_ACROSS_FILESYSTEM"), None);
        assert_eq!(env_value(&command, "GIT_OBJECT_DIRECTORY"), None);
        assert_eq!(
            env_value(&command, "GIT_ALTERNATE_OBJECT_DIRECTORIES"),
            None
        );
        assert_eq!(
            env_value(&command, "GIT_SSH_COMMAND"),
            Some(OsString::from("/usr/local/bin/company-ssh"))
        );
    }

    #[cfg(windows)]
    #[test]
    fn captured_windows_env_strips_mixed_case_git_controls() {
        let mut command = TokioCommand::new("git");
        let mut env = HashMap::from([
            ("git_work_tree".to_string(), "C:\\wrong".to_string()),
            (
                "git_ssh_command".to_string(),
                "C:\\Tools\\company-ssh.cmd".to_string(),
            ),
        ]);

        sanitize_git_env(&mut env);
        apply_captured_git_env(&mut command, &env);
        force_non_interactive(&mut command);

        assert_eq!(env_value(&command, "git_work_tree"), None);
        assert_eq!(
            env_value(&command, "git_ssh_command"),
            Some(OsString::from("C:\\Tools\\company-ssh.cmd"))
        );
    }

    #[test]
    fn git_env_sanitizer_fails_closed_for_unknown_git_variables() {
        let mut env = HashMap::from([
            (
                "GIT_FUTURE_REPOSITORY_CONTROL".to_string(),
                "unsafe".to_string(),
            ),
            ("GIT_SSH_COMMAND".to_string(), "company-ssh".to_string()),
            ("PATH".to_string(), "/usr/bin".to_string()),
        ]);

        sanitize_git_env(&mut env);

        assert!(!env.contains_key("GIT_FUTURE_REPOSITORY_CONTROL"));
        assert_eq!(env.get("GIT_SSH_COMMAND"), Some(&"company-ssh".to_string()));
        assert_eq!(env.get("PATH"), Some(&"/usr/bin".to_string()));
    }

    #[test]
    fn lite_git_env_preserves_explicit_transport_and_strips_explicit_controls() {
        let mut command = TokioCommand::new("git");
        command.env("GIT_SSH_COMMAND", "explicit-company-ssh");
        command.env("GIT_FUTURE_REPOSITORY_CONTROL", "unsafe");

        apply_lite_git_env(&mut command);

        assert_eq!(
            env_value(&command, "GIT_SSH_COMMAND"),
            Some(OsString::from("explicit-company-ssh"))
        );
        assert!(env_is_removed(&command, "GIT_FUTURE_REPOSITORY_CONTROL"));
    }

    #[test]
    fn lite_git_env_does_not_override_path() {
        let mut command = TokioCommand::new("git");
        apply_lite_git_env(&mut command);
        assert_eq!(env_value(&command, "PATH"), None);
    }

    #[cfg(not(windows))]
    #[tokio::test]
    async fn captured_env_failure_falls_back_to_lite_env() {
        let temp = tempfile::tempdir().expect("temp dir");
        let missing_dir = temp.path().join("missing");

        let mut command = TokioCommand::new("git");
        command.env("GIT_DIR", "/wrong/repo");
        command.env("GIT_WORK_TREE", "/wrong/worktree");
        command.env("GIT_INDEX_FILE", "/wrong/index");
        apply_git_environment(
            &mut command,
            &missing_dir,
            EnvSource::Captured,
            Duration::from_millis(50),
        )
        .await;

        assert!(env_is_removed(&command, "GIT_DIR"));
        assert!(env_is_removed(&command, "GIT_WORK_TREE"));
        assert!(env_is_removed(&command, "GIT_INDEX_FILE"));
        assert_eq!(env_value(&command, "PATH"), None);
        assert_eq!(
            env_value(&command, "GIT_TERMINAL_PROMPT"),
            Some(OsString::from("0"))
        );
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn windows_captured_env_runs_hermit_managed_cmd_git_hook() {
        let temp = tempfile::tempdir().expect("temp dir");
        let repo = temp.path().join("Project With Spaces");
        let hook = repo.join(".git").join("hooks").join("post-checkout");
        let hermit_bin = repo.join(".hermit").join("bin");
        let marker = repo.join("hermit-hook-ran.txt");
        std::fs::create_dir_all(&repo).expect("repo");
        let run_setup_git = |args: &[&str]| {
            let output = std::process::Command::new("git")
                .args(args)
                .current_dir(&repo)
                .output()
                .expect("run setup git");
            assert!(
                output.status.success(),
                "setup git {args:?} failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        };
        run_setup_git(&["init", "-q"]);
        std::fs::write(repo.join("tracked.txt"), "tracked\n").expect("tracked file");
        run_setup_git(&["add", "tracked.txt"]);
        run_setup_git(&[
            "-c",
            "user.name=Berd Test",
            "-c",
            "user.email=berd@example.test",
            "commit",
            "-qm",
            "fixture",
        ]);
        std::fs::create_dir_all(&hermit_bin).expect("Hermit bin");
        std::fs::write(
            hermit_bin.join("hermit-hook-tool.CMD"),
            format!("@echo off\r\n>\"{}\" echo managed\r\n", marker.display()),
        )
        .expect("managed CMD tool");
        // Git for Windows runs hooks under an MSYS sh, which rewrites `/d`
        // and `/c` into paths before cmd.exe sees them. Disable MSYS argument
        // conversion for this invocation so cmd receives its native switches.
        // Seed PATHEXT with `.CMD` inside the hook so this Hermit PATH test is
        // independent of the parent runner's executable-extension policy;
        // PATHEXT inheritance and extensionless lookup are covered by dedicated
        // child-process regressions. `exit "$?"` ensures a failed tool lookup
        // cannot silently pass.
        std::fs::write(
            &hook,
            "#!/bin/sh\nPATHEXT=\".CMD${PATHEXT:+;$PATHEXT}\"\nexport PATHEXT\nMSYS2_ARG_CONV_EXCL='*' cmd.exe /d /c hermit-hook-tool\nexit \"$?\"\n",
        )
        .expect("hook");
        let mut command = TokioCommand::new("git");
        command
            .args(["checkout", "-b", "hook-test"])
            .current_dir(&repo);

        apply_git_environment(
            &mut command,
            &repo,
            EnvSource::Captured,
            Duration::from_secs(5),
        )
        .await;
        assert!(
            command
                .as_std()
                .get_envs()
                .any(|(key, value)| key.eq_ignore_ascii_case("PATHEXT") && value.is_some()),
            "captured Rust child env must carry PATHEXT; Git owns the downstream hook environment"
        );
        let output = command.output().await.expect("run Git hook");

        assert!(
            output.status.success(),
            "git checkout failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(
            std::fs::read_to_string(marker)
                .expect("Hermit hook marker")
                .trim(),
            "managed"
        );
    }

    /// A hook whose tool lookup fails must fail the Git operation: the fixture
    /// above cannot be trusted unless a missing tool propagates a nonzero
    /// status through the same native cmd boundary.
    #[cfg(windows)]
    #[tokio::test]
    async fn windows_captured_env_propagates_hook_tool_lookup_failure() {
        let temp = tempfile::tempdir().expect("temp dir");
        let repo = temp.path().join("Project With Spaces");
        let hook = repo.join(".git").join("hooks").join("pre-commit");
        std::fs::create_dir_all(&repo).expect("repo");
        let run_setup_git = |args: &[&str]| {
            let output = std::process::Command::new("git")
                .args(args)
                .current_dir(&repo)
                .output()
                .expect("run setup git");
            assert!(
                output.status.success(),
                "setup git {args:?} failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        };
        run_setup_git(&["init", "-q"]);
        std::fs::write(
            repo.join("tracked.txt"),
            "tracked
",
        )
        .expect("tracked file");
        run_setup_git(&["add", "tracked.txt"]);
        std::fs::write(
            &hook,
            "#!/bin/sh
MSYS2_ARG_CONV_EXCL='*' cmd.exe /d /c berd-missing-hook-tool-fixture
exit \"$?\"
",
        )
        .expect("hook");
        let mut command = TokioCommand::new("git");
        command
            .args([
                "-c",
                "user.name=Berd Test",
                "-c",
                "user.email=berd@example.test",
                "commit",
                "-qm",
                "fixture",
            ])
            .current_dir(&repo);

        apply_git_environment(
            &mut command,
            &repo,
            EnvSource::Captured,
            Duration::from_secs(5),
        )
        .await;
        let output = command.output().await.expect("run Git hook");

        assert!(
            !output.status.success(),
            "commit must fail when the hook tool lookup fails"
        );
    }

    #[cfg(windows)]
    #[test]
    fn git_command_program_is_not_resolved_from_captured_path() {
        let trusted_git = PathBuf::from(r"C:\Program Files\Git\cmd\git.exe");
        let project_bin = PathBuf::from(r"C:\repo\.hermit\bin");
        let mut command = build_git_command(&trusted_git, Path::new(r"C:\repo"), &["status"]);
        let env = HashMap::from([(
            "Path".to_string(),
            std::env::join_paths([project_bin.clone(), PathBuf::from(r"C:\Windows\System32")])
                .expect("captured PATH")
                .to_string_lossy()
                .into_owned(),
        )]);

        apply_captured_git_env(&mut command, &env);

        assert_eq!(command.as_std().get_program(), trusted_git.as_os_str());
        assert_eq!(
            std::env::split_paths(&env_value(&command, "PATH").expect("command PATH"))
                .next()
                .as_deref(),
            Some(project_bin.as_path())
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
        assert_eq!(
            env_source_for_git_args(&["worktree", "remove", "--force", "../repo-worktrees/foo"]),
            EnvSource::Captured
        );
        assert_eq!(
            env_source_for_git_args(&["branch", "-D", "--", "feature/foo"]),
            EnvSource::Captured
        );
    }

    #[test]
    fn delete_branch_switch_args_detaches_at_head() {
        assert_eq!(
            delete_branch_switch_args(true, "HEAD"),
            vec!["switch", "-f", "--detach", "HEAD"]
        );
        assert_eq!(
            delete_branch_switch_args(false, "main"),
            vec!["switch", "--", "main"]
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
    fn force_non_interactive_respects_captured_git_ssh() {
        let mut command = TokioCommand::new("git");
        let mut env = HashMap::from([
            (
                "GIT_SSH".to_string(),
                "/usr/local/bin/company-ssh".to_string(),
            ),
            ("GIT_SSH_VARIANT".to_string(), "ssh".to_string()),
        ]);

        sanitize_git_env(&mut env);
        apply_captured_git_env(&mut command, &env);
        force_non_interactive(&mut command);

        assert_eq!(
            env_value(&command, "GIT_SSH"),
            Some(OsString::from("/usr/local/bin/company-ssh"))
        );
        assert_eq!(
            env_value(&command, "GIT_SSH_VARIANT"),
            Some(OsString::from("ssh"))
        );
        assert_eq!(env_value(&command, "GIT_SSH_COMMAND"), None);
    }

    #[test]
    fn force_non_interactive_respects_captured_git_ssh_command() {
        let mut command = TokioCommand::new("git");
        let mut env = HashMap::from([(
            "GIT_SSH_COMMAND".to_string(),
            "/usr/local/bin/company-ssh".to_string(),
        )]);

        sanitize_git_env(&mut env);
        apply_captured_git_env(&mut command, &env);
        force_non_interactive(&mut command);

        assert_eq!(
            env_value(&command, "GIT_SSH_COMMAND"),
            Some(OsString::from("/usr/local/bin/company-ssh"))
        );
    }
}
