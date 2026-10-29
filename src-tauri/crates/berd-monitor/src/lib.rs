use fs2::FileExt;
use serde::{Deserialize, Serialize};
use std::{
    env,
    fs::{self, OpenOptions},
    io,
    path::{Path, PathBuf},
};

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunningMonitorDescriptor {
    pub session_id: String,
    pub state_key: String,
    pub label: String,
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
        let owner = match OpenOptions::new()
            .read(true)
            .write(true)
            .open(root.join("owner.pid"))
        {
            Ok(f) => f,
            Err(_) => continue,
        };
        match owner.try_lock_exclusive() {
            Ok(()) => continue,
            Err(error) if error.raw_os_error() == fs2::lock_contended_error().raw_os_error() => {}
            Err(_) => continue,
        }
        if let Ok(bytes) = fs::read(root.join("descriptor.json")) {
            if let Ok(d) = serde_json::from_slice(&bytes) {
                monitors.push(d);
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
        owner.try_lock_exclusive().unwrap();
        fs::write(
            root.join("descriptor.json"),
            serde_json::to_vec(&RunningMonitorDescriptor {
                session_id: session_id.into(),
                state_key: key.into(),
                label: key.into(),
            })
            .unwrap(),
        )
        .unwrap();
        owner
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
}
