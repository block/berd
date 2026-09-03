//! Discovery-file resolution: how berdctl finds the app's control endpoint.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Deserialize;

use crate::client::Failure;

/// Wire-protocol version this binary speaks. Duplicated by hand from
/// `PROTOCOL_VERSION` in the `tauri-plugin-berdctl` crate
/// (src-tauri/plugins/berdctl) — the CLI does not depend on the plugin
/// crate; bump both copies together.
pub const PROTOCOL_VERSION: u32 = 4;

/// Exact wording pinned by the implementation spec: the missing env var is the
/// provenance signal that we are not running under the app.
pub const NOT_UNDER_APP: &str =
    "berdctl must run inside a Berd desktop app session (the app sets this up automatically)";

const REREAD_DELAY: Duration = Duration::from_millis(200);

/// Shape of the discovery file the berdctl broker writes on start
/// (`<app-data>/berdctl/control-<app-pid>.json`). Duplicated by hand from
/// the writer's struct in `tauri-plugin-berdctl`; keep in sync.
#[derive(Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveryFile {
    pub port: u16,
    pub pid: u32,
    pub generation: u64,
    pub protocol_version: u32,
}

/// The lock path comes from `--lock-path` or `BERDCTL_LOCK` (clap merges
/// the two); an empty value is as good as unset.
pub fn resolve_lock_path(arg: Option<PathBuf>) -> Result<PathBuf, Failure> {
    match arg {
        Some(path) if !path.as_os_str().is_empty() => Ok(path),
        _ => Err(Failure::env(NOT_UNDER_APP)),
    }
}

pub fn parse(contents: &str) -> Result<DiscoveryFile, String> {
    serde_json::from_str(contents).map_err(|err| format!("discovery file is not valid: {err}"))
}

pub fn load(path: &Path) -> Result<DiscoveryFile, String> {
    let contents = std::fs::read_to_string(path)
        .map_err(|err| format!("cannot read {}: {err}", path.display()))?;
    parse(&contents)
}

/// The broker writes the file atomically, so a read/parse failure is either
/// transient (broker restarting) or means the app is gone; one short retry
/// distinguishes the two.
pub fn load_with_retry(path: &Path) -> Result<DiscoveryFile, Failure> {
    load(path)
        .or_else(|_| {
            std::thread::sleep(REREAD_DELAY);
            load(path)
        })
        .map_err(|err| {
            Failure::env(format!(
                "the Berd desktop app's control endpoint is unavailable ({err}); \
                 the app may not be running or app control may be disabled. \
                 confirm Berd is running, app control is enabled, and this \
                 command is running inside a Berd-started agent session."
            ))
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    const VALID: &str = r#"{"port":52341,"pid":4242,"generation":3,"protocolVersion":1}"#;

    #[test]
    fn parses_a_valid_discovery_file() {
        let file = parse(VALID).expect("valid file parses");
        assert_eq!(
            file,
            DiscoveryFile {
                port: 52341,
                pid: 4242,
                generation: 3,
                protocol_version: 1,
            }
        );
    }

    #[test]
    fn tolerates_unknown_fields_for_forward_compat() {
        let file = parse(r#"{"port":1,"pid":2,"generation":3,"protocolVersion":1,"token":"x"}"#)
            .expect("unknown fields are ignored");
        assert_eq!(file.port, 1);
    }

    #[test]
    fn rejects_truncated_json() {
        // A partial write must never yield a usable endpoint.
        assert!(parse(r#"{"port":52341,"pid":4242,"gen"#).is_err());
    }

    #[test]
    fn rejects_missing_fields() {
        assert!(parse(r#"{"port":52341,"pid":4242}"#).is_err());
        assert!(parse(r#"{}"#).is_err());
    }

    #[test]
    fn rejects_wrongly_typed_fields() {
        assert!(
            parse(r#"{"port":"not-a-port","pid":1,"generation":1,"protocolVersion":1}"#).is_err()
        );
    }

    #[test]
    fn missing_lock_path_is_exit_3_with_the_pinned_message() {
        let failure = resolve_lock_path(None).expect_err("missing path fails");
        assert_eq!(failure.exit, crate::client::EXIT_ENV);
        assert_eq!(failure.message, NOT_UNDER_APP);
    }

    #[test]
    fn empty_lock_path_is_treated_as_missing() {
        let failure = resolve_lock_path(Some(PathBuf::new())).expect_err("empty path fails");
        assert_eq!(failure.message, NOT_UNDER_APP);
    }

    #[test]
    fn present_lock_path_resolves() {
        let path = resolve_lock_path(Some(PathBuf::from("/tmp/control-1.json")))
            .expect("present path resolves");
        assert_eq!(path, PathBuf::from("/tmp/control-1.json"));
    }
}
