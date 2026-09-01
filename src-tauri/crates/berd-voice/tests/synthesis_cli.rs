use std::process::Command;

use serde_json::Value;

fn berd_voice(args: &[&str]) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_berd-voice"))
        .args(args)
        .env_remove("OPENAI_API_KEY")
        .env_remove("OPENAI_BASE_URL")
        .env_remove("OPENAI_TTS_MODEL")
        .env_remove("OPENAI_TTS_VOICE")
        .output()
        .expect("run berd-voice")
}

fn terminal(output: &std::process::Output) -> Value {
    let stdout = String::from_utf8(output.stdout.clone()).expect("UTF-8 stdout");
    let lines = stdout.lines().collect::<Vec<_>>();
    assert_eq!(lines.len(), 1, "{stdout:?}");
    serde_json::from_str(lines[0]).expect("JSON terminal")
}

#[test]
fn synthesis_usage_errors_are_exit_two_and_emit_no_json() {
    for args in [
        vec![
            "synthesize",
            "--tts-backend",
            "openai",
            "--model",
            "gpt-test",
            "--voice",
            "marin",
            "--text",
            "hello",
            "--output",
            "voice.wav",
        ],
        vec![
            "synthesize",
            "--tts-backend",
            "pocket",
            "--model-dir",
            "/models/pocket",
            "--voice",
            "mary",
            "--rate",
            "2",
            "--text",
            "hello",
            "--output",
            "voice.wav",
        ],
        vec![
            "synthesize",
            "--tts-backend",
            "siri",
            "--voice",
            "Aaron",
            "--language",
            "en-US",
            "--text",
            "hello",
            "--output",
            "-",
        ],
    ] {
        let output = berd_voice(&args);
        assert_eq!(output.status.code(), Some(2), "{args:?}");
        assert!(output.stdout.is_empty(), "{args:?}");
        assert!(String::from_utf8_lossy(&output.stderr).contains("usage:"));
    }
}

#[test]
fn existing_output_fails_before_openai_credentials_or_any_request() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let path = directory.path().join("owned.wav");
    std::fs::write(&path, b"owned").expect("write target");
    let output = berd_voice(&[
        "synthesize",
        "--tts-backend",
        "openai",
        "--model",
        "gpt-test",
        "--voice",
        "marin",
        "--allow-paid-openai",
        "--text",
        "private prompt",
        "--output",
        path.to_str().expect("UTF-8 path"),
    ]);
    assert_eq!(output.status.code(), Some(1));
    let value = terminal(&output);
    assert_eq!(value["schemaVersion"], 1);
    assert_eq!(value["operation"], "synthesize");
    assert_eq!(value["event"], "error");
    assert_eq!(value["error"]["code"], "output_unavailable");
    assert_eq!(std::fs::read(path).unwrap(), b"owned");
    assert!(!String::from_utf8_lossy(&output.stdout).contains("private prompt"));
}

#[test]
fn missing_openai_key_is_one_sanitized_terminal_and_leaves_no_artifact() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let path = directory.path().join("voice.wav");
    let output = berd_voice(&[
        "synthesize",
        "--tts-backend",
        "openai",
        "--model",
        "gpt-test",
        "--voice",
        "marin",
        "--allow-paid-openai",
        "--text",
        "private prompt",
        "--output",
        path.to_str().expect("UTF-8 path"),
    ]);
    assert_eq!(output.status.code(), Some(1));
    let value = terminal(&output);
    assert_eq!(value["error"]["code"], "backend_unavailable");
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(!stdout.contains("private prompt"));
    assert!(!stdout.contains(path.to_str().unwrap()));
    assert!(!path.exists());
    assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 0);
    assert!(String::from_utf8_lossy(&output.stderr).contains("OPENAI_API_KEY is required"));
}
