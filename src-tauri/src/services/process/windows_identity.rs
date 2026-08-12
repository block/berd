use std::io;
use std::time::Duration;

use windows_sys::Win32::Foundation::{
    CloseHandle, ERROR_INVALID_PARAMETER, FILETIME, HANDLE, WAIT_FAILED, WAIT_OBJECT_0,
};
use windows_sys::Win32::Globalization::{CompareStringOrdinal, CSTR_EQUAL};
use windows_sys::Win32::System::Threading::{
    GetProcessId, GetProcessTimes, OpenProcess, QueryFullProcessImageNameW, TerminateProcess,
    WaitForSingleObject, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_TERMINATE,
};

use super::{IdentifiedKillOutcome, ProcessIdentity};

const SYNCHRONIZE: u32 = 0x0010_0000;

fn filetime_ticks(filetime: &FILETIME) -> u64 {
    ((filetime.dwHighDateTime as u64) << 32) | filetime.dwLowDateTime as u64
}

fn normalize_executable(path: &str) -> String {
    let path = path.replace('/', "\\");
    if let Some(rest) = path.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = path.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        path
    }
}

pub(super) fn executable_paths_match(left: &str, right: &str) -> bool {
    use std::os::windows::ffi::OsStrExt;

    let left: Vec<u16> = std::ffi::OsStr::new(left).encode_wide().collect();
    let right: Vec<u16> = std::ffi::OsStr::new(right).encode_wide().collect();
    let (Ok(left_len), Ok(right_len)) = (i32::try_from(left.len()), i32::try_from(right.len()))
    else {
        return false;
    };
    // SAFETY: both pointers reference initialized UTF-16 buffers of the supplied lengths.
    unsafe {
        CompareStringOrdinal(
            left.as_ptr(),
            left_len,
            right.as_ptr(),
            right_len,
            true.into(),
        ) == CSTR_EQUAL
    }
}

/// # Safety
/// `handle` must be a valid process handle with query-limited-information access.
pub(super) unsafe fn identity_from_handle(handle: HANDLE) -> io::Result<ProcessIdentity> {
    let pid = unsafe { GetProcessId(handle) };
    if pid == 0 {
        return Err(io::Error::last_os_error());
    }

    let mut creation: FILETIME = unsafe { std::mem::zeroed() };
    let mut exit: FILETIME = unsafe { std::mem::zeroed() };
    let mut kernel: FILETIME = unsafe { std::mem::zeroed() };
    let mut user: FILETIME = unsafe { std::mem::zeroed() };
    if unsafe { GetProcessTimes(handle, &mut creation, &mut exit, &mut kernel, &mut user) } == 0 {
        return Err(io::Error::last_os_error());
    }

    let mut buffer = vec![0u16; 32_768];
    let mut len = buffer.len() as u32;
    if unsafe { QueryFullProcessImageNameW(handle, 0, buffer.as_mut_ptr(), &mut len) } == 0 {
        return Err(io::Error::last_os_error());
    }

    Ok(ProcessIdentity {
        pid,
        created_at: filetime_ticks(&creation),
        exe: normalize_executable(&String::from_utf16_lossy(&buffer[..len as usize])),
    })
}

pub(super) fn capture(pid: u32) -> io::Result<ProcessIdentity> {
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if handle.is_null() {
        return Err(io::Error::last_os_error());
    }
    let result = unsafe { identity_from_handle(handle) };
    unsafe { CloseHandle(handle) };
    result
}

/// # Safety
/// `handle` must be a valid process handle with terminate and synchronize access.
pub(super) unsafe fn terminate_handle(handle: HANDLE, wait: Duration) -> io::Result<()> {
    if unsafe { TerminateProcess(handle, 1) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let wait_ms = wait.as_millis().min(u32::MAX as u128) as u32;
    match unsafe { WaitForSingleObject(handle, wait_ms) } {
        WAIT_OBJECT_0 => Ok(()),
        WAIT_FAILED => Err(io::Error::last_os_error()),
        _ => Err(io::Error::new(
            io::ErrorKind::TimedOut,
            "process did not exit before timeout",
        )),
    }
}

pub(super) fn kill_if_identity_matches(
    identity: &ProcessIdentity,
    wait: Duration,
) -> io::Result<IdentifiedKillOutcome> {
    let handle = unsafe {
        OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE | SYNCHRONIZE,
            0,
            identity.pid,
        )
    };
    if handle.is_null() {
        let error = io::Error::last_os_error();
        return if error.raw_os_error() == Some(ERROR_INVALID_PARAMETER as i32) {
            Ok(IdentifiedKillOutcome::AlreadyGone)
        } else {
            Err(error)
        };
    }

    let result = (|| {
        let current = unsafe { identity_from_handle(handle) }?;
        if !current.matches(identity) {
            return Ok(IdentifiedKillOutcome::IdentityMismatch);
        }
        unsafe { terminate_handle(handle, wait) }?;
        Ok(IdentifiedKillOutcome::KilledAndExited)
    })();
    unsafe { CloseHandle(handle) };
    result
}
