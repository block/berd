//! Host-independent voice-input runtime.
//!
//! Hosts provide exact normalized PCM frames and own capture devices and final
//! transcript delivery. This module owns recognition, VAD, mute/reset epochs,
//! assistant-sensitive interruption thresholds, and bounded engine shutdown.

use std::{
    collections::{BTreeMap, HashMap, VecDeque},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering},
        mpsc::{self, Receiver, SyncSender, TrySendError},
        Arc, Condvar, Mutex, OnceLock,
    },
    thread,
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use tokio::sync::mpsc as tokio_mpsc;

use crate::{
    openai_realtime::{
        OpenAiRealtimeTranscriptionClient, OpenAiRealtimeTranscriptionConfig,
        OpenAiRealtimeTranscriptionError as TranscriptionError, OpenAiRealtimeTranscriptionEvent,
    },
    ParakeetRecognizer,
};

pub const INPUT_SAMPLE_RATE: usize = 48_000;
pub const INPUT_FRAME_SAMPLES: usize = 960;
const INPUT_FRAME_DURATION: Duration = Duration::from_millis(20);
const INPUT_QUEUE_FRAMES: usize = 50;
const PARAKEET_RESULT_QUEUE_DEPTH: usize = 1;

const EVENT_QUEUE_DEPTH: usize = 64;
const MAX_SPEECH_SAMPLES: usize = 16_000 * 30;
const VAD_FRAME_SAMPLES: usize = 256;
const SILENCE_FLUSH_FRAMES: usize = 75;
const OPENAI_NETWORK_OPERATION_TIMEOUT: Duration = Duration::from_secs(5);
const OPENAI_LIVE_RESULT_TIMEOUT: Duration = Duration::from_secs(5);
const OPENAI_FINAL_WRITE_TIMEOUT: Duration = Duration::from_secs(1);
const OPENAI_PRE_ROLL_FRAMES: usize = 15;
const FINAL_STORAGE_TIMEOUT: Duration = Duration::from_secs(5);
const FINISH_TIMEOUT: Duration =
    Duration::from_secs(crate::MAC_SPEECH_RECOGNITION_FINISH_TIMEOUT_SECONDS + 5 + 1);

/// One 20 ms frame of 48 kHz mono, finite, unit-scale Float32 PCM.
pub struct VoiceInputFrame([f32; INPUT_FRAME_SAMPLES]);

impl VoiceInputFrame {
    pub fn try_from_samples(samples: &[f32]) -> Result<Self, String> {
        if samples.len() != INPUT_FRAME_SAMPLES {
            return Err(format!(
                "voice input frame has {} samples; expected {INPUT_FRAME_SAMPLES}",
                samples.len()
            ));
        }
        let mut frame = [0.0; INPUT_FRAME_SAMPLES];
        for (target, sample) in frame.iter_mut().zip(samples) {
            if !sample.is_finite() {
                return Err("voice input frame contains a non-finite sample".to_string());
            }
            *target = sample.clamp(-1.0, 1.0);
        }
        Ok(Self(frame))
    }

    fn samples(&self) -> &[f32; INPUT_FRAME_SAMPLES] {
        &self.0
    }

    pub fn as_samples(&self) -> &[f32; INPUT_FRAME_SAMPLES] {
        &self.0
    }
}

pub enum VoiceInputEngineConfig {
    Parakeet {
        model_dir: PathBuf,
    },
    #[cfg(target_os = "macos")]
    MacSpeech {
        hints: Vec<String>,
    },
    OpenAi {
        endpoint: String,
        api_key: String,
        model: String,
    },
}

/// Receives the macOS worker's speech-detection decisions, for capture.
pub trait DetectionTrace: Send + Sync {
    /// Microphone frames received so far, including the one being pushed.
    fn received_frames(&self) -> u64;
    /// Effective detection settings, before the first frame using them.
    fn settings(&self, revision: u64, settings: crate::detection::DetectionSettings);
    fn frame(&self, frame: TracedFrame);
    /// A recognizer generation began or ended, and why.
    fn recognizer(&self, generation: u64, reason: &'static str);
    /// A final ending at this recognizer sample resolved this many speech turns.
    fn recognized(&self, _end_sample: Option<u64>, _resolved: usize) {}
    /// Apple reported interim words (`heard`) or finalized audio (`settled`) through this recognizer sample.
    fn recognition(&self, _kind: &'static str, _sample: u64) {}
}

/// One 16 ms detector frame.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub struct TracedFrame {
    /// The 48 kHz microphone sample just past this frame's audio.
    pub mic_sample: u64,
    pub vad_frame: u64,
    pub epoch: u64,
    pub generation: u64,
    pub mode: crate::vad_replay::Mode,
    pub probability: f32,
    pub threshold: f32,
    pub detected: bool,
    /// The onset/release gate's output, which starts and ends turns.
    pub active: bool,
    pub settings_revision: u64,
}

pub struct VoiceInputConfig {
    pub engine: VoiceInputEngineConfig,
    pub speech_vad_threshold: f32,
    pub controls: VoiceInputControls,
}

pub struct FinalTranscriptStorageReceipt(Option<SyncSender<()>>);

impl FinalTranscriptStorageReceipt {
    /// Confirms that the host accepted this transcript into its authoritative
    /// recovery storage.
    pub fn stored(mut self) {
        if let Some(sender) = self.0.take() {
            let _ = sender.send(());
        }
    }

    #[cfg(test)]
    pub(crate) fn test_pair() -> (Self, mpsc::Receiver<()>) {
        // A single buffered acknowledgement lets unit tests inspect receipt
        // ordering without introducing a helper thread. Production receipts
        // remain rendezvous channels created by `send_final`.
        let (sender, receiver) = mpsc::sync_channel(1);
        (Self(Some(sender)), receiver)
    }
}

pub enum VoiceInputEvent {
    Ready,
    SpeakingChanged(bool),
    /// Detection state was discarded, rather than a measured speech edge.
    SpeakingReset,
    /// Agent speech admission hold, which may expire before recognition finishes.
    RecognitionPendingChanged(bool),
    /// Display only: words Apple is still transcribing, or empty once none are.
    /// Never stored, delivered or treated as an utterance.
    InterimTranscript(String),
    FinalTranscript {
        text: String,
        storage_receipt: FinalTranscriptStorageReceipt,
    },
    Failed(String),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum VoiceInputFinishError {
    WorkerPanicked,
    Quarantined { timeout: Duration },
}

impl VoiceInputFinishError {
    pub fn is_quarantined(&self) -> bool {
        matches!(self, Self::Quarantined { .. })
    }
}

impl std::fmt::Display for VoiceInputFinishError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::WorkerPanicked => formatter.write_str("voice input runtime worker panicked"),
            Self::Quarantined { timeout } => write!(
                formatter,
                "voice input runtime did not stop within {timeout:?}; the worker was quarantined"
            ),
        }
    }
}

impl std::error::Error for VoiceInputFinishError {}

#[derive(Clone)]
pub struct VoiceInputControls {
    shared: Arc<ControlState>,
}

struct ControlState {
    detection: Mutex<Option<crate::detection::DetectionTuner>>,
    transition: Mutex<ControlTransitionState>,
    muted: AtomicBool,
    mute_epoch: AtomicU64,
    cue_suppressions: AtomicU64,
    assistant_speaking: AtomicBool,
    /// Agent speech starts so far, so the worker can place each on its timeline.
    assistant_starts: AtomicU64,
    assistant_vad_threshold: AtomicU32,
    trace: OnceLock<Arc<dyn DetectionTrace>>,
}

#[derive(Default)]
struct ControlTransitionState {
    host_muted: bool,
    auto_suppressed: bool,
    auto_monitor_running: bool,
    assistant_activity: AssistantActivityState,
}

#[derive(Default)]
struct AssistantActivityState {
    generation: u64,
    lifetimes: BTreeMap<u64, AssistantActivity>,
}

struct AssistantActivity {
    vad_threshold: u32,
    input_policy: InputDuringTtsPolicy,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum InputDuringTtsPolicy {
    Auto,
    AllowBargeIn,
    SuppressInput,
}

impl InputDuringTtsPolicy {
    pub fn resolve(self, output_device: Option<&str>) -> Self {
        if self == Self::Auto {
            self.resolve_for_speakers(output_device_uses_speakers(output_device))
        } else {
            self
        }
    }

    pub fn resolve_for_speakers(self, speakers: bool) -> Self {
        match self {
            Self::Auto if speakers => Self::SuppressInput,
            Self::Auto => Self::AllowBargeIn,
            explicit => explicit,
        }
    }
}

/// Shared best-effort route classification for desktop and CLI callers.
pub fn output_device_uses_speakers(output_device: Option<&str>) -> bool {
    #[cfg(target_os = "macos")]
    let (default_name, builtin) = (
        crate::macos_audio_route::default_output_device_name as fn() -> Option<String>,
        || crate::macos_audio_route::output_device_is_builtin_speaker(output_device),
    );
    #[cfg(not(target_os = "macos"))]
    let (default_name, builtin) = ((|| None) as fn() -> Option<String>, || false);
    route_uses_speakers(output_device, default_name, builtin)
}

/// A named route is judged by its name, then by built-in speaker metadata. No
/// name means the default output, which is named the same way.
fn route_uses_speakers(
    output_device: Option<&str>,
    default_name: impl FnOnce() -> Option<String>,
    builtin_speaker: impl FnOnce() -> bool,
) -> bool {
    let name = output_device.map(str::to_owned).or_else(default_name);
    name.is_some_and(|name| {
        let name = name.to_lowercase();
        ["speaker", "altavo"].iter().any(|word| name.contains(word))
    }) || builtin_speaker()
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct InputDuringTtsSnapshot {
    pub revision: u64,
    pub policy: InputDuringTtsPolicy,
}

pub struct InputDuringTtsSlot {
    snapshot: Mutex<InputDuringTtsSnapshot>,
}

impl InputDuringTtsSlot {
    pub fn new(policy: InputDuringTtsPolicy) -> Self {
        Self {
            snapshot: Mutex::new(InputDuringTtsSnapshot {
                revision: 1,
                policy,
            }),
        }
    }

    pub fn snapshot(&self) -> Result<InputDuringTtsSnapshot, String> {
        self.snapshot
            .lock()
            .map(|snapshot| *snapshot)
            .map_err(|_| "input-during-TTS policy lock was poisoned".into())
    }

    pub fn update(
        &self,
        expected_revision: u64,
        policy: InputDuringTtsPolicy,
    ) -> Result<InputDuringTtsSnapshot, InputDuringTtsSnapshot> {
        let mut snapshot = self
            .snapshot
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if snapshot.revision != expected_revision {
            return Err(*snapshot);
        }
        let Some(revision) = snapshot.revision.checked_add(1) else {
            return Err(*snapshot);
        };
        *snapshot = InputDuringTtsSnapshot { revision, policy };
        Ok(*snapshot)
    }
}

impl Default for VoiceInputControls {
    fn default() -> Self {
        Self {
            shared: Arc::new(ControlState {
                detection: Mutex::new(None),
                transition: Mutex::new(ControlTransitionState::default()),
                muted: AtomicBool::new(false),
                mute_epoch: AtomicU64::new(0),
                cue_suppressions: AtomicU64::new(0),
                assistant_speaking: AtomicBool::new(false),
                assistant_starts: AtomicU64::new(0),
                assistant_vad_threshold: AtomicU32::new(0.5_f32.to_bits()),
                trace: OnceLock::new(),
            }),
        }
    }
}

impl VoiceInputControls {
    /// Pauses new captured frames without invalidating buffered speech or recognition.
    pub fn begin_cue_activity(
        &self,
        policy: InputDuringTtsPolicy,
        output_device: Option<&str>,
    ) -> Result<CueInputActivityGuard, String> {
        let suppress = policy.resolve(output_device) == InputDuringTtsPolicy::SuppressInput;
        if suppress {
            self.shared
                .cue_suppressions
                .fetch_update(Ordering::AcqRel, Ordering::Acquire, |count| {
                    count.checked_add(1)
                })
                .map_err(|_| "Too many overlapping cue activity guards".to_string())?;
        }
        Ok(CueInputActivityGuard {
            controls: self.clone(),
            suppress,
        })
    }

    pub fn is_input_suppressed(&self) -> bool {
        self.is_muted() || self.shared.cue_suppressions.load(Ordering::Acquire) > 0
    }

    pub fn set_detection(
        &self,
        settings: crate::detection::DetectionSettings,
    ) -> Result<(), String> {
        let settings = settings.validate()?;
        let mut detection = self
            .shared
            .detection
            .lock()
            .map_err(|_| "speech detection lock failed")?;
        self.reset();
        *detection = Some(crate::detection::DetectionTuner::new(settings));
        Ok(())
    }

    /// Traces speech detection from runtimes started after this call.
    pub fn set_trace(&self, trace: Arc<dyn DetectionTrace>) {
        let _ = self.shared.trace.set(trace);
    }

    pub fn detection(&self) -> Option<crate::detection::DetectionSnapshot> {
        self.shared
            .detection
            .lock()
            .ok()?
            .as_ref()
            .map(|tuner| tuner.snapshot())
    }

    /// Runs `learn` on the tuner unless a reset has made `epoch` stale.
    #[cfg(target_os = "macos")]
    fn tune(&self, epoch: u64, learn: impl FnOnce(&mut crate::detection::DetectionTuner)) {
        if let Ok(mut detection) = self.shared.detection.lock() {
            if self.mute_epoch() != epoch {
                return;
            }
            if let Some(tuner) = detection.as_mut() {
                learn(tuner);
            }
        }
    }

    #[cfg(target_os = "macos")]
    fn observe_detection(&self, detected: bool, epoch: u64) {
        self.observe_detection_at(detected, epoch, Instant::now());
    }

    #[cfg(target_os = "macos")]
    fn observe_detection_at(&self, detected: bool, epoch: u64, now: Instant) {
        let mode = if self.shared.assistant_speaking.load(Ordering::Acquire) {
            crate::detection::DetectionMode::Interruption
        } else {
            crate::detection::DetectionMode::Listening
        };
        self.tune(epoch, |tuner| tuner.observe(mode, detected, now));
    }

    #[cfg(target_os = "macos")]
    fn detection_result(&self, recognized: bool, epoch: u64) {
        self.detection_result_at(recognized, epoch, Instant::now());
    }

    #[cfg(target_os = "macos")]
    fn detection_result_at(&self, recognized: bool, epoch: u64, now: Instant) {
        self.tune(epoch, |tuner| {
            if recognized {
                tuner.final_transcript(now);
            } else {
                tuner.no_result(now);
            }
        });
    }

    pub fn is_muted(&self) -> bool {
        self.shared.muted.load(Ordering::Acquire)
    }

    /// Changes the host-mute reason. Each effective composed edge advances the
    /// epoch so queued audio and provider results from the prior state cannot
    /// cross it.
    pub fn set_host_muted(&self, muted: bool) {
        let mut transition = self
            .shared
            .transition
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        transition.host_muted = muted;
        self.publish_effective_mute(&transition);
    }

    pub fn is_host_muted(&self) -> bool {
        self.shared
            .transition
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .host_muted
    }

    /// Discards buffered audio and stale provider results without changing mute.
    pub fn reset(&self) {
        let _transition = self
            .shared
            .transition
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        self.shared.mute_epoch.fetch_add(1, Ordering::AcqRel);
    }

    pub fn begin_assistant_activity(
        &self,
        vad_threshold: f32,
        input_policy: InputDuringTtsPolicy,
    ) -> Result<AssistantActivityGuard, String> {
        if !vad_threshold.is_finite() || !(0.0..=1.0).contains(&vad_threshold) {
            return Err("assistant VAD threshold must be finite and between 0 and 1".to_string());
        }
        let mut transition = self
            .shared
            .transition
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let generation = transition
            .assistant_activity
            .generation
            .checked_add(1)
            .ok_or_else(|| "assistant activity generation is exhausted".to_string())?;
        transition.assistant_activity.generation = generation;
        transition.assistant_activity.lifetimes.insert(
            generation,
            AssistantActivity {
                vad_threshold: vad_threshold.to_bits(),
                input_policy,
            },
        );
        let start_monitor =
            input_policy == InputDuringTtsPolicy::Auto && !transition.auto_monitor_running;
        if start_monitor {
            transition.auto_suppressed =
                InputDuringTtsPolicy::Auto.resolve(None) == InputDuringTtsPolicy::SuppressInput;
            transition.auto_monitor_running = true;
        }
        self.publish_assistant_activity(&transition.assistant_activity);
        self.shared.assistant_starts.fetch_add(1, Ordering::AcqRel);
        self.publish_effective_mute(&transition);
        drop(transition);
        if start_monitor {
            // Route queries stay off capture callbacks. The monitor owns no strong
            // reference while sleeping and ends after the last Auto activity.
            let shared = Arc::downgrade(&self.shared);
            thread::spawn(move || loop {
                thread::sleep(Duration::from_millis(100));
                let Some(shared) = shared.upgrade() else {
                    break;
                };
                let controls = VoiceInputControls { shared };
                let suppress =
                    InputDuringTtsPolicy::Auto.resolve(None) == InputDuringTtsPolicy::SuppressInput;
                let mut transition = controls
                    .shared
                    .transition
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                if !transition
                    .assistant_activity
                    .lifetimes
                    .values()
                    .any(|activity| activity.input_policy == InputDuringTtsPolicy::Auto)
                {
                    transition.auto_monitor_running = false;
                    break;
                }
                transition.auto_suppressed = suppress;
                controls.publish_effective_mute(&transition);
            });
        }
        Ok(AssistantActivityGuard {
            controls: self.clone(),
            generation,
        })
    }

    fn mute_epoch(&self) -> u64 {
        self.shared.mute_epoch.load(Ordering::Acquire)
    }

    fn vad_threshold(&self, speech_threshold: f32) -> f32 {
        let (settings, mode) = self.effective_detection(speech_threshold);
        threshold(settings, mode)
    }

    /// The settings in effect, as configured or from the fixed thresholds, and
    /// whether speech now would interrupt the assistant.
    fn effective_detection(
        &self,
        speech_threshold: f32,
    ) -> (crate::detection::DetectionSettings, crate::vad_replay::Mode) {
        use crate::detection::{DetectionSettings, Threshold};
        use crate::vad_replay::Mode;
        let mode = if self.shared.assistant_speaking.load(Ordering::Acquire) {
            Mode::Interruption
        } else {
            Mode::Listening
        };
        let settings = self.detection().map_or_else(
            || DetectionSettings {
                listening: Threshold {
                    value: speech_threshold,
                    dynamic: false,
                },
                interruption: Threshold {
                    value: f32::from_bits(
                        self.shared.assistant_vad_threshold.load(Ordering::Acquire),
                    ),
                    dynamic: false,
                },
                timing: Default::default(),
                pending_utterance_timeout_ms: 5000,
                interim_words_wait_ms: 10000,
                dynamic: Default::default(),
            },
            |snapshot| snapshot.settings,
        );
        (settings, mode)
    }

    fn publish_effective_mute(&self, transition: &ControlTransitionState) {
        let assistant_suppressed =
            transition
                .assistant_activity
                .lifetimes
                .values()
                .any(|activity| {
                    activity
                        .input_policy
                        .resolve_for_speakers(transition.auto_suppressed)
                        == InputDuringTtsPolicy::SuppressInput
                });
        let muted = transition.host_muted || assistant_suppressed;
        if self.shared.muted.swap(muted, Ordering::AcqRel) != muted {
            self.shared.mute_epoch.fetch_add(1, Ordering::AcqRel);
        }
    }

    fn publish_assistant_activity(&self, activity: &AssistantActivityState) {
        if let Some((_, current)) = activity.lifetimes.last_key_value() {
            self.shared
                .assistant_vad_threshold
                .store(current.vad_threshold, Ordering::Release);
            self.shared
                .assistant_speaking
                .store(true, Ordering::Release);
        } else {
            self.shared
                .assistant_speaking
                .store(false, Ordering::Release);
        }
    }
}

#[must_use = "cue input suppression ends when the guard is dropped"]
pub struct CueInputActivityGuard {
    controls: VoiceInputControls,
    suppress: bool,
}

impl Drop for CueInputActivityGuard {
    fn drop(&mut self) {
        if self.suppress {
            self.controls
                .shared
                .cue_suppressions
                .fetch_sub(1, Ordering::AcqRel);
        }
    }
}

#[must_use = "assistant activity ends when the guard is dropped"]
pub struct AssistantActivityGuard {
    controls: VoiceInputControls,
    generation: u64,
}

impl Drop for AssistantActivityGuard {
    fn drop(&mut self) {
        let mut transition = self
            .controls
            .shared
            .transition
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        transition
            .assistant_activity
            .lifetimes
            .remove(&self.generation);
        self.controls
            .publish_assistant_activity(&transition.assistant_activity);
        self.controls.publish_effective_mute(&transition);
    }
}

fn threshold(settings: crate::detection::DetectionSettings, mode: crate::vad_replay::Mode) -> f32 {
    match mode {
        crate::vad_replay::Mode::Listening => settings.listening.value,
        crate::vad_replay::Mode::Interruption => settings.interruption.value,
    }
}

struct QueuedFrame {
    frame: VoiceInputFrame,
    mute_epoch: u64,
    /// This frame's index among those the trace received.
    #[cfg(target_os = "macos")]
    mic_frame: u64,
}

pub struct VoiceInputRuntime {
    frame_tx: SyncSender<QueuedFrame>,
    controls: VoiceInputControls,
    shutdown: Arc<AtomicBool>,
    discard_on_shutdown: Arc<AtomicBool>,
    shutdown_mute_epoch: Arc<AtomicU64>,
    worker: Option<thread::JoinHandle<()>>,
}

impl VoiceInputRuntime {
    pub fn start(
        config: VoiceInputConfig,
    ) -> Result<(Self, tokio_mpsc::Receiver<VoiceInputEvent>), String> {
        if !config.speech_vad_threshold.is_finite()
            || !(0.0..=1.0).contains(&config.speech_vad_threshold)
        {
            return Err("speech VAD threshold must be finite and between 0 and 1".to_string());
        }
        let (frame_tx, frame_rx) = mpsc::sync_channel(INPUT_QUEUE_FRAMES);
        let (event_tx, event_rx) = tokio_mpsc::channel(EVENT_QUEUE_DEPTH);
        let controls = config.controls;
        let shutdown = Arc::new(AtomicBool::new(false));
        let discard_on_shutdown = Arc::new(AtomicBool::new(false));
        let shutdown_mute_epoch = Arc::new(AtomicU64::new(0));
        let worker_controls = controls.clone();
        let worker_shutdown = Arc::clone(&shutdown);
        let worker_discard = Arc::clone(&discard_on_shutdown);
        let worker_shutdown_epoch = Arc::clone(&shutdown_mute_epoch);
        let speech_threshold = config.speech_vad_threshold;
        let (name, work): (&str, Box<dyn FnOnce() + Send>) = match config.engine {
            VoiceInputEngineConfig::Parakeet { model_dir } => (
                "berd-parakeet-stt",
                Box::new(move || {
                    parakeet_worker(
                        model_dir,
                        frame_rx,
                        event_tx,
                        worker_shutdown,
                        worker_discard,
                        worker_shutdown_epoch,
                        worker_controls,
                        speech_threshold,
                    )
                }),
            ),
            #[cfg(target_os = "macos")]
            VoiceInputEngineConfig::MacSpeech { hints } => (
                "berd-macos-stt",
                Box::new(move || {
                    mac_speech_worker(
                        frame_rx,
                        event_tx,
                        worker_shutdown,
                        worker_discard,
                        worker_shutdown_epoch,
                        worker_controls,
                        speech_threshold,
                        hints,
                    )
                }),
            ),
            VoiceInputEngineConfig::OpenAi {
                endpoint,
                api_key,
                model,
            } => (
                "berd-openai-stt",
                Box::new(move || {
                    openai_worker(
                        OpenAiRealtimeTranscriptionConfig::new(endpoint, api_key, model),
                        frame_rx,
                        event_tx,
                        worker_shutdown,
                        worker_discard,
                        worker_shutdown_epoch,
                        worker_controls,
                        speech_threshold,
                    )
                }),
            ),
        };
        let worker = thread::Builder::new()
            .name(name.to_string())
            .spawn(work)
            .map_err(|error| format!("start voice input runtime: {error}"))?;
        Ok((
            Self {
                frame_tx,
                controls,
                shutdown,
                discard_on_shutdown,
                shutdown_mute_epoch,
                worker: Some(worker),
            },
            event_rx,
        ))
    }

    pub fn controls(&self) -> VoiceInputControls {
        self.controls.clone()
    }

    pub fn try_push_frame(&self, frame: VoiceInputFrame) -> Result<(), String> {
        if self.shutdown.load(Ordering::Acquire) {
            return Err("Voice input recognition is no longer running.".to_string());
        }
        if self.controls.is_input_suppressed() {
            return Ok(());
        }
        let mute_epoch = self.controls.mute_epoch();
        if self.controls.is_input_suppressed() || mute_epoch != self.controls.mute_epoch() {
            return Ok(());
        }
        #[cfg(target_os = "macos")]
        let mic_frame = self
            .controls
            .shared
            .trace
            .get()
            .map_or(0, |trace| trace.received_frames().saturating_sub(1));
        match self.frame_tx.try_send(QueuedFrame {
            frame,
            mute_epoch,
            #[cfg(target_os = "macos")]
            mic_frame,
        }) {
            Ok(()) => Ok(()),
            Err(TrySendError::Full(_)) => Err(
                "Voice input overrun: recognition could not keep up with 20 ms frames.".to_string(),
            ),
            Err(TrySendError::Disconnected(_)) => {
                Err("Voice input recognition is no longer running.".to_string())
            }
        }
    }

    pub fn cancel(&self) {
        self.signal_shutdown(true);
    }

    pub async fn finish(mut self) -> Result<(), VoiceInputFinishError> {
        let worker = self.begin_shutdown();
        if let Some(worker) = worker {
            finish_worker(worker, FINISH_TIMEOUT).await?;
        }
        Ok(())
    }

    fn signal_shutdown(&self, discard: bool) {
        let _transition = self
            .controls
            .shared
            .transition
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if self.shutdown.load(Ordering::Acquire) {
            return;
        }
        self.shutdown_mute_epoch
            .store(self.controls.mute_epoch(), Ordering::Release);
        if discard || self.controls.is_muted() {
            self.discard_on_shutdown.store(true, Ordering::Release);
        }
        self.shutdown.store(true, Ordering::Release);
    }

    fn begin_shutdown(&mut self) -> Option<thread::JoinHandle<()>> {
        self.signal_shutdown(false);
        self.worker.take()
    }
}

impl Drop for VoiceInputRuntime {
    fn drop(&mut self) {
        if let Some(worker) = self.begin_shutdown() {
            reap_dropped_worker(worker);
        }
    }
}

async fn finish_worker(
    worker: thread::JoinHandle<()>,
    timeout: Duration,
) -> Result<(), VoiceInputFinishError> {
    let deadline = tokio::time::Instant::now() + timeout;
    while !worker.is_finished() {
        if tokio::time::Instant::now() >= deadline {
            // Rust cannot safely terminate an arbitrary thread blocked inside
            // native code. Detaching this handle avoids adding a second
            // permanently blocked reaper thread; the caller must quarantine
            // the runtime and forbid replacement work in this process.
            drop(worker);
            return Err(VoiceInputFinishError::Quarantined { timeout });
        }
        tokio::time::sleep(Duration::from_millis(10).min(timeout)).await;
    }
    worker
        .join()
        .map_err(|_| VoiceInputFinishError::WorkerPanicked)
}

fn reap_dropped_worker(worker: thread::JoinHandle<()>) {
    // Drop must not block on a native recognizer. Explicit shutdown uses the
    // bounded quarantine path above when the caller needs a completion result.
    let _ = thread::Builder::new()
        .name("berd-call-input-reaper".to_string())
        .spawn(move || {
            let _ = worker.join();
        });
}

// Native finals have no utterance ID. Consume expired credits first, so an old
// final cannot release a newer speech hold. Saturation keeps attribution
// ambiguous until the recognizer is explicitly reset, without unbounded storage.
#[cfg(any(target_os = "macos", test))]
const MAX_PENDING_RECOGNITIONS: usize = 1024;

// Apple ends a final about 0.3 s after its last word, so this only absorbs
// trailing sound the detector still counted as speech.
#[cfg(any(target_os = "macos", test))]
const FINAL_COVERAGE_SLACK_SAMPLES: u64 = 12_000;

// Agent starts a final's words could straddle, which is only the latest few.
#[cfg(any(target_os = "macos", test))]
const MAX_AGENT_STARTS: usize = 8;

#[derive(Default)]
struct PendingRecognitions {
    count: usize,
    blocking: usize,
    ambiguous: bool,
    /// Where each unresolved turn's speech ended, oldest first; None while it continues.
    ends: VecDeque<Option<u64>>,
    /// The wait each unresolved turn's hold had expired in, oldest first. A turn the
    /// hold has not given up on has none, and the marked turns are always the oldest.
    expired: VecDeque<crate::detection::Wait>,
    /// Where the next final's first word starts, as Apple reported just before it.
    #[cfg(any(target_os = "macos", test))]
    first_word: Option<u64>,
    /// Recognizer samples at which agent speech began, oldest first.
    #[cfg(any(target_os = "macos", test))]
    agent_starts: VecDeque<u64>,
    /// The latest recognizer sample with interim words.
    #[cfg(target_os = "macos")]
    heard: u64,
    /// Where the furthest final so far ended, since one can arrive before its turn ends.
    #[cfg(any(target_os = "macos", test))]
    final_end: Option<u64>,
    /// Apple's latest result was interim words rather than a final. Apple
    /// re-reports words a final left out, and interim results end where its
    /// audio does rather than at the last word, so order says more than samples.
    #[cfg(any(target_os = "macos", test))]
    unfinalized: bool,
    /// The interim text last shown, so repeats and clears are sent once.
    interim: String,
}

impl PendingRecognitions {
    fn new() -> Self {
        Self::default()
    }

    fn begin(&mut self, events: &tokio_mpsc::Sender<VoiceInputEvent>) -> Result<(), ()> {
        self.begin_bounded(events, usize::MAX)
    }

    fn begin_bounded(
        &mut self,
        events: &tokio_mpsc::Sender<VoiceInputEvent>,
        limit: usize,
    ) -> Result<(), ()> {
        // Speech after every pending turn resolved is past any earlier final.
        #[cfg(any(target_os = "macos", test))]
        if self.ends.is_empty() {
            self.final_end = None;
        }
        if self.count == limit {
            self.ambiguous = true;
        } else {
            self.count += 1;
            self.ends.push_back(None);
        }
        let was_blocking = self.blocking > 0;
        self.blocking = self.blocking.saturating_add(1).min(limit);
        if !was_blocking {
            events
                .blocking_send(VoiceInputEvent::RecognitionPendingChanged(true))
                .map_err(|_| ())?;
        }
        Ok(())
    }

    #[cfg(any(target_os = "macos", test))]
    fn end_turn(
        &mut self,
        events: &tokio_mpsc::Sender<VoiceInputEvent>,
        speech_end: u64,
    ) -> Result<(), ()> {
        if let Some(end @ None) = self.ends.back_mut() {
            *end = Some(speech_end);
        }
        for _ in 0..self.final_end.map_or(0, |end| self.covered(end)) {
            self.resolve(events)?;
        }
        Ok(())
    }

    /// Ended turns, oldest first, whose speech a final ending at `end` covers.
    #[cfg(any(target_os = "macos", test))]
    fn covered(&self, end: u64) -> usize {
        let end = end.saturating_add(FINAL_COVERAGE_SLACK_SAMPLES);
        self.ends
            .iter()
            .take_while(|turn| turn.is_some_and(|turn| turn <= end))
            .count()
    }

    /// Apple has interim words no final has reached yet, so a transcript is still coming.
    #[cfg(any(target_os = "macos", test))]
    fn words_outstanding(&self) -> bool {
        self.unfinalized
    }

    #[cfg(any(target_os = "macos", test))]
    fn agent_began(&mut self, at: u64) {
        if self.agent_starts.len() == MAX_AGENT_STARTS {
            self.agent_starts.pop_front();
        }
        self.agent_starts.push_back(at);
    }

    /// An agent started speaking in the middle of a final's words, after the first and
    /// with some left to say. Apple ends a final about as long after its last word as
    /// the coverage slack.
    #[cfg(any(target_os = "macos", test))]
    fn agent_jumped_in(&self, first_word: u64, end: u64) -> bool {
        self.agent_starts
            .iter()
            .any(|&at| first_word < at && at + FINAL_COVERAGE_SLACK_SAMPLES <= end)
    }

    /// Interim text is best effort: a full event queue drops it rather than stall recognition.
    fn show_interim(&mut self, events: &tokio_mpsc::Sender<VoiceInputEvent>, text: &str) {
        if self.interim != text {
            self.interim = text.to_string();
            let _ = events.try_send(VoiceInputEvent::InterimTranscript(self.interim.clone()));
        }
    }

    fn result_is_current(&self) -> bool {
        !self.ambiguous && self.count == self.blocking
    }

    fn resolve(&mut self, events: &tokio_mpsc::Sender<VoiceInputEvent>) -> Result<(), ()> {
        if self.count == 0 || self.ambiguous {
            return Ok(());
        }
        let current = self.result_is_current();
        self.count -= 1;
        self.ends.pop_front();
        self.expired.pop_front();
        if current {
            self.blocking -= 1;
            if self.blocking == 0 {
                events
                    .blocking_send(VoiceInputEvent::RecognitionPendingChanged(false))
                    .map_err(|_| ())?;
            }
        }
        Ok(())
    }

    /// Gives up the hold while its turns' finals are still to come, and stops waiting on
    /// interim words whose final never came, so later holds keep their timeout.
    #[cfg(target_os = "macos")]
    fn expire(&mut self, events: &tokio_mpsc::Sender<VoiceInputEvent>) -> Result<(), ()> {
        use crate::detection::Wait;
        let wait = if self.unfinalized {
            Wait::Words
        } else {
            Wait::Timeout
        };
        self.release_hold(events)?;
        self.unfinalized = false;
        self.expired.resize(self.count, wait);
        Ok(())
    }

    fn release_hold(&mut self, events: &tokio_mpsc::Sender<VoiceInputEvent>) -> Result<(), ()> {
        if self.blocking > 0 {
            self.blocking = 0;
            events
                .blocking_send(VoiceInputEvent::RecognitionPendingChanged(false))
                .map_err(|_| ())?;
        }
        Ok(())
    }

    fn reset(&mut self, events: &tokio_mpsc::Sender<VoiceInputEvent>) -> Result<(), ()> {
        self.release_hold(events)?;
        self.show_interim(events, "");
        *self = Self::new();
        Ok(())
    }
}

fn effective_mute_epoch(
    controls: &VoiceInputControls,
    shutdown: &AtomicBool,
    shutdown_mute_epoch: &AtomicU64,
) -> (bool, u64) {
    let live_epoch = controls.mute_epoch();
    if shutdown.load(Ordering::Acquire) {
        // Freeze the epoch at shutdown initiation. A later hardware-mute
        // callback must not retroactively discard an already accepted final
        // utterance from an unmuted shutdown.
        (true, shutdown_mute_epoch.load(Ordering::Acquire))
    } else {
        (false, live_epoch)
    }
}

fn resample(resampler: &mut rubato::Fft<f32>, samples: &[f32]) -> Vec<f32> {
    use audioadapter_buffers::direct::InterleavedSlice;
    use rubato::Resampler;

    let Ok(input) = InterleavedSlice::new(samples, 1, samples.len()) else {
        return Vec::new();
    };
    let output_capacity = resampler.output_frames_max();
    let mut output = vec![0.0; output_capacity];
    let Ok(mut output_buffer) = InterleavedSlice::new_mut(&mut output, 1, output_capacity) else {
        return Vec::new();
    };
    let Ok((_, produced)) = resampler.process_into_buffer(&input, &mut output_buffer, None) else {
        return Vec::new();
    };
    output.truncate(produced);
    output
}

fn clamp_vad_frame(samples: &[f32]) -> Vec<f32> {
    samples
        .iter()
        .map(|sample| sample.clamp(-1.0, 1.0))
        .collect()
}

fn send_final(
    events: &tokio_mpsc::Sender<VoiceInputEvent>,
    text: String,
    storage_deadline: Option<Instant>,
) -> Result<(), ()> {
    let (receipt, receiver) = if storage_deadline.is_some() {
        let (sender, receiver) = mpsc::sync_channel(0);
        (FinalTranscriptStorageReceipt(Some(sender)), Some(receiver))
    } else {
        (FinalTranscriptStorageReceipt(None), None)
    };
    events
        .blocking_send(VoiceInputEvent::FinalTranscript {
            text,
            storage_receipt: receipt,
        })
        .map_err(|_| ())?;
    if let (Some(deadline), Some(receiver)) = (storage_deadline, receiver) {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if !remaining.is_zero() {
            let _ = receiver.recv_timeout(remaining);
        }
    }
    Ok(())
}

fn clear_speech_state(
    speech: &mut Vec<f32>,
    input_48k: &mut Vec<f32>,
    leftover_16k: &mut Vec<f32>,
    silence_frames: &mut usize,
    in_speech: &mut bool,
    events: &tokio_mpsc::Sender<VoiceInputEvent>,
) {
    speech.clear();
    input_48k.clear();
    leftover_16k.clear();
    *silence_frames = 0;
    if std::mem::take(in_speech) {
        let _ = events.blocking_send(VoiceInputEvent::SpeakingReset);
    }
}

struct ParakeetUtterance {
    sequence: u64,
    speech: Vec<f32>,
    mute_epoch: u64,
}

struct ParakeetRecognition {
    sequence: u64,
    text: String,
    mute_epoch: u64,
}

struct PendingParakeetRecognition {
    sequence: u64,
    mute_epoch: u64,
}

struct ParakeetRecognitionLedger {
    next_sequence: u64,
    pending: VecDeque<PendingParakeetRecognition>,
}

impl ParakeetRecognitionLedger {
    fn new() -> Self {
        Self {
            next_sequence: 0,
            pending: VecDeque::new(),
        }
    }

    fn next_sequence(&self) -> Result<u64, String> {
        self.next_sequence
            .checked_add(1)
            .ok_or_else(|| "Parakeet recognition sequence is exhausted.".to_string())
    }

    fn record(&mut self, sequence: u64, mute_epoch: u64) {
        self.next_sequence = sequence;
        self.pending.push_back(PendingParakeetRecognition {
            sequence,
            mute_epoch,
        });
    }

    fn take(&mut self, sequence: u64) -> Result<PendingParakeetRecognition, String> {
        let Some(expected) = self.pending.pop_front() else {
            return Err("Parakeet recognition produced an unexpected result.".to_string());
        };
        if expected.sequence != sequence {
            return Err("Parakeet recognition results arrived out of order.".to_string());
        }
        Ok(expected)
    }

    fn remove(&mut self, sequence: u64) -> Result<PendingParakeetRecognition, String> {
        let Some(index) = self
            .pending
            .iter()
            .position(|pending| pending.sequence == sequence)
        else {
            return Err("Parakeet recognition replacement was not pending.".to_string());
        };
        self.pending
            .remove(index)
            .ok_or_else(|| "Parakeet recognition replacement disappeared.".to_string())
    }
}

struct ParakeetMailbox {
    state: Mutex<ParakeetMailboxState>,
    ready: Condvar,
}

struct ParakeetMailboxState {
    open: bool,
    waiting: Option<ParakeetUtterance>,
}

impl ParakeetMailbox {
    fn new() -> Self {
        Self {
            state: Mutex::new(ParakeetMailboxState {
                open: true,
                waiting: None,
            }),
            ready: Condvar::new(),
        }
    }

    fn try_submit(
        &self,
        utterance: ParakeetUtterance,
    ) -> Result<Option<ParakeetUtterance>, String> {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if !state.open {
            return Err("Parakeet recognition is no longer running.".to_string());
        }
        let displaced = match state.waiting.as_ref() {
            Some(waiting) if waiting.mute_epoch == utterance.mute_epoch => {
                return Err(
                    "Parakeet recognition overrun: completed utterances arrived faster than they could be decoded."
                        .to_string(),
                );
            }
            Some(_) => state.waiting.replace(utterance),
            None => {
                state.waiting = Some(utterance);
                None
            }
        };
        self.ready.notify_one();
        Ok(displaced)
    }

    fn receive(&self) -> Option<ParakeetUtterance> {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        loop {
            if let Some(utterance) = state.waiting.take() {
                return Some(utterance);
            }
            if !state.open {
                return None;
            }
            state = self
                .ready
                .wait(state)
                .unwrap_or_else(std::sync::PoisonError::into_inner);
        }
    }

    fn close(&self) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.open = false;
        self.ready.notify_one();
    }
}

struct ParakeetDecoder {
    utterances: Option<Arc<ParakeetMailbox>>,
    results: Receiver<ParakeetRecognition>,
    worker: Option<thread::JoinHandle<()>>,
}

impl ParakeetDecoder {
    fn start(
        controls: VoiceInputControls,
        shutdown: Arc<AtomicBool>,
        discard_on_shutdown: Arc<AtomicBool>,
        shutdown_mute_epoch: Arc<AtomicU64>,
        mut recognize: impl FnMut(&[f32]) -> String + Send + 'static,
    ) -> Result<Self, String> {
        let utterances = Arc::new(ParakeetMailbox::new());
        let worker_utterances = Arc::clone(&utterances);
        // Only the capture worker submits utterances and drains results. While
        // it is occupied, at most the in-flight decode plus the bounded
        // utterance queue can produce results, so this channel is structurally
        // bounded without making the decoder wait on capture.
        let (result_tx, result_rx) = mpsc::sync_channel(PARAKEET_RESULT_QUEUE_DEPTH);
        let worker = thread::Builder::new()
            .name("berd-parakeet-decode".to_string())
            .spawn(move || {
                while let Some(utterance) = worker_utterances.receive() {
                    let (shutting_down, current_epoch) =
                        effective_mute_epoch(&controls, &shutdown, &shutdown_mute_epoch);
                    let discard = shutting_down && discard_on_shutdown.load(Ordering::Acquire);
                    let text = if !discard && current_epoch == utterance.mute_epoch {
                        recognize(&utterance.speech)
                    } else {
                        String::new()
                    };
                    if result_tx
                        .send(ParakeetRecognition {
                            sequence: utterance.sequence,
                            text,
                            mute_epoch: utterance.mute_epoch,
                        })
                        .is_err()
                    {
                        break;
                    }
                }
            })
            .map_err(|error| format!("start Parakeet recognition worker: {error}"))?;
        Ok(Self {
            utterances: Some(utterances),
            results: result_rx,
            worker: Some(worker),
        })
    }

    fn try_submit(
        &self,
        utterance: ParakeetUtterance,
    ) -> Result<Option<ParakeetUtterance>, String> {
        let Some(sender) = self.utterances.as_ref() else {
            return Err("Parakeet recognition is no longer running.".to_string());
        };
        sender.try_submit(utterance)
    }

    fn close(&mut self) {
        if let Some(sender) = self.utterances.take() {
            sender.close();
        }
    }

    fn is_finished(&self) -> bool {
        self.worker
            .as_ref()
            .is_none_or(thread::JoinHandle::is_finished)
    }

    fn discard_ready_results(&self) {
        while self.results.try_recv().is_ok() {}
    }

    fn finish(&mut self) -> thread::Result<()> {
        self.close();
        if let Some(worker) = self.worker.take() {
            worker.join()
        } else {
            Ok(())
        }
    }
}

fn submit_parakeet_utterance(
    decoder: &ParakeetDecoder,
    speech: Vec<f32>,
    mute_epoch: u64,
    ledger: &mut ParakeetRecognitionLedger,
    pending: &mut PendingRecognitions,
    events: &tokio_mpsc::Sender<VoiceInputEvent>,
) -> Result<(), String> {
    if speech.is_empty() {
        return Ok(());
    }
    let sequence = ledger.next_sequence()?;
    let displaced = decoder.try_submit(ParakeetUtterance {
        sequence,
        speech,
        mute_epoch,
    })?;
    if let Some(displaced) = displaced {
        ledger.remove(displaced.sequence)?;
    }
    ledger.record(sequence, mute_epoch);
    pending
        .begin(events)
        .map_err(|_| "voice input event receiver closed".to_string())
}

#[allow(clippy::too_many_arguments)]
fn drain_parakeet_results(
    decoder: &ParakeetDecoder,
    events: &tokio_mpsc::Sender<VoiceInputEvent>,
    ledger: &mut ParakeetRecognitionLedger,
    pending: &mut PendingRecognitions,
    storage_deadline: Option<Instant>,
    controls: &VoiceInputControls,
    shutdown: &AtomicBool,
    discard_on_shutdown: &AtomicBool,
    shutdown_mute_epoch: &AtomicU64,
) -> Result<(), String> {
    loop {
        let result = match decoder.results.try_recv() {
            Ok(result) => result,
            Err(mpsc::TryRecvError::Empty) => return Ok(()),
            Err(mpsc::TryRecvError::Disconnected) if decoder.utterances.is_none() => return Ok(()),
            Err(mpsc::TryRecvError::Disconnected) => {
                return Err("Parakeet recognition stopped unexpectedly.".to_string());
            }
        };
        let expected = ledger.take(result.sequence)?;
        if expected.mute_epoch != result.mute_epoch {
            return Err("Parakeet recognition result epoch did not match its request.".to_string());
        }
        let (shutting_down, current_epoch) =
            effective_mute_epoch(controls, shutdown, shutdown_mute_epoch);
        if (shutting_down && discard_on_shutdown.load(Ordering::Acquire))
            || result.mute_epoch != current_epoch
        {
            continue;
        }
        complete_parakeet_recognition(result.text, events, pending, storage_deadline);
    }
}

#[allow(clippy::too_many_arguments)]
fn parakeet_worker(
    model_dir: PathBuf,
    frames: Receiver<QueuedFrame>,
    events: tokio_mpsc::Sender<VoiceInputEvent>,
    shutdown: Arc<AtomicBool>,
    discard_on_shutdown: Arc<AtomicBool>,
    shutdown_mute_epoch: Arc<AtomicU64>,
    controls: VoiceInputControls,
    speech_vad_threshold: f32,
) {
    use rubato::{Fft, FixedSync};

    let resampler = match Fft::<f32>::new(INPUT_SAMPLE_RATE, 16_000, 1024, 2, 1, FixedSync::Input) {
        Ok(resampler) => resampler,
        Err(error) => {
            let _ = events.blocking_send(VoiceInputEvent::Failed(format!(
                "Could not initialize native audio resampling: {error}"
            )));
            return;
        }
    };
    let recognizer = match ParakeetRecognizer::load(&model_dir) {
        Ok(recognizer) => recognizer,
        Err(error) => {
            let _ = events.blocking_send(VoiceInputEvent::Failed(error));
            return;
        }
    };
    parakeet_coordinator(
        resampler,
        frames,
        events,
        shutdown,
        discard_on_shutdown,
        shutdown_mute_epoch,
        controls,
        speech_vad_threshold,
        move |speech| recognizer.recognize_utterance(speech),
    );
}

#[allow(clippy::too_many_arguments)]
fn parakeet_coordinator(
    mut resampler: rubato::Fft<f32>,
    frames: Receiver<QueuedFrame>,
    events: tokio_mpsc::Sender<VoiceInputEvent>,
    shutdown: Arc<AtomicBool>,
    discard_on_shutdown: Arc<AtomicBool>,
    shutdown_mute_epoch: Arc<AtomicU64>,
    controls: VoiceInputControls,
    speech_vad_threshold: f32,
    recognize: impl FnMut(&[f32]) -> String + Send + 'static,
) {
    use rubato::Resampler;

    let mut decoder = match ParakeetDecoder::start(
        controls.clone(),
        Arc::clone(&shutdown),
        Arc::clone(&discard_on_shutdown),
        Arc::clone(&shutdown_mute_epoch),
        recognize,
    ) {
        Ok(decoder) => decoder,
        Err(error) => {
            let _ = events.blocking_send(VoiceInputEvent::Failed(error));
            return;
        }
    };
    let chunk_in = resampler.input_frames_next();
    let mut vad = earshot::Detector::new(earshot::DefaultPredictor::new());
    let mut input_48k = Vec::new();
    let mut leftover_16k = Vec::new();
    let mut speech = Vec::new();
    let mut silence_frames = 0;
    let mut in_speech = false;
    let mut observed_epoch = controls.mute_epoch();
    let mut pending = PendingRecognitions::new();
    let mut ledger = ParakeetRecognitionLedger::new();
    let mut terminal_failure = false;
    if events.blocking_send(VoiceInputEvent::Ready).is_err() {
        let _ = decoder.finish();
        return;
    }

    'capture: loop {
        if let Err(error) = drain_parakeet_results(
            &decoder,
            &events,
            &mut ledger,
            &mut pending,
            None,
            &controls,
            &shutdown,
            &discard_on_shutdown,
            &shutdown_mute_epoch,
        ) {
            let _ = events.blocking_send(VoiceInputEvent::Failed(error));
            terminal_failure = true;
            break;
        }
        let frame = match frames.recv_timeout(Duration::from_millis(50)) {
            Ok(frame) => Some(frame),
            Err(mpsc::RecvTimeoutError::Timeout) => None,
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        };
        let (shutting_down, current_epoch) =
            effective_mute_epoch(&controls, &shutdown, &shutdown_mute_epoch);
        if current_epoch != observed_epoch {
            observed_epoch = current_epoch;
            clear_speech_state(
                &mut speech,
                &mut input_48k,
                &mut leftover_16k,
                &mut silence_frames,
                &mut in_speech,
                &events,
            );
            let _ = pending.reset(&events);
        }
        if shutting_down && (discard_on_shutdown.load(Ordering::Acquire) || frame.is_none()) {
            break;
        }
        if !shutting_down && controls.is_muted() {
            continue;
        }
        let Some(frame) = frame else { continue };
        if frame.mute_epoch != observed_epoch {
            continue;
        }
        input_48k.extend_from_slice(frame.frame.samples());
        while input_48k.len() >= chunk_in {
            let chunk: Vec<f32> = input_48k.drain(..chunk_in).collect();
            leftover_16k.extend_from_slice(&resample(&mut resampler, &chunk));
            while leftover_16k.len() >= VAD_FRAME_SAMPLES {
                let frame: Vec<f32> = leftover_16k.drain(..VAD_FRAME_SAMPLES).collect();
                let clamped = clamp_vad_frame(&frame);
                let threshold = controls.vad_threshold(speech_vad_threshold);
                if vad.predict_f32(&clamped) > threshold {
                    silence_frames = 0;
                    speech.extend_from_slice(&frame);
                    if !in_speech {
                        in_speech = true;
                        let _ = events.blocking_send(VoiceInputEvent::SpeakingChanged(true));
                    }
                } else if in_speech {
                    silence_frames += 1;
                    speech.extend_from_slice(&frame);
                    if silence_frames >= SILENCE_FLUSH_FRAMES {
                        silence_frames = 0;
                        in_speech = false;
                        let utterance = std::mem::take(&mut speech);
                        let queued = submit_parakeet_utterance(
                            &decoder,
                            utterance,
                            observed_epoch,
                            &mut ledger,
                            &mut pending,
                            &events,
                        );
                        let _ = events.blocking_send(VoiceInputEvent::SpeakingChanged(false));
                        if let Err(error) = queued {
                            let _ = events.blocking_send(VoiceInputEvent::Failed(error));
                            terminal_failure = true;
                            break 'capture;
                        }
                    }
                }
                if speech.len() >= MAX_SPEECH_SAMPLES {
                    let utterance = std::mem::take(&mut speech);
                    silence_frames = 0;
                    let was_speaking = std::mem::take(&mut in_speech);
                    let queued = submit_parakeet_utterance(
                        &decoder,
                        utterance,
                        observed_epoch,
                        &mut ledger,
                        &mut pending,
                        &events,
                    );
                    if was_speaking {
                        let _ = events.blocking_send(VoiceInputEvent::SpeakingChanged(false));
                    }
                    if let Err(error) = queued {
                        let _ = events.blocking_send(VoiceInputEvent::Failed(error));
                        terminal_failure = true;
                        break 'capture;
                    }
                }
            }
        }
    }

    let discard = discard_on_shutdown.load(Ordering::Acquire);
    if !terminal_failure && !discard && !speech.is_empty() {
        if let Err(error) = submit_parakeet_utterance(
            &decoder,
            speech,
            observed_epoch,
            &mut ledger,
            &mut pending,
            &events,
        ) {
            let _ = events.blocking_send(VoiceInputEvent::Failed(error));
            terminal_failure = true;
        }
    }
    decoder.close();
    let storage_deadline = Instant::now() + FINAL_STORAGE_TIMEOUT;
    while !decoder.is_finished() {
        if !terminal_failure && !discard {
            if let Err(error) = drain_parakeet_results(
                &decoder,
                &events,
                &mut ledger,
                &mut pending,
                Some(storage_deadline),
                &controls,
                &shutdown,
                &discard_on_shutdown,
                &shutdown_mute_epoch,
            ) {
                let _ = events.blocking_send(VoiceInputEvent::Failed(error));
                terminal_failure = true;
            }
        } else {
            decoder.discard_ready_results();
        }
        thread::sleep(Duration::from_millis(5));
    }
    if !terminal_failure && !discard {
        if let Err(error) = drain_parakeet_results(
            &decoder,
            &events,
            &mut ledger,
            &mut pending,
            Some(storage_deadline),
            &controls,
            &shutdown,
            &discard_on_shutdown,
            &shutdown_mute_epoch,
        ) {
            let _ = events.blocking_send(VoiceInputEvent::Failed(error));
        }
    }
    let decoder_result = decoder.finish();
    let _ = pending.reset(&events);
    if let Err(payload) = decoder_result {
        if !terminal_failure {
            let _ = events.blocking_send(VoiceInputEvent::Failed(
                "Parakeet recognition stopped unexpectedly.".to_string(),
            ));
        }
        std::panic::resume_unwind(payload);
    }
}

fn complete_parakeet_recognition(
    text: String,
    events: &tokio_mpsc::Sender<VoiceInputEvent>,
    pending: &mut PendingRecognitions,
    storage_deadline: Option<Instant>,
) {
    if !text.is_empty() {
        let _ = send_final(events, text, storage_deadline);
    }
    let _ = pending.resolve(events);
}

#[cfg(target_os = "macos")]
fn new_mac_recognizer(
    hints: &[String],
) -> Result<
    (
        crate::mac_speech::MacSpeechRecognizer,
        tokio_mpsc::UnboundedReceiver<crate::mac_speech::MacSpeechRecognitionEvent>,
    ),
    String,
> {
    crate::mac_speech::MacSpeechRecognizer::with_hints(hints)
}

#[cfg(target_os = "macos")]
fn forward_mac_events_with_detection(
    recognition_events: &mut tokio_mpsc::UnboundedReceiver<
        crate::mac_speech::MacSpeechRecognitionEvent,
    >,
    events: &tokio_mpsc::Sender<VoiceInputEvent>,
    pending: &mut PendingRecognitions,
    settle_deadline: &mut Option<Instant>,
    storage_deadline: Option<Instant>,
    controls: Option<(&VoiceInputControls, u64)>,
) -> Result<(), ()> {
    while let Ok(event) = recognition_events.try_recv() {
        match event {
            crate::mac_speech::MacSpeechRecognitionEvent::Final(text, end) => {
                use crate::detection::Wait;
                let text = text.trim().to_string();
                // What a final says about the waits and release, read before it resolves turns.
                let (now, has_words, words) =
                    (Instant::now(), !text.is_empty(), pending.unfinalized);
                let waiting = settle_deadline.filter(|_| pending.result_is_current());
                let first_word = pending.first_word.take();
                if !text.is_empty() {
                    if let Some((controls, epoch)) =
                        controls.filter(|_| pending.result_is_current())
                    {
                        controls.detection_result(true, epoch);
                    }
                    send_final(events, text, storage_deadline)?;
                } else if let Some((controls, epoch)) =
                    controls.filter(|_| pending.result_is_current())
                {
                    controls.detection_result(false, epoch);
                }
                // One final can span several turns split by pauses, and one turn
                // can produce several finals, so a final with an end resolves
                // exactly the turns it covers. Without one it resolves the oldest.
                pending.unfinalized = false;
                pending.final_end = pending.final_end.max(end);
                let resolved = end.map_or(1, |end| pending.covered(end));
                let late = pending.expired.front().copied().filter(|_| resolved > 0);
                for _ in 0..resolved {
                    pending.resolve(events)?;
                }
                if let (true, Some((controls, epoch))) = (has_words, controls) {
                    let on_time = waiting
                        .filter(|_| pending.blocking == 0)
                        .and_then(|deadline| match (now < deadline, words) {
                            (true, _) => Some(Wait::Timeout),
                            (false, true) => Some(Wait::Words),
                            (false, false) => None,
                        });
                    // A split sentence is one the agent could have jumped into.
                    let jumped = first_word
                        .zip(end)
                        .filter(|_| resolved > 1)
                        .map(|(first, end)| pending.agent_jumped_in(first, end));
                    controls.tune(epoch, |tuner| {
                        if let Some(wait) = late {
                            tuner.hold_final(wait, true);
                        } else if let Some(wait) = on_time {
                            tuner.hold_final(wait, false);
                        }
                        if let Some(jumped) = jumped {
                            tuner.split_final(jumped);
                        }
                    });
                }
                if let Some(end) = end {
                    pending.agent_starts.retain(|&at| at > end);
                }
                if let Some(trace) = controls.and_then(|(controls, _)| controls.shared.trace.get())
                {
                    trace.recognized(end, resolved);
                }
                if pending.blocking == 0 {
                    *settle_deadline = None;
                }
                if !pending.words_outstanding() {
                    pending.show_interim(events, "");
                }
            }
            crate::mac_speech::MacSpeechRecognitionEvent::FinalStart(start) => {
                pending.first_word = Some(start);
            }
            crate::mac_speech::MacSpeechRecognitionEvent::Heard(end, text) => {
                pending.unfinalized = true;
                pending.show_interim(events, &text);
                // Apple repeats interim results, so only new audio is traced.
                if end > pending.heard {
                    pending.heard = end;
                    if let Some(trace) =
                        controls.and_then(|(controls, _)| controls.shared.trace.get())
                    {
                        trace.recognition("heard", end);
                    }
                }
            }
            crate::mac_speech::MacSpeechRecognitionEvent::Settled(start) => {
                if let Some(trace) = controls.and_then(|(controls, _)| controls.shared.trace.get())
                {
                    trace.recognition("settled", start);
                }
            }
            crate::mac_speech::MacSpeechRecognitionEvent::Finished => {
                if storage_deadline.is_none() {
                    pending.reset(events)?;
                    *settle_deadline = None;
                    let _ = events.blocking_send(VoiceInputEvent::Failed(
                        "macOS speech recognition stopped unexpectedly.".to_string(),
                    ));
                    return Err(());
                }
                // SpeechTranscriber exposes no per-utterance no-result event.
                // Native finish is the bounded no-result resolution point.
                pending.reset(events)?;
                *settle_deadline = None;
            }
            crate::mac_speech::MacSpeechRecognitionEvent::Failed(message) => {
                if storage_deadline.is_none() {
                    let _ = events.blocking_send(VoiceInputEvent::Failed(message));
                }
                pending.reset(events)?;
                return Err(());
            }
        }
    }
    Ok(())
}

#[cfg(all(test, target_os = "macos"))]
fn forward_mac_events(
    recognition_events: &mut tokio_mpsc::UnboundedReceiver<
        crate::mac_speech::MacSpeechRecognitionEvent,
    >,
    events: &tokio_mpsc::Sender<VoiceInputEvent>,
    pending: &mut PendingRecognitions,
    settle_deadline: &mut Option<Instant>,
    storage_deadline: Option<Instant>,
) -> Result<(), ()> {
    forward_mac_events_with_detection(
        recognition_events,
        events,
        pending,
        settle_deadline,
        storage_deadline,
        None,
    )
}

/// Numbers detector frames, recognizer generations and settings revisions for a trace.
#[cfg(any(target_os = "macos", test))]
struct FrameTracer {
    trace: Option<Arc<dyn DetectionTrace>>,
    vad_frame: u64,
    generation: u64,
    settings: Option<(u64, crate::detection::DetectionSettings)>,
}

#[cfg(any(target_os = "macos", test))]
impl FrameTracer {
    fn new(trace: Option<Arc<dyn DetectionTrace>>) -> Self {
        Self {
            trace,
            vad_frame: 0,
            generation: 0,
            settings: None,
        }
    }

    fn began(&mut self, reason: &'static str) {
        self.generation += 1;
        self.ended(reason);
    }

    fn ended(&self, reason: &'static str) {
        if let Some(trace) = &self.trace {
            trace.recognizer(self.generation, reason);
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn frame(
        &mut self,
        mic_sample: u64,
        epoch: u64,
        settings: crate::detection::DetectionSettings,
        mode: crate::vad_replay::Mode,
        probability: f32,
        detected: bool,
        active: bool,
    ) {
        let Some(trace) = &self.trace else { return };
        let revision = match self.settings {
            Some((revision, current)) if current == settings => revision,
            previous => {
                let revision = previous.map_or(0, |(revision, _)| revision + 1);
                trace.settings(revision, settings);
                self.settings = Some((revision, settings));
                revision
            }
        };
        trace.frame(TracedFrame {
            mic_sample,
            vad_frame: self.vad_frame,
            epoch,
            generation: self.generation,
            mode,
            probability,
            threshold: threshold(settings, mode),
            detected,
            active,
            settings_revision: revision,
        });
        self.vad_frame += 1;
    }
}

/// The 48 kHz microphone sample just past a detector frame. `consumed` input and
/// `produced` output samples, through the frame's end, count everything the
/// resampler has seen; its output lags its input by `delay` output samples.
#[cfg(any(target_os = "macos", test))]
fn detector_frame_end(chunk_end: u64, consumed: u64, produced: u64, delay: usize) -> u64 {
    let ratio = (INPUT_SAMPLE_RATE / 16_000) as u64;
    let lag = consumed.saturating_sub(ratio * produced.saturating_sub(delay as u64));
    chunk_end.saturating_sub(lag)
}

#[cfg(target_os = "macos")]
fn begin_mac_turn(
    pending: &mut PendingRecognitions,
    events: &tokio_mpsc::Sender<VoiceInputEvent>,
    settle_deadline: &mut Option<Instant>,
) -> Result<(), ()> {
    pending.begin_bounded(events, MAX_PENDING_RECOGNITIONS)?;
    *settle_deadline = None;
    Ok(())
}

#[cfg(target_os = "macos")]
fn end_mac_turn(
    pending: &PendingRecognitions,
    settle_deadline: &mut Option<Instant>,
    now: Instant,
    timeout: Duration,
) {
    if pending.blocking > 0 {
        *settle_deadline = Some(now + timeout);
    }
}

#[cfg(target_os = "macos")]
fn mac_settle_expired(
    pending: &PendingRecognitions,
    settle_deadline: Option<Instant>,
    now: Instant,
    words_wait: Duration,
) -> bool {
    pending.blocking > 0
        && settle_deadline.is_some_and(|deadline| {
            now >= deadline && (!pending.words_outstanding() || now >= deadline + words_wait)
        })
}

#[cfg(target_os = "macos")]
#[allow(clippy::too_many_arguments)]
fn mac_speech_worker(
    frames: Receiver<QueuedFrame>,
    events: tokio_mpsc::Sender<VoiceInputEvent>,
    shutdown: Arc<AtomicBool>,
    discard_on_shutdown: Arc<AtomicBool>,
    shutdown_mute_epoch: Arc<AtomicU64>,
    controls: VoiceInputControls,
    speech_vad_threshold: f32,
    hints: Vec<String>,
) {
    use rubato::{Fft, FixedSync, Resampler};

    let (mut recognizer, mut recognition_events) = match new_mac_recognizer(&hints) {
        Ok(session) => session,
        Err(error) => {
            let _ = events.blocking_send(VoiceInputEvent::Failed(error));
            return;
        }
    };
    let mut resampler =
        match Fft::<f32>::new(INPUT_SAMPLE_RATE, 16_000, 1024, 2, 1, FixedSync::Input) {
            Ok(resampler) => resampler,
            Err(error) => {
                let _ = events.blocking_send(VoiceInputEvent::Failed(format!(
                    "Could not initialize native audio resampling: {error}"
                )));
                return;
            }
        };
    let chunk_in = resampler.input_frames_next();
    let mut vad = earshot::Detector::new(earshot::DefaultPredictor::new());
    let mut input_48k = Vec::new();
    let mut leftover_16k = Vec::new();
    let mut gate = crate::detection::SpeechGate::default();
    let mut in_speech = false;
    let mut observed_epoch = controls.mute_epoch();
    let mut pending = PendingRecognitions::new();
    let mut settle_deadline = None;
    let mut received_audio = false;
    // Samples pushed to the current recognizer, the timeline its finals report.
    let mut recognized = 0_u64;
    let mut agent_starts = controls.shared.assistant_starts.load(Ordering::Acquire);
    let mut tracer = FrameTracer::new(controls.shared.trace.get().cloned());
    let (mut consumed, mut produced) = (0_u64, 0_u64);
    if events.blocking_send(VoiceInputEvent::Ready).is_err() {
        return;
    }
    tracer.began("start");

    loop {
        if forward_mac_events_with_detection(
            &mut recognition_events,
            &events,
            &mut pending,
            &mut settle_deadline,
            None,
            Some((&controls, observed_epoch)),
        )
        .is_err()
        {
            return;
        }
        let words_wait = controls
            .effective_detection(speech_vad_threshold)
            .0
            .interim_words_wait_ms;
        if mac_settle_expired(
            &pending,
            settle_deadline,
            Instant::now(),
            Duration::from_millis(words_wait.into()),
        ) {
            // Release admission only. Keep native recognition and all its queued
            // events/audio alive so late finals still reach the conversation.
            if pending.expire(&events).is_err() {
                return;
            }
            pending.show_interim(&events, "");
            settle_deadline = None;
        }
        let frame = match frames.recv_timeout(Duration::from_millis(50)) {
            Ok(frame) => Some(frame),
            Err(mpsc::RecvTimeoutError::Timeout) => None,
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        };
        let (shutting_down, current_epoch) =
            effective_mute_epoch(&controls, &shutdown, &shutdown_mute_epoch);
        if current_epoch != observed_epoch {
            observed_epoch = current_epoch;
            if let Ok(mut detection) = controls.shared.detection.lock() {
                if let Some(tuner) = detection.as_mut() {
                    tuner.reset_evidence();
                }
            }
            input_48k.clear();
            leftover_16k.clear();
            gate = crate::detection::SpeechGate::default();
            if std::mem::take(&mut in_speech) {
                let _ = events.blocking_send(VoiceInputEvent::SpeakingReset);
            }
            let _ = pending.reset(&events);
            settle_deadline = None;
            agent_starts = controls.shared.assistant_starts.load(Ordering::Acquire);
            recognizer.cancel();
            if shutting_down {
                tracer.ended("cancel");
                return;
            }
            match new_mac_recognizer(&hints) {
                Ok((next, next_events)) => {
                    recognizer = next;
                    recognition_events = next_events;
                    received_audio = false;
                    recognized = 0;
                    tracer.began("epoch_change");
                }
                Err(error) => {
                    let _ = events.blocking_send(VoiceInputEvent::Failed(error));
                    return;
                }
            }
        }
        if shutting_down && (discard_on_shutdown.load(Ordering::Acquire) || frame.is_none()) {
            break;
        }
        if !shutting_down && controls.is_muted() {
            continue;
        }
        let Some(frame) = frame else { continue };
        if frame.mute_epoch != observed_epoch {
            continue;
        }
        if let Err(error) = recognizer.push_48khz_mono_f32(frame.frame.samples()) {
            let _ = pending.reset(&events);
            let _ = events.blocking_send(VoiceInputEvent::Failed(error));
            return;
        }
        received_audio = true;
        recognized += frame.frame.samples().len() as u64;
        // Speech the agent began since the last frame started about here on the recognizer's timeline.
        let starts = controls.shared.assistant_starts.load(Ordering::Acquire);
        if std::mem::replace(&mut agent_starts, starts) != starts {
            pending.agent_began(recognized);
        }

        input_48k.extend_from_slice(frame.frame.samples());
        let input_end = (frame.mic_frame + 1) * INPUT_FRAME_SAMPLES as u64;
        while input_48k.len() >= chunk_in {
            let chunk: Vec<f32> = input_48k.drain(..chunk_in).collect();
            let resampled = resample(&mut resampler, &chunk);
            consumed += chunk.len() as u64;
            produced += resampled.len() as u64;
            leftover_16k.extend_from_slice(&resampled);
            let chunk_end = input_end.saturating_sub(input_48k.len() as u64);
            while leftover_16k.len() >= VAD_FRAME_SAMPLES {
                let frame: Vec<f32> = leftover_16k.drain(..VAD_FRAME_SAMPLES).collect();
                let clamped = clamp_vad_frame(&frame);
                let (settings, mode) = controls.effective_detection(speech_vad_threshold);
                let probability = vad.predict_f32(&clamped);
                let detected = probability > threshold(settings, mode);
                let active = gate.observe(detected, settings.timing);
                tracer.frame(
                    detector_frame_end(
                        chunk_end,
                        consumed,
                        produced - leftover_16k.len() as u64,
                        resampler.output_delay(),
                    ),
                    observed_epoch,
                    settings,
                    mode,
                    probability,
                    detected,
                    active,
                );
                controls.observe_detection(active && detected, observed_epoch);
                if active != in_speech {
                    in_speech = active;
                    if active {
                        if begin_mac_turn(&mut pending, &events, &mut settle_deadline).is_err() {
                            return;
                        }
                    } else {
                        // Pushed audio runs slightly ahead of the detector, which
                        // only delays coverage.
                        if pending
                            .end_turn(
                                &events,
                                recognized
                                    .saturating_sub(u64::from(settings.timing.release_ms) * 48),
                            )
                            .is_err()
                        {
                            return;
                        }
                        end_mac_turn(
                            &pending,
                            &mut settle_deadline,
                            Instant::now(),
                            Duration::from_millis(settings.pending_utterance_timeout_ms.into()),
                        );
                    }
                    let _ = events.blocking_send(VoiceInputEvent::SpeakingChanged(active));
                }
            }
        }
        if forward_mac_events_with_detection(
            &mut recognition_events,
            &events,
            &mut pending,
            &mut settle_deadline,
            None,
            Some((&controls, observed_epoch)),
        )
        .is_err()
        {
            return;
        }
    }

    if in_speech {
        let _ = events.blocking_send(VoiceInputEvent::SpeakingChanged(false));
    }
    if discard_on_shutdown.load(Ordering::Acquire) || !received_audio {
        recognizer.cancel();
        tracer.ended("cancel");
        let _ = pending.reset(&events);
        return;
    }
    tracer.ended("finish");
    if let Err(error) = recognizer.finish() {
        let _ = pending.reset(&events);
        let _ = events.blocking_send(VoiceInputEvent::Failed(error));
        return;
    }
    let deadline = Instant::now() + FINAL_STORAGE_TIMEOUT;
    let _ = forward_mac_events_with_detection(
        &mut recognition_events,
        &events,
        &mut pending,
        &mut settle_deadline,
        Some(deadline),
        Some((&controls, observed_epoch)),
    );
    let _ = pending.reset(&events);
}

#[derive(Debug, PartialEq, Eq)]
struct OpenAiCommittedTurn {
    item_id: String,
    mute_epoch: u64,
    settle_deadline: Instant,
}

#[derive(Debug, PartialEq, Eq)]
struct OpenAiPendingCommit {
    mute_epoch: u64,
    settle_deadline: Instant,
}

fn block_on_openai_operation<F, T, E>(
    runtime: &tokio::runtime::Runtime,
    shutdown: &AtomicBool,
    future: F,
    action: &str,
) -> Result<Option<T>, String>
where
    F: std::future::Future<Output = Result<T, E>>,
    E: std::fmt::Display,
{
    runtime.block_on(async {
        let wait_for_shutdown = async {
            while !shutdown.load(Ordering::Acquire) {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        };
        tokio::select! {
            result = tokio::time::timeout(OPENAI_NETWORK_OPERATION_TIMEOUT, future) => {
                match result {
                    Ok(Ok(value)) => Ok(Some(value)),
                    Ok(Err(error)) => Err(format!("{action}: {error}")),
                    Err(_) => Err(format!("{action}: operation timed out")),
                }
            }
            () = wait_for_shutdown => Ok(None),
        }
    })
}

fn block_on_openai_timeout<F>(
    runtime: &tokio::runtime::Runtime,
    timeout: Duration,
    future: F,
) -> Result<F::Output, tokio::time::error::Elapsed>
where
    F: std::future::Future,
{
    runtime.block_on(async { tokio::time::timeout(timeout, future).await })
}

fn record_openai_event(
    event: OpenAiRealtimeTranscriptionEvent,
    current_epoch: u64,
    pending_commits: &mut VecDeque<OpenAiPendingCommit>,
    committed: &mut VecDeque<OpenAiCommittedTurn>,
    completed: &mut HashMap<String, String>,
) -> Option<OpenAiCommittedTurn> {
    match event {
        OpenAiRealtimeTranscriptionEvent::Committed { item_id } => {
            let pending = pending_commits.pop_front()?;
            let turn = OpenAiCommittedTurn {
                item_id,
                mute_epoch: pending.mute_epoch,
                settle_deadline: pending.settle_deadline,
            };
            if turn.mute_epoch == current_epoch {
                committed.push_back(OpenAiCommittedTurn {
                    item_id: turn.item_id.clone(),
                    mute_epoch: turn.mute_epoch,
                    settle_deadline: turn.settle_deadline,
                });
            }
            Some(turn)
        }
        OpenAiRealtimeTranscriptionEvent::Completed {
            item_id,
            transcript,
        } => {
            if committed
                .iter()
                .any(|turn| turn.item_id == item_id && turn.mute_epoch == current_epoch)
            {
                completed.insert(item_id, transcript);
            }
            None
        }
    }
}

fn openai_transcription_failure_is_current(
    item_id: &str,
    current_epoch: u64,
    committed: &VecDeque<OpenAiCommittedTurn>,
) -> bool {
    committed
        .iter()
        .any(|turn| turn.item_id == item_id && turn.mute_epoch == current_epoch)
}

fn openai_live_result_expired(
    pending_commits: &VecDeque<OpenAiPendingCommit>,
    committed: &VecDeque<OpenAiCommittedTurn>,
    now: Instant,
) -> bool {
    pending_commits
        .iter()
        .map(|turn| turn.settle_deadline)
        .chain(committed.iter().map(|turn| turn.settle_deadline))
        .min()
        .is_some_and(|deadline| now >= deadline)
}

fn track_openai_commit(pending_commits: &mut VecDeque<OpenAiPendingCommit>, mute_epoch: u64) {
    pending_commits.push_back(OpenAiPendingCommit {
        mute_epoch,
        settle_deadline: Instant::now() + OPENAI_LIVE_RESULT_TIMEOUT,
    });
}

fn deliver_openai_turns(
    committed: &mut VecDeque<OpenAiCommittedTurn>,
    completed: &mut HashMap<String, String>,
    events: &tokio_mpsc::Sender<VoiceInputEvent>,
    pending: &mut PendingRecognitions,
    final_item_id: Option<&str>,
    final_storage_deadline: Option<Instant>,
) {
    while committed
        .front()
        .is_some_and(|turn| completed.contains_key(&turn.item_id))
    {
        let turn = committed.pop_front().expect("checked front");
        let text = completed.remove(&turn.item_id).unwrap_or_default();
        let storage_deadline = (Some(turn.item_id.as_str()) == final_item_id)
            .then_some(final_storage_deadline)
            .flatten();
        if !text.is_empty() {
            let _ = send_final(events, text, storage_deadline);
        }
        let _ = pending.resolve(events);
    }
}

fn push_pre_roll(pre_roll: &mut VecDeque<Vec<u8>>, pcm: Vec<u8>) {
    pre_roll.push_back(pcm);
    while pre_roll.len() > OPENAI_PRE_ROLL_FRAMES {
        pre_roll.pop_front();
    }
}

#[allow(clippy::too_many_arguments)]
fn openai_worker(
    config: OpenAiRealtimeTranscriptionConfig,
    frames: Receiver<QueuedFrame>,
    events: tokio_mpsc::Sender<VoiceInputEvent>,
    shutdown: Arc<AtomicBool>,
    discard_on_shutdown: Arc<AtomicBool>,
    shutdown_mute_epoch: Arc<AtomicU64>,
    controls: VoiceInputControls,
    speech_vad_threshold: f32,
) {
    use rubato::{Fft, FixedSync, Resampler};

    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            let _ = events.blocking_send(VoiceInputEvent::Failed(format!(
                "Could not initialize OpenAI realtime transcription: {error}"
            )));
            return;
        }
    };
    let connection = block_on_openai_operation(
        &runtime,
        &shutdown,
        OpenAiRealtimeTranscriptionClient::connect(config),
        "connect to OpenAI realtime transcription",
    );
    let mut client = match connection {
        Ok(Some(client)) => client,
        Ok(None) => return,
        Err(error) => {
            let _ = events.blocking_send(VoiceInputEvent::Failed(error));
            return;
        }
    };
    match block_on_openai_operation(
        &runtime,
        &shutdown,
        client.configure(),
        "configure OpenAI realtime transcription",
    ) {
        Ok(Some(())) => {}
        Ok(None) => return,
        Err(error) => {
            let _ = events.blocking_send(VoiceInputEvent::Failed(error));
            return;
        }
    }

    let mut resampler = match Fft::<f32>::new(
        INPUT_SAMPLE_RATE,
        24_000,
        INPUT_FRAME_SAMPLES,
        2,
        1,
        FixedSync::Input,
    ) {
        Ok(resampler) => resampler,
        Err(error) => {
            let _ = events.blocking_send(VoiceInputEvent::Failed(format!(
                "Could not initialize OpenAI audio resampling: {error}"
            )));
            return;
        }
    };
    let chunk_in = resampler.input_frames_next();
    let mut vad = earshot::Detector::new(earshot::DefaultPredictor::new());
    let mut input_48k = Vec::new();
    let mut vad_16k = Vec::new();
    let mut silence_frames = 0;
    let mut in_speech = false;
    let mut turn_has_audio = false;
    let mut turn_samples_16k = 0_usize;
    let mut pre_roll = VecDeque::<Vec<u8>>::new();
    let mut observed_epoch = controls.mute_epoch();
    let mut pending_commits = VecDeque::<OpenAiPendingCommit>::new();
    let mut committed = VecDeque::<OpenAiCommittedTurn>::new();
    let mut completed = HashMap::<String, String>::new();
    let mut pending = PendingRecognitions::new();
    if events.blocking_send(VoiceInputEvent::Ready).is_err() {
        return;
    }

    macro_rules! send_operation {
        ($operation:expr, $action:literal, $on_shutdown:block) => {
            match block_on_openai_operation(&runtime, &shutdown, $operation, $action) {
                Ok(Some(())) => {}
                Ok(None) => {
                    let _ = pending.reset(&events);
                    $on_shutdown
                }
                Err(error) => {
                    let _ = pending.reset(&events);
                    let _ = events.blocking_send(VoiceInputEvent::Failed(error));
                    return;
                }
            }
        };
    }

    'worker: loop {
        let (shutting_down, current_epoch) =
            effective_mute_epoch(&controls, &shutdown, &shutdown_mute_epoch);
        if shutting_down {
            break;
        }
        if current_epoch != observed_epoch {
            observed_epoch = current_epoch;
            input_48k.clear();
            vad_16k.clear();
            silence_frames = 0;
            turn_has_audio = false;
            turn_samples_16k = 0;
            pre_roll.clear();
            pending_commits.clear();
            committed.clear();
            completed.clear();
            let _ = pending.reset(&events);
            if std::mem::take(&mut in_speech) {
                let _ = events.blocking_send(VoiceInputEvent::SpeakingReset);
            }
            send_operation!(client.clear(), "clear reset OpenAI transcription audio", {
                break 'worker;
            });
        }

        while let Ok(event) =
            block_on_openai_timeout(&runtime, Duration::from_millis(1), client.next_event())
        {
            let (shutting_down, current_epoch) =
                effective_mute_epoch(&controls, &shutdown, &shutdown_mute_epoch);
            if shutting_down {
                break 'worker;
            }
            if current_epoch != observed_epoch {
                continue 'worker;
            }
            let event = match event {
                Ok(event) => event,
                Err(TranscriptionError::TranscriptionFailed { item_id, message }) => {
                    let failure_is_current = openai_transcription_failure_is_current(
                        &item_id,
                        observed_epoch,
                        &committed,
                    );
                    if failure_is_current {
                        let _ = pending.reset(&events);
                        let _ = events.blocking_send(VoiceInputEvent::Failed(message));
                        return;
                    }
                    continue;
                }
                Err(error) => {
                    let _ = pending.reset(&events);
                    let _ = events.blocking_send(VoiceInputEvent::Failed(error.to_string()));
                    return;
                }
            };
            record_openai_event(
                event,
                observed_epoch,
                &mut pending_commits,
                &mut committed,
                &mut completed,
            );
            deliver_openai_turns(
                &mut committed,
                &mut completed,
                &events,
                &mut pending,
                None,
                None,
            );
        }
        if openai_live_result_expired(&pending_commits, &committed, Instant::now()) {
            let _ = pending.reset(&events);
            let _ = events.blocking_send(VoiceInputEvent::Failed(
                "OpenAI transcription did not complete within 5 seconds.".to_string(),
            ));
            return;
        }

        let frame = match frames.recv_timeout(INPUT_FRAME_DURATION) {
            Ok(frame) => Some(frame),
            Err(mpsc::RecvTimeoutError::Timeout) => None,
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        };
        let (shutting_down, current_epoch) =
            effective_mute_epoch(&controls, &shutdown, &shutdown_mute_epoch);
        if shutting_down {
            break;
        }
        if current_epoch != observed_epoch {
            continue 'worker;
        }
        if controls.is_muted() {
            continue;
        }
        let Some(frame) = frame else { continue };
        if frame.mute_epoch != observed_epoch {
            continue;
        }
        input_48k.extend_from_slice(frame.frame.samples());
        while input_48k.len() >= chunk_in {
            let chunk: Vec<f32> = input_48k.drain(..chunk_in).collect();
            let pcm_24k = resample(&mut resampler, &chunk);
            let pcm_bytes: Vec<u8> = pcm_24k
                .iter()
                .flat_map(|sample| {
                    ((sample.clamp(-1.0, 1.0) * i16::MAX as f32).round() as i16).to_le_bytes()
                })
                .collect();
            vad_16k.extend(chunk.iter().step_by(3).copied());
            let mut speech_started = false;
            let mut should_commit = false;
            while vad_16k.len() >= VAD_FRAME_SAMPLES {
                let frame: Vec<f32> = vad_16k.drain(..VAD_FRAME_SAMPLES).collect();
                if vad.predict_f32(&frame) > controls.vad_threshold(speech_vad_threshold) {
                    silence_frames = 0;
                    if !in_speech {
                        in_speech = true;
                        speech_started = true;
                        let _ = events.blocking_send(VoiceInputEvent::SpeakingChanged(true));
                    }
                } else if in_speech {
                    silence_frames += 1;
                    if silence_frames >= SILENCE_FLUSH_FRAMES {
                        should_commit = true;
                        silence_frames = 0;
                        in_speech = false;
                    }
                }
            }
            if speech_started {
                while let Some(bytes) = pre_roll.pop_front() {
                    send_operation!(
                        client.append_pcm16le_24khz(&bytes),
                        "stream OpenAI pre-roll",
                        {
                            break 'worker;
                        }
                    );
                }
            }
            if speech_started || in_speech || should_commit {
                send_operation!(
                    client.append_pcm16le_24khz(&pcm_bytes),
                    "stream audio to OpenAI transcription",
                    { break 'worker }
                );
                turn_has_audio = true;
                turn_samples_16k = turn_samples_16k.saturating_add(chunk.len() / 3);
            } else {
                push_pre_roll(&mut pre_roll, pcm_bytes);
            }
            if should_commit || turn_samples_16k >= MAX_SPEECH_SAMPLES {
                if pending.begin(&events).is_err() {
                    return;
                }
                send_operation!(client.commit(), "commit OpenAI transcription turn", {
                    break 'worker;
                });
                track_openai_commit(&mut pending_commits, observed_epoch);
                turn_has_audio = false;
                turn_samples_16k = 0;
                silence_frames = 0;
                if std::mem::take(&mut in_speech) || should_commit {
                    let _ = events.blocking_send(VoiceInputEvent::SpeakingChanged(false));
                }
            }
        }
    }

    if discard_on_shutdown.load(Ordering::Acquire) {
        let _ = pending.reset(&events);
        return;
    }
    let mut final_item_id = None::<String>;
    if turn_has_audio {
        if pending.begin(&events).is_err() {
            return;
        }
        let final_write =
            block_on_openai_timeout(&runtime, OPENAI_FINAL_WRITE_TIMEOUT, client.commit());
        if matches!(final_write, Ok(Ok(()))) {
            track_openai_commit(&mut pending_commits, observed_epoch);
        } else {
            let _ = pending.resolve(&events);
        }
    }
    let deadline = Instant::now() + FINAL_STORAGE_TIMEOUT;
    while Instant::now() < deadline {
        if committed.is_empty() && pending_commits.is_empty() && pending.count == 0 {
            break;
        }
        let Ok(event) =
            block_on_openai_timeout(&runtime, Duration::from_millis(50), client.next_event())
        else {
            continue;
        };
        let event = match event {
            Ok(event) => event,
            Err(TranscriptionError::TranscriptionFailed { item_id, message }) => {
                let failure_is_current =
                    openai_transcription_failure_is_current(&item_id, observed_epoch, &committed);
                if failure_is_current {
                    let _ = pending.reset(&events);
                    let _ = events.blocking_send(VoiceInputEvent::Failed(message));
                    break;
                }
                continue;
            }
            Err(TranscriptionError::Provider(message)) => {
                let _ = pending.reset(&events);
                let _ = events.blocking_send(VoiceInputEvent::Failed(message));
                break;
            }
            Err(TranscriptionError::Disconnected) | Err(TranscriptionError::Socket(_)) => continue,
        };
        if let Some(turn) = record_openai_event(
            event,
            observed_epoch,
            &mut pending_commits,
            &mut committed,
            &mut completed,
        ) {
            if turn.mute_epoch == observed_epoch && pending_commits.is_empty() && turn_has_audio {
                final_item_id = Some(turn.item_id);
            }
        }
        deliver_openai_turns(
            &mut committed,
            &mut completed,
            &events,
            &mut pending,
            final_item_id.as_deref(),
            Some(deadline),
        );
    }
    let _ = pending.reset(&events);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cue_auto_policy_uses_selected_speaker_route() {
        let controls = VoiceInputControls::default();
        let guard = controls
            .begin_cue_activity(InputDuringTtsPolicy::Auto, Some("Test Speakers"))
            .unwrap();
        assert!(controls.is_input_suppressed());
        assert_eq!(controls.mute_epoch(), 0);
        drop(guard);
        assert!(!controls.is_input_suppressed());
    }

    #[test]
    fn cue_suppression_preserves_recognition_epoch_and_composes_with_host_mute() {
        let controls = VoiceInputControls::default();
        let epoch = controls.mute_epoch();
        let first = controls
            .begin_cue_activity(InputDuringTtsPolicy::SuppressInput, None)
            .unwrap();
        let second = controls
            .begin_cue_activity(InputDuringTtsPolicy::SuppressInput, None)
            .unwrap();
        assert!(controls.is_input_suppressed());
        assert!(!controls.is_muted());
        assert_eq!(controls.mute_epoch(), epoch);
        drop(first);
        assert!(controls.is_input_suppressed());
        drop(second);
        assert!(!controls.is_input_suppressed());
        assert_eq!(controls.mute_epoch(), epoch);
        let allow = controls
            .begin_cue_activity(InputDuringTtsPolicy::AllowBargeIn, None)
            .unwrap();
        assert!(!controls.is_input_suppressed());
        controls.set_host_muted(true);
        drop(allow);
        assert!(controls.is_input_suppressed());
    }

    #[test]
    fn clearing_speech_reports_a_reset_instead_of_a_vad_edge() {
        let (events, mut receiver) = tokio_mpsc::channel(2);
        clear_speech_state(
            &mut Vec::new(),
            &mut Vec::new(),
            &mut Vec::new(),
            &mut 0,
            &mut true,
            &events,
        );
        assert!(matches!(
            receiver.try_recv(),
            Ok(VoiceInputEvent::SpeakingReset)
        ));
    }

    #[test]
    fn default_output_is_classified_by_its_name() {
        for name in ["USB Speakers", "Bluetooth SPEAKER", "Altavoces externos"] {
            assert!(
                route_uses_speakers(None, || Some(name.into()), || false),
                "{name}"
            );
        }
        for name in ["AirPods Pro", "USB Headphones"] {
            assert!(!route_uses_speakers(None, || Some(name.into()), || false));
        }
        assert!(!route_uses_speakers(None, || None, || false));
        assert!(route_uses_speakers(
            None,
            || Some("MacBook".into()),
            || true
        ));
        let named = |default: fn() -> Option<String>| {
            route_uses_speakers(Some("AirPods"), default, || false)
        };
        assert!(!named(|| Some("USB Speakers".into())));
    }

    fn silence_frame() -> VoiceInputFrame {
        VoiceInputFrame::try_from_samples(&[0.0; INPUT_FRAME_SAMPLES]).unwrap()
    }

    #[derive(Default)]
    struct RecordedTrace(Mutex<Vec<String>>);

    impl DetectionTrace for RecordedTrace {
        fn received_frames(&self) -> u64 {
            0
        }
        fn settings(&self, revision: u64, settings: crate::detection::DetectionSettings) {
            let listening = settings.listening.value;
            self.0
                .lock()
                .unwrap()
                .push(format!("settings {revision} {listening}"));
        }
        fn frame(&self, frame: TracedFrame) {
            let TracedFrame {
                vad_frame,
                generation,
                settings_revision,
                threshold,
                ..
            } = frame;
            self.0.lock().unwrap().push(format!(
                "frame {vad_frame} {generation} {settings_revision} {threshold}"
            ));
        }
        fn recognizer(&self, generation: u64, reason: &'static str) {
            self.0
                .lock()
                .unwrap()
                .push(format!("recognizer {generation} {reason}"));
        }
    }

    #[test]
    fn traces_settings_before_the_frames_that_use_them_and_numbers_generations() {
        use crate::detection::DetectionSettings;
        use crate::vad_replay::Mode;
        let trace = Arc::new(RecordedTrace::default());
        let mut tracer = FrameTracer::new(Some(trace.clone()));
        let initial = DetectionSettings::default();
        let mut raised = initial;
        raised.listening.value = 0.6;
        tracer.began("start");
        tracer.frame(768, 0, initial, Mode::Listening, 0.7, true, true);
        tracer.frame(1_536, 0, initial, Mode::Interruption, 0.7, true, true);
        tracer.began("epoch_change");
        tracer.frame(2_304, 0, raised, Mode::Listening, 0.1, false, false);
        tracer.ended("finish");

        assert_eq!(
            *trace.0.lock().unwrap(),
            [
                "recognizer 1 start",
                "settings 0 0.5",
                "frame 0 1 0 0.5",
                "frame 1 1 0 0.65",
                "recognizer 2 epoch_change",
                "settings 1 0.6",
                "frame 2 2 1 0.6",
                "recognizer 2 finish",
            ]
        );
    }

    #[test]
    fn locates_detector_frames_in_microphone_audio_through_resampling() {
        use rubato::{Fft, FixedSync, Resampler};
        let mut resampler =
            Fft::<f32>::new(INPUT_SAMPLE_RATE, 16_000, 1024, 2, 1, FixedSync::Input).unwrap();
        let impulse = 20_000;
        let mut input = vec![0.0; INPUT_SAMPLE_RATE];
        input[impulse] = 1.0;
        let mut output: Vec<f32> = Vec::new();
        let mut produced = Vec::new();
        for chunk in input.chunks_exact(1024) {
            output.extend(resample(&mut resampler, chunk));
            produced.push(output.len());
        }
        let peak = (0..output.len())
            .max_by(|&a, &b| output[a].abs().total_cmp(&output[b].abs()))
            .unwrap();
        let chunk = produced.iter().position(|&len| len > peak).unwrap();
        // Offset the microphone timeline, as when earlier frames were skipped.
        let skipped = 96_000;
        let consumed = ((chunk + 1) * 1024) as u64;
        let end = detector_frame_end(
            skipped + consumed,
            consumed,
            peak as u64 + 1,
            resampler.output_delay(),
        );

        assert!(
            (skipped + impulse as u64 + 1).abs_diff(end) <= 3,
            "impulse at {impulse}, located just before {end}"
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "changes the default output; requires SwitchAudioSource and BlackHole 2ch"]
    fn native_auto_mute_follows_default_output_during_speech() {
        fn output(args: &[&str]) -> String {
            let result = std::process::Command::new("SwitchAudioSource")
                .args(args)
                .output()
                .unwrap();
            assert!(
                result.status.success(),
                "{}",
                String::from_utf8_lossy(&result.stderr)
            );
            String::from_utf8(result.stdout).unwrap().trim().to_owned()
        }
        struct RestoreOutput(String);
        impl Drop for RestoreOutput {
            fn drop(&mut self) {
                let _ = std::process::Command::new("SwitchAudioSource")
                    .args(["-s", &self.0, "-t", "output"])
                    .output();
            }
        }
        let _restore = RestoreOutput(output(&["-c", "-t", "output"]));
        let devices = output(&["-a", "-t", "output"]);
        assert!(devices.contains("MacBook Pro Speakers") && devices.contains("BlackHole 2ch"));
        let controls = VoiceInputControls::default();
        let _activity = controls
            .begin_assistant_activity(0.65, InputDuringTtsPolicy::Auto)
            .unwrap();
        for (device, muted) in [
            ("MacBook Pro Speakers", true),
            ("BlackHole 2ch", false),
            ("MacBook Pro Speakers", true),
        ] {
            output(&["-s", device, "-t", "output"]);
            let deadline = Instant::now() + Duration::from_secs(2);
            while controls.is_muted() != muted && Instant::now() < deadline {
                thread::sleep(Duration::from_millis(10));
            }
            assert_eq!(controls.is_muted(), muted, "Auto did not follow {device}");
        }
    }

    #[test]
    fn auto_policy_follows_routes_without_overriding_explicit_choices() {
        for (speakers, expected) in [
            (true, InputDuringTtsPolicy::SuppressInput),
            (false, InputDuringTtsPolicy::AllowBargeIn),
        ] {
            assert_eq!(
                InputDuringTtsPolicy::Auto.resolve_for_speakers(speakers),
                expected
            );
            for explicit in [
                InputDuringTtsPolicy::SuppressInput,
                InputDuringTtsPolicy::AllowBargeIn,
            ] {
                assert_eq!(explicit.resolve_for_speakers(speakers), explicit);
            }
        }
    }

    #[test]
    fn auto_route_changes_advance_mute_epochs_and_preserve_host_mute() {
        let controls = VoiceInputControls::default();
        let activity = controls
            .begin_assistant_activity(0.65, InputDuringTtsPolicy::Auto)
            .unwrap();
        // Hold the transition lock to inject route changes deterministically,
        // excluding the native route monitor for the duration of the test.
        let mut transition = controls.shared.transition.lock().unwrap();
        transition.auto_suppressed = false;
        controls.publish_effective_mute(&transition);
        let epoch = controls.mute_epoch();
        assert!(!controls.is_muted());
        transition.auto_suppressed = true;
        controls.publish_effective_mute(&transition);
        assert!(controls.is_muted());
        assert_eq!(controls.mute_epoch(), epoch + 1);
        transition.auto_suppressed = false;
        controls.publish_effective_mute(&transition);
        assert!(!controls.is_muted());
        assert_eq!(controls.mute_epoch(), epoch + 2);
        transition.host_muted = true;
        controls.publish_effective_mute(&transition);
        transition.auto_suppressed = true;
        controls.publish_effective_mute(&transition);
        transition.auto_suppressed = false;
        controls.publish_effective_mute(&transition);
        assert!(controls.is_muted());
        assert_eq!(controls.mute_epoch(), epoch + 3);
        drop(transition);
        drop(activity);
        assert!(controls.is_muted());
    }

    #[test]
    fn exact_frame_contract_rejects_shape_and_nonfinite_and_clamps_unit_scale() {
        assert!(VoiceInputFrame::try_from_samples(&[0.0; 959]).is_err());
        let mut samples = [0.0; INPUT_FRAME_SAMPLES];
        samples[0] = f32::NAN;
        assert!(VoiceInputFrame::try_from_samples(&samples).is_err());
        samples[0] = 2.0;
        samples[1] = -2.0;
        let frame = VoiceInputFrame::try_from_samples(&samples).unwrap();
        assert_eq!(frame.samples()[0], 1.0);
        assert_eq!(frame.samples()[1], -1.0);
    }

    #[test]
    fn mute_and_reset_advance_the_authoritative_epoch() {
        let controls = VoiceInputControls::default();
        assert_eq!(controls.mute_epoch(), 0);
        controls.set_host_muted(true);
        assert_eq!(controls.mute_epoch(), 1);
        controls.set_host_muted(true);
        assert_eq!(controls.mute_epoch(), 1);
        controls.set_host_muted(false);
        assert_eq!(controls.mute_epoch(), 2);
        controls.reset();
        assert_eq!(controls.mute_epoch(), 3);
    }

    #[test]
    fn host_mute_and_assistant_suppression_cannot_clear_each_other() {
        let controls = VoiceInputControls::default();
        controls.set_host_muted(true);
        let assistant = controls
            .begin_assistant_activity(0.65, InputDuringTtsPolicy::SuppressInput)
            .unwrap();
        controls.set_host_muted(false);
        assert!(controls.is_muted());
        assert_eq!(controls.mute_epoch(), 1);
        drop(assistant);
        assert!(!controls.is_muted());
        assert_eq!(controls.mute_epoch(), 2);

        let assistant = controls
            .begin_assistant_activity(0.65, InputDuringTtsPolicy::SuppressInput)
            .unwrap();
        controls.set_host_muted(true);
        drop(assistant);
        assert!(controls.is_muted());
        assert_eq!(controls.mute_epoch(), 3);
        controls.set_host_muted(false);
        assert!(!controls.is_muted());
        assert_eq!(controls.mute_epoch(), 4);
    }

    #[test]
    fn overlapping_assistant_guards_snapshot_policy_and_drop_out_of_order() {
        let controls = VoiceInputControls::default();
        let suppress = controls
            .begin_assistant_activity(0.8, InputDuringTtsPolicy::SuppressInput)
            .unwrap();
        let allow = controls
            .begin_assistant_activity(0.65, InputDuringTtsPolicy::AllowBargeIn)
            .unwrap();
        assert!(controls.is_muted());
        assert_eq!(controls.vad_threshold(0.5), 0.65);
        drop(suppress);
        assert!(!controls.is_muted());
        assert_eq!(controls.vad_threshold(0.5), 0.65);
        drop(allow);
        assert_eq!(controls.vad_threshold(0.5), 0.5);
    }

    #[test]
    fn input_during_tts_policy_updates_are_revisioned_and_nonmutating_when_stale() {
        let slot = InputDuringTtsSlot::new(InputDuringTtsPolicy::AllowBargeIn);
        let leased = slot.snapshot().unwrap();
        let applied = slot.update(1, InputDuringTtsPolicy::SuppressInput).unwrap();
        let stale = slot
            .update(1, InputDuringTtsPolicy::AllowBargeIn)
            .unwrap_err();

        assert_eq!(leased.revision, 1);
        assert_eq!(leased.policy, InputDuringTtsPolicy::AllowBargeIn);
        assert_eq!(applied.revision, 2);
        assert_eq!(applied.policy, InputDuringTtsPolicy::SuppressInput);
        assert_eq!(stale, applied);
        assert_eq!(slot.snapshot().unwrap(), applied);
    }

    #[test]
    fn assistant_activity_guards_restore_the_newest_overlapping_threshold() {
        let controls = VoiceInputControls::default();
        let first = controls
            .begin_assistant_activity(0.8, InputDuringTtsPolicy::AllowBargeIn)
            .unwrap();
        assert_eq!(controls.vad_threshold(0.5), 0.8);
        let second = controls
            .begin_assistant_activity(0.65, InputDuringTtsPolicy::AllowBargeIn)
            .unwrap();
        assert_eq!(controls.vad_threshold(0.5), 0.65);
        drop(first);
        assert_eq!(controls.vad_threshold(0.5), 0.65);
        drop(second);
        assert_eq!(controls.vad_threshold(0.5), 0.5);
    }

    #[test]
    fn concurrent_assistant_starts_publish_the_highest_generation_threshold() {
        let controls = VoiceInputControls::default();
        let barrier = Arc::new(std::sync::Barrier::new(8));
        let (result_tx, result_rx) = mpsc::channel();
        let threads = (1..=8)
            .map(|index| {
                let controls = controls.clone();
                let barrier = Arc::clone(&barrier);
                let result_tx = result_tx.clone();
                thread::spawn(move || {
                    let threshold = index as f32 / 10.0;
                    barrier.wait();
                    let guard = controls
                        .begin_assistant_activity(threshold, InputDuringTtsPolicy::AllowBargeIn)
                        .unwrap();
                    result_tx
                        .send((guard.generation, threshold, guard))
                        .unwrap();
                })
            })
            .collect::<Vec<_>>();
        drop(result_tx);
        let guards = result_rx.into_iter().collect::<Vec<_>>();
        for thread in threads {
            thread.join().unwrap();
        }
        let expected = guards
            .iter()
            .max_by_key(|(generation, _, _)| *generation)
            .map(|(_, threshold, _)| *threshold)
            .unwrap();

        assert_eq!(controls.vad_threshold(0.5), expected);
        drop(guards);
        assert_eq!(controls.vad_threshold(0.5), 0.5);
    }

    #[test]
    fn cloned_controls_carry_assistant_activity_across_runtime_replacement() {
        let controls = VoiceInputControls::default();
        let replacement_controls = controls.clone();
        let guard = controls
            .begin_assistant_activity(0.8, InputDuringTtsPolicy::AllowBargeIn)
            .unwrap();

        assert_eq!(replacement_controls.vad_threshold(0.5), 0.8);
        drop(guard);
        assert_eq!(replacement_controls.vad_threshold(0.5), 0.5);
    }

    #[test]
    fn recognition_pending_is_counted_and_clears_only_after_the_last_resolution() {
        let (events, mut receiver) = tokio_mpsc::channel(8);
        let mut pending = PendingRecognitions::new();
        pending.begin(&events).unwrap();
        pending.begin(&events).unwrap();
        assert!(matches!(
            receiver.try_recv(),
            Ok(VoiceInputEvent::RecognitionPendingChanged(true))
        ));
        pending.resolve(&events).unwrap();
        assert!(receiver.try_recv().is_err());
        pending.resolve(&events).unwrap();
        assert!(matches!(
            receiver.try_recv(),
            Ok(VoiceInputEvent::RecognitionPendingChanged(false))
        ));
        pending.resolve(&events).unwrap();
        assert!(receiver.try_recv().is_err());
    }

    #[test]
    fn parakeet_pending_precedes_idle_and_ordered_final_resolution_follows() {
        let (events, mut receiver) = tokio_mpsc::channel(8);
        let mut pending = PendingRecognitions::new();
        pending.begin(&events).unwrap();
        events
            .blocking_send(VoiceInputEvent::SpeakingChanged(false))
            .unwrap();
        complete_parakeet_recognition("final words".to_string(), &events, &mut pending, None);

        assert!(matches!(
            receiver.try_recv(),
            Ok(VoiceInputEvent::RecognitionPendingChanged(true))
        ));
        assert!(matches!(
            receiver.try_recv(),
            Ok(VoiceInputEvent::SpeakingChanged(false))
        ));
        assert!(matches!(
            receiver.try_recv(),
            Ok(VoiceInputEvent::FinalTranscript { text, .. }) if text == "final words"
        ));
        assert!(matches!(
            receiver.try_recv(),
            Ok(VoiceInputEvent::RecognitionPendingChanged(false))
        ));
    }

    #[test]
    fn parakeet_decoder_orders_one_waiter_and_rejects_a_third_utterance() {
        let controls = VoiceInputControls::default();
        let shutdown = Arc::new(AtomicBool::new(false));
        let discard = Arc::new(AtomicBool::new(false));
        let shutdown_epoch = Arc::new(AtomicU64::new(0));
        let (decode_started_tx, decode_started_rx) = mpsc::sync_channel(0);
        let (release_decode_tx, release_decode_rx) = mpsc::sync_channel(0);
        let mut decode_count = 0;
        let mut decoder = ParakeetDecoder::start(
            controls,
            Arc::clone(&shutdown),
            discard,
            shutdown_epoch,
            move |speech| {
                decode_count += 1;
                if decode_count == 1 {
                    decode_started_tx.send(()).unwrap();
                    release_decode_rx.recv().unwrap();
                }
                format!("recognized {}", speech[0])
            },
        )
        .unwrap();
        assert!(decoder
            .try_submit(ParakeetUtterance {
                sequence: 1,
                speech: vec![0.25; VAD_FRAME_SAMPLES],
                mute_epoch: 0,
            })
            .unwrap()
            .is_none());
        decode_started_rx
            .recv_timeout(Duration::from_millis(100))
            .expect("recognizer starts");
        assert!(decoder
            .try_submit(ParakeetUtterance {
                sequence: 2,
                speech: vec![0.5; VAD_FRAME_SAMPLES],
                mute_epoch: 0,
            })
            .expect("one waiting utterance is bounded and accepted")
            .is_none());
        let third = decoder.try_submit(ParakeetUtterance {
            sequence: 3,
            speech: vec![0.75; VAD_FRAME_SAMPLES],
            mute_epoch: 0,
        });
        assert_eq!(
            third.err().expect("third same-epoch utterance is full"),
            "Parakeet recognition overrun: completed utterances arrived faster than they could be decoded."
        );

        release_decode_tx.send(()).unwrap();
        let first = decoder
            .results
            .recv_timeout(Duration::from_millis(100))
            .expect("first recognition result");
        let second = decoder
            .results
            .recv_timeout(Duration::from_millis(100))
            .expect("ordered waiting recognition result");
        assert_eq!(
            (first.sequence, first.text.as_str()),
            (1, "recognized 0.25")
        );
        assert_eq!(
            (second.sequence, second.text.as_str()),
            (2, "recognized 0.5")
        );
        decoder.finish().unwrap();
    }

    #[tokio::test]
    async fn blocked_parakeet_decode_does_not_overrun_the_production_frame_coordinator() {
        use rubato::{Fft, FixedSync};

        let controls = VoiceInputControls::default();
        let shutdown = Arc::new(AtomicBool::new(false));
        let discard = Arc::new(AtomicBool::new(false));
        let shutdown_epoch = Arc::new(AtomicU64::new(0));
        let (frame_tx, frame_rx) = mpsc::sync_channel(INPUT_QUEUE_FRAMES);
        let (event_tx, mut event_rx) = tokio_mpsc::channel(EVENT_QUEUE_DEPTH);
        let (decode_started_tx, decode_started_rx) = mpsc::sync_channel(0);
        let (release_decode_tx, release_decode_rx) = mpsc::sync_channel(0);
        let resampler = Fft::<f32>::new(INPUT_SAMPLE_RATE, 16_000, 1024, 2, 1, FixedSync::Input)
            .expect("resampler");
        let worker_controls = controls.clone();
        let worker_shutdown = Arc::clone(&shutdown);
        let worker_discard = Arc::clone(&discard);
        let worker_shutdown_epoch = Arc::clone(&shutdown_epoch);
        let worker = thread::spawn(move || {
            parakeet_coordinator(
                resampler,
                frame_rx,
                event_tx,
                worker_shutdown,
                worker_discard,
                worker_shutdown_epoch,
                worker_controls,
                0.5,
                move |_| {
                    decode_started_tx.send(()).unwrap();
                    release_decode_rx.recv().unwrap();
                    "fixture final".to_string()
                },
            )
        });
        let runtime = VoiceInputRuntime {
            frame_tx,
            controls,
            shutdown,
            discard_on_shutdown: discard,
            shutdown_mute_epoch: shutdown_epoch,
            worker: Some(worker),
        };

        let mut decode_started = false;
        for samples in crate::benchmark::first_bundled_fixture_frames_for_test() {
            runtime
                .try_push_frame(VoiceInputFrame::try_from_samples(&samples).unwrap())
                .expect("fixture frame reaches the production coordinator");
            if decode_started_rx.try_recv().is_ok() {
                decode_started = true;
                break;
            }
            thread::sleep(Duration::from_millis(2));
        }
        assert!(decode_started, "checked fixture reaches a VAD boundary");

        for _ in 0..INPUT_QUEUE_FRAMES + 5 {
            runtime
                .try_push_frame(silence_frame())
                .expect("20 ms capture remains drainable during blocked inference");
            thread::sleep(INPUT_FRAME_DURATION);
        }
        release_decode_tx.send(()).unwrap();

        let mut observed = Vec::new();
        while !observed.contains(&"pending:false") {
            let event = tokio::time::timeout(Duration::from_secs(1), event_rx.recv())
                .await
                .expect("coordinator event timeout")
                .expect("coordinator event channel");
            match event {
                VoiceInputEvent::Ready => observed.push("ready"),
                VoiceInputEvent::SpeakingChanged(true) => observed.push("speaking:true"),
                VoiceInputEvent::SpeakingChanged(false) | VoiceInputEvent::SpeakingReset => {
                    observed.push("speaking:false")
                }
                VoiceInputEvent::RecognitionPendingChanged(true) => observed.push("pending:true"),
                VoiceInputEvent::RecognitionPendingChanged(false) => observed.push("pending:false"),
                VoiceInputEvent::FinalTranscript {
                    text,
                    storage_receipt,
                } => {
                    assert_eq!(text, "fixture final");
                    storage_receipt.stored();
                    observed.push("final");
                }
                VoiceInputEvent::InterimTranscript(_) => {}
                VoiceInputEvent::Failed(error) => panic!("unexpected input failure: {error}"),
            }
        }
        assert_eq!(
            observed,
            [
                "ready",
                "speaking:true",
                "pending:true",
                "speaking:false",
                "final",
                "pending:false",
            ]
        );
        runtime.finish().await.unwrap();
    }

    #[test]
    fn parakeet_inference_panic_emits_one_terminal_failure() {
        let controls = VoiceInputControls::default();
        let shutdown = Arc::new(AtomicBool::new(false));
        let discard = Arc::new(AtomicBool::new(false));
        let shutdown_epoch = Arc::new(AtomicU64::new(0));
        let mut decoder = ParakeetDecoder::start(
            controls.clone(),
            Arc::clone(&shutdown),
            Arc::clone(&discard),
            Arc::clone(&shutdown_epoch),
            move |_| panic!("synthetic inference panic"),
        )
        .unwrap();
        let (events, mut event_rx) = tokio_mpsc::channel(8);
        let mut pending = PendingRecognitions::new();
        let mut ledger = ParakeetRecognitionLedger::new();
        submit_parakeet_utterance(
            &decoder,
            vec![0.25; VAD_FRAME_SAMPLES],
            0,
            &mut ledger,
            &mut pending,
            &events,
        )
        .unwrap();
        let deadline = Instant::now() + Duration::from_millis(100);
        let failure = loop {
            match drain_parakeet_results(
                &decoder,
                &events,
                &mut ledger,
                &mut pending,
                None,
                &controls,
                &shutdown,
                &discard,
                &shutdown_epoch,
            ) {
                Ok(()) if Instant::now() < deadline => thread::yield_now(),
                Ok(()) => panic!("inference worker did not disconnect"),
                Err(error) => break error,
            }
        };
        events
            .blocking_send(VoiceInputEvent::Failed(failure))
            .unwrap();
        let decoder_result = decoder.finish();
        pending.reset(&events).unwrap();
        assert!(decoder_result.is_err());

        assert!(matches!(
            event_rx.try_recv(),
            Ok(VoiceInputEvent::RecognitionPendingChanged(true))
        ));
        assert!(matches!(
            event_rx.try_recv(),
            Ok(VoiceInputEvent::Failed(message))
                if message == "Parakeet recognition stopped unexpectedly."
        ));
        assert!(matches!(
            event_rx.try_recv(),
            Ok(VoiceInputEvent::RecognitionPendingChanged(false))
        ));
        assert!(event_rx.try_recv().is_err());
    }

    #[test]
    fn reset_replaces_a_stale_waiter_without_resolving_fresh_pending() {
        let controls = VoiceInputControls::default();
        let shutdown = Arc::new(AtomicBool::new(false));
        let discard = Arc::new(AtomicBool::new(false));
        let shutdown_epoch = Arc::new(AtomicU64::new(0));
        let (first_started_tx, first_started_rx) = mpsc::sync_channel(0);
        let (release_first_tx, release_first_rx) = mpsc::sync_channel(0);
        let (second_started_tx, second_started_rx) = mpsc::sync_channel(0);
        let (release_second_tx, release_second_rx) = mpsc::sync_channel(0);
        let mut decode_count = 0;
        let mut decoder = ParakeetDecoder::start(
            controls.clone(),
            Arc::clone(&shutdown),
            Arc::clone(&discard),
            Arc::clone(&shutdown_epoch),
            move |_| {
                decode_count += 1;
                if decode_count == 1 {
                    first_started_tx.send(()).unwrap();
                    release_first_rx.recv().unwrap();
                    "stale".to_string()
                } else {
                    second_started_tx.send(()).unwrap();
                    release_second_rx.recv().unwrap();
                    "fresh".to_string()
                }
            },
        )
        .unwrap();
        let (events, mut event_rx) = tokio_mpsc::channel(8);
        let mut pending = PendingRecognitions::new();
        let mut ledger = ParakeetRecognitionLedger::new();

        submit_parakeet_utterance(
            &decoder,
            vec![0.25; VAD_FRAME_SAMPLES],
            0,
            &mut ledger,
            &mut pending,
            &events,
        )
        .unwrap();
        first_started_rx.recv().unwrap();
        assert!(matches!(
            event_rx.try_recv(),
            Ok(VoiceInputEvent::RecognitionPendingChanged(true))
        ));
        submit_parakeet_utterance(
            &decoder,
            vec![0.375; VAD_FRAME_SAMPLES],
            0,
            &mut ledger,
            &mut pending,
            &events,
        )
        .expect("one old-epoch utterance may wait behind the active decode");
        assert_eq!(pending.count, 2);
        assert!(event_rx.try_recv().is_err());

        controls.reset();
        pending.reset(&events).unwrap();
        submit_parakeet_utterance(
            &decoder,
            vec![0.5; VAD_FRAME_SAMPLES],
            controls.mute_epoch(),
            &mut ledger,
            &mut pending,
            &events,
        )
        .expect("fresh utterance replaces the stale waiting utterance");
        assert!(matches!(
            event_rx.try_recv(),
            Ok(VoiceInputEvent::RecognitionPendingChanged(false))
        ));
        assert!(matches!(
            event_rx.try_recv(),
            Ok(VoiceInputEvent::RecognitionPendingChanged(true))
        ));

        release_first_tx.send(()).unwrap();
        second_started_rx.recv().unwrap();
        drain_parakeet_results(
            &decoder,
            &events,
            &mut ledger,
            &mut pending,
            None,
            &controls,
            &shutdown,
            &discard,
            &shutdown_epoch,
        )
        .unwrap();
        assert_eq!(pending.count, 1);
        assert!(event_rx.try_recv().is_err());

        release_second_tx.send(()).unwrap();
        let deadline = Instant::now() + Duration::from_millis(100);
        while ledger.pending.len() == 1 && Instant::now() < deadline {
            drain_parakeet_results(
                &decoder,
                &events,
                &mut ledger,
                &mut pending,
                None,
                &controls,
                &shutdown,
                &discard,
                &shutdown_epoch,
            )
            .unwrap();
            thread::yield_now();
        }
        assert!(matches!(
            event_rx.try_recv(),
            Ok(VoiceInputEvent::FinalTranscript { text, .. }) if text == "fresh"
        ));
        assert!(matches!(
            event_rx.try_recv(),
            Ok(VoiceInputEvent::RecognitionPendingChanged(false))
        ));
        assert!(event_rx.try_recv().is_err());
        decoder.finish().unwrap();
    }

    #[test]
    fn cancel_rejects_a_late_parakeet_result() {
        let controls = VoiceInputControls::default();
        let shutdown = Arc::new(AtomicBool::new(false));
        let discard = Arc::new(AtomicBool::new(false));
        let shutdown_epoch = Arc::new(AtomicU64::new(0));
        let (started_tx, started_rx) = mpsc::sync_channel(0);
        let (release_tx, release_rx) = mpsc::sync_channel(0);
        let mut decoder = ParakeetDecoder::start(
            controls.clone(),
            Arc::clone(&shutdown),
            Arc::clone(&discard),
            Arc::clone(&shutdown_epoch),
            move |_| {
                started_tx.send(()).unwrap();
                release_rx.recv().unwrap();
                "too late".to_string()
            },
        )
        .unwrap();
        let (events, mut event_rx) = tokio_mpsc::channel(8);
        let mut pending = PendingRecognitions::new();
        let mut ledger = ParakeetRecognitionLedger::new();
        submit_parakeet_utterance(
            &decoder,
            vec![0.25; VAD_FRAME_SAMPLES],
            0,
            &mut ledger,
            &mut pending,
            &events,
        )
        .unwrap();
        started_rx.recv().unwrap();
        assert!(matches!(
            event_rx.try_recv(),
            Ok(VoiceInputEvent::RecognitionPendingChanged(true))
        ));

        discard.store(true, Ordering::Release);
        shutdown.store(true, Ordering::Release);
        pending.reset(&events).unwrap();
        release_tx.send(()).unwrap();
        let deadline = Instant::now() + Duration::from_millis(100);
        while ledger.pending.len() == 1 && Instant::now() < deadline {
            drain_parakeet_results(
                &decoder,
                &events,
                &mut ledger,
                &mut pending,
                None,
                &controls,
                &shutdown,
                &discard,
                &shutdown_epoch,
            )
            .unwrap();
            thread::yield_now();
        }
        assert!(matches!(
            event_rx.try_recv(),
            Ok(VoiceInputEvent::RecognitionPendingChanged(false))
        ));
        assert!(event_rx.try_recv().is_err());
        decoder.finish().unwrap();
    }

    #[tokio::test]
    async fn blocked_parakeet_inference_preserves_outer_quarantine() {
        let controls = VoiceInputControls::default();
        let shutdown = Arc::new(AtomicBool::new(false));
        let (started_tx, started_rx) = mpsc::sync_channel(0);
        let (release_tx, release_rx) = mpsc::sync_channel(0);
        let mut decoder = ParakeetDecoder::start(
            controls,
            shutdown,
            Arc::new(AtomicBool::new(false)),
            Arc::new(AtomicU64::new(0)),
            move |_| {
                started_tx.send(()).unwrap();
                release_rx.recv().unwrap();
                String::new()
            },
        )
        .unwrap();
        assert!(decoder
            .try_submit(ParakeetUtterance {
                sequence: 1,
                speech: vec![0.25; VAD_FRAME_SAMPLES],
                mute_epoch: 0,
            })
            .unwrap()
            .is_none());
        started_rx.recv().unwrap();
        let (finished_tx, finished_rx) = mpsc::sync_channel(0);
        let outer = thread::spawn(move || {
            decoder.finish().unwrap();
            finished_tx.send(()).unwrap();
        });

        assert_eq!(
            finish_worker(outer, Duration::from_millis(20))
                .await
                .unwrap_err(),
            VoiceInputFinishError::Quarantined {
                timeout: Duration::from_millis(20)
            }
        );
        release_tx.send(()).unwrap();
        finished_rx
            .recv_timeout(Duration::from_millis(100))
            .expect("quarantined nested worker can still finish after release");
    }

    #[test]
    fn shutdown_freezes_the_accepted_mute_epoch() {
        let controls = VoiceInputControls::default();
        let shutdown = AtomicBool::new(false);
        let shutdown_epoch = AtomicU64::new(controls.mute_epoch());
        shutdown.store(true, Ordering::Release);
        controls.set_host_muted(true);

        assert_eq!(
            effective_mute_epoch(&controls, &shutdown, &shutdown_epoch),
            (true, 0)
        );
    }

    #[test]
    fn final_storage_receipt_unblocks_the_bounded_sender() {
        let (events, mut receiver) = tokio_mpsc::channel(1);
        let (done_tx, done_rx) = mpsc::sync_channel(0);
        let sender = thread::spawn(move || {
            send_final(
                &events,
                "stored words".to_string(),
                Some(Instant::now() + Duration::from_secs(1)),
            )
            .unwrap();
            done_tx.send(()).unwrap();
        });
        let VoiceInputEvent::FinalTranscript {
            text,
            storage_receipt,
        } = receiver.blocking_recv().expect("final event")
        else {
            panic!("expected final transcript")
        };
        assert_eq!(text, "stored words");
        assert!(done_rx.try_recv().is_err());
        storage_receipt.stored();
        done_rx
            .recv_timeout(Duration::from_millis(100))
            .expect("storage acknowledgement unblocks worker");
        sender.join().unwrap();
    }

    #[test]
    fn dropping_an_unstored_receipt_unblocks_without_claiming_storage() {
        let (events, mut receiver) = tokio_mpsc::channel(1);
        let (done_tx, done_rx) = mpsc::sync_channel(0);
        let sender = thread::spawn(move || {
            send_final(
                &events,
                "unstored words".to_string(),
                Some(Instant::now() + Duration::from_secs(1)),
            )
            .unwrap();
            done_tx.send(()).unwrap();
        });
        let VoiceInputEvent::FinalTranscript {
            storage_receipt, ..
        } = receiver.blocking_recv().expect("final event")
        else {
            panic!("expected final transcript")
        };

        drop(storage_receipt);

        done_rx
            .recv_timeout(Duration::from_millis(100))
            .expect("dropping an unstored receipt unblocks worker shutdown");
        sender.join().unwrap();
    }

    #[test]
    fn multiple_finals_share_one_absolute_storage_deadline() {
        let (events, mut receiver) = tokio_mpsc::channel(2);
        let (done_tx, done_rx) = mpsc::sync_channel(0);
        let deadline = Instant::now() + Duration::from_millis(100);
        let sender = thread::spawn(move || {
            send_final(&events, "first".to_string(), Some(deadline)).unwrap();
            send_final(&events, "second".to_string(), Some(deadline)).unwrap();
            done_tx.send(()).unwrap();
        });
        let VoiceInputEvent::FinalTranscript {
            storage_receipt: first_receipt,
            ..
        } = receiver.blocking_recv().expect("first final")
        else {
            panic!("expected first final transcript")
        };

        thread::sleep(Duration::from_millis(120));
        let VoiceInputEvent::FinalTranscript {
            storage_receipt: second_receipt,
            ..
        } = receiver.blocking_recv().expect("second final")
        else {
            panic!("expected second final transcript")
        };
        done_rx
            .recv_timeout(Duration::from_millis(50))
            .expect("second final does not start a new storage deadline");

        drop((first_receipt, second_receipt));
        sender.join().unwrap();
    }

    #[test]
    fn queued_frame_keeps_its_old_epoch_across_mute_and_unmute() {
        let (frame_tx, frame_rx) = mpsc::sync_channel(INPUT_QUEUE_FRAMES);
        let controls = VoiceInputControls::default();
        let runtime = VoiceInputRuntime {
            frame_tx,
            controls: controls.clone(),
            shutdown: Arc::new(AtomicBool::new(false)),
            discard_on_shutdown: Arc::new(AtomicBool::new(false)),
            shutdown_mute_epoch: Arc::new(AtomicU64::new(0)),
            worker: None,
        };
        runtime.try_push_frame(silence_frame()).unwrap();

        controls.set_host_muted(true);
        controls.set_host_muted(false);

        let queued = frame_rx.try_recv().expect("queued pre-mute frame");
        assert_eq!(queued.mute_epoch, 0);
        assert_ne!(queued.mute_epoch, controls.mute_epoch());
    }

    #[test]
    fn cue_pause_drops_only_new_pcm_and_keeps_recognition_epoch() {
        let (frame_tx, frame_rx) = mpsc::sync_channel(INPUT_QUEUE_FRAMES);
        let controls = VoiceInputControls::default();
        let runtime = VoiceInputRuntime {
            frame_tx,
            controls: controls.clone(),
            shutdown: Arc::new(AtomicBool::new(false)),
            discard_on_shutdown: Arc::new(AtomicBool::new(false)),
            shutdown_mute_epoch: Arc::new(AtomicU64::new(0)),
            worker: None,
        };
        runtime.try_push_frame(silence_frame()).unwrap();
        let before = frame_rx.try_recv().unwrap();
        let cue = controls
            .begin_cue_activity(InputDuringTtsPolicy::SuppressInput, None)
            .unwrap();
        runtime.try_push_frame(silence_frame()).unwrap();
        assert!(frame_rx.try_recv().is_err());
        assert_eq!(before.mute_epoch, controls.mute_epoch());
        drop(cue);
        runtime.try_push_frame(silence_frame()).unwrap();
        let after = frame_rx.try_recv().unwrap();
        assert_eq!(before.mute_epoch, after.mute_epoch);
        runtime.signal_shutdown(false);
        assert!(!runtime.discard_on_shutdown.load(Ordering::Acquire));
    }

    #[test]
    fn input_during_tts_policy_controls_frame_admission() {
        let (frame_tx, frame_rx) = mpsc::sync_channel(INPUT_QUEUE_FRAMES);
        let controls = VoiceInputControls::default();
        let runtime = VoiceInputRuntime {
            frame_tx,
            controls: controls.clone(),
            shutdown: Arc::new(AtomicBool::new(false)),
            discard_on_shutdown: Arc::new(AtomicBool::new(false)),
            shutdown_mute_epoch: Arc::new(AtomicU64::new(0)),
            worker: None,
        };

        let suppress = controls
            .begin_assistant_activity(0.65, InputDuringTtsPolicy::SuppressInput)
            .unwrap();
        runtime.try_push_frame(silence_frame()).unwrap();
        assert!(frame_rx.try_recv().is_err());
        drop(suppress);

        let allow = controls
            .begin_assistant_activity(0.65, InputDuringTtsPolicy::AllowBargeIn)
            .unwrap();
        runtime.try_push_frame(silence_frame()).unwrap();
        assert!(frame_rx.try_recv().is_ok());
        drop(allow);
    }

    #[test]
    fn bounded_frame_queue_reports_overrun_without_blocking() {
        let (frame_tx, _frame_rx) = mpsc::sync_channel(INPUT_QUEUE_FRAMES);
        let controls = VoiceInputControls::default();
        let runtime = VoiceInputRuntime {
            frame_tx,
            controls,
            shutdown: Arc::new(AtomicBool::new(false)),
            discard_on_shutdown: Arc::new(AtomicBool::new(false)),
            shutdown_mute_epoch: Arc::new(AtomicU64::new(0)),
            worker: None,
        };
        for _ in 0..INPUT_QUEUE_FRAMES {
            runtime.try_push_frame(silence_frame()).unwrap();
        }
        assert!(runtime.try_push_frame(silence_frame()).is_err());
    }

    #[test]
    fn cancelled_runtime_rejects_new_frames() {
        let (frame_tx, _frame_rx) = mpsc::sync_channel(INPUT_QUEUE_FRAMES);
        let runtime = VoiceInputRuntime {
            frame_tx,
            controls: VoiceInputControls::default(),
            shutdown: Arc::new(AtomicBool::new(false)),
            discard_on_shutdown: Arc::new(AtomicBool::new(false)),
            shutdown_mute_epoch: Arc::new(AtomicU64::new(0)),
            worker: None,
        };

        runtime.cancel();

        assert_eq!(
            runtime.try_push_frame(silence_frame()).unwrap_err(),
            "Voice input recognition is no longer running."
        );
    }

    #[test]
    fn mute_before_shutdown_discards_the_frozen_epoch() {
        let (frame_tx, _frame_rx) = mpsc::sync_channel(INPUT_QUEUE_FRAMES);
        let controls = VoiceInputControls::default();
        let runtime = VoiceInputRuntime {
            frame_tx,
            controls: controls.clone(),
            shutdown: Arc::new(AtomicBool::new(false)),
            discard_on_shutdown: Arc::new(AtomicBool::new(false)),
            shutdown_mute_epoch: Arc::new(AtomicU64::new(0)),
            worker: None,
        };

        controls.set_host_muted(true);
        runtime.signal_shutdown(false);

        assert!(runtime.discard_on_shutdown.load(Ordering::Acquire));
        assert_eq!(
            effective_mute_epoch(&controls, &runtime.shutdown, &runtime.shutdown_mute_epoch),
            (true, 1)
        );
    }

    #[test]
    fn shutdown_before_mute_accepts_and_freezes_the_prior_epoch() {
        let (frame_tx, _frame_rx) = mpsc::sync_channel(INPUT_QUEUE_FRAMES);
        let controls = VoiceInputControls::default();
        let runtime = VoiceInputRuntime {
            frame_tx,
            controls: controls.clone(),
            shutdown: Arc::new(AtomicBool::new(false)),
            discard_on_shutdown: Arc::new(AtomicBool::new(false)),
            shutdown_mute_epoch: Arc::new(AtomicU64::new(0)),
            worker: None,
        };

        runtime.signal_shutdown(false);
        controls.set_host_muted(true);

        assert!(!runtime.discard_on_shutdown.load(Ordering::Acquire));
        assert_eq!(
            effective_mute_epoch(&controls, &runtime.shutdown, &runtime.shutdown_mute_epoch),
            (true, 0)
        );
    }

    #[tokio::test]
    async fn concurrent_cancel_and_finish_signals_linearize_without_deadlock() {
        let (frame_tx, _frame_rx) = mpsc::sync_channel(INPUT_QUEUE_FRAMES);
        let runtime = VoiceInputRuntime {
            frame_tx,
            controls: VoiceInputControls::default(),
            shutdown: Arc::new(AtomicBool::new(false)),
            discard_on_shutdown: Arc::new(AtomicBool::new(false)),
            shutdown_mute_epoch: Arc::new(AtomicU64::new(0)),
            worker: None,
        };

        thread::scope(|scope| {
            scope.spawn(|| runtime.cancel());
            scope.spawn(|| runtime.signal_shutdown(false));
        });

        assert!(runtime.shutdown.load(Ordering::Acquire));
        assert_eq!(runtime.shutdown_mute_epoch.load(Ordering::Acquire), 0);
        runtime.finish().await.unwrap();
    }

    #[test]
    fn cancel_before_finish_signal_discards_but_finish_before_cancel_stays_accepted() {
        let make_runtime = || {
            let (frame_tx, _frame_rx) = mpsc::sync_channel(INPUT_QUEUE_FRAMES);
            VoiceInputRuntime {
                frame_tx,
                controls: VoiceInputControls::default(),
                shutdown: Arc::new(AtomicBool::new(false)),
                discard_on_shutdown: Arc::new(AtomicBool::new(false)),
                shutdown_mute_epoch: Arc::new(AtomicU64::new(0)),
                worker: None,
            }
        };

        let cancelled = make_runtime();
        cancelled.cancel();
        cancelled.signal_shutdown(false);
        assert!(cancelled.discard_on_shutdown.load(Ordering::Acquire));

        let finished = make_runtime();
        finished.signal_shutdown(false);
        finished.cancel();
        assert!(!finished.discard_on_shutdown.load(Ordering::Acquire));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn runtime_feedback_changes_only_the_active_threshold_and_applies_without_restart() {
        let controls = VoiceInputControls::default();
        let mut settings = crate::detection::DetectionSettings::default();
        settings.listening.dynamic = true;
        settings.interruption.dynamic = true;
        controls.set_detection(settings).unwrap();
        let epoch = controls.mute_epoch();
        let now = Instant::now();
        for n in 0..1 {
            let time = now + Duration::from_secs(n * 40);
            controls.observe_detection_at(true, epoch, time);
            controls.detection_result_at(false, epoch, time + Duration::from_secs(6));
        }
        assert_eq!(controls.vad_threshold(0.5), 0.5);
        let playback = controls
            .begin_assistant_activity(0.65, InputDuringTtsPolicy::AllowBargeIn)
            .unwrap();
        for n in 0..1 {
            let time = now + Duration::from_secs(120 + n * 40);
            controls.observe_detection_at(false, epoch, time);
            controls.detection_result_at(true, epoch, time + Duration::from_secs(6));
        }
        assert_eq!(controls.vad_threshold(0.5), 0.64);
        assert_eq!(controls.detection().unwrap().settings.listening.value, 0.5);
        drop(playback);
        assert_eq!(controls.vad_threshold(0.5), 0.5);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn stale_input_generation_cannot_train_a_new_profile() {
        let controls = VoiceInputControls::default();
        let old_epoch = controls.mute_epoch();
        let mut settings = crate::detection::DetectionSettings::default();
        settings.listening.dynamic = true;
        controls.set_detection(settings).unwrap();
        for _ in 0..10 {
            controls.observe_detection(true, old_epoch);
            controls.detection_result(false, old_epoch);
        }
        let snapshot = controls.detection().unwrap();
        assert_eq!(snapshot.settings, settings);
        assert_eq!(snapshot.no_result, 0);
        assert_eq!(snapshot.adjustments, 0);
    }

    #[test]
    fn applied_detection_settings_survive_playback_guards_and_reject_invalid_updates() {
        let controls = VoiceInputControls::default();
        let settings = crate::detection::DetectionSettings {
            timing: Default::default(),
            pending_utterance_timeout_ms: 5000,
            interim_words_wait_ms: 10000,
            dynamic: Default::default(),
            listening: crate::detection::Threshold {
                value: 0.81,
                dynamic: true,
            },
            interruption: crate::detection::Threshold {
                value: 0.72,
                dynamic: false,
            },
        };
        controls.set_detection(settings).unwrap();
        assert_eq!(controls.vad_threshold(0.5), 0.81);
        let playback = controls
            .begin_assistant_activity(0.65, InputDuringTtsPolicy::AllowBargeIn)
            .unwrap();
        assert_eq!(controls.vad_threshold(0.5), 0.72);
        drop(playback);
        assert_eq!(controls.vad_threshold(0.5), 0.81);
        let mut invalid = settings;
        invalid.listening.value = f32::NAN;
        assert!(controls.set_detection(invalid).is_err());
        assert_eq!(controls.detection().unwrap().settings, settings);
    }

    #[test]
    fn listening_threshold_applies_before_and_after_independent_playback_threshold() {
        let controls = VoiceInputControls::default();
        let listening = 0.8;
        let probability = 0.7;
        assert!(probability <= controls.vad_threshold(listening));
        let playback = controls
            .begin_assistant_activity(0.65, InputDuringTtsPolicy::AllowBargeIn)
            .unwrap();
        assert!(probability > controls.vad_threshold(listening));
        drop(playback);
        assert!(probability <= controls.vad_threshold(listening));
    }

    #[test]
    fn silence_does_not_cross_the_default_earshot_threshold() {
        let mut vad = earshot::Detector::new(earshot::DefaultPredictor::new());
        assert!(vad.predict_f32(&[0.0; VAD_FRAME_SAMPLES]) <= 0.5);
    }

    #[test]
    fn resampling_produces_the_expected_nonempty_frame_count() {
        use rubato::{Fft, FixedSync, Resampler};

        let mut resampler =
            Fft::<f32>::new(48_000, 16_000, 1024, 2, 1, FixedSync::Input).expect("resampler");
        let input_frames = resampler.input_frames_next();
        let expected_output_frames = resampler.output_frames_next();
        let output = resample(&mut resampler, &vec![0.25; input_frames]);

        assert_eq!(output.len(), expected_output_frames);
        assert!(!output.is_empty());
    }

    #[test]
    fn resampler_overshoot_is_clamped_before_vad() {
        assert_eq!(
            clamp_vad_frame(&[-1.25, -1.0, 0.25, 1.0, 1.25]),
            [-1.0, -1.0, 0.25, 1.0, 1.0]
        );
    }

    #[test]
    fn openai_transcripts_are_delivered_in_commit_order() {
        let deadline = Instant::now() + OPENAI_LIVE_RESULT_TIMEOUT;
        let mut pending_commits = VecDeque::from([
            OpenAiPendingCommit {
                mute_epoch: 7,
                settle_deadline: deadline,
            },
            OpenAiPendingCommit {
                mute_epoch: 7,
                settle_deadline: deadline,
            },
        ]);
        let mut committed = VecDeque::new();
        let mut completed = HashMap::new();
        for item_id in ["first", "second"] {
            record_openai_event(
                OpenAiRealtimeTranscriptionEvent::Committed {
                    item_id: item_id.to_string(),
                },
                7,
                &mut pending_commits,
                &mut committed,
                &mut completed,
            );
        }
        for (item_id, transcript) in [("second", "two"), ("first", "one")] {
            record_openai_event(
                OpenAiRealtimeTranscriptionEvent::Completed {
                    item_id: item_id.to_string(),
                    transcript: transcript.to_string(),
                },
                7,
                &mut pending_commits,
                &mut committed,
                &mut completed,
            );
        }
        let (event_tx, mut event_rx) = tokio_mpsc::channel(4);
        let mut pending = PendingRecognitions {
            count: 2,
            blocking: 2,
            ..Default::default()
        };

        deliver_openai_turns(
            &mut committed,
            &mut completed,
            &event_tx,
            &mut pending,
            None,
            None,
        );

        let texts = [event_rx.try_recv(), event_rx.try_recv()].map(|event| match event {
            Ok(VoiceInputEvent::FinalTranscript { text, .. }) => text,
            _ => panic!("expected finalized transcript"),
        });
        assert_eq!(texts, ["one", "two"]);
        assert!(matches!(
            event_rx.try_recv(),
            Ok(VoiceInputEvent::RecognitionPendingChanged(false))
        ));
    }

    #[test]
    fn openai_commits_from_stale_mute_epochs_are_not_deliverable() {
        let deadline = Instant::now() + OPENAI_LIVE_RESULT_TIMEOUT;
        let mut pending_commits = VecDeque::from([OpenAiPendingCommit {
            mute_epoch: 1,
            settle_deadline: deadline,
        }]);
        let mut committed = VecDeque::new();
        let turn = record_openai_event(
            OpenAiRealtimeTranscriptionEvent::Committed {
                item_id: "stale".to_string(),
            },
            2,
            &mut pending_commits,
            &mut committed,
            &mut HashMap::new(),
        )
        .expect("recorded commit");

        assert_eq!(turn.mute_epoch, 1);
        assert_eq!(turn.settle_deadline, deadline);
        assert!(committed.is_empty());
    }

    #[test]
    fn openai_transcription_failures_only_apply_to_the_current_epoch() {
        let committed = VecDeque::from([OpenAiCommittedTurn {
            item_id: "current".to_string(),
            mute_epoch: 2,
            settle_deadline: Instant::now() + OPENAI_LIVE_RESULT_TIMEOUT,
        }]);

        assert!(openai_transcription_failure_is_current(
            "current", 2, &committed
        ));
        assert!(!openai_transcription_failure_is_current(
            "current", 3, &committed
        ));
        let discarded_is_current =
            openai_transcription_failure_is_current("discarded", 2, &committed);
        assert!(!discarded_is_current);
    }

    #[test]
    fn openai_unmatched_commits_are_not_assigned_to_the_current_epoch() {
        let mut committed = VecDeque::new();

        let turn = record_openai_event(
            OpenAiRealtimeTranscriptionEvent::Committed {
                item_id: "unmatched".to_string(),
            },
            2,
            &mut VecDeque::new(),
            &mut committed,
            &mut HashMap::new(),
        );

        assert!(turn.is_none());
        assert!(committed.is_empty());
    }

    #[test]
    fn openai_commit_transfers_its_original_live_result_deadline() {
        let deadline = Instant::now() + Duration::from_secs(1);
        let mut pending_commits = VecDeque::from([OpenAiPendingCommit {
            mute_epoch: 4,
            settle_deadline: deadline,
        }]);
        let mut committed = VecDeque::new();
        let turn = record_openai_event(
            OpenAiRealtimeTranscriptionEvent::Committed {
                item_id: "turn".to_string(),
            },
            4,
            &mut pending_commits,
            &mut committed,
            &mut HashMap::new(),
        )
        .expect("recorded commit");

        assert!(pending_commits.is_empty());
        assert_eq!(turn.settle_deadline, deadline);
        assert_eq!(committed.front().unwrap().settle_deadline, deadline);
    }

    #[test]
    fn openai_successful_commit_tracking_starts_a_bounded_deadline() {
        let before = Instant::now() + OPENAI_LIVE_RESULT_TIMEOUT;
        let mut pending_commits = VecDeque::new();

        track_openai_commit(&mut pending_commits, 9);

        let after = Instant::now() + OPENAI_LIVE_RESULT_TIMEOUT;
        let tracked = pending_commits.front().expect("tracked commit");
        assert_eq!(tracked.mute_epoch, 9);
        assert!(tracked.settle_deadline >= before);
        assert!(tracked.settle_deadline <= after);
    }

    #[test]
    fn openai_oldest_unresolved_turn_controls_live_result_expiry() {
        let now = Instant::now();
        let pending_commits = VecDeque::from([
            OpenAiPendingCommit {
                mute_epoch: 1,
                settle_deadline: now + Duration::from_secs(1),
            },
            OpenAiPendingCommit {
                mute_epoch: 1,
                settle_deadline: now + Duration::from_secs(2),
            },
        ]);
        let committed = VecDeque::new();

        assert!(!openai_live_result_expired(
            &pending_commits,
            &committed,
            now
        ));
        assert!(openai_live_result_expired(
            &pending_commits,
            &committed,
            now + Duration::from_secs(1)
        ));
    }

    #[test]
    fn openai_empty_completion_resolves_pending_without_a_final() {
        let deadline = Instant::now() + OPENAI_LIVE_RESULT_TIMEOUT;
        let mut pending_commits = VecDeque::from([OpenAiPendingCommit {
            mute_epoch: 2,
            settle_deadline: deadline,
        }]);
        let mut committed = VecDeque::new();
        let mut completed = HashMap::new();
        record_openai_event(
            OpenAiRealtimeTranscriptionEvent::Committed {
                item_id: "empty".to_string(),
            },
            2,
            &mut pending_commits,
            &mut committed,
            &mut completed,
        );
        record_openai_event(
            OpenAiRealtimeTranscriptionEvent::Completed {
                item_id: "empty".to_string(),
                transcript: String::new(),
            },
            2,
            &mut pending_commits,
            &mut committed,
            &mut completed,
        );
        let (event_tx, mut event_rx) = tokio_mpsc::channel(2);
        let mut pending = PendingRecognitions {
            count: 1,
            blocking: 1,
            ..Default::default()
        };

        deliver_openai_turns(
            &mut committed,
            &mut completed,
            &event_tx,
            &mut pending,
            None,
            None,
        );

        assert_eq!(pending.count, 0);
        assert!(matches!(
            event_rx.try_recv(),
            Ok(VoiceInputEvent::RecognitionPendingChanged(false))
        ));
        assert!(event_rx.try_recv().is_err());
    }

    #[test]
    fn openai_timeout_teardown_ignores_late_completion_from_the_old_generation() {
        let deadline = Instant::now();
        let mut pending_commits = VecDeque::new();
        let mut committed = VecDeque::from([OpenAiCommittedTurn {
            item_id: "old".to_string(),
            mute_epoch: 3,
            settle_deadline: deadline,
        }]);
        let mut completed = HashMap::new();
        assert!(openai_live_result_expired(
            &pending_commits,
            &committed,
            deadline
        ));

        pending_commits.clear();
        committed.clear();
        completed.clear();
        record_openai_event(
            OpenAiRealtimeTranscriptionEvent::Completed {
                item_id: "old".to_string(),
                transcript: "late".to_string(),
            },
            4,
            &mut pending_commits,
            &mut committed,
            &mut completed,
        );
        let (event_tx, mut event_rx) = tokio_mpsc::channel(2);
        let mut pending = PendingRecognitions::new();
        deliver_openai_turns(
            &mut committed,
            &mut completed,
            &event_tx,
            &mut pending,
            None,
            None,
        );

        assert!(event_rx.try_recv().is_err());
        assert_eq!(pending.count, 0);
    }

    #[test]
    fn stalled_openai_operation_observes_shutdown() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .expect("runtime");
        let shutdown = Arc::new(AtomicBool::new(false));
        let shutdown_for_thread = Arc::clone(&shutdown);
        let signal = thread::spawn(move || {
            thread::sleep(Duration::from_millis(30));
            shutdown_for_thread.store(true, Ordering::Release);
        });

        let result = block_on_openai_operation(
            &runtime,
            shutdown.as_ref(),
            std::future::pending::<Result<(), std::io::Error>>(),
            "stalled operation",
        )
        .expect("shutdown is not an error");

        signal.join().expect("shutdown signal");
        assert_eq!(result, None);
    }

    #[test]
    fn openai_timeout_constructs_its_timer_inside_the_worker_runtime() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .expect("runtime");

        let result =
            block_on_openai_timeout(&runtime, Duration::from_millis(10), std::future::ready(42));

        assert_eq!(result, Ok(42));
    }

    #[test]
    fn openai_idle_audio_keeps_only_bounded_pre_roll() {
        let mut pre_roll = VecDeque::new();
        for index in 0..(OPENAI_PRE_ROLL_FRAMES * 4) {
            push_pre_roll(&mut pre_roll, vec![index as u8]);
        }

        assert_eq!(pre_roll.len(), OPENAI_PRE_ROLL_FRAMES);
        assert_eq!(
            pre_roll.front(),
            Some(&vec![(OPENAI_PRE_ROLL_FRAMES * 3) as u8])
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn mac_finals_before_the_deadline_preserve_order_and_clear_pending() {
        let (recognition_tx, mut recognition_rx) = tokio_mpsc::unbounded_channel();
        for text in ["first", "second"] {
            recognition_tx
                .send(crate::mac_speech::MacSpeechRecognitionEvent::Final(
                    text.to_string(),
                    None,
                ))
                .unwrap();
        }
        let (event_tx, mut event_rx) = tokio_mpsc::channel(4);
        let mut pending = PendingRecognitions {
            count: 2,
            blocking: 2,
            ..Default::default()
        };
        let mut settle_deadline = Some(
            Instant::now()
                + Duration::from_millis(
                    crate::detection::default_pending_utterance_timeout_ms().into(),
                ),
        );

        forward_mac_events(
            &mut recognition_rx,
            &event_tx,
            &mut pending,
            &mut settle_deadline,
            None,
        )
        .unwrap();

        let texts = [event_rx.try_recv(), event_rx.try_recv()].map(|event| match event {
            Ok(VoiceInputEvent::FinalTranscript { text, .. }) => text,
            _ => panic!("expected finalized transcript"),
        });
        assert_eq!(texts, ["first", "second"]);
        assert_eq!(pending.count, 0);
        assert!(settle_deadline.is_none());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn mac_new_speech_cancels_then_refreshes_the_settle_deadline() {
        let (event_tx, mut event_rx) = tokio_mpsc::channel(8);
        let mut pending = PendingRecognitions::new();
        let mut deadline = None;
        let now = Instant::now();
        begin_mac_turn(&mut pending, &event_tx, &mut deadline).unwrap();
        end_mac_turn(
            &pending,
            &mut deadline,
            now,
            Duration::from_millis(crate::detection::default_pending_utterance_timeout_ms().into()),
        );
        let first_deadline = deadline.expect("first deadline");

        begin_mac_turn(&mut pending, &event_tx, &mut deadline).unwrap();
        assert!(deadline.is_none());
        end_mac_turn(
            &pending,
            &mut deadline,
            now + Duration::from_secs(1),
            Duration::from_millis(crate::detection::default_pending_utterance_timeout_ms().into()),
        );

        assert!(deadline.is_some_and(|deadline| deadline > first_deadline));
        assert_eq!(pending.count, 2);
        assert_eq!(pending.blocking, 2);
        assert!(matches!(
            event_rx.try_recv(),
            Ok(VoiceInputEvent::RecognitionPendingChanged(true))
        ));
        assert!(event_rx.try_recv().is_err());
        let (native_tx, mut native_rx) = tokio_mpsc::unbounded_channel();
        native_tx
            .send(crate::mac_speech::MacSpeechRecognitionEvent::Final(
                "continued speech".into(),
                None,
            ))
            .unwrap();
        forward_mac_events(&mut native_rx, &event_tx, &mut pending, &mut deadline, None).unwrap();
        assert_eq!(pending.blocking, 1);
        assert!(deadline.is_some());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn mac_final_releases_every_turn_its_audio_covers() {
        let (event_tx, mut event_rx) = tokio_mpsc::channel(16);
        let mut pending = PendingRecognitions::new();
        let mut deadline = None;
        let timeout = Duration::from_secs(5);
        // One sentence split by two pauses, then a turn the final does not reach.
        for end in [48_000, 96_000, 200_000] {
            begin_mac_turn(&mut pending, &event_tx, &mut deadline).unwrap();
            pending.end_turn(&event_tx, end).unwrap();
            end_mac_turn(&pending, &mut deadline, Instant::now(), timeout);
        }
        let (native_tx, mut native_rx) = tokio_mpsc::unbounded_channel();
        let final_at =
            |end| crate::mac_speech::MacSpeechRecognitionEvent::Final("words".into(), end);
        native_tx.send(final_at(Some(90_000))).unwrap();
        forward_mac_events(&mut native_rx, &event_tx, &mut pending, &mut deadline, None).unwrap();
        assert_eq!((pending.count, pending.blocking), (1, 1));
        assert!(deadline.is_some());

        native_tx.send(final_at(Some(190_000))).unwrap();
        forward_mac_events(&mut native_rx, &event_tx, &mut pending, &mut deadline, None).unwrap();
        assert_eq!((pending.count, pending.blocking), (0, 0));
        assert!(deadline.is_none());
        let holds: Vec<_> = std::iter::from_fn(|| event_rx.try_recv().ok())
            .filter_map(|event| match event {
                VoiceInputEvent::RecognitionPendingChanged(active) => Some(active),
                _ => None,
            })
            .collect();
        assert_eq!(holds, [true, false]);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn mac_earlier_phrase_final_keeps_the_hold_for_the_rest_of_the_turn() {
        let (event_tx, _event_rx) = tokio_mpsc::channel(16);
        let mut pending = PendingRecognitions::new();
        let mut deadline = None;
        let (native_tx, mut native_rx) = tokio_mpsc::unbounded_channel();
        let final_at =
            |end| crate::mac_speech::MacSpeechRecognitionEvent::Final("words".into(), Some(end));
        begin_mac_turn(&mut pending, &event_tx, &mut deadline).unwrap();
        // Apple finalizes the first phrase while the user is still speaking.
        native_tx.send(final_at(50_000)).unwrap();
        forward_mac_events(&mut native_rx, &event_tx, &mut pending, &mut deadline, None).unwrap();
        pending.end_turn(&event_tx, 200_000).unwrap();
        end_mac_turn(
            &pending,
            &mut deadline,
            Instant::now(),
            Duration::from_secs(5),
        );
        native_tx.send(final_at(120_000)).unwrap();
        forward_mac_events(&mut native_rx, &event_tx, &mut pending, &mut deadline, None).unwrap();
        assert_eq!(pending.blocking, 1);
        assert!(deadline.is_some());

        native_tx.send(final_at(195_000)).unwrap();
        forward_mac_events(&mut native_rx, &event_tx, &mut pending, &mut deadline, None).unwrap();
        assert_eq!(pending.blocking, 0);
        assert!(deadline.is_none());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn mac_final_before_its_turn_ends_releases_the_hold_when_it_does() {
        let (event_tx, _event_rx) = tokio_mpsc::channel(16);
        let mut pending = PendingRecognitions::new();
        let mut deadline = None;
        let (native_tx, mut native_rx) = tokio_mpsc::unbounded_channel();
        begin_mac_turn(&mut pending, &event_tx, &mut deadline).unwrap();
        // Apple finalizes the turn before the detector has heard enough silence to end it.
        native_tx
            .send(crate::mac_speech::MacSpeechRecognitionEvent::Final(
                "words".into(),
                Some(100_000),
            ))
            .unwrap();
        forward_mac_events(&mut native_rx, &event_tx, &mut pending, &mut deadline, None).unwrap();
        assert_eq!(pending.blocking, 1);
        pending.end_turn(&event_tx, 105_000).unwrap();
        end_mac_turn(
            &pending,
            &mut deadline,
            Instant::now(),
            Duration::from_secs(5),
        );
        assert_eq!((pending.count, pending.blocking), (0, 0));
        assert!(deadline.is_none());
    }

    #[test]
    fn finals_cover_only_ended_turns_in_order() {
        let (event_tx, _event_rx) = tokio_mpsc::channel(4);
        let mut pending = PendingRecognitions::new();
        pending.begin(&event_tx).unwrap();
        pending.end_turn(&event_tx, 10_000).unwrap();
        pending.begin(&event_tx).unwrap();
        assert_eq!(pending.covered(1_000_000), 1);
        pending.end_turn(&event_tx, 50_000).unwrap();
        pending.end_turn(&event_tx, 1).unwrap();
        assert_eq!(pending.covered(50_000 - FINAL_COVERAGE_SLACK_SAMPLES), 2);
        assert_eq!(pending.covered(49_999 - FINAL_COVERAGE_SLACK_SAMPLES), 1);
        pending.resolve(&event_tx).unwrap();
        assert_eq!(pending.covered(40_000), 1);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn mac_hold_waits_past_its_timeout_for_words_apple_has_heard() {
        let (event_tx, _event_rx) = tokio_mpsc::channel(16);
        let mut pending = PendingRecognitions::new();
        let mut deadline = None;
        let now = Instant::now();
        let timeout = Duration::from_secs(5);
        // Two sentences: the first final arrives, the second takes longer than the timeout.
        for end in [100_000, 300_000] {
            begin_mac_turn(&mut pending, &event_tx, &mut deadline).unwrap();
            pending.end_turn(&event_tx, end).unwrap();
            end_mac_turn(&pending, &mut deadline, now, timeout);
        }
        let (native_tx, mut native_rx) = tokio_mpsc::unbounded_channel();
        use crate::mac_speech::MacSpeechRecognitionEvent::{Final, Heard};
        // Apple re-reports the second sentence's interim words after the first final.
        native_tx.send(Heard(310_000, "you should".into())).unwrap();
        native_tx
            .send(Final("first".into(), Some(110_000)))
            .unwrap();
        native_tx.send(Heard(310_000, "you should".into())).unwrap();
        forward_mac_events(&mut native_rx, &event_tx, &mut pending, &mut deadline, None).unwrap();
        assert_eq!(pending.blocking, 1);
        let words_wait =
            Duration::from_millis(crate::detection::default_interim_words_wait_ms().into());
        assert!(!mac_settle_expired(
            &pending,
            deadline,
            now + timeout,
            words_wait
        ));
        assert!(mac_settle_expired(
            &pending,
            deadline,
            now + timeout + words_wait,
            words_wait
        ));
        pending.expire(&event_tx).unwrap();
        assert!(!pending.words_outstanding());
        // The late final still resolves its turn.
        native_tx
            .send(Final("second".into(), Some(310_000)))
            .unwrap();
        forward_mac_events(&mut native_rx, &event_tx, &mut pending, &mut deadline, None).unwrap();
        assert_eq!(pending.count, 0);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn mac_hold_keeps_its_timeout_once_heard_words_are_final() {
        let (event_tx, _event_rx) = tokio_mpsc::channel(16);
        let mut pending = PendingRecognitions::new();
        let mut deadline = None;
        let now = Instant::now();
        let timeout = Duration::from_secs(5);
        // Words, then noise after them that Apple never transcribes. Interim
        // results end where Apple's audio did, past the final's last word.
        for end in [100_000, 300_000] {
            begin_mac_turn(&mut pending, &event_tx, &mut deadline).unwrap();
            pending.end_turn(&event_tx, end).unwrap();
            end_mac_turn(&pending, &mut deadline, now, timeout);
        }
        let (native_tx, mut native_rx) = tokio_mpsc::unbounded_channel();
        use crate::mac_speech::MacSpeechRecognitionEvent::{Final, Heard};
        native_tx.send(Heard(130_000, "words".into())).unwrap();
        native_tx
            .send(Final("words".into(), Some(110_000)))
            .unwrap();
        forward_mac_events(&mut native_rx, &event_tx, &mut pending, &mut deadline, None).unwrap();
        assert_eq!(pending.blocking, 1);
        assert!(mac_settle_expired(
            &pending,
            deadline,
            now + timeout,
            Duration::from_secs(10)
        ));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn mac_hold_expiry_keeps_late_finals_without_clearing_new_hold_or_evidence() {
        let (event_tx, mut event_rx) = tokio_mpsc::channel(16);
        let mut pending = PendingRecognitions::new();
        let mut deadline = None;
        let now = Instant::now();
        begin_mac_turn(&mut pending, &event_tx, &mut deadline).unwrap();
        end_mac_turn(&pending, &mut deadline, now, Duration::from_millis(750));
        assert!(!mac_settle_expired(
            &pending,
            deadline,
            now + Duration::from_millis(749),
            Duration::from_secs(10)
        ));
        assert!(mac_settle_expired(
            &pending,
            deadline,
            now + Duration::from_millis(750),
            Duration::from_secs(10)
        ));
        pending.expire(&event_tx).unwrap();
        assert_eq!(pending.count, 1);
        assert_eq!(pending.blocking, 0);
        begin_mac_turn(&mut pending, &event_tx, &mut deadline).unwrap();
        assert!(deadline.is_none());
        let controls = VoiceInputControls::default();
        controls
            .set_detection(crate::detection::DetectionSettings::default())
            .unwrap();
        controls.observe_detection(true, controls.mute_epoch());
        let before = controls.detection().unwrap();
        let (native_tx, mut native_rx) = tokio_mpsc::unbounded_channel();
        native_tx
            .send(crate::mac_speech::MacSpeechRecognitionEvent::Final(
                "late old final".into(),
                None,
            ))
            .unwrap();
        forward_mac_events_with_detection(
            &mut native_rx,
            &event_tx,
            &mut pending,
            &mut deadline,
            None,
            Some((&controls, controls.mute_epoch())),
        )
        .unwrap();
        assert_eq!(pending.count, 1);
        assert_eq!(pending.blocking, 1);
        assert_eq!(controls.detection().unwrap(), before);
        // A late final must not consume the newer observation either.
        controls.detection_result(false, controls.mute_epoch());
        assert_eq!(
            controls.detection().unwrap().no_result,
            before.no_result + 1
        );
        let mut saw_text = false;
        let mut holds = Vec::new();
        while let Ok(event) = event_rx.try_recv() {
            match event {
                VoiceInputEvent::FinalTranscript { text, .. } => {
                    assert_eq!(text, "late old final");
                    saw_text = true;
                }
                VoiceInputEvent::RecognitionPendingChanged(active) => holds.push(active),
                _ => {}
            }
        }
        assert!(saw_text);
        assert_eq!(holds, [true, false, true]);
        native_tx
            .send(crate::mac_speech::MacSpeechRecognitionEvent::Final(
                "new final".into(),
                None,
            ))
            .unwrap();
        forward_mac_events(&mut native_rx, &event_tx, &mut pending, &mut deadline, None).unwrap();
        assert_eq!(pending.blocking, 0);
    }

    /// Apple's events replayed through the ledger into a learning tuner.
    #[cfg(target_os = "macos")]
    struct Learning {
        controls: VoiceInputControls,
        events: tokio_mpsc::Sender<VoiceInputEvent>,
        _held: tokio_mpsc::Receiver<VoiceInputEvent>,
        pending: PendingRecognitions,
        deadline: Option<Instant>,
    }

    #[cfg(target_os = "macos")]
    impl Learning {
        fn new(dynamic: crate::detection::Dynamic) -> Self {
            let controls = VoiceInputControls::default();
            controls
                .set_detection(crate::detection::DetectionSettings {
                    dynamic,
                    ..Default::default()
                })
                .unwrap();
            let (events, _held) = tokio_mpsc::channel(4096);
            Self {
                controls,
                events,
                _held,
                pending: PendingRecognitions::new(),
                deadline: None,
            }
        }
        fn all() -> Self {
            Self::new(crate::detection::Dynamic {
                pending_utterance_timeout: true,
                interim_words_wait: true,
                release: true,
            })
        }
        /// A turn whose speech ends at `end`, held until `secs_left` from now.
        fn turn(&mut self, end: u64, secs_left: i64) {
            begin_mac_turn(&mut self.pending, &self.events, &mut self.deadline).unwrap();
            self.pending.end_turn(&self.events, end).unwrap();
            let now = Instant::now();
            self.deadline = Some(if secs_left < 0 {
                now - Duration::from_secs(secs_left.unsigned_abs())
            } else {
                now + Duration::from_secs(secs_left as u64)
            });
        }
        fn hear(
            &mut self,
            events: impl IntoIterator<Item = crate::mac_speech::MacSpeechRecognitionEvent>,
        ) {
            let (native_tx, mut native_rx) = tokio_mpsc::unbounded_channel();
            for event in events {
                native_tx.send(event).unwrap();
            }
            forward_mac_events_with_detection(
                &mut native_rx,
                &self.events,
                &mut self.pending,
                &mut self.deadline,
                None,
                Some((&self.controls, self.controls.mute_epoch())),
            )
            .unwrap();
        }
        fn settings(&self) -> crate::detection::DetectionSettings {
            self.controls.detection().unwrap().settings
        }
    }

    #[cfg(target_os = "macos")]
    fn final_of(text: &str, end: u64) -> crate::mac_speech::MacSpeechRecognitionEvent {
        crate::mac_speech::MacSpeechRecognitionEvent::Final(text.into(), Some(end))
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn mac_late_final_after_the_idle_timeout_lengthens_it_and_prompt_ones_shorten_it() {
        let mut learning = Learning::all();
        learning.turn(48_000, 5);
        learning.pending.expire(&learning.events).unwrap();
        learning.deadline = None;
        learning.hear([final_of("late", 48_000)]);
        assert_eq!(learning.settings().pending_utterance_timeout_ms, 5250);
        assert_eq!(learning.settings().interim_words_wait_ms, 10000);
        for n in 0..19 {
            assert_eq!(learning.settings().pending_utterance_timeout_ms, 5250);
            learning.turn(48_000 * (n + 2), 5);
            learning.hear([final_of("prompt", 48_000 * (n + 2))]);
        }
        let snapshot = learning.controls.detection().unwrap();
        assert_eq!(snapshot.settings.pending_utterance_timeout_ms, 5000);
        assert_eq!(snapshot.pending_utterance_timeout_adjustments, 2);
        assert_eq!(snapshot.interim_words_wait_adjustments, 0);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn mac_final_that_ends_the_interim_words_wait_is_judged_by_that_wait() {
        use crate::mac_speech::MacSpeechRecognitionEvent::Heard;
        let mut learning = Learning::all();
        learning.turn(48_000, 5);
        learning.hear([Heard(50_000, "words".into())]);
        learning.pending.expire(&learning.events).unwrap();
        learning.deadline = None;
        learning.hear([final_of("late", 50_000)]);
        assert_eq!(learning.settings().interim_words_wait_ms, 10500);
        assert_eq!(learning.settings().pending_utterance_timeout_ms, 5000);
        // Finals that arrive once the timeout has passed, with words still showing.
        for n in 0..19 {
            assert_eq!(learning.settings().interim_words_wait_ms, 10500);
            learning.turn(48_000 * (n + 2), -1);
            learning.hear([
                Heard(48_000 * (n + 2) + 100, "words".into()),
                final_of("prompt", 48_000 * (n + 2)),
            ]);
        }
        assert_eq!(learning.settings().interim_words_wait_ms, 10000);
        assert_eq!(learning.settings().pending_utterance_timeout_ms, 5000);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn mac_finals_without_words_or_for_unfinished_holds_teach_nothing() {
        let mut learning = Learning::all();
        let before = learning.controls.detection().unwrap();
        // Two turns, and a final that reaches only the first leaves the hold waiting.
        learning.turn(48_000, 5);
        learning.turn(200_000, 5);
        learning.hear([final_of("first", 48_000)]);
        // Empty finals settle audio without saying a hold was long enough or short.
        learning.pending.expire(&learning.events).unwrap();
        learning.hear([final_of("", 200_000)]);
        learning.turn(300_000, 5);
        learning.hear([final_of("", 300_000)]);
        // Past the timeout with no interim words is the worker's expiry to judge.
        learning.turn(400_000, -1);
        learning.hear([final_of("slow", 400_000)]);
        assert_eq!(learning.controls.detection().unwrap(), before);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn mac_agent_jumping_into_a_split_sentence_lengthens_the_release() {
        use crate::mac_speech::MacSpeechRecognitionEvent::FinalStart;
        let mut learning = Learning::all();
        // The sentence's pause ended a turn at 48 000, the agent began at 70 000, and
        // the user went on to 96 000. One final carries words from both sides.
        learning.turn(48_000, 5);
        learning.turn(96_000, 5);
        learning.pending.agent_began(70_000);
        learning.hear([FinalStart(10_000), final_of("whole sentence", 120_000)]);
        assert_eq!(learning.settings().timing.release_ms, 332);
        assert_eq!(
            learning.controls.detection().unwrap().release_adjustments,
            1
        );
        assert!(learning.pending.agent_starts.is_empty());
        // Splits the agent did not jump into step it back after nineteen.
        for n in 0..19 {
            assert_eq!(learning.settings().timing.release_ms, 332);
            learning.turn(200_000 * (n + 1), 5);
            learning.turn(200_000 * (n + 1) + 48_000, 5);
            learning.hear([
                FinalStart(200_000 * (n + 1) - 90_000),
                final_of("split", 200_000 * (n + 1) + 60_000),
            ]);
        }
        assert_eq!(learning.settings().timing.release_ms, 300);
        assert_eq!(learning.settings().timing.onset_ms, 16);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn mac_release_counts_agents_outside_the_words_as_calm_and_unplaceable_finals_as_nothing() {
        use crate::mac_speech::MacSpeechRecognitionEvent::FinalStart;
        let mut learning = Learning::all();
        learning.turn(48_000, 5);
        learning.turn(96_000, 5);
        learning.pending.agent_began(70_000);
        learning.hear([FinalStart(10_000), final_of("whole sentence", 120_000)]);
        assert_eq!(learning.settings().timing.release_ms, 332);
        // An agent that began before the first word, after the last, or too near the end
        // of the final to have cut in on words is no straddle.
        for at in [5_000, 120_000, 110_000].repeat(6) {
            learning.turn(48_000, 5);
            learning.turn(96_000, 5);
            learning.pending.agent_began(at);
            learning.hear([FinalStart(10_000), final_of("whole sentence", 120_000)]);
        }
        // A final of one turn, or with no first word, says nothing of a split.
        learning.turn(48_000, 5);
        learning.pending.agent_began(30_000);
        learning.hear([FinalStart(10_000), final_of("one turn", 120_000)]);
        learning.turn(48_000, 5);
        learning.turn(96_000, 5);
        learning.pending.agent_began(60_000);
        learning.hear([final_of("unplaced", 120_000)]);
        assert_eq!(learning.settings().timing.release_ms, 332);
        learning.turn(48_000, 5);
        learning.turn(96_000, 5);
        learning.hear([FinalStart(10_000), final_of("whole sentence", 120_000)]);
        assert_eq!(learning.settings().timing.release_ms, 300);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn mac_learning_is_off_until_each_setting_opts_in() {
        use crate::mac_speech::MacSpeechRecognitionEvent::FinalStart;
        let mut learning = Learning::new(Default::default());
        let before = learning.controls.detection().unwrap();
        for _ in 0..30 {
            learning.turn(48_000, 5);
            learning.pending.expire(&learning.events).unwrap();
            learning.pending.agent_began(30_000);
            learning.turn(96_000, 5);
            learning.hear([FinalStart(10_000), final_of("late", 120_000)]);
            learning.hear([final_of("again", 120_000)]);
        }
        assert_eq!(
            learning.controls.detection().unwrap().settings,
            before.settings
        );
    }

    #[test]
    fn agent_starts_are_counted_and_only_the_latest_few_are_kept() {
        let controls = VoiceInputControls::default();
        let starts = || controls.shared.assistant_starts.load(Ordering::Acquire);
        let first = controls
            .begin_assistant_activity(0.65, InputDuringTtsPolicy::AllowBargeIn)
            .unwrap();
        let second = controls
            .begin_assistant_activity(0.65, InputDuringTtsPolicy::AllowBargeIn)
            .unwrap();
        drop((first, second));
        assert_eq!(starts(), 2);
        let mut pending = PendingRecognitions::new();
        for at in 0..20 {
            pending.agent_began(at * 100_000);
        }
        assert_eq!(pending.agent_starts.len(), MAX_AGENT_STARTS);
        assert_eq!(pending.agent_starts.front(), Some(&1_200_000));
    }

    #[test]
    fn pending_credit_saturation_stays_conservative_until_reset() {
        let (tx, mut rx) = tokio_mpsc::channel(8);
        let mut pending = PendingRecognitions::new();
        for _ in 0..MAX_PENDING_RECOGNITIONS + 10 {
            pending
                .begin_bounded(&tx, MAX_PENDING_RECOGNITIONS)
                .unwrap();
        }
        assert_eq!(pending.count, MAX_PENDING_RECOGNITIONS);
        assert!(pending.ambiguous);
        pending.release_hold(&tx).unwrap();
        pending
            .begin_bounded(&tx, MAX_PENDING_RECOGNITIONS)
            .unwrap();
        for _ in 0..MAX_PENDING_RECOGNITIONS + 10 {
            assert!(!pending.result_is_current());
            pending.resolve(&tx).unwrap();
        }
        assert_eq!(pending.blocking, 1);
        pending.reset(&tx).unwrap();
        assert_eq!(pending.count, 0);
        assert!(!pending.ambiguous);
        while rx.try_recv().is_ok() {}
        pending.begin(&tx).unwrap();
        pending.resolve(&tx).unwrap();
        assert_eq!(pending.blocking, 0);
    }

    #[tokio::test]
    async fn finish_is_bounded_and_joins_a_cooperative_worker() {
        let (frame_tx, _frame_rx) = mpsc::sync_channel(INPUT_QUEUE_FRAMES);
        let controls = VoiceInputControls::default();
        let shutdown = Arc::new(AtomicBool::new(false));
        let worker_shutdown = Arc::clone(&shutdown);
        let worker = thread::spawn(move || {
            while !worker_shutdown.load(Ordering::Acquire) {
                thread::yield_now();
            }
        });
        let runtime = VoiceInputRuntime {
            frame_tx,
            controls,
            shutdown,
            discard_on_shutdown: Arc::new(AtomicBool::new(false)),
            shutdown_mute_epoch: Arc::new(AtomicU64::new(0)),
            worker: Some(worker),
        };
        runtime.finish().await.unwrap();
    }

    #[tokio::test]
    async fn blocked_worker_is_quarantined_at_the_production_finish_seam() {
        let (release_tx, release_rx) = mpsc::sync_channel::<()>(0);
        let returned = Arc::new(AtomicBool::new(false));
        let worker_returned = Arc::clone(&returned);
        let worker = thread::spawn(move || {
            let _ = release_rx.recv();
            worker_returned.store(true, Ordering::Release);
        });

        let error = finish_worker(worker, Duration::from_millis(20))
            .await
            .expect_err("blocked worker must miss its bounded finish deadline");
        assert_eq!(
            error,
            VoiceInputFinishError::Quarantined {
                timeout: Duration::from_millis(20)
            }
        );
        assert!(!returned.load(Ordering::Acquire));

        release_tx
            .send(())
            .expect("release quarantined test worker");
        let deadline = Instant::now() + Duration::from_secs(1);
        while !returned.load(Ordering::Acquire) && Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert!(returned.load(Ordering::Acquire));
    }

    #[tokio::test]
    async fn panicked_worker_is_quiescent_and_not_quarantined() {
        let worker = thread::spawn(|| panic!("deliberate worker panic"));
        let error = finish_worker(worker, Duration::from_secs(1))
            .await
            .expect_err("panic is reported");
        assert_eq!(error, VoiceInputFinishError::WorkerPanicked);
        assert!(!error.is_quarantined());
    }
}
