//! Usage telemetry for standalone calls: one start and one end event per call,
//! in Berd's voice-conversation shape under berd-call's own service and scope,
//! so CLI calls stay distinguishable from in-app calls. Consent is Berd's
//! shared preference (`berd_call::telemetry_store`), forced on only in builds
//! with `telemetry-enforced`. A build without a compiled-in environment never
//! touches the network. Sending is best effort and never fails a call; the
//! only cost to a call is the bounded flush when it ends.
#![cfg_attr(not(target_os = "macos"), allow(dead_code))]

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use berd_call::telemetry_store as store;
use berd_call::TtsSettings;
use serde_json::{json, Value};

const SCHEMA_VERSION: &str = "berd-call-otlp-logs-v1";
const ENFORCED: bool = cfg!(feature = "telemetry-enforced");
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
const FLUSH_TIMEOUT: Duration = Duration::from_secs(5);

/// What a release build reports as, compiled in by `scripts/release/build-macos.sh`.
#[derive(Clone, Copy)]
struct Build {
    origin: &'static str,
    environment: &'static str,
    channel: &'static str,
    version: &'static str,
}

fn build() -> Option<Build> {
    let (origin, environment) = match option_env!("BERD_CALL_TELEMETRY_ENVIRONMENT") {
        Some("production") => ("https://otel.berd.xyz", "production"),
        Some("staging") => ("https://otel.test.blockstaging.build", "staging"),
        _ => return None,
    };
    Some(Build {
        origin,
        environment,
        channel: match option_env!("BERD_CALL_TELEMETRY_CHANNEL") {
            Some("internal") => "internal",
            _ => "public",
        },
        version: option_env!("BERD_CALL_VERSION").unwrap_or(env!("CARGO_PKG_VERSION")),
    })
}

/// Berd.app's data dir (Tauri's app-data dir for `xyz.block.berd`), which
/// holds the shared consent and installation id.
fn berd_dir() -> Option<PathBuf> {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    #[cfg(target_os = "macos")]
    let root = home?.join("Library/Application Support");
    #[cfg(not(target_os = "macos"))]
    let root = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .or_else(|| home.map(|home| home.join(".local/share")))?;
    Some(root.join("xyz.block.berd"))
}

fn consented(dir: &Path) -> bool {
    ENFORCED || store::load_telemetry_consent(dir).unwrap_or(false)
}

fn ensure_consent(dir: &Path) -> Result<(), String> {
    consented(dir)
        .then_some(())
        .ok_or_else(|| "telemetry is disabled".to_string())
}

/// `berd-call telemetry [status|enable|disable]`.
pub(crate) fn command(args: &[String]) -> Result<Value, String> {
    let dir = berd_dir().ok_or("cannot locate Berd's settings: HOME is unset")?;
    command_in(&dir, &args.iter().map(String::as_str).collect::<Vec<_>>())
}

fn command_in(dir: &Path, args: &[&str]) -> Result<Value, String> {
    match args {
        [] | ["status"] => {}
        ["enable" | "disable"] if ENFORCED => {
            return Err("telemetry is always enabled in this build".into())
        }
        [action @ ("enable" | "disable")] => {
            store::persist_telemetry_consent(dir, *action == "enable")?
        }
        _ => return Err("usage: berd-call telemetry [status|enable|disable]".into()),
    }
    Ok(json!({"enabled": consented(dir), "enforced": ENFORCED}))
}

/// The call's audio setup, as Berd's voice events report it.
#[derive(Clone, Debug, PartialEq)]
struct Context {
    input: &'static str,
    output: &'static str,
    rate: Option<String>,
    voice: Option<String>,
}

impl Context {
    /// Reports the selected voice only from its backend's own catalog, and any
    /// other voice as "custom", so free-form names never leave the machine.
    fn new(
        session_arguments: &[String],
        tts: &TtsSettings,
        siri_voices: impl FnOnce() -> Vec<String>,
    ) -> Option<Self> {
        let input = session_arguments
            .windows(2)
            .rfind(|pair| pair[0] == "--stt-backend")
            .map_or("macos", |pair| pair[1].as_str());
        let (output, known) = match tts {
            TtsSettings::OpenAi { voice, .. } => (
                "openai",
                berd_call::openai::OPENAI_VOICE_IDS.contains(&voice.as_str()),
            ),
            TtsSettings::Siri { voice, .. } => ("siri", siri_voices().contains(voice)),
            TtsSettings::Pocket { voice, .. } => (
                "pocket",
                berd_call::pocket_assets::voices()
                    .iter()
                    .any(|known| known.id == voice),
            ),
        };
        let (rate, voice) = (tts.rate(), tts.voice());
        Some(Self {
            input: ["macos", "parakeet", "openai"]
                .into_iter()
                .find(|known| *known == input)?,
            output,
            rate: (0.25..=4.0).contains(&rate).then(|| rate.to_string()),
            voice: (!voice.is_empty()).then(|| if known { voice } else { "custom" }.to_string()),
        })
    }

    fn attributes(&self) -> Vec<(&'static str, String)> {
        let mut attributes = vec![
            ("input_backend", self.input.to_string()),
            ("output_backend", self.output.to_string()),
            ("voice_mode", "chained".to_string()),
        ];
        attributes.extend(self.rate.clone().map(|rate| ("tts_rate", rate)));
        attributes.extend(self.voice.clone().map(|voice| ("tts_voice", voice)));
        attributes
    }
}

struct Call {
    context: Context,
    started: Instant,
    records: mpsc::Sender<Value>,
    sent: mpsc::Receiver<()>,
}

static CALL: Mutex<Option<Call>> = Mutex::new(None);
static USER_UTTERANCES: AtomicU64 = AtomicU64::new(0);
static ASSISTANT_RESPONSES: AtomicU64 = AtomicU64::new(0);
static USER_STOPPED: AtomicBool = AtomicBool::new(false);

pub(crate) fn user_utterance() {
    USER_UTTERANCES.fetch_add(1, Ordering::Relaxed);
}

pub(crate) fn assistant_response() {
    ASSISTANT_RESPONSES.fetch_add(1, Ordering::Relaxed);
}

pub(crate) fn user_stopped() {
    USER_STOPPED.store(true, Ordering::Relaxed);
}

/// Reports the call's start once, when its first session is ready.
pub(crate) fn start(session_arguments: &[String], tts: &TtsSettings) {
    let (Some(build), Some(dir)) = (build(), berd_dir()) else {
        return;
    };
    let Ok(mut call) = CALL.lock() else { return };
    if call.is_some() || !consented(&dir) {
        return;
    }
    let Some(context) = Context::new(session_arguments, tts, || {
        berd_call::siri::load_voice_catalog(None)
            .map(|catalog| catalog.voices.into_iter().map(|voice| voice.name).collect())
            .unwrap_or_default()
    }) else {
        return;
    };
    let (records, queued) = mpsc::channel();
    let (done, sent) = mpsc::channel();
    let worker = thread::Builder::new()
        .name("berd-call-telemetry".into())
        .spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build();
            if let (Ok(runtime), Ok(client)) = (runtime, client()) {
                for record in queued {
                    let _ = runtime.block_on(export(&client, build, &dir, record));
                }
            }
            let _ = done.send(());
        });
    if worker.is_err() {
        return;
    }
    // Consent granted mid-call starts reporting at a later session, so the
    // counts begin with the started event rather than with the process.
    USER_UTTERANCES.store(0, Ordering::Relaxed);
    ASSISTANT_RESPONSES.store(0, Ordering::Relaxed);
    let _ = records.send(record(
        "berd_voice_conversation_started",
        SystemTime::now(),
        &context.attributes(),
    ));
    *call = Some(Call {
        context,
        started: Instant::now(),
        records,
        sent,
    });
}

/// Reports the call's end and waits briefly for queued events to send.
pub(crate) fn end(failed: bool) {
    let Some(call) = CALL.lock().ok().and_then(|mut call| call.take()) else {
        return;
    };
    let reason = if failed {
        "error"
    } else if USER_STOPPED.load(Ordering::Relaxed) {
        "user"
    } else {
        "clean-shutdown"
    };
    let _ = call.records.send(record(
        "berd_voice_conversation_ended",
        SystemTime::now(),
        &ended_attributes(
            &call.context,
            call.started.elapsed(),
            USER_UTTERANCES.load(Ordering::Relaxed),
            ASSISTANT_RESPONSES.load(Ordering::Relaxed),
            reason,
        ),
    ));
    drop(call.records);
    let _ = call.sent.recv_timeout(FLUSH_TIMEOUT);
}

fn ended_attributes(
    context: &Context,
    duration: Duration,
    user_utterances: u64,
    assistant_responses: u64,
    reason: &'static str,
) -> Vec<(&'static str, String)> {
    let mut attributes = context.attributes();
    attributes.extend([
        ("duration_ms", duration.as_millis().to_string()),
        ("user_utterance_count", user_utterances.to_string()),
        ("assistant_response_count", assistant_responses.to_string()),
        ("end_reason", reason.to_string()),
    ]);
    attributes
}

fn attributes<'a>(pairs: impl IntoIterator<Item = (&'a str, &'a str)>) -> Value {
    pairs
        .into_iter()
        .map(|(key, value)| json!({"key": key, "value": {"stringValue": value}}))
        .collect()
}

fn record(event: &str, at: SystemTime, event_attributes: &[(&'static str, String)]) -> Value {
    let nanos = at
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos()
        .to_string();
    json!({
        "timeUnixNano": nanos,
        "observedTimeUnixNano": nanos,
        "body": {},
        "eventName": event,
        "attributes": attributes(event_attributes.iter().map(|(key, value)| (*key, value.as_str()))),
        "droppedAttributesCount": 0,
    })
}

fn payload(build: Build, installation_id: &str, record: Value) -> Value {
    json!({"resourceLogs": [{
        "resource": {
            "attributes": attributes([
                ("service.name", "berd-call"),
                ("service.version", build.version),
                ("deployment.environment", build.environment),
                ("distribution.channel", build.channel),
                ("installation.id", installation_id),
            ]),
            "droppedAttributesCount": 0,
        },
        "scopeLogs": [{"scope": {"name": "berd-call.telemetry"}, "logRecords": [record]}],
    }]})
}

fn client() -> reqwest::Result<reqwest::Client> {
    reqwest::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(REQUEST_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .build()
}

#[derive(serde::Deserialize)]
struct Bootstrap {
    token: String,
}

/// Bootstraps an upload token and posts one record, re-reading consent before
/// each request so a revocation (from the CLI or Berd.app) stops the next one.
async fn export(
    client: &reqwest::Client,
    build: Build,
    dir: &Path,
    record: Value,
) -> Result<(), String> {
    ensure_consent(dir)?;
    let installation_id = store::load_or_create_installation_id(dir)?;
    let failed = |error: reqwest::Error| error.to_string();
    let bootstrap: Bootstrap = client
        .post(format!("{}/v1/bootstrap", build.origin))
        .header(reqwest::header::ACCEPT, "application/json")
        .json(&json!({"installationId": installation_id}))
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
        .map_err(failed)?
        .json()
        .await
        .map_err(failed)?;
    ensure_consent(dir)?;
    client
        .post(format!("{}/v1/logs", build.origin))
        .header(reqwest::header::ACCEPT, "application/json")
        .header("x-berd-schema-version", SCHEMA_VERSION)
        .bearer_auth(bootstrap.token)
        .json(&payload(build, &installation_id, record))
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
        .map_err(failed)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::TcpListener;
    use std::sync::Arc;

    const ID: &str = "11111111-2222-4333-8444-555555555555";

    fn production() -> Build {
        Build {
            origin: "https://otel.berd.xyz",
            environment: "production",
            channel: "internal",
            version: "0.5.42",
        }
    }

    fn pocket(rate: f32) -> TtsSettings {
        TtsSettings::Pocket {
            model: "pocket".into(),
            voice: "anna".into(),
            rate,
        }
    }

    fn context(values: &[&str], tts: &TtsSettings) -> Option<Context> {
        Context::new(&arguments(values), tts, || vec!["Samantha".into()])
    }

    fn arguments(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    fn at(seconds: u64) -> SystemTime {
        UNIX_EPOCH + Duration::from_secs(seconds)
    }

    #[test]
    fn context_reports_backends_and_a_valid_rate() {
        let parakeet = context(
            &[
                "session",
                "--stt-backend",
                "parakeet",
                "--tts-backend",
                "pocket",
            ],
            &pocket(1.25),
        )
        .unwrap();
        assert_eq!(
            parakeet.attributes(),
            [
                ("input_backend", "parakeet".to_string()),
                ("output_backend", "pocket".to_string()),
                ("voice_mode", "chained".to_string()),
                ("tts_rate", "1.25".to_string()),
                ("tts_voice", "anna".to_string()),
            ]
        );
        let siri = |voice: &str| TtsSettings::Siri {
            voice: voice.into(),
            language: "en-US".into(),
            rate: 1.0,
        };
        let default = context(&["session"], &siri("Samantha")).unwrap();
        assert_eq!((default.input, default.output), ("macos", "siri"));
        assert_eq!(default.rate.as_deref(), Some("1"));
        assert_eq!(default.voice.as_deref(), Some("Samantha"));
        assert_eq!(
            context(&["session"], &siri("Fred's clone"))
                .unwrap()
                .voice
                .as_deref(),
            Some("custom")
        );
        assert_eq!(context(&["session"], &siri("")).unwrap().voice, None);
        let openai = |voice: &str| TtsSettings::OpenAi {
            model: "gpt-4o-mini-tts".into(),
            voice: voice.into(),
            rate: 1.0,
        };
        assert_eq!(
            context(&["session"], &openai("marin"))
                .unwrap()
                .voice
                .as_deref(),
            Some("marin")
        );
        assert_eq!(
            context(&["session"], &openai("my-voice"))
                .unwrap()
                .voice
                .as_deref(),
            Some("custom")
        );
        assert_eq!(context(&["session"], &pocket(5.0)).unwrap().rate, None);
        assert_eq!(
            context(&["session", "--stt-backend", "whisper"], &siri("Samantha")),
            None
        );
    }

    #[test]
    fn payloads_match_the_gateway_contract() {
        let context = context(&["session", "--stt-backend", "parakeet"], &pocket(1.25)).unwrap();
        let started = payload(
            production(),
            ID,
            record(
                "berd_voice_conversation_started",
                at(1_762_264_800),
                &context.attributes(),
            ),
        );
        let ended = payload(
            production(),
            ID,
            record(
                "berd_voice_conversation_ended",
                at(1_762_265_100),
                &ended_attributes(&context, Duration::from_millis(300_250), 4, 3, "user"),
            ),
        );
        let fixture = |event: &str, nanos: &str, extra: Value| {
            let mut attributes = json!([
                {"key": "input_backend", "value": {"stringValue": "parakeet"}},
                {"key": "output_backend", "value": {"stringValue": "pocket"}},
                {"key": "voice_mode", "value": {"stringValue": "chained"}},
                {"key": "tts_rate", "value": {"stringValue": "1.25"}},
                {"key": "tts_voice", "value": {"stringValue": "anna"}},
            ]);
            attributes
                .as_array_mut()
                .unwrap()
                .extend(extra.as_array().unwrap().clone());
            json!({"resourceLogs": [{
                "resource": {
                    "attributes": [
                        {"key": "service.name", "value": {"stringValue": "berd-call"}},
                        {"key": "service.version", "value": {"stringValue": "0.5.42"}},
                        {"key": "deployment.environment", "value": {"stringValue": "production"}},
                        {"key": "distribution.channel", "value": {"stringValue": "internal"}},
                        {"key": "installation.id", "value": {"stringValue": ID}},
                    ],
                    "droppedAttributesCount": 0,
                },
                "scopeLogs": [{
                    "scope": {"name": "berd-call.telemetry"},
                    "logRecords": [{
                        "timeUnixNano": nanos,
                        "observedTimeUnixNano": nanos,
                        "body": {},
                        "eventName": event,
                        "attributes": attributes,
                        "droppedAttributesCount": 0,
                    }],
                }],
            }]})
        };
        assert_eq!(
            started,
            fixture(
                "berd_voice_conversation_started",
                "1762264800000000000",
                json!([])
            )
        );
        assert_eq!(
            ended,
            fixture(
                "berd_voice_conversation_ended",
                "1762265100000000000",
                json!([
                    {"key": "duration_ms", "value": {"stringValue": "300250"}},
                    {"key": "user_utterance_count", "value": {"stringValue": "4"}},
                    {"key": "assistant_response_count", "value": {"stringValue": "3"}},
                    {"key": "end_reason", "value": {"stringValue": "user"}},
                ])
            )
        );
        if let Some(path) = std::env::var_os("BERD_CALL_TELEMETRY_FIXTURES") {
            let fixtures = json!({"started": started, "ended": ended});
            std::fs::write(path, serde_json::to_string_pretty(&fixtures).unwrap()).unwrap();
        }
    }

    #[cfg(not(feature = "telemetry-enforced"))]
    #[test]
    fn the_command_shares_berds_preference() {
        let dir = tempfile::tempdir().unwrap();
        let status = |args: &[&str]| command_in(dir.path(), args).unwrap();
        assert_eq!(status(&[]), json!({"enabled": false, "enforced": false}));
        assert_eq!(
            status(&["enable"]),
            json!({"enabled": true, "enforced": false})
        );
        assert_eq!(store::load_telemetry_consent(dir.path()), Ok(true));
        assert_eq!(
            status(&["disable"]),
            json!({"enabled": false, "enforced": false})
        );
        assert_eq!(
            status(&["status"]),
            json!({"enabled": false, "enforced": false})
        );
        assert!(command_in(dir.path(), &["maybe"]).is_err());
        assert!(command_in(dir.path(), &["enable", "now"]).is_err());
    }

    #[cfg(feature = "telemetry-enforced")]
    #[test]
    fn enforced_builds_are_always_enabled() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            command_in(dir.path(), &[]).unwrap(),
            json!({"enabled": true, "enforced": true})
        );
        assert!(command_in(dir.path(), &["disable"]).is_err());
    }

    struct Request {
        line: String,
        headers: Vec<(String, String)>,
        body: Value,
    }

    /// Serves `/v1/bootstrap` then `/v1/logs`, running `during_bootstrap`
    /// before answering the bootstrap.
    fn gateway(during_bootstrap: impl Fn() + Send + 'static) -> (String, Arc<Mutex<Vec<Request>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let requests = Arc::new(Mutex::new(Vec::new()));
        let recorded = Arc::clone(&requests);
        thread::spawn(move || {
            for stream in listener.incoming() {
                let mut stream = stream.unwrap();
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                let mut headers = Vec::new();
                loop {
                    let mut header = String::new();
                    reader.read_line(&mut header).unwrap();
                    let Some((name, value)) = header.trim_end().split_once(": ") else {
                        break;
                    };
                    headers.push((name.to_ascii_lowercase(), value.to_string()));
                }
                let length = headers
                    .iter()
                    .find(|(name, _)| name == "content-length")
                    .map_or(0, |(_, value)| value.parse().unwrap());
                let mut body = vec![0; length];
                reader.read_exact(&mut body).unwrap();
                let bootstrap = line.starts_with("POST /v1/bootstrap ");
                if bootstrap {
                    during_bootstrap();
                }
                recorded.lock().unwrap().push(Request {
                    line: line.trim_end().to_string(),
                    headers,
                    body: serde_json::from_slice(&body).unwrap(),
                });
                let response = if bootstrap {
                    r#"{"token":"token-1","tokenType":"Bearer","expiresInSeconds":900}"#
                } else {
                    r#"{"accepted":true}"#
                };
                write!(
                    stream,
                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{response}",
                    response.len()
                )
                .unwrap();
            }
        });
        (origin, requests)
    }

    fn export_to(origin: &str, dir: &Path) -> Result<(), String> {
        let build = Build {
            origin: Box::leak(origin.to_string().into_boxed_str()),
            ..production()
        };
        let context = context(&["session"], &pocket(1.0)).unwrap();
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(export(
                &client().unwrap(),
                build,
                dir,
                record(
                    "berd_voice_conversation_started",
                    at(1),
                    &context.attributes(),
                ),
            ))
    }

    #[cfg(not(feature = "telemetry-enforced"))]
    #[test]
    fn nothing_is_sent_or_created_without_consent() {
        let dir = tempfile::tempdir().unwrap();
        let (origin, requests) = gateway(|| {});
        assert!(export_to(&origin, dir.path()).is_err());
        assert!(requests.lock().unwrap().is_empty());
        assert!(!dir.path().join(store::INSTALLATION_ID_FILE_NAME).exists());
    }

    #[test]
    fn a_consented_export_bootstraps_then_uploads_the_record() {
        let dir = tempfile::tempdir().unwrap();
        store::persist_telemetry_consent(dir.path(), true).unwrap();
        let (origin, requests) = gateway(|| {});
        export_to(&origin, dir.path()).unwrap();
        let id = store::load_or_create_installation_id(dir.path()).unwrap();
        let requests = requests.lock().unwrap();
        assert_eq!(requests.len(), 2);
        assert_eq!(requests[0].line, "POST /v1/bootstrap HTTP/1.1");
        assert_eq!(requests[0].body, json!({"installationId": id}));
        assert_eq!(requests[1].line, "POST /v1/logs HTTP/1.1");
        let header = |name: &str| {
            requests[1]
                .headers
                .iter()
                .filter(|(header, _)| header == name)
                .map(|(_, value)| value.as_str())
                .collect::<Vec<_>>()
        };
        assert_eq!(header("authorization"), ["Bearer token-1"]);
        assert_eq!(header("x-berd-schema-version"), ["berd-call-otlp-logs-v1"]);
        assert_eq!(header("content-type"), ["application/json"]);
        let resource = &requests[1].body["resourceLogs"][0]["resource"]["attributes"];
        assert_eq!(
            resource[4],
            json!({"key": "installation.id", "value": {"stringValue": id}})
        );
    }

    #[cfg(not(feature = "telemetry-enforced"))]
    #[test]
    fn revoking_consent_during_bootstrap_stops_the_upload() {
        let dir = tempfile::tempdir().unwrap();
        store::persist_telemetry_consent(dir.path(), true).unwrap();
        let revoke = dir.path().to_path_buf();
        let (origin, requests) = gateway(move || {
            store::persist_telemetry_consent(&revoke, false).unwrap();
        });
        assert!(export_to(&origin, dir.path()).is_err());
        let requests = requests.lock().unwrap();
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].line, "POST /v1/bootstrap HTTP/1.1");
    }

    #[test]
    fn ended_attributes_append_duration_counts_and_reason() {
        let context = context(&["session"], &pocket(9.0)).unwrap();
        let attributes = ended_attributes(
            &context,
            Duration::from_millis(1_500),
            0,
            2,
            "clean-shutdown",
        );
        assert_eq!(
            &attributes[4..],
            [
                ("duration_ms", "1500".to_string()),
                ("user_utterance_count", "0".to_string()),
                ("assistant_response_count", "2".to_string()),
                ("end_reason", "clean-shutdown".to_string()),
            ]
        );
    }
}
