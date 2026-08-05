//! Generic process-liveness helpers.

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
pub(crate) fn terminate_process(pid: ProcessId) -> bool {
    kill_process(pid)
}

#[cfg(windows)]
pub(crate) fn kill_process(pid: ProcessId) -> bool {
    use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};

    let mut system = System::new();
    let pid = Pid::from_u32(pid);
    system.refresh_processes_specifics(
        ProcessesToUpdate::Some(&[pid]),
        true,
        ProcessRefreshKind::nothing(),
    );
    system.process(pid).is_some_and(|process| process.kill())
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
