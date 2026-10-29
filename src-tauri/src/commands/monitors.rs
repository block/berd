use berd_monitor::RunningMonitorDescriptor;

#[tauri::command]
pub async fn get_running_monitors() -> Result<Vec<RunningMonitorDescriptor>, String> {
    tauri::async_runtime::spawn_blocking(berd_monitor::get_running_monitors)
        .await
        .map_err(|error| format!("join monitor scanner: {error}"))?
        .map_err(|error| format!("scan running monitors: {error}"))
}

#[tauri::command]
pub async fn stop_running_monitor(
    session_id: String,
    state_key: String,
    instance_id: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        berd_monitor::request_stop(&state_key, &session_id, Some(&instance_id))
    })
    .await
    .map_err(|error| format!("join monitor stop: {error}"))?
    .map_err(|error| format!("stop running monitor: {error}"))
}
