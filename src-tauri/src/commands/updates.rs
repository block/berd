//! Commands backing the in-app update flow.

use tauri::AppHandle;

/// Relaunch step of the update flow. The updater installs the new version
/// into the running bundle's existing path, so an install that still carries
/// a legacy name (e.g. "Goose 2.app" from a pre-rename Managed Software
/// Center install) would keep that name after every update. This renames such
/// a bundle in place to `Berd.app`, schedules a relaunch from the renamed
/// path, and exits; it returns `false` when no rename applies (canonical or
/// user-customized names) and the caller should fall back to the standard
/// restart.
#[tauri::command]
pub fn finalize_update_relaunch(app: AppHandle) -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        let handled = crate::services::installer_media::relaunch_into_renamed_bundle()
            .map_err(|error| error.to_string())?;
        if handled {
            // The scheduled relauncher waits for this process to exit before
            // opening the renamed bundle; exit through Tauri so the
            // RunEvent::Exit cleanup (sidecars, terminals) still runs.
            app.exit(0);
        }
        Ok(handled)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Ok(false)
    }
}
