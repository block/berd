use std::fs;
use std::net::TcpListener;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Output, Stdio};
use std::thread;
use std::time::Duration;

use serde_json::Value;
use tempfile::TempDir;

fn acceptance_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("docker/acceptance")
}

fn available_port() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind port");
    listener.local_addr().expect("read port").port()
}

fn running_as_root() -> bool {
    Command::new("id")
        .arg("-u")
        .output()
        .map(|output| output.stdout == b"0\n")
        .unwrap_or(false)
}

fn wait_for_server(port: u16) {
    for _ in 0..50 {
        if std::net::TcpStream::connect(("127.0.0.1", port)).is_ok() {
            return;
        }
        thread::sleep(Duration::from_millis(20));
    }
    panic!("mock marketplace did not start on port {port}");
}

fn start_marketplace(port: u16, args: &[&str]) -> Child {
    let mut command = Command::new("python3");
    command
        .arg(acceptance_root().join("mock-marketplace.py"))
        .arg("--port")
        .arg(port.to_string())
        .args(args)
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    let child = command.spawn().expect("start mock marketplace");
    wait_for_server(port);
    child
}

fn runner_command(temp: &TempDir) -> Command {
    let mut command = Command::new("sh");
    command
        .arg(acceptance_root().join("run-acceptance.sh"))
        .env("BB_ACCEPTANCE_BB_PATH", env!("CARGO_BIN_EXE_bb"))
        .env(
            "BB_ACCEPTANCE_MOCK_MARKETPLACE",
            acceptance_root().join("mock-marketplace.py"),
        )
        .env("BB_ACCEPTANCE_REPORT_PATH", temp.path().join("report.json"))
        .env_remove("BB_HOME")
        .env_remove("BB_SKILLS_HOME")
        .env_remove("BB_SKILLS_PACKAGES_DIR")
        .env_remove("BB_AUTH_STORAGE")
        .env_remove("BB_AUTH_STORAGE_FILE")
        .env_remove("KGOOSE_BASE_URL")
        .env_remove("KGOOSE_SERVICE_PATH")
        .env_remove("KGOOSE_PLAYPEN")
        .env_remove("BB_KGOOSE_PLAYPEN")
        .env_remove("BB_MARKETPLACE_BASE_URL")
        .env_remove("BB_SESSION_CREDENTIAL")
        .env_remove("BB_ACCEPTANCE_BUNDLE")
        .env_remove("BB_ACCEPTANCE_MOCK_START_ATTEMPTS");
    command
}

fn output_text(output: &Output) -> (String, String) {
    (
        String::from_utf8_lossy(&output.stdout).into_owned(),
        String::from_utf8_lossy(&output.stderr).into_owned(),
    )
}

fn assert_isolated_report(temp: &TempDir, mode: &str) {
    let report: Value = serde_json::from_slice(
        &fs::read(temp.path().join("report.json")).expect("read acceptance report"),
    )
    .expect("parse acceptance report");
    assert_eq!(report["mode"], mode);
    let home = report["home"].as_str().expect("report home");
    for key in [
        "bb_home",
        "skills_home",
        "packages_dir",
        "auth_storage_file",
    ] {
        assert!(
            report[key].as_str().expect("report path").starts_with(home),
            "{key} escapes the isolated home"
        );
    }
}

#[test]
fn runner_executes_mock_bundle_contract_in_an_isolated_home() {
    if running_as_root() {
        return;
    }
    let temp = tempfile::tempdir().expect("create temp dir");
    let port = available_port();
    let output = runner_command(&temp)
        .env("BB_ACCEPTANCE_MODE", "mock")
        .env("BB_ACCEPTANCE_MOCK_PORT", port.to_string())
        .output()
        .expect("run acceptance runner");
    let (stdout, stderr) = output_text(&output);

    assert!(
        output.status.success(),
        "stdout: {stdout}\nstderr: {stderr}"
    );
    assert!(stdout.contains("Docker mock acceptance passed."));
    assert_isolated_report(&temp, "mock");
}

#[test]
fn runner_succeeds_when_no_diagnostic_report_is_requested() {
    if running_as_root() {
        return;
    }
    let temp = tempfile::tempdir().expect("create temp dir");
    let port = available_port();
    let output = runner_command(&temp)
        .env_remove("BB_ACCEPTANCE_REPORT_PATH")
        .env("BB_ACCEPTANCE_MODE", "mock")
        .env("BB_ACCEPTANCE_MOCK_PORT", port.to_string())
        .output()
        .expect("run acceptance runner without a report");
    let (stdout, stderr) = output_text(&output);

    assert!(
        output.status.success(),
        "stdout: {stdout}\nstderr: {stderr}"
    );
    assert!(stdout.contains("Docker mock acceptance passed."));
    assert!(!temp.path().join("report.json").exists());
}

#[test]
fn runner_fails_when_the_mock_exits_before_becoming_ready() {
    if running_as_root() {
        return;
    }
    let temp = tempfile::tempdir().expect("create temp dir");
    let port = available_port();
    let output = runner_command(&temp)
        .env("BB_ACCEPTANCE_MODE", "mock")
        .env("BB_ACCEPTANCE_MOCK_PORT", port.to_string())
        .env("BB_ACCEPTANCE_MOCK_START_ATTEMPTS", "2")
        .env(
            "BB_ACCEPTANCE_MOCK_MARKETPLACE",
            acceptance_root().join("missing-mock-marketplace.py"),
        )
        .output()
        .expect("run acceptance runner with a missing mock");
    let (_, stderr) = output_text(&output);

    assert!(!output.status.success());
    assert!(
        stderr.contains("mock marketplace exited before becoming ready"),
        "stderr was: {stderr}"
    );
    assert!(!temp.path().join("report.json").exists());
}

#[test]
fn runner_live_mode_forwards_runtime_credential_and_playpen() {
    if running_as_root() {
        return;
    }
    let temp = tempfile::tempdir().expect("create temp dir");
    let port = available_port();
    let secret = "docker-acceptance-test-session";
    let mut server = start_marketplace(
        port,
        &[
            "--expect-session-credential",
            secret,
            "--expect-playpen",
            "test-playpen",
            "--expect-service-path",
            "/cash-app/goose",
        ],
    );
    let output = runner_command(&temp)
        .env("BB_ACCEPTANCE_MODE", "live")
        .env(
            "BB_MARKETPLACE_BASE_URL",
            format!("http://127.0.0.1:{port}"),
        )
        .env("BB_SESSION_CREDENTIAL", secret)
        .env("KGOOSE_PLAYPEN", "test-playpen")
        .output()
        .expect("run live acceptance runner");
    server.kill().expect("stop mock marketplace");
    server.wait().expect("wait for mock marketplace");
    let (stdout, stderr) = output_text(&output);

    assert!(
        output.status.success(),
        "stdout: {stdout}\nstderr: {stderr}"
    );
    assert!(!stdout.contains(secret));
    assert!(!stderr.contains(secret));
    assert_isolated_report(&temp, "live");
}

#[test]
fn runner_live_mode_reports_each_missing_runtime_input() {
    if running_as_root() {
        return;
    }
    let temp = tempfile::tempdir().expect("create temp dir");
    let output = runner_command(&temp)
        .env("BB_ACCEPTANCE_MODE", "live")
        .output()
        .expect("run live acceptance runner without inputs");
    let (_, stderr) = output_text(&output);
    assert!(!output.status.success());
    assert!(stderr.contains("BB_MARKETPLACE_BASE_URL"));

    let output = runner_command(&temp)
        .env("BB_ACCEPTANCE_MODE", "live")
        .env("BB_MARKETPLACE_BASE_URL", "http://127.0.0.1:1")
        .output()
        .expect("run live acceptance runner without credential");
    let (_, stderr) = output_text(&output);
    assert!(!output.status.success());
    assert!(stderr.contains("BB_SESSION_CREDENTIAL"));
}

#[cfg(unix)]
#[test]
fn just_recipe_builds_and_runs_the_acceptance_image() {
    let temp = tempfile::tempdir().expect("create temp dir");
    let bin_dir = temp.path().join("bin");
    fs::create_dir(&bin_dir).expect("create bin dir");
    let log = temp.path().join("docker.log");
    let docker = bin_dir.join("docker");
    fs::write(
        &docker,
        "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$BB_ACCEPTANCE_DOCKER_LOG\"\n",
    )
    .expect("write docker shim");
    fs::set_permissions(&docker, fs::Permissions::from_mode(0o755))
        .expect("make docker shim executable");
    let path = std::env::var("PATH").expect("read PATH");
    let output = Command::new("just")
        .arg("bb-cli-docker-acceptance")
        .current_dir(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .expect("repository root"),
        )
        .env("PATH", format!("{}:{path}", bin_dir.display()))
        .env("BB_ACCEPTANCE_DOCKER_LOG", &log)
        .output()
        .expect("run acceptance just recipe");
    let (stdout, stderr) = output_text(&output);

    assert!(
        output.status.success(),
        "stdout: {stdout}\nstderr: {stderr}"
    );
    assert_eq!(
        fs::read_to_string(log).expect("read docker command log"),
        "build --tag bb-cli-acceptance --file bb-cli/docker/acceptance/Dockerfile .\nrun --rm bb-cli-acceptance\n"
    );
}
