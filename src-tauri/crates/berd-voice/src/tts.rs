use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use crate::openai::{stream_openai_pcm, OpenAiPcmOutcome, OpenAiSpeechConfig};
use crate::{load_pocket_voice_style, load_text_to_speech, PocketTts, VoiceStyle, SAMPLE_RATE};

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TtsPcmSpec {
    pub sample_rate: u32,
    pub playback_rate: f32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TtsOutcome {
    Completed,
    Cancelled,
}

pub enum TtsSynthesisEvent<'a> {
    Frames(&'a [f32]),
    /// A lifecycle polling opportunity while synthesis is blocked waiting for
    /// more PCM or a terminal provider result.
    Poll,
}

/// A backend-neutral source of normalized mono, unit-scale Float32 PCM.
///
/// Turn admission, output-device ownership, buffering, playback, and delivery
/// events remain the session host's responsibility.
pub trait TtsBackend: Send + Sync {
    fn pcm_spec(&self) -> TtsPcmSpec;

    fn synthesize(
        &self,
        text: &str,
        active: &AtomicBool,
        on_frames: &mut dyn FnMut(&[f32]) -> Result<(), String>,
    ) -> Result<TtsOutcome, String>;

    /// Synthesizes while allowing backends with blocking waits to yield host
    /// lifecycle polling. Backends without such waits keep the simple source
    /// contract and use the default implementation.
    fn synthesize_with_poll(
        &self,
        text: &str,
        active: &AtomicBool,
        on_event: &mut dyn FnMut(TtsSynthesisEvent<'_>) -> Result<(), String>,
    ) -> Result<TtsOutcome, String> {
        self.synthesize(text, active, &mut |frames| {
            on_event(TtsSynthesisEvent::Frames(frames))
        })
    }
}

pub struct OpenAiTts {
    client: reqwest::Client,
    config: OpenAiSpeechConfig,
}

pub struct PocketTtsBackend {
    engine: PocketTts,
    style: VoiceStyle,
    playback_rate: f32,
}

impl PocketTtsBackend {
    pub fn new(model_dir: &Path, voice_id: &str, playback_rate: f32) -> Result<Self, String> {
        if !playback_rate.is_finite() || !(0.75..=2.0).contains(&playback_rate) {
            return Err("Pocket rate must be between 0.75 and 2.0".into());
        }
        let model_dir_str = model_dir.to_str().ok_or_else(|| {
            format!(
                "Pocket model path is not valid UTF-8: {}",
                model_dir.display()
            )
        })?;
        let style = load_pocket_voice_style(model_dir, voice_id)?;
        let engine = load_text_to_speech(model_dir_str)?;
        Ok(Self {
            engine,
            style,
            playback_rate,
        })
    }
}

impl TtsBackend for PocketTtsBackend {
    fn pcm_spec(&self) -> TtsPcmSpec {
        TtsPcmSpec {
            sample_rate: SAMPLE_RATE,
            playback_rate: self.playback_rate,
        }
    }

    fn synthesize(
        &self,
        text: &str,
        active: &AtomicBool,
        on_frames: &mut dyn FnMut(&[f32]) -> Result<(), String>,
    ) -> Result<TtsOutcome, String> {
        if !active.load(Ordering::SeqCst) {
            return Ok(TtsOutcome::Cancelled);
        }
        let mut callback_error = None;
        let completed =
            self.engine
                .synth_chunk_streaming(text, &self.style, 12, &mut |frames| {
                    if !active.load(Ordering::SeqCst) {
                        return false;
                    }
                    if frames.is_empty() {
                        return true;
                    }
                    match on_frames(&frames) {
                        Ok(()) => true,
                        Err(error) => {
                            callback_error = Some(error);
                            false
                        }
                    }
                })?;
        if let Some(error) = callback_error {
            return Err(error);
        }
        Ok(if completed && active.load(Ordering::SeqCst) {
            TtsOutcome::Completed
        } else {
            TtsOutcome::Cancelled
        })
    }
}

impl OpenAiTts {
    pub fn new(config: OpenAiSpeechConfig) -> Result<Self, String> {
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(15))
            .read_timeout(Duration::from_secs(120))
            .build()
            .map_err(|error| error.to_string())?;
        Ok(Self { client, config })
    }
}

impl TtsBackend for OpenAiTts {
    fn pcm_spec(&self) -> TtsPcmSpec {
        TtsPcmSpec {
            sample_rate: 24_000,
            playback_rate: 1.0,
        }
    }

    fn synthesize(
        &self,
        text: &str,
        active: &AtomicBool,
        on_frames: &mut dyn FnMut(&[f32]) -> Result<(), String>,
    ) -> Result<TtsOutcome, String> {
        if !active.load(Ordering::SeqCst) {
            return Ok(TtsOutcome::Cancelled);
        }
        let runtime = tokio::runtime::Runtime::new().map_err(|error| error.to_string())?;
        match runtime.block_on(stream_openai_pcm(
            &self.client,
            &self.config,
            text,
            active,
            on_frames,
        ))? {
            OpenAiPcmOutcome::Completed => Ok(TtsOutcome::Completed),
            OpenAiPcmOutcome::Cancelled => Ok(TtsOutcome::Cancelled),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{PocketTtsBackend, TtsBackend, TtsOutcome, TtsPcmSpec};
    use std::path::Path;
    use std::sync::atomic::{AtomicBool, Ordering};

    struct FakeTts;

    impl TtsBackend for FakeTts {
        fn pcm_spec(&self) -> TtsPcmSpec {
            TtsPcmSpec {
                sample_rate: 16_000,
                playback_rate: 1.25,
            }
        }

        fn synthesize(
            &self,
            _text: &str,
            _active: &AtomicBool,
            on_frames: &mut dyn FnMut(&[f32]) -> Result<(), String>,
        ) -> Result<TtsOutcome, String> {
            on_frames(&[0.0, 0.5])?;
            Ok(TtsOutcome::Completed)
        }
    }

    #[test]
    fn trait_keeps_engine_pcm_separate_from_output_policy() {
        let backend: &dyn TtsBackend = &FakeTts;
        let mut received = Vec::new();
        let outcome = backend
            .synthesize("hello", &AtomicBool::new(true), &mut |frames| {
                received.extend_from_slice(frames);
                Ok(())
            })
            .unwrap();
        assert_eq!(backend.pcm_spec().sample_rate, 16_000);
        assert_eq!(outcome, TtsOutcome::Completed);
        assert_eq!(received, [0.0, 0.5]);
    }

    #[test]
    #[ignore = "requires BERD_POCKET_TEST_MODEL_DIR with a complete Pocket bundle"]
    fn pocket_backend_synthesizes_in_memory_and_cancels() {
        let model_dir = std::env::var("BERD_POCKET_TEST_MODEL_DIR").unwrap();
        let voice = std::env::var("BERD_POCKET_TEST_VOICE").unwrap_or_else(|_| "george".into());
        let backend = PocketTtsBackend::new(Path::new(&model_dir), &voice, 1.0).unwrap();
        let active = AtomicBool::new(true);
        let mut frames = Vec::new();
        assert_eq!(
            backend
                .synthesize("Pocket synthesis works.", &active, &mut |chunk| {
                    frames.extend_from_slice(chunk);
                    Ok(())
                })
                .unwrap(),
            TtsOutcome::Completed
        );
        assert!(!frames.is_empty());
        assert!(frames.iter().all(|sample| sample.is_finite()));

        let active = AtomicBool::new(true);
        let mut received = false;
        assert_eq!(
            backend
                .synthesize(
                    "This longer sentence is cancelled during local inference.",
                    &active,
                    &mut |chunk| {
                        received |= !chunk.is_empty();
                        active.store(false, Ordering::SeqCst);
                        Ok(())
                    },
                )
                .unwrap(),
            TtsOutcome::Cancelled
        );
        assert!(received);

        let error = backend
            .synthesize(
                "Pocket output errors are preserved.",
                &AtomicBool::new(true),
                &mut |_chunk| Err("fake output failed".into()),
            )
            .unwrap_err();
        assert_eq!(error, "fake output failed");
    }
}
