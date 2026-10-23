//! Cut call captures into short replay fixtures around likely detection failures.
//! Findings are review hints, never labels: source labels keep their provenance,
//! and a clip never spans a capture gap or starts from a gate state it cannot reproduce.
use crate::capture_replay::{convert, Annotations, SampleLabel};
use crate::vad_replay::ReplayInput;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::ops::Range;

const FRAME_SAMPLES: u64 = 768;
const MIC_FRAME_SAMPLES: u64 = 960;
/// The capture writer's record queue bound (capture.rs QUEUE_RECORDS).
const CAPTURE_QUEUE_RECORDS: u64 = 1024;

#[derive(Clone, Copy, Debug)]
pub struct ExtractPolicy {
    /// Audio kept on each side of a finding.
    pub context_ms: u64,
    /// A release followed by an onset within this is a fragment.
    pub fragment_ms: u64,
    /// A prepare_speak request outstanding at least this long is held.
    pub reply_held_ms: u64,
    pub quiet_probability: f32,
    pub quiet_ms: u32,
}

impl Default for ExtractPolicy {
    fn default() -> Self {
        Self {
            context_ms: 3000,
            fragment_ms: 1000,
            reply_held_ms: 1000,
            quiet_probability: 0.1,
            quiet_ms: 1000,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    /// The recorded gate released and became active again within fragment_ms.
    Fragment,
    /// The recorded gate became active while the agent was speaking.
    Interruption,
    /// A reply waited at least reply_held_ms. Located by the capture's frame count
    /// when each message was processed, so its audio position is approximate.
    ReplyHeld,
    /// Human-checked speech without recorded activity.
    MissedSpeech,
    /// Recorded activity during human-checked silence.
    FalseActivity,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Finding {
    pub kind: Kind,
    pub source_start_sample: u64,
    pub source_end_sample: u64,
}

/// Why a fresh replay gate equals the live gate at the clip's first frame.
#[derive(Clone, Copy, Debug, PartialEq, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Start {
    CaptureStart,
    /// A recognizer generation or mute epoch boundary, given the recorded reset schedule.
    GateReset,
    /// Exact only for settings whose thresholds are at least max_probability and
    /// whose release_ms is at most ms.
    Quiet {
        max_probability: f32,
        ms: u32,
    },
}

/// The stable default-device identities that key detection profiles.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct AudioDevices {
    pub input_uid: String,
    pub output_uid: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SetupBasis {
    /// Read when the session started. Routes can change during a call, so this
    /// does not establish the devices behind any particular clip.
    SessionStart,
    /// Recorded by the host around the clip. The input is exact: the clip lies within
    /// one microphone stream, opened on this device before its first frame. The output
    /// is only observed: the default output and its change count agree at observations
    /// before and after the clip, with no capture loss between. Change notifications
    /// have no established delivery bound, and playback follows the system default,
    /// so this does not establish the device that played any agent audio in the clip.
    ObservedRoute,
}

/// Route records from a capture whose host sent them, as source samples.
#[derive(Default)]
struct Routes {
    /// Microphone streams: from their opening record to the next reset or loss.
    inputs: Vec<(u64, u64, String)>,
    outputs: Vec<(u64, Option<String>, u64)>,
    /// Sample spans in which capture records may have been lost.
    losses: Vec<(u64, u64)>,
}

impl Routes {
    fn close_input(&mut self, at: u64) {
        if let Some(input) = self.inputs.last_mut().filter(|input| input.1 == u64::MAX) {
            input.1 = at;
        }
    }

    fn setup(&self, offset: u64, end: u64) -> Option<AudioSetup> {
        let (opened, _, input_uid) = self
            .inputs
            .iter()
            .find(|(from, to, _)| *from <= offset && end <= *to)?;
        let before = self.outputs.partition_point(|output| output.0 <= offset);
        let after = self.outputs.partition_point(|output| output.0 < end);
        let bracket = self.outputs.get(before.checked_sub(1)?..=after)?;
        let (from, Some(output_uid), changes) = &bracket[0] else {
            return None;
        };
        // A loss after the stream opened could hide its reset, and one within the bracket an output change.
        let (from, to) = ((*opened).min(*from), bracket[bracket.len() - 1].0.max(end));
        if bracket
            .iter()
            .any(|output| (&output.1, output.2) != (&bracket[0].1, *changes))
            || self
                .losses
                .iter()
                .any(|loss| loss.0 <= to && from <= loss.1)
        {
            return None;
        }
        Some(AudioSetup {
            devices: AudioDevices {
                input_uid: input_uid.clone(),
                output_uid: output_uid.clone(),
            },
            basis: SetupBasis::ObservedRoute,
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct AudioSetup {
    pub devices: AudioDevices,
    pub basis: SetupBasis,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Provenance {
    /// Stable across recuts and later labelling of the same capture.
    pub source_session: String,
    pub held_out: bool,
    /// Absent when the session could not read both default device UIDs, including
    /// captures that predate recording them.
    pub audio_setup: Option<AudioSetup>,
    /// The source mic.wav sample at clip sample 0 and clip time 0; a multiple of 48.
    pub source_sample_offset: u64,
    pub source_sample_end: u64,
    pub source_start_us: u64,
    pub source_end_us: u64,
    pub start: Start,
    /// Some finding has less than the policy's context on a side.
    pub context_truncated: bool,
}

#[derive(Debug, Serialize)]
pub struct Fixture {
    pub schema: &'static str,
    pub provenance: Provenance,
    pub findings: Vec<Finding>,
    /// Clip-relative times; written beside fixture.json as input.json.
    #[serde(skip)]
    pub input: ReplayInput,
    /// Source vad.jsonl lines: referenced earlier settings, then the clip's rows.
    #[serde(skip)]
    pub vad_lines: Vec<usize>,
    #[serde(skip)]
    pub event_lines: Range<usize>,
}

#[derive(Debug, Serialize)]
pub struct Excluded {
    pub source_start_sample: u64,
    pub source_end_sample: u64,
    pub finding: Option<Kind>,
    pub reason: String,
}

#[derive(Debug, Serialize)]
pub struct Extraction {
    pub source_session: String,
    pub fixtures: Vec<Fixture>,
    pub excluded: Vec<Excluded>,
}

struct Row {
    line: usize,
    start: u64,
    end: u64,
    us: u64,
    frame: u64,
    reset: (u64, u64),
    probability: f32,
    detected: bool,
    active: bool,
    interruption: bool,
    revision: u64,
}

fn number(row: &Value, key: &str) -> Result<u64, String> {
    row[key]
        .as_u64()
        .ok_or_else(|| format!("capture record needs integer {key}"))
}

pub fn extract(
    manifest: &Value,
    rows: &[Value],
    events: &[Value],
    audio_samples: u64,
    held_out: bool,
    labels: &[SampleLabel],
    policy: &ExtractPolicy,
) -> Result<Extraction, String> {
    if policy.quiet_ms < 16 || !(0.0..=1.0).contains(&policy.quiet_probability) {
        return Err("quiet starts need at least 16 ms below a probability in 0..=1".into());
    }
    let source = format!(
        "capture-{}",
        manifest["started_unix_ms"]
            .as_u64()
            .ok_or("capture manifest needs started_unix_ms")?
    );
    let setup = &manifest["session"]["audio_setup"];
    let audio_setup = match (setup["input_uid"].as_str(), setup["output_uid"].as_str()) {
        (Some(input), Some(output)) if !input.is_empty() && !output.is_empty() => {
            Some(AudioSetup {
                devices: AudioDevices {
                    input_uid: input.into(),
                    output_uid: output.into(),
                },
                basis: SetupBasis::SessionStart,
            })
        }
        _ => None,
    };
    let mut settings = HashMap::new();
    let mut frames = Vec::new();
    for (line, row) in rows.iter().enumerate() {
        if row["type"] == "settings" {
            if settings.insert(number(row, "revision")?, line).is_some() {
                return Err("duplicate settings revision".into());
            }
            continue;
        }
        let end = number(row, "mic_sample")?;
        frames.push(Row {
            line,
            start: end.saturating_sub(FRAME_SAMPLES),
            end,
            us: number(row, "us")?,
            frame: number(row, "vad_frame")?,
            reset: (number(row, "epoch")?, number(row, "generation")?),
            probability: row["probability"].as_f64().ok_or("missing probability")? as f32,
            detected: row["detected"].as_bool().ok_or("missing detected")?,
            active: row["active"].as_bool().ok_or("missing active")?,
            interruption: row["mode"] == "interruption",
            revision: number(row, "settings_revision")?,
        });
    }

    // Sample intervals no clip may touch; a pause is a zero-width cut.
    let mut cuts = Vec::new();
    if frames.last().is_some_and(|row| row.end > audio_samples) {
        cuts.push((audio_samples, u64::MAX, "trace beyond mic.wav".to_string()));
    }
    let mut samples = Vec::with_capacity(events.len());
    let mut routes = Routes::default();
    let mut routed = false;
    let loss = |routes: &mut Routes, span: (u64, u64)| {
        routes.close_input(span.0);
        routes.losses.push(span);
    };
    for event in events {
        let at = number(event, "frame")? * MIC_FRAME_SAMPLES;
        if samples.last().is_some_and(|&last| at < last) {
            return Err("capture events must be ordered by frame".into());
        }
        let message = &event["message"];
        match (event["type"].as_str(), message["type"].as_str()) {
            (Some("limit"), _) => {
                cuts.push((at, u64::MAX, "capture limit".into()));
                loss(&mut routes, (at, u64::MAX));
            }
            (Some("gap"), _) => {
                let reason = event["reason"].as_str().unwrap_or("unknown");
                let (from, to) = match (reason, event["from_frame"].as_u64()) {
                    ("input_paused", _) => (at, at),
                    (_, Some(from)) => (from * MIC_FRAME_SAMPLES, at),
                    // Records were dropped behind a full queue, so the loss follows this
                    // marker by at most a queue of records, each advancing at most one mic frame.
                    _ => (at, at + (CAPTURE_QUEUE_RECORDS + 1) * MIC_FRAME_SAMPLES),
                };
                if reason != "input_paused" {
                    loss(&mut routes, (from, to));
                }
                cuts.push((from, to, format!("capture gap: {reason}")));
            }
            (Some("in"), Some("reset_input")) => routes.close_input(at),
            (Some("in"), Some("audio_route")) => {
                routed = true;
                let observation = &message["observation"];
                match observation["kind"].as_str() {
                    Some("input_opened") => {
                        let uid = observation["input_uid"]
                            .as_str()
                            .filter(|uid| !uid.is_empty())
                            .ok_or("input_opened route needs an input_uid")?;
                        routes.close_input(at);
                        routes.inputs.push((at, u64::MAX, uid.into()));
                    }
                    Some("output") => routes.outputs.push((
                        at,
                        observation["output_uid"]
                            .as_str()
                            .filter(|uid| !uid.is_empty())
                            .map(Into::into),
                        number(observation, "changes")?,
                    )),
                    _ => return Err("unknown audio route observation".into()),
                }
            }
            _ => {}
        }
        samples.push(at);
    }
    let mut excluded: Vec<Excluded> = cuts
        .iter()
        .map(|(from, to, reason)| Excluded {
            source_start_sample: *from,
            source_end_sample: *to,
            finding: None,
            reason: reason.clone(),
        })
        .collect();

    let mut segments: Vec<Range<usize>> = Vec::new();
    for (index, row) in frames.iter().enumerate() {
        let prior = index.checked_sub(1).map(|prior| &frames[prior]);
        if prior
            .is_some_and(|prior| row.frame <= prior.frame || row.end < prior.end + FRAME_SAMPLES)
        {
            return Err("VAD frames must be ordered and nonoverlapping".into());
        }
        if cuts
            .iter()
            .any(|(from, to, _)| *from < row.end && row.start < *to)
        {
            continue;
        }
        match (segments.last_mut(), prior) {
            (Some(segment), Some(prior))
                if segment.end == index
                    && row.frame == prior.frame + 1
                    && !cuts
                        .iter()
                        .any(|(from, to, _)| *from <= row.start && prior.end <= *to) =>
            {
                segment.end += 1
            }
            _ => segments.push(index..index + 1),
        }
    }

    let quiet = policy.quiet_ms.div_ceil(16) as usize;
    let start_at = |k: usize, segment: &Range<usize>| {
        if k == 0 && frames[0].frame == 0 {
            Some(Start::CaptureStart)
        } else if k > segment.start && frames[k].reset != frames[k - 1].reset {
            Some(Start::GateReset)
        } else {
            (k >= segment.start + quiet
                && !frames[k - 1].active
                && frames[k - quiet..k]
                    .iter()
                    .all(|row| !row.detected && row.probability <= policy.quiet_probability))
            .then_some(Start::Quiet {
                max_probability: policy.quiet_probability,
                ms: policy.quiet_ms,
            })
        }
    };

    let mut findings = Vec::new();
    let mut found = |kind, source_start_sample, source_end_sample| {
        findings.push(Finding {
            kind,
            source_start_sample,
            source_end_sample,
        })
    };
    for segment in &segments {
        let mut release = None;
        for index in segment.start + 1..segment.end {
            let (prior, row) = (&frames[index - 1], &frames[index]);
            if row.reset != prior.reset {
                release = None;
            } else if prior.active && !row.active {
                release = Some(index);
            } else if !prior.active && row.active {
                if let Some(released) =
                    release.filter(|released| (index - released) as u64 * 16 <= policy.fragment_ms)
                {
                    found(Kind::Fragment, frames[released].start, row.end);
                }
                if row.interruption {
                    found(Kind::Interruption, row.start, row.end);
                }
            }
        }
    }
    for label in labels
        .iter()
        .filter(|label| label.provenance == crate::vad_replay::Provenance::HumanChecked)
    {
        for segment in &segments {
            let rows = &frames[segment.clone()];
            let overlapping = &rows[rows.partition_point(|row| row.end <= label.start_sample)
                ..rows.partition_point(|row| row.start < label.end_sample)];
            if label.speech {
                // Only audio the detector saw throughout; resets can skip buffered audio.
                let covered = overlapping
                    .first()
                    .is_some_and(|row| row.start <= label.start_sample)
                    && overlapping
                        .last()
                        .is_some_and(|row| row.end >= label.end_sample)
                    && overlapping
                        .windows(2)
                        .all(|pair| pair[1].start <= pair[0].end);
                if covered && !overlapping.iter().any(|row| row.active) {
                    found(Kind::MissedSpeech, label.start_sample, label.end_sample);
                }
            } else {
                let mut active = overlapping.iter().filter(|row| row.active);
                if let Some(first) = active.next() {
                    let last = active.next_back().unwrap_or(first);
                    found(Kind::FalseActivity, first.start, last.end);
                }
            }
        }
    }
    let mut pending = HashMap::new();
    for (event, &at) in events.iter().zip(&samples) {
        let message = &event["message"];
        match (event["type"].as_str(), message["type"].as_str()) {
            (Some("gap" | "limit"), _) => pending.clear(),
            (Some("in"), Some("prepare_speak")) => {
                if let Some(id) = message["id"].as_u64() {
                    pending.insert(id, (number(event, "us")?, at));
                }
            }
            (Some("out"), Some("admitted" | "not_admitted" | "pending")) => {
                if let Some((us, from)) = message["id"].as_u64().and_then(|id| pending.remove(&id))
                {
                    if number(event, "us")?.saturating_sub(us) >= policy.reply_held_ms * 1000 {
                        found(Kind::ReplyHeld, from, at);
                    }
                }
            }
            _ => {}
        }
    }
    findings.sort_by_key(|finding| (finding.source_start_sample, finding.source_end_sample));

    struct Clip {
        segment: usize,
        first: usize,
        last: usize,
        start: Start,
        findings: Vec<Finding>,
    }
    let context = policy.context_ms * 48;
    let mut clips: Vec<Clip> = Vec::new();
    for finding in findings {
        let (from, to) = (finding.source_start_sample, finding.source_end_sample);
        let mut exclude = |reason: &str| {
            excluded.push(Excluded {
                source_start_sample: from,
                source_end_sample: to,
                finding: Some(finding.kind),
                reason: reason.into(),
            })
        };
        let Some(index) = segments.iter().position(|segment| {
            frames[segment.start].start <= from && to <= frames[segment.end - 1].end
        }) else {
            exclude("finding is not within one gap-free run of detector frames");
            continue;
        };
        let segment = &segments[index];
        let rows = &frames[segment.clone()];
        let after = |sample: u64| {
            (segment.start + rows.partition_point(|row| row.end <= sample)).min(segment.end - 1)
        };
        let at = after(from);
        let wanted = after(from.saturating_sub(context)).min(at);
        let earliest = after(from.saturating_sub(2 * context)).min(wanted);
        let Some((first, start)) = (earliest..=wanted)
            .rev()
            .chain(wanted + 1..=at)
            .find_map(|k| start_at(k, segment).map(|start| (k, start)))
        else {
            exclude("no reproducible gate state before the finding");
            continue;
        };
        let last = (segment.start + rows.partition_point(|row| row.end < to + context))
            .min(segment.end - 1);
        clips.push(Clip {
            segment: index,
            first,
            last,
            start,
            findings: vec![finding],
        });
    }
    clips.sort_by_key(|clip| (clip.segment, clip.first));
    let mut merged: Vec<Clip> = Vec::new();
    for clip in clips {
        match merged.last_mut() {
            Some(prior) if prior.segment == clip.segment && clip.first <= prior.last + 1 => {
                prior.last = prior.last.max(clip.last);
                prior.findings.extend(clip.findings);
            }
            _ => merged.push(clip),
        }
    }

    let mut fixtures = Vec::new();
    for clip in merged {
        let (head, tail) = (&frames[clip.first], &frames[clip.last]);
        let offset = head.start / 48 * 48;
        let end = tail.end;
        let session_id = format!("{source}@{offset}-{end}");
        let mut vad_lines: Vec<usize> = frames[clip.first..=clip.last]
            .iter()
            .filter_map(|row| settings.get(&row.revision).copied())
            .filter(|&line| line < head.line)
            .collect();
        vad_lines.sort_unstable();
        vad_lines.dedup();
        vad_lines.extend(head.line..=tail.line);
        let sliced: Vec<Value> = vad_lines
            .iter()
            .map(|&line| {
                let mut row = rows[line].clone();
                if let Some(sample) = row["mic_sample"].as_u64() {
                    row["mic_sample"] = (sample - offset).into();
                }
                row
            })
            .collect();
        let event_lines = samples.partition_point(|&at| at <= head.start)
            ..samples.partition_point(|&at| at < end);
        let clip_end = end / 48 * 48;
        let mut clipped = Vec::new();
        for label in labels
            .iter()
            .filter(|label| label.start_sample < clip_end && offset < label.end_sample)
        {
            // Truncating speech at its onset would score a false onset latency.
            if label.speech && label.start_sample < offset {
                excluded.push(Excluded {
                    source_start_sample: label.start_sample,
                    source_end_sample: label.end_sample,
                    finding: None,
                    reason: format!("speech label starts before clip {session_id}"),
                });
                continue;
            }
            clipped.push(SampleLabel {
                start_sample: label.start_sample.max(offset) - offset,
                end_sample: label.end_sample.min(clip_end) - offset,
                speech: label.speech,
                provenance: label.provenance,
            });
        }
        let annotations = Annotations {
            schema_version: 1,
            session_id: session_id.clone(),
            held_out,
            labels: clipped,
        };
        // A capture with route records establishes each clip's setup from them alone.
        let clip_setup = if routed {
            routes.setup(offset, end)
        } else {
            audio_setup.clone()
        };
        let converted = if routed && clip_setup.is_none() {
            Err("audio route is not established across the clip".into())
        } else if event_lines.is_empty() {
            Err("clip contains no capture events".into())
        } else {
            convert(manifest, &sliced, &events[event_lines.clone()], annotations)
        };
        match converted {
            Ok(input) => fixtures.push(Fixture {
                schema: "berd-call-fixture/1",
                provenance: Provenance {
                    source_session: source.clone(),
                    held_out,
                    audio_setup: clip_setup,
                    source_sample_offset: offset,
                    source_sample_end: end,
                    source_start_us: head.us,
                    source_end_us: tail.us,
                    start: clip.start,
                    context_truncated: clip.findings.iter().any(|finding| {
                        finding.source_start_sample.saturating_sub(head.start) < context
                            || end.saturating_sub(finding.source_end_sample) < context
                    }),
                },
                findings: clip.findings,
                input,
                vad_lines,
                event_lines,
            }),
            Err(error) => excluded.push(Excluded {
                source_start_sample: offset,
                source_end_sample: end,
                finding: None,
                reason: format!("clip does not replay: {error}"),
            }),
        }
    }
    Ok(Extraction {
        source_session: source,
        fixtures,
        excluded,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::detection::{DetectionSettings, SpeechGate, Threshold, VadTiming};
    use crate::protocol::{RouteObservation, SessionRequest};
    use crate::vad_replay::{replay, Candidate, Provenance as Label};
    use serde_json::json;

    const BASE: u64 = 100;

    fn settings(threshold: f32, onset_ms: u32, release_ms: u32) -> DetectionSettings {
        let threshold = Threshold {
            value: threshold,
            dynamic: false,
        };
        DetectionSettings {
            pending_utterance_timeout_ms: 5000,
            interim_words_wait_ms: 10000,
            dynamic: Default::default(),
            listening: threshold,
            interruption: threshold,
            timing: VadTiming {
                onset_ms,
                release_ms,
            },
        }
    }

    fn policy() -> ExtractPolicy {
        ExtractPolicy {
            context_ms: 80,
            fragment_ms: 160,
            reply_held_ms: 1000,
            quiet_probability: 0.1,
            quiet_ms: 48,
        }
    }

    /// Rows for (probability, epoch, generation), recording the live gate's decisions.
    fn trace(frames: &[(f32, u64, u64)]) -> (Vec<Value>, Vec<Value>) {
        let recorded = settings(0.5, 16, 48);
        let mut rows = vec![json!({"us":0,"type":"settings","revision":0,"settings":recorded})];
        let mut gate = SpeechGate::default();
        for (index, &(probability, epoch, generation)) in frames.iter().enumerate() {
            if index > 0 && (epoch, generation) != (frames[index - 1].1, frames[index - 1].2) {
                gate = SpeechGate::default();
            }
            let detected = probability > 0.5;
            rows.push(json!({"us":index as u64 * 16000 + 1,"mic_sample":BASE + 768 * (index as u64 + 1),"vad_frame":index,"epoch":epoch,"generation":generation,"mode":"listening","probability":probability,"threshold":0.5,"detected":detected,"active":gate.observe(detected, recorded.timing),"settings_revision":0}));
        }
        let end = BASE + 768 * frames.len() as u64;
        let events = (0..=end / 960)
            .step_by(4)
            .map(|frame| json!({"us":frame * 20000,"frame":frame,"type":"clock"}))
            .collect();
        (rows, events)
    }

    fn manifest() -> Value {
        json!({"schema":"berd-call-capture/1","started_unix_ms":7,"mic":{"sample_rate":48000},"session":{"stt_backend":"macos","continuous_recognition":true}})
    }

    fn run(
        rows: &[Value],
        events: &[Value],
        labels: &[SampleLabel],
        policy: ExtractPolicy,
    ) -> Extraction {
        extract(&manifest(), rows, events, u64::MAX, true, labels, &policy).unwrap()
    }

    /// Release then re-onset inside a 16-frame burst: 3 speech, 4 low, 3 speech.
    fn fragment(epoch: u64, generation: u64) -> Vec<(f32, u64, u64)> {
        [0.9; 3]
            .into_iter()
            .chain([0.3; 4])
            .chain([0.9; 3])
            .chain([0.3; 6])
            .map(|probability| (probability, epoch, generation))
            .collect()
    }

    /// Whether clip decisions under `settings` equal the full capture's for the same frames.
    fn exact(
        rows: &[Value],
        events: &[Value],
        fixture: &Fixture,
        settings: DetectionSettings,
    ) -> bool {
        let candidate = Candidate {
            name: "candidate".into(),
            settings,
        };
        let annotations = |session_id: &str| Annotations {
            schema_version: 1,
            session_id: session_id.into(),
            held_out: true,
            labels: vec![],
        };
        let full = convert(&manifest(), rows, events, annotations("full")).unwrap();
        let full = replay(&full, Some(&candidate)).unwrap().decisions;
        let clip = replay(&fixture.input, Some(&candidate)).unwrap().decisions;
        let offset = fixture.provenance.source_sample_offset / 48;
        let first = full
            .iter()
            .position(|decision| decision.end_ms == clip[0].end_ms + offset)
            .unwrap();
        assert_eq!(clip[0].end_ms, 16);
        clip.iter().zip(&full[first..]).all(|(clip, full)| {
            assert_eq!(clip.end_ms + offset, full.end_ms);
            clip.active == full.active
        })
    }

    #[test]
    fn quiet_start_is_exact_at_its_probability_and_release_bounds() {
        // Gate activity before the quiet run, so a wrong starting state would show.
        let mut frames: Vec<_> = (0..30).map(|index| ([0.9, 0.3][index % 2], 0, 1)).collect();
        frames.extend([(0.1, 0, 1); 3]);
        frames.extend(fragment(0, 1));
        let (rows, events) = trace(&frames);
        let extraction = run(&rows, &events, &[], policy());
        let [fixture] = &extraction.fixtures[..] else {
            panic!("{:?}", extraction.excluded)
        };
        assert_eq!(
            fixture.provenance.start,
            Start::Quiet {
                max_probability: 0.1,
                ms: 48
            }
        );
        assert_eq!(fixture.findings[0].kind, Kind::Fragment);
        assert_eq!(
            fixture.provenance.source_sample_offset,
            (BASE + 768 * 33) / 48 * 48
        );
        assert!(!fixture.provenance.context_truncated);
        // A slower onset exposes any difference in the starting gate state.
        assert!(exact(&rows, &events, fixture, settings(0.1, 48, 48)));
        assert!(!exact(&rows, &events, fixture, settings(0.09, 48, 48)));

        // Just above the probability bound, or one frame short, is not quiet.
        for (probability, length) in [(0.11, 3), (0.1, 2)] {
            let mut frames: Vec<_> = (0..30).map(|index| ([0.9, 0.3][index % 2], 0, 1)).collect();
            frames.extend([(0.3, 0, 1); 3]);
            frames.splice(33 - length..33, vec![(probability, 0, 1); length]);
            frames.extend(fragment(0, 1));
            let (rows, events) = trace(&frames);
            let extraction = run(&rows, &events, &[], policy());
            assert!(extraction.fixtures.is_empty(), "{probability} for {length}");
            assert!(
                extraction
                    .excluded
                    .iter()
                    .all(|excluded| excluded.reason
                        == "no reproducible gate state before the finding")
            );
        }
    }

    #[test]
    fn clips_start_exactly_at_recognizer_and_mute_resets_for_any_candidate() {
        // Never quiet: only a reset can supply a reproducible start.
        for reset in [(0, 2), (1, 1)] {
            let mut frames = vec![(0.9, 0, 1); 2];
            frames.extend((0..20).map(|index| ([0.9, 0.3][index % 2], 0, 1)));
            frames.extend(fragment(reset.0, reset.1));
            let (rows, events) = trace(&frames);
            let extraction = run(&rows, &events, &[], policy());
            let [fixture] = &extraction.fixtures[..] else {
                panic!("{:?}", extraction.excluded)
            };
            assert_eq!(fixture.provenance.start, Start::GateReset);
            assert_eq!(
                fixture.provenance.source_sample_offset,
                (BASE + 768 * 22) / 48 * 48
            );
            for settings in [settings(0.2, 48, 160), settings(0.8, 16, 16)] {
                assert!(exact(&rows, &events, fixture, settings));
            }
        }
    }

    /// A host route request as a capture records it.
    fn route(frame: u64, observation: RouteObservation) -> Value {
        let message = serde_json::to_string(&SessionRequest::AudioRoute {
            observed_us: frame * 20000,
            observation,
        })
        .unwrap();
        serde_json::from_str(&format!(
            r#"{{"us":{},"frame":{frame},"type":"in","message":{message}}}"#,
            frame * 20000
        ))
        .unwrap()
    }

    fn opened(frame: u64, uid: &str) -> Value {
        route(
            frame,
            RouteObservation::InputOpened {
                input_uid: uid.into(),
            },
        )
    }

    fn output(frame: u64, uid: &str, changes: u64) -> Value {
        route(
            frame,
            RouteObservation::Output {
                output_uid: Some(uid.into()),
                changes,
            },
        )
    }

    #[test]
    fn clips_take_their_setup_only_from_bracketing_route_records() {
        let mut frames = vec![(0.0, 0, 1); 10];
        frames.extend(fragment(0, 1));
        frames.extend([(0.0, 0, 1); 120]);
        frames.extend(fragment(0, 1));
        frames.extend([(0.0, 0, 1); 10]);
        let (rows, clock) = trace(&frames);
        let legacy = run(&rows, &clock, &[], policy());
        let [first, second] = legacy.fixtures.as_slice() else {
            panic!("{:?}", legacy.excluded)
        };
        // Without route records a capture keeps its manifest setup, here none.
        assert_eq!(first.provenance.audio_setup, None);
        let clips = [
            first.provenance.source_sample_offset,
            second.provenance.source_sample_offset,
        ];
        let between = first.provenance.source_sample_end.div_ceil(960);
        assert!((between + 4) * 960 < clips[1]);
        let last = second.provenance.source_sample_end.div_ceil(960);
        let setups = |routes: &[Value]| {
            let mut events = clock.clone();
            events.extend_from_slice(routes);
            events.sort_by_key(|event| event["frame"].as_u64());
            let extraction = run(&rows, &events, &[], policy());
            clips.map(|offset| {
                let Some(fixture) = extraction
                    .fixtures
                    .iter()
                    .find(|fixture| fixture.provenance.source_sample_offset == offset)
                else {
                    assert!(extraction.excluded.iter().any(|excluded| excluded.source_start_sample
                        == offset
                        && excluded.reason
                            == "clip does not replay: audio route is not established across the clip"));
                    return None;
                };
                let setup = fixture.provenance.audio_setup.clone().unwrap();
                assert_eq!(setup.basis, SetupBasis::ObservedRoute);
                Some(format!(
                    "{}/{}",
                    setup.devices.input_uid, setup.devices.output_uid
                ))
            })
        };
        let observed = |a: &str, b: &str| [Some(a.to_string()), Some(b.to_string())];
        let start = [opened(0, "mic"), output(0, "speakers", 0)];
        let with = |extra: &[Value]| [&start[..], extra].concat();
        let steady = with(&[output(between, "speakers", 0), output(last, "speakers", 0)]);
        assert_eq!(setups(&steady), observed("mic/speakers", "mic/speakers"));
        // An observed change, or a change notification alone, leaves the clip before it unbracketed.
        assert_eq!(
            setups(&with(&[
                output(between, "headphones", 1),
                output(last, "headphones", 1)
            ])),
            [None, Some("mic/headphones".into())]
        );
        assert_eq!(
            setups(&with(&[
                output(between, "speakers", 1),
                output(last, "speakers", 1)
            ])),
            [None, Some("mic/speakers".into())]
        );
        // The last clip needs an observation after it.
        assert_eq!(
            setups(&with(&[output(between, "speakers", 0)])),
            [Some("mic/speakers".into()), None]
        );
        // Frames before the first opened stream, or after a reset, have no known input.
        assert_eq!(setups(&steady[1..]), [None, None]);
        let reset =
            json!({"us":0,"frame":between + 1,"type":"in","message":{"type":"reset_input","id":9}});
        let mut reopened = [&steady[..], std::slice::from_ref(&reset)].concat();
        assert_eq!(setups(&reopened), [Some("mic/speakers".into()), None]);
        reopened.push(opened(between + 2, "usb"));
        assert_eq!(setups(&reopened), observed("mic/speakers", "usb/speakers"));
        // Possible record loss needs fresh input and output records after it.
        let lost = json!({"us":0,"frame":between + 2,"type":"gap","reason":"capture_dropped","from_frame":between + 1});
        let mut recovered = [&steady[..], &[lost]].concat();
        assert_eq!(setups(&recovered), [Some("mic/speakers".into()), None]);
        recovered.push(opened(between + 3, "mic"));
        assert_eq!(setups(&recovered), [Some("mic/speakers".into()), None]);
        recovered.push(output(between + 3, "speakers", 0));
        assert_eq!(setups(&recovered), observed("mic/speakers", "mic/speakers"));
        // Records dropped behind a full queue may follow their marker, so none in that span can recover.
        let queued = |at: u64| Routes {
            inputs: vec![(at, u64::MAX, "mic".into())],
            outputs: vec![
                (at, Some("speakers".into()), 0),
                (900, Some("speakers".into()), 0),
            ],
            losses: vec![(100, 500)],
        };
        assert_eq!(queued(400).setup(600, 800), None);
        assert!(queued(501).setup(600, 800).is_some());
    }

    #[test]
    fn never_spans_gaps_and_keeps_label_provenance() {
        let mut frames = vec![(0.0, 0, 1); 10];
        frames.extend(fragment(0, 1));
        frames.extend([(0.3, 0, 1); 30]);
        frames.extend(fragment(0, 1));
        frames.extend([(0.0, 0, 1); 10]);
        let (rows, mut events) = trace(&frames);
        // The pause falls inside detector frame 30, which becomes unusable.
        let pause = (BASE + 768 * 30) / 960 + 1;
        events.push(json!({"us":pause * 20000,"frame":pause,"type":"gap","reason":"input_paused"}));
        let dropped = (BASE + 768 * 82) / 960;
        events.push(json!({"us":dropped * 20000,"frame":dropped,"type":"gap","reason":"capture_dropped","records":3}));
        events.sort_by_key(|event| event["frame"].as_u64());
        let speech = |start: u64, end: u64, provenance| SampleLabel {
            start_sample: start * 48,
            end_sample: end * 48,
            speech: true,
            provenance,
        };
        let labels = [
            // Starts before the first clip, so it cannot score an onset there.
            speech(0, 200, Label::HumanChecked),
            SampleLabel {
                speech: false,
                ..speech(200, 300, Label::HumanChecked)
            },
            speech(300, 400, Label::Inferred),
        ];
        let mut extraction = run(&rows, &events, &labels, policy());
        let pause = pause * 960;
        assert!(extraction
            .excluded
            .iter()
            .any(|excluded| excluded.reason == "capture gap: input_paused"
                && excluded.source_start_sample == pause));
        // Records lost behind a full queue follow their marker.
        assert!(extraction.excluded.iter().any(|excluded| {
            excluded.reason == "capture gap: capture_dropped"
                && excluded.source_start_sample == dropped * 960
                && excluded.source_end_sample == (dropped + 1025) * 960
        }));
        // After the pause there is no reset or quiet run before the second fragment.
        assert!(extraction
            .excluded
            .iter()
            .any(|excluded| excluded.finding == Some(Kind::Fragment)
                && excluded.reason == "no reproducible gate state before the finding"));
        let fixture = extraction.fixtures.remove(0);
        assert!(extraction.fixtures.is_empty());
        assert!(fixture.provenance.source_sample_end <= pause);
        assert!(matches!(fixture.provenance.start, Start::Quiet { .. }));
        let offset = fixture.provenance.source_sample_offset;
        let end = fixture.provenance.source_sample_end / 48 * 48;
        assert!(extraction.excluded.iter().any(|excluded| excluded
            .reason
            .starts_with("speech label starts before clip")));
        let labels: Vec<_> = fixture
            .input
            .labels
            .iter()
            .map(|label| (label.start_ms, label.end_ms, label.speech, label.provenance))
            .collect();
        let ms = |sample: u64| (sample - offset) / 48;
        assert_eq!(
            labels,
            [
                (ms(9600), ms(14400), false, Label::HumanChecked),
                (ms(14400), ms(end.min(19200)), true, Label::Inferred)
            ]
        );
        assert!(fixture
            .event_lines
            .clone()
            .all(|line| events[line]["type"] == "clock"));
    }

    #[test]
    fn tail_context_is_complete_when_rows_do_not_align_with_it() {
        let mut frames = vec![(0.0, 0, 1); 30];
        frames.extend(fragment(0, 1));
        frames.extend([(0.0, 0, 1); 30]);
        let (rows, events) = trace(&frames);
        let policy = ExtractPolicy {
            context_ms: 100,
            ..policy()
        };
        let extraction = run(&rows, &events, &[], policy);
        let [fixture] = &extraction.fixtures[..] else {
            panic!("{:?}", extraction.excluded)
        };
        assert!(!fixture.provenance.context_truncated);
        let finding = &fixture.findings[0];
        assert!(fixture.provenance.source_sample_end >= finding.source_end_sample + 4800);
    }

    #[test]
    fn missed_speech_needs_detector_coverage_across_reset_holes() {
        let mut frames = vec![(0.0, 0, 1); 40];
        frames.extend([(0.0, 0, 2); 40]);
        let (mut rows, events) = trace(&frames);
        // The reset discarded ten frames of buffered audio before frame 40.
        for row in &mut rows[41..] {
            row["mic_sample"] = json!(row["mic_sample"].as_u64().unwrap() + 7680);
        }
        let hole = BASE + 768 * 40;
        let speech = |start_sample: u64, end_sample: u64| SampleLabel {
            start_sample: start_sample / 48 * 48,
            end_sample: end_sample / 48 * 48,
            speech: true,
            provenance: Label::HumanChecked,
        };
        let labels = [
            speech(hole - 480, hole + 7680),
            speech(hole + 9600, hole + 14400),
        ];
        let extraction = run(&rows, &events, &labels, ExtractPolicy::default());
        let findings: Vec<_> = extraction
            .fixtures
            .iter()
            .flat_map(|fixture| &fixture.findings)
            .map(|finding| (finding.kind, finding.source_start_sample))
            .collect();
        assert_eq!(findings, [(Kind::MissedSpeech, labels[1].start_sample)]);
    }

    #[test]
    fn finds_reply_holds_interruptions_and_label_disagreements() {
        let mut frames = vec![(0.0, 0, 1); 20];
        frames.extend([(0.9, 0, 1); 10]);
        frames.extend([(0.0, 0, 1); 60]);
        let (mut rows, mut events) = trace(&frames);
        // rows[0] is settings; the agent speaks over frames 19 to 25.
        for row in &mut rows[20..27] {
            row["mode"] = json!("interruption");
        }
        events.push(
            json!({"us":400001,"frame":20,"type":"in","message":{"type":"prepare_speak","id":3}}),
        );
        events.push(
            json!({"us":800001,"frame":40,"type":"out","message":{"type":"admitted","id":3}}),
        );
        events.sort_by_key(|event| event["frame"].as_u64());
        let labels = [
            SampleLabel {
                start_sample: 96 * 48,
                end_sample: 160 * 48,
                speech: true,
                provenance: Label::HumanChecked,
            },
            SampleLabel {
                start_sample: 320 * 48,
                end_sample: 480 * 48,
                speech: false,
                provenance: Label::HumanChecked,
            },
        ];
        let policy = ExtractPolicy {
            reply_held_ms: 400,
            ..ExtractPolicy::default()
        };
        let extraction = run(&rows, &events, &labels, policy);
        assert_eq!(extraction.excluded.len(), 0, "{:?}", extraction.excluded);
        let kinds: Vec<_> = extraction
            .fixtures
            .iter()
            .flat_map(|fixture| fixture.findings.iter().map(|finding| finding.kind))
            .collect();
        assert_eq!(
            kinds,
            [
                Kind::MissedSpeech,
                Kind::Interruption,
                Kind::FalseActivity,
                Kind::ReplyHeld
            ]
        );
        assert_eq!(extraction.fixtures.len(), 1);
        assert_eq!(extraction.fixtures[0].provenance.start, Start::CaptureStart);
        assert_eq!(extraction.source_session, "capture-7");
    }
}
