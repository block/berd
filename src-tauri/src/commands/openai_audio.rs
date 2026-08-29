//! OpenAI realtime transcription configuration and streaming speech playback.

use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc, Arc, Mutex,
};
#[cfg(any(test, target_os = "macos"))]
use std::time::Duration;

#[cfg(target_os = "macos")]
use berd_voice::{
    openai::OpenAiSpeechConfig, DeliveryProgress as VoiceDeliveryProgress, DrainPolicy, OpenAiTts,
    OutboundFailure, OutboundOutcome, OutboundPlayback, PocketAudioPlayer, TtsBackend,
};
use serde::Serialize;
use serde_json::json;
#[cfg(target_os = "macos")]
use tauri::Emitter;
use tauri::{AppHandle, State};

#[cfg(target_os = "macos")]
use super::{
    native_voice::AssistantSpeechGuard,
    pocket_voice::{
        effective_output_device_name, playback_latency_safety_duration, selected_output_device,
        should_suppress_capture,
    },
};
use super::{
    native_voice::{InterruptionSensitivity, NativeVoiceState},
    pocket_voice::VoiceInterruptionMode,
};
#[cfg(any(test, target_os = "macos"))]
use std::time::Instant;

const DEFAULT_BASE_URL: &str = "https://api.openai.com/v1";
const DEFAULT_TRANSCRIPTION_MODEL: &str = "gpt-live-transcribe";
const DEFAULT_TTS_MODEL: &str = "gpt-4o-mini-tts";
const DEFAULT_TTS_VOICE: &str = "marin";
#[cfg(target_os = "macos")]
const TTS_SAMPLE_RATE: u32 = 24_000;
// Avoid starting the audio device from a tiny first network chunk that can drain
// before subsequent streamed PCM arrives.
#[cfg(target_os = "macos")]
const INITIAL_PLAYBACK_BUFFER_FRAMES: usize = TTS_SAMPLE_RATE as usize / 5;
#[cfg(target_os = "macos")]
const TTS_EVENT: &str = "openai-voice:stream-event";
#[cfg(target_os = "macos")]
const MAX_TTS_INPUT_CHARS: usize = 4096;

#[derive(Clone, Debug, Default)]
pub struct OpenAiVoiceState {
    playback: Arc<Mutex<PlaybackRuntime>>,
    configured: Arc<AtomicBool>,
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
    configured: bool,
    transcription_model: String,
    speech_model: String,
    speech_voice: String,
    playback_speed: f32,
    tts_available: bool,
    unavailable_reason: Option<String>,
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

fn env_trimmed(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn goose_yaml_value(path: &std::path::Path, name: &str) -> Result<Option<String>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let payload = std::fs::read_to_string(path)
        .map_err(|error| format!("Could not read Goose configuration: {error}"))?;
    let values: serde_json::Value = yaml_serde::from_str(&payload)
        .map_err(|error| format!("Goose configuration is invalid: {error}"))?;
    Ok(values
        .get(name)
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string))
}

fn goose_openai_api_key() -> Result<Option<String>, String> {
    if let Some(value) = env_trimmed("OPENAI_API_KEY") {
        return Ok(Some(value));
    }
    let mut secure_store_error = None;
    {
        match keyring::Entry::new("goose", "secrets") {
            Ok(entry) => match entry.get_password() {
                Ok(payload) => match serde_json::from_str::<serde_json::Value>(&payload) {
                    Ok(secrets) => {
                        if let Some(key) = secrets
                            .get("OPENAI_API_KEY")
                            .and_then(serde_json::Value::as_str)
                            .map(str::trim)
                            .filter(|value| !value.is_empty())
                        {
                            return Ok(Some(key.to_string()));
                        }
                    }
                    Err(error) => {
                        secure_store_error = Some(format!(
                            "Goose's secure credential store is not valid JSON: {error}"
                        ));
                    }
                },
                Err(keyring::Error::NoEntry) => {}
                Err(error) => {
                    secure_store_error = Some(format!(
                        "Could not read Goose's OpenAI credential from secure storage: {error}"
                    ));
                }
            },
            Err(error) => {
                secure_store_error = Some(format!(
                    "Could not access Goose's secure credential store: {error}"
                ));
            }
        }
    }
    let config_path = crate::services::goose_config::config_path()?;
    let secrets_path = config_path
        .parent()
        .ok_or_else(|| "Could not resolve Goose's credential directory".to_string())?
        .join("secrets.yaml");
    if let Some(key) = goose_yaml_value(&secrets_path, "OPENAI_API_KEY")? {
        return Ok(Some(key));
    }
    if let Some(error) = secure_store_error {
        return Err(error);
    }
    Ok(None)
}

pub(crate) fn api_key() -> Result<String, String> {
    goose_openai_api_key()?.ok_or_else(|| {
        "OpenAI voice is not configured. Configure the OpenAI provider in Berd, then try again."
            .to_string()
    })
}

fn normalize_openai_base_url(raw_url: String, assume_v1: bool) -> Result<String, String> {
    let mut url = reqwest::Url::parse(&raw_url)
        .map_err(|error| format!("OpenAI voice endpoint is invalid: {error}"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("OpenAI voice endpoint must use HTTP or HTTPS".to_string());
    }
    let path = url.path().trim_end_matches('/').to_string();
    if assume_v1 || path.is_empty() {
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
    if let Some(host) = env_trimmed("OPENAI_HOST") {
        return normalize_openai_base_url(host, true);
    }
    if let Some(base_url) = env_trimmed("OPENAI_BASE_URL") {
        return normalize_openai_base_url(base_url, false);
    }
    let config_path = crate::services::goose_config::config_path()?;
    if let Some(base_url) = goose_yaml_value(&config_path, "OPENAI_BASE_URL")? {
        return normalize_openai_base_url(base_url, false);
    }
    if let Some(host) = goose_yaml_value(&config_path, "OPENAI_HOST")? {
        return normalize_openai_base_url(host, true);
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
    env_trimmed("OPENAI_TRANSCRIPTION_MODEL")
        .or_else(|| env_trimmed("OPENAI_STT_MODEL"))
        .unwrap_or_else(|| DEFAULT_TRANSCRIPTION_MODEL.to_string())
}

fn speech_model() -> String {
    env_trimmed("OPENAI_TTS_MODEL").unwrap_or_else(|| DEFAULT_TTS_MODEL.to_string())
}

fn speech_voice() -> String {
    env_trimmed("OPENAI_TTS_VOICE").unwrap_or_else(|| DEFAULT_TTS_VOICE.to_string())
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

fn openai_voice_configured(provider_configured: bool, environment_key: Option<&str>) -> bool {
    provider_configured || environment_key.is_some_and(|key| !key.trim().is_empty())
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

#[tauri::command]
pub fn get_openai_voice_status(
    state: State<'_, OpenAiVoiceState>,
    provider_configured: bool,
) -> Result<OpenAiVoiceStatus, String> {
    // Provider metadata avoids a passive Keychain read; the environment is
    // safe to inspect directly and has the same highest-priority semantics as
    // the credential resolver used when a stream starts.
    let environment_key = env_trimmed("OPENAI_API_KEY");
    let configured = openai_voice_configured(provider_configured, environment_key.as_deref());
    state.configured.store(configured, Ordering::Release);
    let playback_speed = state
        .playback
        .lock()
        .map_err(|_| "OpenAI voice playback state lock was poisoned".to_string())?
        .speed;
    let tts_available = cfg!(target_os = "macos");
    Ok(OpenAiVoiceStatus {
        configured,
        transcription_model: transcription_model(),
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
        let key = api_key()?;
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
    let backend = OpenAiTts::new(OpenAiSpeechConfig {
        endpoint: endpoint("audio/speech")?,
        api_key: key,
        model: speech_model(),
        voice: speech_voice(),
        speed,
    })?;
    let output_device = selected_output_device();
    let effective_output_device = effective_output_device_name(output_device.as_deref());
    let player = PocketAudioPlayer::new(TTS_SAMPLE_RATE, 1.0, output_device.as_deref())?;
    let mut playback = OutboundPlayback::new(
        &player,
        &active,
        TTS_SAMPLE_RATE,
        INITIAL_PLAYBACK_BUFFER_FRAMES,
    )?;
    let suppress_capture =
        should_suppress_capture(interruption_mode, effective_output_device.as_deref());
    let output_latency_grace = playback_latency_safety_duration(effective_output_device.as_deref());
    let mut assistant_speech = None::<AssistantSpeechGuard>;
    let mut playback_drained_at = None::<Instant>;
    let mut pending = String::new();
    let mut last_progress = Instant::now();

    loop {
        update_openai_assistant_speech(
            player.is_empty(),
            &mut assistant_speech,
            &mut playback_drained_at,
            output_latency_grace,
            Instant::now(),
        );
        if !playback.poll().map_err(openai_playback_failure)? {
            return Ok(StreamOutcome {
                state: OpenAiStreamEventState::Interrupted,
                delivery: Some(playback.snapshot()),
            });
        }
        match receiver.recv_timeout(Duration::from_millis(20)) {
            Ok(OpenAiStreamCommand::Append(text)) => {
                pending.push_str(&text);
                if pending.len() >= 24 && pending.trim_end().ends_with(['.', '!', '?', '\n']) {
                    match speak_pending(
                        app,
                        stream_id,
                        &backend,
                        &mut playback,
                        &mut pending,
                        &native_voice,
                        interruption_sensitivity,
                        suppress_capture,
                        &mut assistant_speech,
                        &mut playback_drained_at,
                    )
                    .map_err(openai_playback_failure)?
                    {
                        OutboundOutcome::Interrupted => {
                            return Ok(StreamOutcome {
                                state: OpenAiStreamEventState::Interrupted,
                                delivery: Some(playback.snapshot()),
                            })
                        }
                        OutboundOutcome::Completed => {}
                    }
                }
            }
            Ok(OpenAiStreamCommand::Flush) => {
                if speak_pending(
                    app,
                    stream_id,
                    &backend,
                    &mut playback,
                    &mut pending,
                    &native_voice,
                    interruption_sensitivity,
                    suppress_capture,
                    &mut assistant_speech,
                    &mut playback_drained_at,
                )
                .map_err(openai_playback_failure)?
                    == OutboundOutcome::Interrupted
                {
                    return Ok(StreamOutcome {
                        state: OpenAiStreamEventState::Interrupted,
                        delivery: Some(playback.snapshot()),
                    });
                }
            }
            Ok(OpenAiStreamCommand::Finish) => {
                if speak_pending(
                    app,
                    stream_id,
                    &backend,
                    &mut playback,
                    &mut pending,
                    &native_voice,
                    interruption_sensitivity,
                    suppress_capture,
                    &mut assistant_speech,
                    &mut playback_drained_at,
                )
                .map_err(openai_playback_failure)?
                    == OutboundOutcome::Interrupted
                {
                    return Ok(StreamOutcome {
                        state: OpenAiStreamEventState::Interrupted,
                        delivery: Some(playback.snapshot()),
                    });
                }
                let post_drain = openai_assistant_speech_grace_remaining(
                    assistant_speech.is_some(),
                    playback_drained_at,
                    output_latency_grace,
                    Instant::now(),
                );
                let outcome = playback
                    .finish(
                        DrainPolicy {
                            post_drain,
                            ..DrainPolicy::default()
                        },
                        &mut |delivery| {
                            update_openai_assistant_speech(
                                true,
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
                                    Some(delivery.clone()),
                                );
                                last_progress = Instant::now();
                            }
                            Ok(())
                        },
                    )
                    .map_err(openai_playback_failure)?;
                if outcome == OutboundOutcome::Interrupted {
                    return Ok(StreamOutcome {
                        state: OpenAiStreamEventState::Interrupted,
                        delivery: Some(playback.snapshot()),
                    });
                }
                assistant_speech.take();
                return Ok(StreamOutcome {
                    state: OpenAiStreamEventState::Completed,
                    delivery: None,
                });
            }
            Ok(OpenAiStreamCommand::Stop) | Err(mpsc::RecvTimeoutError::Disconnected) => {
                active.store(false, Ordering::SeqCst);
                playback.interrupt();
                return Ok(StreamOutcome {
                    state: OpenAiStreamEventState::Interrupted,
                    delivery: Some(playback.snapshot()),
                });
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if playback.started() && last_progress.elapsed() >= Duration::from_millis(100) {
                    emit_openai_stream_event(
                        app,
                        stream_id,
                        OpenAiStreamEventState::Progress,
                        None,
                        Some(playback.snapshot()),
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
    app: &AppHandle,
    stream_id: &str,
    backend: &dyn TtsBackend,
    playback: &mut OutboundPlayback<'_>,
    pending: &mut String,
    native_voice: &NativeVoiceState,
    interruption_sensitivity: InterruptionSensitivity,
    suppress_capture: bool,
    assistant_speech: &mut Option<AssistantSpeechGuard>,
    playback_drained_at: &mut Option<Instant>,
) -> Result<OutboundOutcome, OutboundFailure> {
    let text = std::mem::take(pending).trim().to_string();
    if text.is_empty() {
        return Ok(OutboundOutcome::Completed);
    }
    for chunk in chunk_text(&text, MAX_TTS_INPUT_CHARS) {
        let outcome = playback.synthesize_segment(
            backend,
            chunk,
            &mut |_| {
                *playback_drained_at = None;
                if assistant_speech.is_none() {
                    *assistant_speech = Some(
                        native_voice
                            .begin_assistant_speech(interruption_sensitivity, suppress_capture),
                    );
                }
                Ok(())
            },
            &mut || {
                emit_openai_stream_event(
                    app,
                    stream_id,
                    OpenAiStreamEventState::Started,
                    None,
                    None,
                );
            },
        )?;
        if outcome == OutboundOutcome::Interrupted {
            return Ok(outcome);
        }
    }
    Ok(OutboundOutcome::Completed)
}

#[cfg(target_os = "macos")]
fn openai_playback_failure(failure: OutboundFailure) -> StreamFailure {
    StreamFailure {
        error: failure.message,
        delivery: Some(failure.delivery),
    }
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

#[cfg(any(test, target_os = "macos"))]
fn openai_assistant_speech_grace_remaining(
    guard_active: bool,
    playback_drained_at: Option<Instant>,
    output_latency_grace: Duration,
    now: Instant,
) -> Duration {
    if !guard_active {
        return Duration::ZERO;
    }
    playback_drained_at.map_or(output_latency_grace, |drained_at| {
        output_latency_grace.saturating_sub(now.saturating_duration_since(drained_at))
    })
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
    fn openai_host_configuration_resolves_to_the_v1_api_root() {
        assert_eq!(
            normalize_openai_base_url("https://proxy.example".to_string(), true).unwrap(),
            "https://proxy.example/v1"
        );
        assert_eq!(
            normalize_openai_base_url("https://proxy.example/v1/".to_string(), true).unwrap(),
            "https://proxy.example/v1"
        );
    }

    #[test]
    fn openai_base_url_preserves_custom_paths_and_query_parameters() {
        assert_eq!(
            normalize_openai_base_url("https://proxy.example".to_string(), false).unwrap(),
            "https://proxy.example/v1"
        );
        let base = normalize_openai_base_url(
            "https://proxy.example/openai?api-version=2026-01-01".to_string(),
            false,
        )
        .unwrap();
        assert_eq!(
            endpoint_for_base_url(&base, "audio/speech").unwrap(),
            "https://proxy.example/openai/audio/speech?api-version=2026-01-01"
        );
    }

    #[test]
    fn environment_credential_makes_openai_voice_ready() {
        assert!(openai_voice_configured(false, Some("environment-key")));
        assert!(!openai_voice_configured(false, None));
        assert!(!openai_voice_configured(false, Some("  ")));
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
        assert_eq!(
            openai_assistant_speech_grace_remaining(
                true,
                Some(started),
                grace,
                started + Duration::from_millis(40),
            ),
            Duration::from_millis(60)
        );
        assert_eq!(
            openai_assistant_speech_grace_remaining(false, Some(started), grace, started),
            Duration::ZERO
        );
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
    }
}
