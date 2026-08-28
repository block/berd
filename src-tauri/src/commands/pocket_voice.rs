//! Native voice installation, selection, and Pocket playback.

use std::collections::VecDeque;
use std::fs;
use std::io::Read;
#[cfg(target_os = "macos")]
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
#[cfg(target_os = "macos")]
use std::sync::mpsc;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime};

#[cfg(target_os = "macos")]
use berd_voice::SAMPLE_RATE;
#[cfg(target_os = "macos")]
use berd_voice::{load_text_to_speech, load_voice_style, PocketTts, VoiceStyle};
use futures_util::StreamExt;
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
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager, State};

#[cfg(target_os = "macos")]
use super::native_voice::AssistantSpeechGuard;
#[cfg(target_os = "macos")]
use super::pocket_audio_player::PocketAudioPlayer;
use super::{
    native_voice::{InterruptionSensitivity, NativeVoiceState},
    voice_capture::VoiceCaptureState,
};
use tokio::io::AsyncWriteExt;

const CACHE_VERSION: &str = "native-voice-v2";
const VERIFIED_MARKER: &str = ".verified";
const POCKET_EVENT: &str = "pocket-voice:event";
#[cfg(target_os = "macos")]
const POCKET_STREAM_EVENT: &str = "pocket-voice:stream-event";
const DEFAULT_VOICE: &str = "mary";
const DOWNLOAD_PROGRESS_EMIT_INTERVAL: Duration = Duration::from_millis(100);
const DOWNLOAD_CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const DOWNLOAD_READ_TIMEOUT: Duration = Duration::from_secs(30);
const DOWNLOAD_TOTAL_TIMEOUT: Duration = Duration::from_secs(30 * 60);
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
#[cfg(any(test, target_os = "macos"))]
const MIN_POCKET_PLAYBACK_SPEED: f32 = 0.75;

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
const PARAKEET_ARCHIVE: Artifact = Artifact {
    filename: "parakeet.tar.bz2",
    size: 104_337_827,
    sha256: "17f945007b52ccd8b7200ffc7c5652e9e8e961dfdf479cefcabd06cf5703630b",
    url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet_tdt_ctc_110m-en-36000-int8.tar.bz2",
};
const PARAKEET_ARCHIVE_DIR: &str = "sherpa-onnx-nemo-parakeet_tdt_ctc_110m-en-36000-int8";
const PARAKEET_MODEL_SIZE: u64 = 131_652_171;
const PARAKEET_MODEL_SHA256: &str =
    "9177a9146cf32ee0cc8152276ef95116f312018d316be37ccf57f7efea81fc1a";
const PARAKEET_TOKENS_SIZE: u64 = 9_953;
const PARAKEET_TOKENS_SHA256: &str =
    "450e56bd2f036fe5b6aa821865838cc5aa9d8b0106134ce9a9ba0664abe6cd10";
const PARAKEET_LICENSE: &str = "\
NVIDIA Parakeet TDT-CTC 110M (English)
© NVIDIA Corporation.

Licensed under the Creative Commons Attribution 4.0 International License:
https://creativecommons.org/licenses/by/4.0/

Original model: https://huggingface.co/nvidia/parakeet-tdt_ctc-110m
ONNX conversion: https://github.com/k2-fsa/sherpa-onnx
";

#[derive(Clone, Copy)]
struct Artifact {
    filename: &'static str,
    size: u64,
    sha256: &'static str,
    url: &'static str,
}

struct DownloadSpec<'a> {
    url: &'a str,
    destination: &'a Path,
    expected_size: u64,
    expected_sha256: &'a str,
}

const MODEL_ARTIFACTS: &[Artifact] = &[
    Artifact { filename: "bundle.json", size: 24_381, sha256: "bab643150f437f37df080a710520ff39ed9ebd9a339f8ebdc739f7eddfc28b3f", url: "https://huggingface.co/KevinAHM/pocket-tts-onnx/resolve/58a6d00cf13d239b6748cb0769f35c580a8f606c/onnx/english_2026-04/bundle.json" },
    Artifact { filename: "bos_before_voice.npy", size: 4_224, sha256: "f46edf4f7007b7ba4ea58831f49d003e59e167b4641c44bb3addfe9231a780b1", url: "https://huggingface.co/KevinAHM/pocket-tts-onnx/resolve/58a6d00cf13d239b6748cb0769f35c580a8f606c/onnx/english_2026-04/bos_before_voice.npy" },
    Artifact { filename: "tokenizer.model", size: 59_339, sha256: "d461765ae179566678c93091c5fa6f2984c31bbe990bf1aa62d92c64d91bc3f6", url: "https://huggingface.co/KevinAHM/pocket-tts-onnx/resolve/58a6d00cf13d239b6748cb0769f35c580a8f606c/onnx/english_2026-04/tokenizer.model" },
    Artifact { filename: "flow_lm_main_int8.onnx", size: 76_341_079, sha256: "f9bd8106b79a0192c1c43399ab938fb24900a95c1c599870d75a884e99000116", url: "https://huggingface.co/KevinAHM/pocket-tts-onnx/resolve/58a6d00cf13d239b6748cb0769f35c580a8f606c/onnx/english_2026-04/flow_lm_main_int8.onnx" },
    Artifact { filename: "flow_lm_flow_int8.onnx", size: 9_962_530, sha256: "3dd781ee5abee9e195320bf0106bebd6372a852b3b36352524ee78b40554635d", url: "https://huggingface.co/KevinAHM/pocket-tts-onnx/resolve/58a6d00cf13d239b6748cb0769f35c580a8f606c/onnx/english_2026-04/flow_lm_flow_int8.onnx" },
    Artifact { filename: "mimi_decoder_int8.onnx", size: 22_684_077, sha256: "3630450a3297a101792a6ac66619ebc70ab916b265e6220c2afaef8b1673f925", url: "https://huggingface.co/KevinAHM/pocket-tts-onnx/resolve/58a6d00cf13d239b6748cb0769f35c580a8f606c/onnx/english_2026-04/mimi_decoder_int8.onnx" },
    Artifact { filename: "mimi_encoder.onnx", size: 39_768_446, sha256: "853e2ca623b8782d94c3745ec6133bfdff7ce33d9b11128bd29ea03f28d76e3d", url: "https://huggingface.co/KevinAHM/pocket-tts-onnx/resolve/58a6d00cf13d239b6748cb0769f35c580a8f606c/onnx/english_2026-04/mimi_encoder.onnx" },
    Artifact { filename: "text_conditioner.onnx", size: 16_388_344, sha256: "4ecee995fb69f85c7a7493d11f7b5ee15d9950facc7ab3f5c9c49ef1e03847bb", url: "https://huggingface.co/KevinAHM/pocket-tts-onnx/resolve/58a6d00cf13d239b6748cb0769f35c580a8f606c/onnx/english_2026-04/text_conditioner.onnx" },
    Artifact { filename: "LICENSE", size: 18_655, sha256: "fe7b4ce83b8381cc5b216bbb4af73c570688d1b819c73bbaed8ca401f4677cd6", url: "https://huggingface.co/KevinAHM/pocket-tts-onnx/resolve/58a6d00cf13d239b6748cb0769f35c580a8f606c/onnx/LICENSE" },
];

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PocketVoice {
    id: &'static str,
    name: &'static str,
    #[serde(skip_serializing)]
    filename: &'static str,
    #[serde(skip_serializing)]
    size_bytes: u64,
    #[serde(skip_serializing)]
    sha256: &'static str,
    #[serde(skip_serializing)]
    url: &'static str,
}

const VOICES: &[PocketVoice] = &[
    PocketVoice { id: "anna", name: "Anna", filename: "anna.wav", size_bytes: 804_630, sha256: "0a6de25cf12bf1540beb85979f306a92be81fecc051c547c5395e7e5237a3856", url: "https://huggingface.co/kyutai/tts-voices/resolve/323332d33f997de8394f24a193e1a76df720e01a/vctk/p228_023_enhanced.wav" },
    PocketVoice { id: "vera", name: "Vera", filename: "vera.wav", size_bytes: 691_416, sha256: "309cf91a895830f15842b398f69a4962cb1f7e0bfab10e25dd27838e826c204b", url: "https://huggingface.co/kyutai/tts-voices/resolve/323332d33f997de8394f24a193e1a76df720e01a/vctk/p229_023_enhanced.wav" },
    PocketVoice { id: "fantine", name: "Fantine", filename: "fantine.wav", size_bytes: 674_852, sha256: "5f07d4e2a3f20a15572aae885156b43ef3fc12ef3812996fd135680d9956448b", url: "https://huggingface.co/kyutai/tts-voices/resolve/323332d33f997de8394f24a193e1a76df720e01a/vctk/p244_023_enhanced.wav" },
    PocketVoice { id: "charles", name: "Charles", filename: "charles.wav", size_bytes: 639_272, sha256: "6b681a429198f16e378d53bccb08d06939da7b00144a7696111d4f8f76be7756", url: "https://huggingface.co/kyutai/tts-voices/resolve/323332d33f997de8394f24a193e1a76df720e01a/vctk/p254_023_enhanced.wav" },
    PocketVoice { id: "paul", name: "Paul", filename: "paul.wav", size_bytes: 717_182, sha256: "7aba504fe0b3b16478b69eb27ce6007e3cb42b0c1915b5f1c6a6024ae37d679b", url: "https://huggingface.co/kyutai/tts-voices/resolve/323332d33f997de8394f24a193e1a76df720e01a/vctk/p259_023_enhanced.wav" },
    PocketVoice { id: "eponine", name: "Eponine", filename: "eponine.wav", size_bytes: 716_330, sha256: "a13c27fb47627b05223691a0ef2974358a18c886e6c2f9d2762ff1d02c20926b", url: "https://huggingface.co/kyutai/tts-voices/resolve/323332d33f997de8394f24a193e1a76df720e01a/vctk/p262_023_enhanced.wav" },
    PocketVoice { id: "azelma", name: "Azelma", filename: "azelma.wav", size_bytes: 823_852, sha256: "60e3d26cdf2efdec5df712152c839928f4d5522821e6554ae11fd96c57ab1026", url: "https://huggingface.co/kyutai/tts-voices/resolve/323332d33f997de8394f24a193e1a76df720e01a/vctk/p303_023_enhanced.wav" },
    PocketVoice { id: "george", name: "George", filename: "george.wav", size_bytes: 642_692, sha256: "29a41f93bf5236e5b21501091d7774c255d5f3d4e62fa4f9fdf0a92a793c84ae", url: "https://huggingface.co/kyutai/tts-voices/resolve/323332d33f997de8394f24a193e1a76df720e01a/vctk/p315_023_enhanced.wav" },
    PocketVoice { id: "mary", name: "Mary", filename: "mary.wav", size_bytes: 639_084, sha256: "a35b0468382218e9f37a9a7494d1e4b74deaf18d7ced22265b4e325bb55c183f", url: "https://huggingface.co/kyutai/tts-voices/resolve/323332d33f997de8394f24a193e1a76df720e01a/vctk/p333_023_enhanced.wav" },
    PocketVoice { id: "jane", name: "Jane", filename: "jane.wav", size_bytes: 759_340, sha256: "2f12e7f155eb3118f55425394f1b049e5b1b67bdc9b3932c8ba4521420aeb84a", url: "https://huggingface.co/kyutai/tts-voices/resolve/323332d33f997de8394f24a193e1a76df720e01a/vctk/p339_023_enhanced.wav" },
    PocketVoice { id: "michael", name: "Michael", filename: "michael.wav", size_bytes: 751_140, sha256: "b6743e9195e5e3fd34fe9d1633ae93f7ffab787b249e45f6467d7d6f7a6ee6ad", url: "https://huggingface.co/kyutai/tts-voices/resolve/323332d33f997de8394f24a193e1a76df720e01a/vctk/p360_023_enhanced.wav" },
    PocketVoice { id: "eve", name: "Eve", filename: "eve.wav", size_bytes: 671_872, sha256: "396e7cbd066b0f3fb6d67fa26e7904076958239d736d4390f15b5fe88feb14cd", url: "https://huggingface.co/kyutai/tts-voices/resolve/323332d33f997de8394f24a193e1a76df720e01a/vctk/p361_023_enhanced.wav" },
];

#[derive(Clone, Debug, Default)]
pub struct PocketVoiceState {
    install: std::sync::Arc<std::sync::Mutex<InstallRuntime>>,
    install_changed: std::sync::Arc<tokio::sync::Notify>,
    playback: std::sync::Arc<std::sync::Mutex<PlaybackRuntime>>,
}

#[derive(Debug, Default)]
struct PlaybackRuntime {
    active: Option<Arc<AtomicBool>>,
    playback_rate: Option<Arc<AtomicU32>>,
    #[cfg(target_os = "macos")]
    stream: Option<ActivePocketStream>,
}

struct PlaybackSession {
    active: Arc<AtomicBool>,
    playback_rate: Arc<AtomicU32>,
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

#[cfg(any(test, target_os = "macos"))]
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct VoiceDeliverySegment {
    text: String,
    played_frames: u64,
    total_frames: u64,
    synthesis_complete: bool,
}

#[cfg(any(test, target_os = "macos"))]
#[derive(Clone, Debug, Serialize)]
struct VoiceDeliveryProgress {
    #[serde(rename = "sampleRate")]
    sample_rate: u32,
    segments: Vec<VoiceDeliverySegment>,
}

#[cfg(any(test, target_os = "macos"))]
#[derive(Debug, Default)]
struct PlaybackDeliveryLedger {
    segments: Vec<(String, u64, bool)>,
}

#[cfg(any(test, target_os = "macos"))]
impl PlaybackDeliveryLedger {
    fn begin_segment(&mut self, text: String) {
        self.segments.push((text, 0, false));
    }

    fn append_frames(&mut self, frames: usize) {
        let frames = frames as u64;
        if frames == 0 {
            return;
        }
        if let Some((_, total, synthesis_complete)) = self.segments.last_mut() {
            if !*synthesis_complete {
                *total = total.saturating_add(frames);
            }
        }
    }

    fn complete_segment(&mut self, final_total_frames: u64) {
        if let Some((_, total, synthesis_complete)) = self.segments.last_mut() {
            *total = (*total).max(final_total_frames);
            *synthesis_complete = true;
        }
    }

    fn total_frames(&self) -> u64 {
        self.segments
            .iter()
            .map(|(_, total_frames, _)| *total_frames)
            .sum()
    }

    fn snapshot_consumed_frames(&self, consumed_frames: u64) -> VoiceDeliveryProgress {
        let mut segment_start = 0_u64;
        let segments = self
            .segments
            .iter()
            .map(|(text, total_frames, synthesis_complete)| {
                let played_frames = consumed_frames
                    .saturating_sub(segment_start)
                    .min(*total_frames);
                segment_start = segment_start.saturating_add(*total_frames);
                VoiceDeliverySegment {
                    text: text.clone(),
                    played_frames,
                    total_frames: *total_frames,
                    synthesis_complete: *synthesis_complete,
                }
            })
            .collect();
        VoiceDeliveryProgress {
            sample_rate: berd_voice::SAMPLE_RATE,
            segments,
        }
    }
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
    voices: &'static [PocketVoice],
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
    MODEL_ARTIFACTS.iter().map(|item| item.size).sum::<u64>()
        + VOICES.iter().map(|item| item.size_bytes).sum::<u64>()
}

fn parakeet_download_bytes() -> u64 {
    PARAKEET_ARCHIVE.size
}

fn pocket_published_bytes() -> u64 {
    pocket_download_bytes()
}

#[cfg(test)]
fn parakeet_published_bytes() -> u64 {
    PARAKEET_MODEL_SIZE + PARAKEET_TOKENS_SIZE + PARAKEET_LICENSE.len() as u64
}

fn pocket_disk_bytes(base: &Path) -> Option<u64> {
    let version = base.join(CACHE_VERSION);
    MODEL_ARTIFACTS
        .iter()
        .map(|item| version.join(item.filename))
        .chain(
            VOICES
                .iter()
                .map(|voice| version.join("voices").join(voice.filename)),
        )
        .try_fold(0_u64, |total, path| {
            total.checked_add(fs::metadata(path).ok()?.len())
        })
}

fn parakeet_disk_bytes(base: &Path) -> Option<u64> {
    let stt = base.join(CACHE_VERSION).join("stt");
    [
        stt.join("model.int8.onnx"),
        stt.join("tokens.txt"),
        stt.join("MODEL_LICENSE.txt"),
    ]
    .into_iter()
    .try_fold(0_u64, |total, path| {
        total.checked_add(fs::metadata(path).ok()?.len())
    })
}

#[cfg(test)]
fn total_bytes() -> u64 {
    pocket_download_bytes() + parakeet_download_bytes()
}

fn cache_base(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|path| path.join("pocket-tts"))
        .map_err(|error| format!("resolve Pocket TTS data directory: {error}"))
}

fn selected_voice(base: &Path) -> String {
    Some(settings(base).selected_voice)
        .filter(|id| VOICES.iter().any(|voice| voice.id == id))
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
pub(crate) fn should_suppress_capture(
    mode: VoiceInterruptionMode,
    output_device: Option<&str>,
) -> bool {
    match mode {
        // Automatic is best-effort because macOS cannot classify every external route.
        // Prevent feedback remains the reliable fallback when this heuristic misses one.
        VoiceInterruptionMode::Automatic => output_device_uses_speakers(output_device),
        VoiceInterruptionMode::AllowInterruptions => false,
        VoiceInterruptionMode::PreventFeedback => true,
    }
}

fn file_has_size(path: &Path, size: u64) -> bool {
    fs::metadata(path).is_ok_and(|metadata| metadata.len() == size)
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
            MODEL_ARTIFACTS.iter().all(|item| {
                verify_file(
                    &base.join(CACHE_VERSION).join(item.filename),
                    item.size,
                    item.sha256,
                )
                .is_ok()
            }) && VOICES.iter().all(|voice| {
                verify_file(
                    &base.join(CACHE_VERSION).join("voices").join(voice.filename),
                    voice.size_bytes,
                    voice.sha256,
                )
                .is_ok()
            })
        },
    )
}

fn parakeet_installation_valid(base: &Path) -> bool {
    cached_installation_valid(
        base,
        parakeet_installation_fingerprint(base),
        &PARAKEET_INSTALLATION_VALIDATION,
        || {
            verify_file(
                &base.join(CACHE_VERSION).join("stt").join("model.int8.onnx"),
                PARAKEET_MODEL_SIZE,
                PARAKEET_MODEL_SHA256,
            )
            .is_ok()
                && verify_file(
                    &base.join(CACHE_VERSION).join("stt").join("tokens.txt"),
                    PARAKEET_TOKENS_SIZE,
                    PARAKEET_TOKENS_SHA256,
                )
                .is_ok()
        },
    )
}

fn verified_version(base: &Path) -> Option<PathBuf> {
    let version = base.join(CACHE_VERSION);
    if !matches!(
        fs::read_to_string(version.join(VERIFIED_MARKER)).as_deref(),
        Ok(CACHE_VERSION)
    ) {
        return None;
    }
    Some(version)
}

fn pocket_installation_fingerprint(base: &Path) -> Option<InstallationFingerprint> {
    let version = verified_version(base)?;
    let mut files: Vec<(PathBuf, u64)> = MODEL_ARTIFACTS
        .iter()
        .map(|item| (version.join(item.filename), item.size))
        .collect();
    files.extend(VOICES.iter().map(|voice| {
        (
            version.join("voices").join(voice.filename),
            voice.size_bytes,
        )
    }));
    fingerprint_files(files)
}

fn parakeet_installation_fingerprint(base: &Path) -> Option<InstallationFingerprint> {
    let version = verified_version(base)?;
    let mut files = vec![
        (
            version.join("stt").join("model.int8.onnx"),
            PARAKEET_MODEL_SIZE,
        ),
        (version.join("stt").join("tokens.txt"), PARAKEET_TOKENS_SIZE),
    ];
    let license = version.join("stt").join("MODEL_LICENSE.txt");
    files.push((license.clone(), fs::metadata(&license).ok()?.len()));
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
        voices: VOICES,
    })
}

#[tauri::command]
pub fn select_pocket_voice(app: AppHandle, voice_id: String) -> Result<(), String> {
    if !VOICES.iter().any(|voice| voice.id == voice_id) {
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
pub fn set_pocket_playback_speed(
    app: AppHandle,
    state: State<'_, PocketVoiceState>,
    speed: f32,
) -> Result<(), String> {
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
        .map_err(|error| format!("publish Pocket settings: {error}"))?;
    update_active_playback_speed(&state, speed)
}

fn update_active_playback_speed(state: &PocketVoiceState, speed: f32) -> Result<(), String> {
    let playback = state
        .playback
        .lock()
        .map_err(|_| "Pocket TTS playback state lock was poisoned".to_string())?;
    if let Some(playback_rate) = playback.playback_rate.as_ref() {
        playback_rate.store(speed.to_bits(), Ordering::SeqCst);
    }
    Ok(())
}

#[tauri::command]
pub async fn preview_pocket_voice(
    app: AppHandle,
    state: State<'_, PocketVoiceState>,
    native_voice: State<'_, NativeVoiceState>,
    voice_id: String,
) -> Result<(), String> {
    let base = cache_base(&app)?;
    let voice = VOICES
        .iter()
        .find(|voice| voice.id == voice_id)
        .copied()
        .ok_or_else(|| format!("Unknown Pocket voice: {voice_id}"))?;
    if !pocket_installation_valid(&base) {
        return Err("Pocket TTS must be downloaded before previewing a voice".to_string());
    }
    let session = begin_playback(
        &state,
        "Another Pocket voice preview is already playing",
        &base,
    )?;
    let output_device = selected_output_device();
    let effective_output_device = effective_output_device_name(output_device.as_deref());
    let capture_suppression =
        output_device_uses_speakers(effective_output_device.as_deref()).then(|| {
            log::info!("[voice-echo-guard] speaker output detected");
            native_voice.suppress_capture()
        });

    let playback = state.playback.clone();
    let playback_active = session.active.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _capture_suppression = capture_suppression;
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
    if !pocket_installation_valid(&base) {
        return Err("Pocket TTS installation is incomplete or corrupt".to_string());
    }
    let voice_id = selected_voice(&base);
    let voice = VOICES
        .iter()
        .find(|voice| voice.id == voice_id)
        .copied()
        .ok_or_else(|| format!("Unknown selected Pocket voice: {voice_id}"))?;
    let session = begin_playback(&state, "Pocket voice playback is already active", &base)?;
    let output_device = selected_output_device();
    let effective_output_device = effective_output_device_name(output_device.as_deref());
    let capture_suppression =
        output_device_uses_speakers(effective_output_device.as_deref()).then(|| {
            log::info!("[voice-echo-guard] speaker output detected");
            native_voice.suppress_capture()
        });

    let playback = state.playback.clone();
    let playback_active = session.active.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _capture_suppression = capture_suppression;
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
pub fn start_pocket_voice_stream(
    app: AppHandle,
    state: State<'_, PocketVoiceState>,
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
        Err("Pocket voice playback is currently supported on macOS only".to_string())
    }

    #[cfg(target_os = "macos")]
    {
        if stream_id.trim().is_empty() {
            return Err("Pocket voice stream id cannot be empty".to_string());
        }
        let base = cache_base(&app)?;
        if !pocket_installation_valid(&base) {
            return Err("Pocket TTS installation is incomplete or corrupt".to_string());
        }
        let voice_id = selected_voice(&base);
        let voice = VOICES
            .iter()
            .find(|voice| voice.id == voice_id)
            .copied()
            .ok_or_else(|| format!("Unknown selected Pocket voice: {voice_id}"))?;
        let session = begin_playback(&state, "Pocket voice playback is already active", &base)?;
        let output_device = selected_output_device();
        let effective_output_device = effective_output_device_name(output_device.as_deref());
        let suppress_capture =
            should_suppress_capture(interruption_mode, effective_output_device.as_deref());
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
        let playback = state.playback.clone();
        let playback_active = active.clone();
        let native_voice_state = native_voice.inner().clone();
        tauri::async_runtime::spawn_blocking(move || {
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
                    suppress_capture,
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
            emit_pocket_stream_event(&app, &stream_id, event_state, error, delivery);
        });
        Ok(())
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
    let final_dir = base.join(CACHE_VERSION);
    if !final_dir.exists() {
        return Ok(());
    }

    let operation_id = uuid::Uuid::new_v4();
    let staging = base.join(format!("{CACHE_VERSION}.remove-{operation_id}"));
    let previous = base.join(format!("{CACHE_VERSION}.removed-{operation_id}"));
    fs::create_dir_all(&staging)
        .map_err(|error| format!("stage retained voice model assets: {error}"))?;

    let retained_paths: Vec<PathBuf> = match model {
        VoiceModelKind::Pocket => vec![PathBuf::from("stt")],
        VoiceModelKind::Parakeet => MODEL_ARTIFACTS
            .iter()
            .map(|artifact| PathBuf::from(artifact.filename))
            .chain(std::iter::once(PathBuf::from("voices")))
            .collect(),
    };
    let mut retained_any = false;
    let stage_result = (|| {
        for relative in retained_paths {
            let source = final_dir.join(&relative);
            if !source.exists() {
                continue;
            }
            retained_any = true;
            clone_cache_path(&source, &staging.join(relative))?;
        }
        if retained_any {
            fs::write(staging.join(VERIFIED_MARKER), CACHE_VERSION)
                .map_err(|error| format!("verify retained voice model cache: {error}"))?;
        }
        Ok::<(), String>(())
    })();
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
            let _ = fs::rename(&previous, &final_dir);
            let _ = fs::remove_dir_all(&staging);
            return Err(format!(
                "publish retained voice model cache atomically: {error}"
            ));
        }
    }
    fs::remove_dir_all(&previous)
        .map_err(|error| format!("delete retired voice model cache: {error}"))?;
    Ok(())
}

fn clone_cache_path(source: &Path, destination: &Path) -> Result<(), String> {
    if source.is_dir() {
        fs::create_dir_all(destination)
            .map_err(|error| format!("create retained cache directory: {error}"))?;
        for entry in fs::read_dir(source)
            .map_err(|error| format!("read retained cache directory: {error}"))?
        {
            let entry = entry.map_err(|error| format!("read retained cache entry: {error}"))?;
            clone_cache_path(&entry.path(), &destination.join(entry.file_name()))?;
        }
        return Ok(());
    }
    fs::hard_link(source, destination)
        .or_else(|_| fs::copy(source, destination).map(|_| ()))
        .map_err(|error| format!("retain voice model asset {}: {error}", source.display()))
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
    let playback_rate = Arc::new(AtomicU32::new(current_playback_speed().to_bits()));
    playback.active = Some(active.clone());
    playback.playback_rate = Some(playback_rate.clone());
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
            playback.playback_rate = None;
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
    fs::create_dir_all(&base).map_err(|error| format!("create Pocket cache: {error}"))?;
    let staging = base.join(format!("{CACHE_VERSION}.partial-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&staging)
        .map_err(|error| format!("create voice model staging directory: {error}"))?;
    let current = base.join(CACHE_VERSION);
    if current.exists() {
        for entry in fs::read_dir(&current)
            .map_err(|error| format!("read current voice model cache: {error}"))?
        {
            let entry = entry.map_err(|error| format!("read voice model cache entry: {error}"))?;
            if entry.file_name() == VERIFIED_MARKER {
                continue;
            }
            clone_cache_path(&entry.path(), &staging.join(entry.file_name()))?;
        }
    }
    match model {
        VoiceModelKind::Pocket => {
            for artifact in MODEL_ARTIFACTS {
                let _ = fs::remove_file(staging.join(artifact.filename));
            }
            let _ = fs::remove_dir_all(staging.join("voices"));
        }
        VoiceModelKind::Parakeet => {
            let _ = fs::remove_dir_all(staging.join("stt"));
        }
    }
    let client = voice_download_client(
        DOWNLOAD_CONNECT_TIMEOUT,
        DOWNLOAD_READ_TIMEOUT,
        DOWNLOAD_TOTAL_TIMEOUT,
    )?;
    let install_result = async {
        match model {
            VoiceModelKind::Parakeet => {
                let archive = staging.join(PARAKEET_ARCHIVE.filename);
                download_artifact(
                    app,
                    state,
                    model,
                    attempt_id,
                    &client,
                    DownloadSpec {
                        url: PARAKEET_ARCHIVE.url,
                        destination: &archive,
                        expected_size: PARAKEET_ARCHIVE.size,
                        expected_sha256: PARAKEET_ARCHIVE.sha256,
                    },
                )
                .await?;
                set_model_progress(
                    state,
                    model,
                    attempt_id,
                    VoiceModelDownloadPhase::Extracting,
                    Some(PARAKEET_ARCHIVE.size),
                )?;
                emit_pocket_status(app, state);
                extract_parakeet(&archive, &staging).await?;
                tokio::fs::remove_file(&archive)
                    .await
                    .map_err(|error| format!("remove Parakeet archive: {error}"))?;
                set_model_progress(
                    state,
                    model,
                    attempt_id,
                    VoiceModelDownloadPhase::Verifying,
                    Some(parakeet_download_bytes()),
                )?;
                emit_pocket_status(app, state);
            }
            VoiceModelKind::Pocket => {
                tokio::fs::create_dir_all(staging.join("voices"))
                    .await
                    .map_err(|error| format!("create Pocket staging directory: {error}"))?;
                for item in MODEL_ARTIFACTS {
                    download_artifact(
                        app,
                        state,
                        model,
                        attempt_id,
                        &client,
                        DownloadSpec {
                            url: item.url,
                            destination: &staging.join(item.filename),
                            expected_size: item.size,
                            expected_sha256: item.sha256,
                        },
                    )
                    .await?;
                }
                for voice in VOICES {
                    download_artifact(
                        app,
                        state,
                        model,
                        attempt_id,
                        &client,
                        DownloadSpec {
                            url: voice.url,
                            destination: &staging.join("voices").join(voice.filename),
                            expected_size: voice.size_bytes,
                            expected_sha256: voice.sha256,
                        },
                    )
                    .await?;
                }
                set_model_progress(
                    state,
                    model,
                    attempt_id,
                    VoiceModelDownloadPhase::Verifying,
                    Some(pocket_published_bytes()),
                )?;
                emit_pocket_status(app, state);
            }
        }
        tokio::fs::write(staging.join(VERIFIED_MARKER), CACHE_VERSION)
            .await
            .map_err(|error| format!("mark verified voice model installation: {error}"))?;
        set_model_progress(
            state,
            model,
            attempt_id,
            VoiceModelDownloadPhase::Publishing,
            None,
        )?;
        emit_pocket_status(app, state);
        publish_staging(&base, &staging)?;
        let published = match model {
            VoiceModelKind::Pocket => pocket_installation_valid(&base),
            VoiceModelKind::Parakeet => parakeet_installation_valid(&base),
        };
        if !published {
            return Err("Published voice model failed pinned-file verification".to_string());
        }
        set_model_progress(
            state,
            model,
            attempt_id,
            VoiceModelDownloadPhase::Complete,
            Some(match model {
                VoiceModelKind::Pocket => pocket_download_bytes(),
                VoiceModelKind::Parakeet => parakeet_download_bytes(),
            }),
        )?;
        emit_pocket_status(app, state);
        Ok::<(), String>(())
    }
    .await;
    if let Err(error) = install_result {
        let _ = tokio::fs::remove_dir_all(&staging).await;
        return Err(error);
    }
    Ok(())
}

fn voice_download_client(
    connect_timeout: Duration,
    read_timeout: Duration,
    total_timeout: Duration,
) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(connect_timeout)
        .read_timeout(read_timeout)
        .timeout(total_timeout)
        .build()
        .map_err(|error| format!("create Pocket download client: {error}"))
}

async fn extract_parakeet(archive: &Path, staging: &Path) -> Result<(), String> {
    let archive = archive.to_path_buf();
    let staging = staging.to_path_buf();
    tauri::async_runtime::spawn_blocking(move || {
        let extraction = staging.join("parakeet-extract");
        fs::create_dir_all(&extraction)
            .map_err(|error| format!("create Parakeet extraction directory: {error}"))?;
        let compressed =
            fs::File::open(&archive).map_err(|error| format!("open Parakeet archive: {error}"))?;
        let decoder = bzip2::read::BzDecoder::new(compressed);
        let mut archive = tar::Archive::new(decoder);
        archive
            .unpack(&extraction)
            .map_err(|error| format!("extract Parakeet archive: {error}"))?;
        let source = extraction.join(PARAKEET_ARCHIVE_DIR);
        verify_file(
            &source.join("model.int8.onnx"),
            PARAKEET_MODEL_SIZE,
            PARAKEET_MODEL_SHA256,
        )?;
        verify_file(
            &source.join("tokens.txt"),
            PARAKEET_TOKENS_SIZE,
            PARAKEET_TOKENS_SHA256,
        )?;
        let destination = staging.join("stt");
        fs::create_dir_all(&destination)
            .map_err(|error| format!("create Parakeet staging directory: {error}"))?;
        fs::rename(
            source.join("model.int8.onnx"),
            destination.join("model.int8.onnx"),
        )
        .map_err(|error| format!("stage Parakeet model: {error}"))?;
        fs::rename(source.join("tokens.txt"), destination.join("tokens.txt"))
            .map_err(|error| format!("stage Parakeet tokens: {error}"))?;
        fs::write(destination.join("MODEL_LICENSE.txt"), PARAKEET_LICENSE)
            .map_err(|error| format!("write Parakeet attribution: {error}"))?;
        fs::remove_dir_all(&extraction)
            .map_err(|error| format!("remove Parakeet extraction directory: {error}"))
    })
    .await
    .map_err(|error| format!("Parakeet extraction task failed: {error}"))?
}

fn verify_file(path: &Path, expected_size: u64, expected_sha256: &str) -> Result<(), String> {
    if !file_has_size(path, expected_size) {
        return Err(format!("Voice asset size mismatch for {}", path.display()));
    }
    let mut file =
        fs::File::open(path).map_err(|error| format!("open {}: {error}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("read {}: {error}", path.display()))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    let actual = format!("{:x}", hasher.finalize());
    if actual != expected_sha256 {
        return Err(format!(
            "Voice asset checksum mismatch for {}: expected {expected_sha256}, got {actual}",
            path.display()
        ));
    }
    Ok(())
}

pub fn parakeet_model_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let base = cache_base(app)?;
    if !parakeet_installation_valid(&base) {
        return Err("Native voice installation is incomplete or corrupt".to_string());
    }
    Ok(base.join(CACHE_VERSION).join("stt"))
}

fn publish_staging(base: &Path, staging: &Path) -> Result<(), String> {
    let final_dir = base.join(CACHE_VERSION);
    let previous = base.join(format!("{CACHE_VERSION}.previous"));
    let _ = fs::remove_dir_all(&previous);
    if final_dir.exists() {
        fs::rename(&final_dir, &previous)
            .map_err(|error| format!("retire incomplete Pocket cache: {error}"))?;
    }
    if let Err(error) = fs::rename(staging, &final_dir) {
        if previous.exists() {
            let _ = fs::rename(&previous, &final_dir);
        }
        return Err(format!("publish Pocket cache atomically: {error}"));
    }
    let _ = fs::remove_dir_all(previous);
    Ok(())
}

async fn download_artifact(
    app: &AppHandle,
    state: &PocketVoiceState,
    model: VoiceModelKind,
    attempt_id: u64,
    client: &reqwest::Client,
    spec: DownloadSpec<'_>,
) -> Result<(), String> {
    let DownloadSpec {
        url,
        destination,
        expected_size,
        expected_sha256,
    } = spec;
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|error| format!("download {url}: {error}"))?
        .error_for_status()
        .map_err(|error| format!("download {url}: {error}"))?;
    let mut file = tokio::fs::File::create(destination)
        .await
        .map_err(|error| format!("create {}: {error}", destination.display()))?;
    let mut stream = response.bytes_stream();
    let mut size = 0_u64;
    let mut hasher = Sha256::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| format!("read {url}: {error}"))?;
        size = size
            .checked_add(chunk.len() as u64)
            .ok_or_else(|| format!("download size overflow for {url}"))?;
        if size > expected_size {
            return Err(format!("download exceeded pinned size for {url}"));
        }
        hasher.update(&chunk);
        file.write_all(&chunk)
            .await
            .map_err(|error| format!("write {}: {error}", destination.display()))?;
        let should_emit = {
            let mut runtime = state
                .install
                .lock()
                .map_err(|_| "Pocket TTS install state lock was poisoned".to_string())?;
            increment_model_progress(&mut runtime, model, attempt_id, chunk.len() as u64)?
                && should_emit_download_progress_at(&mut runtime, model, attempt_id, Instant::now())
        };
        if should_emit {
            emit_pocket_status(app, state);
        }
    }
    file.flush()
        .await
        .map_err(|error| format!("flush {}: {error}", destination.display()))?;
    if size != expected_size {
        return Err(format!(
            "size mismatch for {}: expected {expected_size}, got {size}",
            destination.display()
        ));
    }
    let actual_sha256 = format!("{:x}", hasher.finalize());
    if actual_sha256 != expected_sha256 {
        return Err(format!(
            "checksum mismatch for {}: expected {expected_sha256}, got {actual_sha256}",
            destination.display()
        ));
    }
    Ok(())
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
    playback_rate: Arc<AtomicU32>,
    receiver: mpsc::Receiver<PocketStreamCommand>,
    native_voice: NativeVoiceState,
    interruption_sensitivity: InterruptionSensitivity,
    suppress_capture: bool,
) -> Result<PocketStreamOutcome, PocketStreamFailure> {
    let version = base.join(CACHE_VERSION);
    let engine = load_text_to_speech(
        version
            .to_str()
            .ok_or_else(|| "Pocket model path is not valid UTF-8".to_string())?,
    )?;
    let style = load_voice_style(&version.join("voices").join(voice.filename))?;
    let mut applied_rate_bits = playback_rate.load(Ordering::SeqCst);
    let player = PocketAudioPlayer::new(
        SAMPLE_RATE,
        f32::from_bits(applied_rate_bits),
        output_device,
    )?;
    let mut pending = String::new();
    let mut first_chunk_pending = true;
    let mut playback_started = false;
    let mut assistant_speech = None::<AssistantSpeechGuard>;
    let mut playback_drained_at = None;
    let output_latency_grace = playback_latency_safety_duration(output_device);
    let mut delivery_ledger = PlaybackDeliveryLedger::default();
    let mut last_progress_emit = Instant::now();

    let result: Result<PocketStreamOutcome, String> = (|| loop {
        sync_pocket_playback_rate(&player, &playback_rate, &mut applied_rate_bits)?;
        update_pocket_assistant_speech(
            player.is_empty(),
            &mut assistant_speech,
            &mut playback_drained_at,
            output_latency_grace,
            Instant::now(),
        );
        if !active.load(Ordering::SeqCst) {
            let delivery = pocket_delivery_snapshot(&delivery_ledger, &player);
            player.stop();
            return Ok(PocketStreamOutcome {
                state: PocketStreamEventState::Interrupted,
                delivery: Some(delivery),
            });
        }
        player.ensure_healthy()?;
        let command = receiver.recv_timeout(Duration::from_millis(20));
        match command {
            Ok(PocketStreamCommand::Append(text)) => {
                pending.push_str(&text);
                if !synthesize_pocket_stream_ready(
                    app,
                    stream_id,
                    &engine,
                    &style,
                    &active,
                    &player,
                    &playback_rate,
                    &mut applied_rate_bits,
                    &mut pending,
                    &mut first_chunk_pending,
                    &mut playback_started,
                    &native_voice,
                    interruption_sensitivity,
                    suppress_capture,
                    &mut assistant_speech,
                    &mut playback_drained_at,
                    &mut delivery_ledger,
                    &mut last_progress_emit,
                    false,
                )? {
                    let delivery = capture_before_stop(
                        || pocket_delivery_snapshot(&delivery_ledger, &player),
                        || player.stop(),
                    );
                    return Ok(PocketStreamOutcome {
                        state: PocketStreamEventState::Interrupted,
                        delivery: Some(delivery),
                    });
                }
            }
            Ok(PocketStreamCommand::Flush) => {
                if !synthesize_pocket_stream_ready(
                    app,
                    stream_id,
                    &engine,
                    &style,
                    &active,
                    &player,
                    &playback_rate,
                    &mut applied_rate_bits,
                    &mut pending,
                    &mut first_chunk_pending,
                    &mut playback_started,
                    &native_voice,
                    interruption_sensitivity,
                    suppress_capture,
                    &mut assistant_speech,
                    &mut playback_drained_at,
                    &mut delivery_ledger,
                    &mut last_progress_emit,
                    true,
                )? {
                    let delivery = capture_before_stop(
                        || pocket_delivery_snapshot(&delivery_ledger, &player),
                        || player.stop(),
                    );
                    return Ok(PocketStreamOutcome {
                        state: PocketStreamEventState::Interrupted,
                        delivery: Some(delivery),
                    });
                }
            }
            Ok(PocketStreamCommand::Finish) => {
                if !synthesize_pocket_stream_ready(
                    app,
                    stream_id,
                    &engine,
                    &style,
                    &active,
                    &player,
                    &playback_rate,
                    &mut applied_rate_bits,
                    &mut pending,
                    &mut first_chunk_pending,
                    &mut playback_started,
                    &native_voice,
                    interruption_sensitivity,
                    suppress_capture,
                    &mut assistant_speech,
                    &mut playback_drained_at,
                    &mut delivery_ledger,
                    &mut last_progress_emit,
                    true,
                )? {
                    let delivery = capture_before_stop(
                        || pocket_delivery_snapshot(&delivery_ledger, &player),
                        || player.stop(),
                    );
                    return Ok(PocketStreamOutcome {
                        state: PocketStreamEventState::Interrupted,
                        delivery: Some(delivery),
                    });
                }
                // Playback speed can change while buffers drain. Use the slowest
                // supported rate so a later slowdown cannot truncate valid audio.
                let drain_timeout = pocket_native_drain_timeout(
                    delivery_ledger.total_frames(),
                    player.completed_source_frames(),
                    MIN_POCKET_PLAYBACK_SPEED,
                );
                let drain_started = Instant::now();
                let mut completion_timed_out = false;
                loop {
                    if !active.load(Ordering::SeqCst) {
                        let delivery = pocket_delivery_snapshot(&delivery_ledger, &player);
                        player.stop();
                        return Ok(PocketStreamOutcome {
                            state: PocketStreamEventState::Interrupted,
                            delivery: Some(delivery),
                        });
                    }
                    sync_pocket_playback_rate_before_timeout(completion_timed_out, || {
                        sync_pocket_playback_rate(&player, &playback_rate, &mut applied_rate_bits)
                    })?;
                    if !completion_timed_out {
                        player.ensure_healthy()?;
                        match pocket_native_drain_status(
                            player.is_empty(),
                            drain_started.elapsed(),
                            drain_timeout,
                        ) {
                            PocketNativeDrainStatus::Waiting => {}
                            PocketNativeDrainStatus::Drained => {
                                player.ensure_healthy()?;
                            }
                            PocketNativeDrainStatus::TimedOut => {
                                log::warn!("Pocket native buffer completion bookkeeping timed out");
                                player.stop();
                                reset_pocket_drain_grace(&mut playback_drained_at);
                                completion_timed_out = true;
                            }
                        }
                    }
                    let playback_drained = completion_timed_out || player.is_empty();
                    if playback_drained {
                        update_pocket_assistant_speech(
                            playback_drained,
                            &mut assistant_speech,
                            &mut playback_drained_at,
                            output_latency_grace,
                            Instant::now(),
                        );
                        if assistant_speech.is_none() {
                            break;
                        }
                    }
                    std::thread::sleep(Duration::from_millis(10));
                }
                return Ok(PocketStreamOutcome {
                    state: PocketStreamEventState::Completed,
                    delivery: None,
                });
            }
            Ok(PocketStreamCommand::Stop) | Err(mpsc::RecvTimeoutError::Disconnected) => {
                let delivery = pocket_delivery_snapshot(&delivery_ledger, &player);
                active.store(false, Ordering::SeqCst);
                player.stop();
                return Ok(PocketStreamOutcome {
                    state: PocketStreamEventState::Interrupted,
                    delivery: Some(delivery),
                });
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if playback_started
                    && last_progress_emit.elapsed() >= PLAYBACK_PROGRESS_EMIT_INTERVAL
                {
                    emit_pocket_stream_event(
                        app,
                        stream_id,
                        PocketStreamEventState::Progress,
                        None,
                        Some(pocket_delivery_snapshot(&delivery_ledger, &player)),
                    );
                    last_progress_emit = Instant::now();
                }
            }
        }
    })();

    assistant_speech.take();
    result.map_err(|error| {
        let delivery = delivery_with_played_audio(capture_before_stop(
            || pocket_delivery_snapshot(&delivery_ledger, &player),
            || player.stop(),
        ));
        PocketStreamFailure { error, delivery }
    })
}

#[cfg(target_os = "macos")]
fn pocket_delivery_snapshot(
    ledger: &PlaybackDeliveryLedger,
    player: &PocketAudioPlayer,
) -> VoiceDeliveryProgress {
    ledger.snapshot_consumed_frames(player.played_frames())
}

#[cfg(any(test, target_os = "macos"))]
fn capture_before_stop(
    snapshot: impl FnOnce() -> VoiceDeliveryProgress,
    stop: impl FnOnce(),
) -> VoiceDeliveryProgress {
    let delivery = snapshot();
    stop();
    delivery
}

#[cfg(target_os = "macos")]
fn update_pocket_assistant_speech(
    playback_drained: bool,
    assistant_speech: &mut Option<AssistantSpeechGuard>,
    playback_drained_at: &mut Option<Instant>,
    output_latency_grace: Duration,
    now: Instant,
) {
    if pocket_assistant_speech_grace_elapsed(
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
fn pocket_assistant_speech_grace_elapsed(
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

#[cfg(any(test, target_os = "macos"))]
fn sync_pocket_playback_rate_before_timeout(
    completion_timed_out: bool,
    sync: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    if completion_timed_out {
        Ok(())
    } else {
        sync()
    }
}

#[cfg(target_os = "macos")]
fn sync_pocket_playback_rate(
    player: &PocketAudioPlayer,
    playback_rate: &AtomicU32,
    applied_rate_bits: &mut u32,
) -> Result<(), String> {
    let requested_rate_bits = playback_rate.load(Ordering::SeqCst);
    if requested_rate_bits != *applied_rate_bits {
        player.set_rate(f32::from_bits(requested_rate_bits))?;
        *applied_rate_bits = requested_rate_bits;
    }
    Ok(())
}

#[cfg(target_os = "macos")]
#[allow(clippy::too_many_arguments)]
fn mark_pocket_playback_started(
    app: &AppHandle,
    stream_id: &str,
    native_voice: &NativeVoiceState,
    interruption_sensitivity: InterruptionSensitivity,
    suppress_capture: bool,
    playback_started: &mut bool,
    assistant_speech: &mut Option<AssistantSpeechGuard>,
) -> Result<(), String> {
    if assistant_speech.is_none() {
        *assistant_speech =
            Some(native_voice.begin_assistant_speech(interruption_sensitivity, suppress_capture));
    }
    if !*playback_started {
        *playback_started = true;
        emit_pocket_stream_event(app, stream_id, PocketStreamEventState::Started, None, None);
        println!("VOICE_CONVERSATION_PLAYBACK_STARTED");
        std::io::stdout()
            .flush()
            .map_err(|error| format!("signal Pocket playback start: {error}"))?;
    }
    Ok(())
}

#[cfg(target_os = "macos")]
#[allow(clippy::too_many_arguments)]
fn synthesize_pocket_stream_ready(
    app: &AppHandle,
    stream_id: &str,
    engine: &PocketTts,
    style: &VoiceStyle,
    active: &Arc<AtomicBool>,
    player: &PocketAudioPlayer,
    playback_rate: &AtomicU32,
    applied_rate_bits: &mut u32,
    pending: &mut String,
    first_chunk_pending: &mut bool,
    playback_started: &mut bool,
    native_voice: &NativeVoiceState,
    interruption_sensitivity: InterruptionSensitivity,
    suppress_capture: bool,
    assistant_speech: &mut Option<AssistantSpeechGuard>,
    playback_drained_at: &mut Option<Instant>,
    delivery_ledger: &mut PlaybackDeliveryLedger,
    last_progress_emit: &mut Instant,
    flush: bool,
) -> Result<bool, String> {
    let split = engine.take_streaming_text_chunks(pending, *first_chunk_pending, flush)?;
    *pending = split.pending;
    *first_chunk_pending = split.first_chunk_pending;
    for text in split.ready {
        if !active.load(Ordering::SeqCst) {
            return Ok(false);
        }
        let text = text.trim().to_string();
        delivery_ledger.begin_segment(text.clone());
        let mut segment_frames = 0_u64;
        let mut callback_error = None;
        let completed =
            engine.synth_chunk_streaming(&text, style, STREAMING_EMIT_FRAMES, &mut |samples| {
                if !active.load(Ordering::SeqCst) {
                    return false;
                }
                if samples.is_empty() {
                    return true;
                }
                if let Err(error) =
                    sync_pocket_playback_rate(player, playback_rate, applied_rate_bits)
                {
                    callback_error = Some(error);
                    return false;
                }
                if let Err(error) = player.ensure_healthy() {
                    callback_error = Some(error);
                    return false;
                }
                if let Err(error) = mark_pocket_playback_started(
                    app,
                    stream_id,
                    native_voice,
                    interruption_sensitivity,
                    suppress_capture,
                    playback_started,
                    assistant_speech,
                ) {
                    callback_error = Some(error);
                    return false;
                }
                if let Err(error) = player.enqueue(&samples) {
                    callback_error = Some(error);
                    return false;
                }
                reset_pocket_drain_grace(playback_drained_at);
                segment_frames = segment_frames.saturating_add(samples.len() as u64);
                delivery_ledger.append_frames(samples.len());
                if last_progress_emit.elapsed() >= PLAYBACK_PROGRESS_EMIT_INTERVAL {
                    emit_pocket_stream_event(
                        app,
                        stream_id,
                        PocketStreamEventState::Progress,
                        None,
                        Some(pocket_delivery_snapshot(delivery_ledger, player)),
                    );
                    *last_progress_emit = Instant::now();
                }
                true
            })?;
        if let Some(error) = callback_error {
            return Err(error);
        }
        if !completed {
            return Ok(false);
        }
        delivery_ledger.complete_segment(segment_frames);
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
    playback_rate: Arc<AtomicU32>,
) -> Result<(), String> {
    use std::sync::Mutex;
    use std::time::Duration;

    let version = base.join(CACHE_VERSION);
    let engine = load_text_to_speech(
        version
            .to_str()
            .ok_or_else(|| "Pocket model path is not valid UTF-8".to_string())?,
    )?;
    let style = load_voice_style(&version.join("voices").join(voice.filename))?;
    let mut applied_rate_bits = playback_rate.load(Ordering::SeqCst);
    let player = PocketAudioPlayer::new(
        SAMPLE_RATE,
        f32::from_bits(applied_rate_bits),
        output_device,
    )?;
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
        if let Err(error) =
            sync_pocket_playback_rate(&player, &playback_rate, &mut applied_rate_bits)
        {
            if let Ok(mut callback_error) = callback_error_slot.lock() {
                *callback_error = Some(error);
            }
            return false;
        }
        if let Err(error) = player.ensure_healthy() {
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
        MIN_POCKET_PLAYBACK_SPEED,
    );
    let drain_started = Instant::now();
    loop {
        sync_pocket_playback_rate(&player, &playback_rate, &mut applied_rate_bits)?;
        if !active.load(Ordering::SeqCst) {
            player.stop();
            break;
        }
        player.ensure_healthy()?;
        match pocket_native_drain_status(player.is_empty(), drain_started.elapsed(), drain_timeout)
        {
            PocketNativeDrainStatus::Waiting => {}
            PocketNativeDrainStatus::Drained => {
                player.ensure_healthy()?;
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
    _playback_rate: Arc<AtomicU32>,
) -> Result<(), String> {
    Err("Pocket voice playback is currently supported on macOS only".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn active_playback_observes_live_speed_changes() {
        let state = PocketVoiceState::default();
        let session =
            begin_playback_runtime(&state, "already active", || 1.0).expect("start playback");
        assert_eq!(
            f32::from_bits(session.playback_rate.load(Ordering::SeqCst)),
            1.0
        );

        update_active_playback_speed(&state, 1.75).expect("update active playback");
        assert_eq!(
            f32::from_bits(session.playback_rate.load(Ordering::SeqCst)),
            1.75
        );

        finish_playback(&state.playback, &session.active);
        update_active_playback_speed(&state, 0.75).expect("ignore completed playback");
        assert_eq!(
            f32::from_bits(session.playback_rate.load(Ordering::SeqCst)),
            1.75
        );
    }

    #[test]
    fn playback_ledger_maps_consumed_frames_to_text_segments_conservatively() {
        let mut ledger = PlaybackDeliveryLedger::default();
        ledger.begin_segment("First sentence.".to_string());
        ledger.append_frames(4_800);
        assert!(!ledger.snapshot_consumed_frames(0).segments[0].synthesis_complete);
        ledger.complete_segment(4_800);
        ledger.begin_segment("Second sentence.".to_string());
        ledger.append_frames(4_800);
        ledger.complete_segment(4_800);

        let progress = ledger.snapshot_consumed_frames(3_600);
        assert_eq!(progress.segments[0].played_frames, 3_600);
        assert_eq!(progress.segments[0].total_frames, 4_800);
        assert!(progress.segments[0].synthesis_complete);
        assert_eq!(progress.segments[1].played_frames, 0);
        assert_eq!(progress.segments[1].total_frames, 4_800);
        assert!(progress.segments[1].synthesis_complete);
    }

    #[test]
    fn playback_ledger_maps_native_consumed_frames_across_segments() {
        let mut ledger = PlaybackDeliveryLedger::default();
        ledger.begin_segment("First sentence.".to_string());
        ledger.append_frames(4_800);
        ledger.complete_segment(4_800);
        ledger.begin_segment("Second sentence.".to_string());
        ledger.append_frames(4_800);
        ledger.complete_segment(4_800);

        let progress = ledger.snapshot_consumed_frames(7_200);
        assert_eq!(progress.segments[0].played_frames, 4_800);
        assert_eq!(progress.segments[1].played_frames, 2_400);
    }

    #[test]
    fn interruption_and_failure_capture_delivery_before_stopping_playback() {
        use std::cell::RefCell;

        let mut ledger = PlaybackDeliveryLedger::default();
        ledger.begin_segment("Played piece.".to_string());
        ledger.append_frames(4_800);
        ledger.complete_segment(4_800);
        ledger.begin_segment("Queued audio.".to_string());
        ledger.append_frames(4_800);
        ledger.append_frames(4_800);
        ledger.complete_segment(9_600);
        let calls = RefCell::new(Vec::new());

        let delivery = capture_before_stop(
            || {
                calls.borrow_mut().push("snapshot");
                ledger.snapshot_consumed_frames(3_600)
            },
            || calls.borrow_mut().push("stop"),
        );

        assert_eq!(&*calls.borrow(), &["snapshot", "stop"]);
        assert_eq!(delivery.segments[0].played_frames, 3_600);
        assert_eq!(delivery.segments[1].played_frames, 0);
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
    fn manifest_has_unique_paths_and_expected_total() {
        let mut names = std::collections::HashSet::new();
        for artifact in MODEL_ARTIFACTS {
            assert!(names.insert(artifact.filename));
            assert_eq!(artifact.url.matches("/resolve/").count(), 1);
        }
        for voice in VOICES {
            assert!(names.insert(voice.filename));
            assert_eq!(voice.url.matches("/resolve/").count(), 1);
        }
        assert_eq!(VOICES.len(), 12);
        assert_eq!(total_bytes(), 278_120_564);
    }

    #[test]
    fn invalid_install_rejects_missing_and_corrupt_files() {
        let directory = tempfile::tempdir().expect("temporary directory");
        assert!(!installation_valid(directory.path()));
        let version = directory.path().join(CACHE_VERSION);
        fs::create_dir_all(version.join("voices")).expect("create fixture");
        fs::write(version.join(VERIFIED_MARKER), CACHE_VERSION).expect("write verified marker");
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
        for artifact in MODEL_ARTIFACTS {
            let contents = vec![b'p'; artifact.filename.len()];
            expected_pocket_bytes += contents.len() as u64;
            fs::write(version.join(artifact.filename), contents)
                .expect("write Pocket artifact fixture");
        }
        for voice in VOICES {
            let contents = vec![b'v'; voice.filename.len()];
            expected_pocket_bytes += contents.len() as u64;
            fs::write(version.join("voices").join(voice.filename), contents)
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
    fn verification_rejects_same_length_corruption() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("asset.bin");
        fs::write(&path, b"same-size-a").expect("write original fixture");
        let expected_sha256 = format!("{:x}", Sha256::digest(b"same-size-a"));
        verify_file(&path, 11, &expected_sha256).expect("verify original fixture");

        fs::write(&path, b"same-size-b").expect("write corrupt fixture");
        assert!(verify_file(&path, 11, &expected_sha256)
            .expect_err("same-length corruption must fail")
            .contains("checksum mismatch"));
    }

    #[tokio::test]
    async fn voice_download_client_times_out_a_stalled_partial_body() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind partial response server");
        let address = listener.local_addr().expect("server address");
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.expect("accept request");
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nx")
                .await
                .expect("write partial response");
            tokio::time::sleep(Duration::from_secs(1)).await;
        });
        let client = voice_download_client(
            Duration::from_millis(100),
            Duration::from_millis(100),
            Duration::from_secs(1),
        )
        .expect("build timeout client");
        let response = client
            .get(format!("http://{address}/model"))
            .send()
            .await
            .expect("receive response headers");
        let mut stream = response.bytes_stream();
        assert_eq!(
            stream
                .next()
                .await
                .expect("first body chunk")
                .expect("read first body chunk")
                .as_ref(),
            b"x"
        );
        let error = stream
            .next()
            .await
            .expect("stalled body must terminate")
            .expect_err("stalled body must time out");
        assert!(error.is_timeout(), "unexpected error: {error}");
        server.abort();
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
    fn failed_atomic_publication_restores_previous_cache() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let final_dir = directory.path().join(CACHE_VERSION);
        fs::create_dir_all(&final_dir).expect("create previous cache");
        fs::write(final_dir.join("sentinel"), b"previous").expect("write previous cache");

        let missing_staging = directory.path().join("missing-staging");
        assert!(publish_staging(directory.path(), &missing_staging).is_err());
        assert_eq!(
            fs::read(final_dir.join("sentinel")).expect("restored cache"),
            b"previous"
        );
        assert!(!directory
            .path()
            .join(format!("{CACHE_VERSION}.previous"))
            .exists());
    }

    #[test]
    fn pocket_multi_file_progress_is_monotonic_for_one_attempt() {
        let mut runtime = InstallRuntime::default();
        let total = pocket_published_bytes();
        let attempt_id = begin_model_attempt(&mut runtime, VoiceModelKind::Pocket, total, true)
            .expect("begin Pocket attempt");
        let mut observed = vec![0];

        for size in MODEL_ARTIFACTS
            .iter()
            .map(|artifact| artifact.size)
            .chain(VOICES.iter().map(|voice| voice.size_bytes))
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
    fn interruption_mode_selects_capture_suppression_policy() {
        assert!(should_suppress_capture(
            VoiceInterruptionMode::Automatic,
            Some("MacBook Pro Speakers"),
        ));
        assert!(!should_suppress_capture(
            VoiceInterruptionMode::Automatic,
            Some("AirPods Pro"),
        ));
        assert!(!should_suppress_capture(
            VoiceInterruptionMode::Automatic,
            Some("USB Headphones"),
        ));
        assert!(!should_suppress_capture(
            VoiceInterruptionMode::Automatic,
            Some("Studio Display Audio"),
        ));
        assert!(!should_suppress_capture(
            VoiceInterruptionMode::Automatic,
            None,
        ));
        assert!(!should_suppress_capture(
            VoiceInterruptionMode::AllowInterruptions,
            Some("MacBook Pro Speakers"),
        ));
        assert!(should_suppress_capture(
            VoiceInterruptionMode::PreventFeedback,
            Some("AirPods Pro"),
        ));
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

        assert!(!pocket_assistant_speech_grace_elapsed(
            true,
            true,
            &mut drained_at,
            grace,
            started,
        ));
        reset_pocket_drain_grace(&mut drained_at);
        assert_eq!(drained_at, None);

        assert!(!pocket_assistant_speech_grace_elapsed(
            true,
            true,
            &mut drained_at,
            grace,
            started + Duration::from_millis(600),
        ));
        assert!(!pocket_assistant_speech_grace_elapsed(
            true,
            true,
            &mut drained_at,
            grace,
            started + Duration::from_millis(900),
        ));
        assert!(pocket_assistant_speech_grace_elapsed(
            true,
            true,
            &mut drained_at,
            grace,
            started + Duration::from_millis(1_100),
        ));

        assert!(!pocket_assistant_speech_grace_elapsed(
            true,
            false,
            &mut drained_at,
            grace,
            started + Duration::from_secs(1),
        ));
        assert_eq!(drained_at, None);
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
    fn native_drain_timeout_covers_a_live_slowdown() {
        let fastest_timeout = pocket_native_drain_timeout(72_000, 24_000, 2.0);
        let live_rate_timeout =
            pocket_native_drain_timeout(72_000, 24_000, MIN_POCKET_PLAYBACK_SPEED);
        assert!(live_rate_timeout > fastest_timeout);
        assert_eq!(
            live_rate_timeout,
            Duration::from_secs_f64(2.0 / f64::from(MIN_POCKET_PLAYBACK_SPEED))
                .saturating_add(POCKET_SOURCE_COMPLETION_TIMEOUT)
        );
    }

    #[test]
    fn post_timeout_grace_ignores_live_rate_changes() {
        let mut sync_count = 0;
        sync_pocket_playback_rate_before_timeout(false, || {
            sync_count += 1;
            Ok(())
        })
        .expect("sync while native playback is active");
        sync_pocket_playback_rate_before_timeout(true, || {
            sync_count += 1;
            Err("stopped player rejected rate change".to_string())
        })
        .expect("ignore rate change after native timeout");
        assert_eq!(sync_count, 1);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn native_drain_timeout_releases_guard_after_route_grace() {
        let native_voice = NativeVoiceState::default();
        let mut assistant_speech =
            Some(native_voice.begin_assistant_speech(InterruptionSensitivity::More, false));
        let mut drained_at = Some(Instant::now());
        let timed_out_at = Instant::now();
        let route_grace = Duration::from_millis(500);

        reset_pocket_drain_grace(&mut drained_at);
        update_pocket_assistant_speech(
            true,
            &mut assistant_speech,
            &mut drained_at,
            route_grace,
            timed_out_at,
        );
        assert!(assistant_speech.is_some());

        update_pocket_assistant_speech(
            true,
            &mut assistant_speech,
            &mut drained_at,
            route_grace,
            timed_out_at + route_grace,
        );
        assert!(assistant_speech.is_none());

        assistant_speech =
            Some(native_voice.begin_assistant_speech(InterruptionSensitivity::More, false));
        assert!(assistant_speech.is_some());
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
            PARAKEET_ARCHIVE.size - first_chunk,
        )
        .expect("finish Parakeet archive");
        advance_model_progress(
            &mut runtime,
            VoiceModelKind::Parakeet,
            attempt_id,
            VoiceModelDownloadPhase::Extracting,
            Some(PARAKEET_ARCHIVE.size),
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

    fn write_removal_fixture(base: &Path) {
        let version = base.join(CACHE_VERSION);
        fs::create_dir_all(version.join("voices")).expect("create Pocket fixture");
        fs::create_dir_all(version.join("stt")).expect("create Parakeet fixture");
        for artifact in MODEL_ARTIFACTS {
            fs::write(version.join(artifact.filename), b"pocket")
                .expect("write Pocket artifact fixture");
        }
        fs::write(version.join("voices").join("mary.wav"), b"voice").expect("write voice fixture");
        fs::write(version.join("stt").join("model.int8.onnx"), b"parakeet")
            .expect("write Parakeet fixture");
        fs::write(version.join("stt").join("tokens.txt"), b"tokens")
            .expect("write Parakeet token fixture");
        fs::write(version.join("stt").join("MODEL_LICENSE.txt"), b"license")
            .expect("write Parakeet license fixture");
        fs::write(version.join(VERIFIED_MARKER), CACHE_VERSION).expect("write verified marker");
    }

    #[test]
    fn pocket_removal_atomically_preserves_parakeet_assets() {
        let directory = tempfile::tempdir().expect("temporary directory");
        write_removal_fixture(directory.path());

        remove_cached_model(directory.path(), VoiceModelKind::Pocket)
            .expect("remove Pocket assets");

        let version = directory.path().join(CACHE_VERSION);
        assert!(version.join("stt").join("model.int8.onnx").exists());
        assert!(version.join(VERIFIED_MARKER).exists());
        assert!(!version.join("voices").exists());
        assert!(!version.join(MODEL_ARTIFACTS[0].filename).exists());
    }

    #[test]
    fn parakeet_removal_atomically_preserves_pocket_assets() {
        let directory = tempfile::tempdir().expect("temporary directory");
        write_removal_fixture(directory.path());

        remove_cached_model(directory.path(), VoiceModelKind::Parakeet)
            .expect("remove Parakeet assets");

        let version = directory.path().join(CACHE_VERSION);
        assert!(version.join("voices").join("mary.wav").exists());
        assert!(version.join(MODEL_ARTIFACTS[0].filename).exists());
        assert!(version.join(VERIFIED_MARKER).exists());
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
