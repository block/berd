//! Renderer-facing commands for remote SSH backends.
//!
//! Thin wrappers over `services::remote_backend`: every command re-validates
//! the host string against freshly parsed ssh-config aliases before any ssh
//! argv is built, and errors cross the bridge as typed
//! `RemoteBackendError { kind, message }` values the UI can render actionably.

use tauri::{AppHandle, State};

use crate::services::remote_backend::{
    self, daemon::RemoteDirListing, daemon::RemoteToolProbe, RemoteBackendConnection,
    RemoteBackendError, RemoteBackendRegistry, RemoteBackendStatus,
};

#[tauri::command]
pub async fn list_ssh_config_hosts() -> Result<Vec<String>, RemoteBackendError> {
    Ok(
        tokio::task::spawn_blocking(remote_backend::ssh_config::load_ssh_config_hosts)
            .await
            .unwrap_or_default(),
    )
}

/// `goose_path` (`goosePath` on the wire) is the optional per-host goose binary
/// override: absolute or `~/`-prefixed, validated in Rust before any argv is
/// built. `None` keeps the remote login PATH lookup.
#[tauri::command]
pub async fn remote_backend_connect(
    app: AppHandle,
    registry: State<'_, RemoteBackendRegistry>,
    host: String,
    goose_path: Option<String>,
) -> Result<RemoteBackendConnection, RemoteBackendError> {
    remote_backend::connect(&app, &registry, &host, goose_path.as_deref()).await
}

#[tauri::command]
pub async fn remote_backend_disconnect(
    app: AppHandle,
    registry: State<'_, RemoteBackendRegistry>,
    host: String,
    expected_generation: Option<u64>,
) -> Result<(), RemoteBackendError> {
    remote_backend::disconnect_generation(&app, &registry, &host, expected_generation);
    Ok(())
}

#[tauri::command]
pub async fn remote_backend_shutdown(
    app: AppHandle,
    registry: State<'_, RemoteBackendRegistry>,
    host: String,
    expected_instance_token: Option<String>,
) -> Result<(), RemoteBackendError> {
    remote_backend::shutdown(&app, &registry, &host, expected_instance_token.as_deref()).await
}

#[tauri::command]
pub async fn list_remote_backends(
    registry: State<'_, RemoteBackendRegistry>,
) -> Result<Vec<RemoteBackendStatus>, RemoteBackendError> {
    Ok(registry.snapshot())
}

#[tauri::command]
pub async fn check_remote_host(
    host: String,
    goose_path: Option<String>,
) -> Result<Vec<RemoteToolProbe>, RemoteBackendError> {
    remote_backend::check_host(&host, goose_path.as_deref()).await
}

#[tauri::command]
pub async fn list_remote_dirs(
    host: String,
    path: String,
) -> Result<RemoteDirListing, RemoteBackendError> {
    remote_backend::list_remote_dir(&host, &path).await
}
