//! Device-local voice primitives for Berd.

mod pocket;

pub use pocket::{
    load_text_to_speech, load_voice_style, take_streaming_text_chunks, PocketTts,
    StreamingTextChunks, VoiceStyle, SAMPLE_RATE,
};
