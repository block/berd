//! Per-instance discovery ("lock") file the berdctl CLI reads to find the
//! running broker: `{port, pid, generation, protocolVersion}`.
//!
//! The path formula and protocol version are exported unconditionally (not
//! behind the `server` feature) so the app crate can compute the path for the
//! goosed spawn env and the stale-file sweep without enabling the broker.

use std::path::{Path, PathBuf};

/// Wire protocol version of the `/v1` HTTP surface, written to the discovery
/// file and echoed by `GET /v1/ping`. The berdctl CLI carries its own copy
/// (src-tauri/crates/berdctl); the CLI does not depend on this crate —
/// bump both together.
#[cfg_attr(not(feature = "server"), allow(dead_code))]
pub const PROTOCOL_VERSION: u32 = 1;

/// Directory under the app data dir holding the per-instance discovery files.
pub const DISCOVERY_DIR_NAME: &str = "berdctl";

const DISCOVERY_FILE_PREFIX: &str = "control-";
const DISCOVERY_FILE_SUFFIX: &str = ".json";
/// A crash between the temp-file write and the atomic rename below leaves
/// `control-<pid>.json.tmp` behind; the app crate's stale-file sweep owns
/// those orphans too.
const DISCOVERY_TEMP_SUFFIX: &str = ".json.tmp";

/// `<app_data_dir>/berdctl/control-<pid>.json`. Per-instance (pid
/// suffix): dev worktrees share a bundle identifier, so a well-known filename
/// would let two instances overwrite each other's file.
pub fn discovery_file_path(app_data_dir: &Path, pid: u32) -> PathBuf {
    app_data_dir.join(DISCOVERY_DIR_NAME).join(format!(
        "{DISCOVERY_FILE_PREFIX}{pid}{DISCOVERY_FILE_SUFFIX}"
    ))
}

/// Owning app pid encoded in a discovery file name: `control-<pid>.json` or
/// its orphaned temp form `control-<pid>.json.tmp`. `None` for anything else.
pub fn owner_pid_from_discovery_file_name(name: &str) -> Option<u32> {
    let stem = name.strip_prefix(DISCOVERY_FILE_PREFIX)?;
    stem.strip_suffix(DISCOVERY_TEMP_SUFFIX)
        .or_else(|| stem.strip_suffix(DISCOVERY_FILE_SUFFIX))?
        .parse()
        .ok()
}

/// Atomically write the discovery file: private dir + temp file + fsync +
/// rename, so a CLI reading mid-write never sees partial JSON.
#[cfg(feature = "server")]
pub(crate) fn write_discovery_file(
    path: &Path,
    port: u16,
    pid: u32,
    generation: u64,
) -> std::io::Result<()> {
    use std::io::Write;

    let dir = path.parent().ok_or_else(|| {
        std::io::Error::other(format!("discovery path {} has no parent", path.display()))
    })?;
    let mut dir_builder = std::fs::DirBuilder::new();
    dir_builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        dir_builder.mode(0o700);
    }
    dir_builder.create(dir)?;

    let payload = serde_json::json!({
        "port": port,
        "pid": pid,
        "generation": generation,
        "protocolVersion": PROTOCOL_VERSION,
    });

    let mut tmp_name = path
        .file_name()
        .map(std::ffi::OsStr::to_os_string)
        .unwrap_or_default();
    tmp_name.push(".tmp");
    let tmp = path.with_file_name(tmp_name);

    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&tmp)?;
    file.write_all(payload.to_string().as_bytes())?;
    file.sync_all()?;
    drop(file);
    std::fs::rename(&tmp, path)
}

/// Best-effort removal (stop / app exit); missing files are expected.
#[cfg(feature = "server")]
pub(crate) fn remove_discovery_file(path: &Path) {
    if let Err(err) = std::fs::remove_file(path) {
        if err.kind() != std::io::ErrorKind::NotFound {
            log::warn!(
                "[berdctl] failed to remove discovery file {}: {err}",
                path.display()
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const API_SURFACE: &str = include_str!("../../../crates/berdctl/api-surface.json");

    #[test]
    fn discovery_file_path_is_pid_suffixed() {
        let path = discovery_file_path(Path::new("/data"), 4242);
        assert_eq!(
            path,
            Path::new("/data").join("berdctl").join("control-4242.json")
        );
    }

    #[test]
    fn parses_owner_pid_from_file_name() {
        assert_eq!(
            owner_pid_from_discovery_file_name("control-1234.json"),
            Some(1234)
        );
        assert_eq!(
            owner_pid_from_discovery_file_name("control-1234.json.tmp"),
            Some(1234)
        );
        assert_eq!(owner_pid_from_discovery_file_name("other.json"), None);
        assert_eq!(owner_pid_from_discovery_file_name("control-1234.tmp"), None);

        // The parser round-trips the name `discovery_file_path` writes.
        let path = discovery_file_path(Path::new("/data"), 4242);
        let name = path.file_name().unwrap().to_str().unwrap();
        assert_eq!(owner_pid_from_discovery_file_name(name), Some(4242));
    }

    #[test]
    fn api_surface_protocol_version_matches_the_plugin() {
        let api: serde_json::Value =
            serde_json::from_str(API_SURFACE).expect("api-surface.json parses");
        let api_protocol_version = api
            .get("protocolVersion")
            .and_then(serde_json::Value::as_u64)
            .expect("api-surface.json has protocolVersion");
        assert_eq!(
            api_protocol_version, PROTOCOL_VERSION as u64,
            "bump protocolVersion in contract.ts and both discovery.rs copies together"
        );
    }

    #[cfg(feature = "server")]
    #[test]
    fn write_and_remove_lifecycle() {
        let base =
            std::env::temp_dir().join(format!("berdctl-discovery-test-{}", std::process::id()));
        std::fs::remove_dir_all(&base).ok();
        let path = discovery_file_path(&base, 4242);

        write_discovery_file(&path, 8080, 4242, 7).unwrap();
        let parsed: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(parsed["port"], 8080);
        assert_eq!(parsed["pid"], 4242);
        assert_eq!(parsed["generation"], 7);
        assert_eq!(parsed["protocolVersion"], PROTOCOL_VERSION);
        // The temp file is renamed away, never left behind.
        assert!(!path.with_file_name("control-4242.json.tmp").exists());

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let dir_mode = std::fs::metadata(path.parent().unwrap())
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(dir_mode & 0o777, 0o700);
            let file_mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(file_mode & 0o777, 0o600);
        }

        // Restart case: a rewrite replaces the content atomically.
        write_discovery_file(&path, 9090, 4242, 8).unwrap();
        let parsed: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(parsed["port"], 9090);
        assert_eq!(parsed["generation"], 8);

        remove_discovery_file(&path);
        assert!(!path.exists());
        // Removing an already-removed file is a quiet no-op.
        remove_discovery_file(&path);

        std::fs::remove_dir_all(&base).ok();
    }
}
