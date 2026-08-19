//! Device-local voice primitives for Berd.

mod pocket;

pub use pocket::{
    april_model_info, load_text_to_speech, load_voice_style, PocketModelArtifact, PocketModelInfo,
    PocketTts, VoiceStyle, APRIL_BUNDLE_ID, APRIL_MODEL_ID, APRIL_MODEL_REVISION, DEFAULT_VOICE,
    SAMPLE_RATE, VOICE_FILE_EXT,
};
