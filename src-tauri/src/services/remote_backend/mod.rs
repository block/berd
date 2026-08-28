//! Remote SSH backends: a detached `goose serve` daemon per host, reached
//! through an SSH local port-forward.
//!
//! Lifecycle model (the daemon is the durable half, the tunnel the cheap one):
//! - `connect` ensures the remote daemon (reusing a healthy one recorded in
//!   the remote state dir), reserves a local port, spawns the forwarding ssh,
//!   and probes HTTP through it before reporting Ready.
//! - A supervisor watches each tunnel child. Unexpected death triggers up to
//!   [`MAX_RECONNECT_ATTEMPTS`] re-establish rounds with exponential backoff;
//!   success hands off to a fresh supervisor, exhaustion marks the backend
//!   Disconnected. The daemon — and any remote sessions — survive throughout.
//! - `disconnect` kills only the tunnel. `shutdown` also stops the remote
//!   daemon. App exit kills all tunnels and leaves daemons running on purpose.
//!
//! Every state transition is emitted as [`REMOTE_BACKEND_STATUS_EVENT`] so the
//! renderer can mirror per-host status without polling.

pub(crate) mod daemon;
pub(crate) mod error;
pub(crate) mod host;
pub(crate) mod ssh;
pub(crate) mod ssh_config;
pub(crate) mod tunnel;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::services::acp::goose_serve::{
    acp_websocket_url, reserve_free_port, TAURI_WEBVIEW_ORIGIN,
};
use crate::services::diagnostic_log::{self, DiagnosticCategory, DiagnosticLevel};
use crate::services::dir_env;
use crate::services::process;

use daemon::RemoteDaemonInfo;
pub use error::{RemoteBackendError, RemoteBackendErrorKind};
pub use host::RemoteHostSpec;

pub const REMOTE_BACKEND_STATUS_EVENT: &str = "berd:remote-backend-status";

const MAX_RECONNECT_ATTEMPTS: u32 = 5;
const RECONNECT_BACKOFF_CAP: Duration = Duration::from_secs(30);
/// A reconnect only resets the attempt budget after the tunnel stays up this
/// long. Without the gate, a tunnel that dies seconds after every reconnect
/// would loop forever instead of converging on Disconnected.
const RECONNECT_STABLE_UPTIME: Duration = Duration::from_secs(60);

#[derive(Clone, Debug, Serialize)]
#[serde(
    tag = "state",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum RemoteBackendState {
    Connecting,
    Ready {
        ws_url: String,
        http_base_url: String,
        local_port: u16,
    },
    Reconnecting {
        attempt: u32,
        error: RemoteBackendError,
    },
    Disconnected,
    Failed {
        error: RemoteBackendError,
    },
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteBackendStatus {
    pub host: String,
    #[serde(flatten)]
    pub state: RemoteBackendState,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteBackendConnection {
    pub ws_url: String,
    pub http_base_url: String,
    pub secret_key: String,
    pub local_port: u16,
    pub goose_version: String,
    pub daemon_reused: bool,
}

#[derive(Default)]
pub struct RemoteBackendRegistry {
    slots: Mutex<HashMap<String, Arc<HostSlot>>>,
}

struct HostSlot {
    key: String,
    spec: RemoteHostSpec,
    /// Serializes establish attempts (user connects and supervisor
    /// reconnects) per host.
    connect_lock: tokio::sync::Mutex<()>,
    shared: Mutex<SlotShared>,
}

struct SlotShared {
    state: RemoteBackendState,
    /// Monotonic ownership token: each successful establish bumps it, and a
    /// supervisor only acts while its own generation is current. Explicit
    /// disconnects bump it to strand any racing supervisor.
    generation: u64,
    daemon: Option<RemoteDaemonInfo>,
    local_port: Option<u16>,
    tunnel_pid: Option<u32>,
}

impl RemoteBackendRegistry {
    fn slot(&self, spec: &RemoteHostSpec) -> Arc<HostSlot> {
        let mut slots = self.slots.lock().expect("remote backend registry poisoned");
        Arc::clone(slots.entry(spec.key()).or_insert_with(|| {
            Arc::new(HostSlot {
                key: spec.key(),
                spec: spec.clone(),
                connect_lock: tokio::sync::Mutex::new(()),
                shared: Mutex::new(SlotShared {
                    state: RemoteBackendState::Disconnected,
                    generation: 0,
                    daemon: None,
                    local_port: None,
                    tunnel_pid: None,
                }),
            })
        }))
    }

    fn existing_slot(&self, key: &str) -> Option<Arc<HostSlot>> {
        self.slots
            .lock()
            .expect("remote backend registry poisoned")
            .get(key)
            .cloned()
    }

    pub fn snapshot(&self) -> Vec<RemoteBackendStatus> {
        let slots = self.slots.lock().expect("remote backend registry poisoned");
        slots
            .values()
            .map(|slot| RemoteBackendStatus {
                host: slot.key.clone(),
                state: slot.shared.lock().expect("slot poisoned").state.clone(),
            })
            .collect()
    }

    /// Best-effort synchronous tunnel teardown for app exit. Daemons are left
    /// running deliberately: surviving the client is the feature.
    pub fn kill_all_tunnels(&self) {
        let slots = self.slots.lock().expect("remote backend registry poisoned");
        for slot in slots.values() {
            let mut shared = slot.shared.lock().expect("slot poisoned");
            shared.generation += 1;
            if let Some(pid) = shared.tunnel_pid.take() {
                kill_tunnel_pid(pid);
            }
        }
    }
}

fn kill_tunnel_pid(pid: u32) {
    #[cfg(unix)]
    {
        if let Some(pid) = process::pid_t_from_u32(pid) {
            process::terminate_process(pid);
        }
    }
    #[cfg(windows)]
    {
        use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
        let mut system = System::new();
        let pid = Pid::from_u32(pid);
        system.refresh_processes_specifics(
            ProcessesToUpdate::Some(&[pid]),
            true,
            ProcessRefreshKind::nothing(),
        );
        if let Some(found) = system.process(pid) {
            found.kill();
        }
    }
}

fn set_state(app: &AppHandle, slot: &HostSlot, state: RemoteBackendState) {
    {
        let mut shared = slot.shared.lock().expect("slot poisoned");
        shared.state = state.clone();
    }
    emit_status(app, &slot.key, &state);
}

fn emit_status(app: &AppHandle, host: &str, state: &RemoteBackendState) {
    let payload = RemoteBackendStatus {
        host: host.to_string(),
        state: state.clone(),
    };
    if let Err(error) = app.emit(REMOTE_BACKEND_STATUS_EVENT, &payload) {
        log::warn!("failed to emit {REMOTE_BACKEND_STATUS_EVENT}: {error}");
    }
}

fn record_diagnostic(level: DiagnosticLevel, event: &str, host: &str, detail: Option<&str>) {
    let mut fields = diagnostic_log::fields([("host", host.into())]);
    if let Some(detail) = detail {
        fields.insert("detail".to_string(), detail.into());
    }
    diagnostic_log::record_event(
        level,
        DiagnosticCategory::RemoteBackend,
        event,
        None,
        fields,
    );
}

/// Extra args the remote `goose serve` needs so the packaged app's webview
/// origin passes the server's origin allowlist (mirrors the local spawn).
fn extra_serve_args() -> Vec<String> {
    if cfg!(debug_assertions) {
        Vec::new()
    } else {
        vec![
            "--allowed-origin".to_string(),
            TAURI_WEBVIEW_ORIGIN.to_string(),
        ]
    }
}

fn connection_from_shared(shared: &SlotShared) -> Option<RemoteBackendConnection> {
    let daemon = shared.daemon.as_ref()?;
    let local_port = shared.local_port?;
    if let RemoteBackendState::Ready {
        ws_url,
        http_base_url,
        ..
    } = &shared.state
    {
        Some(RemoteBackendConnection {
            ws_url: ws_url.clone(),
            http_base_url: http_base_url.clone(),
            secret_key: daemon.secret.clone(),
            local_port,
            goose_version: daemon.goose_version.clone(),
            daemon_reused: daemon.reused,
        })
    } else {
        None
    }
}

pub async fn connect(
    app: &AppHandle,
    registry: &RemoteBackendRegistry,
    host_input: &str,
) -> Result<RemoteBackendConnection, RemoteBackendError> {
    let aliases = ssh_config::load_ssh_config_hosts();
    let spec = RemoteHostSpec::parse(host_input, &aliases)?;
    let slot = registry.slot(&spec);

    let _guard = slot.connect_lock.lock().await;

    if let Some(existing) = connection_from_shared(&slot.shared.lock().expect("slot poisoned")) {
        return Ok(existing);
    }

    set_state(app, &slot, RemoteBackendState::Connecting);
    record_diagnostic(DiagnosticLevel::Info, "connect_start", &slot.key, None);

    match establish(app, &slot, 0).await {
        Ok(connection) => {
            record_diagnostic(DiagnosticLevel::Info, "connect_success", &slot.key, None);
            Ok(connection)
        }
        Err(error) => {
            record_diagnostic(
                DiagnosticLevel::Error,
                "connect_failed",
                &slot.key,
                Some(&error.message),
            );
            set_state(
                app,
                &slot,
                RemoteBackendState::Failed {
                    error: error.clone(),
                },
            );
            Err(error)
        }
    }
}

/// Establish daemon + tunnel and hand the tunnel to a fresh supervisor.
/// Caller must hold the slot's connect lock. `prior_attempts` carries the
/// reconnect budget already spent into the next supervisor so a flapping
/// tunnel cannot reset it (see [`RECONNECT_STABLE_UPTIME`]).
async fn establish(
    app: &AppHandle,
    slot: &Arc<HostSlot>,
    prior_attempts: u32,
) -> Result<RemoteBackendConnection, RemoteBackendError> {
    let shell_env = dir_env::capture_home_interactive_env().await;

    let daemon_info = daemon::ensure_daemon(&slot.spec, &shell_env, &extra_serve_args()).await?;

    let local_port = reserve_free_port().map_err(|error| {
        RemoteBackendError::new(RemoteBackendErrorKind::LocalPortBindFailed, error)
    })?;

    let mut tunnel = tunnel::spawn_tunnel(&slot.spec, &shell_env, local_port, daemon_info.port)?;
    tunnel::wait_for_tunnel_ready(local_port, &mut tunnel).await?;

    let ws_url = acp_websocket_url(local_port, &daemon_info.secret);
    let http_base_url = format!("http://127.0.0.1:{local_port}");
    let state = RemoteBackendState::Ready {
        ws_url: ws_url.clone(),
        http_base_url: http_base_url.clone(),
        local_port,
    };

    let connection = RemoteBackendConnection {
        ws_url,
        http_base_url,
        secret_key: daemon_info.secret.clone(),
        local_port,
        goose_version: daemon_info.goose_version.clone(),
        daemon_reused: daemon_info.reused,
    };

    let generation = {
        let mut shared = slot.shared.lock().expect("slot poisoned");
        shared.generation += 1;
        shared.daemon = Some(daemon_info);
        shared.local_port = Some(local_port);
        shared.tunnel_pid = tunnel.child.id();
        shared.state = state.clone();
        shared.generation
    };
    emit_status(app, &slot.key, &state);

    spawn_supervisor(
        app.clone(),
        Arc::clone(slot),
        tunnel,
        generation,
        prior_attempts,
    );

    Ok(connection)
}

/// Watch one tunnel child. On unexpected death, try to re-establish (each
/// success spawns the next supervisor); on exhaustion mark Disconnected.
fn spawn_supervisor(
    app: AppHandle,
    slot: Arc<HostSlot>,
    mut tunnel: tunnel::TunnelProcess,
    generation: u64,
    prior_attempts: u32,
) {
    tauri::async_runtime::spawn(async move {
        let established_at = tokio::time::Instant::now();
        let status = tunnel.child.wait().await;

        let is_current = {
            let shared = slot.shared.lock().expect("slot poisoned");
            shared.generation == generation
        };
        if !is_current {
            // Explicit disconnect, app exit, or a newer establish owns the
            // slot now; this watcher is history.
            return;
        }

        let exit_detail = match status {
            Ok(status) => status.to_string(),
            Err(error) => error.to_string(),
        };
        log::warn!(
            "[remote-backend] tunnel to {} closed unexpectedly ({exit_detail}); reconnecting",
            slot.key
        );
        record_diagnostic(
            DiagnosticLevel::Warn,
            "tunnel_closed",
            &slot.key,
            Some(&exit_detail),
        );

        let mut last_error = RemoteBackendError::new(
            RemoteBackendErrorKind::TunnelClosed,
            format!("ssh tunnel closed ({exit_detail})"),
        );

        // Stability gate: only a tunnel that stayed up earns a fresh budget.
        let start_attempt = if established_at.elapsed() >= RECONNECT_STABLE_UPTIME {
            1
        } else {
            prior_attempts.saturating_add(1)
        };
        if start_attempt > MAX_RECONNECT_ATTEMPTS {
            record_diagnostic(
                DiagnosticLevel::Error,
                "reconnect_exhausted",
                &slot.key,
                Some(&last_error.message),
            );
            set_state(&app, &slot, RemoteBackendState::Disconnected);
            return;
        }

        for attempt in start_attempt..=MAX_RECONNECT_ATTEMPTS {
            set_state(
                &app,
                &slot,
                RemoteBackendState::Reconnecting {
                    attempt,
                    error: last_error.clone(),
                },
            );

            let backoff = Duration::from_secs(1 << (attempt - 1)).min(RECONNECT_BACKOFF_CAP);
            tokio::time::sleep(backoff).await;

            let _guard = slot.connect_lock.lock().await;
            {
                let shared = slot.shared.lock().expect("slot poisoned");
                if shared.generation != generation {
                    // Someone else (user connect, disconnect, exit) took over
                    // while we were backing off.
                    return;
                }
            }

            match establish(&app, &slot, attempt).await {
                Ok(_) => {
                    record_diagnostic(DiagnosticLevel::Info, "reconnect_success", &slot.key, None);
                    return;
                }
                Err(error) => {
                    log::warn!(
                        "[remote-backend] reconnect attempt {attempt} to {} failed: {}",
                        slot.key,
                        error.message
                    );
                    last_error = error;
                }
            }
        }

        record_diagnostic(
            DiagnosticLevel::Error,
            "reconnect_exhausted",
            &slot.key,
            Some(&last_error.message),
        );
        set_state(&app, &slot, RemoteBackendState::Disconnected);
    });
}

/// Kill the tunnel; the remote daemon keeps running.
pub fn disconnect(app: &AppHandle, registry: &RemoteBackendRegistry, host_input: &str) {
    // Normalize through the parser when possible so `damien@devbox:2222` and
    // its parsed key line up; fall back to the raw string for exact keys.
    let host_key = RemoteHostSpec::parse(host_input, &ssh_config::load_ssh_config_hosts())
        .map(|spec| spec.key())
        .unwrap_or_else(|_| host_input.trim().to_string());
    let Some(slot) = registry.existing_slot(&host_key) else {
        return;
    };
    {
        let mut shared = slot.shared.lock().expect("slot poisoned");
        shared.generation += 1;
        if let Some(pid) = shared.tunnel_pid.take() {
            kill_tunnel_pid(pid);
        }
        shared.local_port = None;
    }
    set_state(app, &slot, RemoteBackendState::Disconnected);
    record_diagnostic(DiagnosticLevel::Info, "disconnected", &host_key, None);
}

/// Stop the remote daemon, then drop the tunnel.
pub async fn shutdown(
    app: &AppHandle,
    registry: &RemoteBackendRegistry,
    host_input: &str,
) -> Result<(), RemoteBackendError> {
    let aliases = ssh_config::load_ssh_config_hosts();
    let spec = RemoteHostSpec::parse(host_input, &aliases)?;
    let shell_env = dir_env::capture_home_interactive_env().await;
    daemon::shutdown_daemon(&spec, &shell_env).await?;
    disconnect(app, registry, &spec.key());
    record_diagnostic(DiagnosticLevel::Info, "daemon_shutdown", &spec.key(), None);
    Ok(())
}

pub async fn check_host(
    host_input: &str,
) -> Result<Vec<daemon::RemoteToolProbe>, RemoteBackendError> {
    let aliases = ssh_config::load_ssh_config_hosts();
    let spec = RemoteHostSpec::parse(host_input, &aliases)?;
    let shell_env = dir_env::capture_home_interactive_env().await;
    daemon::check_host(&spec, &shell_env).await
}

pub async fn list_remote_dir(
    host_input: &str,
    path: &str,
) -> Result<daemon::RemoteDirListing, RemoteBackendError> {
    let aliases = ssh_config::load_ssh_config_hosts();
    let spec = RemoteHostSpec::parse(host_input, &aliases)?;
    let shell_env = dir_env::capture_home_interactive_env().await;
    daemon::list_remote_dir(&spec, &shell_env, path).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extra_serve_args_carry_webview_origin_in_release_only() {
        let args = extra_serve_args();
        if cfg!(debug_assertions) {
            assert!(args.is_empty());
        } else {
            assert_eq!(args, vec!["--allowed-origin", TAURI_WEBVIEW_ORIGIN]);
        }
    }

    #[test]
    fn ready_state_serializes_with_camel_case_tag_and_fields() {
        let state = RemoteBackendState::Ready {
            ws_url: "ws://127.0.0.1:1/acp?token=x".to_string(),
            http_base_url: "http://127.0.0.1:1".to_string(),
            local_port: 1,
        };
        let json = serde_json::to_value(&state).unwrap();
        assert_eq!(json["state"], "ready");
        assert!(json["wsUrl"].is_string());
        assert!(json["httpBaseUrl"].is_string());
        assert_eq!(json["localPort"], 1);
    }

    #[test]
    fn status_payload_flattens_state() {
        let status = RemoteBackendStatus {
            host: "devbox".to_string(),
            state: RemoteBackendState::Connecting,
        };
        let json = serde_json::to_value(&status).unwrap();
        assert_eq!(json["host"], "devbox");
        assert_eq!(json["state"], "connecting");
    }

    #[test]
    fn snapshot_reports_registered_slots() {
        let registry = RemoteBackendRegistry::default();
        let spec = RemoteHostSpec::parse("devbox", &[]).unwrap();
        let _slot = registry.slot(&spec);
        let snapshot = registry.snapshot();
        assert_eq!(snapshot.len(), 1);
        assert_eq!(snapshot[0].host, "devbox");
    }
}
