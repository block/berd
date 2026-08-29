//! OpenAI realtime transcription configuration and streaming speech playback.

use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    mpsc, Arc, Mutex,
};
#[cfg(any(test, target_os = "macos"))]
use std::time::Duration;

#[cfg(target_os = "macos")]
use futures_util::StreamExt;
#[cfg(target_os = "macos")]
use reqwest::header::CONTENT_TYPE;
#[cfg(target_os = "macos")]
use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION};
use serde::Serialize;
use serde_json::json;
use tauri::Emitter;
use tauri::{AppHandle, State};

#[cfg(target_os = "macos")]
use super::{
    native_voice::AssistantSpeechGuard,
    pocket_audio_player::PocketAudioPlayer,
    pocket_voice::{
        effective_output_device_name, playback_latency_safety_duration, selected_output_device,
        should_suppress_capture,
    },
};
use super::{
    native_voice::{InterruptionSensitivity, NativeVoiceState},
    openai_voice_credentials::{self, OpenAiVoiceCredential},
    pocket_voice::VoiceInterruptionMode,
    voice_capture::VoiceCaptureState,
};
#[cfg(any(test, target_os = "macos"))]
use std::time::Instant;

const DEFAULT_BASE_URL: &str = "https://api.openai.com/v1";
const DEFAULT_TRANSCRIPTION_MODEL: &str = "gpt-live-transcribe";
const DEFAULT_TTS_MODEL: &str = "gpt-4o-mini-tts";
const DEFAULT_TTS_VOICE: &str = "marin";
const BASE_URL_ENV: &str = "BERD_OPENAI_VOICE_BASE_URL";
const STT_MODEL_ENV: &str = "BERD_OPENAI_STT_MODEL";
const TTS_MODEL_ENV: &str = "BERD_OPENAI_TTS_MODEL";
const TTS_VOICE_ENV: &str = "BERD_OPENAI_TTS_VOICE";
const SETTINGS_CHANGED_EVENT: &str = "openai-voice:settings-changed";
#[cfg(target_os = "macos")]
const TTS_SAMPLE_RATE: u32 = 24_000;
// Avoid starting the audio device from a tiny first network chunk that can drain
// before subsequent streamed PCM arrives.
#[cfg(target_os = "macos")]
const INITIAL_PLAYBACK_BUFFER_FRAMES: usize = TTS_SAMPLE_RATE as usize / 5;
#[cfg(target_os = "macos")]
const TTS_EVENT: &str = "openai-voice:stream-event";
#[cfg(target_os = "macos")]
const STREAM_IDLE_TIMEOUT: Duration = Duration::from_secs(120);
#[cfg(target_os = "macos")]
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
#[cfg(target_os = "macos")]
const MAX_TTS_INPUT_CHARS: usize = 4096;
#[cfg(target_os = "macos")]
const MAX_FINAL_PLAYBACK_DRAIN: Duration = Duration::from_secs(600);

#[derive(Clone, Debug, Default)]
pub struct OpenAiVoiceState {
    playback: Arc<Mutex<PlaybackRuntime>>,
    configured: Arc<AtomicBool>,
    credential_revision: Arc<AtomicU64>,
}

impl OpenAiVoiceState {
    pub(crate) fn is_configured(&self) -> bool {
        self.configured.load(Ordering::Acquire)
    }
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
    owner_window: String,
    sender: mpsc::Sender<OpenAiStreamCommand>,
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
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
    stt_configured: bool,
    tts_configured: bool,
    stt_configuration_source: OpenAiVoiceConfigurationSource,
    tts_configuration_source: OpenAiVoiceConfigurationSource,
    stt_unavailable_reason: Option<String>,
    tts_unavailable_reason: Option<String>,
    transcription_model: String,
    speech_model: String,
    speech_voice: String,
    playback_speed: f32,
    tts_available: bool,
    unavailable_reason: Option<String>,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
enum OpenAiVoiceConfigurationSource {
    Default,
    Environment,
}

#[cfg(target_os = "macos")]
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenAiVoiceStreamEvent {
    stream_id: String,
    state: OpenAiStreamEventState,
    error: Option<String>,
    delivery: Option<VoiceDeliveryProgress>,
}

#[cfg(target_os = "macos")]
#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
enum OpenAiStreamEventState {
    Started,
    Progress,
    Completed,
    Interrupted,
    Failed,
}

#[cfg(target_os = "macos")]
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct VoiceDeliveryProgress {
    sample_rate: u32,
    segments: Vec<VoiceDeliverySegment>,
}

#[cfg(target_os = "macos")]
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

#[cfg(target_os = "macos")]
fn tts_api_key() -> Result<String, String> {
    openai_voice_credentials::require(OpenAiVoiceCredential::TextToSpeech)
}

pub(crate) fn stt_api_key() -> Result<String, String> {
    openai_voice_credentials::require(OpenAiVoiceCredential::SpeechToText)
}

fn normalize_openai_base_url(raw_url: String) -> Result<String, String> {
    let mut url = reqwest::Url::parse(&raw_url)
        .map_err(|error| format!("OpenAI voice endpoint is invalid: {error}"))?;
    if url.scheme() != "https" {
        return Err("OpenAI voice endpoint must use HTTPS".to_string());
    }
    let path = url.path().trim_end_matches('/').to_string();
    if path.is_empty() {
        let path = if path.ends_with("/v1") {
            path
        } else {
            format!("{path}/v1")
        };
        url.set_path(&path);
    } else {
        url.set_path(&path);
    }
    url.set_fragment(None);
    Ok(url.to_string().trim_end_matches('/').to_string())
}

fn base_url() -> Result<String, String> {
    if let Some(base_url) = env_trimmed(BASE_URL_ENV) {
        return normalize_openai_base_url(base_url);
    }
    Ok(DEFAULT_BASE_URL.to_string())
}

pub(crate) fn realtime_endpoint() -> Result<String, String> {
    let mut url = reqwest::Url::parse(&endpoint("realtime")?)
        .map_err(|error| format!("OpenAI realtime endpoint is invalid: {error}"))?;
    url.query_pairs_mut().append_pair("intent", "transcription");
    match url.scheme() {
        "http" => url.set_scheme("ws").expect("compatible scheme"),
        "https" => url.set_scheme("wss").expect("compatible scheme"),
        "ws" | "wss" => {}
        scheme => {
            return Err(format!(
                "OpenAI realtime endpoint has unsupported scheme: {scheme}"
            ))
        }
    }
    Ok(url.to_string())
}

pub(crate) fn transcription_model() -> String {
    env_trimmed(STT_MODEL_ENV).unwrap_or_else(|| DEFAULT_TRANSCRIPTION_MODEL.to_string())
}

fn speech_model() -> String {
    env_trimmed(TTS_MODEL_ENV).unwrap_or_else(|| DEFAULT_TTS_MODEL.to_string())
}

fn speech_voice() -> String {
    env_trimmed(TTS_VOICE_ENV).unwrap_or_else(|| DEFAULT_TTS_VOICE.to_string())
}

fn tts_configuration_source() -> OpenAiVoiceConfigurationSource {
    if [BASE_URL_ENV, TTS_MODEL_ENV, TTS_VOICE_ENV]
        .iter()
        .any(|name| env_trimmed(name).is_some())
    {
        OpenAiVoiceConfigurationSource::Environment
    } else {
        OpenAiVoiceConfigurationSource::Default
    }
}

fn stt_configuration_source() -> OpenAiVoiceConfigurationSource {
    if [BASE_URL_ENV, STT_MODEL_ENV]
        .iter()
        .any(|name| env_trimmed(name).is_some())
    {
        OpenAiVoiceConfigurationSource::Environment
    } else {
        OpenAiVoiceConfigurationSource::Default
    }
}

fn endpoint(path: &str) -> Result<String, String> {
    endpoint_for_base_url(&base_url()?, path)
}

fn endpoint_for_base_url(base_url: &str, path: &str) -> Result<String, String> {
    let mut url = reqwest::Url::parse(base_url)
        .map_err(|error| format!("OpenAI voice endpoint is invalid: {error}"))?;
    let base_path = url.path().trim_end_matches('/');
    url.set_path(&format!("{base_path}/{}", path.trim_start_matches('/')));
    Ok(url.to_string())
}

#[cfg(target_os = "macos")]
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

#[cfg(target_os = "macos")]
fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .build()
        .map_err(|error| format!("create OpenAI HTTP client: {error}"))
}

#[tauri::command]
pub async fn get_openai_voice_status(
    state: State<'_, OpenAiVoiceState>,
) -> Result<OpenAiVoiceStatus, String> {
    let playback_speed = state
        .playback
        .lock()
        .map_err(|_| "OpenAI voice playback state lock was poisoned".to_string())?
        .speed;
    let tts_available = cfg!(target_os = "macos");
    let credential_revision = state.credential_revision.load(Ordering::Acquire);
    let credential_result = tauri::async_runtime::spawn_blocking(move || {
        openai_voice_credentials::read(OpenAiVoiceCredential::SpeechToText)
    })
    .await
    .map_err(|error| format!("Could not check OpenAI voice credentials: {error}"))?;
    let credential_error = credential_result.as_ref().err().cloned();
    let stt_error = credential_error.clone();
    let tts_error = tts_available.then_some(credential_error).flatten();
    let stt_configured = credential_result.unwrap_or(None).is_some();
    let tts_configured = tts_available && stt_configured;
    if state.credential_revision.load(Ordering::Acquire) == credential_revision {
        state.configured.store(stt_configured, Ordering::Release);
    }
    Ok(OpenAiVoiceStatus {
        stt_configured,
        tts_configured,
        stt_configuration_source: stt_configuration_source(),
        tts_configuration_source: tts_configuration_source(),
        stt_unavailable_reason: stt_error,
        tts_unavailable_reason: tts_error,
        transcription_model: transcription_model(),
        speech_model: speech_model(),
        speech_voice: speech_voice(),
        playback_speed,
        tts_available,
        unavailable_reason: if !tts_available {
            Some("unsupportedPlatform".to_string())
        } else if !tts_configured {
            Some("missingApiKey".to_string())
        } else {
            None
        },
    })
}

#[tauri::command]
pub async fn set_openai_stt_api_key(
    app: AppHandle,
    state: State<'_, OpenAiVoiceState>,
    native_voice: State<'_, NativeVoiceState>,
    capture: State<'_, VoiceCaptureState>,
    api_key: String,
) -> Result<(), String> {
    let api_key = api_key.trim();
    if api_key.is_empty() {
        return Err("OpenAI speech-to-text API key cannot be empty".to_string());
    }
    native_voice
        .stop_active_then(&app, &capture, || {
            stop_openai_voice_inner(&state)?;
            openai_voice_credentials::store(OpenAiVoiceCredential::SpeechToText, api_key)?;
            state.credential_revision.fetch_add(1, Ordering::AcqRel);
            state.configured.store(true, Ordering::Release);
            app.emit(SETTINGS_CHANGED_EVENT, ())
                .map_err(|error| format!("Could not refresh OpenAI voice settings: {error}"))
        })
        .await
}

#[tauri::command]
pub async fn clear_openai_stt_api_key(
    app: AppHandle,
    state: State<'_, OpenAiVoiceState>,
    native_voice: State<'_, NativeVoiceState>,
    capture: State<'_, VoiceCaptureState>,
) -> Result<(), String> {
    native_voice
        .stop_active_then(&app, &capture, || {
            stop_openai_voice_inner(&state)?;
            openai_voice_credentials::clear(OpenAiVoiceCredential::SpeechToText)?;
            state.credential_revision.fetch_add(1, Ordering::AcqRel);
            state.configured.store(false, Ordering::Release);
            app.emit(SETTINGS_CHANGED_EVENT, ())
                .map_err(|error| format!("Could not refresh OpenAI voice settings: {error}"))
        })
        .await
}

#[tauri::command]
pub async fn set_openai_tts_api_key(
    app: AppHandle,
    state: State<'_, OpenAiVoiceState>,
    native_voice: State<'_, NativeVoiceState>,
    capture: State<'_, VoiceCaptureState>,
    api_key: String,
) -> Result<(), String> {
    let api_key = api_key.trim();
    if api_key.is_empty() {
        return Err("OpenAI text-to-speech API key cannot be empty".to_string());
    }
    native_voice
        .stop_active_then(&app, &capture, || {
            stop_openai_voice_inner(&state)?;
            openai_voice_credentials::store(OpenAiVoiceCredential::TextToSpeech, api_key)?;
            state.credential_revision.fetch_add(1, Ordering::AcqRel);
            state.configured.store(true, Ordering::Release);
            app.emit(SETTINGS_CHANGED_EVENT, ())
                .map_err(|error| format!("Could not refresh OpenAI voice settings: {error}"))
        })
        .await
}

#[tauri::command]
pub async fn clear_openai_tts_api_key(
    app: AppHandle,
    state: State<'_, OpenAiVoiceState>,
    native_voice: State<'_, NativeVoiceState>,
    capture: State<'_, VoiceCaptureState>,
) -> Result<(), String> {
    native_voice
        .stop_active_then(&app, &capture, || {
            stop_openai_voice_inner(&state)?;
            openai_voice_credentials::clear(OpenAiVoiceCredential::TextToSpeech)?;
            state.credential_revision.fetch_add(1, Ordering::AcqRel);
            state.configured.store(false, Ordering::Release);
            app.emit(SETTINGS_CHANGED_EVENT, ())
                .map_err(|error| format!("Could not refresh OpenAI voice settings: {error}"))
        })
        .await
}

#[tauri::command]
pub fn start_openai_voice_stream(
    app: AppHandle,
    webview_window: tauri::WebviewWindow,
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
            webview_window,
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
        let key = tts_api_key()?;
        let (sender, receiver) = mpsc::channel();
        let active = Arc::new(AtomicBool::new(true));
        {
            let mut playback = state
                .playback
                .lock()
                .map_err(|_| "OpenAI voice playback state lock was poisoned".to_string())?;
            if let Some(previous) = playback.active.as_ref() {
                previous.store(false, Ordering::SeqCst);
            }
            if let Some(previous) = playback.stream.as_ref() {
                let _ = previous.sender.send(OpenAiStreamCommand::Stop);
            }
            playback.active = Some(active.clone());
            playback.stream = Some(ActiveOpenAiStream {
                id: stream_id.clone(),
                owner_window: webview_window.label().to_string(),
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
                let still_owns_playback = playback
                    .active
                    .as_ref()
                    .is_some_and(|current| Arc::ptr_eq(current, &active));
                if still_owns_playback {
                    playback.active = None;
                    playback.stream = None;
                }
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

fn stop_openai_voice_for_owner(
    state: &OpenAiVoiceState,
    owner_window: Option<&str>,
) -> Result<bool, String> {
    let playback = state
        .playback
        .lock()
        .map_err(|_| "OpenAI voice playback state lock was poisoned".to_string())?;
    if owner_window.is_some_and(|owner| {
        playback
            .stream
            .as_ref()
            .is_none_or(|stream| stream.owner_window != owner)
    }) {
        return Ok(false);
    }
    let Some(active) = playback.active.as_ref() else {
        return Ok(false);
    };
    active.store(false, Ordering::SeqCst);
    if let Some(stream) = playback.stream.as_ref() {
        let _ = stream.sender.send(OpenAiStreamCommand::Stop);
    }
    Ok(true)
}

pub(crate) fn stop_openai_voice_inner(state: &OpenAiVoiceState) -> Result<bool, String> {
    stop_openai_voice_for_owner(state, None)
}

impl OpenAiVoiceState {
    pub(crate) fn stop_for_window_destroyed(&self, window_label: &str) -> bool {
        stop_openai_voice_for_owner(self, Some(window_label)).unwrap_or_else(|error| {
            log::warn!("Failed to stop OpenAI playback for a destroyed window: {error}");
            false
        })
    }
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
    let client = client()?;
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|error| format!("Could not initialize OpenAI speech runtime: {error}"))?;
    let configured_output_device = selected_output_device();
    let player = PocketAudioPlayer::new(TTS_SAMPLE_RATE, 1.0, configured_output_device.as_deref())?;
    let output_device = effective_output_device_name(configured_output_device.as_deref());
    let suppress_capture = should_suppress_capture(interruption_mode, output_device.as_deref());
    let output_latency_grace = playback_latency_safety_duration(output_device.as_deref());
    let mut assistant_speech = None::<AssistantSpeechGuard>;
    let mut playback_drained_at = None::<Instant>;
    let mut pending = String::new();
    let mut delivery = VoiceDeliveryProgress {
        sample_rate: TTS_SAMPLE_RATE,
        segments: Vec::new(),
    };
    let mut started = false;
    let mut last_progress = Instant::now();

    loop {
        if started {
            player.ensure_healthy().map_err(|error| StreamFailure {
                error,
                delivery: Some(snapshot_delivery(&delivery, &player)),
            })?;
        }
        update_openai_assistant_speech(
            player.is_empty(),
            &mut assistant_speech,
            &mut playback_drained_at,
            output_latency_grace,
            Instant::now(),
        );
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
                if pending.len() >= 24 && ends_sentence_boundary(&pending) {
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
                        &native_voice,
                        interruption_sensitivity,
                        suppress_capture,
                        &mut assistant_speech,
                        &mut playback_drained_at,
                        output_latency_grace,
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
                    &native_voice,
                    interruption_sensitivity,
                    suppress_capture,
                    &mut assistant_speech,
                    &mut playback_drained_at,
                    output_latency_grace,
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
                    &native_voice,
                    interruption_sensitivity,
                    suppress_capture,
                    &mut assistant_speech,
                    &mut playback_drained_at,
                    output_latency_grace,
                    speed,
                )
                .map_err(|error| StreamFailure {
                    error,
                    delivery: Some(snapshot_delivery(&delivery, &player)),
                })?;
                let drain_started = Instant::now();
                while active.load(Ordering::SeqCst)
                    && (!player.is_empty() || assistant_speech.is_some())
                {
                    if drain_started.elapsed() >= MAX_FINAL_PLAYBACK_DRAIN {
                        player.stop();
                        return Err(StreamFailure {
                            error: "OpenAI voice playback did not finish within 10 minutes"
                                .to_string(),
                            delivery: Some(snapshot_delivery(&delivery, &player)),
                        });
                    }
                    player.ensure_healthy().map_err(|error| StreamFailure {
                        error,
                        delivery: Some(snapshot_delivery(&delivery, &player)),
                    })?;
                    update_openai_assistant_speech(
                        player.is_empty(),
                        &mut assistant_speech,
                        &mut playback_drained_at,
                        output_latency_grace,
                        Instant::now(),
                    );
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
    native_voice: &NativeVoiceState,
    interruption_sensitivity: InterruptionSensitivity,
    suppress_capture: bool,
    assistant_speech: &mut Option<AssistantSpeechGuard>,
    playback_drained_at: &mut Option<Instant>,
    output_latency_grace: Duration,
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
        let Some(mut bytes) = runtime.block_on(openai_speech_stream_cancellable(
            client,
            key,
            chunk.to_string(),
            speed,
            active,
        ))?
        else {
            return Ok(());
        };
        let mut pcm_remainder = Vec::<u8>::new();
        let mut initial_samples = Vec::<f32>::new();
        let mut last_network_data = Instant::now();
        loop {
            update_openai_assistant_speech(
                player.is_empty(),
                assistant_speech,
                playback_drained_at,
                output_latency_grace,
                Instant::now(),
            );
            if !active.load(Ordering::SeqCst) {
                return Ok(());
            }
            let item = runtime.block_on(async {
                tokio::time::timeout(Duration::from_millis(50), bytes.next()).await
            });
            let Some(item) = (match item {
                Ok(item) => item,
                Err(_) if last_network_data.elapsed() < STREAM_IDLE_TIMEOUT => continue,
                Err(_) => return Err("OpenAI speech audio stream timed out".to_string()),
            }) else {
                break;
            };
            let item =
                item.map_err(|error| format_openai_request_error("stream speech audio", error))?;
            last_network_data = Instant::now();
            if !active.load(Ordering::SeqCst) {
                return Ok(());
            }
            pcm_remainder.extend_from_slice(&item);
            let sample_bytes = pcm_remainder.len() / 2 * 2;
            let samples = pcm16le_to_f32(&pcm_remainder[..sample_bytes]);
            pcm_remainder.drain(..sample_bytes);
            if *started {
                assistant_speech.get_or_insert_with(|| {
                    native_voice.begin_assistant_speech(interruption_sensitivity, suppress_capture)
                });
                *playback_drained_at = None;
                player.enqueue(&samples)?;
            } else {
                initial_samples.extend_from_slice(&samples);
                if initial_samples.len() >= INITIAL_PLAYBACK_BUFFER_FRAMES {
                    assistant_speech.get_or_insert_with(|| {
                        native_voice
                            .begin_assistant_speech(interruption_sensitivity, suppress_capture)
                    });
                    *playback_drained_at = None;
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
            assistant_speech.get_or_insert_with(|| {
                native_voice.begin_assistant_speech(interruption_sensitivity, suppress_capture)
            });
            *playback_drained_at = None;
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
fn ends_sentence_boundary(text: &str) -> bool {
    if text.trim_end_matches([' ', '\t', '\r']).ends_with('\n') {
        return true;
    }
    let trimmed = text.trim_end();
    trimmed
        .trim_end_matches(['"', '\'', '”', '’', ')', ']', '}'])
        .ends_with(['.', '!', '?'])
}

#[cfg(target_os = "macos")]
async fn run_while_active<F: std::future::Future>(
    future: F,
    active: &AtomicBool,
) -> Option<F::Output> {
    tokio::pin!(future);
    loop {
        tokio::select! {
            result = &mut future => return Some(result),
            _ = tokio::time::sleep(Duration::from_millis(20)) => {
                if !active.load(Ordering::SeqCst) {
                    return None;
                }
            }
        }
    }
}

#[cfg(target_os = "macos")]
async fn openai_speech_stream_cancellable(
    client: &reqwest::Client,
    key: &str,
    input: String,
    speed: f32,
    active: &AtomicBool,
) -> Result<Option<impl futures_util::Stream<Item = Result<bytes::Bytes, reqwest::Error>>>, String>
{
    match run_while_active(openai_speech_stream(client, key, input, speed), active).await {
        Some(result) => result.map(Some),
        None => Ok(None),
    }
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
        if end < text.len() {
            if let Some((offset, _)) = text[start..end]
                .char_indices()
                .rev()
                .find(|(offset, character)| *offset > 0 && character.is_whitespace())
            {
                end = start + offset;
            }
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

#[cfg(any(test, target_os = "macos"))]
fn openai_assistant_speech_grace_elapsed(
    playback_drained: bool,
    guard_active: bool,
    playback_drained_at: &mut Option<Instant>,
    output_latency_grace: Duration,
    now: Instant,
) -> bool {
    if !guard_active || !playback_drained {
        *playback_drained_at = None;
        return false;
    }
    let drained_at = *playback_drained_at.get_or_insert(now);
    now.saturating_duration_since(drained_at) >= output_latency_grace
}

#[cfg(target_os = "macos")]
fn update_openai_assistant_speech(
    playback_drained: bool,
    assistant_speech: &mut Option<AssistantSpeechGuard>,
    playback_drained_at: &mut Option<Instant>,
    output_latency_grace: Duration,
    now: Instant,
) {
    if openai_assistant_speech_grace_elapsed(
        playback_drained,
        assistant_speech.is_some(),
        playback_drained_at,
        output_latency_grace,
        now,
    ) {
        assistant_speech.take();
    }
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

#[cfg(target_os = "macos")]
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

#[cfg(target_os = "macos")]
fn format_openai_request_error(action: &str, error: reqwest::Error) -> String {
    if error.is_timeout() {
        format!("OpenAI voice could not {action}: the request timed out")
    } else if error.is_connect() {
        format!("OpenAI voice could not {action}: check your network connection")
    } else {
        format!("OpenAI voice could not {action}: {error}")
    }
}

#[cfg(target_os = "macos")]
fn format_openai_response_error(action: &str, status: reqwest::StatusCode, body: &str) -> String {
    let preview: String = body.chars().take(500).collect();
    format!("OpenAI voice could not {action}: HTTP {status}: {preview}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn destroyed_window_only_stops_its_openai_stream() {
        let state = OpenAiVoiceState::default();
        let active = Arc::new(AtomicBool::new(true));
        let (sender, _receiver) = mpsc::channel();
        {
            let mut playback = state.playback.lock().expect("playback state");
            playback.active = Some(active.clone());
            playback.stream = Some(ActiveOpenAiStream {
                id: "stream-1".to_string(),
                owner_window: "session-window".to_string(),
                sender,
            });
        }

        assert!(!state.stop_for_window_destroyed("other-window"));
        assert!(active.load(Ordering::SeqCst));
        assert!(state.stop_for_window_destroyed("session-window"));
        assert!(!active.load(Ordering::SeqCst));
    }

    #[test]
    fn voice_base_url_configuration_resolves_to_the_v1_api_root() {
        assert_eq!(
            normalize_openai_base_url("https://proxy.example".to_string()).unwrap(),
            "https://proxy.example/v1"
        );
        assert_eq!(
            normalize_openai_base_url("https://proxy.example/v1/".to_string()).unwrap(),
            "https://proxy.example/v1"
        );
    }

    #[test]
    fn openai_voice_endpoints_require_https() {
        assert_eq!(
            normalize_openai_base_url("http://proxy.example".to_string())
                .expect_err("plaintext endpoint must be rejected"),
            "OpenAI voice endpoint must use HTTPS"
        );
    }

    #[test]
    fn openai_base_url_preserves_custom_paths_and_query_parameters() {
        assert_eq!(
            normalize_openai_base_url("https://proxy.example".to_string()).unwrap(),
            "https://proxy.example/v1"
        );
        let base = normalize_openai_base_url(
            "https://proxy.example/openai?api-version=2026-01-01".to_string(),
        )
        .unwrap();
        assert_eq!(
            endpoint_for_base_url(&base, "audio/speech").unwrap(),
            "https://proxy.example/openai/audio/speech?api-version=2026-01-01"
        );
    }

    #[test]
    fn voice_configuration_uses_berd_scoped_environment_names() {
        assert_eq!(BASE_URL_ENV, "BERD_OPENAI_VOICE_BASE_URL");
        assert_eq!(STT_MODEL_ENV, "BERD_OPENAI_STT_MODEL");
        assert_eq!(TTS_MODEL_ENV, "BERD_OPENAI_TTS_MODEL");
        assert_eq!(TTS_VOICE_ENV, "BERD_OPENAI_TTS_VOICE");
    }

    #[test]
    fn capture_suppression_ends_after_playback_drain_grace() {
        let started = Instant::now();
        let mut drained_at = None;
        let grace = Duration::from_millis(100);

        assert!(!openai_assistant_speech_grace_elapsed(
            true,
            true,
            &mut drained_at,
            grace,
            started,
        ));
        assert!(openai_assistant_speech_grace_elapsed(
            true,
            true,
            &mut drained_at,
            grace,
            started + grace,
        ));
        assert!(!openai_assistant_speech_grace_elapsed(
            false,
            true,
            &mut drained_at,
            grace,
            started + grace,
        ));
        assert_eq!(drained_at, None);
    }

    #[test]
    fn configured_readiness_does_not_require_reading_the_secret() {
        let state = OpenAiVoiceState::default();
        assert!(!state.is_configured());

        state.configured.store(true, Ordering::Release);

        assert!(state.is_configured());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn chunks_tts_text_on_char_boundaries() {
        assert_eq!(chunk_text("hello", 10), vec!["hello"]);
        assert_eq!(chunk_text("ééé", 3), vec!["é", "é", "é"]);
        assert_eq!(
            chunk_text("hello wide world", 8),
            vec!["hello", "wide", "world"]
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn recognizes_sentence_boundaries_before_streaming() {
        assert!(ends_sentence_boundary("Hello world.\n"));
        assert!(ends_sentence_boundary("Did it work?” "));
        assert!(ends_sentence_boundary("It did!)"));
        assert!(!ends_sentence_boundary("Still speaking,"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn cancels_a_stalled_speech_request() {
        let active = Arc::new(AtomicBool::new(true));
        let active_for_thread = active.clone();
        let cancellation = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(30));
            active_for_thread.store(false, Ordering::SeqCst);
        });
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .expect("runtime");

        let result = runtime.block_on(run_while_active(
            std::future::pending::<()>(),
            active.as_ref(),
        ));

        cancellation.join().expect("cancellation thread");
        assert_eq!(result, None);
    }
}
