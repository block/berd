//! macOS SiriTTSD voice discovery, download, and selection.

#[cfg(target_os = "macos")]
use std::ffi::{CStr, CString};
use std::fs;
#[cfg(target_os = "macos")]
use std::os::raw::c_char;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(target_os = "macos")]
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
#[cfg(target_os = "macos")]
use std::time::Duration;

use serde::{Deserialize, Serialize};
#[cfg(target_os = "macos")]
use tauri::Emitter;
use tauri::{AppHandle, Manager};

use super::native_voice::NativeVoiceState;
#[cfg(target_os = "macos")]
use super::pocket_voice::{effective_output_device_name, output_device_uses_speakers};

#[derive(Clone, Debug, Default)]
pub struct SiriVoiceState {
    runtime: Arc<Mutex<SiriVoiceRuntime>>,
}

#[derive(Debug, Default)]
struct SiriVoiceRuntime {
    active: Option<Arc<AtomicBool>>,
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
}

#[cfg(target_os = "macos")]
const SIRI_STREAM_EVENT: &str = "siri-voice:stream-event";
const MIN_PLAYBACK_SPEED: f32 = 0.5;
const MAX_PLAYBACK_SPEED: f32 = 2.0;

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
    let temporary = path.with_extension("json.tmp");
    fs::write(&temporary, data).map_err(|error| format!("write Siri TTS settings: {error}"))?;
    fs::rename(&temporary, path).map_err(|error| format!("publish Siri TTS settings: {error}"))
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

#[cfg(target_os = "macos")]
fn begin_playback(state: &SiriVoiceState) -> Result<Arc<AtomicBool>, String> {
    let mut runtime = state
        .runtime
        .lock()
        .map_err(|_| "Siri playback state lock was poisoned".to_string())?;
    if runtime.active.is_some() {
        return Err("Siri voice playback is already active".to_string());
    }
    let token = Arc::new(AtomicBool::new(true));
    runtime.active = Some(token.clone());
    Ok(token)
}

#[cfg(target_os = "macos")]
fn finish_playback(state: &SiriVoiceState, completed: &Arc<AtomicBool>) {
    if let Ok(mut runtime) = state.runtime.lock() {
        if runtime
            .active
            .as_ref()
            .is_some_and(|current| Arc::ptr_eq(current, completed))
        {
            runtime.active = None;
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
struct SiriStreamCallbackContext {
    app: AppHandle,
    stream_id: String,
}

#[cfg(target_os = "macos")]
unsafe extern "C" fn siri_playback_started(context: *mut std::ffi::c_void) {
    if context.is_null() {
        return;
    }
    // SAFETY: The stream worker owns this boxed context until after the native
    // player has completed and been released.
    let context = unsafe { &*(context.cast::<SiriStreamCallbackContext>()) };
    let _ = context.app.emit(
        SIRI_STREAM_EVENT,
        SiriStreamEvent {
            stream_id: context.stream_id.clone(),
            state: SiriStreamEventState::Started,
            error: None,
        },
    );
}

#[cfg(target_os = "macos")]
fn emit_stream_event(
    app: &AppHandle,
    stream_id: &str,
    state: SiriStreamEventState,
    error: Option<String>,
) {
    let _ = app.emit(
        SIRI_STREAM_EVENT,
        SiriStreamEvent {
            stream_id: stream_id.to_string(),
            state,
            error,
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

fn choose_installed_voice(
    preferred_voices: &[SiriVoice],
    load_all_voices: impl FnOnce() -> Result<Vec<SiriVoice>, String>,
) -> Result<Option<SiriVoiceSelection>, String> {
    if let Some(selection) = first_installed_voice(preferred_voices) {
        return Ok(Some(selection));
    }

    Ok(first_installed_voice(&load_all_voices()?))
}

fn status(app: &AppHandle, language_prefix: &str) -> Result<SiriVoiceStatus, String> {
    let voices = discover_voices(language_prefix)?;
    let available_languages = discover_languages()?;
    let path = settings_path(app)?;
    let mut settings = read_settings(&path);
    if settings.selected_voice.is_none() {
        settings.selected_voice = choose_installed_voice(&voices, || discover_voices(""))?;
        if settings.selected_voice.is_some() {
            write_settings(&path, &settings)?;
        }
    }
    let selected_voice_installed = settings.selected_voice.as_ref().is_some_and(|selection| {
        find_voice(&voices, selection).is_some_and(|voice| voice.installed)
            || discover_voices(&selection.language)
                .ok()
                .and_then(|selected| find_voice(&selected, selection).cloned())
                .is_some_and(|voice| voice.installed)
    });
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
    write_settings(
        &settings_path(&app)?,
        &SiriVoiceSettings {
            selected_voice: Some(voice),
            playback_speed: read_settings(&settings_path(&app)?).playback_speed,
        },
    )
}

#[tauri::command]
pub fn set_siri_playback_speed(app: AppHandle, speed: f32) -> Result<(), String> {
    if !speed.is_finite() || !(MIN_PLAYBACK_SPEED..=MAX_PLAYBACK_SPEED).contains(&speed) {
        return Err("Siri playback speed must be between 0.5 and 2.0".to_string());
    }
    let path = settings_path(&app)?;
    let mut settings = read_settings(&path);
    settings.playback_speed = speed;
    write_settings(&path, &settings)
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
#[allow(clippy::too_many_arguments)]
fn run_siri_stream(
    app: AppHandle,
    stream_id: String,
    selection: SiriVoiceSelection,
    speed: f32,
    active: Arc<AtomicBool>,
    receiver: mpsc::Receiver<SiriStreamCommand>,
) -> Result<SiriStreamEventState, String> {
    let language = CString::new(selection.language)
        .map_err(|_| "Siri voice language cannot contain NUL bytes".to_string())?;
    let name = CString::new(selection.name)
        .map_err(|_| "Siri voice name cannot contain NUL bytes".to_string())?;
    let callback_context = Box::new(SiriStreamCallbackContext {
        app: app.clone(),
        stream_id: stream_id.clone(),
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
            callback_context.cast(),
            &mut error,
        )
    };
    if stream.is_null() {
        // SAFETY: Native creation failed, so no callback retained the box.
        unsafe { drop(Box::from_raw(callback_context)) };
        return Err(bridge_error(error, "Could not start Siri voice stream"));
    }

    let result = (|| {
        let mut pending = String::new();
        let mut first_chunk_pending = true;
        let mut finishing = false;
        loop {
            if !active.load(Ordering::SeqCst) {
                unsafe { berd_siri_tts_stream_cancel(stream) };
                return Ok(SiriStreamEventState::Interrupted);
            }
            if finishing && unsafe { berd_siri_tts_stream_is_finished(stream) } {
                let native_error =
                    take_bridge_string(unsafe { berd_siri_tts_stream_copy_error(stream) });
                return native_error.map_or(Ok(SiriStreamEventState::Completed), Err);
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
                }
                SiriStreamCommand::Stop => {
                    active.store(false, Ordering::SeqCst);
                    unsafe { berd_siri_tts_stream_cancel(stream) };
                    return Ok(SiriStreamEventState::Interrupted);
                }
                _ => {}
            }
        }
    })();

    unsafe {
        berd_siri_tts_stream_release(stream);
        drop(Box::from_raw(callback_context));
    }
    result
}

#[tauri::command]
pub fn start_siri_voice_stream(
    app: AppHandle,
    state: tauri::State<'_, SiriVoiceState>,
    native_voice: tauri::State<'_, NativeVoiceState>,
    stream_id: String,
) -> Result<(), String> {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, state, native_voice, stream_id);
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
        let active = begin_playback(&state)?;
        let capture_suppression =
            output_device_uses_speakers(effective_output_device_name(None).as_deref()).then(|| {
                log::info!("[voice-echo-guard] speaker output detected");
                native_voice.suppress_capture()
            });
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
        tauri::async_runtime::spawn_blocking(move || {
            let _capture_suppression = capture_suppression;
            let result = run_siri_stream(
                app.clone(),
                stream_id.clone(),
                selection,
                settings
                    .playback_speed
                    .clamp(MIN_PLAYBACK_SPEED, MAX_PLAYBACK_SPEED),
                active.clone(),
                receiver,
            );
            let (event_state, error) = match result {
                Ok(state) => (state, None),
                Err(_error) if !active.load(Ordering::SeqCst) => {
                    (SiriStreamEventState::Interrupted, None)
                }
                Err(error) => (SiriStreamEventState::Failed, Some(error)),
            };
            emit_stream_event(&app, &stream_id, event_state, error);
            finish_playback(&playback_state, &playback_active);
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
    state: tauri::State<'_, SiriVoiceState>,
    native_voice: tauri::State<'_, NativeVoiceState>,
    voice: SiriVoiceSelection,
) -> Result<(), String> {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, state, native_voice, voice);
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
        let active = begin_playback(&state)?;
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
    let runtime = state
        .runtime
        .lock()
        .map_err(|_| "Siri playback state lock was poisoned".to_string())?;
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
    pub(crate) fn stop_for_window_destroyed(&self) -> bool {
        stop_siri_playback(self).unwrap_or_else(|error| {
            log::warn!("Failed to stop Siri playback for a destroyed window: {error}");
            false
        })
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
            first_installed_voice(&voices),
            Some(SiriVoiceSelection {
                name: "Aaron".to_string(),
                language: "en-US".to_string(),
            })
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
            choose_installed_voice(&filtered_voices, || {
                Ok(vec![SiriVoice {
                    name: "Catherine".to_string(),
                    language: "en-AU".to_string(),
                    size_bytes: 10,
                    installed: true,
                }])
            }),
            Ok(Some(SiriVoiceSelection {
                name: "Catherine".to_string(),
                language: "en-AU".to_string(),
            }))
        );
    }
}
