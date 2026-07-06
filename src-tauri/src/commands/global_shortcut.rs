use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

use tauri::{AppHandle, State};
use tauri_plugin_shell::ShellExt;

use crate::services::acp::GooseServeProcess;

const GOOSE_SERVE_URL_ENV: &str = "GOOSE_SERVE_URL";

#[derive(Default)]
pub struct GlobalShortcutHandlerState {
    child: Mutex<Option<Child>>,
}

#[tauri::command]
pub async fn launch_global_shortcut_handler(
    app_handle: AppHandle,
    state: State<'_, GlobalShortcutHandlerState>,
    shortcut: String,
    initially_hidden: bool,
) -> Result<(), String> {
    let shortcut = shortcut.trim().to_string();
    if shortcut.is_empty() {
        return Err("Global shortcut handler shortcut cannot be empty".to_string());
    }

    let goose_serve = GooseServeProcess::get(app_handle.clone()).await?;
    state.launch(app_handle, goose_serve.ws_url(), shortcut, initially_hidden)
}

#[tauri::command]
pub fn stop_global_shortcut_handler(state: State<'_, GlobalShortcutHandlerState>) {
    state.stop();
}

impl GlobalShortcutHandlerState {
    pub fn stop(&self) {
        let Ok(mut child) = self.child.lock() else {
            log::warn!("Failed to lock global shortcut handler state during shutdown");
            return;
        };
        terminate_child(child.as_mut());
        *child = None;
    }

    fn launch(
        &self,
        app_handle: AppHandle,
        goose_serve_url: String,
        shortcut: String,
        initially_hidden: bool,
    ) -> Result<(), String> {
        let mut child = self
            .child
            .lock()
            .map_err(|_| "Global shortcut handler state lock was poisoned".to_string())?;

        terminate_child(child.as_mut());

        let mut command = catch_sidecar_command(&app_handle)?;
        configure_catch_sidecar_command(
            &mut command,
            &goose_serve_url,
            &shortcut,
            initially_hidden,
        );

        let spawned = command
            .spawn()
            .map_err(|error| format!("Failed to launch global shortcut handler: {error}"))?;
        log::info!(
            "Launched global shortcut handler with shortcut {shortcut}; initially hidden: {initially_hidden}"
        );
        *child = Some(spawned);
        Ok(())
    }
}

fn configure_catch_sidecar_command(
    command: &mut Command,
    goose_serve_url: &str,
    shortcut: &str,
    initially_hidden: bool,
) {
    command
        .arg("--embedded")
        .arg("--global-hotkey")
        .arg(shortcut)
        .env(GOOSE_SERVE_URL_ENV, goose_serve_url)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if initially_hidden {
        command.arg("--start-hidden");
    }
}

fn catch_sidecar_command(app_handle: &AppHandle) -> Result<Command, String> {
    let tauri_command = app_handle
        .shell()
        .sidecar("catch")
        .map_err(|error| format!("could not resolve Catch sidecar binary: {error}"))?;
    Ok(tauri_command.into())
}

fn terminate_child(child: Option<&mut Child>) {
    let Some(child) = child else {
        return;
    };

    match child.try_wait() {
        Ok(Some(status)) => {
            log::debug!("Previous global shortcut handler already exited: {status}");
        }
        Ok(None) => {
            if let Err(error) = child.kill() {
                log::warn!("Failed to terminate previous global shortcut handler: {error}");
            }
            let _ = child.wait();
        }
        Err(error) => {
            log::warn!("Failed to inspect previous global shortcut handler: {error}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsStr;

    fn command_args(command: &Command) -> Vec<String> {
        command
            .get_args()
            .map(|argument| argument.to_string_lossy().to_string())
            .collect()
    }

    fn command_env(command: &Command, name: &str) -> Option<String> {
        command.get_envs().find_map(|(key, value)| {
            if key == OsStr::new(name) {
                value.map(|value| value.to_string_lossy().to_string())
            } else {
                None
            }
        })
    }

    #[test]
    fn terminate_child_accepts_missing_child() {
        terminate_child(None);
    }

    #[test]
    fn command_configuration_passes_embedded_shortcut_and_goose_serve_url() {
        let mut command = Command::new("catch");

        configure_catch_sidecar_command(
            &mut command,
            "ws://127.0.0.1:1234/acp?token=secret",
            "alt+space",
            false,
        );

        assert_eq!(
            command_args(&command),
            ["--embedded", "--global-hotkey", "alt+space"]
        );
        assert_eq!(
            command_env(&command, GOOSE_SERVE_URL_ENV),
            Some("ws://127.0.0.1:1234/acp?token=secret".to_string())
        );
    }

    #[test]
    fn command_configuration_passes_start_hidden_when_requested() {
        let mut command = Command::new("catch");

        configure_catch_sidecar_command(
            &mut command,
            "ws://127.0.0.1:1234/acp?token=secret",
            "ctrl+alt+c",
            true,
        );

        assert_eq!(
            command_args(&command),
            [
                "--embedded",
                "--global-hotkey",
                "ctrl+alt+c",
                "--start-hidden"
            ]
        );
    }
}
