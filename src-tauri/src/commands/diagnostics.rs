use crate::commands::runtime_config::RuntimeConfigState;
use crate::services::diagnostic_log::{self, DiagnosticEventInput};
use crate::services::distro_bundle::DistroBundleState;
use crate::services::kgoose::{KgooseContext, KgooseProbeResult};
use tauri::State;

#[tauri::command]
pub async fn probe_kgoose_connectivity(
    state: State<'_, DistroBundleState>,
    runtime_config_state: State<'_, RuntimeConfigState>,
) -> Result<KgooseProbeResult, String> {
    let runtime_config = runtime_config_state.ready_config(state.inner()).await?;
    let kgoose = KgooseContext::new(state.inner(), &runtime_config);
    kgoose.probe_connectivity().await
}

#[tauri::command]
pub fn write_diagnostic_event(input: DiagnosticEventInput) -> Result<(), String> {
    diagnostic_log::write_event(input)
}
