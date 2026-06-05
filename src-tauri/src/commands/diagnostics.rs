use crate::services::diagnostic_log::{self, DiagnosticEventInput};
use crate::services::distro_bundle::DistroBundleState;
use crate::services::kgoose::{self, KgooseProbeResult};
use tauri::State;

#[tauri::command]
pub async fn probe_kgoose_connectivity(
    state: State<'_, DistroBundleState>,
) -> Result<KgooseProbeResult, String> {
    kgoose::probe_connectivity(state.inner()).await
}

#[tauri::command]
pub fn write_diagnostic_event(input: DiagnosticEventInput) -> Result<(), String> {
    diagnostic_log::write_event(input)
}
