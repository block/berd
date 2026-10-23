//! Experimental outcome-based tuning of independent local speech thresholds.
use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant};

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Threshold {
    pub value: f32,
    #[serde(default)]
    pub dynamic: bool,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct DetectionSettings {
    pub listening: Threshold,
    pub interruption: Threshold,
    #[serde(default)]
    pub timing: VadTiming,
    /// Maximum idle speech hold while recognition remains pending.
    #[serde(default = "default_pending_utterance_timeout_ms")]
    pub pending_utterance_timeout_ms: u32,
    /// How much longer the hold lasts while Apple still has interim words to finalize.
    #[serde(default = "default_interim_words_wait_ms")]
    pub interim_words_wait_ms: u32,
    #[serde(default)]
    pub dynamic: Dynamic,
}

pub const fn default_pending_utterance_timeout_ms() -> u32 {
    5000
}

pub const fn default_interim_words_wait_ms() -> u32 {
    10000
}

/// Opt-ins to learn each setting besides the thresholds, which carry their own.
#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Dynamic {
    #[serde(default)]
    pub pending_utterance_timeout: bool,
    #[serde(default)]
    pub interim_words_wait: bool,
    #[serde(default)]
    pub release: bool,
}

/// Apple recognition keeps receiving audio while these local activity gates settle.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct VadTiming {
    pub onset_ms: u32,
    pub release_ms: u32,
}

impl Default for VadTiming {
    fn default() -> Self {
        Self {
            onset_ms: 16,
            release_ms: 300,
        }
    }
}

#[derive(Default)]
pub struct SpeechGate {
    active: bool,
    speech_frames: u32,
    silence_frames: u32,
}

impl SpeechGate {
    pub fn observe(&mut self, detected: bool, timing: VadTiming) -> bool {
        if detected {
            self.silence_frames = 0;
            self.speech_frames = self.speech_frames.saturating_add(1);
            if self.speech_frames >= timing.onset_ms.div_ceil(16).max(1) {
                self.active = true;
            }
        } else {
            self.speech_frames = 0;
            self.silence_frames = self.silence_frames.saturating_add(1);
            if self.silence_frames >= timing.release_ms.div_ceil(16).max(1) {
                self.active = false;
            }
        }
        self.active
    }
}

pub fn is_detection_flag(flag: &str) -> bool {
    matches!(
        flag,
        "--pending-utterance-timeout-ms"
            | "--interim-words-wait-ms"
            | "--listening-threshold"
            | "--interruption-threshold"
            | "--dynamic-listening"
            | "--dynamic-interruption"
            | "--dynamic-pending-utterance-timeout"
            | "--dynamic-interim-words-wait"
            | "--dynamic-release"
    )
}

pub fn without_detection_arguments(arguments: &[String]) -> Vec<String> {
    filter_arguments(arguments, false)
}

pub fn detection_arguments(arguments: &[String]) -> Vec<String> {
    filter_arguments(arguments, true)
}

fn filter_arguments(arguments: &[String], detection: bool) -> Vec<String> {
    let mut result = Vec::new();
    let mut index = 0;
    while index < arguments.len() {
        let flag = &arguments[index];
        let count = if flag == "session" || flag == "--allow-direct-agent-speech" {
            1
        } else {
            2
        };
        let end = (index + count).min(arguments.len());
        if is_detection_flag(flag) == detection {
            result.extend_from_slice(&arguments[index..end]);
        }
        index = end;
    }
    result
}

impl Default for DetectionSettings {
    fn default() -> Self {
        Self {
            timing: VadTiming::default(),
            pending_utterance_timeout_ms: default_pending_utterance_timeout_ms(),
            interim_words_wait_ms: default_interim_words_wait_ms(),
            dynamic: Dynamic::default(),
            listening: Threshold {
                value: 0.5,
                dynamic: false,
            },
            interruption: Threshold {
                value: 0.65,
                dynamic: false,
            },
        }
    }
}

impl DetectionSettings {
    pub fn validate(self) -> Result<Self, String> {
        if !(16..=1000).contains(&self.timing.onset_ms)
            || !(16..=3000).contains(&self.timing.release_ms)
        {
            return Err("VAD onset must be 16 to 1000 ms and release 16 to 3000 ms".into());
        }
        if !(250..=30000).contains(&self.pending_utterance_timeout_ms) {
            return Err("pending utterance speech-hold timeout must be 250 to 30000 ms".into());
        }
        if !(250..=60000).contains(&self.interim_words_wait_ms) {
            return Err("interim words wait must be 250 to 60000 ms".into());
        }
        for (dynamic, value, rule, name) in [
            (
                self.dynamic.pending_utterance_timeout,
                self.pending_utterance_timeout_ms,
                PENDING,
                "pending utterance timeout",
            ),
            (
                self.dynamic.interim_words_wait,
                self.interim_words_wait_ms,
                INTERIM,
                "interim words wait",
            ),
            (
                self.dynamic.release,
                self.timing.release_ms,
                RELEASE,
                "VAD release",
            ),
        ] {
            if dynamic && !(rule.min..=rule.max).contains(&value) {
                return Err(format!(
                    "dynamic {name} must start between {} and {} ms",
                    rule.min, rule.max
                ));
            }
        }
        for threshold in [self.listening, self.interruption] {
            if !threshold.value.is_finite() || !(0.0..=1.0).contains(&threshold.value) {
                return Err("speech thresholds must be finite and between 0 and 1".into());
            }
            if threshold.dynamic && !(0.10..=0.95).contains(&threshold.value) {
                return Err("dynamic speech thresholds must start between 0.10 and 0.95".into());
            }
        }
        Ok(self)
    }

    pub fn is_dynamic(self) -> bool {
        self.listening.dynamic || self.interruption.dynamic || self.dynamic != Dynamic::default()
    }

    /// The same values with nothing learning.
    pub fn fixed(mut self) -> Self {
        self.listening.dynamic = false;
        self.interruption.dynamic = false;
        self.dynamic = Dynamic::default();
        self
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
pub struct DetectionSnapshot {
    pub settings: DetectionSettings,
    /// Threshold steps, both modes and both directions.
    pub adjustments: u64,
    pub no_result: u64,
    pub missed_detection: u64,
    #[serde(default)]
    pub pending_utterance_timeout_adjustments: u64,
    #[serde(default)]
    pub interim_words_wait_adjustments: u64,
    #[serde(default)]
    pub release_adjustments: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DetectionMode {
    Listening,
    Interruption,
}

const STEP: f32 = 0.01;
const RESULT_GRACE: Duration = Duration::from_secs(5);
/// Successes since a parameter's last step that step it back. The error rate it
/// settles at is about 1 in `every + 1`, so thresholds, which miss real speech,
/// settle far lower than the waits.
const THRESHOLD_EVERY: u32 = 99;

/// An error steps `step` toward fixing it. Every `every`th success since the last
/// step steps back, so a parameter holds near one error per `every + 1` outcomes.
#[derive(Clone, Copy)]
struct Rule {
    step: u32,
    every: u32,
    min: u32,
    max: u32,
}

const PENDING: Rule = Rule {
    step: 250,
    every: 19,
    min: 2000,
    max: 8000,
};
const INTERIM: Rule = Rule {
    step: 500,
    every: 19,
    min: 2000,
    max: 20000,
};
const RELEASE: Rule = Rule {
    step: 32,
    every: 19,
    min: 160,
    max: 1500,
};

/// Which wait a speech hold was in: the idle timeout, or the extension while Apple
/// still has interim words to finalize.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Wait {
    Timeout,
    Words,
}

pub struct DetectionTuner {
    snapshot: DetectionSnapshot,
    window: Option<Observation>,
    grace_until: Option<Instant>,
    calm: Calm,
    drift: bool,
}

/// Successes since each parameter last stepped.
#[derive(Default)]
struct Calm {
    listening: u32,
    interruption: u32,
    pending: u32,
    interim: u32,
    release: u32,
}

struct Observation {
    mode: DetectionMode,
    began: Instant,
    detected: bool,
    ambiguous: bool,
}

impl DetectionTuner {
    pub fn new(settings: DetectionSettings) -> Self {
        Self {
            snapshot: DetectionSnapshot {
                settings,
                adjustments: 0,
                no_result: 0,
                missed_detection: 0,
                pending_utterance_timeout_adjustments: 0,
                interim_words_wait_adjustments: 0,
                release_adjustments: 0,
            },
            window: None,
            grace_until: None,
            calm: Calm::default(),
            drift: true,
        }
    }
    /// Learns from errors only, never stepping back after successes.
    pub fn without_drift(mut self) -> Self {
        self.drift = false;
        self
    }
    pub fn snapshot(&self) -> DetectionSnapshot {
        self.snapshot
    }
    pub fn observe(&mut self, mode: DetectionMode, detected: bool, now: Instant) {
        if self
            .window
            .as_ref()
            .is_some_and(|window| window.mode != mode && !window.detected)
        {
            self.window = None;
        }
        let window = self.window.get_or_insert(Observation {
            mode,
            began: now,
            detected: false,
            ambiguous: false,
        });
        window.ambiguous |= window.mode != mode;
        window.detected |= detected;
    }
    pub fn final_transcript(&mut self, now: Instant) {
        if let Some(window) = self.window.take().filter(|window| !window.ambiguous) {
            if window.detected {
                self.threshold_success(window.mode);
            } else if now.duration_since(window.began) >= RESULT_GRACE
                && self.grace_until.is_none_or(|until| now >= until)
            {
                self.snapshot.missed_detection += 1;
                self.adjust(window.mode, false);
            }
        }
        self.grace_until = Some(now + RESULT_GRACE);
    }
    pub fn no_result(&mut self, _now: Instant) {
        if self
            .window
            .take()
            .is_some_and(|window| window.detected && !window.ambiguous)
        {
            self.snapshot.no_result += 1;
            // Empty recognition cannot distinguish noise from recognizer failure.
            // Keep the observation diagnostic; it cannot justify missing more speech.
        }
    }
    /// A final with words resolved a hold that was in `wait`. It is `late` when the
    /// hold had already expired, so the wait was too short.
    pub fn hold_final(&mut self, wait: Wait, late: bool) {
        let snapshot = &mut self.snapshot;
        let (dynamic, value, calm, adjustments, rule) = match wait {
            Wait::Timeout => (
                snapshot.settings.dynamic.pending_utterance_timeout,
                &mut snapshot.settings.pending_utterance_timeout_ms,
                &mut self.calm.pending,
                &mut snapshot.pending_utterance_timeout_adjustments,
                PENDING,
            ),
            Wait::Words => (
                snapshot.settings.dynamic.interim_words_wait,
                &mut snapshot.settings.interim_words_wait_ms,
                &mut self.calm.interim,
                &mut snapshot.interim_words_wait_adjustments,
                INTERIM,
            ),
        };
        if dynamic {
            learn(value, calm, adjustments, rule, late, self.drift);
        }
    }
    /// One final spanned several ended turns, a sentence the release split. It is
    /// `jumped` when an agent started speaking in the middle of its words.
    pub fn split_final(&mut self, jumped: bool) {
        let snapshot = &mut self.snapshot;
        if snapshot.settings.dynamic.release {
            learn(
                &mut snapshot.settings.timing.release_ms,
                &mut self.calm.release,
                &mut snapshot.release_adjustments,
                RELEASE,
                jumped,
                self.drift,
            );
        }
    }
    fn threshold_success(&mut self, mode: DetectionMode) {
        let calm = match mode {
            DetectionMode::Listening => &mut self.calm.listening,
            DetectionMode::Interruption => &mut self.calm.interruption,
        };
        if !self.drift {
            return;
        }
        *calm += 1;
        if *calm >= THRESHOLD_EVERY {
            self.adjust(mode, true);
        }
    }
    fn adjust(&mut self, mode: DetectionMode, increase: bool) {
        let (threshold, calm) = match mode {
            DetectionMode::Listening => (
                &mut self.snapshot.settings.listening,
                &mut self.calm.listening,
            ),
            DetectionMode::Interruption => (
                &mut self.snapshot.settings.interruption,
                &mut self.calm.interruption,
            ),
        };
        *calm = 0;
        if !threshold.dynamic {
            return;
        }
        // Round to slider ticks, and never jump a manual value toward a bound.
        let next =
            ((threshold.value + if increase { STEP } else { -STEP }) * 100.0).round() / 100.0;
        if !(0.10..=0.95).contains(&next) {
            return;
        }
        threshold.value = next;
        self.snapshot.adjustments += 1;
    }
    pub fn reset_evidence(&mut self) {
        self.window = None;
        self.grace_until = None;
    }
}

/// Steps an error by `rule.step`, or steps back after `rule.every` successes. A
/// step stays inside the bounds, and a value outside them never moves.
fn learn(
    value: &mut u32,
    calm: &mut u32,
    adjustments: &mut u64,
    rule: Rule,
    error: bool,
    drift: bool,
) {
    if !error {
        if !drift {
            return;
        }
        *calm += 1;
        if *calm < rule.every {
            return;
        }
    }
    *calm = 0;
    if !(rule.min..=rule.max).contains(value) {
        return;
    }
    let next = if error {
        value.saturating_add(rule.step)
    } else {
        value.saturating_sub(rule.step)
    };
    let next = next.clamp(rule.min, rule.max);
    if next != *value {
        *value = next;
        *adjustments += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn gate_requires_consecutive_onset_and_release_frames() {
        let mut gate = SpeechGate::default();
        let timing = VadTiming {
            onset_ms: 32,
            release_ms: 48,
        };
        assert!(!gate.observe(true, timing));
        assert!(!gate.observe(false, timing));
        assert!(!gate.observe(true, timing));
        assert!(gate.observe(true, timing));
        assert!(gate.observe(false, timing));
        assert!(gate.observe(false, timing));
        assert!(!gate.observe(false, timing));
    }

    #[test]
    fn legacy_profiles_get_default_timing_and_invalid_timing_is_rejected() {
        let settings: DetectionSettings =
            serde_json::from_str(r#"{"listening":{"value":0.5},"interruption":{"value":0.65}}"#)
                .unwrap();
        assert_eq!(settings.timing, VadTiming::default());
        assert_eq!(settings.pending_utterance_timeout_ms, 5000);
        assert_eq!(settings.interim_words_wait_ms, 10000);
        assert_eq!(settings.dynamic, Dynamic::default());
        assert!(!settings.is_dynamic());
        for value in [0, 249, 60001, u32::MAX] {
            assert!(DetectionSettings {
                interim_words_wait_ms: value,
                ..settings
            }
            .validate()
            .is_err());
        }
        for value in [0, 249, 30001, u32::MAX] {
            assert!(DetectionSettings {
                pending_utterance_timeout_ms: value,
                ..settings
            }
            .validate()
            .is_err());
        }
        for value in [250, 750, 30000] {
            let custom = DetectionSettings {
                pending_utterance_timeout_ms: value,
                ..settings
            }
            .validate()
            .unwrap();
            assert_eq!(
                serde_json::from_value::<DetectionSettings>(serde_json::to_value(custom).unwrap())
                    .unwrap(),
                custom
            );
        }
        for timing in [
            VadTiming {
                onset_ms: 0,
                release_ms: 300,
            },
            VadTiming {
                onset_ms: 16,
                release_ms: 3001,
            },
        ] {
            assert!(DetectionSettings { timing, ..settings }.validate().is_err());
        }
    }

    fn tuner() -> DetectionTuner {
        DetectionTuner::new(DetectionSettings {
            timing: VadTiming::default(),
            pending_utterance_timeout_ms: 5000,
            interim_words_wait_ms: 10000,
            dynamic: Dynamic::default(),
            listening: Threshold {
                value: 0.5,
                dynamic: true,
            },
            interruption: Threshold {
                value: 0.65,
                dynamic: true,
            },
        })
    }
    #[test]
    fn detection_flags_do_not_consume_flag_shaped_hint_values() {
        let arguments = [
            "session",
            "--stt-hint",
            "--listening-threshold",
            "--language",
            "en-US",
            "--listening-threshold",
            "0.8",
            "--allow-direct-agent-speech",
        ]
        .map(str::to_string);
        assert_eq!(
            detection_arguments(&arguments),
            ["--listening-threshold", "0.8"]
        );
        assert_eq!(
            without_detection_arguments(&arguments),
            [
                "session",
                "--stt-hint",
                "--listening-threshold",
                "--language",
                "en-US",
                "--allow-direct-agent-speech"
            ]
        );
    }

    #[test]
    fn recognizer_failures_cannot_raise_speech_thresholds() {
        let mut tuner = tuner();
        let initial = tuner.snapshot().settings;
        let now = Instant::now();
        for mode in [DetectionMode::Listening, DetectionMode::Interruption] {
            for n in 0..20 {
                let time = now + Duration::from_secs(n * 10);
                tuner.observe(mode, true, time);
                tuner.no_result(time + Duration::from_secs(6));
            }
        }
        assert_eq!(tuner.snapshot().settings, initial);
        assert_eq!(tuner.snapshot().adjustments, 0);
        assert_eq!(tuner.snapshot().no_result, 40);
    }

    #[test]
    fn no_result_counts_without_changing_thresholds() {
        let mut tuner = tuner();
        let now = Instant::now();
        for n in 0..3 {
            let time = now + Duration::from_secs(n * 10);
            tuner.observe(DetectionMode::Listening, true, time);
            tuner.no_result(time + Duration::from_secs(6));
        }
        assert_eq!(tuner.snapshot().settings.listening.value, 0.5);
        assert_eq!(tuner.snapshot().settings.interruption.value, 0.65);
        assert_eq!(tuner.snapshot().adjustments, 0);
        assert_eq!(tuner.snapshot().no_result, 3);
    }
    #[test]
    fn interruption_no_result_is_diagnostic_after_idle_mode_changes() {
        let mut tuner = tuner();
        let now = Instant::now();
        for n in 0..3 {
            let time = now + Duration::from_secs(n * 40);
            tuner.observe(DetectionMode::Listening, false, time);
            tuner.observe(
                DetectionMode::Interruption,
                true,
                time + Duration::from_secs(1),
            );
            tuner.no_result(time + Duration::from_secs(7));
        }
        assert_eq!(tuner.snapshot().settings.interruption.value, 0.65);
        assert_eq!(tuner.snapshot().no_result, 3);
        assert_eq!(tuner.snapshot().settings.listening.value, 0.5);
    }

    #[test]
    fn manual_mode_never_learns() {
        let settings = DetectionSettings::default();
        let mut tuner = DetectionTuner::new(settings);
        let now = Instant::now();
        for n in 0..20 {
            let time = now + Duration::from_secs(n * 40);
            tuner.observe(DetectionMode::Interruption, true, time);
            tuner.no_result(time + Duration::from_secs(6));
        }
        assert_eq!(tuner.snapshot().settings, settings);
    }
    #[test]
    fn transcripts_without_detection_lower_only_the_observed_mode() {
        let mut tuner = tuner();
        let now = Instant::now();
        for n in 0..3 {
            let time = now + Duration::from_secs(n * 40);
            tuner.observe(DetectionMode::Interruption, false, time);
            tuner.final_transcript(time + Duration::from_secs(6));
        }
        assert_eq!(tuner.snapshot().settings.interruption.value, 0.62);
        assert_eq!(tuner.snapshot().settings.listening.value, 0.5);
    }
    #[test]
    fn recognized_missed_speech_adjustments_stay_inside_dynamic_bounds() {
        let mut tuner = tuner();
        tuner.snapshot.settings.listening.value = 0.11;
        let now = Instant::now();
        for n in 0..100 {
            let time = now + Duration::from_secs(n * 20);
            tuner.observe(DetectionMode::Listening, false, time);
            tuner.final_transcript(time + Duration::from_secs(6));
        }
        assert_eq!(tuner.snapshot().settings.listening.value, 0.10);
        assert_eq!(tuner.snapshot().adjustments, 1);
    }

    #[test]
    fn recent_split_finals_and_detected_speech_do_not_lower_thresholds() {
        let mut tuner = tuner();
        let now = Instant::now();
        for n in 0..20 {
            let time = now + Duration::from_secs(n);
            tuner.observe(DetectionMode::Listening, n == 0, time);
            tuner.final_transcript(time);
        }
        assert_eq!(tuner.snapshot().adjustments, 0);
    }

    #[test]
    fn mode_switch_and_reset_discard_ambiguous_evidence() {
        let mut tuner = tuner();
        let now = Instant::now();
        for n in 0..10 {
            let time = now + Duration::from_secs(n * 40);
            tuner.observe(DetectionMode::Listening, true, time);
            tuner.observe(DetectionMode::Interruption, false, time);
            tuner.no_result(time + Duration::from_secs(6));
            tuner.observe(DetectionMode::Listening, true, time);
            tuner.reset_evidence();
            tuner.no_result(time + Duration::from_secs(6));
        }
        assert_eq!(tuner.snapshot().settings, self::tuner().snapshot().settings);
    }

    #[test]
    fn legacy_profile_json_loads_with_every_new_setting_off() {
        let settings: DetectionSettings = serde_json::from_str(
            r#"{"listening":{"value":0.5,"dynamic":true},"interruption":{"value":0.65},"timing":{"onset_ms":16,"release_ms":300},"pending_utterance_timeout_ms":4000}"#,
        )
        .unwrap();
        assert_eq!(settings.interim_words_wait_ms, 10000);
        assert_eq!(settings.dynamic, Dynamic::default());
        assert!(settings.is_dynamic());
        assert!(!settings.fixed().is_dynamic());
        let partial: DetectionSettings = serde_json::from_str(
            r#"{"listening":{"value":0.5},"interruption":{"value":0.65},"dynamic":{"release":true}}"#,
        )
        .unwrap();
        assert!(partial.dynamic.release && !partial.dynamic.interim_words_wait);
        let snapshot: DetectionSnapshot = serde_json::from_str(
            r#"{"settings":{"listening":{"value":0.5},"interruption":{"value":0.65}},"adjustments":1,"no_result":2,"missed_detection":3}"#,
        )
        .unwrap();
        assert_eq!(snapshot.release_adjustments, 0);
    }

    #[test]
    fn dynamic_settings_must_start_inside_their_learning_bounds() {
        let valid = |edit: fn(&mut DetectionSettings)| {
            let mut settings = DetectionSettings::default();
            edit(&mut settings);
            settings.validate().is_ok()
        };
        assert!(valid(|s| s.dynamic.pending_utterance_timeout = true));
        assert!(valid(|s| s.dynamic.interim_words_wait = true));
        assert!(valid(|s| s.dynamic.release = true));
        assert!(!valid(|s| {
            s.dynamic.pending_utterance_timeout = true;
            s.pending_utterance_timeout_ms = 1999;
        }));
        assert!(!valid(|s| {
            s.dynamic.interim_words_wait = true;
            s.interim_words_wait_ms = 20001;
        }));
        assert!(!valid(|s| {
            s.dynamic.release = true;
            s.timing.release_ms = 159;
        }));
        // Manual values keep their wider range.
        assert!(valid(|s| s.timing.release_ms = 100));
    }

    fn learner() -> DetectionTuner {
        let mut tuner = tuner();
        tuner.snapshot.settings.dynamic = Dynamic {
            pending_utterance_timeout: true,
            interim_words_wait: true,
            release: true,
        };
        tuner
    }

    #[test]
    fn late_finals_lengthen_each_wait_and_calm_finals_shorten_it_again() {
        for (wait, initial, step) in [(Wait::Timeout, 5000, 250), (Wait::Words, 10000, 500)] {
            let mut tuner = learner();
            let value = |tuner: &DetectionTuner| match wait {
                Wait::Timeout => tuner.snapshot().settings.pending_utterance_timeout_ms,
                Wait::Words => tuner.snapshot().settings.interim_words_wait_ms,
            };
            tuner.hold_final(wait, true);
            assert_eq!(value(&tuner), initial + step);
            for _ in 0..18 {
                tuner.hold_final(wait, false);
            }
            assert_eq!(value(&tuner), initial + step);
            tuner.hold_final(wait, false);
            assert_eq!(value(&tuner), initial);
            // An error forgets the successes before it.
            for _ in 0..18 {
                tuner.hold_final(wait, false);
            }
            tuner.hold_final(wait, true);
            tuner.hold_final(wait, false);
            assert_eq!(value(&tuner), initial + step);
            let snapshot = tuner.snapshot();
            assert_eq!(
                snapshot.pending_utterance_timeout_adjustments
                    + snapshot.interim_words_wait_adjustments,
                3
            );
            assert_eq!(snapshot.adjustments + snapshot.release_adjustments, 0);
        }
    }

    #[test]
    fn waits_hold_still_at_their_bounds() {
        let mut tuner = learner();
        tuner.snapshot.settings.pending_utterance_timeout_ms = 8000;
        tuner.snapshot.settings.interim_words_wait_ms = 2000;
        tuner.hold_final(Wait::Timeout, true);
        for _ in 0..19 {
            tuner.hold_final(Wait::Words, false);
        }
        let snapshot = tuner.snapshot();
        assert_eq!(snapshot.settings.pending_utterance_timeout_ms, 8000);
        assert_eq!(snapshot.settings.interim_words_wait_ms, 2000);
        assert_eq!(snapshot.pending_utterance_timeout_adjustments, 0);
        assert_eq!(snapshot.interim_words_wait_adjustments, 0);
        // A step that would overshoot lands on the bound.
        tuner.snapshot.settings.pending_utterance_timeout_ms = 7900;
        tuner.hold_final(Wait::Timeout, true);
        assert_eq!(tuner.snapshot().settings.pending_utterance_timeout_ms, 8000);
        // A manual value outside the bounds never jumps toward them.
        tuner.snapshot.settings.pending_utterance_timeout_ms = 500;
        tuner.hold_final(Wait::Timeout, true);
        assert_eq!(tuner.snapshot().settings.pending_utterance_timeout_ms, 500);
    }

    #[test]
    fn split_finals_that_an_agent_jumped_into_lengthen_release() {
        let mut tuner = learner();
        tuner.split_final(true);
        assert_eq!(tuner.snapshot().settings.timing.release_ms, 332);
        for _ in 0..19 {
            tuner.split_final(false);
        }
        assert_eq!(tuner.snapshot().settings.timing.release_ms, 300);
        assert_eq!(tuner.snapshot().release_adjustments, 2);
        tuner.snapshot.settings.timing.release_ms = 1484;
        tuner.split_final(true);
        assert_eq!(tuner.snapshot().settings.timing.release_ms, 1500);
        tuner.snapshot.settings.timing.release_ms = 172;
        for _ in 0..19 {
            tuner.split_final(false);
        }
        assert_eq!(tuner.snapshot().settings.timing.release_ms, 160);
        // Onset never learns.
        assert_eq!(tuner.snapshot().settings.timing.onset_ms, 16);
    }

    #[test]
    fn disabled_waits_and_release_never_change() {
        let mut tuner = tuner();
        let initial = tuner.snapshot();
        for _ in 0..40 {
            tuner.hold_final(Wait::Timeout, true);
            tuner.hold_final(Wait::Words, true);
            tuner.split_final(true);
            tuner.hold_final(Wait::Timeout, false);
            tuner.hold_final(Wait::Words, false);
            tuner.split_final(false);
        }
        assert_eq!(tuner.snapshot(), initial);
    }

    #[test]
    fn without_drift_only_errors_move_a_parameter() {
        let mut tuner = learner().without_drift();
        tuner.hold_final(Wait::Timeout, true);
        tuner.split_final(true);
        for _ in 0..100 {
            tuner.hold_final(Wait::Timeout, false);
            tuner.split_final(false);
        }
        let settings = tuner.snapshot().settings;
        assert_eq!(settings.pending_utterance_timeout_ms, 5250);
        assert_eq!(settings.timing.release_ms, 332);
        let now = Instant::now();
        for n in 0..200 {
            let time = now + Duration::from_secs(n);
            tuner.observe(DetectionMode::Listening, true, time);
            tuner.final_transcript(time);
        }
        assert_eq!(tuner.snapshot().settings.listening.value, 0.5);
    }

    #[test]
    fn detected_finals_raise_a_threshold_back_after_a_hundred_calm_ones() {
        let mut tuner = tuner();
        let now = Instant::now();
        let win = |tuner: &mut DetectionTuner, mode, detected, n: u64| {
            let time = now + Duration::from_secs(n * 20);
            tuner.observe(mode, detected, time);
            tuner.final_transcript(time + Duration::from_secs(6));
        };
        win(&mut tuner, DetectionMode::Interruption, false, 0);
        assert_eq!(tuner.snapshot().settings.interruption.value, 0.64);
        for n in 1..=98 {
            win(&mut tuner, DetectionMode::Interruption, true, n);
        }
        assert_eq!(tuner.snapshot().settings.interruption.value, 0.64);
        win(&mut tuner, DetectionMode::Interruption, true, 99);
        assert_eq!(tuner.snapshot().settings.interruption.value, 0.65);
        assert_eq!(tuner.snapshot().adjustments, 2);
        // Modes count separately.
        for n in 100..198 {
            win(&mut tuner, DetectionMode::Listening, true, n);
        }
        assert_eq!(tuner.snapshot().settings.listening.value, 0.5);
        assert_eq!(tuner.snapshot().settings.interruption.value, 0.65);
        for n in 200..299 {
            win(&mut tuner, DetectionMode::Interruption, true, n);
        }
        assert_eq!(tuner.snapshot().settings.interruption.value, 0.66);
    }

    #[test]
    fn threshold_drift_respects_the_upper_bound_and_manual_mode() {
        let mut tuner = tuner();
        tuner.snapshot.settings.listening.value = 0.95;
        let mut manual = DetectionTuner::new(DetectionSettings::default());
        let now = Instant::now();
        for n in 0..300 {
            let time = now + Duration::from_secs(n * 20);
            for tuner in [&mut tuner, &mut manual] {
                tuner.observe(DetectionMode::Listening, true, time);
                tuner.final_transcript(time);
            }
        }
        assert_eq!(tuner.snapshot().settings.listening.value, 0.95);
        assert_eq!(tuner.snapshot().adjustments, 0);
        assert_eq!(manual.snapshot().settings, DetectionSettings::default());
    }
}
