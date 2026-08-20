//! Device-local voice primitives for Berd.

mod pocket;

pub use pocket::{
    load_text_to_speech, load_voice_style, PocketTts, SynthesisOutcome, VoiceStyle, SAMPLE_RATE,
};
