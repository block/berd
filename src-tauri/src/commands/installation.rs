use tauri::State;

use crate::services::installation_cohort::{InstallationCohort, InstallationCohortState};

#[tauri::command]
pub fn get_installation_cohort(state: State<'_, InstallationCohortState>) -> InstallationCohort {
    state.0
}
