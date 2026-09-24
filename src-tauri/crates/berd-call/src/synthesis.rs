use std::io::{Seek, Write};
use std::sync::atomic::AtomicBool;

use crate::{TtsBackend, TtsOutcome, TtsSynthesisEvent};

const MAX_SYNTHESIS_SECONDS: u64 = 10 * 60;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WavSynthesis {
    pub sample_rate: u32,
    pub frames: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WavSynthesisErrorKind {
    Backend,
    Cancelled,
    Empty,
    InvalidPcm,
    TooLong,
    Output,
}

#[derive(Debug, PartialEq, Eq)]
pub struct WavSynthesisError {
    pub kind: WavSynthesisErrorKind,
    pub detail: String,
}

impl WavSynthesisError {
    fn new(kind: WavSynthesisErrorKind, detail: impl Into<String>) -> Self {
        Self {
            kind,
            detail: detail.into(),
        }
    }
}

pub fn synthesize_pcm16_wav(
    backend: &dyn TtsBackend,
    text: &str,
    output: impl Write + Seek,
) -> Result<WavSynthesis, WavSynthesisError> {
    let spec = backend.pcm_spec();
    if spec.sample_rate == 0 || !spec.playback_rate.is_finite() || spec.playback_rate != 1.0 {
        return Err(WavSynthesisError::new(
            WavSynthesisErrorKind::InvalidPcm,
            "WAV synthesis requires a nonzero sample rate and playback rate 1.0",
        ));
    }
    let wav_spec = hound::WavSpec {
        channels: 1,
        sample_rate: spec.sample_rate,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut writer = hound::WavWriter::new(output, wav_spec).map_err(|error| {
        WavSynthesisError::new(WavSynthesisErrorKind::Output, error.to_string())
    })?;
    let max_frames = u64::from(spec.sample_rate)
        .checked_mul(MAX_SYNTHESIS_SECONDS)
        .expect("u32 sample rate times ten minutes fits u64");
    let mut frames = 0_u64;
    let mut callback_failure = None;
    let active = AtomicBool::new(true);
    let outcome = backend.synthesize_with_poll(text, &active, &mut |event| {
        let TtsSynthesisEvent::Frames(samples) = event else {
            return Ok(());
        };
        if samples.is_empty() {
            return Ok(());
        }
        let incoming = samples.len() as u64;
        if frames.saturating_add(incoming) > max_frames {
            callback_failure = Some(WavSynthesisError::new(
                WavSynthesisErrorKind::TooLong,
                "synthesis exceeds ten minutes of source PCM",
            ));
            return Err("synthesis output is too long".into());
        }
        for &sample in samples {
            if !sample.is_finite() || !(-1.0..=1.0).contains(&sample) {
                callback_failure = Some(WavSynthesisError::new(
                    WavSynthesisErrorKind::InvalidPcm,
                    "synthesis produced non-finite or out-of-unit PCM",
                ));
                return Err("synthesis produced invalid PCM".into());
            }
            let quantized = if sample < 0.0 {
                (sample * 32_768.0).round() as i16
            } else {
                (sample * 32_767.0).round() as i16
            };
            if let Err(error) = writer.write_sample(quantized) {
                callback_failure = Some(WavSynthesisError::new(
                    WavSynthesisErrorKind::Output,
                    error.to_string(),
                ));
                return Err("could not write WAV output".into());
            }
        }
        frames += incoming;
        Ok(())
    });
    if let Some(error) = callback_failure {
        return Err(error);
    }
    match outcome {
        Err(error) => {
            return Err(WavSynthesisError::new(
                WavSynthesisErrorKind::Backend,
                error,
            ))
        }
        Ok(TtsOutcome::Cancelled) => {
            return Err(WavSynthesisError::new(
                WavSynthesisErrorKind::Cancelled,
                "synthesis was cancelled",
            ))
        }
        Ok(TtsOutcome::Completed) if frames == 0 => {
            return Err(WavSynthesisError::new(
                WavSynthesisErrorKind::Empty,
                "synthesis completed without PCM",
            ))
        }
        Ok(TtsOutcome::Completed) => {}
    }
    writer.finalize().map_err(|error| {
        WavSynthesisError::new(WavSynthesisErrorKind::Output, error.to_string())
    })?;
    Ok(WavSynthesis {
        sample_rate: spec.sample_rate,
        frames,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{TtsOutcome, TtsPcmSpec, TtsSynthesisEvent};
    use std::io::Cursor;
    use std::sync::atomic::AtomicBool;

    struct FakeTts {
        spec: TtsPcmSpec,
        events: Vec<Vec<f32>>,
        outcome: Result<TtsOutcome, String>,
    }

    impl TtsBackend for FakeTts {
        fn pcm_spec(&self) -> TtsPcmSpec {
            self.spec
        }

        fn synthesize(
            &self,
            _text: &str,
            _active: &AtomicBool,
            _on_frames: &mut dyn FnMut(&[f32]) -> Result<(), String>,
        ) -> Result<TtsOutcome, String> {
            unreachable!("WAV synthesis uses lifecycle polling")
        }

        fn synthesize_with_poll(
            &self,
            _text: &str,
            _active: &AtomicBool,
            on_event: &mut dyn FnMut(TtsSynthesisEvent<'_>) -> Result<(), String>,
        ) -> Result<TtsOutcome, String> {
            on_event(TtsSynthesisEvent::Poll)?;
            for frames in &self.events {
                on_event(TtsSynthesisEvent::Frames(frames))?;
            }
            self.outcome.clone()
        }
    }

    fn fake(events: Vec<Vec<f32>>) -> FakeTts {
        FakeTts {
            spec: TtsPcmSpec {
                sample_rate: 24_000,
                playback_rate: 1.0,
            },
            events,
            outcome: Ok(TtsOutcome::Completed),
        }
    }

    fn failure(
        spec: TtsPcmSpec,
        events: Vec<Vec<f32>>,
        outcome: Result<TtsOutcome, String>,
    ) -> WavSynthesisErrorKind {
        synthesize_pcm16_wav(
            &FakeTts {
                spec,
                events,
                outcome,
            },
            "hello",
            Cursor::new(Vec::new()),
        )
        .unwrap_err()
        .kind
    }

    #[test]
    fn writes_exact_mono_pcm16_wav_across_callbacks_and_ignores_poll() {
        let mut bytes = Cursor::new(Vec::new());
        let result = synthesize_pcm16_wav(
            &fake(vec![vec![-1.0, -0.5], vec![], vec![0.0, 0.5, 1.0]]),
            "hello",
            &mut bytes,
        )
        .unwrap();
        assert_eq!(result.sample_rate, 24_000);
        assert_eq!(result.frames, 5);
        let bytes = bytes.into_inner();
        assert_eq!(&bytes[0..4], b"RIFF");
        assert_eq!(&bytes[8..12], b"WAVE");
        assert_eq!(u16::from_le_bytes(bytes[22..24].try_into().unwrap()), 1);
        assert_eq!(
            u32::from_le_bytes(bytes[24..28].try_into().unwrap()),
            24_000
        );
        assert_eq!(u16::from_le_bytes(bytes[34..36].try_into().unwrap()), 16);
        assert_eq!(u32::from_le_bytes(bytes[40..44].try_into().unwrap()), 10);
        let samples = bytes[44..]
            .chunks_exact(2)
            .map(|sample| i16::from_le_bytes(sample.try_into().unwrap()))
            .collect::<Vec<_>>();
        assert_eq!(samples, [-32768, -16384, 0, 16384, 32767]);
    }

    #[test]
    fn rejects_invalid_empty_cancelled_failed_and_oversized_output() {
        let spec = TtsPcmSpec {
            sample_rate: 24_000,
            playback_rate: 1.0,
        };
        for invalid in [f32::NAN, f32::INFINITY, -1.01, 1.01] {
            assert_eq!(
                failure(spec, vec![vec![invalid]], Ok(TtsOutcome::Completed)),
                WavSynthesisErrorKind::InvalidPcm
            );
        }
        assert_eq!(
            failure(spec, vec![], Ok(TtsOutcome::Completed)),
            WavSynthesisErrorKind::Empty
        );
        assert_eq!(
            failure(spec, vec![vec![0.1]], Ok(TtsOutcome::Cancelled)),
            WavSynthesisErrorKind::Cancelled
        );
        assert_eq!(
            failure(spec, vec![vec![0.1]], Err("provider failed".into())),
            WavSynthesisErrorKind::Backend
        );
        assert_eq!(
            failure(
                TtsPcmSpec {
                    sample_rate: 1,
                    playback_rate: 1.0,
                },
                vec![vec![0.1; 601]],
                Ok(TtsOutcome::Completed),
            ),
            WavSynthesisErrorKind::TooLong
        );
        assert_eq!(
            failure(
                TtsPcmSpec {
                    sample_rate: 24_000,
                    playback_rate: 2.0,
                },
                vec![vec![0.1]],
                Ok(TtsOutcome::Completed),
            ),
            WavSynthesisErrorKind::InvalidPcm
        );
    }
}
