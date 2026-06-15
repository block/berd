//! Generic process-liveness helpers.

pub(crate) fn pid_t_from_u32(pid: u32) -> Option<libc::pid_t> {
    pid.try_into().ok()
}

pub(crate) fn process_is_alive(pid: libc::pid_t) -> bool {
    // SAFETY: sending signal 0 to check process existence.
    if unsafe { libc::kill(pid, 0) } == 0 {
        return true;
    }

    std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pid_t_from_u32_accepts_pid_t_boundary() {
        let max_pid = u32::try_from(libc::pid_t::MAX).expect("pid_t max should fit in u32");

        assert_eq!(pid_t_from_u32(max_pid), Some(libc::pid_t::MAX));
    }

    #[test]
    fn pid_t_from_u32_rejects_values_outside_pid_t_range() {
        let max_pid = u32::try_from(libc::pid_t::MAX).expect("pid_t max should fit in u32");
        assert_eq!(pid_t_from_u32(max_pid + 1), None);
        assert_eq!(pid_t_from_u32(u32::MAX), None);
    }
}
