use std::process::Command;

use serde_json::Value;

fn berd_voice(args: &[&str]) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_berd-voice"))
        .args(args)
        .output()
        .expect("run berd-voice")
}

#[test]
fn management_usage_errors_are_exit_two_and_do_not_emit_json() {
    for args in [
        vec!["voices", "download", "--voice", "Aaron"],
        vec![
            "voices",
            "download",
            "--voice",
            "Aaron",
            "--language",
            "en-US",
            "--availability-wait-seconds",
            "0",
        ],
        vec!["models", "macos", "status", "extra"],
    ] {
        let output = berd_voice(&args);
        assert_eq!(output.status.code(), Some(2), "{args:?}");
        assert!(output.stdout.is_empty(), "{args:?}");
        assert!(
            String::from_utf8(output.stderr)
                .expect("UTF-8 stderr")
                .contains("usage:"),
            "{args:?}"
        );
    }
}

#[cfg(not(target_os = "macos"))]
#[test]
fn unsupported_platform_management_contract_is_process_stable() {
    for (args, exit, operation, event, supported_or_code) in [
        (vec!["voices", "list"], 0, "voices.list", "result", "false"),
        (
            vec!["models", "macos", "status"],
            0,
            "models.macos.status",
            "result",
            "false",
        ),
        (
            vec![
                "voices",
                "download",
                "--voice",
                "Aaron",
                "--language",
                "en-US",
            ],
            1,
            "voices.download",
            "error",
            "unsupported",
        ),
        (
            vec!["models", "macos", "install"],
            1,
            "models.macos.install",
            "error",
            "unsupported",
        ),
    ] {
        let output = berd_voice(&args);
        assert_eq!(output.status.code(), Some(exit), "{args:?}");
        let stdout = String::from_utf8(output.stdout).expect("UTF-8 stdout");
        let lines = stdout.lines().collect::<Vec<_>>();
        assert_eq!(lines.len(), 1, "{args:?}");
        let value: Value = serde_json::from_str(lines[0]).expect("JSON terminal");
        assert_eq!(value["schemaVersion"], 1);
        assert_eq!(value["operation"], operation);
        assert_eq!(value["event"], event);
        if event == "result" {
            assert_eq!(value["result"]["supported"], false);
            assert!(output.stderr.is_empty());
        } else {
            assert_eq!(value["error"]["code"], supported_or_code);
            assert!(!output.stderr.is_empty());
        }
    }
}

#[cfg(target_os = "macos")]
#[test]
#[ignore = "safe opt-in probe of the native Siri catalog; no download, synthesis, or playback"]
fn native_voice_list_emits_one_terminal_json_line() {
    let output = berd_voice(&["voices", "list", "--language", "en_US"]);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let lines = String::from_utf8(output.stdout).expect("UTF-8 stdout");
    let lines = lines.lines().collect::<Vec<_>>();
    assert_eq!(lines.len(), 1);
    let value: Value = serde_json::from_str(lines[0]).expect("JSON result");
    assert_eq!(value["schemaVersion"], 1);
    assert_eq!(value["operation"], "voices.list");
    assert_eq!(value["event"], "result");
    assert_eq!(value["result"]["supported"], true);
    assert!(output.stderr.is_empty());
    for voice in value["result"]["voices"].as_array().expect("voice array") {
        assert_eq!(voice["language"], "en-US");
    }
}

#[cfg(target_os = "macos")]
#[test]
#[ignore = "safe opt-in exact-catalog miss; proves failure before download mutation"]
fn native_missing_voice_emits_one_not_found_terminal() {
    let output = berd_voice(&[
        "voices",
        "download",
        "--voice",
        "__berd_voice_missing__",
        "--language",
        "en-US",
        "--availability-wait-seconds",
        "1",
    ]);
    assert_eq!(output.status.code(), Some(1));
    let lines = String::from_utf8(output.stdout).expect("UTF-8 stdout");
    let lines = lines.lines().collect::<Vec<_>>();
    assert_eq!(lines.len(), 1);
    let value: Value = serde_json::from_str(lines[0]).expect("JSON error");
    assert_eq!(value["schemaVersion"], 1);
    assert_eq!(value["operation"], "voices.download");
    assert_eq!(value["event"], "error");
    assert_eq!(value["error"]["code"], "voice_not_found");
    assert!(!output.stderr.is_empty());
}

#[cfg(target_os = "macos")]
#[test]
#[ignore = "safe opt-in probe of native SpeechTranscriber status; no installation or audio"]
fn native_macos_model_status_emits_one_terminal_json_line() {
    let output = berd_voice(&["models", "macos", "status"]);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let lines = String::from_utf8(output.stdout).expect("UTF-8 stdout");
    let lines = lines.lines().collect::<Vec<_>>();
    assert_eq!(lines.len(), 1);
    let value: Value = serde_json::from_str(lines[0]).expect("JSON result");
    assert_eq!(value["schemaVersion"], 1);
    assert_eq!(value["operation"], "models.macos.status");
    assert_eq!(value["event"], "result");
    assert!(value["result"]["supported"].is_boolean());
    assert!(value["result"]["ready"].is_boolean());
    assert!(output.stderr.is_empty());
}
