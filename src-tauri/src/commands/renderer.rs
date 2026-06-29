//! Frontend-facing renderer telemetry command.
//!
//! Lets the web UI forward lifecycle signals it can observe (e.g. an
//! unexpected page reload after a renderer reap) into `berd.log`, alongside
//! the backend's `renderer_monitor` memory samples.

/// Append a renderer lifecycle event from the frontend to the app log.
#[tauri::command]
pub fn log_renderer_event(level: String, message: String) {
    match level.as_str() {
        "error" => log::error!("[renderer] {message}"),
        "warn" => log::warn!("[renderer] {message}"),
        _ => log::info!("[renderer] {message}"),
    }
}
