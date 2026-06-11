use tauri::Manager;
use tauri_plugin_shell::ShellExt;

use std::collections::HashMap;
use std::ffi::OsString;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::services::diagnostic_log::{
    self, DiagnosticCategory, DiagnosticFieldValue, DiagnosticLevel,
};
use crate::services::distro_bundle::DistroBundleState;
use crate::services::goose_config;
use crate::services::log_redaction::redact_log_line;
use crate::services::path_env;
use crate::services::shell_env;

use tokio::io::{AsyncBufReadExt, AsyncRead, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::OnceCell;

const GOOSE_SERVE_CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
const GOOSE_SERVE_CONNECT_RETRY_DELAY: Duration = Duration::from_millis(100);
const DATABRICKS_HOST_ENV: &str = "DATABRICKS_HOST";
const DEFAULT_DATABRICKS_HOST: &str = "https://block-lakehouse-production.cloud.databricks.com";
const LOCALHOST: &str = "127.0.0.1";

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
        if let Some(pid) = self._child.id() {
            log::info!("Killing goose serve child (pid {pid})");
            // SAFETY: sending SIGTERM to a known child process.
            unsafe {
                libc::kill(pid as libc::pid_t, libc::SIGTERM);
            }
        }
        // Clean up this app instance's stale-process record.
        let _ = std::fs::remove_file(process_record_path());
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
        kill_stale_serve_process().await;

        let port = reserve_free_port()?;
        let secret_key = format!("goose-internal-{}", uuid::Uuid::new_v4().simple());

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
        let shell_env = shell_env::capture_shell_env().await;
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

        apply_shell_env_with_extended_path(&mut command, &shell_env, &prepend_dirs);
        if let Some(config_path) = distro_config_path.as_deref() {
            apply_additional_config_files_env(&mut command, &shell_env, config_path);
        }
        set_databricks_host_env(&mut command);

        command
            .arg("serve")
            .arg("--host")
            .arg(LOCALHOST)
            .arg("--port")
            .arg(port.to_string())
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

        if let Some(pid) = pid {
            write_pid_file(pid);
        }

        Ok(GooseServeProcess {
            port,
            secret_key,
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

const PROCESS_RECORD_DIR_NAME: &str = "goose-internal-serve";
const PROCESS_RECORD_EXTENSION: &str = "json";

#[derive(Debug, Deserialize, Serialize)]
struct ServeProcessRecord {
    owner_pid: u32,
    serve_pid: u32,
}

fn process_record_dir() -> PathBuf {
    std::env::temp_dir().join(PROCESS_RECORD_DIR_NAME)
}

fn process_record_path() -> PathBuf {
    let exe = std::env::current_exe().unwrap_or_default();
    let exe_hash = fnv1a(exe.to_string_lossy().as_bytes());
    process_record_dir().join(format!(
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
    std::env::temp_dir().join(format!("goose-internal-serve-{hash:016x}.pid"))
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

fn write_pid_file(serve_pid: u32) {
    let dir = process_record_dir();
    if let Err(error) = std::fs::create_dir_all(&dir) {
        log::warn!(
            "Failed to create goose serve process record dir {}: {error}",
            dir.display()
        );
        return;
    }

    let path = process_record_path();
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

/// Scan records left by previous runs and kill only true orphans: backend
/// processes whose owning Tauri process is no longer alive. All errors are
/// logged and swallowed so startup is never blocked.
async fn kill_stale_serve_process() {
    remove_legacy_pid_file();

    let dir = process_record_dir();
    let entries = match std::fs::read_dir(&dir) {
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

    let Some(serve_pid) = pid_t_from_u32(record.serve_pid) else {
        log::warn!(
            "Goose serve process record {} has invalid serve pid {}; removing",
            path.display(),
            record.serve_pid
        );
        let _ = std::fs::remove_file(path);
        return;
    };

    cleanup_orphaned_serve_process(path, serve_pid).await;
}

fn read_process_record(path: &Path) -> Result<ServeProcessRecord, String> {
    let contents = std::fs::read_to_string(path).map_err(|error| error.to_string())?;
    serde_json::from_str(&contents).map_err(|error| error.to_string())
}

fn pid_t_from_u32(pid: u32) -> Option<libc::pid_t> {
    if pid > i32::MAX as u32 {
        None
    } else {
        Some(pid as libc::pid_t)
    }
}

fn process_is_alive(pid: libc::pid_t) -> bool {
    // SAFETY: sending signal 0 to check process existence.
    if unsafe { libc::kill(pid, 0) } == 0 {
        return true;
    }

    std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

async fn cleanup_orphaned_serve_process(path: &Path, pid: libc::pid_t) {
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
    // SAFETY: sending SIGTERM to an orphaned goose serve process.
    unsafe {
        libc::kill(pid, libc::SIGTERM);
    }

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
        // SAFETY: sending SIGKILL as a last resort.
        unsafe {
            libc::kill(pid, libc::SIGKILL);
        }
    }

    let _ = std::fs::remove_file(path);
}

/// Check whether the given PID belongs to a goose binary. Uses
/// `proc_pidpath` on macOS and `/proc/{pid}/exe` on Linux.
fn is_goose_process(pid: libc::pid_t) -> bool {
    if let Some(name) = process_executable_name(pid) {
        name.contains("goose")
    } else {
        // If we can't determine the process name, err on the side of caution
        // and assume it is NOT a goose process to avoid killing an unrelated PID.
        false
    }
}

#[cfg(target_os = "macos")]
fn process_executable_name(pid: libc::pid_t) -> Option<String> {
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

#[cfg(not(target_os = "macos"))]
fn process_executable_name(pid: libc::pid_t) -> Option<String> {
    let exe_link = format!("/proc/{pid}/exe");
    let path = std::fs::read_link(exe_link).ok()?;
    path.file_name()?.to_str().map(String::from)
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
/// with `path_env::build_extended_path_from_path` so node-version-manager
/// shims are visible to the goosed sidecar. Any `prepend_dirs` are placed
/// at the front of the resulting PATH. All PATH manipulation for the
/// goosed command flows through this sink, so callers must not read
/// `shell_env["PATH"]` separately or set PATH on `command` directly —
/// doing so would bypass the extended-path logic.
fn apply_shell_env_with_extended_path(
    command: &mut Command,
    shell_env: &HashMap<String, String>,
    prepend_dirs: &[PathBuf],
) {
    let extended_path =
        path_env::build_extended_path_from_path(shell_env.get("PATH").map(String::as_str));

    for (key, value) in shell_env {
        if key == "PATH" {
            continue;
        }
        command.env(key, value);
    }

    let mut paths: Vec<PathBuf> = prepend_dirs.to_vec();
    paths.extend(std::env::split_paths(&extended_path));
    set_path_list_env(
        command,
        "PATH",
        paths,
        prepend_dirs.first().map(|p| p.as_os_str()),
    );
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

fn set_databricks_host_env(command: &mut Command) {
    log::info!("{DATABRICKS_HOST_ENV} set to bundled default");
    command.env(DATABRICKS_HOST_ENV, DEFAULT_DATABRICKS_HOST);
}

fn set_path_list_env(
    command: &mut Command,
    key: &str,
    paths: Vec<PathBuf>,
    fallback_prefix: Option<&std::ffi::OsStr>,
) {
    if let Ok(joined) = std::env::join_paths(&paths) {
        command.env(key, joined);
    } else if let Some(prefix) = fallback_prefix {
        let mut fallback = OsString::from(prefix);
        for path in paths.iter().skip(1) {
            fallback.push(if cfg!(windows) { ";" } else { ":" });
            fallback.push(path.as_os_str());
        }
        command.env(key, fallback);
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
    use super::{acp_websocket_url, apply_shell_env_with_extended_path};
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
            acp_websocket_url(12345, "goose internal/secret"),
            "ws://127.0.0.1:12345/acp?token=goose+internal%2Fsecret"
        );
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
        assert!(paths.iter().any(|p| p.ends_with(".asdf/shims")));

        // Non-PATH variables are forwarded verbatim.
        assert_eq!(
            env_value(&command, "LANG"),
            Some(OsString::from("en_US.UTF-8"))
        );
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
}
