//! Registers Berd's memory MCP server with goose sessions.
//!
//! The server ships as a bundled sidecar (`berd-memory-mcp`). At goosed
//! spawn time we write a small goose config fragment into app data that
//! registers it as a stdio extension, and hand that fragment to goosed via
//! `GOOSE_ADDITIONAL_CONFIG_FILES` — the same mechanism the distro bundle
//! config uses. The binary path is resolved per machine at spawn time, so
//! the fragment is never stale after an app move or update.
//!
//! The server is always registered. It reads `~/.me/policy.json` on every
//! call, so user-owned policy is the single source of truth and toggles reach
//! sessions that are already running.

use std::fs;
use std::path::{Path, PathBuf};

use tauri::Manager;

const FRAGMENT_FILE: &str = "memory-mcp.goose.yaml";

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

fn render_fragment(binary: &Path) -> String {
    format!(
        concat!(
            "extensions:\n",
            "  berd_memory:\n",
            "    enabled: true\n",
            "    type: stdio\n",
            "    name: Berd memory\n",
            "    description: The user's approved memory and a proposal tool. Suggestions stay local and unavailable to agents until the user reviews and approves them.\n",
            "    cmd: {cmd}\n",
            "    args: []\n",
            "    envs: {{}}\n",
            "    env_keys: []\n",
            "    timeout: 60\n",
        ),
        cmd = serde_json::to_string(&binary.to_string_lossy()).unwrap_or_default(),
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

    let Some(binary) = resolve_binary() else {
        log::warn!("memory-mcp: server binary not found, skipping registration");
        return None;
    };

    let fragment = render_fragment(&binary);
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
        let fragment = render_fragment(Path::new(
            "/Applications/Berd.app/Contents/MacOS/berd-memory-mcp",
        ));
        assert!(fragment.contains("berd_memory:"));
        assert!(fragment.contains("type: stdio"));
        assert!(fragment.contains("\"/Applications/Berd.app/Contents/MacOS/berd-memory-mcp\""));
        assert!(fragment.contains("enabled: true"));
    }

    #[test]
    fn fragment_quotes_paths_with_spaces() {
        let fragment = render_fragment(Path::new("/Users/someone/My Apps/berd-memory-mcp"));
        assert!(fragment.contains("\"/Users/someone/My Apps/berd-memory-mcp\""));
    }
}
