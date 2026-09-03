//! Native voice installation, selection, and Pocket playback.

use std::collections::VecDeque;
use std::fs;
#[cfg(target_os = "macos")]
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(target_os = "macos")]
use std::sync::mpsc;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime};

use berd_voice::input::InputDuringTtsPolicy;
use berd_voice::local_assets::{self, LocalAssetRoots, LocalInstallPhase};
#[cfg(any(test, target_os = "macos"))]
use berd_voice::DeliveryProgress as VoiceDeliveryProgress;
#[cfg(target_os = "macos")]
use berd_voice::SAMPLE_RATE;
#[cfg(target_os = "macos")]
use berd_voice::{
    load_pocket_voice_style, load_text_to_speech, ConfiguredTtsSlot, DrainPolicy,
    DrainTimeoutOutcome, OutboundFailure, OutboundOutcome, OutboundPlayback, TtsBackend,
    TtsConfiguration,
};
use berd_voice::{parakeet_assets, pocket_assets};
#[cfg(target_os = "macos")]
use objc2_core_audio::{
    kAudioDevicePropertyScopeOutput, kAudioDevicePropertyStreams, kAudioDeviceTransportTypeBuiltIn,
    kAudioHardwareNoError, kAudioObjectPropertyElementMain, kAudioObjectPropertyScopeGlobal,
    kAudioStreamPropertyTerminalType, kAudioStreamTerminalTypeSpeaker, AudioObjectGetPropertyData,
    AudioObjectGetPropertyDataSize, AudioObjectID, AudioObjectPropertyAddress,
};
#[cfg(target_os = "macos")]
use rodio::DeviceTrait;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

#[cfg(target_os = "macos")]
use super::native_voice::AssistantSpeechGuard;
#[cfg(any(test, target_os = "macos"))]
use super::native_voice::{output_latency_grace_elapsed, output_latency_grace_remaining};
use super::{
    native_voice::{InterruptionSensitivity, NativeVoiceState},
    voice_capture::VoiceCaptureState,
};
#[cfg(target_os = "macos")]
use berd_voice::PocketAudioPlayer;

const CACHE_VERSION: &str = pocket_assets::MODEL_ID;
const POCKET_EVENT: &str = "pocket-voice:event";
#[cfg(target_os = "macos")]
const POCKET_STREAM_EVENT: &str = "pocket-voice:stream-event";
const DEFAULT_VOICE: &str = "mary";
const DOWNLOAD_PROGRESS_EMIT_INTERVAL: Duration = Duration::from_millis(100);
#[cfg(target_os = "macos")]
const STREAMING_EMIT_FRAMES: usize = 12;
#[cfg(target_os = "macos")]
const PLAYBACK_PROGRESS_EMIT_INTERVAL: Duration = Duration::from_millis(100);
#[cfg(target_os = "macos")]
const LOCAL_PLAYBACK_LATENCY_SAFETY_DURATION: Duration = Duration::from_millis(100);
#[cfg(target_os = "macos")]
const BLUETOOTH_PLAYBACK_LATENCY_SAFETY_DURATION: Duration = Duration::from_millis(500);
#[cfg(target_os = "macos")]
const AIRPLAY_PLAYBACK_LATENCY_SAFETY_DURATION: Duration = Duration::from_secs(2);
#[cfg(target_os = "macos")]
const UNKNOWN_PLAYBACK_LATENCY_SAFETY_DURATION: Duration = Duration::from_secs(2);
#[cfg(any(test, target_os = "macos"))]
const POCKET_SOURCE_COMPLETION_TIMEOUT: Duration = Duration::from_secs(2);

#[cfg(target_os = "macos")]
fn playback_latency_safety_duration_for_transport(transport: Option<u32>) -> Duration {
    // CoreAudio transport FOURCC values. Bluetooth and AirPlay routes buffer
    // beyond the local hardware callback, while an unknown/virtual route has
    // no trustworthy upper bound. Keep capture protected conservatively for
    // those routes instead of promising feedback prevention on a 100 ms guess.
    const BUILT_IN: u32 = 0x626c_746e;
    const BLUETOOTH: u32 = 0x626c_7565;
    const BLUETOOTH_LE: u32 = 0x626c_6561;
    const AIRPLAY: u32 = 0x6169_7270;

    match transport {
        Some(BUILT_IN) => LOCAL_PLAYBACK_LATENCY_SAFETY_DURATION,
        Some(BLUETOOTH) | Some(BLUETOOTH_LE) => BLUETOOTH_PLAYBACK_LATENCY_SAFETY_DURATION,
        Some(AIRPLAY) => AIRPLAY_PLAYBACK_LATENCY_SAFETY_DURATION,
        Some(_) | None => UNKNOWN_PLAYBACK_LATENCY_SAFETY_DURATION,
    }
}

#[cfg(target_os = "macos")]
pub(crate) fn playback_latency_safety_duration(output_device: Option<&str>) -> Duration {
    use coreaudio::audio_unit::macos_helpers::{
        get_default_device_id, get_device_id_from_name, get_device_transport_type,
    };

    let device_id = match output_device {
        Some(name) => get_device_id_from_name(name, false),
        None => get_default_device_id(false),
    };
    playback_latency_safety_duration_for_transport(
        device_id.and_then(|id| get_device_transport_type(id).ok()),
    )
}
type PocketVoice = pocket_assets::PocketVoiceDescriptor;

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct PocketVoiceOption {
    id: &'static str,
    name: &'static str,
}

#[derive(Clone, Debug, Default)]
pub struct PocketVoiceState {
    install: std::sync::Arc<std::sync::Mutex<InstallRuntime>>,
    install_changed: std::sync::Arc<tokio::sync::Notify>,
    playback: std::sync::Arc<std::sync::Mutex<PlaybackRuntime>>,
}

#[derive(Debug, Default)]
struct PlaybackRuntime {
    active: Option<Arc<AtomicBool>>,
    #[cfg(target_os = "macos")]
    stream: Option<ActivePocketStream>,
}

struct PlaybackSession {
    active: Arc<AtomicBool>,
    playback_rate: f32,
}

#[cfg(target_os = "macos")]
#[derive(Debug)]
struct ActivePocketStream {
    id: String,
    sender: mpsc::Sender<PocketStreamCommand>,
}

#[cfg(target_os = "macos")]
#[derive(Debug)]
enum PocketStreamCommand {
    Append(String),
    Flush,
    Finish,
    Stop,
}

#[cfg(target_os = "macos")]
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum PocketStreamEventState {
    Started,
    Progress,
    Completed,
    Interrupted,
    Failed,
}

#[cfg(target_os = "macos")]
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PocketStreamEvent {
    stream_id: String,
    state: PocketStreamEventState,
    error: Option<String>,
    delivery: Option<VoiceDeliveryProgress>,
}

#[cfg(target_os = "macos")]
struct PocketStreamOutcome {
    state: PocketStreamEventState,
    delivery: Option<VoiceDeliveryProgress>,
}

#[cfg(target_os = "macos")]
#[derive(Debug)]
struct PocketStreamFailure {
    error: String,
    delivery: Option<VoiceDeliveryProgress>,
}

#[cfg(target_os = "macos")]
impl From<String> for PocketStreamFailure {
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

#[derive(Clone, Debug, Default)]
struct InstallRuntime {
    status_revision: u64,
    next_attempt_id: u64,
    worker_running: bool,
    active_model: Option<VoiceModelKind>,
    queued_models: VecDeque<VoiceModelKind>,
    pocket_attempt_id: Option<u64>,
    parakeet_attempt_id: Option<u64>,
    pocket_progress: Option<VoiceModelDownloadProgress>,
    parakeet_progress: Option<VoiceModelDownloadProgress>,
    pocket_last_progress_emit: Option<Instant>,
    parakeet_last_progress_emit: Option<Instant>,
    pocket_error: Option<String>,
    parakeet_error: Option<String>,
    removing: Option<VoiceModelKind>,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum VoiceModelDownloadPhase {
    Queued,
    Downloading,
    Extracting,
    Verifying,
    Publishing,
    Complete,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct VoiceModelDownloadProgress {
    attempt_id: u64,
    downloaded_bytes: u64,
    total_bytes: u64,
    phase: VoiceModelDownloadPhase,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum VoiceModelKind {
    Pocket,
    Parakeet,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct PocketSettings {
    selected_voice: String,
    #[serde(default = "default_playback_speed")]
    playback_speed: f32,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PocketVoiceStatus {
    status_revision: u64,
    installed: bool,
    pocket_installed: bool,
    parakeet_installed: bool,
    pocket_size_bytes: Option<u64>,
    parakeet_size_bytes: Option<u64>,
    pocket_download_bytes: u64,
    parakeet_download_bytes: u64,
    downloading: bool,
    active_model: Option<VoiceModelKind>,
    pocket_attempt_id: Option<u64>,
    parakeet_attempt_id: Option<u64>,
    pocket_progress: Option<VoiceModelDownloadProgress>,
    parakeet_progress: Option<VoiceModelDownloadProgress>,
    pocket_error: Option<String>,
    parakeet_error: Option<String>,
    removing: Option<VoiceModelKind>,
    removal_queued: bool,
    downloaded_bytes: u64,
    total_bytes: u64,
    error: Option<String>,
    selected_voice: String,
    playback_speed: f32,
    voices: Vec<PocketVoiceOption>,
}

fn default_playback_speed() -> f32 {
    1.0
}

fn settings(base: &Path) -> PocketSettings {
    fs::read(base.join("settings.json"))
        .ok()
        .and_then(|data| serde_json::from_slice::<PocketSettings>(&data).ok())
        .unwrap_or_else(|| PocketSettings {
            selected_voice: DEFAULT_VOICE.to_string(),
            playback_speed: default_playback_speed(),
        })
}

fn pocket_download_bytes() -> u64 {
    pocket_assets::download_bytes()
}

fn parakeet_download_bytes() -> u64 {
    parakeet_assets::download_bytes()
}

#[cfg(test)]
fn pocket_published_bytes() -> u64 {
    pocket_download_bytes()
}

#[cfg(test)]
fn parakeet_published_bytes() -> u64 {
    parakeet_assets::published_bytes()
}

fn pocket_disk_bytes(base: &Path) -> Option<u64> {
    let version = base.join(CACHE_VERSION);
    pocket_assets::model_artifacts()
        .iter()
        .map(|item| version.join(item.relative_path))
        .chain(
            pocket_assets::voices()
                .iter()
                .map(|voice| version.join(voice.relative_path)),
        )
        .try_fold(0_u64, |total, path| {
            total.checked_add(fs::metadata(path).ok()?.len())
        })
}

fn parakeet_disk_bytes(base: &Path) -> Option<u64> {
    let stt = base.join(CACHE_VERSION).join("stt");
    parakeet_assets::published_assets()
        .iter()
        .map(|asset| stt.join(asset.relative_path))
        .try_fold(0_u64, |total, path| {
            total.checked_add(fs::metadata(path).ok()?.len())
        })
}

fn cache_base(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|path| path.join("pocket-tts"))
        .map_err(|error| format!("resolve Pocket TTS data directory: {error}"))
}

fn local_asset_roots(base: &Path) -> Result<LocalAssetRoots, String> {
    LocalAssetRoots::new(
        base,
        base.join(CACHE_VERSION),
        base.join(CACHE_VERSION).join("stt"),
    )
    .map_err(|error| error.to_string())
}

fn selected_voice(base: &Path) -> String {
    Some(settings(base).selected_voice)
        .filter(|id| pocket_assets::voices().iter().any(|voice| voice.id == id))
        .unwrap_or_else(|| DEFAULT_VOICE.to_string())
}

fn playback_speed(base: &Path) -> f32 {
    settings(base).playback_speed.clamp(0.75, 2.0)
}

pub(crate) fn selected_output_device() -> Option<String> {
    std::env::var("VOICE_CONVERSATION_OUTPUT_DEVICE")
        .ok()
        .filter(|value| !value.is_empty())
}

#[cfg(target_os = "macos")]
pub(crate) fn effective_output_device_name(configured: Option<&str>) -> Option<String> {
    use rodio::cpal::traits::HostTrait;

    if let Some(name) = configured {
        return Some(name.to_string());
    }
    rodio::cpal::default_host()
        .default_output_device()?
        .description()
        .ok()
        .map(|description| description.name().to_string())
}

#[cfg(not(target_os = "macos"))]
fn effective_output_device_name(configured: Option<&str>) -> Option<String> {
    configured.map(ToOwned::to_owned)
}

pub(crate) fn output_device_uses_speakers(output_device: Option<&str>) -> bool {
    if output_device.is_some_and(|name| {
        let normalized = name.to_lowercase();
        ["speaker", "altavo"]
            .iter()
            .any(|keyword| normalized.contains(keyword))
    }) {
        return true;
    }

    #[cfg(target_os = "macos")]
    {
        output_device_is_builtin_speaker(output_device)
    }

    #[cfg(not(target_os = "macos"))]
    false
}

#[cfg(target_os = "macos")]
fn output_device_is_builtin_speaker(output_device: Option<&str>) -> bool {
    use coreaudio::audio_unit::macos_helpers::{
        get_device_id_from_name, get_device_transport_type,
    };
    use std::mem;
    use std::ptr::{null, NonNull};

    let device_id = output_device.and_then(|name| get_device_id_from_name(name, false));
    let Some(device_id) = device_id else {
        return false;
    };
    let transport_type = get_device_transport_type(device_id).ok();

    let streams_address = AudioObjectPropertyAddress {
        mSelector: kAudioDevicePropertyStreams,
        mScope: kAudioDevicePropertyScopeOutput,
        mElement: kAudioObjectPropertyElementMain,
    };
    let mut streams_size = 0;
    // SAFETY: Core Audio writes only the property byte count into the valid stack value.
    let status = unsafe {
        AudioObjectGetPropertyDataSize(
            device_id,
            NonNull::from(&streams_address),
            0,
            null(),
            NonNull::from(&mut streams_size),
        )
    };
    if status != kAudioHardwareNoError || streams_size == 0 {
        return false;
    }

    let mut streams =
        vec![0 as AudioObjectID; streams_size as usize / mem::size_of::<AudioObjectID>()];
    // SAFETY: The buffer is sized from Core Audio's preceding property-size query.
    let status = unsafe {
        AudioObjectGetPropertyData(
            device_id,
            NonNull::from(&streams_address),
            0,
            null(),
            NonNull::from(&mut streams_size),
            NonNull::new(streams.as_mut_ptr())
                .expect("non-empty stream buffer")
                .cast(),
        )
    };
    if status != kAudioHardwareNoError {
        return false;
    }

    streams.into_iter().any(|stream_id| {
        let terminal_address = AudioObjectPropertyAddress {
            mSelector: kAudioStreamPropertyTerminalType,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain,
        };
        let mut terminal_type = 0;
        let mut terminal_size = mem::size_of::<u32>() as u32;
        // SAFETY: Core Audio writes one u32 into the valid terminal_type stack value.
        let status = unsafe {
            AudioObjectGetPropertyData(
                stream_id,
                NonNull::from(&terminal_address),
                0,
                null(),
                NonNull::from(&mut terminal_size),
                NonNull::from(&mut terminal_type).cast(),
            )
        };
        status == kAudioHardwareNoError
            && output_metadata_uses_builtin_speakers(transport_type, terminal_type)
    })
}

#[cfg(target_os = "macos")]
fn output_metadata_uses_builtin_speakers(transport_type: Option<u32>, terminal_type: u32) -> bool {
    // Apple's built-in Mac speaker stream currently reports the USB Audio
    // speaker terminal code, while other Core Audio devices may report 'spkr'.
    const USB_AUDIO_SPEAKER_TERMINAL: u32 = 0x0301;
    transport_type == Some(kAudioDeviceTransportTypeBuiltIn)
        && (terminal_type == kAudioStreamTerminalTypeSpeaker
            || terminal_type == USB_AUDIO_SPEAKER_TERMINAL)
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum VoiceInterruptionMode {
    Automatic,
    AllowInterruptions,
    PreventFeedback,
}

#[cfg_attr(not(any(test, target_os = "macos")), allow(dead_code))]
pub(crate) fn resolve_input_during_tts_policy(
    mode: VoiceInterruptionMode,
    output_device: Option<&str>,
) -> InputDuringTtsPolicy {
    match mode {
        // Automatic is best-effort because macOS cannot classify every external route.
        // Prevent feedback remains the reliable fallback when this heuristic misses one.
        VoiceInterruptionMode::Automatic if output_device_uses_speakers(output_device) => {
            InputDuringTtsPolicy::SuppressInput
        }
        VoiceInterruptionMode::Automatic | VoiceInterruptionMode::AllowInterruptions => {
            InputDuringTtsPolicy::AllowBargeIn
        }
        VoiceInterruptionMode::PreventFeedback => InputDuringTtsPolicy::SuppressInput,
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct InstallationFingerprint(Vec<(PathBuf, u64, SystemTime)>);

type InstallationValidation = Option<(PathBuf, InstallationFingerprint, bool)>;

static POCKET_INSTALLATION_VALIDATION: OnceLock<Mutex<InstallationValidation>> = OnceLock::new();
static PARAKEET_INSTALLATION_VALIDATION: OnceLock<Mutex<InstallationValidation>> = OnceLock::new();

#[cfg(test)]
fn installation_valid(base: &Path) -> bool {
    pocket_installation_valid(base) && parakeet_installation_valid(base)
}

fn cached_installation_valid(
    base: &Path,
    fingerprint: Option<InstallationFingerprint>,
    validation: &'static OnceLock<Mutex<InstallationValidation>>,
    validate: impl FnOnce() -> bool,
) -> bool {
    let Some(fingerprint) = fingerprint else {
        return false;
    };
    let validation = validation.get_or_init(|| Mutex::new(None));
    let Ok(mut cached) = validation.lock() else {
        return false;
    };
    if let Some((cached_base, cached_fingerprint, valid)) = cached.as_ref() {
        if cached_base == base && cached_fingerprint == &fingerprint {
            return *valid;
        }
    }

    let valid = validate();
    *cached = Some((base.to_path_buf(), fingerprint, valid));
    valid
}

fn pocket_installation_valid(base: &Path) -> bool {
    cached_installation_valid(
        base,
        pocket_installation_fingerprint(base),
        &POCKET_INSTALLATION_VALIDATION,
        || {
            matches!(
                pocket_assets::inspect(&base.join(CACHE_VERSION)),
                Ok(pocket_assets::PocketAssetStatus::Ready { .. })
            )
        },
    )
}

fn parakeet_installation_valid(base: &Path) -> bool {
    cached_installation_valid(
        base,
        parakeet_installation_fingerprint(base),
        &PARAKEET_INSTALLATION_VALIDATION,
        || {
            matches!(
                parakeet_assets::inspect(&base.join(CACHE_VERSION).join("stt")),
                Ok(parakeet_assets::ParakeetAssetStatus::Ready { .. })
            )
        },
    )
}

fn lock_local_assets_for_read(base: &Path) -> Result<local_assets::LocalAssetReadGuard, String> {
    let roots = local_asset_roots(base)?;
    local_assets::try_lock_for_read(&roots).map_err(|error| error.to_string())
}

fn version_root(base: &Path) -> Option<PathBuf> {
    let version = base.join(CACHE_VERSION);
    if !version.is_dir() {
        return None;
    }
    Some(version)
}

fn pocket_installation_fingerprint(base: &Path) -> Option<InstallationFingerprint> {
    let version = version_root(base)?;
    let mut files: Vec<(PathBuf, u64)> = pocket_assets::model_artifacts()
        .iter()
        .map(|item| (version.join(item.relative_path), item.size_bytes))
        .collect();
    files.extend(
        pocket_assets::voices()
            .iter()
            .map(|voice| (version.join(voice.relative_path), voice.size_bytes)),
    );
    fingerprint_files(files)
}

fn parakeet_installation_fingerprint(base: &Path) -> Option<InstallationFingerprint> {
    let version = version_root(base)?;
    let files = parakeet_assets::published_assets()
        .iter()
        .map(|asset| {
            (
                version.join("stt").join(asset.relative_path),
                asset.size_bytes,
            )
        })
        .collect::<Vec<_>>();
    fingerprint_files(files)
}

fn fingerprint_files(
    files: impl IntoIterator<Item = (PathBuf, u64)>,
) -> Option<InstallationFingerprint> {
    let mut fingerprint = Vec::new();
    for (path, expected_size) in files {
        let metadata = fs::metadata(&path).ok()?;
        if metadata.len() != expected_size {
            return None;
        }
        fingerprint.push((path, metadata.len(), metadata.modified().ok()?));
    }
    Some(InstallationFingerprint(fingerprint))
}

#[tauri::command]
pub fn get_pocket_voice_status(
    app: AppHandle,
    state: State<'_, PocketVoiceState>,
) -> Result<PocketVoiceStatus, String> {
    pocket_voice_status(&app, &state)
}

fn pocket_voice_status(
    app: &AppHandle,
    state: &PocketVoiceState,
) -> Result<PocketVoiceStatus, String> {
    let base = cache_base(app)?;
    let _assets = lock_local_assets_for_read(&base)?;
    let runtime = state
        .install
        .lock()
        .map_err(|_| "Pocket TTS install state lock was poisoned".to_string())?
        .clone();
    let pocket_size_bytes = pocket_installation_valid(&base)
        .then(|| pocket_disk_bytes(&base))
        .flatten();
    let parakeet_size_bytes = parakeet_installation_valid(&base)
        .then(|| parakeet_disk_bytes(&base))
        .flatten();
    let pocket_installed = pocket_size_bytes.is_some();
    let parakeet_installed = parakeet_size_bytes.is_some();
    let active_progress = runtime.active_model.and_then(|model| match model {
        VoiceModelKind::Pocket => runtime.pocket_progress,
        VoiceModelKind::Parakeet => runtime.parakeet_progress,
    });
    Ok(PocketVoiceStatus {
        status_revision: runtime.status_revision,
        installed: pocket_installed && parakeet_installed,
        pocket_installed,
        parakeet_installed,
        pocket_size_bytes,
        parakeet_size_bytes,
        pocket_download_bytes: pocket_download_bytes(),
        parakeet_download_bytes: parakeet_download_bytes(),
        downloading: runtime.active_model.is_some() || !runtime.queued_models.is_empty(),
        active_model: runtime.active_model,
        pocket_attempt_id: runtime.pocket_attempt_id,
        parakeet_attempt_id: runtime.parakeet_attempt_id,
        pocket_progress: runtime.pocket_progress,
        parakeet_progress: runtime.parakeet_progress,
        pocket_error: runtime.pocket_error.clone(),
        parakeet_error: runtime.parakeet_error.clone(),
        removing: runtime.removing,
        removal_queued: runtime.removing.is_some() && install_busy(&runtime),
        downloaded_bytes: active_progress.map_or(0, |progress| progress.downloaded_bytes),
        total_bytes: active_progress.map_or(0, |progress| progress.total_bytes),
        error: runtime.active_model.and_then(|model| match model {
            VoiceModelKind::Pocket => runtime.pocket_error.clone(),
            VoiceModelKind::Parakeet => runtime.parakeet_error.clone(),
        }),
        selected_voice: selected_voice(&base),
        playback_speed: playback_speed(&base),
        voices: pocket_assets::voices()
            .iter()
            .map(|voice| PocketVoiceOption {
                id: voice.id,
                name: voice.name,
            })
            .collect(),
    })
}

#[tauri::command]
pub fn select_pocket_voice(app: AppHandle, voice_id: String) -> Result<(), String> {
    if !pocket_assets::voices()
        .iter()
        .any(|voice| voice.id == voice_id)
    {
        return Err(format!("Unknown Pocket voice: {voice_id}"));
    }
    let base = cache_base(&app)?;
    fs::create_dir_all(&base).map_err(|error| format!("create Pocket settings: {error}"))?;
    let data = serde_json::to_vec_pretty(&PocketSettings {
        selected_voice: voice_id,
        playback_speed: playback_speed(&base),
    })
    .map_err(|error| format!("encode Pocket settings: {error}"))?;
    let temporary = base.join("settings.json.tmp");
    fs::write(&temporary, data).map_err(|error| format!("write Pocket settings: {error}"))?;
    fs::rename(&temporary, base.join("settings.json"))
        .map_err(|error| format!("publish Pocket settings: {error}"))
}

#[tauri::command]
pub fn set_pocket_playback_speed(app: AppHandle, speed: f32) -> Result<(), String> {
    if !speed.is_finite() || !(0.75..=2.0).contains(&speed) {
        return Err("Pocket playback speed must be between 0.75 and 2.0".to_string());
    }
    let base = cache_base(&app)?;
    fs::create_dir_all(&base).map_err(|error| format!("create Pocket settings: {error}"))?;
    let data = serde_json::to_vec_pretty(&PocketSettings {
        selected_voice: selected_voice(&base),
        playback_speed: speed,
    })
    .map_err(|error| format!("encode Pocket settings: {error}"))?;
    let temporary = base.join("settings.json.tmp");
    fs::write(&temporary, data).map_err(|error| format!("write Pocket settings: {error}"))?;
    fs::rename(&temporary, base.join("settings.json"))
        .map_err(|error| format!("publish Pocket settings: {error}"))
}

#[tauri::command]
pub async fn preview_pocket_voice(
    app: AppHandle,
    state: State<'_, PocketVoiceState>,
    native_voice: State<'_, NativeVoiceState>,
    voice_id: String,
) -> Result<(), String> {
    let base = cache_base(&app)?;
    let voice = pocket_assets::voices()
        .iter()
        .find(|voice| voice.id == voice_id)
        .copied()
        .ok_or_else(|| format!("Unknown Pocket voice: {voice_id}"))?;
    let assets = lock_local_assets_for_read(&base)?;
    let installed = pocket_installation_valid(&base);
    drop(assets);
    if !installed {
        return Err("Pocket TTS must be downloaded before previewing a voice".to_string());
    }
    let session = begin_playback(
        &state,
        "Another Pocket voice preview is already playing",
        &base,
    )?;
    let output_device = selected_output_device();
    let effective_output_device = effective_output_device_name(output_device.as_deref());
    let assistant_speech =
        output_device_uses_speakers(effective_output_device.as_deref()).then(|| {
            log::info!("[voice-echo-guard] speaker output detected");
            native_voice.begin_assistant_speech(
                InterruptionSensitivity::Balanced,
                InputDuringTtsPolicy::SuppressInput,
            )
        });

    let playback = state.playback.clone();
    let playback_active = session.active.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _assistant_speech = assistant_speech;
        let result = synthesize_and_stream(
            &base,
            voice,
            "Hello. This is a preview of my voice.",
            output_device.as_deref(),
            session.active,
            session.playback_rate,
        );
        finish_playback(&playback, &playback_active);
        result
    })
    .await
    .map_err(|error| format!("Pocket preview task failed: {error}"))?
}

#[tauri::command]
pub async fn speak_pocket_voice(
    app: AppHandle,
    state: State<'_, PocketVoiceState>,
    native_voice: State<'_, NativeVoiceState>,
    text: String,
) -> Result<(), String> {
    let text = text.trim().to_string();
    if text.is_empty() {
        return Ok(());
    }
    let base = cache_base(&app)?;
    let assets = lock_local_assets_for_read(&base)?;
    let installed = pocket_installation_valid(&base);
    drop(assets);
    if !installed {
        return Err("Pocket TTS installation is incomplete or corrupt".to_string());
    }
    let voice_id = selected_voice(&base);
    let voice = pocket_assets::voices()
        .iter()
        .find(|voice| voice.id == voice_id)
        .copied()
        .ok_or_else(|| format!("Unknown selected Pocket voice: {voice_id}"))?;
    let session = begin_playback(&state, "Pocket voice playback is already active", &base)?;
    let output_device = selected_output_device();
    let effective_output_device = effective_output_device_name(output_device.as_deref());
    let assistant_speech =
        output_device_uses_speakers(effective_output_device.as_deref()).then(|| {
            log::info!("[voice-echo-guard] speaker output detected");
            native_voice.begin_assistant_speech(
                InterruptionSensitivity::Balanced,
                InputDuringTtsPolicy::SuppressInput,
            )
        });

    let playback = state.playback.clone();
    let playback_active = session.active.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _assistant_speech = assistant_speech;
        let result = synthesize_and_stream(
            &base,
            voice,
            &text,
            output_device.as_deref(),
            session.active,
            session.playback_rate,
        );
        finish_playback(&playback, &playback_active);
        result
    })
    .await
    .map_err(|error| format!("Pocket playback task failed: {error}"))?
}

#[tauri::command]
#[allow(clippy::too_many_arguments)] // Tauri injects three runtime dependencies beside the stream payload.
pub fn start_pocket_voice_stream(
    app: AppHandle,
    state: State<'_, PocketVoiceState>,
    native_voice: State<'_, NativeVoiceState>,
    session_id: String,
    expected_revision: u64,
    speech_id: u64,
    stream_id: String,
    interruption_mode: VoiceInterruptionMode,
    interruption_sensitivity: InterruptionSensitivity,
) -> Result<bool, String> {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (
            app,
            state,
            native_voice,
            session_id,
            expected_revision,
            speech_id,
            stream_id,
            interruption_mode,
            interruption_sensitivity,
        );
        Err("Pocket voice playback is currently supported on macOS only".to_string())
    }

    #[cfg(target_os = "macos")]
    {
        if stream_id.trim().is_empty() {
            return Err("Pocket voice stream id cannot be empty".to_string());
        }
        let base = cache_base(&app)?;
        let assets = lock_local_assets_for_read(&base)?;
        let installed = pocket_installation_valid(&base);
        drop(assets);
        if !installed {
            return Err("Pocket TTS installation is incomplete or corrupt".to_string());
        }
        let voice_id = selected_voice(&base);
        let voice = pocket_assets::voices()
            .iter()
            .find(|voice| voice.id == voice_id)
            .copied()
            .ok_or_else(|| format!("Unknown selected Pocket voice: {voice_id}"))?;
        let session = begin_playback(&state, "Pocket voice playback is already active", &base)?;
        let output_device = selected_output_device();
        let effective_output_device = effective_output_device_name(output_device.as_deref());
        let input_during_tts =
            resolve_input_during_tts_policy(interruption_mode, effective_output_device.as_deref());
        let (sender, receiver) = mpsc::channel();
        {
            let mut playback = state
                .playback
                .lock()
                .map_err(|_| "Pocket TTS playback state lock was poisoned".to_string())?;
            playback.stream = Some(ActivePocketStream {
                id: stream_id.clone(),
                sender,
            });
        }

        let PlaybackSession {
            active,
            playback_rate,
        } = session;
        let Some(admission) = native_voice.claim_assistant_speech(
            &session_id,
            expected_revision,
            speech_id,
            active.clone(),
        )?
        else {
            finish_playback(&state.playback, &active);
            return Ok(false);
        };
        let playback = state.playback.clone();
        let playback_active = active.clone();
        let native_voice_state = native_voice.inner().clone();
        tauri::async_runtime::spawn_blocking(move || {
            let admission_guard = admission;
            let result = run_with_playback_cleanup(&playback, &playback_active, || {
                run_pocket_voice_stream(
                    &app,
                    &stream_id,
                    &base,
                    voice,
                    output_device.as_deref(),
                    active.clone(),
                    playback_rate,
                    receiver,
                    native_voice_state,
                    interruption_sensitivity,
                    input_during_tts,
                )
            });
            let (event_state, error, delivery) = match result {
                Ok(outcome) => (outcome.state, None, outcome.delivery),
                Err(failure) if !active.load(Ordering::SeqCst) => {
                    log::debug!("Pocket voice stream stopped after error: {}", failure.error);
                    (PocketStreamEventState::Interrupted, None, failure.delivery)
                }
                Err(failure) => (
                    PocketStreamEventState::Failed,
                    Some(failure.error),
                    failure.delivery,
                ),
            };
            // A terminal event hands stream ownership back to the renderer,
            // which may immediately start a replacement stream. Release the
            // backend playback token before publishing that handoff.
            drop(admission_guard);
            emit_pocket_stream_event(&app, &stream_id, event_state, error, delivery);
        });
        Ok(true)
    }
}

#[tauri::command]
pub fn append_pocket_voice_stream(
    state: State<'_, PocketVoiceState>,
    stream_id: String,
    text: String,
) -> Result<(), String> {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (state, stream_id, text);
        Err("Pocket voice playback is currently supported on macOS only".to_string())
    }

    #[cfg(target_os = "macos")]
    {
        if text.is_empty() {
            return Ok(());
        }
        send_pocket_stream_command(&state, &stream_id, PocketStreamCommand::Append(text))
    }
}

#[tauri::command]
pub fn finish_pocket_voice_stream(
    state: State<'_, PocketVoiceState>,
    stream_id: String,
) -> Result<(), String> {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (state, stream_id);
        Err("Pocket voice playback is currently supported on macOS only".to_string())
    }

    #[cfg(target_os = "macos")]
    {
        send_pocket_stream_command(&state, &stream_id, PocketStreamCommand::Finish)
    }
}

#[tauri::command]
pub fn flush_pocket_voice_stream(
    state: State<'_, PocketVoiceState>,
    stream_id: String,
) -> Result<(), String> {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (state, stream_id);
        Err("Pocket voice playback is currently supported on macOS only".to_string())
    }

    #[cfg(target_os = "macos")]
    {
        send_pocket_stream_command(&state, &stream_id, PocketStreamCommand::Flush)
    }
}

#[cfg(target_os = "macos")]
fn send_pocket_stream_command(
    state: &PocketVoiceState,
    stream_id: &str,
    command: PocketStreamCommand,
) -> Result<(), String> {
    let playback = state
        .playback
        .lock()
        .map_err(|_| "Pocket TTS playback state lock was poisoned".to_string())?;
    let stream = playback
        .stream
        .as_ref()
        .filter(|stream| stream.id == stream_id)
        .ok_or_else(|| format!("Pocket voice stream is not active: {stream_id}"))?;
    stream
        .sender
        .send(command)
        .map_err(|_| format!("Pocket voice stream worker stopped: {stream_id}"))
}

#[tauri::command]
pub fn stop_pocket_voice(state: State<'_, PocketVoiceState>) -> Result<bool, String> {
    stop_pocket_playback(&state)
}

fn stop_pocket_playback(state: &PocketVoiceState) -> Result<bool, String> {
    let playback = state
        .playback
        .lock()
        .map_err(|_| "Pocket TTS playback state lock was poisoned".to_string())?;
    let Some(active) = playback.active.as_ref() else {
        return Ok(false);
    };
    active.store(false, Ordering::SeqCst);
    #[cfg(target_os = "macos")]
    if let Some(stream) = playback.stream.as_ref() {
        let _ = stream.sender.send(PocketStreamCommand::Stop);
    }
    Ok(true)
}

impl PocketVoiceState {
    pub(crate) fn stop_for_window_destroyed(&self) -> bool {
        match stop_pocket_playback(self) {
            Ok(stopped) => stopped,
            Err(error) => {
                log::warn!("Failed to stop Pocket playback for a destroyed window: {error}");
                false
            }
        }
    }
}

#[tauri::command]
pub async fn remove_voice_model(
    app: AppHandle,
    state: State<'_, PocketVoiceState>,
    native_voice: State<'_, NativeVoiceState>,
    capture: State<'_, VoiceCaptureState>,
    model: VoiceModelKind,
) -> Result<PocketVoiceStatus, String> {
    let queued = {
        let mut runtime = state
            .install
            .lock()
            .map_err(|_| "Pocket TTS install state lock was poisoned".to_string())?;
        let queued = begin_model_removal(&mut runtime, model)?;
        match model {
            VoiceModelKind::Pocket => runtime.pocket_error = None,
            VoiceModelKind::Parakeet => runtime.parakeet_error = None,
        }
        queued
    };
    emit_pocket_status(&app, &state);
    if queued {
        wait_for_install_idle(&state).await?;
        emit_pocket_status(&app, &state);
    }

    let stop_result = match model {
        VoiceModelKind::Pocket => match stop_pocket_playback(&state) {
            Ok(false) => Ok(()),
            Ok(true) => {
                let playback = state.playback.clone();
                match tauri::async_runtime::spawn_blocking(move || {
                    wait_for_pocket_playback_to_stop(&playback)
                })
                .await
                {
                    Ok(result) => result,
                    Err(error) => Err(format!("Pocket TTS stop task failed: {error}")),
                }
            }
            Err(error) => Err(error),
        },
        VoiceModelKind::Parakeet => native_voice.stop_for_model_removal(&app, &capture).await,
    };
    let removal_result = match (stop_result, cache_base(&app)) {
        (Ok(()), Ok(base)) => {
            match tauri::async_runtime::spawn_blocking(move || remove_cached_model(&base, model))
                .await
            {
                Ok(result) => result,
                Err(error) => Err(format!("Voice model removal task failed: {error}")),
            }
        }
        (Err(error), _) | (_, Err(error)) => Err(error),
    };

    {
        let mut runtime = state
            .install
            .lock()
            .map_err(|_| "Pocket TTS install state lock was poisoned".to_string())?;
        runtime.removing = None;
        match model {
            VoiceModelKind::Pocket => {
                runtime.pocket_error = removal_result.as_ref().err().cloned();
                if removal_result.is_ok() {
                    runtime.pocket_progress = None;
                }
            }
            VoiceModelKind::Parakeet => {
                runtime.parakeet_error = removal_result.as_ref().err().cloned();
                if removal_result.is_ok() {
                    runtime.parakeet_progress = None;
                }
            }
        }
    }
    emit_pocket_status(&app, &state);
    let status = get_pocket_voice_status(app.clone(), state.clone())?;
    removal_result?;
    Ok(status)
}

fn install_busy(runtime: &InstallRuntime) -> bool {
    runtime.active_model.is_some() || !runtime.queued_models.is_empty()
}

fn begin_model_removal(
    runtime: &mut InstallRuntime,
    model: VoiceModelKind,
) -> Result<bool, String> {
    if runtime.removing.is_some() {
        return Err("A voice model removal is already in progress".to_string());
    }
    if runtime.active_model == Some(model) || runtime.queued_models.contains(&model) {
        return Err("The model being downloaded cannot be removed".to_string());
    }
    runtime.removing = Some(model);
    Ok(install_busy(runtime))
}

async fn wait_for_install_idle(state: &PocketVoiceState) -> Result<(), String> {
    loop {
        let changed = state.install_changed.notified();
        let busy = state
            .install
            .lock()
            .map_err(|_| "Pocket TTS install state lock was poisoned".to_string())
            .map(|runtime| install_busy(&runtime))?;
        if !busy {
            return Ok(());
        }
        changed.await;
    }
}

fn remove_cached_model(base: &Path, model: VoiceModelKind) -> Result<(), String> {
    remove_cached_model_with(
        base,
        model,
        pocket_installation_valid,
        parakeet_installation_valid,
        |mutation, source, destination| {
            pocket_assets::stage_verified_bundle(mutation, source, destination)
                .map_err(|error| error.to_string())
        },
        |mutation, source, destination| {
            parakeet_assets::stage_verified_bundle(mutation, source, destination)
                .map_err(|error| error.to_string())
        },
    )
}

fn remove_cached_model_with(
    base: &Path,
    model: VoiceModelKind,
    pocket_ready: impl Fn(&Path) -> bool,
    parakeet_ready: impl Fn(&Path) -> bool,
    stage_pocket: impl Fn(&local_assets::LocalAssetMutationGuard, &Path, &Path) -> Result<(), String>,
    stage_parakeet: impl Fn(&local_assets::LocalAssetMutationGuard, &Path, &Path) -> Result<(), String>,
) -> Result<(), String> {
    let roots = local_asset_roots(base)?;
    let mutation =
        local_assets::lock_for_mutation_blocking(&roots).map_err(|error| error.to_string())?;
    mutation
        .recover_interrupted_publication()
        .map_err(|error| error.to_string())?;
    let final_dir = base.join(CACHE_VERSION);
    if !final_dir.exists() {
        return Ok(());
    }

    let operation_id = uuid::Uuid::new_v4();
    let staging = base.join(format!("{CACHE_VERSION}.remove-{operation_id}"));
    // Use the shared transaction prefix so a later mutation can recover if this
    // process exits after retiring the live bundle.
    let previous = base.join(format!(".voice-backup-{operation_id}"));
    fs::create_dir_all(&staging)
        .map_err(|error| format!("stage retained voice model assets: {error}"))?;

    let retained_any = match model {
        VoiceModelKind::Pocket => parakeet_ready(base),
        VoiceModelKind::Parakeet => pocket_ready(base),
    };
    let stage_result = match model {
        VoiceModelKind::Pocket if retained_any => stage_parakeet(
            &mutation,
            roots.parakeet_bundle_root(),
            &staging.join("stt"),
        ),
        VoiceModelKind::Parakeet if retained_any => {
            stage_pocket(&mutation, roots.pocket_bundle_root(), &staging)
        }
        _ => Ok(()),
    };
    if let Err(error) = stage_result {
        let _ = fs::remove_dir_all(&staging);
        return Err(error);
    }
    if !retained_any {
        fs::remove_dir_all(&staging)
            .map_err(|error| format!("remove empty voice model staging cache: {error}"))?;
    }

    fs::rename(&final_dir, &previous)
        .map_err(|error| format!("retire voice model cache atomically: {error}"))?;
    if retained_any {
        if let Err(error) = fs::rename(&staging, &final_dir) {
            if let Err(rollback_error) = fs::rename(&previous, &final_dir) {
                return Err(format!(
                    "publish retained voice model cache failed ({error}); restoring the prior cache also failed ({rollback_error}); recovery data remains at {} and {}",
                    previous.display(),
                    staging.display(),
                ));
            }
            fs::remove_dir_all(&staging)
                .map_err(|cleanup| format!("clean failed removal staging cache: {cleanup}"))?;
            return Err(format!("publish retained voice model cache: {error}"));
        }
        let retained_ready = match model {
            VoiceModelKind::Pocket => parakeet_ready(base),
            VoiceModelKind::Parakeet => pocket_ready(base),
        };
        if !retained_ready {
            let failed = base.join(format!("{CACHE_VERSION}.remove-failed-{operation_id}"));
            fs::rename(&final_dir, &failed).map_err(|error| {
                format!(
                    "preserve invalid retained model cache: {error}; recovery data remains at {} and {}",
                    final_dir.display(),
                    previous.display(),
                )
            })?;
            fs::rename(&previous, &final_dir).map_err(|error| {
                format!(
                    "restore prior model cache after verification failure: {error}; recovery data remains at {} and {}",
                    previous.display(),
                    failed.display(),
                )
            })?;
            fs::remove_dir_all(&failed)
                .map_err(|error| format!("clean invalid retained model cache: {error}"))?;
            return Err("Retained voice model cache failed pinned-file verification".to_string());
        }
    }
    fs::remove_dir_all(&previous)
        .map_err(|error| format!("delete retired voice model cache: {error}"))?;
    Ok(())
}

fn begin_playback(
    state: &State<'_, PocketVoiceState>,
    already_active: &str,
    base: &Path,
) -> Result<PlaybackSession, String> {
    begin_playback_runtime(state.inner(), already_active, || playback_speed(base))
}

fn begin_playback_runtime(
    state: &PocketVoiceState,
    already_active: &str,
    current_playback_speed: impl FnOnce() -> f32,
) -> Result<PlaybackSession, String> {
    let install = state
        .install
        .lock()
        .map_err(|_| "Pocket TTS install state lock was poisoned".to_string())?;
    if install.removing.is_some() {
        return Err("Pocket TTS is being removed".to_string());
    }
    let mut playback = state
        .playback
        .lock()
        .map_err(|_| "Pocket TTS playback state lock was poisoned".to_string())?;
    if playback.active.is_some() {
        return Err(already_active.to_string());
    }
    let active = Arc::new(AtomicBool::new(true));
    let playback_rate = current_playback_speed();
    playback.active = Some(active.clone());
    drop(install);
    Ok(PlaybackSession {
        active,
        playback_rate,
    })
}

fn wait_for_pocket_playback_to_stop(
    playback: &std::sync::Mutex<PlaybackRuntime>,
) -> Result<(), String> {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let stopped = playback
            .lock()
            .map_err(|_| "Pocket TTS playback state lock was poisoned".to_string())?
            .active
            .is_none();
        if stopped {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err("Pocket TTS did not stop before model removal".to_string());
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn finish_playback(playback: &std::sync::Mutex<PlaybackRuntime>, completed: &Arc<AtomicBool>) {
    if let Ok(mut playback) = playback.lock() {
        if playback
            .active
            .as_ref()
            .is_some_and(|active| Arc::ptr_eq(active, completed))
        {
            playback.active = None;
            #[cfg(target_os = "macos")]
            {
                playback.stream = None;
            }
        }
    }
}

#[cfg(target_os = "macos")]
fn run_with_playback_cleanup<T>(
    playback: &std::sync::Mutex<PlaybackRuntime>,
    active: &Arc<AtomicBool>,
    run: impl FnOnce() -> T,
) -> T {
    let result = run();
    finish_playback(playback, active);
    result
}

#[tauri::command]
pub async fn install_voice_model(
    app: AppHandle,
    state: State<'_, PocketVoiceState>,
    model: VoiceModelKind,
) -> Result<PocketVoiceStatus, String> {
    let should_start_worker = queue_model_install(&app, &state, model)?;
    emit_pocket_status(&app, &state);
    if should_start_worker {
        spawn_install_worker(app.clone(), state.inner().clone());
    }
    pocket_voice_status(&app, &state)
}

fn queue_model_install(
    app: &AppHandle,
    state: &PocketVoiceState,
    model: VoiceModelKind,
) -> Result<bool, String> {
    let base = cache_base(app)?;
    let _assets = lock_local_assets_for_read(&base)?;
    let already_installed = match model {
        VoiceModelKind::Pocket => pocket_installation_valid(&base),
        VoiceModelKind::Parakeet => parakeet_installation_valid(&base),
    };
    if already_installed {
        return Ok(false);
    }
    let total = match model {
        VoiceModelKind::Pocket => pocket_download_bytes(),
        VoiceModelKind::Parakeet => parakeet_download_bytes(),
    };
    let mut runtime = state
        .install
        .lock()
        .map_err(|_| "Pocket TTS install state lock was poisoned".to_string())?;
    if runtime.removing.is_some() {
        return Err("A voice model removal is already in progress".to_string());
    }
    if runtime.active_model == Some(model) || runtime.queued_models.contains(&model) {
        return Ok(false);
    }
    let should_start_worker = !runtime.worker_running;
    begin_model_attempt(&mut runtime, model, total, should_start_worker)?;
    Ok(should_start_worker)
}

fn begin_model_attempt(
    runtime: &mut InstallRuntime,
    model: VoiceModelKind,
    total_bytes: u64,
    start_immediately: bool,
) -> Result<u64, String> {
    runtime.next_attempt_id = runtime
        .next_attempt_id
        .checked_add(1)
        .ok_or_else(|| "Voice model attempt ID overflow".to_string())?;
    let attempt_id = runtime.next_attempt_id;
    let progress = VoiceModelDownloadProgress {
        attempt_id,
        downloaded_bytes: 0,
        total_bytes,
        phase: if start_immediately {
            VoiceModelDownloadPhase::Downloading
        } else {
            VoiceModelDownloadPhase::Queued
        },
    };
    match model {
        VoiceModelKind::Pocket => {
            runtime.pocket_attempt_id = Some(attempt_id);
            runtime.pocket_progress = Some(progress);
            runtime.pocket_last_progress_emit = None;
            runtime.pocket_error = None;
        }
        VoiceModelKind::Parakeet => {
            runtime.parakeet_attempt_id = Some(attempt_id);
            runtime.parakeet_progress = Some(progress);
            runtime.parakeet_last_progress_emit = None;
            runtime.parakeet_error = None;
        }
    }
    if start_immediately {
        runtime.worker_running = true;
        runtime.active_model = Some(model);
    } else {
        runtime.queued_models.push_back(model);
    }
    Ok(attempt_id)
}

fn spawn_install_worker(app: AppHandle, state: PocketVoiceState) {
    tauri::async_runtime::spawn(async move {
        drain_install_queue(&app, &state).await;
    });
}

async fn drain_install_queue(app: &AppHandle, state: &PocketVoiceState) {
    loop {
        let current = state
            .install
            .lock()
            .ok()
            .and_then(|mut runtime| current_install_attempt(&mut runtime).ok().flatten());
        let Some((model, attempt_id)) = current else {
            return;
        };
        let result = install_one_model(app, state, model, attempt_id).await;
        if let Ok(mut runtime) = state.install.lock() {
            let _ = finish_model_attempt(&mut runtime, model, attempt_id, result.err());
        }
        state.install_changed.notify_waiters();
        emit_pocket_status(app, state);
    }
}

fn current_install_attempt(
    runtime: &mut InstallRuntime,
) -> Result<Option<(VoiceModelKind, u64)>, String> {
    if runtime.active_model.is_none() {
        let Some(next_model) = runtime.queued_models.pop_front() else {
            runtime.worker_running = false;
            return Ok(None);
        };
        let next_attempt_id = model_progress(runtime, next_model)
            .map(|progress| progress.attempt_id)
            .ok_or_else(|| "Queued voice model progress was not initialized".to_string())?;
        runtime.active_model = Some(next_model);
        advance_model_progress(
            runtime,
            next_model,
            next_attempt_id,
            VoiceModelDownloadPhase::Downloading,
            Some(0),
        )?;
    }
    let model = runtime
        .active_model
        .ok_or_else(|| "Voice model worker has no active model".to_string())?;
    let attempt_id = model_progress(runtime, model)
        .map(|progress| progress.attempt_id)
        .ok_or_else(|| "Active voice model progress was not initialized".to_string())?;
    Ok(Some((model, attempt_id)))
}

fn finish_model_attempt(
    runtime: &mut InstallRuntime,
    model: VoiceModelKind,
    attempt_id: u64,
    error: Option<String>,
) -> Result<bool, String> {
    if runtime.active_model != Some(model)
        || model_progress(runtime, model).is_none_or(|progress| progress.attempt_id != attempt_id)
    {
        return Ok(false);
    }
    set_model_error(runtime, model, error);
    runtime.active_model = None;
    let Some(next_model) = runtime.queued_models.pop_front() else {
        return Ok(false);
    };
    let next_attempt_id = model_progress(runtime, next_model)
        .map(|progress| progress.attempt_id)
        .ok_or_else(|| "Queued voice model progress was not initialized".to_string())?;
    runtime.active_model = Some(next_model);
    advance_model_progress(
        runtime,
        next_model,
        next_attempt_id,
        VoiceModelDownloadPhase::Downloading,
        Some(0),
    )?;
    Ok(true)
}

fn model_progress(
    runtime: &InstallRuntime,
    model: VoiceModelKind,
) -> Option<&VoiceModelDownloadProgress> {
    match model {
        VoiceModelKind::Pocket => runtime.pocket_progress.as_ref(),
        VoiceModelKind::Parakeet => runtime.parakeet_progress.as_ref(),
    }
}

fn model_progress_mut(
    runtime: &mut InstallRuntime,
    model: VoiceModelKind,
) -> Option<&mut VoiceModelDownloadProgress> {
    match model {
        VoiceModelKind::Pocket => runtime.pocket_progress.as_mut(),
        VoiceModelKind::Parakeet => runtime.parakeet_progress.as_mut(),
    }
}

fn set_model_error(runtime: &mut InstallRuntime, model: VoiceModelKind, error: Option<String>) {
    match model {
        VoiceModelKind::Pocket => runtime.pocket_error = error,
        VoiceModelKind::Parakeet => runtime.parakeet_error = error,
    }
}

fn set_model_progress(
    state: &PocketVoiceState,
    model: VoiceModelKind,
    attempt_id: u64,
    phase: VoiceModelDownloadPhase,
    downloaded_bytes: Option<u64>,
) -> Result<(), String> {
    let mut runtime = state
        .install
        .lock()
        .map_err(|_| "Pocket TTS install state lock was poisoned".to_string())?;
    advance_model_progress(&mut runtime, model, attempt_id, phase, downloaded_bytes)?;
    Ok(())
}

fn phase_rank(phase: VoiceModelDownloadPhase) -> u8 {
    match phase {
        VoiceModelDownloadPhase::Queued => 0,
        VoiceModelDownloadPhase::Downloading => 1,
        VoiceModelDownloadPhase::Extracting => 2,
        VoiceModelDownloadPhase::Verifying => 3,
        VoiceModelDownloadPhase::Publishing => 4,
        VoiceModelDownloadPhase::Complete => 5,
    }
}

fn advance_model_progress(
    runtime: &mut InstallRuntime,
    model: VoiceModelKind,
    attempt_id: u64,
    phase: VoiceModelDownloadPhase,
    downloaded_bytes: Option<u64>,
) -> Result<bool, String> {
    let Some(progress) = model_progress_mut(runtime, model) else {
        return Err("Voice model progress was not initialized".to_string());
    };
    if progress.attempt_id != attempt_id {
        return Ok(false);
    }
    if phase_rank(phase) < phase_rank(progress.phase) {
        return Err("Voice model progress phase moved backwards".to_string());
    }
    let next_downloaded = downloaded_bytes
        .map(|bytes| progress.downloaded_bytes.max(bytes))
        .unwrap_or(progress.downloaded_bytes);
    if next_downloaded > progress.total_bytes {
        return Err(format!(
            "Voice model progress exceeded its attempt total: {next_downloaded} > {}",
            progress.total_bytes
        ));
    }
    if phase == VoiceModelDownloadPhase::Complete && next_downloaded != progress.total_bytes {
        return Err("Voice model completed before reaching its verified total".to_string());
    }
    progress.downloaded_bytes = next_downloaded;
    progress.phase = phase;
    Ok(true)
}

#[cfg(test)]
fn increment_model_progress(
    runtime: &mut InstallRuntime,
    model: VoiceModelKind,
    attempt_id: u64,
    increment: u64,
) -> Result<bool, String> {
    let Some(progress) = model_progress(runtime, model) else {
        return Err("Voice model progress was not initialized".to_string());
    };
    if progress.attempt_id != attempt_id {
        return Ok(false);
    }
    let next_downloaded = progress
        .downloaded_bytes
        .checked_add(increment)
        .ok_or_else(|| "Voice model progress overflow".to_string())?;
    advance_model_progress(
        runtime,
        model,
        attempt_id,
        progress.phase,
        Some(next_downloaded),
    )
}

fn should_emit_download_progress_at(
    runtime: &mut InstallRuntime,
    model: VoiceModelKind,
    attempt_id: u64,
    now: Instant,
) -> bool {
    if model_progress(runtime, model).is_none_or(|progress| {
        progress.attempt_id != attempt_id || progress.phase != VoiceModelDownloadPhase::Downloading
    }) {
        return false;
    }
    let last_emit = match model {
        VoiceModelKind::Pocket => &mut runtime.pocket_last_progress_emit,
        VoiceModelKind::Parakeet => &mut runtime.parakeet_last_progress_emit,
    };
    if last_emit.is_some_and(|last| now.duration_since(last) < DOWNLOAD_PROGRESS_EMIT_INTERVAL) {
        return false;
    }
    *last_emit = Some(now);
    true
}

fn emit_pocket_status(app: &AppHandle, state: &PocketVoiceState) {
    if let Ok(mut runtime) = state.install.lock() {
        runtime.status_revision = runtime.status_revision.saturating_add(1);
    }
    if let Ok(status) = pocket_voice_status(app, state) {
        log::info!(
            "[voice-model-progress] emit revision={} active={:?} removing={:?} removal_queued={} pocket={:?} parakeet={:?}",
            status.status_revision,
            status.active_model,
            status.removing,
            status.removal_queued,
            status.pocket_progress,
            status.parakeet_progress,
        );
        let _ = app.emit(POCKET_EVENT, status);
    }
}

async fn install_one_model(
    app: &AppHandle,
    state: &PocketVoiceState,
    model: VoiceModelKind,
    attempt_id: u64,
) -> Result<(), String> {
    let base = cache_base(app)?;
    let roots = local_asset_roots(&base)?;
    let mut callback_error = None;
    let mut last_phase = None;
    let mut on_progress = |progress: local_assets::LocalInstallProgress| {
        if callback_error.is_some() {
            return;
        }
        let phase = match progress.phase {
            LocalInstallPhase::Downloading => VoiceModelDownloadPhase::Downloading,
            LocalInstallPhase::Extracting => VoiceModelDownloadPhase::Extracting,
            LocalInstallPhase::Verifying => VoiceModelDownloadPhase::Verifying,
            LocalInstallPhase::Publishing => VoiceModelDownloadPhase::Publishing,
            LocalInstallPhase::Complete => VoiceModelDownloadPhase::Complete,
        };
        if let Err(error) = set_model_progress(
            state,
            model,
            attempt_id,
            phase,
            Some(progress.downloaded_bytes),
        ) {
            callback_error = Some(error);
            return;
        }
        let phase_changed = last_phase.replace(phase) != Some(phase);
        let should_emit = if phase == VoiceModelDownloadPhase::Downloading && !phase_changed {
            state
                .install
                .lock()
                .map(|mut runtime| {
                    should_emit_download_progress_at(
                        &mut runtime,
                        model,
                        attempt_id,
                        Instant::now(),
                    )
                })
                .unwrap_or(false)
        } else {
            true
        };
        if should_emit {
            emit_pocket_status(app, state);
        }
    };
    match model {
        VoiceModelKind::Pocket => {
            pocket_assets::install(&roots, &mut on_progress)
                .await
                .map(|outcome| {
                    if let pocket_assets::PocketInstallOutcome::Installed {
                        cleanup_pending: Some(path),
                        ..
                    } = outcome
                    {
                        log::warn!(
                            "Pocket assets installed; prior backup cleanup remains at {}",
                            path.display()
                        );
                    }
                })
        }
        VoiceModelKind::Parakeet => parakeet_assets::install(&roots, &mut on_progress)
            .await
            .map(|outcome| {
                if let parakeet_assets::ParakeetInstallOutcome::Installed {
                    cleanup_pending: Some(path),
                    ..
                } = outcome
                {
                    log::warn!(
                        "Parakeet assets installed; prior backup cleanup remains at {}",
                        path.display()
                    );
                }
            }),
    }
    .map_err(|error| error.to_string())?;
    if let Some(error) = callback_error {
        return Err(error);
    }
    normalize_successful_install(state, model, attempt_id)?;
    emit_pocket_status(app, state);
    Ok(())
}

fn normalize_successful_install(
    state: &PocketVoiceState,
    model: VoiceModelKind,
    attempt_id: u64,
) -> Result<(), String> {
    let mut runtime = state
        .install
        .lock()
        .map_err(|_| "Pocket TTS install state lock was poisoned".to_string())?;
    let Some(progress) = model_progress_mut(&mut runtime, model) else {
        return Err("Voice model progress was not initialized".to_string());
    };
    if progress.attempt_id != attempt_id {
        return Ok(());
    }
    // AlreadyReady may be discovered during either locked recheck without any
    // network transfer by this attempt. Complete the host projection while
    // retaining the honest downloaded byte count instead of fabricating it.
    progress.phase = VoiceModelDownloadPhase::Complete;
    Ok(())
}

pub fn parakeet_model_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let base = cache_base(app)?;
    let _assets = lock_local_assets_for_read(&base)?;
    if !parakeet_installation_valid(&base) {
        return Err("Native voice installation is incomplete or corrupt".to_string());
    }
    Ok(base.join(CACHE_VERSION).join("stt"))
}

pub fn parakeet_model_for_loading(
    app: &AppHandle,
) -> Result<(PathBuf, local_assets::LocalAssetReadGuard), String> {
    let base = cache_base(app)?;
    let assets = lock_local_assets_for_read(&base)?;
    if !parakeet_installation_valid(&base) {
        return Err("Native voice installation is incomplete or corrupt".to_string());
    }
    Ok((base.join(CACHE_VERSION).join("stt"), assets))
}

#[cfg(target_os = "macos")]
fn emit_pocket_stream_event(
    app: &AppHandle,
    stream_id: &str,
    state: PocketStreamEventState,
    error: Option<String>,
    delivery: Option<VoiceDeliveryProgress>,
) {
    let _ = app.emit(
        POCKET_STREAM_EVENT,
        PocketStreamEvent {
            stream_id: stream_id.to_string(),
            state,
            error,
            delivery,
        },
    );
}

#[cfg(target_os = "macos")]
#[allow(clippy::too_many_arguments)]
fn run_pocket_voice_stream(
    app: &AppHandle,
    stream_id: &str,
    base: &Path,
    voice: PocketVoice,
    output_device: Option<&str>,
    active: Arc<AtomicBool>,
    playback_rate: f32,
    receiver: mpsc::Receiver<PocketStreamCommand>,
    native_voice: NativeVoiceState,
    interruption_sensitivity: InterruptionSensitivity,
    input_during_tts: InputDuringTtsPolicy,
) -> Result<PocketStreamOutcome, PocketStreamFailure> {
    let version = base.join(CACHE_VERSION);
    let _assets = lock_local_assets_for_read(base)?;
    let tts = ConfiguredTtsSlot::new(TtsConfiguration::pocket(
        version,
        CACHE_VERSION.into(),
        voice.id.into(),
        playback_rate,
    ))?;
    let tts = tts.lease()?;
    drop(_assets);
    let backend = tts.backend();
    let player = PocketAudioPlayer::new(SAMPLE_RATE, playback_rate, output_device)?;
    let mut playback = OutboundPlayback::new(&player, &active, SAMPLE_RATE, 0)?;
    let mut pending = String::new();
    let mut first_chunk_pending = true;
    let mut assistant_speech = None::<AssistantSpeechGuard>;
    let mut playback_drained_at = None;
    let output_latency_grace = playback_latency_safety_duration(output_device);
    let mut last_progress_emit = Instant::now();

    let result: Result<PocketStreamOutcome, String> = (|| loop {
        update_pocket_assistant_speech(
            player.is_empty(),
            &mut assistant_speech,
            &mut playback_drained_at,
            output_latency_grace,
            Instant::now(),
        );
        if !playback.poll().map_err(|failure| failure.message)? {
            return Ok(PocketStreamOutcome {
                state: PocketStreamEventState::Interrupted,
                delivery: Some(playback.snapshot()),
            });
        }
        let command = receiver.recv_timeout(Duration::from_millis(20));
        match command {
            Ok(PocketStreamCommand::Append(text)) => {
                pending.push_str(&text);
                if !synthesize_pocket_stream_ready(
                    app,
                    stream_id,
                    backend.as_ref(),
                    &mut playback,
                    &mut pending,
                    &mut first_chunk_pending,
                    &native_voice,
                    interruption_sensitivity,
                    input_during_tts,
                    &mut assistant_speech,
                    &mut playback_drained_at,
                    &mut last_progress_emit,
                    false,
                )? {
                    return Ok(PocketStreamOutcome {
                        state: PocketStreamEventState::Interrupted,
                        delivery: Some(playback.snapshot()),
                    });
                }
            }
            Ok(PocketStreamCommand::Flush) => {
                if !synthesize_pocket_stream_ready(
                    app,
                    stream_id,
                    backend.as_ref(),
                    &mut playback,
                    &mut pending,
                    &mut first_chunk_pending,
                    &native_voice,
                    interruption_sensitivity,
                    input_during_tts,
                    &mut assistant_speech,
                    &mut playback_drained_at,
                    &mut last_progress_emit,
                    true,
                )? {
                    return Ok(PocketStreamOutcome {
                        state: PocketStreamEventState::Interrupted,
                        delivery: Some(playback.snapshot()),
                    });
                }
            }
            Ok(PocketStreamCommand::Finish) => {
                if !synthesize_pocket_stream_ready(
                    app,
                    stream_id,
                    backend.as_ref(),
                    &mut playback,
                    &mut pending,
                    &mut first_chunk_pending,
                    &native_voice,
                    interruption_sensitivity,
                    input_during_tts,
                    &mut assistant_speech,
                    &mut playback_drained_at,
                    &mut last_progress_emit,
                    true,
                )? {
                    return Ok(PocketStreamOutcome {
                        state: PocketStreamEventState::Interrupted,
                        delivery: Some(playback.snapshot()),
                    });
                }
                // Playback speed can change while buffers drain. Use the slowest
                // supported rate so a later slowdown cannot truncate valid audio.
                let drain_timeout = pocket_native_drain_timeout(
                    playback
                        .snapshot()
                        .segments
                        .iter()
                        .map(|segment| segment.total_frames)
                        .sum(),
                    player.completed_source_frames(),
                    playback_rate,
                );
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
                            timeout: Some(drain_timeout),
                            timeout_outcome: DrainTimeoutOutcome::Complete,
                            post_drain,
                        },
                        &mut |delivery| {
                            update_pocket_assistant_speech(
                                player.is_empty(),
                                &mut assistant_speech,
                                &mut playback_drained_at,
                                output_latency_grace,
                                Instant::now(),
                            );
                            if last_progress_emit.elapsed() >= PLAYBACK_PROGRESS_EMIT_INTERVAL {
                                emit_pocket_stream_event(
                                    app,
                                    stream_id,
                                    PocketStreamEventState::Progress,
                                    None,
                                    Some(delivery.clone()),
                                );
                                last_progress_emit = Instant::now();
                            }
                            Ok(())
                        },
                    )
                    .map_err(|failure| failure.message)?;
                if outcome == OutboundOutcome::Interrupted {
                    return Ok(PocketStreamOutcome {
                        state: PocketStreamEventState::Interrupted,
                        delivery: Some(playback.snapshot()),
                    });
                }
                assistant_speech.take();
                return Ok(PocketStreamOutcome {
                    state: PocketStreamEventState::Completed,
                    delivery: None,
                });
            }
            Ok(PocketStreamCommand::Stop) | Err(mpsc::RecvTimeoutError::Disconnected) => {
                active.store(false, Ordering::SeqCst);
                playback.interrupt().map_err(|failure| failure.message)?;
                return Ok(PocketStreamOutcome {
                    state: PocketStreamEventState::Interrupted,
                    delivery: Some(playback.snapshot()),
                });
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if playback.started()
                    && last_progress_emit.elapsed() >= PLAYBACK_PROGRESS_EMIT_INTERVAL
                {
                    emit_pocket_stream_event(
                        app,
                        stream_id,
                        PocketStreamEventState::Progress,
                        None,
                        Some(playback.snapshot()),
                    );
                    last_progress_emit = Instant::now();
                }
            }
        }
    })();

    assistant_speech.take();
    result.map_err(|error| {
        let delivery = delivery_with_played_audio(playback.snapshot());
        let _ = playback.interrupt();
        PocketStreamFailure { error, delivery }
    })
}

#[cfg(target_os = "macos")]
fn update_pocket_assistant_speech(
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
fn reset_pocket_drain_grace(playback_drained_at: &mut Option<Instant>) {
    *playback_drained_at = None;
}

#[cfg(any(test, target_os = "macos"))]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum PocketNativeDrainStatus {
    Waiting,
    Drained,
    TimedOut,
}

#[cfg(any(test, target_os = "macos"))]
fn pocket_native_drain_status(
    playback_drained: bool,
    elapsed: Duration,
    timeout: Duration,
) -> PocketNativeDrainStatus {
    if playback_drained {
        PocketNativeDrainStatus::Drained
    } else if elapsed >= timeout {
        PocketNativeDrainStatus::TimedOut
    } else {
        PocketNativeDrainStatus::Waiting
    }
}

#[cfg(any(test, target_os = "macos"))]
fn pocket_native_drain_timeout(
    total_source_frames: u64,
    completed_source_frames: u64,
    rate: f32,
) -> Duration {
    let remaining_source_frames = total_source_frames.saturating_sub(completed_source_frames);
    let remaining_playback_seconds =
        remaining_source_frames as f64 / f64::from(berd_voice::SAMPLE_RATE) / f64::from(rate);
    Duration::from_secs_f64(remaining_playback_seconds)
        .saturating_add(POCKET_SOURCE_COMPLETION_TIMEOUT)
}

#[cfg(target_os = "macos")]
#[allow(clippy::too_many_arguments)]
fn mark_pocket_playback_started(app: &AppHandle, stream_id: &str) -> Result<(), String> {
    emit_pocket_stream_event(app, stream_id, PocketStreamEventState::Started, None, None);
    println!("VOICE_CONVERSATION_PLAYBACK_STARTED");
    std::io::stdout()
        .flush()
        .map_err(|error| format!("signal Pocket playback start: {error}"))
}

#[cfg(target_os = "macos")]
#[allow(clippy::too_many_arguments)]
fn synthesize_pocket_stream_ready(
    app: &AppHandle,
    stream_id: &str,
    backend: &dyn TtsBackend,
    playback: &mut OutboundPlayback<'_>,
    pending: &mut String,
    first_chunk_pending: &mut bool,
    native_voice: &NativeVoiceState,
    interruption_sensitivity: InterruptionSensitivity,
    input_during_tts: InputDuringTtsPolicy,
    assistant_speech: &mut Option<AssistantSpeechGuard>,
    playback_drained_at: &mut Option<Instant>,
    last_progress_emit: &mut Instant,
    flush: bool,
) -> Result<bool, String> {
    let split = berd_voice::take_streaming_text_chunks(pending, *first_chunk_pending, flush)?;
    *pending = split.pending;
    *first_chunk_pending = split.first_chunk_pending;
    for text in split.ready {
        let text = text.trim().to_string();
        let outcome = playback
            .synthesize_segment(
                backend,
                &text,
                &mut |_| {
                    if assistant_speech.is_none() {
                        *assistant_speech = Some(
                            native_voice
                                .begin_assistant_speech(interruption_sensitivity, input_during_tts),
                        );
                    }
                    reset_pocket_drain_grace(playback_drained_at);
                    Ok(())
                },
                &mut || mark_pocket_playback_started(app, stream_id),
                &mut |delivery| {
                    if last_progress_emit.elapsed() >= PLAYBACK_PROGRESS_EMIT_INTERVAL {
                        emit_pocket_stream_event(
                            app,
                            stream_id,
                            PocketStreamEventState::Progress,
                            None,
                            Some(delivery.clone()),
                        );
                        *last_progress_emit = Instant::now();
                    }
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
fn synthesize_and_stream(
    base: &Path,
    voice: PocketVoice,
    text: &str,
    output_device: Option<&str>,
    active: Arc<AtomicBool>,
    playback_rate: f32,
) -> Result<(), String> {
    use std::sync::Mutex;
    use std::time::Duration;

    let version = base.join(CACHE_VERSION);
    let assets = lock_local_assets_for_read(base)?;
    let engine = load_text_to_speech(
        version
            .to_str()
            .ok_or_else(|| "Pocket model path is not valid UTF-8".to_string())?,
    )?;
    let style = load_pocket_voice_style(&version, voice.id)?;
    drop(assets);
    let player = PocketAudioPlayer::new(SAMPLE_RATE, playback_rate, output_device)?;
    let callback_error = Arc::new(Mutex::new(None::<String>));
    let playback_started = Arc::new(AtomicBool::new(false));
    let mut total_source_frames = 0_u64;

    let callback_active = active.clone();
    let callback_error_slot = callback_error.clone();
    let callback_started = playback_started.clone();
    let mut on_audio = |samples: Vec<f32>| {
        if !callback_active.load(Ordering::SeqCst) {
            return false;
        }
        if samples.is_empty() {
            return true;
        }
        if let Err(error) = player.check_health() {
            if let Ok(mut callback_error) = callback_error_slot.lock() {
                *callback_error = Some(error);
            }
            return false;
        }
        if let Err(error) = player.enqueue(&samples) {
            if let Ok(mut callback_error) = callback_error_slot.lock() {
                *callback_error = Some(error);
            }
            return false;
        }
        total_source_frames = total_source_frames.saturating_add(samples.len() as u64);
        if !callback_started.swap(true, Ordering::SeqCst) {
            println!("VOICE_CONVERSATION_PLAYBACK_STARTED");
            if let Err(error) = std::io::stdout().flush() {
                if let Ok(mut callback_error) = callback_error_slot.lock() {
                    *callback_error = Some(format!("signal Pocket playback start: {error}"));
                }
                return false;
            }
        }
        true
    };
    let completed =
        engine.synth_chunk_streaming(text, &style, STREAMING_EMIT_FRAMES, &mut on_audio)?;

    if let Some(error) = callback_error
        .lock()
        .map_err(|_| "Pocket callback error lock was poisoned".to_string())?
        .take()
    {
        player.stop();
        return Err(error);
    }
    if !completed {
        player.stop();
        return Ok(());
    }
    let drain_timeout = pocket_native_drain_timeout(
        total_source_frames,
        player.completed_source_frames(),
        playback_rate,
    );
    let drain_started = Instant::now();
    loop {
        if !active.load(Ordering::SeqCst) {
            player.stop();
            break;
        }
        player.check_health()?;
        match pocket_native_drain_status(player.is_empty(), drain_started.elapsed(), drain_timeout)
        {
            PocketNativeDrainStatus::Waiting => {}
            PocketNativeDrainStatus::Drained => {
                player.check_health()?;
                break;
            }
            PocketNativeDrainStatus::TimedOut => {
                log::warn!("Pocket one-shot native buffer completion bookkeeping timed out");
                player.stop();
                break;
            }
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn synthesize_and_stream(
    _base: &Path,
    _voice: PocketVoice,
    _text: &str,
    _output_device: Option<&str>,
    _active: Arc<AtomicBool>,
    _playback_rate: f32,
) -> Result<(), String> {
    Err("Pocket voice playback is currently supported on macOS only".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use berd_voice::DeliverySegment as VoiceDeliverySegment;

    #[test]
    fn playback_snapshots_speed_when_the_utterance_begins() {
        let state = PocketVoiceState::default();
        let session =
            begin_playback_runtime(&state, "already active", || 1.0).expect("start playback");
        assert_eq!(session.playback_rate, 1.0);

        finish_playback(&state.playback, &session.active);
        let next =
            begin_playback_runtime(&state, "already active", || 1.75).expect("next playback");
        assert_eq!(session.playback_rate, 1.0);
        assert_eq!(next.playback_rate, 1.75);
    }

    #[test]
    fn failed_stream_retains_only_delivery_with_played_audio() {
        let progress = VoiceDeliveryProgress {
            sample_rate: berd_voice::SAMPLE_RATE,
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
            sample_rate: berd_voice::SAMPLE_RATE,
            segments: vec![VoiceDeliverySegment {
                text: "Not heard.".to_string(),
                played_frames: 0,
                total_frames: 4_800,
                synthesis_complete: true,
            }],
        };
        assert!(delivery_with_played_audio(unheard).is_none());
    }

    #[test]
    fn window_destroy_cancels_active_pocket_playback() {
        let state = PocketVoiceState::default();
        let active = Arc::new(AtomicBool::new(true));
        state.playback.lock().expect("lock playback runtime").active = Some(Arc::clone(&active));

        assert!(state.stop_for_window_destroyed());
        assert!(!active.load(Ordering::SeqCst));
        assert!(!PocketVoiceState::default().stop_for_window_destroyed());
    }

    #[test]
    fn invalid_install_rejects_missing_and_corrupt_files() {
        let directory = tempfile::tempdir().expect("temporary directory");
        assert!(!installation_valid(directory.path()));
        let version = directory.path().join(CACHE_VERSION);
        fs::create_dir_all(version.join("voices")).expect("create fixture");
        fs::write(version.join("bundle.json"), b"wrong").expect("write corrupt fixture");
        assert!(!installation_valid(directory.path()));
    }

    #[test]
    fn disk_usage_is_summed_from_current_published_files() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let version = directory.path().join(CACHE_VERSION);
        fs::create_dir_all(version.join("voices")).expect("create Pocket fixture");
        fs::create_dir_all(version.join("stt")).expect("create Parakeet fixture");

        let mut expected_pocket_bytes = 0;
        for artifact in pocket_assets::model_artifacts() {
            let contents = vec![b'p'; artifact.relative_path.len()];
            expected_pocket_bytes += contents.len() as u64;
            fs::write(version.join(artifact.relative_path), contents)
                .expect("write Pocket artifact fixture");
        }
        for voice in pocket_assets::voices() {
            let contents = vec![b'v'; voice.relative_path.len()];
            expected_pocket_bytes += contents.len() as u64;
            fs::write(version.join(voice.relative_path), contents)
                .expect("write Pocket voice fixture");
        }

        fs::write(version.join("stt").join("model.int8.onnx"), b"model")
            .expect("write Parakeet model fixture");
        fs::write(version.join("stt").join("tokens.txt"), b"tokens")
            .expect("write Parakeet tokens fixture");
        fs::write(version.join("stt").join("MODEL_LICENSE.txt"), b"license")
            .expect("write Parakeet license fixture");

        assert_eq!(
            pocket_disk_bytes(directory.path()),
            Some(expected_pocket_bytes)
        );
        assert_eq!(parakeet_disk_bytes(directory.path()), Some(18));
    }

    #[test]
    fn failed_download_attempt_releases_worker_and_preserves_error() {
        let mut runtime = InstallRuntime::default();
        let attempt_id = begin_model_attempt(
            &mut runtime,
            VoiceModelKind::Parakeet,
            parakeet_download_bytes(),
            true,
        )
        .expect("begin attempt");
        finish_model_attempt(
            &mut runtime,
            VoiceModelKind::Parakeet,
            attempt_id,
            Some("download timed out".to_string()),
        )
        .expect("finish attempt");

        assert!(current_install_attempt(&mut runtime)
            .expect("read current attempt")
            .is_none());
        assert!(!runtime.worker_running);
        assert_eq!(
            runtime.parakeet_error.as_deref(),
            Some("download timed out")
        );
    }

    #[test]
    fn readiness_fingerprint_changes_after_same_length_replacement() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("asset.bin");
        fs::write(&path, b"same-size-a").expect("write original fixture");
        let original =
            fingerprint_files([(path.clone(), 11)]).expect("fingerprint original fixture");

        std::thread::sleep(std::time::Duration::from_millis(5));
        fs::write(&path, b"same-size-b").expect("replace fixture");
        let replacement = fingerprint_files([(path, 11)]).expect("fingerprint replacement fixture");

        assert_ne!(original, replacement);
    }

    #[test]
    fn pocket_multi_file_progress_is_monotonic_for_one_attempt() {
        let mut runtime = InstallRuntime::default();
        let total = pocket_published_bytes();
        let attempt_id = begin_model_attempt(&mut runtime, VoiceModelKind::Pocket, total, true)
            .expect("begin Pocket attempt");
        let mut observed = vec![0];

        for size in pocket_assets::model_artifacts()
            .iter()
            .map(|artifact| artifact.size_bytes)
            .chain(pocket_assets::voices().iter().map(|voice| voice.size_bytes))
        {
            assert!(increment_model_progress(
                &mut runtime,
                VoiceModelKind::Pocket,
                attempt_id,
                size,
            )
            .expect("advance Pocket file"));
            observed.push(
                runtime
                    .pocket_progress
                    .expect("Pocket progress")
                    .downloaded_bytes,
            );
        }
        advance_model_progress(
            &mut runtime,
            VoiceModelKind::Pocket,
            attempt_id,
            VoiceModelDownloadPhase::Verifying,
            Some(total),
        )
        .expect("verify Pocket");
        advance_model_progress(
            &mut runtime,
            VoiceModelKind::Pocket,
            attempt_id,
            VoiceModelDownloadPhase::Publishing,
            None,
        )
        .expect("publish Pocket");
        advance_model_progress(
            &mut runtime,
            VoiceModelKind::Pocket,
            attempt_id,
            VoiceModelDownloadPhase::Complete,
            Some(total),
        )
        .expect("complete Pocket");
        observed.push(
            runtime
                .pocket_progress
                .expect("Pocket progress")
                .downloaded_bytes,
        );

        assert!(observed.windows(2).all(|pair| pair[0] <= pair[1]));
        assert_eq!(observed.last(), Some(&total));
    }

    #[test]
    fn progress_emissions_are_rate_limited_per_model_without_losing_byte_state() {
        let mut runtime = InstallRuntime::default();
        let pocket_id =
            begin_model_attempt(&mut runtime, VoiceModelKind::Pocket, 200, true).expect("Pocket");
        let started = Instant::now();

        increment_model_progress(&mut runtime, VoiceModelKind::Pocket, pocket_id, 25)
            .expect("first chunk");
        assert!(should_emit_download_progress_at(
            &mut runtime,
            VoiceModelKind::Pocket,
            pocket_id,
            started,
        ));
        increment_model_progress(&mut runtime, VoiceModelKind::Pocket, pocket_id, 25)
            .expect("second chunk");
        assert!(!should_emit_download_progress_at(
            &mut runtime,
            VoiceModelKind::Pocket,
            pocket_id,
            started + Duration::from_millis(50),
        ));
        increment_model_progress(&mut runtime, VoiceModelKind::Pocket, pocket_id, 25)
            .expect("third chunk");
        assert!(should_emit_download_progress_at(
            &mut runtime,
            VoiceModelKind::Pocket,
            pocket_id,
            started + DOWNLOAD_PROGRESS_EMIT_INTERVAL,
        ));
        assert_eq!(
            runtime
                .pocket_progress
                .expect("Pocket progress")
                .downloaded_bytes,
            75
        );

        let parakeet_id = begin_model_attempt(&mut runtime, VoiceModelKind::Parakeet, 200, false)
            .expect("Parakeet");
        assert!(!should_emit_download_progress_at(
            &mut runtime,
            VoiceModelKind::Parakeet,
            parakeet_id,
            started,
        ));
    }

    #[test]
    fn speaker_output_detection_is_case_insensitive_and_specific() {
        for name in [
            "MacBook Pro Speakers",
            "Studio SPEAKERS",
            "Living Room Speaker",
            "Altavoces del MacBook Pro",
            "Altavoz del salón",
        ] {
            assert!(output_device_uses_speakers(Some(name)), "{name}");
        }
        for name in [
            "AirPods Pro",
            "USB Headphones",
            "Auriculares externos",
            "BlackHole 16ch",
            "",
        ] {
            assert!(!output_device_uses_speakers(Some(name)), "{name}");
        }
        assert!(!output_device_uses_speakers(None));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn localized_builtin_speaker_metadata_is_distinct_from_headphones() {
        assert!(output_metadata_uses_builtin_speakers(
            Some(kAudioDeviceTransportTypeBuiltIn),
            kAudioStreamTerminalTypeSpeaker,
        ));
        assert!(output_metadata_uses_builtin_speakers(
            Some(kAudioDeviceTransportTypeBuiltIn),
            0x0301,
        ));
        assert!(!output_metadata_uses_builtin_speakers(
            Some(kAudioDeviceTransportTypeBuiltIn),
            0x0302,
        ));
    }

    #[test]
    fn interruption_mode_resolves_shared_input_policy() {
        assert_eq!(
            resolve_input_during_tts_policy(
                VoiceInterruptionMode::Automatic,
                Some("MacBook Pro Speakers"),
            ),
            InputDuringTtsPolicy::SuppressInput
        );
        assert_eq!(
            resolve_input_during_tts_policy(VoiceInterruptionMode::Automatic, Some("AirPods Pro"),),
            InputDuringTtsPolicy::AllowBargeIn
        );
        assert_eq!(
            resolve_input_during_tts_policy(
                VoiceInterruptionMode::Automatic,
                Some("USB Headphones"),
            ),
            InputDuringTtsPolicy::AllowBargeIn
        );
        assert_eq!(
            resolve_input_during_tts_policy(
                VoiceInterruptionMode::Automatic,
                Some("Studio Display Audio"),
            ),
            InputDuringTtsPolicy::AllowBargeIn
        );
        assert_eq!(
            resolve_input_during_tts_policy(VoiceInterruptionMode::Automatic, None,),
            InputDuringTtsPolicy::AllowBargeIn
        );
        assert_eq!(
            resolve_input_during_tts_policy(
                VoiceInterruptionMode::AllowInterruptions,
                Some("MacBook Pro Speakers"),
            ),
            InputDuringTtsPolicy::AllowBargeIn
        );
        assert_eq!(
            resolve_input_during_tts_policy(
                VoiceInterruptionMode::PreventFeedback,
                Some("AirPods Pro"),
            ),
            InputDuringTtsPolicy::SuppressInput
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn playback_drain_grace_covers_high_latency_transports() {
        const BUILT_IN: u32 = 0x626c_746e;
        const BLUETOOTH: u32 = 0x626c_7565;
        const AIRPLAY: u32 = 0x6169_7270;
        const VIRTUAL: u32 = 0x7669_7274;

        assert_eq!(
            playback_latency_safety_duration_for_transport(Some(BUILT_IN)),
            Duration::from_millis(100)
        );
        assert_eq!(
            playback_latency_safety_duration_for_transport(Some(BLUETOOTH)),
            Duration::from_millis(500)
        );
        assert_eq!(
            playback_latency_safety_duration_for_transport(Some(AIRPLAY)),
            Duration::from_secs(2)
        );
        assert_eq!(
            playback_latency_safety_duration_for_transport(Some(VIRTUAL)),
            Duration::from_secs(2)
        );
        assert_eq!(
            playback_latency_safety_duration_for_transport(Some(0x3f3f_3f3f)),
            Duration::from_secs(2)
        );
        assert_eq!(
            playback_latency_safety_duration_for_transport(None),
            Duration::from_secs(2)
        );
    }

    #[test]
    fn playback_drain_grace_restarts_when_a_new_burst_is_enqueued() {
        let started = Instant::now();
        let grace = Duration::from_millis(500);
        let mut drained_at = None;

        assert!(!output_latency_grace_elapsed(
            true,
            true,
            &mut drained_at,
            grace,
            started,
        ));
        reset_pocket_drain_grace(&mut drained_at);
        assert_eq!(drained_at, None);

        assert!(!output_latency_grace_elapsed(
            true,
            true,
            &mut drained_at,
            grace,
            started + Duration::from_millis(600),
        ));
        assert!(!output_latency_grace_elapsed(
            true,
            true,
            &mut drained_at,
            grace,
            started + Duration::from_millis(900),
        ));
        assert!(output_latency_grace_elapsed(
            true,
            true,
            &mut drained_at,
            grace,
            started + Duration::from_millis(1_100),
        ));

        assert!(!output_latency_grace_elapsed(
            true,
            false,
            &mut drained_at,
            grace,
            started + Duration::from_secs(1),
        ));
        assert_eq!(drained_at, None);
    }

    #[test]
    fn playback_drain_grace_never_starts_before_output_is_empty() {
        let started = Instant::now();
        let grace = Duration::from_millis(100);
        let mut drained_at = None;

        assert!(!output_latency_grace_elapsed(
            false,
            true,
            &mut drained_at,
            grace,
            started + Duration::from_secs(10),
        ));
        assert_eq!(drained_at, None);
        assert!(!output_latency_grace_elapsed(
            true,
            true,
            &mut drained_at,
            grace,
            started + Duration::from_secs(10),
        ));
        assert!(output_latency_grace_elapsed(
            true,
            true,
            &mut drained_at,
            grace,
            started + Duration::from_secs(10) + grace,
        ));
    }

    #[test]
    fn native_drain_times_out_after_expected_remaining_audio() {
        let timeout = pocket_native_drain_timeout(72_000, 24_000, 2.0);
        assert_eq!(timeout, Duration::from_secs(3));
        assert_eq!(
            pocket_native_drain_status(false, timeout - Duration::from_millis(1), timeout),
            PocketNativeDrainStatus::Waiting
        );
        assert_eq!(
            pocket_native_drain_status(false, timeout, timeout),
            PocketNativeDrainStatus::TimedOut
        );
        assert_eq!(
            pocket_native_drain_status(true, timeout, timeout),
            PocketNativeDrainStatus::Drained
        );
    }

    #[test]
    fn native_drain_timeout_uses_the_snapshotted_playback_rate() {
        let fastest_timeout = pocket_native_drain_timeout(72_000, 24_000, 2.0);
        let snapshotted_rate = 0.75;
        let snapshotted_timeout = pocket_native_drain_timeout(72_000, 24_000, snapshotted_rate);
        assert!(snapshotted_timeout > fastest_timeout);
        assert_eq!(
            snapshotted_timeout,
            Duration::from_secs_f64(2.0 / f64::from(snapshotted_rate))
                .saturating_add(POCKET_SOURCE_COMPLETION_TIMEOUT)
        );
    }

    #[test]
    fn native_drain_timeout_preserves_remaining_route_grace() {
        let timed_out_at = Instant::now();
        let route_grace = Duration::from_millis(500);

        assert_eq!(
            output_latency_grace_remaining(true, None, route_grace, timed_out_at,),
            route_grace
        );
        assert_eq!(
            output_latency_grace_remaining(
                true,
                Some(timed_out_at - Duration::from_millis(200)),
                route_grace,
                timed_out_at,
            ),
            Duration::from_millis(300)
        );
        assert_eq!(
            output_latency_grace_remaining(
                true,
                Some(timed_out_at - route_grace),
                route_grace,
                timed_out_at,
            ),
            Duration::ZERO
        );
        assert_eq!(
            output_latency_grace_remaining(false, None, route_grace, timed_out_at,),
            Duration::ZERO
        );
    }

    #[test]
    fn parakeet_progress_is_monotonic_through_extraction_and_verification() {
        let mut runtime = InstallRuntime::default();
        let total = parakeet_download_bytes();
        let attempt_id = begin_model_attempt(&mut runtime, VoiceModelKind::Parakeet, total, true)
            .expect("begin Parakeet attempt");
        let first_chunk = 50_000_000;
        increment_model_progress(
            &mut runtime,
            VoiceModelKind::Parakeet,
            attempt_id,
            first_chunk,
        )
        .expect("advance first Parakeet chunk");
        let after_first = runtime
            .parakeet_progress
            .expect("Parakeet progress")
            .downloaded_bytes;
        increment_model_progress(
            &mut runtime,
            VoiceModelKind::Parakeet,
            attempt_id,
            parakeet_assets::ARCHIVE.size_bytes - first_chunk,
        )
        .expect("finish Parakeet archive");
        advance_model_progress(
            &mut runtime,
            VoiceModelKind::Parakeet,
            attempt_id,
            VoiceModelDownloadPhase::Extracting,
            Some(parakeet_assets::ARCHIVE.size_bytes),
        )
        .expect("extract Parakeet");
        let after_archive = runtime
            .parakeet_progress
            .expect("Parakeet progress")
            .downloaded_bytes;
        advance_model_progress(
            &mut runtime,
            VoiceModelKind::Parakeet,
            attempt_id,
            VoiceModelDownloadPhase::Verifying,
            Some(total),
        )
        .expect("verify Parakeet");
        advance_model_progress(
            &mut runtime,
            VoiceModelKind::Parakeet,
            attempt_id,
            VoiceModelDownloadPhase::Publishing,
            None,
        )
        .expect("publish Parakeet");
        advance_model_progress(
            &mut runtime,
            VoiceModelKind::Parakeet,
            attempt_id,
            VoiceModelDownloadPhase::Complete,
            Some(total),
        )
        .expect("complete Parakeet");
        let completed = runtime
            .parakeet_progress
            .expect("Parakeet progress")
            .downloaded_bytes;

        assert!(after_first <= after_archive);
        assert!(after_archive <= completed);
        assert_eq!(completed, total);
        assert_ne!(completed, parakeet_published_bytes());
    }

    #[test]
    fn rapid_model_requests_queue_in_either_order_and_continue_after_failure() {
        for (first, second) in [
            (VoiceModelKind::Pocket, VoiceModelKind::Parakeet),
            (VoiceModelKind::Parakeet, VoiceModelKind::Pocket),
        ] {
            let mut runtime = InstallRuntime::default();
            let first_id =
                begin_model_attempt(&mut runtime, first, 200, true).expect("begin first model");
            let second_id =
                begin_model_attempt(&mut runtime, second, 300, false).expect("queue second model");
            assert_eq!(runtime.active_model, Some(first));
            assert_eq!(runtime.queued_models.front(), Some(&second));
            assert_eq!(
                model_progress(&runtime, second).map(|progress| progress.phase),
                Some(VoiceModelDownloadPhase::Queued)
            );

            assert!(finish_model_attempt(
                &mut runtime,
                first,
                first_id,
                Some("download cancelled".to_string()),
            )
            .expect("continue queue"));
            assert_eq!(runtime.active_model, Some(second));
            assert_eq!(
                model_progress(&runtime, second),
                Some(&VoiceModelDownloadProgress {
                    attempt_id: second_id,
                    downloaded_bytes: 0,
                    total_bytes: 300,
                    phase: VoiceModelDownloadPhase::Downloading,
                })
            );
            assert_eq!(
                match first {
                    VoiceModelKind::Pocket => runtime.pocket_error.as_deref(),
                    VoiceModelKind::Parakeet => runtime.parakeet_error.as_deref(),
                },
                Some("download cancelled")
            );
        }
    }

    #[test]
    fn removal_of_installed_model_queues_while_other_model_downloads() {
        for (downloading, removing) in [
            (VoiceModelKind::Pocket, VoiceModelKind::Parakeet),
            (VoiceModelKind::Parakeet, VoiceModelKind::Pocket),
        ] {
            let mut runtime = InstallRuntime::default();
            let attempt_id = begin_model_attempt(&mut runtime, downloading, 200, true)
                .expect("begin model download");

            assert!(begin_model_removal(&mut runtime, removing)
                .expect("queue independent model removal"));
            assert_eq!(runtime.removing, Some(removing));
            assert!(
                !finish_model_attempt(&mut runtime, downloading, attempt_id, None)
                    .expect("finish active model")
            );
            assert!(!install_busy(&runtime));
        }
    }

    #[test]
    fn removal_then_redownload_resets_only_with_a_new_attempt_and_ignores_stale_events() {
        for model in [VoiceModelKind::Pocket, VoiceModelKind::Parakeet] {
            let mut runtime = InstallRuntime::default();
            let total = 200;
            let original_id =
                begin_model_attempt(&mut runtime, model, total, true).expect("begin install");
            advance_model_progress(
                &mut runtime,
                model,
                original_id,
                VoiceModelDownloadPhase::Complete,
                Some(total),
            )
            .expect("complete install");
            runtime.active_model = None;
            match model {
                VoiceModelKind::Pocket => runtime.pocket_progress = None,
                VoiceModelKind::Parakeet => runtime.parakeet_progress = None,
            }

            let redownload_id =
                begin_model_attempt(&mut runtime, model, total, true).expect("begin redownload");
            assert!(redownload_id > original_id);
            assert_eq!(
                model_progress(&runtime, model).map(|progress| progress.downloaded_bytes),
                Some(0)
            );
            assert!(!advance_model_progress(
                &mut runtime,
                model,
                original_id,
                VoiceModelDownloadPhase::Complete,
                Some(total),
            )
            .expect("ignore stale completion"));
            assert_eq!(
                model_progress(&runtime, model).map(|progress| progress.downloaded_bytes),
                Some(0)
            );
            increment_model_progress(&mut runtime, model, redownload_id, 50)
                .expect("advance redownload");
            advance_model_progress(
                &mut runtime,
                model,
                redownload_id,
                VoiceModelDownloadPhase::Complete,
                Some(total),
            )
            .expect("complete redownload");
            assert_eq!(
                model_progress(&runtime, model).map(|progress| progress.downloaded_bytes),
                Some(total)
            );
        }
    }

    #[test]
    fn initial_already_ready_is_normalized_to_complete_without_fake_download_bytes() {
        let state = PocketVoiceState::default();
        let attempt_id = {
            let mut runtime = state.install.lock().expect("install state");
            begin_model_attempt(&mut runtime, VoiceModelKind::Pocket, 100, true)
                .expect("begin install")
        };
        normalize_successful_install(&state, VoiceModelKind::Pocket, attempt_id)
            .expect("normalize success");
        let runtime = state.install.lock().expect("install state");
        let progress = model_progress(&runtime, VoiceModelKind::Pocket).expect("progress");
        assert_eq!(progress.phase, VoiceModelDownloadPhase::Complete);
        assert_eq!(progress.downloaded_bytes, 0);
        assert_eq!(progress.total_bytes, 100);
    }

    fn remove_fixture_model(base: &Path, model: VoiceModelKind) {
        let version = base.join(CACHE_VERSION);
        fs::create_dir_all(version.join("stt")).expect("create combined fixture");
        fs::write(version.join("pocket-ready"), b"pocket").expect("write Pocket fixture");
        fs::write(version.join("stt/parakeet-ready"), b"parakeet").expect("write Parakeet fixture");
        remove_cached_model_with(
            base,
            model,
            |base| base.join(CACHE_VERSION).join("pocket-ready").is_file(),
            |base| {
                base.join(CACHE_VERSION)
                    .join("stt/parakeet-ready")
                    .is_file()
            },
            |_mutation, source, destination| {
                fs::create_dir_all(destination)
                    .map_err(|error| format!("create Pocket stage: {error}"))?;
                fs::copy(
                    source.join("pocket-ready"),
                    destination.join("pocket-ready"),
                )
                .map_err(|error| format!("copy Pocket stage: {error}"))?;
                Ok(())
            },
            |_mutation, source, destination| {
                fs::create_dir_all(destination)
                    .map_err(|error| format!("create Parakeet stage: {error}"))?;
                fs::copy(
                    source.join("parakeet-ready"),
                    destination.join("parakeet-ready"),
                )
                .map_err(|error| format!("copy Parakeet stage: {error}"))?;
                Ok(())
            },
        )
        .expect("remove fixture model");
    }

    #[test]
    fn pocket_removal_preserves_only_the_ready_parakeet_counterpart() {
        let directory = tempfile::tempdir().expect("temporary directory");
        remove_fixture_model(directory.path(), VoiceModelKind::Pocket);
        let version = directory.path().join(CACHE_VERSION);
        assert!(version.join("stt/parakeet-ready").is_file());
        assert!(!version.join("pocket-ready").exists());
    }

    #[test]
    fn parakeet_removal_preserves_only_the_ready_pocket_counterpart() {
        let directory = tempfile::tempdir().expect("temporary directory");
        remove_fixture_model(directory.path(), VoiceModelKind::Parakeet);
        let version = directory.path().join(CACHE_VERSION);
        assert!(version.join("pocket-ready").is_file());
        assert!(!version.join("stt").exists());
    }

    #[test]
    fn selected_voice_uses_persisted_compatible_voice_or_mary() {
        let directory = tempfile::tempdir().expect("temporary directory");
        assert_eq!(selected_voice(directory.path()), DEFAULT_VOICE);

        fs::write(
            directory.path().join("settings.json"),
            br#"{"selected_voice":"jane"}"#,
        )
        .expect("write compatible selection");
        assert_eq!(selected_voice(directory.path()), "jane");

        fs::write(
            directory.path().join("settings.json"),
            br#"{"selected_voice":"retired"}"#,
        )
        .expect("write incompatible selection");
        assert_eq!(selected_voice(directory.path()), DEFAULT_VOICE);
    }
}
