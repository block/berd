use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{TtsBackend, TtsOutcome, TtsSynthesisEvent};

mod stt;

#[cfg(test)]
pub(crate) use stt::first_bundled_fixture_frames_for_test;
pub use stt::{
    benchmark_stt, load_bundled_stt_fixture_pack, SttBenchmarkEnvironment, SttBenchmarkMode,
    SttBenchmarkReport, SttBenchmarkTarget, SttBenchmarkWorkload, SttFixturePack,
};

const TTS_PROMPT_MANIFEST_ENGLISH_SHORT_V1: &str =
    include_str!("../fixtures/tts/english-short-v1.json");
const MAX_TTS_PROMPT_BYTES: usize = 16 * 1024;
const SIGNAL_WINDOW_MS: u32 = 20;
const SIGNAL_HOP_MS: u32 = 10;
const SIGNAL_RELATIVE_THRESHOLD_DB: f64 = -40.0;
const SIGNAL_RELATIVE_THRESHOLD_RATIO: f64 = 0.01;
const SIGNAL_RMS_FLOOR: f64 = 1.0e-6;
const SIGNAL_CONSECUTIVE_WINDOWS: usize = 3;
const SIGNAL_PLAYOUT_ASSUMPTION: &str =
    "immediate_playout_zero_device_latency_with_underrun_stalls";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TtsBenchmarkMode {
    FreshBackend,
    Warm,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TtsBenchmarkScenario {
    ExactPromptRepeat,
    DistinctPromptManifest,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct TtsBenchmarkPrompt {
    pub id: String,
    pub text: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TtsBenchmarkPromptManifest {
    pub id: String,
    pub language: String,
    pub sha256: String,
    pub warmup: TtsBenchmarkPrompt,
    pub prompts: Vec<TtsBenchmarkPrompt>,
}

#[derive(Deserialize)]
struct RawTtsBenchmarkPromptManifest {
    id: String,
    language: String,
    warmup: TtsBenchmarkPrompt,
    prompts: Vec<TtsBenchmarkPrompt>,
}

#[derive(Debug, Serialize)]
pub struct TtsBenchmarkReport {
    pub schema_version: u32,
    pub target: TtsBenchmarkTarget,
    pub mode: TtsBenchmarkMode,
    pub scenario: TtsBenchmarkScenario,
    pub prior_cache_state: &'static str,
    pub signal_onset_method: TtsSignalOnsetMethod,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt_manifest: Option<TtsBenchmarkPromptManifestReport>,
    pub requested_runs: usize,
    pub planned_workload: TtsBenchmarkWorkload,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warmup: Option<TtsBenchmarkRun>,
    pub runs: Vec<TtsBenchmarkRun>,
}

#[derive(Debug, Serialize)]
pub struct TtsSignalOnsetMethod {
    pub algorithm: &'static str,
    pub window_ms: u32,
    pub hop_ms: u32,
    pub relative_threshold_db: f64,
    pub rms_floor: f64,
    pub consecutive_windows: usize,
    pub playout_assumption: &'static str,
}

impl Default for TtsSignalOnsetMethod {
    fn default() -> Self {
        Self {
            algorithm: "relative_rms_v1",
            window_ms: SIGNAL_WINDOW_MS,
            hop_ms: SIGNAL_HOP_MS,
            relative_threshold_db: SIGNAL_RELATIVE_THRESHOLD_DB,
            rms_floor: SIGNAL_RMS_FLOOR,
            consecutive_windows: SIGNAL_CONSECUTIVE_WINDOWS,
            playout_assumption: SIGNAL_PLAYOUT_ASSUMPTION,
        }
    }
}

#[derive(Debug, Serialize)]
pub struct TtsBenchmarkPromptManifestReport {
    pub id: String,
    pub language: String,
    pub sha256: String,
}

#[derive(Debug, Serialize)]
pub struct TtsBenchmarkWorkload {
    pub synthesis_requests: usize,
    pub total_text_bytes: usize,
}

#[derive(Debug, Serialize)]
pub struct TtsBenchmarkTarget {
    pub backend: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub voice: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rate: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub endpoint_source: Option<String>,
}

impl TtsBenchmarkReport {
    pub fn succeeded(&self) -> bool {
        self.warmup
            .iter()
            .chain(self.runs.iter())
            .all(|run| run.error.is_none() && run.outcome == Some(TtsOutcomeLabel::Completed))
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TtsOutcomeLabel {
    Completed,
    Cancelled,
}

#[derive(Debug, Serialize)]
pub struct TtsBenchmarkRun {
    pub run: usize,
    pub measured: bool,
    pub prompt_id: String,
    pub text_bytes: usize,
    pub text_sha256: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub initialization_ms: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub time_to_first_pcm_ms: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub synthesis_ms: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sample_rate_hz: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub playback_rate: Option<f32>,
    pub pcm_frames: u64,
    pub finite_pcm_frames: u64,
    pub nonfinite_pcm_frames: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub peak_abs_amplitude: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub global_rms: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub peak_window_rms: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub onset_threshold_rms: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub leading_sustained_signal_offset_ms: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub first_sustained_signal_callback_ms: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub estimated_earliest_realtime_signal_ms: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub audio_duration_ms: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub realtime_factor: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub outcome: Option<TtsOutcomeLabel>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_stage: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl TtsBenchmarkRun {
    fn initialization_error(
        run: usize,
        measured: bool,
        prompt: &TtsBenchmarkPrompt,
        elapsed: Duration,
        error: String,
    ) -> Self {
        Self {
            run,
            measured,
            prompt_id: prompt.id.clone(),
            text_bytes: prompt.text.len(),
            text_sha256: text_sha256(&prompt.text),
            initialization_ms: Some(milliseconds(elapsed)),
            time_to_first_pcm_ms: None,
            synthesis_ms: None,
            sample_rate_hz: None,
            playback_rate: None,
            pcm_frames: 0,
            finite_pcm_frames: 0,
            nonfinite_pcm_frames: 0,
            peak_abs_amplitude: None,
            global_rms: None,
            peak_window_rms: None,
            onset_threshold_rms: None,
            leading_sustained_signal_offset_ms: None,
            first_sustained_signal_callback_ms: None,
            estimated_earliest_realtime_signal_ms: None,
            audio_duration_ms: None,
            realtime_factor: None,
            outcome: None,
            error_stage: Some("initialization"),
            error: Some(error),
        }
    }
}

pub fn load_bundled_tts_prompt_manifest(id: &str) -> Result<TtsBenchmarkPromptManifest, String> {
    if id != "english-short-v1" {
        return Err(format!("unsupported TTS prompt manifest: {id}"));
    }
    let raw: RawTtsBenchmarkPromptManifest =
        serde_json::from_str(TTS_PROMPT_MANIFEST_ENGLISH_SHORT_V1)
            .map_err(|error| format!("invalid bundled TTS prompt manifest: {error}"))?;
    if raw.id != id || raw.language.trim().is_empty() {
        return Err("bundled TTS prompt manifest identity is invalid".into());
    }
    if !(5..=10).contains(&raw.prompts.len()) {
        return Err("bundled TTS prompt manifest must contain 5 to 10 measured prompts".into());
    }
    let all = std::iter::once(&raw.warmup).chain(raw.prompts.iter());
    let mut ids = std::collections::HashSet::new();
    let mut texts = std::collections::HashSet::new();
    for prompt in all {
        if prompt.id.trim().is_empty()
            || prompt.text.trim().is_empty()
            || prompt.text.len() > MAX_TTS_PROMPT_BYTES
        {
            return Err("bundled TTS prompt is empty or oversized".into());
        }
        if !ids.insert(prompt.id.as_str()) || !texts.insert(prompt.text.as_str()) {
            return Err("bundled TTS prompt IDs and texts must be distinct".into());
        }
    }
    Ok(TtsBenchmarkPromptManifest {
        id: raw.id,
        language: raw.language,
        sha256: text_sha256(TTS_PROMPT_MANIFEST_ENGLISH_SHORT_V1),
        warmup: raw.warmup,
        prompts: raw.prompts,
    })
}

/// Benchmarks exact-prompt cache reuse without constructing an audio output.
pub fn benchmark_tts(
    target: TtsBenchmarkTarget,
    text: &str,
    requested_runs: usize,
    mode: TtsBenchmarkMode,
    create_backend: impl FnMut() -> Result<Arc<dyn TtsBackend>, String>,
) -> TtsBenchmarkReport {
    let prompt = TtsBenchmarkPrompt {
        id: "repeated".into(),
        text: text.into(),
    };
    let warmup = (mode == TtsBenchmarkMode::Warm).then_some(&prompt);
    let prompts = std::iter::repeat_n(prompt.clone(), requested_runs).collect::<Vec<_>>();
    benchmark_tts_prompts(
        target,
        TtsBenchmarkScenario::ExactPromptRepeat,
        None,
        warmup,
        &prompts,
        mode,
        create_backend,
    )
}

/// Benchmarks prompts that are distinct within this invocation from a fixed
/// manifest, without constructing an audio output. Provider and system cache
/// state from earlier invocations remains uncontrolled.
pub fn benchmark_tts_manifest(
    target: TtsBenchmarkTarget,
    manifest: &TtsBenchmarkPromptManifest,
    mode: TtsBenchmarkMode,
    create_backend: impl FnMut() -> Result<Arc<dyn TtsBackend>, String>,
) -> TtsBenchmarkReport {
    let warmup = (mode == TtsBenchmarkMode::Warm).then_some(&manifest.warmup);
    benchmark_tts_prompts(
        target,
        TtsBenchmarkScenario::DistinctPromptManifest,
        Some(TtsBenchmarkPromptManifestReport {
            id: manifest.id.clone(),
            language: manifest.language.clone(),
            sha256: manifest.sha256.clone(),
        }),
        warmup,
        &manifest.prompts,
        mode,
        create_backend,
    )
}

fn benchmark_tts_prompts(
    target: TtsBenchmarkTarget,
    scenario: TtsBenchmarkScenario,
    prompt_manifest: Option<TtsBenchmarkPromptManifestReport>,
    warmup_prompt: Option<&TtsBenchmarkPrompt>,
    prompts: &[TtsBenchmarkPrompt],
    mode: TtsBenchmarkMode,
    mut create_backend: impl FnMut() -> Result<Arc<dyn TtsBackend>, String>,
) -> TtsBenchmarkReport {
    let synthesis_requests = prompts.len() + usize::from(warmup_prompt.is_some());
    let total_text_bytes = prompts.iter().fold(0_usize, |total, prompt| {
        total.saturating_add(prompt.text.len())
    }) + warmup_prompt.map_or(0, |prompt| prompt.text.len());
    let mut report = TtsBenchmarkReport {
        schema_version: 3,
        target,
        mode,
        scenario,
        prior_cache_state: "uncontrolled_system_and_provider_state",
        signal_onset_method: TtsSignalOnsetMethod::default(),
        prompt_manifest,
        requested_runs: prompts.len(),
        planned_workload: TtsBenchmarkWorkload {
            synthesis_requests,
            total_text_bytes,
        },
        warmup: None,
        runs: Vec::with_capacity(prompts.len()),
    };

    match mode {
        TtsBenchmarkMode::FreshBackend => {
            for (index, prompt) in prompts.iter().enumerate() {
                let started = Instant::now();
                match create_backend() {
                    Ok(backend) => report.runs.push(run_synthesis(
                        index + 1,
                        true,
                        Some(started.elapsed()),
                        backend.as_ref(),
                        prompt,
                    )),
                    Err(error) => report.runs.push(TtsBenchmarkRun::initialization_error(
                        index + 1,
                        true,
                        prompt,
                        started.elapsed(),
                        error,
                    )),
                }
            }
        }
        TtsBenchmarkMode::Warm => {
            let prompt = warmup_prompt.expect("warm benchmark always provides a warm-up prompt");
            let started = Instant::now();
            match create_backend() {
                Ok(backend) => {
                    report.warmup = Some(run_synthesis(
                        0,
                        false,
                        Some(started.elapsed()),
                        backend.as_ref(),
                        prompt,
                    ));
                    if report.warmup.as_ref().is_some_and(|run| {
                        run.error.is_none() && run.outcome == Some(TtsOutcomeLabel::Completed)
                    }) {
                        for (index, prompt) in prompts.iter().enumerate() {
                            report.runs.push(run_synthesis(
                                index + 1,
                                true,
                                None,
                                backend.as_ref(),
                                prompt,
                            ));
                        }
                    }
                }
                Err(error) => {
                    report.warmup = Some(TtsBenchmarkRun::initialization_error(
                        0,
                        false,
                        prompt,
                        started.elapsed(),
                        error,
                    ));
                }
            }
        }
    }
    report
}

#[derive(Clone, Copy, Debug)]
struct PcmChunkTiming {
    source_start_frame: u64,
    frame_count: u64,
    callback_elapsed: Duration,
}

#[derive(Clone, Copy, Debug)]
struct SignalWindow {
    source_start_frame: u64,
    rms: f64,
}

#[derive(Debug, Default)]
struct SignalAnalysis {
    finite_pcm_frames: u64,
    nonfinite_pcm_frames: u64,
    peak_abs_amplitude: Option<f64>,
    global_rms: Option<f64>,
    peak_window_rms: Option<f64>,
    onset_threshold_rms: Option<f64>,
    leading_sustained_signal_offset_ms: Option<f64>,
    first_sustained_signal_callback_ms: Option<f64>,
    estimated_earliest_realtime_signal_ms: Option<f64>,
}

struct PcmSignalAnalyzer {
    sample_rate: u32,
    window_frames: usize,
    hop_frames: usize,
    frames_seen: u64,
    finite_frames: u64,
    nonfinite_frames: u64,
    finite_square_sum: f64,
    peak_abs: f64,
    rolling_squares: std::collections::VecDeque<f64>,
    rolling_square_sum: f64,
    windows: Vec<SignalWindow>,
    chunks: Vec<PcmChunkTiming>,
}

impl PcmSignalAnalyzer {
    fn new(sample_rate: u32) -> Self {
        let window_frames = frames_for_milliseconds(sample_rate, SIGNAL_WINDOW_MS);
        let hop_frames = frames_for_milliseconds(sample_rate, SIGNAL_HOP_MS);
        Self {
            sample_rate,
            window_frames,
            hop_frames,
            frames_seen: 0,
            finite_frames: 0,
            nonfinite_frames: 0,
            finite_square_sum: 0.0,
            peak_abs: 0.0,
            rolling_squares: std::collections::VecDeque::with_capacity(window_frames),
            rolling_square_sum: 0.0,
            windows: Vec::new(),
            chunks: Vec::new(),
        }
    }

    fn observe(&mut self, frames: &[f32], callback_elapsed: Duration) {
        if frames.is_empty() {
            return;
        }
        self.chunks.push(PcmChunkTiming {
            source_start_frame: self.frames_seen,
            frame_count: frames.len() as u64,
            callback_elapsed,
        });
        for &sample in frames {
            let square = if sample.is_finite() {
                let sample = f64::from(sample);
                let square = sample * sample;
                self.finite_frames += 1;
                self.finite_square_sum += square;
                self.peak_abs = self.peak_abs.max(sample.abs());
                square
            } else {
                self.nonfinite_frames += 1;
                0.0
            };
            self.rolling_squares.push_back(square);
            self.rolling_square_sum += square;
            if self.rolling_squares.len() > self.window_frames {
                self.rolling_square_sum -= self.rolling_squares.pop_front().unwrap_or_default();
            }
            self.frames_seen += 1;
            if self.window_frames > 0
                && self.hop_frames > 0
                && self.rolling_squares.len() == self.window_frames
                && (self.frames_seen - self.window_frames as u64)
                    .is_multiple_of(self.hop_frames as u64)
            {
                self.windows.push(SignalWindow {
                    source_start_frame: self.frames_seen - self.window_frames as u64,
                    rms: (self.rolling_square_sum / self.window_frames as f64).sqrt(),
                });
            }
        }
    }

    fn finish(&self) -> SignalAnalysis {
        let peak_window_rms = self
            .windows
            .iter()
            .map(|window| window.rms)
            .reduce(f64::max);
        let onset_threshold_rms = peak_window_rms
            .map(|peak| SIGNAL_RMS_FLOOR.max(peak * SIGNAL_RELATIVE_THRESHOLD_RATIO));
        let onset_frame = onset_threshold_rms.and_then(|threshold| {
            let mut qualifying = 0_usize;
            for (index, window) in self.windows.iter().enumerate() {
                if window.rms >= threshold {
                    qualifying += 1;
                    if qualifying == SIGNAL_CONSECUTIVE_WINDOWS {
                        return Some(
                            self.windows[index + 1 - SIGNAL_CONSECUTIVE_WINDOWS].source_start_frame,
                        );
                    }
                } else {
                    qualifying = 0;
                }
            }
            None
        });
        let onset_chunk = onset_frame.and_then(|frame| {
            self.chunks.iter().position(|chunk| {
                frame >= chunk.source_start_frame
                    && frame < chunk.source_start_frame + chunk.frame_count
            })
        });
        let estimated_earliest_realtime_signal_ms = onset_chunk.map(|onset_chunk| {
            let mut playout_ms = milliseconds(self.chunks[0].callback_elapsed);
            for index in 1..=onset_chunk {
                let previous = self.chunks[index - 1];
                let previous_end_ms =
                    playout_ms + frames_to_milliseconds(previous.frame_count, self.sample_rate);
                playout_ms = previous_end_ms.max(milliseconds(self.chunks[index].callback_elapsed));
            }
            playout_ms
                + frames_to_milliseconds(
                    onset_frame.unwrap_or_default() - self.chunks[onset_chunk].source_start_frame,
                    self.sample_rate,
                )
        });
        SignalAnalysis {
            finite_pcm_frames: self.finite_frames,
            nonfinite_pcm_frames: self.nonfinite_frames,
            peak_abs_amplitude: (self.finite_frames > 0).then_some(self.peak_abs),
            global_rms: (self.finite_frames > 0)
                .then(|| (self.finite_square_sum / self.finite_frames as f64).sqrt()),
            peak_window_rms,
            onset_threshold_rms,
            leading_sustained_signal_offset_ms: onset_frame
                .map(|frame| frames_to_milliseconds(frame, self.sample_rate)),
            first_sustained_signal_callback_ms: onset_chunk
                .map(|index| milliseconds(self.chunks[index].callback_elapsed)),
            estimated_earliest_realtime_signal_ms,
        }
    }
}

fn frames_for_milliseconds(sample_rate: u32, duration_ms: u32) -> usize {
    ((u64::from(sample_rate) * u64::from(duration_ms)) / 1_000) as usize
}

fn frames_to_milliseconds(frames: u64, sample_rate: u32) -> f64 {
    if sample_rate == 0 {
        return 0.0;
    }
    frames as f64 * 1_000.0 / f64::from(sample_rate)
}

fn run_synthesis(
    run: usize,
    measured: bool,
    initialization: Option<Duration>,
    backend: &dyn TtsBackend,
    prompt: &TtsBenchmarkPrompt,
) -> TtsBenchmarkRun {
    let spec = backend.pcm_spec();
    let active = AtomicBool::new(true);
    let started = Instant::now();
    let mut first_pcm = None;
    let mut pcm_frames = 0_u64;
    let mut signal = PcmSignalAnalyzer::new(spec.sample_rate);
    let result = backend.synthesize_with_poll(&prompt.text, &active, &mut |event| {
        if let TtsSynthesisEvent::Frames(frames) = event {
            let callback_elapsed = started.elapsed();
            if !frames.is_empty() && first_pcm.is_none() {
                first_pcm = Some(callback_elapsed);
            }
            pcm_frames = pcm_frames.saturating_add(frames.len() as u64);
            signal.observe(frames, callback_elapsed);
        }
        Ok(())
    });
    let synthesis = started.elapsed();
    let signal = signal.finish();
    let audio_duration = (spec.sample_rate > 0)
        .then(|| Duration::from_secs_f64(pcm_frames as f64 / f64::from(spec.sample_rate)));
    let realtime_factor = audio_duration
        .filter(|duration| !duration.is_zero())
        .map(|duration| synthesis.as_secs_f64() / duration.as_secs_f64());
    let (outcome, error_stage, error) = match result {
        Ok(TtsOutcome::Completed) if spec.sample_rate == 0 => (
            None,
            Some("synthesis"),
            Some("backend reported a zero PCM sample rate".into()),
        ),
        Ok(TtsOutcome::Completed) if pcm_frames == 0 => (
            None,
            Some("synthesis"),
            Some("synthesis completed without PCM".into()),
        ),
        Ok(TtsOutcome::Completed) if signal.nonfinite_pcm_frames > 0 => (
            None,
            Some("synthesis"),
            Some("synthesis produced non-finite PCM".into()),
        ),
        Ok(TtsOutcome::Completed) if signal.leading_sustained_signal_offset_ms.is_none() => (
            None,
            Some("synthesis"),
            Some("synthesis completed without sustained PCM signal".into()),
        ),
        Ok(TtsOutcome::Completed) => (Some(TtsOutcomeLabel::Completed), None, None),
        Ok(TtsOutcome::Cancelled) => (Some(TtsOutcomeLabel::Cancelled), None, None),
        Err(error) => (None, Some("synthesis"), Some(error)),
    };
    TtsBenchmarkRun {
        run,
        measured,
        prompt_id: prompt.id.clone(),
        text_bytes: prompt.text.len(),
        text_sha256: text_sha256(&prompt.text),
        initialization_ms: initialization.map(milliseconds),
        time_to_first_pcm_ms: first_pcm.map(milliseconds),
        synthesis_ms: Some(milliseconds(synthesis)),
        sample_rate_hz: Some(spec.sample_rate),
        playback_rate: Some(spec.playback_rate),
        pcm_frames,
        finite_pcm_frames: signal.finite_pcm_frames,
        nonfinite_pcm_frames: signal.nonfinite_pcm_frames,
        peak_abs_amplitude: signal.peak_abs_amplitude,
        global_rms: signal.global_rms,
        peak_window_rms: signal.peak_window_rms,
        onset_threshold_rms: signal.onset_threshold_rms,
        leading_sustained_signal_offset_ms: signal.leading_sustained_signal_offset_ms,
        first_sustained_signal_callback_ms: signal.first_sustained_signal_callback_ms,
        estimated_earliest_realtime_signal_ms: signal.estimated_earliest_realtime_signal_ms,
        audio_duration_ms: audio_duration.map(milliseconds),
        realtime_factor,
        outcome,
        error_stage,
        error,
    }
}

fn text_sha256(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))
}

fn milliseconds(duration: Duration) -> f64 {
    duration.as_secs_f64() * 1_000.0
}

#[cfg(test)]
mod tests {
    use super::{
        benchmark_tts, benchmark_tts_manifest, load_bundled_tts_prompt_manifest, PcmSignalAnalyzer,
        TtsBenchmarkMode, TtsBenchmarkScenario, TtsBenchmarkTarget, TtsOutcomeLabel,
    };
    use crate::{TtsBackend, TtsOutcome, TtsPcmSpec};
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::time::Duration;

    struct FakeTts;

    struct EmptyTts;

    struct ZeroRateTts;

    struct PartialErrorTts;

    struct CancelledTts;

    struct PollingTts;

    struct SilentTts;

    struct NonfiniteTts;

    fn target() -> TtsBenchmarkTarget {
        TtsBenchmarkTarget {
            backend: "fake".into(),
            model: None,
            voice: Some("test".into()),
            language: None,
            rate: Some(1.0),
            endpoint_source: None,
        }
    }

    impl TtsBackend for FakeTts {
        fn pcm_spec(&self) -> TtsPcmSpec {
            TtsPcmSpec {
                sample_rate: 1_000,
                playback_rate: 1.5,
            }
        }

        fn synthesize(
            &self,
            _text: &str,
            _active: &AtomicBool,
            on_frames: &mut dyn FnMut(&[f32]) -> Result<(), String>,
        ) -> Result<TtsOutcome, String> {
            on_frames(&[])?;
            on_frames(&[0.25; 100])?;
            Ok(TtsOutcome::Completed)
        }
    }

    impl TtsBackend for EmptyTts {
        fn pcm_spec(&self) -> TtsPcmSpec {
            TtsPcmSpec {
                sample_rate: 24_000,
                playback_rate: 1.0,
            }
        }

        fn synthesize(
            &self,
            _text: &str,
            _active: &AtomicBool,
            _on_frames: &mut dyn FnMut(&[f32]) -> Result<(), String>,
        ) -> Result<TtsOutcome, String> {
            Ok(TtsOutcome::Completed)
        }
    }

    impl TtsBackend for ZeroRateTts {
        fn pcm_spec(&self) -> TtsPcmSpec {
            TtsPcmSpec {
                sample_rate: 0,
                playback_rate: 1.0,
            }
        }

        fn synthesize(
            &self,
            _text: &str,
            _active: &AtomicBool,
            on_frames: &mut dyn FnMut(&[f32]) -> Result<(), String>,
        ) -> Result<TtsOutcome, String> {
            on_frames(&[0.0])?;
            Ok(TtsOutcome::Completed)
        }
    }

    impl TtsBackend for PartialErrorTts {
        fn pcm_spec(&self) -> TtsPcmSpec {
            FakeTts.pcm_spec()
        }

        fn synthesize(
            &self,
            _text: &str,
            _active: &AtomicBool,
            on_frames: &mut dyn FnMut(&[f32]) -> Result<(), String>,
        ) -> Result<TtsOutcome, String> {
            on_frames(&[0.0; 20])?;
            Err("provider disconnected".into())
        }
    }

    impl TtsBackend for CancelledTts {
        fn pcm_spec(&self) -> TtsPcmSpec {
            FakeTts.pcm_spec()
        }

        fn synthesize(
            &self,
            _text: &str,
            _active: &AtomicBool,
            _on_frames: &mut dyn FnMut(&[f32]) -> Result<(), String>,
        ) -> Result<TtsOutcome, String> {
            Ok(TtsOutcome::Cancelled)
        }
    }

    impl TtsBackend for PollingTts {
        fn pcm_spec(&self) -> TtsPcmSpec {
            FakeTts.pcm_spec()
        }

        fn synthesize(
            &self,
            _text: &str,
            _active: &AtomicBool,
            _on_frames: &mut dyn FnMut(&[f32]) -> Result<(), String>,
        ) -> Result<TtsOutcome, String> {
            unreachable!("benchmark uses synthesize_with_poll")
        }

        fn synthesize_with_poll(
            &self,
            _text: &str,
            _active: &AtomicBool,
            on_event: &mut dyn FnMut(crate::TtsSynthesisEvent<'_>) -> Result<(), String>,
        ) -> Result<TtsOutcome, String> {
            on_event(crate::TtsSynthesisEvent::Poll)?;
            on_event(crate::TtsSynthesisEvent::Frames(&[0.25; 40]))?;
            Ok(TtsOutcome::Completed)
        }
    }

    impl TtsBackend for SilentTts {
        fn pcm_spec(&self) -> TtsPcmSpec {
            FakeTts.pcm_spec()
        }

        fn synthesize(
            &self,
            _text: &str,
            _active: &AtomicBool,
            on_frames: &mut dyn FnMut(&[f32]) -> Result<(), String>,
        ) -> Result<TtsOutcome, String> {
            on_frames(&[0.0; 100])?;
            Ok(TtsOutcome::Completed)
        }
    }

    impl TtsBackend for NonfiniteTts {
        fn pcm_spec(&self) -> TtsPcmSpec {
            FakeTts.pcm_spec()
        }

        fn synthesize(
            &self,
            _text: &str,
            _active: &AtomicBool,
            on_frames: &mut dyn FnMut(&[f32]) -> Result<(), String>,
        ) -> Result<TtsOutcome, String> {
            let mut frames = [0.25; 100];
            frames[30] = f32::NAN;
            frames[70] = f32::INFINITY;
            on_frames(&frames)?;
            Ok(TtsOutcome::Completed)
        }
    }

    #[test]
    fn fresh_backend_mode_constructs_each_run_and_reports_pcm_metrics() {
        let constructions = AtomicUsize::new(0);
        let report = benchmark_tts(target(), "hello", 2, TtsBenchmarkMode::FreshBackend, || {
            constructions.fetch_add(1, Ordering::SeqCst);
            Ok(Arc::new(FakeTts))
        });

        assert_eq!(constructions.load(Ordering::SeqCst), 2);
        assert!(report.warmup.is_none());
        assert_eq!(report.scenario, TtsBenchmarkScenario::ExactPromptRepeat);
        assert_eq!(report.runs.len(), 2);
        for run in report.runs {
            assert!(run.measured);
            assert!(run.initialization_ms.is_some());
            assert!(run.time_to_first_pcm_ms.is_some());
            assert_eq!(run.pcm_frames, 100);
            assert_eq!(run.audio_duration_ms, Some(100.0));
            assert_eq!(run.outcome, Some(TtsOutcomeLabel::Completed));
        }
    }

    #[test]
    fn warm_mode_records_warmup_then_reuses_one_backend() {
        let constructions = AtomicUsize::new(0);
        let report = benchmark_tts(target(), "hello", 2, TtsBenchmarkMode::Warm, || {
            constructions.fetch_add(1, Ordering::SeqCst);
            Ok(Arc::new(FakeTts))
        });

        assert_eq!(constructions.load(Ordering::SeqCst), 1);
        assert!(!report.warmup.as_ref().unwrap().measured);
        assert!(report.warmup.as_ref().unwrap().initialization_ms.is_some());
        assert_eq!(report.runs.len(), 2);
        assert!(report
            .runs
            .iter()
            .all(|run| run.measured && run.initialization_ms.is_none()));
        assert!(report.succeeded());
    }

    #[test]
    fn initialization_errors_remain_structured() {
        let report = benchmark_tts(target(), "hello", 2, TtsBenchmarkMode::FreshBackend, || {
            Err("missing model".into())
        });

        assert_eq!(report.runs.len(), 2);
        assert_eq!(report.runs[0].error_stage, Some("initialization"));
        assert_eq!(report.runs[0].error.as_deref(), Some("missing model"));
        assert!(!report.succeeded());
    }

    #[test]
    fn completed_synthesis_without_pcm_is_an_error() {
        let report = benchmark_tts(target(), "hello", 1, TtsBenchmarkMode::FreshBackend, || {
            Ok(Arc::new(EmptyTts))
        });

        assert_eq!(report.runs[0].error_stage, Some("synthesis"));
        assert_eq!(
            report.runs[0].error.as_deref(),
            Some("synthesis completed without PCM")
        );
        assert!(!report.succeeded());
    }

    #[test]
    fn poll_is_not_pcm_and_partial_errors_keep_measurements() {
        let polled = benchmark_tts(target(), "hello", 1, TtsBenchmarkMode::FreshBackend, || {
            Ok(Arc::new(PollingTts))
        });
        assert_eq!(polled.runs[0].pcm_frames, 40);
        assert_eq!(polled.runs[0].audio_duration_ms, Some(40.0));
        assert!(polled.runs[0].realtime_factor.is_some());
        assert_eq!(polled.runs[0].outcome, Some(TtsOutcomeLabel::Completed));

        let failed = benchmark_tts(target(), "hello", 1, TtsBenchmarkMode::FreshBackend, || {
            Ok(Arc::new(PartialErrorTts))
        });
        assert_eq!(failed.runs[0].pcm_frames, 20);
        assert_eq!(failed.runs[0].audio_duration_ms, Some(20.0));
        assert!(failed.runs[0].time_to_first_pcm_ms.is_some());
        assert!(failed.runs[0].synthesis_ms.is_some());
        assert_eq!(failed.runs[0].error_stage, Some("synthesis"));
        assert_eq!(
            failed.runs[0].error.as_deref(),
            Some("provider disconnected")
        );
    }

    #[test]
    fn cancellation_and_invalid_sample_rate_are_terminal_results() {
        let cancelled = benchmark_tts(target(), "hello", 1, TtsBenchmarkMode::FreshBackend, || {
            Ok(Arc::new(CancelledTts))
        });
        assert_eq!(cancelled.runs[0].outcome, Some(TtsOutcomeLabel::Cancelled));
        assert!(!cancelled.succeeded());

        let invalid = benchmark_tts(target(), "hello", 1, TtsBenchmarkMode::FreshBackend, || {
            Ok(Arc::new(ZeroRateTts))
        });
        assert_eq!(invalid.runs[0].error_stage, Some("synthesis"));
        assert_eq!(
            invalid.runs[0].error.as_deref(),
            Some("backend reported a zero PCM sample rate")
        );
        assert!(invalid.runs[0].audio_duration_ms.is_none());
        assert!(invalid.runs[0].realtime_factor.is_none());
    }

    #[test]
    fn completed_silence_and_nonfinite_pcm_are_terminal_errors() {
        let silent = benchmark_tts(target(), "hello", 1, TtsBenchmarkMode::FreshBackend, || {
            Ok(Arc::new(SilentTts))
        });
        assert_eq!(silent.runs[0].peak_abs_amplitude, Some(0.0));
        assert_eq!(silent.runs[0].global_rms, Some(0.0));
        assert_eq!(silent.runs[0].leading_sustained_signal_offset_ms, None);
        assert_eq!(
            silent.runs[0].error.as_deref(),
            Some("synthesis completed without sustained PCM signal")
        );

        let nonfinite = benchmark_tts(target(), "hello", 1, TtsBenchmarkMode::FreshBackend, || {
            Ok(Arc::new(NonfiniteTts))
        });
        assert_eq!(nonfinite.runs[0].nonfinite_pcm_frames, 2);
        assert_eq!(
            nonfinite.runs[0].error.as_deref(),
            Some("synthesis produced non-finite PCM")
        );
        assert!(!nonfinite.succeeded());
    }

    fn signal_with_leading(
        sample_rate: u32,
        leading_ms: usize,
        signal_ms: usize,
        amplitude: f32,
    ) -> Vec<f32> {
        let mut samples = vec![0.0; sample_rate as usize * leading_ms / 1_000];
        samples.extend(vec![amplitude; sample_rate as usize * signal_ms / 1_000]);
        samples
    }

    #[test]
    fn sustained_signal_detection_is_scaled_and_sample_rate_independent() {
        for sample_rate in [24_000, 48_000] {
            let samples = signal_with_leading(sample_rate, 50, 100, 0.2);
            let mut analyzer = PcmSignalAnalyzer::new(sample_rate);
            analyzer.observe(&samples, Duration::from_millis(7));
            let analysis = analyzer.finish();
            assert_eq!(analysis.nonfinite_pcm_frames, 0);
            assert!((analysis.peak_abs_amplitude.unwrap() - 0.2).abs() < 1.0e-6);
            assert!((analysis.peak_window_rms.unwrap() - 0.2).abs() < 1.0e-6);
            assert!((analysis.onset_threshold_rms.unwrap() - 0.002).abs() < 1.0e-6);
            // A 20 ms window can backdate the sustained transition by at most
            // one hop for this aligned fixture.
            assert_eq!(analysis.leading_sustained_signal_offset_ms, Some(40.0));
            assert_eq!(analysis.first_sustained_signal_callback_ms, Some(7.0));
            assert_eq!(analysis.estimated_earliest_realtime_signal_ms, Some(47.0));
        }

        let quiet = signal_with_leading(48_000, 50, 100, 0.0001);
        let mut analyzer = PcmSignalAnalyzer::new(48_000);
        analyzer.observe(&quiet, Duration::from_millis(3));
        let analysis = analyzer.finish();
        assert_eq!(analysis.onset_threshold_rms, Some(1.0e-6));
        assert_eq!(analysis.leading_sustained_signal_offset_ms, Some(40.0));
    }

    #[test]
    fn detector_crosses_callbacks_ignores_low_noise_and_rejects_a_click() {
        let mut samples = vec![0.0005; 60];
        samples.extend([0.1; 100]);
        let mut contiguous = PcmSignalAnalyzer::new(1_000);
        contiguous.observe(&samples, Duration::from_millis(5));
        let contiguous = contiguous.finish();

        let mut split = PcmSignalAnalyzer::new(1_000);
        let mut start = 0;
        for (end, arrival) in [(7, 1), (23, 2), (61, 3), (104, 4), (160, 5)] {
            split.observe(&samples[start..end], Duration::from_millis(arrival));
            start = end;
        }
        let split = split.finish();
        assert_eq!(
            split.leading_sustained_signal_offset_ms,
            contiguous.leading_sustained_signal_offset_ms
        );
        assert_eq!(split.peak_abs_amplitude, contiguous.peak_abs_amplitude);
        assert_eq!(split.global_rms, contiguous.global_rms);
        assert_eq!(split.peak_window_rms, contiguous.peak_window_rms);
        assert_eq!(split.leading_sustained_signal_offset_ms, Some(50.0));

        let mut click = PcmSignalAnalyzer::new(1_000);
        let mut samples = vec![0.0; 100];
        samples[50] = 1.0;
        click.observe(&samples, Duration::ZERO);
        let click = click.finish();
        assert!(click.peak_window_rms.unwrap() > 0.0);
        assert_eq!(click.leading_sustained_signal_offset_ms, None);
    }

    #[test]
    fn estimated_realtime_signal_accounts_for_late_chunks_and_underruns() {
        let mut analyzer = PcmSignalAnalyzer::new(1_000);
        analyzer.observe(&[0.0; 40], Duration::from_millis(10));
        let mut remainder = vec![0.0; 20];
        remainder.extend([0.25; 100]);
        analyzer.observe(&remainder, Duration::from_millis(200));
        let analysis = analyzer.finish();
        assert_eq!(analysis.leading_sustained_signal_offset_ms, Some(50.0));
        assert_eq!(analysis.first_sustained_signal_callback_ms, Some(200.0));
        assert_eq!(analysis.estimated_earliest_realtime_signal_ms, Some(210.0));

        let all = signal_with_leading(1_000, 50, 100, 0.25);
        let mut batched = PcmSignalAnalyzer::new(1_000);
        batched.observe(&all, Duration::from_millis(10));
        let batched = batched.finish();
        assert_eq!(batched.leading_sustained_signal_offset_ms, Some(40.0));
        assert_eq!(batched.estimated_earliest_realtime_signal_ms, Some(50.0));
    }

    #[test]
    fn report_is_stable_structured_json() {
        let report = benchmark_tts(target(), "hello", 1, TtsBenchmarkMode::FreshBackend, || {
            Ok(Arc::new(FakeTts))
        });
        let value = serde_json::to_value(report).unwrap();

        assert_eq!(value["schema_version"], 3);
        assert_eq!(value["target"]["backend"], "fake");
        assert_eq!(value["target"]["voice"], "test");
        assert_eq!(value["mode"], "fresh_backend");
        assert_eq!(value["scenario"], "exact_prompt_repeat");
        assert_eq!(
            value["prior_cache_state"],
            "uncontrolled_system_and_provider_state"
        );
        assert_eq!(
            value["runs"][0]["text_sha256"],
            "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
        );
        assert_eq!(value["runs"][0]["prompt_id"], "repeated");
        assert_eq!(value["requested_runs"], 1);
        assert_eq!(value["planned_workload"]["synthesis_requests"], 1);
        assert_eq!(value["planned_workload"]["total_text_bytes"], 5);
        assert_eq!(value["runs"][0]["pcm_frames"], 100);
        assert_eq!(value["runs"][0]["finite_pcm_frames"], 100);
        assert_eq!(value["signal_onset_method"]["algorithm"], "relative_rms_v1");
        assert_eq!(
            value["signal_onset_method"]["playout_assumption"],
            "immediate_playout_zero_device_latency_with_underrun_stalls"
        );
        assert_eq!(value["runs"][0]["nonfinite_pcm_frames"], 0);
        assert_eq!(value["runs"][0]["leading_sustained_signal_offset_ms"], 0.0);
        assert!(value["runs"][0]["estimated_earliest_realtime_signal_ms"].is_number());
        assert_eq!(value["runs"][0]["outcome"], "completed");

        let changed = benchmark_tts(target(), "jello", 1, TtsBenchmarkMode::FreshBackend, || {
            Ok(Arc::new(FakeTts))
        });
        assert_ne!(
            value["runs"][0]["text_sha256"],
            serde_json::to_value(changed).unwrap()["runs"][0]["text_sha256"]
        );
    }

    #[test]
    fn bundled_manifest_is_fixed_distinct_and_uses_separate_warmup() {
        let manifest = load_bundled_tts_prompt_manifest("english-short-v1").unwrap();
        assert_eq!(
            manifest.sha256,
            "ab41a51ef214f0a632f517b1c3dca288505a9edafe70f7d58b2c4b4782594e0d"
        );
        assert_eq!(manifest.prompts.len(), 5);
        assert!(manifest
            .prompts
            .iter()
            .all(|prompt| prompt.text != manifest.warmup.text));

        let report = benchmark_tts_manifest(target(), &manifest, TtsBenchmarkMode::Warm, || {
            Ok(Arc::new(FakeTts))
        });
        assert_eq!(
            report.scenario,
            TtsBenchmarkScenario::DistinctPromptManifest
        );
        assert_eq!(report.warmup.as_ref().unwrap().prompt_id, "warmup");
        assert_eq!(report.runs.len(), 5);
        assert!(report
            .runs
            .iter()
            .all(|run| run.text_sha256 != report.warmup.as_ref().unwrap().text_sha256));
        assert_eq!(report.planned_workload.synthesis_requests, 6);
        assert_eq!(
            report.prompt_manifest.as_ref().unwrap().id,
            "english-short-v1"
        );
    }
}
