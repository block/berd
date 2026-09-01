//! HTTP client for the broker's `/v1/ping` + `/v1/call` routes, and the
//! mapping from HTTP outcomes to the CLI's exit-code contract:
//! 0 ok, 1 command error, 2 transport, 3 environment/reachability/version.

use std::path::Path;
use std::time::Duration;

use serde::Deserialize;
use serde_json::{Map, Value};

use crate::discovery::{self, PROTOCOL_VERSION};

pub const EXIT_COMMAND: u8 = 1;
pub const EXIT_TRANSPORT: u8 = 2;
pub const EXIT_ENV: u8 = 3;

const PING_TIMEOUT: Duration = Duration::from_secs(2);
/// Above the broker's 900s command-timeout ceiling, so the broker's
/// structured 504 always arrives before this client-side timeout fires.
const CALL_TIMEOUT: Duration = Duration::from_secs(910);

const APP_UPDATED: &str = "app updated — restart Berd";
const CONTROL_REMEDIATION: &str = "confirm Berd is running, app control is enabled, and this command is running inside a Berd-started agent session.";

#[derive(Debug)]
pub struct Failure {
    pub exit: u8,
    pub message: String,
}

impl Failure {
    pub fn env(message: impl Into<String>) -> Self {
        Self {
            exit: EXIT_ENV,
            message: message.into(),
        }
    }

    /// Exit 1: the app refused the command. stderr carries the registry's
    /// `code: message` verbatim so the agent can act on the code.
    pub fn command(code: &str, message: &str) -> Self {
        Self {
            exit: EXIT_COMMAND,
            message: format!("{code}: {message}"),
        }
    }

    pub fn transport(detail: impl Into<String>) -> Self {
        Self {
            exit: EXIT_TRANSPORT,
            message: format!("{}\n{CONTROL_REMEDIATION}", detail.into()),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PingResponse {
    pub generation: u64,
    pub protocol_version: u32,
}

pub struct Endpoint {
    pub port: u16,
    capability: String,
}

impl std::fmt::Debug for Endpoint {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("Endpoint")
            .field("port", &self.port)
            .field("capability", &"[redacted]")
            .finish()
    }
}

fn agent(timeout: Duration) -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(timeout))
        // The broker is a literal loopback service. Never hand its bearer
        // capability to a user-configured proxy or redirect target.
        .proxy(None)
        .max_redirects(0)
        // Non-2xx responses carry the broker's structured error body; read it
        // instead of treating the status as a transport error.
        .http_status_as_error(false)
        .build()
        .new_agent()
}

#[derive(Debug)]
struct PingFailure {
    detail: String,
    status: Option<u16>,
}

impl PingFailure {
    fn transport(detail: String) -> Self {
        Self {
            detail,
            status: None,
        }
    }

    fn status(detail: String, status: u16) -> Self {
        Self {
            detail,
            status: Some(status),
        }
    }
}

/// Probe the listener before sending any payload (command args can contain
/// prompt text, which must not be sprayed at an unknown local service).
/// Returns the failure detail only; callers decide the exit class.
fn ping(port: u16, capability: &str) -> Result<PingResponse, PingFailure> {
    let url = format!("http://127.0.0.1:{port}/v1/ping");
    let mut response = agent(PING_TIMEOUT)
        .get(&url)
        .header("Authorization", format!("Bearer {capability}"))
        .call()
        .map_err(|err| {
            PingFailure::transport(format!("nothing answered on 127.0.0.1:{port} ({err})"))
        })?;
    let status = response.status().as_u16();
    if status != 200 {
        return Err(PingFailure::status(
            format!(
                "the listener on 127.0.0.1:{port} does not look like the Berd app \
                 control endpoint (ping returned status {status})"
            ),
            status,
        ));
    }
    response
        .body_mut()
        .read_json::<PingResponse>()
        .map_err(|err| {
            PingFailure::status(
                format!(
                    "the listener on 127.0.0.1:{port} does not look like the Berd app \
                     control endpoint (unrecognized ping response: {err})"
                ),
                status,
            )
        })
}

/// Read the discovery file and verify the broker behind it echoes the file's
/// generation and this binary's protocol version. A generation mismatch or
/// authentication failure can mean the file was read across a broker restart:
/// re-read once and retry once.
pub fn handshake(lock_path: &Path) -> Result<Endpoint, Failure> {
    let mut file = discovery::load_with_retry(lock_path)?;
    for attempt in 0..2 {
        if file.protocol_version != PROTOCOL_VERSION {
            return Err(Failure::env(APP_UPDATED));
        }
        let ping = match ping(file.port, &file.capability) {
            Ok(ping) => ping,
            Err(failure) if failure.status == Some(403) => {
                if attempt == 0 {
                    // Authentication failure can be the observable edge of a
                    // broker restart: the process has rotated the capability but
                    // this command opened the previous discovery inode. Re-read
                    // once, just as for the existing generation-mismatch path.
                    file = discovery::load(lock_path).map_err(|err| {
                        Failure::env(format!(
                            "the Berd desktop app restarted its control endpoint and the new \
                             one could not be read ({err}); {CONTROL_REMEDIATION}"
                        ))
                    })?;
                    continue;
                }
                return Err(Failure::env(format!(
                    "the Berd desktop app is not reachable: {}. The app may have \
                     quit; {CONTROL_REMEDIATION}",
                    failure.detail
                )));
            }
            Err(failure) => {
                return Err(Failure::env(format!(
                    "the Berd desktop app is not reachable: {}. The app may have \
                     quit; {CONTROL_REMEDIATION}",
                    failure.detail
                )));
            }
        };
        if ping.protocol_version != PROTOCOL_VERSION {
            return Err(Failure::env(APP_UPDATED));
        }
        if ping.generation == file.generation {
            return Ok(Endpoint {
                port: file.port,
                capability: file.capability,
            });
        }
        if attempt == 0 {
            file = discovery::load(lock_path).map_err(|err| {
                Failure::env(format!(
                    "the Berd desktop app restarted its control endpoint and the new \
                     one could not be read ({err}); {CONTROL_REMEDIATION}"
                ))
            })?;
        }
    }
    Err(Failure::env(
        "the Berd desktop app's control endpoint restarted while berdctl was \
         connecting; retry the command, and confirm Berd is running, app control is \
         enabled, and this command is running inside a Berd-started agent session if \
         it keeps failing.",
    ))
}

/// POST one command. `args` already contains the `action` discriminator.
///
/// A legitimate broker restart can happen after [`handshake`] and before this
/// request. Its old capability is rejected before dispatch, so re-read and
/// re-handshake exactly once before retrying. `Expect: 100-continue` prevents
/// the rejected listener from receiving the command body: the body is sent
/// only after that listener has accepted the request headers.
pub fn call(
    lock_path: &Path,
    endpoint: &Endpoint,
    command: &str,
    args: Map<String, Value>,
    timeout_ms: Option<u64>,
) -> Result<Value, Failure> {
    let mut payload = Map::new();
    payload.insert("command".into(), Value::String(command.into()));
    payload.insert("args".into(), Value::Object(args));
    if let Some(ms) = timeout_ms {
        payload.insert("timeout_ms".into(), Value::from(ms));
    }
    let payload = Value::Object(payload);

    match call_once(endpoint, &payload) {
        Ok(result) => Ok(result),
        Err(CallFailure::BrokerAuthForbidden) => {
            // The broker emits this 403 before reading the body or dispatching
            // it. Do not retry any other response: HTTP cannot establish
            // whether it may already have been dispatched.
            let endpoint = handshake(lock_path)?;
            call_once(&endpoint, &payload).map_err(CallFailure::into_failure)
        }
        Err(failure) => Err(failure.into_failure()),
    }
}

/// A 403 with this exact broker error is known not to have been dispatched:
/// the broker checks its bearer capability before reading `/v1/call`'s body.
enum CallFailure {
    BrokerAuthForbidden,
    Other(Failure),
}

impl CallFailure {
    fn into_failure(self) -> Failure {
        match self {
            Self::BrokerAuthForbidden => Failure::transport(
                "the app control endpoint rejected a retried command before dispatch",
            ),
            Self::Other(failure) => failure,
        }
    }
}

fn call_once(endpoint: &Endpoint, payload: &Value) -> Result<Value, CallFailure> {
    let url = format!("http://127.0.0.1:{}/v1/call", endpoint.port);
    let mut response = agent(CALL_TIMEOUT)
        .post(&url)
        .header("Authorization", format!("Bearer {}", endpoint.capability))
        // A final response to this header prevents ureq from sending the body.
        // This limits a port-reuse listener to request metadata; HTTP cannot
        // remove the unavoidable TOCTOU after a peer sends 100 Continue.
        .header("Expect", "100-continue")
        .send_json(payload)
        .map_err(|err| CallFailure::Other(transport_error_failure(endpoint.port, &err)))?;
    let status = response.status().as_u16();
    let body = response.body_mut().read_to_string().map_err(|err| {
        CallFailure::Other(Failure::transport(format!(
            "the app control endpoint's response could not be read ({err})"
        )))
    })?;
    if is_broker_auth_forbidden(status, &body) {
        return Err(CallFailure::BrokerAuthForbidden);
    }
    classify_response(status, &body).map_err(CallFailure::Other)
}

fn is_broker_auth_forbidden(status: u16, body: &str) -> bool {
    status == 403
        && serde_json::from_str::<Value>(body)
            .ok()
            .as_ref()
            .and_then(error_parts)
            .is_some_and(|(code, message)| {
                code == "forbidden" && message == "valid bearer capability required"
            })
}

/// The app quitting between ping and call surfaces as a refused connection —
/// that is the environment class (exit 3), not a transport fault (exit 2).
fn transport_error_failure(port: u16, err: &ureq::Error) -> Failure {
    if is_connection_refused(err) {
        Failure::env(format!(
            "the Berd desktop app is not reachable on 127.0.0.1:{port} (connection \
             refused); the app may have quit. {CONTROL_REMEDIATION}"
        ))
    } else {
        Failure::transport(format!(
            "the call to the app control endpoint failed ({err})"
        ))
    }
}

fn is_connection_refused(err: &ureq::Error) -> bool {
    match err {
        ureq::Error::Io(io) => io.kind() == std::io::ErrorKind::ConnectionRefused,
        _ => false,
    }
}

/// Exit-code classification for `/v1/call` responses:
/// - 200 `{"ok":true}` → success, result on stdout
/// - 200 `{"ok":false}`, 400, 429 → exit 1, `code: message` verbatim
/// - anything else (5xx, unparseable, unexpected statuses) → exit 2 with
///   direct app-control remediation
pub fn classify_response(status: u16, body: &str) -> Result<Value, Failure> {
    let parsed: Option<Value> = serde_json::from_str(body).ok();
    match status {
        200 => {
            if let Some(value) = &parsed {
                match value.get("ok").and_then(Value::as_bool) {
                    Some(true) => {
                        return Ok(value.get("result").cloned().unwrap_or(Value::Null));
                    }
                    Some(false) => {
                        if let Some((code, message)) = error_parts(value) {
                            return Err(Failure::command(&code, &message));
                        }
                    }
                    None => {}
                }
            }
            Err(Failure::transport(
                "the app control endpoint returned an unrecognized response (status 200)",
            ))
        }
        400 | 429 => match parsed.as_ref().and_then(error_parts) {
            Some((code, message)) => Err(Failure::command(&code, &message)),
            None => Err(Failure::transport(format!(
                "the app control endpoint returned an unreadable error (status {status})"
            ))),
        },
        _ => {
            let detail = parsed
                .as_ref()
                .and_then(error_parts)
                .map(|(code, message)| format!("{code}: {message}"))
                .unwrap_or_else(|| {
                    format!(
                        "the app control endpoint returned an unexpected response \
                         (status {status})"
                    )
                });
            Err(Failure::transport(detail))
        }
    }
}

fn error_parts(value: &Value) -> Option<(String, String)> {
    let error = value.get("error")?;
    Some((
        error.get("code")?.as_str()?.to_string(),
        error.get("message")?.as_str()?.to_string(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::path::PathBuf;
    use std::sync::{mpsc, Arc};
    use std::thread;

    const CURRENT_CAPABILITY: &str =
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const STALE_CAPABILITY: &str =
        "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";

    struct TempDiscoveryFile(PathBuf);

    impl TempDiscoveryFile {
        fn new(label: &str, port: u16, capability: &str) -> Self {
            let base = std::env::temp_dir().join(format!(
                "berdctl-client-auth-{}-{label}-{port}",
                std::process::id()
            ));
            std::fs::remove_dir_all(&base).ok();
            std::fs::create_dir(&base).expect("create discovery directory");
            let path = base.join("control.json");
            std::fs::write(
                &path,
                format!(
                    r#"{{"port":{port},"pid":4242,"generation":7,"protocolVersion":{PROTOCOL_VERSION},"capability":"{capability}"}}"#
                ),
            )
            .expect("write discovery file");
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(
                    path.parent().expect("test discovery has a parent"),
                    std::fs::Permissions::from_mode(0o700),
                )
                .expect("make discovery directory private");
                std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))
                    .expect("make discovery file private");
            }
            Self(path)
        }
    }

    impl Drop for TempDiscoveryFile {
        fn drop(&mut self) {
            if let Some(parent) = self.0.parent() {
                std::fs::remove_dir_all(parent).ok();
            }
        }
    }

    struct RecordedRequest {
        request_line: String,
        authorization: Option<String>,
        expects_continue: bool,
        body: String,
    }

    fn read_request(stream: &mut TcpStream) -> RecordedRequest {
        let mut reader = BufReader::new(stream.try_clone().expect("clone request stream"));
        let mut request_line = String::new();
        reader
            .read_line(&mut request_line)
            .expect("read request line");
        let mut authorization = None;
        let mut content_length = 0;
        let mut expects_continue = false;
        loop {
            let mut line = String::new();
            reader.read_line(&mut line).expect("read request header");
            if line == "\r\n" {
                break;
            }
            let Some((name, value)) = line.trim_end().split_once(':') else {
                continue;
            };
            if name.eq_ignore_ascii_case("authorization") {
                authorization = Some(value.trim().to_string());
            }
            if name.eq_ignore_ascii_case("content-length") {
                content_length = value.trim().parse().expect("valid content length");
            }
            if name.eq_ignore_ascii_case("expect")
                && value.trim().eq_ignore_ascii_case("100-continue")
            {
                expects_continue = true;
            }
        }
        if expects_continue {
            stream
                .write_all(b"HTTP/1.1 100 Continue\r\n\r\n")
                .expect("accept request body");
        }
        let mut body = vec![0; content_length];
        reader.read_exact(&mut body).expect("read request body");
        RecordedRequest {
            request_line: request_line.trim_end().to_string(),
            authorization,
            expects_continue,
            body: String::from_utf8(body).expect("request body is UTF-8"),
        }
    }

    fn write_response(stream: &mut TcpStream, status: &str, body: &str) {
        write!(
            stream,
            "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
        .expect("write test response");
    }

    fn spawn_broker_sequence(
        expected_requests: Vec<(&'static str, BrokerResponse)>,
    ) -> (u16, mpsc::Receiver<RecordedRequest>, thread::JoinHandle<()>) {
        spawn_broker_responses(expected_requests)
    }

    #[derive(Clone, Copy)]
    enum BrokerResponse {
        Ping { generation: u64 },
        Call,
    }

    fn spawn_broker_responses(
        expected_requests: Vec<(&'static str, BrokerResponse)>,
    ) -> (u16, mpsc::Receiver<RecordedRequest>, thread::JoinHandle<()>) {
        spawn_broker_responses_with_sync(expected_requests, None)
    }

    fn spawn_broker_responses_with_sync(
        expected_requests: Vec<(&'static str, BrokerResponse)>,
        first_response_sync: Option<(Arc<std::sync::Barrier>, Arc<std::sync::Barrier>)>,
    ) -> (u16, mpsc::Receiver<RecordedRequest>, thread::JoinHandle<()>) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind test broker");
        let port = listener.local_addr().expect("test broker address").port();
        let (requests_tx, requests_rx) = mpsc::channel();
        let handle = thread::spawn(move || {
            for (request_number, (expected_capability, response)) in
                expected_requests.into_iter().enumerate()
            {
                let (mut stream, _) = listener.accept().expect("accept client request");
                let request = read_request(&mut stream);
                let authorized = request.authorization.as_deref()
                    == Some(&format!("Bearer {expected_capability}"));
                requests_tx.send(request).expect("record client request");
                if request_number == 0 {
                    if let Some((request_seen, response_ready)) = &first_response_sync {
                        request_seen.wait();
                        response_ready.wait();
                    }
                }
                match (authorized, response) {
                    (true, BrokerResponse::Ping { generation }) => write_response(
                        &mut stream,
                        "200 OK",
                        &format!(
                            r#"{{"generation":{generation},"protocolVersion":{PROTOCOL_VERSION}}}"#
                        ),
                    ),
                    (true, BrokerResponse::Call) => {
                        write_response(&mut stream, "200 OK", r#"{"ok":true,"result":"ok"}"#)
                    }
                    (false, _) => write_response(
                        &mut stream,
                        "403 Forbidden",
                        r#"{"ok":false,"error":{"code":"forbidden","message":"valid bearer capability required"}}"#,
                    ),
                }
            }
        });
        (port, requests_rx, handle)
    }

    fn spawn_broker(
        expected_capability: &'static str,
        request_count: usize,
    ) -> (u16, mpsc::Receiver<RecordedRequest>, thread::JoinHandle<()>) {
        spawn_broker_responses(
            (0..request_count)
                .map(|request_number| {
                    let response = if request_number == 0 {
                        BrokerResponse::Ping { generation: 7 }
                    } else {
                        BrokerResponse::Call
                    };
                    (expected_capability, response)
                })
                .collect(),
        )
    }

    #[test]
    fn handshake_and_call_send_current_capability() {
        let (port, requests, broker) = spawn_broker(CURRENT_CAPABILITY, 2);
        let lock_file = TempDiscoveryFile::new("current", port, CURRENT_CAPABILITY);

        let endpoint = handshake(&lock_file.0).expect("current capability handshakes");
        assert_eq!(
            format!("{endpoint:?}"),
            format!("Endpoint {{ port: {port}, capability: \"[redacted]\" }}"),
            "debug output must not disclose the bearer capability"
        );
        let result = call(
            &lock_file.0,
            &endpoint,
            "sessions",
            Map::from_iter([("action".to_string(), Value::String("list".to_string()))]),
            None,
        )
        .expect("current capability calls");
        assert_eq!(result, Value::String("ok".to_string()));

        let ping = requests.recv().expect("record ping");
        assert_eq!(ping.request_line, "GET /v1/ping HTTP/1.1");
        assert_eq!(
            ping.authorization.as_deref(),
            Some(format!("Bearer {CURRENT_CAPABILITY}").as_str())
        );
        assert!(ping.body.is_empty());
        assert!(!ping.expects_continue);

        let call = requests.recv().expect("record call");
        assert_eq!(call.request_line, "POST /v1/call HTTP/1.1");
        assert_eq!(
            call.authorization.as_deref(),
            Some(format!("Bearer {CURRENT_CAPABILITY}").as_str())
        );
        assert!(call.expects_continue);
        let call_body: Value = serde_json::from_str(&call.body).expect("call body is JSON");
        assert_eq!(call_body["command"], "sessions");
        assert_eq!(call_body["args"]["action"], "list");

        broker.join().expect("test broker exits");
    }

    #[test]
    fn handshake_recovers_when_capability_rotates_after_discovery_read() {
        let first_request = Arc::new(std::sync::Barrier::new(2));
        let response_ready = Arc::new(std::sync::Barrier::new(2));
        let (port, requests, broker) = spawn_broker_responses_with_sync(
            vec![
                (CURRENT_CAPABILITY, BrokerResponse::Ping { generation: 7 }),
                (CURRENT_CAPABILITY, BrokerResponse::Ping { generation: 7 }),
            ],
            Some((first_request.clone(), response_ready.clone())),
        );
        let lock_file = TempDiscoveryFile::new("rotating", port, STALE_CAPABILITY);
        let path = lock_file.0.clone();
        let rewrite_first_request = first_request.clone();
        let rewrite_response_ready = response_ready.clone();
        let rewrite = thread::spawn(move || {
            rewrite_first_request.wait();
            std::fs::write(
                &path,
                format!(
                    r#"{{"port":{port},"pid":4242,"generation":7,"protocolVersion":{PROTOCOL_VERSION},"capability":"{CURRENT_CAPABILITY}"}}"#
                ),
            )
            .expect("publish rotated discovery capability");
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))
                    .expect("keep rewritten discovery private");
            }
            rewrite_response_ready.wait();
            let stale_ping = requests.recv().expect("record stale ping");
            assert_eq!(
                stale_ping.authorization.as_deref(),
                Some(format!("Bearer {STALE_CAPABILITY}").as_str())
            );
            requests.recv().expect("record retried current ping")
        });

        let endpoint = handshake(&lock_file.0).expect("rotated capability retries successfully");
        assert_eq!(endpoint.port, port);
        let current_ping = rewrite.join().expect("discovery rewrite exits");
        assert_eq!(
            current_ping.authorization.as_deref(),
            Some(format!("Bearer {CURRENT_CAPABILITY}").as_str())
        );
        broker.join().expect("test broker exits");
    }

    #[test]
    fn handshake_retries_generation_mismatch_with_rotated_capability() {
        let (port, requests, broker) = spawn_broker_sequence(vec![
            (STALE_CAPABILITY, BrokerResponse::Ping { generation: 6 }),
            (CURRENT_CAPABILITY, BrokerResponse::Ping { generation: 7 }),
        ]);
        let lock_file = TempDiscoveryFile::new("generation-race", port, STALE_CAPABILITY);
        let path = lock_file.0.clone();
        let rewrite = thread::spawn(move || {
            let stale_ping = requests.recv().expect("record old-generation ping");
            assert_eq!(
                stale_ping.authorization.as_deref(),
                Some(format!("Bearer {STALE_CAPABILITY}").as_str())
            );
            std::fs::write(
                &path,
                format!(
                    r#"{{"port":{port},"pid":4242,"generation":7,"protocolVersion":{PROTOCOL_VERSION},"capability":"{CURRENT_CAPABILITY}"}}"#
                ),
            )
            .expect("publish new generation and capability");
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))
                    .expect("keep rewritten discovery private");
            }
            requests.recv().expect("record new-generation ping")
        });

        let endpoint = handshake(&lock_file.0).expect("generation mismatch retries successfully");
        assert_eq!(endpoint.port, port);
        let current_ping = rewrite.join().expect("discovery rewrite exits");
        assert_eq!(
            current_ping.authorization.as_deref(),
            Some(format!("Bearer {CURRENT_CAPABILITY}").as_str())
        );
        broker.join().expect("test broker exits");
    }

    #[test]
    fn handshake_rejects_stale_capability() {
        // The first 403 triggers the one permitted discovery re-read; an
        // unchanged stale record must still fail closed on the second probe.
        let (port, requests, broker) = spawn_broker(CURRENT_CAPABILITY, 2);
        let lock_file = TempDiscoveryFile::new("stale", port, STALE_CAPABILITY);

        let failure = handshake(&lock_file.0).expect_err("stale capability fails closed");
        assert_eq!(failure.exit, EXIT_ENV);
        assert!(failure.message.contains("ping returned status 403"));
        for _ in 0..2 {
            let ping = requests.recv().expect("record stale ping");
            assert_eq!(
                ping.authorization.as_deref(),
                Some(format!("Bearer {STALE_CAPABILITY}").as_str())
            );
        }

        broker.join().expect("test broker exits");
    }

    #[test]
    fn only_the_broker_auth_403_is_safe_to_retry() {
        assert!(is_broker_auth_forbidden(
            403,
            r#"{"ok":false,"error":{"code":"forbidden","message":"valid bearer capability required"}}"#,
        ));
        assert!(!is_broker_auth_forbidden(
            403,
            r#"{"ok":false,"error":{"code":"forbidden","message":"origin rejected"}}"#,
        ));
        assert!(!is_broker_auth_forbidden(
            500,
            r#"{"ok":false,"error":{"code":"forbidden","message":"valid bearer capability required"}}"#,
        ));
    }

    #[test]
    fn ok_true_yields_the_result_verbatim() {
        let result = classify_response(200, r#"{"ok":true,"result":{"session_id":"s1"}}"#)
            .expect("ok response succeeds");
        assert_eq!(result, serde_json::json!({"session_id": "s1"}));
    }

    #[test]
    fn ok_true_without_result_yields_null() {
        let result = classify_response(200, r#"{"ok":true}"#).expect("ok without result");
        assert_eq!(result, Value::Null);
    }

    #[test]
    fn ok_false_is_exit_1_with_code_message_verbatim() {
        let failure = classify_response(
            200,
            r#"{"ok":false,"error":{"code":"session_not_found","message":"No session \"x\""}}"#,
        )
        .expect_err("command error fails");
        assert_eq!(failure.exit, EXIT_COMMAND);
        assert_eq!(failure.message, "session_not_found: No session \"x\"");
    }

    #[test]
    fn bad_request_is_exit_1() {
        let failure = classify_response(
            400,
            r#"{"ok":false,"error":{"code":"bad_request","message":"missing command"}}"#,
        )
        .expect_err("400 fails");
        assert_eq!(failure.exit, EXIT_COMMAND);
        assert_eq!(failure.message, "bad_request: missing command");
    }

    #[test]
    fn too_many_requests_is_exit_1() {
        let body = r#"{"ok":false,"error":{"code":"busy","message":"slow down"}}"#;
        let failure = classify_response(429, body).expect_err("429 fails");
        assert_eq!(failure.exit, EXIT_COMMAND);
        assert_eq!(failure.message, "busy: slow down");
    }

    #[test]
    fn server_errors_are_exit_2_with_app_control_remediation() {
        for status in [500, 503, 504] {
            let failure = classify_response(
                status,
                r#"{"ok":false,"error":{"code":"app_unavailable","message":"renderer gone"}}"#,
            )
            .expect_err("5xx fails");
            assert_eq!(failure.exit, EXIT_TRANSPORT);
            assert!(failure
                .message
                .starts_with("app_unavailable: renderer gone"));
            assert!(failure.message.contains("app control is enabled"));
        }
    }

    #[test]
    fn unparseable_bodies_are_exit_2_with_app_control_remediation() {
        for status in [200, 400, 500] {
            let failure =
                classify_response(status, "<html>nope</html>").expect_err("garbage fails");
            assert_eq!(failure.exit, EXIT_TRANSPORT);
            assert!(failure.message.contains("app control is enabled"));
        }
    }

    #[test]
    fn unexpected_statuses_are_exit_2() {
        // 403 forbidden (header validation) should never hit a CLI caller;
        // if it does, something environmental is rewriting requests.
        let failure = classify_response(
            403,
            r#"{"ok":false,"error":{"code":"forbidden","message":"origin rejected"}}"#,
        )
        .expect_err("403 fails");
        assert_eq!(failure.exit, EXIT_TRANSPORT);
        assert!(failure.message.starts_with("forbidden: origin rejected"));
    }

    #[test]
    fn ok_false_without_error_body_is_exit_2() {
        let failure = classify_response(200, r#"{"ok":false}"#).expect_err("malformed fails");
        assert_eq!(failure.exit, EXIT_TRANSPORT);
    }
}
