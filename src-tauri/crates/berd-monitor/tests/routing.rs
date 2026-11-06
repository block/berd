#![cfg(unix)]
use berd_monitor::{get_running_monitors, try_claim_owner, RunningMonitorDescriptor, StatePaths};
use std::{
    fs,
    path::Path,
    process::{Child, Command, Stdio},
    thread,
    time::{Duration, Instant},
};

// Library discovery runs in a separate process, never by changing the test runner's environment.
#[test]
#[ignore]
fn routing_probe() {
    if std::env::var_os("ROUTING_PROBE_LEGACY").is_some() {
        let key = std::env::var("ROUTING_KEY").unwrap();
        let session = std::env::var("ROUTING_SESSION").unwrap();
        let paths = StatePaths::for_key(&key, &session);
        fs::create_dir_all(&paths.root).unwrap();
        let owner = fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(&paths.owner)
            .unwrap();
        fs::write(&paths.owner, b"legacy-token\n").unwrap();
        try_claim_owner(&owner).unwrap();
        assert!(cli(Path::new(
            &std::env::var_os("BERD_MONITOR_STATE_DIR").unwrap()
        ))
        .args(["stop", "--state-key", &key, "--session-id", &session])
        .output()
        .unwrap()
        .status
        .success());
        assert!(paths.stop_for("legacy-token").exists());
    } else {
        fs::write(
            std::env::var_os("ROUTING_PROBE_OUTPUT").unwrap(),
            serde_json::to_vec(&get_running_monitors().unwrap()).unwrap(),
        )
        .unwrap();
    }
}
fn cli(state: &Path) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_berd-monitor"));
    command
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("BERD_MONITOR_STATE_DIR", state);
    command
}
fn probe(state: &Path) -> Command {
    let mut command = Command::new(std::env::current_exe().unwrap());
    command
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("BERD_MONITOR_STATE_DIR", state)
        .args(["--exact", "routing_probe", "--ignored"]);
    command
}
fn discover(state: &Path) -> Vec<RunningMonitorDescriptor> {
    let output = state.join("probe.json");
    assert!(probe(state)
        .env("ROUTING_PROBE_OUTPUT", &output)
        .output()
        .unwrap()
        .status
        .success());
    serde_json::from_slice(&fs::read(output).unwrap()).unwrap()
}
fn wait_until(mut condition: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !condition() {
        assert!(Instant::now() < deadline, "timed out waiting for monitor");
        thread::sleep(Duration::from_millis(20));
    }
}
fn run(state: &Path, key: &str, session: &str, foreground: bool) -> Command {
    let mut command = cli(state);
    if foreground {
        command.env("BERD_MONITOR_FOREGROUND", "1");
    }
    command.args([
        "run",
        "--state-key",
        key,
        "--session-id",
        session,
        "--label",
        "Routing",
        "--",
    ]);
    command
}
#[test]
fn cli_rejects_invalid_routing_before_any_owner_or_producer() {
    let mut failures = vec![];
    for foreground in [false, true] {
        for field in ["--state-key", "--session-id"] {
            for (case, value) in [
                ("empty", String::new()),
                ("whitespace", " \t\u{2003}".into()),
                ("lf", "a\nb".into()),
                ("cr", "a\rb".into()),
                ("oversized-ascii", "x".repeat(1025)),
                ("oversized-unicode", format!("{}x", "😀".repeat(256))),
            ] {
                let state = tempfile::tempdir().unwrap();
                let base = state.path().join("monitors");
                let marker = state.path().join("producer-started");
                let (key, session) = if field == "--state-key" {
                    (value.as_str(), "session")
                } else {
                    ("key", value.as_str())
                };
                let stderr_path = state.path().join("stderr");
                let mut child = run(&base, key, session, foreground)
                    .args([
                        "sh",
                        "-c",
                        "touch \"$1\"; exec sleep 30",
                        "_",
                        marker.to_str().unwrap(),
                    ])
                    .stdout(Stdio::null())
                    .stderr(fs::File::create(&stderr_path).unwrap())
                    .spawn()
                    .unwrap();
                let deadline = Instant::now() + Duration::from_secs(2);
                let status = loop {
                    if let Some(status) = child.try_wait().unwrap() {
                        break Some(status);
                    }
                    if Instant::now() >= deadline {
                        break None;
                    }
                    thread::sleep(Duration::from_millis(10));
                };
                let stderr = fs::read_to_string(stderr_path).unwrap();
                let clean = !marker.exists() && !base.exists();
                if status.is_none_or(|status| status.success()) || !stderr.contains(field) || !clean
                {
                    failures.push(format!("foreground={foreground} {field} {case}: status={status:?} no-owner-or-producer={clean} stderr={stderr:?}"));
                }
                if !clean {
                    let _ = cli(&base)
                        .args(["stop", "--state-key", key, "--session-id", session])
                        .output();
                }
                if status.is_none() {
                    let _ = child.wait();
                }
            }
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
struct ActiveMonitor {
    state: tempfile::TempDir,
    key: String,
    session: String,
    child: Option<Child>,
}
impl ActiveMonitor {
    fn start(key: String, session: String, foreground: bool, args: &[String]) -> Self {
        let state = tempfile::tempdir().unwrap();
        let mut child = run(state.path(), &key, &session, foreground)
            .args(args)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        if !foreground {
            assert!(child.wait().unwrap().success());
        }
        Self {
            state,
            key,
            session,
            child: foreground.then_some(child),
        }
    }
    fn stop(&mut self) {
        assert!(cli(self.state.path())
            .args([
                "stop",
                "--state-key",
                &self.key,
                "--session-id",
                &self.session
            ])
            .output()
            .unwrap()
            .status
            .success());
        wait_until(|| discover(self.state.path()).is_empty());
        if let Some(child) = &mut self.child {
            assert!(child.wait().unwrap().success());
        }
        self.child = None;
    }
}
impl Drop for ActiveMonitor {
    fn drop(&mut self) {
        let _ = cli(self.state.path())
            .args([
                "stop",
                "--state-key",
                &self.key,
                "--session-id",
                &self.session,
            ])
            .output();
        if let Some(child) = &mut self.child {
            let _ = child.wait();
        }
    }
}
#[test]
fn cli_accepts_byte_boundary_and_remains_discoverable_and_stoppable() {
    for foreground in [false, true] {
        for value in ["x".repeat(1024), "😀".repeat(256)] {
            for field in ["key", "session"] {
                let (key, session) = if field == "key" {
                    (value.clone(), "session".into())
                } else {
                    ("key".into(), value.clone())
                };
                let mut monitor = ActiveMonitor::start(
                    key.clone(),
                    session.clone(),
                    foreground,
                    &["sleep".into(), "30".into()],
                );
                wait_until(|| !discover(monitor.state.path()).is_empty());
                let found = discover(monitor.state.path());
                assert_eq!(
                    (&found[0].state_key, &found[0].session_id),
                    (&key, &session)
                );
                monitor.stop();
            }
        }
    }
}
#[test]
fn cli_stop_still_accepts_legacy_invalid_routing() {
    for invalid in [
        "",
        " \t",
        "a\nb",
        "a\rb",
        &"x".repeat(1025),
        &"😀".repeat(257),
    ] {
        for field in ["key", "session"] {
            let state = tempfile::tempdir().unwrap();
            let (key, session) = if field == "key" {
                (invalid, "session")
            } else {
                ("key", invalid)
            };
            let output = probe(state.path())
                .env("ROUTING_PROBE_LEGACY", "1")
                .env("ROUTING_KEY", key)
                .env("ROUTING_SESSION", session)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stdout)
            );
        }
    }
}
#[test]
fn oversized_optional_command_never_hides_or_changes_producer() {
    for foreground in [false, true] {
        for payload in [
            vec!["x".repeat(70_000)],
            vec!["x".into(); 65],
            vec!["x".repeat(4000); 5],
            vec!["\u{1}".repeat(4000); 4],
        ] {
            let output = tempfile::tempdir().unwrap();
            let marker = output.path().join("argv");
            let mut args = vec![
                "sh".into(),
                "-c".into(),
                "output=$1; shift; printf '%s' \"$@\" > \"$output\"; exec sleep 30".into(),
            ];
            // The output path is positional, not environment shared with another test.
            args.extend(["_".into(), marker.to_str().unwrap().into()]);
            args.extend(payload.clone());
            let mut monitor =
                ActiveMonitor::start("key".into(), "session".into(), foreground, &args);
            wait_until(|| {
                fs::read(&marker).is_ok_and(|bytes| bytes == payload.concat().as_bytes())
            });
            wait_until(|| !discover(monitor.state.path()).is_empty());
            assert_eq!(discover(monitor.state.path())[0].command, None);
            monitor.stop();
        }
    }
}
