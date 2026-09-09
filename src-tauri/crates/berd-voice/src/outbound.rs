use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::{PcmAudioOutput, TtsBackend, TtsOutcome, TtsSynthesisEvent};

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeliverySegment {
    pub text: String,
    pub played_frames: u64,
    pub total_frames: u64,
    pub synthesis_complete: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct DeliveryProgress {
    #[serde(rename = "sampleRate")]
    pub sample_rate: u32,
    pub segments: Vec<DeliverySegment>,
}

/// Estimate a conservative UTF-8 byte boundary through the last fully played
/// word. Hosts can render the remaining suffix as not spoken without owning a
/// second delivery estimator.
pub fn estimated_spoken_through_utf8(text: &str, delivery: &DeliveryProgress) -> usize {
    let Some(segment) = delivery.segments.first() else {
        return 0;
    };
    if delivery.segments.len() != 1 || segment.text != text || segment.total_frames == 0 {
        return 0;
    }
    if segment.synthesis_complete && segment.played_frames >= segment.total_frames {
        return text.len();
    }

    let character_count = text.chars().count();
    let generated_cutoff = ((character_count as u128 * segment.played_frames as u128)
        / segment.total_frames as u128) as usize;
    let approximate_cutoff = if segment.synthesis_complete {
        generated_cutoff
    } else {
        let duration_cutoff = ((segment.played_frames as u128 * 6)
            / u128::from(delivery.sample_rate.max(1))) as usize;
        generated_cutoff.min(duration_cutoff)
    };

    let mut character_index = 0;
    let mut last_word_end = 0;
    let mut in_word = false;
    for (byte_index, character) in text.char_indices() {
        if character_index >= approximate_cutoff {
            break;
        }
        let is_word = character.is_alphanumeric();
        if in_word && !is_word {
            last_word_end = byte_index;
        }
        in_word = is_word;
        character_index += 1;
    }
    if character_index >= character_count && in_word {
        text.len()
    } else {
        last_word_end
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OutboundOutcome {
    Completed,
    Interrupted,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DrainTimeoutOutcome {
    Fail,
    Complete,
}

#[derive(Clone, Copy, Debug)]
pub struct DrainPolicy {
    pub poll_interval: Duration,
    pub timeout: Option<Duration>,
    pub timeout_outcome: DrainTimeoutOutcome,
    /// Keeps cancellation and health polling active after native source-frame
    /// completion while downstream route latency can still be audible.
    pub post_drain: Duration,
}

impl Default for DrainPolicy {
    fn default() -> Self {
        Self {
            poll_interval: Duration::from_millis(10),
            timeout: None,
            timeout_outcome: DrainTimeoutOutcome::Fail,
            post_drain: Duration::ZERO,
        }
    }
}

#[derive(Debug)]
pub struct OutboundFailure {
    pub message: String,
    pub delivery: DeliveryProgress,
    /// False means output cancellation did not prove a quiescent terminal and
    /// the host must not admit another speech on the same data plane.
    pub output_quiescent: bool,
}

#[derive(Debug)]
struct DeliveryLedger {
    sample_rate: u32,
    segments: Vec<LedgerSegment>,
}

#[derive(Debug)]
struct LedgerSegment {
    text: String,
    total_frames: u64,
    synthesis_complete: bool,
}

impl DeliveryLedger {
    fn new(sample_rate: u32) -> Self {
        Self {
            sample_rate,
            segments: Vec::new(),
        }
    }

    fn begin_segment(&mut self, text: String) {
        self.segments.push(LedgerSegment {
            text,
            total_frames: 0,
            synthesis_complete: false,
        });
    }

    fn append_frames(&mut self, frames: usize) {
        if let Some(segment) = self.segments.last_mut() {
            segment.total_frames = segment.total_frames.saturating_add(frames as u64);
        }
    }

    fn complete_segment(&mut self) {
        if let Some(segment) = self.segments.last_mut() {
            segment.synthesis_complete = true;
        }
    }

    fn snapshot(&self, played_frames: u64) -> DeliveryProgress {
        let mut segment_start = 0_u64;
        let segments = self
            .segments
            .iter()
            .map(|segment| {
                let played_frames = played_frames
                    .saturating_sub(segment_start)
                    .min(segment.total_frames);
                segment_start = segment_start.saturating_add(segment.total_frames);
                DeliverySegment {
                    text: segment.text.clone(),
                    played_frames,
                    total_frames: segment.total_frames,
                    synthesis_complete: segment.synthesis_complete,
                }
            })
            .collect();
        DeliveryProgress {
            sample_rate: self.sample_rate,
            segments,
        }
    }
}

/// Coordinates backend-neutral TTS PCM with one host-provided audio output.
///
/// Text accumulation, device selection, host events, admission, and assistant
/// activity remain outside this type. A coordinator is single-use after a
/// terminal outcome.
pub struct OutboundPlayback<'a> {
    output: &'a dyn PcmAudioOutput,
    active: &'a AtomicBool,
    initial_buffer_frames: usize,
    initial: Vec<f32>,
    started: bool,
    terminal: bool,
    terminal_delivery: Option<DeliveryProgress>,
    ledger: DeliveryLedger,
}

impl<'a> OutboundPlayback<'a> {
    pub fn new(
        output: &'a dyn PcmAudioOutput,
        active: &'a AtomicBool,
        sample_rate: u32,
        initial_buffer_frames: usize,
    ) -> Result<Self, String> {
        if sample_rate == 0 {
            return Err("TTS sample rate must be positive".into());
        }
        Ok(Self {
            output,
            active,
            initial_buffer_frames,
            initial: Vec::new(),
            started: false,
            terminal: false,
            terminal_delivery: None,
            ledger: DeliveryLedger::new(sample_rate),
        })
    }

    pub fn started(&self) -> bool {
        self.started
    }

    pub fn snapshot(&self) -> DeliveryProgress {
        self.terminal_delivery
            .clone()
            .unwrap_or_else(|| self.ledger.snapshot(self.output.played_frames()))
    }

    /// Checks cancellation authority and asynchronous output health while the
    /// host is waiting for more text. Returns `false` after interruption.
    pub fn poll(&mut self) -> Result<bool, OutboundFailure> {
        self.ensure_live()?;
        if !self.active.load(Ordering::SeqCst) {
            self.interrupt()?;
            return Ok(false);
        }
        self.output
            .check_health()
            .map_err(|message| self.fail(message))?;
        Ok(true)
    }

    pub fn synthesize_segment(
        &mut self,
        backend: &dyn TtsBackend,
        text: &str,
        before_write: &mut dyn FnMut(bool) -> Result<(), String>,
        on_started: &mut dyn FnMut() -> Result<(), String>,
        on_progress: &mut dyn FnMut(&DeliveryProgress) -> Result<(), String>,
    ) -> Result<OutboundOutcome, OutboundFailure> {
        self.ensure_live()?;
        if !self.active.load(Ordering::SeqCst) {
            return self.interrupt();
        }
        self.ledger.begin_segment(text.to_string());
        let outcome = backend.synthesize_with_poll(text, self.active, &mut |event| match event {
            TtsSynthesisEvent::Frames(samples) => {
                if samples.is_empty() {
                    return Ok(());
                }
                if !self.active.load(Ordering::SeqCst) {
                    return Ok(());
                }
                self.output.check_health()?;
                self.ledger.append_frames(samples.len());
                if self.started {
                    before_write(false)?;
                    self.output.write(samples)?;
                    on_progress(&self.snapshot())
                } else {
                    self.initial.extend_from_slice(samples);
                    if self.initial.len() >= self.initial_buffer_frames.max(1) {
                        self.flush_initial(before_write, on_started)?;
                        on_progress(&self.snapshot())
                    } else {
                        Ok(())
                    }
                }
            }
            TtsSynthesisEvent::Poll => {
                if self.active.load(Ordering::SeqCst) {
                    self.output.check_health()?;
                    on_progress(&self.snapshot())?;
                }
                Ok(())
            }
        });
        let outcome = match outcome {
            Ok(outcome) => outcome,
            Err(_) if !self.active.load(Ordering::SeqCst) => return self.interrupt(),
            Err(message) => return Err(self.fail(message)),
        };
        if outcome == TtsOutcome::Cancelled || !self.active.load(Ordering::SeqCst) {
            return self.interrupt();
        }
        self.ledger.complete_segment();
        if !self.initial.is_empty() {
            if let Err(message) = self.flush_initial(before_write, on_started) {
                return Err(self.fail(message));
            }
            if let Err(message) = on_progress(&self.snapshot()) {
                return Err(self.fail(message));
            }
        }
        Ok(OutboundOutcome::Completed)
    }

    pub fn finish(
        &mut self,
        policy: DrainPolicy,
        on_poll: &mut dyn FnMut(&DeliveryProgress) -> Result<(), String>,
    ) -> Result<OutboundOutcome, OutboundFailure> {
        self.ensure_live()?;
        let started_at = Instant::now();
        let mut forced_complete = false;
        while !self.output.is_drained() {
            if !self.active.load(Ordering::SeqCst) {
                return self.interrupt();
            }
            if policy
                .timeout
                .is_some_and(|timeout| started_at.elapsed() >= timeout)
            {
                if policy.timeout_outcome == DrainTimeoutOutcome::Complete {
                    self.remember_delivery_and_cancel()?;
                    forced_complete = true;
                    break;
                }
                return Err(self.fail("TTS playback did not drain before its deadline".into()));
            }
            self.output
                .check_health()
                .map_err(|message| self.fail(message))?;
            on_poll(&self.snapshot()).map_err(|message| self.fail(message))?;
            std::thread::sleep(policy.poll_interval);
        }
        if !self.active.load(Ordering::SeqCst) {
            return self.interrupt();
        }
        if !forced_complete {
            self.output
                .check_health()
                .map_err(|message| self.fail(message))?;
        }
        let post_drain_started = Instant::now();
        while post_drain_started.elapsed() < policy.post_drain {
            if !self.active.load(Ordering::SeqCst) {
                return self.interrupt();
            }
            if !forced_complete {
                self.output
                    .check_health()
                    .map_err(|message| self.fail(message))?;
            }
            on_poll(&self.snapshot()).map_err(|message| self.fail(message))?;
            std::thread::sleep(policy.poll_interval);
        }
        self.terminal = true;
        Ok(OutboundOutcome::Completed)
    }

    pub fn interrupt(&mut self) -> Result<OutboundOutcome, OutboundFailure> {
        if !self.terminal {
            self.remember_delivery_and_cancel()?;
            self.terminal = true;
        }
        Ok(OutboundOutcome::Interrupted)
    }

    fn flush_initial(
        &mut self,
        before_write: &mut dyn FnMut(bool) -> Result<(), String>,
        on_started: &mut dyn FnMut() -> Result<(), String>,
    ) -> Result<(), String> {
        if self.initial.is_empty() {
            return Ok(());
        }
        before_write(true)?;
        self.output.write(&self.initial)?;
        self.initial.clear();
        self.started = true;
        on_started()?;
        Ok(())
    }

    fn ensure_live(&mut self) -> Result<(), OutboundFailure> {
        if self.terminal {
            Err(OutboundFailure {
                message: "TTS playback is already terminal".into(),
                delivery: self.snapshot(),
                output_quiescent: true,
            })
        } else {
            Ok(())
        }
    }

    fn fail(&mut self, message: String) -> OutboundFailure {
        self.terminal_delivery = Some(self.snapshot());
        let cancellation = self.output.cancel_and_snapshot();
        let output_quiescent = cancellation.is_ok();
        if let Ok(played_frames) = cancellation {
            self.terminal_delivery = Some(self.ledger.snapshot(played_frames));
        }
        self.terminal = true;
        let delivery = self
            .terminal_delivery
            .clone()
            .expect("failure records terminal delivery");
        let message = if output_quiescent {
            message
        } else {
            format!("{message}; output cancellation did not reach a quiescent terminal")
        };
        OutboundFailure {
            message,
            delivery,
            output_quiescent,
        }
    }

    fn remember_delivery_and_cancel(&mut self) -> Result<(), OutboundFailure> {
        if self.terminal_delivery.is_some() {
            self.output.cancel();
            return Ok(());
        }
        let played_frames = self
            .output
            .cancel_and_snapshot()
            .map_err(|message| self.fail_without_cancel(message))?;
        self.terminal_delivery = Some(self.ledger.snapshot(played_frames));
        Ok(())
    }

    fn fail_without_cancel(&mut self, message: String) -> OutboundFailure {
        let delivery = self.snapshot();
        self.terminal_delivery = Some(delivery.clone());
        self.terminal = true;
        OutboundFailure {
            message,
            delivery,
            output_quiescent: false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::TtsPcmSpec;
    use std::sync::atomic::{AtomicU64, AtomicUsize};
    use std::sync::Mutex;

    #[test]
    fn spoken_through_estimate_uses_completed_word_utf8_boundary() {
        let text = "Hello café world.";
        let delivery = DeliveryProgress {
            sample_rate: 24_000,
            segments: vec![DeliverySegment {
                text: text.into(),
                played_frames: 14_000,
                total_frames: 24_000,
                synthesis_complete: true,
            }],
        };

        let cutoff = estimated_spoken_through_utf8(text, &delivery);
        assert_eq!(&text[..cutoff], "Hello");
        assert!(text.is_char_boundary(cutoff));
    }

    #[test]
    fn spoken_through_estimate_is_conservative_for_incomplete_synthesis() {
        let text = "One two three four five six seven eight.";
        let delivery = DeliveryProgress {
            sample_rate: 24_000,
            segments: vec![DeliverySegment {
                text: text.into(),
                played_frames: 24_000,
                total_frames: 24_000,
                synthesis_complete: false,
            }],
        };

        assert_eq!(
            &text[..estimated_spoken_through_utf8(text, &delivery)],
            "One"
        );
    }

    struct FakeTts {
        chunks: Vec<Vec<f32>>,
        cancel_after_first: bool,
    }

    struct PollThenFramesTts;

    struct UnquiescedOutput;

    impl PcmAudioOutput for UnquiescedOutput {
        fn write(&self, _samples: &[f32]) -> Result<(), String> {
            Err("remote write failed".into())
        }

        fn cancel(&self) {}

        fn cancel_and_snapshot(&self) -> Result<u64, String> {
            Err("remote cancel timed out".into())
        }

        fn is_drained(&self) -> bool {
            false
        }

        fn check_health(&self) -> Result<(), String> {
            Ok(())
        }

        fn played_frames(&self) -> u64 {
            0
        }
    }

    impl TtsBackend for PollThenFramesTts {
        fn pcm_spec(&self) -> TtsPcmSpec {
            TtsPcmSpec {
                sample_rate: 10,
                playback_rate: 1.0,
            }
        }

        fn synthesize(
            &self,
            _text: &str,
            _active: &AtomicBool,
            _on_frames: &mut dyn FnMut(&[f32]) -> Result<(), String>,
        ) -> Result<TtsOutcome, String> {
            unreachable!("test backend exercises the polling synthesis seam")
        }

        fn synthesize_with_poll(
            &self,
            _text: &str,
            _active: &AtomicBool,
            on_event: &mut dyn FnMut(TtsSynthesisEvent<'_>) -> Result<(), String>,
        ) -> Result<TtsOutcome, String> {
            on_event(TtsSynthesisEvent::Poll)?;
            on_event(TtsSynthesisEvent::Frames(&[0.3]))?;
            Ok(TtsOutcome::Completed)
        }
    }

    impl TtsBackend for FakeTts {
        fn pcm_spec(&self) -> TtsPcmSpec {
            TtsPcmSpec {
                sample_rate: 10,
                playback_rate: 1.0,
            }
        }

        fn synthesize(
            &self,
            _text: &str,
            active: &AtomicBool,
            on_frames: &mut dyn FnMut(&[f32]) -> Result<(), String>,
        ) -> Result<TtsOutcome, String> {
            for (index, chunk) in self.chunks.iter().enumerate() {
                on_frames(chunk)?;
                if self.cancel_after_first && index == 0 {
                    active.store(false, Ordering::SeqCst);
                    return Ok(TtsOutcome::Cancelled);
                }
            }
            Ok(TtsOutcome::Completed)
        }
    }

    struct FakeOutput {
        writes: Mutex<Vec<Vec<f32>>>,
        played: AtomicU64,
        drain_polls: AtomicUsize,
        drain_after: AtomicUsize,
        cancelled: AtomicBool,
        fail_health: AtomicBool,
    }

    impl FakeOutput {
        fn new(drain_after: usize) -> Self {
            Self {
                writes: Mutex::new(Vec::new()),
                played: AtomicU64::new(0),
                drain_polls: AtomicUsize::new(0),
                drain_after: AtomicUsize::new(drain_after),
                cancelled: AtomicBool::new(false),
                fail_health: AtomicBool::new(false),
            }
        }
    }

    impl PcmAudioOutput for FakeOutput {
        fn write(&self, samples: &[f32]) -> Result<(), String> {
            self.writes.lock().unwrap().push(samples.to_vec());
            Ok(())
        }
        fn cancel(&self) {
            self.cancelled.store(true, Ordering::SeqCst);
            self.played.store(0, Ordering::SeqCst);
        }
        fn is_drained(&self) -> bool {
            self.drain_polls.fetch_add(1, Ordering::SeqCst)
                >= self.drain_after.load(Ordering::SeqCst)
        }
        fn check_health(&self) -> Result<(), String> {
            if self.fail_health.load(Ordering::SeqCst) {
                Err("fake output failed".into())
            } else {
                Ok(())
            }
        }
        fn played_frames(&self) -> u64 {
            self.played.load(Ordering::SeqCst)
        }
    }

    #[test]
    fn buffers_initial_pcm_and_starts_exactly_once() {
        let active = AtomicBool::new(true);
        let output = FakeOutput::new(0);
        let backend = FakeTts {
            chunks: vec![vec![0.1, 0.2], vec![0.3, 0.4], vec![0.5]],
            cancel_after_first: false,
        };
        let mut playback = OutboundPlayback::new(&output, &active, 10, 4).unwrap();
        let mut starting = 0;
        let mut started = 0;
        assert_eq!(
            playback
                .synthesize_segment(
                    &backend,
                    "hello",
                    &mut |first| {
                        starting += usize::from(first);
                        Ok(())
                    },
                    &mut || {
                        started += 1;
                        Ok(())
                    },
                    &mut |_| Ok(()),
                )
                .unwrap(),
            OutboundOutcome::Completed
        );
        assert_eq!(starting, 1);
        assert_eq!(started, 1);
        assert_eq!(
            output.writes.lock().unwrap().as_slice(),
            &[vec![0.1, 0.2, 0.3, 0.4], vec![0.5]]
        );
    }

    #[test]
    fn write_failure_without_a_cancel_barrier_is_not_reusable() {
        let active = AtomicBool::new(true);
        let backend = FakeTts {
            chunks: vec![vec![0.2]],
            cancel_after_first: false,
        };
        let mut playback = OutboundPlayback::new(&UnquiescedOutput, &active, 10, 1).unwrap();
        let failure = playback
            .synthesize_segment(
                &backend,
                "failure",
                &mut |_| Ok(()),
                &mut || Ok(()),
                &mut |_| Ok(()),
            )
            .unwrap_err();

        assert!(!failure.output_quiescent);
        assert!(failure
            .message
            .contains("did not reach a quiescent terminal"));
    }

    #[test]
    fn delivery_maps_confirmed_frames_across_segments() {
        let active = AtomicBool::new(true);
        let output = FakeOutput::new(0);
        let backend = FakeTts {
            chunks: vec![vec![0.1, 0.2, 0.3]],
            cancel_after_first: false,
        };
        let mut playback = OutboundPlayback::new(&output, &active, 10, 0).unwrap();
        for text in ["one", "two"] {
            playback
                .synthesize_segment(&backend, text, &mut |_| Ok(()), &mut || Ok(()), &mut |_| {
                    Ok(())
                })
                .unwrap();
        }
        output.played.store(4, Ordering::SeqCst);
        let snapshot = playback.snapshot();
        assert_eq!(snapshot.segments[0].played_frames, 3);
        assert_eq!(snapshot.segments[1].played_frames, 1);
        assert!(snapshot
            .segments
            .iter()
            .all(|segment| segment.synthesis_complete));
    }

    #[test]
    fn synthesis_poll_can_release_and_next_pcm_reacquires_host_guard() {
        use std::cell::{Cell, RefCell};

        let active = AtomicBool::new(true);
        let output = FakeOutput::new(0);
        let first = FakeTts {
            chunks: vec![vec![0.1, 0.2]],
            cancel_after_first: false,
        };
        let mut playback = OutboundPlayback::new(&output, &active, 10, 0).unwrap();
        let guard_active = Cell::new(false);
        let lifecycle = RefCell::new(Vec::new());
        playback
            .synthesize_segment(
                &first,
                "first",
                &mut |_| {
                    guard_active.set(true);
                    Ok(())
                },
                &mut || Ok(()),
                &mut |_| Ok(()),
            )
            .unwrap();
        assert!(guard_active.get());

        playback
            .synthesize_segment(
                &PollThenFramesTts,
                "second",
                &mut |_| {
                    if !guard_active.replace(true) {
                        lifecycle.borrow_mut().push("reacquired");
                    }
                    output.drain_after.store(usize::MAX, Ordering::SeqCst);
                    Ok(())
                },
                &mut || Ok(()),
                &mut |_| {
                    if output.is_drained() && guard_active.replace(false) {
                        lifecycle.borrow_mut().push("released");
                    }
                    Ok(())
                },
            )
            .unwrap();

        assert_eq!(&*lifecycle.borrow(), &["released", "reacquired"]);
        assert!(guard_active.get());
    }

    #[test]
    fn cancellation_snapshots_before_stopping_and_is_terminal() {
        let active = AtomicBool::new(true);
        let output = FakeOutput::new(0);
        output.played.store(1, Ordering::SeqCst);
        let backend = FakeTts {
            chunks: vec![vec![0.1, 0.2]],
            cancel_after_first: true,
        };
        let mut playback = OutboundPlayback::new(&output, &active, 10, 0).unwrap();
        assert_eq!(
            playback
                .synthesize_segment(
                    &backend,
                    "cancel",
                    &mut |_| Ok(()),
                    &mut || Ok(()),
                    &mut |_| Ok(()),
                )
                .unwrap(),
            OutboundOutcome::Interrupted
        );
        assert!(output.cancelled.load(Ordering::SeqCst));
        assert_eq!(playback.snapshot().segments[0].played_frames, 1);
        assert!(playback
            .synthesize_segment(
                &backend,
                "again",
                &mut |_| Ok(()),
                &mut || Ok(()),
                &mut |_| Ok(()),
            )
            .is_err());
    }

    #[test]
    fn drain_checks_health_and_has_a_bounded_failure() {
        let active = AtomicBool::new(true);
        let output = FakeOutput::new(usize::MAX);
        let mut playback = OutboundPlayback::new(&output, &active, 10, 0).unwrap();
        let failure = playback
            .finish(
                DrainPolicy {
                    poll_interval: Duration::ZERO,
                    timeout: Some(Duration::ZERO),
                    timeout_outcome: DrainTimeoutOutcome::Fail,
                    post_drain: Duration::ZERO,
                },
                &mut |_| Ok(()),
            )
            .unwrap_err();
        assert!(failure.message.contains("deadline"));
        assert!(output.cancelled.load(Ordering::SeqCst));

        let output = FakeOutput::new(1);
        output.fail_health.store(true, Ordering::SeqCst);
        let mut playback = OutboundPlayback::new(&output, &active, 10, 0).unwrap();
        assert_eq!(
            playback
                .finish(DrainPolicy::default(), &mut |_| Ok(()))
                .unwrap_err()
                .message,
            "fake output failed"
        );
    }

    #[test]
    fn forced_complete_snapshots_before_cancel_and_runs_post_drain() {
        let active = AtomicBool::new(true);
        let output = FakeOutput::new(usize::MAX);
        output.played.store(1, Ordering::SeqCst);
        let backend = FakeTts {
            chunks: vec![vec![0.1, 0.2]],
            cancel_after_first: false,
        };
        let mut playback = OutboundPlayback::new(&output, &active, 10, 0).unwrap();
        playback
            .synthesize_segment(
                &backend,
                "forced",
                &mut |_| Ok(()),
                &mut || Ok(()),
                &mut |_| Ok(()),
            )
            .unwrap();
        let mut post_drain_polls = 0;
        assert_eq!(
            playback
                .finish(
                    DrainPolicy {
                        poll_interval: Duration::ZERO,
                        timeout: Some(Duration::ZERO),
                        timeout_outcome: DrainTimeoutOutcome::Complete,
                        post_drain: Duration::from_millis(10),
                    },
                    &mut |delivery| {
                        post_drain_polls += 1;
                        assert_eq!(delivery.segments[0].played_frames, 1);
                        Ok(())
                    },
                )
                .unwrap(),
            OutboundOutcome::Completed
        );
        assert!(post_drain_polls > 0);
        assert!(output.cancelled.load(Ordering::SeqCst));
        assert_eq!(playback.snapshot().segments[0].played_frames, 1);
    }

    #[test]
    fn cancellation_during_forced_complete_grace_is_interrupted() {
        let active = AtomicBool::new(true);
        let output = FakeOutput::new(usize::MAX);
        output.played.store(1, Ordering::SeqCst);
        let backend = FakeTts {
            chunks: vec![vec![0.1, 0.2]],
            cancel_after_first: false,
        };
        let mut playback = OutboundPlayback::new(&output, &active, 10, 0).unwrap();
        playback
            .synthesize_segment(
                &backend,
                "forced cancel",
                &mut |_| Ok(()),
                &mut || Ok(()),
                &mut |_| Ok(()),
            )
            .unwrap();
        assert_eq!(
            playback
                .finish(
                    DrainPolicy {
                        poll_interval: Duration::ZERO,
                        timeout: Some(Duration::ZERO),
                        timeout_outcome: DrainTimeoutOutcome::Complete,
                        post_drain: Duration::from_secs(1),
                    },
                    &mut |_| {
                        active.store(false, Ordering::SeqCst);
                        Ok(())
                    },
                )
                .unwrap(),
            OutboundOutcome::Interrupted
        );
        assert!(output.cancelled.load(Ordering::SeqCst));
        assert_eq!(playback.snapshot().segments[0].played_frames, 1);
    }

    #[test]
    fn cancellation_during_post_drain_is_interrupted_and_keeps_delivery() {
        let active = AtomicBool::new(true);
        let output = FakeOutput::new(0);
        output.played.store(1, Ordering::SeqCst);
        let backend = FakeTts {
            chunks: vec![vec![0.1, 0.2]],
            cancel_after_first: false,
        };
        let mut playback = OutboundPlayback::new(&output, &active, 10, 0).unwrap();
        playback
            .synthesize_segment(
                &backend,
                "tail",
                &mut |_| Ok(()),
                &mut || Ok(()),
                &mut |_| Ok(()),
            )
            .unwrap();
        let mut polls = 0;
        assert_eq!(
            playback
                .finish(
                    DrainPolicy {
                        poll_interval: Duration::ZERO,
                        post_drain: Duration::from_secs(1),
                        ..DrainPolicy::default()
                    },
                    &mut |_| {
                        polls += 1;
                        active.store(false, Ordering::SeqCst);
                        Ok(())
                    },
                )
                .unwrap(),
            OutboundOutcome::Interrupted
        );
        assert_eq!(polls, 1);
        assert!(output.cancelled.load(Ordering::SeqCst));
        assert_eq!(playback.snapshot().segments[0].played_frames, 1);
    }
}
