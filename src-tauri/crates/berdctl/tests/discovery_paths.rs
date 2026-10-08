//! Exercise discovery through the actual CLI in child working directories;
//! changing this test process's cwd would race the parallel unit tests.
#![cfg(unix)]

use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::process::{Command, Output};
use std::thread;

const CAPABILITY: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

struct Fixture(PathBuf);

impl Fixture {
    fn new(port: u16) -> Self {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "berdctl-discovery-integration-{}-{unique}",
            std::process::id()
        ));
        fs::create_dir(&dir).unwrap();
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)).unwrap();
        let file = dir.join("control.json");
        let protocol =
            serde_json::from_str::<serde_json::Value>(include_str!("../api-surface.json")).unwrap()
                ["protocolVersion"]
                .as_u64()
                .unwrap();
        fs::write(
            &file,
            serde_json::json!({
                "port": port, "pid": 4242, "generation": 7,
                "protocolVersion": protocol, "capability": CAPABILITY,
            })
            .to_string(),
        )
        .unwrap();
        fs::set_permissions(file, fs::Permissions::from_mode(0o600)).unwrap();
        Self(dir)
    }

    fn call(&self, path: &str, via_env: bool) -> Output {
        let mut cli = Command::new(env!("CARGO_BIN_EXE_berdctl"));
        cli.current_dir(&self.0).env_remove("BERDCTL_LOCK");
        if via_env {
            cli.env("BERDCTL_LOCK", path);
        } else {
            cli.args(["--lock-path", path]);
        }
        cli.args(["session", "list", "--json"]).output().unwrap()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).ok();
    }
}

#[test]
fn absolute_basename_and_dot_relative_paths_reach_the_same_broker() {
    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let fixture = Fixture::new(listener.local_addr().unwrap().port());
    let broker = thread::spawn(move || {
        for _ in 0..6 {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(std::time::Duration::from_secs(5)))
                .unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            assert!(line.starts_with("GET /v1/ping "));
            let mut authorized = false;
            loop {
                line.clear();
                assert_ne!(reader.read_line(&mut line).unwrap(), 0);
                if line == "\r\n" {
                    break;
                }
                if let Some((name, value)) = line.split_once(':') {
                    if name.eq_ignore_ascii_case("authorization") {
                        authorized = value.trim() == format!("Bearer {CAPABILITY}");
                    }
                }
            }
            assert!(authorized);
            // Stop at ping: this test checks discovery and authentication, not
            // command execution. A distinctive HTTP error proves we got here.
            write!(stream, "HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();
        }
    });
    let absolute = fixture.0.join("control.json");
    for path in [absolute.to_str().unwrap(), "control.json", "./control.json"] {
        for via_env in [false, true] {
            let output = fixture.call(path, via_env);
            let error = String::from_utf8(output.stderr).unwrap();
            assert!(
                error.contains("ping returned status 503"),
                "{path}: {error}"
            );
        }
    }
    broker.join().unwrap();
}

#[test]
fn relative_paths_still_reject_non_private_directories() {
    let fixture = Fixture::new(1);
    fs::set_permissions(&fixture.0, fs::Permissions::from_mode(0o755)).unwrap();
    for path in ["control.json", "./control.json"] {
        let output = fixture.call(path, false);
        let error = String::from_utf8(output.stderr).unwrap();
        assert!(error.contains("not an owner-private directory"), "{error}");
    }
}

#[cfg(target_os = "macos")]
#[test]
fn extended_acl_on_file_or_directory_is_rejected_despite_private_modes() {
    for on_directory in [false, true] {
        let fixture = Fixture::new(1);
        let file = fixture.0.join("control.json");
        let object = if on_directory { &fixture.0 } else { &file };
        assert!(Command::new("/bin/chmod")
            .args(["+a", "everyone allow read"])
            .arg(object)
            .status()
            .unwrap()
            .success());
        let mode = fs::metadata(object).unwrap().permissions().mode();
        assert_eq!(
            mode & 0o077,
            0,
            "ACL grants must not change the mode-bit fixture"
        );
        let output = fixture.call("control.json", false);
        let error = String::from_utf8(output.stderr).unwrap();
        assert!(error.contains("extended ACL present"), "{error}");
    }
}
