use clap::{Parser, Subcommand, ValueEnum};
use fs2::FileExt;
use std::env;
use std::ffi::OsString;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode, Stdio};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::thread;
use std::time::{Duration, Instant, SystemTime};

const FOREGROUND_ENV: &str = "BERD_MONITOR_FOREGROUND";
const LAUNCH_TOKEN_ENV: &str = "BERD_MONITOR_LAUNCH_TOKEN";
const RETRY_INTERVAL: Duration = Duration::from_secs(15);
const BATCH_WINDOW: Duration = Duration::from_millis(250);
const MAX_DELIVERY_BYTES: usize = 40_000;
const MAX_PROMPT_CODE_UNITS: usize = 49_000;
const MAX_INSTRUCTIONS_CODE_UNITS: usize = 4_000;
const MAX_LABEL_CODE_UNITS: usize = 120;
const MAX_LOCK_CANDIDATES: usize = 8;
const DELIVERY_POLL_INTERVAL: Duration = Duration::from_millis(50);
const LAUNCH_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Clone, Copy, Debug, ValueEnum)]
enum RunningMode {
    Steer,
    Queue,
}

impl RunningMode {
    fn as_str(self) -> &'static str {
        match self {
            Self::Steer => "steer",
            Self::Queue => "queue",
        }
    }
}

#[derive(Debug, Parser)]
#[command(
    name = "berd-monitor",
    about = "Run a long-lived command and wake its owning Berd session"
)]
struct Cli {
    #[command(subcommand)]
    command: MonitorCommand,
}

#[derive(Debug, Subcommand)]
enum MonitorCommand {
    /// Start a detached line-oriented command monitor.
    Run {
        /// Stable key used to identify and stop this monitor.
        #[arg(long)]
        state_key: String,
        /// Concise source name included with delivered events.
        #[arg(long)]
        label: String,
        /// Guidance appended to every delivered event.
        #[arg(long, default_value = "")]
        instructions: String,
        /// Berd session that owns the monitor.
        #[arg(long, env = "AGENT_SESSION_ID")]
        session_id: String,
        /// Whether events steer a running turn or queue behind it.
        #[arg(long, value_enum, default_value_t = RunningMode::Steer)]
        if_running: RunningMode,
        /// Producer command and arguments, following `--`.
        #[arg(last = true, required = true, allow_hyphen_values = true)]
        command: Vec<OsString>,
    },
    /// Request that a running monitor stop its producer.
    Stop {
        /// Stable key passed when the monitor was started.
        #[arg(long)]
        state_key: String,
        /// Berd session that owns the monitor.
        #[arg(long, env = "AGENT_SESSION_ID")]
        session_id: String,
    },
}

struct StatePaths {
    root: PathBuf,
    log: PathBuf,
    pending: PathBuf,
    owner: PathBuf,
    stop: PathBuf,
}

impl StatePaths {
    fn for_key(key: &str, session_id: &str) -> Self {
        let identity = format!("{session_id}\0{key}");
        let suffix = stable_hash(identity.as_bytes());
        let safe = key
            .chars()
            .take(80)
            .map(|character| {
                if character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-') {
                    character
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
            stop: root.join("stop-requested"),
            root,
        }
    }

    fn launch_status(&self, token: &str) -> PathBuf {
        self.root.join(format!("launch-{token}.status"))
    }
}

fn state_base_dir() -> PathBuf {
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

fn stable_hash(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf29ce484222325, |hash, byte| {
        (hash ^ u64::from(*byte)).wrapping_mul(0x100000001b3)
    })
}

fn main() -> ExitCode {
    match run_cli() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("berd-monitor: {error}");
            ExitCode::FAILURE
        }
    }
}

fn run_cli() -> Result<(), String> {
    let cli = Cli::parse();
    match cli.command {
        MonitorCommand::Run {
            state_key,
            label,
            instructions,
            session_id,
            if_running,
            command,
        } => {
            validate_single_line("--label", &label)?;
            if label.encode_utf16().count() > MAX_LABEL_CODE_UNITS {
                return Err(format!(
                    "--label must not exceed {MAX_LABEL_CODE_UNITS} characters"
                ));
            }
            if instructions.encode_utf16().count() > MAX_INSTRUCTIONS_CODE_UNITS {
                return Err(format!(
                    "--instructions must not exceed {MAX_INSTRUCTIONS_CODE_UNITS} characters"
                ));
            }
            if env::var_os(FOREGROUND_ENV).is_some() {
                run_foreground(
                    &state_key,
                    &label,
                    &instructions,
                    &session_id,
                    if_running,
                    &command,
                    env::var(LAUNCH_TOKEN_ENV).ok().as_deref(),
                )
                .map_err(|error| error.to_string())
            } else {
                spawn_detached(&state_key, &session_id)
            }
        }
        MonitorCommand::Stop {
            state_key,
            session_id,
        } => request_stop(&state_key, &session_id).map_err(|error| error.to_string()),
    }
}

fn validate_single_line(flag: &str, value: &str) -> Result<(), String> {
    if value.trim().is_empty() {
        return Err(format!("{flag} must not be empty"));
    }
    if value.contains('\n') || value.contains('\r') {
        return Err(format!("{flag} must be a single line"));
    }
    Ok(())
}

fn spawn_detached(state_key: &str, session_id: &str) -> Result<(), String> {
    let executable =
        env::current_exe().map_err(|error| format!("resolve current executable: {error}"))?;
    let token = format!(
        "{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    );
    let paths = StatePaths::for_key(state_key, session_id);
    let status_path = paths.launch_status(&token);
    let mut child = Command::new(executable);
    child
        .args(env::args_os().skip(1))
        .env(FOREGROUND_ENV, "1")
        .env(LAUNCH_TOKEN_ENV, &token)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    configure_detached(&mut child);
    let mut process = child
        .spawn()
        .map_err(|error| format!("start detached monitor: {error}"))?;
    let deadline = Instant::now() + LAUNCH_TIMEOUT;
    loop {
        if let Ok(status) = fs::read_to_string(&status_path) {
            let _ = fs::remove_file(&status_path);
            if status.trim() == "ready" {
                println!("{} {}", process.id(), paths.root.display());
                return Ok(());
            }
            return Err(status
                .strip_prefix("error: ")
                .unwrap_or(status.trim())
                .to_owned());
        }
        if Instant::now() >= deadline {
            return Err(format!(
                "monitor did not become ready within {} seconds; inspect {}",
                LAUNCH_TIMEOUT.as_secs(),
                paths.log.display()
            ));
        }
        if let Ok(Some(status)) = process.try_wait() {
            return Err(format!("monitor exited before becoming ready ({status})"));
        }
        thread::sleep(Duration::from_millis(50));
    }
}

#[cfg(unix)]
fn configure_detached(command: &mut Command) {
    use std::os::unix::process::CommandExt;
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        });
    }
}

#[cfg(unix)]
fn configure_producer(command: &mut Command) {
    use std::os::unix::process::CommandExt;
    unsafe {
        command.pre_exec(|| {
            if libc::setpgid(0, 0) == -1 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        });
    }
}

#[cfg(windows)]
fn configure_producer(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    const CREATE_SUSPENDED: u32 = 0x0000_0004;
    command.creation_flags(CREATE_NEW_PROCESS_GROUP | CREATE_SUSPENDED);
}

#[cfg(unix)]
fn resume_producer(_child: &std::process::Child) -> io::Result<()> {
    Ok(())
}

#[cfg(windows)]
fn resume_producer(child: &std::process::Child) -> io::Result<()> {
    use std::mem::{size_of, zeroed};
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
    };
    use windows_sys::Win32::System::Threading::{OpenThread, ResumeThread, THREAD_SUSPEND_RESUME};

    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    let mut entry: THREADENTRY32 = unsafe { zeroed() };
    entry.dwSize = size_of::<THREADENTRY32>() as u32;
    let mut found = unsafe { Thread32First(snapshot, &mut entry) } != 0;
    while found && entry.th32OwnerProcessID != child.id() {
        found = unsafe { Thread32Next(snapshot, &mut entry) } != 0;
    }
    unsafe {
        CloseHandle(snapshot);
    }
    if !found {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            "could not find the suspended producer thread",
        ));
    }
    let thread = unsafe { OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID) };
    if thread.is_null() {
        return Err(io::Error::last_os_error());
    }
    let resumed = unsafe { ResumeThread(thread) };
    let resume_error = (resumed == u32::MAX).then(io::Error::last_os_error);
    unsafe {
        CloseHandle(thread);
    }
    if let Some(error) = resume_error {
        return Err(error);
    }
    Ok(())
}

#[cfg(unix)]
struct ProducerTree {
    process_group: i32,
}

#[cfg(unix)]
fn attach_producer_tree(child: &std::process::Child) -> io::Result<ProducerTree> {
    Ok(ProducerTree {
        process_group: child.id() as i32,
    })
}

#[cfg(unix)]
fn terminate_producer_tree(child: &mut std::process::Child, tree: &ProducerTree) {
    unsafe {
        libc::kill(-tree.process_group, libc::SIGKILL);
    }
    let _ = child.kill();
}

#[cfg(windows)]
struct ProducerTree {
    job: windows_sys::Win32::Foundation::HANDLE,
}

#[cfg(windows)]
fn attach_producer_tree(child: &std::process::Child) -> io::Result<ProducerTree> {
    use std::mem::{size_of, zeroed};
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
    if job.is_null() {
        return Err(io::Error::last_os_error());
    }
    let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { zeroed() };
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    let configured = unsafe {
        SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            (&raw const limits).cast(),
            size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
    };
    let assigned = configured != 0
        && unsafe { AssignProcessToJobObject(job, child.as_raw_handle().cast()) } != 0;
    if !assigned {
        let error = io::Error::last_os_error();
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(job);
        }
        return Err(error);
    }
    Ok(ProducerTree { job })
}

#[cfg(windows)]
fn terminate_producer_tree(child: &mut std::process::Child, tree: &ProducerTree) {
    unsafe {
        windows_sys::Win32::System::JobObjects::TerminateJobObject(tree.job, 1);
    }
    let _ = child.kill();
}

#[cfg(windows)]
impl Drop for ProducerTree {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.job);
        }
    }
}

fn ensure_private_directory(path: &Path) -> io::Result<()> {
    fs::create_dir_all(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let metadata = fs::symlink_metadata(path)?;
        if metadata.file_type().is_symlink() || metadata.uid() != unsafe { libc::geteuid() } {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                format!("refusing unsafe monitor state directory {}", path.display()),
            ));
        }
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

fn claim_owner(paths: &StatePaths) -> io::Result<File> {
    let mut owner = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(&paths.owner)?;
    owner.try_lock_exclusive().map_err(|error| {
        io::Error::new(
            error.kind(),
            format!("a monitor already owns {}: {error}", paths.root.display()),
        )
    })?;
    owner.set_len(0)?;
    writeln!(owner, "{}", std::process::id())?;
    owner.flush()?;
    Ok(owner)
}

fn write_launch_status(paths: &StatePaths, token: Option<&str>, status: &str) {
    if let Some(token) = token {
        let _ = atomic_write(&paths.launch_status(token), status.as_bytes());
    }
}

#[cfg(windows)]
fn configure_detached(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    command.creation_flags(CREATE_NEW_PROCESS_GROUP | DETACHED_PROCESS);
}

fn request_stop(state_key: &str, session_id: &str) -> io::Result<()> {
    let paths = StatePaths::for_key(state_key, session_id);
    let owner = OpenOptions::new()
        .read(true)
        .write(true)
        .open(&paths.owner)
        .map_err(|error| {
            if error.kind() == io::ErrorKind::NotFound {
                io::Error::new(
                    io::ErrorKind::NotFound,
                    format!("no monitor found for state key {state_key:?}"),
                )
            } else {
                error
            }
        })?;
    if owner.try_lock_exclusive().is_ok() {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            format!("no monitor found for state key {state_key:?}"),
        ));
    }
    fs::write(&paths.stop, b"stop\n")?;
    println!("stop requested for {}", paths.root.display());
    Ok(())
}

fn run_foreground(
    state_key: &str,
    label: &str,
    instructions: &str,
    session_id: &str,
    if_running: RunningMode,
    producer_command: &[OsString],
    launch_token: Option<&str>,
) -> io::Result<()> {
    let paths = StatePaths::for_key(state_key, session_id);
    ensure_private_directory(&paths.root)?;
    let _owner = claim_owner(&paths).inspect_err(|error| {
        write_launch_status(&paths, launch_token, &format!("error: {error}"));
    })?;
    let result = (|| {
        paths
            .stop
            .exists()
            .then(|| fs::remove_file(&paths.stop))
            .transpose()?;
        run_producer(
            &paths,
            label,
            instructions,
            session_id,
            if_running,
            producer_command,
            launch_token,
        )
    })();
    if let Err(error) = &result {
        let _ = log_line(&paths, &format!("monitor failed: {error}"));
        write_launch_status(&paths, launch_token, &format!("error: {error}"));
    }
    result
}

fn run_producer(
    paths: &StatePaths,
    label: &str,
    instructions: &str,
    session_id: &str,
    if_running: RunningMode,
    producer_command: &[OsString],
    launch_token: Option<&str>,
) -> io::Result<()> {
    let diagnostics = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&paths.log)?;
    log_line(
        paths,
        &format!("starting producer: {}", render_command(producer_command)),
    )?;
    let mut pending = read_optional(&paths.pending)?;

    let mut producer = Command::new(&producer_command[0]);
    producer
        .args(&producer_command[1..])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::from(diagnostics.try_clone()?));
    configure_producer(&mut producer);
    let mut child = producer.spawn()?;
    let producer_tree = match attach_producer_tree(&child) {
        Ok(tree) => tree,
        Err(error) => {
            let _ = child.kill();
            return Err(io::Error::new(
                error.kind(),
                format!("attach producer process tree: {error}"),
            ));
        }
    };
    if let Err(error) = resume_producer(&child) {
        terminate_producer_tree(&mut child, &producer_tree);
        return Err(io::Error::new(
            error.kind(),
            format!("resume producer process: {error}"),
        ));
    }
    write_launch_status(paths, launch_token, "ready");
    let stdout = child.stdout.take().expect("stdout was piped");
    let (sender, receiver) = mpsc::sync_channel::<Vec<u8>>(1024);
    thread::spawn(move || forward_producer_output(stdout, sender));

    let mut batch = Vec::new();
    let mut batch_deadline: Option<Instant> = None;
    let mut retry_deadline = Instant::now();
    let mut producer_status = None;
    let mut receiver_closed = false;
    let mut termination_requested = false;

    loop {
        if paths.stop.exists() && !termination_requested {
            log_line(paths, "stop requested")?;
            terminate_producer_tree(&mut child, &producer_tree);
            termination_requested = true;
        }

        let now = Instant::now();
        if batch_deadline.is_some_and(|deadline| now >= deadline) {
            append_batch(paths, &mut pending, &mut batch)?;
            batch_deadline = None;
            flush_pending(
                paths,
                &mut pending,
                label,
                instructions,
                session_id,
                if_running,
            )?;
            retry_deadline = now + RETRY_INTERVAL;
        }
        if now >= retry_deadline {
            flush_pending(
                paths,
                &mut pending,
                label,
                instructions,
                session_id,
                if_running,
            )?;
            retry_deadline = now + RETRY_INTERVAL;
        }

        if producer_status.is_none() {
            producer_status = child.try_wait()?;
        }
        if producer_status.is_some() && receiver_closed {
            break;
        }

        let timeout = batch_deadline
            .map(|deadline| deadline.saturating_duration_since(Instant::now()))
            .unwrap_or(Duration::from_millis(100))
            .min(Duration::from_millis(100));
        match receiver.recv_timeout(timeout) {
            Ok(line) => {
                if !batch.is_empty() && batch.len() + line.len() > MAX_DELIVERY_BYTES {
                    append_batch(paths, &mut pending, &mut batch)?;
                    flush_pending(
                        paths,
                        &mut pending,
                        label,
                        instructions,
                        session_id,
                        if_running,
                    )?;
                    retry_deadline = Instant::now() + RETRY_INTERVAL;
                }
                batch.extend_from_slice(&line);
                if batch.len() >= MAX_DELIVERY_BYTES {
                    append_batch(paths, &mut pending, &mut batch)?;
                    flush_pending(
                        paths,
                        &mut pending,
                        label,
                        instructions,
                        session_id,
                        if_running,
                    )?;
                    retry_deadline = Instant::now() + RETRY_INTERVAL;
                    batch_deadline = None;
                } else {
                    batch_deadline.get_or_insert(Instant::now() + BATCH_WINDOW);
                }
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => receiver_closed = true,
        }
    }

    terminate_producer_tree(&mut child, &producer_tree);
    append_batch(paths, &mut pending, &mut batch)?;
    let status = producer_status.expect("producer has exited");
    let summary = format!("[monitor] producer exited with status {status}\n");
    pending.extend_from_slice(summary.as_bytes());
    append_file(&paths.pending, summary.as_bytes())?;
    flush_pending(
        paths,
        &mut pending,
        label,
        instructions,
        session_id,
        if_running,
    )?;

    while !pending.is_empty() && !paths.stop.exists() {
        thread::sleep(RETRY_INTERVAL);
        flush_pending(
            paths,
            &mut pending,
            label,
            instructions,
            session_id,
            if_running,
        )?;
    }
    if !pending.is_empty() && paths.stop.exists() {
        pending.clear();
        atomic_write(&paths.pending, &pending)?;
        log_line(paths, "discarded undelivered output after explicit stop")?;
    }
    log_line(paths, &format!("producer exited with status {status}"))?;
    Ok(())
}

fn forward_producer_output<R: Read>(mut reader: R, sender: mpsc::SyncSender<Vec<u8>>) {
    let mut read_buffer = [0_u8; 8 * 1024];
    let mut record = Vec::with_capacity(MAX_DELIVERY_BYTES);
    loop {
        let read = match reader.read(&mut read_buffer) {
            Ok(0) => break,
            Ok(read) => read,
            Err(_) => return,
        };
        for byte in &read_buffer[..read] {
            record.push(*byte);
            if *byte == b'\n' || record.len() == MAX_DELIVERY_BYTES {
                if sender.send(std::mem::take(&mut record)).is_err() {
                    return;
                }
                record = Vec::with_capacity(MAX_DELIVERY_BYTES);
            }
        }
    }
    if !record.is_empty() {
        if !record.ends_with(b"\n") {
            record.push(b'\n');
        }
        let _ = sender.send(record);
    }
}

fn append_batch(paths: &StatePaths, pending: &mut Vec<u8>, batch: &mut Vec<u8>) -> io::Result<()> {
    if batch.is_empty() {
        return Ok(());
    }
    pending.extend_from_slice(batch);
    append_file(&paths.pending, batch)?;
    batch.clear();
    Ok(())
}

fn flush_pending(
    paths: &StatePaths,
    pending: &mut Vec<u8>,
    label: &str,
    instructions: &str,
    session_id: &str,
    if_running: RunningMode,
) -> io::Result<()> {
    while !pending.is_empty() {
        let end = pending_chunk_end(pending, MAX_DELIVERY_BYTES);
        let text = String::from_utf8_lossy(&pending[..end]);
        let mut prompt = format!(
            "[monitor: {label} | pid {}]\n{}",
            std::process::id(),
            text.trim_end()
        );
        if !instructions.is_empty() {
            prompt.push_str("\n\n");
            prompt.push_str(instructions);
        }
        if prompt.encode_utf16().count() > MAX_PROMPT_CODE_UNITS {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "monitor delivery prompt exceeded its internal size bound",
            ));
        }
        if !deliver(paths, session_id, &prompt, if_running) {
            log_line(paths, "delivery failed; buffered output will be retried")?;
            return Ok(());
        }
        pending.drain(..end);
        atomic_write(&paths.pending, pending)?;
        log_line(paths, "delivered one event batch")?;
    }
    Ok(())
}

fn deliver(
    paths: &StatePaths,
    session_id: &str,
    prompt: &str,
    if_running: RunningMode,
) -> bool {
    deliver_with_candidates(
        paths,
        session_id,
        prompt,
        if_running,
        lock_candidates(),
        berdctl_candidates(),
    )
}

fn deliver_with_candidates(
    paths: &StatePaths,
    session_id: &str,
    prompt: &str,
    if_running: RunningMode,
    locks: Vec<PathBuf>,
    binaries: Vec<OsString>,
) -> bool {
    for lock in locks {
        for binary in &binaries {
            if paths.stop.exists() {
                return false;
            }
            let mut child = match Command::new(binary)
                .arg("--lock-path")
                .arg(&lock)
                .arg("--timeout-ms")
                .arg("10000")
                .arg("session")
                .arg("send")
                .arg("--session-id")
                .arg(session_id)
                .arg("--prompt")
                .arg(prompt)
                .arg("--if-running")
                .arg(if_running.as_str())
                .arg("--from")
                .arg("berd-monitor")
                .arg("--json")
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
            {
                Ok(child) => child,
                Err(_) => continue,
            };
            loop {
                if paths.stop.exists() {
                    let _ = child.kill();
                    let _ = child.wait();
                    return false;
                }
                match child.try_wait() {
                    Ok(Some(status)) if status.success() => return true,
                    Ok(Some(_)) | Err(_) => break,
                    Ok(None) => thread::sleep(DELIVERY_POLL_INTERVAL),
                }
            }
        }
    }
    false
}

fn lock_candidates() -> Vec<PathBuf> {
    let Some(explicit) = env::var_os("BERDCTL_LOCK").map(PathBuf::from) else {
        return Vec::new();
    };
    lock_candidates_for(&explicit)
}

fn lock_candidates_for(explicit: &Path) -> Vec<PathBuf> {
    let mut candidates = vec![explicit.to_path_buf()];
    if let Some(parent) = explicit.parent() {
        let mut siblings = fs::read_dir(parent)
            .into_iter()
            .flatten()
            .flatten()
            .filter_map(|entry| {
                let name = entry.file_name();
                let name = name.to_string_lossy();
                if name.starts_with("control-") && name.ends_with(".json") {
                    let modified = entry
                        .metadata()
                        .ok()?
                        .modified()
                        .ok()
                        .unwrap_or(SystemTime::UNIX_EPOCH);
                    Some((modified, entry.path()))
                } else {
                    None
                }
            })
            .collect::<Vec<_>>();
        siblings.sort_by(|left, right| right.0.cmp(&left.0));
        for (_, sibling) in siblings
            .into_iter()
            .take(MAX_LOCK_CANDIDATES.saturating_sub(1))
        {
            if sibling != explicit {
                candidates.push(sibling);
            }
        }
    }
    candidates
}

fn berdctl_candidates() -> Vec<OsString> {
    let mut candidates = Vec::new();
    if let Some(explicit) = env::var_os("BERDCTL_BIN") {
        candidates.push(explicit);
    }
    let default = OsString::from(if cfg!(windows) {
        "berdctl.exe"
    } else {
        "berdctl"
    });
    if !candidates.contains(&default) {
        candidates.push(default);
    }
    candidates
}

fn pending_chunk_end(pending: &[u8], limit: usize) -> usize {
    if pending.len() <= limit {
        return pending.len();
    }
    let mut hard_end = limit;
    if let Err(error) = std::str::from_utf8(&pending[..hard_end]) {
        if error.error_len().is_none() {
            hard_end = error.valid_up_to();
        }
    }
    let end = pending[..hard_end]
        .iter()
        .rposition(|byte| *byte == b'\n')
        .map(|index| index + 1)
        .unwrap_or(hard_end);
    end.max(1)
}

fn read_optional(path: &Path) -> io::Result<Vec<u8>> {
    match File::open(path) {
        Ok(mut file) => {
            let mut contents = Vec::new();
            file.read_to_end(&mut contents)?;
            Ok(contents)
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(error) => Err(error),
    }
}

fn append_file(path: &Path, data: &[u8]) -> io::Result<()> {
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?
        .write_all(data)
}

fn atomic_write(path: &Path, data: &[u8]) -> io::Result<()> {
    let temporary = path.with_extension(format!("tmp.{}", std::process::id()));
    fs::write(&temporary, data)?;
    if path.exists() {
        fs::remove_file(path)?;
    }
    fs::rename(temporary, path)
}

fn log_line(paths: &StatePaths, message: &str) -> io::Result<()> {
    writeln!(
        OpenOptions::new()
            .create(true)
            .append(true)
            .open(&paths.log)?,
        "{message}"
    )
}

fn render_command(command: &[OsString]) -> String {
    command
        .iter()
        .map(|part| part.to_string_lossy())
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    fn test_process_exists(pid: u32) -> bool {
        let result = unsafe { libc::kill(pid as i32, 0) };
        result == 0 || io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
    }

    #[test]
    fn chunk_prefers_complete_lines() {
        let input = b"first\nsecond\nthird\n";
        assert_eq!(pending_chunk_end(input, 13), 13);
        assert_eq!(&input[..pending_chunk_end(input, 10)], b"first\n");
    }

    #[test]
    fn chunk_never_exceeds_limit_for_a_long_line() {
        let input = vec![b'x'; MAX_DELIVERY_BYTES + 10_000];
        assert_eq!(
            pending_chunk_end(&input, MAX_DELIVERY_BYTES),
            MAX_DELIVERY_BYTES
        );
    }

    #[test]
    fn producer_output_splits_unterminated_records_before_they_can_grow_unbounded() {
        let input = vec![b'x'; MAX_DELIVERY_BYTES * 3 + 17];
        let (sender, receiver) = mpsc::sync_channel(8);

        forward_producer_output(io::Cursor::new(&input), sender);
        let records = receiver.into_iter().collect::<Vec<_>>();

        assert_eq!(records.len(), 4);
        assert!(records
            .iter()
            .all(|record| record.len() <= MAX_DELIVERY_BYTES));
        let mut output = records.concat();
        assert_eq!(output.pop(), Some(b'\n'));
        assert_eq!(output, input);
    }

    #[cfg(unix)]
    #[test]
    fn stop_interrupts_a_nonresponsive_delivery_probe() {
        use std::os::unix::fs::PermissionsExt;

        let key = format!(
            "delivery-stop-test-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let session_id = "test-session";
        let paths = StatePaths::for_key(&key, session_id);
        ensure_private_directory(&paths.root).unwrap();
        let owner = claim_owner(&paths).unwrap();
        let fake_berdctl = paths.root.join("fake-berdctl");
        fs::write(&fake_berdctl, "#!/bin/sh\nexec sleep 30\n").unwrap();
        fs::set_permissions(&fake_berdctl, fs::Permissions::from_mode(0o700)).unwrap();

        let worker_key = key.clone();
        let worker_binary = fake_berdctl.into_os_string();
        let started = Instant::now();
        let worker = thread::spawn(move || {
            let worker_paths = StatePaths::for_key(&worker_key, session_id);
            deliver_with_candidates(
                &worker_paths,
                session_id,
                "test",
                RunningMode::Steer,
                vec![PathBuf::from("stale-a"), PathBuf::from("stale-b")],
                vec![worker_binary],
            )
        });
        thread::sleep(Duration::from_millis(150));
        request_stop(&key, session_id).unwrap();

        assert!(!worker.join().unwrap());
        assert!(started.elapsed() < Duration::from_secs(2));
        drop(owner);
        fs::remove_dir_all(&paths.root).unwrap();
    }

    #[test]
    fn lock_candidates_keep_the_explicit_lock_and_bound_siblings() {
        let root = env::temp_dir().join(format!(
            "berd-monitor-locks-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        let explicit = root.join("control-explicit.json");
        fs::write(&explicit, "{}").unwrap();
        for index in 0..(MAX_LOCK_CANDIDATES * 2) {
            fs::write(root.join(format!("control-{index}.json")), "{}").unwrap();
        }

        let candidates = lock_candidates_for(&explicit);

        assert_eq!(candidates.first(), Some(&explicit));
        assert_eq!(candidates.len(), MAX_LOCK_CANDIDATES);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn state_key_path_is_stable_and_safe() {
        let first = StatePaths::for_key("pr/123 checks", "session-a");
        let second = StatePaths::for_key("pr/123 checks", "session-a");
        assert_eq!(first.root, second.root);
        assert!(first.root.to_string_lossy().contains("pr-123-checks-"));
        assert_ne!(
            first.root,
            StatePaths::for_key("pr/123 checks", "session-b").root
        );
    }

    #[test]
    fn active_owner_rejects_a_duplicate_monitor() {
        let key = format!(
            "owner-test-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let paths = StatePaths::for_key(&key, "test-session");
        ensure_private_directory(&paths.root).unwrap();
        let owner = claim_owner(&paths).unwrap();
        assert_eq!(
            claim_owner(&paths).unwrap_err().kind(),
            io::ErrorKind::WouldBlock
        );
        drop(owner);
        claim_owner(&paths).unwrap();
        fs::remove_dir_all(&paths.root).unwrap();
    }

    #[test]
    fn simultaneous_owner_claims_have_one_winner() {
        use std::sync::{Arc, Barrier};

        let key = format!(
            "owner-race-test-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let paths = StatePaths::for_key(&key, "test-session");
        ensure_private_directory(&paths.root).unwrap();
        let barrier = Arc::new(Barrier::new(3));
        let mut workers = Vec::new();
        for _ in 0..2 {
            let barrier = Arc::clone(&barrier);
            let key = key.clone();
            workers.push(thread::spawn(move || {
                barrier.wait();
                let owner = claim_owner(&StatePaths::for_key(&key, "test-session"));
                if owner.is_ok() {
                    thread::sleep(Duration::from_millis(100));
                }
                owner.is_ok()
            }));
        }
        barrier.wait();
        let winners = workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .filter(|won| *won)
            .count();
        assert_eq!(winners, 1);
        fs::remove_dir_all(&paths.root).unwrap();
    }

    #[test]
    fn missing_producer_is_recorded_as_a_launch_failure() {
        let key = format!(
            "missing-producer-test-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let paths = StatePaths::for_key(&key, "test-session");
        let error = run_foreground(
            &key,
            "test",
            "",
            "test-session",
            RunningMode::Steer,
            &[OsString::from("berd-monitor-command-that-does-not-exist")],
            None,
        )
        .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::NotFound);
        assert!(fs::read_to_string(&paths.log)
            .unwrap()
            .contains("monitor failed"));
        fs::remove_dir_all(&paths.root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn stop_terminates_the_producer_process_group_and_discards_pending() {
        let key = format!(
            "process-tree-test-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let session_id = "test-session";
        let paths = StatePaths::for_key(&key, session_id);
        let worker_key = key.clone();
        let worker = thread::spawn(move || {
            run_foreground(
                &worker_key,
                "test",
                "",
                session_id,
                RunningMode::Steer,
                &[
                    OsString::from("sh"),
                    OsString::from("-c"),
                    OsString::from("sleep 30 & child=$!; echo $child; wait"),
                ],
                None,
            )
        });
        let deadline = Instant::now() + Duration::from_secs(5);
        while !paths.pending.is_file() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(25));
        }
        let child_pid = loop {
            if let Ok(value) = fs::read_to_string(&paths.pending) {
                if let Ok(pid) = value.trim().parse::<i32>() {
                    break pid;
                }
            }
            assert!(
                Instant::now() < deadline,
                "producer output was not buffered"
            );
            thread::sleep(Duration::from_millis(25));
        };
        request_stop(&key, session_id).unwrap();
        worker.join().unwrap().unwrap();
        assert!(fs::read(&paths.pending).unwrap().is_empty());
        let child_gone_deadline = Instant::now() + Duration::from_secs(2);
        while test_process_exists(child_pid as u32) && Instant::now() < child_gone_deadline {
            thread::sleep(Duration::from_millis(25));
        }
        assert!(!test_process_exists(child_pid as u32));
        fs::remove_dir_all(&paths.root).unwrap();
    }

    #[test]
    fn running_mode_matches_berdctl_values() {
        assert_eq!(RunningMode::Steer.as_str(), "steer");
        assert_eq!(RunningMode::Queue.as_str(), "queue");
    }
}
