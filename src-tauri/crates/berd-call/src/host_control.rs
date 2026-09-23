use std::collections::HashSet;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Ipv4Addr, Shutdown, SocketAddrV4, TcpListener, TcpStream};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;

const MAX_REQUEST_BYTES: u64 = 64 * 1024;
const MAX_SPEAK_TEXT_BYTES: usize = 16 * 1024;
const MAX_HANDOFF_IDS: usize = 64;
const MAX_HANDOFF_ID_BYTES: usize = 512;
const IO_TIMEOUT: Duration = Duration::from_secs(5);

pub(crate) trait HostControl: Send + Sync + 'static {
    fn status(&self) -> Result<Value, String>;
    fn speak(
        &self,
        text: String,
        acknowledgement: Option<u64>,
        resolved_handoff_ids: Vec<String>,
    ) -> Result<Value, String>;
    fn stop(&self) -> Result<Value, String>;
    fn set_non_blocking(&self, enabled: bool) -> Result<Value, String>;
    fn set_tts(&self, settings: berd_call::TtsSettings) -> Result<Value, String>;
}

pub(crate) struct ControlServer {
    listener: TcpListener,
}

impl ControlServer {
    pub(crate) fn bind(port: u16) -> Result<Self, String> {
        let address = SocketAddrV4::new(Ipv4Addr::LOCALHOST, port);
        let listener = TcpListener::bind(address).map_err(|error| {
            format!("could not bind voice control server on {address}: {error}")
        })?;
        listener
            .set_nonblocking(true)
            .map_err(|error| format!("could not configure voice control server: {error}"))?;
        Ok(Self { listener })
    }

    #[cfg(test)]
    fn local_port(&self) -> u16 {
        self.listener.local_addr().unwrap().port()
    }

    #[cfg(test)]
    fn serve_one(&self, control: &dyn HostControl) -> Result<(), String> {
        loop {
            match self.listener.accept() {
                Ok((stream, _)) => return handle_connection(stream, control),
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(1));
                }
                Err(error) => return Err(format!("voice control server failed: {error}")),
            }
        }
    }

    pub(crate) fn poll(&self, control: Arc<dyn HostControl>) -> Result<(), String> {
        loop {
            match self.listener.accept() {
                Ok((stream, _)) => {
                    let control = Arc::clone(&control);
                    thread::Builder::new()
                        .name("berd-call-control".into())
                        .spawn(move || {
                            if let Err(error) = handle_connection(stream, control.as_ref()) {
                                eprintln!("berd-call control request failed: {error}");
                            }
                        })
                        .map_err(|error| {
                            format!("could not start voice control request: {error}")
                        })?;
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => return Ok(()),
                Err(error) => return Err(format!("voice control server failed: {error}")),
            }
        }
    }
}

#[derive(Deserialize, Serialize)]
#[serde(tag = "command", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum ControlRequest {
    Status,
    Speak {
        text: String,
        acknowledgement: Option<u64>,
        #[serde(rename = "resolvedHandoffIds")]
        resolved_handoff_ids: Vec<String>,
    },
    Stop,
    Settings {
        #[serde(rename = "nonBlocking")]
        non_blocking: bool,
    },
    TtsSettings {
        settings: berd_call::TtsSettings,
    },
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ControlResponse {
    ok: bool,
    value: Option<Value>,
    message: Option<String>,
}

pub(crate) fn request(port: u16, request: ControlRequest) -> Result<Value, String> {
    let read_timeout = if matches!(
        &request,
        ControlRequest::Speak { .. } | ControlRequest::TtsSettings { .. }
    ) {
        None
    } else {
        Some(IO_TIMEOUT)
    };
    let mut stream = TcpStream::connect((Ipv4Addr::LOCALHOST, port))
        .map_err(|error| format!("could not connect to berd-call on port {port}: {error}"))?;
    configure_stream(&stream, read_timeout)?;
    write_json_line(&mut stream, &request, "request")?;
    stream
        .shutdown(Shutdown::Write)
        .map_err(|error| format!("could not finish berd-call request: {error}"))?;

    let response: ControlResponse = read_json_line(&mut stream, "response")?;
    if response.ok {
        response
            .value
            .ok_or_else(|| "berd-call returned an empty response".to_string())
    } else {
        Err(response
            .message
            .unwrap_or_else(|| "berd-call request failed".into()))
    }
}

fn handle_connection(mut stream: TcpStream, control: &dyn HostControl) -> Result<(), String> {
    configure_stream(&stream, Some(IO_TIMEOUT))?;
    let result =
        read_json_line::<ControlRequest>(&mut stream, "request").and_then(
            |request| match request {
                ControlRequest::Status => control.status(),
                ControlRequest::Speak {
                    text,
                    acknowledgement,
                    resolved_handoff_ids,
                } => {
                    validate_speak(&text, &resolved_handoff_ids)?;
                    control.speak(text, acknowledgement, resolved_handoff_ids)
                }
                ControlRequest::Stop => control.stop(),
                ControlRequest::TtsSettings { settings } => control.set_tts(settings),
                ControlRequest::Settings { non_blocking } => control.set_non_blocking(non_blocking),
            },
        );
    let response = match result {
        Ok(value) => ControlResponse {
            ok: true,
            value: Some(value),
            message: None,
        },
        Err(message) => ControlResponse {
            ok: false,
            value: None,
            message: Some(message),
        },
    };
    write_json_line(&mut stream, &response, "response")?;
    stream
        .shutdown(Shutdown::Write)
        .map_err(|error| format!("could not finish berd-call response: {error}"))?;
    let mut remainder = Vec::new();
    stream
        .read_to_end(&mut remainder)
        .map_err(|error| format!("could not finish berd-call connection: {error}"))?;
    Ok(())
}

fn configure_stream(stream: &TcpStream, read_timeout: Option<Duration>) -> Result<(), String> {
    stream
        .set_nonblocking(false)
        .and_then(|()| stream.set_read_timeout(read_timeout))
        .and_then(|()| stream.set_write_timeout(Some(IO_TIMEOUT)))
        .map_err(|error| format!("could not configure berd-call connection: {error}"))
}

fn read_json_line<T: for<'de> Deserialize<'de>>(
    stream: &mut TcpStream,
    label: &str,
) -> Result<T, String> {
    let mut bytes = Vec::new();
    let count = BufReader::new(stream)
        .take(MAX_REQUEST_BYTES + 1)
        .read_until(b'\n', &mut bytes)
        .map_err(|error| format!("could not read berd-call {label}: {error}"))?;
    if count == 0 || bytes.last() != Some(&b'\n') {
        return Err(format!("berd-call {label} is incomplete"));
    }
    if count as u64 > MAX_REQUEST_BYTES {
        return Err(format!("berd-call {label} is too large"));
    }
    serde_json::from_slice(&bytes).map_err(|error| format!("berd-call {label} is invalid: {error}"))
}

fn write_json_line(
    stream: &mut TcpStream,
    value: &impl Serialize,
    label: &str,
) -> Result<(), String> {
    serde_json::to_writer(&mut *stream, value)
        .map_err(|error| format!("could not encode berd-call {label}: {error}"))?;
    stream
        .write_all(b"\n")
        .and_then(|()| stream.flush())
        .map_err(|error| format!("could not write berd-call {label}: {error}"))
}

fn validate_speak(text: &str, resolved_handoff_ids: &[String]) -> Result<(), String> {
    if text.trim().is_empty() {
        return Err("speak text must not be empty".into());
    }
    if text.len() > MAX_SPEAK_TEXT_BYTES {
        return Err("speak text is larger than 16 KiB".into());
    }
    if resolved_handoff_ids.len() > MAX_HANDOFF_IDS
        || resolved_handoff_ids
            .iter()
            .any(|id| id.is_empty() || id.len() > MAX_HANDOFF_ID_BYTES)
    {
        return Err("resolved handoff IDs are invalid".into());
    }
    let unique = resolved_handoff_ids.iter().collect::<HashSet<_>>();
    if unique.len() != resolved_handoff_ids.len() {
        return Err("resolved handoff IDs must be unique".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::{AtomicBool, Ordering};

    struct FakeControl {
        stopped: AtomicBool,
    }

    impl HostControl for FakeControl {
        fn set_tts(&self, settings: berd_call::TtsSettings) -> Result<Value, String> {
            Ok(serde_json::to_value(settings).unwrap())
        }
        fn set_non_blocking(&self, enabled: bool) -> Result<Value, String> {
            Ok(json!({"nonBlocking": enabled}))
        }
        fn status(&self) -> Result<Value, String> {
            Ok(json!({"running": !self.stopped.load(Ordering::SeqCst)}))
        }

        fn speak(
            &self,
            text: String,
            acknowledgement: Option<u64>,
            resolved_handoff_ids: Vec<String>,
        ) -> Result<Value, String> {
            Ok(json!({
                "spoken":text,
                "acknowledgement":acknowledgement,
                "resolvedHandoffIds":resolved_handoff_ids,
            }))
        }

        fn stop(&self) -> Result<Value, String> {
            self.stopped.store(true, Ordering::SeqCst);
            Ok(json!({"stopping":true}))
        }
    }

    #[test]
    fn loopback_control_round_trips_status_speak_and_stop() {
        let server = ControlServer::bind(0).unwrap();
        let port = server.local_port();
        let concrete = Arc::new(FakeControl {
            stopped: AtomicBool::new(false),
        });
        let control: Arc<dyn HostControl> = concrete.clone();
        let worker = thread::spawn(move || {
            for _ in 0..3 {
                server.serve_one(control.as_ref()).unwrap();
            }
        });

        assert_eq!(
            request(port, ControlRequest::Status).unwrap()["running"],
            true
        );
        assert_eq!(
            request(
                port,
                ControlRequest::Speak {
                    text: "hello".into(),
                    acknowledgement: Some(7),
                    resolved_handoff_ids: vec!["call-1".into()],
                }
            )
            .unwrap(),
            json!({
                "spoken":"hello",
                "acknowledgement":7,
                "resolvedHandoffIds":["call-1"],
            })
        );
        assert_eq!(
            request(port, ControlRequest::Stop).unwrap()["stopping"],
            true
        );
        worker.join().unwrap();
    }

    #[test]
    fn speak_validation_rejects_invalid_values() {
        assert!(validate_speak(" ", &[]).is_err());
        assert!(validate_speak(&"x".repeat(16 * 1024 + 1), &[]).is_err());
        assert!(validate_speak("hello", &["".into()]).is_err());
        assert!(validate_speak("hello", &["same".into(), "same".into()]).is_err());
    }
}
