//! macOS SiriTTSD voice discovery, download, and selection.

#[cfg(target_os = "macos")]
use std::ffi::{CStr, CString};
use std::fs;
#[cfg(target_os = "macos")]
use std::os::raw::c_char;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
#[cfg(target_os = "macos")]
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
#[cfg(any(test, target_os = "macos"))]
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
#[cfg(target_os = "macos")]
use tauri::Emitter;
use tauri::{AppHandle, Manager};

#[cfg(target_os = "macos")]
use super::native_voice::AssistantSpeechGuard;
#[cfg(any(test, target_os = "macos"))]
use super::native_voice::{output_latency_grace_elapsed, output_latency_grace_remaining};
use super::native_voice::{InterruptionSensitivity, NativeVoiceState};
use super::pocket_voice::VoiceInterruptionMode;
#[cfg(target_os = "macos")]
use super::pocket_voice::{
    effective_output_device_name, output_device_uses_speakers, playback_latency_safety_duration,
    resolve_input_during_tts_policy, selected_output_device,
};
#[cfg(target_os = "macos")]
use berd_voice::input::InputDuringTtsPolicy;
#[cfg(target_os = "macos")]
use berd_voice::siri::{
    download_voice as download_managed_siri_voice, SiriDownloadAvailabilityWait,
};
use berd_voice::siri::{
    load_voice_catalog, validate_installed_voice, SiriVoice, SiriVoiceIdentity,
};
#[cfg(any(test, target_os = "macos"))]
use berd_voice::DeliveryProgress as VoiceDeliveryProgress;
#[cfg(test)]
use berd_voice::DeliverySegment as VoiceDeliverySegment;
#[cfg(target_os = "macos")]
use berd_voice::{
    ConfiguredTtsSlot, DrainPolicy, OutboundFailure, OutboundOutcome, OutboundPlayback,
    PcmAudioOutput, PocketAudioPlayer, TtsBackend, TtsConfiguration,
};

#[derive(Clone, Debug, Default)]
pub struct SiriVoiceState {
    runtime: Arc<Mutex<SiriVoiceRuntime>>,
}

#[derive(Debug, Default)]
struct SiriVoiceRuntime {
    active: Option<Arc<AtomicBool>>,
    owner_window: Option<String>,
    #[cfg(target_os = "macos")]
    stream: Option<ActiveSiriStream>,
}

#[cfg(target_os = "macos")]
#[derive(Debug)]
struct ActiveSiriStream {
    id: String,
    sender: mpsc::Sender<SiriStreamCommand>,
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
#[derive(Debug)]
enum SiriStreamCommand {
    Append(String),
    Flush,
    Finish,
    Stop,
}

#[cfg(target_os = "macos")]
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum SiriStreamEventState {
    Started,
    Progress,
    Completed,
    Interrupted,
    Failed,
}

#[cfg(target_os = "macos")]
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SiriStreamEvent {
    stream_id: String,
    state: SiriStreamEventState,
    error: Option<String>,
    delivery: Option<VoiceDeliveryProgress>,
}

#[cfg(target_os = "macos")]
struct SiriStreamOutcome {
    state: SiriStreamEventState,
    delivery: Option<VoiceDeliveryProgress>,
}

#[cfg(target_os = "macos")]
#[derive(Debug)]
struct SiriStreamFailure {
    error: String,
    delivery: Option<VoiceDeliveryProgress>,
}

#[cfg(target_os = "macos")]
impl From<String> for SiriStreamFailure {
    fn from(error: String) -> Self {
        Self {
            error,
            delivery: None,
        }
    }
}

#[cfg(any(test, target_os = "macos"))]
fn delivery_with_played_audio(delivery: VoiceDeliveryProgress) -> Option<VoiceDeliveryProgress> {
    delivery
        .segments
        .iter()
        .any(|segment| segment.played_frames > 0)
        .then_some(delivery)
}

#[cfg(target_os = "macos")]
const SIRI_STREAM_EVENT: &str = "siri-voice:stream-event";
#[cfg(any(test, target_os = "macos"))]
const SIRI_OUTPUT_DRAIN_MARGIN: Duration = Duration::from_secs(60);
#[cfg(target_os = "macos")]
const PLAYBACK_PROGRESS_EMIT_INTERVAL: Duration = Duration::from_millis(100);
const MIN_PLAYBACK_SPEED: f32 = 0.5;
const MAX_PLAYBACK_SPEED: f32 = 2.0;
static SIRI_SETTINGS_LOCK: Mutex<()> = Mutex::new(());
static SIRI_SETTINGS_TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

pub type SiriVoiceSelection = SiriVoiceIdentity;

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SiriVoiceStatus {
    supported: bool,
    available_languages: Vec<String>,
    selected_voice: Option<SiriVoiceSelection>,
    selected_voice_installed: bool,
    playback_speed: f32,
    voices: Vec<SiriVoice>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SiriVoiceSettings {
    selected_voice: Option<SiriVoiceSelection>,
    #[serde(default = "default_playback_speed")]
    playback_speed: f32,
}

fn default_playback_speed() -> f32 {
    1.0
}

impl Default for SiriVoiceSettings {
    fn default() -> Self {
        Self {
            selected_voice: None,
            playback_speed: default_playback_speed(),
        }
    }
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|path| path.join("siri-tts").join("settings.json"))
        .map_err(|error| format!("resolve Siri TTS settings directory: {error}"))
}

fn read_settings(path: &Path) -> SiriVoiceSettings {
    fs::read(path)
        .ok()
        .and_then(|data| serde_json::from_slice(&data).ok())
        .unwrap_or_default()
}

fn write_settings(path: &Path, settings: &SiriVoiceSettings) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Siri TTS settings path has no parent".to_string())?;
    fs::create_dir_all(parent).map_err(|error| format!("create Siri TTS settings: {error}"))?;
    let data = serde_json::to_vec_pretty(settings)
        .map_err(|error| format!("encode Siri TTS settings: {error}"))?;
    let temporary = path.with_extension(format!(
        "json.{}.{}.tmp",
        std::process::id(),
        SIRI_SETTINGS_TEMP_COUNTER.fetch_add(1, Ordering::Relaxed),
    ));
    fs::write(&temporary, data).map_err(|error| format!("write Siri TTS settings: {error}"))?;
    fs::rename(&temporary, path).map_err(|error| {
        let _ = fs::remove_file(&temporary);
        format!("publish Siri TTS settings: {error}")
    })
}

fn update_settings(
    path: &Path,
    update: impl FnOnce(&mut SiriVoiceSettings) -> bool,
) -> Result<SiriVoiceSettings, String> {
    let _guard = SIRI_SETTINGS_LOCK
        .lock()
        .map_err(|_| "Siri TTS settings lock was poisoned".to_string())?;
    let mut settings = read_settings(path);
    if update(&mut settings) {
        write_settings(path, &settings)?;
    }
    Ok(settings)
}

#[cfg(target_os = "macos")]
unsafe extern "C" {
    fn berd_siri_tts_play_sample(
        voice_name: *const c_char,
        language: *const c_char,
        rate: f32,
        should_stop: Option<unsafe extern "C" fn(*mut std::ffi::c_void) -> bool>,
        context: *mut std::ffi::c_void,
        error_out: *mut *mut c_char,
    ) -> bool;
    fn berd_siri_tts_speak(
        text: *const c_char,
        language: *const c_char,
        voice_name: *const c_char,
        rate: f32,
        should_stop: Option<unsafe extern "C" fn(*mut std::ffi::c_void) -> bool>,
        playback_started: Option<unsafe extern "C" fn(*mut std::ffi::c_void)>,
        context: *mut std::ffi::c_void,
        error_out: *mut *mut c_char,
    ) -> bool;
    fn berd_siri_tts_free_string(value: *mut c_char);
}

#[cfg(target_os = "macos")]
unsafe extern "C" fn should_stop_siri_playback(context: *mut std::ffi::c_void) -> bool {
    if context.is_null() {
        return false;
    }
    // SAFETY: The pointer comes from an Arc<AtomicBool> kept alive for the
    // entire synchronous bridge call.
    let active = unsafe { &*(context.cast::<AtomicBool>()) };
    !active.load(Ordering::SeqCst)
}

#[cfg(any(test, target_os = "macos"))]
fn begin_playback(state: &SiriVoiceState, owner_window: &str) -> Result<Arc<AtomicBool>, String> {
    let mut runtime = state
        .runtime
        .lock()
        .map_err(|_| "Siri playback state lock was poisoned".to_string())?;
    if runtime.active.is_some() {
        return Err("Siri voice playback is already active".to_string());
    }
    let token = Arc::new(AtomicBool::new(true));
    runtime.active = Some(token.clone());
    runtime.owner_window = Some(owner_window.to_string());
    Ok(token)
}

#[cfg(any(test, target_os = "macos"))]
fn finish_playback(state: &SiriVoiceState, completed: &Arc<AtomicBool>) {
    if let Ok(mut runtime) = state.runtime.lock() {
        if runtime
            .active
            .as_ref()
            .is_some_and(|current| Arc::ptr_eq(current, completed))
        {
            runtime.active = None;
            runtime.owner_window = None;
            #[cfg(target_os = "macos")]
            {
                runtime.stream = None;
            }
        }
    }
}

#[cfg(target_os = "macos")]
fn take_bridge_string(value: *mut c_char) -> Option<String> {
    if value.is_null() {
        return None;
    }
    // SAFETY: The Objective-C bridge returns a NUL-terminated malloc-owned
    // string. Copy it before releasing it through the paired bridge function.
    let result = unsafe { CStr::from_ptr(value) }
        .to_string_lossy()
        .into_owned();
    unsafe { berd_siri_tts_free_string(value) };
    Some(result)
}

#[cfg(target_os = "macos")]
fn bridge_error(error: *mut c_char, fallback: &str) -> String {
    take_bridge_string(error).unwrap_or_else(|| fallback.to_string())
}

#[cfg(target_os = "macos")]
fn emit_stream_event(
    app: &AppHandle,
    stream_id: &str,
    state: SiriStreamEventState,
    error: Option<String>,
    delivery: Option<VoiceDeliveryProgress>,
) {
    let _ = app.emit(
        SIRI_STREAM_EVENT,
        SiriStreamEvent {
            stream_id: stream_id.to_string(),
            state,
            error,
            delivery,
        },
    );
}

#[cfg(target_os = "macos")]
fn discover_voices(language_prefix: &str) -> Result<Vec<SiriVoice>, String> {
    load_voice_catalog((!language_prefix.is_empty()).then_some(language_prefix))
        .map(|catalog| catalog.voices)
}

#[cfg(not(target_os = "macos"))]
fn discover_voices(_language_prefix: &str) -> Result<Vec<SiriVoice>, String> {
    Ok(Vec::new())
}

fn first_installed_voice(voices: &[SiriVoice]) -> Option<SiriVoiceSelection> {
    voices
        .iter()
        .find(|voice| voice.installed)
        .map(SiriVoice::identity)
}

fn resolve_voice_selection(
    preferred_voices: &[SiriVoice],
    selected_voice: Option<&SiriVoiceSelection>,
    load_all_voices: impl FnOnce() -> Result<Vec<SiriVoice>, String>,
) -> Result<(Option<SiriVoiceSelection>, bool), String> {
    if let Some(selection) = selected_voice {
        if preferred_voices
            .iter()
            .find(|voice| voice.matches(selection))
            .is_some_and(|voice| voice.installed)
        {
            return Ok((Some(selection.clone()), true));
        }
    } else if let Some(selection) = first_installed_voice(preferred_voices) {
        return Ok((Some(selection), true));
    }

    let all_voices = load_all_voices()?;
    if let Some(selection) = selected_voice {
        if all_voices
            .iter()
            .find(|voice| voice.matches(selection))
            .is_some_and(|voice| voice.installed)
        {
            return Ok((Some(selection.clone()), true));
        }
    }

    let fallback = first_installed_voice(&all_voices);
    Ok(match fallback {
        Some(selection) => (Some(selection), true),
        None => (selected_voice.cloned(), false),
    })
}

#[cfg(any(target_os = "macos", test))]
fn resolve_stream_voice(
    selection: &SiriVoiceSelection,
    load_all_voices: impl FnOnce() -> Result<Vec<SiriVoice>, String>,
) -> Result<SiriVoiceSelection, String> {
    let voices = load_all_voices()?;
    if voices
        .iter()
        .find(|voice| voice.matches(selection))
        .is_some_and(|voice| voice.installed)
    {
        return Ok(selection.clone());
    }

    first_installed_voice(&voices).ok_or_else(|| {
        "No installed Siri voice is available. Open Voice settings to download one.".to_string()
    })
}

fn status(app: &AppHandle, language_prefix: &str) -> Result<SiriVoiceStatus, String> {
    let catalog = load_voice_catalog((!language_prefix.is_empty()).then_some(language_prefix))?;
    let voices = catalog.voices;
    let available_languages = catalog.available_languages;
    let path = settings_path(app)?;
    let previous_selection = read_settings(&path).selected_voice;
    let (resolved_selection, resolved_selection_installed) =
        resolve_voice_selection(&voices, previous_selection.as_ref(), || discover_voices(""))?;
    let settings = update_settings(&path, |settings| {
        if previous_selection.is_none()
            && resolved_selection_installed
            && settings.selected_voice == previous_selection
            && settings.selected_voice != resolved_selection
        {
            settings.selected_voice = resolved_selection.clone();
            true
        } else {
            false
        }
    })?;
    let (selected_voice, selected_voice_installed) =
        if settings.selected_voice == previous_selection {
            (resolved_selection, resolved_selection_installed)
        } else {
            let installed = settings.selected_voice.as_ref().is_some_and(|selection| {
                voices
                    .iter()
                    .find(|voice| voice.matches(selection))
                    .is_some_and(|voice| voice.installed)
                    || discover_voices(selection.language())
                        .ok()
                        .and_then(|selected| {
                            selected.into_iter().find(|voice| voice.matches(selection))
                        })
                        .is_some_and(|voice| voice.installed)
            });
            (settings.selected_voice.clone(), installed)
        };
    Ok(SiriVoiceStatus {
        supported: cfg!(target_os = "macos"),
        available_languages,
        selected_voice,
        selected_voice_installed,
        playback_speed: settings
            .playback_speed
            .clamp(MIN_PLAYBACK_SPEED, MAX_PLAYBACK_SPEED),
        voices,
    })
}

#[tauri::command]
pub async fn get_siri_voice_status(
    app: AppHandle,
    language_prefix: Option<String>,
) -> Result<SiriVoiceStatus, String> {
    let prefix = language_prefix.unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || status(&app, prefix.trim()))
        .await
        .map_err(|error| format!("Siri voice catalog task failed: {error}"))?
}

#[tauri::command]
pub async fn select_siri_voice(app: AppHandle, voice: SiriVoiceSelection) -> Result<(), String> {
    let candidate = voice.clone();
    tauri::async_runtime::spawn_blocking(move || validate_installed_voice(&candidate))
        .await
        .map_err(|error| format!("Siri voice validation task failed: {error}"))??;
    update_settings(&settings_path(&app)?, |settings| {
        settings.selected_voice = Some(voice);
        true
    })
    .map(|_| ())
}

#[tauri::command]
pub fn set_siri_playback_speed(app: AppHandle, speed: f32) -> Result<(), String> {
    if !speed.is_finite() || !(MIN_PLAYBACK_SPEED..=MAX_PLAYBACK_SPEED).contains(&speed) {
        return Err("Siri playback speed must be between 0.5 and 2.0".to_string());
    }
    let path = settings_path(&app)?;
    update_settings(&path, |settings| {
        settings.playback_speed = speed;
        true
    })
    .map(|_| ())
}

#[tauri::command]
pub async fn download_siri_voice(app: AppHandle, voice: SiriVoiceSelection) -> Result<(), String> {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, voice);
        Err("Siri TTS is only available on macOS".to_string())
    }

    #[cfg(target_os = "macos")]
    {
        tauri::async_runtime::spawn_blocking(move || {
            download_managed_siri_voice(&voice, SiriDownloadAvailabilityWait::default())
                .map(|_| ())
                .map_err(|error| error.to_string())
        })
        .await
        .map_err(|error| format!("Siri voice download task failed: {error}"))??;
        let _ = app;
        Ok(())
    }
}

#[cfg(target_os = "macos")]
#[allow(clippy::too_many_arguments)]
fn synthesize_siri_stream_ready(
    app: &AppHandle,
    stream_id: &str,
    backend: &dyn TtsBackend,
    playback: &mut OutboundPlayback<'_>,
    player: &PocketAudioPlayer,
    output_latency_grace: Duration,
    pending: &mut String,
    first_chunk_pending: &mut bool,
    native_voice: &NativeVoiceState,
    interruption_sensitivity: InterruptionSensitivity,
    input_during_tts: InputDuringTtsPolicy,
    assistant_speech: &mut Option<AssistantSpeechGuard>,
    playback_drained_at: &mut Option<Instant>,
    last_progress_emit: &mut Instant,
    last_progress: &mut Option<VoiceDeliveryProgress>,
    flush: bool,
) -> Result<bool, String> {
    let split = berd_voice::take_streaming_text_chunks(pending, *first_chunk_pending, flush)?;
    *pending = split.pending;
    *first_chunk_pending = split.first_chunk_pending;
    for text in split.ready {
        // The coordinator invokes these callbacks serially, but Rust cannot
        // infer that two callback values never overlap. Interior borrows keep
        // the single host-owned guard state shared without duplicating it.
        let assistant_speech_cell = std::cell::RefCell::new(&mut *assistant_speech);
        let playback_drained_at_cell = std::cell::RefCell::new(&mut *playback_drained_at);
        let outcome = playback
            .synthesize_segment(
                backend,
                text.trim(),
                &mut |_| {
                    let mut assistant_speech = assistant_speech_cell.borrow_mut();
                    if assistant_speech.is_none() {
                        **assistant_speech = Some(
                            native_voice
                                .begin_assistant_speech(interruption_sensitivity, input_during_tts),
                        );
                    }
                    **playback_drained_at_cell.borrow_mut() = None;
                    Ok(())
                },
                &mut || {
                    emit_stream_event(app, stream_id, SiriStreamEventState::Started, None, None);
                    Ok(())
                },
                &mut |delivery| {
                    let mut assistant_speech = assistant_speech_cell.borrow_mut();
                    let mut playback_drained_at = playback_drained_at_cell.borrow_mut();
                    update_siri_assistant_speech(
                        player.is_drained(),
                        &mut assistant_speech,
                        &mut playback_drained_at,
                        output_latency_grace,
                        Instant::now(),
                    );
                    emit_siri_progress_if_changed(
                        app,
                        stream_id,
                        delivery,
                        last_progress_emit,
                        last_progress,
                    );
                    Ok(())
                },
            )
            .map_err(|failure: OutboundFailure| failure.message)?;
        if outcome == OutboundOutcome::Interrupted {
            return Ok(false);
        }
    }
    Ok(true)
}

#[cfg(target_os = "macos")]
fn emit_siri_progress_if_changed(
    app: &AppHandle,
    stream_id: &str,
    delivery: &VoiceDeliveryProgress,
    last_progress_emit: &mut Instant,
    last_progress: &mut Option<VoiceDeliveryProgress>,
) {
    if last_progress_emit.elapsed() < PLAYBACK_PROGRESS_EMIT_INTERVAL
        || last_progress.as_ref() == Some(delivery)
    {
        return;
    }
    emit_stream_event(
        app,
        stream_id,
        SiriStreamEventState::Progress,
        None,
        Some(delivery.clone()),
    );
    *last_progress_emit = Instant::now();
    *last_progress = Some(delivery.clone());
}

#[cfg(target_os = "macos")]
fn update_siri_assistant_speech(
    playback_drained: bool,
    assistant_speech: &mut Option<AssistantSpeechGuard>,
    playback_drained_at: &mut Option<Instant>,
    output_latency_grace: Duration,
    now: Instant,
) {
    if output_latency_grace_elapsed(
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
fn siri_drain_timeout(total_frames: u64, completed_frames: u64, sample_rate: u32) -> Duration {
    let remaining_frames = total_frames.saturating_sub(completed_frames);
    Duration::from_secs_f64(remaining_frames as f64 / f64::from(sample_rate))
        .saturating_add(SIRI_OUTPUT_DRAIN_MARGIN)
}

#[cfg(target_os = "macos")]
#[allow(clippy::too_many_arguments)]
fn run_siri_stream(
    app: AppHandle,
    stream_id: String,
    selection: SiriVoiceSelection,
    speed: f32,
    active: Arc<AtomicBool>,
    receiver: mpsc::Receiver<SiriStreamCommand>,
    native_voice: NativeVoiceState,
    interruption_sensitivity: InterruptionSensitivity,
    input_during_tts: InputDuringTtsPolicy,
    output_device: Option<&str>,
    output_latency_grace: Duration,
) -> Result<SiriStreamOutcome, SiriStreamFailure> {
    let tts = ConfiguredTtsSlot::new(TtsConfiguration::siri(
        selection.name().to_owned(),
        selection.language().to_owned(),
        speed,
    ))?;
    let tts = tts.lease()?;
    let backend = tts.backend();
    let pcm_spec = backend.pcm_spec();
    let player =
        PocketAudioPlayer::new(pcm_spec.sample_rate, pcm_spec.playback_rate, output_device)?;
    let mut playback = OutboundPlayback::new(&player, &active, pcm_spec.sample_rate, 0)?;
    let mut pending = String::new();
    let mut first_chunk_pending = true;
    let mut assistant_speech = None::<AssistantSpeechGuard>;
    let mut playback_drained_at = None;
    let mut last_progress_emit = Instant::now();
    let mut last_progress = None;

    let result: Result<SiriStreamOutcome, String> = (|| loop {
        update_siri_assistant_speech(
            player.is_drained(),
            &mut assistant_speech,
            &mut playback_drained_at,
            output_latency_grace,
            Instant::now(),
        );
        if !playback.poll().map_err(|failure| failure.message)? {
            return Ok(SiriStreamOutcome {
                state: SiriStreamEventState::Interrupted,
                delivery: Some(playback.snapshot()),
            });
        }
        let command = receiver.recv_timeout(Duration::from_millis(10));
        match command {
            Ok(SiriStreamCommand::Append(text)) => {
                pending.push_str(&text);
                if !synthesize_siri_stream_ready(
                    &app,
                    &stream_id,
                    backend.as_ref(),
                    &mut playback,
                    &player,
                    output_latency_grace,
                    &mut pending,
                    &mut first_chunk_pending,
                    &native_voice,
                    interruption_sensitivity,
                    input_during_tts,
                    &mut assistant_speech,
                    &mut playback_drained_at,
                    &mut last_progress_emit,
                    &mut last_progress,
                    false,
                )? {
                    return Ok(SiriStreamOutcome {
                        state: SiriStreamEventState::Interrupted,
                        delivery: Some(playback.snapshot()),
                    });
                }
            }
            Ok(SiriStreamCommand::Flush) => {
                if !synthesize_siri_stream_ready(
                    &app,
                    &stream_id,
                    backend.as_ref(),
                    &mut playback,
                    &player,
                    output_latency_grace,
                    &mut pending,
                    &mut first_chunk_pending,
                    &native_voice,
                    interruption_sensitivity,
                    input_during_tts,
                    &mut assistant_speech,
                    &mut playback_drained_at,
                    &mut last_progress_emit,
                    &mut last_progress,
                    true,
                )? {
                    return Ok(SiriStreamOutcome {
                        state: SiriStreamEventState::Interrupted,
                        delivery: Some(playback.snapshot()),
                    });
                }
            }
            Ok(SiriStreamCommand::Finish) => {
                if !synthesize_siri_stream_ready(
                    &app,
                    &stream_id,
                    backend.as_ref(),
                    &mut playback,
                    &player,
                    output_latency_grace,
                    &mut pending,
                    &mut first_chunk_pending,
                    &native_voice,
                    interruption_sensitivity,
                    input_during_tts,
                    &mut assistant_speech,
                    &mut playback_drained_at,
                    &mut last_progress_emit,
                    &mut last_progress,
                    true,
                )? {
                    return Ok(SiriStreamOutcome {
                        state: SiriStreamEventState::Interrupted,
                        delivery: Some(playback.snapshot()),
                    });
                }
                let total_frames = playback
                    .snapshot()
                    .segments
                    .iter()
                    .map(|segment| segment.total_frames)
                    .sum();
                let post_drain = output_latency_grace_remaining(
                    assistant_speech.is_some(),
                    playback_drained_at,
                    output_latency_grace,
                    Instant::now(),
                );
                let outcome = playback
                    .finish(
                        DrainPolicy {
                            poll_interval: Duration::from_millis(10),
                            timeout: Some(siri_drain_timeout(
                                total_frames,
                                player.completed_source_frames(),
                                pcm_spec.sample_rate,
                            )),
                            post_drain,
                            ..DrainPolicy::default()
                        },
                        &mut |delivery| {
                            update_siri_assistant_speech(
                                player.is_drained(),
                                &mut assistant_speech,
                                &mut playback_drained_at,
                                output_latency_grace,
                                Instant::now(),
                            );
                            emit_siri_progress_if_changed(
                                &app,
                                &stream_id,
                                delivery,
                                &mut last_progress_emit,
                                &mut last_progress,
                            );
                            Ok(())
                        },
                    )
                    .map_err(|failure| failure.message)?;
                if outcome == OutboundOutcome::Interrupted {
                    return Ok(SiriStreamOutcome {
                        state: SiriStreamEventState::Interrupted,
                        delivery: Some(playback.snapshot()),
                    });
                }
                assistant_speech.take();
                return Ok(SiriStreamOutcome {
                    state: SiriStreamEventState::Completed,
                    delivery: None,
                });
            }
            Ok(SiriStreamCommand::Stop) | Err(mpsc::RecvTimeoutError::Disconnected) => {
                active.store(false, Ordering::SeqCst);
                playback.interrupt().map_err(|failure| failure.message)?;
                return Ok(SiriStreamOutcome {
                    state: SiriStreamEventState::Interrupted,
                    delivery: Some(playback.snapshot()),
                });
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if playback.started() {
                    let delivery = playback.snapshot();
                    emit_siri_progress_if_changed(
                        &app,
                        &stream_id,
                        &delivery,
                        &mut last_progress_emit,
                        &mut last_progress,
                    );
                }
            }
        }
    })();

    assistant_speech.take();
    result.map_err(|error| {
        let delivery = delivery_with_played_audio(playback.snapshot());
        let _ = playback.interrupt();
        SiriStreamFailure { error, delivery }
    })
}

#[tauri::command]
#[allow(clippy::too_many_arguments)] // Tauri injects four runtime dependencies beside the stream payload.
pub fn start_siri_voice_stream(
    app: AppHandle,
    webview_window: tauri::WebviewWindow,
    state: tauri::State<'_, SiriVoiceState>,
    native_voice: tauri::State<'_, NativeVoiceState>,
    session_id: String,
    expected_revision: u64,
    speech_id: u64,
    stream_id: String,
    voice: SiriVoiceSelection,
    interruption_mode: VoiceInterruptionMode,
    interruption_sensitivity: InterruptionSensitivity,
) -> Result<bool, String> {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (
            app,
            webview_window,
            state,
            native_voice,
            session_id,
            expected_revision,
            speech_id,
            stream_id,
            voice,
            interruption_mode,
            interruption_sensitivity,
        );
        Err("Siri TTS is only available on macOS".to_string())
    }

    #[cfg(target_os = "macos")]
    {
        if stream_id.trim().is_empty() {
            return Err("Siri voice stream id cannot be empty".to_string());
        }
        let voice = resolve_stream_voice(&voice, || discover_voices(""))?;
        let settings = read_settings(&settings_path(&app)?);
        let active = begin_playback(&state, webview_window.label())?;
        let output_device = selected_output_device();
        let effective_output_device = effective_output_device_name(output_device.as_deref());
        let input_during_tts =
            resolve_input_during_tts_policy(interruption_mode, effective_output_device.as_deref());
        let playback_latency_safety_duration =
            playback_latency_safety_duration(effective_output_device.as_deref());
        let Some(admission) = native_voice.claim_assistant_speech(
            &session_id,
            expected_revision,
            speech_id,
            active.clone(),
        )?
        else {
            finish_playback(state.inner(), &active);
            return Ok(false);
        };
        let (sender, receiver) = mpsc::channel();
        {
            let mut runtime = state
                .runtime
                .lock()
                .map_err(|_| "Siri playback state lock was poisoned".to_string())?;
            runtime.stream = Some(ActiveSiriStream {
                id: stream_id.clone(),
                sender,
            });
        }
        let playback_state = state.inner().clone();
        let playback_active = active.clone();
        let native_voice_state = native_voice.inner().clone();
        tauri::async_runtime::spawn_blocking(move || {
            let admission_guard = admission;
            let result = run_siri_stream(
                app.clone(),
                stream_id.clone(),
                voice,
                settings
                    .playback_speed
                    .clamp(MIN_PLAYBACK_SPEED, MAX_PLAYBACK_SPEED),
                active.clone(),
                receiver,
                native_voice_state,
                interruption_sensitivity,
                input_during_tts,
                output_device.as_deref(),
                playback_latency_safety_duration,
            );
            let (event_state, error, delivery) = match result {
                Ok(outcome) => (outcome.state, None, outcome.delivery),
                Err(failure) if !active.load(Ordering::SeqCst) => {
                    (SiriStreamEventState::Interrupted, None, failure.delivery)
                }
                Err(failure) => (
                    SiriStreamEventState::Failed,
                    Some(failure.error),
                    failure.delivery,
                ),
            };
            finish_playback(&playback_state, &playback_active);
            // A terminal event hands stream ownership back to the renderer,
            // which may immediately start a replacement stream. Release the
            // backend playback token before publishing that handoff.
            drop(admission_guard);
            emit_stream_event(&app, &stream_id, event_state, error, delivery);
        });
        Ok(true)
    }
}

#[tauri::command]
pub fn append_siri_voice_stream(
    state: tauri::State<'_, SiriVoiceState>,
    stream_id: String,
    text: String,
) -> Result<(), String> {
    if text.is_empty() {
        return Ok(());
    }
    send_stream_command(&state, &stream_id, SiriStreamCommand::Append(text))
}

#[tauri::command]
pub fn flush_siri_voice_stream(
    state: tauri::State<'_, SiriVoiceState>,
    stream_id: String,
) -> Result<(), String> {
    send_stream_command(&state, &stream_id, SiriStreamCommand::Flush)
}

#[tauri::command]
pub fn finish_siri_voice_stream(
    state: tauri::State<'_, SiriVoiceState>,
    stream_id: String,
) -> Result<(), String> {
    send_stream_command(&state, &stream_id, SiriStreamCommand::Finish)
}

#[cfg(target_os = "macos")]
fn send_stream_command(
    state: &SiriVoiceState,
    stream_id: &str,
    command: SiriStreamCommand,
) -> Result<(), String> {
    let runtime = state
        .runtime
        .lock()
        .map_err(|_| "Siri playback state lock was poisoned".to_string())?;
    let stream = runtime
        .stream
        .as_ref()
        .filter(|stream| stream.id == stream_id)
        .ok_or_else(|| format!("Siri voice stream is not active: {stream_id}"))?;
    stream
        .sender
        .send(command)
        .map_err(|_| format!("Siri voice stream worker stopped: {stream_id}"))
}

#[cfg(not(target_os = "macos"))]
fn send_stream_command(
    _state: &SiriVoiceState,
    _stream_id: &str,
    _command: SiriStreamCommand,
) -> Result<(), String> {
    Err("Siri TTS is only available on macOS".to_string())
}

#[tauri::command]
pub async fn preview_siri_voice(
    app: AppHandle,
    webview_window: tauri::WebviewWindow,
    state: tauri::State<'_, SiriVoiceState>,
    native_voice: tauri::State<'_, NativeVoiceState>,
    voice: SiriVoiceSelection,
) -> Result<(), String> {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, webview_window, state, native_voice, voice);
        Err("Siri TTS is only available on macOS".to_string())
    }

    #[cfg(target_os = "macos")]
    {
        let speed = read_settings(&settings_path(&app)?)
            .playback_speed
            .clamp(MIN_PLAYBACK_SPEED, MAX_PLAYBACK_SPEED);
        let text = CString::new("Hello. This is a preview of my voice.").expect("static preview");
        let language = CString::new(voice.language())
            .map_err(|_| "Siri voice language cannot contain NUL bytes".to_string())?;
        let name = CString::new(voice.name())
            .map_err(|_| "Siri voice name cannot contain NUL bytes".to_string())?;
        let active = begin_playback(&state, webview_window.label())?;
        let assistant_speech =
            output_device_uses_speakers(effective_output_device_name(None).as_deref()).then(|| {
                log::info!("[voice-echo-guard] speaker output detected");
                native_voice.begin_assistant_speech(
                    InterruptionSensitivity::Balanced,
                    InputDuringTtsPolicy::SuppressInput,
                )
            });
        let playback_state = state.inner().clone();
        let playback_active = active.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let _assistant_speech = assistant_speech;
            let result = (|| {
                let mut error = std::ptr::null_mut();
                // SAFETY: The bridge copies all strings synchronously. The Arc
                // keeps the callback context alive until the call returns.
                let context = Arc::as_ptr(&playback_active).cast_mut().cast();
                let sample_played = unsafe {
                    berd_siri_tts_play_sample(
                        name.as_ptr(),
                        language.as_ptr(),
                        speed,
                        Some(should_stop_siri_playback),
                        context,
                        &mut error,
                    )
                };
                if sample_played {
                    return Ok(());
                }

                let sample_error = bridge_error(error, "No system preview is available");
                if validate_installed_voice(&voice).is_err() {
                    return Err(sample_error);
                }

                error = std::ptr::null_mut();
                // SAFETY: The bridge copies all strings synchronously and the
                // callback context remains alive for the duration of the call.
                let spoken = unsafe {
                    berd_siri_tts_speak(
                        text.as_ptr(),
                        language.as_ptr(),
                        name.as_ptr(),
                        speed,
                        Some(should_stop_siri_playback),
                        None,
                        context,
                        &mut error,
                    )
                };
                spoken
                    .then_some(())
                    .ok_or_else(|| bridge_error(error, "Siri voice preview failed"))
            })();
            finish_playback(&playback_state, &playback_active);
            result
        })
        .await
        .map_err(|error| format!("Siri voice preview task failed: {error}"))?
    }
}

#[tauri::command]
pub fn stop_siri_voice(state: tauri::State<'_, SiriVoiceState>) -> Result<bool, String> {
    stop_siri_playback(&state)
}

fn stop_siri_playback(state: &SiriVoiceState) -> Result<bool, String> {
    stop_siri_playback_for_owner(state, None)
}

fn stop_siri_playback_for_owner(
    state: &SiriVoiceState,
    owner_window: Option<&str>,
) -> Result<bool, String> {
    let runtime = state
        .runtime
        .lock()
        .map_err(|_| "Siri playback state lock was poisoned".to_string())?;
    if owner_window.is_some_and(|owner| runtime.owner_window.as_deref() != Some(owner)) {
        return Ok(false);
    }
    let Some(active) = runtime.active.as_ref() else {
        return Ok(false);
    };
    active.store(false, Ordering::SeqCst);
    #[cfg(target_os = "macos")]
    if let Some(stream) = runtime.stream.as_ref() {
        let _ = stream.sender.send(SiriStreamCommand::Stop);
    }
    Ok(true)
}

impl SiriVoiceState {
    pub(crate) fn stop_for_window_destroyed(&self, window_label: &str) -> bool {
        stop_siri_playback_for_owner(self, Some(window_label)).unwrap_or_else(|error| {
            log::warn!("Failed to stop Siri playback for a destroyed window: {error}");
            false
        })
    }

    pub(crate) fn stop_for_app_exit(&self) {
        if let Err(error) = stop_siri_playback(self) {
            log::warn!("Failed to stop Siri playback during app exit: {error}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn voice_lookup_normalizes_language_but_preserves_exact_name() {
        let voices = vec![SiriVoice {
            name: "Aaron".to_string(),
            language: "en-US".to_string(),
            size_bytes: 10,
            installed: true,
        }];
        let selected = SiriVoiceSelection::new("Aaron", "en-US").unwrap();
        assert_eq!(
            voices.iter().find(|voice| voice.matches(&selected)),
            voices.first()
        );
        assert!(voices
            .iter()
            .find(|voice| { voice.matches(&SiriVoiceSelection::new("aaron", "en-US").unwrap()) })
            .is_none());
    }

    #[test]
    fn settings_default_without_a_selected_voice() {
        let directory = tempfile::tempdir().expect("tempdir");
        assert_eq!(
            read_settings(&directory.path().join("missing.json")).selected_voice,
            None
        );
    }

    #[test]
    fn concurrent_settings_updates_preserve_both_fields() {
        let directory = tempfile::tempdir().expect("tempdir");
        let path = Arc::new(directory.path().join("settings.json"));
        let (selection_entered_tx, selection_entered_rx) = std::sync::mpsc::channel();
        let (release_selection_tx, release_selection_rx) = std::sync::mpsc::channel();

        let selection_path = path.clone();
        let selection_writer = std::thread::spawn(move || {
            update_settings(&selection_path, |settings| {
                selection_entered_tx.send(()).expect("signal settings read");
                release_selection_rx
                    .recv()
                    .expect("release selection write");
                settings.selected_voice = Some(SiriVoiceSelection::new("Aaron", "en-US").unwrap());
                true
            })
            .expect("write selected voice");
        });

        selection_entered_rx
            .recv()
            .expect("selection acquired lock");
        assert!(matches!(
            SIRI_SETTINGS_LOCK.try_lock(),
            Err(std::sync::TryLockError::WouldBlock)
        ));
        let speed_path = path.clone();
        let (speed_started_tx, speed_started_rx) = std::sync::mpsc::channel();
        let speed_writer = std::thread::spawn(move || {
            speed_started_tx.send(()).expect("signal speed update");
            update_settings(&speed_path, |settings| {
                settings.playback_speed = 1.5;
                true
            })
            .expect("write playback speed");
        });
        speed_started_rx.recv().expect("speed update started");
        release_selection_tx.send(()).expect("release selection");
        selection_writer.join().expect("selection writer");
        speed_writer.join().expect("speed writer");

        let settings = read_settings(&path);
        assert_eq!(
            settings.selected_voice,
            Some(SiriVoiceSelection::new("Aaron", "en-US").unwrap())
        );
        assert_eq!(settings.playback_speed, 1.5);
        serde_json::from_slice::<SiriVoiceSettings>(&fs::read(&*path).expect("settings JSON"))
            .expect("valid settings JSON");
    }

    #[test]
    fn auto_selection_uses_an_installed_siri_voice() {
        let voices = vec![
            SiriVoice {
                name: "Quinn".to_string(),
                language: "en-US".to_string(),
                size_bytes: 10,
                installed: false,
            },
            SiriVoice {
                name: "Aaron".to_string(),
                language: "en-US".to_string(),
                size_bytes: 10,
                installed: true,
            },
        ];

        assert_eq!(
            resolve_voice_selection(&voices, None, || Ok(Vec::new())),
            Ok((
                Some(SiriVoiceSelection::new("Aaron", "en-US").unwrap()),
                true,
            ))
        );
    }

    #[test]
    fn auto_selection_falls_back_to_an_installed_voice_outside_the_filter() {
        let filtered_voices = vec![SiriVoice {
            name: "Aaron".to_string(),
            language: "en-US".to_string(),
            size_bytes: 10,
            installed: false,
        }];

        assert_eq!(
            resolve_voice_selection(&filtered_voices, None, || {
                Ok(vec![SiriVoice {
                    name: "Catherine".to_string(),
                    language: "en-AU".to_string(),
                    size_bytes: 10,
                    installed: true,
                }])
            }),
            Ok((
                Some(SiriVoiceSelection::new("Catherine", "en-AU").unwrap()),
                true,
            ))
        );
    }

    #[test]
    fn unavailable_selection_falls_back_to_an_installed_siri_voice() {
        let selected = SiriVoiceSelection::new("Aaron", "en-US").unwrap();
        let preferred_voices = vec![
            SiriVoice {
                name: "Aaron".to_string(),
                language: "en-US".to_string(),
                size_bytes: 10,
                installed: false,
            },
            SiriVoice {
                name: "Samantha".to_string(),
                language: "en-US".to_string(),
                size_bytes: 10,
                installed: true,
            },
        ];

        assert_eq!(
            resolve_voice_selection(&preferred_voices, Some(&selected), || {
                Ok(vec![
                    SiriVoice {
                        name: "Catherine".to_string(),
                        language: "en-AU".to_string(),
                        size_bytes: 10,
                        installed: true,
                    },
                    preferred_voices[1].clone(),
                ])
            }),
            Ok((
                Some(SiriVoiceSelection::new("Catherine", "en-AU").unwrap()),
                true,
            ))
        );
    }

    #[test]
    fn unavailable_selection_is_preserved_when_no_siri_voice_is_installed() {
        let selected = SiriVoiceSelection::new("Aaron", "en-US").unwrap();
        let voices = vec![SiriVoice {
            name: "Aaron".to_string(),
            language: "en-US".to_string(),
            size_bytes: 10,
            installed: false,
        }];

        assert_eq!(
            resolve_voice_selection(&voices, Some(&selected), || Ok(voices.clone())),
            Ok((Some(selected), false))
        );
    }

    #[test]
    fn stream_voice_ingress_re_resolves_a_voice_removed_after_status() {
        let selected = SiriVoiceSelection::new("Aaron", "en-US").unwrap();
        let status_catalog = vec![SiriVoice {
            name: selected.name().to_string(),
            language: selected.language().to_string(),
            size_bytes: 10,
            installed: true,
        }];
        assert!(status_catalog
            .iter()
            .find(|voice| voice.matches(&selected))
            .is_some_and(|voice| voice.installed));

        let current_catalog = vec![
            SiriVoice {
                installed: false,
                ..status_catalog[0].clone()
            },
            SiriVoice {
                name: "Catherine".to_string(),
                language: "en-AU".to_string(),
                size_bytes: 10,
                installed: true,
            },
        ];

        assert_eq!(
            resolve_stream_voice(&selected, || Ok(current_catalog)),
            Ok(SiriVoiceSelection::new("Catherine", "en-AU").unwrap())
        );
    }

    #[test]
    fn stream_voice_ingress_rejects_when_no_siri_voice_is_installed() {
        let selected = SiriVoiceSelection::new("Aaron", "en-US").unwrap();

        assert_eq!(
            resolve_stream_voice(&selected, || {
                Ok(vec![SiriVoice {
                    name: selected.name().to_string(),
                    language: selected.language().to_string(),
                    size_bytes: 10,
                    installed: false,
                }])
            }),
            Err(
                "No installed Siri voice is available. Open Voice settings to download one."
                    .to_string()
            )
        );
    }

    #[test]
    fn window_destroy_stops_only_its_owned_siri_playback() {
        let state = SiriVoiceState::default();
        let active = begin_playback(&state, "session-window").expect("start playback");

        assert!(!state.stop_for_window_destroyed("other-window"));
        assert!(active.load(Ordering::SeqCst));

        assert!(state.stop_for_window_destroyed("session-window"));
        assert!(!active.load(Ordering::SeqCst));

        finish_playback(&state, &active);
        assert!(begin_playback(&state, "next-window").is_ok());
    }

    #[test]
    fn siri_drain_bound_covers_remaining_pcm_and_stall_margin() {
        assert_eq!(
            siri_drain_timeout(144_000, 48_000, 48_000),
            SIRI_OUTPUT_DRAIN_MARGIN + Duration::from_secs(2)
        );
        assert_eq!(
            siri_drain_timeout(48_000, 96_000, 48_000),
            SIRI_OUTPUT_DRAIN_MARGIN
        );
    }

    #[test]
    fn siri_route_grace_preserves_only_the_unelapsed_tail() {
        let now = Instant::now();
        let grace = Duration::from_millis(500);
        assert_eq!(
            output_latency_grace_remaining(true, None, grace, now),
            grace
        );
        assert_eq!(
            output_latency_grace_remaining(
                true,
                Some(now - Duration::from_millis(200)),
                grace,
                now,
            ),
            Duration::from_millis(300)
        );
        assert_eq!(
            output_latency_grace_remaining(false, None, grace, now),
            Duration::ZERO
        );

        let mut drained_at = None;
        assert!(!output_latency_grace_elapsed(
            false,
            true,
            &mut drained_at,
            grace,
            now + Duration::from_secs(10),
        ));
        assert_eq!(drained_at, None);
    }

    #[test]
    fn failed_stream_retains_only_delivery_with_played_audio() {
        let progress = VoiceDeliveryProgress {
            sample_rate: 24_000,
            segments: vec![VoiceDeliverySegment {
                text: "Partly heard.".to_string(),
                played_frames: 1_200,
                total_frames: 4_800,
                synthesis_complete: true,
            }],
        };
        assert_eq!(
            delivery_with_played_audio(progress)
                .expect("played audio is evidence")
                .segments[0]
                .played_frames,
            1_200
        );

        let unheard = VoiceDeliveryProgress {
            sample_rate: 24_000,
            segments: vec![VoiceDeliverySegment {
                text: "Not heard.".to_string(),
                played_frames: 0,
                total_frames: 4_800,
                synthesis_complete: true,
            }],
        };
        assert!(delivery_with_played_audio(unheard).is_none());
    }
}
