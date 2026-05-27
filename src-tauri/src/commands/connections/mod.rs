mod client;

use crate::services::distro_bundle::DistroBundleState;
use client::list_oauth_extensions;
use serde_json::Value;
use tauri::State;

#[tauri::command]
pub async fn list_connections(state: State<'_, DistroBundleState>) -> Result<Value, String> {
    list_oauth_extensions(state.inner()).await
}
