use std::io::Cursor;
use std::time::{Duration, Instant};

use claxon::FlacReader;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::sync::mpsc;

use crate::input::{
    VoiceInputEvent, VoiceInputFrame, VoiceInputRuntime, INPUT_FRAME_SAMPLES, INPUT_SAMPLE_RATE,
};

const MANIFEST_JSON: &str =
    include_str!("../../fixtures/stt/librispeech-test-clean-mini/manifest.json");
const ATTRIBUTION_NOTICE: &str =
    include_str!("../../fixtures/stt/librispeech-test-clean-mini/NOTICE.md");
const LEADING_SILENCE_FRAMES: usize = 50;
// Keep supplying capture-like silence through the runtime's five-second live
// no-result bounds. Continuous engines such as SpeechTranscriber settle from
// PCM time, not from the benchmark merely waiting without sending frames.
const TRAILING_SILENCE_FRAMES: usize = 325;
const FRAME_DURATION: Duration = Duration::from_millis(20);
const INITIALIZATION_TIMEOUT: Duration = Duration::from_secs(60);
const RESULT_TIMEOUT: Duration = Duration::from_secs(7);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SttBenchmarkMode {
    Cold,
    Warm,
}

#[derive(Clone, Debug, Serialize)]
pub struct SttBenchmarkTarget {
    pub backend: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub locale: Option<String>,
    pub vad_threshold: f32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub endpoint_source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub credential_source: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct SttBenchmarkEnvironment {
    pub os: String,
    pub architecture: String,
    pub berd_voice_version: String,
}

impl Default for SttBenchmarkEnvironment {
    fn default() -> Self {
        Self {
            os: std::env::consts::OS.to_string(),
            architecture: std::env::consts::ARCH.to_string(),
            berd_voice_version: env!("CARGO_PKG_VERSION").to_string(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct SttFixtureManifest {
    pub schema_version: u32,
    pub corpus: String,
    pub resource_id: String,
    pub subset: String,
    pub language: String,
    pub license: String,
    pub license_url: String,
    pub source_url: String,
    pub archive_url: String,
    pub archive_md5: String,
    pub utterances: Vec<SttFixtureMetadata>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct SttFixtureMetadata {
    pub id: String,
    pub file: String,
    pub sha256: String,
    pub bytes: usize,
    pub sample_rate_hz: u32,
    pub channels: u32,
    pub bits_per_sample: u32,
    pub samples: u64,
    pub transcript: String,
}

pub struct SttFixturePack {
    manifest: SttFixtureManifest,
    manifest_sha256: String,
    utterances: Vec<PreparedUtterance>,
}

struct PreparedUtterance {
    metadata: SttFixtureMetadata,
    samples_48k: Vec<f32>,
}

#[derive(Debug, Serialize)]
pub struct SttBenchmarkReport {
    pub schema_version: u32,
    pub target: SttBenchmarkTarget,
    pub environment: SttBenchmarkEnvironment,
    pub mode: SttBenchmarkMode,
    pub runtime_scope: &'static str,
    pub fixture_conversion: &'static str,
    pub input_pacing: &'static str,
    pub word_error_normalization: &'static str,
    pub requested_runs: usize,
    pub fixture: SttFixtureSummary,
    pub planned_workload: SttBenchmarkWorkload,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warmup: Option<SttBenchmarkRun>,
    pub runs: Vec<SttBenchmarkRun>,
    pub aggregate: SttWordError,
}

#[derive(Debug, Serialize)]
pub struct SttFixtureSummary {
    pub corpus: String,
    pub resource_id: String,
    pub subset: String,
    pub language: String,
    pub license: String,
    pub license_url: String,
    pub source_url: String,
    pub archive_url: String,
    pub archive_md5: String,
    pub manifest_sha256: String,
    pub attribution_notice: &'static str,
    pub utterances: Vec<SttFixtureMetadata>,
}

#[derive(Debug, Serialize)]
pub struct SttBenchmarkWorkload {
    pub runtime_initializations: usize,
    pub recognition_commits: usize,
    pub source_audio_seconds: f64,
    pub streamed_audio_seconds: f64,
    pub includes_warmup: bool,
}

#[derive(Debug, Serialize)]
pub struct SttBenchmarkRun {
    pub run: usize,
    pub measured: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub initialization_ms: Option<f64>,
    pub total_ms: f64,
    pub utterances: Vec<SttUtteranceResult>,
    pub aggregate: SttWordError,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_stage: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct SttUtteranceResult {
    pub id: String,
    pub reference: String,
    pub hypothesis: String,
    pub source_duration_ms: f64,
    pub streamed_duration_ms: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub speaking_started_ms: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub speaking_duration_ms: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recognition_pending_ms: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub final_latency_ms: Option<f64>,
    pub total_ms: f64,
    pub word_error: SttWordError,
    pub outcome: SttUtteranceOutcome,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SttUtteranceOutcome {
    Completed,
    NoResult,
    Failed,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct SttWordError {
    pub reference_words: usize,
    pub substitutions: usize,
    pub deletions: usize,
    pub insertions: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub word_error_rate: Option<f64>,
}

impl SttWordError {
    fn add(&mut self, other: &Self) {
        self.reference_words += other.reference_words;
        self.substitutions += other.substitutions;
        self.deletions += other.deletions;
        self.insertions += other.insertions;
        self.word_error_rate = rate(self);
    }
}

impl SttBenchmarkReport {
    pub fn succeeded(&self) -> bool {
        self.warmup.iter().chain(self.runs.iter()).all(|run| {
            run.error.is_none()
                && run
                    .utterances
                    .iter()
                    .all(|utterance| utterance.outcome == SttUtteranceOutcome::Completed)
        }) && self.runs.len() == self.requested_runs
    }
}

pub fn load_bundled_stt_fixture_pack() -> Result<SttFixturePack, String> {
    let manifest: SttFixtureManifest = serde_json::from_str(MANIFEST_JSON)
        .map_err(|error| format!("decode STT fixture manifest: {error}"))?;
    if manifest.schema_version != 1 {
        return Err(format!(
            "unsupported STT fixture manifest schema {}",
            manifest.schema_version
        ));
    }
    let mut utterances = Vec::with_capacity(manifest.utterances.len());
    for metadata in &manifest.utterances {
        let bytes = fixture_bytes(&metadata.file)
            .ok_or_else(|| format!("fixture manifest names unknown file {}", metadata.file))?;
        verify_fixture_bytes(metadata, bytes)?;
        let samples_16k = decode_flac(metadata, bytes)?;
        utterances.push(PreparedUtterance {
            metadata: metadata.clone(),
            samples_48k: upsample_16k_to_48k(&samples_16k),
        });
    }
    if utterances.is_empty() {
        return Err("STT fixture manifest has no utterances".into());
    }
    Ok(SttFixturePack {
        manifest,
        manifest_sha256: format!("{:x}", Sha256::digest(MANIFEST_JSON.as_bytes())),
        utterances,
    })
}

pub async fn benchmark_stt(
    target: SttBenchmarkTarget,
    environment: SttBenchmarkEnvironment,
    pack: &SttFixturePack,
    requested_runs: usize,
    mode: SttBenchmarkMode,
    mut create_runtime: impl FnMut() -> Result<
        (VoiceInputRuntime, mpsc::Receiver<VoiceInputEvent>),
        String,
    >,
) -> SttBenchmarkReport {
    let mut report = SttBenchmarkReport {
        schema_version: 1,
        target,
        environment,
        mode,
        runtime_scope: match mode {
            SttBenchmarkMode::Cold => "fresh_voice_input_runtime_per_measured_run",
            SttBenchmarkMode::Warm => "one_resident_voice_input_runtime_with_unmeasured_warmup",
        },
        fixture_conversion: "FLAC PCM decoded at 16kHz and linearly interpolated to 48kHz",
        input_pacing: "real_time_48khz_mono_f32_960_samples_every_20ms",
        word_error_normalization:
            "ASCII alphanumeric and apostrophe words, uppercase, punctuation as whitespace",
        requested_runs,
        fixture: pack.summary(),
        planned_workload: pack.workload(requested_runs, mode),
        warmup: None,
        runs: Vec::with_capacity(requested_runs),
        aggregate: SttWordError::default(),
    };

    match mode {
        SttBenchmarkMode::Cold => {
            for run in 1..=requested_runs {
                let result = run_with_new_runtime(run, true, pack, &mut create_runtime).await;
                let can_continue = result.error.is_none();
                report.aggregate.add(&result.aggregate);
                report.runs.push(result);
                if !can_continue {
                    break;
                }
            }
        }
        SttBenchmarkMode::Warm => {
            let initialization_started = Instant::now();
            match create_runtime() {
                Err(error) => {
                    report.warmup = Some(SttBenchmarkRun::initialization_error(
                        0,
                        false,
                        initialization_started.elapsed(),
                        error,
                    ));
                }
                Ok((runtime, mut events)) => match wait_until_ready(&mut events).await {
                    Err(error) => {
                        runtime.cancel();
                        report.warmup = Some(SttBenchmarkRun::initialization_error(
                            0,
                            false,
                            initialization_started.elapsed(),
                            error,
                        ));
                        if let Err(error) = finish_runtime(runtime, &mut events).await {
                            record_shutdown_failure(
                                report.warmup.as_mut().expect("warmup was just recorded"),
                                error,
                            );
                        }
                    }
                    Ok(()) => {
                        let initialization = initialization_started.elapsed();
                        let warmup =
                            run_pack(0, false, Some(initialization), pack, &runtime, &mut events)
                                .await;
                        let warmup_ok = warmup.error.is_none()
                            && warmup.utterances.iter().all(|utterance| {
                                utterance.outcome == SttUtteranceOutcome::Completed
                            });
                        report.warmup = Some(warmup);
                        if warmup_ok {
                            for run in 1..=requested_runs {
                                let result =
                                    run_pack(run, true, None, pack, &runtime, &mut events).await;
                                let can_continue = result.error.is_none();
                                report.aggregate.add(&result.aggregate);
                                report.runs.push(result);
                                if !can_continue {
                                    break;
                                }
                            }
                        }
                        if let Err(error) = finish_runtime(runtime, &mut events).await {
                            let target = report
                                .runs
                                .last_mut()
                                .or(report.warmup.as_mut())
                                .expect("warm mode records a warmup before shutdown");
                            record_shutdown_failure(target, error);
                        }
                    }
                },
            }
        }
    }
    report
}

async fn run_with_new_runtime(
    run: usize,
    measured: bool,
    pack: &SttFixturePack,
    create_runtime: &mut impl FnMut() -> Result<
        (VoiceInputRuntime, mpsc::Receiver<VoiceInputEvent>),
        String,
    >,
) -> SttBenchmarkRun {
    let initialization_started = Instant::now();
    let (runtime, mut events) = match create_runtime() {
        Ok(value) => value,
        Err(error) => {
            return SttBenchmarkRun::initialization_error(
                run,
                measured,
                initialization_started.elapsed(),
                error,
            )
        }
    };
    if let Err(error) = wait_until_ready(&mut events).await {
        runtime.cancel();
        let mut result = SttBenchmarkRun::initialization_error(
            run,
            measured,
            initialization_started.elapsed(),
            error,
        );
        if let Err(error) = finish_runtime(runtime, &mut events).await {
            record_shutdown_failure(&mut result, error);
        }
        return result;
    }
    let initialization = initialization_started.elapsed();
    let mut result = run_pack(
        run,
        measured,
        Some(initialization),
        pack,
        &runtime,
        &mut events,
    )
    .await;
    if let Err(error) = finish_runtime(runtime, &mut events).await {
        record_shutdown_failure(&mut result, error);
    }
    result
}

async fn wait_until_ready(events: &mut mpsc::Receiver<VoiceInputEvent>) -> Result<(), String> {
    let deadline = tokio::time::Instant::now() + INITIALIZATION_TIMEOUT;
    match tokio::time::timeout_at(deadline, events.recv()).await {
        Err(_) => Err("voice input initialization exceeded 60 seconds".into()),
        Ok(None) => Err("voice input stopped before readiness".into()),
        Ok(Some(VoiceInputEvent::Ready)) => Ok(()),
        Ok(Some(VoiceInputEvent::Failed(error))) => Err(error),
        Ok(Some(_)) => Err("voice input emitted data before readiness".into()),
    }
}

async fn run_pack(
    run: usize,
    measured: bool,
    initialization: Option<Duration>,
    pack: &SttFixturePack,
    runtime: &VoiceInputRuntime,
    events: &mut mpsc::Receiver<VoiceInputEvent>,
) -> SttBenchmarkRun {
    let started = Instant::now();
    let mut utterances = Vec::with_capacity(pack.utterances.len());
    let mut error = None;
    for fixture in &pack.utterances {
        let result = run_utterance(fixture, runtime, events).await;
        let terminal = result.outcome == SttUtteranceOutcome::Failed;
        utterances.push(result);
        if terminal {
            error = utterances.last().and_then(|result| result.error.clone());
            runtime.cancel();
            break;
        }
    }
    let aggregate = aggregate_utterances(&utterances);
    SttBenchmarkRun {
        run,
        measured,
        initialization_ms: initialization.map(milliseconds),
        total_ms: milliseconds(started.elapsed()),
        utterances,
        aggregate,
        error_stage: error.as_ref().map(|_| "recognition"),
        error,
    }
}

async fn run_utterance(
    fixture: &PreparedUtterance,
    runtime: &VoiceInputRuntime,
    events: &mut mpsc::Receiver<VoiceInputEvent>,
) -> SttUtteranceResult {
    let started = Instant::now();
    let frames = framed_utterance(&fixture.samples_48k);
    let source_end = started
        + FRAME_DURATION * LEADING_SILENCE_FRAMES as u32
        + Duration::from_secs_f64(fixture.metadata.samples as f64 / 16_000.0);
    let result_deadline = started + FRAME_DURATION * frames.len() as u32 + RESULT_TIMEOUT;
    let mut next_frame = 0;
    let mut tracker = UtteranceTracker::default();

    while next_frame < frames.len() || !tracker.settled() {
        if deadline_expired(Instant::now(), result_deadline) {
            tracker.error = Some("recognition did not settle within 7 seconds after input".into());
            break;
        }
        let frame_deadline = started + FRAME_DURATION * (next_frame as u32 + 1);
        if next_frame < frames.len() {
            tokio::select! {
                _ = tokio::time::sleep_until(tokio::time::Instant::from_std(frame_deadline)) => {
                    if let Err(error) = runtime.try_push_frame(
                        VoiceInputFrame::try_from_samples(&frames[next_frame])
                            .expect("benchmark frames have the runtime's exact shape"),
                    ) {
                        tracker.error = Some(error);
                        break;
                    }
                    next_frame += 1;
                }
                event = events.recv() => {
                    if observe_event(event, &mut tracker, started).is_err() {
                        break;
                    }
                }
            }
        } else {
            let remaining = result_deadline.saturating_duration_since(Instant::now());
            match tokio::time::timeout(remaining, events.recv()).await {
                Err(_) => {
                    tracker.error =
                        Some("recognition did not settle within 7 seconds after input".into());
                    break;
                }
                Ok(event) => {
                    if observe_event(event, &mut tracker, started).is_err() {
                        break;
                    }
                }
            }
        }
    }

    let hypothesis = tracker.final_text.unwrap_or_default();
    let word_error = word_error(&fixture.metadata.transcript, &hypothesis);
    let no_result = tracker.error.is_none() && hypothesis.is_empty();
    SttUtteranceResult {
        id: fixture.metadata.id.clone(),
        reference: fixture.metadata.transcript.clone(),
        hypothesis,
        source_duration_ms: fixture.metadata.samples as f64 / 16.0,
        streamed_duration_ms: milliseconds(FRAME_DURATION * frames.len() as u32),
        speaking_started_ms: tracker
            .speaking_started
            .map(|time| milliseconds(time - started)),
        speaking_duration_ms: duration_between(tracker.speaking_started, tracker.speaking_ended),
        recognition_pending_ms: duration_between(tracker.pending_started, tracker.pending_ended),
        final_latency_ms: tracker
            .final_received
            .map(|time| milliseconds(time.saturating_duration_since(source_end))),
        total_ms: milliseconds(started.elapsed()),
        word_error,
        outcome: if tracker.error.is_some() {
            SttUtteranceOutcome::Failed
        } else if no_result {
            SttUtteranceOutcome::NoResult
        } else {
            SttUtteranceOutcome::Completed
        },
        error: tracker
            .error
            .or_else(|| no_result.then(|| "recognizer returned no transcript".into())),
    }
}

fn observe_event(
    event: Option<VoiceInputEvent>,
    tracker: &mut UtteranceTracker,
    run_started: Instant,
) -> Result<(), ()> {
    let now = Instant::now();
    match event {
        None => tracker.error = Some("voice input stopped before recognition settled".into()),
        Some(VoiceInputEvent::Ready) => {
            tracker.error = Some("voice input emitted duplicate readiness".into())
        }
        Some(VoiceInputEvent::SpeakingChanged(active)) => {
            tracker.speaking = active;
            if active {
                tracker.speaking_started.get_or_insert(now);
            } else if tracker.speaking_started.is_some() {
                tracker.speaking_ended = Some(now);
            }
        }
        Some(VoiceInputEvent::RecognitionPendingChanged(active)) => {
            tracker.pending = active;
            if active {
                tracker.pending_seen = true;
                tracker.pending_started.get_or_insert(now);
            } else if tracker.pending_started.is_some() {
                tracker.pending_ended = Some(now);
            }
        }
        Some(VoiceInputEvent::FinalTranscript {
            text,
            storage_receipt,
        }) => {
            if tracker.final_text.is_some() {
                tracker.error =
                    Some("recognizer emitted more than one final for one fixture".into());
            } else {
                tracker.final_text = Some(text);
                tracker.final_received = Some(now.max(run_started));
                storage_receipt.stored();
            }
        }
        Some(VoiceInputEvent::Failed(error)) => tracker.error = Some(error),
    }
    if tracker.error.is_some() {
        Err(())
    } else {
        Ok(())
    }
}

async fn finish_runtime(
    runtime: VoiceInputRuntime,
    events: &mut mpsc::Receiver<VoiceInputEvent>,
) -> Result<(), String> {
    let finish = runtime.finish();
    tokio::pin!(finish);
    loop {
        tokio::select! {
            result = &mut finish => return result.map_err(|error| error.to_string()),
            event = events.recv() => match event {
                Some(event) => observe_shutdown_event(event)?,
                None => return finish.await.map_err(|error| error.to_string()),
            }
        }
    }
}

fn observe_shutdown_event(event: VoiceInputEvent) -> Result<(), String> {
    match event {
        VoiceInputEvent::FinalTranscript { .. } => Err(
            "voice input emitted a final after benchmark utterances settled; transcript was not stored"
                .into(),
        ),
        VoiceInputEvent::Failed(error) => Err(error),
        _ => Ok(()),
    }
}

#[derive(Default)]
struct UtteranceTracker {
    speaking: bool,
    pending: bool,
    pending_seen: bool,
    speaking_started: Option<Instant>,
    speaking_ended: Option<Instant>,
    pending_started: Option<Instant>,
    pending_ended: Option<Instant>,
    final_received: Option<Instant>,
    final_text: Option<String>,
    error: Option<String>,
}

impl UtteranceTracker {
    fn settled(&self) -> bool {
        self.error.is_some()
            || (!self.speaking && !self.pending && (self.final_text.is_some() || self.pending_seen))
    }
}

impl SttFixturePack {
    fn summary(&self) -> SttFixtureSummary {
        SttFixtureSummary {
            corpus: self.manifest.corpus.clone(),
            resource_id: self.manifest.resource_id.clone(),
            subset: self.manifest.subset.clone(),
            language: self.manifest.language.clone(),
            license: self.manifest.license.clone(),
            license_url: self.manifest.license_url.clone(),
            source_url: self.manifest.source_url.clone(),
            archive_url: self.manifest.archive_url.clone(),
            archive_md5: self.manifest.archive_md5.clone(),
            manifest_sha256: self.manifest_sha256.clone(),
            attribution_notice: ATTRIBUTION_NOTICE,
            utterances: self.manifest.utterances.clone(),
        }
    }

    pub fn workload(&self, requested_runs: usize, mode: SttBenchmarkMode) -> SttBenchmarkWorkload {
        let attempts = requested_runs + usize::from(mode == SttBenchmarkMode::Warm);
        let source_audio_seconds = self
            .utterances
            .iter()
            .map(|fixture| fixture.metadata.samples as f64 / 16_000.0)
            .sum::<f64>();
        let streamed_audio_seconds = self
            .utterances
            .iter()
            .map(|fixture| {
                framed_utterance(&fixture.samples_48k).len() as f64 * FRAME_DURATION.as_secs_f64()
            })
            .sum::<f64>();
        SttBenchmarkWorkload {
            runtime_initializations: match mode {
                SttBenchmarkMode::Cold => requested_runs,
                SttBenchmarkMode::Warm => 1,
            },
            recognition_commits: self.utterances.len().saturating_mul(attempts),
            source_audio_seconds: source_audio_seconds * attempts as f64,
            streamed_audio_seconds: streamed_audio_seconds * attempts as f64,
            includes_warmup: mode == SttBenchmarkMode::Warm,
        }
    }
}

impl SttBenchmarkRun {
    fn initialization_error(
        run: usize,
        measured: bool,
        initialization: Duration,
        error: String,
    ) -> Self {
        Self {
            run,
            measured,
            initialization_ms: Some(milliseconds(initialization)),
            total_ms: milliseconds(initialization),
            utterances: Vec::new(),
            aggregate: SttWordError::default(),
            error_stage: Some("initialization"),
            error: Some(error),
        }
    }
}

fn record_shutdown_failure(run: &mut SttBenchmarkRun, error: String) {
    if let Some(existing) = run.error.take() {
        run.error = Some(format!("{existing}; shutdown: {error}"));
    } else {
        run.error_stage = Some("shutdown");
        run.error = Some(error);
    }
}

fn fixture_bytes(file: &str) -> Option<&'static [u8]> {
    match file {
        "1089-134686-0002.flac" => Some(include_bytes!(
            "../../fixtures/stt/librispeech-test-clean-mini/1089-134686-0002.flac"
        )),
        "1221-135766-0002.flac" => Some(include_bytes!(
            "../../fixtures/stt/librispeech-test-clean-mini/1221-135766-0002.flac"
        )),
        "1284-1180-0003.flac" => Some(include_bytes!(
            "../../fixtures/stt/librispeech-test-clean-mini/1284-1180-0003.flac"
        )),
        _ => None,
    }
}

fn verify_fixture_bytes(metadata: &SttFixtureMetadata, bytes: &[u8]) -> Result<(), String> {
    if bytes.len() != metadata.bytes {
        return Err(format!(
            "fixture {} has {} bytes; manifest expects {}",
            metadata.id,
            bytes.len(),
            metadata.bytes
        ));
    }
    let sha256 = format!("{:x}", Sha256::digest(bytes));
    if sha256 != metadata.sha256 {
        return Err(format!(
            "fixture {} SHA-256 mismatch: {sha256}",
            metadata.id
        ));
    }
    Ok(())
}

fn decode_flac(metadata: &SttFixtureMetadata, bytes: &[u8]) -> Result<Vec<f32>, String> {
    let mut reader = FlacReader::new(Cursor::new(bytes))
        .map_err(|error| format!("decode fixture {}: {error}", metadata.id))?;
    let info = reader.streaminfo();
    if info.sample_rate != metadata.sample_rate_hz
        || info.channels != metadata.channels
        || info.bits_per_sample != metadata.bits_per_sample
        || info.samples != Some(metadata.samples)
    {
        return Err(format!(
            "fixture {} decoded stream metadata does not match manifest",
            metadata.id
        ));
    }
    if metadata.channels != 1 || metadata.sample_rate_hz != 16_000 {
        return Err(format!("fixture {} must be 16 kHz mono FLAC", metadata.id));
    }
    let scale = (1_u64 << (metadata.bits_per_sample - 1)) as f32;
    let samples = reader
        .samples()
        .map(|sample| {
            sample
                .map(|sample| (sample as f32 / scale).clamp(-1.0, 1.0))
                .map_err(|error| format!("decode fixture {}: {error}", metadata.id))
        })
        .collect::<Result<Vec<_>, _>>()?;
    if samples.len() as u64 != metadata.samples {
        return Err(format!(
            "fixture {} decoded {} samples; manifest expects {}",
            metadata.id,
            samples.len(),
            metadata.samples
        ));
    }
    Ok(samples)
}

fn upsample_16k_to_48k(samples: &[f32]) -> Vec<f32> {
    debug_assert_eq!(INPUT_SAMPLE_RATE, 48_000);
    let mut output = Vec::with_capacity(samples.len() * 3);
    for (index, current) in samples.iter().copied().enumerate() {
        let next = samples.get(index + 1).copied().unwrap_or(current);
        output.push(current);
        output.push(current + (next - current) / 3.0);
        output.push(current + (next - current) * (2.0 / 3.0));
    }
    output
}

fn framed_utterance(samples: &[f32]) -> Vec<[f32; INPUT_FRAME_SAMPLES]> {
    let audio_frames = samples.len().div_ceil(INPUT_FRAME_SAMPLES);
    let mut frames = vec![
        [0.0; INPUT_FRAME_SAMPLES];
        LEADING_SILENCE_FRAMES + audio_frames + TRAILING_SILENCE_FRAMES
    ];
    for (target, sample) in frames[LEADING_SILENCE_FRAMES..]
        .iter_mut()
        .flatten()
        .zip(samples)
    {
        *target = *sample;
    }
    frames
}

#[cfg(test)]
pub(crate) fn first_bundled_fixture_frames_for_test() -> Vec<[f32; INPUT_FRAME_SAMPLES]> {
    let pack = load_bundled_stt_fixture_pack().expect("checked bundled STT fixture");
    framed_utterance(&pack.utterances[0].samples_48k)
}

fn word_error(reference: &str, hypothesis: &str) -> SttWordError {
    let reference = normalized_words(reference);
    let hypothesis = normalized_words(hypothesis);
    let mut distance = vec![vec![0_usize; hypothesis.len() + 1]; reference.len() + 1];
    for (index, row) in distance.iter_mut().enumerate() {
        row[0] = index;
    }
    for (index, cell) in distance[0].iter_mut().enumerate() {
        *cell = index;
    }
    for i in 1..=reference.len() {
        for j in 1..=hypothesis.len() {
            distance[i][j] = if reference[i - 1] == hypothesis[j - 1] {
                distance[i - 1][j - 1]
            } else {
                (distance[i - 1][j - 1] + 1)
                    .min(distance[i - 1][j] + 1)
                    .min(distance[i][j - 1] + 1)
            };
        }
    }
    let (mut i, mut j) = (reference.len(), hypothesis.len());
    let (mut substitutions, mut deletions, mut insertions) = (0, 0, 0);
    while i > 0 || j > 0 {
        if i > 0 && j > 0 && reference[i - 1] == hypothesis[j - 1] {
            i -= 1;
            j -= 1;
        } else if i > 0 && j > 0 && distance[i][j] == distance[i - 1][j - 1] + 1 {
            substitutions += 1;
            i -= 1;
            j -= 1;
        } else if i > 0 && distance[i][j] == distance[i - 1][j] + 1 {
            deletions += 1;
            i -= 1;
        } else {
            insertions += 1;
            j -= 1;
        }
    }
    let mut result = SttWordError {
        reference_words: reference.len(),
        substitutions,
        deletions,
        insertions,
        word_error_rate: None,
    };
    result.word_error_rate = rate(&result);
    result
}

fn normalized_words(text: &str) -> Vec<String> {
    let normalized = text
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || character == '\'' {
                character.to_ascii_uppercase()
            } else {
                ' '
            }
        })
        .collect::<String>();
    normalized
        .split_whitespace()
        .map(ToString::to_string)
        .collect()
}

fn aggregate_utterances(utterances: &[SttUtteranceResult]) -> SttWordError {
    let mut aggregate = SttWordError::default();
    for utterance in utterances {
        aggregate.add(&utterance.word_error);
    }
    aggregate
}

fn rate(error: &SttWordError) -> Option<f64> {
    (error.reference_words > 0).then(|| {
        (error.substitutions + error.deletions + error.insertions) as f64
            / error.reference_words as f64
    })
}

fn duration_between(start: Option<Instant>, end: Option<Instant>) -> Option<f64> {
    start.zip(end).map(|(start, end)| milliseconds(end - start))
}

fn milliseconds(duration: Duration) -> f64 {
    duration.as_secs_f64() * 1_000.0
}

fn deadline_expired(now: Instant, deadline: Instant) -> bool {
    now >= deadline
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundled_manifest_hashes_and_decoded_metadata_are_exact() {
        let pack = load_bundled_stt_fixture_pack().unwrap();
        assert_eq!(pack.manifest.resource_id, "SLR12");
        assert_eq!(
            pack.manifest.archive_md5,
            "32fa31d27d2e1cad72775fee3f4849a9"
        );
        assert_eq!(pack.utterances.len(), 3);
        assert_eq!(pack.utterances[0].samples_48k.len(), 318_000);
        assert_eq!(pack.utterances[1].samples_48k.len(), 231_600);
        assert_eq!(pack.utterances[2].samples_48k.len(), 232_080);
        assert!(pack
            .utterances
            .iter()
            .flat_map(|fixture| &fixture.samples_48k)
            .all(|sample| sample.is_finite() && (-1.0..=1.0).contains(sample)));
    }

    #[test]
    fn fixture_framing_matches_the_production_contract_and_timing() {
        let pack = load_bundled_stt_fixture_pack().unwrap();
        let frames = framed_utterance(&pack.utterances[0].samples_48k);
        assert_eq!(frames.len(), 50 + 332 + 325);
        assert!(frames[..50].iter().flatten().all(|sample| *sample == 0.0));
        assert!(frames[50 + 332..]
            .iter()
            .flatten()
            .all(|sample| *sample == 0.0));
        assert_eq!(INPUT_SAMPLE_RATE, 48_000);
        assert_eq!(INPUT_FRAME_SAMPLES, 960);
    }

    #[test]
    fn workload_includes_warmup_and_exact_stream_padding() {
        let pack = load_bundled_stt_fixture_pack().unwrap();
        let cold = pack.workload(2, SttBenchmarkMode::Cold);
        assert_eq!(cold.runtime_initializations, 2);
        assert_eq!(cold.recognition_commits, 6);
        assert!((cold.source_audio_seconds - 32.57).abs() < 0.000_001);
        assert!((cold.streamed_audio_seconds - 77.64).abs() < 0.000_001);

        let warm = pack.workload(2, SttBenchmarkMode::Warm);
        assert_eq!(warm.runtime_initializations, 1);
        assert_eq!(warm.recognition_commits, 9);
        assert!((warm.streamed_audio_seconds - 116.46).abs() < 0.000_001);
        assert!(warm.includes_warmup);
    }

    #[test]
    fn word_error_normalizes_case_and_punctuation_and_reports_sdi() {
        assert_eq!(
            word_error("Hello, brave new world!", "hello brave old worlds"),
            SttWordError {
                reference_words: 4,
                substitutions: 2,
                deletions: 0,
                insertions: 0,
                word_error_rate: Some(0.5),
            }
        );
        assert_eq!(
            word_error("ONE TWO THREE", "ZERO ONE THREE FOUR"),
            SttWordError {
                reference_words: 3,
                substitutions: 2,
                deletions: 0,
                insertions: 1,
                word_error_rate: Some(1.0),
            }
        );
        assert_eq!(word_error("ONE TWO THREE", "ONE THREE").deletions, 1);
        assert_eq!(word_error("", "noise").word_error_rate, None);
    }

    #[test]
    fn recognition_deadline_is_inclusive_and_bounded() {
        let now = Instant::now();
        let deadline = now + RESULT_TIMEOUT;
        assert!(!deadline_expired(
            deadline - Duration::from_nanos(1),
            deadline
        ));
        assert!(deadline_expired(deadline, deadline));
        assert!(deadline_expired(
            deadline + Duration::from_nanos(1),
            deadline
        ));
    }

    #[test]
    fn shutdown_failures_are_terminal_and_preserve_an_earlier_failure() {
        let mut clean = SttBenchmarkRun {
            run: 1,
            measured: true,
            initialization_ms: None,
            total_ms: 0.0,
            utterances: Vec::new(),
            aggregate: SttWordError::default(),
            error_stage: None,
            error: None,
        };
        record_shutdown_failure(&mut clean, "worker stuck".into());
        assert_eq!(clean.error_stage, Some("shutdown"));
        assert_eq!(clean.error.as_deref(), Some("worker stuck"));

        let mut initialization =
            SttBenchmarkRun::initialization_error(0, false, Duration::ZERO, "not ready".into());
        record_shutdown_failure(&mut initialization, "worker stuck".into());
        assert_eq!(initialization.error_stage, Some("initialization"));
        assert_eq!(
            initialization.error.as_deref(),
            Some("not ready; shutdown: worker stuck")
        );
    }

    #[test]
    fn receipt_is_acknowledged_only_after_the_first_final_is_stored() {
        let started = Instant::now();
        let mut tracker = UtteranceTracker::default();
        let (first_receipt, first_ack) = crate::input::FinalTranscriptStorageReceipt::test_pair();
        observe_event(
            Some(VoiceInputEvent::FinalTranscript {
                text: "stored words".into(),
                storage_receipt: first_receipt,
            }),
            &mut tracker,
            started,
        )
        .unwrap();
        assert_eq!(tracker.final_text.as_deref(), Some("stored words"));
        assert_eq!(first_ack.recv_timeout(Duration::from_millis(10)), Ok(()));

        let (duplicate_receipt, duplicate_ack) =
            crate::input::FinalTranscriptStorageReceipt::test_pair();
        assert!(observe_event(
            Some(VoiceInputEvent::FinalTranscript {
                text: "duplicate words".into(),
                storage_receipt: duplicate_receipt,
            }),
            &mut tracker,
            started,
        )
        .is_err());
        assert_eq!(tracker.final_text.as_deref(), Some("stored words"));
        assert_eq!(
            duplicate_ack.try_recv(),
            Err(std::sync::mpsc::TryRecvError::Disconnected)
        );
    }

    #[test]
    fn late_final_is_a_shutdown_failure_and_is_not_acknowledged() {
        let (receipt, acknowledgement) = crate::input::FinalTranscriptStorageReceipt::test_pair();
        let error = observe_shutdown_event(VoiceInputEvent::FinalTranscript {
            text: "late words".into(),
            storage_receipt: receipt,
        })
        .unwrap_err();
        assert!(error.contains("after benchmark utterances settled"));
        assert_eq!(
            acknowledgement.try_recv(),
            Err(std::sync::mpsc::TryRecvError::Disconnected)
        );
    }

    #[test]
    fn tracker_requires_authoritative_idle_after_final_or_no_result() {
        let now = Instant::now();
        let mut tracker = UtteranceTracker {
            speaking: true,
            pending: true,
            pending_seen: true,
            speaking_started: Some(now),
            pending_started: Some(now),
            final_text: Some("words".into()),
            ..Default::default()
        };
        assert!(!tracker.settled());
        tracker.speaking = false;
        tracker.pending = false;
        assert!(tracker.settled());

        let no_result = UtteranceTracker {
            pending_seen: true,
            ..Default::default()
        };
        assert!(no_result.settled());
    }

    #[test]
    fn report_json_exposes_provenance_without_fixture_audio_or_secrets() {
        let pack = load_bundled_stt_fixture_pack().unwrap();
        let report = SttBenchmarkReport {
            schema_version: 1,
            target: SttBenchmarkTarget {
                backend: "openai".into(),
                model: Some("test-model".into()),
                locale: None,
                vad_threshold: 0.5,
                endpoint_source: Some("default".into()),
                model_source: Some("environment".into()),
                credential_source: Some("OPENAI_API_KEY environment variable".into()),
            },
            environment: SttBenchmarkEnvironment::default(),
            mode: SttBenchmarkMode::Cold,
            runtime_scope: "fresh_voice_input_runtime_per_measured_run",
            fixture_conversion: "FLAC PCM decoded at 16kHz and linearly interpolated to 48kHz",
            input_pacing: "real_time_48khz_mono_f32_960_samples_every_20ms",
            word_error_normalization:
                "ASCII alphanumeric and apostrophe words, uppercase, punctuation as whitespace",
            requested_runs: 1,
            fixture: pack.summary(),
            planned_workload: pack.workload(1, SttBenchmarkMode::Cold),
            warmup: None,
            runs: Vec::new(),
            aggregate: SttWordError::default(),
        };
        let json = serde_json::to_string(&report).unwrap();
        assert!(json.contains("32fa31d27d2e1cad72775fee3f4849a9"));
        assert!(json.contains("OPENAI_API_KEY environment variable"));
        assert!(json.contains("Creative Commons Attribution 4.0 International"));
        assert!(json.contains("LibriSpeech (c) 2014 by Vassil Panayotov"));
        assert!(!json.contains("sk-"));
    }
}
