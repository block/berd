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
const MAX_DISCOVERY_BYTES: u64 = 4096;

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

#[cfg(windows)]
fn read_private_discovery_file(path: &Path) -> Result<String, String> {
    use std::fs::File;
    use std::io::Read;
    use std::mem::zeroed;
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::{AsRawHandle, FromRawHandle, RawHandle};
    use windows_sys::Win32::Foundation::{GENERIC_READ, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Security::Authorization::{GetSecurityInfo, SE_FILE_OBJECT};
    use windows_sys::Win32::Security::{DACL_SECURITY_INFORMATION, OWNER_SECURITY_INFORMATION};
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, GetFileInformationByHandle, GetFileType, BY_HANDLE_FILE_INFORMATION,
        FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT, FILE_SHARE_DELETE, FILE_SHARE_READ,
        FILE_SHARE_WRITE, FILE_TYPE_DISK, OPEN_EXISTING,
    };

    // FILE_FLAG_OPEN_REPARSE_POINT makes the handle refer to the reparse point
    // itself rather than its target. This makes the reparse-point check below
    // apply to the object we opened, not to a potentially attacker-selected target.
    const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
    const READ_CONTROL: u32 = 0x0002_0000;

    let mut wide: Vec<u16> = path.as_os_str().encode_wide().collect();
    if wide.contains(&0) {
        return Err(format!("cannot open {}: path contains NUL", path.display()));
    }
    wide.push(0);
    let handle = unsafe {
        CreateFileW(
            wide.as_ptr(),
            GENERIC_READ | READ_CONTROL,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_OPEN_REPARSE_POINT,
            std::ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(format!(
            "cannot open {}: {}",
            path.display(),
            std::io::Error::last_os_error()
        ));
    }
    // SAFETY: CreateFileW above returned an owned, valid handle.
    let file = unsafe { File::from_raw_handle(handle as RawHandle) };

    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { zeroed() };
    if unsafe { GetFileInformationByHandle(file.as_raw_handle() as _, &mut info) } == 0 {
        return Err(format!(
            "cannot inspect {}: {}",
            path.display(),
            std::io::Error::last_os_error()
        ));
    }
    if info.dwFileAttributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DIRECTORY) != 0
        || unsafe { GetFileType(file.as_raw_handle() as _) } != FILE_TYPE_DISK
    {
        return Err(format!(
            "{} is not a regular, non-reparse file",
            path.display()
        ));
    }
    let size = (u64::from(info.nFileSizeHigh) << 32) | u64::from(info.nFileSizeLow);
    if size > MAX_DISCOVERY_BYTES {
        return Err(format!("{} is unexpectedly large", path.display()));
    }

    // GetSecurityInfo returns a self-contained descriptor for this handle. The
    // ownership and DACL checks are therefore bound to the object read below,
    // rather than a path that could be replaced between checks.
    let mut owner = std::ptr::null_mut();
    let mut dacl = std::ptr::null_mut();
    let mut descriptor = std::ptr::null_mut();
    let security_error = unsafe {
        GetSecurityInfo(
            file.as_raw_handle() as _,
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            &mut owner,
            std::ptr::null_mut(),
            &mut dacl,
            std::ptr::null_mut(),
            &mut descriptor,
        )
    };
    if security_error != 0 {
        return Err(format!(
            "cannot inspect permissions for {}: Windows error {security_error}",
            path.display()
        ));
    }
    let permissions = unsafe { windows_discovery_permissions_are_private(owner, dacl) };
    // SAFETY: GetSecurityInfo allocated this descriptor with LocalAlloc.
    unsafe { windows_sys::Win32::Foundation::LocalFree(descriptor as _) };
    permissions.map_err(|reason| format!("{} {reason}", path.display()))?;

    let mut contents = String::new();
    file.take(MAX_DISCOVERY_BYTES + 1)
        .read_to_string(&mut contents)
        .map_err(|err| format!("cannot read {}: {err}", path.display()))?;
    if contents.len() as u64 > MAX_DISCOVERY_BYTES {
        return Err(format!("{} is unexpectedly large", path.display()));
    }
    Ok(contents)
}

/// Verifies the handle's owner and DACL. An absent DACL grants everyone full
/// access, and an allow ACE for an identity other than the owner, SYSTEM, or
/// Administrators can expose or replace the capability, so both fail closed.
#[cfg(windows)]
unsafe fn windows_discovery_permissions_are_private(
    owner: windows_sys::Win32::Security::PSID,
    dacl: *mut windows_sys::Win32::Security::ACL,
) -> Result<(), &'static str> {
    use std::mem::size_of;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::Security::{
        EqualSid, GetTokenInformation, TokenUser, TOKEN_QUERY, TOKEN_USER,
    };
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    if owner.is_null() || dacl.is_null() {
        return Err("does not have an owner-private DACL");
    }
    let mut token: HANDLE = std::ptr::null_mut();
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
        return Err("cannot determine the current user");
    }
    let mut size = 0;
    unsafe { GetTokenInformation(token, TokenUser, std::ptr::null_mut(), 0, &mut size) };
    if (size as usize) < size_of::<TOKEN_USER>() {
        unsafe { CloseHandle(token) };
        return Err("cannot determine the current user");
    }
    let mut bytes = vec![0_usize; (size as usize).div_ceil(size_of::<usize>())];
    let ok = unsafe {
        GetTokenInformation(token, TokenUser, bytes.as_mut_ptr().cast(), size, &mut size)
    } != 0;
    unsafe { CloseHandle(token) };
    if !ok || bytes.len() * size_of::<usize>() < size_of::<TOKEN_USER>() {
        return Err("cannot determine the current user");
    }
    let current_user = unsafe { (*(bytes.as_ptr().cast::<TOKEN_USER>())).User.Sid };
    if current_user.is_null() || unsafe { EqualSid(owner, current_user) } == 0 {
        return Err("is not owned by the current user");
    }

    // ACL and ACE layouts start with these fixed Windows ABI fields. Parsing
    // only ordinary/callback allow ACEs lets us fail closed on every less
    // familiar ACE type rather than accidentally treating it as private.
    let acl = unsafe { &*dacl };
    let mut offset = size_of::<windows_sys::Win32::Security::ACL>();
    let acl_size = usize::from(acl.AclSize);
    if acl_size < offset {
        return Err("has a malformed DACL");
    }
    for _ in 0..acl.AceCount {
        if offset.checked_add(8).is_none_or(|end| end > acl_size) {
            return Err("has a malformed DACL");
        }
        let ace = unsafe { (dacl as *const u8).add(offset) };
        let ace_type = unsafe { *ace };
        let ace_size = usize::from(unsafe { *(ace.add(2).cast::<u16>()) });
        if ace_size < 8
            || ace_size % 4 != 0
            || offset
                .checked_add(ace_size)
                .is_none_or(|end| end > acl_size)
        {
            return Err("has a malformed DACL");
        }
        // ACCESS_ALLOWED_ACE_TYPE and ACCESS_ALLOWED_CALLBACK_ACE_TYPE.
        if matches!(ace_type, 0 | 9) {
            let sid = unsafe { ace.add(8).cast_mut().cast() };
            if !unsafe { windows_ace_sid_is_trusted(sid, ace_size - 8, current_user) } {
                return Err("is accessible by other users");
            }
        } else if !matches!(ace_type, 1 | 6 | 10 | 12) {
            // Deny ACEs only further restrict access. Every other ACE type is
            // rejected, including object/callback allow ACEs whose SID has a
            // variable layout, so an unfamiliar granting ACE cannot slip by.
            return Err("has an unsupported DACL entry");
        }
        offset += ace_size;
    }
    Ok(())
}

#[cfg(windows)]
unsafe fn windows_ace_sid_is_trusted(
    sid: windows_sys::Win32::Security::PSID,
    available_bytes: usize,
    current_user: windows_sys::Win32::Security::PSID,
) -> bool {
    use windows_sys::Win32::Security::EqualSid;

    if sid.is_null() || available_bytes < 8 {
        return false;
    }
    // The SID is embedded in the ACE, so validate its variable-length layout
    // against that ACE before passing it to Win32 or inspecting its fields.
    let sid = sid as *const u8;
    let revision = unsafe { *sid };
    let count = unsafe { *sid.add(1) };
    let Some(sid_len) = 8usize.checked_add(usize::from(count).saturating_mul(4)) else {
        return false;
    };
    if revision != 1 || sid_len > available_bytes {
        return false;
    }
    if unsafe { EqualSid(sid.cast_mut().cast(), current_user) } != 0 {
        return true;
    }
    // S-1-5-18 (LOCAL SYSTEM) and S-1-5-32-544 (BUILTIN\\Administrators)
    // are privileged principals, not other unprivileged users.
    let authority = unsafe { std::slice::from_raw_parts(sid.add(2), 6) };
    let sub_authorities =
        unsafe { std::slice::from_raw_parts(sid.add(8).cast::<u32>(), usize::from(count)) };
    authority == [0, 0, 0, 0, 0, 5] && matches!(sub_authorities, [18] | [32, 544])
}

#[cfg(all(not(unix), not(windows)))]
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
