use std::fs::File;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::net::UnixStream;
use std::os::unix::process::CommandExt;
use std::process::{Child, ChildStdout, Command, Stdio};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

use futures_util::StreamExt;
use serde_json::{json, Value};
use tokio::net::TcpListener;
use tokio_tungstenite::{accept_async, tungstenite::Message};

const FRAME_MARKER: u8 = 3;

struct ChildGuard(Option<Child>);

impl Drop for ChildGuard {
    fn drop(&mut self) {
        if let Some(child) = self.0.as_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

fn write_session_pcm(writer: &mut impl Write, value: f32) {
    writer.write_all(b"BV").unwrap();
    writer.write_all(&[FRAME_MARKER, 2]).unwrap();
    writer.write_all(&(960_u32 * 4).to_le_bytes()).unwrap();
    for _ in 0..960 {
        writer.write_all(&value.to_le_bytes()).unwrap();
    }
}

fn write_session_json(writer: &mut impl Write, value: &Value) {
    try_write_session_json(writer, value).unwrap();
}

fn try_write_session_json(writer: &mut impl Write, value: &Value) -> std::io::Result<()> {
    let payload = serde_json::to_vec(value).unwrap();
    writer.write_all(b"BV")?;
    writer.write_all(&[FRAME_MARKER, 1])?;
    writer.write_all(&(payload.len() as u32).to_le_bytes())?;
    writer.write_all(&payload)
}

fn write_audio_replies(writer: &mut impl Write, replies: &[Value]) -> bool {
    let result = replies
        .iter()
        .try_for_each(|reply| try_write_session_json(writer, reply))
        .and_then(|()| writer.flush());
    match result {
        Ok(()) => true,
        // The child may terminate with audio records still queued. The fixture
        // waiter independently checks its exit status and protocol terminals.
        Err(error) if error.kind() == std::io::ErrorKind::BrokenPipe => false,
        Err(error) => panic!("fixture audio reply failed: {error}"),
    }
}

fn spawn_session_message_reader(stdout: ChildStdout) -> mpsc::Receiver<Value> {
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        let mut stdout = BufReader::new(stdout);
        loop {
            let mut line = String::new();
            match stdout.read_line(&mut line) {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    let Ok(message) = serde_json::from_str(&line) else {
                        break;
                    };
                    if sender.send(message).is_err() {
                        break;
                    }
                }
            }
        }
    });
    receiver
}

async fn receive_realtime_json(
    socket: &mut tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>,
) -> Value {
    let Message::Text(text) = socket.next().await.unwrap().unwrap() else {
        panic!("expected Realtime JSON")
    };
    serde_json::from_str(&text).unwrap()
}

async fn send_realtime_json(
    socket: &mut tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>,
    value: Value,
) {
    use futures_util::SinkExt;
    socket
        .send(Message::Text(value.to_string().into()))
        .await
        .unwrap();
}

fn session_command() -> (Command, File, UnixStream) {
    let (pcm, host) = UnixStream::pair().unwrap();
    let source_fd = unsafe { libc::fcntl(pcm.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 64) };
    assert!(source_fd >= 64);
    let inherited = unsafe { File::from_raw_fd(source_fd) };
    let mut command = Command::new(env!("CARGO_BIN_EXE_berd-call"));
    command.args(["session", "--pcm-output-fd", "9"]);
    unsafe {
        command.pre_exec(move || {
            if libc::dup2(source_fd, 9) < 0 {
                return Err(std::io::Error::last_os_error());
            }
            if libc::fcntl(9, libc::F_SETFD, 0) < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    (command, inherited, host)
}

fn spawn_audio_host(
    reader: UnixStream,
    stdin: Arc<Mutex<std::process::ChildStdin>>,
) -> std::thread::JoinHandle<std::io::Result<()>> {
    spawn_audio_host_with_played_limit(reader, stdin, None, false)
}

fn spawn_audio_host_with_played_limit<W: Write + Send + 'static>(
    mut reader: UnixStream,
    stdin: Arc<Mutex<W>>,
    played_frame_limit: Option<u64>,
    mut fail_at_limit: bool,
) -> std::thread::JoinHandle<std::io::Result<()>> {
    std::thread::spawn(move || {
        let mut current = None::<(u64, u64, u64)>;
        // The speech whose player failed, and what it played: like the real host, it ignores what the session sent before hearing.
        let mut failed = None::<(u64, u64)>;
        loop {
            let mut header = [0_u8; 8];
            match reader.read_exact(&mut header) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(()),
                Err(error) => panic!("audio pipe read failed: {error}"),
            }
            assert_eq!(&header[..2], b"BA");
            assert_eq!(header[2], FRAME_MARKER);
            let length = u32::from_le_bytes(header[4..8].try_into().unwrap()) as usize;
            let mut payload = vec![0_u8; length];
            reader.read_exact(&mut payload)?;
            let message = match header[3] {
                1 => {
                    assert_eq!(payload.len(), 16);
                    let speech_id = u64::from_le_bytes(payload[..8].try_into().unwrap());
                    current = Some((speech_id, 0, 0));
                    json!({"type":"audio_begin_accepted","speech_id":speech_id})
                }
                2 => {
                    assert!(payload.len() >= 20);
                    let speech_id = u64::from_le_bytes(payload[..8].try_into().unwrap());
                    if failed.is_some_and(|(id, _)| id == speech_id) {
                        continue;
                    }
                    let sequence = u64::from_le_bytes(payload[8..16].try_into().unwrap());
                    let frames = u64::try_from((payload.len() - 16) / 4).unwrap();
                    let state = current.as_mut().expect("chunk follows begin");
                    assert_eq!(state.0, speech_id);
                    assert_eq!(sequence, state.1 + 1);
                    state.1 = sequence;
                    state.2 += frames;
                    let reached_limit = played_frame_limit.is_some_and(|limit| state.2 >= limit);
                    let mut writer = stdin.lock().unwrap();
                    let mut replies = vec![
                        json!({"type":"audio_chunk_accepted","speech_id":speech_id,"sequence":sequence}),
                        json!({"type":"audio_played","speech_id":speech_id,"played_frames":played_frame_limit.map_or(state.2, |limit| state.2.min(limit))}),
                    ];
                    if reached_limit && fail_at_limit {
                        fail_at_limit = false;
                        let played_frames = played_frame_limit.unwrap();
                        failed = Some((speech_id, played_frames));
                        current = None;
                        replies.push(json!({"type":"audio_failed","speech_id":speech_id,"played_frames":played_frames,"message":"PCM audio output stopped unexpectedly"}));
                    }
                    if !write_audio_replies(&mut *writer, &replies) {
                        return Ok(());
                    }
                    continue;
                }
                3 => {
                    assert_eq!(payload.len(), 24);
                    let speech_id = u64::from_le_bytes(payload[..8].try_into().unwrap());
                    if failed.is_some_and(|(id, _)| id == speech_id) {
                        continue;
                    }
                    let sequence = u64::from_le_bytes(payload[8..16].try_into().unwrap());
                    let frames = u64::from_le_bytes(payload[16..24].try_into().unwrap());
                    assert_eq!(current, Some((speech_id, sequence, frames)));
                    current = None;
                    json!({"type":"audio_drained","speech_id":speech_id,"sequence":sequence,"played_frames":frames})
                }
                4 => {
                    assert_eq!(payload.len(), 8);
                    let speech_id = u64::from_le_bytes(payload.try_into().unwrap());
                    if let Some((_, played_frames)) = failed.filter(|(id, _)| *id == speech_id) {
                        let mut writer = stdin.lock().unwrap();
                        if !write_audio_replies(
                            &mut *writer,
                            &[
                                json!({"type":"audio_cancelled","speech_id":speech_id,"played_frames":played_frames}),
                            ],
                        ) {
                            return Ok(());
                        }
                        continue;
                    }
                    let played_frames = current
                        .take()
                        .filter(|state| state.0 == speech_id)
                        .map_or(0, |state| {
                            played_frame_limit.map_or(state.2, |limit| state.2.min(limit))
                        });
                    json!({"type":"audio_cancelled","speech_id":speech_id,"played_frames":played_frames})
                }
                kind => panic!("unknown audio record kind {kind}"),
            };
            let mut writer = stdin.lock().unwrap();
            if !write_audio_replies(&mut *writer, &[message]) {
                return Ok(());
            }
        }
    })
}

fn check_audio_host_result(result: std::io::Result<()>, allow_truncated_payload: bool) {
    if let Err(error) = result {
        assert!(
            allow_truncated_payload && error.kind() == std::io::ErrorKind::UnexpectedEof,
            "fixture audio read failed: {error}"
        );
    }
}

#[test]
fn audio_fixture_payload_errors_require_explicit_shutdown_allowance() {
    for allow in [false, true] {
        check_audio_host_result(Ok(()), allow);
        for kind in [
            std::io::ErrorKind::UnexpectedEof,
            std::io::ErrorKind::PermissionDenied,
            std::io::ErrorKind::ConnectionReset,
        ] {
            let accepted =
                std::panic::catch_unwind(|| check_audio_host_result(Err(kind.into()), allow))
                    .is_ok();
            assert_eq!(accepted, allow && kind == std::io::ErrorKind::UnexpectedEof);
        }
    }
}

#[test]
fn audio_fixture_truncated_payload_does_not_panic_before_shutdown_is_checked() {
    let (input, _peer) = UnixStream::pair().unwrap();
    let (mut audio, reader) = UnixStream::pair().unwrap();
    audio.write_all(b"BA").unwrap();
    audio.write_all(&[FRAME_MARKER, 1]).unwrap();
    audio.write_all(&16_u32.to_le_bytes()).unwrap();
    // The child exits halfway through a valid begin payload.
    audio.write_all(&1_u64.to_le_bytes()).unwrap();
    drop(audio);
    let host = spawn_audio_host_with_played_limit(reader, Arc::new(Mutex::new(input)), None, false);
    let result = host
        .join()
        .expect("payload EOF panicked before child status was checked");
    assert_eq!(
        result.as_ref().unwrap_err().kind(),
        std::io::ErrorKind::UnexpectedEof
    );
    check_audio_host_result(result, true);
}

#[test]
fn audio_fixture_reply_errors_remain_visible_except_for_closed_input() {
    struct FailingWriter(std::io::ErrorKind);
    impl Write for FailingWriter {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Err(self.0.into())
        }
    }
    let reply = json!({"type":"audio_cancelled","speech_id":1,"played_frames":0});
    assert!(!write_audio_replies(
        &mut FailingWriter(std::io::ErrorKind::BrokenPipe),
        std::slice::from_ref(&reply)
    ));
    assert!(std::panic::catch_unwind(|| {
        write_audio_replies(
            &mut FailingWriter(std::io::ErrorKind::PermissionDenied),
            &[reply],
        );
    })
    .is_err());
}

#[test]
fn audio_fixture_can_finish_a_queued_reply_after_child_input_closes() {
    let (input, closed) = UnixStream::pair().unwrap();
    drop(closed);
    let (mut audio, reader) = UnixStream::pair().unwrap();
    // Queue a valid begin record after the child has closed its input. No sleeps
    // or scheduler assumptions: the fixture's first acknowledgement must fail.
    audio.write_all(b"BA").unwrap();
    audio.write_all(&[FRAME_MARKER, 1]).unwrap();
    audio.write_all(&16_u32.to_le_bytes()).unwrap();
    audio.write_all(&1_u64.to_le_bytes()).unwrap();
    audio.write_all(&24_000_u64.to_le_bytes()).unwrap();
    drop(audio);
    let host = spawn_audio_host_with_played_limit(reader, Arc::new(Mutex::new(input)), None, false);
    host.join()
        .expect("late fixture reply panicked after child shutdown")
        .unwrap();
}

#[test]
fn session_rejects_a_read_only_pcm_descriptor_before_hello() {
    let mut descriptors = [-1; 2];
    assert_eq!(unsafe { libc::pipe(descriptors.as_mut_ptr()) }, 0);
    let read = unsafe { File::from_raw_fd(descriptors[0]) };
    let write_guard = unsafe { File::from_raw_fd(descriptors[1]) };
    let source_fd = unsafe { libc::fcntl(read.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 64) };
    assert!(source_fd >= 64);
    let read_guard = unsafe { File::from_raw_fd(source_fd) };
    let mut command = Command::new(env!("CARGO_BIN_EXE_berd-call"));
    command
        .args(["session", "--pcm-output-fd", "9", "--tts-backend", "openai"])
        .env("OPENAI_API_KEY", "test-key-not-used")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    unsafe {
        command.pre_exec(move || {
            if libc::dup2(source_fd, 9) < 0 || libc::fcntl(9, libc::F_SETFD, 0) < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let child = command.spawn().unwrap();
    drop(read_guard);
    drop(write_guard);
    let output = child.wait_with_output().unwrap();
    assert_eq!(output.status.code(), Some(1));
    assert!(output.stdout.is_empty());
    assert!(String::from_utf8_lossy(&output.stderr)
        .contains("PCM output file descriptor is not writable"));
}

#[test]
fn a_session_stops_on_sigterm_even_when_its_host_blocks_it() {
    let (mut command, _pcm, _host) = session_command();
    unsafe {
        command.pre_exec(|| {
            // The host blocks its stop signals, and a spawned process inherits that mask.
            let mut signals = std::mem::zeroed::<libc::sigset_t>();
            libc::sigemptyset(&mut signals);
            libc::sigaddset(&mut signals, libc::SIGINT);
            libc::sigaddset(&mut signals, libc::SIGTERM);
            libc::pthread_sigmask(libc::SIG_BLOCK, &signals, std::ptr::null_mut());
            Ok(())
        });
    }
    let mut child = command
        .args(["--tts-backend", "openai"])
        .env("OPENAI_API_KEY", "test-key-not-used")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    unsafe { libc::kill(child.id() as i32, libc::SIGTERM) };
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        if std::time::Instant::now() > deadline {
            child.kill().unwrap();
            panic!("the session ignored SIGTERM");
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    use std::os::unix::process::ExitStatusExt;
    assert_eq!(status.signal(), Some(libc::SIGTERM));
}

#[test]
fn framed_hello_reports_input_initialization_failure_before_ready() {
    let missing =
        std::env::temp_dir().join(format!("berd-call-missing-parakeet-{}", std::process::id()));
    assert!(!missing.exists(), "test path must remain absent");
    let (mut command, _pcm, _host) = session_command();
    let mut child = command
        .args([
            "--tts-backend",
            "openai",
            "--stt-backend",
            "parakeet",
            "--stt-model-dir",
            missing.to_str().unwrap(),
        ])
        .env("OPENAI_API_KEY", "test-key-not-used-before-synthesis")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let mut stdout = BufReader::new(child.stdout.take().unwrap());
    write_session_json(
        &mut stdin,
        &json!({"type":"hello","id":1,"input_during_tts":"allow_barge_in"}),
    );
    stdin.flush().unwrap();
    let mut line = String::new();
    stdout.read_line(&mut line).unwrap();
    drop(stdin);
    assert!(child.wait().unwrap().success());
    let message: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(message["type"], "fatal");
    assert!(!message["message"].as_str().unwrap().is_empty());
}

#[test]
#[ignore = "requires an installed Siri voice and current-locale macOS SpeechTranscriber model"]
fn siri_session_reaches_ready_without_openai_credentials() {
    let voice = std::env::var("BERD_SIRI_TEST_VOICE").unwrap();
    let language = std::env::var("BERD_SIRI_TEST_LANGUAGE").unwrap_or_else(|_| "en-US".into());
    let (mut command, _pcm, _host) = session_command();
    let mut child = command
        .args([
            "--tts-backend",
            "siri",
            "--voice",
            &voice,
            "--language",
            &language,
        ])
        .env_remove("OPENAI_API_KEY")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let mut stdout = BufReader::new(child.stdout.take().unwrap());
    let mut receive = || {
        let mut line = String::new();
        stdout.read_line(&mut line).unwrap();
        serde_json::from_str::<Value>(&line).unwrap()
    };
    write_session_json(
        &mut stdin,
        &json!({"type":"hello","id":1,"input_during_tts":"allow_barge_in"}),
    );
    stdin.flush().unwrap();
    let ready = receive();
    assert_eq!(ready["type"], "ready");
    assert_eq!(ready["protocol"], 9);
    assert_eq!(ready["session"]["tts"]["backend"], "siri");
    assert_eq!(ready["session"]["tts"]["voice"], voice);
    assert_eq!(ready["session"]["tts"]["language"], language);
    assert_eq!(ready["session"]["tts"]["rate"], 1.0);
    assert_eq!(
        ready["session"]["input_during_tts"],
        json!({"revision":1,"policy":"allow_barge_in"})
    );
    write_session_json(
        &mut stdin,
        &json!({
            "type":"set_conversation_status",
            "id":19,
            "status":"working",
            "settings":{"mode":"working"}
        }),
    );
    stdin.flush().unwrap();
    assert_eq!(
        receive(),
        json!({
            "type":"conversation_status_applied",
            "id":19,
            "status":"working",
            "settings":{"mode":"working"}
        })
    );
    write_session_json(
        &mut stdin,
        &json!({
            "type":"set_input_during_tts",
            "id":20,
            "expected_revision":1,
            "policy":"suppress_input"
        }),
    );
    stdin.flush().unwrap();
    assert_eq!(
        receive(),
        json!({
            "type":"input_during_tts_result",
            "id":20,
            "outcome":"applied",
            "snapshot":{"revision":2,"policy":"suppress_input"}
        })
    );
    write_session_json(
        &mut stdin,
        &json!({
            "type":"set_input_during_tts",
            "id":21,
            "expected_revision":1,
            "policy":"allow_barge_in"
        }),
    );
    stdin.flush().unwrap();
    assert_eq!(
        receive(),
        json!({
            "type":"input_during_tts_result",
            "id":21,
            "outcome":"rejected",
            "snapshot":{"revision":2,"policy":"suppress_input"}
        })
    );
    write_session_json(
        &mut stdin,
        &json!({
            "type":"set_tts_settings",
            "id":2,
            "expected_revision":1,
            "settings":{
                "backend":"siri",
                "voice":voice,
                "language":language,
                "rate":2.0
            }
        }),
    );
    stdin.flush().unwrap();
    let applied = receive();
    assert_eq!(applied["type"], "tts_settings_result");
    assert_eq!(applied["id"], 2);
    assert_eq!(applied["outcome"], "applied");
    assert_eq!(applied["snapshot"]["revision"], 2);
    assert_eq!(applied["snapshot"]["rate"], 2.0);
    assert!(applied.get("message").is_none());
    write_session_json(&mut stdin, &json!({"type":"shutdown"}));
    drop(stdin);
    assert!(child.wait().unwrap().success());
}

#[test]
#[ignore = "requires a Pocket bundle and current-locale macOS SpeechTranscriber model"]
fn pocket_session_reaches_ready_without_openai_credentials() {
    let model_dir = std::env::var("BERD_POCKET_TEST_MODEL_DIR").unwrap();
    let voice = std::env::var("BERD_POCKET_TEST_VOICE").unwrap_or_else(|_| "george".into());
    let (mut command, _pcm, _host) = session_command();
    let mut child = command
        .args([
            "--tts-backend",
            "pocket",
            "--model-dir",
            &model_dir,
            "--voice",
            &voice,
        ])
        .env_remove("OPENAI_API_KEY")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    write_session_json(
        &mut stdin,
        &json!({"type":"hello","id":1,"input_during_tts":"allow_barge_in"}),
    );
    write_session_json(&mut stdin, &json!({"type":"shutdown"}));
    drop(stdin);
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let messages: Vec<Value> = String::from_utf8(output.stdout)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0]["type"], "ready");
    assert_eq!(messages[0]["session"]["tts"]["backend"], "pocket");
    assert_eq!(messages[0]["session"]["tts"]["voice"], voice);
    assert_eq!(messages[0]["session"]["tts"]["rate"], 1.0);
}

#[test]
#[ignore = "requires installed Siri voice and current-locale macOS SpeechTranscriber model"]
fn explicit_macos_stt_session_reaches_ready_without_audio() {
    let voice = std::env::var("BERD_SIRI_TEST_VOICE").unwrap();
    let language = std::env::var("BERD_SIRI_TEST_LANGUAGE").unwrap_or_else(|_| "en-US".into());
    let (mut command, _pcm, _host) = session_command();
    let mut child = command
        .args([
            "--tts-backend",
            "siri",
            "--voice",
            &voice,
            "--language",
            &language,
            "--stt-backend",
            "macos",
        ])
        .env_remove("OPENAI_API_KEY")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    write_session_json(
        &mut stdin,
        &json!({"type":"hello","id":1,"input_during_tts":"allow_barge_in"}),
    );
    write_session_json(&mut stdin, &json!({"type":"shutdown"}));
    drop(stdin);
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let messages: Vec<Value> = String::from_utf8(output.stdout)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0]["type"], "ready");
    assert_eq!(messages[0]["session"]["tts"]["backend"], "siri");
}

#[test]
#[ignore = "requires Siri voice and current-locale macOS SpeechTranscriber model"]
fn siri_remote_output_supports_consecutive_turns_and_cancellation() {
    let voice = std::env::var("BERD_SIRI_TEST_VOICE").unwrap();
    let language = std::env::var("BERD_SIRI_TEST_LANGUAGE").unwrap_or_else(|_| "en-US".into());
    let (mut command, pcm_guard, host) = session_command();
    let child = command
        .args([
            "--tts-backend",
            "siri",
            "--voice",
            &voice,
            "--language",
            &language,
            "--rate",
            "1.5",
        ])
        .env_remove("OPENAI_API_KEY")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    drop(pcm_guard);
    let mut child = ChildGuard(Some(child));
    let child_process = child.0.as_mut().unwrap();
    let stdin = Arc::new(Mutex::new(child_process.stdin.take().unwrap()));
    let audio_host = spawn_audio_host(host, Arc::clone(&stdin));
    let stdout = child_process.stdout.take().unwrap();
    let (sender, receiver) = mpsc::channel();
    let reader = std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            if sender.send(line).is_err() {
                break;
            }
        }
    });
    let send = |message: Value| {
        let mut stdin = stdin.lock().unwrap();
        write_session_json(&mut *stdin, &message);
        stdin.flush().unwrap();
    };
    let receive = || -> Value {
        let line = receiver
            .recv_timeout(Duration::from_secs(10))
            .expect("child did not emit a bounded response")
            .unwrap();
        serde_json::from_str(&line).unwrap()
    };

    send(json!({"type":"hello","id":1,"input_during_tts":"allow_barge_in"}));
    assert_eq!(receive()["type"], "ready");

    send(json!({
        "type":"prepare_speak",
        "id":2,
        "acknowledgement":null,
        "text":"First completed turn."
    }));
    let first = receive();
    assert_eq!(first["type"], "admitted");
    let first_speech_id = first["speech_id"].as_u64().unwrap();
    send(json!({"type":"output_ready","id":2,"speech_id":first_speech_id}));
    assert_eq!(receive()["type"], "output_ready_result");
    assert_eq!(receive()["type"], "speech_started");
    let first_terminal = receive();
    assert_eq!(
        first_terminal["type"], "speech_completed",
        "unexpected first terminal: {first_terminal}"
    );

    send(json!({
        "type":"prepare_speak",
        "id":3,
        "acknowledgement":null,
        "text":"This deliberately long Siri phrase keeps queued output active until playback completes and the session must promptly return to idle."
    }));
    let admitted = receive();
    assert_eq!(admitted["type"], "admitted");
    let speech_id = admitted["speech_id"].as_u64().unwrap();
    send(json!({"type":"output_ready","id":3,"speech_id":speech_id}));
    assert_eq!(receive()["type"], "output_ready_result");
    assert_eq!(receive()["type"], "speech_started");
    assert_eq!(receive()["type"], "speech_completed");

    send(json!({
        "type":"prepare_speak",
        "id":4,
        "acknowledgement":null,
        "text":"This second deliberately long Siri phrase stays active until targeted cancellation interrupts playback and the session must promptly return to idle."
    }));
    let interruptible = receive();
    assert_eq!(interruptible["type"], "admitted");
    let speech_id = interruptible["speech_id"].as_u64().unwrap();
    send(json!({"type":"output_ready","id":4,"speech_id":speech_id}));
    assert_eq!(receive()["type"], "output_ready_result");
    assert_eq!(receive()["type"], "speech_started");
    send(json!({"type":"cancel","id":4}));
    assert_eq!(receive()["type"], "cancel_result");
    assert_eq!(receive()["type"], "speech_interrupted");

    send(json!({"type":"prepare_speak","id":5,"acknowledgement":null,"text":"next"}));
    let next = receive();
    assert_eq!(next["type"], "admitted");
    send(json!({"type":"cancel","id":5}));
    assert_eq!(receive()["type"], "cancel_result");
    assert_eq!(receive()["type"], "speech_interrupted");
    send(json!({"type":"shutdown"}));
    drop(stdin);
    let mut child_process = child.0.take().unwrap();
    assert!(child_process.wait().unwrap().success());
    reader.join().unwrap();
    audio_host.join().unwrap().unwrap();
}

#[test]
fn speech_whose_player_stops_is_interrupted_where_it_was_heard_and_the_call_goes_on() {
    let (speech_url, _speech_requests) = spawn_speech_server();
    let (mut command, pcm_guard, host) = session_command();
    let child = command
        .args([
            "--tts-backend",
            "openai",
            "--tts-url",
            &speech_url,
            "--stt-backend",
            "openai",
            "--stt-url",
            &spawn_transcription_server(),
        ])
        .env("OPENAI_API_KEY", "test-key")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    drop(pcm_guard);
    let mut child = ChildGuard(Some(child));
    let process = child.0.as_mut().unwrap();
    let stdin = Arc::new(Mutex::new(process.stdin.take().unwrap()));
    let output = spawn_session_message_reader(process.stdout.take().unwrap());
    // The host's player stops partway through the first speech, as when the speakers change.
    let audio_host =
        spawn_audio_host_with_played_limit(host, Arc::clone(&stdin), Some(1_200), true);
    let send = |message: Value| {
        let mut stdin = stdin.lock().unwrap();
        write_session_json(&mut *stdin, &message);
        stdin.flush().unwrap();
    };
    let terminal = |id: u64| loop {
        let message = output.recv_timeout(Duration::from_secs(5)).unwrap();
        match message["type"].as_str() {
            Some("admitted") => send(json!({
                "type":"output_ready","id":id,"speech_id":message["speech_id"]
            })),
            Some("output_ready_result" | "speech_started") => {}
            _ => break message,
        }
    };
    send(json!({"type":"hello","id":1,"input_during_tts":"allow_barge_in"}));
    let ready = output.recv_timeout(Duration::from_secs(5)).unwrap();
    assert_eq!(ready["type"], "ready", "{ready}");
    let text = "A reply cut off by a change of speakers.";
    send(json!({"type":"prepare_speak","id":2,"acknowledgement":null,"text":text}));
    let interrupted = terminal(2);
    assert_eq!(interrupted["type"], "speech_interrupted", "{interrupted}");
    let heard = interrupted["spoken_through_utf8"].as_u64().unwrap();
    assert!(heard < text.len() as u64, "{interrupted}");
    send(json!({"type":"prepare_speak","id":3,"acknowledgement":null,"text":"Still here."}));
    assert_eq!(terminal(3)["type"], "speech_completed");
    send(json!({"type":"shutdown"}));
    drop(stdin);
    assert!(child.0.take().unwrap().wait().unwrap().success());
    audio_host.join().unwrap().unwrap();
}

/// Accepts one OpenAI transcription session that never hears anything.
fn spawn_transcription_server() -> String {
    let (endpoint_tx, endpoint_rx) = mpsc::sync_channel(1);
    std::thread::spawn(move || {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async move {
                let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
                endpoint_tx
                    .send(format!("ws://{}/", listener.local_addr().unwrap()))
                    .unwrap();
                let (stream, _) = listener.accept().await.unwrap();
                let mut socket = accept_async(stream).await.unwrap();
                assert_eq!(
                    receive_realtime_json(&mut socket).await["type"],
                    "session.update"
                );
                send_realtime_json(&mut socket, json!({"type":"session.updated"})).await;
                while let Some(Ok(_)) = socket.next().await {}
            });
    });
    endpoint_rx.recv().unwrap()
}

/// Serves OpenAI speech requests with a little silence, reporting each request body.
fn spawn_speech_server() -> (String, mpsc::Receiver<Value>) {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}/v1/audio/speech", listener.local_addr().unwrap());
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let mut stream = stream.unwrap();
            let mut request = Vec::new();
            let mut byte = [0_u8; 1];
            while !request.ends_with(b"\r\n\r\n") {
                stream.read_exact(&mut byte).unwrap();
                request.push(byte[0]);
            }
            let head = String::from_utf8(request).unwrap().to_ascii_lowercase();
            let length = head
                .lines()
                .find_map(|line| line.strip_prefix("content-length:"))
                .unwrap()
                .trim()
                .parse()
                .unwrap();
            let mut body = vec![0_u8; length];
            stream.read_exact(&mut body).unwrap();
            let _ = sender.send(serde_json::from_slice(&body).unwrap());
            let audio = vec![1_u8; 4_800];
            write!(
                stream,
                "HTTP/1.1 200 OK\r\ncontent-type: audio/pcm\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                audio.len()
            )
            .unwrap();
            stream.write_all(&audio).unwrap();
        }
    });
    (url, receiver)
}

#[test]
fn capture_is_readable_by_event_replay() {
    let capture_root = tempfile::tempdir().unwrap();
    let (speech_url, _requests) = spawn_speech_server();
    let (mut command, pcm_guard, host) = session_command();
    let mut child = command
        .args([
            "--capture",
            capture_root.path().to_str().unwrap(),
            "--tts-backend",
            "openai",
            "--tts-url",
            &speech_url,
            "--stt-backend",
            "openai",
            "--stt-url",
            &spawn_transcription_server(),
        ])
        .env("OPENAI_API_KEY", "test-key")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    drop(pcm_guard);
    let stdin = Arc::new(Mutex::new(child.stdin.take().unwrap()));
    let output = spawn_session_message_reader(child.stdout.take().unwrap());
    let audio_host = spawn_audio_host(host, Arc::clone(&stdin));
    let send = |message: Value| {
        let mut writer = stdin.lock().unwrap();
        write_session_json(&mut *writer, &message);
        writer.flush().unwrap();
    };
    send(json!({"type":"hello","id":1,"input_during_tts":"allow_barge_in"}));
    assert_eq!(
        output.recv_timeout(Duration::from_secs(5)).unwrap()["type"],
        "ready"
    );
    {
        let mut writer = stdin.lock().unwrap();
        write_session_pcm(&mut *writer, 0.0);
        writer.flush().unwrap();
    }
    send(
        json!({"type":"prepare_speak","id":2,"acknowledgement":null,"text":"Capture this reply."}),
    );
    loop {
        let event = output.recv_timeout(Duration::from_secs(5)).unwrap();
        match event["type"].as_str() {
            Some("admitted") => {
                send(json!({"type":"output_ready","id":2,"speech_id":event["speech_id"]}))
            }
            Some("speech_completed") => break,
            Some("speech_interrupted" | "fatal") => panic!("{event}"),
            _ => {}
        }
    }
    send(json!({"type":"shutdown"}));
    drop(stdin);
    assert!(child.wait().unwrap().success());
    audio_host.join().unwrap().unwrap();
    let dir = std::fs::read_dir(capture_root.path())
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    let manifest: Value =
        serde_json::from_slice(&std::fs::read(dir.join("manifest.json")).unwrap()).unwrap();
    assert_eq!(manifest["schema"], "berd-call-capture/1");
    assert!(std::fs::metadata(dir.join("mic.wav")).unwrap().len() > 44);
    assert!(std::fs::read_dir(&dir).unwrap().any(|entry| entry
        .unwrap()
        .file_name()
        .to_string_lossy()
        .ends_with(".sent.wav")));
    let replay = Command::new(env!("CARGO_BIN_EXE_berd-call"))
        .args(["vad-replay", "events", dir.to_str().unwrap()])
        .output()
        .unwrap();
    assert!(
        replay.status.success(),
        "{}",
        String::from_utf8_lossy(&replay.stderr)
    );
    let report: Value = serde_json::from_slice(&replay.stdout).unwrap();
    assert!(report.is_object());
}
