//! Registers Berd's memory MCP server with goose sessions.
//!
//! The server ships as a bundled sidecar (`berd-memory-mcp`). At goosed
//! spawn time we write a small goose config fragment into app data that
//! registers it as a stdio extension, and hand that fragment to goosed via
//! `GOOSE_ADDITIONAL_CONFIG_FILES` — the same mechanism the distro bundle
//! config uses. The binary path is resolved per machine at spawn time, so
//! the fragment is never stale after an app move or update.
//!
//! The Settings → Memory toggle controls a disabled flag file here (via
//! the `set_memory_mcp_enabled` command). Memory off means the fragment
//! isn't offered at all — the tools don't exist in the session, which is
//! the cleanest possible off state.

use std::fs;
use std::path::{Path, PathBuf};

use tauri::Manager;

const FRAGMENT_FILE: &str = "memory-mcp.goose.yaml";
const DISABLED_FLAG: &str = "memory-mcp-disabled";

/// Env override for dev builds, exported by `just dev` (the workspace crate
/// isn't built by `tauri dev` and externalBin is blanked in dev config).
const BIN_ENV: &str = "BERD_MEMORY_MCP_BIN";

fn binary_name() -> &'static str {
    if cfg!(windows) {
        "berd-memory-mcp.exe"
    } else {
        "berd-memory-mcp"
    }
}

fn resolve_binary() -> Option<PathBuf> {
    if let Ok(override_path) = std::env::var(BIN_ENV) {
        if !override_path.is_empty() {
            let path = PathBuf::from(override_path);
            if path.exists() {
                return Some(path);
            }
        }
    }
    let exe = std::env::current_exe().ok()?;
    let candidate = exe.parent()?.join(binary_name());
    candidate.exists().then_some(candidate)
}

pub(crate) fn disabled_flag_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(DISABLED_FLAG)
}

fn render_fragment(binary: &Path, off_flag: &Path) -> String {
    // Goose stdio extension entry, same shape user configs use. The cmd is
    // an absolute path so no PATH games are needed. BERD_MEMORY_OFF_FLAG
    // lets the server enforce the Settings toggle on every tool call —
    // including sessions that were already running when it flipped.
    format!(
        concat!(
            "extensions:\n",
            "  berd_memory:\n",
            "    enabled: true\n",
            "    type: stdio\n",
            "    name: Berd memory\n",
            "    description: The user's memory — durable preferences and topic files they own. Anything saved is shown to them right away and they can delete it.\n",
            "    cmd: {cmd}\n",
            "    args: []\n",
            "    envs:\n",
            "      BERD_MEMORY_OFF_FLAG: {flag}\n",
            "    env_keys: []\n",
            "    timeout: 60\n",
        ),
        cmd = serde_json::to_string(&binary.to_string_lossy()).unwrap_or_default(),
        flag = serde_json::to_string(&off_flag.to_string_lossy()).unwrap_or_default(),
    )
}

/// Write (or refresh) the config fragment and return its path, or `None`
/// when memory is toggled off or the binary can't be found. Best-effort:
/// any failure returns `None` and goosed spawns without memory tools —
/// never a blocked session.
pub(crate) fn ensure_fragment(app_handle: &tauri::AppHandle) -> Option<PathBuf> {
    let app_data_dir = match app_handle.path().app_data_dir() {
        Ok(dir) => dir,
        Err(error) => {
            log::warn!("memory-mcp: no app data dir, skipping registration: {error}");
            return None;
        }
    };

    if disabled_flag_path(&app_data_dir).exists() {
        return None;
    }

    let Some(binary) = resolve_binary() else {
        log::warn!("memory-mcp: server binary not found, skipping registration");
        return None;
    };

    let fragment = render_fragment(&binary, &disabled_flag_path(&app_data_dir));
    let path = app_data_dir.join(FRAGMENT_FILE);
    if let Err(error) = fs::create_dir_all(&app_data_dir) {
        log::warn!("memory-mcp: couldn't create app data dir: {error}");
        return None;
    }
    // Skip the write when current — goosed spawns shouldn't churn mtimes.
    if fs::read_to_string(&path).ok().as_deref() != Some(fragment.as_str()) {
        if let Err(error) = fs::write(&path, &fragment) {
            log::warn!("memory-mcp: couldn't write config fragment: {error}");
            return None;
        }
    }
    Some(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fragment_registers_a_stdio_extension_with_absolute_cmd() {
        let fragment = render_fragment(
            Path::new("/Applications/Berd.app/Contents/MacOS/berd-memory-mcp"),
            Path::new("/appdata/memory-mcp-disabled"),
        );
        assert!(fragment.contains("berd_memory:"));
        assert!(fragment.contains("type: stdio"));
        assert!(fragment.contains("\"/Applications/Berd.app/Contents/MacOS/berd-memory-mcp\""));
        assert!(fragment.contains("enabled: true"));
    }

    #[test]
    fn fragment_quotes_paths_with_spaces() {
        let fragment = render_fragment(
            Path::new("/Users/someone/My Apps/berd-memory-mcp"),
            Path::new("/appdata/memory-mcp-disabled"),
        );
        assert!(fragment.contains("\"/Users/someone/My Apps/berd-memory-mcp\""));
    }

    #[test]
    fn fragment_exports_the_off_flag_env() {
        let fragment = render_fragment(
            Path::new("/bin/berd-memory-mcp"),
            Path::new("/appdata/memory-mcp-disabled"),
        );
        assert!(fragment.contains("BERD_MEMORY_OFF_FLAG: \"/appdata/memory-mcp-disabled\""));
    }
}
