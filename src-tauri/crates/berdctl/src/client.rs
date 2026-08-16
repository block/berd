//! HTTP client for the broker's `/v1/ping` + `/v1/call` routes, and the
//! mapping from HTTP outcomes to the CLI's exit-code contract:
//! 0 ok, 1 command error, 2 transport, 3 environment/reachability/version.

#[cfg(windows)]
use interprocess::local_socket::{prelude::*, GenericNamespaced, Stream, ToNsName};
use std::io::{BufRead, BufReader, Read};
use std::path::Path;
use std::time::Duration;

use serde::Deserialize;
use serde_json::{Map, Value};

use crate::discovery::{self, PROTOCOL_VERSION};

pub const EXIT_COMMAND: u8 = 1;
pub const EXIT_TRANSPORT: u8 = 2;
pub const EXIT_ENV: u8 = 3;

const PING_TIMEOUT: Duration = Duration::from_secs(2);
const MAX_BOOTSTRAP_RESPONSE_BYTES: u64 = 4096;
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

fn bootstrap(file: &discovery::DiscoveryFile) -> Result<Endpoint, Failure> {
    #[cfg(unix)]
    let stream = std::os::unix::net::UnixStream::connect(&file.bootstrap_endpoint).map_err(|error| Failure::env(format!("the Berd desktop app's authenticated control bootstrap is unavailable ({error}); {CONTROL_REMEDIATION}")))?;
    #[cfg(windows)]
    let stream = {
        let name = file
            .bootstrap_endpoint
            .to_string_lossy()
            .to_string()
            .to_ns_name::<GenericNamespaced>()
            .map_err(|error| {
                Failure::env(format!("invalid Berd control bootstrap endpoint: {error}"))
            })?;
        Stream::connect(name).map_err(|error| Failure::env(format!("the Berd desktop app's authenticated control bootstrap is unavailable ({error}); {CONTROL_REMEDIATION}")))?
    };
    let mut response = String::new();
    BufReader::new(stream)
        .take(MAX_BOOTSTRAP_RESPONSE_BYTES + 1)
        .read_line(&mut response)
        .map_err(|error| Failure::env(format!("the Berd desktop app's authenticated control bootstrap failed ({error}); {CONTROL_REMEDIATION}")))?;
    if response.len() as u64 > MAX_BOOTSTRAP_RESPONSE_BYTES {
        return Err(Failure::env(
            "the Berd control bootstrap returned an unexpectedly large response",
        ));
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct BootstrapResponse {
        port: u16,
        generation: u64,
        protocol_version: u32,
        capability: String,
    }
    let response: BootstrapResponse = serde_json::from_str(&response).map_err(|error| {
        Failure::env(format!(
            "the Berd control bootstrap returned invalid data ({error})"
        ))
    })?;
    if response.port != file.port
        || response.generation != file.generation
        || response.protocol_version != PROTOCOL_VERSION
    {
        return Err(Failure::env(
            "the Berd desktop app restarted its control endpoint; retry the command",
        ));
    }
    Ok(Endpoint {
        port: response.port,
        capability: response.capability,
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
        let endpoint = bootstrap(&file)?;
        let ping = match ping(endpoint.port, &endpoint.capability) {
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
            return Ok(endpoint);
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
pub fn call(
    endpoint: &Endpoint,
    command: &str,
    args: Map<String, Value>,
    timeout_ms: Option<u64>,
) -> Result<Value, Failure> {
    let url = format!("http://127.0.0.1:{}/v1/call", endpoint.port);
    let mut payload = Map::new();
    payload.insert("command".into(), Value::String(command.into()));
    payload.insert("args".into(), Value::Object(args));
    if let Some(ms) = timeout_ms {
        payload.insert("timeout_ms".into(), Value::from(ms));
    }
    let mut response = agent(CALL_TIMEOUT)
        .post(&url)
        .header("Authorization", format!("Bearer {}", endpoint.capability))
        .send_json(Value::Object(payload))
        .map_err(|err| transport_error_failure(endpoint.port, &err))?;
    let status = response.status().as_u16();
    let body = response.body_mut().read_to_string().map_err(|err| {
        Failure::transport(format!(
            "the app control endpoint's response could not be read ({err})"
        ))
    })?;
    classify_response(status, &body)
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
    #[cfg(unix)]
    use std::io::Write;
    #[cfg(unix)]
    use std::net::{TcpListener, TcpStream};
    #[cfg(unix)]
    use std::path::PathBuf;
    #[cfg(unix)]
    use std::sync::mpsc;
    #[cfg(unix)]
    use std::thread;

    #[cfg(unix)]
    const TEST_CAPABILITY: &str =
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    #[cfg(unix)]
    struct TempDiscoveryFile {
        path: PathBuf,
        bootstrap_endpoint: PathBuf,
    }

    #[cfg(unix)]
    impl TempDiscoveryFile {
        fn new(port: u16, generation: u64) -> Self {
            use std::os::unix::fs::PermissionsExt;
            let base = std::env::temp_dir().join(format!(
                "berdctl-client-bootstrap-{}-{port}",
                std::process::id()
            ));
            std::fs::remove_dir_all(&base).ok();
            std::fs::create_dir(&base).unwrap();
            std::fs::set_permissions(&base, std::fs::Permissions::from_mode(0o700)).unwrap();
            let path = base.join("control.json");
            let bootstrap_endpoint = base.join("bootstrap.sock");
            std::fs::write(
                &path,
                format!(
                    r#"{{"port":{port},"pid":4242,"generation":{generation},"protocolVersion":{PROTOCOL_VERSION},"bootstrapEndpoint":"{}"}}"#,
                    bootstrap_endpoint.display()
                ),
            )
            .unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
            Self {
                path,
                bootstrap_endpoint,
            }
        }
    }

    #[cfg(unix)]
    impl Drop for TempDiscoveryFile {
        fn drop(&mut self) {
            if let Some(parent) = self.path.parent() {
                std::fs::remove_dir_all(parent).ok();
            }
        }
    }

    #[cfg(unix)]
    fn read_request(stream: &mut TcpStream) -> (String, Option<String>, String) {
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let mut request_line = String::new();
        reader.read_line(&mut request_line).unwrap();
        let mut authorization = None;
        let mut content_length = 0;
        loop {
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            if line == "\r\n" {
                break;
            }
            if let Some((name, value)) = line.trim_end().split_once(':') {
                if name.eq_ignore_ascii_case("authorization") {
                    authorization = Some(value.trim().to_string());
                }
                if name.eq_ignore_ascii_case("content-length") {
                    content_length = value.trim().parse().unwrap();
                }
            }
        }
        let mut body = vec![0; content_length];
        reader.read_exact(&mut body).unwrap();
        (
            request_line.trim_end().to_string(),
            authorization,
            String::from_utf8(body).unwrap(),
        )
    }

    #[cfg(unix)]
    fn write_response(stream: &mut TcpStream, body: &str) {
        write!(
            stream,
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        ).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn handshake_bootstraps_capability_and_call_reuses_it() {
        let broker = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = broker.local_addr().unwrap().port();
        let discovery = TempDiscoveryFile::new(port, 7);
        let bootstrap =
            std::os::unix::net::UnixListener::bind(&discovery.bootstrap_endpoint).unwrap();
        let (requests_tx, requests_rx) = mpsc::channel();
        let worker = thread::spawn(move || {
            let (mut stream, _) = bootstrap.accept().unwrap();
            writeln!(stream, r#"{{"port":{port},"generation":7,"protocolVersion":{PROTOCOL_VERSION},"capability":"{TEST_CAPABILITY}"}}"#).unwrap();
            for response in [
                format!(r#"{{"generation":7,"protocolVersion":{PROTOCOL_VERSION}}}"#),
                r#"{"ok":true,"result":"ok"}"#.to_string(),
            ] {
                let (mut stream, _) = broker.accept().unwrap();
                requests_tx.send(read_request(&mut stream)).unwrap();
                write_response(&mut stream, &response);
            }
        });

        let endpoint = handshake(&discovery.path).unwrap();
        assert_eq!(
            format!("{endpoint:?}"),
            format!("Endpoint {{ port: {port}, capability: \"[redacted]\" }}")
        );
        assert_eq!(
            call(
                &endpoint,
                "sessions",
                Map::from_iter([("action".into(), Value::String("list".into()))]),
                None
            )
            .unwrap(),
            Value::String("ok".into())
        );

        let ping = requests_rx.recv().unwrap();
        assert_eq!(ping.0, "GET /v1/ping HTTP/1.1");
        assert_eq!(
            ping.1.as_deref(),
            Some(format!("Bearer {TEST_CAPABILITY}").as_str())
        );
        let call = requests_rx.recv().unwrap();
        assert_eq!(call.0, "POST /v1/call HTTP/1.1");
        assert_eq!(
            call.1.as_deref(),
            Some(format!("Bearer {TEST_CAPABILITY}").as_str())
        );
        assert_eq!(
            serde_json::from_str::<Value>(&call.2).unwrap()["command"],
            "sessions"
        );
        worker.join().unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn bootstrap_rejects_mismatched_discovery_generation() {
        let discovery = TempDiscoveryFile::new(43123, 7);
        let bootstrap =
            std::os::unix::net::UnixListener::bind(&discovery.bootstrap_endpoint).unwrap();
        let worker = thread::spawn(move || {
            let (mut stream, _) = bootstrap.accept().unwrap();
            writeln!(stream, r#"{{"port":43123,"generation":6,"protocolVersion":{PROTOCOL_VERSION},"capability":"{TEST_CAPABILITY}"}}"#).unwrap();
        });
        let failure = handshake(&discovery.path).expect_err("mismatched generation fails closed");
        assert_eq!(failure.exit, EXIT_ENV);
        assert!(failure.message.contains("restarted its control endpoint"));
        worker.join().unwrap();
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
