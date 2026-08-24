//! Native speech recognition for Desktop voice conversations.

use std::{
    collections::{HashMap, VecDeque},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
        mpsc::{self, Receiver, SyncSender, TrySendError},
        Arc, Mutex,
    },
    thread,
    time::Duration,
};

#[cfg(target_os = "macos")]
use std::time::Instant;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};
use tokio::sync::mpsc as tokio_mpsc;

use super::mac_speech;
use super::{
    native_input_mute, pocket_voice::parakeet_model_dir, voice_buddy,
    voice_capture::VoiceCaptureState,
};

pub(crate) const EVENT_NAME: &str = "voice-conversation:event";
const MAX_AUDIO_BATCH_BYTES: usize = 100 * 1024;
const AUDIO_QUEUE_DEPTH: usize = 50;
const MAX_PENDING_TRANSCRIPTS: usize = 64;
const MAX_TRANSCRIPT_DELIVERY_ATTEMPTS: u8 = 3;
const MAX_SPEECH_SAMPLES: usize = 16_000 * 30;
const VAD_FRAME_SAMPLES: usize = 256;
const VAD_THRESHOLD: f32 = 0.5;
// Keep ordinary pauses between words inside one offline recognition request.
// At 16 kHz with 256-sample frames this is 1.2 seconds.
const SILENCE_FLUSH_FRAMES: usize = 75;
const FINAL_TRANSCRIPT_DELIVERY_TIMEOUT_SECONDS: u64 = 5;
const FINAL_TRANSCRIPT_DELIVERY_TIMEOUT: Duration =
    Duration::from_secs(FINAL_TRANSCRIPT_DELIVERY_TIMEOUT_SECONDS);
const STT_WORKER_SHUTDOWN_TIMEOUT_SECONDS: u64 =
    mac_speech::RECOGNITION_FINISH_TIMEOUT_SECONDS + FINAL_TRANSCRIPT_DELIVERY_TIMEOUT_SECONDS + 1;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum VoiceInputBackend {
    Parakeet,
    Macos,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MicrophoneMuteRequest {
    session_id: String,
    expected_revision: u64,
    muted: bool,
    renderer_id: String,
    renderer_epoch: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantSpeakingRequest {
    session_id: String,
    expected_revision: u64,
    speaking: bool,
    renderer_id: String,
    renderer_epoch: u64,
}

#[derive(Clone, Copy, Debug, Default, Serialize)]
#[serde(rename_all = "kebab-case")]
enum Lifecycle {
    #[default]
    Stopped,
    Running,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeVoiceStatus {
    available: bool,
    unavailable_reason: Option<String>,
    lifecycle: Lifecycle,
    session_id: Option<String>,
    owner_window_label: Option<String>,
    microphone_muted: bool,
    revision: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingTranscript {
    session_id: String,
    lifecycle_id: String,
    id: String,
    text: String,
    revision: u64,
    delivery_attempts: u8,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptRejection {
    attempts: u8,
    terminal: bool,
}

#[derive(Clone, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(crate) enum NativeVoiceEvent {
    Startup {
        session_id: String,
        owner_window_label: String,
        line: String,
        revision: u64,
    },
    User {
        session_id: String,
        lifecycle_id: String,
        id: String,
        text: String,
        revision: u64,
        delivery_attempts: u8,
    },
    Activity {
        session_id: String,
        activity: &'static str,
        revision: u64,
    },
    MicrophoneMute {
        session_id: String,
        muted: bool,
        revision: u64,
    },
    CleanShutdown {
        session_id: String,
        revision: u64,
    },
    ControlsDismissed {
        revision: u64,
    },
    Error {
        session_id: Option<String>,
        message: String,
        revision: u64,
        terminal: bool,
    },
}

#[derive(Default)]
struct Runtime {
    session_id: Option<String>,
    lifecycle_id: Option<String>,
    revision: u64,
    owner: Option<RuntimeOwner>,
    pipeline: Option<SttPipeline>,
    controls_ready: bool,
    controls_suppressed: bool,
    controls_visibility_generation: u64,
    native_microphone_mute_control: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct ControlsVisibilityTarget {
    pub(crate) suppressed: bool,
    pub(crate) generation: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ControlsVisibilityAcknowledgement {
    Inactive,
    Ready,
    Superseded(ControlsVisibilityTarget),
}

#[derive(Clone)]
struct RuntimeOwner {
    window_label: String,
}

#[derive(Clone)]
struct VoiceStartBlock {
    token: String,
    window_label: String,
    renderer_id: String,
    renderer_epoch: u64,
}

type StopSnapshot = (
    Option<String>,
    u64,
    Option<SttPipeline>,
    Option<(RuntimeOwner, String)>,
);

struct StopCompletion {
    session_id: String,
    controls_revision: u64,
    next_revision: u64,
    owner: RuntimeOwner,
    owner_id: String,
}

#[derive(Clone, Default)]
pub struct NativeVoiceState {
    runtime: Arc<Mutex<Runtime>>,
    stop_serial: Arc<tokio::sync::Mutex<()>>,
    start_blocks: Arc<Mutex<HashMap<String, Vec<VoiceStartBlock>>>>,
    pending: Arc<Mutex<VecDeque<PendingTranscript>>>,
    capture_suppressions: Arc<AtomicUsize>,
    microphone_muted: Arc<AtomicBool>,
    input_muted: Arc<AtomicBool>,
    input_mute_epoch: Arc<AtomicU64>,
}

#[must_use = "capture suppression ends when the guard is dropped"]
pub struct CaptureSuppressionGuard {
    capture_suppressions: Arc<AtomicUsize>,
}

impl Drop for CaptureSuppressionGuard {
    fn drop(&mut self) {
        let previous = self.capture_suppressions.fetch_sub(1, Ordering::SeqCst);
        debug_assert!(previous > 0, "capture suppression guard underflow");
        log::info!(
            "[voice-echo-guard] capture resumed suppression_count={}",
            previous.saturating_sub(1)
        );
    }
}

impl NativeVoiceState {
    fn block_starts(
        &self,
        session_id: String,
        window_label: String,
        renderer_id: String,
        renderer_epoch: u64,
    ) -> Result<String, String> {
        let token = uuid::Uuid::new_v4().to_string();
        self.start_blocks
            .lock()
            .map_err(|_| "native voice start block lock was poisoned".to_string())?
            .entry(session_id)
            .or_default()
            .push(VoiceStartBlock {
                token: token.clone(),
                window_label,
                renderer_id,
                renderer_epoch,
            });
        Ok(token)
    }

    fn release_start_block(&self, session_id: &str, token: &str) -> Result<(), String> {
        let mut blocks = self
            .start_blocks
            .lock()
            .map_err(|_| "native voice start block lock was poisoned".to_string())?;
        let Some(session_blocks) = blocks.get_mut(session_id) else {
            return Ok(());
        };
        session_blocks.retain(|block| block.token != token);
        if session_blocks.is_empty() {
            blocks.remove(session_id);
        }
        Ok(())
    }

    fn release_start_blocks_for_window(&self, window_label: &str) {
        let Ok(mut blocks) = self.start_blocks.lock() else {
            return;
        };
        blocks.retain(|_, session_blocks| {
            session_blocks.retain(|block| block.window_label != window_label);
            !session_blocks.is_empty()
        });
    }

    pub(crate) fn release_start_blocks_for_replaced_renderer(
        &self,
        window_label: &str,
        renderer_id: &str,
        renderer_epoch: u64,
    ) {
        let Ok(mut blocks) = self.start_blocks.lock() else {
            return;
        };
        blocks.retain(|_, session_blocks| {
            session_blocks.retain(|block| {
                block.window_label != window_label
                    || (block.renderer_id == renderer_id && block.renderer_epoch == renderer_epoch)
            });
            !session_blocks.is_empty()
        });
    }

    #[cfg(test)]
    fn starts_blocked(&self, session_id: &str) -> bool {
        self.start_blocks
            .lock()
            .is_ok_and(|blocks| blocks.contains_key(session_id))
    }

    pub fn suppress_capture(&self) -> CaptureSuppressionGuard {
        let previous = self.capture_suppressions.fetch_add(1, Ordering::SeqCst);
        log::info!(
            "[voice-echo-guard] capture suppressed suppression_count={}",
            previous + 1
        );
        CaptureSuppressionGuard {
            capture_suppressions: Arc::clone(&self.capture_suppressions),
        }
    }

    fn capture_is_suppressed(&self) -> bool {
        self.capture_suppressions.load(Ordering::SeqCst) > 0
    }

    pub fn microphone_is_muted(&self) -> bool {
        self.microphone_muted.load(Ordering::SeqCst) || self.input_muted.load(Ordering::Acquire)
    }

    pub fn active_session_target(&self) -> Option<(String, String)> {
        let runtime = self.runtime.lock().ok()?;
        Some((
            runtime.session_id.clone()?,
            runtime.owner.as_ref()?.window_label.clone(),
        ))
    }

    pub fn active_session_lifecycle_target(&self) -> Option<(String, String, u64)> {
        let runtime = self.runtime.lock().ok()?;
        Some((
            runtime.session_id.clone()?,
            runtime.owner.as_ref()?.window_label.clone(),
            runtime.revision,
        ))
    }

    pub(crate) fn controls_visibility_target(
        &self,
        session_id: &str,
        expected_revision: u64,
    ) -> Result<Option<ControlsVisibilityTarget>, String> {
        let runtime = self
            .runtime
            .lock()
            .map_err(|_| "native voice state lock was poisoned".to_string())?;
        if runtime.session_id.as_deref() != Some(session_id)
            || runtime.revision != expected_revision
        {
            return Ok(None);
        }
        Ok(Some(ControlsVisibilityTarget {
            suppressed: runtime.controls_suppressed,
            generation: runtime.controls_visibility_generation,
        }))
    }

    pub(crate) fn acknowledge_controls_visibility(
        &self,
        session_id: &str,
        expected_revision: u64,
        applied_generation: u64,
    ) -> Result<ControlsVisibilityAcknowledgement, String> {
        let mut runtime = self
            .runtime
            .lock()
            .map_err(|_| "native voice state lock was poisoned".to_string())?;
        if runtime.session_id.as_deref() != Some(session_id)
            || runtime.revision != expected_revision
        {
            return Ok(ControlsVisibilityAcknowledgement::Inactive);
        }
        runtime.controls_ready = true;
        if runtime.controls_visibility_generation == applied_generation {
            Ok(ControlsVisibilityAcknowledgement::Ready)
        } else {
            Ok(ControlsVisibilityAcknowledgement::Superseded(
                ControlsVisibilityTarget {
                    suppressed: runtime.controls_suppressed,
                    generation: runtime.controls_visibility_generation,
                },
            ))
        }
    }

    pub fn controls_ready_for(&self, session_id: &str, revision: u64) -> bool {
        self.runtime.lock().ok().is_some_and(|runtime| {
            runtime.session_id.as_deref() == Some(session_id)
                && runtime.revision == revision
                && runtime.controls_ready
        })
    }

    pub fn set_controls_suppressed(
        &self,
        caller_window_label: &str,
        session_id: &str,
        expected_revision: u64,
        suppressed: bool,
    ) -> Result<Option<(bool, bool)>, String> {
        let mut runtime = self
            .runtime
            .lock()
            .map_err(|_| "native voice state lock was poisoned".to_string())?;
        if runtime.session_id.as_deref() != Some(session_id)
            || runtime.revision != expected_revision
        {
            return Ok(None);
        }
        if runtime
            .owner
            .as_ref()
            .map(|owner| owner.window_label.as_str())
            != Some(caller_window_label)
        {
            return Err("Only the voice conversation owner can change control visibility.".into());
        }
        let previous_suppression = runtime.controls_suppressed;
        if previous_suppression != suppressed {
            runtime.controls_suppressed = suppressed;
            runtime.controls_visibility_generation =
                runtime.controls_visibility_generation.wrapping_add(1);
        }
        Ok(Some((
            runtime.controls_ready && !suppressed,
            previous_suppression,
        )))
    }

    pub fn rollback_controls_suppression(
        &self,
        session_id: &str,
        expected_revision: u64,
        failed_suppression: bool,
        previous_suppression: bool,
    ) {
        if let Ok(mut runtime) = self.runtime.lock() {
            if runtime.session_id.as_deref() == Some(session_id)
                && runtime.revision == expected_revision
                && runtime.controls_suppressed == failed_suppression
            {
                runtime.controls_suppressed = previous_suppression;
                runtime.controls_visibility_generation =
                    runtime.controls_visibility_generation.wrapping_add(1);
            }
        }
    }

    pub fn is_active_for_session(&self, session_id: &str) -> bool {
        self.runtime
            .lock()
            .ok()
            .and_then(|runtime| runtime.session_id.clone())
            .is_some_and(|active_session_id| active_session_id == session_id)
    }

    fn set_microphone_muted_target(
        &self,
        caller_window_label: &str,
        session_id: &str,
        expected_revision: u64,
        muted: bool,
    ) -> Result<Option<String>, String> {
        let owner_window_label = {
            let runtime = self
                .runtime
                .lock()
                .map_err(|_| "native voice state lock was poisoned".to_string())?;
            if runtime.session_id.as_deref() != Some(session_id)
                || runtime.revision != expected_revision
            {
                return Ok(None);
            }
            let owner_window_label = runtime
                .owner
                .as_ref()
                .map(|owner| owner.window_label.clone())
                .ok_or_else(|| "The native voice conversation has no owning window.".to_string())?;
            if caller_window_label != owner_window_label
                && caller_window_label != super::voice_buddy::WINDOW_LABEL
            {
                return Err(
                    "Only the voice conversation owner or floating controls can mute the microphone."
                        .to_string(),
                );
            }
            let native_microphone_mute_control = runtime.native_microphone_mute_control;
            if native_microphone_mute_control {
                native_input_mute::set_muted(&self.input_muted, &self.input_mute_epoch, muted)?;
            }
            // Native input mute is authoritative when installed so a hardware
            // unmute cannot be masked by a stale renderer fallback latch.
            self.microphone_muted.store(
                software_microphone_mute(native_microphone_mute_control, muted),
                Ordering::SeqCst,
            );
            owner_window_label
        };
        Ok(Some(owner_window_label))
    }

    pub fn set_microphone_muted(
        &self,
        app: &AppHandle,
        caller_window_label: &str,
        session_id: &str,
        expected_revision: u64,
        muted: bool,
    ) -> Result<(), String> {
        let Some(owner_window_label) = self.set_microphone_muted_target(
            caller_window_label,
            session_id,
            expected_revision,
            muted,
        )?
        else {
            return Ok(());
        };
        let event = NativeVoiceEvent::MicrophoneMute {
            session_id: session_id.to_string(),
            muted,
            revision: expected_revision,
        };
        if let Some(window) = app.get_webview_window(&owner_window_label) {
            let _ = window.emit(EVENT_NAME, event.clone());
        }
        super::voice_buddy::emit(app, event);
        Ok(())
    }

    fn assistant_activity_target(
        &self,
        caller_window_label: &str,
        session_id: &str,
        expected_revision: u64,
    ) -> Result<Option<(String, u64)>, String> {
        let runtime = self
            .runtime
            .lock()
            .map_err(|_| "native voice state lock was poisoned".to_string())?;
        if runtime.session_id.as_deref() != Some(session_id)
            || runtime.revision != expected_revision
        {
            return Ok(None);
        }
        let owner_window_label = runtime
            .owner
            .as_ref()
            .map(|owner| owner.window_label.clone())
            .ok_or_else(|| "The native voice conversation has no owning window.".to_string())?;
        if owner_window_label != caller_window_label {
            return Err("Only the voice conversation owner can report assistant activity.".into());
        }
        Ok(Some((owner_window_label, runtime.revision)))
    }

    fn set_assistant_speaking(
        &self,
        app: &AppHandle,
        caller_window_label: &str,
        session_id: &str,
        expected_revision: u64,
        speaking: bool,
    ) -> Result<(), String> {
        let Some((owner_window_label, revision)) =
            self.assistant_activity_target(caller_window_label, session_id, expected_revision)?
        else {
            return Ok(());
        };
        let event = NativeVoiceEvent::Activity {
            session_id: session_id.to_string(),
            activity: if speaking {
                "assistant-speaking"
            } else {
                "assistant-idle"
            },
            revision,
        };
        if let Some(window) = app.get_webview_window(&owner_window_label) {
            let _ = window.emit(EVENT_NAME, event.clone());
        }
        super::voice_buddy::emit(app, event);
        Ok(())
    }

    fn take_stop_snapshot(
        &self,
        expected_lifecycle: Option<(&str, u64)>,
    ) -> Result<Option<StopSnapshot>, String> {
        let mut runtime = self
            .runtime
            .lock()
            .map_err(|_| "native voice state lock was poisoned".to_string())?;
        if expected_lifecycle.is_some_and(|(session_id, revision)| {
            runtime.session_id.as_deref() != Some(session_id) || runtime.revision != revision
        }) {
            return Ok(None);
        }
        if runtime.session_id.is_none() {
            return Ok(None);
        }
        let owner = runtime.owner.clone();
        let session_id = runtime.session_id.clone();
        let owner_id = session_id.as_deref().map(native_owner_id);
        Ok(Some((
            session_id,
            runtime.revision,
            runtime.pipeline.take(),
            owner.zip(owner_id),
        )))
    }

    fn owner_matches_lifecycle(
        &self,
        caller_window_label: &str,
        session_id: &str,
        expected_revision: u64,
    ) -> Result<bool, String> {
        let runtime = self
            .runtime
            .lock()
            .map_err(|_| "native voice state lock was poisoned".to_string())?;
        if runtime.session_id.as_deref() != Some(session_id)
            || runtime.revision != expected_revision
        {
            return Ok(false);
        }
        if runtime
            .owner
            .as_ref()
            .map(|owner| owner.window_label.as_str())
            != Some(caller_window_label)
        {
            return Err("Only the voice conversation owner can stop it.".to_string());
        }
        Ok(true)
    }
}

enum SttMessage {
    Speaking(bool),
    Final {
        text: String,
        delivered: Option<SyncSender<()>>,
    },
    Failed(String),
}

struct SttPipeline {
    audio_tx: SyncSender<AudioBatch>,
    audio_seen: AtomicBool,
    shutdown: Arc<AtomicBool>,
    discard_on_shutdown: Arc<AtomicBool>,
    input_muted: Arc<AtomicBool>,
    input_mute_epoch: Arc<AtomicU64>,
    shutdown_mute_epoch: Arc<AtomicU64>,
    thread: Option<thread::JoinHandle<()>>,
}

struct AudioBatch {
    bytes: Vec<u8>,
    mute_epoch: u64,
}

impl SttPipeline {
    fn new_parakeet(
        model_dir: PathBuf,
        input_muted: Arc<AtomicBool>,
        input_mute_epoch: Arc<AtomicU64>,
    ) -> Result<(Self, tokio_mpsc::Receiver<SttMessage>), String> {
        let (audio_tx, audio_rx) = mpsc::sync_channel(AUDIO_QUEUE_DEPTH);
        let (event_tx, event_rx) = tokio_mpsc::channel(64);
        let shutdown = Arc::new(AtomicBool::new(false));
        let discard_on_shutdown = Arc::new(AtomicBool::new(false));
        let shutdown_mute_epoch = Arc::new(AtomicU64::new(0));
        let worker_shutdown = Arc::clone(&shutdown);
        let worker_discard_on_shutdown = Arc::clone(&discard_on_shutdown);
        let worker_input_muted = Arc::clone(&input_muted);
        let worker_input_mute_epoch = Arc::clone(&input_mute_epoch);
        let worker_shutdown_mute_epoch = Arc::clone(&shutdown_mute_epoch);
        let thread = thread::Builder::new()
            .name("berd-native-stt".into())
            .spawn(move || {
                stt_worker(
                    model_dir,
                    audio_rx,
                    event_tx,
                    worker_shutdown,
                    worker_discard_on_shutdown,
                    worker_input_muted,
                    worker_input_mute_epoch,
                    worker_shutdown_mute_epoch,
                )
            })
            .map_err(|error| format!("start native transcription: {error}"))?;
        Ok((
            Self {
                audio_tx,
                audio_seen: AtomicBool::new(false),
                shutdown,
                discard_on_shutdown,
                input_muted,
                input_mute_epoch,
                shutdown_mute_epoch,
                thread: Some(thread),
            },
            event_rx,
        ))
    }

    fn new_macos(
        input_muted: Arc<AtomicBool>,
        input_mute_epoch: Arc<AtomicU64>,
    ) -> Result<(Self, tokio_mpsc::Receiver<SttMessage>), String> {
        #[cfg(not(target_os = "macos"))]
        {
            let _ = (input_muted, input_mute_epoch);
            Err("macOS speech recognition requires macOS 26 or later.".to_string())
        }
        #[cfg(target_os = "macos")]
        {
            let (audio_tx, audio_rx) = mpsc::sync_channel(AUDIO_QUEUE_DEPTH);
            let (event_tx, event_rx) = tokio_mpsc::channel(64);
            let shutdown = Arc::new(AtomicBool::new(false));
            let discard_on_shutdown = Arc::new(AtomicBool::new(false));
            let shutdown_mute_epoch = Arc::new(AtomicU64::new(0));
            let worker_shutdown = Arc::clone(&shutdown);
            let worker_discard_on_shutdown = Arc::clone(&discard_on_shutdown);
            let worker_input_muted = Arc::clone(&input_muted);
            let worker_input_mute_epoch = Arc::clone(&input_mute_epoch);
            let worker_shutdown_mute_epoch = Arc::clone(&shutdown_mute_epoch);
            let thread = thread::Builder::new()
                .name("berd-macos-stt".into())
                .spawn(move || {
                    macos_stt_worker(
                        audio_rx,
                        event_tx,
                        worker_shutdown,
                        worker_discard_on_shutdown,
                        worker_input_muted,
                        worker_input_mute_epoch,
                        worker_shutdown_mute_epoch,
                    )
                })
                .map_err(|error| format!("start macOS speech recognition: {error}"))?;
            Ok((
                Self {
                    audio_tx,
                    audio_seen: AtomicBool::new(false),
                    shutdown,
                    discard_on_shutdown,
                    input_muted,
                    input_mute_epoch,
                    shutdown_mute_epoch,
                    thread: Some(thread),
                },
                event_rx,
            ))
        }
    }

    fn push(&self, bytes: Vec<u8>) -> Result<(), String> {
        if bytes.len() > MAX_AUDIO_BATCH_BYTES {
            return Err(format!(
                "audio batch is {} bytes; maximum is {MAX_AUDIO_BATCH_BYTES}",
                bytes.len()
            ));
        }
        if !bytes.len().is_multiple_of(4) {
            return Err("audio batch must contain complete f32 samples".to_string());
        }
        if self.input_muted.load(Ordering::Acquire) {
            return Ok(());
        }
        let mute_epoch = self.input_mute_epoch.load(Ordering::Acquire);
        if self.input_muted.load(Ordering::Acquire)
            || mute_epoch != self.input_mute_epoch.load(Ordering::Acquire)
        {
            return Ok(());
        }
        if !self.audio_seen.swap(true, Ordering::AcqRel) {
            log::info!(
                "Native STT received its first audio batch ({} bytes)",
                bytes.len()
            );
        }
        match self.audio_tx.try_send(AudioBatch { bytes, mute_epoch }) {
            Ok(()) => Ok(()),
            Err(TrySendError::Full(_)) => Err(
                "Native voice audio overrun: transcription could not keep up with microphone input."
                    .to_string(),
            ),
            Err(TrySendError::Disconnected(_)) => {
                Err("Native voice transcription is no longer running.".to_string())
            }
        }
    }

    fn begin_shutdown(&mut self) -> Option<thread::JoinHandle<()>> {
        self.signal_shutdown();
        self.thread.take()
    }

    fn signal_shutdown(&self) {
        if self.shutdown.load(Ordering::Acquire) {
            return;
        }
        self.shutdown_mute_epoch.store(
            self.input_mute_epoch.load(Ordering::Acquire),
            Ordering::Release,
        );
        self.latch_muted_shutdown();
        self.shutdown.store(true, Ordering::Release);
    }

    fn latch_muted_shutdown(&self) {
        if self.input_muted.load(Ordering::Acquire) {
            self.discard_on_shutdown.store(true, Ordering::Release);
        }
    }
}

impl Drop for SttPipeline {
    fn drop(&mut self) {
        if let Some(worker) = self.begin_shutdown() {
            let _ = thread::Builder::new()
                .name("berd-native-stt-reaper".into())
                .spawn(move || {
                    let _ = worker.join();
                });
        }
    }
}

#[cfg(not(test))]
const STT_WORKER_SHUTDOWN_TIMEOUT: Duration =
    Duration::from_secs(STT_WORKER_SHUTDOWN_TIMEOUT_SECONDS);
#[cfg(test)]
const STT_WORKER_SHUTDOWN_TIMEOUT: Duration = Duration::from_millis(100);

async fn shutdown_pipeline(mut pipeline: SttPipeline) {
    let worker = pipeline.begin_shutdown();
    drop(pipeline);
    if let Some(worker) = worker {
        let deadline = tokio::time::Instant::now() + STT_WORKER_SHUTDOWN_TIMEOUT;
        while !worker.is_finished() {
            if tokio::time::Instant::now() >= deadline {
                log::error!(
                    "Native voice recognizer did not stop within {:?}; detaching it",
                    STT_WORKER_SHUTDOWN_TIMEOUT
                );
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        if worker.join().is_err() {
            log::error!("Native voice recognizer worker panicked during shutdown");
        }
    }
}

async fn status(app: &AppHandle, state: &NativeVoiceState) -> NativeVoiceStatus {
    let (session_id, owner_window_label, revision) = {
        let runtime = state
            .runtime
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        (
            runtime.session_id.clone(),
            runtime
                .owner
                .as_ref()
                .map(|owner| owner.window_label.clone()),
            runtime.revision,
        )
    };
    let parakeet_available = parakeet_model_dir(app).is_ok();
    #[cfg(target_os = "macos")]
    let macos_available = if needs_macos_status(session_id.is_some(), parakeet_available) {
        mac_speech::status_async()
            .await
            .map(|status| status.model_installed)
            .unwrap_or(false)
    } else {
        false
    };
    #[cfg(not(target_os = "macos"))]
    let macos_available = false;
    let (available, unavailable_reason) =
        if session_id.is_some() || parakeet_available || macos_available {
            (true, None)
        } else {
            (
                false,
                Some("Download speech recognition before starting a call.".to_string()),
            )
        };
    NativeVoiceStatus {
        available,
        unavailable_reason,
        lifecycle: if session_id.is_some() {
            Lifecycle::Running
        } else {
            Lifecycle::Stopped
        },
        session_id,
        owner_window_label,
        microphone_muted: state.microphone_is_muted(),
        revision,
    }
}

#[cfg(target_os = "macos")]
fn needs_macos_status(session_active: bool, parakeet_available: bool) -> bool {
    !session_active && !parakeet_available
}

#[tauri::command]
pub async fn get_native_voice_conversation_status(
    app: AppHandle,
    state: State<'_, NativeVoiceState>,
) -> Result<NativeVoiceStatus, String> {
    Ok(status(&app, &state).await)
}

#[tauri::command]
pub fn block_native_voice_conversation_starts(
    state: State<'_, NativeVoiceState>,
    capture: State<'_, VoiceCaptureState>,
    webview_window: WebviewWindow,
    session_id: String,
    renderer_id: String,
    renderer_epoch: u64,
) -> Result<String, String> {
    let session_id = session_id.trim().to_string();
    if session_id.is_empty() || session_id.len() > 256 {
        return Err("session id must be between 1 and 256 bytes".to_string());
    }
    let window_label = webview_window.label().to_string();
    capture.with_active_renderer(&window_label, &renderer_id, renderer_epoch, || {
        state.block_starts(
            session_id,
            window_label.clone(),
            renderer_id.clone(),
            renderer_epoch,
        )
    })
}

#[tauri::command]
pub fn release_native_voice_conversation_start_block(
    state: State<'_, NativeVoiceState>,
    session_id: String,
    token: String,
) -> Result<(), String> {
    state.release_start_block(&session_id, &token)
}

#[tauri::command]
pub fn drain_native_voice_conversation_transcripts(
    state: State<'_, NativeVoiceState>,
    session_id: String,
) -> Result<Vec<PendingTranscript>, String> {
    Ok(state
        .pending
        .lock()
        .map_err(|_| "native transcript queue lock was poisoned".to_string())?
        .iter()
        .filter(|item| item.session_id == session_id)
        .cloned()
        .collect())
}

#[tauri::command]
pub fn acknowledge_native_voice_conversation_transcript(
    state: State<'_, NativeVoiceState>,
    session_id: String,
    id: String,
    revision: u64,
) -> Result<(), String> {
    state
        .pending
        .lock()
        .map_err(|_| "native transcript queue lock was poisoned".to_string())?
        .retain(|item| {
            !(item.session_id == session_id && item.id == id && item.revision == revision)
        });
    Ok(())
}

#[tauri::command]
pub fn reject_native_voice_conversation_transcript(
    state: State<'_, NativeVoiceState>,
    session_id: String,
    id: String,
    revision: u64,
) -> Result<TranscriptRejection, String> {
    let mut pending = state
        .pending
        .lock()
        .map_err(|_| "native transcript queue lock was poisoned".to_string())?;
    Ok(reject_pending_transcript(
        &mut pending,
        &session_id,
        &id,
        revision,
    ))
}

fn reject_pending_transcript(
    pending: &mut VecDeque<PendingTranscript>,
    session_id: &str,
    id: &str,
    revision: u64,
) -> TranscriptRejection {
    let Some(index) = pending.iter().position(|item| {
        item.session_id == session_id && item.id == id && item.revision == revision
    }) else {
        return TranscriptRejection {
            attempts: MAX_TRANSCRIPT_DELIVERY_ATTEMPTS,
            terminal: true,
        };
    };
    let attempts = pending[index].delivery_attempts.saturating_add(1);
    let terminal = attempts >= MAX_TRANSCRIPT_DELIVERY_ATTEMPTS;
    if terminal {
        pending.remove(index);
    } else {
        pending[index].delivery_attempts = attempts;
    }
    TranscriptRejection { attempts, terminal }
}

#[tauri::command]
#[allow(clippy::too_many_arguments)] // Tauri injects four guards beside the lifecycle claim.
pub async fn start_native_voice_conversation(
    app: AppHandle,
    state: State<'_, NativeVoiceState>,
    capture: State<'_, VoiceCaptureState>,
    window_sessions: State<'_, super::window_session::WindowSessionRegistry>,
    webview_window: WebviewWindow,
    session_id: String,
    input_backend: VoiceInputBackend,
    renderer_id: String,
    renderer_epoch: u64,
    foreground_generation: u64,
) -> Result<NativeVoiceStatus, String> {
    let session_id = session_id.trim().to_string();
    if session_id.is_empty() || session_id.len() > 256 {
        return Err("session id must be between 1 and 256 bytes".to_string());
    }
    if input_backend == VoiceInputBackend::Macos
        && !mac_speech::status_async().await?.model_installed
    {
        return Err(
            "Download the macOS speech recognition model before starting a call.".to_string(),
        );
    }
    let window_label = webview_window.label().to_string();
    let owner_id = native_owner_id(&session_id);
    let lifecycle_guard = state
        .target_lifecycle_guard(|| {
            validate_voice_target_session(
                capture.inner(),
                &window_sessions,
                &webview_window,
                &renderer_id,
                renderer_epoch,
                &session_id,
                Some(foreground_generation),
            )
        })
        .await?;
    let mut microphone_claimed = capture.claim_microphone(
        window_label.clone(),
        renderer_id.clone(),
        renderer_epoch,
        owner_id.clone(),
    )?;
    let pipeline = match input_backend {
        VoiceInputBackend::Parakeet => parakeet_model_dir(&app).and_then(|model_dir| {
            SttPipeline::new_parakeet(
                model_dir,
                Arc::clone(&state.input_muted),
                Arc::clone(&state.input_mute_epoch),
            )
        }),
        VoiceInputBackend::Macos => SttPipeline::new_macos(
            Arc::clone(&state.input_muted),
            Arc::clone(&state.input_mute_epoch),
        ),
    };
    let (pipeline, mut events) = match pipeline {
        Ok(result) => result,
        Err(error) => {
            if microphone_claimed {
                capture.release_microphone(&window_label, &renderer_id, renderer_epoch, &owner_id);
            }
            return Err(error);
        }
    };
    if let Err(error) = validate_voice_target_session(
        capture.inner(),
        &window_sessions,
        &webview_window,
        &renderer_id,
        renderer_epoch,
        &session_id,
        Some(foreground_generation),
    ) {
        drop(lifecycle_guard);
        if microphone_claimed {
            capture.release_microphone(&window_label, &renderer_id, renderer_epoch, &owner_id);
        }
        return Err(error);
    }
    match refresh_microphone_claim(
        capture.inner(),
        &window_label,
        &renderer_id,
        renderer_epoch,
        &owner_id,
        &mut microphone_claimed,
    ) {
        Ok(()) => {}
        Err(error) => {
            drop(lifecycle_guard);
            if microphone_claimed {
                capture.release_microphone(&window_label, &renderer_id, renderer_epoch, &owner_id);
            }
            return Err(error);
        }
    }
    let install_result = (|| -> Result<(u64, String), String> {
        let start_blocks = state
            .start_blocks
            .lock()
            .map_err(|_| "native voice start block lock was poisoned".to_string())?;
        if start_blocks.contains_key(&session_id) {
            return Err("Voice cannot start while this chat is being archived.".to_string());
        }
        let mut runtime = state
            .runtime
            .lock()
            .map_err(|_| "native voice state lock was poisoned".to_string())?;
        if runtime.session_id.is_some() {
            return Err("A native voice conversation is already active.".to_string());
        }
        runtime.revision = runtime.revision.wrapping_add(1);
        runtime.session_id = Some(session_id.clone());
        runtime.lifecycle_id = Some(uuid::Uuid::new_v4().to_string());
        runtime.owner = Some(RuntimeOwner {
            window_label: window_label.clone(),
        });
        runtime.pipeline = Some(pipeline);
        runtime.controls_ready = false;
        // Voice always starts from its owning session, where the in-session
        // controls are already available. The owner renderer reveals the
        // floating controls when that session stops being foreground.
        runtime.controls_suppressed = true;
        runtime.controls_visibility_generation = 0;
        state.microphone_muted.store(false, Ordering::SeqCst);
        let runtime_revision = runtime.revision;
        let mute_app = app.clone();
        let mute_window = webview_window.clone();
        let mute_session_id = session_id.clone();
        runtime.native_microphone_mute_control =
            native_input_mute::start(&state.input_muted, &state.input_mute_epoch, move |muted| {
                let event = NativeVoiceEvent::MicrophoneMute {
                    session_id: mute_session_id.clone(),
                    muted,
                    revision: runtime_revision,
                };
                let _ = mute_window.emit(EVENT_NAME, event.clone());
                super::voice_buddy::emit(&mute_app, event);
            });
        Ok((
            runtime.revision,
            runtime.lifecycle_id.clone().unwrap_or_default(),
        ))
    })();
    let (revision, lifecycle_id) = match install_result {
        Ok(lifecycle) => lifecycle,
        Err(error) => {
            drop(lifecycle_guard);
            if microphone_claimed {
                capture.release_microphone(&window_label, &renderer_id, renderer_epoch, &owner_id);
            }
            return Err(error);
        }
    };
    if app.get_webview_window(&window_label).is_none()
        || state.active_session_lifecycle_target()
            != Some((session_id.clone(), window_label.clone(), revision))
    {
        drop(lifecycle_guard);
        state
            .stop_active_for_lifecycle(&app, capture.inner(), &session_id, revision)
            .await?;
        return Err("The voice conversation owner closed during startup.".to_string());
    }
    if let Err(error) = super::voice_buddy::install(&app) {
        drop(lifecycle_guard);
        state.stop_active(&app, &capture).await?;
        return Err(format!(
            "Could not show the floating voice controls: {error}"
        ));
    }
    if app.get_webview_window(&window_label).is_none()
        || state.active_session_lifecycle_target()
            != Some((session_id.clone(), window_label.clone(), revision))
    {
        drop(lifecycle_guard);
        state
            .stop_active_for_lifecycle(&app, capture.inner(), &session_id, revision)
            .await?;
        return Err("The voice conversation owner closed during startup.".to_string());
    }
    drop(lifecycle_guard);
    let _ = webview_window.emit(
        EVENT_NAME,
        NativeVoiceEvent::Startup {
            session_id: session_id.clone(),
            owner_window_label: window_label.clone(),
            line: "Native voice conversation is on".to_string(),
            revision,
        },
    );
    super::voice_buddy::emit(
        &app,
        NativeVoiceEvent::Startup {
            session_id: session_id.clone(),
            owner_window_label: window_label.clone(),
            line: "Native voice conversation is on".to_string(),
            revision,
        },
    );

    let event_app = app.clone();
    let event_window = webview_window.clone();
    let runtime = Arc::clone(&state.runtime);
    let pending = Arc::clone(&state.pending);
    let event_state = state.inner().clone();
    let input_muted = Arc::clone(&state.input_muted);
    tauri::async_runtime::spawn(async move {
        while let Some(event) = events.recv().await {
            let active = runtime.lock().ok().is_some_and(|current| {
                current.session_id.as_deref() == Some(session_id.as_str())
                    && current.revision == revision
            });
            if !active {
                break;
            }
            match event {
                SttMessage::Speaking(speaking) => {
                    let event = NativeVoiceEvent::Activity {
                        session_id: session_id.clone(),
                        activity: if speaking {
                            "user-speaking"
                        } else {
                            "user-idle"
                        },
                        revision,
                    };
                    let _ = event_window.emit(EVENT_NAME, event.clone());
                    super::voice_buddy::emit(&event_app, event);
                }
                SttMessage::Final { text, delivered } => {
                    let transcript = PendingTranscript {
                        session_id: session_id.clone(),
                        lifecycle_id: lifecycle_id.clone(),
                        id: uuid::Uuid::new_v4().to_string(),
                        text,
                        revision,
                        delivery_attempts: 0,
                    };
                    let Ok((accepted, evicted)) = enqueue_transcript_if_active(
                        &runtime,
                        &pending,
                        &session_id,
                        revision,
                        transcript.clone(),
                    ) else {
                        break;
                    };
                    if !accepted {
                        if let Some(delivered) = delivered {
                            let _ = delivered.send(());
                        }
                        break;
                    }
                    if evicted.is_some() {
                        let _ = event_window.emit(
                            EVENT_NAME,
                            NativeVoiceEvent::Error {
                                session_id: Some(session_id.clone()),
                                message: "Voice transcript recovery queue was full; the oldest retained transcript was discarded.".to_string(),
                                revision,
                                terminal: false,
                            },
                        );
                    }
                    let _ = event_window.emit(
                        EVENT_NAME,
                        NativeVoiceEvent::User {
                            session_id: transcript.session_id,
                            lifecycle_id: transcript.lifecycle_id,
                            id: transcript.id,
                            text: transcript.text,
                            revision,
                            delivery_attempts: transcript.delivery_attempts,
                        },
                    );
                    if let Some(delivered) = delivered {
                        let _ = delivered.send(());
                    }
                }
                SttMessage::Failed(message) => {
                    let _stop_guard = event_state.stop_serial.lock().await;
                    let pipeline = {
                        let Ok(mut current) = runtime.lock() else {
                            break;
                        };
                        if current.session_id.as_deref() != Some(session_id.as_str())
                            || current.revision != revision
                        {
                            break;
                        }
                        native_input_mute::stop(&input_muted);
                        current.native_microphone_mute_control = false;
                        current.session_id = None;
                        current.lifecycle_id = None;
                        current.owner = None;
                        current.revision = current.revision.wrapping_add(1);
                        current.pipeline.take()
                    };
                    if let Some(pipeline) = pipeline {
                        shutdown_pipeline(pipeline).await;
                    }
                    event_state.microphone_muted.store(false, Ordering::SeqCst);
                    event_app
                        .state::<VoiceCaptureState>()
                        .release_owner(&window_label, &owner_id);
                    let terminal_event = NativeVoiceEvent::Error {
                        session_id: Some(session_id.clone()),
                        message,
                        revision: revision.wrapping_add(1),
                        terminal: true,
                    };
                    let _ = event_window.emit(EVENT_NAME, terminal_event.clone());
                    super::voice_buddy::emit(&event_app, terminal_event);
                    let shutdown_event = NativeVoiceEvent::CleanShutdown {
                        session_id: session_id.clone(),
                        revision: revision.wrapping_add(1),
                    };
                    let _ = event_window.emit(EVENT_NAME, shutdown_event.clone());
                    super::voice_buddy::dismiss_after_terminal_event(
                        &event_app,
                        revision,
                        shutdown_event,
                    );
                    super::voice_buddy::restore_hidden_owner(&event_app, &window_label);
                    break;
                }
            }
        }
    });
    Ok(status(&app, &state).await)
}

#[tauri::command]
pub async fn set_native_voice_microphone_muted(
    app: AppHandle,
    state: State<'_, NativeVoiceState>,
    capture: State<'_, VoiceCaptureState>,
    webview_window: WebviewWindow,
    request: MicrophoneMuteRequest,
) -> Result<NativeVoiceStatus, String> {
    let apply = || {
        state.set_microphone_muted(
            &app,
            webview_window.label(),
            &request.session_id,
            request.expected_revision,
            request.muted,
        )
    };
    if webview_window.label() == super::voice_buddy::WINDOW_LABEL {
        apply()?;
    } else {
        capture.with_active_renderer(
            webview_window.label(),
            &request.renderer_id,
            request.renderer_epoch,
            apply,
        )?;
    }
    Ok(status(&app, &state).await)
}

#[tauri::command]
pub fn set_native_voice_assistant_speaking(
    app: AppHandle,
    state: State<'_, NativeVoiceState>,
    capture: State<'_, VoiceCaptureState>,
    webview_window: WebviewWindow,
    request: AssistantSpeakingRequest,
) -> Result<(), String> {
    capture.with_active_renderer(
        webview_window.label(),
        &request.renderer_id,
        request.renderer_epoch,
        || {
            state.set_assistant_speaking(
                &app,
                webview_window.label(),
                &request.session_id,
                request.expected_revision,
                request.speaking,
            )
        },
    )
}

#[tauri::command]
#[allow(clippy::too_many_arguments)] // Tauri injects four guards beside the exact lifecycle payload.
pub async fn stop_native_voice_conversation(
    app: AppHandle,
    state: State<'_, NativeVoiceState>,
    capture: State<'_, VoiceCaptureState>,
    webview_window: WebviewWindow,
    renderer_id: String,
    renderer_epoch: u64,
    session_id: String,
    expected_revision: u64,
) -> Result<NativeVoiceStatus, String> {
    capture.activate_renderer(webview_window.label(), &renderer_id, renderer_epoch)?;
    if state.owner_matches_lifecycle(webview_window.label(), &session_id, expected_revision)? {
        state
            .stop_active_for_lifecycle(&app, &capture, &session_id, expected_revision)
            .await?;
    }
    Ok(status(&app, &state).await)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)] // Tauri injects four guards beside the exact lifecycle payload.
pub async fn stop_native_voice_conversation_for_replacement(
    app: AppHandle,
    state: State<'_, NativeVoiceState>,
    capture: State<'_, VoiceCaptureState>,
    window_sessions: State<'_, super::window_session::WindowSessionRegistry>,
    webview_window: WebviewWindow,
    renderer_id: String,
    renderer_epoch: u64,
    session_id: String,
    expected_revision: u64,
    target_session_id: String,
) -> Result<NativeVoiceStatus, String> {
    let target_session_id = target_session_id.trim();
    if target_session_id.is_empty() || target_session_id.len() > 256 {
        return Err("target session id must be between 1 and 256 bytes".to_string());
    }
    validate_voice_target_session(
        capture.inner(),
        &window_sessions,
        &webview_window,
        &renderer_id,
        renderer_epoch,
        target_session_id,
        None,
    )?;
    let _stop_guard = state
        .target_lifecycle_guard(|| {
            validate_voice_target_session(
                capture.inner(),
                &window_sessions,
                &webview_window,
                &renderer_id,
                renderer_epoch,
                target_session_id,
                None,
            )
        })
        .await?;
    state
        .stop_active_inner_locked(&app, &capture, Some((&session_id, expected_revision, None)))
        .await?;
    Ok(status(&app, &state).await)
}

fn replacement_caller_matches_target(
    caller_window_label: &str,
    target_owner: Option<&str>,
    owns_foreground_session: bool,
) -> bool {
    if !owns_foreground_session {
        return false;
    }
    match target_owner {
        Some(owner_window_label) => owner_window_label == caller_window_label,
        None => caller_window_label == "main",
    }
}

fn voice_target_window_focus_is_valid(
    window_label: &str,
    focused: bool,
    app_is_active: bool,
    main_surface_is_available: bool,
    another_window_is_focused: bool,
) -> bool {
    focused
        || (window_label == "main"
            && app_is_active
            && main_surface_is_available
            && !another_window_is_focused)
}

fn voice_main_surface_is_available(visible: bool, minimized: bool) -> bool {
    visible && !minimized
}

#[cfg(target_os = "macos")]
fn app_is_active_for_main_window_focus_fallback() -> bool {
    use objc2_app_kit::NSRunningApplication;

    // The non-activating floating controls can leave Berd frontmost while
    // AppKit reports that none of its ordinary windows are focused.
    NSRunningApplication::currentApplication().isActive()
}

#[cfg(not(target_os = "macos"))]
fn app_is_active_for_main_window_focus_fallback() -> bool {
    false
}

fn another_user_window_is_focused(webview_window: &WebviewWindow) -> Result<bool, String> {
    for (label, window) in webview_window.app_handle().webview_windows() {
        if label == webview_window.label() || label == voice_buddy::WINDOW_LABEL {
            continue;
        }
        if window
            .is_focused()
            .map_err(|error| format!("Could not confirm Berd window focus: {error}"))?
        {
            return Ok(true);
        }
    }
    Ok(false)
}

fn validate_voice_target_session(
    capture: &VoiceCaptureState,
    window_sessions: &super::window_session::WindowSessionRegistry,
    webview_window: &WebviewWindow,
    renderer_id: &str,
    renderer_epoch: u64,
    target_session_id: &str,
    foreground_generation: Option<u64>,
) -> Result<(), String> {
    let target_owner = window_sessions.label_for(target_session_id);
    let owns_foreground_session = capture.foreground_session_matches_generation(
        webview_window.label(),
        renderer_id,
        renderer_epoch,
        target_session_id,
        foreground_generation,
    )?;
    if !replacement_caller_matches_target(
        webview_window.label(),
        target_owner.as_deref(),
        owns_foreground_session,
    ) {
        return Err("The target session is no longer in the foreground.".to_string());
    }
    let focused = webview_window
        .is_focused()
        .map_err(|error| format!("Could not confirm the target session window focus: {error}"))?;
    let app_is_active = !focused
        && webview_window.label() == "main"
        && app_is_active_for_main_window_focus_fallback();
    let main_surface_is_available = if app_is_active {
        let visible = webview_window
            .is_visible()
            .map_err(|error| format!("Could not confirm the main window visibility: {error}"))?;
        let minimized = webview_window
            .is_minimized()
            .map_err(|error| format!("Could not confirm the main window state: {error}"))?;
        voice_main_surface_is_available(visible, minimized)
    } else {
        false
    };
    let another_window_is_focused =
        main_surface_is_available && another_user_window_is_focused(webview_window)?;
    if !voice_target_window_focus_is_valid(
        webview_window.label(),
        focused,
        app_is_active,
        main_surface_is_available,
        another_window_is_focused,
    ) {
        return Err("The target session window is no longer focused.".to_string());
    }
    Ok(())
}

fn native_owner_id(session_id: &str) -> String {
    format!("native-voice:{session_id}")
}

fn refresh_microphone_claim(
    capture: &VoiceCaptureState,
    window_label: &str,
    renderer_id: &str,
    renderer_epoch: u64,
    owner_id: &str,
    microphone_claimed: &mut bool,
) -> Result<(), String> {
    let claimed_after_wait = capture.claim_microphone(
        window_label.to_string(),
        renderer_id.to_string(),
        renderer_epoch,
        owner_id.to_string(),
    )?;
    *microphone_claimed |= claimed_after_wait;
    Ok(())
}

impl NativeVoiceState {
    async fn target_lifecycle_guard<F>(
        &self,
        validate_target: F,
    ) -> Result<tokio::sync::MutexGuard<'_, ()>, String>
    where
        F: FnOnce() -> Result<(), String>,
    {
        let guard = self.stop_serial.lock().await;
        validate_target()?;
        Ok(guard)
    }

    pub async fn stop_active(
        &self,
        app: &AppHandle,
        capture: &VoiceCaptureState,
    ) -> Result<(), String> {
        self.stop_active_inner(app, capture, None).await.map(|_| ())
    }

    pub async fn stop_active_for_lifecycle(
        &self,
        app: &AppHandle,
        capture: &VoiceCaptureState,
        expected_session_id: &str,
        expected_revision: u64,
    ) -> Result<bool, String> {
        self.stop_active_inner(
            app,
            capture,
            Some((expected_session_id, expected_revision, None)),
        )
        .await
    }

    pub async fn stop_active_if_lifecycle(
        &self,
        app: &AppHandle,
        capture: &VoiceCaptureState,
        expected_session_id: &str,
        expected_revision: u64,
        failure_message: &str,
    ) -> Result<bool, String> {
        self.stop_active_inner(
            app,
            capture,
            Some((
                expected_session_id,
                expected_revision,
                Some(failure_message),
            )),
        )
        .await
    }

    async fn stop_active_inner(
        &self,
        app: &AppHandle,
        capture: &VoiceCaptureState,
        expected_lifecycle: Option<(&str, u64, Option<&str>)>,
    ) -> Result<bool, String> {
        let _stop_guard = self.stop_serial.lock().await;
        self.stop_active_inner_locked(app, capture, expected_lifecycle)
            .await
    }

    async fn stop_active_inner_locked(
        &self,
        app: &AppHandle,
        capture: &VoiceCaptureState,
        expected_lifecycle: Option<(&str, u64, Option<&str>)>,
    ) -> Result<bool, String> {
        let failure_message = expected_lifecycle.and_then(|(_, _, message)| message);
        let completion = self
            .stop_lifecycle_locked(
                expected_lifecycle.map(|(session_id, revision, _)| (session_id, revision)),
            )
            .await?;
        let Some(StopCompletion {
            session_id,
            controls_revision,
            next_revision,
            owner,
            owner_id,
        }) = completion
        else {
            return Ok(false);
        };
        if let Some(failure_message) = failure_message {
            let failure_event = NativeVoiceEvent::Error {
                session_id: Some(session_id.clone()),
                message: failure_message.to_string(),
                revision: next_revision,
                terminal: true,
            };
            if let Some(target) = app.get_webview_window(&owner.window_label) {
                let _ = target.emit(EVENT_NAME, failure_event.clone());
            }
            super::voice_buddy::emit(app, failure_event);
        }
        self.microphone_muted.store(false, Ordering::SeqCst);
        capture.release_owner(&owner.window_label, &owner_id);
        let shutdown_event = NativeVoiceEvent::CleanShutdown {
            session_id,
            revision: next_revision,
        };
        if let Some(target) = app.get_webview_window(&owner.window_label) {
            let _ = target.emit(EVENT_NAME, shutdown_event.clone());
        }
        super::voice_buddy::dismiss_after_terminal_event(app, controls_revision, shutdown_event);
        super::voice_buddy::restore_hidden_owner(app, &owner.window_label);
        Ok(true)
    }

    #[cfg(test)]
    async fn stop_lifecycle(
        &self,
        expected_lifecycle: Option<(&str, u64)>,
    ) -> Result<Option<StopCompletion>, String> {
        let _stop_guard = self.stop_serial.lock().await;
        self.stop_lifecycle_locked(expected_lifecycle).await
    }

    async fn stop_lifecycle_locked(
        &self,
        expected_lifecycle: Option<(&str, u64)>,
    ) -> Result<Option<StopCompletion>, String> {
        let Some((session_id, revision, pipeline, owner)) =
            self.take_stop_snapshot(expected_lifecycle)?
        else {
            return Ok(None);
        };
        // Keep the lifecycle current through the bounded shutdown window so a
        // cooperative worker can flush its final utterance durably. A worker
        // that misses the deadline is detached; its revision-bound late events
        // are discarded rather than leaking into a replacement lifecycle.
        if let Some(pipeline) = pipeline {
            shutdown_pipeline(pipeline).await;
        }
        let (stopped, next_revision) = {
            let mut runtime = self
                .runtime
                .lock()
                .map_err(|_| "native voice state lock was poisoned".to_string())?;
            let stopped = runtime.revision == revision && runtime.session_id == session_id;
            if stopped {
                native_input_mute::stop(&self.input_muted);
                runtime.native_microphone_mute_control = false;
                runtime.session_id = None;
                runtime.lifecycle_id = None;
                runtime.owner = None;
                runtime.revision = runtime.revision.wrapping_add(1);
            }
            (stopped, runtime.revision)
        };
        if !stopped {
            return Ok(None);
        }
        let (Some(session_id), Some((owner, owner_id))) = (session_id, owner) else {
            return Ok(None);
        };
        Ok(Some(StopCompletion {
            session_id,
            controls_revision: revision,
            next_revision,
            owner,
            owner_id,
        }))
    }

    pub async fn stop_for_model_removal(
        &self,
        app: &AppHandle,
        capture: &VoiceCaptureState,
    ) -> Result<(), String> {
        let _stop_guard = self.stop_serial.lock().await;
        let (session_id, revision, pipeline, owner) = {
            let mut runtime = self
                .runtime
                .lock()
                .map_err(|_| "native voice state lock was poisoned".to_string())?;
            (
                runtime.session_id.clone(),
                runtime.revision,
                runtime.pipeline.take(),
                runtime.owner.clone(),
            )
        };
        if let Some(pipeline) = pipeline {
            shutdown_pipeline(pipeline).await;
        }
        let next_revision = {
            let mut runtime = self
                .runtime
                .lock()
                .map_err(|_| "native voice state lock was poisoned".to_string())?;
            if runtime.revision == revision && runtime.session_id == session_id {
                native_input_mute::stop(&self.input_muted);
                runtime.native_microphone_mute_control = false;
                runtime.session_id = None;
                runtime.lifecycle_id = None;
                runtime.owner = None;
                runtime.revision = runtime.revision.wrapping_add(1);
            }
            runtime.revision
        };
        self.microphone_muted.store(false, Ordering::SeqCst);
        if let (Some(owner), Some(session_id)) = (owner, session_id) {
            capture.release_owner(&owner.window_label, &native_owner_id(&session_id));
            let shutdown_event = NativeVoiceEvent::CleanShutdown {
                session_id,
                revision: next_revision,
            };
            if let Some(window) = app.get_webview_window(&owner.window_label) {
                let _ = window.emit(EVENT_NAME, shutdown_event.clone());
            }
            super::voice_buddy::dismiss_after_terminal_event(app, revision, shutdown_event);
            super::voice_buddy::restore_hidden_owner(app, &owner.window_label);
        } else {
            super::voice_buddy::dismiss_stale_after_terminal(app, next_revision);
        }
        Ok(())
    }

    pub fn capture_destroyed_owner_lifecycle(&self, window_label: &str) -> Option<(String, u64)> {
        self.release_start_blocks_for_window(window_label);
        let runtime = self.runtime.lock().ok()?;
        if runtime
            .owner
            .as_ref()
            .is_none_or(|owner| owner.window_label != window_label)
        {
            return None;
        }
        runtime
            .session_id
            .clone()
            .map(|session_id| (session_id, runtime.revision))
    }

    #[cfg(test)]
    async fn stop_destroyed_owner_lifecycle(
        &self,
        window_label: &str,
        expected_session_id: &str,
        expected_revision: u64,
    ) -> Result<Option<StopCompletion>, String> {
        self.stop_destroyed_owner_lifecycle_with_cleanup(
            window_label,
            expected_session_id,
            expected_revision,
            |_| {},
        )
        .await
    }

    async fn stop_destroyed_owner_lifecycle_with_cleanup(
        &self,
        window_label: &str,
        expected_session_id: &str,
        expected_revision: u64,
        cleanup: impl FnOnce(&StopCompletion),
    ) -> Result<Option<StopCompletion>, String> {
        let _stop_guard = self.stop_serial.lock().await;
        let completion = self
            .stop_destroyed_owner_lifecycle_locked(
                window_label,
                expected_session_id,
                expected_revision,
            )
            .await?;
        if let Some(completion) = completion.as_ref() {
            cleanup(completion);
        }
        Ok(completion)
    }

    async fn stop_destroyed_owner_lifecycle_locked(
        &self,
        window_label: &str,
        expected_session_id: &str,
        expected_revision: u64,
    ) -> Result<Option<StopCompletion>, String> {
        let owner_matches = {
            let runtime = self
                .runtime
                .lock()
                .map_err(|_| "native voice state lock was poisoned".to_string())?;
            runtime
                .owner
                .as_ref()
                .is_some_and(|owner| owner.window_label == window_label)
        };
        if !owner_matches {
            return Ok(None);
        }
        let completion = self
            .stop_lifecycle_locked(Some((expected_session_id, expected_revision)))
            .await?;
        if completion.is_some() {
            self.microphone_muted.store(false, Ordering::SeqCst);
        }
        Ok(completion)
    }

    pub async fn stop_for_window_destroyed(
        &self,
        app: &AppHandle,
        capture: &VoiceCaptureState,
        pocket_voice: &super::pocket_voice::PocketVoiceState,
        window_label: &str,
        expected_session_id: &str,
        expected_revision: u64,
    ) -> Result<bool, String> {
        let Some(completion) = self
            .stop_destroyed_owner_lifecycle_with_cleanup(
                window_label,
                expected_session_id,
                expected_revision,
                |completion| {
                    capture.release_owner(&completion.owner.window_label, &completion.owner_id);
                    pocket_voice.stop_for_window_destroyed();
                },
            )
            .await?
        else {
            return Ok(false);
        };
        super::voice_buddy::dismiss_after_terminal_event(
            app,
            completion.controls_revision,
            NativeVoiceEvent::CleanShutdown {
                session_id: completion.session_id,
                revision: completion.next_revision,
            },
        );
        Ok(true)
    }

    pub fn stop_for_app_exit(&self) {
        let (session_id, revision, pipeline) = {
            let Ok(mut runtime) = self.runtime.lock() else {
                return;
            };
            if let Some(pipeline) = runtime.pipeline.as_ref() {
                pipeline.latch_muted_shutdown();
            }
            native_input_mute::stop(&self.input_muted);
            runtime.native_microphone_mute_control = false;
            (
                runtime.session_id.clone(),
                runtime.revision,
                runtime.pipeline.take(),
            )
        };
        drop(pipeline);
        self.microphone_muted.store(false, Ordering::SeqCst);
        if let Ok(mut runtime) = self.runtime.lock() {
            if runtime.revision == revision && runtime.session_id == session_id {
                runtime.session_id = None;
                runtime.lifecycle_id = None;
                runtime.owner = None;
                runtime.revision = runtime.revision.wrapping_add(1);
            }
        }
    }
}

pub fn handle_voice_owner_window_destroyed(app: &AppHandle, window_label: &str) {
    app.state::<VoiceCaptureState>()
        .release_window(window_label);
    let destroyed_lifecycle = app
        .state::<NativeVoiceState>()
        .capture_destroyed_owner_lifecycle(window_label);
    let app_for_native_close = app.clone();
    let label_for_native_close = window_label.to_string();
    if let Some((session_id, revision)) = destroyed_lifecycle {
        tauri::async_runtime::spawn(async move {
            let native_voice = app_for_native_close.state::<NativeVoiceState>();
            let capture = app_for_native_close.state::<VoiceCaptureState>();
            let pocket_voice =
                app_for_native_close.state::<super::pocket_voice::PocketVoiceState>();
            match native_voice
                .stop_for_window_destroyed(
                    &app_for_native_close,
                    capture.inner(),
                    pocket_voice.inner(),
                    &label_for_native_close,
                    &session_id,
                    revision,
                )
                .await
            {
                Ok(true) => {}
                Ok(false) => {}
                Err(error) => {
                    log::error!("Failed to stop voice for destroyed owner window: {error}");
                }
            }
        });
    }
    app.state::<super::siri_voice::SiriVoiceState>()
        .stop_for_window_destroyed(window_label);
}

fn software_microphone_mute(native_microphone_mute_control: bool, muted: bool) -> bool {
    !native_microphone_mute_control && muted
}

#[tauri::command]
pub fn push_native_voice_audio(
    request: tauri::ipc::Request<'_>,
    state: State<'_, NativeVoiceState>,
    webview_window: WebviewWindow,
) -> Result<(), String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("native voice audio requires a raw binary body".to_string());
    };
    push_audio_for_window(&state, webview_window.label(), bytes.to_vec())
}

fn push_audio_for_window(
    state: &NativeVoiceState,
    window_label: &str,
    bytes: Vec<u8>,
) -> Result<(), String> {
    let runtime = state
        .runtime
        .lock()
        .map_err(|_| "native voice state lock was poisoned".to_string())?;
    if runtime
        .owner
        .as_ref()
        .is_none_or(|owner| owner.window_label != window_label)
    {
        return Err("Only the owning window may send native voice audio.".to_string());
    }
    if state.capture_is_suppressed() || state.microphone_is_muted() {
        return Ok(());
    }
    if let Some(pipeline) = runtime.pipeline.as_ref() {
        pipeline.push(bytes)?;
    }
    Ok(())
}

fn enqueue_pending_transcript(
    queue: &mut VecDeque<PendingTranscript>,
    transcript: PendingTranscript,
) -> Option<PendingTranscript> {
    let evicted = (queue.len() >= MAX_PENDING_TRANSCRIPTS)
        .then(|| queue.pop_front())
        .flatten();
    queue.push_back(transcript);
    evicted
}

fn enqueue_transcript_if_active(
    runtime: &Mutex<Runtime>,
    pending: &Mutex<VecDeque<PendingTranscript>>,
    expected_session_id: &str,
    expected_revision: u64,
    transcript: PendingTranscript,
) -> Result<(bool, Option<PendingTranscript>), String> {
    let runtime = runtime
        .lock()
        .map_err(|_| "native voice state lock was poisoned".to_string())?;
    if runtime.session_id.as_deref() != Some(expected_session_id)
        || runtime.revision != expected_revision
    {
        return Ok((false, None));
    }
    let mut pending = pending
        .lock()
        .map_err(|_| "pending transcript lock was poisoned".to_string())?;
    let evicted = enqueue_pending_transcript(&mut pending, transcript);
    Ok((true, evicted))
}

#[cfg(target_os = "macos")]
fn forward_macos_events(
    events: &mut tokio_mpsc::UnboundedReceiver<mac_speech::RecognitionEvent>,
    output: &tokio_mpsc::Sender<SttMessage>,
    delivery_deadline: Option<Instant>,
) -> Result<(), ()> {
    while let Ok(event) = events.try_recv() {
        match event {
            mac_speech::RecognitionEvent::Final(text) => {
                let text = text.trim().to_string();
                if text.is_empty() {
                    continue;
                }
                let delivered = delivery_deadline.map(|_| {
                    let (sender, receiver) = mpsc::sync_channel(0);
                    (sender, receiver)
                });
                let sender = delivered.as_ref().map(|(sender, _)| sender.clone());
                if output
                    .blocking_send(SttMessage::Final {
                        text,
                        delivered: sender,
                    })
                    .is_err()
                {
                    return Err(());
                }
                if let (Some(deadline), Some((_, receiver))) = (delivery_deadline, delivered) {
                    let remaining = deadline.saturating_duration_since(Instant::now());
                    if !remaining.is_zero() {
                        let _ = receiver.recv_timeout(remaining);
                    }
                }
            }
            mac_speech::RecognitionEvent::Finished => {
                if delivery_deadline.is_none() {
                    let _ = output.blocking_send(SttMessage::Failed(
                        "macOS speech recognition stopped unexpectedly.".to_string(),
                    ));
                    return Err(());
                }
            }
            mac_speech::RecognitionEvent::Failed(message) => {
                if delivery_deadline.is_none() {
                    let _ = output.blocking_send(SttMessage::Failed(message));
                } else {
                    log::error!("macOS speech recognition failed while finishing: {message}");
                }
                return Err(());
            }
        }
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn new_macos_recognition_session() -> Result<
    (
        mac_speech::RecognitionSession,
        tokio_mpsc::UnboundedReceiver<mac_speech::RecognitionEvent>,
    ),
    String,
> {
    let (events_tx, events_rx) = tokio_mpsc::unbounded_channel();
    mac_speech::RecognitionSession::new(events_tx).map(|session| (session, events_rx))
}

#[cfg(target_os = "macos")]
#[allow(clippy::too_many_arguments)]
fn macos_stt_worker(
    audio_rx: Receiver<AudioBatch>,
    event_tx: tokio_mpsc::Sender<SttMessage>,
    shutdown: Arc<AtomicBool>,
    discard_on_shutdown: Arc<AtomicBool>,
    input_muted: Arc<AtomicBool>,
    input_mute_epoch: Arc<AtomicU64>,
    shutdown_mute_epoch: Arc<AtomicU64>,
) {
    use rubato::{Fft, FixedSync, Resampler};

    let (mut session, mut recognition_events) = match new_macos_recognition_session() {
        Ok(session) => session,
        Err(error) => {
            let _ = event_tx.blocking_send(SttMessage::Failed(error));
            return;
        }
    };
    let mut resampler = match Fft::<f32>::new(48_000, 16_000, 1024, 2, 1, FixedSync::Input) {
        Ok(resampler) => resampler,
        Err(error) => {
            let _ = event_tx.blocking_send(SttMessage::Failed(format!(
                "Could not initialize native audio resampling: {error}"
            )));
            return;
        }
    };
    let chunk_in = resampler.input_frames_next();
    let mut vad = earshot::Detector::new(earshot::DefaultPredictor::new());
    let mut input_48k = Vec::new();
    let mut leftover_16k = Vec::new();
    let mut silence_frames = 0_usize;
    let mut in_speech = false;
    let mut observed_mute_epoch = input_mute_epoch.load(Ordering::Acquire);

    loop {
        if forward_macos_events(&mut recognition_events, &event_tx, None).is_err() {
            return;
        }
        let batch = match audio_rx.recv_timeout(Duration::from_millis(50)) {
            Ok(batch) => Some(batch),
            Err(mpsc::RecvTimeoutError::Timeout) => None,
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        };
        let (shutting_down, current_mute_epoch) =
            sample_effective_mute_epoch(&input_mute_epoch, &shutdown, &shutdown_mute_epoch);
        if current_mute_epoch != observed_mute_epoch {
            observed_mute_epoch = current_mute_epoch;
            input_48k.clear();
            leftover_16k.clear();
            silence_frames = 0;
            if std::mem::take(&mut in_speech) {
                let _ = event_tx.blocking_send(SttMessage::Speaking(false));
            }
            // A mute boundary must discard Apple's partial hypothesis just as
            // the Parakeet worker discards its buffered utterance.
            session.cancel();
            if shutting_down {
                break;
            }
            match new_macos_recognition_session() {
                Ok((next_session, next_events)) => {
                    session = next_session;
                    recognition_events = next_events;
                }
                Err(error) => {
                    let _ = event_tx.blocking_send(SttMessage::Failed(error));
                    return;
                }
            }
        }
        if shutting_down && (discard_on_shutdown.load(Ordering::Acquire) || batch.is_none()) {
            break;
        }
        if !shutting_down && input_muted.load(Ordering::Acquire) {
            continue;
        }
        let Some(batch) = batch else {
            continue;
        };
        if batch.mute_epoch != observed_mute_epoch {
            continue;
        }

        let samples: Vec<f32> = batch
            .bytes
            .chunks_exact(4)
            .map(|sample| f32::from_le_bytes([sample[0], sample[1], sample[2], sample[3]]))
            .collect();
        // Feed Apple continuously. Earshot below controls activity only and
        // never holds audio until its silence boundary.
        if let Err(error) = session.push(&samples) {
            let _ = event_tx.blocking_send(SttMessage::Failed(error));
            return;
        }

        input_48k.extend_from_slice(&samples);
        while input_48k.len() >= chunk_in {
            let chunk: Vec<f32> = input_48k.drain(..chunk_in).collect();
            leftover_16k.extend_from_slice(&resample(&mut resampler, &chunk));
            while leftover_16k.len() >= VAD_FRAME_SAMPLES {
                let frame: Vec<f32> = leftover_16k.drain(..VAD_FRAME_SAMPLES).collect();
                let clamped: Vec<f32> =
                    frame.iter().map(|sample| sample.clamp(-1.0, 1.0)).collect();
                if vad.predict_f32(&clamped) > VAD_THRESHOLD {
                    silence_frames = 0;
                    if !in_speech {
                        in_speech = true;
                        let _ = event_tx.blocking_send(SttMessage::Speaking(true));
                    }
                } else if in_speech {
                    silence_frames += 1;
                    if silence_frames >= SILENCE_FLUSH_FRAMES {
                        silence_frames = 0;
                        in_speech = false;
                        let _ = event_tx.blocking_send(SttMessage::Speaking(false));
                    }
                }
            }
        }
        if forward_macos_events(&mut recognition_events, &event_tx, None).is_err() {
            return;
        }
    }

    if in_speech {
        let _ = event_tx.blocking_send(SttMessage::Speaking(false));
    }
    if discard_on_shutdown.load(Ordering::Acquire) {
        session.cancel();
        return;
    }
    if let Err(error) = session.finish() {
        log::error!("Could not finish macOS speech recognition: {error}");
        return;
    }
    let delivery_deadline = Instant::now() + FINAL_TRANSCRIPT_DELIVERY_TIMEOUT;
    let _ = forward_macos_events(&mut recognition_events, &event_tx, Some(delivery_deadline));
}

#[allow(clippy::too_many_arguments)] // Worker boundary keeps channel and mute lifecycle inputs explicit.
fn stt_worker(
    model_dir: PathBuf,
    audio_rx: Receiver<AudioBatch>,
    event_tx: tokio_mpsc::Sender<SttMessage>,
    shutdown: Arc<AtomicBool>,
    discard_on_shutdown: Arc<AtomicBool>,
    input_muted: Arc<AtomicBool>,
    input_mute_epoch: Arc<AtomicU64>,
    shutdown_mute_epoch: Arc<AtomicU64>,
) {
    use rubato::{Fft, FixedSync, Resampler};
    use sherpa_onnx::{OfflineRecognizer, OfflineRecognizerConfig};

    let mut resampler = match Fft::<f32>::new(48_000, 16_000, 1024, 2, 1, FixedSync::Input) {
        Ok(resampler) => resampler,
        Err(error) => {
            let _ = event_tx.blocking_send(SttMessage::Failed(format!(
                "Could not initialize native audio resampling: {error}"
            )));
            return;
        }
    };
    let chunk_in = resampler.input_frames_next();
    let mut vad = earshot::Detector::new(earshot::DefaultPredictor::new());

    let mut config = OfflineRecognizerConfig::default();
    config.model_config.nemo_ctc.model = Some(
        model_dir
            .join("model.int8.onnx")
            .to_string_lossy()
            .into_owned(),
    );
    config.model_config.tokens = Some(model_dir.join("tokens.txt").to_string_lossy().into_owned());
    config.model_config.num_threads = 1;
    config.model_config.debug = false;
    let Some(recognizer) = OfflineRecognizer::create(&config) else {
        let _ = event_tx.blocking_send(SttMessage::Failed(
            "Could not load the Parakeet speech model.".to_string(),
        ));
        return;
    };

    let mut input_48k = Vec::new();
    let mut leftover_16k = Vec::new();
    let mut speech = Vec::new();
    let mut silence_frames = 0_usize;
    let mut in_speech = false;
    let mut observed_mute_epoch = input_mute_epoch.load(Ordering::Acquire);
    while !shutdown.load(Ordering::Acquire) {
        let batch = match audio_rx.recv_timeout(Duration::from_millis(50)) {
            Ok(batch) => Some(batch),
            Err(mpsc::RecvTimeoutError::Timeout) => None,
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        };
        let (shutting_down, current_mute_epoch) =
            sample_effective_mute_epoch(&input_mute_epoch, &shutdown, &shutdown_mute_epoch);
        if current_mute_epoch != observed_mute_epoch {
            observed_mute_epoch = current_mute_epoch;
            if clear_buffered_audio(
                &mut input_48k,
                &mut leftover_16k,
                &mut speech,
                &mut silence_frames,
                &mut in_speech,
            ) {
                let _ = event_tx.blocking_send(SttMessage::Speaking(false));
            }
        }
        if shutting_down && (discard_on_shutdown.load(Ordering::Acquire) || batch.is_none()) {
            break;
        }
        if !shutting_down && input_muted.load(Ordering::Acquire) {
            continue;
        }
        let Some(batch) = batch else {
            continue;
        };
        if batch.mute_epoch != observed_mute_epoch {
            continue;
        }
        input_48k.extend(
            batch
                .bytes
                .chunks_exact(4)
                .map(|sample| f32::from_le_bytes([sample[0], sample[1], sample[2], sample[3]])),
        );
        while input_48k.len() >= chunk_in {
            let chunk: Vec<f32> = input_48k.drain(..chunk_in).collect();
            let resampled = resample(&mut resampler, &chunk);
            leftover_16k.extend_from_slice(&resampled);
            while leftover_16k.len() >= VAD_FRAME_SAMPLES {
                let frame: Vec<f32> = leftover_16k.drain(..VAD_FRAME_SAMPLES).collect();
                let clamped: Vec<f32> =
                    frame.iter().map(|sample| sample.clamp(-1.0, 1.0)).collect();
                let speaking = vad.predict_f32(&clamped) > VAD_THRESHOLD;
                if speaking {
                    if !in_speech {
                        in_speech = true;
                        log::info!("Native Parakeet detected speech");
                        let _ = event_tx.blocking_send(SttMessage::Speaking(true));
                    }
                    silence_frames = 0;
                    speech.extend_from_slice(&frame);
                    if speech.len() >= MAX_SPEECH_SAMPLES {
                        flush_speech(
                            &speech,
                            &recognizer,
                            &event_tx,
                            None,
                            &input_mute_epoch,
                            &shutdown,
                            &shutdown_mute_epoch,
                            observed_mute_epoch,
                        );
                        speech.clear();
                        in_speech = false;
                        let _ = event_tx.blocking_send(SttMessage::Speaking(false));
                    }
                } else if in_speech {
                    speech.extend_from_slice(&frame);
                    silence_frames += 1;
                    if silence_frames >= SILENCE_FLUSH_FRAMES {
                        flush_speech(
                            &speech,
                            &recognizer,
                            &event_tx,
                            None,
                            &input_mute_epoch,
                            &shutdown,
                            &shutdown_mute_epoch,
                            observed_mute_epoch,
                        );
                        speech.clear();
                        silence_frames = 0;
                        in_speech = false;
                        let _ = event_tx.blocking_send(SttMessage::Speaking(false));
                    }
                }
            }
        }
    }
    if !speech.is_empty() && !discard_on_shutdown.load(Ordering::Acquire) {
        let (delivered_tx, delivered_rx) = mpsc::sync_channel(0);
        flush_speech(
            &speech,
            &recognizer,
            &event_tx,
            Some(delivered_tx),
            &input_mute_epoch,
            &shutdown,
            &shutdown_mute_epoch,
            observed_mute_epoch,
        );
        let _ = delivered_rx.recv_timeout(FINAL_TRANSCRIPT_DELIVERY_TIMEOUT);
    }
}

fn sample_effective_mute_epoch(
    input_mute_epoch: &AtomicU64,
    shutdown: &AtomicBool,
    shutdown_mute_epoch: &AtomicU64,
) -> (bool, u64) {
    let live_mute_epoch = input_mute_epoch.load(Ordering::Acquire);
    let shutting_down = shutdown.load(Ordering::Acquire);
    if shutting_down {
        (true, shutdown_mute_epoch.load(Ordering::Acquire))
    } else {
        (false, live_mute_epoch)
    }
}

fn clear_buffered_audio(
    input_48k: &mut Vec<f32>,
    leftover_16k: &mut Vec<f32>,
    speech: &mut Vec<f32>,
    silence_frames: &mut usize,
    in_speech: &mut bool,
) -> bool {
    input_48k.clear();
    leftover_16k.clear();
    speech.clear();
    *silence_frames = 0;
    std::mem::take(in_speech)
}

fn resample(resampler: &mut rubato::Fft<f32>, samples: &[f32]) -> Vec<f32> {
    use audioadapter_buffers::direct::InterleavedSlice;
    use rubato::Resampler;
    let Ok(input) = InterleavedSlice::new(samples, 1, samples.len()) else {
        return Vec::new();
    };
    resampler
        .process(&input, 0, None)
        .map(|output| output.take_data())
        .unwrap_or_default()
}

#[allow(clippy::too_many_arguments)] // Recognition needs both live and shutdown mute clocks.
fn flush_speech(
    speech: &[f32],
    recognizer: &sherpa_onnx::OfflineRecognizer,
    event_tx: &tokio_mpsc::Sender<SttMessage>,
    delivered: Option<SyncSender<()>>,
    input_mute_epoch: &AtomicU64,
    shutdown: &AtomicBool,
    shutdown_mute_epoch: &AtomicU64,
    expected_mute_epoch: u64,
) {
    if speech.is_empty() {
        return;
    }
    let stream = recognizer.create_stream();
    stream.accept_waveform(16_000, speech);
    recognizer.decode(&stream);
    let text = stream
        .get_result()
        .map(|result| result.text.trim().to_string())
        .unwrap_or_default();
    if sample_effective_mute_epoch(input_mute_epoch, shutdown, shutdown_mute_epoch).1
        != expected_mute_epoch
    {
        if let Some(delivered) = delivered {
            let _ = delivered.send(());
        }
        return;
    }
    log::info!(
        "Native Parakeet finalized {} samples into {} text characters",
        speech.len(),
        text.chars().count()
    );
    deliver_recognition_result(text, event_tx, delivered);
}

fn deliver_recognition_result(
    text: String,
    event_tx: &tokio_mpsc::Sender<SttMessage>,
    delivered: Option<SyncSender<()>>,
) {
    if text.is_empty() {
        if let Some(delivered) = delivered {
            let _ = delivered.send(());
        }
        return;
    }
    let _ = event_tx.blocking_send(SttMessage::Final { text, delivered });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn replacement_revalidates_target_after_waiting_for_stop_serialization() {
        let state = NativeVoiceState::default();
        let target_is_foreground = AtomicBool::new(true);
        let active_operation = state.stop_serial.lock().await;
        let validation = state.target_lifecycle_guard(|| {
            target_is_foreground
                .load(Ordering::SeqCst)
                .then_some(())
                .ok_or_else(|| "The target session is no longer in the foreground.".to_string())
        });
        tokio::pin!(validation);

        assert!(
            tokio::time::timeout(Duration::from_millis(10), validation.as_mut())
                .await
                .is_err()
        );
        target_is_foreground.store(false, Ordering::SeqCst);
        drop(active_operation);

        assert_eq!(
            validation.await.expect_err("stale target must be rejected"),
            "The target session is no longer in the foreground."
        );
    }

    #[test]
    fn worker_shutdown_budget_covers_recognition_and_delivery() {
        assert!(
            STT_WORKER_SHUTDOWN_TIMEOUT_SECONDS
                > mac_speech::RECOGNITION_FINISH_TIMEOUT_SECONDS
                    + FINAL_TRANSCRIPT_DELIVERY_TIMEOUT_SECONDS
        );
    }

    #[test]
    fn apple_status_is_only_queried_when_it_can_change_availability() {
        assert!(!needs_macos_status(true, false));
        assert!(!needs_macos_status(false, true));
        assert!(needs_macos_status(false, false));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn finishing_finals_share_one_delivery_deadline() {
        let (recognition_tx, mut recognition_rx) = tokio_mpsc::unbounded_channel();
        recognition_tx
            .send(mac_speech::RecognitionEvent::Final("first".to_string()))
            .expect("queue first final");
        recognition_tx
            .send(mac_speech::RecognitionEvent::Final("second".to_string()))
            .expect("queue second final");
        recognition_tx
            .send(mac_speech::RecognitionEvent::Finished)
            .expect("queue finish");
        let (output_tx, mut output_rx) = tokio_mpsc::channel(4);
        let started = Instant::now();

        forward_macos_events(
            &mut recognition_rx,
            &output_tx,
            Some(started + Duration::from_millis(20)),
        )
        .expect("drain final events");

        assert!(started.elapsed() < Duration::from_millis(100));
        assert!(matches!(
            output_rx.try_recv(),
            Ok(SttMessage::Final { text, .. }) if text == "first"
        ));
        assert!(matches!(
            output_rx.try_recv(),
            Ok(SttMessage::Final { text, .. }) if text == "second"
        ));
    }

    #[test]
    fn native_mute_control_does_not_latch_the_software_fallback() {
        assert!(!software_microphone_mute(true, true));
        assert!(software_microphone_mute(false, true));
        assert!(!software_microphone_mute(false, false));
    }

    #[test]
    fn replacement_stop_requires_the_target_session_window() {
        assert!(replacement_caller_matches_target("main", None, true));
        assert!(!replacement_caller_matches_target("main", None, false));
        assert!(!replacement_caller_matches_target(
            "main",
            Some("session:target"),
            true,
        ));
        assert!(replacement_caller_matches_target(
            "session:target",
            Some("session:target"),
            true,
        ));
        assert!(!replacement_caller_matches_target(
            "session:other",
            Some("session:target"),
            true,
        ));
        assert!(!replacement_caller_matches_target(
            "voice-buddy",
            None,
            true,
        ));
    }

    #[test]
    fn replacement_focus_accepts_an_active_app_only_for_the_main_window() {
        assert!(voice_main_surface_is_available(true, false));
        assert!(!voice_main_surface_is_available(false, false));
        assert!(!voice_main_surface_is_available(true, true));
        assert!(voice_target_window_focus_is_valid(
            "main", true, false, false, false,
        ));
        assert!(voice_target_window_focus_is_valid(
            "main", false, true, true, false,
        ));
        assert!(!voice_target_window_focus_is_valid(
            "main", false, true, true, true,
        ));
        assert!(!voice_target_window_focus_is_valid(
            "main", false, true, false, false,
        ));
        assert!(!voice_target_window_focus_is_valid(
            "main", false, false, true, false,
        ));
        assert!(voice_target_window_focus_is_valid(
            "session:target",
            true,
            false,
            false,
            false,
        ));
        assert!(!voice_target_window_focus_is_valid(
            "session:target",
            false,
            true,
            true,
            false,
        ));
    }

    #[test]
    fn speaker_playback_blocks_vad_ingestion_until_all_guards_finish() {
        let state = NativeVoiceState::default();
        assert!(!state.capture_is_suppressed());

        let first = state.suppress_capture();
        assert!(state.capture_is_suppressed());
        {
            let second = state.suppress_capture();
            assert!(state.capture_is_suppressed());
            drop(second);
            assert!(state.capture_is_suppressed());
        }

        drop(first);
        assert!(!state.capture_is_suppressed());
    }

    #[test]
    fn assistant_activity_is_bound_to_the_exact_voice_lifecycle() {
        let state = NativeVoiceState::default();
        {
            let mut runtime = state.runtime.lock().expect("lock native runtime");
            runtime.session_id = Some("session-1".to_string());
            runtime.revision = 7;
            runtime.owner = Some(RuntimeOwner {
                window_label: "main".to_string(),
            });
        }

        assert_eq!(
            state
                .assistant_activity_target("main", "session-1", 7)
                .expect("current activity target"),
            Some(("main".to_string(), 7)),
        );
        assert_eq!(
            state
                .assistant_activity_target("main", "session-1", 6)
                .expect("stale activity is ignored"),
            None,
        );
        assert!(state
            .assistant_activity_target("session:other", "session-1", 7)
            .is_err());

        state.runtime.lock().expect("lock native runtime").revision = 8;
        assert_eq!(
            state
                .assistant_activity_target("main", "session-1", 7)
                .expect("prior lifecycle activity is ignored after restart"),
            None,
        );
    }

    #[test]
    fn stale_controls_watchdog_cannot_take_a_restarted_voice_lifecycle() {
        let state = NativeVoiceState::default();
        {
            let mut runtime = state.runtime.lock().expect("lock native runtime");
            runtime.session_id = Some("session-b".to_string());
            runtime.revision = 8;
            runtime.owner = Some(RuntimeOwner {
                window_label: "main".to_string(),
            });
        }

        assert!(state
            .take_stop_snapshot(Some(("session-a", 7)))
            .expect("stale watchdog check")
            .is_none());
        assert_eq!(
            state.active_session_lifecycle_target(),
            Some(("session-b".to_string(), "main".to_string(), 8)),
        );
    }

    #[tokio::test]
    async fn concurrent_stops_flush_one_final_transcript_once() {
        let state = NativeVoiceState::default();
        let (audio_tx, _audio_rx) = mpsc::sync_channel(1);
        let shutdown = Arc::new(AtomicBool::new(false));
        let worker_shutdown = Arc::clone(&shutdown);
        let pending = Arc::clone(&state.pending);
        let worker = thread::spawn(move || {
            while !worker_shutdown.load(Ordering::Acquire) {
                thread::yield_now();
            }
            pending
                .lock()
                .expect("lock pending transcripts")
                .push_back(PendingTranscript {
                    session_id: "session-1".to_string(),
                    lifecycle_id: "lifecycle-1".to_string(),
                    id: "final-1".to_string(),
                    text: "final words".to_string(),
                    revision: 4,
                    delivery_attempts: 0,
                });
        });
        {
            let mut runtime = state.runtime.lock().expect("lock native runtime");
            runtime.session_id = Some("session-1".to_string());
            runtime.lifecycle_id = Some("lifecycle-1".to_string());
            runtime.revision = 4;
            runtime.owner = Some(RuntimeOwner {
                window_label: "main".to_string(),
            });
            runtime.pipeline = Some(SttPipeline {
                audio_tx,
                audio_seen: AtomicBool::new(false),
                shutdown,
                discard_on_shutdown: Arc::new(AtomicBool::new(false)),
                input_muted: Arc::new(AtomicBool::new(false)),
                input_mute_epoch: Arc::new(AtomicU64::new(0)),
                shutdown_mute_epoch: Arc::new(AtomicU64::new(0)),
                thread: Some(worker),
            });
        }

        let first_state = state.clone();
        let second_state = state.clone();
        let first = tokio::spawn(async move {
            first_state
                .stop_lifecycle(Some(("session-1", 4)))
                .await
                .expect("first stop")
        });
        let second = tokio::spawn(async move {
            second_state
                .stop_lifecycle(Some(("session-1", 4)))
                .await
                .expect("second stop")
        });
        let (first, second) = tokio::join!(first, second);
        let completions = [first.expect("join first"), second.expect("join second")];

        assert_eq!(
            completions.iter().filter(|result| result.is_some()).count(),
            1
        );
        let pending = state.pending.lock().expect("lock pending transcripts");
        assert_eq!(pending.len(), 1);
        assert_eq!(
            pending.front().map(|item| item.id.as_str()),
            Some("final-1")
        );
    }

    #[tokio::test]
    async fn non_cooperative_worker_cannot_block_stop_or_replacement_lifecycle() {
        let state = NativeVoiceState::default();
        let (audio_tx, _audio_rx) = mpsc::sync_channel(1);
        let worker_release = Arc::new(AtomicBool::new(false));
        let release = Arc::clone(&worker_release);
        let worker = thread::spawn(move || {
            while !release.load(Ordering::Acquire) {
                thread::sleep(Duration::from_millis(5));
            }
        });
        {
            let mut runtime = state.runtime.lock().expect("lock native runtime");
            runtime.session_id = Some("session-1".to_string());
            runtime.lifecycle_id = Some("lifecycle-1".to_string());
            runtime.revision = 4;
            runtime.owner = Some(RuntimeOwner {
                window_label: "main".to_string(),
            });
            runtime.pipeline = Some(SttPipeline {
                audio_tx,
                audio_seen: AtomicBool::new(false),
                shutdown: Arc::new(AtomicBool::new(false)),
                discard_on_shutdown: Arc::new(AtomicBool::new(false)),
                input_muted: Arc::new(AtomicBool::new(false)),
                input_mute_epoch: Arc::new(AtomicU64::new(0)),
                shutdown_mute_epoch: Arc::new(AtomicU64::new(0)),
                thread: Some(worker),
            });
        }

        let completion = tokio::time::timeout(
            Duration::from_millis(500),
            state.stop_lifecycle(Some(("session-1", 4))),
        )
        .await
        .expect("stop is bounded")
        .expect("stop succeeds");
        assert!(completion.is_some());

        {
            let mut runtime = state.runtime.lock().expect("lock native runtime");
            assert!(runtime.session_id.is_none());
            runtime.session_id = Some("session-2".to_string());
            runtime.lifecycle_id = Some("lifecycle-2".to_string());
            runtime.revision = 6;
            runtime.owner = Some(RuntimeOwner {
                window_label: "main".to_string(),
            });
        }
        assert_eq!(
            state.active_session_lifecycle_target(),
            Some(("session-2".to_string(), "main".to_string(), 6))
        );
        assert!(state
            .take_stop_snapshot(Some(("session-1", 4)))
            .expect("late stale lifecycle is ignored")
            .is_none());
        let (accepted, evicted) = enqueue_transcript_if_active(
            &state.runtime,
            &state.pending,
            "session-1",
            4,
            PendingTranscript {
                session_id: "session-1".to_string(),
                lifecycle_id: "lifecycle-1".to_string(),
                id: "late-final".to_string(),
                text: "late words".to_string(),
                revision: 4,
                delivery_attempts: 0,
            },
        )
        .expect("late transcript lifecycle check");
        assert!(!accepted);
        assert!(evicted.is_none());
        assert!(state.pending.lock().expect("lock pending queue").is_empty());

        worker_release.store(true, Ordering::Release);
    }

    #[test]
    fn microphone_mute_is_authorized_and_lifecycle_bound() {
        let state = NativeVoiceState::default();
        {
            let mut runtime = state.runtime.lock().expect("lock native runtime");
            runtime.session_id = Some("session-b".to_string());
            runtime.revision = 8;
            runtime.owner = Some(RuntimeOwner {
                window_label: "main".to_string(),
            });
        }

        assert_eq!(
            state
                .set_microphone_muted_target("main", "session-a", 7, true)
                .expect("stale mute is ignored"),
            None,
        );
        assert!(!state.microphone_is_muted());
        assert!(state
            .set_microphone_muted_target("other", "session-b", 8, true)
            .is_err());
        assert!(!state.microphone_is_muted());
        assert_eq!(
            state
                .set_microphone_muted_target(
                    super::super::voice_buddy::WINDOW_LABEL,
                    "session-b",
                    8,
                    true,
                )
                .expect("floating controls can mute"),
            Some("main".to_string()),
        );
        assert!(state.microphone_is_muted());
    }

    #[test]
    fn owner_stop_authorization_is_lifecycle_bound() {
        let state = NativeVoiceState::default();
        {
            let mut runtime = state.runtime.lock().expect("lock native runtime");
            runtime.session_id = Some("session-b".to_string());
            runtime.revision = 8;
            runtime.owner = Some(RuntimeOwner {
                window_label: "main".to_string(),
            });
        }

        assert!(!state
            .owner_matches_lifecycle("main", "session-a", 7)
            .expect("stale owner stop is ignored"));
        assert!(state
            .owner_matches_lifecycle("other", "session-b", 8)
            .is_err());
        assert!(state
            .owner_matches_lifecycle("main", "session-b", 8)
            .expect("owner can stop current lifecycle"));
    }

    #[tokio::test]
    async fn window_destroy_stops_only_its_owned_voice_lifecycle() {
        let state = NativeVoiceState::default();
        state.microphone_muted.store(true, Ordering::SeqCst);
        {
            let mut runtime = state.runtime.lock().expect("lock native runtime");
            runtime.session_id = Some("session-1".to_string());
            runtime.lifecycle_id = Some("lifecycle-1".to_string());
            runtime.owner = Some(RuntimeOwner {
                window_label: "session-window".to_string(),
            });
        }

        assert!(state
            .capture_destroyed_owner_lifecycle("other-window")
            .is_none());
        assert_eq!(
            state
                .runtime
                .lock()
                .expect("lock native runtime")
                .session_id
                .as_deref(),
            Some("session-1")
        );

        let completion = state
            .stop_destroyed_owner_lifecycle("session-window", "session-1", 0)
            .await
            .expect("stop destroyed owner")
            .expect("owned lifecycle stops");
        assert_eq!(completion.controls_revision, 0);
        assert_eq!(completion.next_revision, 1);
        let runtime = state.runtime.lock().expect("lock native runtime");
        assert!(runtime.session_id.is_none());
        assert!(runtime.owner.is_none());
        assert!(!state.microphone_muted.load(Ordering::SeqCst));
    }

    #[test]
    fn floating_controls_follow_only_the_exact_owner_lifecycle() {
        let state = NativeVoiceState::default();
        {
            let mut runtime = state.runtime.lock().expect("lock native runtime");
            runtime.session_id = Some("session-1".to_string());
            runtime.revision = 4;
            runtime.owner = Some(RuntimeOwner {
                window_label: "main".to_string(),
            });
            runtime.controls_suppressed = true;
        }

        assert_eq!(
            state
                .controls_visibility_target("session-1", 4)
                .expect("read control visibility"),
            Some(ControlsVisibilityTarget {
                suppressed: true,
                generation: 0,
            }),
        );
        assert_eq!(
            state
                .acknowledge_controls_visibility("session-1", 4, 0)
                .expect("acknowledge controls visibility"),
            ControlsVisibilityAcknowledgement::Ready,
        );
        assert!(state.controls_ready_for("session-1", 4));
        assert_eq!(
            state
                .acknowledge_controls_visibility("session-1", 3, 0)
                .expect("stale readiness is ignored"),
            ControlsVisibilityAcknowledgement::Inactive,
        );
        assert_eq!(
            state
                .set_controls_suppressed("main", "session-1", 4, false)
                .expect("owner reveals controls"),
            Some((true, true)),
        );
        state.rollback_controls_suppression("session-1", 4, false, true);
        assert_eq!(
            state
                .controls_visibility_target("session-1", 4)
                .expect("failed visibility is rolled back"),
            Some(ControlsVisibilityTarget {
                suppressed: true,
                generation: 2,
            }),
        );
        assert_eq!(
            state
                .set_controls_suppressed("main", "session-1", 3, true)
                .expect("stale lifecycle is ignored"),
            None,
        );
        assert!(state
            .set_controls_suppressed("other-window", "session-1", 4, true)
            .is_err());
    }

    #[test]
    fn floating_controls_remain_ready_while_visibility_converges() {
        let state = NativeVoiceState::default();
        {
            let mut runtime = state.runtime.lock().expect("lock native runtime");
            runtime.session_id = Some("session-1".to_string());
            runtime.revision = 4;
            runtime.owner = Some(RuntimeOwner {
                window_label: "main".to_string(),
            });
            runtime.controls_suppressed = true;
        }

        let mut target = state
            .controls_visibility_target("session-1", 4)
            .expect("read initial visibility")
            .expect("active lifecycle");
        for _ in 0..4 {
            state
                .set_controls_suppressed("main", "session-1", 4, !target.suppressed)
                .expect("change visibility");
            target = match state
                .acknowledge_controls_visibility("session-1", 4, target.generation)
                .expect("acknowledge superseded visibility")
            {
                ControlsVisibilityAcknowledgement::Superseded(next_target) => next_target,
                acknowledgement => panic!("expected superseded target, got {acknowledgement:?}"),
            };
            assert!(state.controls_ready_for("session-1", 4));
        }

        assert_eq!(
            state
                .acknowledge_controls_visibility("session-1", 4, target.generation)
                .expect("acknowledge newest visibility"),
            ControlsVisibilityAcknowledgement::Ready,
        );
        assert!(state.controls_ready_for("session-1", 4));
    }

    #[test]
    fn audio_push_rejects_malformed_batches() {
        let (sender, _receiver) = mpsc::sync_channel(1);
        let pipeline = SttPipeline {
            audio_tx: sender,
            shutdown: Arc::new(AtomicBool::new(false)),
            discard_on_shutdown: Arc::new(AtomicBool::new(false)),
            input_muted: Arc::new(AtomicBool::new(false)),
            input_mute_epoch: Arc::new(AtomicU64::new(0)),
            shutdown_mute_epoch: Arc::new(AtomicU64::new(0)),
            audio_seen: AtomicBool::new(false),
            thread: None,
        };
        assert!(pipeline.push(vec![0; 3]).is_err());
        assert!(pipeline.push(vec![0; MAX_AUDIO_BATCH_BYTES + 4]).is_err());
    }

    #[test]
    fn audio_push_reports_bounded_queue_overrun() {
        let (sender, _receiver) = mpsc::sync_channel(1);
        let pipeline = SttPipeline {
            audio_tx: sender,
            shutdown: Arc::new(AtomicBool::new(false)),
            discard_on_shutdown: Arc::new(AtomicBool::new(false)),
            input_muted: Arc::new(AtomicBool::new(false)),
            input_mute_epoch: Arc::new(AtomicU64::new(0)),
            shutdown_mute_epoch: Arc::new(AtomicU64::new(0)),
            audio_seen: AtomicBool::new(false),
            thread: None,
        };

        pipeline.push(vec![0; 4]).expect("first batch fits");
        assert!(pipeline
            .push(vec![0; 4])
            .expect_err("full queue must report overrun")
            .contains("overrun"));
    }

    #[test]
    fn input_mute_discards_audio_and_unmute_resumes_queueing() {
        let (sender, receiver) = mpsc::sync_channel(1);
        let input_muted = Arc::new(AtomicBool::new(true));
        let input_mute_epoch = Arc::new(AtomicU64::new(1));
        let pipeline = SttPipeline {
            audio_tx: sender,
            shutdown: Arc::new(AtomicBool::new(false)),
            discard_on_shutdown: Arc::new(AtomicBool::new(false)),
            input_muted: Arc::clone(&input_muted),
            input_mute_epoch: Arc::clone(&input_mute_epoch),
            shutdown_mute_epoch: Arc::new(AtomicU64::new(0)),
            audio_seen: AtomicBool::new(false),
            thread: None,
        };

        pipeline
            .push(vec![0; 4])
            .expect("muted microphone input is accepted and discarded");
        assert!(receiver.try_recv().is_err());

        input_muted.store(false, Ordering::Release);
        pipeline.push(vec![0; 4]).expect("unmuted audio is queued");
        assert_eq!(
            receiver.try_recv().expect("unmuted audio").bytes,
            vec![0; 4]
        );
    }

    #[test]
    fn queued_audio_retains_epoch_across_fast_mute_unmute() {
        let (sender, receiver) = mpsc::sync_channel(1);
        let input_mute_epoch = Arc::new(AtomicU64::new(0));
        let pipeline = SttPipeline {
            audio_tx: sender,
            shutdown: Arc::new(AtomicBool::new(false)),
            discard_on_shutdown: Arc::new(AtomicBool::new(false)),
            input_muted: Arc::new(AtomicBool::new(false)),
            input_mute_epoch: Arc::clone(&input_mute_epoch),
            shutdown_mute_epoch: Arc::new(AtomicU64::new(0)),
            audio_seen: AtomicBool::new(false),
            thread: None,
        };

        pipeline.push(vec![0; 4]).expect("audio queues before mute");
        input_mute_epoch.fetch_add(1, Ordering::AcqRel);

        let batch = receiver.try_recv().expect("queued audio");
        assert_ne!(batch.mute_epoch, input_mute_epoch.load(Ordering::Acquire));
    }

    #[test]
    fn input_mute_clears_partial_utterance_even_without_a_new_batch() {
        let mut input_48k = vec![0.1];
        let mut leftover_16k = vec![0.2];
        let mut speech = vec![0.3];
        let mut silence_frames = 4;
        let mut in_speech = true;

        assert!(clear_buffered_audio(
            &mut input_48k,
            &mut leftover_16k,
            &mut speech,
            &mut silence_frames,
            &mut in_speech,
        ));
        assert!(input_48k.is_empty());
        assert!(leftover_16k.is_empty());
        assert!(speech.is_empty());
        assert_eq!(silence_frames, 0);
        assert!(!in_speech);
    }

    #[test]
    fn muted_shutdown_keeps_final_utterance_discarded_after_handler_reset() {
        let (sender, _receiver) = mpsc::sync_channel(1);
        let input_muted = Arc::new(AtomicBool::new(true));
        let discard_on_shutdown = Arc::new(AtomicBool::new(false));
        let mut pipeline = SttPipeline {
            audio_tx: sender,
            shutdown: Arc::new(AtomicBool::new(false)),
            discard_on_shutdown: Arc::clone(&discard_on_shutdown),
            input_muted: Arc::clone(&input_muted),
            input_mute_epoch: Arc::new(AtomicU64::new(1)),
            shutdown_mute_epoch: Arc::new(AtomicU64::new(0)),
            audio_seen: AtomicBool::new(false),
            thread: None,
        };

        pipeline.begin_shutdown();
        input_muted.store(false, Ordering::Release);

        assert!(discard_on_shutdown.load(Ordering::Acquire));
    }

    #[test]
    fn unmuted_shutdown_keeps_final_utterance_after_later_mute_event() {
        let (sender, _receiver) = mpsc::sync_channel(1);
        let input_muted = Arc::new(AtomicBool::new(false));
        let input_mute_epoch = Arc::new(AtomicU64::new(0));
        let discard_on_shutdown = Arc::new(AtomicBool::new(false));
        let mut pipeline = SttPipeline {
            audio_tx: sender,
            shutdown: Arc::new(AtomicBool::new(false)),
            discard_on_shutdown: Arc::clone(&discard_on_shutdown),
            input_muted: Arc::clone(&input_muted),
            input_mute_epoch: Arc::clone(&input_mute_epoch),
            shutdown_mute_epoch: Arc::new(AtomicU64::new(0)),
            audio_seen: AtomicBool::new(false),
            thread: None,
        };

        pipeline.begin_shutdown();
        input_muted.store(true, Ordering::Release);
        input_mute_epoch.fetch_add(1, Ordering::AcqRel);
        pipeline.signal_shutdown();

        assert!(!discard_on_shutdown.load(Ordering::Acquire));
        assert_eq!(pipeline.shutdown_mute_epoch.load(Ordering::Acquire), 0);
        assert_eq!(
            sample_effective_mute_epoch(
                &input_mute_epoch,
                &AtomicBool::new(false),
                &pipeline.shutdown_mute_epoch,
            ),
            (false, 1),
        );
        assert_eq!(
            sample_effective_mute_epoch(
                &input_mute_epoch,
                &pipeline.shutdown,
                &pipeline.shutdown_mute_epoch,
            ),
            (true, 0),
        );
    }

    #[test]
    fn only_owning_window_can_inject_audio() {
        let state = NativeVoiceState::default();
        let (sender, receiver) = mpsc::sync_channel(2);
        {
            let mut runtime = state.runtime.lock().expect("lock native runtime");
            runtime.owner = Some(RuntimeOwner {
                window_label: "owner-window".to_string(),
            });
            runtime.pipeline = Some(SttPipeline {
                audio_tx: sender,
                shutdown: Arc::new(AtomicBool::new(false)),
                discard_on_shutdown: Arc::new(AtomicBool::new(false)),
                input_muted: Arc::new(AtomicBool::new(false)),
                input_mute_epoch: Arc::new(AtomicU64::new(0)),
                shutdown_mute_epoch: Arc::new(AtomicU64::new(0)),
                audio_seen: AtomicBool::new(false),
                thread: None,
            });
        }

        assert!(push_audio_for_window(&state, "other-window", vec![0; 4]).is_err());
        assert!(receiver.try_recv().is_err());
        state.microphone_muted.store(true, Ordering::SeqCst);
        push_audio_for_window(&state, "owner-window", vec![0; 4])
            .expect("muted owner audio is ignored");
        assert!(receiver.try_recv().is_err());
        state.microphone_muted.store(false, Ordering::SeqCst);
        state.input_muted.store(true, Ordering::SeqCst);
        push_audio_for_window(&state, "owner-window", vec![0; 4])
            .expect("native-muted owner audio is ignored");
        assert!(receiver.try_recv().is_err());
        state.input_muted.store(false, Ordering::SeqCst);
        push_audio_for_window(&state, "owner-window", vec![0; 4]).expect("owner can send audio");
        assert_eq!(
            receiver.try_recv().expect("owner audio queued").bytes,
            vec![0; 4]
        );
    }

    #[tokio::test]
    async fn window_destroy_awaits_bounded_worker_shutdown_off_callback() {
        let state = NativeVoiceState::default();
        state.microphone_muted.store(true, Ordering::SeqCst);
        let (sender, _receiver) = mpsc::sync_channel(1);
        let shutdown = Arc::new(AtomicBool::new(false));
        let worker = thread::spawn(|| thread::sleep(Duration::from_millis(250)));
        {
            let mut runtime = state.runtime.lock().expect("lock native runtime");
            runtime.session_id = Some("session-1".to_string());
            runtime.owner = Some(RuntimeOwner {
                window_label: "owner-window".to_string(),
            });
            runtime.pipeline = Some(SttPipeline {
                audio_tx: sender,
                shutdown: Arc::clone(&shutdown),
                discard_on_shutdown: Arc::new(AtomicBool::new(false)),
                input_muted: Arc::new(AtomicBool::new(false)),
                input_mute_epoch: Arc::new(AtomicU64::new(0)),
                shutdown_mute_epoch: Arc::new(AtomicU64::new(0)),
                audio_seen: AtomicBool::new(false),
                thread: Some(worker),
            });
        }

        let completion = state
            .stop_destroyed_owner_lifecycle("owner-window", "session-1", 0)
            .await
            .expect("stop destroyed owner")
            .expect("owned lifecycle stops");
        assert_eq!(completion.controls_revision, 0);
        assert_eq!(completion.next_revision, 1);
        assert!(shutdown.load(Ordering::Acquire));
        assert!(!state.microphone_muted.load(Ordering::SeqCst));
        assert!(state
            .runtime
            .lock()
            .expect("lock native runtime")
            .session_id
            .is_none());
    }

    #[tokio::test]
    async fn owner_destroy_waits_for_start_serialization_before_stopping_exact_lifecycle() {
        let state = NativeVoiceState::default();
        let startup_guard = state.stop_serial.lock().await;
        {
            let mut runtime = state.runtime.lock().expect("lock native runtime");
            runtime.session_id = Some("session-a".to_string());
            runtime.lifecycle_id = Some("lifecycle-a".to_string());
            runtime.revision = 4;
            runtime.owner = Some(RuntimeOwner {
                window_label: "owner-window".to_string(),
            });
        }

        let close_state = state.clone();
        let close = tokio::spawn(async move {
            close_state
                .stop_destroyed_owner_lifecycle("owner-window", "session-a", 4)
                .await
                .expect("stop destroyed owner")
        });
        tokio::task::yield_now().await;
        assert_eq!(
            state.active_session_lifecycle_target(),
            Some(("session-a".to_string(), "owner-window".to_string(), 4,))
        );

        {
            let mut runtime = state.runtime.lock().expect("lock native runtime");
            runtime.session_id = Some("session-b".to_string());
            runtime.lifecycle_id = Some("lifecycle-b".to_string());
            runtime.revision = 6;
            runtime.owner = Some(RuntimeOwner {
                window_label: "owner-window".to_string(),
            });
        }
        drop(startup_guard);
        assert!(close.await.expect("join owner close").is_none());
        assert!(state
            .take_stop_snapshot(Some(("session-a", 4)))
            .expect("stale A cleanup is rejected")
            .is_none());
        assert_eq!(
            state.active_session_lifecycle_target(),
            Some(("session-b".to_string(), "owner-window".to_string(), 6,))
        );
    }

    #[tokio::test]
    async fn owner_destroy_keeps_cleanup_inside_start_stop_serialization() {
        let state = NativeVoiceState::default();
        {
            let mut runtime = state.runtime.lock().expect("lock native runtime");
            runtime.session_id = Some("session-a".to_string());
            runtime.lifecycle_id = Some("lifecycle-a".to_string());
            runtime.revision = 4;
            runtime.owner = Some(RuntimeOwner {
                window_label: "owner-window".to_string(),
            });
        }

        let cleanup_ran = AtomicBool::new(false);
        let completion = state
            .stop_destroyed_owner_lifecycle_with_cleanup("owner-window", "session-a", 4, |_| {
                assert!(state.stop_serial.try_lock().is_err());
                cleanup_ran.store(true, Ordering::SeqCst);
            })
            .await
            .expect("stop destroyed owner")
            .expect("owned lifecycle stops");

        assert_eq!(completion.next_revision, 5);
        assert!(cleanup_ran.load(Ordering::SeqCst));
    }

    #[test]
    fn queued_start_reclaims_microphone_after_destroyed_owner_cleanup() {
        let capture = VoiceCaptureState::default();
        let first_epoch = capture.register_renderer_for_test("owner-window", "renderer-a");
        let owner_id = native_owner_id("session-a");
        assert!(capture
            .claim_microphone(
                "owner-window".to_string(),
                "renderer-a".to_string(),
                first_epoch,
                owner_id.clone(),
            )
            .expect("initial lifecycle claims microphone"));

        let second_epoch = capture.register_renderer_for_test("owner-window", "renderer-b");
        let mut replacement_claimed = capture
            .claim_microphone(
                "owner-window".to_string(),
                "renderer-b".to_string(),
                second_epoch,
                owner_id.clone(),
            )
            .expect("replacement renderer inherits the native claim");
        assert!(!replacement_claimed);
        assert!(capture.release_owner("owner-window", &owner_id));

        refresh_microphone_claim(
            &capture,
            "owner-window",
            "renderer-b",
            second_epoch,
            &owner_id,
            &mut replacement_claimed,
        )
        .expect("queued replacement reclaims after serialized cleanup");

        assert!(replacement_claimed);
        assert!(!capture
            .claim_microphone(
                "owner-window".to_string(),
                "renderer-b".to_string(),
                second_epoch,
                owner_id,
            )
            .expect("replacement keeps the microphone claim"));
    }

    #[test]
    fn archive_start_blocks_are_process_wide_and_window_scoped() {
        let state = NativeVoiceState::default();
        let shared_state = state.clone();
        let first_token = state
            .block_starts(
                "session-1".to_string(),
                "main".to_string(),
                "renderer-1".to_string(),
                1,
            )
            .expect("block starts from main");
        let second_token = shared_state
            .block_starts(
                "session-1".to_string(),
                "session-window".to_string(),
                "renderer-2".to_string(),
                1,
            )
            .expect("block starts from session window");

        assert!(shared_state.starts_blocked("session-1"));
        state
            .release_start_block("session-1", &first_token)
            .expect("release main block");
        assert!(shared_state.starts_blocked("session-1"));

        shared_state.release_start_blocks_for_window("session-window");
        assert!(!state.starts_blocked("session-1"));
        state
            .release_start_block("session-1", &second_token)
            .expect("stale release is harmless");
    }

    #[test]
    fn renderer_replacement_clears_abandoned_archive_start_blocks() {
        let state = NativeVoiceState::default();
        state
            .block_starts(
                "session-1".to_string(),
                "main".to_string(),
                "renderer-1".to_string(),
                1,
            )
            .expect("block starts");

        state.release_start_blocks_for_replaced_renderer("main", "renderer-2", 2);

        assert!(!state.starts_blocked("session-1"));
    }

    #[test]
    fn retained_transcripts_are_capped_and_fail_terminally() {
        let mut pending = VecDeque::new();
        for index in 0..=MAX_PENDING_TRANSCRIPTS {
            enqueue_pending_transcript(
                &mut pending,
                PendingTranscript {
                    session_id: "session-1".to_string(),
                    lifecycle_id: "lifecycle-1".to_string(),
                    id: index.to_string(),
                    text: "hello".to_string(),
                    revision: 2,
                    delivery_attempts: 0,
                },
            );
        }
        assert_eq!(pending.len(), MAX_PENDING_TRANSCRIPTS);
        assert_eq!(pending.front().map(|item| item.id.as_str()), Some("1"));

        let id = pending.front().expect("retained transcript").id.clone();
        for attempts in 1..MAX_TRANSCRIPT_DELIVERY_ATTEMPTS {
            let outcome = reject_pending_transcript(&mut pending, "session-1", &id, 2);
            assert_eq!(outcome.attempts, attempts);
            assert!(!outcome.terminal);
        }
        let outcome = reject_pending_transcript(&mut pending, "session-1", &id, 2);
        assert!(outcome.terminal);
        assert!(!pending.iter().any(|item| item.id == id));
    }

    #[test]
    fn empty_recognition_result_releases_stop_waiter() {
        let (event_tx, _event_rx) = tokio_mpsc::channel(1);
        let (delivered_tx, delivered_rx) = mpsc::sync_channel(1);

        deliver_recognition_result(String::new(), &event_tx, Some(delivered_tx));

        assert!(delivered_rx.try_recv().is_ok());
    }

    #[test]
    fn native_voice_events_use_renderer_field_names() {
        let event = NativeVoiceEvent::User {
            session_id: "session-1".to_string(),
            lifecycle_id: "lifecycle-1".to_string(),
            id: "utterance-1".to_string(),
            text: "hello".to_string(),
            revision: 2,
            delivery_attempts: 0,
        };

        assert_eq!(
            serde_json::to_value(event).expect("serialize native voice event"),
            serde_json::json!({
                "type": "user",
                "sessionId": "session-1",
                "lifecycleId": "lifecycle-1",
                "id": "utterance-1",
                "text": "hello",
                "revision": 2,
                "deliveryAttempts": 0,
            }),
        );

        assert_eq!(
            serde_json::to_value(NativeVoiceEvent::ControlsDismissed { revision: 3 })
                .expect("serialize controls-dismissed event"),
            serde_json::json!({
                "type": "controlsDismissed",
                "revision": 3,
            }),
        );
    }

    #[test]
    fn input_backend_uses_renderer_wire_values() {
        assert_eq!(
            serde_json::from_str::<VoiceInputBackend>("\"parakeet\"")
                .expect("deserialize Parakeet backend"),
            VoiceInputBackend::Parakeet,
        );
        assert_eq!(
            serde_json::from_str::<VoiceInputBackend>("\"macos\"")
                .expect("deserialize macOS backend"),
            VoiceInputBackend::Macos,
        );
    }
}
