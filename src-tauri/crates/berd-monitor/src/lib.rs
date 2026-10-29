use fs2::FileExt;
use serde::{Deserialize, Serialize};
use std::{
    env,
    fs::{self, OpenOptions},
    io::{self, Read},
    path::{Path, PathBuf},
};

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunningMonitorDescriptor {
    pub session_id: String,
    pub state_key: String,
    pub label: String,
    #[serde(default)]
    pub instance_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<u64>,
    #[serde(default)]
    pub stopping: bool,
}

#[derive(Clone, Debug)]
pub struct StatePaths {
    pub root: PathBuf,
    pub log: PathBuf,
    pub pending: PathBuf,
    pub owner: PathBuf,
    pub descriptor: PathBuf,
}

impl StatePaths {
    pub fn for_key(key: &str, session_id: &str) -> Self {
        let suffix = stable_hash(format!("{session_id}\0{key}").as_bytes());
        let safe = key
            .chars()
            .take(80)
            .map(|c| {
                if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
                    c
                } else {
                    '-'
                }
            })
            .collect::<String>();
        let root = state_base_dir().join(format!("{safe}-{suffix:016x}"));
        Self {
            log: root.join("watcher.log"),
            pending: root.join("pending.txt"),
            owner: root.join("owner.pid"),
            descriptor: root.join("descriptor.json"),
            root,
        }
    }
    pub fn launch_status(&self, token: &str) -> PathBuf {
        self.root.join(format!("launch-{token}.status"))
    }
    pub fn stop_for(&self, owner_token: &str) -> PathBuf {
        self.root.join(format!(
            "stop-{:016x}.requested",
            stable_hash(owner_token.as_bytes())
        ))
    }
}

pub fn state_base_dir() -> PathBuf {
    if let Some(explicit) = env::var_os("BERD_MONITOR_STATE_DIR") {
        return PathBuf::from(explicit);
    }
    #[cfg(target_os = "windows")]
    if let Some(local) = env::var_os("LOCALAPPDATA") {
        return PathBuf::from(local).join("Berd").join("monitor");
    }
    #[cfg(target_os = "macos")]
    if let Some(home) = env::var_os("HOME") {
        return PathBuf::from(home)
            .join("Library")
            .join("Caches")
            .join("Berd")
            .join("monitor");
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        if let Some(runtime) = env::var_os("XDG_RUNTIME_DIR") {
            return PathBuf::from(runtime).join("berd-monitor");
        }
        if let Some(state) = env::var_os("XDG_STATE_HOME") {
            return PathBuf::from(state).join("berd").join("monitor");
        }
        if let Some(home) = env::var_os("HOME") {
            return PathBuf::from(home)
                .join(".local")
                .join("state")
                .join("berd")
                .join("monitor");
        }
    }
    env::temp_dir().join(format!("berd-monitor-{}", current_user_suffix()))
}
#[cfg(unix)]
fn current_user_suffix() -> u32 {
    unsafe { libc::geteuid() }
}
#[cfg(windows)]
fn current_user_suffix() -> u32 {
    std::process::id()
}
pub fn stable_hash(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf29ce484222325, |h, b| {
        (h ^ u64::from(*b)).wrapping_mul(0x100000001b3)
    })
}

/// Request producer shutdown, optionally restricted to the instance shown to a caller.
pub fn request_stop(
    state_key: &str,
    session_id: &str,
    expected_instance: Option<&str>,
) -> io::Result<()> {
    request_stop_for(
        &StatePaths::for_key(state_key, session_id),
        expected_instance,
    )
}

/// Claim monitor ownership until this file handle is closed.
/// On Windows, reserve a byte beyond the token so other handles can read it.
/// Whole-file fs2 probes and legacy owners still conflict with this lock.
pub fn try_claim_owner(owner: &fs::File) -> io::Result<()> {
    #[cfg(unix)]
    {
        owner.try_lock_exclusive()
    }
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::{
            Storage::FileSystem::{LockFileEx, LOCKFILE_EXCLUSIVE_LOCK, LOCKFILE_FAIL_IMMEDIATELY},
            System::IO::OVERLAPPED,
        };

        // Tokens occupy only bytes below 4096. Keep the original handle alive:
        // closing a temporary handle here would release the ownership lock.
        let mut overlapped: OVERLAPPED = unsafe { std::mem::zeroed() };
        overlapped.Anonymous.Anonymous.Offset = 4096;
        let locked = unsafe {
            LockFileEx(
                owner.as_raw_handle(),
                LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY,
                0,
                1,
                0,
                &mut overlapped,
            )
        };
        if locked == 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(())
        }
    }
}

fn locked_owner_token(owner: &mut fs::File) -> io::Result<String> {
    match owner.try_lock_exclusive() {
        Ok(()) => {
            return Err(io::Error::new(
                io::ErrorKind::NotFound,
                "monitor is not running",
            ))
        }
        Err(error) if error.raw_os_error() == fs2::lock_contended_error().raw_os_error() => {}
        Err(error) => return Err(error),
    }
    let mut token = String::new();
    owner.take(4096).read_to_string(&mut token)?;
    let token = token.trim();
    if token.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "monitor owner token is empty",
        ));
    }
    Ok(token.to_owned())
}

fn request_stop_for(paths: &StatePaths, expected_instance: Option<&str>) -> io::Result<()> {
    let mut owner = OpenOptions::new()
        .read(true)
        .write(true)
        .open(&paths.owner)?;
    let token = locked_owner_token(&mut owner)?;
    if expected_instance.is_some_and(|expected| expected != token) {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            "monitor instance has changed",
        ));
    }
    // A replacement can claim the owner after this check. Its different token
    // ensures this request can only stop the instance that we observed.
    fs::write(paths.stop_for(&token), b"stop\n")
}

pub fn get_running_monitors() -> io::Result<Vec<RunningMonitorDescriptor>> {
    running_monitors_in(&state_base_dir())
}

fn running_monitors_in(base: &Path) -> io::Result<Vec<RunningMonitorDescriptor>> {
    let entries = match fs::read_dir(base) {
        Ok(e) => e,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(vec![]),
        Err(e) => return Err(e),
    };
    let mut monitors: Vec<RunningMonitorDescriptor> = vec![];
    for entry in entries.flatten() {
        let root = entry.path();
        if !root.is_dir() {
            continue;
        }
        let mut owner = match OpenOptions::new()
            .read(true)
            .write(true)
            .open(root.join("owner.pid"))
        {
            Ok(f) => f,
            Err(_) => continue,
        };
        let token = match locked_owner_token(&mut owner) {
            Ok(token) => Some(token),
            // Old Windows owners lock the token bytes too. Keep only legacy
            // metadata visible, without an actionable instance or stop status.
            #[cfg(windows)]
            Err(error)
                if error.raw_os_error()
                    == Some(windows_sys::Win32::Foundation::ERROR_LOCK_VIOLATION as i32) =>
            {
                None
            }
            Err(_) => continue,
        };
        if let Ok(bytes) = fs::read(root.join("descriptor.json")) {
            if let Ok(mut descriptor) = serde_json::from_slice::<RunningMonitorDescriptor>(&bytes) {
                if let Some(token) = token {
                    if !descriptor.instance_id.is_empty() && descriptor.instance_id != token {
                        continue;
                    }
                    descriptor.instance_id = token.clone();
                    descriptor.stopping = root
                        .join(format!(
                            "stop-{:016x}.requested",
                            stable_hash(token.as_bytes())
                        ))
                        .exists();
                } else {
                    if !descriptor.instance_id.is_empty() {
                        continue;
                    }
                    descriptor.stopping = false;
                }
                monitors.push(descriptor);
            }
        }
    }
    monitors.sort_by(|a, b| (&a.session_id, &a.state_key).cmp(&(&b.session_id, &b.state_key)));
    Ok(monitors)
}
#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn descriptor(root: &Path, session_id: &str, key: &str) -> std::fs::File {
        let root = root.join(key);
        fs::create_dir_all(&root).unwrap();
        let owner = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(root.join("owner.pid"))
            .unwrap();
        fs::write(root.join("owner.pid"), format!("{key}\n")).unwrap();
        try_claim_owner(&owner).unwrap();
        fs::write(
            root.join("descriptor.json"),
            serde_json::to_vec(&RunningMonitorDescriptor {
                session_id: session_id.into(),
                state_key: key.into(),
                label: key.into(),
                instance_id: String::new(),
                command: None,
                started_at: None,
                stopping: false,
            })
            .unwrap(),
        )
        .unwrap();
        owner
    }

    // Windows must allow token reads from a second handle while ownership is live.
    #[test]
    fn live_owner_token_is_readable_across_handles() {
        let state = TempDir::new().unwrap();
        let path = state.path().join("owner.pid");
        fs::write(&path, "live-owner\n").unwrap();
        let owner = OpenOptions::new()
            .read(true)
            .write(true)
            .open(&path)
            .unwrap();
        try_claim_owner(&owner).unwrap();
        let mut reader = OpenOptions::new()
            .read(true)
            .write(true)
            .open(&path)
            .unwrap();
        assert_eq!(locked_owner_token(&mut reader).unwrap(), "live-owner");
        assert!(try_claim_owner(&reader).is_err());
        drop(owner);
        try_claim_owner(&reader).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn legacy_whole_file_lock_is_visible_but_not_actionable() {
        let state = TempDir::new().unwrap();
        let owner = descriptor(state.path(), "session", "legacy");
        drop(owner);
        let root = state.path().join("legacy");
        fs::write(
            root.join("descriptor.json"),
            br#"{"sessionId":"session","stateKey":"legacy","label":"Legacy"}"#,
        )
        .unwrap();
        let owner = OpenOptions::new()
            .read(true)
            .write(true)
            .open(root.join("owner.pid"))
            .unwrap();
        owner.try_lock_exclusive().unwrap();
        let mut reader = OpenOptions::new()
            .read(true)
            .write(true)
            .open(root.join("owner.pid"))
            .unwrap();
        assert!(try_claim_owner(&reader).is_err());
        assert_eq!(
            locked_owner_token(&mut reader).unwrap_err().raw_os_error(),
            Some(33)
        );
        let paths = StatePaths {
            owner: root.join("owner.pid"),
            descriptor: root.join("descriptor.json"),
            log: root.join("watcher.log"),
            pending: root.join("pending.txt"),
            root,
        };
        assert!(request_stop_for(&paths, None).is_err());
        assert!(!paths.stop_for("legacy").exists());
        let monitors = running_monitors_in(state.path()).unwrap();
        assert_eq!(monitors.len(), 1);
        assert!(monitors[0].instance_id.is_empty());
        assert_eq!(monitors[0].command, None);
        assert_eq!(monitors[0].started_at, None);
        assert!(!monitors[0].stopping);

        // An unreadable token must never authorize even matching modern metadata.
        let mut metadata = monitors[0].clone();
        metadata.instance_id = "legacy".into();
        fs::write(&paths.descriptor, serde_json::to_vec(&metadata).unwrap()).unwrap();
        assert!(running_monitors_in(state.path()).unwrap().is_empty());
        assert!(request_stop_for(&paths, Some("legacy")).is_err());
    }

    #[test]
    fn lists_only_locked_owners_and_ignores_corrupt_descriptors() {
        let state = TempDir::new().unwrap();
        let first = descriptor(state.path(), "session-b", "first");
        let second = descriptor(state.path(), "session-a", "second");
        let stale = descriptor(state.path(), "session-c", "stale");
        drop(stale);
        let _corrupt = descriptor(state.path(), "session-c", "corrupt");
        fs::write(state.path().join("corrupt/descriptor.json"), b"bad json").unwrap();
        let monitors = running_monitors_in(state.path()).unwrap();
        assert_eq!(
            monitors
                .iter()
                .map(|m| m.session_id.as_str())
                .collect::<Vec<_>>(),
            vec!["session-a", "session-b"]
        );
        drop(first);
        assert_eq!(running_monitors_in(state.path()).unwrap().len(), 1);
        drop(second);
        assert!(running_monitors_in(state.path()).unwrap().is_empty());
    }

    #[test]
    fn absent_state_is_empty() {
        let state = TempDir::new().unwrap();
        assert!(running_monitors_in(&state.path().join("absent"))
            .unwrap()
            .is_empty());
    }

    #[test]
    fn legacy_metadata_gets_current_instance_and_stop_status() {
        let state = TempDir::new().unwrap();
        let _owner = descriptor(state.path(), "session", "legacy");
        let root = state.path().join("legacy");
        fs::write(
            root.join("descriptor.json"),
            br#"{"sessionId":"session","stateKey":"legacy","label":"Legacy"}"#,
        )
        .unwrap();
        let monitors = running_monitors_in(state.path()).unwrap();
        assert_eq!(monitors[0].instance_id, "legacy");
        assert_eq!(monitors[0].command, None);
        assert_eq!(monitors[0].started_at, None);
        assert!(!monitors[0].stopping);
        fs::write(
            root.join(format!("stop-{:016x}.requested", stable_hash(b"legacy"))),
            b"stop\n",
        )
        .unwrap();
        assert!(running_monitors_in(state.path()).unwrap()[0].stopping);
    }

    #[test]
    fn replacement_owner_hides_stale_metadata() {
        let state = TempDir::new().unwrap();
        let owner = descriptor(state.path(), "session", "replace");
        drop(owner);
        let root = state.path().join("replace");
        fs::write(root.join("owner.pid"), "replacement\n").unwrap();
        let owner = OpenOptions::new()
            .read(true)
            .write(true)
            .open(root.join("owner.pid"))
            .unwrap();
        try_claim_owner(&owner).unwrap();
        let mut metadata: RunningMonitorDescriptor =
            serde_json::from_slice(&fs::read(root.join("descriptor.json")).unwrap()).unwrap();
        metadata.instance_id = "previous".into();
        fs::write(
            root.join("descriptor.json"),
            serde_json::to_vec(&metadata).unwrap(),
        )
        .unwrap();
        assert!(running_monitors_in(state.path()).unwrap().is_empty());
        metadata.instance_id = "replacement".into();
        fs::write(
            root.join("descriptor.json"),
            serde_json::to_vec(&metadata).unwrap(),
        )
        .unwrap();
        assert_eq!(running_monitors_in(state.path()).unwrap().len(), 1);
    }

    #[test]
    fn stop_requires_locked_owner_and_matching_instance() {
        let state = TempDir::new().unwrap();
        let paths = StatePaths {
            root: state.path().to_owned(),
            owner: state.path().join("owner.pid"),
            descriptor: state.path().join("descriptor.json"),
            log: state.path().join("watcher.log"),
            pending: state.path().join("pending.txt"),
        };
        fs::write(&paths.owner, "first\n").unwrap();
        assert!(request_stop_for(&paths, Some("first")).is_err());
        assert!(!paths.stop_for("first").exists());
        let owner = OpenOptions::new()
            .read(true)
            .write(true)
            .open(&paths.owner)
            .unwrap();
        try_claim_owner(&owner).unwrap();
        assert!(request_stop_for(&paths, Some("wrong")).is_err());
        assert!(!paths.stop_for("wrong").exists());
        request_stop_for(&paths, Some("first")).unwrap();
        assert!(paths.stop_for("first").exists());
        drop(owner);
        fs::write(&paths.owner, "second\n").unwrap();
        let replacement = OpenOptions::new()
            .read(true)
            .write(true)
            .open(&paths.owner)
            .unwrap();
        try_claim_owner(&replacement).unwrap();
        assert!(request_stop_for(&paths, Some("first")).is_err());
        assert!(!paths.stop_for("second").exists());
        request_stop_for(&paths, None).unwrap();
        assert!(paths.stop_for("second").exists());
    }
}
