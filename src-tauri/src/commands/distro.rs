use crate::{
    commands::runtime_config::RuntimeConfigState,
    services::distro_bundle::{DistroBundleInfo, DistroBundleState},
};
use tauri::State;

#[tauri::command]
pub async fn get_distro_bundle(
    state: State<'_, DistroBundleState>,
    runtime_config_state: State<'_, RuntimeConfigState>,
) -> Result<DistroBundleInfo, String> {
    let runtime_config = runtime_config_state.ready_config(state.inner()).await?;
    Ok(state.info(runtime_config.kgoose.as_ref()))
}
