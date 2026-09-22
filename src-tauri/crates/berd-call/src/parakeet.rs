use std::path::Path;

use sherpa_onnx::{OfflineRecognizer, OfflineRecognizerConfig};

/// A loaded Parakeet recognizer for complete 16 kHz mono utterances.
pub struct ParakeetRecognizer {
    recognizer: OfflineRecognizer,
}

impl ParakeetRecognizer {
    /// Loads a compatible Parakeet model bundle from an explicit directory.
    pub fn load(model_dir: &Path) -> Result<Self, String> {
        let config = recognizer_config(model_dir);
        let recognizer = OfflineRecognizer::create(&config)
            .ok_or_else(|| "Could not load the Parakeet speech model.".to_string())?;
        Ok(Self { recognizer })
    }

    /// Recognizes one complete utterance of 16 kHz mono Float32 PCM.
    pub fn recognize_utterance(&self, samples: &[f32]) -> String {
        let stream = self.recognizer.create_stream();
        stream.accept_waveform(16_000, samples);
        self.recognizer.decode(&stream);
        stream
            .get_result()
            .map(|result| result.text.trim().to_string())
            .unwrap_or_default()
    }
}

fn recognizer_config(model_dir: &Path) -> OfflineRecognizerConfig {
    let mut config = OfflineRecognizerConfig::default();
    config.model_config.nemo_ctc.model = Some(
        model_dir
            .join("model.int8.onnx")
            .to_string_lossy()
            .into_owned(),
    );
    config.model_config.tokens = Some(model_dir.join("tokens.txt").to_string_lossy().into_owned());
    config.model_config.num_threads = 1;
    config.model_config.debug = false;
    config
}

#[cfg(test)]
mod tests {
    use super::{recognizer_config, ParakeetRecognizer};
    use std::path::Path;

    #[test]
    fn parakeet_config_uses_the_portable_bundle_layout() {
        let model_dir = Path::new("models").join("parakeet");
        let config = recognizer_config(&model_dir);
        let model = model_dir.join("model.int8.onnx");
        let tokens = model_dir.join("tokens.txt");
        assert_eq!(
            config.model_config.nemo_ctc.model.as_deref(),
            Some(model.to_string_lossy().as_ref())
        );
        assert_eq!(
            config.model_config.tokens.as_deref(),
            Some(tokens.to_string_lossy().as_ref())
        );
        assert_eq!(config.model_config.num_threads, 1);
        assert!(!config.model_config.debug);
    }

    #[test]
    #[ignore = "requires BERD_PARAKEET_TEST_MODEL_DIR with a complete Parakeet bundle"]
    fn installed_model_loads_and_decodes_silence() {
        let model_dir = std::env::var("BERD_PARAKEET_TEST_MODEL_DIR").unwrap();
        let recognizer = ParakeetRecognizer::load(Path::new(&model_dir)).unwrap();
        assert_eq!(recognizer.recognize_utterance(&[0.0; 16_000]), "");
    }
}
