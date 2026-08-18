//! Shared e2e harness: a sequential mock HTTP server plus helpers used by
//! both the `agent-tools`/sq test suite and the `bb` test suite. Each test
//! binary compiles its own copy, so unused helpers are expected per-binary.
#![allow(dead_code)]

use std::collections::{BTreeMap, VecDeque};
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde_json::{json, Value};

pub const LIST_EXTENSIONS_PATH: &str = "/cash-app/goose/v3/list-extensions";
pub const LIST_TOOLS_PATH: &str = "/cash-app/goose/v3/list-tools";
pub const CALL_TOOL_PATH: &str = "/cash-app/goose/v3/call-tool";
pub const BB_TOOLS_LIST_TOOLS_PATH: &str = "/api/v3/list-tools";
pub const BB_TOOLS_CALL_TOOL_PATH: &str = "/api/v3/call-tool";

#[derive(Debug, Clone)]
pub struct RecordedRequest {
    pub method: String,
    pub path: String,
    pub headers: BTreeMap<String, String>,
    pub body: Value,
    pub body_bytes: Vec<u8>,
}

#[derive(Debug, Clone)]
pub struct MockResponse {
    pub status: u16,
    pub headers: BTreeMap<String, String>,
    pub body: Vec<u8>,
}

impl MockResponse {
    pub fn json(body: Value) -> Self {
        let mut headers = BTreeMap::new();
        headers.insert("Content-Type".to_string(), "application/json".to_string());
        Self {
            status: 200,
            headers,
            body: serde_json::to_vec(&body).expect("serialize mock response"),
        }
    }

    pub fn text(status: u16, body: &str) -> Self {
        let mut headers = BTreeMap::new();
        headers.insert("Content-Type".to_string(), "text/plain".to_string());
        Self {
            status,
            headers,
            body: body.as_bytes().to_vec(),
        }
    }

    pub fn bytes(status: u16, body: Vec<u8>, headers: &[(&str, String)]) -> Self {
        Self {
            status,
            headers: headers
                .iter()
                .map(|(name, value)| ((*name).to_string(), value.clone()))
                .collect(),
            body,
        }
    }
}

pub struct MockServer {
    pub base_url: String,
    requests: Arc<Mutex<Vec<RecordedRequest>>>,
    shutdown: Arc<AtomicBool>,
    handle: Option<thread::JoinHandle<()>>,
}

impl MockServer {
    pub fn start(responses: Vec<MockResponse>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind mock server");
        listener
            .set_nonblocking(true)
            .expect("set mock server nonblocking");

        let base_url = format!(
            "http://{}",
            listener.local_addr().expect("mock server addr")
        );
        let requests = Arc::new(Mutex::new(Vec::new()));
        let shutdown = Arc::new(AtomicBool::new(false));

        let thread_requests = Arc::clone(&requests);
        let thread_shutdown = Arc::clone(&shutdown);
        let handle = thread::spawn(move || {
            let mut responses = VecDeque::from(responses);

            loop {
                match listener.accept() {
                    Ok((stream, _)) => {
                        handle_connection(stream, &thread_requests, &mut responses);
                        if responses.is_empty() {
                            break;
                        }
                    }
                    Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => {
                        if thread_shutdown.load(Ordering::SeqCst) {
                            break;
                        }
                        thread::sleep(Duration::from_millis(10));
                    }
                    Err(err) => panic!("accept mock request: {err}"),
                }
            }

            assert!(
                responses.is_empty(),
                "unserved mock responses remained: {}",
                responses.len()
            );
        });

        Self {
            base_url,
            requests,
            shutdown,
            handle: Some(handle),
        }
    }

    pub fn command(&self) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_agent-tools"));
        command
            .env_remove("KGOOSE_BASE_URL")
            .env_remove("KGOOSE_DEBUG")
            .env_remove("KGOOSE_PLAYPEN")
            .env_remove("KGOOSE_SERVICE_PATH")
            .env_remove("KGOOSE_TIMEOUT")
            .env_remove("STS_ACCESS_TOKEN")
            .env_remove("BB_HOME")
            .env_remove("BB_SKILLS_PROFILE")
            .env_remove("BB_AUTH_STORAGE")
            .env_remove("BB_AUTH_STORAGE_FILE")
            .arg("--base-url")
            .arg(&self.base_url);
        command
    }

    pub fn bb_tools_command(&self) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_bb"));
        let bb_home = bb_home_with_org("bb-tools-home", "test");
        command
            .env_remove("KGOOSE_BASE_URL")
            .env_remove("KGOOSE_DEBUG")
            .env_remove("KGOOSE_PLAYPEN")
            .env_remove("KGOOSE_SERVICE_PATH")
            .env_remove("KGOOSE_TIMEOUT")
            .env_remove("STS_ACCESS_TOKEN")
            .env("BB_HOME", bb_home)
            .env_remove("BB_SKILLS_CONFIG")
            .env_remove("BB_SKILLS_PROFILE")
            .env_remove("BB_AUTH_STORAGE")
            .env_remove("BB_AUTH_STORAGE_FILE")
            .arg("tools")
            .arg("--base-url")
            .arg(&self.base_url);
        command
    }

    pub fn finish(mut self) -> Vec<RecordedRequest> {
        self.shutdown.store(true, Ordering::SeqCst);
        self.handle
            .take()
            .expect("mock server handle")
            .join()
            .expect("join mock server thread");
        self.requests
            .lock()
            .expect("lock recorded requests")
            .clone()
    }
}

pub fn bb_command() -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_bb"));
    let bb_home = bb_home_with_org("bb-home", "test");
    command
        .env("BB_HOME", bb_home)
        .env_remove("BB_SKILLS_HOME")
        .env_remove("BB_SKILLS_PACKAGES_DIR")
        .env_remove("BB_SKILLS_CONFIG")
        .env_remove("BB_SKILLS_PROFILE")
        .env_remove("BB_KGOOSE_PLAYPEN")
        .env_remove("BB_AUTH_STORAGE")
        .env_remove("BB_AUTH_STORAGE_FILE")
        .env_remove("BB_APPS_E2E_RESOLVE_ADDR")
        .env_remove("KGOOSE_BASE_URL")
        .env_remove("KGOOSE_DEBUG")
        .env_remove("KGOOSE_PLAYPEN")
        .env_remove("KGOOSE_SERVICE_PATH")
        .env_remove("KGOOSE_TIMEOUT")
        .env_remove("STS_ACCESS_TOKEN");
    command
}

pub fn bb_home_with_org(prefix: &str, org: &str) -> PathBuf {
    let bb_home = temp_test_dir(prefix);
    write_bb_org_config(&bb_home, org);
    bb_home
}

pub fn write_bb_org_config(bb_home: &Path, org: &str) {
    fs::create_dir_all(bb_home).expect("create bb home");
    fs::write(bb_home.join("config.yaml"), format!("org: {org}\n")).expect("write bb config");
}

fn handle_connection(
    mut stream: TcpStream,
    requests: &Arc<Mutex<Vec<RecordedRequest>>>,
    responses: &mut VecDeque<MockResponse>,
) {
    stream
        .set_nonblocking(false)
        .expect("set mock stream blocking");
    let mut reader = BufReader::new(stream.try_clone().expect("clone mock stream"));
    let mut request_line = String::new();
    reader
        .read_line(&mut request_line)
        .expect("read mock request line");
    assert!(
        !request_line.is_empty(),
        "mock server received an empty request"
    );

    let mut parts = request_line.split_whitespace();
    let method = parts.next().expect("mock request method");
    let path = parts.next().expect("mock request path");

    let mut headers = BTreeMap::new();
    let mut content_length = 0usize;
    loop {
        let mut line = String::new();
        reader
            .read_line(&mut line)
            .expect("read mock request header");
        if line == "\r\n" {
            break;
        }

        let (name, value) = line
            .split_once(':')
            .expect("mock request header should contain ':'");
        let normalized_name = name.trim().to_ascii_lowercase();
        let normalized_value = value.trim().to_string();

        if normalized_name == "content-length" {
            content_length = normalized_value
                .parse::<usize>()
                .expect("parse mock request content-length");
        }

        headers.insert(normalized_name, normalized_value);
    }

    let mut body = vec![0; content_length];
    reader
        .read_exact(&mut body)
        .expect("read mock request body");
    let parsed_body = if body.is_empty() {
        Value::Null
    } else if headers
        .get("content-type")
        .is_some_and(|value| value.starts_with("application/json"))
    {
        serde_json::from_slice::<Value>(&body).expect("json mock request body")
    } else {
        Value::Null
    };

    requests
        .lock()
        .expect("lock recorded requests")
        .push(RecordedRequest {
            method: method.to_string(),
            path: path.to_string(),
            headers,
            body: parsed_body,
            body_bytes: body,
        });

    let response = responses
        .pop_front()
        .expect("unexpected request without a queued response");
    let mut response_head = format!(
        "HTTP/1.1 {} {}\r\nContent-Length: {}\r\nConnection: close\r\n",
        response.status,
        http_reason_phrase(response.status),
        response.body.len()
    );
    for (name, value) in &response.headers {
        response_head.push_str(name);
        response_head.push_str(": ");
        response_head.push_str(value);
        response_head.push_str("\r\n");
    }
    response_head.push_str("\r\n");
    stream
        .write_all(response_head.as_bytes())
        .expect("write mock response head");
    stream
        .write_all(&response.body)
        .expect("write mock response");
}

fn http_reason_phrase(status: u16) -> &'static str {
    match status {
        200 => "OK",
        400 => "Bad Request",
        403 => "Forbidden",
        404 => "Not Found",
        _ => "Internal Server Error",
    }
}

pub fn output_text(output: &Output) -> (String, String) {
    (
        String::from_utf8(output.stdout.clone()).expect("utf8 stdout"),
        String::from_utf8(output.stderr.clone()).expect("utf8 stderr"),
    )
}

pub fn write_extensions_catalog(prefix: &str, contents: &str) -> PathBuf {
    let unique = format!("{}-{}", std::process::id(), unique_suffix());
    let path = std::env::temp_dir().join(format!("{prefix}-{unique}.yaml"));
    fs::write(&path, contents).expect("write extensions catalog");
    path
}

pub fn unique_suffix() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock")
        .as_nanos()
}

pub fn temp_test_dir(prefix: &str) -> PathBuf {
    let unique = format!("{}-{}", std::process::id(), unique_suffix());
    let path = std::env::temp_dir().join(format!("{prefix}-{unique}"));
    fs::create_dir_all(&path).expect("create temp test dir");
    path
}

#[cfg(unix)]
pub fn write_fake_executable(directory: &Path, name: &str, body: &str) {
    let path = directory.join(name);
    fs::write(&path, body).expect("write fake executable");
    let mut permissions = fs::metadata(&path)
        .expect("fake executable metadata")
        .permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(&path, permissions).expect("chmod fake executable");
}

pub fn calculate_tool_schema(with_round_up: bool) -> String {
    let mut properties = serde_json::Map::from_iter([
        (
            "numbers".to_string(),
            json!({
                "type": "array",
                "items": {"type": "number"},
                "description": "Numbers to process"
            }),
        ),
        (
            "operation".to_string(),
            json!({
                "type": "string",
                "enum": ["add", "subtract"],
                "description": "Operation to apply"
            }),
        ),
    ]);

    if with_round_up {
        properties.insert(
            "round_up".to_string(),
            json!({
                "type": "boolean",
                "description": "Round the result up",
                "default": true
            }),
        );
    }

    json!({
        "type": "object",
        "properties": properties,
        "required": ["numbers", "operation"]
    })
    .to_string()
}

pub fn post_message_tool_schema() -> String {
    json!({
        "type": "object",
        "properties": {
            "channel_id": {
                "type": "string",
                "description": "Slack channel ID"
            },
            "dm_myself": {
                "type": "boolean",
                "description": "Send the message to yourself",
                "default": false
            }
        },
        "required": ["channel_id"]
    })
    .to_string()
}

pub fn list_tools_response(extension_name: &str, schema_json: String) -> MockResponse {
    tool_response_with_extension_description(
        extension_name,
        "Utility helpers",
        "calculate",
        "Perform math",
        schema_json,
    )
}

pub fn tool_response(
    extension_name: &str,
    tool_name: &str,
    description: &str,
    schema_json: String,
) -> MockResponse {
    tool_response_with_extension_description(
        extension_name,
        "Utility helpers",
        tool_name,
        description,
        schema_json,
    )
}

pub fn tool_response_with_extension_description(
    extension_name: &str,
    extension_description: &str,
    tool_name: &str,
    description: &str,
    schema_json: String,
) -> MockResponse {
    MockResponse::json(json!({
        "extension_name": extension_name,
        "extension_description": extension_description,
        "tools": [{
            "tool": tool_name,
            "description": description,
            "config_json": schema_json,
            "mutates_state": false
        }]
    }))
}
