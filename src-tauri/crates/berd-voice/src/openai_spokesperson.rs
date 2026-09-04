use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::LazyLock;
use std::thread;
use std::time::Duration;

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::{client::IntoClientRequest, Message};

use crate::expert_spokesperson::SemanticTurn;

const DEFAULT_ENDPOINT: &str = "wss://api.openai.com/v1/realtime";
const DEFAULT_MODEL: &str = "gpt-realtime-2.1";
const DEFAULT_TRANSCRIPTION_MODEL: &str = "gpt-realtime-whisper";
const CONTROL_ACK_TIMEOUT: Duration = Duration::from_secs(4);

const PROMPT_DOCUMENT: &str = include_str!("../prompts/expert-spokesperson.md");
const ROLE_PLACEHOLDER: &str = "{{ROLE}}";
static SPOKESPERSON_INSTRUCTIONS: LazyLock<String> =
    LazyLock::new(|| create_realtime_role_instructions("Spokesperson"));

fn create_realtime_role_instructions(role: &str) -> String {
    let normalized = PROMPT_DOCUMENT.replace("\r\n", "\n");
    let normalized = normalized.trim();
    assert_eq!(
        normalized.matches(ROLE_PLACEHOLDER).count(),
        1,
        "Realtime prompt must contain exactly one {ROLE_PLACEHOLDER} placeholder"
    );
    normalized.replace(ROLE_PLACEHOLDER, role)
}

/// Connection settings for the live Spokesperson. This deliberately does not
/// implement `Debug` because it contains an API key.
#[derive(Clone)]
pub struct OpenAiSpokespersonConfig {
    pub endpoint: String,
    pub api_key: String,
    pub model: String,
    pub transcription_model: String,
    pub voice: String,
    pub speed: f32,
    pub semantic_transcript: Vec<SemanticTurn>,
}

impl OpenAiSpokespersonConfig {
    pub fn from_environment() -> Result<Self, String> {
        let api_key = std::env::var("OPENAI_API_KEY")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| "OPENAI_API_KEY is required for Expert-Spokesperson mode".to_string())?;
        Ok(Self {
            endpoint: std::env::var("OPENAI_REALTIME_ENDPOINT")
                .unwrap_or_else(|_| DEFAULT_ENDPOINT.into()),
            api_key,
            model: std::env::var("OPENAI_REALTIME_MODEL").unwrap_or_else(|_| DEFAULT_MODEL.into()),
            transcription_model: std::env::var("OPENAI_TRANSCRIPTION_MODEL")
                .unwrap_or_else(|_| DEFAULT_TRANSCRIPTION_MODEL.into()),
            voice: std::env::var("OPENAI_REALTIME_VOICE").unwrap_or_else(|_| "marin".into()),
            speed: std::env::var("OPENAI_REALTIME_SPEED")
                .ok()
                .and_then(|value| value.parse().ok())
                .filter(|value| (0.25..=1.5).contains(value))
                .unwrap_or(1.0),
            semantic_transcript: Vec::new(),
        })
    }
}

#[derive(Debug)]
pub enum SpokespersonCommand {
    InputPcm48Khz(Vec<f32>),
    ResetInput {
        completed: std::sync::mpsc::SyncSender<Result<(), String>>,
    },
    CancelResponses {
        response_ids: Vec<String>,
    },
    CreateUserResponse,
    ExpertSay {
        directive_id: u64,
        text: String,
    },
    ExpertContext {
        text: String,
    },
    UpdateSpeed {
        request_id: u64,
        speed: f32,
    },
    BeginInputCutover {
        request_id: u64,
    },
    AbortInputCutover {
        completed: std::sync::mpsc::SyncSender<Result<(), String>>,
    },
    TruncateOutput {
        response_id: String,
        item_id: String,
        content_index: u64,
        audio_end_ms: u64,
    },
    Shutdown,
}

#[derive(Debug)]
pub enum SpokespersonEvent {
    Ready,
    UserSpeaking {
        active: bool,
        item_id: String,
    },
    UserFinal {
        item_id: String,
        text: String,
    },
    UserTurnDiscarded {
        item_id: String,
    },
    ResponseStarted {
        response_id: String,
    },
    ResponseFinished {
        response_id: String,
        status: SpokespersonResponseStatus,
    },
    ResponseBound {
        response_id: String,
        directive_id: u64,
    },
    AudioDelta {
        response_id: String,
        item_id: String,
        content_index: u64,
        samples: Vec<f32>,
    },
    AudioDone {
        response_id: String,
    },
    TranscriptDone {
        response_id: String,
        text: String,
    },
    TranscriptDelta {
        response_id: String,
        text: String,
    },
    SpeedUpdated {
        request_id: u64,
        speed: f32,
        result: Result<(), String>,
    },
    InputCutoverFinished {
        request_id: u64,
        result: Result<(), String>,
    },
    OutputTruncated {
        response_id: String,
    },
    Handoff {
        call_id: String,
        message: String,
    },
    Failed(String),
    Closed,
}

#[derive(Debug, PartialEq, Eq)]
pub enum SpokespersonResponseStatus {
    Completed,
    Cancelled,
    Failed(String),
}

pub struct OpenAiSpokespersonRuntime {
    commands: mpsc::UnboundedSender<SpokespersonCommand>,
    worker: Option<thread::JoinHandle<()>>,
}

struct PendingSpeedUpdate {
    request_id: u64,
    event_id: String,
    speed: f32,
    deadline: tokio::time::Instant,
}

struct PendingTruncation {
    response_id: String,
    event_id: String,
    deadline: tokio::time::Instant,
}

struct PendingInputCutover {
    request_id: u64,
    event_id: String,
    cleared: bool,
    deadline: tokio::time::Instant,
    abort_completion: Option<std::sync::mpsc::SyncSender<Result<(), String>>>,
}

struct PendingInputReset {
    event_id: String,
    deadline: tokio::time::Instant,
    completed: std::sync::mpsc::SyncSender<Result<(), String>>,
}

fn complete_input_cutover_if_ready(
    pending: &mut Option<PendingInputCutover>,
    started_items: &HashSet<String>,
    committed_items: &HashSet<String>,
    events: &std::sync::mpsc::Sender<SpokespersonEvent>,
) -> Result<(), String> {
    if pending.as_ref().is_some_and(|cutover| {
        cutover.abort_completion.is_none()
            && cutover.cleared
            && started_items.is_empty()
            && committed_items.is_empty()
    }) {
        let request_id = pending.take().expect("ready input cutover").request_id;
        send_event(
            events,
            SpokespersonEvent::InputCutoverFinished {
                request_id,
                result: Ok(()),
            },
        )?;
    }
    Ok(())
}

fn expire_speed_update(
    pending: &mut Option<PendingSpeedUpdate>,
    now: tokio::time::Instant,
) -> Option<String> {
    let expired = pending
        .as_ref()
        .is_some_and(|update| now >= update.deadline);
    if expired {
        pending.take();
        Some("Spokesperson speed update timed out; provider state is indeterminate".into())
    } else {
        None
    }
}

fn speed_error_matches(pending: &PendingSpeedUpdate, event: &serde_json::Value) -> bool {
    event
        .pointer("/error/event_id")
        .and_then(|value| value.as_str())
        == Some(pending.event_id.as_str())
}

fn validate_effective_session(
    event: &serde_json::Value,
    config: &OpenAiSpokespersonConfig,
) -> Result<(), String> {
    let model = event
        .pointer("/session/model")
        .and_then(|value| value.as_str());
    let voice = event
        .pointer("/session/audio/output/voice")
        .and_then(|value| value.as_str());
    let speed = event
        .pointer("/session/audio/output/speed")
        .and_then(serde_json::Value::as_f64)
        .map(|value| value as f32);
    if model != Some(config.model.as_str())
        || voice != Some(config.voice.as_str())
        || !speed.is_some_and(|speed| (speed - config.speed).abs() <= f32::EPSILON)
    {
        return Err("OpenAI Realtime did not apply the requested model, voice, and speed".into());
    }
    Ok(())
}

fn truncation_timed_out(
    pending: &HashMap<(String, u64), PendingTruncation>,
    now: tokio::time::Instant,
) -> bool {
    pending
        .values()
        .any(|truncation| now >= truncation.deadline)
}

impl OpenAiSpokespersonRuntime {
    pub fn spawn(
        config: OpenAiSpokespersonConfig,
    ) -> Result<(Self, std::sync::mpsc::Receiver<SpokespersonEvent>), String> {
        let (commands, command_rx) = mpsc::unbounded_channel();
        let (events, event_rx) = std::sync::mpsc::channel();
        let worker = thread::Builder::new()
            .name("berd-voice-spokesperson".into())
            .spawn(move || {
                let runtime = match tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                {
                    Ok(runtime) => runtime,
                    Err(error) => {
                        let _ = events.send(SpokespersonEvent::Failed(error.to_string()));
                        return;
                    }
                };
                if let Err(error) = runtime.block_on(run(config, command_rx, &events)) {
                    let _ = events.send(SpokespersonEvent::Failed(error));
                }
                let _ = events.send(SpokespersonEvent::Closed);
            })
            .map_err(|error| error.to_string())?;
        Ok((
            Self {
                commands,
                worker: Some(worker),
            },
            event_rx,
        ))
    }

    pub fn send(&self, command: SpokespersonCommand) -> Result<(), String> {
        self.commands
            .send(command)
            .map_err(|_| "Spokesperson runtime is closed".into())
    }

    pub fn reset_input(&self) -> Result<(), String> {
        let (completed, result) = std::sync::mpsc::sync_channel(1);
        self.send(SpokespersonCommand::ResetInput { completed })?;
        result
            .recv_timeout(std::time::Duration::from_secs(5))
            .map_err(|_| "Spokesperson input reset timed out".to_string())?
    }

    pub fn abort_input_cutover(&self) -> Result<(), String> {
        let (completed, result) = std::sync::mpsc::sync_channel(1);
        self.send(SpokespersonCommand::AbortInputCutover { completed })?;
        result
            .recv_timeout(std::time::Duration::from_secs(5))
            .map_err(|_| "Spokesperson input cutover abort timed out".to_string())?
    }

    pub fn finish(mut self) -> Result<(), String> {
        let _ = self.commands.send(SpokespersonCommand::Shutdown);
        self.worker
            .take()
            .expect("Spokesperson worker exists")
            .join()
            .map_err(|_| "Spokesperson runtime panicked".to_string())
    }
}

async fn run(
    mut config: OpenAiSpokespersonConfig,
    mut commands: mpsc::UnboundedReceiver<SpokespersonCommand>,
    events: &std::sync::mpsc::Sender<SpokespersonEvent>,
) -> Result<(), String> {
    if let Err(existing) = rustls::crypto::aws_lc_rs::default_provider().install_default() {
        drop(existing);
    }
    let endpoint = if config.endpoint.contains('?') {
        format!("{}&model={}", config.endpoint, config.model)
    } else {
        format!("{}?model={}", config.endpoint, config.model)
    };
    let mut request = endpoint
        .into_client_request()
        .map_err(|error| format!("prepare OpenAI Realtime connection: {error}"))?;
    request.headers_mut().insert(
        "Authorization",
        format!("Bearer {}", config.api_key)
            .parse()
            .map_err(|_| "OpenAI API key is not a valid header value")?,
    );
    let connection = tokio::time::timeout(
        Duration::from_secs(30),
        tokio_tungstenite::connect_async(request),
    );
    let (mut socket, _) = tokio::select! {
        result = connection => result
            .map_err(|_| "connect OpenAI Realtime timed out".to_string())?
            .map_err(|error| format!("connect OpenAI Realtime: {error}"))?,
        command = commands.recv() => match command {
            Some(SpokespersonCommand::Shutdown) | None => return Ok(()),
            Some(_) => return Err("Spokesperson command arrived before readiness".into()),
        }
    };
    send_json(
        &mut socket,
        serde_json::json!({
            "type": "session.update",
            "session": {
                "type": "realtime",
                "output_modalities": ["audio"],
                "instructions": SPOKESPERSON_INSTRUCTIONS.as_str(),
                "audio": {
                    "input": {
                        "format": { "type": "audio/pcm", "rate": 24000 },
                        "transcription": { "model": config.transcription_model },
                        "turn_detection": {
                            "type": "server_vad",
                            "threshold": 0.5,
                            "prefix_padding_ms": 300,
                            "silence_duration_ms": 500,
                            "create_response": false,
                            "interrupt_response": false
                        }
                    },
                    "output": {
                        "format": { "type": "audio/pcm", "rate": 24000 },
                        "voice": config.voice,
                        "speed": config.speed
                    }
                },
                "tools": [{
                    "type": "function",
                    "name": "handoff",
                    "description": "Hand unresolved tool work or an authoritative question to the Expert.",
                    "parameters": {
                        "type": "object",
                        "properties": { "message": { "type": "string" } },
                        "required": ["message"],
                        "additionalProperties": false
                    }
                }],
                "tool_choice": "auto"
            }
        }),
    )
    .await?;

    let mut call_names = HashMap::<String, String>::new();
    let mut call_arguments = HashMap::<String, String>::new();
    let mut speed_update: Option<PendingSpeedUpdate> = None;
    let mut pending_truncations = HashMap::<(String, u64), PendingTruncation>::new();
    let mut pending_input_cutover: Option<PendingInputCutover> = None;
    let mut pending_input_reset: Option<PendingInputReset> = None;
    let mut started_input_items = HashSet::<String>::new();
    let mut committed_input_items = HashSet::<String>::new();
    let mut seed_turns = VecDeque::from(std::mem::take(&mut config.semantic_transcript));
    let mut pending_seed_item: Option<String> = None;
    let mut initial_session_ready = false;
    let mut next_control_event_id = 1_u64;
    loop {
        let speed_update_deadline = speed_update.as_ref().map(|update| update.deadline);
        let truncation_deadline = pending_truncations
            .values()
            .map(|truncation| truncation.deadline)
            .min();
        let cutover_deadline = pending_input_cutover
            .as_ref()
            .map(|cutover| cutover.deadline);
        let reset_deadline = pending_input_reset.as_ref().map(|reset| reset.deadline);
        tokio::select! {
            _ = async {
                match reset_deadline {
                    Some(deadline) => tokio::time::sleep_until(deadline).await,
                    None => std::future::pending().await,
                }
            }, if reset_deadline.is_some() => {
                if pending_input_reset
                    .as_ref()
                    .is_some_and(|reset| tokio::time::Instant::now() >= reset.deadline)
                {
                    let reset = pending_input_reset.take().expect("expired input reset");
                    let _ = reset.completed.send(Err("Spokesperson input reset timed out".into()));
                    return Err("Spokesperson input reset timed out; provider input state is indeterminate".into());
                }
            }
            _ = async {
                match cutover_deadline {
                    Some(deadline) => tokio::time::sleep_until(deadline).await,
                    None => std::future::pending().await,
                }
            }, if cutover_deadline.is_some() => {
                if pending_input_cutover
                    .as_ref()
                    .is_some_and(|cutover| tokio::time::Instant::now() >= cutover.deadline)
                {
                    let mut cutover = pending_input_cutover
                        .take()
                        .expect("expired input cutover");
                    if let Some(completed) = cutover.abort_completion.take() {
                        let _ = completed.send(Err("Spokesperson input cutover timed out".into()));
                    }
                    return Err(format!(
                        "Spokesperson input cutover {} timed out; provider input state is indeterminate",
                        cutover.request_id
                    ));
                }
            }
            _ = async {
                match speed_update_deadline {
                    Some(deadline) => tokio::time::sleep_until(deadline).await,
                    None => std::future::pending().await,
                }
            }, if speed_update_deadline.is_some() => {
                if let Some(message) = expire_speed_update(
                    &mut speed_update,
                    tokio::time::Instant::now(),
                ) {
                    return Err(message);
                }
            }
            _ = async {
                match truncation_deadline {
                    Some(deadline) => tokio::time::sleep_until(deadline).await,
                    None => std::future::pending().await,
                }
            }, if truncation_deadline.is_some() => {
                if truncation_timed_out(&pending_truncations, tokio::time::Instant::now()) {
                    return Err("Spokesperson output truncation timed out; server context is indeterminate".into());
                }
            }
            command = commands.recv() => {
                match command {
                    Some(SpokespersonCommand::InputPcm48Khz(samples)) => {
                        let pcm = downsample_pcm16(&samples);
                        send_json(&mut socket, serde_json::json!({
                            "type": "input_audio_buffer.append",
                            "audio": BASE64.encode(pcm),
                        })).await?;
                    }
                    Some(SpokespersonCommand::ResetInput { completed }) => {
                        if pending_input_cutover.is_some() || pending_input_reset.is_some() {
                            let _ = completed.send(Err(
                                "another Spokesperson input clear is in progress".into(),
                            ));
                        } else {
                            let event_id = format!("berd-reset-{next_control_event_id}");
                            next_control_event_id = next_control_event_id.checked_add(1)
                                .ok_or("Spokesperson control event space is exhausted")?;
                            send_json(&mut socket, serde_json::json!({
                                "event_id": event_id,
                                "type": "input_audio_buffer.clear",
                            })).await?;
                            pending_input_reset = Some(PendingInputReset {
                                event_id,
                                deadline: tokio::time::Instant::now() + CONTROL_ACK_TIMEOUT,
                                completed,
                            });
                        }
                    }
                    Some(SpokespersonCommand::CancelResponses { response_ids }) => {
                        for response_id in response_ids {
                            send_json(&mut socket, serde_json::json!({
                                "type": "response.cancel",
                                "response_id": response_id,
                            })).await?;
                        }
                    }
                    Some(SpokespersonCommand::CreateUserResponse) => {
                        send_json(&mut socket, serde_json::json!({
                            "type": "response.create",
                        })).await?;
                    }
                    Some(SpokespersonCommand::ExpertContext { text }) => {
                        send_expert_item(&mut socket, &text, false).await?;
                    }
                    Some(SpokespersonCommand::UpdateSpeed { request_id, speed }) => {
                        if !speed.is_finite() || !(0.25..=1.5).contains(&speed) {
                            send_event(events, SpokespersonEvent::SpeedUpdated {
                                request_id,
                                speed,
                                result: Err("Expert-Spokesperson rate must be between 0.25 and 1.5".into()),
                            })?;
                        } else if speed_update.is_some() {
                            send_event(events, SpokespersonEvent::SpeedUpdated {
                                request_id,
                                speed,
                                result: Err("another Spokesperson speed update is in progress".into()),
                            })?;
                        } else {
                            let event_id = format!("berd-speed-{next_control_event_id}");
                            next_control_event_id = next_control_event_id.checked_add(1)
                                .ok_or("Spokesperson settings event space is exhausted")?;
                            send_json(&mut socket, serde_json::json!({
                                "event_id": event_id,
                                "type": "session.update",
                                "session": {
                                    "type": "realtime",
                                    "audio": { "output": { "speed": speed } }
                                }
                            })).await?;
                            speed_update = Some(PendingSpeedUpdate {
                                request_id,
                                event_id,
                                speed,
                                deadline: tokio::time::Instant::now() + CONTROL_ACK_TIMEOUT,
                            });
                        }
                    }
                    Some(SpokespersonCommand::BeginInputCutover { request_id }) => {
                        if pending_input_cutover.is_some() || pending_input_reset.is_some() {
                            return Err("Spokesperson input cutover was requested twice".into());
                        }
                        let event_id = format!("berd-cutover-{next_control_event_id}");
                        next_control_event_id = next_control_event_id.checked_add(1)
                            .ok_or("Spokesperson control event space is exhausted")?;
                        send_json(&mut socket, serde_json::json!({
                            "event_id": event_id,
                            "type": "input_audio_buffer.clear",
                        })).await?;
                        pending_input_cutover = Some(PendingInputCutover {
                            request_id,
                            event_id,
                            cleared: false,
                            deadline: tokio::time::Instant::now() + CONTROL_ACK_TIMEOUT,
                            abort_completion: None,
                        });
                    }
                    Some(SpokespersonCommand::AbortInputCutover { completed }) => {
                        if pending_input_cutover
                            .as_ref()
                            .is_some_and(|cutover| cutover.cleared)
                        {
                            let request_id = pending_input_cutover
                                .take()
                                .expect("cleared input cutover")
                                .request_id;
                            let _ = completed.send(Ok(()));
                            send_event(events, SpokespersonEvent::InputCutoverFinished {
                                request_id,
                                result: Err("Spokesperson input cutover was aborted".into()),
                            })?;
                        } else if let Some(cutover) = pending_input_cutover.as_mut() {
                            if cutover.abort_completion.is_some() {
                                let _ = completed.send(Err(
                                    "Spokesperson input cutover abort is already pending".into(),
                                ));
                            } else {
                                cutover.abort_completion = Some(completed);
                            }
                        } else {
                            let _ = completed.send(Ok(()));
                        }
                    }
                    Some(SpokespersonCommand::TruncateOutput {
                        response_id,
                        item_id,
                        content_index,
                        audio_end_ms,
                    }) => {
                        let key = (item_id.clone(), content_index);
                        if pending_truncations.contains_key(&key) {
                            return Err("Spokesperson output truncation was requested twice".into());
                        }
                        let event_id = format!("berd-truncate-{next_control_event_id}");
                        next_control_event_id = next_control_event_id.checked_add(1)
                            .ok_or("Spokesperson control event space is exhausted")?;
                        send_json(&mut socket, serde_json::json!({
                            "event_id": event_id,
                            "type": "conversation.item.truncate",
                            "item_id": item_id,
                            "content_index": content_index,
                            "audio_end_ms": audio_end_ms,
                        })).await?;
                        pending_truncations.insert(key, PendingTruncation {
                            response_id,
                            event_id,
                            deadline: tokio::time::Instant::now() + CONTROL_ACK_TIMEOUT,
                        });
                    }
                    Some(SpokespersonCommand::ExpertSay { directive_id, text }) => {
                        send_expert_item(&mut socket, &text, true).await?;
                        send_json(&mut socket, serde_json::json!({
                            "type": "response.create",
                            "response": {
                                "instructions": format!("Speak this Expert message naturally and accurately without adding filler: {text}"),
                                "metadata": {
                                    "berd_expert_directive_id": directive_id.to_string()
                                },
                                "tools": [],
                                "tool_choice": "none"
                            }
                        })).await?;
                    }
                    Some(SpokespersonCommand::Shutdown) | None => {
                        let _ = socket.close(None).await;
                        return Ok(());
                    }
                }
            }
            message = socket.next() => {
                let text = match message {
                    Some(Ok(Message::Text(text))) => text,
                    Some(Ok(Message::Close(frame))) => {
                        let detail = frame
                            .map(|frame| {
                                format!("code {}: {}", u16::from(frame.code), frame.reason)
                            })
                            .unwrap_or_else(|| "without a close frame".into());
                        return Err(format!("OpenAI Realtime connection closed {detail}"));
                    }
                    None => {
                        return Err("OpenAI Realtime connection ended without a close frame".into());
                    }
                    Some(Ok(_)) => continue,
                    Some(Err(error)) => return Err(error.to_string()),
                };
                let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else { continue };
                let kind = value.get("type").and_then(|value| value.as_str()).unwrap_or("");
                match kind {
                    "session.updated" => {
                        if let Some(update) = speed_update.take() {
                            let applied_speed = value
                                .pointer("/session/audio/output/speed")
                                .and_then(serde_json::Value::as_f64)
                                .map(|value| value as f32);
                            let result = if applied_speed
                                .is_some_and(|speed| (speed - update.speed).abs() <= f32::EPSILON)
                            {
                                Ok(())
                            } else {
                                Err("OpenAI Realtime did not apply the requested speed".into())
                            };
                            send_event(events, SpokespersonEvent::SpeedUpdated {
                                request_id: update.request_id,
                                speed: update.speed,
                                result,
                            })?;
                        } else if !initial_session_ready {
                            validate_effective_session(&value, &config)?;
                            initial_session_ready = true;
                            send_next_seed_item(
                                &mut socket,
                                &mut seed_turns,
                                &mut pending_seed_item,
                                &mut next_control_event_id,
                            ).await?;
                            if pending_seed_item.is_none() {
                                send_event(events, SpokespersonEvent::Ready)?;
                            }
                        }
                    }
                    "input_audio_buffer.speech_started" | "input_audio_buffer.speech_stopped" => {
                        if let Some(item_id) = string(&value, "item_id") {
                            if kind.ends_with("speech_started") {
                                started_input_items.insert(item_id.into());
                            }
                            send_event(events, SpokespersonEvent::UserSpeaking {
                                active: kind.ends_with("speech_started"),
                                item_id: item_id.into(),
                            })?;
                        }
                    }
                    "conversation.item.input_audio_transcription.completed" => {
                        if let (Some(item_id), Some(text)) =
                            (string(&value, "item_id"), string(&value, "transcript"))
                        {
                            started_input_items.remove(item_id);
                            committed_input_items.remove(item_id);
                            let text = text.trim();
                            if text.is_empty() {
                                send_event(events, SpokespersonEvent::UserTurnDiscarded {
                                    item_id: item_id.into(),
                                })?;
                            } else {
                                send_event(events, SpokespersonEvent::UserFinal {
                                    item_id: item_id.into(),
                                    text: text.into(),
                                })?;
                            }
                            complete_input_cutover_if_ready(
                                &mut pending_input_cutover,
                                &started_input_items,
                                &committed_input_items,
                                events,
                            )?;
                        }
                    }
                    "conversation.item.input_audio_transcription.failed" => {
                        if let Some(item_id) = string(&value, "item_id") {
                            started_input_items.remove(item_id);
                            committed_input_items.remove(item_id);
                            send_event(events, SpokespersonEvent::UserTurnDiscarded {
                                item_id: item_id.into(),
                            })?;
                            complete_input_cutover_if_ready(
                                &mut pending_input_cutover,
                                &started_input_items,
                                &committed_input_items,
                                events,
                            )?;
                        }
                    }
                    "input_audio_buffer.committed" => {
                        if let Some(item_id) = string(&value, "item_id") {
                            committed_input_items.insert(item_id.into());
                        }
                    }
                    "input_audio_buffer.cleared" => {
                        let abandoned: Vec<_> = started_input_items
                            .difference(&committed_input_items)
                            .cloned()
                            .collect();
                        for item_id in abandoned {
                            started_input_items.remove(&item_id);
                            send_event(events, SpokespersonEvent::UserSpeaking {
                                active: false,
                                item_id: item_id.clone(),
                            })?;
                            send_event(events, SpokespersonEvent::UserTurnDiscarded { item_id })?;
                        }
                        if let Some(cutover) = pending_input_cutover.as_mut() {
                            if let Some(completed) = cutover.abort_completion.take() {
                                let request_id = cutover.request_id;
                                let _ = completed.send(Ok(()));
                                pending_input_cutover = None;
                                send_event(events, SpokespersonEvent::InputCutoverFinished {
                                    request_id,
                                    result: Err("Spokesperson input cutover was aborted".into()),
                                })?;
                                continue;
                            }
                            cutover.cleared = true;
                            complete_input_cutover_if_ready(
                                &mut pending_input_cutover,
                                &started_input_items,
                                &committed_input_items,
                                events,
                            )?;
                        } else if let Some(reset) = pending_input_reset.take() {
                            let _ = reset.completed.send(Ok(()));
                        }
                    }
                    "conversation.item.created" => {
                        let item_id = value.pointer("/item/id").and_then(|value| value.as_str());
                        if pending_seed_item.as_deref() == item_id {
                            pending_seed_item = None;
                            send_next_seed_item(
                                &mut socket,
                                &mut seed_turns,
                                &mut pending_seed_item,
                                &mut next_control_event_id,
                            ).await?;
                            if pending_seed_item.is_none() {
                                send_event(events, SpokespersonEvent::Ready)?;
                            }
                        }
                    }
                    "response.created" => {
                        if let Some(response_id) = value.pointer("/response/id").and_then(|value| value.as_str()) {
                            send_event(events, SpokespersonEvent::ResponseStarted {
                                response_id: response_id.into()
                            })?;
                            if let Some(directive_id) = value
                                .pointer("/response/metadata/berd_expert_directive_id")
                                .and_then(|value| value.as_str())
                                .and_then(|value| value.parse::<u64>().ok())
                            {
                            send_event(events, SpokespersonEvent::ResponseBound {
                                response_id: response_id.into(), directive_id
                            })?;
                            }
                        }
                    }
                    "response.done" => {
                        if let Some(response_id) = value.pointer("/response/id").and_then(|value| value.as_str()) {
                            let status = match value
                                .pointer("/response/status")
                                .and_then(|value| value.as_str())
                            {
                                Some("completed") | None => SpokespersonResponseStatus::Completed,
                                Some("cancelled") => SpokespersonResponseStatus::Cancelled,
                                Some(status) => SpokespersonResponseStatus::Failed(format!(
                                    "Spokesperson response ended with status {status}"
                                )),
                            };
                            send_event(events, SpokespersonEvent::ResponseFinished {
                                response_id: response_id.into(),
                                status,
                            })?;
                        }
                    }
                    "response.output_audio.delta" => {
                        if let (Some(response_id), Some(item_id), Some(content_index), Some(delta)) = (
                            string(&value, "response_id"),
                            string(&value, "item_id"),
                            value.get("content_index").and_then(serde_json::Value::as_u64),
                            string(&value, "delta"),
                        ) {
                            let bytes = BASE64.decode(delta).map_err(|error| format!("decode Spokesperson audio: {error}"))?;
                            let samples = pcm16_samples(&bytes)?;
                            send_event(events, SpokespersonEvent::AudioDelta {
                                response_id: response_id.into(),
                                item_id: item_id.into(),
                                content_index,
                                samples,
                            })?;
                        }
                    }
                    "conversation.item.truncated" => {
                        if let (Some(item_id), Some(content_index)) = (
                            string(&value, "item_id"),
                            value.get("content_index").and_then(serde_json::Value::as_u64),
                        ) {
                            if let Some(truncation) = pending_truncations.remove(&(item_id.into(), content_index)) {
                                send_event(events, SpokespersonEvent::OutputTruncated {
                                    response_id: truncation.response_id,
                                })?;
                            }
                        }
                    }
                    "response.output_audio.done" => {
                        if let Some(response_id) = string(&value, "response_id") {
                            send_event(events, SpokespersonEvent::AudioDone { response_id: response_id.into() })?;
                        }
                    }
                    "response.output_audio_transcript.done" => {
                        if let (Some(response_id), Some(text)) = (string(&value, "response_id"), string(&value, "transcript")) {
                            send_event(events, SpokespersonEvent::TranscriptDone { response_id: response_id.into(), text: text.trim().into() })?;
                        }
                    }
                    "response.output_audio_transcript.delta" => {
                        if let (Some(response_id), Some(text)) = (string(&value, "response_id"), string(&value, "delta")) {
                            send_event(events, SpokespersonEvent::TranscriptDelta { response_id: response_id.into(), text: text.into() })?;
                        }
                    }
                    "response.output_item.added" => {
                        if let Some(item) = value.get("item") {
                            if let (Some(call_id), Some(name)) = (string(item, "call_id"), string(item, "name")) {
                                call_names.insert(call_id.into(), name.into());
                            }
                        }
                    }
                    "response.function_call_arguments.delta" => {
                        if let (Some(call_id), Some(delta)) = (string(&value, "call_id"), string(&value, "delta")) {
                            call_arguments.entry(call_id.into()).or_default().push_str(delta);
                        }
                    }
                    "response.function_call_arguments.done" => {
                        let call_id = string(&value, "call_id").unwrap_or("");
                        let name = string(&value, "name").or_else(|| call_names.get(call_id).map(String::as_str));
                        let args = string(&value, "arguments").or_else(|| call_arguments.get(call_id).map(String::as_str));
                        if name == Some("handoff") {
                            if let Some(message) = args.and_then(parse_handoff) {
                                send_event(events, SpokespersonEvent::Handoff { call_id: call_id.into(), message })?;
                            }
                        }
                    }
                    "error" => {
                        let message = value.pointer("/error/message").and_then(|value| value.as_str()).unwrap_or("OpenAI Realtime failed").to_string();
                        if pending_input_reset.as_ref().is_some_and(|reset| {
                            value.pointer("/error/event_id").and_then(|value| value.as_str())
                                == Some(reset.event_id.as_str())
                        }) {
                            let reset = pending_input_reset.take().expect("matched input reset");
                            let _ = reset.completed.send(Err(message));
                        } else if pending_input_cutover.as_ref().is_some_and(|cutover| {
                            value.pointer("/error/event_id").and_then(|value| value.as_str())
                                == Some(cutover.event_id.as_str())
                        }) {
                            let mut cutover = pending_input_cutover
                                .take()
                                .expect("matched pending input cutover");
                            if let Some(completed) = cutover.abort_completion.take() {
                                let _ = completed.send(Err(message.clone()));
                            }
                            send_event(events, SpokespersonEvent::InputCutoverFinished {
                                request_id: cutover.request_id,
                                result: Err(message),
                            })?;
                        } else if speed_update
                            .as_ref()
                            .is_some_and(|update| speed_error_matches(update, &value))
                        {
                            let update = speed_update.take().expect("matched pending speed update");
                            send_event(events, SpokespersonEvent::SpeedUpdated {
                                request_id: update.request_id,
                                speed: update.speed,
                                result: Err(message),
                            })?;
                        } else if pending_truncations
                            .values()
                            .any(|truncation| value.pointer("/error/event_id").and_then(|value| value.as_str()) == Some(truncation.event_id.as_str()))
                        {
                            return Err(format!("Spokesperson output truncation failed: {message}"));
                        } else {
                            return Err(message);
                        }
                    }
                    _ => {}
                }
            }
        }
    }
}

async fn send_expert_item<S>(
    socket: &mut tokio_tungstenite::WebSocketStream<S>,
    text: &str,
    say: bool,
) -> Result<(), String>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let prefix = if say {
        "Expert message to speak now"
    } else {
        "Private Expert context; do not respond now"
    };
    send_json(
        socket,
        serde_json::json!({
            "type": "conversation.item.create",
            "item": { "type": "message", "role": "system", "content": [{
                "type": "input_text", "text": format!("{prefix}:\n{text}")
            }] }
        }),
    )
    .await
}

async fn send_next_seed_item<S>(
    socket: &mut tokio_tungstenite::WebSocketStream<S>,
    turns: &mut VecDeque<SemanticTurn>,
    pending_item: &mut Option<String>,
    next_control_event_id: &mut u64,
) -> Result<(), String>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let Some(turn) = turns.pop_front() else {
        return Ok(());
    };
    let item_id = format!("berd-seed-{next_control_event_id}");
    *next_control_event_id = next_control_event_id
        .checked_add(1)
        .ok_or("Spokesperson seed item space is exhausted")?;
    let (role, content_type, text) = match turn {
        SemanticTurn::User(text) => ("user", "input_text", text),
        SemanticTurn::Spokesperson { text, interrupted } => (
            "assistant",
            "output_text",
            if interrupted {
                format!("{text} [interrupted]")
            } else {
                text
            },
        ),
        SemanticTurn::Expert(text) => (
            "system",
            "input_text",
            format!("Private Expert context; do not respond now:\n{text}"),
        ),
    };
    send_json(
        socket,
        serde_json::json!({
            "type": "conversation.item.create",
            "item": {
                "id": item_id,
                "type": "message",
                "role": role,
                "content": [{ "type": content_type, "text": text }]
            }
        }),
    )
    .await?;
    *pending_item = Some(item_id);
    Ok(())
}

async fn send_json<S>(
    socket: &mut tokio_tungstenite::WebSocketStream<S>,
    value: serde_json::Value,
) -> Result<(), String>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    socket
        .send(Message::Text(value.to_string().into()))
        .await
        .map_err(|error| error.to_string())
}

fn downsample_pcm16(samples: &[f32]) -> Vec<u8> {
    let mut output = Vec::with_capacity(samples.len());
    for pair in samples.chunks_exact(2) {
        let sample = ((pair[0] + pair[1]) * 0.5).clamp(-1.0, 1.0);
        let sample = (sample * f32::from(i16::MAX)).round() as i16;
        output.extend_from_slice(&sample.to_le_bytes());
    }
    output
}

fn pcm16_samples(bytes: &[u8]) -> Result<Vec<f32>, String> {
    if !bytes.len().is_multiple_of(2) {
        return Err("Spokesperson audio contained a partial PCM16 frame".into());
    }
    Ok(bytes
        .chunks_exact(2)
        .map(|sample| f32::from(i16::from_le_bytes([sample[0], sample[1]])) / f32::from(i16::MAX))
        .collect())
}

fn parse_handoff(arguments: &str) -> Option<String> {
    serde_json::from_str::<serde_json::Value>(arguments)
        .ok()?
        .get("message")?
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn string<'a>(value: &'a serde_json::Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(|value| value.as_str())
}

fn send_event(
    events: &std::sync::mpsc::Sender<SpokespersonEvent>,
    event: SpokespersonEvent,
) -> Result<(), String> {
    events
        .send(event)
        .map_err(|_| "Spokesperson event consumer closed".into())
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::time::Duration;

    use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
    use futures_util::{SinkExt, StreamExt};
    use serde_json::{json, Value};
    use tokio::net::TcpListener;
    use tokio_tungstenite::{
        accept_hdr_async,
        tungstenite::{
            handshake::server::{ErrorResponse, Request, Response},
            protocol::{frame::coding::CloseCode, CloseFrame},
            Message,
        },
        WebSocketStream,
    };

    use super::{
        create_realtime_role_instructions, downsample_pcm16, expire_speed_update, parse_handoff,
        pcm16_samples, run, speed_error_matches, truncation_timed_out, OpenAiSpokespersonConfig,
        OpenAiSpokespersonRuntime, PendingSpeedUpdate, PendingTruncation, SpokespersonCommand,
        SpokespersonEvent, SpokespersonResponseStatus, CONTROL_ACK_TIMEOUT, PROMPT_DOCUMENT,
        ROLE_PLACEHOLDER,
    };
    use crate::expert_spokesperson::SemanticTurn;

    #[test]
    fn shared_prompt_renders_exactly_one_role_placeholder() {
        let normalized = PROMPT_DOCUMENT.replace("\r\n", "\n");
        let normalized = normalized.trim();
        assert_eq!(normalized.matches(ROLE_PLACEHOLDER).count(), 1);
        assert_eq!(
            create_realtime_role_instructions("Spokesperson"),
            normalized.replace(ROLE_PLACEHOLDER, "Spokesperson")
        );
        assert_eq!(
            create_realtime_role_instructions("Expert"),
            normalized.replace(ROLE_PLACEHOLDER, "Expert")
        );
    }

    #[allow(clippy::result_large_err)]
    fn require_test_authorization(
        request: &Request,
        response: Response,
    ) -> Result<Response, ErrorResponse> {
        assert_eq!(
            request
                .headers()
                .get("Authorization")
                .and_then(|value| value.to_str().ok()),
            Some("Bearer test-key")
        );
        Ok(response)
    }

    async fn receive_json(socket: &mut WebSocketStream<tokio::net::TcpStream>) -> Value {
        let Message::Text(text) = socket.next().await.unwrap().unwrap() else {
            panic!("expected JSON text")
        };
        serde_json::from_str(&text).unwrap()
    }

    async fn send_json(socket: &mut WebSocketStream<tokio::net::TcpStream>, value: Value) {
        socket
            .send(Message::Text(value.to_string().into()))
            .await
            .unwrap();
    }

    async fn acknowledge_initial_session(
        socket: &mut WebSocketStream<tokio::net::TcpStream>,
        update: &Value,
        model: &str,
    ) {
        send_json(
            socket,
            json!({
                "type":"session.updated",
                "session": {
                    "model": model,
                    "audio": { "output": update["session"]["audio"]["output"].clone() }
                }
            }),
        )
        .await;
    }

    #[test]
    fn normalizes_host_pcm_for_realtime() {
        let bytes = downsample_pcm16(&[1.0, 1.0, -1.0, -1.0]);
        let samples = pcm16_samples(&bytes).unwrap();
        assert_eq!(samples.len(), 2);
        assert!(samples[0] > 0.99);
        assert!(samples[1] < -0.99);
    }

    #[tokio::test]
    async fn replacement_seed_is_ordered_and_ready_only_after_provider_acknowledges_it() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("ws://{}/", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut socket = accept_hdr_async(stream, require_test_authorization)
                .await
                .unwrap();
            let update = receive_json(&mut socket).await;
            assert_eq!(update["type"], "session.update");
            acknowledge_initial_session(&mut socket, &update, "test-model").await;

            let assistant = receive_json(&mut socket).await;
            assert_eq!(assistant["item"]["role"], "assistant");
            assert_eq!(
                assistant["item"]["content"][0]["text"],
                "The heard prefix [interrupted]"
            );
            assert!(!assistant["item"]["content"][0]["text"]
                .as_str()
                .unwrap()
                .contains("unsaid suffix"));
            send_json(
                &mut socket,
                json!({"type":"conversation.item.created","item":{"id":assistant["item"]["id"]}}),
            )
            .await;

            let user = receive_json(&mut socket).await;
            assert_eq!(user["item"]["role"], "user");
            assert_eq!(user["item"]["content"][0]["text"], "interrupting user");
            send_json(
                &mut socket,
                json!({"type":"conversation.item.created","item":{"id":user["item"]["id"]}}),
            )
            .await;

            let expert = receive_json(&mut socket).await;
            assert_eq!(expert["item"]["role"], "system");
            assert!(expert["item"]["content"][0]["text"]
                .as_str()
                .unwrap()
                .contains("verified result"));
            send_json(
                &mut socket,
                json!({"type":"conversation.item.created","item":{"id":expert["item"]["id"]}}),
            )
            .await;
            let _ = socket.next().await;
        });

        let (runtime, events) = OpenAiSpokespersonRuntime::spawn(OpenAiSpokespersonConfig {
            endpoint,
            api_key: "test-key".into(),
            model: "test-model".into(),
            transcription_model: "test-transcription".into(),
            voice: "new-voice".into(),
            speed: 1.25,
            semantic_transcript: vec![
                SemanticTurn::Spokesperson {
                    text: "The heard prefix".into(),
                    interrupted: true,
                },
                SemanticTurn::User("interrupting user".into()),
                SemanticTurn::Expert("verified result".into()),
            ],
        })
        .unwrap();
        let ready = tokio::task::spawn_blocking(move || {
            events.recv_timeout(Duration::from_secs(2)).unwrap()
        })
        .await
        .unwrap();
        assert!(matches!(ready, SpokespersonEvent::Ready));
        runtime.finish().unwrap();
        server.await.unwrap();
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn input_cutover_waits_for_committed_transcription_terminal() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("ws://{}/", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut socket = accept_hdr_async(stream, require_test_authorization)
                .await
                .unwrap();
            let update = receive_json(&mut socket).await;
            assert_eq!(update["type"], "session.update");
            acknowledge_initial_session(&mut socket, &update, "test-model").await;
            let clear = receive_json(&mut socket).await;
            assert_eq!(clear["type"], "input_audio_buffer.clear");
            assert!(clear["event_id"]
                .as_str()
                .unwrap()
                .starts_with("berd-cutover-"));
            send_json(
                &mut socket,
                json!({"type":"input_audio_buffer.speech_started","item_id":"item-1"}),
            )
            .await;
            send_json(
                &mut socket,
                json!({"type":"input_audio_buffer.committed","item_id":"item-1"}),
            )
            .await;
            send_json(&mut socket, json!({"type":"input_audio_buffer.cleared"})).await;
            tokio::time::sleep(Duration::from_millis(120)).await;
            send_json(
                &mut socket,
                json!({
                    "type":"conversation.item.input_audio_transcription.completed",
                    "item_id":"item-1",
                    "transcript":"changed conversation"
                }),
            )
            .await;
            let _ = socket.next().await;
        });

        let (runtime, events) = OpenAiSpokespersonRuntime::spawn(OpenAiSpokespersonConfig {
            endpoint,
            api_key: "test-key".into(),
            model: "test-model".into(),
            transcription_model: "test-transcription".into(),
            voice: "old-voice".into(),
            speed: 1.0,
            semantic_transcript: Vec::new(),
        })
        .unwrap();
        assert!(matches!(
            events.recv_timeout(Duration::from_secs(2)).unwrap(),
            SpokespersonEvent::Ready
        ));
        runtime
            .send(SpokespersonCommand::BeginInputCutover { request_id: 41 })
            .unwrap();
        assert!(matches!(
            events.recv_timeout(Duration::from_secs(2)).unwrap(),
            SpokespersonEvent::UserSpeaking { active: true, .. }
        ));
        assert!(events.recv_timeout(Duration::from_millis(60)).is_err());
        assert!(matches!(
            events.recv_timeout(Duration::from_secs(2)).unwrap(),
            SpokespersonEvent::UserFinal { .. }
        ));
        assert!(matches!(
            events.recv_timeout(Duration::from_secs(2)).unwrap(),
            SpokespersonEvent::InputCutoverFinished {
                request_id: 41,
                result: Ok(())
            }
        ));
        runtime.finish().unwrap();
        server.await.unwrap();
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn cleared_uncommitted_speech_is_discarded_before_cutover_completes() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("ws://{}/", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut socket = accept_hdr_async(stream, require_test_authorization)
                .await
                .unwrap();
            let update = receive_json(&mut socket).await;
            assert_eq!(update["type"], "session.update");
            acknowledge_initial_session(&mut socket, &update, "test-model").await;
            assert_eq!(
                receive_json(&mut socket).await["type"],
                "input_audio_buffer.clear"
            );
            send_json(
                &mut socket,
                json!({"type":"input_audio_buffer.speech_started","item_id":"item-abandoned"}),
            )
            .await;
            send_json(&mut socket, json!({"type":"input_audio_buffer.cleared"})).await;
            let _ = socket.next().await;
        });

        let (runtime, events) = OpenAiSpokespersonRuntime::spawn(OpenAiSpokespersonConfig {
            endpoint,
            api_key: "test-key".into(),
            model: "test-model".into(),
            transcription_model: "test-transcription".into(),
            voice: "old-voice".into(),
            speed: 1.0,
            semantic_transcript: Vec::new(),
        })
        .unwrap();
        assert!(matches!(
            events.recv_timeout(Duration::from_secs(2)).unwrap(),
            SpokespersonEvent::Ready
        ));
        runtime
            .send(SpokespersonCommand::BeginInputCutover { request_id: 9 })
            .unwrap();
        assert!(matches!(
            events.recv_timeout(Duration::from_secs(2)).unwrap(),
            SpokespersonEvent::UserSpeaking { active: true, .. }
        ));
        assert!(matches!(
            events.recv_timeout(Duration::from_secs(2)).unwrap(),
            SpokespersonEvent::UserSpeaking { active: false, .. }
        ));
        assert!(matches!(
            events.recv_timeout(Duration::from_secs(2)).unwrap(),
            SpokespersonEvent::UserTurnDiscarded { .. }
        ));
        assert!(matches!(
            events.recv_timeout(Duration::from_secs(2)).unwrap(),
            SpokespersonEvent::InputCutoverFinished {
                request_id: 9,
                result: Ok(())
            }
        ));
        runtime.finish().unwrap();
        server.await.unwrap();
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn ordinary_reset_settles_started_input_before_the_next_cutover() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("ws://{}/", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut socket = accept_hdr_async(stream, require_test_authorization)
                .await
                .unwrap();
            let update = receive_json(&mut socket).await;
            assert_eq!(update["type"], "session.update");
            acknowledge_initial_session(&mut socket, &update, "test-model").await;
            assert_eq!(
                receive_json(&mut socket).await["type"],
                "input_audio_buffer.clear"
            );
            send_json(
                &mut socket,
                json!({"type":"input_audio_buffer.speech_started","item_id":"reset-item"}),
            )
            .await;
            send_json(&mut socket, json!({"type":"input_audio_buffer.cleared"})).await;
            assert_eq!(
                receive_json(&mut socket).await["type"],
                "input_audio_buffer.clear"
            );
            send_json(&mut socket, json!({"type":"input_audio_buffer.cleared"})).await;
            let _ = socket.next().await;
        });
        let (runtime, events) = OpenAiSpokespersonRuntime::spawn(OpenAiSpokespersonConfig {
            endpoint,
            api_key: "test-key".into(),
            model: "test-model".into(),
            transcription_model: "test-transcription".into(),
            voice: "old-voice".into(),
            speed: 1.0,
            semantic_transcript: Vec::new(),
        })
        .unwrap();
        assert!(matches!(
            events.recv_timeout(Duration::from_secs(2)).unwrap(),
            SpokespersonEvent::Ready
        ));
        let reset_runtime = runtime.commands.clone();
        let reset = tokio::task::spawn_blocking(move || {
            let (completed, result) = std::sync::mpsc::sync_channel(1);
            reset_runtime
                .send(SpokespersonCommand::ResetInput { completed })
                .unwrap();
            result.recv_timeout(Duration::from_secs(2)).unwrap()
        });
        assert!(matches!(
            events.recv_timeout(Duration::from_secs(2)).unwrap(),
            SpokespersonEvent::UserSpeaking { active: true, .. }
        ));
        assert!(matches!(
            events.recv_timeout(Duration::from_secs(2)).unwrap(),
            SpokespersonEvent::UserSpeaking { active: false, .. }
        ));
        assert!(matches!(
            events.recv_timeout(Duration::from_secs(2)).unwrap(),
            SpokespersonEvent::UserTurnDiscarded { .. }
        ));
        reset.await.unwrap().unwrap();
        runtime
            .send(SpokespersonCommand::BeginInputCutover { request_id: 11 })
            .unwrap();
        assert!(matches!(
            events.recv_timeout(Duration::from_secs(2)).unwrap(),
            SpokespersonEvent::InputCutoverFinished {
                request_id: 11,
                result: Ok(())
            }
        ));
        runtime.finish().unwrap();
        server.await.unwrap();
    }

    #[test]
    fn accepts_only_nonempty_handoff_messages() {
        assert_eq!(
            parse_handoff(r#"{"message":" check disk "}"#).as_deref(),
            Some("check disk")
        );
        assert_eq!(parse_handoff(r#"{"message":" "}"#), None);
        assert_eq!(parse_handoff("not json"), None);
    }

    #[test]
    fn speed_update_timeout_clears_the_worker_reservation() {
        let now = tokio::time::Instant::now();
        let mut pending = Some(PendingSpeedUpdate {
            request_id: 7,
            event_id: "berd-speed-1".into(),
            speed: 1.5,
            deadline: now,
        });

        assert_eq!(
            expire_speed_update(&mut pending, now).as_deref(),
            Some("Spokesperson speed update timed out; provider state is indeterminate")
        );
        assert!(pending.is_none());
    }

    #[test]
    fn only_the_correlated_provider_error_rejects_a_speed_update() {
        let pending = PendingSpeedUpdate {
            request_id: 7,
            event_id: "berd-speed-1".into(),
            speed: 1.5,
            deadline: tokio::time::Instant::now() + CONTROL_ACK_TIMEOUT,
        };

        assert!(speed_error_matches(
            &pending,
            &json!({"error":{"event_id":"berd-speed-1"}})
        ));
        assert!(!speed_error_matches(
            &pending,
            &json!({"error":{"event_id":"different-event"}})
        ));
    }

    #[test]
    fn output_truncation_timeout_is_bounded() {
        let now = tokio::time::Instant::now();
        let pending = HashMap::from([(
            ("assistant-1".into(), 0),
            PendingTruncation {
                response_id: "response-1".into(),
                event_id: "berd-truncate-1".into(),
                deadline: now,
            },
        )]);
        assert!(truncation_timed_out(&pending, now));
    }

    #[tokio::test]
    async fn preserves_unexpected_realtime_close_details() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("ws://{}/", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut socket = accept_hdr_async(stream, require_test_authorization)
                .await
                .unwrap();
            assert_eq!(receive_json(&mut socket).await["type"], "session.update");
            socket
                .close(Some(CloseFrame {
                    code: CloseCode::Policy,
                    reason: "response already active".into(),
                }))
                .await
                .unwrap();
        });

        let (_commands, command_rx) = tokio::sync::mpsc::unbounded_channel();
        let (events, _event_rx) = std::sync::mpsc::channel();
        let error = run(
            OpenAiSpokespersonConfig {
                endpoint,
                api_key: "test-key".into(),
                model: "test-model".into(),
                transcription_model: "test-transcription".into(),
                voice: "test-voice".into(),
                speed: 1.0,
                semantic_transcript: Vec::new(),
            },
            command_rx,
            &events,
        )
        .await
        .unwrap_err();

        assert!(
            error.contains("code 1008: response already active"),
            "{error}"
        );
        server.await.unwrap();
    }

    #[tokio::test]
    async fn truncation_is_correlated_before_a_replacement_response() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("ws://{}/", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut socket = accept_hdr_async(stream, require_test_authorization)
                .await
                .unwrap();
            let update = receive_json(&mut socket).await;
            assert_eq!(update["type"], "session.update");
            acknowledge_initial_session(&mut socket, &update, "test-model").await;

            let cancel = receive_json(&mut socket).await;
            assert_eq!(cancel["type"], "response.cancel");
            assert_eq!(cancel["response_id"], "response-old");
            let truncate = receive_json(&mut socket).await;
            assert_eq!(truncate["type"], "conversation.item.truncate");
            assert_eq!(truncate["event_id"], "berd-truncate-1");
            assert_eq!(truncate["item_id"], "assistant-old");
            assert_eq!(truncate["content_index"], 0);
            assert_eq!(truncate["audio_end_ms"], 500);
            assert!(
                tokio::time::timeout(Duration::from_millis(20), socket.next())
                    .await
                    .is_err()
            );
            send_json(
                &mut socket,
                json!({
                    "type":"conversation.item.truncated",
                    "item_id":"assistant-old",
                    "content_index":0,
                }),
            )
            .await;
            assert_eq!(receive_json(&mut socket).await["type"], "response.create");
        });

        let (runtime, events) = OpenAiSpokespersonRuntime::spawn(OpenAiSpokespersonConfig {
            endpoint,
            api_key: "test-key".into(),
            model: "test-model".into(),
            transcription_model: "test-transcription".into(),
            voice: "test-voice".into(),
            speed: 1.0,
            semantic_transcript: Vec::new(),
        })
        .unwrap();
        let (ready, events) = tokio::task::spawn_blocking(move || {
            let ready = events.recv_timeout(Duration::from_secs(2)).unwrap();
            (ready, events)
        })
        .await
        .unwrap();
        assert!(matches!(ready, SpokespersonEvent::Ready));
        runtime
            .send(SpokespersonCommand::CancelResponses {
                response_ids: vec!["response-old".into()],
            })
            .unwrap();
        runtime
            .send(SpokespersonCommand::TruncateOutput {
                response_id: "response-old".into(),
                item_id: "assistant-old".into(),
                content_index: 0,
                audio_end_ms: 500,
            })
            .unwrap();
        let truncated = tokio::task::spawn_blocking(move || {
            events.recv_timeout(Duration::from_secs(2)).unwrap()
        })
        .await
        .unwrap();
        assert!(matches!(
            truncated,
            SpokespersonEvent::OutputTruncated { response_id }
                if response_id == "response-old"
        ));
        runtime
            .send(SpokespersonCommand::CreateUserResponse)
            .unwrap();
        server.await.unwrap();
        runtime.finish().unwrap();
    }

    #[tokio::test]
    async fn owns_realtime_configuration_commands_and_normalized_events() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("ws://{}/", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut socket = accept_hdr_async(stream, require_test_authorization)
                .await
                .unwrap();
            let configured = receive_json(&mut socket).await;
            assert_eq!(configured["type"], "session.update");
            assert_eq!(
                configured.pointer("/session/audio/input/turn_detection/create_response"),
                Some(&json!(false))
            );
            assert_eq!(
                configured.pointer("/session/audio/input/turn_detection/interrupt_response"),
                Some(&json!(false))
            );
            assert_eq!(
                configured.pointer("/session/audio/output/voice"),
                Some(&json!("test-voice"))
            );
            acknowledge_initial_session(&mut socket, &configured, "test-model").await;

            let appended = receive_json(&mut socket).await;
            assert_eq!(appended["type"], "input_audio_buffer.append");
            assert_eq!(
                BASE64
                    .decode(appended["audio"].as_str().unwrap())
                    .unwrap()
                    .len(),
                4
            );

            let item = receive_json(&mut socket).await;
            assert_eq!(item["type"], "input_audio_buffer.clear");
            send_json(&mut socket, json!({"type":"input_audio_buffer.cleared"})).await;

            let speed = receive_json(&mut socket).await;
            assert_eq!(speed["type"], "session.update");
            assert_eq!(speed["event_id"], "berd-speed-2");
            assert_eq!(
                speed.pointer("/session/audio/output/speed"),
                Some(&json!(1.5))
            );
            send_json(
                &mut socket,
                json!({"type":"input_audio_buffer.speech_started","item_id":"item-during-update"}),
            )
            .await;
            let pcm_during_update = receive_json(&mut socket).await;
            assert_eq!(pcm_during_update["type"], "input_audio_buffer.append");
            send_json(
                &mut socket,
                json!({
                    "type":"session.updated",
                    "session":{"audio":{"output":{"speed":1.5}}}
                }),
            )
            .await;

            let cancel = receive_json(&mut socket).await;
            assert_eq!(cancel["type"], "response.cancel");
            assert_eq!(cancel["response_id"], "response-prior");
            let response = receive_json(&mut socket).await;
            assert_eq!(response["type"], "response.create");

            let item = receive_json(&mut socket).await;
            assert_eq!(item["type"], "conversation.item.create");
            assert!(item
                .pointer("/item/content/0/text")
                .unwrap()
                .as_str()
                .unwrap()
                .contains("speak now"));
            let response_create = receive_json(&mut socket).await;
            assert_eq!(response_create["type"], "response.create");
            assert_eq!(
                response_create.pointer("/response/metadata/berd_expert_directive_id"),
                Some(&json!("7"))
            );

            send_json(
                &mut socket,
                json!({"type":"input_audio_buffer.speech_started","item_id":"item-1"}),
            )
            .await;
            send_json(
                &mut socket,
                json!({"type":"input_audio_buffer.speech_stopped","item_id":"item-1"}),
            )
            .await;
            send_json(
                &mut socket,
                json!({
                    "type":"conversation.item.input_audio_transcription.completed",
                    "item_id":"item-1",
                    "transcript":" hello expert "
                }),
            )
            .await;
            send_json(
                &mut socket,
                json!({
                    "type":"conversation.item.input_audio_transcription.failed",
                    "item_id":"item-2"
                }),
            )
            .await;
            send_json(
                &mut socket,
                json!({"type":"response.created","response":{"id":"response-auto"}}),
            )
            .await;
            send_json(
                &mut socket,
                json!({
                    "type":"response.done",
                    "response":{"id":"response-auto","status":"failed"}
                }),
            )
            .await;
            send_json(
                &mut socket,
                json!({
                    "type":"response.created",
                    "response":{
                        "id":"response-1",
                        "metadata":{"berd_expert_directive_id":"7"}
                    }
                }),
            )
            .await;
            send_json(
                &mut socket,
                json!({
                    "type":"response.output_audio.delta",
                    "response_id":"response-1",
                    "item_id":"assistant-1",
                    "content_index":0,
                    "delta": BASE64.encode([1_u8, 0, 255, 127])
                }),
            )
            .await;
            send_json(
                &mut socket,
                json!({"type":"response.output_audio.done","response_id":"response-1"}),
            )
            .await;
            send_json(
                &mut socket,
                json!({
                    "type":"response.output_audio_transcript.done",
                    "response_id":"response-1",
                    "transcript":" spoken answer "
                }),
            )
            .await;
            send_json(
                &mut socket,
                json!({
                    "type":"response.function_call_arguments.done",
                    "call_id":"call-1",
                    "name":"handoff",
                    "arguments": r#"{"message":" inspect the computer "}"#
                }),
            )
            .await;
            send_json(
                &mut socket,
                json!({"type":"response.done","response":{"id":"response-1"}}),
            )
            .await;

            let _ = socket.next().await;
        });

        let (commands, command_rx) = tokio::sync::mpsc::unbounded_channel();
        let (events, event_rx) = std::sync::mpsc::channel();
        let client = tokio::spawn(async move {
            run(
                OpenAiSpokespersonConfig {
                    endpoint,
                    api_key: "test-key".into(),
                    model: "test-model".into(),
                    transcription_model: "test-transcription".into(),
                    voice: "test-voice".into(),
                    speed: 1.25,
                    semantic_transcript: Vec::new(),
                },
                command_rx,
                &events,
            )
            .await
        });

        let event_rx = tokio::task::spawn_blocking(move || {
            let ready = event_rx.recv_timeout(Duration::from_secs(2)).unwrap();
            (ready, event_rx)
        })
        .await
        .unwrap();
        assert!(matches!(event_rx.0, SpokespersonEvent::Ready));
        let event_rx = event_rx.1;
        commands
            .send(SpokespersonCommand::InputPcm48Khz(vec![
                1.0, 1.0, -1.0, -1.0,
            ]))
            .unwrap();
        let (reset_completed, reset_result) = std::sync::mpsc::sync_channel(1);
        commands
            .send(SpokespersonCommand::ResetInput {
                completed: reset_completed,
            })
            .unwrap();
        commands
            .send(SpokespersonCommand::UpdateSpeed {
                request_id: 9,
                speed: 1.5,
            })
            .unwrap();
        commands
            .send(SpokespersonCommand::InputPcm48Khz(vec![0.5, 0.5]))
            .unwrap();
        commands
            .send(SpokespersonCommand::CancelResponses {
                response_ids: vec!["response-prior".into()],
            })
            .unwrap();
        commands
            .send(SpokespersonCommand::CreateUserResponse)
            .unwrap();
        commands
            .send(SpokespersonCommand::ExpertSay {
                directive_id: 7,
                text: "answer this".into(),
            })
            .unwrap();

        let received = tokio::task::spawn_blocking(move || {
            (0..15)
                .map(|_| event_rx.recv_timeout(Duration::from_secs(2)).unwrap())
                .collect::<Vec<_>>()
        })
        .await
        .unwrap();
        assert_eq!(reset_result.recv().unwrap(), Ok(()));
        let (during_update, received) = received.split_first().unwrap();
        assert!(
            matches!(during_update, SpokespersonEvent::UserSpeaking { active: true, item_id } if item_id == "item-during-update")
        );
        assert!(matches!(
            &received[0],
            SpokespersonEvent::SpeedUpdated {
                request_id: 9,
                speed: 1.5,
                result: Ok(()),
            }
        ));
        let received = &received[1..];
        assert!(
            matches!(&received[0], SpokespersonEvent::UserSpeaking { active: true, item_id } if item_id == "item-1")
        );
        assert!(
            matches!(&received[1], SpokespersonEvent::UserSpeaking { active: false, item_id } if item_id == "item-1")
        );
        assert!(
            matches!(&received[2], SpokespersonEvent::UserFinal { item_id, text } if item_id == "item-1" && text == "hello expert")
        );
        assert!(
            matches!(&received[3], SpokespersonEvent::UserTurnDiscarded { item_id } if item_id == "item-2")
        );
        assert!(
            matches!(&received[4], SpokespersonEvent::ResponseStarted { response_id } if response_id == "response-auto")
        );
        assert!(
            matches!(&received[5], SpokespersonEvent::ResponseFinished { response_id, status: SpokespersonResponseStatus::Failed(message) } if response_id == "response-auto" && message.contains("failed"))
        );
        assert!(
            matches!(&received[6], SpokespersonEvent::ResponseStarted { response_id } if response_id == "response-1")
        );
        assert!(
            matches!(&received[7], SpokespersonEvent::ResponseBound { response_id, directive_id: 7 } if response_id == "response-1")
        );
        assert!(
            matches!(&received[8], SpokespersonEvent::AudioDelta { response_id, item_id, content_index: 0, samples } if response_id == "response-1" && item_id == "assistant-1" && samples.len() == 2)
        );
        assert!(
            matches!(&received[9], SpokespersonEvent::AudioDone { response_id } if response_id == "response-1")
        );
        assert!(
            matches!(&received[10], SpokespersonEvent::TranscriptDone { response_id, text } if response_id == "response-1" && text == "spoken answer")
        );
        assert!(
            matches!(&received[11], SpokespersonEvent::Handoff { call_id, message } if call_id == "call-1" && message == "inspect the computer")
        );
        assert!(
            matches!(&received[12], SpokespersonEvent::ResponseFinished { response_id, status: SpokespersonResponseStatus::Completed } if response_id == "response-1")
        );

        commands.send(SpokespersonCommand::Shutdown).unwrap();
        assert!(client.await.unwrap().is_ok());
        server.await.unwrap();
    }
}
