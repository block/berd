use berd_monitor::RunningMonitorDescriptor;

#[tauri::command]
pub async fn get_running_monitors() -> Result<Vec<RunningMonitorDescriptor>, String> {
    tauri::async_runtime::spawn_blocking(berd_monitor::get_running_monitors)
        .await
        .map_err(|error| format!("join monitor scanner: {error}"))?
        .map_err(|error| format!("scan running monitors: {error}"))
}
