//! Generic process helpers.

/// Suppress the console window a GUI-subsystem parent would otherwise allocate
/// when spawning a console-subsystem child. Redirecting or piping stdio does
/// not prevent that flash on Windows; `CREATE_NO_WINDOW` does.
pub(crate) fn apply_no_window(command: &mut std::process::Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;

        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    {
        let _ = command;
    }
}

/// Tokio equivalent of [`apply_no_window`]. Keep both entry points here so
/// synchronous and asynchronous subprocesses follow the same policy.
pub(crate) fn apply_no_window_async(command: &mut tokio::process::Command) {
    apply_no_window(command.as_std_mut());
}

#[cfg(unix)]
pub(crate) type ProcessId = libc::pid_t;
#[cfg(windows)]
pub(crate) type ProcessId = u32;

pub(crate) fn pid_t_from_u32(pid: u32) -> Option<ProcessId> {
    platform_pid_from_u32(pid)
}

#[cfg(unix)]
fn platform_pid_from_u32(pid: u32) -> Option<ProcessId> {
    pid.try_into().ok()
}

#[cfg(windows)]
fn platform_pid_from_u32(pid: u32) -> Option<ProcessId> {
    Some(pid)
}

#[cfg(unix)]
pub(crate) fn process_is_alive(pid: ProcessId) -> bool {
    // SAFETY: sending signal 0 to check process existence.
    if unsafe { libc::kill(pid, 0) } == 0 {
        return true;
    }

    std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

#[cfg(windows)]
mod windows_identity;

#[cfg(windows)]
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub(crate) struct ProcessIdentity {
    pub pid: u32,
    pub created_at: u64,
    pub exe: String,
}

#[cfg(windows)]
impl ProcessIdentity {
    fn matches(&self, other: &Self) -> bool {
        self.pid == other.pid
            && self.created_at == other.created_at
            && windows_identity::executable_paths_match(&self.exe, &other.exe)
    }
}

#[cfg(windows)]
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum IdentityProbe {
    Matches,
    Mismatch,
    Gone,
    Unverifiable,
}

#[cfg(windows)]
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum IdentifiedKillOutcome {
    KilledAndExited,
    AlreadyGone,
    IdentityMismatch,
}

#[cfg(windows)]
impl IdentifiedKillOutcome {
    pub(crate) fn exit_confirmed(&self) -> bool {
        matches!(
            self,
            Self::KilledAndExited | Self::AlreadyGone | Self::IdentityMismatch
        )
    }
}

#[cfg(windows)]
pub(crate) fn process_is_alive(pid: ProcessId) -> bool {
    use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};

    let mut system = System::new();
    let pid = Pid::from_u32(pid);
    system.refresh_processes_specifics(
        ProcessesToUpdate::Some(&[pid]),
        true,
        ProcessRefreshKind::nothing(),
    );
    system.process(pid).is_some()
}

#[cfg(unix)]
pub(crate) fn terminate_process(pid: ProcessId) -> bool {
    // SAFETY: sending SIGTERM to a process id we previously recorded.
    unsafe { libc::kill(pid, libc::SIGTERM) == 0 }
}

#[cfg(unix)]
pub(crate) fn kill_process(pid: ProcessId) -> bool {
    // SAFETY: sending SIGKILL as a last resort to a process id we previously recorded.
    unsafe { libc::kill(pid, libc::SIGKILL) == 0 }
}

#[cfg(windows)]
pub(crate) fn capture_process_identity(pid: u32) -> std::io::Result<ProcessIdentity> {
    windows_identity::capture(pid)
}

#[cfg(windows)]
pub(crate) fn probe_process_identity(identity: &ProcessIdentity) -> IdentityProbe {
    use windows_sys::Win32::Foundation::ERROR_INVALID_PARAMETER;

    match capture_process_identity(identity.pid) {
        Ok(current) if current.matches(identity) => IdentityProbe::Matches,
        Ok(_) => IdentityProbe::Mismatch,
        Err(error) if error.raw_os_error() == Some(ERROR_INVALID_PARAMETER as i32) => {
            IdentityProbe::Gone
        }
        Err(_) => IdentityProbe::Unverifiable,
    }
}

/// # Safety
/// `handle` must remain a valid process handle with query-limited-information access.
#[cfg(windows)]
pub(crate) unsafe fn process_identity_from_handle(
    handle: *mut std::ffi::c_void,
) -> std::io::Result<ProcessIdentity> {
    unsafe { windows_identity::identity_from_handle(handle as _) }
}

/// # Safety
/// `handle` must remain a valid process handle with terminate and synchronize access.
#[cfg(all(windows, not(feature = "berdctl")))]
pub(crate) unsafe fn terminate_process_handle(
    handle: *mut std::ffi::c_void,
    wait: std::time::Duration,
) -> std::io::Result<()> {
    unsafe { windows_identity::terminate_handle(handle as _, wait) }
}

#[cfg(windows)]
pub(crate) fn kill_process_if_identity_matches(
    identity: &ProcessIdentity,
    wait: std::time::Duration,
) -> std::io::Result<IdentifiedKillOutcome> {
    windows_identity::kill_if_identity_matches(identity, wait)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    const CONSOLE_WINDOW_PROBE: &str = r#"
        Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class ConsoleProbe { [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow(); }';
        if ([ConsoleProbe]::GetConsoleWindow() -ne [IntPtr]::Zero) { exit 7 }
    "#;

    #[cfg(windows)]
    #[test]
    fn std_background_command_has_no_console_window() {
        let mut command = std::process::Command::new("powershell.exe");
        command.args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            CONSOLE_WINDOW_PROBE,
        ]);
        apply_no_window(&mut command);

        let output = command.output().expect("run console-window probe");
        assert!(
            output.status.success(),
            "background child had a console window: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn async_background_command_has_no_console_window() {
        let mut command = tokio::process::Command::new("powershell.exe");
        command.args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            CONSOLE_WINDOW_PROBE,
        ]);
        apply_no_window_async(&mut command);

        let output = command.output().await.expect("run console-window probe");
        assert!(
            output.status.success(),
            "background child had a console window: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[cfg(unix)]
    #[test]
    fn pid_t_from_u32_accepts_pid_t_boundary() {
        let max_pid = u32::try_from(libc::pid_t::MAX).expect("pid_t max should fit in u32");

        assert_eq!(pid_t_from_u32(max_pid), Some(libc::pid_t::MAX));
    }

    #[cfg(unix)]
    #[test]
    fn pid_t_from_u32_rejects_values_outside_pid_t_range() {
        let max_pid = u32::try_from(libc::pid_t::MAX).expect("pid_t max should fit in u32");
        assert_eq!(pid_t_from_u32(max_pid + 1), None);
        assert_eq!(pid_t_from_u32(u32::MAX), None);
    }

    #[cfg(windows)]
    #[test]
    fn pid_t_from_u32_accepts_windows_process_ids() {
        assert_eq!(pid_t_from_u32(u32::MAX), Some(u32::MAX));
    }

    #[cfg(windows)]
    #[test]
    fn current_process_identity_is_stable_and_probeable() {
        let identity =
            capture_process_identity(std::process::id()).expect("capture current process identity");

        assert_eq!(identity.pid, std::process::id());
        assert_ne!(identity.created_at, 0);
        assert!(!identity.exe.is_empty());
        assert_eq!(probe_process_identity(&identity), IdentityProbe::Matches);
    }

    #[cfg(windows)]
    #[test]
    fn changed_creation_time_does_not_match_current_process() {
        let mut identity =
            capture_process_identity(std::process::id()).expect("capture current process identity");
        identity.created_at = identity.created_at.wrapping_add(1);

        assert_eq!(probe_process_identity(&identity), IdentityProbe::Mismatch);
    }
}
