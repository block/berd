//! Per-instance discovery ("lock") file the berdctl CLI reads to find and
//! authenticate to the running broker: `{port, pid, generation,
//! protocolVersion, capability}`.
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
pub const PROTOCOL_VERSION: u32 = 5;

/// Directory under the app data dir holding the per-instance discovery files.
pub const DISCOVERY_DIR_NAME: &str = "berdctl";

const DISCOVERY_FILE_PREFIX: &str = "control-";
const DISCOVERY_FILE_SUFFIX: &str = ".json";
/// A crash between a temp-file write and its atomic rename can leave either
/// the legacy fixed-name `control-<pid>.json.tmp` orphan or the current
/// `control-<pid>.json.<nonce>.tmp` orphan. The app crate's stale-file sweep
/// owns both forms.
const LEGACY_DISCOVERY_TEMP_SUFFIX: &str = ".json.tmp";
const DISCOVERY_TEMP_MARKER: &str = ".json.";
const DISCOVERY_TEMP_SUFFIX: &str = ".tmp";
const DISCOVERY_TEMP_NONCE_HEX_LEN: usize = 32;

/// `<app_data_dir>/berdctl/control-<pid>.json`. Per-instance (pid
/// suffix): dev worktrees share a bundle identifier, so a well-known filename
/// would let two instances overwrite each other's file.
pub fn discovery_file_path(app_data_dir: &Path, pid: u32) -> PathBuf {
    app_data_dir.join(DISCOVERY_DIR_NAME).join(format!(
        "{DISCOVERY_FILE_PREFIX}{pid}{DISCOVERY_FILE_SUFFIX}"
    ))
}

/// Owning app pid encoded in a discovery file name. Recognized forms are the
/// final `control-<pid>.json`, legacy `control-<pid>.json.tmp`, and current
/// `control-<pid>.json.<32 lowercase hex chars>.tmp` orphan names. `None` for
/// anything else, so the stale-file sweep cannot delete unrelated files.
pub fn owner_pid_from_discovery_file_name(name: &str) -> Option<u32> {
    let stem = name.strip_prefix(DISCOVERY_FILE_PREFIX)?;
    let pid = if let Some(pid) = stem.strip_suffix(DISCOVERY_FILE_SUFFIX) {
        pid
    } else if let Some(pid) = stem.strip_suffix(LEGACY_DISCOVERY_TEMP_SUFFIX) {
        pid
    } else {
        let (pid, nonce_with_suffix) = stem.split_once(DISCOVERY_TEMP_MARKER)?;
        let nonce = nonce_with_suffix.strip_suffix(DISCOVERY_TEMP_SUFFIX)?;
        if nonce.len() != DISCOVERY_TEMP_NONCE_HEX_LEN
            || !nonce
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return None;
        }
        pid
    };
    pid.parse().ok()
}

#[cfg(all(feature = "server", windows))]
mod windows_discovery_security {
    use std::{ffi::c_void, mem::size_of, os::windows::ffi::OsStrExt, path::Path};

    use windows_sys::Win32::{
        Foundation::{
            CloseHandle, GetLastError, ERROR_INSUFFICIENT_BUFFER, HANDLE, INVALID_HANDLE_VALUE,
        },
        Security::Authorization::{SetSecurityInfo, SE_FILE_OBJECT},
        Security::{
            AddAccessAllowedAceEx, GetLengthSid, GetTokenInformation, InitializeAcl, TokenUser,
            ACL, ACL_REVISION, DACL_SECURITY_INFORMATION, OWNER_SECURITY_INFORMATION,
            PROTECTED_DACL_SECURITY_INFORMATION, TOKEN_QUERY, TOKEN_USER,
        },
        Storage::FileSystem::{
            CreateFileW, FileAttributeTagInfo, GetFileInformationByHandleEx,
            FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT, FILE_ATTRIBUTE_TAG_INFO,
            FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ,
            FILE_SHARE_WRITE, OPEN_EXISTING,
        },
        System::Threading::{GetCurrentProcess, OpenProcessToken},
    };

    // These access and inheritance values are stable Win32 ABI constants. They
    // intentionally avoid relying on an inherited ACL from an app-data parent.
    const READ_CONTROL: u32 = 0x0002_0000;
    const WRITE_DAC: u32 = 0x0004_0000;
    const WRITE_OWNER: u32 = 0x0008_0000;
    const GENERIC_ALL: u32 = 0x1000_0000;
    const OBJECT_INHERIT_ACE: u32 = 0x01;
    const CONTAINER_INHERIT_ACE: u32 = 0x02;
    const MAX_TOKEN_USER_INFO_SIZE: u32 = 64 * 1024;
    const MAX_SID_LENGTH: usize = 68;

    pub(super) struct PrivateDirectory(HANDLE);

    impl Drop for PrivateDirectory {
        fn drop(&mut self) {
            // SAFETY: this type owns a successful CreateFileW handle.
            unsafe { CloseHandle(self.0) };
        }
    }

    fn win_error(context: &str, code: u32) -> std::io::Error {
        std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            format!("{context}: Windows error {code}"),
        )
    }

    fn path_as_wide_null(path: &Path) -> Vec<u16> {
        path.as_os_str().encode_wide().chain(Some(0)).collect()
    }

    /// Kept separate from the syscall wrapper so the security decision is
    /// directly unit-testable without creating Windows filesystem objects.
    fn is_plain_directory(attributes: u32) -> bool {
        attributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)
            == FILE_ATTRIBUTE_DIRECTORY
    }

    fn acl_size_for_sid(sid_len: usize) -> usize {
        size_of::<ACL>() + 8 + sid_len
    }

    fn is_bounded_token_user_info_size(size: u32) -> bool {
        (size as usize) >= size_of::<TOKEN_USER>() && size <= MAX_TOKEN_USER_INFO_SIZE
    }

    unsafe fn with_current_user_sid<T>(
        f: impl FnOnce(*mut c_void) -> std::io::Result<T>,
    ) -> std::io::Result<T> {
        let mut token = 0;
        // SAFETY: pseudo process handle is valid and `token` is writable.
        if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
            return Err(win_error("opening current process token", unsafe {
                GetLastError()
            }));
        }
        let result = (|| {
            let mut size = 0;
            // SAFETY: querying the required buffer size permits a null buffer.
            let queried = unsafe {
                GetTokenInformation(token, TokenUser, std::ptr::null_mut(), 0, &mut size)
            };
            if queried != 0 || unsafe { GetLastError() } != ERROR_INSUFFICIENT_BUFFER {
                return Err(win_error("querying current user SID", unsafe {
                    GetLastError()
                }));
            }
            if !is_bounded_token_user_info_size(size) {
                return Err(std::io::Error::other(
                    "current user SID information has an invalid size",
                ));
            }
            let mut buffer = vec![0_u8; size as usize];
            // SAFETY: `buffer` has the size requested by the preceding call.
            if unsafe {
                GetTokenInformation(
                    token,
                    TokenUser,
                    buffer.as_mut_ptr().cast(),
                    size,
                    &mut size,
                )
            } == 0
            {
                return Err(win_error("reading current user SID", unsafe {
                    GetLastError()
                }));
            }
            let user = buffer.as_ptr().cast::<TOKEN_USER>();
            // SAFETY: GetTokenInformation initialized a TOKEN_USER in buffer.
            f(unsafe { (*user).User.Sid })
        })();
        // SAFETY: OpenProcessToken returned this handle above.
        unsafe { CloseHandle(token) };
        result
    }

    unsafe fn apply_current_user_dacl(handle: HANDLE, inherit: u32) -> std::io::Result<()> {
        unsafe {
            with_current_user_sid(|sid| {
                let sid_len = GetLengthSid(sid) as usize;
                if sid_len == 0 {
                    return Err(win_error("measuring current user SID", GetLastError()));
                }
                if sid_len > MAX_SID_LENGTH {
                    return Err(std::io::Error::other("current user SID is too large"));
                }
                // u32 backing gives the ACL its required alignment.
                let mut acl_storage =
                    vec![0_u32; acl_size_for_sid(sid_len).div_ceil(size_of::<u32>())];
                let acl = acl_storage.as_mut_ptr().cast::<ACL>();
                if InitializeAcl(
                    acl,
                    (acl_storage.len() * size_of::<u32>()) as u32,
                    ACL_REVISION,
                ) == 0
                {
                    return Err(win_error("initializing discovery ACL", GetLastError()));
                }
                if AddAccessAllowedAceEx(acl, ACL_REVISION, inherit, GENERIC_ALL, sid) == 0 {
                    return Err(win_error(
                        "adding current user discovery ACL",
                        GetLastError(),
                    ));
                }
                let status = SetSecurityInfo(
                    handle,
                    SE_FILE_OBJECT,
                    OWNER_SECURITY_INFORMATION
                        | DACL_SECURITY_INFORMATION
                        | PROTECTED_DACL_SECURITY_INFORMATION,
                    sid,
                    std::ptr::null_mut(),
                    acl,
                    std::ptr::null(),
                );
                if status != 0 {
                    return Err(win_error("setting private discovery ACL", status));
                }
                Ok(())
            })
        }
    }

    pub(super) fn open_private_directory(path: &Path) -> std::io::Result<PrivateDirectory> {
        let wide_path = path_as_wide_null(path);
        // Do not share delete access: holding this handle prevents a checked
        // directory from being renamed/replaced while paths beneath it are used.
        // OPEN_REPARSE_POINT lets us inspect (rather than traverse) junctions.
        let handle = unsafe {
            CreateFileW(
                wide_path.as_ptr(),
                READ_CONTROL | WRITE_DAC | WRITE_OWNER,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                std::ptr::null(),
                OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
                0,
            )
        };
        if handle == INVALID_HANDLE_VALUE {
            return Err(win_error("opening discovery directory", unsafe {
                GetLastError()
            }));
        }
        let result = (|| unsafe {
            let mut info = FILE_ATTRIBUTE_TAG_INFO {
                FileAttributes: 0,
                ReparseTag: 0,
            };
            if GetFileInformationByHandleEx(
                handle,
                FileAttributeTagInfo,
                (&mut info as *mut FILE_ATTRIBUTE_TAG_INFO).cast(),
                size_of::<FILE_ATTRIBUTE_TAG_INFO>() as u32,
            ) == 0
            {
                return Err(win_error("checking discovery directory", GetLastError()));
            }
            if !is_plain_directory(info.FileAttributes) {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    "discovery directory is not a plain directory (reparse points are forbidden)",
                ));
            }
            apply_current_user_dacl(handle, OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE)
        })();
        match result {
            Ok(()) => Ok(PrivateDirectory(handle)),
            Err(error) => {
                unsafe { CloseHandle(handle) };
                Err(error)
            }
        }
    }

    pub(super) fn private_file_handle(handle: HANDLE) -> std::io::Result<()> {
        // Temp files get an explicit protected DACL before the capability is
        // written; inheritance alone would not repair an existing weak ACL.
        unsafe { apply_current_user_dacl(handle, 0) }
    }

    pub(super) fn open_private_file(file: &std::fs::File) -> std::io::Result<()> {
        use std::os::windows::io::AsRawHandle;

        let handle = file.as_raw_handle() as HANDLE;
        // std::fs opens the newly-created temp path. It is safe to repair its
        // ACL only while the verified directory handle is held by the caller.
        // The file is private before any capability bytes are written.
        private_file_handle(handle)
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn plain_directory_rejects_reparse_points_and_files() {
            assert!(is_plain_directory(FILE_ATTRIBUTE_DIRECTORY));
            assert!(!is_plain_directory(0));
            assert!(!is_plain_directory(
                FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT
            ));
        }

        #[test]
        fn acl_storage_includes_header_ace_and_sid() {
            assert_eq!(acl_size_for_sid(12), size_of::<ACL>() + 8 + 12);
        }

        #[test]
        fn token_user_buffer_size_is_bounded() {
            assert!(!is_bounded_token_user_info_size(0));
            assert!(is_bounded_token_user_info_size(
                size_of::<TOKEN_USER>() as u32
            ));
            assert!(is_bounded_token_user_info_size(MAX_TOKEN_USER_INFO_SIZE));
            assert!(!is_bounded_token_user_info_size(
                MAX_TOKEN_USER_INFO_SIZE + 1
            ));
        }
    }
}

#[cfg(all(feature = "server", not(windows)))]
fn private_discovery_directory(dir: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, OpenOptionsExt};

        // Refuse to follow a symlink or repair a directory after it has been
        // swapped out from under the checked path.
        let handle = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_DIRECTORY)
            .open(dir)?;
        let metadata = handle.metadata()?;
        // SAFETY: `geteuid` takes no arguments and has no preconditions.
        let current_uid = unsafe { libc::geteuid() };
        if !metadata.file_type().is_dir() || metadata.uid() != current_uid {
            return Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                format!(
                    "discovery directory {} is not owned by the current user",
                    dir.display()
                ),
            ));
        }
        handle.set_permissions(unix_permissions(0o700))?;
        Ok(())
    }
    #[cfg(not(unix))]
    {
        let metadata = std::fs::symlink_metadata(dir)?;
        if !metadata.file_type().is_dir() {
            return Err(std::io::Error::other(format!(
                "discovery directory {} is not a directory",
                dir.display()
            )));
        }
        Ok(())
    }
}

/// Atomically write the discovery file: private dir + temp file + fsync +
/// rename, so a CLI reading mid-write never sees partial JSON. The capability
/// is sensitive to other users on the host, so Unix paths are tightened to
/// owner-only access even when they predate this write.
#[cfg(feature = "server")]
pub(crate) fn write_discovery_file(
    path: &Path,
    port: u16,
    pid: u32,
    generation: u64,
    capability: &str,
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
    #[cfg(windows)]
    let _private_dir = windows_discovery_security::open_private_directory(dir)?;
    #[cfg(not(windows))]
    private_discovery_directory(dir)?;

    let payload = serde_json::json!({
        "port": port,
        "pid": pid,
        "generation": generation,
        "protocolVersion": PROTOCOL_VERSION,
        "capability": capability,
    });

    // Use a unique adjacent path for each write. A stale fixed-name temp file
    // must never block broker startup, and `create_new` prevents following or
    // truncating a same-user symlink planted at the candidate path.
    let tmp = (0_u8..16)
        .find_map(|_| {
            let mut suffix = [0_u8; 16];
            if let Err(err) = getrandom::fill(&mut suffix) {
                return Some(Err(std::io::Error::other(err)));
            }
            let mut tmp_name = path
                .file_name()
                .map(std::ffi::OsStr::to_os_string)
                .unwrap_or_default();
            tmp_name.push(format!(".{}.tmp", hex::encode(suffix)));
            let candidate = path.with_file_name(tmp_name);

            let mut options = std::fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            match options.open(&candidate) {
                Ok(file) => Some(Ok((candidate, file))),
                Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => None,
                Err(err) => Some(Err(err)),
            }
        })
        .transpose()?
        .ok_or_else(|| std::io::Error::other("could not allocate discovery temp file"))?;
    let (tmp, mut file) = tmp;
    #[cfg(windows)]
    windows_discovery_security::open_private_file(&file)?;
    #[cfg(unix)]
    file.set_permissions(unix_permissions(0o600))?;

    let mut renamed = false;
    let result = (|| {
        file.write_all(payload.to_string().as_bytes())?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&tmp, path)?;
        renamed = true;
        sync_directory(dir)
    })();
    if result.is_err() {
        let cleanup_path = if renamed { path } else { &tmp };
        let _ = std::fs::remove_file(cleanup_path);
        if renamed {
            let _ = sync_directory(dir);
        }
    }
    result
}

#[cfg(feature = "server")]
fn sync_directory(dir: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        std::fs::File::open(dir)?.sync_all()
    }
    #[cfg(not(unix))]
    {
        let _ = dir;
        Ok(())
    }
}

#[cfg(all(feature = "server", unix))]
fn unix_permissions(mode: u32) -> std::fs::Permissions {
    use std::os::unix::fs::PermissionsExt;
    std::fs::Permissions::from_mode(mode)
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
        const NONCE: &str = "0123456789abcdef0123456789abcdef";

        for name in [
            "control-1234.json".to_string(),
            "control-1234.json.tmp".to_string(),
            format!("control-1234.json.{NONCE}.tmp"),
        ] {
            assert_eq!(
                owner_pid_from_discovery_file_name(&name),
                Some(1234),
                "expected to recognize {name}"
            );
        }

        for name in [
            "other.json",
            "control-1234.tmp",
            "control-1234.json.short.tmp",
            "control-1234.json.0123456789abcdef0123456789abcdeg.tmp",
            "control-1234.json.0123456789ABCDEF0123456789ABCDEF.tmp",
            "control-1234.json.0123456789abcdef0123456789abcdef.tmp.extra",
        ] {
            assert_eq!(
                owner_pid_from_discovery_file_name(name),
                None,
                "must not recognize unrelated name {name}"
            );
        }

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

    #[cfg(all(feature = "server", unix))]
    #[test]
    fn write_rejects_symlinked_discovery_directory() {
        use std::os::unix::fs::symlink;

        let base = std::env::temp_dir().join(format!(
            "berdctl-discovery-dir-symlink-test-{}",
            std::process::id()
        ));
        std::fs::remove_dir_all(&base).ok();
        std::fs::create_dir(&base).unwrap();
        let target = base.join("target");
        let link = base.join("berdctl");
        std::fs::create_dir(&target).unwrap();
        std::fs::set_permissions(&target, unix_permissions(0o700)).unwrap();
        symlink(&target, &link).unwrap();
        let path = link.join("control-4242.json");

        let error = write_discovery_file(
            &path,
            8080,
            4242,
            7,
            "1111111111111111111111111111111111111111111111111111111111111111",
        )
        .expect_err("symlinked discovery directory must fail closed");
        assert!(!target.join("control-4242.json").exists());
        assert_ne!(error.kind(), std::io::ErrorKind::NotFound);

        std::fs::remove_dir_all(base).ok();
    }

    #[cfg(feature = "server")]
    #[test]
    fn write_and_remove_lifecycle() {
        const FIRST_CAPABILITY: &str =
            "1111111111111111111111111111111111111111111111111111111111111111";
        const ROTATED_CAPABILITY: &str =
            "2222222222222222222222222222222222222222222222222222222222222222";
        let base =
            std::env::temp_dir().join(format!("berdctl-discovery-test-{}", std::process::id()));
        std::fs::remove_dir_all(&base).ok();
        let path = discovery_file_path(&base, 4242);

        write_discovery_file(&path, 8080, 4242, 7, FIRST_CAPABILITY).unwrap();
        let parsed: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(parsed["port"], 8080);
        assert_eq!(parsed["pid"], 4242);
        assert_eq!(parsed["generation"], 7);
        assert_eq!(parsed["protocolVersion"], PROTOCOL_VERSION);
        assert_eq!(parsed["capability"], FIRST_CAPABILITY);
        // The temp file is renamed away, never left behind.
        let leftovers: Vec<_> = std::fs::read_dir(path.parent().unwrap())
            .unwrap()
            .flatten()
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("control-4242.json.")
            })
            .collect();
        assert!(leftovers.is_empty(), "leftover temp files: {leftovers:?}");

        // A crash orphan at the legacy fixed temp name cannot block a future
        // broker start or be overwritten with the new capability.
        let legacy_tmp = path.with_file_name("control-4242.json.tmp");
        std::fs::write(&legacy_tmp, "stale").unwrap();

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

            // Pre-existing permissive paths are tightened too; creation modes
            // alone do not repair them.
            std::fs::set_permissions(path.parent().unwrap(), unix_permissions(0o755)).unwrap();
            std::fs::set_permissions(&path, unix_permissions(0o644)).unwrap();
        }

        // Restart case: an atomic rewrite rotates both generation and secret.
        write_discovery_file(&path, 9090, 4242, 8, ROTATED_CAPABILITY).unwrap();
        let parsed: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(parsed["port"], 9090);
        assert_eq!(parsed["generation"], 8);
        assert_eq!(parsed["capability"], ROTATED_CAPABILITY);
        assert_eq!(std::fs::read_to_string(&legacy_tmp).unwrap(), "stale");

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

        remove_discovery_file(&path);
        assert!(!path.exists());
        // Removing an already-removed file is a quiet no-op.
        remove_discovery_file(&path);

        std::fs::remove_dir_all(&base).ok();
    }
}
