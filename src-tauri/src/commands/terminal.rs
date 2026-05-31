use crate::commands::git::is_git_repo_async;
use crate::services::{path_env::build_extended_path, shell_env};
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::{
    collections::HashMap,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    thread,
};
use tauri::{ipc::Channel, State};
use uuid::Uuid;

const MIN_COLS: u16 = 20;
const MIN_ROWS: u16 = 5;
const MAX_COLS: u16 = 500;
const MAX_ROWS: u16 = 200;

#[derive(Clone, Default)]
pub struct TerminalState {
    sessions: Arc<Mutex<HashMap<String, TerminalSession>>>,
}

impl TerminalState {
    pub fn stop_all(&self) {
        let sessions = match self.sessions.lock() {
            Ok(mut sessions) => sessions
                .drain()
                .map(|(_, session)| session)
                .collect::<Vec<_>>(),
            Err(error) => {
                log::warn!("Failed to lock terminal sessions for shutdown: {error}");
                Vec::new()
            }
        };

        for session in sessions {
            session.kill();
        }
    }
}

struct TerminalSession {
    master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    killer: Arc<Mutex<Box<dyn ChildKiller + Send + Sync>>>,
}

impl TerminalSession {
    fn kill(&self) {
        if let Ok(mut killer) = self.killer.lock() {
            let _ = killer.kill();
        }
    }
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
    if !is_git_repo_async(&cwd).await? {
        return Err("Terminal is available in git workspaces.".to_string());
    }

    let mut shell_env = shell_env::capture_shell_env().await;
    add_fallback_env_vars(&mut shell_env);
    shell_env::sanitize_shell_env(&mut shell_env);
    let shell = resolve_shell(&shell_env);
    let terminal_id = Uuid::new_v4().to_string();
    let size = terminal_size(cols, rows);
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(size)
        .map_err(|error| format!("Failed to create terminal: {error}"))?;

    let mut command = CommandBuilder::new(shell);
    command.env_clear();
    command.cwd(&cwd);
    for (key, value) in &shell_env {
        command.env(key, value);
    }
    command.env("PATH", build_extended_path().await);
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");

    let mut child = pair
        .slave
        .spawn_command(command)
        .map_err(|error| format!("Failed to start terminal shell: {error}"))?;
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
                            Ok(mut sessions) => sessions.remove(&read_terminal_id),
                            Err(error) => {
                                log::warn!(
                                    "Failed to lock terminal sessions after channel closed: {error}"
                                );
                                None
                            }
                        };
                        if let Some(session) = session {
                            session.kill();
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
                            Ok(mut sessions) => sessions.remove(&read_terminal_id),
                            Err(error) => {
                                log::warn!(
                                    "Failed to lock terminal sessions after channel closed: {error}"
                                );
                                None
                            }
                        };
                        if let Some(session) = session {
                            session.kill();
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
        let mut sessions = state
            .sessions
            .lock()
            .map_err(|error| format!("Failed to lock terminal sessions: {error}"))?;
        sessions.remove(&terminal_id)
    };

    if let Some(session) = session {
        session.kill();
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
