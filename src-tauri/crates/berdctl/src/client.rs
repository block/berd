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
}

fn agent(timeout: Duration) -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(timeout))
        // Non-2xx responses carry the broker's structured error body; read it
        // instead of treating the status as a transport error.
        .http_status_as_error(false)
        .build()
        .new_agent()
}

/// Probe the listener before sending any payload (command args can contain
/// prompt text, which must not be sprayed at an unknown local service).
/// Returns the failure detail only; callers decide the exit class.
pub fn ping(port: u16) -> Result<PingResponse, String> {
    let url = format!("http://127.0.0.1:{port}/v1/ping");
    let mut response = agent(PING_TIMEOUT)
        .get(&url)
        .call()
        .map_err(|err| format!("nothing answered on 127.0.0.1:{port} ({err})"))?;
    let status = response.status().as_u16();
    if status != 200 {
        return Err(format!(
            "the listener on 127.0.0.1:{port} does not look like the Berd app \
             control endpoint (ping returned status {status})"
        ));
    }
    response
        .body_mut()
        .read_json::<PingResponse>()
        .map_err(|err| {
            format!(
                "the listener on 127.0.0.1:{port} does not look like the Berd app \
                 control endpoint (unrecognized ping response: {err})"
            )
        })
}

/// Read the discovery file and verify the broker behind it echoes the file's
/// generation and this binary's protocol version. A generation mismatch means
/// the file was read across a broker restart: re-read once and retry once.
pub fn handshake(lock_path: &Path) -> Result<Endpoint, Failure> {
    let mut file = discovery::load_with_retry(lock_path)?;
    for attempt in 0..2 {
        if file.protocol_version != PROTOCOL_VERSION {
            return Err(Failure::env(APP_UPDATED));
        }
        let ping = ping(file.port).map_err(|detail| {
            Failure::env(format!(
                "the Berd desktop app is not reachable: {detail}. The app may have \
                 quit; {CONTROL_REMEDIATION}"
            ))
        })?;
        if ping.protocol_version != PROTOCOL_VERSION {
            return Err(Failure::env(APP_UPDATED));
        }
        if ping.generation == file.generation {
            return Ok(Endpoint { port: file.port });
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
