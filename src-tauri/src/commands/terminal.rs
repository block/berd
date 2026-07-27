use crate::services::{dir_env, path_env::build_extended_path_from_path, shell_env};
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
#[cfg(unix)]
use std::time::{Duration, Instant};
use std::{
    collections::HashMap,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
};
use tauri::{ipc::Channel, State};
use uuid::Uuid;

const MIN_COLS: u16 = 20;
const MIN_ROWS: u16 = 5;
const MAX_COLS: u16 = 500;
const MAX_ROWS: u16 = 200;
#[cfg(unix)]
const STOP_GRACE: Duration = Duration::from_millis(750);
#[cfg(unix)]
const STOP_POLL_INTERVAL: Duration = Duration::from_millis(25);

#[derive(Clone, Default)]
pub struct TerminalState {
    sessions: Arc<Mutex<HashMap<String, TerminalSession>>>,
}

impl TerminalState {
    pub fn stop_all(&self) {
        let sessions = match self.sessions.lock() {
            Ok(sessions) => sessions.values().cloned().collect::<Vec<_>>(),
            Err(error) => {
                log::warn!("Failed to lock terminal sessions for shutdown: {error}");
                Vec::new()
            }
        };

        for session in sessions {
            session.stop_blocking();
        }
    }
}

#[derive(Clone)]
struct TerminalSession {
    master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    killer: Arc<Mutex<Box<dyn ChildKiller + Send + Sync>>>,
    process_id: Option<u32>,
    stopping: Arc<AtomicBool>,
}

impl TerminalSession {
    fn begin_stop(&self) -> bool {
        !self.stopping.swap(true, Ordering::AcqRel)
    }

    fn stop(&self) {
        if !self.begin_stop() {
            return;
        }

        #[cfg(unix)]
        if let Some(process_id) = self.process_id {
            thread::spawn(move || stop_unix_process_group(process_id));
            return;
        }

        // portable-pty's Windows killer terminates only the process represented
        // by its handle; it does not establish process-tree ownership. Keep this
        // fallback bounded, but do not claim that it terminates descendants.
        self.kill_child();
    }

    fn stop_blocking(&self) {
        if !self.begin_stop() {
            return;
        }

        #[cfg(unix)]
        if let Some(process_id) = self.process_id {
            stop_unix_process_group(process_id);
            return;
        }

        self.kill_child();
    }

    fn kill_child(&self) {
        match self.killer.lock() {
            Ok(mut killer) => {
                if let Err(error) = killer.kill() {
                    log::warn!("Failed to stop terminal process: {error}");
                }
            }
            Err(error) => log::warn!("Failed to lock terminal process killer: {error}"),
        }
    }
}

#[cfg(unix)]
fn stop_unix_process_group(process_id: u32) {
    if process_id > i32::MAX as u32 {
        log::warn!("Cannot stop terminal process group with invalid id {process_id}");
        return;
    }

    if !signal_process_group(process_id, libc::SIGHUP) {
        return;
    }

    let deadline = Instant::now() + STOP_GRACE;
    while process_group_exists(process_id) && Instant::now() < deadline {
        thread::sleep(STOP_POLL_INTERVAL);
    }

    if process_group_exists(process_id) {
        signal_process_group(process_id, libc::SIGKILL);
    }
}

#[cfg(unix)]
fn process_group_exists(process_id: u32) -> bool {
    let result = unsafe { libc::kill(-(process_id as i32), 0) };
    if result == 0 {
        return true;
    }

    std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

#[cfg(unix)]
fn signal_process_group(process_id: u32, signal: libc::c_int) -> bool {
    let result = unsafe { libc::kill(-(process_id as i32), signal) };
    if result == 0 {
        return true;
    }

    let error = std::io::Error::last_os_error();
    if error.raw_os_error() != Some(libc::ESRCH) {
        log::warn!("Failed to signal terminal process group {process_id}: {error}");
    }
    false
}

#[derive(Clone, Serialize)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "event",
    content = "data"
)]
pub enum TerminalEvent {
    Started {
        terminal_id: String,
    },
    Output {
        terminal_id: String,
        data: String,
    },
    Exited {
        terminal_id: String,
        exit_code: u32,
        signal: Option<String>,
    },
    Error {
        terminal_id: String,
        message: String,
    },
}

#[tauri::command]
pub async fn start_terminal(
    state: State<'_, TerminalState>,
    cwd: String,
    cols: u16,
    rows: u16,
    on_event: Channel<TerminalEvent>,
) -> Result<String, String> {
    let cwd = resolve_terminal_cwd(&cwd)?;
    let mut shell_env = dir_env::capture_home_interactive_env().await;
    add_fallback_env_vars(&mut shell_env);
    shell_env::sanitize_shell_env(&mut shell_env);
    let extended_path = build_extended_path_from_path(shell_env.get("PATH").map(String::as_str));
    let shell = resolve_shell(&shell_env);
    let terminal_id = Uuid::new_v4().to_string();
    let size = terminal_size(cols, rows);
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(size)
        .map_err(|error| format!("Failed to create terminal: {error}"))?;

    let mut process = CommandBuilder::new(shell);
    process.env_clear();
    process.cwd(&cwd);
    for (key, value) in &shell_env {
        process.env(key, value);
    }
    process.env("PATH", extended_path);
    process.env("TERM", "xterm-256color");
    process.env("COLORTERM", "truecolor");
    let mut child = pair
        .slave
        .spawn_command(process)
        .map_err(|error| format!("Failed to start terminal shell: {error}"))?;
    let process_id = child.process_id();
    let killer = Arc::new(Mutex::new(child.clone_killer()));
    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|error| format!("Failed to read terminal output: {error}"))?;
    let writer =
        Arc::new(Mutex::new(pair.master.take_writer().map_err(|error| {
            format!("Failed to open terminal input: {error}")
        })?));
    let master = Arc::new(Mutex::new(pair.master));

    let session = TerminalSession {
        master,
        writer,
        killer,
        process_id,
        stopping: Arc::new(AtomicBool::new(false)),
    };

    {
        let mut sessions = state
            .sessions
            .lock()
            .map_err(|error| format!("Failed to lock terminal sessions: {error}"))?;
        sessions.insert(terminal_id.clone(), session);
    }

    let _ = on_event.send(TerminalEvent::Started {
        terminal_id: terminal_id.clone(),
    });

    let read_terminal_id = terminal_id.clone();
    let read_channel = on_event.clone();
    let read_sessions = state.sessions.clone();
    thread::spawn(move || {
        let mut buffer = [0_u8; 8192];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(len) => {
                    let data = String::from_utf8_lossy(&buffer[..len]).to_string();
                    if read_channel
                        .send(TerminalEvent::Output {
                            terminal_id: read_terminal_id.clone(),
                            data,
                        })
                        .is_err()
                    {
                        let session = match read_sessions.lock() {
                            Ok(sessions) => sessions.get(&read_terminal_id).cloned(),
                            Err(error) => {
                                log::warn!(
                                    "Failed to lock terminal sessions after channel closed: {error}"
                                );
                                None
                            }
                        };
                        if let Some(session) = session {
                            session.stop();
                        }
                        break;
                    }
                }
                Err(error) => {
                    if read_channel
                        .send(TerminalEvent::Error {
                            terminal_id: read_terminal_id.clone(),
                            message: format!("Terminal output stopped: {error}"),
                        })
                        .is_err()
                    {
                        let session = match read_sessions.lock() {
                            Ok(sessions) => sessions.get(&read_terminal_id).cloned(),
                            Err(error) => {
                                log::warn!(
                                    "Failed to lock terminal sessions after channel closed: {error}"
                                );
                                None
                            }
                        };
                        if let Some(session) = session {
                            session.stop();
                        }
                    }
                    break;
                }
            }
        }
    });

    let wait_terminal_id = terminal_id.clone();
    let wait_channel = on_event;
    let sessions = state.sessions.clone();
    thread::spawn(move || {
        let result = child.wait();
        if let Ok(mut sessions) = sessions.lock() {
            sessions.remove(&wait_terminal_id);
        }

        match result {
            Ok(status) => {
                let _ = wait_channel.send(TerminalEvent::Exited {
                    terminal_id: wait_terminal_id,
                    exit_code: status.exit_code(),
                    signal: status.signal().map(str::to_string),
                });
            }
            Err(error) => {
                let _ = wait_channel.send(TerminalEvent::Error {
                    terminal_id: wait_terminal_id,
                    message: format!("Terminal shell ended unexpectedly: {error}"),
                });
            }
        }
    });

    Ok(terminal_id)
}

#[tauri::command]
pub fn write_terminal(
    state: State<'_, TerminalState>,
    terminal_id: String,
    data: String,
) -> Result<(), String> {
    let writer = {
        let sessions = state
            .sessions
            .lock()
            .map_err(|error| format!("Failed to lock terminal sessions: {error}"))?;
        sessions
            .get(&terminal_id)
            .map(|session| session.writer.clone())
            .ok_or_else(|| "Terminal session is not running.".to_string())?
    };

    let mut writer = writer
        .lock()
        .map_err(|error| format!("Failed to lock terminal input: {error}"))?;
    writer
        .write_all(data.as_bytes())
        .and_then(|_| writer.flush())
        .map_err(|error| format!("Failed to write terminal input: {error}"))
}

#[tauri::command]
pub fn resize_terminal(
    state: State<'_, TerminalState>,
    terminal_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let master = {
        let sessions = state
            .sessions
            .lock()
            .map_err(|error| format!("Failed to lock terminal sessions: {error}"))?;
        sessions
            .get(&terminal_id)
            .map(|session| session.master.clone())
            .ok_or_else(|| "Terminal session is not running.".to_string())?
    };

    let master = master
        .lock()
        .map_err(|error| format!("Failed to lock terminal size: {error}"))?;
    master
        .resize(terminal_size(cols, rows))
        .map_err(|error| format!("Failed to resize terminal: {error}"))
}

#[tauri::command]
pub fn stop_terminal(state: State<'_, TerminalState>, terminal_id: String) -> Result<(), String> {
    let session = {
        let sessions = state
            .sessions
            .lock()
            .map_err(|error| format!("Failed to lock terminal sessions: {error}"))?;
        sessions.get(&terminal_id).cloned()
    };

    if let Some(session) = session {
        session.stop();
    }

    Ok(())
}

fn terminal_size(cols: u16, rows: u16) -> PtySize {
    PtySize {
        rows: rows.clamp(MIN_ROWS, MAX_ROWS),
        cols: cols.clamp(MIN_COLS, MAX_COLS),
        pixel_width: 0,
        pixel_height: 0,
    }
}

fn resolve_terminal_cwd(cwd: &str) -> Result<PathBuf, String> {
    let cwd = cwd.trim();
    let path = if cwd.is_empty() || cwd == "~" {
        dirs::home_dir().ok_or("Could not determine home directory")?
    } else if let Some(rest) = cwd.strip_prefix("~/") {
        dirs::home_dir()
            .ok_or("Could not determine home directory")?
            .join(rest)
    } else {
        PathBuf::from(cwd)
    };

    if !path.exists() {
        return Err(format!(
            "Terminal folder does not exist: {}",
            path.display()
        ));
    }
    if !path.is_dir() {
        return Err(format!("Terminal path is not a folder: {}", path.display()));
    }

    Ok(normalize_path(&path))
}

fn normalize_path(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
}

fn resolve_shell(shell_env: &HashMap<String, String>) -> String {
    if cfg!(target_os = "windows") {
        return std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".to_string());
    }

    shell_env
        .get("SHELL")
        .cloned()
        .or_else(|| std::env::var("SHELL").ok())
        .unwrap_or_else(|| "/bin/sh".to_string())
}

fn add_fallback_env_vars(env: &mut HashMap<String, String>) {
    for key in [
        "HOME",
        "USER",
        "LOGNAME",
        "SHELL",
        "LANG",
        "LC_ALL",
        "LC_CTYPE",
        "TMPDIR",
        "SSH_AUTH_SOCK",
    ] {
        if env.contains_key(key) {
            continue;
        }
        if let Ok(value) = std::env::var(key) {
            env.insert(key.to_string(), value);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::resolve_terminal_cwd;
    #[cfg(unix)]
    use super::{process_group_exists, stop_unix_process_group};
    #[cfg(unix)]
    use std::os::unix::process::CommandExt;
    #[cfg(unix)]
    use std::process::{Command, Stdio};
    use tempfile::{tempdir, NamedTempFile};

    #[cfg(unix)]
    #[test]
    fn stop_escalates_for_a_process_group_that_ignores_hup() {
        let mut child = Command::new("sh")
            .args(["-c", "trap '' HUP; while :; do sleep 1; done"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .process_group(0)
            .spawn()
            .expect("spawn HUP-ignoring process group");
        let process_id = child.id();

        assert!(process_group_exists(process_id));
        stop_unix_process_group(process_id);
        child.wait().expect("reap stopped process group");
        assert!(!process_group_exists(process_id));
    }

    #[test]
    fn resolve_terminal_cwd_accepts_plain_directory() {
        let dir = tempdir().expect("tempdir");
        let cwd = dir.path().to_string_lossy().to_string();

        let resolved = resolve_terminal_cwd(&cwd).expect("resolve cwd");

        assert_eq!(resolved, dir.path().canonicalize().expect("canonicalize"));
    }

    #[test]
    fn resolve_terminal_cwd_rejects_file_path() {
        let file = NamedTempFile::new().expect("temp file");
        let cwd = file.path().to_string_lossy().to_string();

        let error = resolve_terminal_cwd(&cwd).expect_err("file should fail");

        assert!(error.contains("Terminal path is not a folder"));
    }

    #[test]
    fn resolve_terminal_cwd_rejects_missing_path() {
        let dir = tempdir().expect("tempdir");
        let missing = dir.path().join("missing");
        let cwd = missing.to_string_lossy().to_string();

        let error = resolve_terminal_cwd(&cwd).expect_err("missing path should fail");

        assert!(error.contains("Terminal folder does not exist"));
    }
}
