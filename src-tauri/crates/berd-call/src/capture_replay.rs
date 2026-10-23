//! Convert captured continuous-worker frames without mixing the two clocks.
use crate::detection::DetectionSettings;
use crate::vad_replay::{Frame, Label, Mode, Provenance, ReplayInput};
use serde::Deserialize;
use serde_json::Value;
use std::collections::HashMap;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Annotations {
    pub schema_version: u32,
    pub session_id: String,
    pub held_out: bool,
    pub labels: Vec<SampleLabel>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SampleLabel {
    pub start_sample: u64,
    pub end_sample: u64,
    pub speech: bool,
    pub provenance: Provenance,
}

fn number(row: &Value, key: &str) -> Result<u64, String> {
    row[key]
        .as_u64()
        .ok_or_else(|| format!("trace needs integer {key}"))
}

/// Protocol waiting remains in capture_metrics: processing us cannot be projected
/// onto sample time without measuring the intervening input and worker latency.
pub fn convert(
    manifest: &Value,
    rows: &[Value],
    events: &[Value],
    annotations: Annotations,
) -> Result<ReplayInput, String> {
    if manifest["schema"] != "berd-call-capture/1"
        || manifest["mic"]["sample_rate"] != 48000
        || manifest["session"]["stt_backend"] != "macos"
        || manifest["session"]["continuous_recognition"] != true
    {
        return Err("directory replay requires a 48 kHz macOS continuous capture".into());
    }
    if events.is_empty()
        || events
            .iter()
            .any(|row| matches!(row["type"].as_str(), Some("gap" | "limit")))
    {
        return Err(
            "directory replay requires complete events without capture gaps or limits".into(),
        );
    }
    crate::capture_metrics::measure(events)?;
    if annotations.schema_version != 1 {
        return Err("unsupported annotation schema".into());
    }
    let labels = annotations
        .labels
        .into_iter()
        .map(|label| {
            if label.start_sample % 48 != 0 || label.end_sample % 48 != 0 {
                return Err(
                    "label sample boundaries must align to whole milliseconds (48 samples)".into(),
                );
            }
            Ok(Label {
                start_ms: label.start_sample / 48,
                end_ms: label.end_sample / 48,
                speech: label.speech,
                provenance: label.provenance,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    let mut settings = HashMap::<u64, DetectionSettings>::new();
    let mut frames = Vec::new();
    let mut previous_us = 0;
    let mut previous_frame = None;
    let mut previous_sample = None;
    let mut previous_reset = None;
    let mut replay_epoch = 0;
    for row in rows {
        let us = number(row, "us")?;
        if us < previous_us {
            return Err("VAD processing times must be ordered".into());
        }
        previous_us = us;
        if row["type"] == "settings" {
            let revision = number(row, "revision")?;
            let value: DetectionSettings = serde_json::from_value(row["settings"].clone())
                .map_err(|error| error.to_string())?;
            value.validate()?;
            if settings.insert(revision, value).is_some() {
                return Err("duplicate settings revision".into());
            }
            continue;
        }
        if row.get("type").is_some() {
            return Err("unknown VAD record type".into());
        }
        let index = number(row, "vad_frame")?;
        let sample = number(row, "mic_sample")?;
        let reset = (number(row, "epoch")?, number(row, "generation")?);
        if previous_frame.is_some_and(|prior| index.checked_sub(prior) != Some(1)) {
            return Err("missing or unordered VAD frames".into());
        }
        if previous_sample
            .is_some_and(|prior| sample.checked_sub(prior).is_none_or(|delta| delta < 768))
        {
            return Err("VAD audio frames must be ordered and nonoverlapping".into());
        }
        if previous_reset.is_some_and(|prior| prior != reset) {
            replay_epoch += 1;
        }
        let effective = *settings
            .get(&number(row, "settings_revision")?)
            .ok_or("VAD frame references missing settings")?;
        let mode: Mode =
            serde_json::from_value(row["mode"].clone()).map_err(|error| error.to_string())?;
        let probability = row["probability"].as_f64().ok_or("missing probability")? as f32;
        let threshold = match mode {
            Mode::Listening => effective.listening.value,
            Mode::Interruption => effective.interruption.value,
        };
        if row["threshold"].as_f64().map(|value| value as f32) != Some(threshold)
            || row["detected"].as_bool() != Some(probability > threshold)
            || row["active"].as_bool().is_none()
        {
            return Err("VAD decision disagrees with effective settings".into());
        }
        frames.push(Frame {
            end_ms: sample / 48,
            epoch: replay_epoch,
            confidence: probability,
            mode,
            settings: effective,
        });
        previous_frame = Some(index);
        previous_sample = Some(sample);
        previous_reset = Some(reset);
    }
    let input = ReplayInput {
        schema_version: 1,
        session_id: annotations.session_id,
        held_out: annotations.held_out,
        frames,
        labels,
        reply_waiting: vec![],
    };
    input.validate()?;
    let baseline = crate::vad_replay::replay(&input, None)?;
    for (decision, row) in baseline
        .decisions
        .iter()
        .zip(rows.iter().filter(|row| row.get("type").is_none()))
    {
        if decision
            .active
            .is_some_and(|active| row["active"].as_bool() != Some(active))
        {
            return Err(
                "recorded gate output disagrees with replay; reset or frame history is incomplete"
                    .into(),
            );
        }
    }
    Ok(input)
}
