//! Discovery-file resolution: how berdctl finds and authenticates to the
//! app's control endpoint.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Deserialize;

use crate::client::Failure;

/// Wire-protocol version this binary speaks. Duplicated by hand from
/// `PROTOCOL_VERSION` in the `tauri-plugin-berdctl` crate
/// (src-tauri/plugins/berdctl) — the CLI does not depend on the plugin
/// crate; bump both copies together.
pub const PROTOCOL_VERSION: u32 = 5;

/// Exact wording pinned by the implementation spec: the missing env var is the
/// provenance signal that we are not running under the app.
pub const NOT_UNDER_APP: &str =
    "berdctl must run inside a Berd desktop app session (the app sets this up automatically)";

const REREAD_DELAY: Duration = Duration::from_millis(200);
const CAPABILITY_HEX_LEN: usize = 64;

/// Shape of the discovery file the berdctl broker writes on start
/// (`<app-data>/berdctl/control-<app-pid>.json`). Duplicated by hand from
/// the writer's struct in `tauri-plugin-berdctl`; keep in sync.
#[derive(Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", try_from = "RawDiscoveryFile")]
pub struct DiscoveryFile {
    pub port: u16,
    pub pid: u32,
    pub generation: u64,
    pub protocol_version: u32,
    pub capability: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawDiscoveryFile {
    port: u16,
    pid: u32,
    generation: u64,
    protocol_version: u32,
    capability: String,
}

impl TryFrom<RawDiscoveryFile> for DiscoveryFile {
    type Error = String;

    fn try_from(raw: RawDiscoveryFile) -> Result<Self, Self::Error> {
        if raw.capability.len() != CAPABILITY_HEX_LEN
            || !raw
                .capability
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err("capability must be a 256-bit hexadecimal value".to_string());
        }
        Ok(Self {
            port: raw.port,
            pid: raw.pid,
            generation: raw.generation,
            protocol_version: raw.protocol_version,
            capability: raw.capability,
        })
    }
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
    let contents = read_private_discovery_file(path)?;
    parse(&contents)
}

#[cfg(unix)]
fn read_private_discovery_file(path: &Path) -> Result<String, String> {
    use std::io::Read;
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt};

    const MAX_DISCOVERY_BYTES: u64 = 4096;

    // Check the containing directory first. Once it is owner-private, another
    // user cannot replace the final path while it is opened below.
    let parent = path
        .parent()
        .ok_or_else(|| format!("{} has no parent directory", path.display()))?;
    let parent_metadata = std::fs::symlink_metadata(parent)
        .map_err(|err| format!("cannot inspect {}: {err}", parent.display()))?;
    // SAFETY: `geteuid` takes no arguments and has no preconditions.
    let current_uid = unsafe { libc::geteuid() };
    if !parent_metadata.file_type().is_dir()
        || parent_metadata.uid() != current_uid
        || parent_metadata.mode() & 0o077 != 0
    {
        return Err(format!(
            "{} is not an owner-private directory (expected mode 0700)",
            parent.display()
        ));
    }

    // O_NOFOLLOW makes the final symlink check atomic with opening the file.
    // O_NONBLOCK keeps a malicious FIFO from blocking before metadata reveals
    // that it is not a regular file.
    let file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .map_err(|err| format!("cannot open {}: {err}", path.display()))?;
    let metadata = file
        .metadata()
        .map_err(|err| format!("cannot inspect {}: {err}", path.display()))?;
    if !metadata.file_type().is_file() {
        return Err(format!("{} is not a regular file", path.display()));
    }
    if metadata.uid() != current_uid {
        return Err(format!(
            "{} is not owned by the current user",
            path.display()
        ));
    }
    if metadata.mode() & 0o077 != 0 {
        return Err(format!(
            "{} is accessible by other users (expected mode 0600)",
            path.display()
        ));
    }
    if metadata.len() > MAX_DISCOVERY_BYTES {
        return Err(format!("{} is unexpectedly large", path.display()));
    }

    // Limit the read too: the handle may grow after the metadata check, but it
    // must never make berdctl allocate an unbounded discovery record.
    let mut contents = String::new();
    file.take(MAX_DISCOVERY_BYTES + 1)
        .read_to_string(&mut contents)
        .map_err(|err| format!("cannot read {}: {err}", path.display()))?;
    if contents.len() as u64 > MAX_DISCOVERY_BYTES {
        return Err(format!("{} is unexpectedly large", path.display()));
    }
    Ok(contents)
}

#[cfg(not(unix))]
fn read_private_discovery_file(path: &Path) -> Result<String, String> {
    std::fs::read_to_string(path).map_err(|err| format!("cannot read {}: {err}", path.display()))
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

    const CAPABILITY: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const VALID: &str = r#"{"port":52341,"pid":4242,"generation":3,"protocolVersion":1,"capability":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"}"#;

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
                capability: CAPABILITY.to_string(),
            }
        );
    }

    #[test]
    fn tolerates_unknown_fields_for_forward_compat() {
        let file = parse(
            r#"{"port":1,"pid":2,"generation":3,"protocolVersion":1,"capability":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef","future":"x"}"#,
        )
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
        assert!(
            parse(r#"{"port":52341,"pid":4242,"generation":3,"protocolVersion":1}"#).is_err(),
            "legacy discovery without a capability must fail closed"
        );
        assert!(parse(r#"{}"#).is_err());
    }

    #[test]
    fn rejects_wrongly_typed_or_malformed_fields() {
        assert!(parse(
            r#"{"port":"not-a-port","pid":1,"generation":1,"protocolVersion":1,"capability":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"}"#
        )
        .is_err());
        assert!(
            parse(r#"{"port":1,"pid":1,"generation":1,"protocolVersion":1,"capability":123}"#)
                .is_err()
        );
        for capability in [
            "",
            "short",
            "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz",
            "0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF",
        ] {
            let contents = format!(
                r#"{{"port":1,"pid":1,"generation":1,"protocolVersion":1,"capability":"{capability}"}}"#
            );
            assert!(
                parse(&contents).is_err(),
                "malformed capability {capability:?} must fail closed"
            );
        }
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

    #[cfg(unix)]
    #[test]
    fn load_accepts_private_discovery_file_from_shared_working_directory() {
        use std::os::unix::fs::PermissionsExt;

        let base =
            std::env::temp_dir().join(format!("berdctl-discovery-private-{}", std::process::id()));
        std::fs::remove_dir_all(&base).ok();
        std::fs::create_dir(&base).unwrap();
        let path = base.join("control.json");
        std::fs::write(&path, VALID).unwrap();
        std::fs::set_permissions(&base, std::fs::Permissions::from_mode(0o700)).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();

        assert_eq!(load(&path).expect("private discovery loads").port, 52341);
        std::fs::remove_dir_all(base).ok();
    }

    #[cfg(unix)]
    #[test]
    fn load_rejects_permissive_discovery_file() {
        use std::os::unix::fs::PermissionsExt;

        let base = std::env::temp_dir().join(format!(
            "berdctl-discovery-permissions-{}",
            std::process::id()
        ));
        std::fs::remove_dir_all(&base).ok();
        std::fs::create_dir(&base).unwrap();
        let path = base.join("control.json");
        std::fs::write(&path, VALID).unwrap();
        std::fs::set_permissions(&base, std::fs::Permissions::from_mode(0o700)).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        let error = load(&path).expect_err("world-readable capability must fail closed");
        assert!(error.contains("accessible by other users"));
        std::fs::remove_dir_all(base).ok();
    }

    #[cfg(unix)]
    #[test]
    fn load_rejects_permissive_discovery_directory() {
        use std::os::unix::fs::PermissionsExt;

        let base = std::env::temp_dir().join(format!(
            "berdctl-discovery-directory-permissions-{}",
            std::process::id()
        ));
        std::fs::remove_dir_all(&base).ok();
        std::fs::create_dir(&base).unwrap();
        let path = base.join("control.json");
        std::fs::write(&path, VALID).unwrap();
        std::fs::set_permissions(&base, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();

        let error = load(&path).expect_err("shared discovery directory must fail closed");
        assert!(error.contains("not an owner-private directory"));
        std::fs::remove_dir_all(base).ok();
    }

    #[cfg(unix)]
    #[test]
    fn load_rejects_symlinked_discovery_file() {
        use std::os::unix::fs::{symlink, PermissionsExt};

        let base =
            std::env::temp_dir().join(format!("berdctl-discovery-symlink-{}", std::process::id()));
        std::fs::remove_dir_all(&base).ok();
        std::fs::create_dir(&base).unwrap();
        std::fs::set_permissions(&base, std::fs::Permissions::from_mode(0o700)).unwrap();
        let target = base.join("target.json");
        let link = base.join("control.json");
        std::fs::write(&target, VALID).unwrap();
        std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o600)).unwrap();
        symlink(&target, &link).unwrap();
        assert!(load(&link).is_err(), "symlink must fail closed");
        std::fs::remove_dir_all(base).ok();
    }

    #[cfg(unix)]
    #[test]
    fn load_rejects_non_regular_and_oversized_discovery_files() {
        use std::os::unix::fs::PermissionsExt;

        let base =
            std::env::temp_dir().join(format!("berdctl-discovery-shape-{}", std::process::id()));
        std::fs::remove_dir_all(&base).ok();
        std::fs::create_dir(&base).unwrap();
        std::fs::set_permissions(&base, std::fs::Permissions::from_mode(0o700)).unwrap();

        let directory_path = base.join("control-dir");
        std::fs::create_dir(&directory_path).unwrap();
        assert!(load(&directory_path).is_err(), "directory must fail closed");

        let oversized_path = base.join("control-large.json");
        std::fs::write(&oversized_path, vec![b'x'; 4097]).unwrap();
        std::fs::set_permissions(&oversized_path, std::fs::Permissions::from_mode(0o600)).unwrap();
        let error = load(&oversized_path).expect_err("oversized discovery must fail closed");
        assert!(error.contains("unexpectedly large"));

        std::fs::remove_dir_all(base).ok();
    }
}
