use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use crate::openai::{stream_openai_pcm, OpenAiPcmOutcome, OpenAiSpeechConfig};
use crate::{load_pocket_voice_style, load_text_to_speech, PocketTts, VoiceStyle, SAMPLE_RATE};

const OPENAI_MAX_TTS_INPUT_CHARS: usize = 4096;

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

/// Stable synthesis units drained from a growing assistant response.
#[derive(Debug, PartialEq, Eq)]
pub struct StreamingTextChunks {
    pub ready: Vec<StreamingTextChunk>,
    pub pending: String,
}

/// One provider-safe piece of a speech block.
#[derive(Debug, PartialEq, Eq)]
pub struct StreamingTextChunk {
    pub text: String,
    /// True only for the first provider piece in a prose paragraph or Markdown list.
    pub starts_speech_block: bool,
    /// True only for the final provider piece in a prose paragraph or Markdown list.
    pub ends_speech_block: bool,
}

/// Drain complete speech blocks while retaining text that may still grow.
///
/// A speech block is one prose paragraph or one whole Markdown list, including
/// adjacent list items and their indented explanations. A possible list marker
/// at the streaming tail remains pending until it can be classified.
pub(crate) fn take_streaming_text_chunks(text: &str, flush: bool) -> StreamingTextChunks {
    let mut pending = text.trim_start().to_string();
    let mut ready = Vec::new();

    while let Some(end) = first_stable_speech_block_end(&pending) {
        ready.push(StreamingTextChunk {
            text: pending[..end].to_string(),
            starts_speech_block: true,
            ends_speech_block: true,
        });
        pending = pending[end..].trim_start().to_string();
    }

    if flush && !pending.is_empty() {
        ready.push(StreamingTextChunk {
            text: std::mem::take(&mut pending),
            starts_speech_block: true,
            ends_speech_block: true,
        });
    }

    StreamingTextChunks { ready, pending }
}

fn first_stable_speech_block_end(text: &str) -> Option<usize> {
    let mut saw_line_break = false;
    for (offset, ch) in text.char_indices() {
        if ch == '\n' {
            if saw_line_break {
                let separator_end = offset + ch.len_utf8();
                let mut end = separator_end;
                while text[end..].chars().next().is_some_and(char::is_whitespace) {
                    end += text[end..]
                        .chars()
                        .next()
                        .expect("checked above")
                        .len_utf8();
                }
                if end == text.len() {
                    return None;
                }
                if starts_markdown_list_item(text)
                    && (starts_markdown_list_item(&text[end..])
                        || could_be_incomplete_markdown_list_marker(&text[end..])
                        || next_block_is_indented(text, separator_end, end))
                {
                    saw_line_break = false;
                    continue;
                }
                return Some(end);
            }
            saw_line_break = true;
        } else if !ch.is_whitespace() {
            saw_line_break = false;
        }
    }
    None
}

fn next_block_is_indented(text: &str, separator_end: usize, content_start: usize) -> bool {
    let line_start = text[separator_end..content_start]
        .rfind('\n')
        .map_or(separator_end, |offset| separator_end + offset + 1);
    let indentation = &text[line_start..content_start];
    indentation.contains('\t') || indentation.chars().filter(|ch| *ch == ' ').count() >= 2
}

fn starts_markdown_list_item(text: &str) -> bool {
    let line = text.trim_start();
    if line.starts_with("- ") || line.starts_with("* ") || line.starts_with("+ ") {
        return true;
    }
    let marker_end = line
        .char_indices()
        .take_while(|(_, ch)| ch.is_ascii_digit())
        .last()
        .map(|(offset, ch)| offset + ch.len_utf8());
    marker_end.is_some_and(|end| {
        matches!(line[end..].chars().next(), Some('.' | ')'))
            && line[end + 1..].starts_with(char::is_whitespace)
    })
}

fn could_be_incomplete_markdown_list_marker(text: &str) -> bool {
    let line = text.trim_start();
    if matches!(line, "-" | "*" | "+") {
        return true;
    }
    let digits = line
        .bytes()
        .take_while(|byte| byte.is_ascii_digit())
        .count();
    digits > 0
        && (digits == line.len()
            || (digits + 1 == line.len()
                && matches!(line.as_bytes().get(digits), Some(b'.' | b')'))))
}

fn split_at_char_limit(text: &str, max_chars: usize) -> Vec<String> {
    debug_assert!(max_chars > 0);
    let mut chunks = Vec::new();
    let mut start = 0;
    while start < text.len() {
        let end = text[start..]
            .char_indices()
            .nth(max_chars)
            .map_or(text.len(), |(offset, _)| start + offset);
        let chunk = text[start..end].trim();
        if !chunk.is_empty() {
            chunks.push(chunk.to_string());
        }
        start = end;
    }
    chunks
}

fn apply_char_limit(mut split: StreamingTextChunks, max_chars: usize) -> StreamingTextChunks {
    split.ready = split
        .ready
        .into_iter()
        .flat_map(|chunk| {
            let pieces = split_at_char_limit(&chunk.text, max_chars);
            let last = pieces.len().saturating_sub(1);
            pieces
                .into_iter()
                .enumerate()
                .map(move |(index, text)| StreamingTextChunk {
                    text,
                    starts_speech_block: chunk.starts_speech_block && index == 0,
                    ends_speech_block: chunk.ends_speech_block && index == last,
                })
        })
        .collect();
    if split.pending.chars().count() > max_chars {
        let mut chunks = split_at_char_limit(&split.pending, max_chars);
        if let Some(pending) = chunks.pop() {
            split
                .ready
                .extend(
                    chunks
                        .into_iter()
                        .enumerate()
                        .map(|(index, text)| StreamingTextChunk {
                            text,
                            starts_speech_block: index == 0,
                            ends_speech_block: false,
                        }),
                );
            split.pending = pending;
        }
    }
    split
}

#[derive(Default)]
pub struct StreamingTtsText {
    pending: String,
    pending_block_started: bool,
}

impl StreamingTtsText {
    pub fn append(
        &mut self,
        backend: &dyn TtsBackend,
        delta: &str,
    ) -> Result<Vec<StreamingTextChunk>, String> {
        self.pending.push_str(delta);
        self.take_ready(backend, false)
    }

    pub fn flush(&mut self, backend: &dyn TtsBackend) -> Result<Vec<StreamingTextChunk>, String> {
        self.take_ready(backend, true)
    }

    fn take_ready(
        &mut self,
        backend: &dyn TtsBackend,
        flush: bool,
    ) -> Result<Vec<StreamingTextChunk>, String> {
        let mut split = backend.take_streaming_text_chunks(&self.pending, flush)?;
        if self.pending_block_started {
            if let Some(first) = split.ready.first_mut() {
                first.starts_speech_block = false;
            }
        }
        if let Some(last) = split.ready.last() {
            self.pending_block_started = !last.ends_speech_block;
        }
        self.pending = split.pending;
        Ok(split.ready)
    }
}

/// A backend-neutral source of normalized mono, unit-scale Float32 PCM.
///
/// Turn admission, output-device ownership, buffering, playback, and delivery
/// events remain the session host's responsibility.
pub trait TtsBackend: Send + Sync {
    fn pcm_spec(&self) -> TtsPcmSpec;

    /// Drains stable synthesis units while retaining the growing text tail.
    /// Backends may override this only to honor an actual provider limit.
    fn take_streaming_text_chunks(
        &self,
        text: &str,
        flush: bool,
    ) -> Result<StreamingTextChunks, String> {
        Ok(take_streaming_text_chunks(text, flush))
    }

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

    fn take_streaming_text_chunks(
        &self,
        text: &str,
        flush: bool,
    ) -> Result<StreamingTextChunks, String> {
        self.engine.take_streaming_text_chunks(text, flush)
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

    fn take_streaming_text_chunks(
        &self,
        text: &str,
        flush: bool,
    ) -> Result<StreamingTextChunks, String> {
        Ok(apply_char_limit(
            take_streaming_text_chunks(text, flush),
            OPENAI_MAX_TTS_INPUT_CHARS,
        ))
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
    use super::{
        apply_char_limit, take_streaming_text_chunks, PocketTtsBackend, StreamingTextChunk,
        StreamingTextChunks, StreamingTtsText, TtsBackend, TtsOutcome, TtsPcmSpec,
    };
    use std::path::Path;
    use std::sync::atomic::{AtomicBool, Ordering};

    struct FakeTts;

    struct FourCharacterTts;

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

    impl TtsBackend for FourCharacterTts {
        fn pcm_spec(&self) -> TtsPcmSpec {
            FakeTts.pcm_spec()
        }

        fn take_streaming_text_chunks(
            &self,
            text: &str,
            flush: bool,
        ) -> Result<StreamingTextChunks, String> {
            Ok(apply_char_limit(take_streaming_text_chunks(text, flush), 4))
        }

        fn synthesize(
            &self,
            text: &str,
            active: &AtomicBool,
            on_frames: &mut dyn FnMut(&[f32]) -> Result<(), String>,
        ) -> Result<TtsOutcome, String> {
            FakeTts.synthesize(text, active, on_frames)
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
    fn streaming_text_accepts_deltas_and_releases_only_stable_units() {
        let backend = FakeTts;
        let mut text = StreamingTtsText::default();

        assert!(text.append(&backend, "N").unwrap().is_empty());
        assert_eq!(
            text.append(&backend, "ora waited.\n\nThe light remained")
                .unwrap(),
            [StreamingTextChunk {
                text: "Nora waited.\n\n".into(),
                starts_speech_block: true,
                ends_speech_block: true,
            }]
        );
        assert_eq!(
            text.flush(&backend).unwrap(),
            [StreamingTextChunk {
                text: "The light remained".into(),
                starts_speech_block: true,
                ends_speech_block: true,
            }]
        );
        assert!(text.flush(&backend).unwrap().is_empty());
    }

    #[test]
    fn streaming_text_waits_for_a_partial_list_marker() {
        let split = take_streaming_text_chunks("- First.\n\n-", false);

        assert!(split.ready.is_empty());
        assert_eq!(split.pending, "- First.\n\n-");

        let split = take_streaming_text_chunks("1. First.\n\n2.", false);

        assert!(split.ready.is_empty());
        assert_eq!(split.pending, "1. First.\n\n2.");

        let split = take_streaming_text_chunks("- First.\n\n- Second.\n\nAfter", false);
        assert_eq!(
            split.ready,
            [StreamingTextChunk {
                text: "- First.\n\n- Second.\n\n".into(),
                starts_speech_block: true,
                ends_speech_block: true,
            }]
        );
        assert_eq!(split.pending, "After");
    }

    #[test]
    fn provider_character_limit_releases_only_stable_overflow() {
        let split = apply_char_limit(
            StreamingTextChunks {
                ready: vec![StreamingTextChunk {
                    text: "12345678".into(),
                    starts_speech_block: true,
                    ends_speech_block: true,
                }],
                pending: "abcdéfg".into(),
            },
            4,
        );

        assert_eq!(
            split.ready,
            [
                StreamingTextChunk {
                    text: "1234".into(),
                    starts_speech_block: true,
                    ends_speech_block: false,
                },
                StreamingTextChunk {
                    text: "5678".into(),
                    starts_speech_block: false,
                    ends_speech_block: true,
                },
                StreamingTextChunk {
                    text: "abcd".into(),
                    starts_speech_block: true,
                    ends_speech_block: false,
                },
            ]
        );
        assert_eq!(split.pending, "éfg");
    }

    #[test]
    fn provider_splits_do_not_create_false_speech_block_boundaries() {
        let backend = FourCharacterTts;
        let mut text = StreamingTtsText::default();

        assert_eq!(
            text.append(&backend, "abcdefghij").unwrap(),
            [
                StreamingTextChunk {
                    text: "abcd".into(),
                    starts_speech_block: true,
                    ends_speech_block: false,
                },
                StreamingTextChunk {
                    text: "efgh".into(),
                    starts_speech_block: false,
                    ends_speech_block: false,
                },
            ]
        );
        assert_eq!(
            text.flush(&backend).unwrap(),
            [StreamingTextChunk {
                text: "ij".into(),
                starts_speech_block: false,
                ends_speech_block: true,
            }]
        );
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
