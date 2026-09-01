use std::fs::File;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::net::UnixStream;
use std::os::unix::process::CommandExt;
use std::process::{Child, Command, Stdio};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};

struct ChildGuard(Option<Child>);

impl Drop for ChildGuard {
    fn drop(&mut self) {
        if let Some(child) = self.0.as_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
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
    mut reader: UnixStream,
    stdin: Arc<Mutex<std::process::ChildStdin>>,
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
                    let mut writer = stdin.lock().unwrap();
                    write_session_json(
                        &mut *writer,
                        &json!({"type":"audio_chunk_accepted","speech_id":speech_id,"sequence":sequence}),
                    );
                    write_session_json(
                        &mut *writer,
                        &json!({"type":"audio_played","speech_id":speech_id,"played_frames":state.2}),
                    );
                    writer.flush().unwrap();
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
                        .map_or(0, |state| state.2);
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
