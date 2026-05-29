use crate::services::distro_bundle::DistroBundleState;
use crate::services::kgoose::{self, KgooseProbeResult};
use tauri::State;

#[tauri::command]
pub async fn probe_kgoose_connectivity(
    state: State<'_, DistroBundleState>,
) -> Result<KgooseProbeResult, String> {
    kgoose::probe_connectivity(state.inner()).await
}
