//! Reusable voice primitives for Berd.

/// Maximum time the macOS recognizer waits for native completion after input ends.
pub const MAC_SPEECH_RECOGNITION_FINISH_TIMEOUT_SECONDS: u64 = 5;

mod audio_output;
pub mod input;
#[cfg(target_os = "macos")]
pub mod mac_speech;
#[cfg(target_os = "macos")]
mod macos_audio_output;
pub mod openai;
pub mod openai_realtime;
mod outbound;
mod parakeet;
mod pocket;
pub mod protocol;
pub mod session;
#[cfg(target_os = "macos")]
pub mod siri;
mod tts;

pub use audio_output::{wait_until_drained, PcmAudioOutput};
#[cfg(target_os = "macos")]
pub use macos_audio_output::PocketAudioPlayer;
pub use outbound::{
    DeliveryProgress, DeliverySegment, DrainPolicy, DrainTimeoutOutcome, OutboundFailure,
    OutboundOutcome, OutboundPlayback,
};
pub use parakeet::ParakeetRecognizer;
pub use pocket::{
    load_pocket_voice_style, load_text_to_speech, load_voice_style, take_streaming_text_chunks,
    PocketTts, StreamingTextChunks, VoiceStyle, SAMPLE_RATE,
};
#[cfg(target_os = "macos")]
pub use siri::SiriTts;
pub use tts::{OpenAiTts, PocketTtsBackend, TtsBackend, TtsOutcome, TtsPcmSpec};
