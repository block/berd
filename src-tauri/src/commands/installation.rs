use tauri::State;

use crate::services::installation_cohort::{
    InstallationCohort, InstallationCohortReadiness, InstallationCohortState,
};

#[tauri::command]
pub async fn get_installation_cohort(
    state: State<'_, InstallationCohortState>,
) -> Result<InstallationCohort, String> {
    let mut receiver = state.0.clone();
    drop(state);
    loop {
        let readiness = *receiver.borrow_and_update();
        if let InstallationCohortReadiness::Ready(cohort) = readiness {
            return Ok(cohort);
        }
        if receiver.changed().await.is_err() {
            return Ok(InstallationCohort::Unknown);
        }
    }
}
