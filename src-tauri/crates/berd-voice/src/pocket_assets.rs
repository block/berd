//! Pinned, portable Pocket TTS model and voice assets.

use crate::asset_verification::{inspect_assets, AssetInspection, PinnedAsset};
use std::path::Path;

/// Stable public identity of Berd's pinned Pocket TTS model.
pub const MODEL_ID: &str = "native-voice-v2";
pub const MODEL_LICENSE_ID: &str = "CC-BY-4.0";
pub const VOICE_LICENSE_ID: &str = "CC-BY-4.0";

/// One immutable Pocket model file.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PocketModelAsset {
    pub relative_path: &'static str,
    pub size_bytes: u64,
    pub sha256: &'static str,
    pub source_url: &'static str,
}

/// One immutable Pocket reference voice.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PocketVoiceDescriptor {
    pub id: &'static str,
    pub name: &'static str,
    pub relative_path: &'static str,
    pub size_bytes: u64,
    pub sha256: &'static str,
    pub source_url: &'static str,
}

/// Installation state for one explicit portable Pocket bundle root.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PocketAssetStatus {
    Missing,
    Invalid,
    Ready { verified_bytes: u64 },
}

const MODEL_ARTIFACTS: &[PocketModelAsset] = &[
    PocketModelAsset { relative_path: "bundle.json", size_bytes: 24_381, sha256: "bab643150f437f37df080a710520ff39ed9ebd9a339f8ebdc739f7eddfc28b3f", source_url: "https://huggingface.co/KevinAHM/pocket-tts-onnx/resolve/58a6d00cf13d239b6748cb0769f35c580a8f606c/onnx/english_2026-04/bundle.json" },
    PocketModelAsset { relative_path: "bos_before_voice.npy", size_bytes: 4_224, sha256: "f46edf4f7007b7ba4ea58831f49d003e59e167b4641c44bb3addfe9231a780b1", source_url: "https://huggingface.co/KevinAHM/pocket-tts-onnx/resolve/58a6d00cf13d239b6748cb0769f35c580a8f606c/onnx/english_2026-04/bos_before_voice.npy" },
    PocketModelAsset { relative_path: "tokenizer.model", size_bytes: 59_339, sha256: "d461765ae179566678c93091c5fa6f2984c31bbe990bf1aa62d92c64d91bc3f6", source_url: "https://huggingface.co/KevinAHM/pocket-tts-onnx/resolve/58a6d00cf13d239b6748cb0769f35c580a8f606c/onnx/english_2026-04/tokenizer.model" },
    PocketModelAsset { relative_path: "flow_lm_main_int8.onnx", size_bytes: 76_341_079, sha256: "f9bd8106b79a0192c1c43399ab938fb24900a95c1c599870d75a884e99000116", source_url: "https://huggingface.co/KevinAHM/pocket-tts-onnx/resolve/58a6d00cf13d239b6748cb0769f35c580a8f606c/onnx/english_2026-04/flow_lm_main_int8.onnx" },
    PocketModelAsset { relative_path: "flow_lm_flow_int8.onnx", size_bytes: 9_962_530, sha256: "3dd781ee5abee9e195320bf0106bebd6372a852b3b36352524ee78b40554635d", source_url: "https://huggingface.co/KevinAHM/pocket-tts-onnx/resolve/58a6d00cf13d239b6748cb0769f35c580a8f606c/onnx/english_2026-04/flow_lm_flow_int8.onnx" },
    PocketModelAsset { relative_path: "mimi_decoder_int8.onnx", size_bytes: 22_684_077, sha256: "3630450a3297a101792a6ac66619ebc70ab916b265e6220c2afaef8b1673f925", source_url: "https://huggingface.co/KevinAHM/pocket-tts-onnx/resolve/58a6d00cf13d239b6748cb0769f35c580a8f606c/onnx/english_2026-04/mimi_decoder_int8.onnx" },
    PocketModelAsset { relative_path: "mimi_encoder.onnx", size_bytes: 39_768_446, sha256: "853e2ca623b8782d94c3745ec6133bfdff7ce33d9b11128bd29ea03f28d76e3d", source_url: "https://huggingface.co/KevinAHM/pocket-tts-onnx/resolve/58a6d00cf13d239b6748cb0769f35c580a8f606c/onnx/english_2026-04/mimi_encoder.onnx" },
    PocketModelAsset { relative_path: "text_conditioner.onnx", size_bytes: 16_388_344, sha256: "4ecee995fb69f85c7a7493d11f7b5ee15d9950facc7ab3f5c9c49ef1e03847bb", source_url: "https://huggingface.co/KevinAHM/pocket-tts-onnx/resolve/58a6d00cf13d239b6748cb0769f35c580a8f606c/onnx/english_2026-04/text_conditioner.onnx" },
    PocketModelAsset { relative_path: "LICENSE", size_bytes: 18_655, sha256: "fe7b4ce83b8381cc5b216bbb4af73c570688d1b819c73bbaed8ca401f4677cd6", source_url: "https://huggingface.co/KevinAHM/pocket-tts-onnx/resolve/58a6d00cf13d239b6748cb0769f35c580a8f606c/onnx/LICENSE" },
];

const VOICES: &[PocketVoiceDescriptor] = &[
    PocketVoiceDescriptor { id: "anna", name: "Anna", relative_path: "voices/anna.wav", size_bytes: 804_630, sha256: "0a6de25cf12bf1540beb85979f306a92be81fecc051c547c5395e7e5237a3856", source_url: "https://huggingface.co/kyutai/tts-voices/resolve/323332d33f997de8394f24a193e1a76df720e01a/vctk/p228_023_enhanced.wav" },
    PocketVoiceDescriptor { id: "vera", name: "Vera", relative_path: "voices/vera.wav", size_bytes: 691_416, sha256: "309cf91a895830f15842b398f69a4962cb1f7e0bfab10e25dd27838e826c204b", source_url: "https://huggingface.co/kyutai/tts-voices/resolve/323332d33f997de8394f24a193e1a76df720e01a/vctk/p229_023_enhanced.wav" },
    PocketVoiceDescriptor { id: "fantine", name: "Fantine", relative_path: "voices/fantine.wav", size_bytes: 674_852, sha256: "5f07d4e2a3f20a15572aae885156b43ef3fc12ef3812996fd135680d9956448b", source_url: "https://huggingface.co/kyutai/tts-voices/resolve/323332d33f997de8394f24a193e1a76df720e01a/vctk/p244_023_enhanced.wav" },
    PocketVoiceDescriptor { id: "charles", name: "Charles", relative_path: "voices/charles.wav", size_bytes: 639_272, sha256: "6b681a429198f16e378d53bccb08d06939da7b00144a7696111d4f8f76be7756", source_url: "https://huggingface.co/kyutai/tts-voices/resolve/323332d33f997de8394f24a193e1a76df720e01a/vctk/p254_023_enhanced.wav" },
    PocketVoiceDescriptor { id: "paul", name: "Paul", relative_path: "voices/paul.wav", size_bytes: 717_182, sha256: "7aba504fe0b3b16478b69eb27ce6007e3cb42b0c1915b5f1c6a6024ae37d679b", source_url: "https://huggingface.co/kyutai/tts-voices/resolve/323332d33f997de8394f24a193e1a76df720e01a/vctk/p259_023_enhanced.wav" },
    PocketVoiceDescriptor { id: "eponine", name: "Eponine", relative_path: "voices/eponine.wav", size_bytes: 716_330, sha256: "a13c27fb47627b05223691a0ef2974358a18c886e6c2f9d2762ff1d02c20926b", source_url: "https://huggingface.co/kyutai/tts-voices/resolve/323332d33f997de8394f24a193e1a76df720e01a/vctk/p262_023_enhanced.wav" },
    PocketVoiceDescriptor { id: "azelma", name: "Azelma", relative_path: "voices/azelma.wav", size_bytes: 823_852, sha256: "60e3d26cdf2efdec5df712152c839928f4d5522821e6554ae11fd96c57ab1026", source_url: "https://huggingface.co/kyutai/tts-voices/resolve/323332d33f997de8394f24a193e1a76df720e01a/vctk/p303_023_enhanced.wav" },
    PocketVoiceDescriptor { id: "george", name: "George", relative_path: "voices/george.wav", size_bytes: 642_692, sha256: "29a41f93bf5236e5b21501091d7774c255d5f3d4e62fa4f9fdf0a92a793c84ae", source_url: "https://huggingface.co/kyutai/tts-voices/resolve/323332d33f997de8394f24a193e1a76df720e01a/vctk/p315_023_enhanced.wav" },
    PocketVoiceDescriptor { id: "mary", name: "Mary", relative_path: "voices/mary.wav", size_bytes: 639_084, sha256: "a35b0468382218e9f37a9a7494d1e4b74deaf18d7ced22265b4e325bb55c183f", source_url: "https://huggingface.co/kyutai/tts-voices/resolve/323332d33f997de8394f24a193e1a76df720e01a/vctk/p333_023_enhanced.wav" },
    PocketVoiceDescriptor { id: "jane", name: "Jane", relative_path: "voices/jane.wav", size_bytes: 759_340, sha256: "2f12e7f155eb3118f55425394f1b049e5b1b67bdc9b3932c8ba4521420aeb84a", source_url: "https://huggingface.co/kyutai/tts-voices/resolve/323332d33f997de8394f24a193e1a76df720e01a/vctk/p339_023_enhanced.wav" },
    PocketVoiceDescriptor { id: "michael", name: "Michael", relative_path: "voices/michael.wav", size_bytes: 751_140, sha256: "b6743e9195e5e3fd34fe9d1633ae93f7ffab787b249e45f6467d7d6f7a6ee6ad", source_url: "https://huggingface.co/kyutai/tts-voices/resolve/323332d33f997de8394f24a193e1a76df720e01a/vctk/p360_023_enhanced.wav" },
    PocketVoiceDescriptor { id: "eve", name: "Eve", relative_path: "voices/eve.wav", size_bytes: 671_872, sha256: "396e7cbd066b0f3fb6d67fa26e7904076958239d736d4390f15b5fe88feb14cd", source_url: "https://huggingface.co/kyutai/tts-voices/resolve/323332d33f997de8394f24a193e1a76df720e01a/vctk/p361_023_enhanced.wav" },
];

pub fn model_artifacts() -> &'static [PocketModelAsset] {
    MODEL_ARTIFACTS
}

pub fn voices() -> &'static [PocketVoiceDescriptor] {
    VOICES
}

pub fn download_bytes() -> u64 {
    MODEL_ARTIFACTS
        .iter()
        .map(|asset| asset.size_bytes)
        .chain(VOICES.iter().map(|voice| voice.size_bytes))
        .sum()
}

pub fn inspect(root: &Path) -> Result<PocketAssetStatus, String> {
    let manifest: Vec<_> = MODEL_ARTIFACTS
        .iter()
        .map(|asset| PinnedAsset {
            relative_path: asset.relative_path,
            size_bytes: asset.size_bytes,
            sha256: asset.sha256,
        })
        .chain(VOICES.iter().map(|voice| PinnedAsset {
            relative_path: voice.relative_path,
            size_bytes: voice.size_bytes,
            sha256: voice.sha256,
        }))
        .collect();
    Ok(match inspect_assets(root, &manifest)? {
        AssetInspection::Missing => PocketAssetStatus::Missing,
        AssetInspection::Invalid => PocketAssetStatus::Invalid,
        AssetInspection::Ready { verified_bytes } => PocketAssetStatus::Ready { verified_bytes },
    })
}

#[cfg(test)]
mod tests {
    use super::{
        download_bytes, model_artifacts, voices, MODEL_ID, MODEL_LICENSE_ID, VOICE_LICENSE_ID,
    };
    use std::collections::HashSet;

    #[test]
    fn pinned_catalog_has_stable_identity_and_safe_unique_paths() {
        assert_eq!(MODEL_ID, "native-voice-v2");
        assert_eq!(MODEL_LICENSE_ID, "CC-BY-4.0");
        assert_eq!(VOICE_LICENSE_ID, "CC-BY-4.0");
        assert_eq!(voices().len(), 12);
        assert_eq!(
            voices().iter().map(|voice| voice.id).collect::<Vec<_>>(),
            [
                "anna", "vera", "fantine", "charles", "paul", "eponine", "azelma", "george",
                "mary", "jane", "michael", "eve"
            ]
        );
        let mut paths = HashSet::new();
        for artifact in model_artifacts() {
            assert!(paths.insert(artifact.relative_path));
            assert!(artifact.size_bytes > 0);
            assert!(artifact.source_url.starts_with("https://"));
            assert_eq!(artifact.sha256.len(), 64);
        }
        let mut ids = HashSet::new();
        for voice in voices() {
            assert!(paths.insert(voice.relative_path));
            assert!(ids.insert(voice.id));
            assert!(voice.size_bytes > 0);
            assert!(voice
                .id
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-'));
            assert_eq!(voice.relative_path, format!("voices/{}.wav", voice.id));
            assert!(voice.source_url.starts_with("https://"));
            assert_eq!(voice.sha256.len(), 64);
        }
        assert_eq!(download_bytes(), 173_782_737);
        let license = model_artifacts()
            .iter()
            .find(|asset| asset.relative_path == "LICENSE")
            .expect("Pocket license asset");
        assert_eq!(license.size_bytes, 18_655);
        assert_eq!(
            license.sha256,
            "fe7b4ce83b8381cc5b216bbb4af73c570688d1b819c73bbaed8ca401f4677cd6"
        );
    }
}
