//! Deterministic replay of the continuous-recognition activity gate.
//! This predicts gate decisions, never counterfactual audible playback.
use crate::detection::{DetectionSettings, SpeechGate};
use serde::{Deserialize, Serialize};

pub const FRAME_MS: u64 = 16;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Mode {
    Listening,
    Interruption,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Frame {
    /// End of a 16 ms detector frame on the recording timeline.
    /// The first frame may begin before zero because of resampler padding.
    pub end_ms: u64,
    pub epoch: u64,
    pub confidence: f32,
    pub mode: Mode,
    pub settings: DetectionSettings,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Provenance {
    HumanChecked,
    Inferred,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Label {
    pub start_ms: u64,
    pub end_ms: u64,
    pub speech: bool,
    pub provenance: Provenance,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Interval {
    pub start_ms: u64,
    pub end_ms: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ReplayInput {
    pub schema_version: u32,
    pub session_id: String,
    pub held_out: bool,
    pub frames: Vec<Frame>,
    pub labels: Vec<Label>,
    /// Reply-ready until admitted/cancelled, on the same timeline.
    pub reply_waiting: Vec<Interval>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Candidate {
    pub name: String,
    pub settings: DetectionSettings,
}

#[derive(Debug, Serialize)]
pub struct Decision {
    pub end_ms: u64,
    pub epoch: u64,
    pub mode: Mode,
    /// None means a capture gap has left the prior gate state unknown.
    pub active: Option<bool>,
}

#[derive(Debug, Default, Serialize)]
pub struct Latencies {
    pub samples_ms: Vec<u64>,
    pub missed: u64,
    pub excluded: u64,
}

#[derive(Debug, Default, Serialize)]
pub struct Scores {
    pub human_checked_ms: u64,
    pub speech_onset: Latencies,
    pub interruption_detection: Latencies,
    pub speech_fragments: u64,
    pub missed_speech_ms: u64,
    pub false_activity_ms: u64,
    pub silent_reply_held_ms: u64,
    pub inferred_label_ms: u64,
    pub unlabelled_ms: u64,
    pub gap_ms: u64,
    pub uncertain_ms: u64,
}

#[derive(Debug, Serialize)]
pub struct Report {
    pub session_id: String,
    pub held_out: bool,
    pub candidate: String,
    pub scores: Scores,
    pub decisions: Vec<Decision>,
}

fn validate_intervals(intervals: impl Iterator<Item = (u64, u64)>) -> Result<(), String> {
    let mut previous_end = 0;
    for (start, end) in intervals {
        if start >= end || start < previous_end {
            return Err("intervals must be nonempty, ordered and nonoverlapping".into());
        }
        previous_end = end;
    }
    Ok(())
}

impl ReplayInput {
    pub fn validate(&self) -> Result<(), String> {
        if self.schema_version != 1 || self.session_id.trim().is_empty() || self.frames.is_empty() {
            return Err("replay needs schema_version 1, a session_id and frames".into());
        }
        validate_intervals(
            self.labels
                .iter()
                .map(|label| (label.start_ms, label.end_ms)),
        )?;
        validate_intervals(
            self.reply_waiting
                .iter()
                .map(|span| (span.start_ms, span.end_ms)),
        )?;
        let mut previous = None;
        for frame in &self.frames {
            frame.settings.validate()?;
            if !frame.confidence.is_finite() || !(0.0..=1.0).contains(&frame.confidence) {
                return Err("frame confidence must be finite and between 0 and 1".into());
            }
            if previous.is_some_and(|end| frame.end_ms.saturating_sub(end) < FRAME_MS) {
                return Err("detector frames must be ordered and nonoverlapping".into());
            }
            previous = Some(frame.end_ms);
        }
        Ok(())
    }
}

/// Reuse the live gate and its strict confidence comparison.
/// Candidates are static profiles; outcome-based online learning is not simulated.
pub fn replay(input: &ReplayInput, candidate: Option<&Candidate>) -> Result<Report, String> {
    input.validate()?;
    if let Some(candidate) = candidate {
        candidate.settings.validate()?;
        if candidate.name.trim().is_empty() || candidate.settings.is_dynamic() {
            return Err("candidate needs a name and static thresholds".into());
        }
    }
    let mut report = Report {
        session_id: input.session_id.clone(),
        held_out: input.held_out,
        candidate: candidate.map_or("recorded".into(), |value| value.name.clone()),
        scores: Scores::default(),
        decisions: Vec::with_capacity(input.frames.len()),
    };
    let mut gate = SpeechGate::default();
    let mut previous: Option<&Frame> = None;
    let mut uncertain = false;
    let mut consecutive = 0u64;
    let mut last_detected = None;
    let mut label_index = 0;
    let mut waiting_index = 0;
    for frame in &input.frames {
        let settings = candidate.map_or(frame.settings, |value| value.settings);
        let gap = previous.map_or(frame.end_ms.saturating_sub(FRAME_MS), |prior| {
            frame.end_ms - prior.end_ms - FRAME_MS
        });
        if gap > 0 {
            report.scores.gap_ms += gap;
            gate = SpeechGate::default();
            uncertain = true;
            consecutive = 0;
            last_detected = None;
        }
        // Epoch changes correspond to explicit live gate resets.
        if previous.is_some_and(|prior| prior.epoch != frame.epoch) {
            gate = SpeechGate::default();
            uncertain = false;
            consecutive = 0;
            last_detected = None;
        }
        let threshold = match frame.mode {
            Mode::Listening => settings.listening.value,
            Mode::Interruption => settings.interruption.value,
        };
        let detected = frame.confidence > threshold;
        consecutive = if last_detected == Some(detected) {
            consecutive + 1
        } else {
            1
        };
        last_detected = Some(detected);
        // Either a full onset or release run determines state regardless of missing history.
        let settling_ms = if detected {
            settings.timing.onset_ms
        } else {
            settings.timing.release_ms
        };
        if consecutive >= u64::from(settling_ms.div_ceil(16).max(1)) {
            uncertain = false;
        }
        let active = gate.observe(detected, settings.timing);
        let start = frame.end_ms.saturating_sub(FRAME_MS);
        let duration = frame.end_ms - start;
        while label_index < input.labels.len() && input.labels[label_index].end_ms <= start {
            label_index += 1;
        }
        while waiting_index < input.reply_waiting.len()
            && input.reply_waiting[waiting_index].end_ms <= start
        {
            waiting_index += 1;
        }
        if uncertain {
            report.scores.uncertain_ms += duration;
        } else {
            let mut labelled_ms = 0;
            for label in input.labels[label_index..]
                .iter()
                .take_while(|label| label.start_ms < frame.end_ms)
            {
                let end = label.end_ms.min(frame.end_ms);
                let begin = label.start_ms.max(start);
                let duration = end.saturating_sub(begin);
                labelled_ms += duration;
                if label.provenance == Provenance::Inferred {
                    report.scores.inferred_label_ms += duration;
                    continue;
                }
                report.scores.human_checked_ms += duration;
                if label.speech && !active {
                    report.scores.missed_speech_ms += duration;
                }
                if !label.speech && active {
                    report.scores.false_activity_ms += duration;
                    for span in input.reply_waiting[waiting_index..]
                        .iter()
                        .take_while(|span| span.start_ms < end)
                    {
                        report.scores.silent_reply_held_ms += end
                            .min(span.end_ms)
                            .saturating_sub(begin.max(span.start_ms));
                    }
                }
            }
            report.scores.unlabelled_ms += duration - labelled_ms;
        }
        report.decisions.push(Decision {
            end_ms: frame.end_ms,
            epoch: frame.epoch,
            mode: frame.mode,
            active: (!uncertain).then_some(active),
        });
        previous = Some(frame);
    }
    score_utterances(input, &mut report);
    Ok(report)
}

fn score_utterances(input: &ReplayInput, report: &mut Report) {
    for label in input
        .labels
        .iter()
        .filter(|label| label.speech && label.provenance == Provenance::HumanChecked)
    {
        let first = report
            .decisions
            .partition_point(|decision| decision.end_ms <= label.start_ms);
        let end = report
            .decisions
            .partition_point(|decision| decision.end_ms < label.end_ms);
        let end = (end + 1).min(report.decisions.len());
        let decisions = &report.decisions[first..end.max(first)];
        // Full speech annotation must have uninterrupted detector coverage.
        let covered = decisions
            .first()
            .is_some_and(|value| value.end_ms.saturating_sub(FRAME_MS) <= label.start_ms)
            && decisions
                .last()
                .is_some_and(|value| value.end_ms >= label.end_ms)
            && decisions.windows(2).all(|pair| {
                pair[1].end_ms - pair[0].end_ms == FRAME_MS && pair[1].epoch == pair[0].epoch
            })
            && decisions.iter().all(|decision| decision.active.is_some());
        let interruption = decisions
            .first()
            .is_some_and(|value| value.mode == Mode::Interruption);
        if !covered {
            report.scores.speech_onset.excluded += 1;
            if interruption {
                report.scores.interruption_detection.excluded += 1;
            }
            continue;
        }
        let delay = decisions
            .iter()
            .find(|decision| decision.active == Some(true))
            .map(|decision| decision.end_ms.saturating_sub(label.start_ms));
        for latency in std::iter::once(&mut report.scores.speech_onset)
            .chain(interruption.then_some(&mut report.scores.interruption_detection))
        {
            if let Some(delay) = delay {
                latency.samples_ms.push(delay);
            } else {
                latency.missed += 1;
            }
        }
        let runs = u64::from(
            decisions
                .first()
                .is_some_and(|value| value.active == Some(true)),
        ) + decisions
            .windows(2)
            .filter(|pair| pair[0].active == Some(false) && pair[1].active == Some(true))
            .count() as u64;
        report.scores.speech_fragments += runs.saturating_sub(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn input(confidences: &[f32]) -> ReplayInput {
        ReplayInput {
            schema_version: 1,
            session_id: "fixture".into(),
            held_out: true,
            frames: confidences
                .iter()
                .enumerate()
                .map(|(index, confidence)| Frame {
                    end_ms: (index as u64 + 1) * FRAME_MS,
                    epoch: 0,
                    confidence: *confidence,
                    mode: Mode::Listening,
                    settings: DetectionSettings::default(),
                })
                .collect(),
            labels: vec![],
            reply_waiting: vec![],
        }
    }
    #[test]
    fn onset_latency_misses_and_fragmentation_use_complete_annotations() {
        let mut input = input(&[0.0, 0.9, 0.0, 0.9]);
        for frame in &mut input.frames {
            frame.settings.timing.release_ms = 16;
        }
        input.labels = vec![Label {
            start_ms: 0,
            end_ms: 64,
            speech: true,
            provenance: Provenance::HumanChecked,
        }];
        let result = replay(&input, None).unwrap();
        assert_eq!(result.scores.speech_onset.samples_ms, vec![32]);
        assert_eq!(result.scores.speech_fragments, 1);
        input.frames[2].epoch = 1;
        input.frames[3].epoch = 1;
        let result = replay(&input, None).unwrap();
        assert_eq!(result.scores.speech_onset.excluded, 1);
    }

    #[test]
    fn matches_production_gate_and_strict_threshold() {
        let input = input(&[0.5, 0.51, 0.0, 0.0]);
        let result = replay(&input, None).unwrap();
        assert_eq!(
            result
                .decisions
                .iter()
                .map(|value| value.active)
                .collect::<Vec<_>>(),
            vec![Some(false), Some(true), Some(true), Some(true)]
        );
    }
    #[test]
    fn only_human_labels_score_and_only_waiting_time_is_penalized() {
        let mut input = input(&[0.9, 0.0, 0.0]);
        input.labels = vec![
            Label {
                start_ms: 0,
                end_ms: 16,
                speech: true,
                provenance: Provenance::Inferred,
            },
            Label {
                start_ms: 16,
                end_ms: 48,
                speech: false,
                provenance: Provenance::HumanChecked,
            },
        ];
        input.reply_waiting = vec![Interval {
            start_ms: 24,
            end_ms: 40,
        }];
        let report = replay(&input, None).unwrap();
        assert_eq!(report.scores.human_checked_ms, 32);
        assert_eq!(report.scores.inferred_label_ms, 16);
        assert_eq!(report.scores.false_activity_ms, 32);
        assert_eq!(report.scores.silent_reply_held_ms, 16);
    }
    #[test]
    fn gaps_are_unknown_until_state_is_determined() {
        let mut input = input(&[0.9, 0.0, 0.9]);
        input.frames[1].end_ms = 64;
        input.frames[2].end_ms = 80;
        let report = replay(&input, None).unwrap();
        assert_eq!(report.scores.gap_ms, 32);
        assert_eq!(report.decisions[1].active, None);
        assert_eq!(report.decisions[2].active, Some(true));
    }
    #[test]
    fn mode_switch_uses_independent_threshold_and_epoch_resets() {
        let mut input = input(&[0.6, 0.6]);
        input.frames[1].mode = Mode::Interruption;
        input.frames[1].epoch = 1;
        let report = replay(&input, None).unwrap();
        assert_eq!(report.decisions[0].active, Some(true));
        assert_eq!(report.decisions[1].active, Some(false));
    }
    #[test]
    fn candidate_is_static_and_does_not_mutate_recording() {
        let input = input(&[0.6]);
        let mut settings = DetectionSettings::default();
        settings.listening.value = 0.7;
        let candidate = Candidate {
            name: "quiet".into(),
            settings,
        };
        assert_eq!(
            replay(&input, Some(&candidate)).unwrap().decisions[0].active,
            Some(false)
        );
        assert_eq!(
            replay(&input, None).unwrap().decisions[0].active,
            Some(true)
        );
        settings.listening.dynamic = true;
        assert!(replay(
            &input,
            Some(&Candidate {
                name: "invalid".into(),
                settings
            })
        )
        .is_err());
    }
    #[test]
    fn rejects_bad_frames_and_overlapping_labels() {
        let mut input = input(&[0.2, 0.3]);
        input.frames[1].end_ms = 16;
        assert!(replay(&input, None).is_err());
        input.frames[1].end_ms = 32;
        input.frames[0].confidence = f32::NAN;
        assert!(replay(&input, None).is_err());
        input.frames[0].confidence = 0.5;
        input.labels = vec![
            Label {
                start_ms: 0,
                end_ms: 20,
                speech: true,
                provenance: Provenance::HumanChecked,
            },
            Label {
                start_ms: 16,
                end_ms: 32,
                speech: false,
                provenance: Provenance::HumanChecked,
            },
        ];
        assert!(replay(&input, None).is_err());
    }
}
