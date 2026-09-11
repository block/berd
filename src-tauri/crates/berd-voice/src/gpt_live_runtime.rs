use std::thread;
use std::time::Duration;

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::{client::IntoClientRequest, Message};

use crate::gpt_live_bridge::SemanticTurn;
use crate::gpt_live_protocol::{
    gpt_live_session_update, RealtimeGptLiveSessionOptions,
};

const DEFAULT_ENDPOINT: &str = "wss://api.openai.com/v1/live/sessions";
const DEFAULT_MODEL: &str = "gpt-live-1";
const INPUT_QUEUE_FRAMES: usize = 100;

/// Connection settings for GPT Live. This deliberately does not
/// implement `Debug` because it contains an API key.
#[derive(Clone)]
pub struct OpenAiGptLiveConfig {
    pub endpoint: String,
    pub api_key: String,
    pub session: RealtimeGptLiveSessionOptions,
    pub semantic_transcript: Vec<SemanticTurn>,
}

impl OpenAiGptLiveConfig {
    pub fn new(
        api_key: String,
        session: RealtimeGptLiveSessionOptions,
        semantic_transcript: Vec<SemanticTurn>,
    ) -> Self {
        Self {
            endpoint: DEFAULT_ENDPOINT.into(),
            api_key,
            session,
            semantic_transcript,
        }
    }

    pub fn from_environment() -> Result<Self, String> {
        let api_key = std::env::var("OPENAI_API_KEY")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| "OPENAI_API_KEY is required for GPT Live mode".to_string())?;
        let mut config = Self::new(
            api_key,
            RealtimeGptLiveSessionOptions {
                voice: Some(
                    std::env::var("OPENAI_REALTIME_VOICE").unwrap_or_else(|_| "marin".into()),
                ),
            },
            Vec::new(),
        );
        config.endpoint = std::env::var("OPENAI_LIVE_ENDPOINT")
            .or_else(|_| std::env::var("OPENAI_REALTIME_ENDPOINT"))
            .unwrap_or_else(|_| DEFAULT_ENDPOINT.into());
        Ok(config)
    }

    pub fn model(&self) -> &str {
        DEFAULT_MODEL
    }

    pub fn voice(&self) -> &str {
        self.session.voice.as_deref().unwrap_or("marin")
    }

    pub fn speed(&self) -> f32 {
        1.0
    }

    pub fn set_voice_and_speed(&mut self, voice: String, _speed: f32) {
        self.session.voice = Some(voice);
    }
}

#[derive(Debug)]
pub enum GptLiveCommand {
    /// Send a GPT Live client-delegation protocol event.
    Provider(serde_json::Value),
    InputPcm48Khz(Vec<f32>),
    ResetInput {
        completed: std::sync::mpsc::SyncSender<Result<(), String>>,
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
pub enum GptLiveEvent {
    /// Raw provider event consumed by the shared GPT Live reducer.
    Provider(serde_json::Value),
    Ready,
    ResponseStarted {
        response_id: String,
    },
    ResponseFinished {
        response_id: String,
        status: GptLiveResponseStatus,
    },
    AudioDelta {
        response_id: String,
        item_id: String,
        output_index: u64,
        content_index: u64,
        samples: Vec<f32>,
    },
    InputCutoverFinished {
        request_id: u64,
        result: Result<(), String>,
    },
    OutputTruncated {
        response_id: String,
        item_id: String,
        content_index: u64,
    },
    Expired(String),
    SessionLost(String),
    Failed(String),
    Closed,
}

#[derive(Debug, PartialEq, Eq)]
pub enum GptLiveResponseStatus {
    Completed,
    Cancelled,
    Failed(String),
}

pub struct OpenAiGptLiveRuntime {
    commands: mpsc::UnboundedSender<GptLiveCommand>,
    audio: mpsc::Sender<Vec<f32>>,
    worker: Option<thread::JoinHandle<()>>,
}

fn validate_effective_session(
    event: &serde_json::Value,
    config: &OpenAiGptLiveConfig,
) -> Result<(), String> {
    let model = event
        .pointer("/session/model")
        .and_then(|value| value.as_str());
    let voice = event
        .pointer("/session/audio/output/voice")
        .and_then(|value| value.as_str());
    if model != Some(DEFAULT_MODEL) || voice != Some(config.voice()) {
        return Err("OpenAI Live did not apply the requested model and voice".into());
    }
    Ok(())
}

impl OpenAiGptLiveRuntime {
    pub fn spawn(
        config: OpenAiGptLiveConfig,
    ) -> Result<(Self, std::sync::mpsc::Receiver<GptLiveEvent>), String> {
        Self::spawn_inner(config)
    }

    fn spawn_inner(
        config: OpenAiGptLiveConfig,
    ) -> Result<(Self, std::sync::mpsc::Receiver<GptLiveEvent>), String> {
        let (commands, command_rx) = mpsc::unbounded_channel();
        let (audio, audio_rx) = mpsc::channel(INPUT_QUEUE_FRAMES);
        let (events, event_rx) = std::sync::mpsc::channel();
        let worker = thread::Builder::new()
            .name("berd-voice-gpt_live".into())
            .spawn(move || {
                let runtime = match tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                {
                    Ok(runtime) => runtime,
                    Err(error) => {
                        let _ = events.send(GptLiveEvent::Failed(error.to_string()));
                        return;
                    }
                };
                if let Err(error) =
                    runtime.block_on(run_inner(config, command_rx, audio_rx, &events))
                {
                    let _ = events.send(GptLiveEvent::Failed(error));
                }
                let _ = events.send(GptLiveEvent::Closed);
            })
            .map_err(|error| error.to_string())?;
        Ok((
            Self {
                commands,
                audio,
                worker: Some(worker),
            },
            event_rx,
        ))
    }

    pub fn send(&self, command: GptLiveCommand) -> Result<(), String> {
        match command {
            GptLiveCommand::InputPcm48Khz(samples) => {
                self.audio.try_send(samples).map_err(|error| match error {
                    mpsc::error::TrySendError::Full(_) => "GptLive input queue is full".into(),
                    mpsc::error::TrySendError::Closed(_) => "GptLive runtime is closed".into(),
                })
            }
            command => self
                .commands
                .send(command)
                .map_err(|_| "GptLive runtime is closed".into()),
        }
    }

    pub fn reset_input(&self) -> Result<(), String> {
        let (completed, result) = std::sync::mpsc::sync_channel(1);
        self.send(GptLiveCommand::ResetInput { completed })?;
        result
            .recv_timeout(std::time::Duration::from_secs(5))
            .map_err(|_| "GptLive input reset timed out".to_string())?
    }

    pub fn abort_input_cutover(&self) -> Result<(), String> {
        let (completed, result) = std::sync::mpsc::sync_channel(1);
        self.send(GptLiveCommand::AbortInputCutover { completed })?;
        result
            .recv_timeout(std::time::Duration::from_secs(5))
            .map_err(|_| "GptLive input cutover abort timed out".to_string())?
    }

    pub fn finish(mut self) -> Result<(), String> {
        let _ = self.commands.send(GptLiveCommand::Shutdown);
        self.worker
            .take()
            .expect("GptLive worker exists")
            .join()
            .map_err(|_| "GptLive runtime panicked".to_string())
    }

    pub fn retire_in_background(mut self) {
        self.begin_background_retirement();
    }

    fn begin_background_retirement(&mut self) {
        if let Some(worker) = self.worker.take() {
            let _ = self.commands.send(GptLiveCommand::Shutdown);
            reap_gpt_live_worker(worker, self.audio.clone());
        }
    }
}

impl Drop for OpenAiGptLiveRuntime {
    fn drop(&mut self) {
        self.begin_background_retirement();
    }
}

fn reap_gpt_live_worker(
    worker: thread::JoinHandle<()>,
    audio_lifetime: mpsc::Sender<Vec<f32>>,
) {
    let _ = thread::Builder::new()
        .name("berd-voice-gpt_live-reaper".into())
        .spawn(move || {
            let _ = worker.join();
            drop(audio_lifetime);
        });
}

async fn run_inner(
    config: OpenAiGptLiveConfig,
    commands: mpsc::UnboundedReceiver<GptLiveCommand>,
    audio: mpsc::Receiver<Vec<f32>>,
    events: &std::sync::mpsc::Sender<GptLiveEvent>,
) -> Result<(), String> {
    run_live_inner(config, commands, audio, events).await
}

async fn run_live_inner(
    mut config: OpenAiGptLiveConfig,
    mut commands: mpsc::UnboundedReceiver<GptLiveCommand>,
    mut audio: mpsc::Receiver<Vec<f32>>,
    events: &std::sync::mpsc::Sender<GptLiveEvent>,
) -> Result<(), String> {
    if let Err(existing) = rustls::crypto::aws_lc_rs::default_provider().install_default() {
        drop(existing);
    }
    let mut request = config
        .endpoint
        .as_str()
        .into_client_request()
        .map_err(|error| format!("prepare OpenAI Live connection: {error}"))?;
    request.headers_mut().insert(
        "Authorization",
        format!("Bearer {}", config.api_key)
            .parse()
            .map_err(|_| "OpenAI API key is not a valid header value")?,
    );
    let (mut socket, _) = tokio::select! {
        result = tokio::time::timeout(
            Duration::from_secs(30),
            tokio_tungstenite::connect_async(request),
        ) => result
            .map_err(|_| "connect OpenAI Live timed out".to_string())?
            .map_err(|error| format!("connect OpenAI Live: {error}"))?,
        command = commands.recv() => match command {
            Some(GptLiveCommand::Shutdown) | None => return Ok(()),
            Some(_) => return Err("GptLive command arrived before readiness".into()),
        }
    };
    send_json(&mut socket, gpt_live_session_update(&config.session)).await?;

    let mut ready = false;
    let mut closing = false;
    let mut close_deadline = None;
    let mut current_response: Option<(String, String)> = None;
    let mut next_response_id = 1_u64;

    loop {
        tokio::select! {
            _ = async {
                match close_deadline {
                    Some(deadline) => tokio::time::sleep_until(deadline).await,
                    None => std::future::pending().await,
                }
            }, if close_deadline.is_some() => {
                let _ = socket.close(None).await;
                return Ok(());
            }
            samples = audio.recv(), if ready && !closing => {
                let Some(samples) = samples else {
                    return Err("GptLive input queue is closed".into());
                };
                send_live_audio(&mut socket, &samples).await?;
            }
            command = commands.recv(), if !closing => {
                match command {
                    Some(GptLiveCommand::Provider(event)) => send_json(&mut socket, event).await?,
                    Some(GptLiveCommand::InputPcm48Khz(samples)) => {
                        send_live_audio(&mut socket, &samples).await?;
                    }
                    Some(GptLiveCommand::ResetInput { completed }) => {
                        let _ = completed.send(Ok(()));
                    }
                    Some(GptLiveCommand::BeginInputCutover { request_id }) => {
                        send_event(events, GptLiveEvent::InputCutoverFinished {
                            request_id,
                            result: Ok(()),
                        })?;
                    }
                    Some(GptLiveCommand::AbortInputCutover { completed }) => {
                        let _ = completed.send(Ok(()));
                    }
                    Some(GptLiveCommand::TruncateOutput {
                        response_id,
                        item_id,
                        content_index,
                        ..
                    }) => {
                        send_event(events, GptLiveEvent::OutputTruncated {
                            response_id,
                            item_id,
                            content_index,
                        })?;
                    }
                    Some(GptLiveCommand::Shutdown) | None => {
                        commands.close();
                        audio.close();
                        send_json(&mut socket, serde_json::json!({ "type": "session.close" })).await?;
                        closing = true;
                        close_deadline = Some(tokio::time::Instant::now() + Duration::from_secs(5));
                    }
                }
            }
            message = socket.next() => {
                let text = match message {
                    Some(Ok(Message::Text(text))) => text,
                    Some(Ok(Message::Close(_))) | None if closing => return Ok(()),
                    Some(Ok(Message::Close(_))) | None => {
                        send_event(events, GptLiveEvent::SessionLost(
                            "OpenAI Live connection closed unexpectedly".into(),
                        ))?;
                        return Ok(());
                    }
                    Some(Ok(_)) => continue,
                    Some(Err(error)) => return Err(format!("OpenAI Live transport failed: {error}")),
                };
                let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else {
                    continue;
                };
                let kind = string(&value, "type").unwrap_or_default();
                if kind != "session.output_audio.delta" {
                    send_event(events, GptLiveEvent::Provider(value.clone()))?;
                }
                if kind == "error" {
                    let message = value
                        .pointer("/error/message")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or("OpenAI Live failed")
                        .to_string();
                    return Err(message);
                }
                match kind {
                    "session.started" => {
                        validate_effective_session(&value, &config)?;
                        for turn in std::mem::take(&mut config.semantic_transcript) {
                            send_json(&mut socket, live_seed_event(turn, next_response_id)).await?;
                            next_response_id = next_response_id.saturating_add(1);
                        }
                        ready = true;
                        send_event(events, GptLiveEvent::Ready)?;
                    }
                    "session.input_transcript.delta" => {
                        finish_live_response(events, &mut current_response)?;
                    }
                    "session.output_audio.delta" => {
                        let (response_id, item_id) = ensure_live_response(
                            events,
                            &mut current_response,
                            &mut next_response_id,
                        )?;
                        if let Some(delta) = string(&value, "delta") {
                            let bytes = BASE64
                                .decode(delta)
                                .map_err(|error| format!("decode GptLive audio: {error}"))?;
                            let samples = pcm16_samples(&bytes)?;
                            send_event(events, GptLiveEvent::AudioDelta {
                                response_id,
                                item_id,
                                output_index: 0,
                                content_index: 0,
                                samples,
                            })?;
                        }
                    }
                    "output_audio_buffer.stopped" | "session.delegation.created" => {
                        finish_live_response(events, &mut current_response)?;
                    }
                    "session.closed" => return Ok(()),
                    _ => {}
                }
            }
        }
    }
}

fn finish_live_response(
    events: &std::sync::mpsc::Sender<GptLiveEvent>,
    current: &mut Option<(String, String)>,
) -> Result<(), String> {
    if let Some((response_id, _)) = current.take() {
        send_event(events, GptLiveEvent::ResponseFinished {
            response_id,
            status: GptLiveResponseStatus::Completed,
        })?;
    }
    Ok(())
}

fn ensure_live_response(
    events: &std::sync::mpsc::Sender<GptLiveEvent>,
    current: &mut Option<(String, String)>,
    next_id: &mut u64,
) -> Result<(String, String), String> {
    if current.is_none() {
        let response_id = format!("live-output-{next_id}");
        let item_id = format!("live-output-item-{next_id}");
        *next_id = next_id.saturating_add(1);
        send_event(events, GptLiveEvent::ResponseStarted {
            response_id: response_id.clone(),
        })?;
        *current = Some((response_id, item_id));
    }
    Ok(current.clone().expect("live response exists"))
}

async fn send_live_audio<S>(
    socket: &mut tokio_tungstenite::WebSocketStream<S>,
    samples: &[f32],
) -> Result<(), String>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let pcm = downsample_pcm16(samples);
    send_json(
        socket,
        serde_json::json!({
            "type": "session.input_audio.append",
            "audio": BASE64.encode(pcm),
        }),
    )
    .await
}

fn live_seed_event(turn: SemanticTurn, event_id: u64) -> serde_json::Value {
    let content = match turn {
        SemanticTurn::User(text) => format!("Earlier in this conversation, the user said: {text}"),
        SemanticTurn::GptLive { text, interrupted } => format!(
            "Earlier in this conversation, I said: {text}{}",
            if interrupted { " (The user may have interrupted this.)" } else { "" }
        ),
        SemanticTurn::Backend(text) => format!("Durable backend context from earlier: {text}"),
    };
    let mut end = content.len().min(500);
    while !content.is_char_boundary(end) {
        end -= 1;
    }
    serde_json::json!({
        "event_id": format!("berd-live-seed-{event_id}"),
        "type": "session.thinking.append",
        "delegation_id": null,
        "content": &content[..end],
    })
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
        return Err("GptLive audio contained a partial PCM16 frame".into());
    }
    Ok(bytes
        .chunks_exact(2)
        .map(|sample| f32::from(i16::from_le_bytes([sample[0], sample[1]])) / f32::from(i16::MAX))
        .collect())
}

fn string<'a>(value: &'a serde_json::Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(|value| value.as_str())
}

fn send_event(
    events: &std::sync::mpsc::Sender<GptLiveEvent>,
    event: GptLiveEvent,
) -> Result<(), String> {
    events
        .send(event)
        .map_err(|_| "GptLive event consumer closed".into())
}
