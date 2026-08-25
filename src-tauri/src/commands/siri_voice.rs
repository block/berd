//! macOS SiriTTSD voice discovery, download, and selection.

#[cfg(target_os = "macos")]
use std::ffi::{CStr, CString};
use std::fs;
#[cfg(target_os = "macos")]
use std::os::raw::c_char;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
#[cfg(any(test, target_os = "macos"))]
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
use super::native_voice::{InterruptionSensitivity, NativeVoiceState};
use super::pocket_voice::VoiceInterruptionMode;
#[cfg(target_os = "macos")]
use super::pocket_voice::{
    effective_output_device_name, output_device_uses_speakers, playback_latency_safety_duration,
    should_suppress_capture,
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

#[cfg(any(test, target_os = "macos"))]
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct VoiceDeliverySegment {
    text: String,
    played_frames: u64,
    total_frames: u64,
    synthesis_complete: bool,
}

#[cfg(any(test, target_os = "macos"))]
#[derive(Clone, Debug, Deserialize, Serialize)]
struct VoiceDeliveryProgress {
    #[serde(rename = "sampleRate")]
    sample_rate: u32,
    segments: Vec<VoiceDeliverySegment>,
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

#[cfg(any(test, target_os = "macos"))]
fn capture_before_cancel<T>(snapshot: impl FnOnce() -> T, cancel: impl FnOnce()) -> T {
    let delivery = snapshot();
    cancel();
    delivery
}

#[cfg(target_os = "macos")]
const SIRI_STREAM_EVENT: &str = "siri-voice:stream-event";
#[cfg(target_os = "macos")]
const SIRI_STREAM_STALL_TIMEOUT: Duration = Duration::from_secs(60);
#[cfg(target_os = "macos")]
const PLAYBACK_PROGRESS_EMIT_INTERVAL: Duration = Duration::from_millis(100);
const MIN_PLAYBACK_SPEED: f32 = 0.5;
const MAX_PLAYBACK_SPEED: f32 = 2.0;
static SIRI_SETTINGS_LOCK: Mutex<()> = Mutex::new(());
static SIRI_SETTINGS_TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

#[cfg(any(test, target_os = "macos"))]
struct SiriPlaybackLifetimeState<T> {
    guard: Option<T>,
    generation: u64,
    cancelled: bool,
}

#[cfg(any(test, target_os = "macos"))]
struct SiriPlaybackLifetime<T> {
    state: Mutex<SiriPlaybackLifetimeState<T>>,
}

#[cfg(any(test, target_os = "macos"))]
impl<T> Default for SiriPlaybackLifetime<T> {
    fn default() -> Self {
        Self {
            state: Mutex::new(SiriPlaybackLifetimeState {
                guard: None,
                generation: 0,
                cancelled: false,
            }),
        }
    }
}

#[cfg(any(test, target_os = "macos"))]
impl<T> SiriPlaybackLifetime<T> {
    fn start(&self, create_guard: impl FnOnce() -> T) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if state.cancelled {
            return;
        }
        state.generation = state.generation.wrapping_add(1);
        if state.guard.is_none() {
            state.guard = Some(create_guard());
        }
    }

    fn begin_drain(&self) -> Option<u64> {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if state.cancelled || state.guard.is_none() {
            return None;
        }
        state.generation = state.generation.wrapping_add(1);
        Some(state.generation)
    }

    fn release_if_current(&self, generation: u64) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if !state.cancelled && state.generation == generation {
            state.guard.take();
        }
    }

    fn is_active(&self) -> bool {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .guard
            .is_some()
    }

    fn cancel(&self) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.cancelled = true;
        state.generation = state.generation.wrapping_add(1);
        state.guard.take();
    }
}

#[cfg(any(test, target_os = "macos"))]
enum SiriPlaybackMonitorEvent {
    Started,
    Drain(u64),
    Shutdown,
}

#[cfg(any(test, target_os = "macos"))]
fn run_siri_playback_monitor<T>(
    receiver: mpsc::Receiver<SiriPlaybackMonitorEvent>,
    lifetime: Arc<SiriPlaybackLifetime<T>>,
    playback_latency_safety_duration: Duration,
) {
    let mut pending_release: Option<(u64, Instant)> = None;
    loop {
        let event = if let Some((_, deadline)) = pending_release {
            match receiver.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
                Ok(event) => Some(event),
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    if let Some((generation, _)) = pending_release.take() {
                        lifetime.release_if_current(generation);
                    }
                    continue;
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => return,
            }
        } else {
            match receiver.recv() {
                Ok(event) => Some(event),
                Err(mpsc::RecvError) => return,
            }
        };

        match event {
            Some(SiriPlaybackMonitorEvent::Started) => pending_release = None,
            Some(SiriPlaybackMonitorEvent::Drain(generation)) => {
                pending_release = Some((
                    generation,
                    Instant::now() + playback_latency_safety_duration,
                ));
            }
            Some(SiriPlaybackMonitorEvent::Shutdown) | None => return,
        }
    }
}

#[cfg(any(test, target_os = "macos"))]
fn spawn_siri_playback_monitor_with<F>(
    task: impl FnOnce() + Send + 'static,
    spawn: F,
) -> std::io::Result<std::thread::JoinHandle<()>>
where
    F: FnOnce(Box<dyn FnOnce() + Send>) -> std::io::Result<std::thread::JoinHandle<()>>,
{
    spawn(Box::new(task))
}

#[cfg(target_os = "macos")]
fn spawn_siri_playback_monitor<T: Send + 'static>(
    receiver: mpsc::Receiver<SiriPlaybackMonitorEvent>,
    lifetime: Arc<SiriPlaybackLifetime<T>>,
    playback_latency_safety_duration: Duration,
    failed: Arc<AtomicBool>,
) -> std::io::Result<std::thread::JoinHandle<()>> {
    spawn_siri_playback_monitor_with(
        move || {
            let monitor_lifetime = Arc::clone(&lifetime);
            if std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                run_siri_playback_monitor(
                    receiver,
                    monitor_lifetime,
                    playback_latency_safety_duration,
                );
            }))
            .is_err()
            {
                failed.store(true, Ordering::SeqCst);
                lifetime.cancel();
            }
        },
        |task| {
            std::thread::Builder::new()
                .name("siri-playback-monitor".to_string())
                .spawn(task)
        },
    )
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SiriVoice {
    name: String,
    language: String,
    size_bytes: u64,
    installed: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SiriVoiceSelection {
    name: String,
    language: String,
}

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
    fn berd_siri_tts_catalog_json(
        language_prefix: *const c_char,
        error_out: *mut *mut c_char,
    ) -> *mut c_char;
    fn berd_siri_tts_languages_json(error_out: *mut *mut c_char) -> *mut c_char;
    fn berd_siri_tts_download_voice(
        language: *const c_char,
        voice_name: *const c_char,
        timeout_seconds: f64,
        error_out: *mut *mut c_char,
    ) -> bool;
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
    fn berd_siri_tts_stream_create(
        language: *const c_char,
        voice_name: *const c_char,
        rate: f32,
        playback_started: Option<unsafe extern "C" fn(*mut std::ffi::c_void)>,
        playback_stopped: Option<unsafe extern "C" fn(*mut std::ffi::c_void)>,
        context: *mut std::ffi::c_void,
        error_out: *mut *mut c_char,
    ) -> *mut std::ffi::c_void;
    fn berd_siri_tts_stream_enqueue(
        stream: *mut std::ffi::c_void,
        text: *const c_char,
        error_out: *mut *mut c_char,
    ) -> bool;
    fn berd_siri_tts_stream_finish(stream: *mut std::ffi::c_void);
    fn berd_siri_tts_stream_is_finished(stream: *mut std::ffi::c_void) -> bool;
    fn berd_siri_tts_stream_progress(stream: *mut std::ffi::c_void) -> u64;
    fn berd_siri_tts_stream_copy_delivery_json(stream: *mut std::ffi::c_void) -> *mut c_char;
    fn berd_siri_tts_stream_copy_error(stream: *mut std::ffi::c_void) -> *mut c_char;
    fn berd_siri_tts_stream_cancel(stream: *mut std::ffi::c_void);
    fn berd_siri_tts_stream_release(stream: *mut std::ffi::c_void);
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
#[derive(Debug)]
struct SiriStreamWatchdog {
    progress: u64,
    last_progress_at: Instant,
}

#[cfg(target_os = "macos")]
impl SiriStreamWatchdog {
    fn new(progress: u64, now: Instant) -> Self {
        Self {
            progress,
            last_progress_at: now,
        }
    }

    fn observe(&mut self, progress: u64, now: Instant) -> bool {
        if progress != self.progress {
            self.progress = progress;
            self.last_progress_at = now;
            return false;
        }
        now.duration_since(self.last_progress_at) >= SIRI_STREAM_STALL_TIMEOUT
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
struct SiriStreamCallbackContext {
    app: AppHandle,
    stream_id: String,
    native_voice: NativeVoiceState,
    interruption_sensitivity: InterruptionSensitivity,
    suppress_capture: bool,
    playback_started: AtomicBool,
    playback_lifetime: Arc<SiriPlaybackLifetime<AssistantSpeechGuard>>,
    playback_monitor_sender: mpsc::Sender<SiriPlaybackMonitorEvent>,
}

#[cfg(target_os = "macos")]
unsafe extern "C" fn siri_playback_started(context: *mut std::ffi::c_void) {
    if context.is_null() {
        return;
    }
    // SAFETY: The stream worker owns this boxed context until after the native
    // player has completed and been released.
    let context = unsafe { &*(context.cast::<SiriStreamCallbackContext>()) };
    context.playback_lifetime.start(|| {
        context
            .native_voice
            .begin_assistant_speech(context.interruption_sensitivity, context.suppress_capture)
    });
    let _ = context
        .playback_monitor_sender
        .send(SiriPlaybackMonitorEvent::Started);
    if !context.playback_started.swap(true, Ordering::AcqRel) {
        let _ = context.app.emit(
            SIRI_STREAM_EVENT,
            SiriStreamEvent {
                stream_id: context.stream_id.clone(),
                state: SiriStreamEventState::Started,
                error: None,
                delivery: None,
            },
        );
    }
}

#[cfg(target_os = "macos")]
unsafe extern "C" fn siri_playback_stopped(context: *mut std::ffi::c_void) {
    if context.is_null() {
        return;
    }
    // SAFETY: The stream worker owns this boxed context until after the native
    // player has completed and been released.
    let context = unsafe { &*(context.cast::<SiriStreamCallbackContext>()) };
    let Some(generation) = context.playback_lifetime.begin_drain() else {
        return;
    };
    let _ = context
        .playback_monitor_sender
        .send(SiriPlaybackMonitorEvent::Drain(generation));
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
    let prefix = CString::new(language_prefix)
        .map_err(|_| "Siri voice language cannot contain NUL bytes".to_string())?;
    let mut error = std::ptr::null_mut();
    // SAFETY: The bridge copies the input string synchronously and returns
    // owned strings through its documented allocation contract.
    let json = unsafe { berd_siri_tts_catalog_json(prefix.as_ptr(), &mut error) };
    let json = take_bridge_string(json)
        .ok_or_else(|| bridge_error(error, "Could not load the Siri voice catalog"))?;
    serde_json::from_str(&json).map_err(|error| format!("decode Siri voice catalog: {error}"))
}

#[cfg(target_os = "macos")]
fn discover_languages() -> Result<Vec<String>, String> {
    let mut error = std::ptr::null_mut();
    // SAFETY: Returned strings follow the bridge allocation contract.
    let json = unsafe { berd_siri_tts_languages_json(&mut error) };
    let json = take_bridge_string(json)
        .ok_or_else(|| bridge_error(error, "Could not load Siri voice languages"))?;
    serde_json::from_str(&json).map_err(|error| format!("decode Siri voice languages: {error}"))
}

#[cfg(not(target_os = "macos"))]
fn discover_voices(_language_prefix: &str) -> Result<Vec<SiriVoice>, String> {
    Ok(Vec::new())
}

#[cfg(not(target_os = "macos"))]
fn discover_languages() -> Result<Vec<String>, String> {
    Ok(Vec::new())
}

fn normalize_language(value: &str) -> String {
    value.replace('_', "-").to_lowercase()
}

fn find_voice<'a>(
    voices: &'a [SiriVoice],
    selection: &SiriVoiceSelection,
) -> Option<&'a SiriVoice> {
    let language = normalize_language(&selection.language);
    voices.iter().find(|voice| {
        voice.name.eq_ignore_ascii_case(&selection.name)
            && normalize_language(&voice.language) == language
    })
}

fn first_installed_voice(voices: &[SiriVoice]) -> Option<SiriVoiceSelection> {
    voices
        .iter()
        .find(|voice| voice.installed)
        .map(|voice| SiriVoiceSelection {
            name: voice.name.clone(),
            language: voice.language.clone(),
        })
}

fn resolve_voice_selection(
    preferred_voices: &[SiriVoice],
    selected_voice: Option<&SiriVoiceSelection>,
    load_all_voices: impl FnOnce() -> Result<Vec<SiriVoice>, String>,
) -> Result<(Option<SiriVoiceSelection>, bool), String> {
    if let Some(selection) = selected_voice {
        if find_voice(preferred_voices, selection).is_some_and(|voice| voice.installed) {
            return Ok((Some(selection.clone()), true));
        }
    } else if let Some(selection) = first_installed_voice(preferred_voices) {
        return Ok((Some(selection), true));
    }

    let all_voices = load_all_voices()?;
    if let Some(selection) = selected_voice {
        if find_voice(&all_voices, selection).is_some_and(|voice| voice.installed) {
            return Ok((Some(selection.clone()), true));
        }
    }

    let fallback =
        first_installed_voice(preferred_voices).or_else(|| first_installed_voice(&all_voices));
    Ok(match fallback {
        Some(selection) => (Some(selection), true),
        None => (selected_voice.cloned(), false),
    })
}

fn status(app: &AppHandle, language_prefix: &str) -> Result<SiriVoiceStatus, String> {
    let voices = discover_voices(language_prefix)?;
    let available_languages = discover_languages()?;
    let path = settings_path(app)?;
    let previous_selection = read_settings(&path).selected_voice;
    let (resolved_selection, resolved_selection_installed) =
        resolve_voice_selection(&voices, previous_selection.as_ref(), || discover_voices(""))?;
    let settings = update_settings(&path, |settings| {
        if resolved_selection_installed
            && settings.selected_voice == previous_selection
            && settings.selected_voice != resolved_selection
        {
            settings.selected_voice = resolved_selection.clone();
            true
        } else {
            false
        }
    })?;
    let selected_voice_installed = if settings.selected_voice == resolved_selection {
        resolved_selection_installed
    } else {
        settings.selected_voice.as_ref().is_some_and(|selection| {
            find_voice(&voices, selection).is_some_and(|voice| voice.installed)
                || discover_voices(&selection.language)
                    .ok()
                    .and_then(|selected| find_voice(&selected, selection).cloned())
                    .is_some_and(|voice| voice.installed)
        })
    };
    Ok(SiriVoiceStatus {
        supported: cfg!(target_os = "macos"),
        available_languages,
        selected_voice: settings.selected_voice,
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
    let prefix = voice.language.clone();
    let candidate = voice.clone();
    let installed = tauri::async_runtime::spawn_blocking(move || {
        let voices = discover_voices(&prefix)?;
        Ok::<_, String>(find_voice(&voices, &candidate).is_some_and(|voice| voice.installed))
    })
    .await
    .map_err(|error| format!("Siri voice validation task failed: {error}"))??;
    if !installed {
        return Err(format!(
            "Siri voice {} ({}) must be downloaded before selection",
            voice.name, voice.language
        ));
    }
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
        let language = CString::new(voice.language.clone())
            .map_err(|_| "Siri voice language cannot contain NUL bytes".to_string())?;
        let name = CString::new(voice.name.clone())
            .map_err(|_| "Siri voice name cannot contain NUL bytes".to_string())?;
        tauri::async_runtime::spawn_blocking(move || {
            let mut error = std::ptr::null_mut();
            // SAFETY: Inputs stay alive for the blocking call and returned
            // errors follow the bridge string ownership contract.
            let downloaded = unsafe {
                berd_siri_tts_download_voice(language.as_ptr(), name.as_ptr(), 300.0, &mut error)
            };
            downloaded
                .then_some(())
                .ok_or_else(|| bridge_error(error, "Siri voice download failed"))
        })
        .await
        .map_err(|error| format!("Siri voice download task failed: {error}"))??;
        let _ = app;
        Ok(())
    }
}

#[cfg(target_os = "macos")]
fn enqueue_native_stream(stream: *mut std::ffi::c_void, text: &str) -> Result<(), String> {
    let text =
        CString::new(text).map_err(|_| "Siri speech text cannot contain NUL bytes".to_string())?;
    let mut error = std::ptr::null_mut();
    // SAFETY: The native stream remains owned by the worker for this call and
    // the bridge copies the text before returning.
    let accepted = unsafe { berd_siri_tts_stream_enqueue(stream, text.as_ptr(), &mut error) };
    accepted
        .then_some(())
        .ok_or_else(|| bridge_error(error, "Siri stream rejected text"))
}

#[cfg(target_os = "macos")]
fn siri_delivery_progress(stream: *mut std::ffi::c_void) -> Option<VoiceDeliveryProgress> {
    let json = take_bridge_string(unsafe { berd_siri_tts_stream_copy_delivery_json(stream) })?;
    serde_json::from_str(&json).ok()
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
    suppress_capture: bool,
    playback_latency_safety_duration: Duration,
) -> Result<SiriStreamOutcome, SiriStreamFailure> {
    let language = CString::new(selection.language)
        .map_err(|_| "Siri voice language cannot contain NUL bytes".to_string())?;
    let name = CString::new(selection.name)
        .map_err(|_| "Siri voice name cannot contain NUL bytes".to_string())?;
    let playback_lifetime = Arc::new(SiriPlaybackLifetime::default());
    let playback_monitor_failed = Arc::new(AtomicBool::new(false));
    let (playback_monitor_sender, playback_monitor_receiver) = mpsc::channel();
    let playback_monitor = spawn_siri_playback_monitor(
        playback_monitor_receiver,
        Arc::clone(&playback_lifetime),
        playback_latency_safety_duration,
        Arc::clone(&playback_monitor_failed),
    )
    .map_err(|error| format!("Could not start Siri playback monitor: {error}"))?;
    let callback_context = Box::new(SiriStreamCallbackContext {
        app: app.clone(),
        stream_id: stream_id.clone(),
        native_voice,
        interruption_sensitivity,
        suppress_capture,
        playback_started: AtomicBool::new(false),
        playback_lifetime: Arc::clone(&playback_lifetime),
        playback_monitor_sender: playback_monitor_sender.clone(),
    });
    let callback_context = Box::into_raw(callback_context);
    let mut error = std::ptr::null_mut();
    // SAFETY: Strings remain alive through creation. The callback context is
    // released only after the native stream has finished and is released.
    let stream = unsafe {
        berd_siri_tts_stream_create(
            language.as_ptr(),
            name.as_ptr(),
            speed,
            Some(siri_playback_started),
            Some(siri_playback_stopped),
            callback_context.cast(),
            &mut error,
        )
    };
    if stream.is_null() {
        // SAFETY: Native creation failed, so no callback retained the box.
        unsafe { drop(Box::from_raw(callback_context)) };
        playback_lifetime.cancel();
        let _ = playback_monitor_sender.send(SiriPlaybackMonitorEvent::Shutdown);
        let _ = playback_monitor.join();
        return Err(bridge_error(error, "Could not start Siri voice stream").into());
    }

    let result = (|| {
        let mut pending = String::new();
        let mut first_chunk_pending = true;
        let mut finishing = false;
        let mut watchdog: Option<SiriStreamWatchdog> = None;
        let mut last_progress_emit = Instant::now();
        let mut last_delivery_json = String::new();
        loop {
            if playback_monitor_failed.load(Ordering::SeqCst) {
                return Err("Siri playback monitor failed".to_string());
            }
            if !active.load(Ordering::SeqCst) {
                let delivery = siri_delivery_progress(stream);
                unsafe { berd_siri_tts_stream_cancel(stream) };
                return Ok(SiriStreamOutcome {
                    state: SiriStreamEventState::Interrupted,
                    delivery,
                });
            }
            if finishing && unsafe { berd_siri_tts_stream_is_finished(stream) } {
                let native_error =
                    take_bridge_string(unsafe { berd_siri_tts_stream_copy_error(stream) });
                if let Some(error) = native_error {
                    return Err(error);
                }
                if !playback_lifetime.is_active() {
                    return Ok(SiriStreamOutcome {
                        state: SiriStreamEventState::Completed,
                        delivery: None,
                    });
                }
            }
            if let Some(watchdog) = watchdog.as_mut() {
                let progress = unsafe { berd_siri_tts_stream_progress(stream) };
                if watchdog.observe(progress, Instant::now()) {
                    return Err("Siri synthesis stopped making progress".to_string());
                }
            }
            if last_progress_emit.elapsed() >= PLAYBACK_PROGRESS_EMIT_INTERVAL {
                if let Some(delivery) = siri_delivery_progress(stream) {
                    let delivery_json = serde_json::to_string(&delivery).unwrap_or_default();
                    if delivery_json != last_delivery_json {
                        emit_stream_event(
                            &app,
                            &stream_id,
                            SiriStreamEventState::Progress,
                            None,
                            Some(delivery),
                        );
                        last_delivery_json = delivery_json;
                    }
                }
                last_progress_emit = Instant::now();
            }

            let command = match receiver.recv_timeout(Duration::from_millis(10)) {
                Ok(command) => command,
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(mpsc::RecvTimeoutError::Disconnected) => SiriStreamCommand::Stop,
            };
            match command {
                SiriStreamCommand::Append(text) if !finishing => {
                    pending.push_str(&text);
                    let split = berd_voice::take_streaming_text_chunks(
                        &pending,
                        first_chunk_pending,
                        false,
                    )?;
                    pending = split.pending;
                    first_chunk_pending = split.first_chunk_pending;
                    for ready in split.ready {
                        enqueue_native_stream(stream, ready.trim())?;
                    }
                }
                SiriStreamCommand::Flush if !finishing => {
                    let split = berd_voice::take_streaming_text_chunks(
                        &pending,
                        first_chunk_pending,
                        true,
                    )?;
                    pending = split.pending;
                    first_chunk_pending = split.first_chunk_pending;
                    for ready in split.ready {
                        enqueue_native_stream(stream, ready.trim())?;
                    }
                }
                SiriStreamCommand::Finish if !finishing => {
                    let split = berd_voice::take_streaming_text_chunks(
                        &pending,
                        first_chunk_pending,
                        true,
                    )?;
                    for ready in split.ready {
                        enqueue_native_stream(stream, ready.trim())?;
                    }
                    pending.clear();
                    finishing = true;
                    unsafe { berd_siri_tts_stream_finish(stream) };
                    watchdog = Some(SiriStreamWatchdog::new(
                        unsafe { berd_siri_tts_stream_progress(stream) },
                        Instant::now(),
                    ));
                }
                SiriStreamCommand::Stop => {
                    let delivery = siri_delivery_progress(stream);
                    active.store(false, Ordering::SeqCst);
                    unsafe { berd_siri_tts_stream_cancel(stream) };
                    return Ok(SiriStreamOutcome {
                        state: SiriStreamEventState::Interrupted,
                        delivery,
                    });
                }
                _ => {}
            }
        }
    })();

    let result = result.map_err(|error| {
        let delivery = capture_before_cancel(
            || siri_delivery_progress(stream),
            || unsafe { berd_siri_tts_stream_cancel(stream) },
        )
        .and_then(delivery_with_played_audio);
        SiriStreamFailure { error, delivery }
    });

    unsafe { berd_siri_tts_stream_release(stream) };
    unsafe {
        drop(Box::from_raw(callback_context));
    }
    playback_lifetime.cancel();
    let _ = playback_monitor_sender.send(SiriPlaybackMonitorEvent::Shutdown);
    let _ = playback_monitor.join();
    result
}

#[tauri::command]
pub fn start_siri_voice_stream(
    app: AppHandle,
    webview_window: tauri::WebviewWindow,
    state: tauri::State<'_, SiriVoiceState>,
    native_voice: tauri::State<'_, NativeVoiceState>,
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
        Err("Siri TTS is only available on macOS".to_string())
    }

    #[cfg(target_os = "macos")]
    {
        if stream_id.trim().is_empty() {
            return Err("Siri voice stream id cannot be empty".to_string());
        }
        let settings = read_settings(&settings_path(&app)?);
        let selection = settings.selected_voice.ok_or_else(|| {
            "Select an installed Siri voice in Voice settings before using Siri TTS".to_string()
        })?;
        let active = begin_playback(&state, webview_window.label())?;
        let effective_output_device = effective_output_device_name(None);
        let suppress_capture =
            should_suppress_capture(interruption_mode, effective_output_device.as_deref());
        let playback_latency_safety_duration =
            playback_latency_safety_duration(effective_output_device.as_deref());
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
            let result = run_siri_stream(
                app.clone(),
                stream_id.clone(),
                selection,
                settings
                    .playback_speed
                    .clamp(MIN_PLAYBACK_SPEED, MAX_PLAYBACK_SPEED),
                active.clone(),
                receiver,
                native_voice_state,
                interruption_sensitivity,
                suppress_capture,
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
            emit_stream_event(&app, &stream_id, event_state, error, delivery);
        });
        Ok(())
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
        let language = CString::new(voice.language.clone())
            .map_err(|_| "Siri voice language cannot contain NUL bytes".to_string())?;
        let name = CString::new(voice.name.clone())
            .map_err(|_| "Siri voice name cannot contain NUL bytes".to_string())?;
        let active = begin_playback(&state, webview_window.label())?;
        let capture_suppression =
            output_device_uses_speakers(effective_output_device_name(None).as_deref()).then(|| {
                log::info!("[voice-echo-guard] speaker output detected");
                native_voice.suppress_capture()
            });
        let playback_state = state.inner().clone();
        let playback_active = active.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let _capture_suppression = capture_suppression;
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
                let voices = discover_voices(&voice.language)?;
                if !find_voice(&voices, &voice).is_some_and(|candidate| candidate.installed) {
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
    fn voice_lookup_normalizes_language_and_name_case() {
        let voices = vec![SiriVoice {
            name: "Aaron".to_string(),
            language: "en_US".to_string(),
            size_bytes: 10,
            installed: true,
        }];
        let selected = SiriVoiceSelection {
            name: "aaron".to_string(),
            language: "EN-us".to_string(),
        };
        assert_eq!(find_voice(&voices, &selected), voices.first());
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
                settings.selected_voice = Some(SiriVoiceSelection {
                    name: "Aaron".to_string(),
                    language: "en-US".to_string(),
                });
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
            Some(SiriVoiceSelection {
                name: "Aaron".to_string(),
                language: "en-US".to_string(),
            })
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
                Some(SiriVoiceSelection {
                    name: "Aaron".to_string(),
                    language: "en-US".to_string(),
                }),
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
                Some(SiriVoiceSelection {
                    name: "Catherine".to_string(),
                    language: "en-AU".to_string(),
                }),
                true,
            ))
        );
    }

    #[test]
    fn unavailable_selection_falls_back_to_an_installed_siri_voice() {
        let selected = SiriVoiceSelection {
            name: "Aaron".to_string(),
            language: "en-US".to_string(),
        };
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
                Ok(preferred_voices.clone())
            }),
            Ok((
                Some(SiriVoiceSelection {
                    name: "Samantha".to_string(),
                    language: "en-US".to_string(),
                }),
                true,
            ))
        );
    }

    #[test]
    fn unavailable_selection_is_preserved_when_no_siri_voice_is_installed() {
        let selected = SiriVoiceSelection {
            name: "Aaron".to_string(),
            language: "en-US".to_string(),
        };
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
    fn siri_playback_monitor_reschedules_many_drain_gaps_on_one_thread() {
        struct DropSignal(mpsc::SyncSender<()>);
        impl Drop for DropSignal {
            fn drop(&mut self) {
                let _ = self.0.send(());
            }
        }

        let (drop_sender, drop_receiver) = mpsc::sync_channel(1);
        let lifetime = Arc::new(SiriPlaybackLifetime::default());
        lifetime.start(|| DropSignal(drop_sender));
        let (event_sender, event_receiver) = mpsc::channel();
        let monitor_lifetime = Arc::clone(&lifetime);
        let monitor = std::thread::Builder::new()
            .name("siri-playback-monitor-test".to_string())
            .spawn(move || {
                run_siri_playback_monitor(
                    event_receiver,
                    monitor_lifetime,
                    Duration::from_millis(20),
                );
            })
            .expect("start monitor");

        for _ in 0..100 {
            let generation = lifetime.begin_drain().expect("drain active guard");
            event_sender
                .send(SiriPlaybackMonitorEvent::Drain(generation))
                .expect("schedule drain");
            lifetime.start(|| panic!("resumed buffering must retain the existing guard"));
            event_sender
                .send(SiriPlaybackMonitorEvent::Started)
                .expect("cancel pending drain");
        }

        let final_drain = lifetime.begin_drain().expect("final drain");
        event_sender
            .send(SiriPlaybackMonitorEvent::Drain(final_drain))
            .expect("schedule final drain");
        drop_receiver
            .recv_timeout(Duration::from_secs(1))
            .expect("final drain releases guard");
        assert!(!lifetime.is_active());
        assert!(drop_receiver.try_recv().is_err());

        event_sender
            .send(SiriPlaybackMonitorEvent::Shutdown)
            .expect("stop monitor");
        monitor.join().expect("join monitor");
    }

    #[test]
    fn cancelling_siri_playback_invalidates_a_pending_grace_release() {
        struct DropCounter(Arc<AtomicU64>);
        impl Drop for DropCounter {
            fn drop(&mut self) {
                self.0.fetch_add(1, Ordering::SeqCst);
            }
        }

        let drops = Arc::new(AtomicU64::new(0));
        let lifetime = Arc::new(SiriPlaybackLifetime::default());
        lifetime.start(|| DropCounter(Arc::clone(&drops)));
        let drain = lifetime.begin_drain().expect("drain before cancellation");
        let (event_sender, event_receiver) = mpsc::channel();
        let monitor_lifetime = Arc::clone(&lifetime);
        let monitor = std::thread::Builder::new()
            .name("siri-playback-cancel-test".to_string())
            .spawn(move || {
                run_siri_playback_monitor(
                    event_receiver,
                    monitor_lifetime,
                    Duration::from_secs(60),
                );
            })
            .expect("start monitor");
        event_sender
            .send(SiriPlaybackMonitorEvent::Drain(drain))
            .expect("schedule drain");

        lifetime.cancel();
        assert!(!lifetime.is_active());
        assert_eq!(drops.load(Ordering::SeqCst), 1);
        event_sender
            .send(SiriPlaybackMonitorEvent::Shutdown)
            .expect("stop monitor");
        monitor.join().expect("join monitor");
        assert_eq!(drops.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn siri_playback_monitor_spawn_failure_is_reported_without_running_the_task() {
        let ran = Arc::new(AtomicBool::new(false));
        let task_ran = Arc::clone(&ran);
        let result = spawn_siri_playback_monitor_with(
            move || task_ran.store(true, Ordering::SeqCst),
            |_task| Err(std::io::Error::other("injected spawn failure")),
        );

        assert_eq!(
            result.expect_err("spawn must fail").to_string(),
            "injected spawn failure"
        );
        assert!(!ran.load(Ordering::SeqCst));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn siri_playback_monitor_panic_cancels_the_lifetime_and_reports_failure() {
        struct DropSignal(mpsc::SyncSender<()>);
        impl Drop for DropSignal {
            fn drop(&mut self) {
                let _ = self.0.send(());
            }
        }

        let (drop_sender, drop_receiver) = mpsc::sync_channel(1);
        let lifetime = Arc::new(SiriPlaybackLifetime::default());
        lifetime.start(|| DropSignal(drop_sender));
        let drain = lifetime.begin_drain().expect("drain active guard");
        let failed = Arc::new(AtomicBool::new(false));
        let (event_sender, event_receiver) = mpsc::channel();
        let monitor = spawn_siri_playback_monitor(
            event_receiver,
            Arc::clone(&lifetime),
            Duration::MAX,
            Arc::clone(&failed),
        )
        .expect("start monitor");

        event_sender
            .send(SiriPlaybackMonitorEvent::Drain(drain))
            .expect("trigger monitor overflow panic");
        drop_receiver
            .recv_timeout(Duration::from_secs(1))
            .expect("monitor panic cancels playback lifetime");
        monitor.join().expect("panic is contained by monitor");

        assert!(failed.load(Ordering::SeqCst));
        assert!(!lifetime.is_active());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn stream_watchdog_times_out_only_after_progress_stalls() {
        let started = Instant::now();
        let mut watchdog = SiriStreamWatchdog::new(1, started);

        assert!(!watchdog.observe(2, started + SIRI_STREAM_STALL_TIMEOUT));
        assert!(!watchdog.observe(
            2,
            started + SIRI_STREAM_STALL_TIMEOUT + Duration::from_millis(1),
        ));
        assert!(watchdog.observe(2, started + SIRI_STREAM_STALL_TIMEOUT * 2,));
    }

    #[test]
    fn failed_stream_retains_only_delivery_with_played_audio() {
        use std::cell::RefCell;

        let calls = RefCell::new(Vec::new());
        let progress = VoiceDeliveryProgress {
            sample_rate: 24_000,
            segments: vec![VoiceDeliverySegment {
                text: "Partly heard.".to_string(),
                played_frames: 1_200,
                total_frames: 4_800,
                synthesis_complete: true,
            }],
        };
        let progress = capture_before_cancel(
            || {
                calls.borrow_mut().push("snapshot");
                progress
            },
            || calls.borrow_mut().push("cancel"),
        );
        assert_eq!(&*calls.borrow(), &["snapshot", "cancel"]);
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
