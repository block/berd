use tauri::Manager;
use tauri_plugin_shell::ShellExt;

use crate::commands::runtime_config::{
    local_byo_key_providers_enabled, RuntimeConfig, RuntimeConfigState,
};
use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::services::diagnostic_log::{
    self, DiagnosticCategory, DiagnosticFieldValue, DiagnosticLevel,
};
use crate::services::dir_env;
use crate::services::distro_bundle::DistroBundleState;
use crate::services::env_key;
use crate::services::goose_config;
use crate::services::log_redaction::redact_log_line;
use crate::services::managed_acp_tools;
use crate::services::path_env;
#[cfg(unix)]
use crate::services::process::ProcessId;
#[cfg(unix)]
use crate::services::process::{kill_process, terminate_process};
use crate::services::process::{pid_t_from_u32, process_is_alive};
#[cfg(windows)]
use crate::services::process::{IdentityProbe, ProcessIdentity};

use tokio::io::{AsyncBufReadExt, AsyncRead, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::OnceCell;

const GOOSE_SERVE_CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
const GOOSE_SERVE_CONNECT_RETRY_DELAY: Duration = Duration::from_millis(100);
const GOOSE_SEARCH_PATHS_ENV: &str = "GOOSE_SEARCH_PATHS";
const LOCALHOST: &str = "127.0.0.1";
#[cfg(target_os = "windows")]
const TAURI_WEBVIEW_ORIGIN: &str = "http://tauri.localhost";
#[cfg(not(target_os = "windows"))]
const TAURI_WEBVIEW_ORIGIN: &str = "tauri://localhost";
const DATABRICKS_HOST_ENV: &str = "DATABRICKS_HOST";
const GOOSE_FAST_MODEL_ENV: &str = "GOOSE_FAST_MODEL";

// ---------------------------------------------------------------------------
// GooseServeProcess — singleton that owns the long-lived `goose serve` child
// ---------------------------------------------------------------------------

/// A long-lived `goose serve` process that accepts WebSocket connections.
///
/// Each WebSocket connection to the `/acp` endpoint creates an independent
/// ACP agent inside the server, so a single process can serve any number of
/// concurrent sessions.
pub struct GooseServeProcess {
    port: u16,
    secret_key: String,
    process_record_dir: PathBuf,
    _child: Child,
}

/// Global singleton — initialised once at app startup.
static GOOSE_SERVE: OnceCell<GooseServeProcess> = OnceCell::const_new();

impl GooseServeProcess {
    /// Return the WebSocket URL for connecting to this server.
    pub fn ws_url(&self) -> String {
        acp_websocket_url(self.port, &self.secret_key)
    }

    /// Return the HTTP base URL for authenticated Goose server routes.
    pub fn http_base_url(&self) -> String {
        format!("http://{LOCALHOST}:{}", self.port)
    }

    /// Return the secret key used to authenticate local HTTP requests.
    pub fn secret_key(&self) -> &str {
        &self.secret_key
    }

    /// Get a reference to the running process, or an error if it was never
    /// started (should not happen in normal operation).
    pub async fn get(app_handle: tauri::AppHandle) -> Result<&'static GooseServeProcess, String> {
        GOOSE_SERVE
            .get_or_try_init(|| async { Self::spawn(app_handle).await })
            .await
    }

    /// Kill the child process. Called from the app exit handler to ensure
    /// the child doesn't outlive the Tauri process.
    pub fn kill(&self) {
        #[cfg(unix)]
        if let Some(child_pid) = self._child.id() {
            match pid_t_from_u32(child_pid) {
                Some(pid) => {
                    log::info!("Killing goose serve child (pid {child_pid})");
                    terminate_process(pid);
                }
                None => {
                    log::warn!(
                        "Skipping goose serve child kill because pid {child_pid} is outside pid_t range"
                    );
                }
            }
        }

        #[cfg(windows)]
        let remove_process_record = if let Some(handle) = self._child.raw_handle() {
            log::info!("Killing goose serve child through its retained process handle");
            // SAFETY: Tokio owns this process handle for the lifetime of `_child`.
            match unsafe {
                crate::services::process::terminate_process_handle(handle, Duration::from_secs(5))
            } {
                Ok(()) => true,
                Err(error) => {
                    log::warn!(
                        "Failed to stop goose serve child: {error}; keeping process record for recovery"
                    );
                    false
                }
            }
        } else {
            log::warn!(
                "Cannot stop goose serve child through its retained handle; keeping process record for recovery"
            );
            false
        };

        #[cfg(unix)]
        let remove_process_record = true;

        // Keep recovery evidence until child exit has been confirmed on Windows.
        if remove_process_record {
            let _ = std::fs::remove_file(process_record_path(&self.process_record_dir));
        }
    }

    /// Kill the singleton goose serve process if it exists. Called from the
    /// app exit handler.
    pub fn kill_singleton() {
        if let Some(process) = GOOSE_SERVE.get() {
            process.kill();
        }
    }

    async fn spawn(app_handle: tauri::AppHandle) -> Result<GooseServeProcess, String> {
        let process_started_at = Instant::now();

        // Kill any orphaned goose serve process left by a previous run
        // (e.g. tauri dev hot-reload).
        let process_record_dir =
            crate::services::e2e_mode::E2eMode::process_record_dir_for(&app_handle)
                .unwrap_or_else(|| std::env::temp_dir().join(PROCESS_RECORD_DIR_NAME));
        kill_stale_serve_process(&process_record_dir).await;

        let port = reserve_free_port()?;
        let secret_key = format!("berd-{}", uuid::Uuid::new_v4().simple());

        // Use a stable working directory for the long-lived server process.
        // Individual sessions will set their own cwd via the ACP protocol.
        let working_dir = default_serve_working_dir();
        std::fs::create_dir_all(&working_dir).map_err(|e| {
            format!(
                "Failed to create goose serve working directory {}: {e}",
                working_dir.display()
            )
        })?;

        let mut command: Command = get_goose_command(&app_handle)?;
        let binary_display = command.as_std().get_program().to_string_lossy().to_string();

        // When launched from Finder/Dock/Spotlight, the app inherits a minimal
        // launchd environment. Restore the user's login shell environment so
        // goosed has access to PATH, LANG, and other needed variables. The
        // login shell often misses node-version-manager shims (nvm sources
        // from .zshrc, not .zprofile), so override PATH with the extended
        // path used by every other subprocess spawn site in this app, with
        // the distro `bin_dir` (if any) prepended in front of it.
        let shell_env = dir_env::capture_home_interactive_env().await;
        let mut prepend_dirs: Vec<PathBuf> = Vec::new();
        let mut distro_config_path: Option<PathBuf> = None;

        if let Some(distro_state) = app_handle.try_state::<DistroBundleState>() {
            if let Some(bundle) = distro_state.bundle() {
                if let Some(bin_dir) = &bundle.bin_dir {
                    prepend_dirs.push(bin_dir.clone());
                }
                if let Some(config_path) = &bundle.config_path {
                    distro_config_path = Some(config_path.clone());
                }
                command.env("GOOSE_DISTRO_DIR", &bundle.root_dir);
            }
        }
        // Berd-managed installs: the lock-pinned bridge shims in `packages/bin`
        // (or the `BERD_ACP_TOOLS_DIR` dev override), the private npm prefix
        // (copilot, amp-acp), and the managed Node runtime their
        // `#!/usr/bin/env node` shims run on — goosed spawns bridges from
        // PATH / GOOSE_SEARCH_PATHS. Nothing ships inside the bundle; the
        // startup reconciler installs the lock's bridges into app data.
        prepend_dirs.extend(managed_acp_tools::managed_prepend_dirs(&app_handle));

        #[cfg(feature = "berdctl")]
        let berdctl_paths = resolve_berdctl_spawn_paths(&app_handle, &mut prepend_dirs);

        apply_shell_env_with_extended_path(&mut command, &shell_env, &prepend_dirs);
        // Set after the shell-env copy so same-named vars in the user's
        // shell cannot clobber Berd-managed values.
        apply_goose_search_paths_env(&mut command, &shell_env, &prepend_dirs);
        #[cfg(feature = "berdctl")]
        apply_berdctl_env(
            &mut command,
            berdctl_paths.app_data_dir.as_deref(),
            berdctl_paths.berdctl_bin.as_deref(),
        );
        if let Some(config_path) = distro_config_path.as_deref() {
            apply_additional_config_files_env(&mut command, &shell_env, config_path);
        }
        super::security_env::apply(&mut command);
        match runtime_config_for_spawn(&app_handle).await {
            Ok(runtime_config) => apply_runtime_goose_provider_env(&mut command, &runtime_config),
            Err(error) => log::warn!("failed to load runtime config for goose serve env: {error}"),
        }
        // This must be the final environment layer. Captured shell and runtime
        // provider values are intentionally unable to redirect an E2E child
        // back into a normal Goose root or keyring.
        crate::services::e2e_mode::E2eMode::apply_goose_command_env_if_active(
            &app_handle,
            &mut command,
        );

        command
            .arg("serve")
            .arg("--enable-scheduler")
            .arg("--host")
            .arg(LOCALHOST)
            .arg("--port")
            .arg(port.to_string());
        add_release_webview_origin_arg(&mut command);
        command
            .current_dir(&working_dir)
            .env("GOOSE_SERVER__SECRET_KEY", &secret_key)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);

        log::info!(
            "Spawning long-lived goose serve: binary={binary_display} port={port} cwd={}",
            working_dir.display(),
        );
        diagnostic_log::record_event(
            DiagnosticLevel::Info,
            DiagnosticCategory::GooseServe,
            "spawn_start",
            None,
            diagnostic_log::fields([
                ("binaryPath", binary_display.clone().into()),
                ("cwd", working_dir.to_string_lossy().to_string().into()),
                ("port", port.into()),
            ]),
        );

        crate::services::process::apply_no_window_async(&mut command);
        let mut child = command.spawn().map_err(|error| {
            diagnostic_log::record_event(
                DiagnosticLevel::Error,
                DiagnosticCategory::GooseServe,
                "spawn_failed",
                Some(process_started_at.elapsed().as_millis() as u64),
                diagnostic_log::fields([
                    ("classification", "spawn_failed".into()),
                    ("error", error.to_string().into()),
                    ("binaryPath", binary_display.clone().into()),
                    ("cwd", working_dir.to_string_lossy().to_string().into()),
                    ("port", port.into()),
                ]),
            );
            format!(
                "Failed to spawn goose serve (binary: {binary_display}, cwd: {}): {error}",
                working_dir.display()
            )
        })?;
        let pid = child.id();
        diagnostic_log::record_event(
            DiagnosticLevel::Info,
            DiagnosticCategory::GooseServe,
            "spawn_success",
            Some(process_started_at.elapsed().as_millis() as u64),
            diagnostic_log::fields([("pid", optional_u32_value(pid)), ("port", port.into())]),
        );

        #[cfg(windows)]
        if let Err(error) = write_process_record(&process_record_dir, &child) {
            log::warn!(
                "Failed to publish goose serve recovery record: {error}; stopping child and failing startup"
            );
            if let Some(handle) = child.raw_handle() {
                // SAFETY: Tokio owns this process handle for the lifetime of `child`.
                if let Err(stop_error) = unsafe {
                    crate::services::process::terminate_process_handle(
                        handle,
                        Duration::from_secs(5),
                    )
                } {
                    log::warn!("Failed to stop recordless goose serve child: {stop_error}");
                }
            }
            return Err(format!(
                "Failed to publish goose serve recovery record: {error}"
            ));
        }

        spawn_log_reader(child.stdout.take(), "stdout");
        spawn_log_reader(child.stderr.take(), "stderr");

        match wait_for_server_ready(port, &mut child).await {
            Ok(()) => {
                diagnostic_log::record_event(
                    DiagnosticLevel::Info,
                    DiagnosticCategory::GooseServe,
                    "ready",
                    Some(process_started_at.elapsed().as_millis() as u64),
                    diagnostic_log::fields([
                        ("pid", optional_u32_value(pid)),
                        ("port", port.into()),
                    ]),
                );
            }
            Err(error) => {
                diagnostic_log::record_event(
                    DiagnosticLevel::Error,
                    DiagnosticCategory::GooseServe,
                    "ready_failed",
                    Some(process_started_at.elapsed().as_millis() as u64),
                    diagnostic_log::fields([
                        ("classification", "ready_failed".into()),
                        ("error", error.to_string().into()),
                        ("pid", optional_u32_value(pid)),
                        ("port", port.into()),
                    ]),
                );
                return Err(error);
            }
        }

        log::info!("Goose serve is ready on port {port}");

        #[cfg(unix)]
        if let Some(pid) = pid {
            write_pid_file(&process_record_dir, pid);
        }

        Ok(GooseServeProcess {
            port,
            secret_key,
            process_record_dir,
            _child: child,
        })
    }
}

fn acp_websocket_url(port: u16, secret_key: &str) -> String {
    let mut url = reqwest::Url::parse(&format!("ws://{LOCALHOST}:{port}/acp"))
        .expect("local ACP WebSocket URL should be valid");
    url.query_pairs_mut().append_pair("token", secret_key);
    url.to_string()
}

fn add_release_webview_origin_arg(command: &mut Command) {
    if cfg!(debug_assertions) {
        return;
    }

    command.arg("--allowed-origin").arg(TAURI_WEBVIEW_ORIGIN);
}

fn spawn_log_reader<R>(stream: Option<R>, stream_name: &'static str)
where
    R: AsyncRead + Unpin + Send + 'static,
{
    let Some(stream) = stream else {
        return;
    };

    tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(stream).lines();
        loop {
            match lines.next_line().await {
                Ok(Some(line)) => {
                    let line = redact_log_line(&line);
                    if stream_name == "stdout" {
                        log::info!("[goose serve stdout] {line}");
                    } else {
                        log::warn!("[goose serve stderr] {line}");
                    }
                }
                Ok(None) => break,
                Err(error) => {
                    log::warn!("Failed to read goose serve {stream_name}: {error}");
                    break;
                }
            }
        }
    });
}

// ---------------------------------------------------------------------------
// Stale-process record helpers — best-effort orphan cleanup
// ---------------------------------------------------------------------------

const PROCESS_RECORD_DIR_NAME: &str = "berd-serve";
const PROCESS_RECORD_EXTENSION: &str = "json";

#[derive(Debug, Deserialize, Serialize)]
struct ServeProcessRecord {
    owner_pid: u32,
    serve_pid: u32,
    #[cfg(windows)]
    #[serde(default)]
    owner_identity: Option<ProcessIdentity>,
    #[cfg(windows)]
    #[serde(default)]
    serve_identity: Option<ProcessIdentity>,
}

fn process_record_path(dir: &Path) -> PathBuf {
    let exe = std::env::current_exe().unwrap_or_default();
    let exe_hash = fnv1a(exe.to_string_lossy().as_bytes());
    dir.join(format!(
        "{}-{exe_hash:016x}.{PROCESS_RECORD_EXTENSION}",
        std::process::id()
    ))
}

/// Legacy single-slot PID file used before per-owner process records. It is
/// unsafe when multiple dev worktrees share the same Tauri executable path, so
/// new launches remove it without killing the recorded process.
fn legacy_pid_file_path() -> PathBuf {
    let exe = std::env::current_exe().unwrap_or_default();
    let hash = fnv1a(exe.to_string_lossy().as_bytes());
    std::env::temp_dir().join(format!("berd-serve-{hash:016x}.pid"))
}

/// FNV-1a hash — deterministic across runs (unlike `DefaultHasher`).
fn fnv1a(bytes: &[u8]) -> u64 {
    const BASIS: u64 = 0xcbf29ce484222325;
    const PRIME: u64 = 0x00000100000001B3;
    let mut hash = BASIS;
    for &b in bytes {
        hash ^= b as u64;
        hash = hash.wrapping_mul(PRIME);
    }
    hash
}

#[cfg(unix)]
fn write_pid_file(dir: &Path, serve_pid: u32) {
    if let Err(error) = std::fs::create_dir_all(dir) {
        log::warn!(
            "Failed to create goose serve process record dir {}: {error}",
            dir.display()
        );
        return;
    }

    let path = process_record_path(dir);
    let record = ServeProcessRecord {
        owner_pid: std::process::id(),
        serve_pid,
    };
    match std::fs::File::create(&path) {
        Ok(mut file) => {
            if let Err(error) = serde_json::to_writer(&mut file, &record) {
                log::warn!(
                    "Failed to write goose serve process record {}: {error}",
                    path.display()
                );
            }
            if let Err(error) = file.write_all(b"\n") {
                log::warn!(
                    "Failed to finish goose serve process record {}: {error}",
                    path.display()
                );
            }
        }
        Err(error) => {
            log::warn!(
                "Failed to create goose serve process record {}: {error}",
                path.display()
            );
        }
    }
}

#[cfg(windows)]
fn write_process_record(dir: &Path, child: &Child) -> Result<(), String> {
    let handle = child
        .raw_handle()
        .ok_or_else(|| "child has no process handle".to_string())?;
    let owner_identity = crate::services::process::capture_process_identity(std::process::id())
        .map_err(|error| format!("failed to identify owner: {error}"))?;
    // SAFETY: Tokio owns this process handle for the lifetime of `child`.
    let serve_identity = unsafe { crate::services::process::process_identity_from_handle(handle) }
        .map_err(|error| format!("failed to identify child: {error}"))?;
    std::fs::create_dir_all(dir).map_err(|error| {
        format!(
            "failed to create process record dir {}: {error}",
            dir.display()
        )
    })?;
    let path = process_record_path(dir);
    let record = ServeProcessRecord {
        owner_pid: owner_identity.pid,
        serve_pid: serve_identity.pid,
        owner_identity: Some(owner_identity),
        serve_identity: Some(serve_identity),
    };
    let serialized = serde_json::to_vec(&record).map_err(|error| {
        format!(
            "failed to serialize process record {}: {error}",
            path.display()
        )
    })?;
    let temp_path = path.with_extension(format!("{PROCESS_RECORD_EXTENSION}.tmp"));
    let _ = std::fs::remove_file(&temp_path);
    let write_result = (|| {
        let mut file = std::fs::File::create(&temp_path).map_err(|error| {
            format!(
                "failed to create temporary process record {}: {error}",
                temp_path.display()
            )
        })?;
        file.write_all(&serialized).map_err(|error| {
            format!(
                "failed to write temporary process record {}: {error}",
                temp_path.display()
            )
        })?;
        file.write_all(b"\n").map_err(|error| {
            format!(
                "failed to finish temporary process record {}: {error}",
                temp_path.display()
            )
        })?;
        file.sync_all().map_err(|error| {
            format!(
                "failed to sync temporary process record {}: {error}",
                temp_path.display()
            )
        })?;
        std::fs::rename(&temp_path, &path).map_err(|error| {
            format!(
                "failed to publish process record {}: {error}",
                path.display()
            )
        })
    })();
    if write_result.is_err() {
        let _ = std::fs::remove_file(&temp_path);
    }
    write_result
}

/// Scan records left by previous runs and kill only true orphans: backend
/// processes whose owning Tauri process is no longer alive. All errors are
/// logged and swallowed so startup is never blocked.
async fn kill_stale_serve_process(dir: &Path) {
    remove_legacy_pid_file();

    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return,
        Err(error) => {
            log::warn!(
                "Failed to read goose serve process record dir {}: {error}",
                dir.display()
            );
            return;
        }
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if !is_process_record_path(&path) {
            continue;
        }
        cleanup_process_record(&path).await;
    }
}

fn remove_legacy_pid_file() {
    let path = legacy_pid_file_path();
    if !path.exists() {
        return;
    }

    log::info!(
        "Removing legacy goose serve PID file {} without killing its recorded process",
        path.display()
    );
    let _ = std::fs::remove_file(path);
}

fn is_process_record_path(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension == PROCESS_RECORD_EXTENSION)
}

async fn cleanup_process_record(path: &Path) {
    let record = match read_process_record(path) {
        Ok(record) => record,
        Err(error) => {
            log::warn!(
                "Failed to read goose serve process record {}: {error}; removing",
                path.display()
            );
            let _ = std::fs::remove_file(path);
            return;
        }
    };

    #[cfg(windows)]
    if let Some(owner_identity) = &record.owner_identity {
        match crate::services::process::probe_process_identity(owner_identity) {
            IdentityProbe::Matches => {
                log::debug!(
                    "Goose serve process record {} is still owned by live process {}; leaving it alone",
                    path.display(),
                    record.owner_pid
                );
                return;
            }
            IdentityProbe::Unverifiable => {
                log::warn!(
                    "Cannot verify owner of goose serve process record {}; keeping it",
                    path.display()
                );
                return;
            }
            IdentityProbe::Gone | IdentityProbe::Mismatch => {
                cleanup_orphaned_serve_process(path, &record).await;
                return;
            }
        }
    }

    let Some(owner_pid) = pid_t_from_u32(record.owner_pid) else {
        log::warn!(
            "Goose serve process record {} has invalid owner pid {}; removing",
            path.display(),
            record.owner_pid
        );
        let _ = std::fs::remove_file(path);
        return;
    };

    if process_is_alive(owner_pid) {
        log::debug!(
            "Goose serve process record {} is still owned by live process {}; leaving it alone",
            path.display(),
            record.owner_pid
        );
        return;
    }

    #[cfg(unix)]
    let Some(serve_pid) = pid_t_from_u32(record.serve_pid) else {
        log::warn!(
            "Goose serve process record {} has invalid serve pid {}; removing",
            path.display(),
            record.serve_pid
        );
        let _ = std::fs::remove_file(path);
        return;
    };

    #[cfg(unix)]
    cleanup_orphaned_serve_process(path, serve_pid).await;
    #[cfg(windows)]
    cleanup_orphaned_serve_process(path, &record).await;
}

fn read_process_record(path: &Path) -> Result<ServeProcessRecord, String> {
    let contents = std::fs::read_to_string(path).map_err(|error| error.to_string())?;
    serde_json::from_str(&contents).map_err(|error| error.to_string())
}

#[cfg(windows)]
async fn cleanup_orphaned_serve_process(path: &Path, record: &ServeProcessRecord) {
    let Some(identity) = &record.serve_identity else {
        log::warn!(
            "Goose serve process record {} has no Windows process identity; removing without killing PID {}",
            path.display(),
            record.serve_pid
        );
        let _ = std::fs::remove_file(path);
        return;
    };
    let identity = identity.clone();

    log::info!(
        "Killing orphaned goose serve process (pid {})",
        identity.pid
    );
    diagnostic_log::record_event(
        DiagnosticLevel::Warn,
        DiagnosticCategory::GooseServe,
        "stale_process_kill",
        None,
        diagnostic_log::fields([("pid", (identity.pid as i64).into())]),
    );
    match crate::services::process::kill_process_if_identity_matches(
        &identity,
        Duration::from_secs(5),
    ) {
        Ok(outcome) if outcome.exit_confirmed() => {
            let _ = std::fs::remove_file(path);
        }
        Ok(_) => log::warn!(
            "Goose serve process {} did not confirm exit; keeping process record {}",
            identity.pid,
            path.display()
        ),
        Err(error) => log::warn!(
            "Failed to kill orphaned goose serve process {}: {error}; keeping process record {}",
            identity.pid,
            path.display()
        ),
    }
}

#[cfg(unix)]
async fn cleanup_orphaned_serve_process(path: &Path, pid: ProcessId) {
    if !process_is_alive(pid) {
        log::info!(
            "Previous goose serve (pid {pid}) is no longer running, removing process record {}",
            path.display()
        );
        let _ = std::fs::remove_file(path);
        return;
    }

    // Guard against PID recycling: verify the process is actually a goose binary.
    if !is_goose_process(pid) {
        log::warn!(
            "PID {pid} is alive but is not a goose process (PID was likely recycled), removing process record {}",
            path.display()
        );
        let _ = std::fs::remove_file(path);
        return;
    }

    log::info!("Killing orphaned goose serve process (pid {pid})");
    diagnostic_log::record_event(
        DiagnosticLevel::Warn,
        DiagnosticCategory::GooseServe,
        "stale_process_kill",
        None,
        diagnostic_log::fields([("pid", (pid as i64).into())]),
    );
    terminate_process(pid);

    // Give it a moment to exit, then force-kill if still alive.
    tokio::time::sleep(Duration::from_millis(200)).await;
    if process_is_alive(pid) {
        log::warn!("Orphaned goose serve (pid {pid}) did not exit after SIGTERM, sending SIGKILL");
        diagnostic_log::record_event(
            DiagnosticLevel::Warn,
            DiagnosticCategory::GooseServe,
            "stale_process_kill_forced",
            None,
            diagnostic_log::fields([("pid", (pid as i64).into())]),
        );
        kill_process(pid);
    }

    let _ = std::fs::remove_file(path);
}

#[cfg(unix)]
/// Check whether the given PID belongs to a goose binary. Uses
/// `proc_pidpath` on macOS and `/proc/{pid}/exe` on Linux.
fn is_goose_process(pid: ProcessId) -> bool {
    if let Some(name) = process_executable_name(pid) {
        name.contains("goose")
    } else {
        // If we can't determine the process name, err on the side of caution
        // and assume it is NOT a goose process to avoid killing an unrelated PID.
        false
    }
}

#[cfg(target_os = "macos")]
fn process_executable_name(pid: ProcessId) -> Option<String> {
    let mut buf = vec![0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
    // SAFETY: buf is large enough for the maximum path length.
    let len =
        unsafe { libc::proc_pidpath(pid, buf.as_mut_ptr() as *mut libc::c_void, buf.len() as u32) };
    if len <= 0 {
        return None;
    }
    let path = std::str::from_utf8(&buf[..len as usize]).ok()?;
    path.rsplit('/').next().map(String::from)
}

#[cfg(all(unix, not(target_os = "macos")))]
fn process_executable_name(pid: ProcessId) -> Option<String> {
    let exe_link = format!("/proc/{pid}/exe");
    let path = std::fs::read_link(exe_link).ok()?;
    path.file_name()?.to_str().map(String::from)
}

/// Paths resolved by `resolve_berdctl_spawn_paths`, consumed by
/// `apply_berdctl_env` after PATH assembly.
#[cfg(feature = "berdctl")]
struct BerdctlSpawnPaths {
    berdctl_bin: Option<PathBuf>,
    app_data_dir: Option<PathBuf>,
}

/// Resolve the bundled berdctl CLI and the app data dir before PATH
/// assembly: the shim dir only goes on PATH when the shim was actually
/// created, and the same resolved paths feed `apply_berdctl_env` after
/// the shell-env copy.
#[cfg(feature = "berdctl")]
fn resolve_berdctl_spawn_paths(
    app_handle: &tauri::AppHandle,
    prepend_dirs: &mut Vec<PathBuf>,
) -> BerdctlSpawnPaths {
    let berdctl_bin = resolve_berdctl_bin();
    let berd_monitor_bin = resolve_berd_monitor_bin();
    let app_data_dir = match app_handle.path().app_data_dir() {
        Ok(app_data_dir) => Some(app_data_dir),
        Err(error) => {
            log::warn!(
                "Skipping berdctl PATH shim and BERDCTL_LOCK: failed to resolve app data dir: {error}"
            );
            None
        }
    };
    if let Some(app_data_dir) = app_data_dir.as_deref() {
        let shim_dir = app_data_dir.join("bin");
        let mut installed_any = false;
        if let Some(cli_path) = berdctl_bin.as_deref() {
            match create_berdctl_shim(&shim_dir, cli_path) {
                Ok(()) => installed_any = true,
                Err(error) => log::warn!("Skipping berdctl PATH shim: {error}"),
            }
        }
        if let Some(cli_path) = berd_monitor_bin.as_deref() {
            match create_berd_monitor_shim(&shim_dir, cli_path) {
                Ok(()) => installed_any = true,
                Err(error) => log::warn!("Skipping berd-monitor PATH shim: {error}"),
            }
        }
        if installed_any {
            // After the distro bin dir so that dir keeps its pinned
            // PATH-front position.
            prepend_dirs.push(shim_dir);
        }
    }
    BerdctlSpawnPaths {
        berdctl_bin,
        app_data_dir,
    }
}

/// Point goosed — and the harness children that inherit its environment — at
/// this app instance's berdctl discovery file and the bundled berdctl
/// CLI. Both values are static paths knowable before the broker exists; the
/// broker starts lazily and writes the discovery file itself. A `None`
/// app_data_dir (the caller already warned about it) skips
/// BERDCTL_LOCK.
#[cfg(feature = "berdctl")]
fn apply_berdctl_env(
    command: &mut Command,
    app_data_dir: Option<&Path>,
    berdctl_bin: Option<&Path>,
) {
    if let Some(app_data_dir) = app_data_dir {
        command.env(
            "BERDCTL_LOCK",
            tauri_plugin_berdctl::discovery_file_path(app_data_dir, std::process::id()),
        );
    }

    if let Some(berdctl_bin) = berdctl_bin {
        command.env("BERDCTL_BIN", berdctl_bin);
    } else {
        log::warn!("Skipping BERDCTL_BIN: could not resolve the berdctl binary path");
    }
}

/// Create or refresh the PATH shim that lets harness children run a bare
/// `berdctl`.
///
/// Unix uses a `berdctl` symlink so the signed bundled binary and updates stay
/// authoritative. Windows uses a `berdctl.cmd` wrapper because creating
/// symlinks is not reliably available in non-admin developer shells, and
/// replacing an in-use copied `.exe` can fail.
#[cfg(feature = "berdctl")]
fn create_berdctl_shim(shim_dir: &Path, cli_path: &Path) -> Result<(), String> {
    create_cli_shim(shim_dir, cli_path, berdctl_shim_name())
}

#[cfg(feature = "berdctl")]
fn create_berd_monitor_shim(shim_dir: &Path, cli_path: &Path) -> Result<(), String> {
    create_cli_shim(shim_dir, cli_path, berd_monitor_shim_name())
}

#[cfg(feature = "berdctl")]
fn create_cli_shim(shim_dir: &Path, cli_path: &Path, shim_name: &str) -> Result<(), String> {
    if !cli_path.exists() {
        return Err(format!(
            "agent CLI binary not found at {}",
            cli_path.display()
        ));
    }

    std::fs::create_dir_all(shim_dir)
        .map_err(|error| format!("failed to create {}: {error}", shim_dir.display()))?;

    let link = shim_dir.join(shim_name);
    // `remove_file` deletes a symlink itself rather than its target.
    match std::fs::remove_file(&link) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(format!(
                "failed to remove stale shim {}: {error}",
                link.display()
            ));
        }
    }
    create_cli_shim_file(cli_path, &link)
}

/// Mirrors `get_goose_command`: explicit env override (exported by `just
/// dev`, where externalBin is empty) wins; otherwise the externalBin sidecar
/// sits next to the app executable.
#[cfg(feature = "berdctl")]
fn resolve_berdctl_bin() -> Option<PathBuf> {
    if let Ok(override_path) = std::env::var("BERDCTL_BIN") {
        if !override_path.is_empty() {
            return Some(PathBuf::from(override_path));
        }
    }

    let exe = std::env::current_exe().ok()?;
    Some(exe.parent()?.join(berdctl_binary_name()))
}

#[cfg(feature = "berdctl")]
fn resolve_berd_monitor_bin() -> Option<PathBuf> {
    if let Ok(override_path) = std::env::var("BERD_MONITOR_BIN") {
        if !override_path.is_empty() {
            return Some(PathBuf::from(override_path));
        }
    }

    let exe = std::env::current_exe().ok()?;
    Some(exe.parent()?.join(berd_monitor_binary_name()))
}

#[cfg(feature = "berdctl")]
fn berdctl_binary_name() -> &'static str {
    if cfg!(windows) {
        "berdctl.exe"
    } else {
        "berdctl"
    }
}

#[cfg(feature = "berdctl")]
fn berd_monitor_binary_name() -> &'static str {
    if cfg!(windows) {
        "berd-monitor.exe"
    } else {
        "berd-monitor"
    }
}

#[cfg(feature = "berdctl")]
fn berdctl_shim_name() -> &'static str {
    if cfg!(windows) {
        "berdctl.cmd"
    } else {
        berdctl_binary_name()
    }
}

#[cfg(feature = "berdctl")]
fn berd_monitor_shim_name() -> &'static str {
    if cfg!(windows) {
        "berd-monitor.cmd"
    } else {
        berd_monitor_binary_name()
    }
}

#[cfg(all(feature = "berdctl", unix))]
fn create_cli_shim_file(cli_path: &Path, link: &Path) -> Result<(), String> {
    std::os::unix::fs::symlink(cli_path, link).map_err(|error| {
        format!(
            "failed to symlink {} -> {}: {error}",
            link.display(),
            cli_path.display()
        )
    })
}

#[cfg(all(feature = "berdctl", windows))]
fn create_cli_shim_file(cli_path: &Path, link: &Path) -> Result<(), String> {
    let content = format!("@echo off\r\n\"{}\" %*\r\n", cli_path.to_string_lossy());
    std::fs::write(link, content).map_err(|error| {
        format!(
            "failed to write {} wrapper for {}: {error}",
            link.display(),
            cli_path.display(),
        )
    })
}

pub fn get_goose_command(app_handle: &tauri::AppHandle) -> Result<Command, String> {
    if let Ok(override_path) = std::env::var("GOOSE_BIN") {
        Ok(Command::new(override_path))
    } else {
        let tauri_command = app_handle
            .shell()
            .sidecar("goosed")
            .map_err(|e| format!("could not resolve goose binary: {e}"))?;
        let std_command: std::process::Command = tauri_command.into();
        Ok(std_command.into())
    }
}

async fn wait_for_server_ready(port: u16, child: &mut Child) -> Result<(), String> {
    let deadline = Instant::now() + GOOSE_SERVE_CONNECT_TIMEOUT;
    let addr = format!("{LOCALHOST}:{port}");

    loop {
        match tokio::net::TcpStream::connect(&addr).await {
            Ok(_) => return Ok(()),
            Err(_) => {
                if let Some(status) = child
                    .try_wait()
                    .map_err(|e| format!("Failed to poll goose serve process: {e}"))?
                {
                    return Err(format!(
                        "Goose serve exited before becoming ready: {status}"
                    ));
                }

                if Instant::now() >= deadline {
                    return Err(format!("Timed out waiting for goose serve on port {port}"));
                }

                tokio::time::sleep(GOOSE_SERVE_CONNECT_RETRY_DELAY).await;
            }
        }
    }
}

fn optional_u32_value(value: Option<u32>) -> DiagnosticFieldValue {
    value.map(Into::into).unwrap_or(DiagnosticFieldValue::Null)
}

fn default_serve_working_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("/tmp"))
}

/// Copy the captured shell environment onto `command`, overriding `PATH`
/// with `path_env::build_extended_path_with_prepended_dirs` so
/// node-version-manager shims are visible to the goosed sidecar. Any
/// `prepend_dirs` are placed
/// at the front of the resulting PATH. All PATH manipulation for the
/// goosed command flows through this sink, so callers must not read
/// `shell_env["PATH"]` separately or set PATH on `command` directly —
/// doing so would bypass the extended-path logic.
fn apply_shell_env_with_extended_path(
    command: &mut Command,
    shell_env: &HashMap<String, String>,
    prepend_dirs: &[PathBuf],
) {
    apply_shell_env_with_extended_path_inner(
        command,
        shell_env,
        prepend_dirs,
        local_byo_key_providers_enabled(),
    );
}

fn apply_shell_env_with_extended_path_inner(
    command: &mut Command,
    shell_env: &HashMap<String, String>,
    prepend_dirs: &[PathBuf],
    strip_databricks_host: bool,
) {
    let extended_path = path_env::build_extended_path_with_prepended_dirs(
        env_key::get(shell_env, "PATH"),
        prepend_dirs,
    );

    if strip_databricks_host {
        command.env_remove(DATABRICKS_HOST_ENV);
    }

    for (key, value) in shell_env {
        if env_key::matches(key, "PATH") {
            continue;
        }
        if strip_databricks_host && env_key::matches(key, DATABRICKS_HOST_ENV) {
            continue;
        }
        command.env(key, value);
    }

    command.env("PATH", extended_path);
}

fn apply_goose_search_paths_env(
    command: &mut Command,
    shell_env: &HashMap<String, String>,
    prepend_dirs: &[PathBuf],
) {
    let mut search_paths: Vec<String> = prepend_dirs
        .iter()
        .map(|path| path.to_string_lossy().to_string())
        .collect();

    if let Some(existing_search_paths) = shell_env.get(GOOSE_SEARCH_PATHS_ENV) {
        match parse_goose_search_paths_env(existing_search_paths) {
            Ok(paths) => search_paths.extend(paths),
            Err(error) => log::warn!("Ignoring invalid {GOOSE_SEARCH_PATHS_ENV}: {error}"),
        }
    }

    if search_paths.is_empty() {
        return;
    }

    let value = serde_json::to_string(&search_paths)
        .expect("serializing Goose search path strings should not fail");
    command.env(GOOSE_SEARCH_PATHS_ENV, value);
}

fn parse_goose_search_paths_env(value: &str) -> Result<Vec<String>, serde_json::Error> {
    if value.trim().is_empty() {
        return Ok(Vec::new());
    }
    serde_json::from_str(value)
}

fn apply_additional_config_files_env(
    command: &mut Command,
    shell_env: &HashMap<String, String>,
    config_path: &std::path::Path,
) {
    let process_value = std::env::var_os(goose_config::ADDITIONAL_CONFIG_FILES_ENV);
    let config_files = goose_config::additional_config_files_from_values(
        process_value.as_deref(),
        shell_env
            .get(goose_config::ADDITIONAL_CONFIG_FILES_ENV)
            .map(std::ffi::OsStr::new),
        Some(config_path),
    );

    command.env(
        goose_config::ADDITIONAL_CONFIG_FILES_ENV,
        goose_config::join_additional_config_files(&config_files.paths),
    );
}

async fn runtime_config_for_spawn(app_handle: &tauri::AppHandle) -> Result<RuntimeConfig, String> {
    let runtime_config_state = app_handle
        .try_state::<RuntimeConfigState>()
        .ok_or_else(|| "RuntimeConfigState is not registered".to_string())?;
    let distro_state = app_handle
        .try_state::<DistroBundleState>()
        .ok_or_else(|| "DistroBundleState is not registered".to_string())?;
    runtime_config_state
        .ready_config(distro_state.inner())
        .await
}

fn apply_runtime_goose_provider_env(command: &mut Command, runtime_config: &RuntimeConfig) {
    for provider in &runtime_config.goose.model_providers {
        if let Some(endpoint_env) = &provider.endpoint_env {
            for (key, value) in endpoint_env {
                log::info!("setting goose runtime provider env {key}");
                command.env(key, value);
            }
        }
        // Redirect Goose's lightweight "fast" tasks (session naming, context
        // compaction/summarization, tool-call titles, orchestrator sub-calls)
        // onto the provider's declared fast model instead of reusing the heavy
        // main model. `GOOSE_FAST_MODEL` is the highest-priority source in
        // Goose's fast-model resolution. Stock berd defaults declare no
        // fastModelId (a distribution injects one at release time), and BYO-key
        // dev clears the field along with the databricks endpoint, so those
        // sessions export nothing here.
        if let Some(fast_model_id) = &provider.fast_model_id {
            log::info!("setting goose fast model env for provider {}", provider.id);
            command.env(GOOSE_FAST_MODEL_ENV, fast_model_id);
        }
    }
}

fn reserve_free_port() -> Result<u16, String> {
    let listener = std::net::TcpListener::bind((LOCALHOST, 0))
        .map_err(|error| format!("Failed to reserve Goose serve port: {error}"))?;
    listener
        .local_addr()
        .map(|address| address.port())
        .map_err(|error| format!("Failed to resolve reserved Goose serve port: {error}"))
}

#[cfg(test)]
mod tests {
    use super::{
        acp_websocket_url, add_release_webview_origin_arg, apply_goose_search_paths_env,
        apply_runtime_goose_provider_env, apply_shell_env_with_extended_path,
        apply_shell_env_with_extended_path_inner, DATABRICKS_HOST_ENV, TAURI_WEBVIEW_ORIGIN,
    };
    use crate::commands::runtime_config::default_runtime_config;
    use std::collections::HashMap;
    use std::ffi::OsString;
    use std::path::{Path, PathBuf};
    use tokio::process::Command;

    fn env_value(command: &Command, key: &str) -> Option<OsString> {
        command.as_std().get_envs().find_map(|(k, v)| {
            if k == key {
                v.map(|value| value.to_os_string())
            } else {
                None
            }
        })
    }

    #[test]
    fn acp_websocket_url_includes_secret_key_token() {
        assert_eq!(
            acp_websocket_url(12345, "berd/secret"),
            "ws://127.0.0.1:12345/acp?token=berd%2Fsecret"
        );
    }

    #[test]
    fn release_build_allows_platform_tauri_webview_origin_for_acp_websocket() {
        let mut command = Command::new("goose");

        add_release_webview_origin_arg(&mut command);

        let args: Vec<_> = command
            .as_std()
            .get_args()
            .map(|arg| arg.to_string_lossy().to_string())
            .collect();
        if cfg!(debug_assertions) {
            assert!(args.is_empty());
        } else {
            assert_eq!(args, ["--allowed-origin", TAURI_WEBVIEW_ORIGIN]);
        }
    }

    // Verifies the two pieces of behavior that are unique to
    // `apply_shell_env_with_extended_path` — extended-path coverage itself is
    // exercised by `path_env::tests`.
    #[test]
    fn apply_shell_env_routes_path_through_extended_path_and_forwards_other_vars() {
        let mut command = Command::new("goose");
        let mut shell_env = HashMap::new();
        shell_env.insert("PATH".to_string(), "/shell/bin".to_string());
        shell_env.insert("LANG".to_string(), "en_US.UTF-8".to_string());

        apply_shell_env_with_extended_path(&mut command, &shell_env, &[]);

        // PATH was routed through `build_extended_path_from_path`: the shell
        // PATH entry survives and at least one tool-manager shim was appended.
        let path = env_value(&command, "PATH").expect("PATH should be set");
        let paths: Vec<_> = std::env::split_paths(&path).collect();
        assert!(paths.iter().any(|p| p == Path::new("/shell/bin")));
        // Tool-manager shim dirs are platform-specific: Unix appends them,
        // Windows deliberately does not (see `path_env::push_tool_manager_dirs`).
        // Windows PATH-extension coverage lives in the `#[cfg(windows)]` tests.
        #[cfg(not(windows))]
        assert!(paths.iter().any(|p| p.ends_with(".asdf/shims")));

        // Non-PATH variables are forwarded verbatim.
        assert_eq!(
            env_value(&command, "LANG"),
            Some(OsString::from("en_US.UTF-8"))
        );
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn windows_goosed_child_resolves_cmd_tools_via_pathext_with_spaces() {
        let temp = tempfile::tempdir().expect("temp dir");
        let tools = temp.path().join("Managed Tools With Spaces");
        std::fs::create_dir_all(&tools).expect("tool dir");
        std::fs::write(tools.join("goosed.CMD"), "@echo off\r\necho goosed\r\n")
            .expect("goosed CMD");
        std::fs::write(
            tools.join("berd-tool.cmd"),
            "@echo off\r\necho berd-tool\r\n",
        )
        .expect("tool CMD");
        let inherited = std::env::join_paths([
            PathBuf::from(std::env::var_os("SystemRoot").expect("SystemRoot")).join("System32"),
            tools.clone(),
        ])
        .expect("join inherited path")
        .to_string_lossy()
        .into_owned();
        let differently_cased_tools = PathBuf::from(tools.to_string_lossy().to_ascii_uppercase());
        let shell_env = HashMap::from([
            ("Path".to_string(), inherited),
            ("Pathext".to_string(), ".CMD;.EXE".to_string()),
        ]);
        let mut command = Command::new("cmd.exe");
        command.args(["/d", "/c", "goosed && berd-tool"]);

        apply_shell_env_with_extended_path(
            &mut command,
            &shell_env,
            &[tools.clone(), differently_cased_tools],
        );
        let path = env_value(&command, "PATH").expect("PATH");
        assert_eq!(
            std::env::split_paths(&path)
                .filter(|entry| entry
                    .to_string_lossy()
                    .eq_ignore_ascii_case(&tools.to_string_lossy()))
                .count(),
            1,
            "case-insensitive duplicate tool directories must collapse"
        );
        let output = command.output().await.expect("run cmd tool discovery");

        assert!(
            output.status.success(),
            "cmd tool discovery failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let stdout = String::from_utf8_lossy(&output.stdout);
        assert!(stdout.contains("goosed"));
        assert!(stdout.contains("berd-tool"));
    }

    #[cfg(windows)]
    #[test]
    fn windows_goosed_env_uses_extended_inherited_path_once() {
        let prepended = PathBuf::from("C:\\Program Files\\Berd\\bin");
        let inherited = std::env::join_paths([PathBuf::from("C:\\Windows\\System32")])
            .expect("join inherited path")
            .to_string_lossy()
            .into_owned();
        let mut command = Command::new("goosed");
        let shell_env = HashMap::from([("Path".to_string(), inherited)]);

        apply_shell_env_with_extended_path(
            &mut command,
            &shell_env,
            std::slice::from_ref(&prepended),
        );

        let logical_paths: Vec<_> = command
            .as_std()
            .get_envs()
            .filter(|(key, value)| {
                value.is_some() && key.to_string_lossy().eq_ignore_ascii_case("PATH")
            })
            .collect();
        assert_eq!(logical_paths.len(), 1);
        let paths: Vec<_> =
            std::env::split_paths(logical_paths[0].1.expect("PATH value")).collect();
        assert_eq!(paths.first(), Some(&prepended));
        assert!(paths.iter().any(|path| path.ends_with("Windows\\System32")));
    }

    #[test]
    fn apply_shell_env_can_strip_databricks_host_for_byo_dev() {
        let mut command = Command::new("goose");
        let mut shell_env = HashMap::new();
        shell_env.insert("PATH".to_string(), "/shell/bin".to_string());
        shell_env.insert(
            DATABRICKS_HOST_ENV.to_string(),
            "https://example.test".to_string(),
        );
        shell_env.insert("LANG".to_string(), "en_US.UTF-8".to_string());

        apply_shell_env_with_extended_path_inner(&mut command, &shell_env, &[], true);

        assert_eq!(env_value(&command, DATABRICKS_HOST_ENV), None);
        assert_eq!(
            env_value(&command, "LANG"),
            Some(OsString::from("en_US.UTF-8"))
        );
        assert!(env_value(&command, "PATH").is_some());
    }

    #[cfg(windows)]
    #[test]
    fn windows_apply_shell_env_strips_mixed_case_databricks_host_for_byo_dev() {
        let mut command = Command::new("goose");
        let shell_env = HashMap::from([(
            "Databricks_Host".to_string(),
            "https://example.test".to_string(),
        )]);

        apply_shell_env_with_extended_path_inner(&mut command, &shell_env, &[], true);

        assert!(!command.as_std().get_envs().any(|(key, value)| {
            key.eq_ignore_ascii_case(DATABRICKS_HOST_ENV) && value.is_some()
        }));
    }

    #[test]
    fn apply_runtime_goose_provider_env_exports_declared_fast_model_alongside_host() {
        let mut command = Command::new("goose");
        let mut config = default_runtime_config();
        let provider = config
            .goose
            .model_providers
            .first_mut()
            .expect("default config has a provider");
        provider.fast_model_id = Some("goose-fast-model".to_string());
        provider.endpoint_env = Some(HashMap::from([(
            DATABRICKS_HOST_ENV.to_string(),
            "https://example.databricks.com".to_string(),
        )]));

        apply_runtime_goose_provider_env(&mut command, &config);

        assert_eq!(
            env_value(&command, "GOOSE_FAST_MODEL"),
            Some(OsString::from("goose-fast-model"))
        );
        // The provider's endpoint env is still forwarded verbatim.
        assert_eq!(
            env_value(&command, DATABRICKS_HOST_ENV),
            Some(OsString::from("https://example.databricks.com"))
        );
    }

    // Stock berd defaults declare no fastModelId (the release-time distribution
    // injector supplies it), so a stock build exports no GOOSE_FAST_MODEL.
    #[test]
    fn apply_runtime_goose_provider_env_exports_no_fast_model_for_default_config() {
        let mut command = Command::new("goose");

        apply_runtime_goose_provider_env(&mut command, &default_runtime_config());

        assert_eq!(env_value(&command, "GOOSE_FAST_MODEL"), None);
        assert_eq!(env_value(&command, DATABRICKS_HOST_ENV), None);
    }

    // BYO-key dev clears the default provider's endpoint and fast model, so
    // neither leaks into those sessions. Stock defaults declare no
    // fastModelId, so set one to mimic a bundled config a distribution injected
    // one into.
    #[cfg(debug_assertions)]
    #[test]
    fn apply_runtime_goose_provider_env_exports_nothing_for_byo_stripped_config() {
        use crate::commands::runtime_config::clear_default_databricks_distribution_config;

        let mut command = Command::new("goose");
        let mut config = default_runtime_config();
        let provider = config
            .goose
            .model_providers
            .first_mut()
            .expect("default config has a provider");
        provider.fast_model_id = Some("goose-fast-model".to_string());
        provider.endpoint_env = Some(HashMap::from([(
            DATABRICKS_HOST_ENV.to_string(),
            "https://example.databricks.com".to_string(),
        )]));
        clear_default_databricks_distribution_config(&mut config);

        apply_runtime_goose_provider_env(&mut command, &config);

        assert_eq!(env_value(&command, DATABRICKS_HOST_ENV), None);
        assert_eq!(env_value(&command, "GOOSE_FAST_MODEL"), None);
    }

    #[test]
    fn apply_shell_env_prepends_extra_dirs_in_front_of_extended_path() {
        let mut command = Command::new("goose");
        let mut shell_env = HashMap::new();
        shell_env.insert("PATH".to_string(), "/shell/bin".to_string());

        apply_shell_env_with_extended_path(
            &mut command,
            &shell_env,
            &[PathBuf::from("/distro/bin")],
        );

        let path = env_value(&command, "PATH").expect("PATH should be set");
        let paths: Vec<_> = std::env::split_paths(&path).collect();
        assert_eq!(
            paths.first().map(|p| p.as_path()),
            Some(Path::new("/distro/bin"))
        );
        assert!(paths.iter().any(|p| p == Path::new("/shell/bin")));
    }

    #[test]
    fn apply_shell_env_prepends_managed_acp_dirs_before_shell_path() {
        let mut command = Command::new("goose");
        let mut shell_env = HashMap::new();
        shell_env.insert("PATH".to_string(), "/shell/bin:/user/bin".to_string());

        apply_shell_env_with_extended_path(
            &mut command,
            &shell_env,
            &[PathBuf::from("/distro/bin"), PathBuf::from("/acp/bin")],
        );

        let path = env_value(&command, "PATH").expect("PATH should be set");
        let paths: Vec<_> = std::env::split_paths(&path).collect();
        assert_eq!(
            paths.first().map(|p| p.as_path()),
            Some(Path::new("/distro/bin"))
        );
        assert_eq!(
            paths.get(1).map(|p| p.as_path()),
            Some(Path::new("/acp/bin"))
        );
        assert_eq!(
            paths.get(2).map(|p| p.as_path()),
            Some(Path::new("/shell/bin"))
        );
        assert_eq!(
            paths.get(3).map(|p| p.as_path()),
            Some(Path::new("/user/bin"))
        );
    }

    #[test]
    fn apply_goose_search_paths_env_sets_managed_dirs_as_json_array() {
        let mut command = Command::new("goose");
        let shell_env = HashMap::new();

        apply_shell_env_with_extended_path(&mut command, &shell_env, &[]);
        apply_goose_search_paths_env(
            &mut command,
            &shell_env,
            &[PathBuf::from("/distro/bin"), PathBuf::from("/acp/bin")],
        );

        let value =
            env_value(&command, "GOOSE_SEARCH_PATHS").expect("GOOSE_SEARCH_PATHS should be set");
        let paths: Vec<String> =
            serde_json::from_str(&value.to_string_lossy()).expect("valid JSON array");
        assert_eq!(paths, vec!["/distro/bin", "/acp/bin"]);
    }

    #[test]
    fn apply_goose_search_paths_env_appends_existing_goose_dirs_without_shell_path() {
        let mut command = Command::new("goose");
        let mut shell_env = HashMap::new();
        shell_env.insert("PATH".to_string(), "/shell/bin:/user/bin".to_string());
        shell_env.insert(
            "GOOSE_SEARCH_PATHS".to_string(),
            "[\"/custom/goose/bin\"]".to_string(),
        );

        apply_shell_env_with_extended_path(&mut command, &shell_env, &[]);
        apply_goose_search_paths_env(
            &mut command,
            &shell_env,
            &[PathBuf::from("/distro/bin"), PathBuf::from("/acp/bin")],
        );

        let value =
            env_value(&command, "GOOSE_SEARCH_PATHS").expect("GOOSE_SEARCH_PATHS should be set");
        let paths: Vec<String> =
            serde_json::from_str(&value.to_string_lossy()).expect("valid JSON array");
        assert_eq!(paths, vec!["/distro/bin", "/acp/bin", "/custom/goose/bin"]);
        assert!(!paths.iter().any(|path| path == "/shell/bin"));
        assert!(!paths.iter().any(|path| path == "/user/bin"));
    }

    // The distro bin dir keeps the PATH-front position; the berdctl shim
    // dir follows it, and both precede the login-shell PATH.
    #[test]
    fn apply_shell_env_keeps_distro_bin_first_with_shim_dir_second() {
        let mut command = Command::new("goose");
        let mut shell_env = HashMap::new();
        shell_env.insert("PATH".to_string(), "/shell/bin".to_string());

        apply_shell_env_with_extended_path(
            &mut command,
            &shell_env,
            &[PathBuf::from("/distro/bin"), PathBuf::from("/app-data/bin")],
        );

        let path = env_value(&command, "PATH").expect("PATH should be set");
        let paths: Vec<_> = std::env::split_paths(&path).collect();
        assert_eq!(
            paths.first().map(|p| p.as_path()),
            Some(Path::new("/distro/bin"))
        );
        assert_eq!(
            paths.get(1).map(|p| p.as_path()),
            Some(Path::new("/app-data/bin"))
        );
        assert!(paths.iter().any(|p| p == Path::new("/shell/bin")));
    }

    #[cfg(feature = "berdctl")]
    mod berdctl_shim {
        use super::super::create_berdctl_shim;
        use std::path::Path;

        fn write_fake_cli(dir: &Path, name: &str) -> std::path::PathBuf {
            let path = dir.join(name);
            std::fs::write(&path, "#!/bin/sh\n").expect("write fake cli");
            path
        }

        #[cfg(unix)]
        #[test]
        fn shim_symlink_points_at_resolved_cli_path() {
            let temp = tempfile::tempdir().expect("temp dir");
            let cli_path = write_fake_cli(temp.path(), "berdctl");
            let shim_dir = temp.path().join("bin");

            create_berdctl_shim(&shim_dir, &cli_path).expect("shim creation should succeed");

            let link = shim_dir.join("berdctl");
            assert!(link.symlink_metadata().expect("shim exists").is_symlink());
            assert_eq!(std::fs::read_link(&link).expect("read link"), cli_path);
        }

        #[cfg(unix)]
        #[test]
        fn shim_symlink_is_refreshed_when_target_path_changes() {
            let temp = tempfile::tempdir().expect("temp dir");
            let shim_dir = temp.path().join("bin");
            let old_cli = write_fake_cli(temp.path(), "berdctl-old");
            let new_cli = write_fake_cli(temp.path(), "berdctl-new");

            create_berdctl_shim(&shim_dir, &old_cli).expect("first shim creation");
            create_berdctl_shim(&shim_dir, &new_cli).expect("shim refresh");

            let link = shim_dir.join("berdctl");
            assert_eq!(std::fs::read_link(&link).expect("read link"), new_cli);
        }

        #[test]
        fn shim_creation_fails_when_cli_path_is_missing() {
            let temp = tempfile::tempdir().expect("temp dir");
            let shim_dir = temp.path().join("bin");

            let result = create_berdctl_shim(&shim_dir, &temp.path().join("missing"));

            assert!(result.is_err());
            assert!(!shim_dir.exists());
        }

        #[cfg(windows)]
        #[test]
        fn shim_cmd_wrapper_points_at_resolved_cli_path() {
            let temp = tempfile::tempdir().expect("temp dir");
            let cli_path = write_fake_cli(temp.path(), "berdctl.exe");
            let shim_dir = temp.path().join("bin");

            create_berdctl_shim(&shim_dir, &cli_path).expect("shim creation should succeed");

            let link = shim_dir.join("berdctl.cmd");
            assert!(link.is_file());
            let wrapper = std::fs::read_to_string(&link).expect("read shim");
            assert!(wrapper.contains(&format!("\"{}\" %*", cli_path.to_string_lossy())));
        }
    }
}
