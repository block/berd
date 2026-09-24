use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use berd_call::{input::InputDuringTtsPolicy, TtsSettings};
use serde::{Deserialize, Serialize};

/// Call preferences only. Agent identity, transcript routing and credentials
/// always belong to the invocation that starts the call.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct SavedSettings {
    pub arguments: Vec<String>,
    pub tts: Option<TtsSettings>,
    pub input_policy: Option<InputDuringTtsPolicy>,
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

#[cfg(test)]
mod tests {
    use super::*;

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
}
