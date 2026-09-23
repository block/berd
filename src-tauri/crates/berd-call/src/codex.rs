//! Native delivery of `berd-call start --codex` transcripts to a Codex task.
//!
//! Codex Desktop exposes a local IPC socket that frames JSON messages with a
//! four-byte little-endian length. A client initializes once per connection,
//! then steers the task's active turn or starts a new turn when it is idle.

use std::collections::VecDeque;
use std::io::{Read, Write};
use std::os::unix::fs::{FileTypeExt, MetadataExt, PermissionsExt};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::Mutex;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

const IPC_TIMEOUT: Duration = Duration::from_secs(12);
const RETRY_INTERVAL: Duration = Duration::from_secs(5);
const SHUTDOWN_DELIVERY_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_FRAME_BYTES: u32 = 256 * 1024 * 1024;
const MAX_PROMPT_BYTES: usize = 40_000;

/// One transcript record delivered to Codex.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CodexRecord {
    pub cursor: Option<u64>,
    pub role: String,
    pub handoff_id: Option<String>,
    pub text: String,
}

impl CodexRecord {
    fn render(&self) -> String {
        let mut header = self.role.to_uppercase();
        if let Some(cursor) = self.cursor {
            header = format!("{cursor} {header}");
        }
        if let Some(handoff_id) = &self.handoff_id {
            header = format!("{header} {handoff_id}");
        }
        format!("[{header}]\n{}", self.text)
    }
}

pub(crate) struct CodexTarget {
    socket: PathBuf,
    thread_id: String,
    cwd: String,
}

impl CodexTarget {
    /// Resolves the calling Codex task and verifies that Codex Desktop owns it.
    pub(crate) fn from_environment() -> Result<Self, String> {
        let thread_id = std::env::var("CODEX_THREAD_ID")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .ok_or("--codex requires CODEX_THREAD_ID; start the call from a Codex task")?;
        let cwd = std::env::current_dir()
            .map_err(|error| format!("could not resolve the working directory: {error}"))?
            .to_string_lossy()
            .into_owned();
        let target = Self {
            socket: default_socket_path(),
            thread_id,
            cwd,
        };
        target.probe_owner()?;
        Ok(target)
    }

    fn probe_owner(&self) -> Result<(), String> {
        let mut connection = IpcConnection::open(&self.socket)?;
        match connection.request(
            "thread-owner-discovery",
            json!({"hostId": "local", "conversationId": self.thread_id}),
            1,
        ) {
            Ok(response) if response["handledByClientId"].as_str().is_some() => Ok(()),
            Ok(_) => Err("Codex owner discovery response omitted handledByClientId".into()),
            Err(IpcError::Remote(message)) if message.contains("no-client-found") => Err(format!(
                "Codex task {} does not have a reachable Desktop owner",
                self.thread_id
            )),
            Err(error) => Err(error.to_string()),
        }
    }

    fn deliver(&self, message_id: &str, prompt: &str) -> Result<(), String> {
        let mut connection = IpcConnection::open(&self.socket)?;
        let input = json!([{"type": "text", "text": prompt, "text_elements": []}]);
        let created_at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|elapsed| elapsed.as_millis() as u64)
            .unwrap_or_default();
        let steer = json!({
            "conversationId": self.thread_id,
            "input": input,
            "restoreMessage": {
                "id": message_id,
                "text": prompt,
                "context": {
                    "prompt": prompt,
                    "addedFiles": [],
                    "fileAttachments": [],
                    "ideContext": null,
                    "imageAttachments": [],
                    "workspaceRoots": [self.cwd],
                    "collaborationMode": null,
                },
                "cwd": self.cwd,
                "createdAt": created_at,
            },
            "serviceTier": null,
            "attachments": [],
            "clientUserMessageId": message_id,
        });
        match connection.request("thread-follower-steer-turn", steer, 1) {
            Ok(_) => return Ok(()),
            Err(IpcError::Remote(message)) if is_inactive_turn_error(&message) => {}
            Err(error) => return Err(error.to_string()),
        }
        connection
            .request(
                "thread-follower-start-turn",
                json!({
                    "conversationId": self.thread_id,
                    "turnStart": {"request": {
                        "threadId": self.thread_id,
                        "input": input,
                        "cwd": self.cwd,
                        "clientUserMessageId": message_id,
                    }},
                }),
                2,
            )
            .map(|_| ())
            .map_err(|error| error.to_string())
    }
}

/// Delivers records to Codex in order, retrying until they are accepted.
pub(crate) struct CodexRelay {
    records: Mutex<Option<Sender<CodexRecord>>>,
    worker: Mutex<Option<(JoinHandle<()>, Receiver<()>)>>,
}

impl CodexRelay {
    pub(crate) fn start(target: CodexTarget, guidance: String) -> Self {
        let (records, receiver) = mpsc::channel();
        let (done, finished) = mpsc::channel();
        let worker = thread::spawn(move || {
            let _done = done;
            relay_worker(&target, &guidance, &receiver);
        });
        Self {
            records: Mutex::new(Some(records)),
            worker: Mutex::new(Some((worker, finished))),
        }
    }

    pub(crate) fn send(&self, record: CodexRecord) {
        if let Some(records) = lock(&self.records).as_ref() {
            let _ = records.send(record);
        }
    }

    /// Queues the terminal record and waits, within the shutdown budget, for
    /// everything to deliver. An unresponsive Codex cannot hold the call open.
    pub(crate) fn finish(&self, record: Option<CodexRecord>) {
        if let Some(records) = lock(&self.records).take() {
            if let Some(record) = record {
                let _ = records.send(record);
            }
        }
        if let Some((worker, finished)) = lock(&self.worker).take() {
            match finished.recv_timeout(SHUTDOWN_DELIVERY_TIMEOUT) {
                Err(RecvTimeoutError::Timeout) => {
                    eprintln!("berd-call: gave up delivering final records to Codex");
                }
                _ => {
                    let _ = worker.join();
                }
            }
        }
    }
}

impl Drop for CodexRelay {
    fn drop(&mut self) {
        self.finish(None);
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn relay_worker(target: &CodexTarget, guidance: &str, receiver: &Receiver<CodexRecord>) {
    let mut delivery = Delivery::new(guidance);
    // While the call runs, deliver records as they arrive and retry failures.
    loop {
        let received = if delivery.pending.is_empty() {
            receiver.recv().map_err(|_| RecvTimeoutError::Disconnected)
        } else {
            receiver.recv_timeout(RETRY_INTERVAL)
        };
        match received {
            Ok(record) => delivery.pending.push_back(record),
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => break,
        }
        delivery.pending.extend(receiver.try_iter());
        delivery.flush(|id, prompt| target.deliver(id, prompt));
    }
    // After the call ends, keep retrying briefly so the final records land.
    let deadline = Instant::now() + SHUTDOWN_DELIVERY_TIMEOUT;
    while !delivery.flush(|id, prompt| target.deliver(id, prompt)) && Instant::now() < deadline {
        thread::sleep(RETRY_INTERVAL.min(deadline.saturating_duration_since(Instant::now())));
    }
}

/// Records awaiting delivery. A batch keeps its message ID and extent across
/// retries so Codex can recognize a retry of a message it already accepted.
struct Delivery<'a> {
    pending: VecDeque<CodexRecord>,
    guidance: Option<&'a str>,
    batch: Option<(String, usize)>,
}

impl<'a> Delivery<'a> {
    fn new(guidance: &'a str) -> Self {
        Self {
            pending: VecDeque::new(),
            guidance: Some(guidance),
            batch: None,
        }
    }

    /// Delivers pending records in order; returns whether all were accepted.
    fn flush(&mut self, mut deliver: impl FnMut(&str, &str) -> Result<(), String>) -> bool {
        while !self.pending.is_empty() {
            let pending = &self.pending;
            let (id, count) = self
                .batch
                .get_or_insert_with(|| (uuid::Uuid::new_v4().to_string(), batch_len(pending)))
                .clone();
            let prompt = delivery_prompt(self.pending.iter().take(count), self.guidance);
            if let Err(error) = deliver(&id, &prompt) {
                eprintln!("berd-call: Codex delivery failed; retrying: {error}");
                return false;
            }
            self.pending.drain(..count);
            self.batch = None;
            self.guidance = None;
        }
        true
    }
}

fn batch_len(pending: &VecDeque<CodexRecord>) -> usize {
    let mut bytes = 0;
    pending
        .iter()
        .take_while(|record| {
            bytes += record.render().len() + 2;
            bytes <= MAX_PROMPT_BYTES
        })
        .count()
        .max(1)
}

pub(crate) fn delivery_prompt<'a>(
    records: impl IntoIterator<Item = &'a CodexRecord>,
    guidance: Option<&str>,
) -> String {
    let mut prompt = records
        .into_iter()
        .map(CodexRecord::render)
        .collect::<Vec<_>>()
        .join("\n\n");
    if let Some(guidance) = guidance {
        prompt.push_str("\n\n");
        prompt.push_str(guidance);
    }
    prompt
}

pub(crate) fn guidance(executable: &Path, port: u16) -> String {
    let speak = format!("{} speak --port {port}", executable.display());
    format!(
        "This is a live Berd Call. Treat USER records as live voice input: reply visibly, then run `{speak} --re CURSOR` with the same substantive reply. In Expert-Spokesperson mode, SPOKESPERSON records are context; answer HANDOFF records, whose header ends with the handoff ID, and add `--resolves HANDOFF_ID` for each handoff the reply answers. SPEECH_RESULT records report interruptions, failures, or newer user speech; LIFECYCLE records report call state. Do not start a second call."
    )
}

fn default_socket_path() -> PathBuf {
    if let Some(path) = non_empty_env("CODEX_MONITOR_SOCKET") {
        return expand_tilde(&path);
    }
    let root = non_empty_env("CODEX_HOME")
        .map(|path| expand_tilde(&path))
        .unwrap_or_else(|| expand_tilde("~/.codex"));
    root.join("ipc/ipc.sock")
}

fn non_empty_env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|value| !value.is_empty())
}

fn expand_tilde(path: &str) -> PathBuf {
    match (path.strip_prefix("~/"), std::env::var_os("HOME")) {
        (Some(rest), Some(home)) => PathBuf::from(home).join(rest),
        _ => PathBuf::from(path),
    }
}

fn is_inactive_turn_error(message: &str) -> bool {
    let message = message.to_lowercase();
    [
        "is not being streamed",
        "without an active turn",
        "no active turn",
        "no-client-found",
        "cannot steer",
        "turn is not active",
    ]
    .iter()
    .any(|needle| message.contains(needle))
}

#[derive(Debug)]
enum IpcError {
    Local(String),
    Remote(String),
}

impl std::fmt::Display for IpcError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Local(message) | Self::Remote(message) => formatter.write_str(message),
        }
    }
}

impl From<String> for IpcError {
    fn from(message: String) -> Self {
        Self::Local(message)
    }
}

struct IpcConnection {
    stream: UnixStream,
    client_id: String,
}

impl IpcConnection {
    fn open(socket: &Path) -> Result<Self, String> {
        validate_socket(socket)?;
        let stream = UnixStream::connect(socket).map_err(|error| {
            format!(
                "could not connect to Codex IPC at {}: {error}",
                socket.display()
            )
        })?;
        stream
            .set_read_timeout(Some(IPC_TIMEOUT))
            .and_then(|()| stream.set_write_timeout(Some(IPC_TIMEOUT)))
            .map_err(|error| format!("could not configure Codex IPC socket: {error}"))?;
        let mut connection = Self {
            stream,
            client_id: String::new(),
        };
        let response = connection
            .request("initialize", json!({"clientType": "berd-call"}), 0)
            .map_err(|error| error.to_string())?;
        connection.client_id = response["result"]["clientId"]
            .as_str()
            .filter(|id| !id.is_empty())
            .ok_or("Codex IPC initialize response omitted clientId")?
            .to_string();
        Ok(connection)
    }

    fn request(&mut self, method: &str, params: Value, version: u32) -> Result<Value, IpcError> {
        let request_id = uuid::Uuid::new_v4().to_string();
        let mut message = json!({
            "type": "request",
            "requestId": request_id,
            "method": method,
            "version": version,
            "params": params,
            "timeoutMs": IPC_TIMEOUT.as_millis() as u64,
        });
        if !self.client_id.is_empty() {
            message["sourceClientId"] = json!(self.client_id);
        }
        let body = serde_json::to_vec(&message)
            .map_err(|error| format!("could not encode Codex IPC request: {error}"))?;
        let length = u32::try_from(body.len())
            .ok()
            .filter(|length| *length <= MAX_FRAME_BYTES)
            .ok_or("Codex IPC request exceeds the maximum frame size".to_string())?;
        self.stream
            .write_all(&length.to_le_bytes())
            .and_then(|()| self.stream.write_all(&body))
            .map_err(|error| format!("Codex IPC write failed: {error}"))?;
        loop {
            let response = self.read_frame()?;
            if response["type"] != "response" || response["requestId"] != request_id.as_str() {
                continue;
            }
            if response["resultType"] == "success" {
                return Ok(response);
            }
            return Err(IpcError::Remote(match &response["error"] {
                Value::String(message) => message.clone(),
                Value::Null => "unknown Codex IPC error".into(),
                error => error.to_string(),
            }));
        }
    }

    fn read_frame(&mut self) -> Result<Value, String> {
        let mut header = [0; 4];
        self.stream
            .read_exact(&mut header)
            .map_err(|error| format!("Codex IPC read failed: {error}"))?;
        let length = u32::from_le_bytes(header);
        if length == 0 || length > MAX_FRAME_BYTES {
            return Err(format!("invalid Codex IPC frame length: {length}"));
        }
        let mut body = vec![0; length as usize];
        self.stream
            .read_exact(&mut body)
            .map_err(|error| format!("Codex IPC read failed: {error}"))?;
        serde_json::from_slice(&body).map_err(|error| format!("invalid Codex IPC frame: {error}"))
    }
}

fn validate_socket(socket: &Path) -> Result<(), String> {
    let metadata = std::fs::symlink_metadata(socket)
        .map_err(|_| format!("Codex IPC socket not found: {}", socket.display()))?;
    if !metadata.file_type().is_socket() {
        return Err(format!(
            "Codex IPC path is not a socket: {}",
            socket.display()
        ));
    }
    // SAFETY: getuid has no preconditions and cannot fail.
    let uid = unsafe { libc::getuid() };
    if metadata.uid() != uid {
        return Err("Codex IPC socket is not owned by the current user".into());
    }
    let directory = socket.parent().unwrap_or_else(|| Path::new("/"));
    let directory = std::fs::symlink_metadata(directory)
        .map_err(|_| format!("Codex IPC directory not found: {}", directory.display()))?;
    if directory.permissions().mode() & 0o077 != 0 {
        return Err("Codex IPC directory permits group or other access".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(cursor: Option<u64>, role: &str, text: &str) -> CodexRecord {
        CodexRecord {
            cursor,
            role: role.into(),
            handoff_id: None,
            text: text.into(),
        }
    }

    #[test]
    fn prompt_places_cursor_and_role_above_each_message() {
        let records = [
            record(Some(3), "user", "Tell me a story."),
            CodexRecord {
                handoff_id: Some("handoff-a-4".into()),
                ..record(Some(4), "handoff", "Explain the lifecycle.")
            },
            record(None, "lifecycle", "Berd Call stopped."),
        ];
        assert_eq!(
            delivery_prompt(&records, Some("guidance")),
            "[3 USER]\nTell me a story.\n\n[4 HANDOFF handoff-a-4]\nExplain the lifecycle.\n\n[LIFECYCLE]\nBerd Call stopped.\n\nguidance"
        );
        assert_eq!(
            delivery_prompt(&records[..1], None),
            "[3 USER]\nTell me a story."
        );
    }

    #[test]
    fn batches_stay_under_the_prompt_limit_but_always_progress() {
        let small = record(Some(1), "user", "hi");
        let large = record(Some(2), "user", &"x".repeat(MAX_PROMPT_BYTES));
        assert_eq!(
            batch_len(&VecDeque::from([small.clone(), small.clone()])),
            2
        );
        assert_eq!(
            batch_len(&VecDeque::from([large.clone(), small.clone()])),
            1
        );
        assert_eq!(batch_len(&VecDeque::from([small, large])), 1);
    }

    #[test]
    fn a_retried_batch_keeps_its_message_id_and_records() {
        let mut delivery = Delivery::new("guidance");
        delivery.pending.push_back(record(Some(1), "user", "first"));
        let mut attempts = Vec::new();
        assert!(!delivery.flush(|id, prompt| {
            attempts.push((id.to_string(), prompt.to_string()));
            Err("timed out".into())
        }));
        delivery
            .pending
            .push_back(record(Some(2), "user", "second"));
        assert!(delivery.flush(|id, prompt| {
            attempts.push((id.to_string(), prompt.to_string()));
            Ok(())
        }));
        assert_eq!(attempts.len(), 3);
        assert_eq!(attempts[0], attempts[1]);
        assert!(!attempts[1].1.contains("second"));
        assert_ne!(attempts[2].0, attempts[1].0);
        assert!(attempts[2].1.contains("second") && !attempts[2].1.contains("guidance"));
        assert!(delivery.pending.is_empty());
    }

    #[test]
    fn inactive_turn_errors_fall_back_to_starting_a_turn() {
        assert!(is_inactive_turn_error("Thread is not being streamed"));
        assert!(is_inactive_turn_error("no-client-found"));
        assert!(!is_inactive_turn_error("permission denied"));
    }
}
