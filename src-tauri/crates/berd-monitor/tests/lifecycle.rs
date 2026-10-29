#![cfg(unix)]
use berd_monitor::{get_running_monitors, request_stop, StatePaths};
use std::{
    process::{Child, Command, Stdio},
    thread,
    time::{Duration, Instant},
};

struct Monitor(Child);
impl Drop for Monitor {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
fn start(key: &str, session: &str) -> Monitor {
    Monitor(
        Command::new(env!("CARGO_BIN_EXE_berd-monitor"))
            .env("BERD_MONITOR_FOREGROUND", "1")
            .args([
                "run",
                "--state-key",
                key,
                "--label",
                key,
                "--session-id",
                session,
                "--",
                "sleep",
                "30",
            ])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap(),
    )
}
fn wait_for(count: usize) {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let monitors = get_running_monitors().unwrap();
        if monitors.len() == count {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "expected {count} live monitors, got {monitors:?}"
        );
        thread::sleep(Duration::from_millis(20));
    }
}
#[test]
fn real_monitors_are_inspectable_and_stop_only_the_selected_instance() {
    let state = tempfile::TempDir::new().unwrap();
    std::env::set_var("BERD_MONITOR_STATE_DIR", state.path());
    let before_launch = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;
    let mut first = start("CI checks", "session-a");
    let mut second = start("CI checks", "session-b");
    wait_for(2);
    let monitors = get_running_monitors().unwrap();
    let first_instance = monitors[0].instance_id.clone();
    assert_eq!(monitors[0].session_id, "session-a");
    assert_eq!(monitors[0].label, "CI checks");
    assert_eq!(monitors[0].command, Some(vec!["sleep".into(), "30".into()]));
    assert!(monitors[0].started_at.unwrap() >= before_launch);
    assert!(!first_instance.is_empty());
    assert_eq!(monitors[1].session_id, "session-b");
    assert_ne!(first_instance, monitors[1].instance_id);
    assert!(request_stop("CI checks", "missing-session", Some(&first_instance)).is_err());
    assert!(request_stop("CI checks", "session-b", Some(&first_instance)).is_err());
    assert!(request_stop("CI checks", "session-a", Some("wrong-token")).is_err());
    assert!(get_running_monitors()
        .unwrap()
        .iter()
        .all(|monitor| !monitor.stopping));
    assert!(first.0.try_wait().unwrap().is_none());
    assert!(second.0.try_wait().unwrap().is_none());

    // Freeze the watcher so the request remains observable before it is consumed.
    assert_eq!(unsafe { libc::kill(first.0.id() as i32, libc::SIGSTOP) }, 0);
    request_stop("CI checks", "session-a", Some(&first_instance)).unwrap();
    let monitors = get_running_monitors().unwrap();
    assert!(monitors[0].stopping);
    assert!(!monitors[1].stopping);
    assert_eq!(unsafe { libc::kill(first.0.id() as i32, libc::SIGCONT) }, 0);
    wait_for(1);
    assert!(first.0.wait().unwrap().success());
    assert!(second.0.try_wait().unwrap().is_none());

    let mut replacement = start("CI checks", "session-a");
    wait_for(2);
    let monitors = get_running_monitors().unwrap();
    let replacement_instance = monitors[0].instance_id.clone();
    assert_ne!(replacement_instance, first_instance);
    assert!(request_stop("CI checks", "session-a", Some(&first_instance)).is_err());
    // Even a delayed write for the old instance cannot stop its replacement.
    let paths = StatePaths::for_key("CI checks", "session-a");
    std::fs::write(paths.stop_for(&first_instance), b"stop\n").unwrap();
    thread::sleep(Duration::from_millis(200));
    assert!(replacement.0.try_wait().unwrap().is_none());
    assert!(!get_running_monitors().unwrap()[0].stopping);
    request_stop("CI checks", "session-a", Some(&replacement_instance)).unwrap();
    wait_for(1);
    assert!(replacement.0.wait().unwrap().success());

    // CLI stop uses the same lock-checked request path without an expected token.
    assert!(Command::new(env!("CARGO_BIN_EXE_berd-monitor"))
        .args([
            "stop",
            "--state-key",
            "CI checks",
            "--session-id",
            "session-b"
        ])
        .status()
        .unwrap()
        .success());
    wait_for(0);
    assert!(second.0.wait().unwrap().success());

    let crashed = start("Crash", "session-c");
    wait_for(1);
    drop(crashed);
    wait_for(0);
}
