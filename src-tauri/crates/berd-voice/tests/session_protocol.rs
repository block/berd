use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
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

#[test]
fn framed_hello_reports_input_initialization_failure_before_ready() {
    let missing = std::env::temp_dir().join(format!(
        "berd-voice-missing-parakeet-{}",
        std::process::id()
    ));
    assert!(!missing.exists(), "test path must remain absent");
    let mut child = Command::new(env!("CARGO_BIN_EXE_berd-voice"))
        .args([
            "session",
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
    write_session_json(
        &mut stdin,
        &json!({"type":"hello","id":1,"output_device":null}),
    );
    drop(stdin);
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success());
    let messages: Vec<Value> = String::from_utf8(output.stdout)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0]["type"], "fatal");
    assert!(!messages[0]["message"].as_str().unwrap().is_empty());
}

#[test]
#[ignore = "requires an installed Siri voice and current-locale macOS SpeechTranscriber model"]
fn siri_session_reaches_ready_without_openai_credentials() {
    let voice = std::env::var("BERD_SIRI_TEST_VOICE").unwrap();
    let language = std::env::var("BERD_SIRI_TEST_LANGUAGE").unwrap_or_else(|_| "en-US".into());
    let mut child = Command::new(env!("CARGO_BIN_EXE_berd-voice"))
        .args([
            "session",
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
    write_session_json(
        &mut stdin,
        &json!({"type":"hello","id":1,"output_device":null}),
    );
    write_session_json(&mut stdin, &json!({"type":"shutdown"}));
    drop(stdin);
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success());
    let messages: Vec<Value> = String::from_utf8(output.stdout)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(messages, [json!({"type":"ready","id":1,"protocol":2})]);
}

#[test]
#[ignore = "requires a Pocket bundle and current-locale macOS SpeechTranscriber model"]
fn pocket_session_reaches_ready_without_openai_credentials() {
    let model_dir = std::env::var("BERD_POCKET_TEST_MODEL_DIR").unwrap();
    let voice = std::env::var("BERD_POCKET_TEST_VOICE").unwrap_or_else(|_| "george".into());
    let mut child = Command::new(env!("CARGO_BIN_EXE_berd-voice"))
        .args([
            "session",
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
        &json!({"type":"hello","id":1,"output_device":null}),
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
    assert_eq!(messages, [json!({"type":"ready","id":1,"protocol":2})]);
}

#[test]
#[ignore = "requires installed Siri voice and current-locale macOS SpeechTranscriber model"]
fn explicit_macos_stt_session_reaches_ready_without_audio() {
    let voice = std::env::var("BERD_SIRI_TEST_VOICE").unwrap();
    let language = std::env::var("BERD_SIRI_TEST_LANGUAGE").unwrap_or_else(|_| "en-US".into());
    let mut child = Command::new(env!("CARGO_BIN_EXE_berd-voice"))
        .args([
            "session",
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
        &json!({"type":"hello","id":1,"output_device":null}),
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
    assert_eq!(messages, [json!({"type":"ready","id":1,"protocol":2})]);
}

#[test]
#[ignore = "requires Siri voice, macOS SpeechTranscriber model, and virtual output"]
fn siri_multichannel_output_supports_consecutive_turns_and_cancellation() {
    let voice = std::env::var("BERD_SIRI_TEST_VOICE").unwrap();
    let language = std::env::var("BERD_SIRI_TEST_LANGUAGE").unwrap_or_else(|_| "en-US".into());
    let output_device = std::env::var("BERD_SIRI_TEST_OUTPUT_DEVICE").unwrap();
    let child = Command::new(env!("CARGO_BIN_EXE_berd-voice"))
        .args([
            "session",
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
    let mut child = ChildGuard(Some(child));
    let child_process = child.0.as_mut().unwrap();
    let mut stdin = child_process.stdin.take().unwrap();
    let stdout = child_process.stdout.take().unwrap();
    let (sender, receiver) = mpsc::channel();
    let reader = std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            if sender.send(line).is_err() {
                break;
            }
        }
    });
    let send = |stdin: &mut std::process::ChildStdin, message: Value| {
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

    send(
        &mut stdin,
        json!({"type":"hello","id":1,"output_device":output_device}),
    );
    assert_eq!(receive()["type"], "ready");

    send(
        &mut stdin,
        json!({
            "type":"prepare_speak",
            "id":2,
            "acknowledgement":null,
            "text":"First completed turn."
        }),
    );
    let first = receive();
    assert_eq!(first["type"], "admitted");
    let first_speech_id = first["speech_id"].as_u64().unwrap();
    send(
        &mut stdin,
        json!({"type":"output_ready","id":2,"speech_id":first_speech_id}),
    );
    assert_eq!(receive()["type"], "output_ready_result");
    assert_eq!(receive()["type"], "speech_started");
    assert_eq!(receive()["type"], "speech_completed");

    send(
        &mut stdin,
        json!({
            "type":"prepare_speak",
            "id":3,
            "acknowledgement":null,
            "text":"This deliberately long Siri phrase keeps queued output active until playback completes and the session must promptly return to idle."
        }),
    );
    let admitted = receive();
    assert_eq!(admitted["type"], "admitted");
    let speech_id = admitted["speech_id"].as_u64().unwrap();
    send(
        &mut stdin,
        json!({"type":"output_ready","id":3,"speech_id":speech_id}),
    );
    assert_eq!(receive()["type"], "output_ready_result");
    assert_eq!(receive()["type"], "speech_started");
    assert_eq!(receive()["type"], "speech_completed");

    send(
        &mut stdin,
        json!({
            "type":"prepare_speak",
            "id":4,
            "acknowledgement":null,
            "text":"This second deliberately long Siri phrase stays active until targeted cancellation interrupts playback and the session must promptly return to idle."
        }),
    );
    let interruptible = receive();
    assert_eq!(interruptible["type"], "admitted");
    let speech_id = interruptible["speech_id"].as_u64().unwrap();
    send(
        &mut stdin,
        json!({"type":"output_ready","id":4,"speech_id":speech_id}),
    );
    assert_eq!(receive()["type"], "output_ready_result");
    assert_eq!(receive()["type"], "speech_started");
    send(&mut stdin, json!({"type":"cancel","id":4}));
    assert_eq!(receive()["type"], "cancel_result");
    assert_eq!(receive()["type"], "speech_interrupted");

    send(
        &mut stdin,
        json!({"type":"prepare_speak","id":5,"acknowledgement":null,"text":"next"}),
    );
    let next = receive();
    assert_eq!(next["type"], "admitted");
    send(&mut stdin, json!({"type":"cancel","id":5}));
    assert_eq!(receive()["type"], "cancel_result");
    assert_eq!(receive()["type"], "speech_interrupted");
    send(&mut stdin, json!({"type":"shutdown"}));
    drop(stdin);
    let mut child_process = child.0.take().unwrap();
    assert!(child_process.wait().unwrap().success());
    reader.join().unwrap();
}
