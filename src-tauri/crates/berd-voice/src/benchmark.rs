use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{TtsBackend, TtsOutcome, TtsSynthesisEvent};

mod stt;

pub use stt::{
    benchmark_stt, load_bundled_stt_fixture_pack, SttBenchmarkEnvironment, SttBenchmarkMode,
    SttBenchmarkReport, SttBenchmarkTarget, SttBenchmarkWorkload, SttFixturePack,
};

const TTS_PROMPT_MANIFEST_ENGLISH_SHORT_V1: &str =
    include_str!("../fixtures/tts/english-short-v1.json");
const MAX_TTS_PROMPT_BYTES: usize = 16 * 1024;

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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt_manifest: Option<TtsBenchmarkPromptManifestReport>,
    pub requested_runs: usize,
    pub planned_workload: TtsBenchmarkWorkload,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warmup: Option<TtsBenchmarkRun>,
    pub runs: Vec<TtsBenchmarkRun>,
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
        schema_version: 2,
        target,
        mode,
        scenario,
        prior_cache_state: "uncontrolled_system_and_provider_state",
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
    let result = backend.synthesize_with_poll(&prompt.text, &active, &mut |event| {
        if let TtsSynthesisEvent::Frames(frames) = event {
            if !frames.is_empty() && first_pcm.is_none() {
                first_pcm = Some(started.elapsed());
            }
            pcm_frames = pcm_frames.saturating_add(frames.len() as u64);
        }
        Ok(())
    });
    let synthesis = started.elapsed();
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
        benchmark_tts, benchmark_tts_manifest, load_bundled_tts_prompt_manifest, TtsBenchmarkMode,
        TtsBenchmarkScenario, TtsBenchmarkTarget, TtsOutcomeLabel,
    };
    use crate::{TtsBackend, TtsOutcome, TtsPcmSpec};
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::Arc;

    struct FakeTts;

    struct EmptyTts;

    struct ZeroRateTts;

    struct PartialErrorTts;

    struct CancelledTts;

    struct PollingTts;

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
            on_frames(&[0.0; 100])?;
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
            on_event(crate::TtsSynthesisEvent::Frames(&[0.0; 25]))?;
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
        assert_eq!(polled.runs[0].pcm_frames, 25);
        assert_eq!(polled.runs[0].audio_duration_ms, Some(25.0));
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
    fn report_is_stable_structured_json() {
        let report = benchmark_tts(target(), "hello", 1, TtsBenchmarkMode::FreshBackend, || {
            Ok(Arc::new(FakeTts))
        });
        let value = serde_json::to_value(report).unwrap();

        assert_eq!(value["schema_version"], 2);
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
