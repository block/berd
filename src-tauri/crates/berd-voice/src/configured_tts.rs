use std::fmt;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};

use crate::openai::OpenAiSpeechConfig;
#[cfg(target_os = "macos")]
use crate::SiriTts;

use crate::{OpenAiTts, PocketTtsBackend, TtsBackend};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(tag = "backend", rename_all = "snake_case", deny_unknown_fields)]
pub enum TtsSettings {
    #[serde(rename = "openai")]
    OpenAi {
        model: String,
        voice: String,
        rate: f32,
    },
    Siri {
        voice: String,
        language: String,
        rate: f32,
    },
    Pocket {
        model: String,
        voice: String,
        rate: f32,
    },
}

impl TtsSettings {
    pub fn voice(&self) -> &str {
        match self {
            Self::OpenAi { voice, .. } | Self::Siri { voice, .. } | Self::Pocket { voice, .. } => {
                voice
            }
        }
    }

    pub fn rate(&self) -> f32 {
        match self {
            Self::OpenAi { rate, .. } | Self::Siri { rate, .. } | Self::Pocket { rate, .. } => {
                *rate
            }
        }
    }

    fn backend_name(&self) -> &'static str {
        match self {
            Self::OpenAi { .. } => "openai",
            Self::Siri { .. } => "siri",
            Self::Pocket { .. } => "pocket",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct TtsConfigurationSnapshot {
    pub revision: u64,
    #[serde(flatten)]
    pub settings: TtsSettings,
}

#[derive(Clone)]
pub enum TtsConfiguration {
    OpenAi {
        endpoint: String,
        api_key: String,
        model: String,
        voice: String,
        rate: f32,
    },
    Siri {
        voice: String,
        language: String,
        rate: f32,
    },
    Pocket {
        model_dir: PathBuf,
        model: String,
        voice: String,
        rate: f32,
    },
}

impl fmt::Debug for TtsConfiguration {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("TtsConfiguration")
            .field("settings", &self.settings())
            .finish_non_exhaustive()
    }
}

impl TtsConfiguration {
    pub fn openai(
        endpoint: String,
        api_key: String,
        model: String,
        voice: String,
        rate: f32,
    ) -> Self {
        Self::OpenAi {
            endpoint,
            api_key,
            model,
            voice,
            rate,
        }
    }

    pub fn siri(voice: String, language: String, rate: f32) -> Self {
        Self::Siri {
            voice,
            language,
            rate,
        }
    }

    pub fn pocket(model_dir: PathBuf, model: String, voice: String, rate: f32) -> Self {
        Self::Pocket {
            model_dir,
            model,
            voice,
            rate,
        }
    }

    pub fn settings(&self) -> TtsSettings {
        match self {
            Self::OpenAi {
                model, voice, rate, ..
            } => TtsSettings::OpenAi {
                model: model.clone(),
                voice: voice.clone(),
                rate: *rate,
            },
            Self::Siri {
                voice,
                language,
                rate,
            } => TtsSettings::Siri {
                voice: voice.clone(),
                language: language.clone(),
                rate: *rate,
            },
            Self::Pocket {
                model, voice, rate, ..
            } => TtsSettings::Pocket {
                model: model.clone(),
                voice: voice.clone(),
                rate: *rate,
            },
        }
    }

    fn replacement(
        &self,
        settings: TtsSettings,
    ) -> Result<Self, (TtsConfigurationRejectionKind, String)> {
        match (self, settings) {
            (
                Self::OpenAi {
                    endpoint, api_key, ..
                },
                TtsSettings::OpenAi { model, voice, rate },
            ) => Ok(Self::openai(
                endpoint.clone(),
                api_key.clone(),
                model,
                voice,
                rate,
            )),
            (
                Self::Siri { .. },
                TtsSettings::Siri {
                    voice,
                    language,
                    rate,
                },
            ) => Ok(Self::siri(voice, language, rate)),
            (
                Self::Pocket {
                    model_dir,
                    model: current_model,
                    ..
                },
                TtsSettings::Pocket { model, voice, rate },
            ) if &model == current_model => Ok(Self::pocket(model_dir.clone(), model, voice, rate)),
            (Self::Pocket { .. }, TtsSettings::Pocket { .. }) => Err((
                TtsConfigurationRejectionKind::InvalidSettings,
                "Pocket model cannot be changed without selecting a new bundle".into(),
            )),
            (current, requested) => Err((
                TtsConfigurationRejectionKind::BackendMismatch,
                format!(
                    "cannot apply {} settings while {} TTS is active",
                    requested.backend_name(),
                    current.settings().backend_name()
                ),
            )),
        }
    }

    fn build(&self) -> Result<Arc<dyn TtsBackend>, String> {
        validate_settings(&self.settings())?;
        match self {
            Self::OpenAi {
                endpoint,
                api_key,
                model,
                voice,
                rate,
            } => OpenAiTts::new(OpenAiSpeechConfig {
                endpoint: endpoint.clone(),
                api_key: api_key.clone(),
                model: model.clone(),
                voice: voice.clone(),
                speed: *rate,
            })
            .map(|backend| Arc::new(backend) as Arc<dyn TtsBackend>),
            #[cfg(target_os = "macos")]
            Self::Siri {
                voice,
                language,
                rate,
            } => SiriTts::new(language, voice, *rate)
                .map(|backend| Arc::new(backend) as Arc<dyn TtsBackend>),
            #[cfg(not(target_os = "macos"))]
            Self::Siri { .. } => Err("Siri TTS is only available on macOS".into()),
            Self::Pocket {
                model_dir,
                voice,
                rate,
                ..
            } => PocketTtsBackend::new(model_dir, voice, *rate)
                .map(|backend| Arc::new(backend) as Arc<dyn TtsBackend>),
        }
    }
}

fn validate_settings(settings: &TtsSettings) -> Result<(), String> {
    let nonempty = |name: &str, value: &str| {
        (!value.trim().is_empty())
            .then_some(())
            .ok_or_else(|| format!("{name} must be nonempty"))
    };
    match settings {
        TtsSettings::OpenAi { model, voice, rate } => {
            nonempty("OpenAI model", model)?;
            nonempty("OpenAI voice", voice)?;
            if !rate.is_finite() || !(0.75..=2.0).contains(rate) {
                return Err("OpenAI rate must be between 0.75 and 2.0".into());
            }
        }
        TtsSettings::Siri {
            voice,
            language,
            rate,
        } => {
            nonempty("Siri voice", voice)?;
            nonempty("Siri language", language)?;
            if !rate.is_finite() || !(0.5..=2.0).contains(rate) {
                return Err("Siri rate must be between 0.5 and 2.0".into());
            }
        }
        TtsSettings::Pocket { model, voice, rate } => {
            nonempty("Pocket model", model)?;
            nonempty("Pocket voice", voice)?;
            if !rate.is_finite() || !(0.75..=2.0).contains(rate) {
                return Err("Pocket rate must be between 0.75 and 2.0".into());
            }
        }
    }
    Ok(())
}

struct ConfiguredTtsState {
    configuration: TtsConfiguration,
    backend: Arc<dyn TtsBackend>,
    snapshot: TtsConfigurationSnapshot,
}

pub struct ConfiguredTtsSlot {
    inner: Mutex<ConfiguredTtsState>,
}

impl fmt::Debug for ConfiguredTtsSlot {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ConfiguredTtsSlot")
            .field("snapshot", &self.snapshot())
            .finish_non_exhaustive()
    }
}

#[derive(Clone)]
pub struct TtsConfigurationLease {
    backend: Arc<dyn TtsBackend>,
    snapshot: TtsConfigurationSnapshot,
}

impl TtsConfigurationLease {
    pub fn backend(&self) -> &Arc<dyn TtsBackend> {
        &self.backend
    }
    pub fn snapshot(&self) -> &TtsConfigurationSnapshot {
        &self.snapshot
    }
}

pub struct TtsConfigurationReplacement {
    base_revision: u64,
    configuration: TtsConfiguration,
    backend: Arc<dyn TtsBackend>,
    settings: TtsSettings,
}

#[derive(Clone, Debug, PartialEq)]
pub struct TtsConfigurationRejection {
    pub kind: TtsConfigurationRejectionKind,
    pub message: String,
    pub snapshot: TtsConfigurationSnapshot,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TtsConfigurationRejectionKind {
    StaleRevision,
    BackendMismatch,
    InvalidSettings,
    Initialization,
    Internal,
}

impl ConfiguredTtsSlot {
    pub fn new(configuration: TtsConfiguration) -> Result<Self, String> {
        let settings = configuration.settings();
        let backend = configuration.build()?;
        Ok(Self::from_parts(configuration, backend, settings))
    }

    fn from_parts(
        configuration: TtsConfiguration,
        backend: Arc<dyn TtsBackend>,
        settings: TtsSettings,
    ) -> Self {
        Self {
            inner: Mutex::new(ConfiguredTtsState {
                configuration,
                backend,
                snapshot: TtsConfigurationSnapshot {
                    revision: 1,
                    settings,
                },
            }),
        }
    }

    pub fn snapshot(&self) -> Result<TtsConfigurationSnapshot, String> {
        self.inner
            .lock()
            .map(|state| state.snapshot.clone())
            .map_err(|_| "configured TTS lock was poisoned".into())
    }

    pub fn lease(&self) -> Result<TtsConfigurationLease, String> {
        let state = self
            .inner
            .lock()
            .map_err(|_| "configured TTS lock was poisoned".to_string())?;
        Ok(TtsConfigurationLease {
            backend: Arc::clone(&state.backend),
            snapshot: state.snapshot.clone(),
        })
    }

    /// Builds and validates a replacement without holding the slot lock.
    pub fn prepare_replacement(
        &self,
        expected_revision: u64,
        settings: TtsSettings,
    ) -> Result<TtsConfigurationReplacement, TtsConfigurationRejection> {
        let (configuration, snapshot) = {
            let state = self.inner.lock().map_err(|_| TtsConfigurationRejection {
                kind: TtsConfigurationRejectionKind::Internal,
                message: "configured TTS lock was poisoned".into(),
                snapshot: TtsConfigurationSnapshot {
                    revision: 0,
                    settings: settings.clone(),
                },
            })?;
            (state.configuration.clone(), state.snapshot.clone())
        };
        if snapshot.revision != expected_revision {
            return Err(TtsConfigurationRejection {
                kind: TtsConfigurationRejectionKind::StaleRevision,
                message: format!(
                    "stale TTS configuration revision: expected {expected_revision}, current {}",
                    snapshot.revision
                ),
                snapshot,
            });
        }
        let configuration =
            configuration
                .replacement(settings.clone())
                .map_err(|(kind, message)| TtsConfigurationRejection {
                    kind,
                    message,
                    snapshot: snapshot.clone(),
                })?;
        validate_settings(&settings).map_err(|message| TtsConfigurationRejection {
            kind: TtsConfigurationRejectionKind::InvalidSettings,
            message,
            snapshot: snapshot.clone(),
        })?;
        let backend = configuration
            .build()
            .map_err(|message| TtsConfigurationRejection {
                kind: TtsConfigurationRejectionKind::Initialization,
                message,
                snapshot: snapshot.clone(),
            })?;
        Ok(TtsConfigurationReplacement {
            base_revision: expected_revision,
            configuration,
            backend,
            settings,
        })
    }

    pub fn commit_replacement(
        &self,
        replacement: TtsConfigurationReplacement,
    ) -> Result<TtsConfigurationSnapshot, TtsConfigurationRejection> {
        let mut state = self.inner.lock().map_err(|_| TtsConfigurationRejection {
            kind: TtsConfigurationRejectionKind::Internal,
            message: "configured TTS lock was poisoned".into(),
            snapshot: TtsConfigurationSnapshot {
                revision: 0,
                settings: replacement.settings.clone(),
            },
        })?;
        if state.snapshot.revision != replacement.base_revision {
            return Err(TtsConfigurationRejection {
                kind: TtsConfigurationRejectionKind::StaleRevision,
                message: format!(
                    "stale TTS configuration revision: expected {}, current {}",
                    replacement.base_revision, state.snapshot.revision
                ),
                snapshot: state.snapshot.clone(),
            });
        }
        let revision =
            state
                .snapshot
                .revision
                .checked_add(1)
                .ok_or_else(|| TtsConfigurationRejection {
                    kind: TtsConfigurationRejectionKind::Internal,
                    message: "TTS configuration revision overflow".into(),
                    snapshot: state.snapshot.clone(),
                })?;
        state.configuration = replacement.configuration;
        state.backend = replacement.backend;
        state.snapshot = TtsConfigurationSnapshot {
            revision,
            settings: replacement.settings,
        };
        Ok(state.snapshot.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{TtsOutcome, TtsPcmSpec};
    use std::sync::atomic::AtomicBool;

    struct FakeTts;
    impl TtsBackend for FakeTts {
        fn pcm_spec(&self) -> TtsPcmSpec {
            TtsPcmSpec {
                sample_rate: 24_000,
                playback_rate: 1.0,
            }
        }
        fn synthesize(
            &self,
            _text: &str,
            _active: &AtomicBool,
            _on_frames: &mut dyn FnMut(&[f32]) -> Result<(), String>,
        ) -> Result<TtsOutcome, String> {
            Ok(TtsOutcome::Completed)
        }
    }

    impl ConfiguredTtsSlot {
        fn new_for_test(settings: TtsSettings) -> Self {
            let TtsSettings::OpenAi { model, voice, rate } = &settings else {
                panic!("test helper expects OpenAI")
            };
            Self::from_parts(
                TtsConfiguration::openai(
                    "endpoint".into(),
                    "key".into(),
                    model.clone(),
                    voice.clone(),
                    *rate,
                ),
                Arc::new(FakeTts),
                settings,
            )
        }

        fn replace_for_test(
            &self,
            expected_revision: u64,
            settings: TtsSettings,
        ) -> Result<TtsConfigurationSnapshot, TtsConfigurationRejection> {
            let snapshot = self.snapshot().unwrap();
            if snapshot.revision != expected_revision {
                return Err(TtsConfigurationRejection {
                    kind: TtsConfigurationRejectionKind::StaleRevision,
                    message: "stale".into(),
                    snapshot,
                });
            }
            let configuration = self
                .inner
                .lock()
                .unwrap()
                .configuration
                .replacement(settings.clone())
                .unwrap();
            self.commit_replacement(TtsConfigurationReplacement {
                base_revision: expected_revision,
                configuration,
                backend: Arc::new(FakeTts),
                settings,
            })
        }
    }

    #[test]
    fn snapshot_is_sanitized_and_revisioned() {
        let slot = ConfiguredTtsSlot::new(TtsConfiguration::openai(
            "https://private.invalid/v1/audio/speech".into(),
            "secret-key".into(),
            "gpt-4o-mini-tts".into(),
            "marin".into(),
            1.0,
        ))
        .unwrap();
        let json = serde_json::to_string(&slot.snapshot().unwrap()).unwrap();
        assert!(json.contains("gpt-4o-mini-tts"));
        assert!(json.contains("marin"));
        assert!(!json.contains("secret-key"));
        assert!(!json.contains("private.invalid"));
        assert_eq!(slot.snapshot().unwrap().revision, 1);
    }

    #[test]
    fn active_lease_keeps_old_configuration_and_next_lease_gets_update() {
        let slot = ConfiguredTtsSlot::new_for_test(TtsSettings::OpenAi {
            model: "model".into(),
            voice: "old".into(),
            rate: 1.0,
        });
        let old = slot.lease().unwrap();
        slot.replace_for_test(
            1,
            TtsSettings::OpenAi {
                model: "model".into(),
                voice: "new".into(),
                rate: 2.0,
            },
        )
        .unwrap();
        assert_eq!(old.snapshot().revision, 1);
        assert_eq!(old.snapshot().settings.voice(), "old");
        let next = slot.lease().unwrap();
        assert_eq!(next.snapshot().revision, 2);
        assert_eq!(next.snapshot().settings.voice(), "new");
        assert_eq!(next.snapshot().settings.rate(), 2.0);
    }

    #[test]
    fn stale_replacement_preserves_authoritative_configuration() {
        let slot = ConfiguredTtsSlot::new_for_test(TtsSettings::OpenAi {
            model: "model".into(),
            voice: "old".into(),
            rate: 1.0,
        });
        slot.replace_for_test(
            1,
            TtsSettings::OpenAi {
                model: "model".into(),
                voice: "new".into(),
                rate: 2.0,
            },
        )
        .unwrap();
        let rejection = slot
            .replace_for_test(
                1,
                TtsSettings::OpenAi {
                    model: "model".into(),
                    voice: "stale".into(),
                    rate: 1.5,
                },
            )
            .unwrap_err();
        assert_eq!(rejection.snapshot.revision, 2);
        assert_eq!(slot.snapshot().unwrap().settings.voice(), "new");
    }

    #[test]
    fn invalid_or_cross_backend_settings_leave_the_slot_unchanged() {
        let slot = ConfiguredTtsSlot::new_for_test(TtsSettings::OpenAi {
            model: "model".into(),
            voice: "voice".into(),
            rate: 1.0,
        });
        for settings in [
            TtsSettings::OpenAi {
                model: "model".into(),
                voice: "voice".into(),
                rate: 2.1,
            },
            TtsSettings::Siri {
                voice: "Aaron".into(),
                language: "en-US".into(),
                rate: 1.0,
            },
        ] {
            assert!(slot.prepare_replacement(1, settings).is_err());
            assert_eq!(slot.snapshot().unwrap().revision, 1);
        }
    }

    #[test]
    fn concurrent_preparations_commit_only_from_the_current_revision() {
        let slot = ConfiguredTtsSlot::new(TtsConfiguration::openai(
            "https://example.invalid/audio/speech".into(),
            "secret".into(),
            "model".into(),
            "initial".into(),
            1.0,
        ))
        .unwrap();
        let first = slot
            .prepare_replacement(
                1,
                TtsSettings::OpenAi {
                    model: "model".into(),
                    voice: "first".into(),
                    rate: 1.5,
                },
            )
            .unwrap();
        let second = slot
            .prepare_replacement(
                1,
                TtsSettings::OpenAi {
                    model: "model".into(),
                    voice: "second".into(),
                    rate: 2.0,
                },
            )
            .unwrap();

        assert_eq!(slot.commit_replacement(first).unwrap().revision, 2);
        let rejection = slot.commit_replacement(second).unwrap_err();
        assert_eq!(rejection.snapshot.revision, 2);
        assert_eq!(rejection.snapshot.settings.voice(), "first");
    }

    #[test]
    fn every_backend_snapshot_contains_only_public_configuration() {
        for (settings, backend) in [
            (
                TtsSettings::OpenAi {
                    model: "model".into(),
                    voice: "marin".into(),
                    rate: 2.0,
                },
                "openai",
            ),
            (
                TtsSettings::Siri {
                    voice: "Aaron".into(),
                    language: "en-US".into(),
                    rate: 1.25,
                },
                "siri",
            ),
            (
                TtsSettings::Pocket {
                    model: crate::pocket_assets::MODEL_ID.into(),
                    voice: "mary".into(),
                    rate: 1.5,
                },
                "pocket",
            ),
        ] {
            let json = serde_json::to_value(TtsConfigurationSnapshot {
                revision: 3,
                settings,
            })
            .unwrap();
            assert_eq!(json["backend"], backend);
            assert_eq!(json["revision"], 3);
            assert!(json.get("endpoint").is_none());
            assert!(json.get("api_key").is_none());
            assert!(json.get("model_dir").is_none());
        }
    }
}
