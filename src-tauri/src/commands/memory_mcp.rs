//! Frontend control over the memory MCP server registration.
//!
//! The Settings → Memory toggle calls `set_memory_mcp_enabled`. Off writes
//! a flag file in app data; `memory_mcp::ensure_fragment` checks it at
//! goosed spawn time and skips registration entirely — the memory tools
//! don't exist in sessions while memory is off. On removes the flag.
//!
//! Note: sessions already running keep their current toolset until their
//! goosed restarts; the preamble (which is per-send) goes quiet
//! immediately, so agents stop being told about memory right away.

use std::fs;

use tauri::Manager;

use crate::services::memory_mcp::disabled_flag_path;

#[tauri::command]
pub async fn set_memory_mcp_enabled(
    app_handle: tauri::AppHandle,
    enabled: bool,
) -> Result<(), String> {
    let app_data_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("No app data dir: {e}"))?;
    let flag = disabled_flag_path(&app_data_dir);

    if enabled {
        match fs::remove_file(&flag) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(format!("Couldn't clear the memory-off flag: {e}")),
        }
    } else {
        fs::create_dir_all(&app_data_dir)
            .map_err(|e| format!("Couldn't create app data dir: {e}"))?;
        fs::write(&flag, b"memory disabled via Settings\n")
            .map_err(|e| format!("Couldn't write the memory-off flag: {e}"))
    }
}
