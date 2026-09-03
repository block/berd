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
        vec!["models", "pocket", "status"],
        vec!["models", "parakeet", "install", "--store-root", "relative"],
        vec!["models", "pocket", "status", "--store-root", "/tmp/./store"],
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

#[test]
fn local_model_management_is_process_stable_without_network_or_root_creation() {
    let temporary = tempfile::tempdir().expect("temporary directory");
    let missing_store = temporary.path().join("missing-store");
    let missing_store_arg = missing_store.to_str().expect("UTF-8 path");

    for (engine, model_id) in [
        ("pocket", "native-voice-v2"),
        ("parakeet", "parakeet-tdt-ctc-110m-en-int8"),
    ] {
        let output = berd_voice(&[
            "models",
            engine,
            "status",
            "--store-root",
            missing_store_arg,
        ]);
        assert!(
            output.status.success(),
            "{engine}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let lines = String::from_utf8(output.stdout).expect("UTF-8 stdout");
        let lines = lines.lines().collect::<Vec<_>>();
        assert_eq!(lines.len(), 1, "{engine}");
        let value: Value = serde_json::from_str(lines[0]).expect("JSON result");
        assert_eq!(value["schemaVersion"], 1);
        assert_eq!(value["operation"], format!("models.{engine}.status"));
        assert_eq!(value["event"], "result");
        assert_eq!(value["result"]["modelId"], model_id);
        assert_eq!(value["result"]["state"], "missing");
        assert_eq!(value["result"]["ready"], false);
        assert!(value["result"]["verifiedBytes"].is_null());
        assert!(value["result"]["totalDownloadBytes"].as_u64().unwrap() > 0);
        assert!(output.stderr.is_empty());
        assert!(
            !missing_store.exists(),
            "status created {missing_store_arg}"
        );
    }

    let output = berd_voice(&["models", "pocket", "voices"]);
    assert!(output.status.success());
    let lines = String::from_utf8(output.stdout).expect("UTF-8 stdout");
    let lines = lines.lines().collect::<Vec<_>>();
    assert_eq!(lines.len(), 1);
    let value: Value = serde_json::from_str(lines[0]).expect("JSON result");
    assert_eq!(value["operation"], "models.pocket.voices");
    assert_eq!(value["result"]["voiceLicenseId"], "CC-BY-4.0");
    let voices = value["result"]["voices"].as_array().unwrap();
    assert_eq!(voices.len(), 12);
    assert!(voices.iter().all(|voice| {
        voice.as_object().is_some_and(|voice| {
            voice.len() == 2 && voice.contains_key("id") && voice.contains_key("name")
        })
    }));

    for (engine, relative_file) in [
        ("pocket", "native-voice-v2/bundle.json"),
        ("parakeet", "native-voice-v2/stt/model.int8.onnx"),
    ] {
        let invalid_store = temporary.path().join(format!("invalid-{engine}"));
        let invalid_file = invalid_store.join(relative_file);
        std::fs::create_dir_all(invalid_file.parent().unwrap()).expect("create invalid bundle");
        std::fs::write(invalid_file, b"invalid").expect("write invalid bundle");
        let output = berd_voice(&[
            "models",
            engine,
            "status",
            "--store-root",
            invalid_store.to_str().expect("UTF-8 path"),
        ]);
        assert!(output.status.success());
        let value: Value = serde_json::from_slice(&output.stdout).expect("JSON result");
        assert_eq!(value["result"]["state"], "invalid");
        assert_eq!(value["result"]["ready"], false);
        assert!(value["result"]["verifiedBytes"].is_null());
    }

    let blocked_store = temporary.path().join("blocked-store");
    std::fs::write(&blocked_store, b"not a directory").expect("write blocked store");
    for engine in ["pocket", "parakeet"] {
        let output = berd_voice(&[
            "models",
            engine,
            "install",
            "--store-root",
            blocked_store.to_str().expect("UTF-8 path"),
        ]);
        assert_eq!(output.status.code(), Some(1));
        let lines = String::from_utf8(output.stdout).expect("UTF-8 stdout");
        let lines = lines.lines().collect::<Vec<_>>();
        assert_eq!(lines.len(), 1, "{engine}");
        let value: Value = serde_json::from_str(lines[0]).expect("JSON error");
        assert_eq!(value["operation"], format!("models.{engine}.install"));
        assert_eq!(value["event"], "error");
        assert_eq!(value["error"]["code"], "io_failed");
        assert!(!output.stderr.is_empty());
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
