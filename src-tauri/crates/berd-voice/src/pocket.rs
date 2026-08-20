//! April 2026 Pocket TTS engine for Berd.
//!
//! The `english_2026-04` bundle uses SentencePiece tokenization, a learned
//! voice BOS embedding, recurrent FlowLM state, and stateful Mimi decoding.
//! Berd selects the upstream three-graph INT8 variant while retaining the
//! full-precision Mimi encoder and text conditioner specified by that variant.
//!
//! ## Attribution
//!
//! - Pocket TTS and Mimi: Kyutai, CC-BY-4.0.
//! - ONNX export: KevinAHM/pocket-tts-onnx, CC-BY-4.0.
//! - Reference voice: Kyutai's Mary preset (VCTK p333), CC-BY-4.0.
//!
//! Berd's Pocket model installer writes the complete attribution beside the
//! cached model files.

use std::cell::RefCell;
use std::path::Path;
use std::sync::Mutex;

use sherpa_onnx::Wave;

#[path = "pocket_april.rs"]
mod pocket_april;
use pocket_april::{prepare_april_prompt, AprilPocketTts, AprilSynthesisOutcome};

/// Pocket TTS emits 24 kHz mono PCM.
pub const SAMPLE_RATE: u32 = 24_000;

const TTS_NUM_THREADS: usize = 1;

thread_local! {
    static ACTIVE_SYNTHESIS_ENGINES: RefCell<Vec<usize>> = const { RefCell::new(Vec::new()) };
}

struct SynthesisCallGuard {
    engine_id: usize,
}

impl SynthesisCallGuard {
    fn enter(engine_id: usize) -> Result<Self, String> {
        ACTIVE_SYNTHESIS_ENGINES.with(|active| {
            let mut active = active.borrow_mut();
            if active.contains(&engine_id) {
                return Err("Pocket TTS callback re-entered the active engine".to_string());
            }
            active.push(engine_id);
            Ok(Self { engine_id })
        })
    }
}

impl Drop for SynthesisCallGuard {
    fn drop(&mut self) {
        ACTIVE_SYNTHESIS_ENGINES.with(|active| {
            let mut active = active.borrow_mut();
            if let Some(index) = active.iter().rposition(|engine| *engine == self.engine_id) {
                active.remove(index);
            }
        });
    }
}

/// Loaded reference voice samples and their original sample rate.
#[derive(Debug, Clone)]
pub struct VoiceStyle {
    samples: Vec<f32>,
    sample_rate: i32,
}

/// Load a Pocket reference voice WAV from disk.
pub fn load_voice_style(path: &Path) -> Result<VoiceStyle, String> {
    let path_str = path
        .to_str()
        .ok_or_else(|| format!("voice path is not valid UTF-8: {}", path.display()))?;
    let wave = Wave::read(path_str)
        .ok_or_else(|| format!("could not read voice WAV at {}", path.display()))?;
    let samples = wave.samples().to_vec();
    if samples.is_empty() {
        return Err(format!("voice WAV is empty: {}", path.display()));
    }
    Ok(VoiceStyle {
        samples,
        sample_rate: wave.sample_rate(),
    })
}

/// Resident April INT8 Pocket TTS engine.
pub struct PocketTts {
    inner: Mutex<AprilPocketTts>,
}

/// Result of a callback-driven Pocket synthesis request.
#[derive(Debug, Clone, PartialEq)]
pub enum SynthesisOutcome {
    /// Synthesis finished and contains the same PCM exposed cumulatively to
    /// the callback.
    Complete(Vec<f32>),
    /// The callback requested cancellation before synthesis completed.
    Interrupted,
}

/// Load Berd's pinned April INT8 model.
pub fn load_text_to_speech(model_dir: &str) -> Result<PocketTts, String> {
    let dir = Path::new(model_dir);
    Ok(PocketTts {
        inner: Mutex::new(AprilPocketTts::load(dir, TTS_NUM_THREADS)?),
    })
}

impl PocketTts {
    /// Synthesize text while reporting cumulative PCM as decoder blocks finish.
    ///
    /// Callback sample buffers contain all PCM produced for this call so far.
    /// Their lengths never decrease, but equal lengths are allowed while the
    /// engine advances before PCM is available or between internal model-safe
    /// text chunks. Returning `false` interrupts synthesis before the next
    /// model or decoder step.
    pub fn synth_chunk_streaming<F>(
        &self,
        text: &str,
        _lang: &str,
        style: &VoiceStyle,
        _steps: usize,
        mut callback: F,
    ) -> Result<SynthesisOutcome, String>
    where
        F: FnMut(&[f32], f32) -> bool,
    {
        let _call_guard = SynthesisCallGuard::enter(self as *const Self as usize)?;
        let Some(prepared) = prepare_april_prompt(text) else {
            return Ok(SynthesisOutcome::Complete(Vec::new()));
        };
        let mut engine = self
            .inner
            .lock()
            .map_err(|_| "Pocket TTS engine lock poisoned".to_string())?;
        let chunks = engine.split_prompt(&prepared)?;
        let chunk_count = chunks.len();
        let mut samples = Vec::new();
        for (chunk_index, chunk) in chunks.into_iter().enumerate() {
            if chunk_index > 0
                && !callback_allows_progress(
                    &mut callback,
                    &samples,
                    chunk_index as f32 / chunk_count as f32,
                )?
            {
                return Ok(SynthesisOutcome::Interrupted);
            }
            let prepared = prepare_april_prompt(&chunk)
                .ok_or_else(|| "Pocket TTS prompt chunk became empty".to_string())?;
            let mut callback_error = None;
            let outcome = engine.synth_chunk_streaming(&prepared, style, |block, progress| {
                match append_and_callback(
                    &mut samples,
                    block,
                    &mut callback,
                    (chunk_index as f32 + progress) / chunk_count as f32,
                ) {
                    Ok(allowed) => allowed,
                    Err(error) => {
                        callback_error = Some(error);
                        false
                    }
                }
            })?;
            if let Some(error) = callback_error {
                return Err(error);
            }
            if matches!(outcome, AprilSynthesisOutcome::Interrupted) {
                return Ok(SynthesisOutcome::Interrupted);
            }
        }
        Ok(SynthesisOutcome::Complete(samples))
    }
}

fn append_and_callback<F>(
    samples: &mut Vec<f32>,
    block: &[f32],
    callback: &mut F,
    progress: f32,
) -> Result<bool, String>
where
    F: FnMut(&[f32], f32) -> bool,
{
    samples.extend_from_slice(block);
    callback_allows_progress(callback, samples, progress)
}

fn callback_allows_progress<F>(
    callback: &mut F,
    samples: &[f32],
    progress: f32,
) -> Result<bool, String>
where
    F: FnMut(&[f32], f32) -> bool,
{
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| callback(samples, progress)))
        .map_err(|_| "Pocket TTS synthesis callback panicked".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cumulative_callback_allows_growth_equal_repeats_and_cancellation() {
        let mut observed = Vec::new();
        let mut callback = |samples: &[f32], progress: f32| {
            observed.push((samples.to_vec(), progress));
            progress < 0.75
        };
        let mut samples = Vec::new();

        assert!(
            append_and_callback(&mut samples, &[1.0, 2.0], &mut callback, 0.25)
                .expect("first callback")
        );
        assert!(append_and_callback(&mut samples, &[], &mut callback, 0.5)
            .expect("equal-length callback"));
        assert!(
            !append_and_callback(&mut samples, &[3.0], &mut callback, 0.75)
                .expect("cancelling callback")
        );

        assert_eq!(
            observed,
            vec![
                (vec![1.0, 2.0], 0.25),
                (vec![1.0, 2.0], 0.5),
                (vec![1.0, 2.0, 3.0], 0.75),
            ]
        );
    }

    #[test]
    fn equal_length_pre_decoder_callback_can_cancel() {
        let mut callback = |samples: &[f32], progress: f32| {
            assert!(samples.is_empty());
            assert_eq!(progress, 0.25);
            false
        };
        let mut samples = Vec::new();

        assert!(!append_and_callback(&mut samples, &[], &mut callback, 0.25)
            .expect("pre-decoder cancellation callback"));
    }

    #[test]
    fn callback_panic_is_reported_without_unwinding() {
        let mut callback = |_: &[f32], _: f32| -> bool {
            panic!("callback failure");
        };
        assert_eq!(
            callback_allows_progress(&mut callback, &[], 0.0).unwrap_err(),
            "Pocket TTS synthesis callback panicked"
        );
    }

    #[test]
    fn active_engine_reentry_is_rejected() {
        let _guard = SynthesisCallGuard::enter(42).expect("first call");
        assert!(SynthesisCallGuard::enter(42).is_err());
    }

    #[test]
    #[ignore = "requires BERD_POCKET_TEST_MODEL_DIR"]
    fn production_streaming_callbacks_are_cumulative_across_model_chunks() {
        let dir = std::env::var("BERD_POCKET_TEST_MODEL_DIR")
            .expect("set BERD_POCKET_TEST_MODEL_DIR to an April INT8 model directory");
        let engine = load_text_to_speech(&dir).expect("load April INT8 engine");
        let style = load_voice_style(&Path::new(&dir).join("reference_sample.wav"))
            .expect("load reference voice");
        let text = "And sometimes, when I am certain the reader is rested, I will engage him with a sentence of considerable length, a sentence that burns with energy and builds with all the impetus of a crescendo, the roll of the drums, the crash of the cymbals–sounds that say listen to this, it is important.";
        let mut reconstructed = Vec::new();
        let mut previous_len = 0;
        let mut saw_equal_repeat = false;
        let mut callback_count = 0;
        let mut first_callback = None;
        let started = std::time::Instant::now();

        let outcome = engine
            .synth_chunk_streaming(text, "en", &style, 1, |cumulative, _| {
                callback_count += 1;
                first_callback.get_or_insert_with(|| started.elapsed());
                assert!(cumulative.len() >= previous_len);
                saw_equal_repeat |= cumulative.len() == previous_len;
                reconstructed.extend_from_slice(&cumulative[previous_len..]);
                previous_len = cumulative.len();
                true
            })
            .expect("stream through the production API");
        let SynthesisOutcome::Complete(samples) = outcome else {
            panic!("uninterrupted synthesis must complete");
        };
        let total = started.elapsed();
        let first_callback = first_callback.expect("decoder must produce a callback");
        let audio_duration =
            std::time::Duration::from_secs_f64(samples.len() as f64 / SAMPLE_RATE as f64);
        eprintln!(
            "first_callback_ms={:.1} total_ms={:.1} audio_seconds={:.3} rtf={:.3} callbacks={callback_count}",
            first_callback.as_secs_f64() * 1000.0,
            total.as_secs_f64() * 1000.0,
            audio_duration.as_secs_f64(),
            total.as_secs_f64() / audio_duration.as_secs_f64(),
        );

        assert!(saw_equal_repeat);
        assert_eq!(reconstructed, samples);
        assert!(samples.iter().all(|sample| sample.is_finite()));
        assert!(samples.iter().any(|sample| sample.abs() > 1.0e-6));
    }
}
