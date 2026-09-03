//! Native speech recognition for Desktop voice conversations.

#[cfg(any(test, target_os = "macos"))]
use std::time::Instant;
use std::{
    collections::{HashMap, VecDeque},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};
use tokio::sync::Notify;

use super::mac_speech;
use super::{
    native_input_mute,
    pocket_voice::{parakeet_model_dir, parakeet_model_for_loading},
    voice_capture::VoiceCaptureState,
};

pub(crate) const EVENT_NAME: &str = "voice-conversation:event";
const MAX_PENDING_TRANSCRIPTS: usize = 64;
const MAX_TRANSCRIPT_DELIVERY_ATTEMPTS: u8 = 3;
const VAD_THRESHOLD: f32 = 0.5;
const INPUT_STARTUP_TIMEOUT: Duration = Duration::from_secs(60);

#[cfg(any(test, target_os = "macos"))]
pub(crate) fn output_latency_grace_elapsed(
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
pub(crate) fn output_latency_grace_remaining(
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

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum VoiceInputBackend {
    Parakeet,
    Macos,
    Openai,
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

#[derive(Clone, Debug, Deserialize, Eq, Hash, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VoiceTranscriptReference {
    lifecycle_id: String,
    id: String,
    revision: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepareAssistantSpeechRequest {
    session_id: String,
    expected_revision: u64,
    text: String,
    acknowledgement: Option<VoiceTranscriptReference>,
    renderer_id: String,
    renderer_epoch: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(
    tag = "outcome",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum PrepareAssistantSpeechOutcome {
    Pending,
    NotAdmitted,
    Admitted { speech_id: u64 },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelAssistantSpeechRequest {
    session_id: String,
    expected_revision: u64,
    speech_id: u64,
    renderer_id: String,
    renderer_epoch: u64,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum InterruptionSensitivity {
    Less,
    Balanced,
    More,
}

impl InterruptionSensitivity {
    pub(crate) fn vad_threshold(self) -> f32 {
        match self {
            Self::Less => 0.8,
            Self::Balanced => 0.65,
            Self::More => VAD_THRESHOLD,
        }
    }
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
    pipeline: Option<berd_voice::input::VoiceInputRuntime>,
    controls_ready: bool,
    controls_suppressed: bool,
    controls_visibility_generation: u64,
    controls_window_revision: Option<u64>,
    native_microphone_mute_control: bool,
    admission: Option<Arc<BerdAdmissionCoordinator>>,
    voice_input_quarantined: bool,
}

#[derive(Debug)]
struct ActiveAdmission {
    speech_id: u64,
    playback_active: Option<Arc<AtomicBool>>,
}

#[derive(Debug, Default)]
struct BerdAdmissionInner {
    core: berd_voice::session::SessionCore,
    next_token: u64,
    tokens: HashMap<VoiceTranscriptReference, u64>,
    active: Option<ActiveAdmission>,
    closed: bool,
}

#[derive(Debug, Default)]
struct BerdAdmissionCoordinator {
    inner: Mutex<BerdAdmissionInner>,
    changed: Notify,
}

impl BerdAdmissionCoordinator {
    fn add_final(&self, reference: VoiceTranscriptReference, text: String) -> Result<u64, String> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "voice admission lock was poisoned".to_string())?;
        if inner.closed {
            return Err("The voice conversation is no longer running.".to_string());
        }
        let token = inner.next_token.saturating_add(1);
        inner.core.add_final(token, text)?;
        inner.next_token = token;
        inner.tokens.insert(reference, token);
        Self::interrupt_locked(&mut inner);
        drop(inner);
        self.changed.notify_waiters();
        Ok(token)
    }

    fn confirm(&self, reference: &VoiceTranscriptReference) -> Result<bool, String> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "voice admission lock was poisoned".to_string())?;
        let confirmed = inner
            .tokens
            .get(reference)
            .copied()
            .is_some_and(|token| inner.core.confirm_exact(token));
        drop(inner);
        if confirmed {
            self.changed.notify_waiters();
        }
        Ok(confirmed)
    }

    fn discard(&self, reference: &VoiceTranscriptReference) -> Result<bool, String> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "voice admission lock was poisoned".to_string())?;
        let discarded = inner
            .tokens
            .get(reference)
            .copied()
            .is_some_and(|token| inner.core.discard_final(token));
        if discarded {
            inner.tokens.remove(reference);
        }
        drop(inner);
        if discarded {
            self.changed.notify_waiters();
        }
        Ok(discarded)
    }

    fn set_user_speaking(&self, active: bool) {
        if let Ok(mut inner) = self.inner.lock() {
            if inner.core.set_user_speaking(active) {
                Self::interrupt_locked(&mut inner);
            }
        }
        self.changed.notify_waiters();
    }

    fn set_recognition_pending(&self, active: bool) {
        if let Ok(mut inner) = self.inner.lock() {
            if inner.core.set_recognition_pending(active) {
                Self::interrupt_locked(&mut inner);
            }
        }
        self.changed.notify_waiters();
    }

    async fn prepare(
        &self,
        text: String,
        acknowledgement: Option<VoiceTranscriptReference>,
    ) -> Result<PrepareAssistantSpeechOutcome, String> {
        loop {
            let notified = self.changed.notified();
            let outcome = {
                let mut inner = self
                    .inner
                    .lock()
                    .map_err(|_| "voice admission lock was poisoned".to_string())?;
                if inner.closed {
                    return Err("The voice conversation is no longer running.".to_string());
                }
                let acknowledgement = match acknowledgement.as_ref() {
                    Some(reference) => {
                        let Some(token) = inner.tokens.get(reference).copied() else {
                            return Ok(PrepareAssistantSpeechOutcome::Pending);
                        };
                        Some(token)
                    }
                    None => None,
                };
                match inner.core.prepare_after_host_confirmation(
                    berd_voice::session::PrepareRequest {
                        id: 0,
                        acknowledgement,
                        text: text.clone(),
                    },
                ) {
                    berd_voice::session::PrepareOutcome::Hold => None,
                    berd_voice::session::PrepareOutcome::Pending(_) => {
                        Some(PrepareAssistantSpeechOutcome::Pending)
                    }
                    berd_voice::session::PrepareOutcome::NotAdmitted(_) => {
                        Some(PrepareAssistantSpeechOutcome::NotAdmitted)
                    }
                    berd_voice::session::PrepareOutcome::Admitted { speech_id, .. } => {
                        inner.active = Some(ActiveAdmission {
                            speech_id,
                            playback_active: None,
                        });
                        Some(PrepareAssistantSpeechOutcome::Admitted { speech_id })
                    }
                }
            };
            if let Some(outcome) = outcome {
                return Ok(outcome);
            }
            notified.await;
        }
    }

    #[cfg(any(test, target_os = "macos"))]
    fn claim(
        self: &Arc<Self>,
        speech_id: u64,
        playback_active: Arc<AtomicBool>,
    ) -> Result<Option<AdmissionPlaybackGuard>, String> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "voice admission lock was poisoned".to_string())?;
        let owns_reservation = inner
            .active
            .as_ref()
            .is_some_and(|active| active.speech_id == speech_id);
        if inner.closed || !owns_reservation || !inner.core.mark_started(speech_id) {
            return Ok(None);
        }
        if let Some(active) = inner.active.as_mut() {
            active.playback_active = Some(playback_active);
        }
        Ok(Some(AdmissionPlaybackGuard {
            coordinator: Arc::clone(self),
            speech_id,
        }))
    }

    fn cancel(&self, speech_id: u64) -> Result<bool, String> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "voice admission lock was poisoned".to_string())?;
        let Some(active) = inner.active.as_ref() else {
            return Ok(false);
        };
        if active.speech_id != speech_id {
            return Ok(false);
        }
        if let Some(playback_active) = active.playback_active.as_ref() {
            playback_active.store(false, Ordering::SeqCst);
        } else {
            inner.core.finish(speech_id);
            inner.active = None;
        }
        drop(inner);
        self.changed.notify_waiters();
        Ok(true)
    }

    #[cfg(any(test, target_os = "macos"))]
    fn finish(&self, speech_id: u64) {
        if let Ok(mut inner) = self.inner.lock() {
            if inner
                .active
                .as_ref()
                .is_some_and(|active| active.speech_id == speech_id)
            {
                inner.core.finish(speech_id);
                inner.active = None;
            }
        }
        self.changed.notify_waiters();
    }

    fn close(&self) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.closed = true;
            if let Some(active) = inner.active.take() {
                if let Some(playback_active) = active.playback_active {
                    playback_active.store(false, Ordering::SeqCst);
                }
                inner.core.finish(active.speech_id);
            }
        }
        self.changed.notify_waiters();
    }

    fn interrupt_locked(inner: &mut BerdAdmissionInner) {
        let Some(active) = inner.active.as_ref() else {
            return;
        };
        if let Some(playback_active) = active.playback_active.as_ref() {
            playback_active.store(false, Ordering::SeqCst);
        } else {
            let speech_id = active.speech_id;
            inner.core.finish(speech_id);
            inner.active = None;
        }
    }
}

#[must_use = "voice admission remains active until the backend terminal path drops this guard"]
#[cfg(any(test, target_os = "macos"))]
pub(crate) struct AdmissionPlaybackGuard {
    coordinator: Arc<BerdAdmissionCoordinator>,
    speech_id: u64,
}

#[cfg(any(test, target_os = "macos"))]
impl Drop for AdmissionPlaybackGuard {
    fn drop(&mut self) {
        self.coordinator.finish(self.speech_id);
    }
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
    Option<berd_voice::input::VoiceInputRuntime>,
    Option<(RuntimeOwner, String)>,
);

struct StopCompletion {
    session_id: String,
    controls_revision: u64,
    next_revision: u64,
    owner: RuntimeOwner,
    owner_id: String,
    shutdown_error: Option<String>,
}

#[derive(Clone, Default)]
pub struct NativeVoiceState {
    runtime: Arc<Mutex<Runtime>>,
    stop_serial: Arc<tokio::sync::Mutex<()>>,
    start_blocks: Arc<Mutex<HashMap<String, Vec<VoiceStartBlock>>>>,
    pending: Arc<Mutex<VecDeque<PendingTranscript>>>,
    microphone_muted: Arc<AtomicBool>,
    input_controls: berd_voice::input::VoiceInputControls,
}

#[must_use = "assistant speech policy ends when the guard is dropped"]
pub(crate) struct AssistantSpeechGuard {
    _activity: Option<berd_voice::input::AssistantActivityGuard>,
}

impl NativeVoiceState {
    fn ensure_voice_input_not_quarantined(&self) -> Result<(), String> {
        let runtime = self
            .runtime
            .lock()
            .map_err(|_| "native voice state lock was poisoned".to_string())?;
        if runtime.voice_input_quarantined {
            Err("Voice recognition did not stop safely. Restart Berd before starting another voice conversation.".to_string())
        } else {
            Ok(())
        }
    }

    fn record_voice_input_finish(
        &self,
        result: Result<(), berd_voice::input::VoiceInputFinishError>,
    ) -> Option<String> {
        let error = result.err()?;
        log::error!("Native voice recognizer shutdown failed: {error}");
        if error.is_quarantined() {
            if let Ok(mut runtime) = self.runtime.lock() {
                runtime.voice_input_quarantined = true;
            }
            Some("Voice recognition did not stop safely. Restart Berd before starting another voice conversation.".to_string())
        } else {
            Some(error.to_string())
        }
    }

    async fn finish_uninstalled_pipeline(
        &self,
        pipeline: berd_voice::input::VoiceInputRuntime,
        startup_error: String,
    ) -> String {
        self.record_voice_input_finish(shutdown_pipeline(pipeline).await)
            .unwrap_or(startup_error)
    }

    fn admission_target(
        &self,
        caller_window_label: &str,
        session_id: &str,
        expected_revision: u64,
    ) -> Result<Option<Arc<BerdAdmissionCoordinator>>, String> {
        let runtime = self
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
            return Err("Only the voice conversation owner can prepare assistant speech.".into());
        }
        Ok(runtime.admission.clone())
    }

    #[cfg(target_os = "macos")]
    pub(crate) fn claim_assistant_speech(
        &self,
        session_id: &str,
        expected_revision: u64,
        speech_id: u64,
        playback_active: Arc<AtomicBool>,
    ) -> Result<Option<AdmissionPlaybackGuard>, String> {
        let admission = {
            let runtime = self
                .runtime
                .lock()
                .map_err(|_| "native voice state lock was poisoned".to_string())?;
            if runtime.session_id.as_deref() != Some(session_id)
                || runtime.revision != expected_revision
            {
                return Ok(None);
            }
            runtime.admission.clone()
        };
        admission
            .ok_or_else(|| "Voice admission is not available.".to_string())?
            .claim(speech_id, playback_active)
    }

    fn acknowledge_transcript(
        &self,
        session_id: &str,
        id: &str,
        revision: u64,
    ) -> Result<(), String> {
        let admission = self.runtime.lock().ok().and_then(|runtime| {
            (runtime.session_id.as_deref() == Some(session_id) && runtime.revision == revision)
                .then(|| runtime.admission.clone())
                .flatten()
        });
        let mut pending = self
            .pending
            .lock()
            .map_err(|_| "native transcript queue lock was poisoned".to_string())?;
        if let Some(index) = pending.iter().position(|item| {
            item.session_id == session_id && item.id == id && item.revision == revision
        }) {
            let transcript = &pending[index];
            if let Some(admission) = admission {
                let reference = VoiceTranscriptReference {
                    lifecycle_id: transcript.lifecycle_id.clone(),
                    id: transcript.id.clone(),
                    revision,
                };
                if !admission.confirm(&reference)? {
                    return Err("The voice transcript is not tracked by admission.".to_string());
                }
            }
            pending.remove(index);
        }
        Ok(())
    }

    fn reject_transcript(
        &self,
        session_id: &str,
        id: &str,
        revision: u64,
    ) -> Result<TranscriptRejection, String> {
        let admission = self.runtime.lock().ok().and_then(|runtime| {
            (runtime.session_id.as_deref() == Some(session_id) && runtime.revision == revision)
                .then(|| runtime.admission.clone())
                .flatten()
        });
        let mut pending = self
            .pending
            .lock()
            .map_err(|_| "native transcript queue lock was poisoned".to_string())?;
        reject_pending_transcript(&mut pending, session_id, id, revision, admission.as_deref())
    }

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

    pub(crate) fn begin_assistant_speech(
        &self,
        sensitivity: InterruptionSensitivity,
        input_during_tts: berd_voice::input::InputDuringTtsPolicy,
    ) -> AssistantSpeechGuard {
        let activity = self
            .input_controls
            .begin_assistant_activity(sensitivity.vad_threshold(), input_during_tts)
            .ok();
        AssistantSpeechGuard {
            _activity: activity,
        }
    }

    pub fn microphone_is_muted(&self) -> bool {
        self.microphone_muted.load(Ordering::SeqCst) || self.input_controls.is_host_muted()
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
                native_input_mute::set_muted(muted)?;
            }
            // Native input mute is authoritative when installed so a hardware
            // unmute cannot be masked by a stale renderer fallback latch.
            let software_muted = software_microphone_mute(native_microphone_mute_control, muted);
            self.microphone_muted
                .store(software_muted, Ordering::SeqCst);
            self.input_controls.set_host_muted(muted);
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

async fn shutdown_pipeline(
    pipeline: berd_voice::input::VoiceInputRuntime,
) -> Result<(), berd_voice::input::VoiceInputFinishError> {
    pipeline.finish().await
}
async fn status_with_availability<F, Fut>(
    state: &NativeVoiceState,
    parakeet_available: bool,
    mut macos_status: F,
) -> NativeVoiceStatus
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = bool>,
{
    let (session_active, revision_before_availability, quarantined_before_availability) = {
        let runtime = state
            .runtime
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        (
            runtime.session_id.is_some(),
            runtime.revision,
            runtime.voice_input_quarantined,
        )
    };
    let macos_available = if !quarantined_before_availability
        && needs_macos_status(session_active, parakeet_available)
    {
        macos_status().await
    } else {
        false
    };
    let mut snapshot = {
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
            runtime.voice_input_quarantined,
        )
    };
    let macos_available = if !snapshot.3
        && snapshot.2 != revision_before_availability
        && needs_macos_status(snapshot.0.is_some(), parakeet_available)
    {
        let available = macos_status().await;
        snapshot = {
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
                runtime.voice_input_quarantined,
            )
        };
        available
    } else {
        macos_available
    };
    let (session_id, owner_window_label, revision, voice_input_quarantined) = snapshot;
    let (available, unavailable_reason) = if voice_input_quarantined {
        (
                false,
                Some("Voice recognition did not stop safely. Restart Berd before starting another voice conversation.".to_string()),
            )
    } else if session_id.is_some() || parakeet_available || macos_available {
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

async fn status(app: &AppHandle, state: &NativeVoiceState) -> NativeVoiceStatus {
    let parakeet_available = parakeet_model_dir(app).is_ok()
        || app
            .state::<super::openai_audio::OpenAiVoiceState>()
            .is_configured();
    #[cfg(target_os = "macos")]
    let macos_status = || async {
        mac_speech::status_async()
            .await
            .map(|status| status.model_installed)
            .unwrap_or(false)
    };
    #[cfg(not(target_os = "macos"))]
    let macos_status = || async { false };
    status_with_availability(state, parakeet_available, macos_status).await
}

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
pub async fn prepare_native_voice_assistant_speech(
    state: State<'_, NativeVoiceState>,
    capture: State<'_, VoiceCaptureState>,
    webview_window: WebviewWindow,
    request: PrepareAssistantSpeechRequest,
) -> Result<PrepareAssistantSpeechOutcome, String> {
    let admission = capture.with_active_renderer(
        webview_window.label(),
        &request.renderer_id,
        request.renderer_epoch,
        || {
            state.admission_target(
                webview_window.label(),
                &request.session_id,
                request.expected_revision,
            )
        },
    )?;
    let Some(admission) = admission else {
        return Ok(PrepareAssistantSpeechOutcome::NotAdmitted);
    };
    admission
        .prepare(request.text, request.acknowledgement)
        .await
}

#[tauri::command]
pub fn cancel_native_voice_assistant_speech(
    state: State<'_, NativeVoiceState>,
    capture: State<'_, VoiceCaptureState>,
    webview_window: WebviewWindow,
    request: CancelAssistantSpeechRequest,
) -> Result<bool, String> {
    let admission = capture.with_active_renderer(
        webview_window.label(),
        &request.renderer_id,
        request.renderer_epoch,
        || {
            state.admission_target(
                webview_window.label(),
                &request.session_id,
                request.expected_revision,
            )
        },
    )?;
    match admission {
        Some(admission) => admission.cancel(request.speech_id),
        None => Ok(false),
    }
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
    state.acknowledge_transcript(&session_id, &id, revision)
}

#[tauri::command]
pub fn reject_native_voice_conversation_transcript(
    state: State<'_, NativeVoiceState>,
    session_id: String,
    id: String,
    revision: u64,
) -> Result<TranscriptRejection, String> {
    state.reject_transcript(&session_id, &id, revision)
}

fn reject_pending_transcript(
    pending: &mut VecDeque<PendingTranscript>,
    session_id: &str,
    id: &str,
    revision: u64,
    admission: Option<&BerdAdmissionCoordinator>,
) -> Result<TranscriptRejection, String> {
    let Some(index) = pending.iter().position(|item| {
        item.session_id == session_id && item.id == id && item.revision == revision
    }) else {
        return Ok(TranscriptRejection {
            attempts: MAX_TRANSCRIPT_DELIVERY_ATTEMPTS,
            terminal: true,
        });
    };
    let attempts = pending[index].delivery_attempts.saturating_add(1);
    let terminal = attempts >= MAX_TRANSCRIPT_DELIVERY_ATTEMPTS;
    if terminal {
        if let Some(admission) = admission {
            let transcript = &pending[index];
            let reference = VoiceTranscriptReference {
                lifecycle_id: transcript.lifecycle_id.clone(),
                id: transcript.id.clone(),
                revision,
            };
            if !admission.discard(&reference)? {
                return Err("The voice transcript is not tracked by admission.".to_string());
            }
        }
        pending.remove(index);
    } else {
        pending[index].delivery_attempts = attempts;
    }
    Ok(TranscriptRejection { attempts, terminal })
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
    if app
        .try_state::<super::voice_buddy::RealtimeVoiceControlsState>()
        .is_some_and(|state| state.active_target().is_some())
    {
        return Err("An OpenAI Realtime voice conversation is already active.".to_string());
    }
    state.ensure_voice_input_not_quarantined()?;
    if input_backend == VoiceInputBackend::Macos
        && !mac_speech::status_async().await?.model_installed
    {
        return Err(
            "Download the macOS speech recognition model before starting a call.".to_string(),
        );
    }
    let openai_api_key = if input_backend == VoiceInputBackend::Openai {
        Some(super::openai_audio::stt_api_key()?)
    } else {
        None
    };
    if openai_api_key.is_some() {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(1);
        while !webview_window.is_focused().unwrap_or(false)
            && tokio::time::Instant::now() < deadline
        {
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
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
    let mut parakeet_assets = None;
    let engine = match input_backend {
        VoiceInputBackend::Parakeet => {
            parakeet_model_for_loading(&app).map(|(model_dir, assets)| {
                parakeet_assets = Some(assets);
                berd_voice::input::VoiceInputEngineConfig::Parakeet { model_dir }
            })
        }
        VoiceInputBackend::Macos => {
            #[cfg(target_os = "macos")]
            {
                Ok(berd_voice::input::VoiceInputEngineConfig::MacSpeech)
            }
            #[cfg(not(target_os = "macos"))]
            {
                if microphone_claimed {
                    capture.release_microphone(
                        &window_label,
                        &renderer_id,
                        renderer_epoch,
                        &owner_id,
                    );
                }
                return Err("macOS speech recognition requires macOS 26 or later.".to_string());
            }
        }
        VoiceInputBackend::Openai => super::openai_audio::realtime_endpoint().map(|endpoint| {
            berd_voice::input::VoiceInputEngineConfig::OpenAi {
                endpoint,
                api_key: openai_api_key.expect("OpenAI key resolved for OpenAI input"),
                model: super::openai_audio::transcription_model(),
            }
        }),
    };
    let engine = match engine {
        Ok(engine) => engine,
        Err(error) => {
            if microphone_claimed {
                capture.release_microphone(&window_label, &renderer_id, renderer_epoch, &owner_id);
            }
            return Err(error);
        }
    };
    let pipeline =
        berd_voice::input::VoiceInputRuntime::start(berd_voice::input::VoiceInputConfig {
            engine,
            speech_vad_threshold: VAD_THRESHOLD,
            controls: state.input_controls.clone(),
        });
    let (pipeline, mut events) = match pipeline {
        Ok(result) => result,
        Err(error) => {
            if microphone_claimed {
                capture.release_microphone(&window_label, &renderer_id, renderer_epoch, &owner_id);
            }
            return Err(error);
        }
    };
    let readiness = match tokio::time::timeout(INPUT_STARTUP_TIMEOUT, events.recv()).await {
        Ok(Some(berd_voice::input::VoiceInputEvent::Ready)) => Ok(()),
        Ok(Some(berd_voice::input::VoiceInputEvent::Failed(error))) => Err(error),
        Ok(Some(_)) => Err("Voice input emitted activity before it was ready.".to_string()),
        Ok(None) => Err("Voice input stopped before it was ready.".to_string()),
        Err(_) => Err("Voice input did not become ready within 60 seconds.".to_string()),
    };
    if let Err(error) = readiness {
        let error = state.finish_uninstalled_pipeline(pipeline, error).await;
        if microphone_claimed {
            capture.release_microphone(&window_label, &renderer_id, renderer_epoch, &owner_id);
        }
        return Err(error);
    }
    drop(parakeet_assets);
    let input_controls = pipeline.controls();
    if let Err(error) = validate_voice_target_session(
        capture.inner(),
        &window_sessions,
        &webview_window,
        &renderer_id,
        renderer_epoch,
        &session_id,
        Some(foreground_generation),
    ) {
        let error = state.finish_uninstalled_pipeline(pipeline, error).await;
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
            let error = state.finish_uninstalled_pipeline(pipeline, error).await;
            drop(lifecycle_guard);
            if microphone_claimed {
                capture.release_microphone(&window_label, &renderer_id, renderer_epoch, &owner_id);
            }
            return Err(error);
        }
    }
    let mut pipeline = Some(pipeline);
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
        if runtime.voice_input_quarantined {
            return Err("Voice recognition did not stop safely. Restart Berd before starting another voice conversation.".to_string());
        }
        if runtime.session_id.is_some() {
            return Err("A native voice conversation is already active.".to_string());
        }
        runtime.revision = runtime.revision.wrapping_add(1);
        runtime.session_id = Some(session_id.clone());
        runtime.lifecycle_id = Some(uuid::Uuid::new_v4().to_string());
        runtime.owner = Some(RuntimeOwner {
            window_label: window_label.clone(),
        });
        runtime.pipeline = pipeline.take();
        runtime.admission = Some(Arc::new(BerdAdmissionCoordinator::default()));
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
        let native_input_controls = input_controls.clone();
        runtime.native_microphone_mute_control = native_input_mute::start(move |muted| {
            native_input_controls.set_host_muted(muted);
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
            let error = match pipeline.take() {
                Some(pipeline) => state.finish_uninstalled_pipeline(pipeline, error).await,
                None => error,
            };
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
    let admission = state
        .runtime
        .lock()
        .ok()
        .and_then(|runtime| runtime.admission.clone())
        .ok_or_else(|| "Voice admission was not initialized.".to_string())?;
    let event_state = state.inner().clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = events.recv().await {
            let active = runtime.lock().ok().is_some_and(|current| {
                current.session_id.as_deref() == Some(session_id.as_str())
                    && current.revision == revision
                    && !current.voice_input_quarantined
            });
            if !active {
                break;
            }
            match event {
                berd_voice::input::VoiceInputEvent::Ready => {
                    log::warn!("Voice input emitted duplicate readiness");
                }
                berd_voice::input::VoiceInputEvent::SpeakingChanged(speaking) => {
                    admission.set_user_speaking(speaking);
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
                berd_voice::input::VoiceInputEvent::RecognitionPendingChanged(pending) => {
                    admission.set_recognition_pending(pending);
                    // The runtime owns recognition-pending sequencing. Berd's
                    // renderer does not project that state yet.
                }
                berd_voice::input::VoiceInputEvent::FinalTranscript {
                    text,
                    storage_receipt,
                } => {
                    let transcript = PendingTranscript {
                        session_id: session_id.clone(),
                        lifecycle_id: lifecycle_id.clone(),
                        id: uuid::Uuid::new_v4().to_string(),
                        text,
                        revision,
                        delivery_attempts: 0,
                    };
                    let Ok(disposition) = store_final_if_active(
                        &runtime,
                        &pending,
                        &admission,
                        &session_id,
                        revision,
                        transcript.clone(),
                        || storage_receipt.stored(),
                    ) else {
                        break;
                    };
                    let StoredFinal::Stored { evicted } = disposition else {
                        break;
                    };
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
                }
                berd_voice::input::VoiceInputEvent::Failed(message) => {
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
                        native_input_mute::stop();
                        event_state.input_controls.set_host_muted(false);
                        current.native_microphone_mute_control = false;
                        if let Some(admission) = current.admission.take() {
                            admission.close();
                        }
                        current.session_id = None;
                        current.lifecycle_id = None;
                        current.owner = None;
                        current.revision = current.revision.wrapping_add(1);
                        current.pipeline.take()
                    };
                    let shutdown_error = match pipeline {
                        Some(pipeline) => {
                            event_state.record_voice_input_finish(shutdown_pipeline(pipeline).await)
                        }
                        None => None,
                    };
                    event_state.microphone_muted.store(false, Ordering::SeqCst);
                    event_app
                        .state::<VoiceCaptureState>()
                        .release_owner(&window_label, &owner_id);
                    let terminal_event = NativeVoiceEvent::Error {
                        session_id: Some(session_id.clone()),
                        message: shutdown_error.unwrap_or(message),
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

fn caller_owns_target(
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
    if !caller_owns_target(
        webview_window.label(),
        target_owner.as_deref(),
        owns_foreground_session,
    ) {
        return Err("The target session is no longer in the foreground.".to_string());
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
    pub(crate) fn register_controls_window(
        &self,
        session_id: &str,
        expected_revision: u64,
    ) -> Result<(), String> {
        let mut runtime = self
            .runtime
            .lock()
            .map_err(|_| "native voice state lock was poisoned".to_string())?;
        if runtime.session_id.as_deref() != Some(session_id)
            || runtime.revision != expected_revision
        {
            return Err("The voice conversation changed while its controls were opening.".into());
        }
        runtime.controls_window_revision = Some(expected_revision);
        Ok(())
    }

    pub(crate) fn controls_window_revision(&self) -> Option<u64> {
        self.runtime
            .lock()
            .ok()
            .and_then(|runtime| runtime.controls_window_revision)
    }

    pub(crate) fn controls_window_matches_active_lifecycle(&self) -> bool {
        self.runtime.lock().ok().is_some_and(|runtime| {
            runtime.session_id.is_some()
                && runtime.controls_window_revision == Some(runtime.revision)
        })
    }

    pub(crate) fn clear_controls_window_if_revision(&self, expected_revision: Option<u64>) {
        if let Ok(mut runtime) = self.runtime.lock() {
            if runtime.controls_window_revision == expected_revision {
                runtime.controls_window_revision = None;
            }
        }
    }

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

    pub(crate) async fn stop_active_then<T, F>(
        &self,
        app: &AppHandle,
        capture: &VoiceCaptureState,
        action: F,
    ) -> Result<T, String>
    where
        F: FnOnce() -> Result<T, String>,
    {
        let _stop_guard = self.stop_serial.lock().await;
        self.stop_active_inner_locked(app, capture, None).await?;
        action()
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
            shutdown_error,
        }) = completion
        else {
            return Ok(false);
        };
        if let Some(failure_message) = shutdown_error.as_deref().or(failure_message) {
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
        // that misses the deadline is quarantined; its revision-bound late
        // events are discarded and this process cannot start a replacement.
        let shutdown_error = match pipeline {
            Some(pipeline) => self.record_voice_input_finish(shutdown_pipeline(pipeline).await),
            None => None,
        };
        let (stopped, next_revision) = {
            let mut runtime = self
                .runtime
                .lock()
                .map_err(|_| "native voice state lock was poisoned".to_string())?;
            let stopped = runtime.revision == revision && runtime.session_id == session_id;
            if stopped {
                native_input_mute::stop();
                self.input_controls.set_host_muted(false);
                runtime.native_microphone_mute_control = false;
                if let Some(admission) = runtime.admission.take() {
                    admission.close();
                }
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
            shutdown_error,
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
        let shutdown_error = match pipeline {
            Some(pipeline) => self.record_voice_input_finish(shutdown_pipeline(pipeline).await),
            None => None,
        };
        let next_revision = {
            let mut runtime = self
                .runtime
                .lock()
                .map_err(|_| "native voice state lock was poisoned".to_string())?;
            if runtime.revision == revision && runtime.session_id == session_id {
                native_input_mute::stop();
                self.input_controls.set_host_muted(false);
                runtime.native_microphone_mute_control = false;
                if let Some(admission) = runtime.admission.take() {
                    admission.close();
                }
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
            if let Some(message) = shutdown_error {
                let failure_event = NativeVoiceEvent::Error {
                    session_id: Some(session_id.clone()),
                    message,
                    revision: next_revision,
                    terminal: true,
                };
                if let Some(window) = app.get_webview_window(&owner.window_label) {
                    let _ = window.emit(EVENT_NAME, failure_event.clone());
                }
                super::voice_buddy::emit(app, failure_event);
            }
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
                if pipeline.controls().is_muted() {
                    pipeline.cancel();
                }
            }
            native_input_mute::stop();
            self.input_controls.set_host_muted(false);
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
                if let Some(admission) = runtime.admission.take() {
                    admission.close();
                }
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
    app.state::<super::openai_audio::OpenAiVoiceState>()
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
    if let Some(pipeline) = runtime.pipeline.as_ref() {
        if pipeline.controls().is_muted() {
            return Ok(());
        }
        pipeline.try_push_frame(decode_voice_input_frame(&bytes)?)?;
    }
    Ok(())
}

fn decode_voice_input_frame(bytes: &[u8]) -> Result<berd_voice::input::VoiceInputFrame, String> {
    if bytes.len() != berd_voice::input::INPUT_FRAME_SAMPLES * size_of::<f32>() {
        return Err(format!(
            "native voice audio must contain exactly {} mono f32 samples",
            berd_voice::input::INPUT_FRAME_SAMPLES
        ));
    }
    let samples = bytes
        .chunks_exact(size_of::<f32>())
        .map(|sample| f32::from_le_bytes(sample.try_into().expect("four-byte chunk")))
        .collect::<Vec<_>>();
    berd_voice::input::VoiceInputFrame::try_from_samples(&samples)
}

#[cfg(test)]
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

#[derive(Debug)]
enum StoredFinal {
    Stored { evicted: Option<PendingTranscript> },
    Inactive,
}

fn store_final_if_active(
    runtime: &Mutex<Runtime>,
    pending: &Mutex<VecDeque<PendingTranscript>>,
    admission: &BerdAdmissionCoordinator,
    expected_session_id: &str,
    expected_revision: u64,
    transcript: PendingTranscript,
    mark_stored: impl FnOnce(),
) -> Result<StoredFinal, String> {
    let runtime = runtime
        .lock()
        .map_err(|_| "native voice state lock was poisoned".to_string())?;
    if runtime.session_id.as_deref() != Some(expected_session_id)
        || runtime.revision != expected_revision
        || runtime.voice_input_quarantined
    {
        return Ok(StoredFinal::Inactive);
    }
    let mut pending = pending
        .lock()
        .map_err(|_| "pending transcript lock was poisoned".to_string())?;
    let reference = VoiceTranscriptReference {
        lifecycle_id: transcript.lifecycle_id.clone(),
        id: transcript.id.clone(),
        revision: transcript.revision,
    };
    let evicted = (pending.len() >= MAX_PENDING_TRANSCRIPTS)
        .then(|| pending.front().cloned())
        .flatten();
    admission.add_final(reference, transcript.text.clone())?;
    if let Some(evicted) = evicted.as_ref() {
        if evicted.session_id == transcript.session_id
            && evicted.lifecycle_id == transcript.lifecycle_id
            && evicted.revision == transcript.revision
        {
            let evicted_reference = VoiceTranscriptReference {
                lifecycle_id: evicted.lifecycle_id.clone(),
                id: evicted.id.clone(),
                revision: evicted.revision,
            };
            if !admission.discard(&evicted_reference)? {
                return Err("The evicted voice transcript is not tracked by admission.".to_string());
            }
        }
        pending.pop_front();
    }
    pending.push_back(transcript);
    drop(pending);
    drop(runtime);
    // This acknowledgement is the durability boundary. UI delivery below is
    // best effort and must not delay or decide whether the engine may finish.
    mark_stored();
    Ok(StoredFinal::Stored { evicted })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{thread, time::Instant};

    fn pending_transcript(
        session_id: &str,
        lifecycle_id: &str,
        id: &str,
        revision: u64,
    ) -> PendingTranscript {
        PendingTranscript {
            session_id: session_id.to_string(),
            lifecycle_id: lifecycle_id.to_string(),
            id: id.to_string(),
            text: format!("text-{id}"),
            revision,
            delivery_attempts: 0,
        }
    }

    #[test]
    fn final_that_linearizes_before_stop_is_stored_and_acknowledged_once() {
        let runtime = Arc::new(Mutex::new(Runtime {
            session_id: Some("session-a".into()),
            lifecycle_id: Some("lifecycle-a".into()),
            revision: 4,
            ..Runtime::default()
        }));
        let pending = Arc::new(Mutex::new(VecDeque::new()));
        let admission = Arc::new(BerdAdmissionCoordinator::default());
        let acknowledgements = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let pending_gate = pending.lock().expect("hold pending queue");

        let final_thread = {
            let runtime = Arc::clone(&runtime);
            let pending = Arc::clone(&pending);
            let pending_at_ack = Arc::clone(&pending);
            let admission = Arc::clone(&admission);
            let acknowledgements = Arc::clone(&acknowledgements);
            thread::spawn(move || {
                store_final_if_active(
                    &runtime,
                    &pending,
                    &admission,
                    "session-a",
                    4,
                    pending_transcript("session-a", "lifecycle-a", "final", 4),
                    || {
                        assert_eq!(
                            pending_at_ack.lock().expect("inspect stored final")[0].id,
                            "final"
                        );
                        acknowledgements.fetch_add(1, Ordering::SeqCst);
                    },
                )
                .expect("store final")
            })
        };
        let deadline = Instant::now() + Duration::from_secs(1);
        while runtime.try_lock().is_ok() && Instant::now() < deadline {
            thread::yield_now();
        }
        assert!(runtime.try_lock().is_err(), "final holds lifecycle lock");
        let close_thread = {
            let runtime = Arc::clone(&runtime);
            thread::spawn(move || {
                let mut runtime = runtime.lock().expect("close lifecycle");
                runtime.session_id = None;
                runtime.lifecycle_id = None;
                runtime.revision += 1;
            })
        };
        drop(pending_gate);

        assert!(matches!(
            final_thread.join().expect("join final"),
            StoredFinal::Stored { .. }
        ));
        close_thread.join().expect("join close");
        assert_eq!(acknowledgements.load(Ordering::SeqCst), 1);
        assert_eq!(pending.lock().expect("pending queue").len(), 1);
        let admission = admission.inner.lock().expect("admission state");
        assert_eq!(admission.next_token, 1);
        assert_eq!(admission.tokens.len(), 1);
        assert_eq!(admission.core.utterances_after(0).len(), 1);
    }

    #[test]
    fn stop_that_linearizes_before_final_drops_without_acknowledging() {
        let runtime = Arc::new(Mutex::new(Runtime {
            session_id: Some("session-a".into()),
            lifecycle_id: Some("lifecycle-a".into()),
            revision: 4,
            ..Runtime::default()
        }));
        let pending = Arc::new(Mutex::new(VecDeque::new()));
        let admission = Arc::new(BerdAdmissionCoordinator::default());
        let acknowledgements = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let mut close = runtime.lock().expect("hold lifecycle for stop");
        let final_thread = {
            let runtime = Arc::clone(&runtime);
            let pending = Arc::clone(&pending);
            let admission = Arc::clone(&admission);
            let acknowledgements = Arc::clone(&acknowledgements);
            thread::spawn(move || {
                store_final_if_active(
                    &runtime,
                    &pending,
                    &admission,
                    "session-a",
                    4,
                    pending_transcript("session-a", "lifecycle-a", "late", 4),
                    || {
                        acknowledgements.fetch_add(1, Ordering::SeqCst);
                    },
                )
                .expect("dispose final")
            })
        };
        close.session_id = None;
        close.lifecycle_id = None;
        close.revision = 5;
        drop(close);

        assert!(matches!(
            final_thread.join().expect("join final"),
            StoredFinal::Inactive
        ));
        assert_eq!(acknowledgements.load(Ordering::SeqCst), 0);
        assert!(pending.lock().expect("pending queue").is_empty());
        let admission = admission.inner.lock().expect("admission state");
        assert_eq!(admission.next_token, 0);
        assert!(admission.tokens.is_empty());
        assert!(admission.core.utterances_after(0).is_empty());
    }

    #[test]
    fn old_revision_final_cannot_reach_replacement_but_current_final_can() {
        let runtime = Mutex::new(Runtime {
            session_id: Some("session-b".into()),
            lifecycle_id: Some("lifecycle-b".into()),
            revision: 5,
            ..Runtime::default()
        });
        let pending = Mutex::new(VecDeque::new());
        let admission = BerdAdmissionCoordinator::default();
        let acknowledgements = std::sync::atomic::AtomicUsize::new(0);

        assert!(matches!(
            store_final_if_active(
                &runtime,
                &pending,
                &admission,
                "session-a",
                4,
                pending_transcript("session-a", "lifecycle-a", "old", 4),
                || {
                    acknowledgements.fetch_add(1, Ordering::SeqCst);
                },
            )
            .expect("reject old final"),
            StoredFinal::Inactive
        ));
        assert!(matches!(
            store_final_if_active(
                &runtime,
                &pending,
                &admission,
                "session-b",
                5,
                pending_transcript("session-b", "lifecycle-b", "new", 5),
                || {
                    acknowledgements.fetch_add(1, Ordering::SeqCst);
                },
            )
            .expect("store replacement final"),
            StoredFinal::Stored { .. }
        ));
        assert_eq!(acknowledgements.load(Ordering::SeqCst), 1);
        let pending = pending.lock().expect("pending queue");
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].id, "new");
        let admission = admission.inner.lock().expect("admission state");
        assert_eq!(admission.next_token, 1);
        assert_eq!(admission.tokens.len(), 1);
        assert_eq!(admission.core.utterances_after(0).len(), 1);
    }

    #[test]
    fn current_final_evicts_superseded_lifecycle_recovery_without_current_admission() {
        let runtime = Mutex::new(Runtime {
            session_id: Some("session-new".into()),
            lifecycle_id: Some("lifecycle-new".into()),
            revision: 5,
            ..Runtime::default()
        });
        let pending = Mutex::new(
            (0..MAX_PENDING_TRANSCRIPTS)
                .map(|index| {
                    pending_transcript("session-old", "lifecycle-old", &format!("old-{index}"), 4)
                })
                .collect(),
        );
        let admission = BerdAdmissionCoordinator::default();

        let result = store_final_if_active(
            &runtime,
            &pending,
            &admission,
            "session-new",
            5,
            pending_transcript("session-new", "lifecycle-new", "new", 5),
            || {},
        )
        .expect("store current final while evicting stale recovery");

        assert!(matches!(result, StoredFinal::Stored { evicted: Some(_) }));
        let pending = pending.lock().unwrap();
        assert_eq!(pending.len(), MAX_PENDING_TRANSCRIPTS);
        assert_eq!(pending.front().unwrap().id, "old-1");
        assert_eq!(pending.back().unwrap().id, "new");
    }

    #[tokio::test]
    async fn nonquiescent_finish_blocks_restart_and_projects_unavailable() {
        let state = NativeVoiceState::default();
        {
            let mut runtime = state.runtime.lock().expect("install old lifecycle");
            runtime.session_id = Some("session-a".into());
            runtime.lifecycle_id = Some("lifecycle-a".into());
            runtime.revision = 4;
        }
        let message = state
            .record_voice_input_finish(Err(berd_voice::input::VoiceInputFinishError::Quarantined {
                timeout: Duration::from_millis(20),
            }))
            .expect("quarantine is terminal");
        assert!(message.contains("Restart Berd"));
        assert!(state.ensure_voice_input_not_quarantined().is_err());

        let admission = BerdAdmissionCoordinator::default();
        let acknowledgements = std::sync::atomic::AtomicUsize::new(0);
        assert!(matches!(
            store_final_if_active(
                &state.runtime,
                &state.pending,
                &admission,
                "session-a",
                4,
                pending_transcript("session-a", "lifecycle-a", "too-late", 4),
                || {
                    acknowledgements.fetch_add(1, Ordering::SeqCst);
                },
            )
            .expect("quarantine rejects late final"),
            StoredFinal::Inactive
        ));
        assert_eq!(acknowledgements.load(Ordering::SeqCst), 0);
        assert!(state.pending.lock().expect("pending queue").is_empty());

        let status = status_with_availability(&state, true, || async { true }).await;
        assert!(!status.available);
        assert!(status
            .unavailable_reason
            .as_deref()
            .is_some_and(|reason| reason.contains("Restart Berd")));
    }

    #[test]
    fn quiescent_completion_and_worker_panic_do_not_poison_restart() {
        let completed = NativeVoiceState::default();
        assert_eq!(completed.record_voice_input_finish(Ok(())), None);
        completed
            .ensure_voice_input_not_quarantined()
            .expect("joined worker remains restartable");

        let panicked = NativeVoiceState::default();
        assert_eq!(
            panicked.record_voice_input_finish(Err(
                berd_voice::input::VoiceInputFinishError::WorkerPanicked,
            )),
            Some("voice input runtime worker panicked".to_string())
        );
        panicked
            .ensure_voice_input_not_quarantined()
            .expect("joined panic is quiescent and restartable");
    }

    fn transcript_reference(id: &str) -> VoiceTranscriptReference {
        VoiceTranscriptReference {
            lifecycle_id: "lifecycle-1".to_string(),
            id: id.to_string(),
            revision: 4,
        }
    }

    #[tokio::test]
    async fn admission_holds_without_confirming_then_observes_a_final() {
        let admission = Arc::new(BerdAdmissionCoordinator::default());
        let first = transcript_reference("first");
        admission.add_final(first.clone(), "one".into()).unwrap();
        admission.set_user_speaking(true);

        let waiting = {
            let admission = Arc::clone(&admission);
            let first = first.clone();
            tokio::spawn(async move { admission.prepare("reply".into(), Some(first)).await })
        };
        tokio::task::yield_now().await;
        assert_eq!(
            admission.inner.lock().unwrap().core.confirmed_token(),
            0,
            "held preparation must not apply its causal acknowledgement"
        );

        admission
            .add_final(transcript_reference("second"), "two".into())
            .unwrap();
        admission.set_user_speaking(false);
        assert!(matches!(
            waiting.await.unwrap().unwrap(),
            PrepareAssistantSpeechOutcome::Pending
        ));
    }

    #[tokio::test]
    async fn stale_exact_causal_reference_does_not_inherit_global_confirmation() {
        let admission = BerdAdmissionCoordinator::default();
        let first = transcript_reference("first");
        let second = transcript_reference("second");
        admission.add_final(first.clone(), "one".into()).unwrap();
        admission.add_final(second.clone(), "two".into()).unwrap();
        assert!(admission.confirm(&second).unwrap());

        assert!(matches!(
            admission
                .prepare("delayed".into(), Some(first))
                .await
                .unwrap(),
            PrepareAssistantSpeechOutcome::Pending
        ));
    }

    #[tokio::test]
    async fn fast_second_delivery_cannot_hide_slow_first_rejection() {
        let state = NativeVoiceState::default();
        let admission = Arc::new(BerdAdmissionCoordinator::default());
        {
            let mut runtime = state.runtime.lock().unwrap();
            runtime.session_id = Some("session-1".into());
            runtime.lifecycle_id = Some("lifecycle-1".into());
            runtime.revision = 4;
            runtime.admission = Some(Arc::clone(&admission));
        }
        for id in ["first", "second"] {
            let reference = transcript_reference(id);
            admission.add_final(reference, id.to_string()).unwrap();
            state.pending.lock().unwrap().push_back(PendingTranscript {
                session_id: "session-1".into(),
                lifecycle_id: "lifecycle-1".into(),
                id: id.into(),
                text: id.into(),
                revision: 4,
                delivery_attempts: 0,
            });
        }

        state
            .acknowledge_transcript("session-1", "second", 4)
            .unwrap();
        assert!(matches!(
            admission
                .prepare("reply".into(), Some(transcript_reference("second")))
                .await
                .unwrap(),
            PrepareAssistantSpeechOutcome::Pending
        ));

        for _ in 0..MAX_TRANSCRIPT_DELIVERY_ATTEMPTS {
            state.reject_transcript("session-1", "first", 4).unwrap();
        }
        assert!(matches!(
            admission
                .prepare("reply".into(), Some(transcript_reference("second")))
                .await
                .unwrap(),
            PrepareAssistantSpeechOutcome::Admitted { .. }
        ));
    }

    #[test]
    fn superseded_lifecycle_recovery_can_be_acknowledged_without_admission() {
        let state = NativeVoiceState::default();
        state.pending.lock().unwrap().push_back(PendingTranscript {
            session_id: "old-session".into(),
            lifecycle_id: "old-lifecycle".into(),
            id: "old-final".into(),
            text: "recover me".into(),
            revision: 3,
            delivery_attempts: 0,
        });

        state
            .acknowledge_transcript("old-session", "old-final", 3)
            .unwrap();

        assert!(state.pending.lock().unwrap().is_empty());
    }

    #[test]
    fn superseded_lifecycle_recovery_can_be_terminally_rejected_without_admission() {
        let state = NativeVoiceState::default();
        state.pending.lock().unwrap().push_back(PendingTranscript {
            session_id: "old-session".into(),
            lifecycle_id: "old-lifecycle".into(),
            id: "old-final".into(),
            text: "recover me".into(),
            revision: 3,
            delivery_attempts: 0,
        });

        for _ in 0..MAX_TRANSCRIPT_DELIVERY_ATTEMPTS {
            state
                .reject_transcript("old-session", "old-final", 3)
                .unwrap();
        }

        assert!(state.pending.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn input_after_prepare_invalidates_the_installed_reservation_before_claim() {
        let admission = Arc::new(BerdAdmissionCoordinator::default());
        let PrepareAssistantSpeechOutcome::Admitted { speech_id } =
            admission.prepare("reply".into(), None).await.unwrap()
        else {
            panic!("expected admission")
        };

        admission.set_recognition_pending(true);
        let playback_active = Arc::new(AtomicBool::new(true));
        assert!(admission
            .claim(speech_id, Arc::clone(&playback_active))
            .unwrap()
            .is_none());
        assert!(playback_active.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn input_after_claim_cancels_playback_until_the_terminal_guard_finishes() {
        let admission = Arc::new(BerdAdmissionCoordinator::default());
        let PrepareAssistantSpeechOutcome::Admitted { speech_id } =
            admission.prepare("reply".into(), None).await.unwrap()
        else {
            panic!("expected admission")
        };
        let playback_active = Arc::new(AtomicBool::new(true));
        let guard = admission
            .claim(speech_id, Arc::clone(&playback_active))
            .unwrap()
            .expect("claim reservation");

        admission.set_user_speaking(true);
        assert!(!playback_active.load(Ordering::SeqCst));
        admission.set_user_speaking(false);
        assert!(matches!(
            admission.prepare("next".into(), None).await.unwrap(),
            PrepareAssistantSpeechOutcome::NotAdmitted
        ));
        drop(guard);
        assert!(matches!(
            admission.prepare("next".into(), None).await.unwrap(),
            PrepareAssistantSpeechOutcome::Admitted { .. }
        ));
    }

    #[tokio::test]
    async fn closing_the_lifecycle_wakes_a_held_prepare() {
        let admission = Arc::new(BerdAdmissionCoordinator::default());
        admission.set_user_speaking(true);
        let waiting = {
            let admission = Arc::clone(&admission);
            tokio::spawn(async move { admission.prepare("reply".into(), None).await })
        };
        tokio::task::yield_now().await;
        admission.close();
        assert_eq!(
            waiting.await.unwrap().unwrap_err(),
            "The voice conversation is no longer running."
        );
    }

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
    fn apple_status_is_only_queried_when_it_can_change_availability() {
        assert!(!needs_macos_status(true, false));
        assert!(!needs_macos_status(false, true));
        assert!(needs_macos_status(false, false));
    }

    #[tokio::test]
    async fn status_resamples_runtime_after_availability_check() {
        let state = NativeVoiceState::default();
        let (availability_tx, availability_rx) = tokio::sync::oneshot::channel();
        let mut availability_rx = Some(availability_rx);
        let status = status_with_availability(&state, false, || {
            let availability_rx = availability_rx.take().expect("availability queried once");
            async move { availability_rx.await.expect("finish availability refresh") }
        });
        tokio::pin!(status);
        assert!(
            tokio::time::timeout(Duration::from_millis(10), status.as_mut())
                .await
                .is_err()
        );

        {
            let mut runtime = state.runtime.lock().expect("lock native runtime");
            runtime.session_id = Some("session-1".to_string());
            runtime.owner = Some(RuntimeOwner {
                window_label: "main".to_string(),
            });
            runtime.revision = 7;
        }

        availability_tx
            .send(false)
            .expect("availability refresh is still pending");
        let status = status.await;
        assert!(status.available);
        assert!(matches!(status.lifecycle, Lifecycle::Running));
        assert_eq!(status.session_id.as_deref(), Some("session-1"));
        assert_eq!(status.owner_window_label.as_deref(), Some("main"));
        assert_eq!(status.revision, 7);
    }

    #[tokio::test]
    async fn status_rechecks_availability_after_lifecycle_changes() {
        let state = NativeVoiceState::default();
        let (first_tx, first_rx) = tokio::sync::oneshot::channel();
        let (second_tx, second_rx) = tokio::sync::oneshot::channel();
        let mut responses = VecDeque::from([first_rx, second_rx]);
        let status = status_with_availability(&state, false, || {
            let response = responses.pop_front().expect("availability response");
            async move { response.await.expect("finish availability refresh") }
        });
        tokio::pin!(status);
        assert!(
            tokio::time::timeout(Duration::from_millis(10), status.as_mut())
                .await
                .is_err()
        );

        state.runtime.lock().expect("lock native runtime").revision = 2;
        first_tx
            .send(false)
            .expect("finish first availability check");
        assert!(
            tokio::time::timeout(Duration::from_millis(10), status.as_mut())
                .await
                .is_err()
        );

        second_tx
            .send(true)
            .expect("finish replacement availability check");
        let status = status.await;
        assert!(status.available);
        assert!(matches!(status.lifecycle, Lifecycle::Stopped));
        assert_eq!(status.revision, 2);
    }

    #[test]
    fn native_mute_control_does_not_latch_the_software_fallback() {
        assert!(!software_microphone_mute(true, true));
        assert!(software_microphone_mute(false, true));
        assert!(!software_microphone_mute(false, false));
    }

    #[test]
    fn replacement_stop_requires_the_target_session_window() {
        assert!(caller_owns_target("main", None, true));
        assert!(!caller_owns_target("main", None, false));
        assert!(!caller_owns_target("main", Some("session:target"), true,));
        assert!(caller_owns_target(
            "session:target",
            Some("session:target"),
            true,
        ));
        assert!(!caller_owns_target(
            "session:other",
            Some("session:target"),
            true,
        ));
        assert!(!caller_owns_target("voice-buddy", None, true,));
    }

    #[test]
    fn assistant_suppression_uses_the_shared_input_controls() {
        let state = NativeVoiceState::default();
        assert!(!state.input_controls.is_muted());

        let guard = state.begin_assistant_speech(
            InterruptionSensitivity::Balanced,
            berd_voice::input::InputDuringTtsPolicy::SuppressInput,
        );
        assert!(state.input_controls.is_muted());

        drop(guard);
        assert!(!state.input_controls.is_muted());
    }

    #[test]
    fn assistant_input_suppression_outlives_lifecycle_replacement() {
        let state = NativeVoiceState::default();
        {
            let mut runtime = state.runtime.lock().expect("lock native runtime");
            runtime.session_id = Some("old-session".to_string());
            runtime.revision = 7;
        }
        let guard = state.begin_assistant_speech(
            InterruptionSensitivity::Less,
            berd_voice::input::InputDuringTtsPolicy::SuppressInput,
        );
        state
            .take_stop_snapshot(Some(("old-session", 7)))
            .expect("stop old lifecycle")
            .expect("active old lifecycle");
        {
            let mut runtime = state.runtime.lock().expect("lock native runtime");
            runtime.session_id = Some("new-session".to_string());
            runtime.revision = 8;
        }

        assert!(state.input_controls.is_muted());
        drop(guard);
        assert!(!state.input_controls.is_muted());
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
        state.microphone_muted.store(false, Ordering::SeqCst);
        assert!(state.input_controls.is_host_muted());
        state
            .set_microphone_muted_target("main", "session-b", 8, false)
            .expect("authoritative unmute repairs a stale UI projection");
        assert!(!state.input_controls.is_host_muted());
        assert!(!state.microphone_is_muted());
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
    fn floating_controls_window_registration_is_lifecycle_bound() {
        let state = NativeVoiceState::default();
        {
            let mut runtime = state.runtime.lock().expect("lock native runtime");
            runtime.session_id = Some("session-1".to_string());
            runtime.revision = 4;
        }

        state
            .register_controls_window("session-1", 4)
            .expect("register current controls window");
        assert_eq!(state.controls_window_revision(), Some(4));
        assert!(state.controls_window_matches_active_lifecycle());
        assert!(state.register_controls_window("session-1", 3).is_err());

        state.clear_controls_window_if_revision(Some(3));
        assert_eq!(state.controls_window_revision(), Some(4));
        state
            .runtime
            .lock()
            .expect("lock native runtime")
            .session_id = None;
        assert!(!state.controls_window_matches_active_lifecycle());

        state.clear_controls_window_if_revision(Some(4));
        assert_eq!(state.controls_window_revision(), None);
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
    fn only_owning_window_can_inject_audio() {
        let state = NativeVoiceState::default();
        {
            let mut runtime = state.runtime.lock().expect("lock native runtime");
            runtime.owner = Some(RuntimeOwner {
                window_label: "owner-window".to_string(),
            });
        }

        assert!(push_audio_for_window(&state, "other-window", vec![0; 4]).is_err());
        state.microphone_muted.store(true, Ordering::SeqCst);
        push_audio_for_window(&state, "owner-window", vec![0; 4])
            .expect("muted owner audio is ignored");
        state.microphone_muted.store(false, Ordering::SeqCst);
        push_audio_for_window(&state, "owner-window", vec![0; 4])
            .expect("owner can send audio while no runtime is installed");
    }

    #[test]
    fn audio_transport_decodes_only_exact_finite_frames() {
        let samples = [0.0_f32; berd_voice::input::INPUT_FRAME_SAMPLES];
        let bytes = samples
            .iter()
            .flat_map(|sample| sample.to_le_bytes())
            .collect::<Vec<_>>();
        decode_voice_input_frame(&bytes).expect("exact frame");
        assert!(decode_voice_input_frame(&bytes[..bytes.len() - 4]).is_err());

        let mut nonfinite = bytes;
        nonfinite[..4].copy_from_slice(&f32::NAN.to_le_bytes());
        assert!(decode_voice_input_frame(&nonfinite).is_err());
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
            let outcome =
                reject_pending_transcript(&mut pending, "session-1", &id, 2, None).unwrap();
            assert_eq!(outcome.attempts, attempts);
            assert!(!outcome.terminal);
        }
        let outcome = reject_pending_transcript(&mut pending, "session-1", &id, 2, None).unwrap();
        assert!(outcome.terminal);
        assert!(!pending.iter().any(|item| item.id == id));
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
    fn prepared_speech_outcomes_match_the_shared_renderer_contract() {
        let expected: serde_json::Value = serde_json::from_str(include_str!(
            "../../../tests/contracts/voice/prepare-assistant-speech-outcomes.json"
        ))
        .expect("parse shared prepared speech contract");
        let actual = serde_json::json!([
            serde_json::to_value(PrepareAssistantSpeechOutcome::Pending)
                .expect("serialize pending outcome"),
            serde_json::to_value(PrepareAssistantSpeechOutcome::NotAdmitted)
                .expect("serialize not-admitted outcome"),
            serde_json::to_value(PrepareAssistantSpeechOutcome::Admitted { speech_id: 7 })
                .expect("serialize admitted outcome"),
        ]);
        assert_eq!(actual, expected);
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
        assert_eq!(
            serde_json::from_str::<VoiceInputBackend>("\"openai\"")
                .expect("deserialize OpenAI backend"),
            VoiceInputBackend::Openai,
        );
    }
}
