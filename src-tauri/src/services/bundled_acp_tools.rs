use std::{
    ffi::OsStr,
    path::{Path, PathBuf},
};

use tauri::Manager;

pub const ACP_TOOLS_DIR_ENV: &str = "BERD_ACP_TOOLS_DIR";
const ACP_TOOLS_RESOURCE_DIR: &str = "acp/bin";
const NODE_RUNTIME_MANIFEST_FILE: &str = "node-runtime.json";

pub fn resolve_bundled_acp_tools_dir(app_handle: &tauri::AppHandle) -> Option<PathBuf> {
    bundled_acp_tools_dir_from_parts(
        std::env::var_os(ACP_TOOLS_DIR_ENV).as_deref(),
        app_handle.path().resource_dir().ok().as_deref(),
    )
}

/// Path of the Node runtime manifest staged by
/// `scripts/prepare-acp-tools-resource.sh`: it lives next to the tools bin
/// dir (`acp/node-runtime.json` beside `acp/bin`), so it resolves for both
/// the bundled resource dir and a `BERD_ACP_TOOLS_DIR` dev override.
pub fn node_runtime_manifest_path(bin_dir: &Path) -> Option<PathBuf> {
    bin_dir
        .parent()
        .map(|dir| dir.join(NODE_RUNTIME_MANIFEST_FILE))
}

pub(crate) fn bundled_acp_tools_dir_from_parts(
    env_override: Option<&OsStr>,
    resource_dir: Option<&Path>,
) -> Option<PathBuf> {
    if let Some(value) = env_override {
        if !value.is_empty() {
            return Some(PathBuf::from(value));
        }
    }
    resource_dir.map(|dir| dir.join(ACP_TOOLS_RESOURCE_DIR))
}

#[cfg(test)]
mod tests {
    use super::bundled_acp_tools_dir_from_parts;
    use std::{ffi::OsStr, path::Path};

    #[test]
    fn env_override_wins() {
        assert_eq!(
            bundled_acp_tools_dir_from_parts(
                Some(OsStr::new("/dev/acp/bin")),
                Some(Path::new("/bundle/resources")),
            )
            .as_deref(),
            Some(Path::new("/dev/acp/bin")),
        );
    }

    #[test]
    fn empty_env_falls_back_to_resource_dir() {
        assert_eq!(
            bundled_acp_tools_dir_from_parts(Some(OsStr::new("")), Some(Path::new("/resources")))
                .as_deref(),
            Some(Path::new("/resources/acp/bin")),
        );
    }

    #[test]
    fn missing_inputs_returns_none() {
        assert!(bundled_acp_tools_dir_from_parts(None, None).is_none());
    }

    #[test]
    fn node_runtime_manifest_sits_beside_bin_dir() {
        assert_eq!(
            super::node_runtime_manifest_path(Path::new("/bundle/resources/acp/bin")).as_deref(),
            Some(Path::new("/bundle/resources/acp/node-runtime.json")),
        );
        assert!(super::node_runtime_manifest_path(Path::new("/")).is_none());
    }
}
