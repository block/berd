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
use pocket_april::{prepare_april_prompt, AprilPocketTts};

/// Pocket TTS emits 24 kHz mono PCM.
pub const SAMPLE_RATE: u32 = 24_000;

const TTS_NUM_THREADS: usize = 1;

/// Drain stable, sentence-aware chunks from text that may still be growing.
///
/// This backend-neutral form uses a word-count budget. It lets system speech
/// engines share Berd's first-sentence latency behavior without loading a
/// Pocket model solely to segment text.
pub fn take_streaming_text_chunks(
    text: &str,
    first_chunk_pending: bool,
    flush: bool,
) -> Result<StreamingTextChunks, String> {
    let (ready, pending, first_chunk_pending) =
        pocket_april::take_streaming_chunks_at_natural_boundaries(
            text,
            50,
            first_chunk_pending,
            flush,
            |candidate| Ok(candidate.split_whitespace().count()),
        )?;
    Ok(StreamingTextChunks {
        ready,
        pending,
        first_chunk_pending,
    })
}

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

    fn is_active(engine_id: usize) -> bool {
        ACTIVE_SYNTHESIS_ENGINES.with(|active| active.borrow().contains(&engine_id))
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

/// Return the configured ONNX intra-op thread count for Pocket sessions.
/// `BERD_TTS_THREADS` overrides the single-thread default when set.
fn tts_num_threads() -> usize {
    std::env::var("BERD_TTS_THREADS")
        .ok()
        .and_then(|v| v.parse::<usize>().ok())
        .filter(|&n| n >= 1)
        .unwrap_or(TTS_NUM_THREADS)
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

/// Resolve and load an exact Pocket voice ID from a self-contained model
/// bundle. Voice IDs are deliberately path-safe; callers choose the bundle
/// root and this function owns the stable `voices/<id>.wav` layout.
pub fn load_pocket_voice_style(model_dir: &Path, voice_id: &str) -> Result<VoiceStyle, String> {
    if voice_id.is_empty()
        || !voice_id
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
    {
        return Err(format!("invalid Pocket voice ID: {voice_id}"));
    }
    let path = model_dir.join("voices").join(format!("{voice_id}.wav"));
    if !path.is_file() {
        return Err(format!(
            "Pocket voice {voice_id} is not installed at {}",
            path.display()
        ));
    }
    load_voice_style(&path)
}

/// Resident April INT8 Pocket TTS engine.
pub struct PocketTts {
    inner: Mutex<AprilPocketTts>,
}

/// Stable synthesis units drained from a growing assistant response.
#[derive(Debug, PartialEq, Eq)]
pub struct StreamingTextChunks {
    pub ready: Vec<String>,
    pub pending: String,
    pub first_chunk_pending: bool,
}

/// Load Berd's pinned April INT8 model.
pub fn load_text_to_speech(model_dir: &str) -> Result<PocketTts, String> {
    let dir = Path::new(model_dir);
    Ok(PocketTts {
        inner: Mutex::new(AprilPocketTts::load(dir, tts_num_threads())?),
    })
}

impl PocketTts {
    /// Drain model-safe units from text that may still be growing.
    ///
    /// The first complete sentence is made ready immediately. Later text stays
    /// pending until it overflows the model's exact token limit, at which point
    /// every stable natural chunk except the growing tail is returned. `flush`
    /// makes the tail ready at a response or tool boundary.
    pub fn take_streaming_text_chunks(
        &self,
        text: &str,
        first_chunk_pending: bool,
        flush: bool,
    ) -> Result<StreamingTextChunks, String> {
        self.reject_reentry()?;
        let mut engine = self
            .inner
            .lock()
            .map_err(|_| "Pocket TTS engine lock poisoned".to_string())?;
        let (ready, pending, first_chunk_pending) =
            engine.take_streaming_text_chunks(text, first_chunk_pending, flush)?;
        Ok(StreamingTextChunks {
            ready,
            pending,
            first_chunk_pending,
        })
    }

    /// Stream synthesis as PCM deltas become decoder-safe. `emit_frames` is
    /// rounded down to a positive multiple of the Mimi decoder's 12-frame
    /// chunk size. Concatenated non-empty deltas equal one `synth_chunk`
    /// result. The callback runs on the caller thread and may receive empty
    /// deltas so cancellation is observed before PCM is available. Returning
    /// `false` cancels synthesis and makes the function return `Ok(false)`.
    pub fn synth_chunk_streaming(
        &self,
        text: &str,
        style: &VoiceStyle,
        emit_frames: usize,
        on_audio: &mut dyn FnMut(Vec<f32>) -> bool,
    ) -> Result<bool, String> {
        let _call_guard = SynthesisCallGuard::enter(self as *const Self as usize)?;
        let Some(prepared) = prepare_april_prompt(text) else {
            return Ok(true);
        };
        let mut engine = self
            .inner
            .lock()
            .map_err(|_| "Pocket TTS engine lock poisoned".to_string())?;
        let chunks = engine.split_prompt(&prepared)?;
        for chunk in chunks {
            if !callback_allows_audio(on_audio, Vec::new())? {
                return Ok(false);
            }
            let prepared = prepare_april_prompt(&chunk)
                .ok_or_else(|| "Pocket TTS prompt chunk became empty".to_string())?;
            let mut callback_error = None;
            let completed =
                engine.synth_chunk_streaming(&prepared, style, emit_frames, &mut |audio| {
                    match callback_allows_audio(on_audio, audio) {
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
            if !completed {
                return Ok(false);
            }
        }
        Ok(true)
    }

    fn reject_reentry(&self) -> Result<(), String> {
        if SynthesisCallGuard::is_active(self as *const Self as usize) {
            return Err("Pocket TTS callback re-entered the active engine".to_string());
        }
        Ok(())
    }
}

fn callback_allows_audio(
    callback: &mut dyn FnMut(Vec<f32>) -> bool,
    audio: Vec<f32>,
) -> Result<bool, String> {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| callback(audio)))
        .map_err(|_| "Pocket TTS synthesis callback panicked".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn active_engine_reentry_is_rejected() {
        let _guard = SynthesisCallGuard::enter(42).expect("first call");
        assert!(SynthesisCallGuard::enter(42).is_err());
        assert!(SynthesisCallGuard::is_active(42));
    }

    #[test]
    fn callback_panic_is_reported_without_unwinding() {
        let mut callback = |_: Vec<f32>| -> bool { panic!("callback failure") };
        assert_eq!(
            callback_allows_audio(&mut callback, Vec::new()).unwrap_err(),
            "Pocket TTS synthesis callback panicked"
        );
    }

    #[test]
    fn pocket_voice_ids_cannot_escape_the_bundle() {
        let root = Path::new("/tmp/model");
        assert!(load_pocket_voice_style(root, "../mary").is_err());
        assert!(load_pocket_voice_style(root, "Mary").is_err());
        assert!(load_pocket_voice_style(root, "").is_err());
        assert!(load_pocket_voice_style(root, "mary")
            .unwrap_err()
            .contains("is not installed"));
    }
}
