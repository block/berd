//! Native Parakeet speech recognition for Desktop voice conversations.

use std::{
    collections::VecDeque,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
        mpsc::{self, Receiver, SyncSender, TrySendError},
        Arc, Mutex,
    },
    thread,
    time::Duration,
};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};
use tokio::sync::mpsc as tokio_mpsc;

use super::{
    native_input_mute, pocket_voice::parakeet_model_dir, voice_capture::VoiceCaptureState,
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
    native_microphone_mute_control: bool,
    native_microphone_muted: bool,
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
enum NativeVoiceEvent {
    Startup {
        session_id: String,
        owner_window_label: String,
        line: String,
        revision: u64,
        native_microphone_mute_control: bool,
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
    InputMute {
        session_id: String,
        muted: bool,
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
    native_microphone_mute_control: bool,
}

#[derive(Clone)]
struct RuntimeOwner {
    window_label: String,
}

#[derive(Clone, Default)]
pub struct NativeVoiceState {
    runtime: Arc<Mutex<Runtime>>,
    pending: Arc<Mutex<VecDeque<PendingTranscript>>>,
    capture_suppressions: Arc<AtomicUsize>,
    input_muted: Arc<AtomicBool>,
    input_mute_epoch: Arc<AtomicU64>,
    microphone_muted: Arc<AtomicBool>,
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
        self.microphone_muted.load(Ordering::SeqCst)
    }

    pub fn active_session_target(&self) -> Option<(String, String)> {
        let runtime = self.runtime.lock().ok()?;
        Some((
            runtime.session_id.clone()?,
            runtime.owner.as_ref()?.window_label.clone(),
        ))
    }

    pub fn set_microphone_muted(&self, app: &AppHandle, muted: bool) -> Result<(), String> {
        let (session_id, owner_window_label, revision) = {
            let runtime = self
                .runtime
                .lock()
                .map_err(|_| "native voice state lock was poisoned".to_string())?;
            let session_id = runtime
                .session_id
                .clone()
                .ok_or_else(|| "No native voice conversation is active.".to_string())?;
            let owner_window_label = runtime
                .owner
                .as_ref()
                .map(|owner| owner.window_label.clone())
                .ok_or_else(|| "The native voice conversation has no owning window.".to_string())?;
            (session_id, owner_window_label, runtime.revision)
        };
        self.microphone_muted.store(muted, Ordering::SeqCst);
        #[cfg(target_os = "macos")]
        if let Err(error) = super::voice_menu_bar::set_muted(app, muted) {
            log::warn!("Failed to update the voice menu bar mute state: {error}");
        }
        let event = NativeVoiceEvent::MicrophoneMute {
            session_id,
            muted,
            revision,
        };
        if let Some(window) = app.get_webview_window(&owner_window_label) {
            let _ = window.emit(EVENT_NAME, event.clone());
        }
        super::voice_buddy::emit(app, event);
        Ok(())
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
    thread: Option<thread::JoinHandle<()>>,
}

struct AudioBatch {
    bytes: Vec<u8>,
    mute_epoch: u64,
}

impl SttPipeline {
    fn new(
        model_dir: PathBuf,
        input_muted: Arc<AtomicBool>,
        input_mute_epoch: Arc<AtomicU64>,
    ) -> Result<(Self, tokio_mpsc::Receiver<SttMessage>), String> {
        let (audio_tx, audio_rx) = mpsc::sync_channel(AUDIO_QUEUE_DEPTH);
        let (event_tx, event_rx) = tokio_mpsc::channel(64);
        let shutdown = Arc::new(AtomicBool::new(false));
        let discard_on_shutdown = Arc::new(AtomicBool::new(false));
        let worker_shutdown = Arc::clone(&shutdown);
        let worker_discard_on_shutdown = Arc::clone(&discard_on_shutdown);
        let worker_input_muted = Arc::clone(&input_muted);
        let worker_input_mute_epoch = Arc::clone(&input_mute_epoch);
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
                thread: Some(thread),
            },
            event_rx,
        ))
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
                "Native Parakeet received its first audio batch ({} bytes)",
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

async fn shutdown_pipeline(mut pipeline: SttPipeline) {
    let worker = pipeline.begin_shutdown();
    drop(pipeline);
    if let Some(worker) = worker {
        let _ = tauri::async_runtime::spawn_blocking(move || worker.join()).await;
    }
}

fn status(app: &AppHandle, state: &NativeVoiceState) -> NativeVoiceStatus {
    let model = parakeet_model_dir(app);
    let runtime = state
        .runtime
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    NativeVoiceStatus {
        available: model.is_ok(),
        unavailable_reason: model
            .err()
            .map(|_| "Download native voice before starting a call.".to_string()),
        lifecycle: if runtime.session_id.is_some() {
            Lifecycle::Running
        } else {
            Lifecycle::Stopped
        },
        session_id: runtime.session_id.clone(),
        owner_window_label: runtime
            .owner
            .as_ref()
            .map(|owner| owner.window_label.clone()),
        microphone_muted: state.microphone_is_muted(),
        revision: runtime.revision,
        native_microphone_mute_control: runtime.native_microphone_mute_control,
        native_microphone_muted: runtime.session_id.is_some()
            && state.input_muted.load(Ordering::Acquire),
    }
}

#[tauri::command]
pub fn get_native_voice_conversation_status(
    app: AppHandle,
    state: State<'_, NativeVoiceState>,
) -> NativeVoiceStatus {
    status(&app, &state)
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
pub async fn start_native_voice_conversation(
    app: AppHandle,
    state: State<'_, NativeVoiceState>,
    capture: State<'_, VoiceCaptureState>,
    webview_window: WebviewWindow,
    session_id: String,
    renderer_id: String,
    renderer_epoch: u64,
) -> Result<NativeVoiceStatus, String> {
    let session_id = session_id.trim().to_string();
    if session_id.is_empty() || session_id.len() > 256 {
        return Err("session id must be between 1 and 256 bytes".to_string());
    }
    let window_label = webview_window.label().to_string();
    let owner_id = native_owner_id(&session_id);
    let microphone_claimed = capture.claim_microphone(
        window_label.clone(),
        renderer_id.clone(),
        renderer_epoch,
        owner_id.clone(),
    )?;
    let model_dir = match parakeet_model_dir(&app) {
        Ok(model_dir) => model_dir,
        Err(error) => {
            if microphone_claimed {
                capture.release_microphone(&window_label, &renderer_id, renderer_epoch, &owner_id);
            }
            return Err(error);
        }
    };
    let (pipeline, mut events) = match SttPipeline::new(
        model_dir,
        Arc::clone(&state.input_muted),
        Arc::clone(&state.input_mute_epoch),
    ) {
        Ok(result) => result,
        Err(error) => {
            if microphone_claimed {
                capture.release_microphone(&window_label, &renderer_id, renderer_epoch, &owner_id);
            }
            return Err(error);
        }
    };
    let (revision, lifecycle_id, runtime_mute_control) = {
        let mut runtime = state
            .runtime
            .lock()
            .map_err(|_| "native voice state lock was poisoned".to_string())?;
        if runtime.session_id.is_some() {
            if microphone_claimed {
                capture.release_microphone(&window_label, &renderer_id, renderer_epoch, &owner_id);
            }
            return Err("A native voice conversation is already active.".to_string());
        }
        runtime.revision = runtime.revision.wrapping_add(1);
        runtime.session_id = Some(session_id.clone());
        runtime.lifecycle_id = Some(uuid::Uuid::new_v4().to_string());
        runtime.owner = Some(RuntimeOwner {
            window_label: window_label.clone(),
        });
        runtime.pipeline = Some(pipeline);
        let runtime_revision = runtime.revision;
        let mute_window = webview_window.clone();
        let mute_session_id = session_id.clone();
        runtime.native_microphone_mute_control =
            native_input_mute::start(&state.input_muted, &state.input_mute_epoch, move |muted| {
                let _ = mute_window.emit(
                    EVENT_NAME,
                    NativeVoiceEvent::InputMute {
                        session_id: mute_session_id.clone(),
                        muted,
                        revision: runtime_revision,
                    },
                );
            });
        state.microphone_muted.store(false, Ordering::SeqCst);
        (
            runtime.revision,
            runtime.lifecycle_id.clone().unwrap_or_default(),
            runtime.native_microphone_mute_control,
        )
    };
    if let Err(error) = super::voice_buddy::install(&app) {
        state.stop_active(&app, &capture).await?;
        return Err(format!("Could not show the Gloopie voice buddy: {error}"));
    }
    let _ = webview_window.emit(
        EVENT_NAME,
        NativeVoiceEvent::Startup {
            session_id: session_id.clone(),
            owner_window_label: window_label.clone(),
            line: "Native Parakeet voice conversation is on".to_string(),
            revision,
            native_microphone_mute_control: runtime_mute_control,
        },
    );
    super::voice_buddy::emit(
        &app,
        NativeVoiceEvent::Startup {
            session_id: session_id.clone(),
            owner_window_label: window_label.clone(),
            line: "Native Parakeet voice conversation is on".to_string(),
            revision,
        },
    );

    let event_app = app.clone();
    let event_window = webview_window.clone();
    let runtime = Arc::clone(&state.runtime);
    let pending = Arc::clone(&state.pending);
    let input_muted = Arc::clone(&state.input_muted);
    let event_state = state.inner().clone();
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
                    let evicted = pending.lock().ok().and_then(|mut queue| {
                        enqueue_pending_transcript(&mut queue, transcript.clone())
                    });
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
                    #[cfg(target_os = "macos")]
                    super::voice_menu_bar::remove(&event_app);
                    super::voice_buddy::remove(&event_app);
                    event_app
                        .state::<VoiceCaptureState>()
                        .release_owner(&window_label, &owner_id);
                    let _ = event_window.emit(
                        EVENT_NAME,
                        NativeVoiceEvent::Error {
                            session_id: Some(session_id.clone()),
                            message,
                            revision: revision.wrapping_add(1),
                            terminal: true,
                        },
                    );
                    break;
                }
            }
        }
    });
    Ok(status(&app, &state))
}

#[tauri::command]
pub fn set_native_voice_microphone_muted(
    app: AppHandle,
    state: State<'_, NativeVoiceState>,
    muted: bool,
) -> Result<NativeVoiceStatus, String> {
    state.set_microphone_muted(&app, muted)?;
    Ok(status(&app, &state))
}

#[tauri::command]
pub async fn stop_native_voice_conversation(
    app: AppHandle,
    state: State<'_, NativeVoiceState>,
    capture: State<'_, VoiceCaptureState>,
    webview_window: WebviewWindow,
    renderer_id: String,
    renderer_epoch: u64,
) -> Result<NativeVoiceStatus, String> {
    capture.activate_renderer(webview_window.label(), &renderer_id, renderer_epoch)?;
    state.stop_active(&app, &capture).await?;
    Ok(status(&app, &state))
}

fn native_owner_id(session_id: &str) -> String {
    format!("native-voice:{session_id}")
}

impl NativeVoiceState {
    pub async fn stop_active(
        &self,
        app: &AppHandle,
        capture: &VoiceCaptureState,
    ) -> Result<(), String> {
        let (session_id, revision, pipeline, owner) = {
            let mut runtime = self
                .runtime
                .lock()
                .map_err(|_| "native voice state lock was poisoned".to_string())?;
            let owner = runtime.owner.clone();
            let session_id = runtime.session_id.clone();
            let owner_id = session_id.as_deref().map(native_owner_id);
            let revision = runtime.revision;
            (
                session_id,
                revision,
                runtime.pipeline.take(),
                owner.zip(owner_id),
            )
        };
        // Keep the lifecycle current while the worker flushes its final buffered
        // utterance into the durable pending queue.
        if let Some(pipeline) = pipeline {
            shutdown_pipeline(pipeline).await;
        }
        let next_revision = {
            let mut runtime = self
                .runtime
                .lock()
                .map_err(|_| "native voice state lock was poisoned".to_string())?;
            if runtime.revision == revision && runtime.session_id == session_id {
                runtime.session_id = None;
                runtime.lifecycle_id = None;
                runtime.owner = None;
                runtime.revision = runtime.revision.wrapping_add(1);
            }
            runtime.revision
        };
        self.microphone_muted.store(false, Ordering::SeqCst);
        #[cfg(target_os = "macos")]
        super::voice_menu_bar::remove(app);
        super::voice_buddy::remove(app);
        if let Some((owner, owner_id)) = owner.as_ref() {
            capture.release_owner(&owner.window_label, owner_id);
        }
        if let (Some(session_id), Some((owner, _))) = (session_id, owner) {
            if let Some(target) = app.get_webview_window(&owner.window_label) {
                let _ = target.emit(
                    EVENT_NAME,
                    NativeVoiceEvent::CleanShutdown {
                        session_id,
                        revision: next_revision,
                    },
                );
            }
        }
        Ok(())
    }

    pub async fn stop_for_model_removal(
        &self,
        app: &AppHandle,
        capture: &VoiceCaptureState,
    ) -> Result<(), String> {
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
        #[cfg(target_os = "macos")]
        super::voice_menu_bar::remove(app);
        super::voice_buddy::remove(app);
        if let (Some(owner), Some(session_id)) = (owner, session_id) {
            capture.release_owner(&owner.window_label, &native_owner_id(&session_id));
            if let Some(window) = app.get_webview_window(&owner.window_label) {
                let _ = window.emit(
                    EVENT_NAME,
                    NativeVoiceEvent::CleanShutdown {
                        session_id,
                        revision: next_revision,
                    },
                );
            }
        }
        Ok(())
    }

    pub fn stop_for_window_destroyed(&self, window_label: &str) -> bool {
        let (session_id, revision, pipeline) = {
            let Ok(mut runtime) = self.runtime.lock() else {
                return false;
            };
            if runtime
                .owner
                .as_ref()
                .is_none_or(|owner| owner.window_label != window_label)
            {
                return false;
            }
            let pipeline = runtime.pipeline.take();
            if let Some(pipeline) = pipeline.as_ref() {
                pipeline.signal_shutdown();
            }
            native_input_mute::stop(&self.input_muted);
            runtime.native_microphone_mute_control = false;
            (runtime.session_id.clone(), runtime.revision, pipeline)
        };
        if pipeline.is_none() {
            if let Ok(mut runtime) = self.runtime.lock() {
                if runtime.revision == revision && runtime.session_id == session_id {
                    runtime.session_id = None;
                    runtime.lifecycle_id = None;
                    runtime.owner = None;
                    runtime.revision = runtime.revision.wrapping_add(1);
                }
            }
            return true;
        }
        let runtime = Arc::clone(&self.runtime);
        tauri::async_runtime::spawn(async move {
            shutdown_pipeline(pipeline.expect("pipeline checked above")).await;
            if let Ok(mut runtime) = runtime.lock() {
                if runtime.revision == revision && runtime.session_id == session_id {
                    runtime.session_id = None;
                    runtime.lifecycle_id = None;
                    runtime.owner = None;
                    runtime.revision = runtime.revision.wrapping_add(1);
                }
            }
        });
        true
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

#[tauri::command]
pub fn set_native_voice_input_muted(
    state: State<'_, NativeVoiceState>,
    webview_window: WebviewWindow,
    session_id: String,
    revision: u64,
    muted: bool,
) -> Result<(), String> {
    let runtime = state
        .runtime
        .lock()
        .map_err(|_| "native voice state lock was poisoned".to_string())?;
    if !owns_native_mute_control(&runtime, webview_window.label(), &session_id, revision) {
        return Err("Native microphone mute is unavailable for this conversation.".to_string());
    }
    native_input_mute::set_muted(&state.input_muted, &state.input_mute_epoch, muted)
}

fn owns_native_mute_control(
    runtime: &Runtime,
    window_label: &str,
    session_id: &str,
    revision: u64,
) -> bool {
    runtime.native_microphone_mute_control
        && runtime.session_id.as_deref() == Some(session_id)
        && runtime.revision == revision
        && runtime
            .owner
            .as_ref()
            .is_some_and(|owner| owner.window_label == window_label)
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

fn stt_worker(
    model_dir: PathBuf,
    audio_rx: Receiver<AudioBatch>,
    event_tx: tokio_mpsc::Sender<SttMessage>,
    shutdown: Arc<AtomicBool>,
    discard_on_shutdown: Arc<AtomicBool>,
    input_muted: Arc<AtomicBool>,
    input_mute_epoch: Arc<AtomicU64>,
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
        let shutting_down = shutdown.load(Ordering::Acquire);
        if shutting_down && (discard_on_shutdown.load(Ordering::Acquire) || batch.is_none()) {
            break;
        }
        let current_mute_epoch = input_mute_epoch.load(Ordering::Acquire);
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
            observed_mute_epoch,
        );
        let _ = delivered_rx.recv_timeout(Duration::from_secs(5));
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

fn flush_speech(
    speech: &[f32],
    recognizer: &sherpa_onnx::OfflineRecognizer,
    event_tx: &tokio_mpsc::Sender<SttMessage>,
    delivered: Option<SyncSender<()>>,
    input_mute_epoch: &AtomicU64,
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
    if input_mute_epoch.load(Ordering::Acquire) != expected_mute_epoch {
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

    #[test]
    fn native_mute_control_is_bound_to_window_session_and_revision() {
        let runtime = Runtime {
            session_id: Some("session-1".to_string()),
            revision: 4,
            owner: Some(RuntimeOwner {
                window_label: "main".to_string(),
            }),
            native_microphone_mute_control: true,
            ..Runtime::default()
        };

        assert!(owns_native_mute_control(&runtime, "main", "session-1", 4));
        assert!(!owns_native_mute_control(&runtime, "other", "session-1", 4));
        assert!(!owns_native_mute_control(&runtime, "main", "session-2", 4));
        assert!(!owns_native_mute_control(&runtime, "main", "session-1", 5));
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
    fn window_destroy_stops_only_its_owned_voice_lifecycle() {
        let state = NativeVoiceState::default();
        {
            let mut runtime = state.runtime.lock().expect("lock native runtime");
            runtime.session_id = Some("session-1".to_string());
            runtime.lifecycle_id = Some("lifecycle-1".to_string());
            runtime.owner = Some(RuntimeOwner {
                window_label: "session-window".to_string(),
            });
        }

        assert!(!state.stop_for_window_destroyed("other-window"));
        assert_eq!(
            state
                .runtime
                .lock()
                .expect("lock native runtime")
                .session_id
                .as_deref(),
            Some("session-1")
        );

        assert!(state.stop_for_window_destroyed("session-window"));
        let runtime = state.runtime.lock().expect("lock native runtime");
        assert!(runtime.session_id.is_none());
        assert!(runtime.owner.is_none());
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
        let discard_on_shutdown = Arc::new(AtomicBool::new(false));
        let mut pipeline = SttPipeline {
            audio_tx: sender,
            shutdown: Arc::new(AtomicBool::new(false)),
            discard_on_shutdown: Arc::clone(&discard_on_shutdown),
            input_muted: Arc::clone(&input_muted),
            input_mute_epoch: Arc::new(AtomicU64::new(0)),
            audio_seen: AtomicBool::new(false),
            thread: None,
        };

        pipeline.begin_shutdown();
        input_muted.store(true, Ordering::Release);

        assert!(!discard_on_shutdown.load(Ordering::Acquire));
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
        push_audio_for_window(&state, "owner-window", vec![0; 4]).expect("owner can send audio");
        assert_eq!(
            receiver.try_recv().expect("owner audio queued").bytes,
            vec![0; 4]
        );
    }

    #[tokio::test]
    async fn window_destroy_schedules_blocked_worker_join_off_callback() {
        let state = NativeVoiceState::default();
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
                audio_seen: AtomicBool::new(false),
                thread: Some(worker),
            });
        }

        let started = std::time::Instant::now();
        assert!(state.stop_for_window_destroyed("owner-window"));
        assert!(started.elapsed() < Duration::from_millis(50));
        assert!(shutdown.load(Ordering::Acquire));
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(state
            .runtime
            .lock()
            .expect("lock native runtime")
            .session_id
            .is_none());
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
    }
}
