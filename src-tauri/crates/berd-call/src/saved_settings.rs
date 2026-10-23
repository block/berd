use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use berd_call::{input::InputDuringTtsPolicy, StatusSoundMode, TtsSettings};
use serde::{Deserialize, Serialize};

/// Call preferences only. Agent identity, transcript routing and credentials
/// always belong to the invocation that starts the call.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct SavedSettings {
    pub arguments: Vec<String>,
    pub tts: Option<TtsSettings>,
    pub input_policy: Option<InputDuringTtsPolicy>,
    // Left out until chosen, so a file without one still opens in older berd-call.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status_sounds: Option<StatusSoundMode>,
    #[serde(default)]
    pub vad_debug_sounds: bool,
}

pub(crate) fn path() -> Result<PathBuf, String> {
    if let Some(path) = std::env::var_os("BERD_CALL_SETTINGS_FILE") {
        return Ok(PathBuf::from(path));
    }
    let root = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".config")))
        .ok_or("cannot locate call settings; set BERD_CALL_SETTINGS_FILE")?;
    Ok(root.join("berd-call/settings.json"))
}

pub(crate) fn load(path: &Path) -> Result<SavedSettings, String> {
    let file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(SavedSettings::default())
        }
        Err(error) => return Err(format!("could not read saved call settings: {error}")),
    };
    let mut bytes = Vec::new();
    file.take(65537)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() > 65536 {
        return Err("saved call settings exceed 64 KiB".into());
    }
    let settings: SavedSettings = serde_json::from_slice(&bytes)
        .map_err(|error| format!("invalid saved call settings: {error}"))?;
    validate_arguments(&settings.arguments)?;
    Ok(settings)
}

pub(crate) fn save(path: &Path, settings: &SavedSettings) -> Result<(), String> {
    validate_arguments(&settings.arguments)?;
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let mut file = tempfile::NamedTempFile::new_in(parent).map_err(|error| error.to_string())?;
    serde_json::to_writer_pretty(&mut file, settings).map_err(|error| error.to_string())?;
    file.flush()
        .and_then(|()| file.as_file().sync_all())
        .map_err(|error| error.to_string())?;
    file.persist(path)
        .map_err(|error| format!("could not save call settings: {error}"))?;
    Ok(())
}

/// Serialize read/modify/replace across calls. The stable sidecar lock is not
/// replaced with the settings inode, so all writers coordinate on one file.
pub(crate) fn update(path: &Path, change: impl FnOnce(&mut SavedSettings)) -> Result<(), String> {
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let mut lock_path = path.as_os_str().to_os_string();
    lock_path.push(".lock");
    let lock = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(PathBuf::from(lock_path))
        .map_err(|error| error.to_string())?;
    fs2::FileExt::lock_exclusive(&lock).map_err(|error| error.to_string())?;
    let mut latest = load(path)?;
    change(&mut latest);
    save(path, &latest)
}

fn validate_arguments(arguments: &[String]) -> Result<(), String> {
    if !arguments.len().is_multiple_of(2)
        || arguments.chunks_exact(2).any(|pair| {
            !matches!(
                pair[0].as_str(),
                "--tts-backend"
                    | "--stt-backend"
                    | "--mode"
                    | "--voice"
                    | "--language"
                    | "--rate"
                    | "--model-dir"
                    | "--stt-model-dir"
                    | "--spokesperson-voice"
                    | "--spokesperson-rate"
            )
        })
    {
        return Err("saved call settings contain unsupported arguments".into());
    }
    Ok(())
}

/// Explicit flags win. Changing a backend discards options that are
/// incompatible with the selected backend.
pub(crate) fn merge_arguments(saved: &[String], explicit: &[String]) -> Vec<String> {
    let overrides = |flag: &str| explicit.iter().any(|value| value == flag);
    let mut result = Vec::new();
    for pair in saved.chunks_exact(2) {
        let flag = pair[0].as_str();
        let replaced_tts = overrides("--tts-backend")
            && matches!(flag, "--voice" | "--language" | "--rate" | "--model-dir");
        let replaced_stt = overrides("--stt-backend") && flag == "--stt-model-dir";
        if !overrides(flag) && !replaced_tts && !replaced_stt {
            result.extend_from_slice(pair);
        }
    }
    result.extend_from_slice(explicit);
    result
}

pub(crate) fn persistable_arguments(arguments: &[String]) -> Vec<String> {
    let arguments: Vec<_> = arguments
        .iter()
        .filter(|argument| *argument != crate::DIRECT_AGENT_SPEECH)
        .cloned()
        .collect();
    arguments
        .chunks_exact(2)
        .filter(|pair| {
            !berd_call::detection::is_detection_flag(&pair[0])
                && !matches!(
                    pair[0].as_str(),
                    "--realtime-url"
                        | "--stt-url"
                        | "--tts-url"
                        | "--spokesperson-options"
                        | "--stt-hint"
                        | "--capture"
                )
        })
        .flatten()
        .cloned()
        .collect()
}

fn spokesperson_flag(pair: &[String]) -> bool {
    matches!(
        pair[0].as_str(),
        "--spokesperson-voice" | "--spokesperson-rate"
    )
}

/// Leaves out the Spokesperson's own voice, which only calls whose replies have theirs take.
pub(crate) fn without_spokesperson(arguments: &[String]) -> Vec<String> {
    arguments
        .chunks_exact(2)
        .filter(|pair| !spokesperson_flag(pair))
        .flatten()
        .cloned()
        .collect()
}

pub(crate) fn only_spokesperson(arguments: &[String]) -> Vec<String> {
    arguments
        .chunks_exact(2)
        .filter(|pair| spokesperson_flag(pair))
        .flatten()
        .cloned()
        .collect()
}

pub(crate) fn without_tts(arguments: &[String]) -> Vec<String> {
    arguments
        .chunks_exact(2)
        .filter(|pair| {
            !matches!(
                pair[0].as_str(),
                "--tts-backend" | "--voice" | "--language" | "--rate" | "--model-dir"
            )
        })
        .flatten()
        .cloned()
        .collect()
}

/// The same call's session options with the Spokesperson on or off. Options only one mode takes are left out of the
/// other; with the Spokesperson on, `direct` lets agents also speak in their own voice.
/// The Spokesperson keeps as close to the agents' speed as it can.
pub(crate) fn with_spokesperson(arguments: &[String], on: bool, direct: bool) -> Vec<String> {
    let mut result: Vec<_> = arguments
        .iter()
        .filter(|argument| *argument != crate::DIRECT_AGENT_SPEECH)
        .cloned()
        .collect::<Vec<_>>()
        .chunks_exact(2)
        .filter(|pair| match pair[0].as_str() {
            "--mode" => false,
            "--realtime-url" => on,
            "--stt-url" | "--capture" => !on,
            "--tts-url" => !on || direct,
            // The Spokesperson's speed follows the agents'.
            "--spokesperson-rate" => false,
            _ => on || !spokesperson_flag(pair),
        })
        .flatten()
        .cloned()
        .collect();
    result.extend([
        "--mode".into(),
        if on {
            "expert-spokesperson"
        } else {
            "conventional"
        }
        .into(),
    ]);
    if on && direct {
        // Last, since it takes no value.
        result.push(crate::DIRECT_AGENT_SPEECH.into());
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn debug_preferences_survive_without_losing_other_settings() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("settings.json");
        let settings = SavedSettings {
            arguments: vec!["--rate".into(), "1.5".into()],
            tts: Some(TtsSettings::Siri {
                voice: "Aaron".into(),
                language: "en-GB".into(),
                rate: 1.5,
            }),
            input_policy: Some(InputDuringTtsPolicy::SuppressInput),
            status_sounds: Some(StatusSoundMode::WorkingAndWaiting),
            vad_debug_sounds: true,
        };
        let expected = serde_json::to_value(&settings).unwrap();
        let mut legacy = expected.clone();
        legacy["vad_debug_sounds"] = serde_json::json!(true);
        std::fs::write(&path, serde_json::to_vec(&legacy).unwrap()).unwrap();
        let restored = load(&path).unwrap();
        assert_eq!(serde_json::to_value(&restored).unwrap(), expected);
        save(&path, &restored).unwrap();
        let written: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(written["vad_debug_sounds"], true);
        assert_eq!(written, expected);
        assert_eq!(
            serde_json::to_value(load(&path).unwrap()).unwrap(),
            expected
        );
    }

    #[test]
    fn auto_and_explicit_input_preferences_survive_reopen() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("settings.json");
        for policy in [
            InputDuringTtsPolicy::Auto,
            InputDuringTtsPolicy::AllowBargeIn,
            InputDuringTtsPolicy::SuppressInput,
        ] {
            save(
                &path,
                &SavedSettings {
                    input_policy: Some(policy),
                    ..SavedSettings::default()
                },
            )
            .unwrap();
            assert_eq!(load(&path).unwrap().input_policy, Some(policy));
        }
    }

    #[test]
    fn saved_settings_survive_reopen_and_explicit_backend_clears_dependent_flags() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("settings.json");
        let settings = SavedSettings {
            arguments: [
                "--tts-backend",
                "siri",
                "--voice",
                "Aaron",
                "--language",
                "en-US",
            ]
            .map(str::to_string)
            .to_vec(),
            ..SavedSettings::default()
        };
        save(&path, &settings).unwrap();
        assert!(
            !std::fs::read_to_string(&path)
                .unwrap()
                .contains("\"muted\""),
            "transient microphone mute was written as a preference"
        );
        let restored = load(&path).unwrap();
        assert_eq!(restored.arguments, settings.arguments);
        assert_eq!(
            merge_arguments(
                &restored.arguments,
                &["--tts-backend".into(), "openai".into()]
            ),
            vec!["--tts-backend", "openai"]
        );
    }

    #[test]
    fn settings_cannot_persist_agent_routing_or_secret_arguments() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("settings.json");
        let settings = SavedSettings {
            arguments: vec!["--codex".into(), "secret".into()],
            ..SavedSettings::default()
        };
        assert!(save(&path, &settings).is_err());
        assert!(!path.exists());
    }

    #[test]
    fn removing_tts_preferences_preserves_other_call_preferences() {
        let arguments = [
            "--mode",
            "chained",
            "--stt-backend",
            "macos",
            "--tts-backend",
            "siri",
            "--voice",
            "Aaron",
            "--language",
            "en-US",
            "--rate",
            "1.5",
        ]
        .map(str::to_string);

        assert_eq!(
            without_tts(&arguments),
            ["--mode", "chained", "--stt-backend", "macos"]
        );
    }

    #[test]
    fn turning_the_spokesperson_off_and_on_keeps_the_options_both_modes_take() {
        let strings = |values: &[&str]| {
            values
                .iter()
                .map(|value| value.to_string())
                .collect::<Vec<_>>()
        };
        let realtime = strings(&[
            "--mode",
            "expert-spokesperson",
            "--voice",
            "Aaron",
            "--rate",
            "2",
            "--spokesperson-voice",
            "cedar",
            "--spokesperson-rate",
            "1",
            "--realtime-url",
            "wss://realtime.test/",
            "--allow-direct-agent-speech",
        ]);
        let conventional = with_spokesperson(&realtime, false, true);
        assert_eq!(
            conventional,
            strings(&["--voice", "Aaron", "--rate", "2", "--mode", "conventional"])
        );
        assert_eq!(
            with_spokesperson(
                &[
                    conventional.clone(),
                    strings(&["--stt-url", "wss://stt.test/"])
                ]
                .concat(),
                true,
                true
            ),
            strings(&[
                "--voice",
                "Aaron",
                "--rate",
                "2",
                "--mode",
                "expert-spokesperson",
                "--allow-direct-agent-speech"
            ])
        );
        assert_eq!(
            with_spokesperson(&conventional, true, false),
            strings(&[
                "--voice",
                "Aaron",
                "--rate",
                "2",
                "--mode",
                "expert-spokesperson"
            ])
        );
    }
}

#[cfg(test)]
mod speech_hint_tests {
    #[test]
    fn conversation_hints_are_not_saved_for_other_calls() {
        let args = [
            "--voice",
            "Aaron",
            "--stt-hint",
            "Nora",
            "--stt-hint",
            "Zack",
        ]
        .map(String::from);
        assert_eq!(super::persistable_arguments(&args), ["--voice", "Aaron"]);
    }
}

#[cfg(test)]
mod capture_tests {
    #[test]
    fn capture_is_not_saved_for_other_calls() {
        let args = ["--voice", "Aaron", "--capture", "/tmp/captures"].map(String::from);
        assert_eq!(super::persistable_arguments(&args), ["--voice", "Aaron"]);
    }
}
