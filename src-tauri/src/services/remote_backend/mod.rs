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
//! A host may pin an optional goose binary path instead of the remote login
//! PATH lookup. The path is validated here before it reaches the bootstrap, is
//! remembered per slot so reconnects keep using it, and switching it forces a
//! fresh connect because the bootstrap restarts the remote daemon.
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
// Only the unix tunnel-kill path goes through the shared process helpers; the
// Windows branch talks to sysinfo directly.
#[cfg(unix)]
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
    pub incarnation: String,
    pub generation: u64,
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
    /// Unique identity for this registry slot. A forgotten host receives a
    /// new incarnation even when its per-slot generation restarts.
    pub incarnation: String,
    /// Slot generation that owns this tunnel. Callers use it to invalidate
    /// only the connection they established, never a newer replacement.
    pub generation: u64,
}

#[derive(Default)]
pub struct RemoteBackendRegistry {
    slots: Mutex<HashMap<String, Arc<HostSlot>>>,
}

struct HostSlot {
    key: String,
    spec: RemoteHostSpec,
    incarnation: String,
    /// Serializes establish attempts (user connects and supervisor
    /// reconnects) per host.
    connect_lock: tokio::sync::Mutex<()>,
    shared: Mutex<SlotShared>,
}

struct SlotShared {
    state: RemoteBackendState,
    /// Set before an inactive slot leaves the registry. Connect attempts that
    /// already retained its Arc must observe this tombstone after admission.
    forgotten: bool,
    /// Monotonic ownership token: each successful establish bumps it, and a
    /// supervisor only acts while its own generation is current. Explicit
    /// disconnects bump it to strand any racing supervisor.
    generation: u64,
    daemon: Option<RemoteDaemonInfo>,
    local_port: Option<u16>,
    tunnel_pid: Option<u32>,
    /// Validated goose binary override this slot connected with (`None` = the
    /// remote login PATH). Supervisor reconnects reuse it, and a connect that
    /// asks for a different one must not be served from cache.
    goose_path: Option<String>,
}

impl RemoteBackendRegistry {
    fn slot(&self, spec: &RemoteHostSpec) -> Arc<HostSlot> {
        let mut slots = self.slots.lock().expect("remote backend registry poisoned");
        Arc::clone(slots.entry(spec.key()).or_insert_with(|| {
            Arc::new(HostSlot {
                key: spec.key(),
                spec: spec.clone(),
                incarnation: uuid::Uuid::new_v4().to_string(),
                connect_lock: tokio::sync::Mutex::new(()),
                shared: Mutex::new(SlotShared {
                    state: RemoteBackendState::Disconnected,
                    forgotten: false,
                    generation: 0,
                    daemon: None,
                    local_port: None,
                    tunnel_pid: None,
                    goose_path: None,
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
            .map(|slot| {
                let shared = slot.shared.lock().expect("slot poisoned");
                RemoteBackendStatus {
                    host: slot.key.clone(),
                    incarnation: slot.incarnation.clone(),
                    generation: shared.generation,
                    state: shared.state.clone(),
                }
            })
            .collect()
    }

    /// Remove an inactive host slot from the registry. The exact key is used
    /// deliberately so malformed inputs from a failed connect can still be
    /// forgotten instead of having to pass host parsing again.
    pub async fn forget(&self, key: &str) -> bool {
        let Some(slot) = self.existing_slot(key) else {
            return true;
        };

        // Invalidate queued connection admission before waiting on the lock.
        // A current establish already holding the lock publishes Connecting,
        // so only an inactive slot can reach this point; a waiter that retained
        // the Arc must observe the tombstone when it eventually acquires.
        {
            let mut shared = slot.shared.lock().expect("slot poisoned");
            if !matches!(
                shared.state,
                RemoteBackendState::Disconnected | RemoteBackendState::Failed { .. }
            ) {
                return false;
            }
            shared.forgotten = true;
            shared.generation += 1;
        }

        let _guard = slot.connect_lock.lock().await;
        let mut slots = self.slots.lock().expect("remote backend registry poisoned");
        let Some(registered) = slots.get(key) else {
            return true;
        };
        if !Arc::ptr_eq(registered, &slot) {
            return false;
        }
        slots.remove(key);
        true
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
    let generation = {
        let mut shared = slot.shared.lock().expect("slot poisoned");
        shared.state = state.clone();
        shared.generation
    };
    emit_status(app, slot, generation, &state);
}

fn update_state_if_current(
    shared: &mut SlotShared,
    generation: u64,
    state: RemoteBackendState,
) -> bool {
    if shared.generation != generation {
        return false;
    }
    shared.state = state;
    true
}

/// Publish a supervisor-owned transition only while its generation still owns
/// the slot. Emitting while holding the same mutex keeps a later Disconnect
/// event ordered after this one instead of allowing a stale event to overtake it.
fn set_state_if_current(
    app: &AppHandle,
    slot: &HostSlot,
    generation: u64,
    state: RemoteBackendState,
) -> bool {
    let mut shared = slot.shared.lock().expect("slot poisoned");
    if !update_state_if_current(&mut shared, generation, state.clone()) {
        return false;
    }
    emit_status(app, slot, generation, &state);
    true
}

fn emit_status(app: &AppHandle, slot: &HostSlot, generation: u64, state: &RemoteBackendState) {
    let payload = RemoteBackendStatus {
        host: slot.key.clone(),
        incarnation: slot.incarnation.clone(),
        generation,
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

fn connection_from_shared(
    shared: &SlotShared,
    incarnation: &str,
) -> Option<RemoteBackendConnection> {
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
            incarnation: incarnation.to_string(),
            generation: shared.generation,
        })
    } else {
        None
    }
}

/// The slot's cached connection, but only when it was established with the
/// goose binary now being requested. A different override means the bootstrap
/// has to restart the remote daemon, so the cached tunnel is not an answer.
fn cached_connection(
    shared: &SlotShared,
    requested_goose_path: Option<&str>,
    incarnation: &str,
) -> Option<RemoteBackendConnection> {
    if shared.goose_path.as_deref() != requested_goose_path {
        return None;
    }
    connection_from_shared(shared, incarnation)
}

async fn acquire_connect_admission(
    slot: &HostSlot,
) -> Result<tokio::sync::MutexGuard<'_, ()>, RemoteBackendError> {
    let guard = slot.connect_lock.lock().await;
    if slot.shared.lock().expect("slot poisoned").forgotten {
        return Err(RemoteBackendError::internal(
            "remote connection attempt was superseded",
        ));
    }
    Ok(guard)
}

fn advance_generation_if_current(shared: &mut SlotShared, expected: u64) -> Option<u64> {
    if shared.generation != expected {
        return None;
    }
    shared.generation += 1;
    Some(shared.generation)
}

fn clear_tunnel_pid_if_current(shared: &mut SlotShared, generation: u64, pid: Option<u32>) -> bool {
    if shared.generation != generation {
        return false;
    }
    if shared.tunnel_pid == pid {
        shared.tunnel_pid = None;
    }
    true
}

pub async fn connect(
    app: &AppHandle,
    registry: &RemoteBackendRegistry,
    host_input: &str,
    goose_path: Option<&str>,
) -> Result<RemoteBackendConnection, RemoteBackendError> {
    let aliases = ssh_config::load_ssh_config_hosts();
    let spec = RemoteHostSpec::parse(host_input, &aliases)?;
    let goose_path = goose_path.map(daemon::normalize_goose_path).transpose()?;
    let slot = registry.slot(&spec);

    let _guard = acquire_connect_admission(&slot).await?;

    {
        let mut shared = slot.shared.lock().expect("slot poisoned");
        // Forget can tombstone an inactive slot after this connect acquires
        // admission but before it publishes Connecting.
        if shared.forgotten {
            return Err(RemoteBackendError::internal(
                "remote connection attempt was superseded",
            ));
        }
        if let Some(existing) = cached_connection(&shared, goose_path.as_deref(), &slot.incarnation)
        {
            return Ok(existing);
        }
        if shared.goose_path.as_deref() != goose_path.as_deref() {
            // A different goose binary was requested: the bootstrap will stop
            // the recorded daemon and start a fresh one on a new remote port,
            // so the current tunnel (and its supervisor) are already history.
            shared.generation += 1;
            if let Some(pid) = shared.tunnel_pid.take() {
                kill_tunnel_pid(pid);
            }
            shared.local_port = None;
            shared.daemon = None;
            shared.goose_path = goose_path;
        }
    }

    set_state(app, &slot, RemoteBackendState::Connecting);
    record_diagnostic(DiagnosticLevel::Info, "connect_start", &slot.key, None);

    let expected_generation = slot.shared.lock().expect("slot poisoned").generation;
    match establish(app, &slot, expected_generation, 0).await {
        Ok(Some(connection)) => {
            record_diagnostic(DiagnosticLevel::Info, "connect_success", &slot.key, None);
            Ok(connection)
        }
        Ok(None) => Err(RemoteBackendError::internal(
            "remote connection attempt was superseded",
        )),
        Err(error) => {
            record_diagnostic(
                DiagnosticLevel::Error,
                "connect_failed",
                &slot.key,
                Some(&error.message),
            );
            set_state_if_current(
                app,
                &slot,
                expected_generation,
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
/// `expected_generation` is the ownership token observed before asynchronous
/// setup began. `Ok(None)` means a disconnect or newer connection superseded
/// this attempt before it could publish Ready.
async fn establish(
    app: &AppHandle,
    slot: &Arc<HostSlot>,
    expected_generation: u64,
    prior_attempts: u32,
) -> Result<Option<RemoteBackendConnection>, RemoteBackendError> {
    let shell_env = dir_env::capture_home_interactive_env().await;

    // Reconnects reuse the binary the slot connected with, so a supervisor
    // never silently falls back to the PATH goose.
    let goose_path = slot
        .shared
        .lock()
        .expect("slot poisoned")
        .goose_path
        .clone();
    let daemon_info = daemon::ensure_daemon(
        &slot.spec,
        &shell_env,
        &extra_serve_args(),
        goose_path.as_deref(),
    )
    .await?;

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

    let tunnel_pid = tunnel.child.id();
    let generation = {
        let mut shared = slot.shared.lock().expect("slot poisoned");
        advance_generation_if_current(&mut shared, expected_generation).inspect(|_| {
            shared.daemon = Some(daemon_info.clone());
            shared.local_port = Some(local_port);
            shared.tunnel_pid = tunnel_pid;
            shared.state = state.clone();
        })
    };
    let Some(generation) = generation else {
        let _ = tunnel.child.start_kill();
        let _ = tunnel.child.wait().await;
        return Ok(None);
    };
    emit_status(app, slot, generation, &state);

    let connection = RemoteBackendConnection {
        ws_url,
        http_base_url,
        secret_key: daemon_info.secret.clone(),
        local_port,
        goose_version: daemon_info.goose_version.clone(),
        daemon_reused: daemon_info.reused,
        incarnation: slot.incarnation.clone(),
        generation,
    };

    spawn_supervisor(
        app.clone(),
        Arc::clone(slot),
        tunnel,
        generation,
        prior_attempts,
    );

    Ok(Some(connection))
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
        let tunnel_pid = tunnel.child.id();
        let status = tunnel.child.wait().await;

        let is_current = {
            let mut shared = slot.shared.lock().expect("slot poisoned");
            clear_tunnel_pid_if_current(&mut shared, generation, tunnel_pid)
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
            set_state_if_current(&app, &slot, generation, RemoteBackendState::Disconnected);
            return;
        }

        for attempt in start_attempt..=MAX_RECONNECT_ATTEMPTS {
            if !set_state_if_current(
                &app,
                &slot,
                generation,
                RemoteBackendState::Reconnecting {
                    attempt,
                    error: last_error.clone(),
                },
            ) {
                return;
            }

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

            match establish(&app, &slot, generation, attempt).await {
                Ok(Some(_)) => {
                    record_diagnostic(DiagnosticLevel::Info, "reconnect_success", &slot.key, None);
                    return;
                }
                Ok(None) => return,
                Err(error) => {
                    if slot.shared.lock().expect("slot poisoned").generation != generation {
                        return;
                    }
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
        set_state_if_current(&app, &slot, generation, RemoteBackendState::Disconnected);
    });
}

/// Disconnect only when `expected_generation` still owns the host slot. This
/// lets an initializer clean up work superseded while it was awaiting without
/// tearing down a newer connection that won the race.
pub fn disconnect_generation(
    app: &AppHandle,
    registry: &RemoteBackendRegistry,
    host_input: &str,
    expected_generation: Option<u64>,
) -> bool {
    // Normalize through the parser when possible so `damien@devbox:2222` and
    // its parsed key line up; fall back to the raw string for exact keys.
    let host_key = RemoteHostSpec::parse(host_input, &ssh_config::load_ssh_config_hosts())
        .map(|spec| spec.key())
        .unwrap_or_else(|_| host_input.trim().to_string());
    let Some(slot) = registry.existing_slot(&host_key) else {
        return false;
    };
    let disconnected_generation = {
        let mut shared = slot.shared.lock().expect("slot poisoned");
        if expected_generation.is_some_and(|expected| shared.generation != expected) {
            return false;
        }
        shared.generation += 1;
        if let Some(pid) = shared.tunnel_pid.take() {
            kill_tunnel_pid(pid);
        }
        shared.local_port = None;
        shared.generation
    };
    set_state_if_current(
        app,
        &slot,
        disconnected_generation,
        RemoteBackendState::Disconnected,
    );
    record_diagnostic(DiagnosticLevel::Info, "disconnected", &host_key, None);
    true
}

fn validate_shutdown_generation(
    slot: &HostSlot,
    expected_generation: Option<u64>,
) -> Result<(), RemoteBackendError> {
    let shared = slot.shared.lock().expect("slot poisoned");
    if expected_generation.is_some_and(|expected| shared.generation != expected) {
        return Err(RemoteBackendError::new(
            RemoteBackendErrorKind::DaemonChanged,
            "Remote backend changed before shutdown completed",
        ));
    }
    Ok(())
}

/// Stop the remote daemon, then drop the tunnel.
pub async fn shutdown(
    app: &AppHandle,
    registry: &RemoteBackendRegistry,
    host_input: &str,
    expected_instance_token: Option<&str>,
    expected_generation: Option<u64>,
) -> Result<(), RemoteBackendError> {
    let aliases = ssh_config::load_ssh_config_hosts();
    let spec = RemoteHostSpec::parse(host_input, &aliases)?;
    let slot = registry.slot(&spec);
    let shell_env = dir_env::capture_home_interactive_env().await;

    // Wait out any in-flight establish and validate the local owner before
    // touching either resource. Keep the tunnel intact until remote shutdown
    // succeeds: a daemon identity mismatch must not leave a dead local path
    // represented by the still-current Ready state.
    let _guard = slot.connect_lock.lock().await;
    validate_shutdown_generation(&slot, expected_generation)?;
    daemon::shutdown_daemon(&spec, &shell_env, expected_instance_token).await?;
    if !disconnect_generation(app, registry, &spec.key(), expected_generation) {
        return Err(RemoteBackendError::new(
            RemoteBackendErrorKind::DaemonChanged,
            "Remote backend changed before shutdown completed",
        ));
    }
    record_diagnostic(DiagnosticLevel::Info, "daemon_shutdown", &spec.key(), None);
    Ok(())
}

pub async fn check_host(
    host_input: &str,
    goose_path: Option<&str>,
) -> Result<Vec<daemon::RemoteToolProbe>, RemoteBackendError> {
    let aliases = ssh_config::load_ssh_config_hosts();
    let spec = RemoteHostSpec::parse(host_input, &aliases)?;
    let goose_path = goose_path.map(daemon::normalize_goose_path).transpose()?;
    let shell_env = dir_env::capture_home_interactive_env().await;
    daemon::check_host(&spec, &shell_env, goose_path.as_deref()).await
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
            incarnation: "slot-1".to_string(),
            generation: 7,
            state: RemoteBackendState::Connecting,
        };
        let json = serde_json::to_value(&status).unwrap();
        assert_eq!(json["host"], "devbox");
        assert_eq!(json["incarnation"], "slot-1");
        assert_eq!(json["generation"], 7);
        assert_eq!(json["state"], "connecting");
    }

    fn ready_shared(goose_path: Option<&str>) -> SlotShared {
        SlotShared {
            state: RemoteBackendState::Ready {
                ws_url: "ws://127.0.0.1:5000/acp?token=x".to_string(),
                http_base_url: "http://127.0.0.1:5000".to_string(),
                local_port: 5000,
            },
            forgotten: false,
            generation: 1,
            daemon: Some(RemoteDaemonInfo {
                pid: 10,
                port: 20,
                secret: "hush".to_string(),
                goose_version: "goose 1.0.0".to_string(),
                started_at: "0".to_string(),
                reused: false,
            }),
            local_port: Some(5000),
            tunnel_pid: Some(99),
            goose_path: goose_path.map(str::to_string),
        }
    }

    #[test]
    fn cached_connection_is_reused_for_the_same_goose_path() {
        assert!(cached_connection(&ready_shared(None), None, "slot-1").is_some());
        assert!(cached_connection(
            &ready_shared(Some("/opt/goose/bin/goose")),
            Some("/opt/goose/bin/goose"),
            "slot-1"
        )
        .is_some());
    }

    #[test]
    fn cached_connection_is_refused_for_a_different_goose_path() {
        // Adding, removing, or swapping an override all force a fresh connect
        // because the bootstrap restarts the remote daemon.
        assert!(
            cached_connection(&ready_shared(None), Some("/opt/goose/bin/goose"), "slot-1")
                .is_none()
        );
        assert!(
            cached_connection(&ready_shared(Some("/opt/goose/bin/goose")), None, "slot-1")
                .is_none()
        );
        assert!(cached_connection(
            &ready_shared(Some("/opt/goose/bin/goose")),
            Some("~/src/goose/target/release/goose"),
            "slot-1"
        )
        .is_none());
    }

    #[test]
    fn cached_connection_is_none_while_not_ready() {
        let mut shared = ready_shared(None);
        shared.state = RemoteBackendState::Connecting;
        assert!(cached_connection(&shared, None, "slot-1").is_none());
    }

    #[test]
    fn stale_establish_cannot_advance_generation() {
        let mut shared = ready_shared(None);
        shared.generation = 4;

        assert_eq!(advance_generation_if_current(&mut shared, 3), None);
        assert_eq!(shared.generation, 4);
        assert_eq!(advance_generation_if_current(&mut shared, 4), Some(5));
        assert_eq!(shared.generation, 5);
    }

    #[test]
    fn exited_tunnel_pid_is_cleared_only_by_its_current_supervisor() {
        let mut shared = ready_shared(None);

        assert!(clear_tunnel_pid_if_current(&mut shared, 1, Some(99)));
        assert_eq!(shared.tunnel_pid, None);

        shared.tunnel_pid = Some(100);
        assert!(!clear_tunnel_pid_if_current(&mut shared, 0, Some(100)));
        assert_eq!(shared.tunnel_pid, Some(100));
    }

    #[test]
    fn reconnecting_state_is_rejected_after_generation_changes() {
        let mut shared = ready_shared(None);
        shared.generation = 3;

        assert!(update_state_if_current(
            &mut shared,
            3,
            RemoteBackendState::Reconnecting {
                attempt: 1,
                error: RemoteBackendError::internal("closed"),
            },
        ));
        assert!(matches!(
            shared.state,
            RemoteBackendState::Reconnecting { attempt: 1, .. }
        ));

        shared.generation = 4;
        shared.state = RemoteBackendState::Disconnected;
        assert!(!update_state_if_current(
            &mut shared,
            3,
            RemoteBackendState::Reconnecting {
                attempt: 2,
                error: RemoteBackendError::internal("closed again"),
            },
        ));
        assert!(matches!(shared.state, RemoteBackendState::Disconnected));
    }

    #[test]
    fn shutdown_generation_mismatch_preserves_the_ready_tunnel() {
        let spec = RemoteHostSpec::parse("devbox", &[]).unwrap();
        let slot = HostSlot {
            key: spec.key(),
            spec,
            incarnation: "slot-1".to_string(),
            connect_lock: tokio::sync::Mutex::new(()),
            shared: Mutex::new(ready_shared(None)),
        };

        let error = validate_shutdown_generation(&slot, Some(2)).unwrap_err();
        assert_eq!(error.kind, RemoteBackendErrorKind::DaemonChanged);
        let shared = slot.shared.lock().expect("slot poisoned");
        assert_eq!(shared.generation, 1);
        assert_eq!(shared.tunnel_pid, Some(99));
        assert!(matches!(shared.state, RemoteBackendState::Ready { .. }));
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

    #[tokio::test]
    async fn forget_removes_inactive_slot_by_its_exact_key() {
        let registry = RemoteBackendRegistry::default();
        let spec = RemoteHostSpec::parse("devbox", &[]).unwrap();
        let slot = registry.slot(&spec);
        slot.shared.lock().expect("slot poisoned").state = RemoteBackendState::Failed {
            error: RemoteBackendError::internal("failed"),
        };

        assert!(registry.forget("devbox").await);
        assert!(registry.snapshot().is_empty());
    }

    #[tokio::test]
    async fn forget_preserves_active_slot() {
        let registry = RemoteBackendRegistry::default();
        let spec = RemoteHostSpec::parse("devbox", &[]).unwrap();
        let slot = registry.slot(&spec);
        slot.shared.lock().expect("slot poisoned").state = RemoteBackendState::Connecting;

        assert!(!registry.forget("devbox").await);
        assert_eq!(registry.snapshot().len(), 1);
    }

    #[tokio::test]
    async fn pending_connect_is_superseded_before_establishment_after_forget() {
        let registry = Arc::new(RemoteBackendRegistry::default());
        let spec = RemoteHostSpec::parse("devbox", &[]).unwrap();
        let admitted = registry.slot(&spec);
        let held = admitted.connect_lock.lock().await;

        let side_effect_reached = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let connect_slot = Arc::clone(&admitted);
        let connect_side_effect = Arc::clone(&side_effect_reached);
        let pending_connect = tokio::spawn(async move {
            let admission = acquire_connect_admission(&connect_slot).await;
            if admission.is_ok() {
                connect_side_effect.store(true, std::sync::atomic::Ordering::SeqCst);
            }
            admission.map(|_| ())
        });
        tokio::task::yield_now().await;

        let forget_registry = Arc::clone(&registry);
        let forgetting = tokio::spawn(async move { forget_registry.forget("devbox").await });
        for _ in 0..100 {
            if admitted.shared.lock().expect("slot poisoned").forgotten {
                break;
            }
            tokio::task::yield_now().await;
        }
        assert!(admitted.shared.lock().expect("slot poisoned").forgotten);

        drop(held);
        let connect_error = pending_connect.await.unwrap().unwrap_err();
        assert_eq!(
            connect_error.message,
            "remote connection attempt was superseded"
        );
        assert!(!side_effect_reached.load(std::sync::atomic::Ordering::SeqCst));
        assert!(forgetting.await.unwrap());
        assert!(registry.snapshot().is_empty());

        let replacement = registry.slot(&spec);
        assert!(!Arc::ptr_eq(&admitted, &replacement));
        assert!(!replacement.shared.lock().expect("slot poisoned").forgotten);
    }
}
