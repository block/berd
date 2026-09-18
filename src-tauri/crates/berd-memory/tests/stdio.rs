//! Subprocess coverage uses only an isolated HOME with an uninitialized store.
//! Opening a missing marker fails before any OS keychain operation.
#![cfg(unix)]

use serde_json::{json, Value};
use std::{
    fs,
    io::Write,
    process::{Command, Stdio},
};

#[test]
fn stdio_handshake_tools_and_uninitialized_store_fail_closed() {
    let home = tempfile::tempdir().unwrap();
    let root = home.path().join(".me");
    fs::create_dir(&root).unwrap();
    fs::write(root.join("policy.json"), r#"{"enabled":true}"#).unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_berd-memory-mcp"))
        .env("HOME", home.path())
        .env("USERPROFILE", home.path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let messages = [
        json!({"jsonrpc":"2.0","id":1,"method":"initialize"}),
        json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
        json!({"jsonrpc":"2.0","id":2,"method":"tools/list"}),
        json!({"jsonrpc":"2.0","id":3,"method":"ping"}),
        json!({"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"recall","arguments":{"topic":"Style"}}}),
    ];
    let mut stdin = child.stdin.take().unwrap();
    for message in messages {
        writeln!(stdin, "{message}").unwrap();
    }
    drop(stdin);
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success());
    let stdout = String::from_utf8(output.stdout).unwrap();
    let responses: Vec<Value> = stdout
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(responses.len(), 4);
    assert_eq!(responses[0]["result"]["serverInfo"]["name"], "berd-memory");
    assert_eq!(responses[1]["result"]["tools"].as_array().unwrap().len(), 2);
    assert_eq!(responses[2]["result"], json!({}));
    assert_eq!(responses[3]["result"]["isError"], true);
    assert!(!root.join(".berd-memory-store.json").exists());
    assert!(!root.join("topics").exists());
}
