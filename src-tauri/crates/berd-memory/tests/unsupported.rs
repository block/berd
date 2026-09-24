//! Unsupported binaries must exit without opening stdin, HOME, policy, or keys.
#![cfg(not(any(
    all(target_os = "macos", target_arch = "aarch64"),
    all(
        feature = "portable-store",
        any(target_os = "macos", target_os = "linux", target_os = "windows")
    )
)))]

use std::process::{Command, Stdio};

#[test]
fn unsupported_entry_exits_before_memory_access() {
    let fixture = tempfile::tempdir().unwrap();
    let home = fixture.path().join("home-that-must-not-be-created");
    let output = Command::new(env!("CARGO_BIN_EXE_berd-memory-mcp"))
        .env("HOME", &home)
        .env("USERPROFILE", &home)
        .env("BERD_MEMORY_MCP_BIN", "must-not-run")
        .stdin(Stdio::piped())
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(1));
    assert!(output.stdout.is_empty());
    assert!(String::from_utf8(output.stderr)
        .unwrap()
        .contains("Apple-silicon macOS"));
    assert!(!home.exists());
    assert_eq!(std::fs::read_dir(fixture.path()).unwrap().count(), 0);
}

#[test]
fn enabled_legacy_store_is_unchanged_on_unsupported_target() {
    let home = tempfile::tempdir().unwrap();
    let root = home.path().join(".me");
    std::fs::create_dir(&root).unwrap();
    let fixtures = [
        ("policy.json", "{\"enabled\":true}"),
        (".berd-memory-store.json", "synthetic legacy marker"),
        ("pending.jsonl", "synthetic pending entry"),
    ];
    for (name, content) in fixtures {
        std::fs::write(root.join(name), content).unwrap();
    }
    let output = Command::new(env!("CARGO_BIN_EXE_berd-memory-mcp"))
        .env("HOME", home.path())
        .env("USERPROFILE", home.path())
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(1));
    assert!(output.stdout.is_empty());
    for (name, content) in fixtures {
        assert_eq!(std::fs::read_to_string(root.join(name)).unwrap(), content);
    }
    assert_eq!(std::fs::read_dir(&root).unwrap().count(), fixtures.len());
}
