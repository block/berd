use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::{TtsBackend, TtsOutcome, TtsSynthesisEvent};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TtsBenchmarkMode {
    Cold,
    Warm,
}

#[derive(Debug, Serialize)]
pub struct TtsBenchmarkReport {
    pub schema_version: u32,
    pub target: TtsBenchmarkTarget,
    pub mode: TtsBenchmarkMode,
    pub text_bytes: usize,
    pub text_sha256: String,
    pub requested_runs: usize,
    pub planned_workload: TtsBenchmarkWorkload,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warmup: Option<TtsBenchmarkRun>,
    pub runs: Vec<TtsBenchmarkRun>,
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
    fn initialization_error(run: usize, measured: bool, elapsed: Duration, error: String) -> Self {
        Self {
            run,
            measured,
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

/// Benchmarks synthesis without constructing or writing to an audio output.
///
/// Cold mode creates a fresh backend for every measured run. Warm mode creates
/// one backend, records one unmeasured warm-up synthesis, then reuses that
/// instance for every measured run. Process-wide provider, native, and OS caches
/// are intentionally outside the meaning of "cold" here.
pub fn benchmark_tts(
    target: TtsBenchmarkTarget,
    text: &str,
    requested_runs: usize,
    mode: TtsBenchmarkMode,
    mut create_backend: impl FnMut() -> Result<Arc<dyn TtsBackend>, String>,
) -> TtsBenchmarkReport {
    let synthesis_requests =
        requested_runs.saturating_add(usize::from(mode == TtsBenchmarkMode::Warm));
    let mut report = TtsBenchmarkReport {
        schema_version: 1,
        target,
        mode,
        text_bytes: text.len(),
        text_sha256: format!("{:x}", Sha256::digest(text.as_bytes())),
        requested_runs,
        planned_workload: TtsBenchmarkWorkload {
            synthesis_requests,
            total_text_bytes: text.len().saturating_mul(synthesis_requests),
        },
        warmup: None,
        runs: Vec::with_capacity(requested_runs),
    };

    match mode {
        TtsBenchmarkMode::Cold => {
            for run in 1..=requested_runs {
                let started = Instant::now();
                match create_backend() {
                    Ok(backend) => report.runs.push(run_synthesis(
                        run,
                        true,
                        Some(started.elapsed()),
                        backend.as_ref(),
                        text,
                    )),
                    Err(error) => report.runs.push(TtsBenchmarkRun::initialization_error(
                        run,
                        true,
                        started.elapsed(),
                        error,
                    )),
                }
            }
        }
        TtsBenchmarkMode::Warm => {
            let started = Instant::now();
            match create_backend() {
                Ok(backend) => {
                    report.warmup = Some(run_synthesis(
                        0,
                        false,
                        Some(started.elapsed()),
                        backend.as_ref(),
                        text,
                    ));
                    if report.warmup.as_ref().is_some_and(|run| {
                        run.error.is_none() && run.outcome == Some(TtsOutcomeLabel::Completed)
                    }) {
                        for run in 1..=requested_runs {
                            report.runs.push(run_synthesis(
                                run,
                                true,
                                None,
                                backend.as_ref(),
                                text,
                            ));
                        }
                    }
                }
                Err(error) => {
                    report.warmup = Some(TtsBenchmarkRun::initialization_error(
                        0,
                        false,
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
    text: &str,
) -> TtsBenchmarkRun {
    let spec = backend.pcm_spec();
    let active = AtomicBool::new(true);
    let started = Instant::now();
    let mut first_pcm = None;
    let mut pcm_frames = 0_u64;
    let result = backend.synthesize_with_poll(text, &active, &mut |event| {
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

fn milliseconds(duration: Duration) -> f64 {
    duration.as_secs_f64() * 1_000.0
}

#[cfg(test)]
mod tests {
    use super::{benchmark_tts, TtsBenchmarkMode, TtsBenchmarkTarget, TtsOutcomeLabel};
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
    fn cold_mode_constructs_each_run_and_reports_pcm_metrics() {
        let constructions = AtomicUsize::new(0);
        let report = benchmark_tts(target(), "hello", 2, TtsBenchmarkMode::Cold, || {
            constructions.fetch_add(1, Ordering::SeqCst);
            Ok(Arc::new(FakeTts))
        });

        assert_eq!(constructions.load(Ordering::SeqCst), 2);
        assert!(report.warmup.is_none());
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
        let report = benchmark_tts(target(), "hello", 2, TtsBenchmarkMode::Cold, || {
            Err("missing model".into())
        });

        assert_eq!(report.runs.len(), 2);
        assert_eq!(report.runs[0].error_stage, Some("initialization"));
        assert_eq!(report.runs[0].error.as_deref(), Some("missing model"));
        assert!(!report.succeeded());
    }

    #[test]
    fn completed_synthesis_without_pcm_is_an_error() {
        let report = benchmark_tts(target(), "hello", 1, TtsBenchmarkMode::Cold, || {
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
        let polled = benchmark_tts(target(), "hello", 1, TtsBenchmarkMode::Cold, || {
            Ok(Arc::new(PollingTts))
        });
        assert_eq!(polled.runs[0].pcm_frames, 25);
        assert_eq!(polled.runs[0].audio_duration_ms, Some(25.0));
        assert!(polled.runs[0].realtime_factor.is_some());
        assert_eq!(polled.runs[0].outcome, Some(TtsOutcomeLabel::Completed));

        let failed = benchmark_tts(target(), "hello", 1, TtsBenchmarkMode::Cold, || {
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
        let cancelled = benchmark_tts(target(), "hello", 1, TtsBenchmarkMode::Cold, || {
            Ok(Arc::new(CancelledTts))
        });
        assert_eq!(cancelled.runs[0].outcome, Some(TtsOutcomeLabel::Cancelled));
        assert!(!cancelled.succeeded());

        let invalid = benchmark_tts(target(), "hello", 1, TtsBenchmarkMode::Cold, || {
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
        let report = benchmark_tts(target(), "hello", 1, TtsBenchmarkMode::Cold, || {
            Ok(Arc::new(FakeTts))
        });
        let value = serde_json::to_value(report).unwrap();

        assert_eq!(value["schema_version"], 1);
        assert_eq!(value["target"]["backend"], "fake");
        assert_eq!(value["target"]["voice"], "test");
        assert_eq!(value["mode"], "cold");
        assert_eq!(
            value["text_sha256"],
            "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
        );
        assert_eq!(value["requested_runs"], 1);
        assert_eq!(value["planned_workload"]["synthesis_requests"], 1);
        assert_eq!(value["planned_workload"]["total_text_bytes"], 5);
        assert_eq!(value["runs"][0]["pcm_frames"], 100);
        assert_eq!(value["runs"][0]["outcome"], "completed");

        let changed = benchmark_tts(target(), "jello", 1, TtsBenchmarkMode::Cold, || {
            Ok(Arc::new(FakeTts))
        });
        assert_ne!(
            value["text_sha256"],
            serde_json::to_value(changed).unwrap()["text_sha256"]
        );
    }
}
