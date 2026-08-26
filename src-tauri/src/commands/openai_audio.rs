//! OpenAI streaming speech playback for voice conversations.

use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    },
    time::{Duration, Instant},
};

use futures_util::StreamExt;
use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION, CONTENT_TYPE};
use serde::Serialize;
use serde_json::json;
use tauri::{AppHandle, Emitter, State};

#[cfg(target_os = "macos")]
use super::{
    native_voice::{InterruptionSensitivity, NativeVoiceState},
    pocket_audio_player::PocketAudioPlayer,
    pocket_voice::{effective_output_device_name, should_suppress_capture, VoiceInterruptionMode},
};

const DEFAULT_BASE_URL: &str = "https://api.openai.com/v1";
const DEFAULT_TTS_MODEL: &str = "gpt-4o-mini-tts";
const DEFAULT_TTS_VOICE: &str = "marin";
const TTS_SAMPLE_RATE: u32 = 24_000;
// Avoid starting the audio device from a tiny first network chunk that can drain
// before subsequent streamed PCM arrives.
const INITIAL_PLAYBACK_BUFFER_FRAMES: usize = TTS_SAMPLE_RATE as usize / 2;
const TTS_EVENT: &str = "openai-voice:stream-event";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(120);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_TTS_INPUT_CHARS: usize = 4096;

#[derive(Clone, Debug, Default)]
pub struct OpenAiVoiceState {
    playback: Arc<Mutex<PlaybackRuntime>>,
}

#[derive(Debug)]
struct PlaybackRuntime {
    active: Option<Arc<AtomicBool>>,
    stream: Option<ActiveOpenAiStream>,
    speed: f32,
}

impl Default for PlaybackRuntime {
    fn default() -> Self {
        Self {
            active: None,
            stream: None,
            speed: stored_playback_speed(),
        }
    }
}

#[derive(Debug)]
struct ActiveOpenAiStream {
    id: String,
    sender: mpsc::Sender<OpenAiStreamCommand>,
}

#[derive(Debug)]
enum OpenAiStreamCommand {
    Append(String),
    Flush,
    Finish,
    Stop,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenAiVoiceStatus {
    configured: bool,
    speech_model: String,
    speech_voice: String,
    playback_speed: f32,
    tts_available: bool,
    unavailable_reason: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenAiVoiceStreamEvent {
    stream_id: String,
    state: OpenAiStreamEventState,
    error: Option<String>,
    delivery: Option<VoiceDeliveryProgress>,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
enum OpenAiStreamEventState {
    Started,
    Progress,
    Completed,
    Interrupted,
    Failed,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct VoiceDeliveryProgress {
    sample_rate: u32,
    segments: Vec<VoiceDeliverySegment>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct VoiceDeliverySegment {
    text: String,
    played_frames: u64,
    total_frames: u64,
    synthesis_complete: bool,
}

fn env_trimmed(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn goose_openai_api_key() -> Result<Option<String>, String> {
    if let Some(value) = env_trimmed("OPENAI_API_KEY") {
        return Ok(Some(value));
    }
    #[cfg(target_os = "macos")]
    {
        let entry = keyring::Entry::new("goose", "secrets").map_err(|error| {
            format!("Could not access Goose's secure credential store: {error}")
        })?;
        match entry.get_password() {
            Ok(payload) => {
                let secrets: serde_json::Value =
                    serde_json::from_str(&payload).map_err(|error| {
                        format!("Goose's secure credential store is not valid JSON: {error}")
                    })?;
                return Ok(secrets
                    .get("OPENAI_API_KEY")
                    .and_then(serde_json::Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(ToString::to_string));
            }
            Err(keyring::Error::NoEntry) => {}
            Err(error) => {
                return Err(format!(
                    "Could not read Goose's OpenAI credential from secure storage: {error}"
                ));
            }
        }
    }
    let config_path = crate::services::goose_config::config_path()?;
    let secrets_path = config_path
        .parent()
        .ok_or_else(|| "Could not resolve Goose's credential directory".to_string())?
        .join("secrets.yaml");
    if !secrets_path.exists() {
        return Ok(None);
    }
    let payload = std::fs::read_to_string(&secrets_path)
        .map_err(|error| format!("Could not read Goose's credential file: {error}"))?;
    let secrets: serde_json::Value = yaml_serde::from_str(&payload)
        .map_err(|error| format!("Goose's credential file is invalid: {error}"))?;
    Ok(secrets
        .get("OPENAI_API_KEY")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string))
}

fn base_url() -> String {
    env_trimmed("OPENAI_BASE_URL").unwrap_or_else(|| DEFAULT_BASE_URL.to_string())
}

fn speech_model() -> String {
    env_trimmed("OPENAI_TTS_MODEL").unwrap_or_else(|| DEFAULT_TTS_MODEL.to_string())
}

fn speech_voice() -> String {
    env_trimmed("OPENAI_TTS_VOICE").unwrap_or_else(|| DEFAULT_TTS_VOICE.to_string())
}

fn endpoint(path: &str) -> Result<String, String> {
    let mut url = base_url();
    while url.ends_with('/') {
        url.pop();
    }
    let path = path.trim_start_matches('/');
    let full = format!("{url}/{path}");
    reqwest::Url::parse(&full)
        .map(|_| full)
        .map_err(|error| format!("OpenAI voice endpoint is invalid: {error}"))
}

fn authorized_headers(key: &str) -> Result<HeaderMap, String> {
    let mut headers = HeaderMap::new();
    let bearer = format!("Bearer {key}");
    headers.insert(
        AUTHORIZATION,
        HeaderValue::from_str(&bearer).map_err(|_| "OpenAI API key is not a valid header value")?,
    );
    Ok(headers)
}

fn speed_settings_path() -> Result<std::path::PathBuf, String> {
    Ok(crate::services::goose_config::config_path()?
        .parent()
        .ok_or_else(|| "Could not resolve Goose's configuration directory".to_string())?
        .join("openai-voice-settings.json"))
}

fn stored_playback_speed() -> f32 {
    speed_settings_path()
        .ok()
        .and_then(|path| std::fs::read(path).ok())
        .and_then(|data| serde_json::from_slice::<serde_json::Value>(&data).ok())
        .and_then(|value| value.get("playbackSpeed")?.as_f64())
        .map(|speed| speed as f32)
        .filter(|speed| speed.is_finite() && (0.75..=2.0).contains(speed))
        .unwrap_or(1.0)
}

fn persist_playback_speed(speed: f32) -> Result<(), String> {
    let path = speed_settings_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("create OpenAI voice settings directory: {error}"))?;
    }
    std::fs::write(
        &path,
        serde_json::to_vec_pretty(&json!({ "playbackSpeed": speed })).unwrap(),
    )
    .map_err(|error| format!("write OpenAI voice settings: {error}"))
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|error| format!("create OpenAI HTTP client: {error}"))
}

#[tauri::command]
pub fn get_openai_voice_status(
    state: State<'_, OpenAiVoiceState>,
    configured: bool,
) -> Result<OpenAiVoiceStatus, String> {
    let playback_speed = state
        .playback
        .lock()
        .map_err(|_| "OpenAI voice playback state lock was poisoned".to_string())?
        .speed;
    let tts_available = cfg!(target_os = "macos");
    Ok(OpenAiVoiceStatus {
        configured,
        speech_model: speech_model(),
        speech_voice: speech_voice(),
        playback_speed,
        tts_available,
        unavailable_reason: if !configured {
            Some("Configure the OpenAI provider in Berd to use OpenAI voice.".to_string())
        } else if !tts_available {
            Some("OpenAI voice playback is currently supported on macOS only.".to_string())
        } else {
            None
        },
    })
}

#[tauri::command]
pub fn start_openai_voice_stream(
    app: AppHandle,
    state: State<'_, OpenAiVoiceState>,
    native_voice: State<'_, NativeVoiceState>,
    stream_id: String,
    interruption_mode: VoiceInterruptionMode,
    interruption_sensitivity: InterruptionSensitivity,
) -> Result<(), String> {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (
            app,
            state,
            native_voice,
            stream_id,
            interruption_mode,
            interruption_sensitivity,
        );
        Err("OpenAI voice playback is currently supported on macOS only".to_string())
    }

    #[cfg(target_os = "macos")]
    {
        if stream_id.trim().is_empty() {
            return Err("OpenAI voice stream id cannot be empty".to_string());
        }
        let key = api_key()?;
        let (sender, receiver) = mpsc::channel();
        let active = Arc::new(AtomicBool::new(true));
        {
            let mut playback = state
                .playback
                .lock()
                .map_err(|_| "OpenAI voice playback state lock was poisoned".to_string())?;
            if playback.active.is_some() {
                return Err("OpenAI voice playback is already active".to_string());
            }
            playback.active = Some(active.clone());
            playback.stream = Some(ActiveOpenAiStream {
                id: stream_id.clone(),
                sender,
            });
        }
        let speed = state
            .playback
            .lock()
            .map_err(|_| "OpenAI voice playback state lock was poisoned".to_string())?
            .speed;
        let playback = state.playback.clone();
        let native_voice = native_voice.inner().clone();
        tauri::async_runtime::spawn_blocking(move || {
            let result = run_openai_voice_stream(
                &app,
                &stream_id,
                key,
                active.clone(),
                receiver,
                native_voice,
                interruption_mode,
                interruption_sensitivity,
                speed,
            );
            if let Ok(mut playback) = playback.lock() {
                playback.active = None;
                playback.stream = None;
            }
            let (state, error, delivery) = match result {
                Ok(outcome) => (outcome.state, None, outcome.delivery),
                Err(failure) if !active.load(Ordering::SeqCst) => {
                    (OpenAiStreamEventState::Interrupted, None, failure.delivery)
                }
                Err(failure) => (
                    OpenAiStreamEventState::Failed,
                    Some(failure.error),
                    failure.delivery,
                ),
            };
            emit_openai_stream_event(&app, &stream_id, state, error, delivery);
        });
        Ok(())
    }
}

#[tauri::command]
pub fn append_openai_voice_stream(
    state: State<'_, OpenAiVoiceState>,
    stream_id: String,
    text: String,
) -> Result<(), String> {
    if text.is_empty() {
        return Ok(());
    }
    send_stream_command(&state, &stream_id, OpenAiStreamCommand::Append(text))
}

#[tauri::command]
pub fn flush_openai_voice_stream(
    state: State<'_, OpenAiVoiceState>,
    stream_id: String,
) -> Result<(), String> {
    send_stream_command(&state, &stream_id, OpenAiStreamCommand::Flush)
}

#[tauri::command]
pub fn finish_openai_voice_stream(
    state: State<'_, OpenAiVoiceState>,
    stream_id: String,
) -> Result<(), String> {
    send_stream_command(&state, &stream_id, OpenAiStreamCommand::Finish)
}

#[tauri::command]
pub fn set_openai_playback_speed(
    state: State<'_, OpenAiVoiceState>,
    speed: f32,
) -> Result<(), String> {
    if !speed.is_finite() || !(0.75..=2.0).contains(&speed) {
        return Err("OpenAI playback speed must be between 0.75 and 2.0".to_string());
    }
    persist_playback_speed(speed)?;
    state
        .playback
        .lock()
        .map_err(|_| "OpenAI voice playback state lock was poisoned".to_string())?
        .speed = speed;
    Ok(())
}

pub(crate) fn stop_openai_voice_inner(state: &OpenAiVoiceState) -> Result<bool, String> {
    let playback = state
        .playback
        .lock()
        .map_err(|_| "OpenAI voice playback state lock was poisoned".to_string())?;
    let Some(active) = playback.active.as_ref() else {
        return Ok(false);
    };
    active.store(false, Ordering::SeqCst);
    if let Some(stream) = playback.stream.as_ref() {
        let _ = stream.sender.send(OpenAiStreamCommand::Stop);
    }
    Ok(true)
}

#[tauri::command]
pub fn stop_openai_voice(state: State<'_, OpenAiVoiceState>) -> Result<bool, String> {
    stop_openai_voice_inner(&state)
}

fn send_stream_command(
    state: &OpenAiVoiceState,
    stream_id: &str,
    command: OpenAiStreamCommand,
) -> Result<(), String> {
    let playback = state
        .playback
        .lock()
        .map_err(|_| "OpenAI voice playback state lock was poisoned".to_string())?;
    let stream = playback
        .stream
        .as_ref()
        .filter(|stream| stream.id == stream_id)
        .ok_or_else(|| format!("OpenAI voice stream is not active: {stream_id}"))?;
    stream
        .sender
        .send(command)
        .map_err(|_| format!("OpenAI voice stream worker stopped: {stream_id}"))
}

#[cfg(target_os = "macos")]
struct StreamOutcome {
    state: OpenAiStreamEventState,
    delivery: Option<VoiceDeliveryProgress>,
}

#[cfg(target_os = "macos")]
struct StreamFailure {
    error: String,
    delivery: Option<VoiceDeliveryProgress>,
}

#[cfg(target_os = "macos")]
impl From<String> for StreamFailure {
    fn from(error: String) -> Self {
        Self {
            error,
            delivery: None,
        }
    }
}

#[cfg(target_os = "macos")]
#[allow(clippy::too_many_arguments)] // Stream worker keeps lifecycle and playback policy explicit.
fn run_openai_voice_stream(
    app: &AppHandle,
    stream_id: &str,
    key: String,
    active: Arc<AtomicBool>,
    receiver: mpsc::Receiver<OpenAiStreamCommand>,
    native_voice: NativeVoiceState,
    interruption_mode: VoiceInterruptionMode,
    interruption_sensitivity: InterruptionSensitivity,
    speed: f32,
) -> Result<StreamOutcome, StreamFailure> {
    run_openai_voice_stream_inner(
        app,
        stream_id,
        key,
        active,
        receiver,
        native_voice,
        interruption_mode,
        interruption_sensitivity,
        speed,
    )
}

#[cfg(target_os = "macos")]
#[allow(clippy::too_many_arguments)]
fn run_openai_voice_stream_inner(
    app: &AppHandle,
    stream_id: &str,
    key: String,
    active: Arc<AtomicBool>,
    receiver: mpsc::Receiver<OpenAiStreamCommand>,
    native_voice: NativeVoiceState,
    interruption_mode: VoiceInterruptionMode,
    interruption_sensitivity: InterruptionSensitivity,
    speed: f32,
) -> Result<StreamOutcome, StreamFailure> {
    let client = client()?;
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|error| format!("Could not initialize OpenAI speech runtime: {error}"))?;
    let player = PocketAudioPlayer::new(TTS_SAMPLE_RATE, 1.0, None)?;
    let output_device = effective_output_device_name(None);
    let suppress_capture = should_suppress_capture(interruption_mode, output_device.as_deref());
    let _assistant_speech =
        native_voice.begin_assistant_speech(interruption_sensitivity, suppress_capture);
    let mut pending = String::new();
    let mut delivery = VoiceDeliveryProgress {
        sample_rate: TTS_SAMPLE_RATE,
        segments: Vec::new(),
    };
    let mut started = false;
    let mut last_progress = Instant::now();

    loop {
        if !active.load(Ordering::SeqCst) {
            player.stop();
            return Ok(StreamOutcome {
                state: OpenAiStreamEventState::Interrupted,
                delivery: Some(snapshot_delivery(&delivery, &player)),
            });
        }
        match receiver.recv_timeout(Duration::from_millis(20)) {
            Ok(OpenAiStreamCommand::Append(text)) => {
                pending.push_str(&text);
                if pending.len() >= 24 && pending.trim_end().ends_with(['.', '!', '?', '\n']) {
                    speak_pending(
                        &runtime,
                        app,
                        stream_id,
                        &client,
                        &key,
                        &active,
                        &player,
                        &mut pending,
                        &mut delivery,
                        &mut started,
                        speed,
                    )
                    .map_err(|error| StreamFailure {
                        error,
                        delivery: Some(snapshot_delivery(&delivery, &player)),
                    })?;
                }
            }
            Ok(OpenAiStreamCommand::Flush) => {
                speak_pending(
                    &runtime,
                    app,
                    stream_id,
                    &client,
                    &key,
                    &active,
                    &player,
                    &mut pending,
                    &mut delivery,
                    &mut started,
                    speed,
                )
                .map_err(|error| StreamFailure {
                    error,
                    delivery: Some(snapshot_delivery(&delivery, &player)),
                })?;
            }
            Ok(OpenAiStreamCommand::Finish) => {
                speak_pending(
                    &runtime,
                    app,
                    stream_id,
                    &client,
                    &key,
                    &active,
                    &player,
                    &mut pending,
                    &mut delivery,
                    &mut started,
                    speed,
                )?;
                while active.load(Ordering::SeqCst) && !player.is_empty() {
                    player.ensure_healthy()?;
                    if last_progress.elapsed() >= Duration::from_millis(100) {
                        emit_openai_stream_event(
                            app,
                            stream_id,
                            OpenAiStreamEventState::Progress,
                            None,
                            Some(snapshot_delivery(&delivery, &player)),
                        );
                        last_progress = Instant::now();
                    }
                    std::thread::sleep(Duration::from_millis(20));
                }
                if !active.load(Ordering::SeqCst) {
                    player.stop();
                    return Ok(StreamOutcome {
                        state: OpenAiStreamEventState::Interrupted,
                        delivery: Some(snapshot_delivery(&delivery, &player)),
                    });
                }
                return Ok(StreamOutcome {
                    state: OpenAiStreamEventState::Completed,
                    delivery: None,
                });
            }
            Ok(OpenAiStreamCommand::Stop) | Err(mpsc::RecvTimeoutError::Disconnected) => {
                active.store(false, Ordering::SeqCst);
                player.stop();
                return Ok(StreamOutcome {
                    state: OpenAiStreamEventState::Interrupted,
                    delivery: Some(snapshot_delivery(&delivery, &player)),
                });
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if started && last_progress.elapsed() >= Duration::from_millis(100) {
                    emit_openai_stream_event(
                        app,
                        stream_id,
                        OpenAiStreamEventState::Progress,
                        None,
                        Some(snapshot_delivery(&delivery, &player)),
                    );
                    last_progress = Instant::now();
                }
            }
        }
    }
}

#[cfg(target_os = "macos")]
#[allow(clippy::too_many_arguments)]
fn speak_pending(
    runtime: &tokio::runtime::Runtime,
    app: &AppHandle,
    stream_id: &str,
    client: &reqwest::Client,
    key: &str,
    active: &AtomicBool,
    player: &PocketAudioPlayer,
    pending: &mut String,
    delivery: &mut VoiceDeliveryProgress,
    started: &mut bool,
    speed: f32,
) -> Result<(), String> {
    let text = std::mem::take(pending).trim().to_string();
    if text.is_empty() {
        return Ok(());
    }
    for chunk in chunk_text(&text, MAX_TTS_INPUT_CHARS) {
        if !active.load(Ordering::SeqCst) {
            return Ok(());
        }
        let mut segment_frames = 0_u64;
        delivery.segments.push(VoiceDeliverySegment {
            text: chunk.to_string(),
            played_frames: 0,
            total_frames: 0,
            synthesis_complete: false,
        });
        let mut bytes =
            runtime.block_on(openai_speech_stream(client, key, chunk.to_string(), speed))?;
        let mut pcm_remainder = Vec::<u8>::new();
        let mut initial_samples = Vec::<f32>::new();
        loop {
            if !active.load(Ordering::SeqCst) {
                return Ok(());
            }
            let item = runtime.block_on(async {
                tokio::time::timeout(Duration::from_millis(50), bytes.next()).await
            });
            let Some(item) = (match item {
                Ok(item) => item,
                Err(_) => continue,
            }) else {
                break;
            };
            let item =
                item.map_err(|error| format_openai_request_error("stream speech audio", error))?;
            if !active.load(Ordering::SeqCst) {
                return Ok(());
            }
            pcm_remainder.extend_from_slice(&item);
            let sample_bytes = pcm_remainder.len() / 2 * 2;
            let samples = pcm16le_to_f32(&pcm_remainder[..sample_bytes]);
            pcm_remainder.drain(..sample_bytes);
            if *started {
                player.enqueue(&samples)?;
            } else {
                initial_samples.extend_from_slice(&samples);
                if initial_samples.len() >= INITIAL_PLAYBACK_BUFFER_FRAMES {
                    player.enqueue(&initial_samples)?;
                    initial_samples.clear();
                    *started = true;
                    emit_openai_stream_event(
                        app,
                        stream_id,
                        OpenAiStreamEventState::Started,
                        None,
                        None,
                    );
                }
            }
            segment_frames = segment_frames.saturating_add(samples.len() as u64);
            upsert_delivery_segment(delivery, chunk, segment_frames, false);
        }
        if !pcm_remainder.is_empty() {
            return Err("OpenAI speech returned an incomplete PCM sample".to_string());
        }
        if !initial_samples.is_empty() {
            player.enqueue(&initial_samples)?;
            if !*started {
                *started = true;
                emit_openai_stream_event(
                    app,
                    stream_id,
                    OpenAiStreamEventState::Started,
                    None,
                    None,
                );
            }
        }
        upsert_delivery_segment(delivery, chunk, segment_frames, true);
    }
    Ok(())
}

#[cfg(target_os = "macos")]
async fn openai_speech_stream(
    client: &reqwest::Client,
    key: &str,
    input: String,
    speed: f32,
) -> Result<impl futures_util::Stream<Item = Result<bytes::Bytes, reqwest::Error>>, String> {
    let response = client
        .post(endpoint("audio/speech")?)
        .headers(authorized_headers(key)?)
        .header(CONTENT_TYPE, "application/json")
        .json(&json!({
            "model": speech_model(),
            "voice": speech_voice(),
            "input": input,
            "speed": speed,
            "response_format": "pcm",
            "stream_format": "audio"
        }))
        .send()
        .await
        .map_err(|error| format_openai_request_error("start speech audio", error))?;
    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(format_openai_response_error(
            "start speech audio",
            status,
            &body,
        ));
    }
    Ok(response.bytes_stream())
}

#[cfg(target_os = "macos")]
fn chunk_text(text: &str, max_chars: usize) -> Vec<&str> {
    let mut chunks = Vec::new();
    let mut start = 0;
    while start < text.len() {
        let mut end = (start + max_chars).min(text.len());
        while end > start && !text.is_char_boundary(end) {
            end -= 1;
        }
        if end == start {
            end = text.len();
        }
        chunks.push(text[start..end].trim());
        start = end;
    }
    chunks
        .into_iter()
        .filter(|chunk| !chunk.is_empty())
        .collect()
}

#[cfg(target_os = "macos")]
fn pcm16le_to_f32(bytes: &[u8]) -> Vec<f32> {
    bytes
        .chunks_exact(2)
        .map(|sample| i16::from_le_bytes([sample[0], sample[1]]) as f32 / i16::MAX as f32)
        .collect()
}

#[cfg(target_os = "macos")]
fn upsert_delivery_segment(
    delivery: &mut VoiceDeliveryProgress,
    _text: &str,
    total_frames: u64,
    synthesis_complete: bool,
) {
    if let Some(segment) = delivery.segments.last_mut() {
        segment.total_frames = total_frames;
        segment.synthesis_complete = synthesis_complete;
    }
}

#[cfg(target_os = "macos")]
fn snapshot_delivery(
    delivery: &VoiceDeliveryProgress,
    player: &PocketAudioPlayer,
) -> VoiceDeliveryProgress {
    let mut remaining_played = player.played_frames();
    let segments = delivery
        .segments
        .iter()
        .map(|segment| {
            let played_frames = remaining_played.min(segment.total_frames);
            remaining_played = remaining_played.saturating_sub(played_frames);
            VoiceDeliverySegment {
                text: segment.text.clone(),
                played_frames,
                total_frames: segment.total_frames,
                synthesis_complete: segment.synthesis_complete,
            }
        })
        .collect();
    VoiceDeliveryProgress {
        sample_rate: delivery.sample_rate,
        segments,
    }
}

fn emit_openai_stream_event(
    app: &AppHandle,
    stream_id: &str,
    state: OpenAiStreamEventState,
    error: Option<String>,
    delivery: Option<VoiceDeliveryProgress>,
) {
    let _ = app.emit(
        TTS_EVENT,
        OpenAiVoiceStreamEvent {
            stream_id: stream_id.to_string(),
            state,
            error,
            delivery,
        },
    );
}

fn format_openai_request_error(action: &str, error: reqwest::Error) -> String {
    if error.is_timeout() {
        format!("OpenAI voice could not {action}: the request timed out")
    } else if error.is_connect() {
        format!("OpenAI voice could not {action}: check your network connection")
    } else {
        format!("OpenAI voice could not {action}: {error}")
    }
}

fn format_openai_response_error(action: &str, status: reqwest::StatusCode, body: &str) -> String {
    let preview: String = body.chars().take(500).collect();
    format!("OpenAI voice could not {action}: HTTP {status}: {preview}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "macos")]
    #[test]
    fn chunks_tts_text_on_char_boundaries() {
        assert_eq!(chunk_text("hello", 10), vec!["hello"]);
        assert_eq!(chunk_text("ééé", 3), vec!["é", "é", "é"]);
    }
}
