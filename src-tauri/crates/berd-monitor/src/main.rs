use clap::{Parser, Subcommand, ValueEnum};
use fs2::FileExt;
use std::env;
use std::ffi::OsString;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
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
const DELIVERY_TIMEOUT: Duration = Duration::from_secs(15);
const LAUNCH_TIMEOUT: Duration = Duration::from_secs(10);
const LAUNCH_TERMINATION_GRACE: Duration = Duration::from_secs(1);
const PENDING_HEADER_PREFIX: &str = "BERD_MONITOR_PENDING_V1 ";

static PENDING_GENERATION_COUNTER: AtomicU64 = AtomicU64::new(0);

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
}

struct PendingState {
    generation: String,
    active_len: usize,
    bytes: Vec<u8>,
}

enum ProducerOutputEvent {
    Data(Vec<u8>),
    ReadError(io::Error),
}

impl PendingState {
    fn empty() -> Self {
        Self {
            generation: next_pending_generation(),
            active_len: 0,
            bytes: Vec::new(),
        }
    }

    fn delivery_id(&self, paths: &StatePaths) -> String {
        let state_hash = stable_hash(paths.root.to_string_lossy().as_bytes());
        format!("berd-monitor-{state_hash:016x}-{}", self.generation)
    }

    fn rotate(&mut self) {
        self.generation = next_pending_generation();
        self.active_len = 0;
    }
}

fn next_pending_generation() -> String {
    let timestamp = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let sequence = PENDING_GENERATION_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("{}-{timestamp}-{sequence}", std::process::id())
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
            root,
        }
    }

    fn launch_status(&self, token: &str) -> PathBuf {
        self.root.join(format!("launch-{token}.status"))
    }

    fn stop_for(&self, owner_token: &str) -> PathBuf {
        self.root.join(format!(
            "stop-{:016x}.requested",
            stable_hash(owner_token.as_bytes())
        ))
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
    let stop_path = paths.stop_for(&token);
    wait_for_launch(
        &mut process,
        &paths,
        &status_path,
        &stop_path,
        LAUNCH_TIMEOUT,
    )
}

fn wait_for_launch(
    process: &mut std::process::Child,
    paths: &StatePaths,
    status_path: &Path,
    stop_path: &Path,
    timeout: Duration,
) -> Result<(), String> {
    let deadline = Instant::now() + timeout;
    loop {
        if let Ok(status) = fs::read_to_string(status_path) {
            let _ = fs::remove_file(status_path);
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
            terminate_timed_out_launch(process, status_path, stop_path);
            return Err(format!(
                "monitor did not become ready within {} seconds; inspect {}",
                timeout.as_secs_f64(),
                paths.log.display()
            ));
        }
        if let Ok(Some(status)) = process.try_wait() {
            let _ = fs::remove_file(status_path);
            return Err(format!("monitor exited before becoming ready ({status})"));
        }
        thread::sleep(Duration::from_millis(50));
    }
}

fn terminate_timed_out_launch(
    process: &mut std::process::Child,
    status_path: &Path,
    stop_path: &Path,
) {
    let _ = fs::write(stop_path, b"stop\n");
    let deadline = Instant::now() + LAUNCH_TERMINATION_GRACE;
    while Instant::now() < deadline {
        match process.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => thread::sleep(Duration::from_millis(50)),
            Err(_) => break,
        }
    }
    if process.try_wait().ok().flatten().is_none() {
        let _ = process.kill();
        let _ = process.wait();
    }
    let _ = fs::remove_file(status_path);
    let _ = fs::remove_file(stop_path);
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

struct ProducerProcess {
    child: std::process::Child,
    tree: Option<ProducerTree>,
}

impl ProducerProcess {
    fn terminate_and_wait(&mut self) {
        self.terminate_and_wait_with(terminate_producer_tree);
    }

    fn terminate_and_wait_with(
        &mut self,
        terminate: impl FnOnce(&mut std::process::Child, &ProducerTree),
    ) {
        let Some(tree) = self.tree.take() else {
            return;
        };
        terminate(&mut self.child, &tree);
        let _ = self.child.wait();
    }
}

impl Drop for ProducerProcess {
    fn drop(&mut self) {
        self.terminate_and_wait();
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

fn claim_owner(paths: &StatePaths, owner_token: &str) -> io::Result<File> {
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
    writeln!(owner, "{owner_token}")?;
    owner.flush()?;
    Ok(owner)
}

fn owner_token(paths: &StatePaths) -> io::Result<String> {
    let token = fs::read_to_string(&paths.owner)?.trim().to_owned();
    if token.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "monitor owner token is empty",
        ));
    }
    Ok(token)
}

fn stop_requested(paths: &StatePaths) -> bool {
    owner_token(paths)
        .map(|token| paths.stop_for(&token).exists())
        .unwrap_or(false)
}

fn remove_active_stop(paths: &StatePaths) -> io::Result<()> {
    let stop_path = paths.stop_for(&owner_token(paths)?);
    match fs::remove_file(stop_path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
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
    let token = owner_token(&paths)?;
    fs::write(paths.stop_for(&token), b"stop\n")?;
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
    run_foreground_after_claim(
        state_key,
        label,
        instructions,
        session_id,
        if_running,
        producer_command,
        launch_token,
        || {},
    )
}

fn run_foreground_after_claim(
    state_key: &str,
    label: &str,
    instructions: &str,
    session_id: &str,
    if_running: RunningMode,
    producer_command: &[OsString],
    launch_token: Option<&str>,
    after_claim: impl FnOnce(),
) -> io::Result<()> {
    let paths = StatePaths::for_key(state_key, session_id);
    ensure_private_directory(&paths.root)?;
    let owner_token = launch_token
        .map(str::to_owned)
        .unwrap_or_else(next_pending_generation);
    let _owner = claim_owner(&paths, &owner_token).inspect_err(|error| {
        write_launch_status(&paths, launch_token, &format!("error: {error}"));
    })?;
    after_claim();
    if paths.stop_for(&owner_token).exists() {
        log_line(&paths, "stop requested before producer start")?;
        write_launch_status(&paths, launch_token, "ready");
        remove_active_stop(&paths)?;
        return Ok(());
    }
    let result = (|| {
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
    let mut pending = read_pending(&paths.pending)?;

    let mut command = Command::new(&producer_command[0]);
    command
        .args(&producer_command[1..])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::from(diagnostics.try_clone()?));
    configure_producer(&mut command);
    let mut child = command.spawn()?;
    let producer_tree = match attach_producer_tree(&child) {
        Ok(tree) => tree,
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(io::Error::new(
                error.kind(),
                format!("attach producer process tree: {error}"),
            ));
        }
    };
    let mut producer = ProducerProcess {
        child,
        tree: Some(producer_tree),
    };
    if let Err(error) = resume_producer(&producer.child) {
        return Err(io::Error::new(
            error.kind(),
            format!("resume producer process: {error}"),
        ));
    }
    write_launch_status(paths, launch_token, "ready");
    let stdout = producer.child.stdout.take().expect("stdout was piped");
    let (sender, receiver) = mpsc::sync_channel::<ProducerOutputEvent>(1024);
    thread::spawn(move || forward_producer_output(stdout, sender));

    let mut batch = Vec::new();
    let mut batch_deadline: Option<Instant> = None;
    let mut retry_deadline = Instant::now();
    let mut producer_status = None;
    let mut receiver_closed = false;
    let mut termination_requested = false;
    let mut capture_failure = None;

    loop {
        if stop_requested(paths) && !termination_requested {
            log_line(paths, "stop requested")?;
            producer.terminate_and_wait();
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
            producer_status = producer.child.try_wait()?;
        }
        if producer_status.is_some() && receiver_closed {
            break;
        }

        let timeout = batch_deadline
            .map(|deadline| deadline.saturating_duration_since(Instant::now()))
            .unwrap_or(Duration::from_millis(100))
            .min(Duration::from_millis(100));
        match receiver.recv_timeout(timeout) {
            Ok(ProducerOutputEvent::Data(line)) => {
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
            Ok(ProducerOutputEvent::ReadError(error)) => {
                capture_failure = Some(record_capture_failure(paths, &mut producer, error)?);
                termination_requested = true;
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => receiver_closed = true,
        }
    }

    producer.terminate_and_wait();
    append_batch(paths, &mut pending, &mut batch)?;
    let status = producer_status.expect("producer has exited");
    let summary = capture_failure
        .as_ref()
        .map(|(_, message)| format!("[monitor] {message}\n"))
        .unwrap_or_else(|| format!("[monitor] producer exited with status {status}\n"));
    append_pending(&paths.pending, &mut pending, summary.as_bytes())?;
    flush_pending(
        paths,
        &mut pending,
        label,
        instructions,
        session_id,
        if_running,
    )?;

    while !pending.bytes.is_empty() && !stop_requested(paths) {
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
    if !pending.bytes.is_empty() && stop_requested(paths) {
        pending.bytes.clear();
        pending.rotate();
        persist_pending(&paths.pending, &pending)?;
        log_line(paths, "discarded undelivered output after explicit stop")?;
    }
    remove_active_stop(paths)?;
    if let Some((kind, message)) = capture_failure {
        return Err(io::Error::new(kind, message));
    }
    log_line(paths, &format!("producer exited with status {status}"))?;
    Ok(())
}

fn record_capture_failure(
    paths: &StatePaths,
    producer: &mut ProducerProcess,
    error: io::Error,
) -> io::Result<(io::ErrorKind, String)> {
    let message = format!("producer stdout capture failed: {error}");
    log_line(paths, &message)?;
    producer.terminate_and_wait();
    Ok((error.kind(), message))
}

fn forward_producer_output<R: Read>(mut reader: R, sender: mpsc::SyncSender<ProducerOutputEvent>) {
    let mut read_buffer = [0_u8; 8 * 1024];
    let mut record = Vec::with_capacity(MAX_DELIVERY_BYTES);
    loop {
        let read = match reader.read(&mut read_buffer) {
            Ok(0) => break,
            Ok(read) => read,
            Err(error) => {
                if !send_output_record(&sender, &mut record) {
                    return;
                }
                let _ = sender.send(ProducerOutputEvent::ReadError(error));
                return;
            }
        };
        for byte in &read_buffer[..read] {
            record.push(*byte);
            if *byte == b'\n' || record.len() == MAX_DELIVERY_BYTES {
                if sender
                    .send(ProducerOutputEvent::Data(std::mem::take(&mut record)))
                    .is_err()
                {
                    return;
                }
                record = Vec::with_capacity(MAX_DELIVERY_BYTES);
            }
        }
    }
    let _ = send_output_record(&sender, &mut record);
}

fn send_output_record(
    sender: &mpsc::SyncSender<ProducerOutputEvent>,
    record: &mut Vec<u8>,
) -> bool {
    if !record.is_empty() {
        if !record.ends_with(b"\n") {
            record.push(b'\n');
        }
        return sender
            .send(ProducerOutputEvent::Data(std::mem::take(record)))
            .is_ok();
    }
    true
}

fn append_batch(
    paths: &StatePaths,
    pending: &mut PendingState,
    batch: &mut Vec<u8>,
) -> io::Result<()> {
    if batch.is_empty() {
        return Ok(());
    }
    append_pending(&paths.pending, pending, batch)?;
    batch.clear();
    Ok(())
}

fn flush_pending(
    paths: &StatePaths,
    pending: &mut PendingState,
    label: &str,
    instructions: &str,
    session_id: &str,
    if_running: RunningMode,
) -> io::Result<()> {
    while !pending.bytes.is_empty() {
        if pending.active_len == 0 {
            pending.active_len = pending_chunk_end(&pending.bytes, MAX_DELIVERY_BYTES);
            persist_pending(&paths.pending, pending)?;
        }
        let end = pending.active_len;
        let prompt = build_delivery_prompt(label, &pending.bytes[..end], instructions)?;
        let delivery_id = pending.delivery_id(paths);
        if !deliver_to_session(paths, session_id, &prompt, if_running, &delivery_id) {
            log_line(paths, "delivery failed; buffered output will be retried")?;
            return Ok(());
        }
        pending.bytes.drain(..end);
        pending.rotate();
        persist_pending(&paths.pending, pending)?;
        log_line(paths, "delivered one event batch")?;
    }
    Ok(())
}

fn build_delivery_prompt(label: &str, bytes: &[u8], instructions: &str) -> io::Result<String> {
    let text = String::from_utf8_lossy(bytes).replace('\0', "\u{fffd}");
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
    Ok(prompt)
}

fn deliver_to_session(
    paths: &StatePaths,
    session_id: &str,
    prompt: &str,
    if_running: RunningMode,
    delivery_id: &str,
) -> bool {
    deliver_with_candidates(
        paths,
        session_id,
        prompt,
        if_running,
        delivery_id,
        lock_candidates(),
        berdctl_candidates(),
        DELIVERY_TIMEOUT,
    )
}

fn deliver_with_candidates(
    paths: &StatePaths,
    session_id: &str,
    prompt: &str,
    if_running: RunningMode,
    delivery_id: &str,
    locks: Vec<PathBuf>,
    binaries: Vec<OsString>,
    timeout: Duration,
) -> bool {
    for lock in locks {
        for binary in &binaries {
            if stop_requested(paths) {
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
                .arg("--delivery-id")
                .arg(delivery_id)
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
            let deadline = Instant::now() + timeout;
            loop {
                if stop_requested(paths) {
                    let _ = child.kill();
                    let _ = child.wait();
                    return false;
                }
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    break;
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

fn read_pending(path: &Path) -> io::Result<PendingState> {
    let contents = read_optional(path)?;
    if contents.is_empty() {
        return Ok(PendingState::empty());
    }
    if !contents.starts_with(PENDING_HEADER_PREFIX.as_bytes()) {
        return Ok(PendingState {
            generation: next_pending_generation(),
            active_len: 0,
            bytes: contents,
        });
    }
    let header_end = contents
        .iter()
        .position(|byte| *byte == b'\n')
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "invalid pending header"))?;
    let header = std::str::from_utf8(&contents[PENDING_HEADER_PREFIX.len()..header_end])
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "invalid pending header"))?;
    let (generation, active_len) = header
        .split_once(' ')
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "invalid pending header"))?;
    let active_len = active_len
        .parse::<usize>()
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "invalid pending length"))?;
    let bytes = contents[(header_end + 1)..].to_vec();
    if generation.is_empty() || active_len > bytes.len() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "invalid pending delivery state",
        ));
    }
    Ok(PendingState {
        generation: generation.to_owned(),
        active_len,
        bytes,
    })
}

fn persist_pending(path: &Path, pending: &PendingState) -> io::Result<()> {
    if pending.bytes.is_empty() {
        return match fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error),
        };
    }
    let mut contents = format!(
        "{PENDING_HEADER_PREFIX}{} {}\n",
        pending.generation, pending.active_len
    )
    .into_bytes();
    contents.extend_from_slice(&pending.bytes);
    atomic_write(path, &contents)
}

fn append_pending(path: &Path, pending: &mut PendingState, data: &[u8]) -> io::Result<()> {
    if data.is_empty() {
        return Ok(());
    }
    let existed = path.exists();
    pending.bytes.extend_from_slice(data);
    if existed {
        append_file(path, data)
    } else {
        persist_pending(path, pending)
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
    atomic_write_with(path, data, replace_file_atomically)
}

fn atomic_write_with(
    path: &Path,
    data: &[u8],
    replace: impl FnOnce(&Path, &Path) -> io::Result<()>,
) -> io::Result<()> {
    let temporary = path.with_extension(format!("tmp.{}", std::process::id()));
    let mut file = OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(&temporary)?;
    file.write_all(data)?;
    file.sync_all()?;
    drop(file);

    if let Err(error) = replace(&temporary, path) {
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }

    #[cfg(unix)]
    if let Some(parent) = path.parent() {
        File::open(parent)?.sync_all()?;
    }
    Ok(())
}

#[cfg(unix)]
fn replace_file_atomically(source: &Path, destination: &Path) -> io::Result<()> {
    fs::rename(source, destination)
}

#[cfg(windows)]
fn replace_file_atomically(source: &Path, destination: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let source = source
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let destination = destination
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let result = unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
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
    #[test]
    fn launch_timeout_terminates_and_reaps_the_child() {
        let key = format!(
            "launch-timeout-test-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let paths = StatePaths::for_key(&key, "test-session");
        ensure_private_directory(&paths.root).unwrap();
        let status_path = paths.launch_status("never-ready");
        let stop_path = paths.stop_for("never-ready");
        let mut child = Command::new("sh")
            .args(["-c", "exec sleep 30"])
            .spawn()
            .unwrap();
        let pid = child.id();

        let launch_timeout = Duration::from_millis(100);
        let launch_result =
            wait_for_launch(&mut child, &paths, &status_path, &stop_path, launch_timeout);
        let error = launch_result.unwrap_err();

        assert!(error.contains("did not become ready"));
        assert!(!test_process_exists(pid));
        assert!(!status_path.exists());
        assert!(!stop_path.exists());
        fs::remove_dir_all(paths.root).unwrap();
    }

    #[test]
    fn failed_atomic_replace_preserves_pending_output() {
        let root = env::temp_dir().join(format!(
            "berd-monitor-atomic-write-test-{}",
            std::process::id()
        ));
        fs::create_dir_all(&root).unwrap();
        let pending = root.join("pending");
        fs::write(&pending, b"still pending").unwrap();

        let error = atomic_write_with(&pending, b"replacement", |_, _| {
            Err(io::Error::other("injected replacement failure"))
        })
        .unwrap_err();

        assert_eq!(error.kind(), io::ErrorKind::Other);
        assert_eq!(fs::read(&pending).unwrap(), b"still pending");
        assert!(!pending
            .with_extension(format!("tmp.{}", std::process::id()))
            .exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn pending_delivery_id_survives_restart_and_rotates_after_ack() {
        let key = format!(
            "pending-id-test-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let paths = StatePaths::for_key(&key, "test-session");
        ensure_private_directory(&paths.root).unwrap();
        let mut pending = PendingState::empty();
        append_pending(&paths.pending, &mut pending, b"same event\n").unwrap();
        pending.active_len = pending.bytes.len();
        persist_pending(&paths.pending, &pending).unwrap();
        let first_id = pending.delivery_id(&paths);

        let mut restarted = read_pending(&paths.pending).unwrap();
        assert_eq!(restarted.delivery_id(&paths), first_id);
        assert_eq!(restarted.active_len, restarted.bytes.len());

        restarted.bytes.clear();
        restarted.rotate();
        persist_pending(&paths.pending, &restarted).unwrap();
        append_pending(&paths.pending, &mut restarted, b"same event\n").unwrap();
        restarted.active_len = restarted.bytes.len();
        persist_pending(&paths.pending, &restarted).unwrap();

        assert_ne!(restarted.delivery_id(&paths), first_id);
        fs::remove_dir_all(paths.root).unwrap();
    }

    #[cfg(unix)]
    fn test_process_exists(pid: u32) -> bool {
        let result = unsafe { libc::kill(pid as i32, 0) };
        result == 0 || io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
    }

    #[cfg(unix)]
    #[test]
    fn producer_guard_cleans_up_the_process_group_on_error() {
        use std::io::{BufRead, BufReader};

        let mut observed_pids = None;
        let result: io::Result<()> = (|| {
            let mut command = Command::new("sh");
            command
                .args(["-c", "sleep 30 & child=$!; echo $child; wait"])
                .stdout(Stdio::piped());
            configure_producer(&mut command);
            let child = command.spawn()?;
            let tree = attach_producer_tree(&child)?;
            let mut producer = ProducerProcess {
                child,
                tree: Some(tree),
            };
            resume_producer(&producer.child)?;
            let direct_pid = producer.child.id();
            let mut descendant = String::new();
            let stdout = producer.child.stdout.take().unwrap();
            let mut reader = BufReader::new(stdout);
            reader.read_line(&mut descendant)?;
            let descendant_pid = descendant.trim().parse::<u32>().unwrap();
            observed_pids = Some((direct_pid, descendant_pid));
            Err(io::Error::other("injected post-spawn failure"))
        })();

        assert_eq!(result.unwrap_err().kind(), io::ErrorKind::Other);
        let (direct_pid, descendant_pid) = observed_pids.unwrap();
        let deadline = Instant::now() + Duration::from_secs(2);
        while (test_process_exists(direct_pid) || test_process_exists(descendant_pid))
            && Instant::now() < deadline
        {
            thread::sleep(Duration::from_millis(25));
        }
        assert!(!test_process_exists(direct_pid));
        assert!(!test_process_exists(descendant_pid));
    }

    #[cfg(unix)]
    #[test]
    fn explicit_producer_cleanup_disarms_drop() {
        let mut command = Command::new("sh");
        command.args(["-c", "exec sleep 30"]);
        configure_producer(&mut command);
        let child = command.spawn().unwrap();
        let tree = attach_producer_tree(&child).unwrap();
        let mut producer = ProducerProcess {
            child,
            tree: Some(tree),
        };
        resume_producer(&producer.child).unwrap();
        let mut termination_calls = 0;

        producer.terminate_and_wait_with(|child, tree| {
            termination_calls += 1;
            terminate_producer_tree(child, tree);
        });
        producer.terminate_and_wait_with(|_, _| termination_calls += 1);
        drop(producer);

        assert_eq!(termination_calls, 1);
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
        let records = receiver
            .into_iter()
            .map(|event| match event {
                ProducerOutputEvent::Data(record) => record,
                ProducerOutputEvent::ReadError(error) => {
                    panic!("unexpected capture failure: {error}")
                }
            })
            .collect::<Vec<_>>();

        assert_eq!(records.len(), 4);
        assert!(records
            .iter()
            .all(|record| record.len() <= MAX_DELIVERY_BYTES));
        let mut output = records.concat();
        assert_eq!(output.pop(), Some(b'\n'));
        assert_eq!(output, input);
    }

    #[test]
    fn producer_output_preserves_partial_record_before_read_error() {
        struct BytesThenError(bool);

        impl Read for BytesThenError {
            fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
                if self.0 {
                    return Err(io::Error::other("injected stdout read failure"));
                }
                self.0 = true;
                let bytes = b"partial output";
                buffer[..bytes.len()].copy_from_slice(bytes);
                Ok(bytes.len())
            }
        }

        let (sender, receiver) = mpsc::sync_channel(2);
        forward_producer_output(BytesThenError(false), sender);
        let events = receiver.into_iter().collect::<Vec<_>>();

        assert_eq!(events.len(), 2);
        assert!(matches!(
            &events[0],
            ProducerOutputEvent::Data(bytes) if bytes == b"partial output\n"
        ));
        assert!(matches!(
            &events[1],
            ProducerOutputEvent::ReadError(error)
                if error.to_string() == "injected stdout read failure"
        ));
    }

    #[cfg(unix)]
    #[test]
    fn capture_failure_is_recorded_and_cleans_up_the_process_group() {
        use std::io::{BufRead, BufReader};

        let key = format!(
            "capture-failure-test-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let paths = StatePaths::for_key(&key, "test-session");
        ensure_private_directory(&paths.root).unwrap();
        let mut command = Command::new("sh");
        command
            .args(["-c", "sleep 30 & child=$!; echo $child; wait"])
            .stdout(Stdio::piped());
        configure_producer(&mut command);
        let child = command.spawn().unwrap();
        let tree = attach_producer_tree(&child).unwrap();
        let mut producer = ProducerProcess {
            child,
            tree: Some(tree),
        };
        resume_producer(&producer.child).unwrap();
        let direct_pid = producer.child.id();
        let mut descendant = String::new();
        BufReader::new(producer.child.stdout.take().unwrap())
            .read_line(&mut descendant)
            .unwrap();
        let descendant_pid = descendant.trim().parse::<u32>().unwrap();

        let failure = record_capture_failure(
            &paths,
            &mut producer,
            io::Error::other("injected stdout read failure"),
        )
        .unwrap();

        assert_eq!(failure.0, io::ErrorKind::Other);
        assert!(failure.1.contains("injected stdout read failure"));
        assert!(fs::read_to_string(&paths.log)
            .unwrap()
            .contains("producer stdout capture failed"));
        let deadline = Instant::now() + Duration::from_secs(2);
        while (test_process_exists(direct_pid) || test_process_exists(descendant_pid))
            && Instant::now() < deadline
        {
            thread::sleep(Duration::from_millis(25));
        }
        assert!(!test_process_exists(direct_pid));
        assert!(!test_process_exists(descendant_pid));
        fs::remove_dir_all(paths.root).unwrap();
    }

    #[test]
    fn delivery_prompt_replaces_embedded_nul_bytes_without_growing() {
        let prompt = build_delivery_prompt("test", b"before\0after\n", "continue").unwrap();

        assert!(!prompt.contains('\0'));
        assert!(prompt.contains("before\u{fffd}after"));
        assert!(prompt.contains("continue"));
    }

    #[cfg(unix)]
    #[test]
    fn nul_output_is_delivered_once_and_does_not_block_later_output() {
        use std::os::unix::fs::PermissionsExt;

        let key = format!(
            "delivery-nul-test-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let session_id = "test-session";
        let paths = StatePaths::for_key(&key, session_id);
        ensure_private_directory(&paths.root).unwrap();
        let capture = paths.root.join("delivered.txt");
        let fake_berdctl = paths.root.join("fake-berdctl");
        fs::write(
            &fake_berdctl,
            format!(
                "#!/bin/sh\nprintf '%s\\n' \"$@\" >> '{}'\n",
                capture.display()
            ),
        )
        .unwrap();
        fs::set_permissions(&fake_berdctl, fs::Permissions::from_mode(0o700)).unwrap();
        let binary = fake_berdctl.into_os_string();

        let first = build_delivery_prompt("test", b"before\0after\n", "").unwrap();
        assert!(deliver_with_candidates(
            &paths,
            session_id,
            &first,
            RunningMode::Steer,
            "nul-delivery",
            vec![PathBuf::from("stale")],
            vec![binary.clone()],
            Duration::from_secs(2),
        ));
        let later = build_delivery_prompt("test", b"later output\n", "").unwrap();
        assert!(deliver_with_candidates(
            &paths,
            session_id,
            &later,
            RunningMode::Steer,
            "later-delivery",
            vec![PathBuf::from("stale")],
            vec![binary],
            Duration::from_secs(2),
        ));

        let delivered = fs::read_to_string(capture).unwrap();
        assert_eq!(delivered.matches("before\u{fffd}after").count(), 1);
        assert!(delivered.contains("later output"));
        fs::remove_dir_all(paths.root).unwrap();
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
        let owner = claim_owner(&paths, "delivery-stop-owner").unwrap();
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
                "test-delivery",
                vec![PathBuf::from("stale-a"), PathBuf::from("stale-b")],
                vec![worker_binary],
                DELIVERY_TIMEOUT,
            )
        });
        thread::sleep(Duration::from_millis(150));
        request_stop(&key, session_id).unwrap();

        assert!(!worker.join().unwrap());
        assert!(started.elapsed() < Duration::from_secs(2));
        drop(owner);
        fs::remove_dir_all(&paths.root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn delivery_timeout_terminates_and_reaps_the_probe() {
        use std::os::unix::fs::PermissionsExt;

        let key = format!(
            "delivery-timeout-test-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let session_id = "test-session";
        let paths = StatePaths::for_key(&key, session_id);
        ensure_private_directory(&paths.root).unwrap();
        let pid_file = paths.root.join("probe.pid");
        let fake_berdctl = paths.root.join("fake-berdctl");
        fs::write(
            &fake_berdctl,
            format!(
                "#!/bin/sh\nprintf '%s\\n' \"$$\" > '{}'\nexec sleep 30\n",
                pid_file.display()
            ),
        )
        .unwrap();
        fs::set_permissions(&fake_berdctl, fs::Permissions::from_mode(0o700)).unwrap();

        let started = Instant::now();
        assert!(!deliver_with_candidates(
            &paths,
            session_id,
            "test",
            RunningMode::Steer,
            "test-delivery",
            vec![PathBuf::from("stale")],
            vec![fake_berdctl.into_os_string()],
            Duration::from_millis(500),
        ));

        let pid = fs::read_to_string(pid_file)
            .unwrap()
            .trim()
            .parse::<u32>()
            .unwrap();
        assert!(started.elapsed() < Duration::from_secs(2));
        assert!(!test_process_exists(pid));
        fs::remove_dir_all(paths.root).unwrap();
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
        let owner = claim_owner(&paths, "owner-a").unwrap();
        assert_eq!(
            claim_owner(&paths, "owner-b").unwrap_err().kind(),
            io::ErrorKind::WouldBlock
        );
        drop(owner);
        claim_owner(&paths, "owner-b").unwrap();
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
                let owner = claim_owner(&StatePaths::for_key(&key, "test-session"), "race-owner");
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
    fn stop_after_owner_claim_prevents_producer_start() {
        let key = format!(
            "startup-stop-race-test-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let session_id = "test-session";
        let paths = StatePaths::for_key(&key, session_id);
        let producer_started = paths.root.join("producer-started");
        let command = format!("printf started > '{}'", producer_started.display());

        run_foreground_after_claim(
            &key,
            "test",
            "",
            session_id,
            RunningMode::Steer,
            &[
                OsString::from("sh"),
                OsString::from("-c"),
                OsString::from(command),
            ],
            Some("startup-stop-owner"),
            || request_stop(&key, session_id).unwrap(),
        )
        .unwrap();

        assert!(!producer_started.exists());
        assert!(!paths.stop_for("startup-stop-owner").exists());
        assert!(fs::read_to_string(&paths.log)
            .unwrap()
            .contains("stop requested before producer start"));
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
            if let Ok(pending) = read_pending(&paths.pending) {
                let pending_text = String::from_utf8_lossy(&pending.bytes);
                let parsed_pid = pending_text.trim().parse::<i32>();
                if let Ok(pid) = parsed_pid {
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
        assert!(read_optional(&paths.pending).unwrap().is_empty());
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
