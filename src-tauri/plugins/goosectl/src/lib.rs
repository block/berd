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
    use crate::bridge::{Bridge, BridgeResult};
    use crate::discovery;
    use crate::server::{
        self, BridgeDispatcher, ServerContext, ServerHandle, TimeoutStore, IN_FLIGHT_LIMIT,
    };
    use serde::Serialize;
    use std::collections::HashMap;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::{Arc, Mutex};
    use tauri::plugin::TauriPlugin;
    use tauri::{AppHandle, Manager, RunEvent, Runtime, State};

    #[derive(Serialize)]
    pub struct StartedEndpoint {
        pub port: u16,
    }

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
}

#[cfg(feature = "server")]
pub use plugin::init;
