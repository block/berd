//! Kernel-backed admission for berdctl bootstrap connections.
//!
//! A caller is admitted only when its process belongs to the current Berd-owned
//! `goosed` tree. Unix proves that by walking stable `(pid, start time)` process
//! snapshots to the retained root. Windows uses an exact, retained Job Object;
//! logical parent PIDs are not an authorization primitive there.

use std::io;
use std::sync::{Arc, OnceLock, RwLock};

static AUTHORIZER: OnceLock<ProcessAuthorizer> = OnceLock::new();

pub(crate) fn authorizer() -> ProcessAuthorizer {
    AUTHORIZER.get_or_init(ProcessAuthorizer::default).clone()
}

pub fn prepare_goosed(command: &mut tokio::process::Command) -> io::Result<GoosedAuthorization> {
    prepare_goosed_authorization(authorizer(), command)
}

#[derive(Clone, Default)]
pub(crate) struct ProcessAuthorizer {
    root: Arc<RwLock<Option<PlatformRoot>>>,
}

impl ProcessAuthorizer {
    pub(crate) fn authorize(&self, pid: u32) -> io::Result<bool> {
        let root = self.root.read().unwrap();
        let Some(root) = root.as_ref() else {
            return Ok(false);
        };
        root.authorize(pid)
    }

    #[cfg(unix)]
    pub(crate) fn install_root(&self, pid: u32) -> io::Result<()> {
        let root = PlatformRoot::capture(pid)?;
        *self.root.write().unwrap() = Some(root);
        Ok(())
    }

    #[cfg(windows)]
    fn install_job(&self, job: Arc<WindowsJob>) {
        *self.root.write().unwrap() = Some(PlatformRoot { job });
    }

    #[cfg(windows)]
    fn revoke_job(&self, job: &Arc<WindowsJob>) {
        let mut root = self.root.write().unwrap();
        if root
            .as_ref()
            .is_some_and(|root| Arc::ptr_eq(&root.job, job))
        {
            *root = None;
        }
    }
}

#[cfg(unix)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct ProcessSnapshot {
    pid: u32,
    parent_pid: u32,
    started_at: u64,
}

#[cfg(unix)]
#[derive(Clone, Copy)]
struct PlatformRoot(ProcessSnapshot);

#[cfg(unix)]
impl PlatformRoot {
    fn capture(pid: u32) -> io::Result<Self> {
        Ok(Self(process_snapshot(pid)?))
    }

    fn authorize(&self, peer_pid: u32) -> io::Result<bool> {
        self.authorize_with(peer_pid, process_snapshot)
    }

    fn authorize_with(
        &self,
        peer_pid: u32,
        mut snapshot_for: impl FnMut(u32) -> io::Result<ProcessSnapshot>,
    ) -> io::Result<bool> {
        const MAX_DEPTH: usize = 128;
        let mut pid = peer_pid;
        let mut chain = Vec::new();
        for _ in 0..MAX_DEPTH {
            if pid == 0
                || chain
                    .iter()
                    .any(|snapshot: &ProcessSnapshot| snapshot.pid == pid)
            {
                return Ok(false);
            }
            let snapshot = snapshot_for(pid)?;
            chain.push(snapshot);
            if snapshot == self.0 {
                // Re-read every hop after reaching the root. Any PID reuse or
                // parent mutation observed during the walk fails closed.
                for expected in &chain {
                    if snapshot_for(expected.pid)? != *expected {
                        return Ok(false);
                    }
                }
                return Ok(true);
            }
            pid = snapshot.parent_pid;
        }
        Ok(false)
    }
}

#[cfg(target_os = "linux")]
fn process_snapshot(pid: u32) -> io::Result<ProcessSnapshot> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat"))?;
    let close = stat.rfind(')').ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            "missing process comm terminator",
        )
    })?;
    let fields: Vec<&str> = stat[close + 1..].split_whitespace().collect();
    // After `comm`, fields[0] is state (field 3), fields[1] is ppid (4), and
    // fields[19] is starttime (22).
    if fields.len() <= 19 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "truncated process stat",
        ));
    }
    let parent_pid = fields[1]
        .parse()
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "invalid parent pid"))?;
    let started_at = fields[19]
        .parse()
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "invalid process start time"))?;
    Ok(ProcessSnapshot {
        pid,
        parent_pid,
        started_at,
    })
}

#[cfg(target_os = "macos")]
fn process_snapshot(pid: u32) -> io::Result<ProcessSnapshot> {
    let pid_i32 = i32::try_from(pid)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "pid outside platform range"))?;
    let mut info = std::mem::MaybeUninit::<libc::proc_bsdinfo>::zeroed();
    let expected = std::mem::size_of::<libc::proc_bsdinfo>();
    // SAFETY: `info` points to writable storage of exactly the supplied size.
    let read = unsafe {
        libc::proc_pidinfo(
            pid_i32,
            libc::PROC_PIDTBSDINFO,
            0,
            info.as_mut_ptr().cast(),
            expected as i32,
        )
    };
    if read != expected as i32 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: proc_pidinfo initialized the full structure, verified above.
    let info = unsafe { info.assume_init() };
    Ok(ProcessSnapshot {
        pid: info.pbi_pid,
        parent_pid: info.pbi_ppid,
        started_at: info
            .pbi_start_tvsec
            .saturating_mul(1_000_000)
            .saturating_add(info.pbi_start_tvusec),
    })
}

#[cfg(all(unix, not(any(target_os = "linux", target_os = "macos"))))]
fn process_snapshot(_pid: u32) -> io::Result<ProcessSnapshot> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "berdctl process admission is unsupported on this Unix platform",
    ))
}

#[cfg(windows)]
struct PlatformRoot {
    job: Arc<WindowsJob>,
}

#[cfg(windows)]
impl PlatformRoot {
    fn authorize(&self, pid: u32) -> io::Result<bool> {
        self.job.contains_pid(pid)
    }
}

/// Spawn authorization guard. On Windows it owns the exact no-breakaway Job
/// Object and keeps the child suspended until admission is established.
pub struct GoosedAuthorization {
    authorizer: ProcessAuthorizer,
    #[cfg(windows)]
    job: Arc<WindowsJob>,
}

pub(crate) fn prepare_goosed_authorization(
    authorizer: ProcessAuthorizer,
    command: &mut tokio::process::Command,
) -> io::Result<GoosedAuthorization> {
    #[cfg(windows)]
    {
        let job = Arc::new(WindowsJob::new()?);
        command.creation_flags(
            windows_sys::Win32::System::Threading::CREATE_NO_WINDOW
                | windows_sys::Win32::System::Threading::CREATE_SUSPENDED,
        );
        Ok(GoosedAuthorization { authorizer, job })
    }
    #[cfg(not(windows))]
    {
        let _ = command;
        Ok(GoosedAuthorization { authorizer })
    }
}

impl GoosedAuthorization {
    pub fn admit(self, child: &tokio::process::Child) -> io::Result<GoosedAdmission> {
        let pid = child
            .id()
            .ok_or_else(|| io::Error::other("goosed child has no process id"))?;
        #[cfg(unix)]
        {
            self.authorizer.install_root(pid)?;
            Ok(GoosedAdmission {})
        }
        #[cfg(windows)]
        {
            let process = child
                .raw_handle()
                .ok_or_else(|| io::Error::other("goosed child has no process handle"))?;
            self.job.assign_handle(process.cast(), pid)?;
            resume_process_main_thread(process.cast(), pid)?;
            self.authorizer.install_job(Arc::clone(&self.job));
            Ok(GoosedAdmission {
                authorizer: self.authorizer,
                job: self.job,
            })
        }
    }
}

/// Revocable ownership of the process tree admitted for berdctl bootstrap.
///
/// On Windows this lease retains the exact Job Object installed as the
/// authorization root. Dropping it revokes admission and closes the Job; call
/// `terminate` when shutdown must synchronously confirm the tree is gone.
pub struct GoosedAdmission {
    #[cfg(windows)]
    authorizer: ProcessAuthorizer,
    #[cfg(windows)]
    job: Arc<WindowsJob>,
}

impl GoosedAdmission {
    #[cfg(windows)]
    pub fn terminate(
        &self,
        child: &tokio::process::Child,
        timeout: std::time::Duration,
    ) -> io::Result<()> {
        let process = child
            .raw_handle()
            .ok_or_else(|| io::Error::other("goosed child has no process handle"))?;
        self.authorizer.revoke_job(&self.job);
        self.job.terminate_and_wait(process.cast(), timeout)
    }
}

#[cfg(windows)]
impl Drop for GoosedAdmission {
    fn drop(&mut self) {
        self.authorizer.revoke_job(&self.job);
    }
}

#[cfg(windows)]
struct WindowsJob {
    handle: windows_sys::Win32::Foundation::HANDLE,
}
#[cfg(windows)]
unsafe impl Send for WindowsJob {}
#[cfg(windows)]
unsafe impl Sync for WindowsJob {}

#[cfg(windows)]
impl WindowsJob {
    fn new() -> io::Result<Self> {
        use windows_sys::Win32::System::JobObjects::*;
        let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if handle.is_null() {
            return Err(io::Error::last_os_error());
        }
        let job = Self { handle };
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let ok = unsafe {
            SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                (&info as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                std::mem::size_of_val(&info) as u32,
            )
        };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(job)
    }

    fn assign_handle(
        &self,
        process: windows_sys::Win32::Foundation::HANDLE,
        expected_pid: u32,
    ) -> io::Result<()> {
        use windows_sys::Win32::Foundation::WAIT_TIMEOUT;
        use windows_sys::Win32::System::JobObjects::AssignProcessToJobObject;
        use windows_sys::Win32::System::Threading::{GetProcessId, WaitForSingleObject};
        let actual_pid = unsafe { GetProcessId(process) };
        if actual_pid == 0 {
            return Err(io::Error::last_os_error());
        }
        if actual_pid != expected_pid {
            return Err(io::Error::other("goosed process handle PID changed"));
        }
        if unsafe { WaitForSingleObject(process, 0) } != WAIT_TIMEOUT {
            return Err(io::Error::other("goosed exited before Job assignment"));
        }
        let ok = unsafe { AssignProcessToJobObject(self.handle, process) };
        if ok == 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(())
        }
    }

    fn terminate_and_wait(
        &self,
        process: windows_sys::Win32::Foundation::HANDLE,
        timeout: std::time::Duration,
    ) -> io::Result<()> {
        use windows_sys::Win32::Foundation::{WAIT_OBJECT_0, WAIT_TIMEOUT};
        use windows_sys::Win32::System::JobObjects::{
            JobObjectBasicAccountingInformation, QueryInformationJobObject, TerminateJobObject,
            JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
        };
        use windows_sys::Win32::System::Threading::WaitForSingleObject;

        if unsafe { TerminateJobObject(self.handle, 1) } == 0 {
            return Err(io::Error::last_os_error());
        }
        let deadline = std::time::Instant::now() + timeout;
        loop {
            let mut info: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = unsafe { std::mem::zeroed() };
            let queried = unsafe {
                QueryInformationJobObject(
                    self.handle,
                    JobObjectBasicAccountingInformation,
                    (&mut info as *mut JOBOBJECT_BASIC_ACCOUNTING_INFORMATION).cast(),
                    std::mem::size_of_val(&info) as u32,
                    std::ptr::null_mut(),
                )
            };
            if queried == 0 {
                return Err(io::Error::last_os_error());
            }
            let child_wait = unsafe { WaitForSingleObject(process, 0) };
            if info.ActiveProcesses == 0 && child_wait == WAIT_OBJECT_0 {
                return Ok(());
            }
            if child_wait != WAIT_OBJECT_0 && child_wait != WAIT_TIMEOUT {
                return Err(io::Error::last_os_error());
            }
            if std::time::Instant::now() >= deadline {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "timed out waiting for goosed Job to become empty",
                ));
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
    }

    fn contains_pid(&self, pid: u32) -> io::Result<bool> {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::JobObjects::IsProcessInJob;
        use windows_sys::Win32::System::Threading::{
            OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
        };
        let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
        if process.is_null() {
            return Err(io::Error::last_os_error());
        }
        let mut result = 0;
        let ok = unsafe { IsProcessInJob(process, self.handle, &mut result) };
        let error = (ok == 0).then(io::Error::last_os_error);
        unsafe { CloseHandle(process) };
        error.map_or(Ok(result != 0), Err)
    }
}

#[cfg(windows)]
impl Drop for WindowsJob {
    fn drop(&mut self) {
        unsafe { windows_sys::Win32::Foundation::CloseHandle(self.handle) };
    }
}

#[cfg(windows)]
fn resume_process_main_thread(
    process: windows_sys::Win32::Foundation::HANDLE,
    expected_pid: u32,
) -> io::Result<()> {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE, WAIT_TIMEOUT};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
    };
    use windows_sys::Win32::System::Threading::{
        GetProcessId, GetProcessIdOfThread, OpenThread, ResumeThread, WaitForSingleObject,
        THREAD_QUERY_LIMITED_INFORMATION, THREAD_SUSPEND_RESUME,
    };
    if unsafe { GetProcessId(process) } != expected_pid
        || unsafe { WaitForSingleObject(process, 0) } != WAIT_TIMEOUT
    {
        return Err(io::Error::other(
            "goosed process identity or liveness changed before resume",
        ));
    }
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    let mut entry: THREADENTRY32 = unsafe { std::mem::zeroed() };
    entry.dwSize = std::mem::size_of::<THREADENTRY32>() as u32;
    let mut thread_id = None;
    let mut current = unsafe { Thread32First(snapshot, &mut entry) };
    while current != 0 {
        if entry.th32OwnerProcessID == expected_pid
            && thread_id.replace(entry.th32ThreadID).is_some()
        {
            unsafe { CloseHandle(snapshot) };
            return Err(io::Error::other(
                "suspended goosed unexpectedly has multiple threads",
            ));
        }
        current = unsafe { Thread32Next(snapshot, &mut entry) };
    }
    unsafe { CloseHandle(snapshot) };
    let thread_id = thread_id.ok_or_else(|| io::Error::other("goosed main thread not found"))?;
    let thread = unsafe {
        OpenThread(
            THREAD_SUSPEND_RESUME | THREAD_QUERY_LIMITED_INFORMATION,
            0,
            thread_id,
        )
    };
    if thread.is_null() {
        return Err(io::Error::last_os_error());
    }
    let owner_pid = unsafe { GetProcessIdOfThread(thread) };
    if owner_pid != expected_pid {
        unsafe { CloseHandle(thread) };
        return Err(io::Error::other("goosed main thread identity changed"));
    }
    let previous_suspend_count = unsafe { ResumeThread(thread) };
    unsafe { CloseHandle(thread) };
    if previous_suspend_count != 1 {
        return Err(io::Error::other(format!(
            "goosed main thread had unexpected suspend count {previous_suspend_count}"
        )));
    }
    if unsafe { GetProcessId(process) } != expected_pid {
        return Err(io::Error::other(
            "goosed process identity changed after resume",
        ));
    }
    Ok(())
}

#[cfg(all(test, windows))]
mod windows_tests {
    use super::*;

    #[tokio::test]
    async fn suspended_child_is_assigned_resumed_revoked_and_terminated() {
        let authorizer = ProcessAuthorizer::default();
        let mut command = tokio::process::Command::new("cmd.exe");
        command.args(["/d", "/c", "ping -t 127.0.0.1 > nul"]);
        let authorization = prepare_goosed_authorization(authorizer.clone(), &mut command).unwrap();
        let mut child = command.spawn().unwrap();
        let pid = child.id().unwrap();

        let admission = authorization.admit(&child).unwrap();
        assert!(authorizer.authorize(pid).unwrap());
        assert!(!authorizer.authorize(std::process::id()).unwrap());

        admission
            .terminate(&child, std::time::Duration::from_secs(5))
            .unwrap();
        child.wait().await.unwrap();
        assert!(!authorizer.authorize(pid).unwrap());
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn snapshot(pid: u32, parent_pid: u32, started_at: u64) -> ProcessSnapshot {
        ProcessSnapshot {
            pid,
            parent_pid,
            started_at,
        }
    }

    #[test]
    fn admits_descendant_and_rejects_sibling_of_root() {
        let authorizer = ProcessAuthorizer::default();
        authorizer.install_root(std::process::id()).unwrap();
        let mut child = std::process::Command::new("sleep")
            .arg("5")
            .spawn()
            .unwrap();
        assert!(authorizer.authorize(child.id()).unwrap());
        let _ = child.kill();
        let _ = child.wait();

        let mut fake_root = std::process::Command::new("sleep")
            .arg("5")
            .spawn()
            .unwrap();
        let isolated = ProcessAuthorizer::default();
        isolated.install_root(fake_root.id()).unwrap();
        assert!(!matches!(isolated.authorize(std::process::id()), Ok(true)));
        let _ = fake_root.kill();
        let _ = fake_root.wait();
    }

    #[test]
    fn admits_multi_hop_descendant() {
        let root = snapshot(10, 1, 100);
        let snapshots = HashMap::from([
            (10, root),
            (20, snapshot(20, 10, 200)),
            (30, snapshot(30, 20, 300)),
        ]);

        assert!(PlatformRoot(root)
            .authorize_with(30, |pid| Ok(snapshots[&pid]))
            .unwrap());
    }

    #[test]
    fn rejects_when_mid_chain_snapshot_changes_during_revalidation() {
        let root = snapshot(10, 1, 100);
        let original_mid = snapshot(20, 10, 200);
        let reused_mid = snapshot(20, 10, 201);
        let leaf = snapshot(30, 20, 300);
        let mut mid_reads = 0;

        let admitted = PlatformRoot(root)
            .authorize_with(30, |pid| match pid {
                10 => Ok(root),
                20 => {
                    mid_reads += 1;
                    Ok(if mid_reads == 1 {
                        original_mid
                    } else {
                        reused_mid
                    })
                }
                30 => Ok(leaf),
                _ => Err(io::Error::new(io::ErrorKind::NotFound, "unknown pid")),
            })
            .unwrap();

        assert!(!admitted);
        assert_eq!(mid_reads, 2);
    }

    #[test]
    fn rejects_cycles_and_chains_over_depth_limit() {
        let root = snapshot(10, 1, 100);
        let cycle = HashMap::from([(20, snapshot(20, 30, 200)), (30, snapshot(30, 20, 300))]);
        assert!(!PlatformRoot(root)
            .authorize_with(30, |pid| Ok(cycle[&pid]))
            .unwrap());

        assert!(!PlatformRoot(root)
            .authorize_with(1_000, |pid| Ok(snapshot(pid, pid + 1, u64::from(pid))))
            .unwrap());
    }
}
