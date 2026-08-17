//! Stale berdctl discovery-file cleanup.
//!
//! Each app instance's berdctl broker writes a discovery file at
//! `<app_data_dir>/berdctl/control-<app_pid>.json` and deletes it on
//! stop/exit. A crashed instance leaves its file behind (possibly as a
//! legacy `control-<pid>.json.tmp` or current
//! `control-<pid>.json.<nonce>.tmp` orphan from a crash mid-write); this sweep
//! removes files whose owning app process is no longer alive. The directory
//! and filename formats are owned by the plugin's discovery module. Compiled
//! unconditionally — stale files must be cleaned even by builds where the
//! berdctl feature is off.

use std::path::Path;

use tauri_plugin_berdctl::{owner_pid_from_discovery_file_name, DISCOVERY_DIR_NAME};

use crate::services::process::{pid_t_from_u32, process_is_alive};

/// Remove discovery files left behind by dead app instances. The live
/// instances' files (including this one's) are left alone; this instance's
/// plugin owns its own file's lifecycle.
pub fn sweep_stale_discovery_files(app_data_dir: &Path) {
    let dir = app_data_dir.join(DISCOVERY_DIR_NAME);
    let entries = match std::fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return,
        Err(error) => {
            log::warn!(
                "Failed to read berdctl discovery dir {}: {error}",
                dir.display()
            );
            return;
        }
    };

    for entry in entries.flatten() {
        let Some(owner_pid) = entry
            .file_name()
            .to_str()
            .and_then(owner_pid_from_discovery_file_name)
        else {
            continue;
        };
        if owner_pid == std::process::id() {
            continue;
        }

        let alive = pid_t_from_u32(owner_pid).is_some_and(process_is_alive);
        if alive {
            continue;
        }

        let path = entry.path();
        log::info!("Removing stale berdctl discovery file {}", path.display());
        if let Err(error) = std::fs::remove_file(&path) {
            log::warn!(
                "Failed to remove stale berdctl discovery file {}: {error}",
                path.display()
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use tempfile::tempdir;

    fn write_discovery_file(app_data_dir: &Path, name: &str) -> PathBuf {
        let dir = app_data_dir.join(DISCOVERY_DIR_NAME);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(name);
        std::fs::write(&path, "{}").unwrap();
        path
    }

    /// Spawn and reap a short-lived child to obtain a pid that is no longer
    /// alive.
    fn dead_pid() -> u32 {
        let mut child = std::process::Command::new("true").spawn().unwrap();
        let pid = child.id();
        child.wait().unwrap();
        pid
    }

    #[test]
    fn missing_dir_is_a_no_op() {
        let app_data_dir = tempdir().unwrap();
        sweep_stale_discovery_files(app_data_dir.path());
    }

    #[test]
    fn removes_dead_owner_files_and_keeps_live_and_own_files() {
        let app_data_dir = tempdir().unwrap();
        let gone = dead_pid();
        let dead = write_discovery_file(app_data_dir.path(), &format!("control-{gone}.json"));
        let dead_tmp =
            write_discovery_file(app_data_dir.path(), &format!("control-{gone}.json.tmp"));
        let dead_random_tmp = write_discovery_file(
            app_data_dir.path(),
            &format!("control-{gone}.json.0123456789abcdef0123456789abcdef.tmp"),
        );
        let own = write_discovery_file(
            app_data_dir.path(),
            &format!("control-{}.json", std::process::id()),
        );
        // pid 1 (launchd/init) is always alive.
        let live = write_discovery_file(app_data_dir.path(), "control-1.json");
        let unrelated = write_discovery_file(app_data_dir.path(), "notes.json");

        sweep_stale_discovery_files(app_data_dir.path());

        assert!(!dead.exists());
        assert!(!dead_tmp.exists());
        assert!(!dead_random_tmp.exists());
        assert!(own.exists());
        assert!(live.exists());
        assert!(unrelated.exists());
    }
}
