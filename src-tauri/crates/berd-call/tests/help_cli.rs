use std::process::Command;

fn berd_call(args: &[&str]) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_berd-call"))
        .args(args)
        .output()
        .expect("run berd-call")
}

#[test]
fn global_help_is_successful_and_lists_only_implemented_commands() {
    for argument in ["-h", "--help", "help"] {
        let output = berd_call(&[argument]);
        assert!(output.status.success(), "{argument}");
        assert!(output.stderr.is_empty(), "{argument}");
        let stdout = String::from_utf8(output.stdout).expect("UTF-8 stdout");
        assert!(stdout.starts_with("Berd Call\n"), "{argument}");
        for command in ["session", "synthesize", "voices", "models", "benchmark"] {
            assert!(stdout.contains(command), "{argument}: {command}");
        }
        for unimplemented in ["start", "speak", "status", "stop"] {
            assert!(
                !stdout.contains(unimplemented),
                "{argument}: {unimplemented}"
            );
        }
    }
}

#[test]
fn command_help_is_available_in_prefix_and_suffix_forms() {
    for args in [
        vec!["help", "session"],
        vec!["session", "--help"],
        vec!["help", "benchmark", "tts"],
        vec!["benchmark", "tts", "--help"],
        vec!["models", "pocket", "status", "--help"],
    ] {
        let output = berd_call(&args);
        assert!(output.status.success(), "{args:?}");
        assert!(output.stderr.is_empty(), "{args:?}");
        let stdout = String::from_utf8(output.stdout).expect("UTF-8 stdout");
        assert!(stdout.contains("Usage:\n"), "{args:?}");
    }
}

#[test]
fn version_is_successful_and_machine_readable_as_one_line() {
    for argument in ["-V", "--version", "version"] {
        let output = berd_call(&[argument]);
        assert!(output.status.success(), "{argument}");
        assert!(output.stderr.is_empty(), "{argument}");
        assert_eq!(
            String::from_utf8(output.stdout).expect("UTF-8 stdout"),
            format!("berd-call {}\n", env!("CARGO_PKG_VERSION")),
            "{argument}"
        );
    }
}

#[test]
fn unknown_help_topics_remain_usage_errors() {
    for args in [vec!["help", "start"], vec!["help", "session", "bogus"]] {
        let output = berd_call(&args);
        assert_eq!(output.status.code(), Some(2), "{args:?}");
        assert!(output.stdout.is_empty(), "{args:?}");
        assert!(
            String::from_utf8(output.stderr)
                .expect("UTF-8 stderr")
                .contains("unknown help topic:"),
            "{args:?}"
        );
    }
}

#[test]
fn help_shaped_option_values_reach_the_operational_parser() {
    let output = berd_call(&["synthesize", "--text", "--help"]);
    assert_eq!(output.status.code(), Some(2));
    assert!(output.stdout.is_empty());
    let stderr = String::from_utf8(output.stderr).expect("UTF-8 stderr");
    assert!(stderr.contains("--tts-backend is required"));
    assert!(stderr.contains("Render text through a configured TTS backend"));
}

#[test]
fn suffix_help_after_a_complete_boolean_option_is_successful() {
    let output = berd_call(&["benchmark", "tts", "--allow-paid-openai", "--help"]);
    assert!(output.status.success());
    assert!(output.stderr.is_empty());
    assert!(String::from_utf8(output.stdout)
        .expect("UTF-8 stdout")
        .contains("Benchmark a TTS backend"));
}
