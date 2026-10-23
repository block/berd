use berd_call::{detection::DetectionSettings, macos_audio_route::AudioSetup};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    io::{Read, Write},
    path::{Path, PathBuf},
};

#[derive(Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Profiles {
    profiles: BTreeMap<String, DetectionSettings>,
}

pub fn settings_for_start(
    persisted: Option<DetectionSettings>,
    configured: DetectionSettings,
    arguments: &[String],
) -> Result<DetectionSettings, String> {
    let mut settings = persisted.unwrap_or(configured);
    for pair in berd_call::detection::detection_arguments(arguments).chunks_exact(2) {
        match pair[0].as_str() {
            "--pending-utterance-timeout-ms" => {
                settings.pending_utterance_timeout_ms = configured.pending_utterance_timeout_ms
            }
            "--interim-words-wait-ms" => {
                settings.interim_words_wait_ms = configured.interim_words_wait_ms
            }
            "--listening-threshold" => settings.listening.value = configured.listening.value,
            "--interruption-threshold" => {
                settings.interruption.value = configured.interruption.value
            }
            "--dynamic-listening" => settings.listening.dynamic = configured.listening.dynamic,
            "--dynamic-interruption" => {
                settings.interruption.dynamic = configured.interruption.dynamic
            }
            "--dynamic-pending-utterance-timeout" => {
                settings.dynamic.pending_utterance_timeout =
                    configured.dynamic.pending_utterance_timeout
            }
            "--dynamic-interim-words-wait" => {
                settings.dynamic.interim_words_wait = configured.dynamic.interim_words_wait
            }
            "--dynamic-release" => settings.dynamic.release = configured.dynamic.release,
            _ => {}
        }
    }
    settings.validate()
}

pub fn path() -> Result<PathBuf, String> {
    Ok(crate::saved_settings::path()?.with_file_name("detection-profiles.json"))
}

fn key(setup: &AudioSetup) -> String {
    serde_json::to_string(&[&setup.input_uid, &setup.output_uid]).expect("device strings serialize")
}

fn read(path: &Path) -> Result<Profiles, String> {
    let file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(Profiles::default())
        }
        Err(error) => return Err(error.to_string()),
    };
    let mut bytes = Vec::new();
    file.take(65537)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() > 65536 {
        return Err("speech profiles exceed 64 KiB".into());
    }
    let profiles: Profiles = serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
    if profiles.profiles.len() > 64 {
        return Err("too many speech profiles".into());
    }
    for settings in profiles.profiles.values() {
        settings.validate()?;
    }
    Ok(profiles)
}

pub fn load(path: &Path, setup: &AudioSetup) -> Result<Option<DetectionSettings>, String> {
    Ok(read(path)?.profiles.get(&key(setup)).copied())
}

pub fn save(path: &Path, setup: &AudioSetup, settings: DetectionSettings) -> Result<(), String> {
    write(path, setup, settings, None).map(|_| ())
}

pub fn save_if_unchanged(
    path: &Path,
    setup: &AudioSetup,
    expected: Option<DetectionSettings>,
    settings: DetectionSettings,
) -> Result<bool, String> {
    write(path, setup, settings, Some(expected))
}

/// An in-memory trial. Dropping it leaves the saved profile untouched.
/// The host must not persist trial acknowledgements through its ordinary saver.
#[must_use]
pub struct PreparedTrial {
    path: PathBuf,
    setup: AudioSetup,
    persisted: Option<DetectionSettings>,
    baseline: DetectionSettings,
    settings: DetectionSettings,
}

impl PreparedTrial {
    pub fn baseline(&self) -> DetectionSettings {
        self.baseline
    }
    pub fn settings(&self) -> DetectionSettings {
        self.settings
    }
}

/// Eligibility is issued only by the shared corpus evaluator. Check the live
/// route and settings again before applying this trial.
pub fn prepare_trial(
    path: &Path,
    setup: &AudioSetup,
    current: DetectionSettings,
    candidate: &berd_call::learning_evaluation::EligibleCandidate,
) -> Result<PreparedTrial, String> {
    prepare(
        path,
        setup,
        current,
        candidate.devices(),
        candidate.baseline(),
        candidate.settings(),
    )
}

fn prepare(
    path: &Path,
    setup: &AudioSetup,
    current: DetectionSettings,
    devices: &berd_call::failure_fixtures::AudioDevices,
    baseline: DetectionSettings,
    settings: DetectionSettings,
) -> Result<PreparedTrial, String> {
    baseline.validate()?;
    settings.validate()?;
    if setup.input_uid.is_empty()
        || setup.output_uid.is_empty()
        || setup.input_uid != devices.input_uid
        || setup.output_uid != devices.output_uid
    {
        return Err("trial audio devices no longer match".into());
    }
    if current != baseline {
        return Err("trial baseline no longer matches live settings".into());
    }
    let persisted = load(path, setup)?;
    if persisted.is_some_and(|saved| saved != baseline) {
        return Err("trial baseline no longer matches saved settings".into());
    }
    Ok(PreparedTrial {
        path: path.into(),
        setup: setup.clone(),
        persisted,
        baseline,
        settings,
    })
}

/// Call only after an uninterrupted live trial has passed its health checks.
/// On failure, use baseline() to restore the live runtime before dropping the
/// trial. No saved profile changes until this guarded promotion succeeds.
pub fn finish_trial(
    trial: PreparedTrial,
    setup: &AudioSetup,
    applied: DetectionSettings,
    passed: bool,
) -> Result<bool, String> {
    if !passed {
        return Ok(false);
    }
    if setup.input_uid != trial.setup.input_uid
        || setup.output_uid != trial.setup.output_uid
        || applied != trial.settings
    {
        return Ok(false);
    }
    save_if_unchanged(&trial.path, &trial.setup, trial.persisted, trial.settings)
}

fn write(
    path: &Path,
    setup: &AudioSetup,
    settings: DetectionSettings,
    expected: Option<Option<DetectionSettings>>,
) -> Result<bool, String> {
    settings.validate()?;
    let parent = path
        .parent()
        .ok_or("speech profiles need a parent directory")?;
    std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let lock = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path.with_extension("json.lock"))
        .map_err(|error| error.to_string())?;
    fs2::FileExt::lock_exclusive(&lock).map_err(|error| error.to_string())?;
    let mut profiles = read(path)?;
    if expected.is_some_and(|expected| profiles.profiles.get(&key(setup)).copied() != expected) {
        return Ok(false);
    }
    if profiles.profiles.get(&key(setup)) == Some(&settings) {
        return Ok(true);
    }
    profiles.profiles.insert(key(setup), settings);
    if profiles.profiles.len() > 64 {
        return Err("too many speech profiles".into());
    }
    let bytes = serde_json::to_vec_pretty(&profiles).map_err(|error| error.to_string())?;
    if bytes.len() > 65536 {
        return Err("speech profiles exceed 64 KiB".into());
    }
    let mut file = tempfile::NamedTempFile::new_in(parent).map_err(|error| error.to_string())?;
    file.write_all(&bytes)
        .and_then(|()| file.as_file().sync_all())
        .map_err(|error| error.to_string())?;
    file.persist(path).map_err(|error| error.to_string())?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn setup(input: &str, output: &str) -> AudioSetup {
        AudioSetup {
            input_uid: input.into(),
            output_uid: output.into(),
            input_name: "same display name".into(),
            output_name: "same display name".into(),
        }
    }
    #[test]
    fn explicit_start_and_restart_flags_override_only_their_profile_choices() {
        let mut profile = DetectionSettings {
            pending_utterance_timeout_ms: 12345,
            ..Default::default()
        };
        profile.listening.value = 0.73;
        profile.listening.dynamic = true;
        profile.interruption.value = 0.82;
        let mut configured = DetectionSettings {
            pending_utterance_timeout_ms: 750,
            ..Default::default()
        };
        configured.listening.value = 0.8;
        configured.interruption.dynamic = true;
        let arguments = [
            "session",
            "--listening-threshold",
            "0.8",
            "--dynamic-interruption",
            "true",
        ]
        .map(str::to_string);
        let restored = settings_for_start(Some(profile), configured, &arguments).unwrap();
        assert_eq!(restored.pending_utterance_timeout_ms, 12345);
        let explicit = ["--pending-utterance-timeout-ms", "750"].map(str::to_string);
        assert_eq!(
            settings_for_start(Some(profile), configured, &explicit)
                .unwrap()
                .pending_utterance_timeout_ms,
            750
        );
        assert!(berd_call::detection::without_detection_arguments(&explicit).is_empty());
        assert_eq!(restored.listening.value, 0.8);
        assert!(restored.listening.dynamic);
        assert_eq!(restored.interruption.value, 0.82);
        assert!(restored.interruption.dynamic);
        let inherited = berd_call::detection::without_detection_arguments(&arguments);
        assert_eq!(inherited, ["session"]);
        assert_eq!(
            settings_for_start(Some(profile), configured, &inherited).unwrap(),
            profile
        );
    }

    #[test]
    fn learned_waits_and_release_persist_and_their_flags_override_only_themselves() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("profiles.json");
        let setup = setup("mic", "output");
        let mut learned = DetectionSettings {
            pending_utterance_timeout_ms: 5250,
            interim_words_wait_ms: 10500,
            ..Default::default()
        };
        learned.timing.release_ms = 332;
        learned.dynamic = berd_call::detection::Dynamic {
            pending_utterance_timeout: true,
            interim_words_wait: true,
            release: true,
        };
        save(&path, &setup, learned).unwrap();
        assert_eq!(load(&path, &setup).unwrap(), Some(learned));
        let configured = DetectionSettings {
            interim_words_wait_ms: 12000,
            ..Default::default()
        };
        let explicit = [
            "--interim-words-wait-ms",
            "12000",
            "--dynamic-release",
            "false",
        ]
        .map(str::to_string);
        let restored = settings_for_start(Some(learned), configured, &explicit).unwrap();
        assert_eq!(restored.interim_words_wait_ms, 12000);
        assert!(!restored.dynamic.release);
        assert!(restored.dynamic.pending_utterance_timeout && restored.dynamic.interim_words_wait);
        assert_eq!(restored.pending_utterance_timeout_ms, 5250);
        assert_eq!(restored.timing.release_ms, 332);
        let all_off = [
            "--dynamic-pending-utterance-timeout",
            "false",
            "--dynamic-interim-words-wait",
            "false",
        ]
        .map(str::to_string);
        assert_eq!(
            settings_for_start(Some(learned), configured, &all_off)
                .unwrap()
                .dynamic,
            berd_call::detection::Dynamic {
                release: true,
                ..Default::default()
            }
        );
    }

    #[test]
    fn profiles_saved_before_waits_and_release_learned_still_load() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("profiles.json");
        let setup = setup("mic", "output");
        let legacy = format!(
            r#"{{"profiles":{{{}:{{"listening":{{"value":0.7,"dynamic":true}},"interruption":{{"value":0.8}},"timing":{{"onset_ms":16,"release_ms":300}},"pending_utterance_timeout_ms":4000}}}}}}"#,
            serde_json::to_string(&key(&setup)).unwrap()
        );
        std::fs::write(&path, legacy).unwrap();
        let loaded = load(&path, &setup).unwrap().unwrap();
        assert_eq!(loaded.pending_utterance_timeout_ms, 4000);
        assert_eq!(loaded.interim_words_wait_ms, 10000);
        assert_eq!(loaded.dynamic, berd_call::detection::Dynamic::default());
        assert!(loaded.listening.dynamic);
    }

    #[test]
    fn late_learning_cannot_overwrite_an_explicit_profile_edit() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("profiles.json");
        let setup = setup("mic", "output");
        let original = DetectionSettings::default();
        save(&path, &setup, original).unwrap();
        let mut edited = original;
        edited.listening.value = 0.77;
        save(&path, &setup, edited).unwrap();
        let mut learned = original;
        learned.listening.value = 0.51;
        assert!(!save_if_unchanged(&path, &setup, Some(original), learned).unwrap());
        assert_eq!(load(&path, &setup).unwrap(), Some(edited));
        assert!(save_if_unchanged(&path, &setup, Some(edited), learned).unwrap());
    }

    #[test]
    fn profiles_are_isolated_by_both_stable_device_ids_and_survive_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("profiles.json");
        let airpods = setup("airpods-mic", "airpods-output");
        let mixed = setup("mac-mic", "airpods-output");
        let mut first = DetectionSettings {
            pending_utterance_timeout_ms: 12345,
            ..Default::default()
        };
        first.listening.value = 0.71;
        first.listening.dynamic = true;
        let mut second = DetectionSettings {
            pending_utterance_timeout_ms: 750,
            ..Default::default()
        };
        second.interruption.value = 0.83;
        save(&path, &airpods, first).unwrap();
        save(&path, &mixed, second).unwrap();
        assert_eq!(load(&path, &airpods).unwrap(), Some(first));
        assert_eq!(load(&path, &mixed).unwrap(), Some(second));
        assert_eq!(
            load(&path, &setup("headset-mic", "headset-output")).unwrap(),
            None
        );
        assert!(!std::fs::read_to_string(path)
            .unwrap()
            .contains("same display name"));
    }
    fn trial_at(path: &Path, setup: &AudioSetup) -> PreparedTrial {
        let baseline = DetectionSettings::default();
        let mut settings = baseline;
        settings.listening.value = 0.45;
        prepare(
            path,
            setup,
            baseline,
            &berd_call::failure_fixtures::AudioDevices {
                input_uid: setup.input_uid.clone(),
                output_uid: setup.output_uid.clone(),
            },
            baseline,
            settings,
        )
        .unwrap()
    }

    #[test]
    fn unsuccessful_or_abandoned_trials_do_not_change_saved_profiles() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("profiles.json");
        let setup = setup("mic", "speaker");
        let trial = trial_at(&path, &setup);
        assert_eq!(trial.baseline(), DetectionSettings::default());
        assert_ne!(trial.settings(), trial.baseline());
        assert!(!path.exists());
        assert!(!finish_trial(trial, &setup, DetectionSettings::default(), false).unwrap());
        assert_eq!(load(&path, &setup).unwrap(), None);
        let baseline = DetectionSettings::default();
        save(&path, &setup, baseline).unwrap();
        drop(trial_at(&path, &setup));
        assert_eq!(load(&path, &setup).unwrap(), Some(baseline));
    }

    #[test]
    fn promotion_requires_applied_candidate_original_devices_and_unchanged_profile() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("profiles.json");
        let setup = setup("mic", "speaker");
        let trial = trial_at(&path, &setup);
        let candidate = trial.settings();
        let other = super::tests::setup("mic", "headset");
        assert!(!finish_trial(trial, &other, candidate, true).unwrap());
        assert_eq!(load(&path, &setup).unwrap(), None);
        assert!(!finish_trial(
            trial_at(&path, &setup),
            &setup,
            DetectionSettings::default(),
            true
        )
        .unwrap());
        let trial = trial_at(&path, &setup);
        let mut edited = DetectionSettings::default();
        edited.listening.value = 0.8;
        save(&path, &setup, edited).unwrap();
        assert!(!finish_trial(trial, &setup, candidate, true).unwrap());
        assert_eq!(load(&path, &setup).unwrap(), Some(edited));
        assert!(prepare(
            &path,
            &setup,
            DetectionSettings::default(),
            &berd_call::failure_fixtures::AudioDevices {
                input_uid: "mic".into(),
                output_uid: "speaker".into()
            },
            DetectionSettings::default(),
            candidate
        )
        .is_err());
    }

    #[test]
    fn successful_trial_persists_only_its_own_device_pair() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("profiles.json");
        let setup = setup("mic", "speaker");
        let other = super::tests::setup("other", "speaker");
        save(&path, &other, DetectionSettings::default()).unwrap();
        let trial = trial_at(&path, &setup);
        let candidate = trial.settings();
        assert!(finish_trial(trial, &setup, candidate, true).unwrap());
        assert_eq!(load(&path, &setup).unwrap(), Some(candidate));
        assert_eq!(
            load(&path, &other).unwrap(),
            Some(DetectionSettings::default())
        );
    }

    #[test]
    fn preparation_rejects_stale_runtime_and_wrong_devices() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("profiles.json");
        let setup = setup("mic", "speaker");
        let baseline = DetectionSettings::default();
        let mut candidate = baseline;
        candidate.listening.value = 0.45;
        let devices = berd_call::failure_fixtures::AudioDevices {
            input_uid: "mic".into(),
            output_uid: "speaker".into(),
        };
        assert!(prepare(&path, &setup, candidate, &devices, baseline, candidate).is_err());
        let other = super::tests::setup("different-mic", "speaker");
        assert!(prepare(&path, &other, baseline, &devices, baseline, candidate).is_err());
    }
}
