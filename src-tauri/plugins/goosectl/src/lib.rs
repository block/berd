//! goosectl broker: the in-app command broker for the goosectl CLI.
//!
//! A lazily started, loopback-only HTTP server (`GET /v1/ping`, `POST
//! /v1/call`) that forwards commands over a request/response bridge into the
//! main-window renderer. The CLI finds it through a per-instance discovery
//! file written on start and removed on stop/exit.
//!
//! Without the `server` feature this crate is an inert stub: build.rs still
//! generates the command permissions (so capability validation passes in
//! non-feature builds), but no runtime broker code — including `init` —
//! exists. Only the discovery path helpers below stay unconditional so the
//! app crate can compute paths without enabling the broker.

#[cfg(feature = "server")]
mod bridge;
mod discovery;
#[cfg(feature = "server")]
mod server;

pub use discovery::{discovery_file_path, owner_pid_from_discovery_file_name, DISCOVERY_DIR_NAME};

#[cfg(feature = "server")]
mod plugin {
    use crate::bridge::{Bridge, BridgeError, BridgeRequest, BridgeResult};
    use crate::discovery;
    use crate::server::{
        self, BridgeDispatcher, ServerContext, ServerHandle, TimeoutStore, IN_FLIGHT_LIMIT,
    };
    use serde::Serialize;
    use std::collections::HashMap;
    use std::fmt;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::Duration;
    use tauri::plugin::TauriPlugin;
    use tauri::{AppHandle, Manager, RunEvent, Runtime, State};

    #[derive(Serialize)]
    pub struct StartedEndpoint {
        pub port: u16,
    }

    #[derive(Debug, PartialEq, Eq)]
    pub enum AppCommandDispatchError {
        PluginNotInitialized,
        BridgeUnavailable,
        RendererDropped,
        Timeout,
        Command { code: String, message: String },
    }

    impl fmt::Display for AppCommandDispatchError {
        fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
            match self {
                Self::PluginNotInitialized => write!(f, "goosectl plugin is not initialized"),
                Self::BridgeUnavailable => write!(f, "app window unavailable"),
                Self::RendererDropped => write!(f, "renderer dropped goosectl command"),
                Self::Timeout => write!(f, "renderer timed out handling goosectl command"),
                Self::Command { code, message } => {
                    write!(f, "goosectl command failed ({code}): {message}")
                }
            }
        }
    }

    impl std::error::Error for AppCommandDispatchError {}

    pub struct GoosectlState {
        bridge: Arc<Bridge>,
        server: tokio::sync::Mutex<Option<ServerHandle>>,
        timeouts: Arc<TimeoutStore>,
        // Bumped per actual server start (not idempotent re-starts) and echoed
        // by /v1/ping, so the CLI can tell a restarted broker from the one the
        // discovery file describes.
        generation: AtomicU64,
        discovery_file: Mutex<Option<PathBuf>>,
    }

    impl GoosectlState {
        fn new() -> Self {
            Self {
                bridge: Arc::new(Bridge::new()),
                server: tokio::sync::Mutex::new(None),
                timeouts: Arc::new(TimeoutStore::new()),
                generation: AtomicU64::new(0),
                discovery_file: Mutex::new(None),
            }
        }

        fn remove_discovery_file(&self) {
            if let Some(path) = self.discovery_file.lock().unwrap().take() {
                discovery::remove_discovery_file(&path);
            }
        }
    }

    /// Dispatch an app command through the same renderer registry that backs
    /// the goosectl CLI, without going through the loopback HTTP broker.
    pub async fn dispatch_app_command<R: Runtime>(
        app: AppHandle<R>,
        command: String,
        args: serde_json::Value,
        timeout_override: Option<Duration>,
    ) -> Result<serde_json::Value, AppCommandDispatchError> {
        let Some(state) = app.try_state::<GoosectlState>() else {
            return Err(AppCommandDispatchError::PluginNotInitialized);
        };
        let timeout = state
            .timeouts
            .command_timeout(&command, timeout_override.map(|t| t.as_millis() as u64));
        let req = BridgeRequest {
            id: uuid::Uuid::new_v4().to_string(),
            command,
            args,
            timeout_ms: timeout.as_millis() as u64,
        };
        resolve_dispatch_result(state.bridge.dispatch(&app, req, timeout).await)
    }

    fn resolve_dispatch_result(
        result: Result<BridgeResult, BridgeError>,
    ) -> Result<serde_json::Value, AppCommandDispatchError> {
        match result {
            Ok(result) if result.ok => Ok(result.data.unwrap_or(serde_json::Value::Null)),
            Ok(result) => {
                let (code, message) = result
                    .error
                    .map(|err| (err.code, err.message))
                    .unwrap_or_else(|| ("error".to_string(), "Command failed".to_string()));
                Err(AppCommandDispatchError::Command { code, message })
            }
            Err(BridgeError::Emit(_)) => Err(AppCommandDispatchError::BridgeUnavailable),
            Err(BridgeError::RendererDropped) => Err(AppCommandDispatchError::RendererDropped),
            Err(BridgeError::Timeout) => Err(AppCommandDispatchError::Timeout),
        }
    }

    /// Idempotent: returns the existing endpoint when already running (and
    /// leaves the discovery file and generation untouched).
    #[tauri::command]
    async fn start<R: Runtime>(
        app: AppHandle<R>,
        state: State<'_, GoosectlState>,
    ) -> Result<StartedEndpoint, String> {
        let mut server_slot = state.server.lock().await;
        if let Some(handle) = server_slot.as_ref() {
            return Ok(StartedEndpoint { port: handle.port });
        }
        let generation = state.generation.fetch_add(1, Ordering::Relaxed) + 1;
        // Each server gets its own semaphore: graceful shutdown lets the
        // previous server's in-flight handlers outlive `stop`, and their
        // permits must release slots on that dead instance, not free up (and
        // over-admit against) the new server's semaphore.
        let ctx = Arc::new(ServerContext::new(
            BridgeDispatcher {
                app: app.clone(),
                bridge: state.bridge.clone(),
            },
            state.timeouts.clone(),
            Arc::new(tokio::sync::Semaphore::new(IN_FLIGHT_LIMIT)),
            generation,
        ));
        let handle = server::start_server(ctx)
            .await
            .map_err(|err| format!("failed to start goosectl server: {err}"))?;
        let port = handle.port;

        // The CLI can only find the broker through the discovery file, so a
        // failed write means a failed start.
        let app_data_dir = app
            .path()
            .app_data_dir()
            .map_err(|err| format!("failed to resolve app data dir: {err}"))?;
        let pid = std::process::id();
        let path = discovery::discovery_file_path(&app_data_dir, pid);
        if let Err(err) = discovery::write_discovery_file(&path, port, pid, generation) {
            handle.shutdown();
            return Err(format!(
                "failed to write goosectl discovery file {}: {err}",
                path.display()
            ));
        }
        *state.discovery_file.lock().unwrap() = Some(path);

        *server_slot = Some(handle);
        log::info!("[goosectl] listening on 127.0.0.1:{port} (generation {generation})");
        Ok(StartedEndpoint { port })
    }

    #[tauri::command]
    async fn stop(state: State<'_, GoosectlState>) -> Result<(), String> {
        let mut server_slot = state.server.lock().await;
        if let Some(handle) = server_slot.take() {
            let port = handle.port;
            handle.shutdown();
            state.remove_discovery_file();
            log::info!("[goosectl] stopped server on 127.0.0.1:{port}");
        }
        Ok(())
    }

    /// Per-command bridge timeouts, pushed by the renderer at broker start
    /// (the renderer owns command knowledge; the broker only stores the
    /// map). Clamped server-side.
    #[tauri::command]
    fn set_timeouts(state: State<'_, GoosectlState>, timeouts: HashMap<String, u64>) {
        let count = timeouts.len();
        state.timeouts.set(timeouts);
        log::info!("[goosectl] timeouts updated ({count} commands)");
    }

    #[tauri::command]
    fn submit_result(state: State<'_, GoosectlState>, result: BridgeResult) {
        state.bridge.resolve(result);
    }

    pub fn init<R: Runtime>() -> TauriPlugin<R> {
        tauri::plugin::Builder::new("goosectl")
            .invoke_handler(tauri::generate_handler![
                start,
                stop,
                set_timeouts,
                submit_result
            ])
            .setup(|app, _api| {
                // No server start here: the renderer starts it lazily once the
                // experiment is enabled.
                app.manage(GoosectlState::new());
                Ok(())
            })
            .on_event(|app, event| {
                if let RunEvent::Exit = event {
                    if let Some(state) = app.try_state::<GoosectlState>() {
                        state.remove_discovery_file();
                    }
                }
            })
            .build()
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use crate::bridge::BridgeErrorBody;
        use serde_json::json;

        fn ok_result(data: Option<serde_json::Value>) -> BridgeResult {
            BridgeResult {
                id: "request-id".to_string(),
                ok: true,
                data,
                error: None,
            }
        }

        fn error_result(error: Option<BridgeErrorBody>) -> BridgeResult {
            BridgeResult {
                id: "request-id".to_string(),
                ok: false,
                data: None,
                error,
            }
        }

        #[test]
        fn resolves_successful_dispatch_result_data() {
            assert_eq!(
                resolve_dispatch_result(Ok(ok_result(Some(json!({ "ok": true }))))),
                Ok(json!({ "ok": true }))
            );
            assert_eq!(
                resolve_dispatch_result(Ok(ok_result(None))),
                Ok(serde_json::Value::Null)
            );
        }

        #[test]
        fn maps_command_dispatch_errors() {
            assert_eq!(
                resolve_dispatch_result(Ok(error_result(Some(BridgeErrorBody {
                    code: "session_not_found".to_string(),
                    message: "No session".to_string(),
                })))),
                Err(AppCommandDispatchError::Command {
                    code: "session_not_found".to_string(),
                    message: "No session".to_string(),
                })
            );
            assert_eq!(
                resolve_dispatch_result(Ok(error_result(None))),
                Err(AppCommandDispatchError::Command {
                    code: "error".to_string(),
                    message: "Command failed".to_string(),
                })
            );
            assert_eq!(
                resolve_dispatch_result(Err(BridgeError::RendererDropped)),
                Err(AppCommandDispatchError::RendererDropped)
            );
            assert_eq!(
                resolve_dispatch_result(Err(BridgeError::Timeout)),
                Err(AppCommandDispatchError::Timeout)
            );
        }

        #[test]
        fn maps_emit_failure_to_bridge_unavailable() {
            assert_eq!(
                resolve_dispatch_result(Err(BridgeError::Emit(tauri::Error::Io(
                    std::io::Error::other("emit failed"),
                )))),
                Err(AppCommandDispatchError::BridgeUnavailable)
            );
        }
    }
}

#[cfg(feature = "server")]
pub use plugin::{dispatch_app_command, init, AppCommandDispatchError};
