use std::fs::File;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::net::UnixStream;
use std::os::unix::process::CommandExt;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
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

struct BackendGptLiveTestSession {
    child: ChildGuard,
    stdin: Option<Arc<Mutex<ChildStdin>>>,
    output: mpsc::Receiver<Value>,
    stderr: mpsc::Receiver<String>,
    audio_host: Option<std::thread::JoinHandle<()>>,
}

struct AudioCancellationGate {
    observed: mpsc::SyncSender<()>,
    release: mpsc::Receiver<()>,
}

impl BackendGptLiveTestSession {
    fn start_live(endpoint: String) -> Self {
        let (mut command, _pcm, audio_host) = session_command();
        let mut child = ChildGuard(Some(
            command
                .args(["--mode", "gpt-live", "--tts-backend", "openai"])
                .env("OPENAI_API_KEY", "test-key")
                .env("OPENAI_LIVE_ENDPOINT", endpoint)
                .env("OPENAI_REALTIME_VOICE", "marin")
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap(),
        ));
        let process = child.0.as_mut().unwrap();
        let stdin = Arc::new(Mutex::new(process.stdin.take().unwrap()));
        let output = spawn_session_message_reader(process.stdout.take().unwrap());
        let stderr = spawn_session_stderr_reader(process.stderr.take().unwrap());
        let audio_host = spawn_audio_host_with_played_limit(
            audio_host,
            Arc::clone(&stdin),
            None,
            None,
            None,
        );
        let mut session = Self {
            child,
            stdin: Some(stdin),
            output,
            stderr,
            audio_host: Some(audio_host),
        };
        session.send(json!({
            "type":"hello","id":1,"input_during_tts":"allow_barge_in"
        }));
        assert_eq!(session.recv(Duration::from_secs(2))["type"], "ready");
        session
    }

    fn send(&mut self, message: Value) {
        let mut stdin = self
            .stdin
            .as_ref()
            .expect("session input remains open")
            .lock()
            .unwrap();
        write_session_json(&mut *stdin, &message);
        stdin.flush().unwrap();
    }

    fn recv(&self, timeout: Duration) -> Value {
        self.output.recv_timeout(timeout).unwrap_or_else(|error| {
            panic!(
                "session output failed ({error}); stderr: {:?}",
                self.stderr.try_iter().collect::<Vec<_>>()
            )
        })
    }

    fn shutdown(self) {
        let _ = self.shutdown_and_collect();
    }

    fn shutdown_and_collect(mut self) -> Vec<Value> {
        self.send(json!({"type":"shutdown"}));
        self.wait()
    }

    fn wait(self) -> Vec<Value> {
        self.wait_with_stderr().0
    }

    fn wait_with_stderr(mut self) -> (Vec<Value>, Vec<String>) {
        self.stdin.take();
        let status = self.child.0.as_mut().unwrap().wait().unwrap();
        self.child.0 = None;
        assert!(status.success());
        self.audio_host.take().unwrap().join().unwrap();
        (self.output.iter().collect(), self.stderr.iter().collect())
    }
}

fn write_session_json(writer: &mut impl Write, value: &Value) {
    let payload = serde_json::to_vec(value).unwrap();
    writer.write_all(b"BV").unwrap();
    writer.write_all(&[FRAME_MARKER, 1]).unwrap();
    writer
        .write_all(&(payload.len() as u32).to_le_bytes())
        .unwrap();
    writer.write_all(&payload).unwrap();
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

fn spawn_session_stderr_reader(stderr: std::process::ChildStderr) -> mpsc::Receiver<String> {
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            if sender.send(line).is_err() {
                break;
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
    let mut command = Command::new(env!("CARGO_BIN_EXE_berd-voice"));
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

fn spawn_audio_host_with_played_limit(
    mut reader: UnixStream,
    stdin: Arc<Mutex<std::process::ChildStdin>>,
    played_frame_limit: Option<u64>,
    mut played_ready: Option<mpsc::SyncSender<()>>,
    mut cancellation_gate: Option<AudioCancellationGate>,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let mut current = None::<(u64, u64, u64)>;
        loop {
            let mut header = [0_u8; 8];
            match reader.read_exact(&mut header) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => return,
                Err(error) => panic!("audio pipe read failed: {error}"),
            }
            assert_eq!(&header[..2], b"BA");
            assert_eq!(header[2], FRAME_MARKER);
            let length = u32::from_le_bytes(header[4..8].try_into().unwrap()) as usize;
            let mut payload = vec![0_u8; length];
            reader.read_exact(&mut payload).unwrap();
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
                    let sequence = u64::from_le_bytes(payload[8..16].try_into().unwrap());
                    let frames = u64::try_from((payload.len() - 16) / 4).unwrap();
                    let state = current.as_mut().expect("chunk follows begin");
                    assert_eq!(state.0, speech_id);
                    assert_eq!(sequence, state.1 + 1);
                    state.1 = sequence;
                    state.2 += frames;
                    let reached_limit = played_frame_limit.is_some_and(|limit| state.2 >= limit);
                    let mut writer = stdin.lock().unwrap();
                    write_session_json(
                        &mut *writer,
                        &json!({"type":"audio_chunk_accepted","speech_id":speech_id,"sequence":sequence}),
                    );
                    write_session_json(
                        &mut *writer,
                        &json!({"type":"audio_played","speech_id":speech_id,"played_frames":played_frame_limit.map_or(state.2, |limit| state.2.min(limit))}),
                    );
                    writer.flush().unwrap();
                    if reached_limit {
                        if let Some(ready) = played_ready.take() {
                            let _ = ready.send(());
                        }
                    }
                    continue;
                }
                3 => {
                    assert_eq!(payload.len(), 24);
                    let speech_id = u64::from_le_bytes(payload[..8].try_into().unwrap());
                    let sequence = u64::from_le_bytes(payload[8..16].try_into().unwrap());
                    let frames = u64::from_le_bytes(payload[16..24].try_into().unwrap());
                    assert_eq!(current, Some((speech_id, sequence, frames)));
                    current = None;
                    json!({"type":"audio_drained","speech_id":speech_id,"sequence":sequence,"played_frames":frames})
                }
                4 => {
                    assert_eq!(payload.len(), 8);
                    let speech_id = u64::from_le_bytes(payload.try_into().unwrap());
                    let played_frames = current
                        .take()
                        .filter(|state| state.0 == speech_id)
                        .map_or(0, |state| {
                            played_frame_limit.map_or(state.2, |limit| state.2.min(limit))
                        });
                    if let Some(gate) = cancellation_gate.take() {
                        let _ = gate.observed.send(());
                        gate.release.recv().unwrap();
                    }
                    json!({"type":"audio_cancelled","speech_id":speech_id,"played_frames":played_frames})
                }
                kind => panic!("unknown audio record kind {kind}"),
            };
            let mut writer = stdin.lock().unwrap();
            write_session_json(&mut *writer, &message);
            writer.flush().unwrap();
        }
    })
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
    let mut command = Command::new(env!("CARGO_BIN_EXE_berd-voice"));
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
fn framed_hello_reports_input_initialization_failure_before_ready() {
    let missing = std::env::temp_dir().join(format!(
        "berd-voice-missing-parakeet-{}",
        std::process::id()
    ));
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
fn vccli_gpt_live_bridge_starts_and_closes_a_gpt_live_session() {
    let (endpoint_tx, endpoint_rx) = mpsc::sync_channel(1);
    let server = std::thread::spawn(move || {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async move {
                let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
                endpoint_tx
                    .send(format!(
                        "ws://{}/live/sessions",
                        listener.local_addr().unwrap()
                    ))
                    .unwrap();
                let (stream, _) = listener.accept().await.unwrap();
                let mut socket = accept_async(stream).await.unwrap();
                let start = receive_realtime_json(&mut socket).await;
                assert_eq!(start["type"], "session.start");
                assert_eq!(start["session"]["model"], "gpt-live-1");
                assert_eq!(start["session"]["delegation"]["type"], "client");
                send_realtime_json(
                    &mut socket,
                    json!({
                        "type": "session.started",
                        "session": {
                            "model": "gpt-live-1",
                            "audio": { "output": { "voice": "marin" } },
                        },
                    }),
                )
                .await;
                let close = receive_realtime_json(&mut socket).await;
                assert_eq!(close["type"], "session.close");
                send_realtime_json(&mut socket, json!({ "type": "session.closed" })).await;
            });
    });

    let session = BackendGptLiveTestSession::start_live(endpoint_rx.recv().unwrap());
    session.shutdown();
    server.join().unwrap();
}

#[test]
fn vccli_forwards_transcript_since_delegation_and_appends_commentary() {
    let (endpoint_tx, endpoint_rx) = mpsc::sync_channel(1);
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
    let server = std::thread::spawn(move || {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async move {
                let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
                endpoint_tx
                    .send(format!(
                        "ws://{}/live/sessions",
                        listener.local_addr().unwrap()
                    ))
                    .unwrap();
                let (stream, _) = listener.accept().await.unwrap();
                let mut socket = accept_async(stream).await.unwrap();
                let start = receive_realtime_json(&mut socket).await;
                assert_eq!(start["type"], "session.start");
                send_realtime_json(
                    &mut socket,
                    json!({
                        "type": "session.started",
                        "session": {
                            "model": "gpt-live-1",
                            "audio": { "output": { "voice": "marin" } },
                        },
                    }),
                )
                .await;
                tokio::select! {
                    result = ready_rx => result.unwrap(),
                    message = socket.next() => panic!("client closed before ready: {message:?}"),
                }
                send_realtime_json(
                    &mut socket,
                    json!({
                        "type": "session.input_transcript.delta",
                        "delta": "What changed?",
                        "start_ms": 0,
                        "end_ms": 400,
                    }),
                )
                .await;
                send_realtime_json(
                    &mut socket,
                    json!({
                        "type": "session.output_transcript.delta",
                        "delta": "I’ll check.",
                        "start_ms": 500,
                        "end_ms": 800,
                    }),
                )
                .await;
                send_realtime_json(
                    &mut socket,
                    json!({
                        "type": "session.delegation.created",
                        "delegation": { "target": "client", "id": "delegation-1" },
                    }),
                )
                .await;

                let append = receive_realtime_json(&mut socket).await;
                assert_eq!(append["type"], "session.commentary.append");
                assert_eq!(append["delegation_id"], "delegation-1");
                assert_eq!(append["content"], "The migration is ready.");
                let close = receive_realtime_json(&mut socket).await;
                assert_eq!(close["type"], "session.close");
                send_realtime_json(&mut socket, json!({ "type": "session.closed" })).await;
            });
    });

    let mut session = BackendGptLiveTestSession::start_live(endpoint_rx.recv().unwrap());
    ready_tx.send(()).unwrap();
    let user = session.recv(Duration::from_secs(5));
    let gpt_live = session.recv(Duration::from_secs(5));
    let delegation = session.recv(Duration::from_secs(5));
    let delivery = session.recv(Duration::from_secs(5));
    assert_eq!(user["origin"], "user");
    assert_eq!(gpt_live["origin"], "gpt_live");
    assert_eq!(delegation["origin"], "handoff");
    assert_eq!(delivery["type"], "backend_delivery");
    assert_eq!(delivery["events"].as_array().unwrap().len(), 3);

    session.send(json!({
        "type": "prepare_speak",
        "id": 2,
        "acknowledgement": delegation["token"],
        "text": "The migration is ready.",
        "resolved_handoff_ids": ["delegation-1"],
    }));
    let admitted = session.recv(Duration::from_secs(2));
    assert_eq!(admitted["type"], "admitted");
    session.shutdown();
    server.join().unwrap();
}
