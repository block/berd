//! Reusable voice primitives for Berd.

/// Maximum time the macOS recognizer waits for native completion after input ends.
pub const MAC_SPEECH_RECOGNITION_FINISH_TIMEOUT_SECONDS: u64 = 5;

mod asset_verification;
mod audio_output;
pub mod benchmark;
mod configured_tts;
pub mod input;
pub mod local_assets;
#[cfg(target_os = "macos")]
pub mod mac_speech;
#[cfg(target_os = "macos")]
mod macos_audio_output;
pub mod openai;
pub mod openai_realtime;
mod outbound;
mod parakeet;
pub mod parakeet_assets;
mod pocket;
pub mod pocket_assets;
pub mod protocol;
pub mod session;
pub mod siri;
mod synthesis;
mod tts;

pub use audio_output::{wait_until_drained, PcmAudioOutput};
pub use configured_tts::{
    ConfiguredTtsSlot, TtsConfiguration, TtsConfigurationLease, TtsConfigurationRejection,
    TtsConfigurationRejectionKind, TtsConfigurationReplacement, TtsConfigurationSnapshot,
    TtsSettings,
};
#[cfg(target_os = "macos")]
pub use macos_audio_output::PocketAudioPlayer;
pub use outbound::{
    estimated_spoken_through_utf8, DeliveryProgress, DeliverySegment, DrainPolicy,
    DrainTimeoutOutcome, OutboundFailure, OutboundOutcome, OutboundPlayback,
};
pub use parakeet::ParakeetRecognizer;
pub use pocket::{
    load_pocket_voice_style, load_text_to_speech, load_voice_style, take_streaming_text_chunks,
    PocketTts, StreamingTextChunks, VoiceStyle, SAMPLE_RATE,
};
#[cfg(target_os = "macos")]
pub use siri::SiriTts;
pub use synthesis::{synthesize_pcm16_wav, WavSynthesis, WavSynthesisError, WavSynthesisErrorKind};
pub use tts::{OpenAiTts, PocketTtsBackend, TtsBackend, TtsOutcome, TtsPcmSpec, TtsSynthesisEvent};
