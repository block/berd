#![cfg(unix)]
use berd_monitor::get_running_monitors;
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
fn real_monitors_appear_and_clear_after_stop_or_crash() {
    let state = tempfile::TempDir::new().unwrap();
    std::env::set_var("BERD_MONITOR_STATE_DIR", state.path());
    let mut first = start("CI checks", "session-a");
    let second = start("Review feedback", "session-b");
    wait_for(2);
    let monitors = get_running_monitors().unwrap();
    assert_eq!(monitors[0].session_id, "session-a");
    assert_eq!(monitors[0].label, "CI checks");
    assert_eq!(monitors[1].session_id, "session-b");
    assert!(Command::new(env!("CARGO_BIN_EXE_berd-monitor"))
        .args([
            "stop",
            "--state-key",
            "CI checks",
            "--session-id",
            "session-a"
        ])
        .status()
        .unwrap()
        .success());
    wait_for(1);
    assert!(first.0.wait().unwrap().success());
    drop(second);
    wait_for(0);
}
