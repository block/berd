mod client;

use crate::commands::runtime_config::RuntimeConfigState;
use crate::services::distro_bundle::DistroBundleState;
use crate::services::kgoose::KgooseContext;
use client::{delete_oauth_extension, list_oauth_extensions};
use serde_json::Value;
use tauri::State;

#[tauri::command]
pub async fn list_connections(
    state: State<'_, DistroBundleState>,
    runtime_config_state: State<'_, RuntimeConfigState>,
) -> Result<Value, String> {
    let runtime_config = runtime_config_state.ready_config(state.inner()).await?;
    let kgoose = KgooseContext::new(state.inner(), &runtime_config);
    list_oauth_extensions(&kgoose).await
}

#[tauri::command]
pub async fn disconnect_connection(
    state: State<'_, DistroBundleState>,
    runtime_config_state: State<'_, RuntimeConfigState>,
    extension: String,
) -> Result<Value, String> {
    let runtime_config = runtime_config_state.ready_config(state.inner()).await?;
    let kgoose = KgooseContext::new(state.inner(), &runtime_config);
    delete_oauth_extension(&kgoose, &extension).await
}
