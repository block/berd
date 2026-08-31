//! Berd v2 voice-input runtime.
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
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use tokio::sync::mpsc as tokio_mpsc;

use crate::{
    openai_realtime::{
        OpenAiRealtimeTranscriptionClient, OpenAiRealtimeTranscriptionConfig,
        OpenAiRealtimeTranscriptionError, OpenAiRealtimeTranscriptionEvent,
    },
    ParakeetRecognizer,
};

pub const INPUT_SAMPLE_RATE: usize = 48_000;
pub const INPUT_FRAME_SAMPLES: usize = 960;
const INPUT_FRAME_DURATION: Duration = Duration::from_millis(20);
const INPUT_QUEUE_FRAMES: usize = 50;

const EVENT_QUEUE_DEPTH: usize = 64;
const MAX_SPEECH_SAMPLES: usize = 16_000 * 30;
const VAD_FRAME_SAMPLES: usize = 256;
const SILENCE_FLUSH_FRAMES: usize = 75;
const OPENAI_NETWORK_OPERATION_TIMEOUT: Duration = Duration::from_secs(5);
const OPENAI_LIVE_RESULT_TIMEOUT: Duration = Duration::from_secs(5);
const OPENAI_FINAL_WRITE_TIMEOUT: Duration = Duration::from_secs(1);
const OPENAI_PRE_ROLL_FRAMES: usize = 15;
const FINAL_STORAGE_TIMEOUT: Duration = Duration::from_secs(5);
#[cfg(target_os = "macos")]
const MAC_LIVE_NO_RESULT_TIMEOUT: Duration = Duration::from_secs(5);
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
}

pub enum VoiceInputEngineConfig {
    Parakeet {
        model_dir: PathBuf,
    },
    #[cfg(target_os = "macos")]
    MacSpeech,
    OpenAi {
        endpoint: String,
        api_key: String,
        model: String,
    },
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
    RecognitionPendingChanged(bool),
    FinalTranscript {
        text: String,
        storage_receipt: FinalTranscriptStorageReceipt,
    },
    Failed(String),
}

#[derive(Clone)]
pub struct VoiceInputControls {
    shared: Arc<ControlState>,
}

struct ControlState {
    transition: Mutex<ControlTransitionState>,
    muted: AtomicBool,
    mute_epoch: AtomicU64,
    assistant_speaking: AtomicBool,
    assistant_vad_threshold: AtomicU32,
}

#[derive(Default)]
struct ControlTransitionState {
    host_muted: bool,
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
    AllowBargeIn,
    SuppressInput,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
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
                transition: Mutex::new(ControlTransitionState::default()),
                muted: AtomicBool::new(false),
                mute_epoch: AtomicU64::new(0),
                assistant_speaking: AtomicBool::new(false),
                assistant_vad_threshold: AtomicU32::new(0.5_f32.to_bits()),
            }),
        }
    }
}

impl VoiceInputControls {
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
        self.publish_assistant_activity(&transition.assistant_activity);
        self.publish_effective_mute(&transition);
        Ok(AssistantActivityGuard {
            controls: self.clone(),
            generation,
        })
    }

    fn mute_epoch(&self) -> u64 {
        self.shared.mute_epoch.load(Ordering::Acquire)
    }

    fn vad_threshold(&self, speech_threshold: f32) -> f32 {
        if self.shared.assistant_speaking.load(Ordering::Acquire) {
            f32::from_bits(self.shared.assistant_vad_threshold.load(Ordering::Acquire))
        } else {
            speech_threshold
        }
    }

    fn publish_effective_mute(&self, transition: &ControlTransitionState) {
        let assistant_suppressed = transition
            .assistant_activity
            .lifetimes
            .values()
            .any(|activity| activity.input_policy == InputDuringTtsPolicy::SuppressInput);
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

struct QueuedFrame {
    frame: VoiceInputFrame,
    mute_epoch: u64,
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
            VoiceInputEngineConfig::MacSpeech => (
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
        if self.controls.is_muted() {
            return Ok(());
        }
        let mute_epoch = self.controls.mute_epoch();
        if self.controls.is_muted() || mute_epoch != self.controls.mute_epoch() {
            return Ok(());
        }
        match self.frame_tx.try_send(QueuedFrame { frame, mute_epoch }) {
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

    pub async fn finish(mut self) -> Result<(), String> {
        let worker = self.begin_shutdown();
        if let Some(worker) = worker {
            let deadline = tokio::time::Instant::now() + FINISH_TIMEOUT;
            while !worker.is_finished() {
                if tokio::time::Instant::now() >= deadline {
                    return Err(format!(
                        "voice input runtime did not stop within {FINISH_TIMEOUT:?}"
                    ));
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            worker
                .join()
                .map_err(|_| "voice input runtime worker panicked".to_string())?;
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
            let _ = thread::Builder::new()
                .name("berd-voice-input-reaper".to_string())
                .spawn(move || {
                    let _ = worker.join();
                });
        }
    }
}

struct PendingRecognitions {
    count: usize,
}

impl PendingRecognitions {
    fn new() -> Self {
        Self { count: 0 }
    }

    fn begin(&mut self, events: &tokio_mpsc::Sender<VoiceInputEvent>) -> Result<(), ()> {
        self.count += 1;
        if self.count == 1 {
            events
                .blocking_send(VoiceInputEvent::RecognitionPendingChanged(true))
                .map_err(|_| ())?;
        }
        Ok(())
    }

    fn resolve(&mut self, events: &tokio_mpsc::Sender<VoiceInputEvent>) -> Result<(), ()> {
        if self.count == 0 {
            return Ok(());
        }
        self.count -= 1;
        if self.count == 0 {
            events
                .blocking_send(VoiceInputEvent::RecognitionPendingChanged(false))
                .map_err(|_| ())?;
        }
        Ok(())
    }

    fn reset(&mut self, events: &tokio_mpsc::Sender<VoiceInputEvent>) -> Result<(), ()> {
        if self.count > 0 {
            self.count = 0;
            events
                .blocking_send(VoiceInputEvent::RecognitionPendingChanged(false))
                .map_err(|_| ())?;
        }
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
        let _ = events.blocking_send(VoiceInputEvent::SpeakingChanged(false));
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
    use rubato::{Fft, FixedSync, Resampler};

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
    let recognizer = match ParakeetRecognizer::load(&model_dir) {
        Ok(recognizer) => recognizer,
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
    if events.blocking_send(VoiceInputEvent::Ready).is_err() {
        return;
    }

    loop {
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
                        recognize_parakeet(
                            &utterance,
                            &recognizer,
                            &events,
                            &mut pending,
                            None,
                            observed_epoch,
                            &controls,
                            &shutdown,
                            &shutdown_mute_epoch,
                        );
                        let _ = events.blocking_send(VoiceInputEvent::SpeakingChanged(false));
                    }
                }
                if speech.len() >= MAX_SPEECH_SAMPLES {
                    let utterance = std::mem::take(&mut speech);
                    silence_frames = 0;
                    let was_speaking = std::mem::take(&mut in_speech);
                    recognize_parakeet(
                        &utterance,
                        &recognizer,
                        &events,
                        &mut pending,
                        None,
                        observed_epoch,
                        &controls,
                        &shutdown,
                        &shutdown_mute_epoch,
                    );
                    if was_speaking {
                        let _ = events.blocking_send(VoiceInputEvent::SpeakingChanged(false));
                    }
                }
            }
        }
    }

    if !discard_on_shutdown.load(Ordering::Acquire) && !speech.is_empty() {
        recognize_parakeet(
            &speech,
            &recognizer,
            &events,
            &mut pending,
            Some(Instant::now() + FINAL_STORAGE_TIMEOUT),
            observed_epoch,
            &controls,
            &shutdown,
            &shutdown_mute_epoch,
        );
    }
    let _ = pending.reset(&events);
}

#[allow(clippy::too_many_arguments)]
fn recognize_parakeet(
    speech: &[f32],
    recognizer: &ParakeetRecognizer,
    events: &tokio_mpsc::Sender<VoiceInputEvent>,
    pending: &mut PendingRecognitions,
    storage_deadline: Option<Instant>,
    expected_epoch: u64,
    controls: &VoiceInputControls,
    shutdown: &AtomicBool,
    shutdown_mute_epoch: &AtomicU64,
) {
    if speech.is_empty() || pending.begin(events).is_err() {
        return;
    }
    let text = recognizer.recognize_utterance(speech);
    complete_parakeet_recognition(
        text,
        events,
        pending,
        storage_deadline,
        effective_mute_epoch(controls, shutdown, shutdown_mute_epoch).1 == expected_epoch,
    );
}

fn complete_parakeet_recognition(
    text: String,
    events: &tokio_mpsc::Sender<VoiceInputEvent>,
    pending: &mut PendingRecognitions,
    storage_deadline: Option<Instant>,
    current_epoch: bool,
) {
    if current_epoch && !text.is_empty() {
        let _ = send_final(events, text, storage_deadline);
    }
    let _ = pending.resolve(events);
}

#[cfg(target_os = "macos")]
fn new_mac_recognizer() -> Result<
    (
        crate::mac_speech::MacSpeechRecognizer,
        tokio_mpsc::UnboundedReceiver<crate::mac_speech::MacSpeechRecognitionEvent>,
    ),
    String,
> {
    crate::mac_speech::MacSpeechRecognizer::new()
}

#[cfg(target_os = "macos")]
fn forward_mac_events(
    recognition_events: &mut tokio_mpsc::UnboundedReceiver<
        crate::mac_speech::MacSpeechRecognitionEvent,
    >,
    events: &tokio_mpsc::Sender<VoiceInputEvent>,
    pending: &mut PendingRecognitions,
    settle_deadline: &mut Option<Instant>,
    storage_deadline: Option<Instant>,
) -> Result<(), ()> {
    while let Ok(event) = recognition_events.try_recv() {
        match event {
            crate::mac_speech::MacSpeechRecognitionEvent::Final(text) => {
                let text = text.trim().to_string();
                if !text.is_empty() {
                    send_final(events, text, storage_deadline)?;
                }
                pending.resolve(events)?;
                if pending.count == 0 {
                    *settle_deadline = None;
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

#[cfg(target_os = "macos")]
fn begin_mac_turn(
    pending: &mut PendingRecognitions,
    events: &tokio_mpsc::Sender<VoiceInputEvent>,
    settle_deadline: &mut Option<Instant>,
) -> Result<(), ()> {
    pending.begin(events)?;
    *settle_deadline = None;
    Ok(())
}

#[cfg(target_os = "macos")]
fn end_mac_turn(
    pending: &PendingRecognitions,
    settle_deadline: &mut Option<Instant>,
    now: Instant,
) {
    if pending.count > 0 {
        *settle_deadline = Some(now + MAC_LIVE_NO_RESULT_TIMEOUT);
    }
}

#[cfg(target_os = "macos")]
fn mac_settle_expired(
    pending: &PendingRecognitions,
    settle_deadline: Option<Instant>,
    now: Instant,
) -> bool {
    pending.count > 0 && settle_deadline.is_some_and(|deadline| now >= deadline)
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
) {
    use rubato::{Fft, FixedSync, Resampler};

    let (mut recognizer, mut recognition_events) = match new_mac_recognizer() {
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
    let mut silence_frames = 0;
    let mut in_speech = false;
    let mut observed_epoch = controls.mute_epoch();
    let mut pending = PendingRecognitions::new();
    let mut settle_deadline = None;
    let mut received_audio = false;
    if events.blocking_send(VoiceInputEvent::Ready).is_err() {
        return;
    }

    loop {
        if forward_mac_events(
            &mut recognition_events,
            &events,
            &mut pending,
            &mut settle_deadline,
            None,
        )
        .is_err()
        {
            return;
        }
        if mac_settle_expired(&pending, settle_deadline, Instant::now()) {
            // SpeechTranscriber has no per-utterance no-result callback. End
            // this recognizer generation at the bounded idle deadline so its
            // suppressed late callbacks cannot resolve a later generation.
            recognizer.cancel();
            let _ = pending.reset(&events);
            settle_deadline = None;
            input_48k.clear();
            leftover_16k.clear();
            silence_frames = 0;
            vad = earshot::Detector::new(earshot::DefaultPredictor::new());
            match new_mac_recognizer() {
                Ok((next, next_events)) => {
                    recognizer = next;
                    recognition_events = next_events;
                    received_audio = false;
                }
                Err(error) => {
                    let _ = events.blocking_send(VoiceInputEvent::Failed(error));
                    return;
                }
            }
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
            input_48k.clear();
            leftover_16k.clear();
            silence_frames = 0;
            if std::mem::take(&mut in_speech) {
                let _ = events.blocking_send(VoiceInputEvent::SpeakingChanged(false));
            }
            let _ = pending.reset(&events);
            settle_deadline = None;
            recognizer.cancel();
            if shutting_down {
                break;
            }
            match new_mac_recognizer() {
                Ok((next, next_events)) => {
                    recognizer = next;
                    recognition_events = next_events;
                    received_audio = false;
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

        input_48k.extend_from_slice(frame.frame.samples());
        while input_48k.len() >= chunk_in {
            let chunk: Vec<f32> = input_48k.drain(..chunk_in).collect();
            leftover_16k.extend_from_slice(&resample(&mut resampler, &chunk));
            while leftover_16k.len() >= VAD_FRAME_SAMPLES {
                let frame: Vec<f32> = leftover_16k.drain(..VAD_FRAME_SAMPLES).collect();
                let clamped = clamp_vad_frame(&frame);
                if vad.predict_f32(&clamped) > controls.vad_threshold(speech_vad_threshold) {
                    silence_frames = 0;
                    if !in_speech {
                        in_speech = true;
                        if begin_mac_turn(&mut pending, &events, &mut settle_deadline).is_err() {
                            return;
                        }
                        let _ = events.blocking_send(VoiceInputEvent::SpeakingChanged(true));
                    }
                } else if in_speech {
                    silence_frames += 1;
                    if silence_frames >= SILENCE_FLUSH_FRAMES {
                        silence_frames = 0;
                        in_speech = false;
                        end_mac_turn(&pending, &mut settle_deadline, Instant::now());
                        let _ = events.blocking_send(VoiceInputEvent::SpeakingChanged(false));
                    }
                }
            }
        }
        if forward_mac_events(
            &mut recognition_events,
            &events,
            &mut pending,
            &mut settle_deadline,
            None,
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
        let _ = pending.reset(&events);
        return;
    }
    if let Err(error) = recognizer.finish() {
        let _ = pending.reset(&events);
        let _ = events.blocking_send(VoiceInputEvent::Failed(error));
        return;
    }
    let deadline = Instant::now() + FINAL_STORAGE_TIMEOUT;
    let _ = forward_mac_events(
        &mut recognition_events,
        &events,
        &mut pending,
        &mut settle_deadline,
        Some(deadline),
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
            let pending = pending_commits.pop_front().unwrap_or(OpenAiPendingCommit {
                mute_epoch: current_epoch,
                settle_deadline: Instant::now() + OPENAI_LIVE_RESULT_TIMEOUT,
            });
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
                let _ = events.blocking_send(VoiceInputEvent::SpeakingChanged(false));
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
            Err(OpenAiRealtimeTranscriptionError::Provider(message)) => {
                let _ = pending.reset(&events);
                let _ = events.blocking_send(VoiceInputEvent::Failed(message));
                break;
            }
            Err(OpenAiRealtimeTranscriptionError::Disconnected)
            | Err(OpenAiRealtimeTranscriptionError::Socket(_)) => continue,
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

    fn silence_frame() -> VoiceInputFrame {
        VoiceInputFrame::try_from_samples(&[0.0; INPUT_FRAME_SAMPLES]).unwrap()
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
    fn parakeet_pending_and_final_precede_the_idle_transition() {
        let (events, mut receiver) = tokio_mpsc::channel(8);
        let mut pending = PendingRecognitions::new();
        pending.begin(&events).unwrap();
        complete_parakeet_recognition("final words".to_string(), &events, &mut pending, None, true);
        events
            .blocking_send(VoiceInputEvent::SpeakingChanged(false))
            .unwrap();

        assert!(matches!(
            receiver.try_recv(),
            Ok(VoiceInputEvent::RecognitionPendingChanged(true))
        ));
        assert!(matches!(
            receiver.try_recv(),
            Ok(VoiceInputEvent::FinalTranscript { text, .. }) if text == "final words"
        ));
        assert!(matches!(
            receiver.try_recv(),
            Ok(VoiceInputEvent::RecognitionPendingChanged(false))
        ));
        assert!(matches!(
            receiver.try_recv(),
            Ok(VoiceInputEvent::SpeakingChanged(false))
        ));
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
        let mut pending = PendingRecognitions { count: 2 };

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
        let mut pending = PendingRecognitions { count: 1 };

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
                ))
                .unwrap();
        }
        let (event_tx, mut event_rx) = tokio_mpsc::channel(4);
        let mut pending = PendingRecognitions { count: 2 };
        let mut settle_deadline = Some(Instant::now() + MAC_LIVE_NO_RESULT_TIMEOUT);

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
        let (event_tx, _event_rx) = tokio_mpsc::channel(4);
        let mut pending = PendingRecognitions::new();
        let mut deadline = None;
        let now = Instant::now();
        begin_mac_turn(&mut pending, &event_tx, &mut deadline).unwrap();
        end_mac_turn(&pending, &mut deadline, now);
        let first_deadline = deadline.expect("first deadline");

        begin_mac_turn(&mut pending, &event_tx, &mut deadline).unwrap();
        assert!(deadline.is_none());
        end_mac_turn(&pending, &mut deadline, now + Duration::from_secs(1));

        assert!(deadline.is_some_and(|deadline| deadline > first_deadline));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn mac_timeout_reset_drops_the_old_event_channel_before_new_pending() {
        let (event_tx, _event_rx) = tokio_mpsc::channel(8);
        let mut pending = PendingRecognitions::new();
        let mut deadline = None;
        let now = Instant::now();
        begin_mac_turn(&mut pending, &event_tx, &mut deadline).unwrap();
        end_mac_turn(&pending, &mut deadline, now);
        assert!(mac_settle_expired(
            &pending,
            deadline,
            now + MAC_LIVE_NO_RESULT_TIMEOUT
        ));

        let (old_tx, old_rx) = tokio_mpsc::unbounded_channel();
        drop(old_rx);
        pending.reset(&event_tx).unwrap();
        deadline = None;
        begin_mac_turn(&mut pending, &event_tx, &mut deadline).unwrap();
        assert!(old_tx
            .send(crate::mac_speech::MacSpeechRecognitionEvent::Final(
                "late old final".to_string(),
            ))
            .is_err());
        assert_eq!(pending.count, 1);

        let (new_tx, mut new_rx) = tokio_mpsc::unbounded_channel();
        new_tx
            .send(crate::mac_speech::MacSpeechRecognitionEvent::Final(
                "current final".to_string(),
            ))
            .unwrap();
        forward_mac_events(&mut new_rx, &event_tx, &mut pending, &mut deadline, None).unwrap();
        assert_eq!(pending.count, 0);
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
}
