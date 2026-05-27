use tauri::Manager;
use tauri_plugin_shell::ShellExt;

use std::ffi::OsString;
use std::io::Write;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use crate::services::distro_bundle::DistroBundleState;
use crate::services::shell_env;

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
        format!("ws://{LOCALHOST}:{}/acp", self.port)
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
        let pid = self._child.id();
        if let Some(pid) = pid {
            log::info!("Killing goose serve child (pid {pid})");
            // SAFETY: sending SIGTERM to a known child process.
            unsafe {
                libc::kill(pid as libc::pid_t, libc::SIGTERM);
            }
        }
        // Clean up the PID file.
        let _ = std::fs::remove_file(pid_file_path());
    }

    /// Kill the singleton goose serve process if it exists. Called from the
    /// app exit handler.
    pub fn kill_singleton() {
        if let Some(process) = GOOSE_SERVE.get() {
            process.kill();
        }
    }

    async fn spawn(app_handle: tauri::AppHandle) -> Result<GooseServeProcess, String> {
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
        // goosed has access to PATH, LANG, and other needed variables.
        let shell_env = shell_env::capture_shell_env().await;
        for (key, value) in &shell_env {
            command.env(key, value);
        }

        if let Some(distro_state) = app_handle.try_state::<DistroBundleState>() {
            if let Some(bundle) = distro_state.bundle() {
                if let Some(bin_dir) = &bundle.bin_dir {
                    prepend_path_env(
                        &mut command,
                        bin_dir,
                        shell_env.get("PATH").map(String::as_str),
                    );
                }
                if let Some(config_path) = &bundle.config_path {
                    append_additional_config_env(&mut command, config_path);
                }
                command.env("GOOSE_DISTRO_DIR", &bundle.root_dir);
            }
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
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true);

        log::info!(
            "Spawning long-lived goose serve: binary={binary_display} port={port} cwd={}",
            working_dir.display(),
        );

        let mut child = command.spawn().map_err(|error| {
            format!(
                "Failed to spawn goose serve (binary: {binary_display}, cwd: {}): {error}",
                working_dir.display()
            )
        })?;

        wait_for_server_ready(port, &mut child).await?;

        log::info!("Goose serve is ready on port {port}");

        if let Some(pid) = child.id() {
            write_pid_file(pid);
        }

        Ok(GooseServeProcess {
            port,
            secret_key,
            _child: child,
        })
    }
}

// ---------------------------------------------------------------------------
// PID-file helpers — best-effort orphan cleanup
// ---------------------------------------------------------------------------

fn pid_file_path() -> PathBuf {
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

fn write_pid_file(pid: u32) {
    let path = pid_file_path();
    match std::fs::File::create(&path) {
        Ok(mut f) => {
            if let Err(e) = write!(f, "{pid}") {
                log::warn!("Failed to write PID file {}: {e}", path.display());
            }
        }
        Err(e) => {
            log::warn!("Failed to create PID file {}: {e}", path.display());
        }
    }
}

/// Read the PID file left by a previous run, check whether that process is
/// still alive, and kill it if so. All errors are logged and swallowed so
/// that app startup is never blocked.
async fn kill_stale_serve_process() {
    let path = pid_file_path();
    let contents = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        Err(_) => return, // no PID file — nothing to clean up
    };

    let pid: libc::pid_t = match contents.trim().parse() {
        Ok(p) => p,
        Err(_) => {
            log::warn!("Stale PID file contains non-numeric value, removing");
            let _ = std::fs::remove_file(&path);
            return;
        }
    };

    // Check whether the process is still alive (signal 0 = existence check).
    // SAFETY: sending signal 0 to check process existence.
    let alive = unsafe { libc::kill(pid, 0) } == 0;
    if !alive {
        log::info!(
            "Previous goose serve (pid {pid}) is no longer running, removing stale PID file"
        );
        let _ = std::fs::remove_file(&path);
        return;
    }

    // Guard against PID recycling: verify the process is actually a goose binary.
    if !is_goose_process(pid) {
        log::warn!(
            "PID {pid} is alive but is not a goose process (PID was likely recycled), removing stale PID file"
        );
        let _ = std::fs::remove_file(&path);
        return;
    }

    log::info!("Killing orphaned goose serve process (pid {pid})");
    // SAFETY: sending SIGTERM to the orphaned child.
    unsafe {
        libc::kill(pid, libc::SIGTERM);
    }

    // Give it a moment to exit, then force-kill if still alive.
    tokio::time::sleep(Duration::from_millis(200)).await;
    // SAFETY: checking if process still exists after SIGTERM.
    if unsafe { libc::kill(pid, 0) } == 0 {
        log::warn!("Orphaned goose serve (pid {pid}) did not exit after SIGTERM, sending SIGKILL");
        // SAFETY: sending SIGKILL as a last resort.
        unsafe {
            libc::kill(pid, libc::SIGKILL);
        }
    }

    let _ = std::fs::remove_file(&path);
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

fn default_serve_working_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("/tmp"))
}

fn prepend_path_env(
    command: &mut Command,
    extra_dir: &std::path::Path,
    existing_path: Option<&str>,
) {
    let mut paths = vec![extra_dir.to_path_buf()];
    if let Some(existing) = existing_path {
        paths.extend(std::env::split_paths(existing));
    } else if let Some(existing) = std::env::var_os("PATH") {
        paths.extend(std::env::split_paths(&existing));
    }

    set_path_list_env(command, "PATH", paths, Some(extra_dir.as_os_str()));
}

fn append_additional_config_env(command: &mut Command, config_path: &std::path::Path) {
    let existing = std::env::var_os("GOOSE_ADDITIONAL_CONFIG_FILES");
    let mut paths: Vec<PathBuf> = existing
        .as_ref()
        .map(std::env::split_paths)
        .map(Iterator::collect)
        .unwrap_or_default();
    paths.push(config_path.to_path_buf());

    if let Ok(joined) = std::env::join_paths(&paths) {
        command.env("GOOSE_ADDITIONAL_CONFIG_FILES", joined);
    } else {
        let mut fallback = existing.unwrap_or_default();
        if !fallback.is_empty() {
            fallback.push(if cfg!(windows) { ";" } else { ":" });
        }
        fallback.push(config_path.as_os_str());
        command.env("GOOSE_ADDITIONAL_CONFIG_FILES", fallback);
    }
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
    use super::prepend_path_env;
    use std::path::Path;
    use tokio::process::Command;

    #[test]
    fn distro_path_prepend_preserves_captured_shell_path() {
        let mut command = Command::new("goose");
        let shell_path = "/shell/bin:/tool/bin".to_string();

        prepend_path_env(&mut command, Path::new("/distro/bin"), Some(&shell_path));

        let path = command
            .as_std()
            .get_envs()
            .find_map(|(key, value)| {
                if key == "PATH" {
                    value.map(|value| value.to_os_string())
                } else {
                    None
                }
            })
            .expect("PATH should be set");
        let paths: Vec<_> = std::env::split_paths(&path).collect();

        assert_eq!(
            paths.first().map(|p| p.as_path()),
            Some(Path::new("/distro/bin"))
        );
        assert!(paths.iter().any(|p| p == Path::new("/shell/bin")));
        assert!(paths.iter().any(|p| p == Path::new("/tool/bin")));
    }

    #[test]
    fn distro_path_prepend_falls_back_to_process_path() {
        let mut command = Command::new("goose");

        prepend_path_env(&mut command, Path::new("/distro/bin"), None);

        let path = command
            .as_std()
            .get_envs()
            .find_map(|(key, value)| {
                if key == "PATH" {
                    value.map(|value| value.to_os_string())
                } else {
                    None
                }
            })
            .expect("PATH should be set");
        let paths: Vec<_> = std::env::split_paths(&path).collect();

        assert_eq!(
            paths.first().map(|p| p.as_path()),
            Some(Path::new("/distro/bin"))
        );
        assert!(paths.len() > 1);
    }
}
