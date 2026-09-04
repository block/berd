use std::fs::File;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::net::UnixStream;
use std::os::unix::process::CommandExt;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use futures_util::StreamExt;
use serde_json::{json, Value};
use tokio::net::TcpListener;
use tokio_tungstenite::{accept_async, tungstenite::Message};

struct ChildGuard(Option<Child>);

impl Drop for ChildGuard {
    fn drop(&mut self) {
        if let Some(child) = self.0.as_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

struct ExpertSpokespersonTestSession {
    child: ChildGuard,
    stdin: Option<Arc<Mutex<ChildStdin>>>,
    output: mpsc::Receiver<Value>,
    stderr: mpsc::Receiver<String>,
    audio_host: Option<std::thread::JoinHandle<()>>,
}

impl ExpertSpokespersonTestSession {
    fn start(endpoint: String) -> Self {
        Self::start_with_renew_after(endpoint, None)
    }

    fn start_with_renew_after(endpoint: String, renew_after_ms: Option<u64>) -> Self {
        Self::start_with_options(endpoint, renew_after_ms, None, None)
    }

    fn start_with_options(
        endpoint: String,
        renew_after_ms: Option<u64>,
        played_frame_limit: Option<u64>,
        played_ready: Option<mpsc::SyncSender<()>>,
    ) -> Self {
        let (mut command, _pcm, audio_host) = session_command();
        if let Some(renew_after_ms) = renew_after_ms {
            command.env(
                "BERD_VOICE_REALTIME_RENEW_AFTER_MS",
                renew_after_ms.to_string(),
            );
        }
        let mut child = ChildGuard(Some(
            command
                .args(["--mode", "expert-spokesperson", "--tts-backend", "openai"])
                .env("OPENAI_API_KEY", "test-key")
                .env("OPENAI_REALTIME_ENDPOINT", endpoint)
                .env("OPENAI_REALTIME_MODEL", "test-model")
                .env("OPENAI_REALTIME_VOICE", "old-voice")
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
            played_frame_limit,
            played_ready,
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

    fn send_pcm(&mut self, value: f32) {
        let mut stdin = self
            .stdin
            .as_ref()
            .expect("session input remains open")
            .lock()
            .unwrap();
        write_session_pcm(&mut *stdin, value);
    }

    fn flush(&mut self) {
        self.stdin
            .as_ref()
            .unwrap()
            .lock()
            .unwrap()
            .flush()
            .unwrap();
    }

    fn recv(&self, timeout: Duration) -> Value {
        self.output.recv_timeout(timeout).unwrap()
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
    writer.write_all(&[2, 1]).unwrap();
    writer
        .write_all(&(payload.len() as u32).to_le_bytes())
        .unwrap();
    writer.write_all(&payload).unwrap();
}

fn write_session_pcm(writer: &mut impl Write, value: f32) {
    writer.write_all(b"BV").unwrap();
    writer.write_all(&[2, 2]).unwrap();
    writer.write_all(&(960_u32 * 4).to_le_bytes()).unwrap();
    for _ in 0..960 {
        writer.write_all(&value.to_le_bytes()).unwrap();
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

async fn acknowledge_realtime_session(
    socket: &mut tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>,
    update: &Value,
) {
    send_realtime_json(
        socket,
        json!({
            "type":"session.updated",
            "session": {
                "model":"test-model",
                "audio": { "output": update["session"]["audio"]["output"].clone() }
            }
        }),
    )
    .await;
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

fn spawn_audio_host(
    reader: UnixStream,
    stdin: Arc<Mutex<std::process::ChildStdin>>,
) -> std::thread::JoinHandle<()> {
    spawn_audio_host_with_played_limit(reader, stdin, None, None)
}

fn spawn_audio_host_with_played_limit(
    mut reader: UnixStream,
    stdin: Arc<Mutex<std::process::ChildStdin>>,
    played_frame_limit: Option<u64>,
    mut played_ready: Option<mpsc::SyncSender<()>>,
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
            assert_eq!(header[2], 2);
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
fn expert_spokesperson_renews_before_provider_expiry_without_changing_settings() {
    let (endpoint_tx, endpoint_rx) = mpsc::sync_channel(1);
    let (suspended_tx, suspended_rx) = mpsc::sync_channel(1);
    let (audio_ready_tx, audio_ready_rx) = mpsc::sync_channel(1);
    let (release_speech_tx, release_speech_rx) = mpsc::sync_channel(1);
    let (renewed_tx, renewed_rx) = mpsc::sync_channel(1);
    let server = std::thread::spawn(move || {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async move {
                let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
                endpoint_tx
                    .send(format!("ws://{}/", listener.local_addr().unwrap()))
                    .unwrap();
                let (old_stream, _) = listener.accept().await.unwrap();
                let mut old = accept_async(old_stream).await.unwrap();
                let initial = receive_realtime_json(&mut old).await;
                acknowledge_realtime_session(&mut old, &initial).await;
                send_realtime_json(
                    &mut old,
                    json!({"type":"input_audio_buffer.speech_started","item_id":"user-1"}),
                )
                .await;
                send_realtime_json(
                    &mut old,
                    json!({"type":"input_audio_buffer.speech_stopped","item_id":"user-1"}),
                )
                .await;
                send_realtime_json(
                    &mut old,
                    json!({"type":"conversation.item.input_audio_transcription.completed","item_id":"user-1","transcript":"remember this"}),
                )
                .await;
                assert_eq!(receive_realtime_json(&mut old).await["type"], "response.create");
                send_realtime_json(
                    &mut old,
                    json!({"type":"response.created","response":{"id":"response-1"}}),
                )
                .await;
                let audio = BASE64.encode(vec![0_u8; 24_000]);
                for _ in 0..2 {
                    send_realtime_json(
                        &mut old,
                        json!({"type":"response.output_audio.delta","response_id":"response-1","item_id":"assistant-1","content_index":0,"delta":audio}),
                    )
                    .await;
                }
                send_realtime_json(
                    &mut old,
                    json!({"type":"response.output_audio_transcript.done","response_id":"response-1","transcript":"heard words UNSAID SUFFIX"}),
                )
                .await;
                tokio::task::spawn_blocking(move || release_speech_rx.recv().unwrap()).await.unwrap();
                send_realtime_json(&mut old, json!({"type":"input_audio_buffer.speech_started","item_id":"user-2"})).await;
                tokio::task::spawn_blocking(move || suspended_rx.recv().unwrap()).await.unwrap();
                send_realtime_json(&mut old, json!({"type":"input_audio_buffer.speech_stopped","item_id":"user-2"})).await;
                send_realtime_json(&mut old, json!({"type":"conversation.item.input_audio_transcription.completed","item_id":"user-2","transcript":"interrupt now"})).await;
                assert_eq!(receive_realtime_json(&mut old).await["type"], "response.cancel");
                let truncate = receive_realtime_json(&mut old).await;
                assert_eq!(truncate["type"], "conversation.item.truncate");
                send_realtime_json(&mut old, json!({"type":"conversation.item.truncated","item_id":"assistant-1","content_index":0})).await;
                send_realtime_json(&mut old, json!({"type":"response.done","response":{"id":"response-1","status":"cancelled"}})).await;
                assert_eq!(receive_realtime_json(&mut old).await["type"], "response.create");
                send_realtime_json(&mut old, json!({"type":"response.created","response":{"id":"response-2"}})).await;
                send_realtime_json(&mut old, json!({"type":"response.output_audio_transcript.done","response_id":"response-2","transcript":"after interruption"})).await;
                send_realtime_json(&mut old, json!({"type":"response.done","response":{"id":"response-2","status":"completed"}})).await;

                let (candidate_stream, _) =
                    tokio::time::timeout(Duration::from_secs(2), listener.accept())
                        .await
                        .expect("renewal candidate should connect before provider expiry")
                        .unwrap();
                let mut candidate = accept_async(candidate_stream).await.unwrap();
                let replacement = receive_realtime_json(&mut candidate).await;
                assert_eq!(replacement["type"], "session.update");
                assert_eq!(
                    replacement["session"]["audio"]["output"]["voice"],
                    "old-voice"
                );
                assert_eq!(replacement["session"]["audio"]["output"]["speed"], 1.0);
                acknowledge_realtime_session(&mut candidate, &replacement).await;
                let user_seed = receive_realtime_json(&mut candidate).await;
                assert_eq!(user_seed["item"]["role"], "user");
                assert_eq!(user_seed["item"]["content"][0]["text"], "remember this");
                send_realtime_json(
                    &mut candidate,
                    json!({"type":"conversation.item.created","item":{"id":user_seed["item"]["id"]}}),
                )
                .await;
                let spokesperson_seed = receive_realtime_json(&mut candidate).await;
                assert_eq!(spokesperson_seed["item"]["role"], "assistant");
                assert_eq!(spokesperson_seed["item"]["content"][0]["text"], "heard words [interrupted]");
                assert!(!spokesperson_seed["item"]["content"][0]["text"]
                    .as_str()
                    .unwrap()
                    .contains("UNSAID SUFFIX"));
                send_realtime_json(
                    &mut candidate,
                    json!({"type":"conversation.item.created","item":{"id":spokesperson_seed["item"]["id"]}}),
                )
                .await;
                for (role, text) in [("user", "interrupt now"), ("assistant", "after interruption")] {
                    let seed = receive_realtime_json(&mut candidate).await;
                    assert_eq!(seed["item"]["role"], role);
                    assert_eq!(seed["item"]["content"][0]["text"], text);
                    send_realtime_json(&mut candidate, json!({"type":"conversation.item.created","item":{"id":seed["item"]["id"]}})).await;
                }
                let clear = receive_realtime_json(&mut old).await;
                assert_eq!(clear["type"], "input_audio_buffer.clear");
                send_realtime_json(&mut old, json!({"type":"input_audio_buffer.cleared"})).await;
                let _ = old.next().await;
                renewed_tx.send(()).unwrap();
                let _ = candidate.next().await;
            });
    });
    let endpoint = endpoint_rx.recv().unwrap();
    let mut session = ExpertSpokespersonTestSession::start_with_options(
        endpoint,
        Some(1_000),
        Some(12_000),
        Some(audio_ready_tx),
    );
    audio_ready_rx.recv_timeout(Duration::from_secs(2)).unwrap();
    release_speech_tx.send(()).unwrap();
    let mut messages = Vec::new();
    loop {
        let message = session.recv(Duration::from_secs(2));
        let is_suspend = message["type"] == "audio_suspend";
        let speech_id = message["speech_id"].as_u64();
        messages.push(message);
        if is_suspend {
            assert!(speech_id.is_some());
            session.send(json!({"type":"audio_suspended","speech_id":speech_id.unwrap(),"played_frames":12000}));
            session.send(json!({"type":"query_state","id":99,"after":0}));
            loop {
                let barrier = session.recv(Duration::from_secs(2));
                let done = barrier["type"] == "state" && barrier["id"] == 99;
                messages.push(barrier);
                if done {
                    break;
                }
            }
            suspended_tx.send(()).unwrap();
            break;
        }
    }
    renewed_rx.recv_timeout(Duration::from_secs(2)).unwrap();
    messages.extend(session.shutdown_and_collect());
    assert!(messages
        .iter()
        .all(|message| message["type"] != "tts_settings_result"));
    server.join().unwrap();
}

#[test]
fn expert_spokesperson_recovers_from_provider_expiry_and_preserves_pcm_once() {
    let (endpoint_tx, endpoint_rx) = mpsc::sync_channel(1);
    let (candidate_seen_tx, candidate_seen_rx) = mpsc::sync_channel(1);
    let (release_candidate_tx, release_candidate_rx) = mpsc::sync_channel(1);
    let server = std::thread::spawn(move || {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async move {
                let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
                endpoint_tx
                    .send(format!("ws://{}/", listener.local_addr().unwrap()))
                    .unwrap();
                let (old_stream, _) = listener.accept().await.unwrap();
                let mut old = accept_async(old_stream).await.unwrap();
                let initial = receive_realtime_json(&mut old).await;
                acknowledge_realtime_session(&mut old, &initial).await;
                send_realtime_json(
                    &mut old,
                    json!({
                        "type":"error",
                        "error":{"message":"Your session hit the maximum duration of 60 minutes."}
                    }),
                )
                .await;

                let (candidate_stream, _) = listener.accept().await.unwrap();
                let mut candidate = accept_async(candidate_stream).await.unwrap();
                let replacement = receive_realtime_json(&mut candidate).await;
                candidate_seen_tx.send(()).unwrap();
                tokio::task::spawn_blocking(move || release_candidate_rx.recv().unwrap())
                    .await
                    .unwrap();
                acknowledge_realtime_session(&mut candidate, &replacement).await;
                let pcm = tokio::time::timeout(
                    Duration::from_secs(2),
                    receive_realtime_json(&mut candidate),
                )
                .await
                .expect("held PCM should reach the recovered runtime");
                assert_eq!(pcm["type"], "input_audio_buffer.append");
                if let Ok(Some(Ok(Message::Text(text)))) =
                    tokio::time::timeout(Duration::from_millis(100), candidate.next()).await
                {
                    let message: Value = serde_json::from_str(&text).unwrap();
                    assert_ne!(message["type"], "input_audio_buffer.append");
                }
                let _ = candidate.next().await;
            });
    });
    let endpoint = endpoint_rx.recv().unwrap();
    let mut session = ExpertSpokespersonTestSession::start(endpoint);
    candidate_seen_rx
        .recv_timeout(Duration::from_secs(2))
        .unwrap();
    session.send_pcm(0.25);
    session.flush();
    release_candidate_tx.send(()).unwrap();
    std::thread::sleep(Duration::from_millis(100));
    session.shutdown();
    server.join().unwrap();
}

#[test]
fn expert_spokesperson_recovers_from_quiescent_provider_disconnect() {
    let (endpoint_tx, endpoint_rx) = mpsc::sync_channel(1);
    let (recovery_ready_tx, recovery_ready_rx) = mpsc::sync_channel(1);
    let (pcm_seen_tx, pcm_seen_rx) = mpsc::sync_channel(1);
    let server = std::thread::spawn(move || {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async move {
                let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
                endpoint_tx
                    .send(format!("ws://{}/", listener.local_addr().unwrap()))
                    .unwrap();
                let (old_stream, _) = listener.accept().await.unwrap();
                let mut old = accept_async(old_stream).await.unwrap();
                let initial = receive_realtime_json(&mut old).await;
                acknowledge_realtime_session(&mut old, &initial).await;
                drop(old);

                let (candidate_stream, _) =
                    tokio::time::timeout(Duration::from_secs(2), listener.accept())
                        .await
                        .expect("disconnect should start recovery")
                        .unwrap();
                let mut candidate = accept_async(candidate_stream).await.unwrap();
                let replacement = receive_realtime_json(&mut candidate).await;
                assert_eq!(
                    replacement["session"]["audio"]["output"],
                    initial["session"]["audio"]["output"]
                );
                acknowledge_realtime_session(&mut candidate, &replacement).await;
                recovery_ready_tx.send(()).unwrap();
                let pcm = receive_realtime_json(&mut candidate).await;
                assert_eq!(pcm["type"], "input_audio_buffer.append");
                pcm_seen_tx.send(()).unwrap();
                if let Ok(Some(Ok(Message::Text(text)))) =
                    tokio::time::timeout(Duration::from_millis(100), candidate.next()).await
                {
                    let message: Value = serde_json::from_str(&text).unwrap();
                    assert_ne!(message["type"], "input_audio_buffer.append");
                }
                let _ = candidate.next().await;
            });
    });
    let endpoint = endpoint_rx.recv().unwrap();
    let mut session = ExpertSpokespersonTestSession::start(endpoint);
    recovery_ready_rx
        .recv_timeout(Duration::from_secs(2))
        .unwrap();
    session.send_pcm(0.25);
    session.flush();
    pcm_seen_rx.recv_timeout(Duration::from_secs(2)).unwrap();
    session.send(json!({
        "type":"set_tts_settings",
        "id":2,
        "expected_revision":2,
        "settings":{"backend":"openai","model":"test-model","voice":"old-voice","rate":1.0}
    }));
    let authoritative = session.recv(Duration::from_secs(2));
    assert_eq!(authoritative["type"], "tts_settings_result");
    assert_eq!(authoritative["id"], 2);
    assert_eq!(authoritative["outcome"], "rejected");
    assert_eq!(authoritative["snapshot"]["revision"], 1);
    assert_eq!(authoritative["snapshot"]["voice"], "old-voice");
    assert!(session
        .shutdown_and_collect()
        .iter()
        .all(|message| message["type"] != "tts_settings_result"));
    server.join().unwrap();
}

#[test]
fn active_spokesperson_disconnect_is_specific_terminal_and_does_not_replay() {
    let (endpoint_tx, endpoint_rx) = mpsc::sync_channel(1);
    let (release_disconnect_tx, release_disconnect_rx) = mpsc::sync_channel(1);
    let server = std::thread::spawn(move || {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async move {
                let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
                endpoint_tx
                    .send(format!("ws://{}/", listener.local_addr().unwrap()))
                    .unwrap();
                let (old_stream, _) = listener.accept().await.unwrap();
                let mut old = accept_async(old_stream).await.unwrap();
                let initial = receive_realtime_json(&mut old).await;
                acknowledge_realtime_session(&mut old, &initial).await;
                assert_eq!(
                    receive_realtime_json(&mut old).await["type"],
                    "conversation.item.create"
                );
                assert_eq!(
                    receive_realtime_json(&mut old).await["type"],
                    "response.create"
                );
                send_realtime_json(
                    &mut old,
                    json!({"type":"response.created","response":{"id":"response-active"}}),
                )
                .await;
                send_realtime_json(
                    &mut old,
                    json!({
                        "type":"response.output_audio.delta",
                        "response_id":"response-active",
                        "item_id":"assistant-active",
                        "content_index":0,
                        "delta":BASE64.encode(vec![0_u8; 24_000])
                    }),
                )
                .await;
                tokio::task::spawn_blocking(move || release_disconnect_rx.recv().unwrap())
                    .await
                    .unwrap();
                drop(old);
                assert!(
                    tokio::time::timeout(Duration::from_millis(300), listener.accept())
                        .await
                        .is_err(),
                    "active output must not be replayed on a replacement session"
                );
            });
    });
    let endpoint = endpoint_rx.recv().unwrap();
    let mut session = ExpertSpokespersonTestSession::start(endpoint);
    session.send(json!({
        "type":"prepare_speak",
        "id":2,
        "acknowledgement":null,
        "text":"keep this response active"
    }));
    let admitted = session.recv(Duration::from_secs(2));
    assert_eq!(admitted["type"], "admitted");
    session.send(json!({
        "type":"output_ready",
        "id":2,
        "speech_id":admitted["speech_id"]
    }));
    assert_eq!(
        session.recv(Duration::from_secs(2))["type"],
        "output_ready_result"
    );
    assert_eq!(
        session.recv(Duration::from_secs(2))["type"],
        "spokesperson_speech"
    );
    release_disconnect_tx.send(()).unwrap();
    let fatal = session.recv(Duration::from_secs(2));
    assert_eq!(fatal["type"], "fatal");
    assert_eq!(
        fatal["message"],
        "Spokesperson connection was lost during an active turn"
    );
    let (remaining, stderr) = session.wait_with_stderr();
    assert!(remaining
        .iter()
        .all(|message| message["type"] != "user_final"));
    assert!(stderr
        .iter()
        .any(|line| line.contains("without closing handshake")));
    server.join().unwrap();
}

#[test]
fn expert_spokesperson_expiry_recovery_failure_reports_the_specific_terminal() {
    let (endpoint_tx, endpoint_rx) = mpsc::sync_channel(1);
    let server = std::thread::spawn(move || {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async move {
                let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
                endpoint_tx
                    .send(format!("ws://{}/", listener.local_addr().unwrap()))
                    .unwrap();
                let (old_stream, _) = listener.accept().await.unwrap();
                let mut old = accept_async(old_stream).await.unwrap();
                let initial = receive_realtime_json(&mut old).await;
                acknowledge_realtime_session(&mut old, &initial).await;
                send_realtime_json(
                    &mut old,
                    json!({
                        "type":"error",
                        "error":{"message":"Your session hit the maximum duration of 60 minutes."}
                    }),
                )
                .await;
                let (candidate_stream, _) = listener.accept().await.unwrap();
                let candidate = accept_async(candidate_stream).await.unwrap();
                drop(candidate);
            });
    });
    let endpoint = endpoint_rx.recv().unwrap();
    let session = ExpertSpokespersonTestSession::start(endpoint);
    let fatal = session.recv(Duration::from_secs(2));
    assert_eq!(fatal["type"], "fatal");
    assert_eq!(fatal["message"], "Spokesperson session renewal failed");
    assert!(session
        .wait()
        .iter()
        .all(|message| message["type"] != "tts_settings_result"));
    server.join().unwrap();
}

#[test]
fn provider_expiry_during_user_voice_change_never_silently_activates_the_candidate() {
    let (endpoint_tx, endpoint_rx) = mpsc::sync_channel(1);
    let (recovery_ready_tx, recovery_ready_rx) = mpsc::sync_channel(1);
    let (pcm_seen_tx, pcm_seen_rx) = mpsc::sync_channel(1);
    let server = std::thread::spawn(move || {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async move {
                let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
                endpoint_tx
                    .send(format!("ws://{}/", listener.local_addr().unwrap()))
                    .unwrap();
                let (old_stream, _) = listener.accept().await.unwrap();
                let mut old = accept_async(old_stream).await.unwrap();
                let initial = receive_realtime_json(&mut old).await;
                acknowledge_realtime_session(&mut old, &initial).await;
                let (candidate_stream, _) = listener.accept().await.unwrap();
                let mut candidate = accept_async(candidate_stream).await.unwrap();
                let update = receive_realtime_json(&mut candidate).await;
                assert_eq!(update["session"]["audio"]["output"]["voice"], "new-voice");
                send_realtime_json(
                    &mut old,
                    json!({"type":"error","error":{"code":"session_expired","message":"provider session expired"}}),
                )
                .await;
                let _ = candidate.next().await;
                let (recovery_stream, _) = listener.accept().await.unwrap();
                let mut recovery = accept_async(recovery_stream).await.unwrap();
                let recovery_update = receive_realtime_json(&mut recovery).await;
                assert_eq!(
                    recovery_update["session"]["audio"]["output"]["voice"],
                    "old-voice"
                );
                acknowledge_realtime_session(&mut recovery, &recovery_update).await;
                recovery_ready_tx.send(()).unwrap();
                let pcm = receive_realtime_json(&mut recovery).await;
                assert_eq!(pcm["type"], "input_audio_buffer.append");
                pcm_seen_tx.send(()).unwrap();
                let _ = recovery.next().await;
            });
    });
    let endpoint = endpoint_rx.recv().unwrap();
    let mut session = ExpertSpokespersonTestSession::start(endpoint);
    session.send(json!({
        "type":"set_tts_settings",
        "id":2,
        "expected_revision":1,
        "settings":{"backend":"openai","model":"test-model","voice":"new-voice","rate":1.0}
    }));
    let rejected = session.recv(Duration::from_secs(2));
    assert_eq!(rejected["type"], "tts_settings_result");
    assert_eq!(rejected["id"], 2);
    assert_eq!(rejected["outcome"], "rejected");
    assert_eq!(rejected["snapshot"]["revision"], 1);
    assert_eq!(rejected["snapshot"]["voice"], "old-voice");
    recovery_ready_rx
        .recv_timeout(Duration::from_secs(2))
        .unwrap();
    session.send_pcm(0.25);
    session.flush();
    pcm_seen_rx.recv_timeout(Duration::from_secs(2)).unwrap();
    session.send(json!({
        "type":"set_tts_settings",
        "id":3,
        "expected_revision":2,
        "settings":{"backend":"openai","model":"test-model","voice":"old-voice","rate":1.0}
    }));
    let authoritative = session.recv(Duration::from_secs(2));
    assert_eq!(
        authoritative["type"], "tts_settings_result",
        "unexpected post-recovery message: {authoritative}"
    );
    assert_eq!(authoritative["id"], 3);
    assert_eq!(authoritative["outcome"], "rejected");
    assert_eq!(authoritative["snapshot"]["revision"], 1);
    assert_eq!(authoritative["snapshot"]["voice"], "old-voice");
    assert!(session.shutdown_and_collect().iter().all(|message| {
        message["type"] != "tts_settings_result"
            || message["id"] != 2
            || message["outcome"] != "applied"
    }));
    server.join().unwrap();
}

#[test]
fn unresolved_handoff_at_provider_expiry_fails_without_starting_a_replacement() {
    let (endpoint_tx, endpoint_rx) = mpsc::sync_channel(1);
    let server = std::thread::spawn(move || {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async move {
                let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
                endpoint_tx
                    .send(format!("ws://{}/", listener.local_addr().unwrap()))
                    .unwrap();
                let (old_stream, _) = listener.accept().await.unwrap();
                let mut old = accept_async(old_stream).await.unwrap();
                let initial = receive_realtime_json(&mut old).await;
                acknowledge_realtime_session(&mut old, &initial).await;
                send_realtime_json(
                    &mut old,
                    json!({
                        "type":"response.function_call_arguments.done",
                        "call_id":"handoff-1",
                        "name":"handoff",
                        "arguments":"{\"message\":\"please inspect the repository\"}"
                    }),
                )
                .await;
                send_realtime_json(
                    &mut old,
                    json!({
                        "type":"error",
                        "error":{"code":"session_expired","message":"provider session expired"}
                    }),
                )
                .await;
                assert!(
                    tokio::time::timeout(Duration::from_millis(300), listener.accept())
                        .await
                        .is_err()
                );
            });
    });
    let endpoint = endpoint_rx.recv().unwrap();
    let session = ExpertSpokespersonTestSession::start(endpoint);
    let handoff = session.recv(Duration::from_secs(2));
    assert_eq!(handoff["type"], "user_final");
    assert_eq!(handoff["origin"], "handoff");
    let fatal = session.recv(Duration::from_secs(2));
    assert_eq!(fatal["type"], "fatal");
    assert_eq!(
        fatal["message"],
        "Spokesperson session expired before it could renew"
    );
    assert!(session.wait().is_empty());
    server.join().unwrap();
}

#[test]
fn expiry_recovery_pcm_overflow_is_terminal_instead_of_losing_held_input() {
    let (endpoint_tx, endpoint_rx) = mpsc::sync_channel(1);
    let (candidate_seen_tx, candidate_seen_rx) = mpsc::sync_channel(1);
    let server = std::thread::spawn(move || {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async move {
                let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
                endpoint_tx
                    .send(format!("ws://{}/", listener.local_addr().unwrap()))
                    .unwrap();
                let (old_stream, _) = listener.accept().await.unwrap();
                let mut old = accept_async(old_stream).await.unwrap();
                let initial = receive_realtime_json(&mut old).await;
                acknowledge_realtime_session(&mut old, &initial).await;
                send_realtime_json(
                    &mut old,
                    json!({
                        "type":"error",
                        "error":{"code":"session_expired","message":"provider session expired"}
                    }),
                )
                .await;
                let (candidate_stream, _) = listener.accept().await.unwrap();
                let mut candidate = accept_async(candidate_stream).await.unwrap();
                let _ = receive_realtime_json(&mut candidate).await;
                candidate_seen_tx.send(()).unwrap();
                let _ = candidate.next().await;
            });
    });
    let endpoint = endpoint_rx.recv().unwrap();
    let mut session = ExpertSpokespersonTestSession::start(endpoint);
    candidate_seen_rx
        .recv_timeout(Duration::from_secs(2))
        .unwrap();
    for _ in 0..33 {
        session.send_pcm(0.25);
    }
    session.flush();
    let fatal = session.recv(Duration::from_secs(2));
    assert_eq!(fatal["type"], "fatal");
    assert_eq!(fatal["message"], "Spokesperson session renewal failed");
    session.wait();
    server.join().unwrap();
}

#[test]
fn expert_spokesperson_voice_change_swaps_atomically_and_flushes_gated_pcm_once() {
    let (endpoint_tx, endpoint_rx) = mpsc::sync_channel(1);
    let (clear_seen_tx, clear_seen_rx) = mpsc::sync_channel(1);
    let (release_clear_tx, release_clear_rx) = mpsc::sync_channel(1);
    let server = std::thread::spawn(move || {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async move {
                let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
                endpoint_tx
                    .send(format!("ws://{}/", listener.local_addr().unwrap()))
                    .unwrap();

                let (old_stream, _) = listener.accept().await.unwrap();
                let mut old = accept_async(old_stream).await.unwrap();
                let initial = receive_realtime_json(&mut old).await;
                assert_eq!(initial["type"], "session.update");
                assert_eq!(initial["session"]["audio"]["output"]["voice"], "old-voice");
                acknowledge_realtime_session(&mut old, &initial).await;

                let (candidate_stream, _) = listener.accept().await.unwrap();
                let mut candidate = accept_async(candidate_stream).await.unwrap();
                let replacement = receive_realtime_json(&mut candidate).await;
                assert_eq!(replacement["type"], "session.update");
                assert_eq!(
                    replacement["session"]["audio"]["output"]["voice"],
                    "new-voice"
                );
                assert_eq!(replacement["session"]["audio"]["output"]["speed"], 1.25);
                acknowledge_realtime_session(&mut candidate, &replacement).await;

                loop {
                    let request = receive_realtime_json(&mut old).await;
                    if request["type"] == "input_audio_buffer.clear" {
                        assert!(request["event_id"]
                            .as_str()
                            .unwrap()
                            .starts_with("berd-cutover-"));
                        break;
                    }
                }
                clear_seen_tx.send(()).unwrap();
                tokio::task::spawn_blocking(move || release_clear_rx.recv().unwrap())
                    .await
                    .unwrap();
                send_realtime_json(&mut old, json!({"type":"input_audio_buffer.cleared"})).await;

                let gated_pcm = receive_realtime_json(&mut candidate).await;
                assert_eq!(gated_pcm["type"], "input_audio_buffer.append");
                assert!(!gated_pcm["audio"].as_str().unwrap().is_empty());
                if let Ok(Some(Ok(Message::Text(text)))) =
                    tokio::time::timeout(Duration::from_millis(100), candidate.next()).await
                {
                    let message: Value = serde_json::from_str(&text).unwrap();
                    assert_ne!(message["type"], "input_audio_buffer.append");
                }
            });
    });
    let endpoint = endpoint_rx.recv().unwrap();

    let mut session = ExpertSpokespersonTestSession::start(endpoint);
    session.send(json!({
            "type":"set_tts_settings",
            "id":2,
            "expected_revision":1,
            "settings":{"backend":"openai","model":"test-model","voice":"new-voice","rate":1.25}
    }));
    clear_seen_rx.recv_timeout(Duration::from_secs(2)).unwrap();
    session.send_pcm(0.125);
    session.flush();
    session.send(json!({
        "type":"set_tts_settings",
        "id":3,
        "expected_revision":1,
        "settings":{"backend":"openai","model":"test-model","voice":"third-voice","rate":1.0}
    }));
    let concurrent = session.recv(Duration::from_secs(2));
    assert_eq!(concurrent["type"], "tts_settings_result");
    assert_eq!(concurrent["id"], 3);
    assert_eq!(concurrent["outcome"], "rejected");
    assert_eq!(concurrent["snapshot"]["revision"], 1);
    assert_eq!(concurrent["snapshot"]["voice"], "old-voice");
    release_clear_tx.send(()).unwrap();

    let applied = session.recv(Duration::from_secs(2));
    assert_eq!(applied["type"], "tts_settings_result");
    assert_eq!(applied["id"], 2);
    assert_eq!(applied["outcome"], "applied");
    assert_eq!(applied["snapshot"]["revision"], 2);
    assert_eq!(applied["snapshot"]["voice"], "new-voice");
    assert_eq!(applied["snapshot"]["rate"], 1.25);

    session.shutdown();
    server.join().unwrap();
}

#[test]
fn user_activity_during_voice_cutover_rolls_back_and_flushes_gated_pcm_once() {
    let (endpoint_tx, endpoint_rx) = mpsc::sync_channel(1);
    let (clear_seen_tx, clear_seen_rx) = mpsc::sync_channel(1);
    let (release_activity_tx, release_activity_rx) = mpsc::sync_channel(1);
    let (rollback_seen_tx, rollback_seen_rx) = mpsc::sync_channel(1);
    let server = std::thread::spawn(move || {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async move {
                let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
                endpoint_tx
                    .send(format!("ws://{}/", listener.local_addr().unwrap()))
                    .unwrap();

                let (old_stream, _) = listener.accept().await.unwrap();
                let mut old = accept_async(old_stream).await.unwrap();
                let old_update = receive_realtime_json(&mut old).await;
                assert_eq!(old_update["type"], "session.update");
                acknowledge_realtime_session(&mut old, &old_update).await;

                let (candidate_stream, _) = listener.accept().await.unwrap();
                let mut candidate = accept_async(candidate_stream).await.unwrap();
                let candidate_update = receive_realtime_json(&mut candidate).await;
                assert_eq!(candidate_update["type"], "session.update");
                acknowledge_realtime_session(&mut candidate, &candidate_update).await;

                let clear = receive_realtime_json(&mut old).await;
                assert_eq!(clear["type"], "input_audio_buffer.clear");
                clear_seen_tx.send(()).unwrap();
                tokio::task::spawn_blocking(move || release_activity_rx.recv().unwrap())
                    .await
                    .unwrap();

                send_realtime_json(
                    &mut old,
                    json!({"type":"input_audio_buffer.speech_started","item_id":"user-cutover"}),
                )
                .await;
                send_realtime_json(
                    &mut old,
                    json!({"type":"input_audio_buffer.speech_stopped","item_id":"user-cutover"}),
                )
                .await;
                send_realtime_json(
                    &mut old,
                    json!({
                        "type":"input_audio_buffer.committed",
                        "item_id":"user-cutover"
                    }),
                )
                .await;
                send_realtime_json(&mut old, json!({"type":"input_audio_buffer.cleared"})).await;
                send_realtime_json(
                    &mut old,
                    json!({
                        "type":"conversation.item.input_audio_transcription.completed",
                        "item_id":"user-cutover",
                        "transcript":"keep the old voice"
                    }),
                )
                .await;

                let append =
                    tokio::time::timeout(Duration::from_secs(2), receive_realtime_json(&mut old))
                        .await
                        .expect("held PCM should return to the authoritative runtime");
                assert_eq!(append["type"], "input_audio_buffer.append");
                let response =
                    tokio::time::timeout(Duration::from_secs(2), receive_realtime_json(&mut old))
                        .await
                        .expect("settled user input should receive a response after rollback");
                assert_eq!(response["type"], "response.create");
                assert!(tokio::time::timeout(Duration::from_millis(100), old.next())
                    .await
                    .is_err());
                rollback_seen_tx.send(()).unwrap();
                let _ = candidate.next().await;
            });
    });
    let endpoint = endpoint_rx.recv().unwrap();

    let mut session = ExpertSpokespersonTestSession::start(endpoint);
    session.send(json!({
            "type":"set_tts_settings",
            "id":2,
            "expected_revision":1,
            "settings":{"backend":"openai","model":"test-model","voice":"new-voice","rate":1.0}
    }));
    clear_seen_rx.recv_timeout(Duration::from_secs(2)).unwrap();
    session.send_pcm(0.25);
    session.flush();
    release_activity_tx.send(()).unwrap();

    let deadline = std::time::Instant::now() + Duration::from_secs(3);
    let mut saw_user = false;
    let mut saw_rejection = false;
    while !(saw_user && saw_rejection) {
        let remaining = deadline
            .checked_duration_since(std::time::Instant::now())
            .expect("rollback did not publish user input and settings rejection promptly");
        let message = session.recv(remaining);
        saw_user |= message["type"] == "user_final";
        if message["type"] == "tts_settings_result" {
            assert_eq!(message["outcome"], "rejected");
            assert_eq!(message["snapshot"]["revision"], 1);
            assert_eq!(message["snapshot"]["voice"], "old-voice");
            saw_rejection = true;
        }
    }
    rollback_seen_rx
        .recv_timeout(Duration::from_secs(2))
        .unwrap();
    session.shutdown();
    server.join().unwrap();
}

#[test]
fn expert_spokesperson_voice_candidate_mismatch_preserves_old_snapshot() {
    let (endpoint_tx, endpoint_rx) = mpsc::sync_channel(1);
    let server = std::thread::spawn(move || {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async move {
                let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
                endpoint_tx
                    .send(format!("ws://{}/", listener.local_addr().unwrap()))
                    .unwrap();
                let (old_stream, _) = listener.accept().await.unwrap();
                let mut old = accept_async(old_stream).await.unwrap();
                let old_update = receive_realtime_json(&mut old).await;
                assert_eq!(old_update["type"], "session.update");
                acknowledge_realtime_session(&mut old, &old_update).await;

                let (candidate_stream, _) = listener.accept().await.unwrap();
                let mut candidate = accept_async(candidate_stream).await.unwrap();
                let update = receive_realtime_json(&mut candidate).await;
                assert_eq!(update["session"]["audio"]["output"]["voice"], "bad-voice");
                send_realtime_json(
                    &mut candidate,
                    json!({
                        "type":"session.updated",
                        "session": {
                            "model":"test-model",
                            "audio":{"output":{"voice":"old-voice","speed":1.0}}
                        }
                    }),
                )
                .await;
                let _ = candidate.next().await;
                let _ = old.next().await;
            });
    });
    let endpoint = endpoint_rx.recv().unwrap();
    let mut session = ExpertSpokespersonTestSession::start(endpoint);
    session.send(json!({
            "type":"set_tts_settings",
            "id":2,
            "expected_revision":1,
            "settings":{"backend":"openai","model":"test-model","voice":"bad-voice","rate":1.0}
    }));
    let rejected = session.recv(Duration::from_secs(2));
    assert_eq!(rejected["type"], "tts_settings_result");
    assert_eq!(rejected["outcome"], "rejected");
    assert_eq!(rejected["snapshot"]["revision"], 1);
    assert_eq!(rejected["snapshot"]["voice"], "old-voice");
    assert!(rejected["message"]
        .as_str()
        .unwrap()
        .contains("did not apply"));
    session.shutdown();
    server.join().unwrap();
}

#[test]
fn candidate_close_during_voice_cutover_rejects_without_activating_it() {
    let (endpoint_tx, endpoint_rx) = mpsc::sync_channel(1);
    let server = std::thread::spawn(move || {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async move {
                let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
                endpoint_tx
                    .send(format!("ws://{}/", listener.local_addr().unwrap()))
                    .unwrap();
                let (old_stream, _) = listener.accept().await.unwrap();
                let mut old = accept_async(old_stream).await.unwrap();
                let old_update = receive_realtime_json(&mut old).await;
                acknowledge_realtime_session(&mut old, &old_update).await;

                let (candidate_stream, _) = listener.accept().await.unwrap();
                let mut candidate = accept_async(candidate_stream).await.unwrap();
                let candidate_update = receive_realtime_json(&mut candidate).await;
                acknowledge_realtime_session(&mut candidate, &candidate_update).await;
                assert_eq!(
                    receive_realtime_json(&mut old).await["type"],
                    "input_audio_buffer.clear"
                );
                candidate.close(None).await.unwrap();
                tokio::time::sleep(Duration::from_millis(50)).await;
                send_realtime_json(&mut old, json!({"type":"input_audio_buffer.cleared"})).await;
                let _ = old.next().await;
            });
    });
    let endpoint = endpoint_rx.recv().unwrap();
    let mut session = ExpertSpokespersonTestSession::start(endpoint);
    session.send(json!({
            "type":"set_tts_settings",
            "id":2,
            "expected_revision":1,
            "settings":{"backend":"openai","model":"test-model","voice":"new-voice","rate":1.0}
    }));
    let result = session.recv(Duration::from_secs(2));
    assert_eq!(result["type"], "tts_settings_result");
    assert_eq!(result["outcome"], "rejected");
    assert_eq!(result["snapshot"]["revision"], 1);
    assert_eq!(result["snapshot"]["voice"], "old-voice");
    session.shutdown();
    server.join().unwrap();
}

#[test]
fn voice_cutover_pcm_overflow_rolls_back_every_frame_to_the_old_runtime() {
    let (endpoint_tx, endpoint_rx) = mpsc::sync_channel(1);
    let (clear_seen_tx, clear_seen_rx) = mpsc::sync_channel(1);
    let (frames_sent_tx, frames_sent_rx) = mpsc::sync_channel(1);
    let (frames_seen_tx, frames_seen_rx) = mpsc::sync_channel(1);
    let server = std::thread::spawn(move || {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async move {
                let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
                endpoint_tx
                    .send(format!("ws://{}/", listener.local_addr().unwrap()))
                    .unwrap();
                let (old_stream, _) = listener.accept().await.unwrap();
                let mut old = accept_async(old_stream).await.unwrap();
                let old_update = receive_realtime_json(&mut old).await;
                acknowledge_realtime_session(&mut old, &old_update).await;
                let (candidate_stream, _) = listener.accept().await.unwrap();
                let mut candidate = accept_async(candidate_stream).await.unwrap();
                let candidate_update = receive_realtime_json(&mut candidate).await;
                acknowledge_realtime_session(&mut candidate, &candidate_update).await;
                assert_eq!(
                    receive_realtime_json(&mut old).await["type"],
                    "input_audio_buffer.clear"
                );
                clear_seen_tx.send(()).unwrap();
                tokio::task::spawn_blocking(move || frames_sent_rx.recv().unwrap())
                    .await
                    .unwrap();
                send_realtime_json(&mut old, json!({"type":"input_audio_buffer.cleared"})).await;
                for _ in 0..33 {
                    let append = tokio::time::timeout(
                        Duration::from_secs(2),
                        receive_realtime_json(&mut old),
                    )
                    .await
                    .expect("every frame should return to the old runtime");
                    assert_eq!(append["type"], "input_audio_buffer.append");
                }
                frames_seen_tx.send(()).unwrap();
                let _ = candidate.next().await;
            });
    });
    let endpoint = endpoint_rx.recv().unwrap();
    let mut session = ExpertSpokespersonTestSession::start(endpoint);
    session.send(json!({
            "type":"set_tts_settings","id":2,"expected_revision":1,
            "settings":{"backend":"openai","model":"test-model","voice":"new-voice","rate":1.0}
    }));
    clear_seen_rx.recv_timeout(Duration::from_secs(2)).unwrap();
    for index in 0..33 {
        session.send_pcm(index as f32 / 100.0);
    }
    session.flush();
    frames_sent_tx.send(()).unwrap();
    let rejected = session.recv(Duration::from_secs(3));
    assert_eq!(rejected["type"], "tts_settings_result");
    assert_eq!(rejected["outcome"], "rejected");
    assert_eq!(rejected["snapshot"]["voice"], "old-voice");
    frames_seen_rx.recv_timeout(Duration::from_secs(2)).unwrap();
    session.shutdown();
    server.join().unwrap();
}

#[test]
fn reset_input_during_voice_cutover_rolls_back_then_clears_the_old_runtime() {
    let (endpoint_tx, endpoint_rx) = mpsc::sync_channel(1);
    let (cutover_seen_tx, cutover_seen_rx) = mpsc::sync_channel(1);
    let (reset_seen_tx, reset_seen_rx) = mpsc::sync_channel(1);
    let server = std::thread::spawn(move || {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async move {
                let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
                endpoint_tx
                    .send(format!("ws://{}/", listener.local_addr().unwrap()))
                    .unwrap();
                let (old_stream, _) = listener.accept().await.unwrap();
                let mut old = accept_async(old_stream).await.unwrap();
                let old_update = receive_realtime_json(&mut old).await;
                acknowledge_realtime_session(&mut old, &old_update).await;
                let (candidate_stream, _) = listener.accept().await.unwrap();
                let mut candidate = accept_async(candidate_stream).await.unwrap();
                let candidate_update = receive_realtime_json(&mut candidate).await;
                acknowledge_realtime_session(&mut candidate, &candidate_update).await;
                let cutover_clear = receive_realtime_json(&mut old).await;
                assert_eq!(cutover_clear["type"], "input_audio_buffer.clear");
                cutover_seen_tx.send(()).unwrap();
                tokio::task::spawn_blocking(move || reset_seen_rx.recv().unwrap())
                    .await
                    .unwrap();
                send_realtime_json(&mut old, json!({"type":"input_audio_buffer.cleared"})).await;
                let reset_clear =
                    tokio::time::timeout(Duration::from_secs(2), receive_realtime_json(&mut old))
                        .await
                        .expect("ordered reset should run after the voice cutover abort");
                assert_eq!(reset_clear["type"], "input_audio_buffer.clear");
                assert_ne!(reset_clear["event_id"], cutover_clear["event_id"]);
                send_realtime_json(&mut old, json!({"type":"input_audio_buffer.cleared"})).await;
                let _ = candidate.next().await;
                let _ = old.next().await;
            });
    });
    let endpoint = endpoint_rx.recv().unwrap();
    let mut session = ExpertSpokespersonTestSession::start(endpoint);
    session.send(json!({
            "type":"set_tts_settings","id":2,"expected_revision":1,
            "settings":{"backend":"openai","model":"test-model","voice":"new-voice","rate":1.0}
    }));
    cutover_seen_rx
        .recv_timeout(Duration::from_secs(2))
        .unwrap();
    session.send(json!({"type":"reset_input","id":3}));
    reset_seen_tx.send(()).unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(3);
    let mut saw_rejection = false;
    let mut saw_reset = false;
    while !(saw_rejection && saw_reset) {
        let remaining = deadline
            .checked_duration_since(std::time::Instant::now())
            .expect("voice rollback and input reset did not both complete");
        let message = session.recv(remaining);
        saw_rejection |= message["type"] == "tts_settings_result"
            && message["outcome"] == "rejected"
            && message["snapshot"]["voice"] == "old-voice";
        saw_reset |= message == json!({"type":"input_reset_applied","id":3});
    }
    session.shutdown();
    server.join().unwrap();
}

#[test]
fn unresolved_handoff_rejects_voice_change_without_starting_a_candidate() {
    let (endpoint_tx, endpoint_rx) = mpsc::sync_channel(1);
    let (emit_handoff_tx, emit_handoff_rx) = mpsc::sync_channel(1);
    let server = std::thread::spawn(move || {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async move {
                let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
                endpoint_tx
                    .send(format!("ws://{}/", listener.local_addr().unwrap()))
                    .unwrap();
                let (old_stream, _) = listener.accept().await.unwrap();
                let mut old = accept_async(old_stream).await.unwrap();
                let old_update = receive_realtime_json(&mut old).await;
                assert_eq!(old_update["type"], "session.update");
                acknowledge_realtime_session(&mut old, &old_update).await;
                tokio::task::spawn_blocking(move || emit_handoff_rx.recv().unwrap())
                    .await
                    .unwrap();
                send_realtime_json(
                    &mut old,
                    json!({"type":"response.created","response":{"id":"response-handoff"}}),
                )
                .await;
                send_realtime_json(
                    &mut old,
                    json!({"type":"response.output_item.added","item":{"call_id":"call-1","name":"handoff"}}),
                )
                .await;
                send_realtime_json(
                    &mut old,
                    json!({
                        "type":"response.function_call_arguments.done",
                        "call_id":"call-1",
                        "arguments":"{\"message\":\"inspect the computer\"}"
                    }),
                )
                .await;
                send_realtime_json(
                    &mut old,
                    json!({"type":"response.done","response":{"id":"response-handoff","status":"completed"}}),
                )
                .await;
                assert!(tokio::time::timeout(Duration::from_millis(250), listener.accept())
                    .await
                    .is_err());
                let _ = old.next().await;
            });
    });
    let endpoint = endpoint_rx.recv().unwrap();
    let mut session = ExpertSpokespersonTestSession::start(endpoint);
    emit_handoff_tx.send(()).unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(2);
    loop {
        let remaining = deadline
            .checked_duration_since(std::time::Instant::now())
            .expect("handoff was not published promptly");
        let message = session.recv(remaining);
        if message["type"] == "user_final" {
            assert_eq!(message["origin"], "handoff");
            break;
        }
    }
    session.send(json!({
            "type":"set_tts_settings",
            "id":2,
            "expected_revision":1,
            "settings":{"backend":"openai","model":"test-model","voice":"new-voice","rate":1.0}
    }));
    let rejected = session.recv(Duration::from_secs(2));
    assert_eq!(rejected["type"], "tts_settings_result");
    assert_eq!(rejected["outcome"], "rejected");
    assert_eq!(rejected["snapshot"]["voice"], "old-voice");
    assert!(rejected["message"]
        .as_str()
        .unwrap()
        .contains("between turns"));
    session.shutdown();
    server.join().unwrap();
}

#[test]
fn voice_cutover_timeout_is_terminal_and_never_reports_a_settings_result() {
    let (endpoint_tx, endpoint_rx) = mpsc::sync_channel(1);
    let server = std::thread::spawn(move || {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async move {
                let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
                endpoint_tx
                    .send(format!("ws://{}/", listener.local_addr().unwrap()))
                    .unwrap();
                let (old_stream, _) = listener.accept().await.unwrap();
                let mut old = accept_async(old_stream).await.unwrap();
                let old_update = receive_realtime_json(&mut old).await;
                assert_eq!(old_update["type"], "session.update");
                acknowledge_realtime_session(&mut old, &old_update).await;
                let (candidate_stream, _) = listener.accept().await.unwrap();
                let mut candidate = accept_async(candidate_stream).await.unwrap();
                let candidate_update = receive_realtime_json(&mut candidate).await;
                assert_eq!(candidate_update["type"], "session.update");
                acknowledge_realtime_session(&mut candidate, &candidate_update).await;
                assert_eq!(
                    receive_realtime_json(&mut old).await["type"],
                    "input_audio_buffer.clear"
                );
                let _ = old.next().await;
                let _ = candidate.next().await;
            });
    });
    let endpoint = endpoint_rx.recv().unwrap();
    let mut session = ExpertSpokespersonTestSession::start(endpoint);
    session.send(json!({
            "type":"set_tts_settings",
            "id":2,
            "expected_revision":1,
            "settings":{"backend":"openai","model":"test-model","voice":"new-voice","rate":1.0}
    }));
    let fatal = session.recv(Duration::from_secs(6));
    assert_eq!(fatal["type"], "fatal");
    assert_eq!(fatal["message"], "Spokesperson failed");
    assert!(session
        .wait()
        .iter()
        .all(|message| message["type"] != "tts_settings_result"));
    server.join().unwrap();
}

#[test]
fn user_final_promptly_aborts_a_stalled_voice_candidate_and_replies_on_old_runtime() {
    let (endpoint_tx, endpoint_rx) = mpsc::sync_channel(1);
    let (candidate_seen_tx, candidate_seen_rx) = mpsc::sync_channel(1);
    let server = std::thread::spawn(move || {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async move {
                let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
                endpoint_tx
                    .send(format!("ws://{}/", listener.local_addr().unwrap()))
                    .unwrap();
                let (old_stream, _) = listener.accept().await.unwrap();
                let mut old = accept_async(old_stream).await.unwrap();
                let old_update = receive_realtime_json(&mut old).await;
                assert_eq!(old_update["type"], "session.update");
                acknowledge_realtime_session(&mut old, &old_update).await;
                let (mut stalled_candidate, _) = listener.accept().await.unwrap();
                candidate_seen_tx.send(()).unwrap();
                send_realtime_json(
                    &mut old,
                    json!({"type":"input_audio_buffer.speech_started","item_id":"user-1"}),
                )
                .await;
                send_realtime_json(
                    &mut old,
                    json!({"type":"input_audio_buffer.speech_stopped","item_id":"user-1"}),
                )
                .await;
                send_realtime_json(
                    &mut old,
                    json!({
                        "type":"conversation.item.input_audio_transcription.completed",
                        "item_id":"user-1",
                        "transcript":"answer me now"
                    }),
                )
                .await;
                let response =
                    tokio::time::timeout(Duration::from_secs(2), receive_realtime_json(&mut old))
                        .await
                        .expect("old runtime should promptly receive replacement response request");
                assert_eq!(response["type"], "response.create");
                use tokio::io::AsyncReadExt;
                let mut pending_handshake = Vec::new();
                tokio::time::timeout(
                    Duration::from_secs(2),
                    stalled_candidate.read_to_end(&mut pending_handshake),
                )
                .await
                .expect("stalled candidate should be cancelled promptly")
                .unwrap();
                assert!(!pending_handshake.is_empty());
                let _ = old.next().await;
            });
    });
    let endpoint = endpoint_rx.recv().unwrap();
    let mut session = ExpertSpokespersonTestSession::start(endpoint);
    session.send(json!({
            "type":"set_tts_settings",
            "id":2,
            "expected_revision":1,
            "settings":{"backend":"openai","model":"test-model","voice":"new-voice","rate":1.0}
    }));
    candidate_seen_rx
        .recv_timeout(Duration::from_secs(2))
        .unwrap();
    let mut saw_user = false;
    let mut saw_rejection = false;
    let deadline = std::time::Instant::now() + Duration::from_secs(2);
    while !(saw_user && saw_rejection) {
        let remaining = deadline
            .checked_duration_since(std::time::Instant::now())
            .expect("session did not report user input and voice rejection promptly");
        let message = session.recv(remaining);
        saw_user |= message["type"] == "user_final";
        if message["type"] == "tts_settings_result" {
            assert_eq!(message["outcome"], "rejected");
            assert_eq!(message["snapshot"]["voice"], "old-voice");
            saw_rejection = true;
        }
    }
    session.shutdown();
    server.join().unwrap();
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
    assert_eq!(ready["protocol"], 2);
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
    audio_host.join().unwrap();
}
