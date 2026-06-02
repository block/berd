use tauri::Manager;
use tauri_plugin_shell::ShellExt;

use std::collections::HashMap;
use std::ffi::OsString;
use std::io::Write;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use crate::services::distro_bundle::DistroBundleState;
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
        format!(
            "ws://{LOCALHOST}:{}/acp?token={}",
            self.port, self.secret_key
        )
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
        // goosed has access to PATH, LANG, and other needed variables. The
        // login shell often misses node-version-manager shims (nvm sources
        // from .zshrc, not .zprofile), so override PATH with the extended
        // path used by every other subprocess spawn site in this app, with
        // the distro `bin_dir` (if any) prepended in front of it.
        let shell_env = shell_env::capture_shell_env().await;
        let mut prepend_dirs: Vec<PathBuf> = Vec::new();

        if let Some(distro_state) = app_handle.try_state::<DistroBundleState>() {
            if let Some(bundle) = distro_state.bundle() {
                if let Some(bin_dir) = &bundle.bin_dir {
                    prepend_dirs.push(bin_dir.clone());
                }
                if let Some(config_path) = &bundle.config_path {
                    append_additional_config_env(&mut command, config_path);
                }
                command.env("GOOSE_DISTRO_DIR", &bundle.root_dir);
            }
        }

        apply_shell_env_with_extended_path(&mut command, &shell_env, &prepend_dirs);
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

        let mut child = command.spawn().map_err(|error| {
            format!(
                "Failed to spawn goose serve (binary: {binary_display}, cwd: {}): {error}",
                working_dir.display()
            )
        })?;

        spawn_log_reader(child.stdout.take(), "stdout");
        spawn_log_reader(child.stderr.take(), "stderr");

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

fn redact_log_line(line: &str) -> String {
    [
        "goose_server__secret_key",
        "authorization",
        "refresh_token",
        "access_token",
        "secret_key",
        "api_key",
        "apikey",
        "password",
        "secret",
        "token",
    ]
    .into_iter()
    .fold(line.to_string(), redact_sensitive_key)
}

fn redact_sensitive_key(line: String, key: &str) -> String {
    let mut redacted = line;
    let mut search_start = 0;

    loop {
        let lower = redacted.to_ascii_lowercase();
        let Some(relative_key_start) = lower[search_start..].find(key) else {
            break;
        };
        let key_start = search_start + relative_key_start;
        let key_end = key_start + key.len();

        if !is_key_boundary(lower.as_bytes(), key_start, key_end) {
            search_start = key_end;
            continue;
        }

        let mut delimiter_index = key_end;
        if matches!(
            lower.as_bytes().get(delimiter_index).copied(),
            Some(b'"' | b'\'')
        ) {
            delimiter_index += 1;
        }
        delimiter_index = skip_ascii_whitespace(lower.as_bytes(), delimiter_index);

        if !matches!(
            lower.as_bytes().get(delimiter_index).copied(),
            Some(b':' | b'=')
        ) {
            search_start = delimiter_index;
            continue;
        }

        let mut value_start = skip_ascii_whitespace(lower.as_bytes(), delimiter_index + 1);
        let quote = match lower.as_bytes().get(value_start).copied() {
            Some(b'"') => {
                value_start += 1;
                Some(b'"')
            }
            Some(b'\'') => {
                value_start += 1;
                Some(b'\'')
            }
            _ => None,
        };

        let value_end = find_value_end(lower.as_bytes(), value_start, quote, key);
        if value_end <= value_start {
            search_start = value_start;
            continue;
        }

        redacted.replace_range(value_start..value_end, "[redacted]");
        search_start = value_start + "[redacted]".len();
    }

    redacted
}

fn is_key_boundary(bytes: &[u8], key_start: usize, key_end: usize) -> bool {
    let before_is_key_char = key_start
        .checked_sub(1)
        .and_then(|index| bytes.get(index))
        .is_some_and(|byte| byte.is_ascii_alphanumeric() || matches!(*byte, b'_' | b'-'));
    let after_is_key_char = bytes
        .get(key_end)
        .is_some_and(|byte| byte.is_ascii_alphanumeric() || matches!(*byte, b'_' | b'-'));

    !before_is_key_char && !after_is_key_char
}

fn skip_ascii_whitespace(bytes: &[u8], start: usize) -> usize {
    let mut index = start;
    while bytes
        .get(index)
        .is_some_and(|byte| byte.is_ascii_whitespace())
    {
        index += 1;
    }
    index
}

fn find_value_end(bytes: &[u8], value_start: usize, quote: Option<u8>, key: &str) -> usize {
    if let Some(quote) = quote {
        return bytes[value_start..]
            .iter()
            .position(|byte| *byte == quote)
            .map(|relative| value_start + relative)
            .unwrap_or(bytes.len());
    }

    let allow_spaces = key == "authorization";
    let mut value_end = value_start;
    while let Some(byte) = bytes.get(value_end) {
        if matches!(*byte, b',' | b';' | b'&') || (!allow_spaces && byte.is_ascii_whitespace()) {
            break;
        }
        value_end += 1;
    }
    value_end
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
    use super::{apply_shell_env_with_extended_path, redact_log_line};
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

    #[test]
    fn redacts_common_secret_key_value_pairs() {
        let redacted =
            redact_log_line("token=abc123 api_key: xyz password = hunter2 secret='keep' ok=value");

        assert_eq!(
            redacted,
            "token=[redacted] api_key: [redacted] password = [redacted] secret='[redacted]' ok=value"
        );
    }

    #[test]
    fn redacts_json_style_secret_values() {
        let redacted = redact_log_line(
            r#"{"authorization":"Bearer abc.def","GOOSE_SERVER__SECRET_KEY":"local-secret"}"#,
        );

        assert_eq!(
            redacted,
            r#"{"authorization":"[redacted]","GOOSE_SERVER__SECRET_KEY":"[redacted]"}"#
        );
    }

    #[test]
    fn redacts_unquoted_authorization_header_value_with_spaces() {
        let redacted = redact_log_line("Authorization: Bearer abc.def, status=401");

        assert_eq!(redacted, "Authorization: [redacted], status=401");
    }
}
