use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::Path;
use tokio::sync::watch;

const MARKER_FILE_NAME: &str = "installation-cohort-v1.json";
const MARKER_VERSION: u32 = 1;
const CURRENT_LAYOUT_DATABASE: &str = "berd.sqlite";

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum InstallationCohort {
    FreshWithLandingV1,
    EstablishedBeforeLandingV1,
    Unknown,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InstallationCohortReadiness {
    Initializing,
    Ready(InstallationCohort),
}

#[derive(Clone, Debug)]
pub struct InstallationCohortState(pub watch::Receiver<InstallationCohortReadiness>);

#[derive(Deserialize, Serialize)]
struct InstallationCohortRecord {
    version: u32,
    cohort: InstallationCohort,
}

pub fn installation_cohort_channel() -> (
    watch::Sender<InstallationCohortReadiness>,
    InstallationCohortState,
) {
    let (sender, receiver) = watch::channel(InstallationCohortReadiness::Initializing);
    (sender, InstallationCohortState(receiver))
}

pub fn initialize_installation_cohort(
    app_data_dir: &Path,
    legacy_layout_exists: Result<bool, String>,
) -> Result<InstallationCohort, String> {
    fs::create_dir_all(app_data_dir)
        .map_err(|error| format!("Failed to create app data directory: {error}"))?;
    let marker_path = app_data_dir.join(MARKER_FILE_NAME);

    if marker_path.exists() {
        let bytes = fs::read(&marker_path)
            .map_err(|error| format!("Failed to read installation cohort marker: {error}"))?;
        let Ok(record) = serde_json::from_slice::<InstallationCohortRecord>(&bytes) else {
            return Ok(InstallationCohort::Unknown);
        };
        if record.version != MARKER_VERSION || record.cohort == InstallationCohort::Unknown {
            return Ok(InstallationCohort::Unknown);
        }
        return Ok(record.cohort);
    }

    let legacy_layout_exists = legacy_layout_exists?;
    let cohort = if app_data_dir.join(CURRENT_LAYOUT_DATABASE).is_file() || legacy_layout_exists {
        InstallationCohort::EstablishedBeforeLandingV1
    } else {
        InstallationCohort::FreshWithLandingV1
    };
    persist_marker(&marker_path, cohort)
}

fn persist_marker(path: &Path, cohort: InstallationCohort) -> Result<InstallationCohort, String> {
    let record = InstallationCohortRecord {
        version: MARKER_VERSION,
        cohort,
    };
    let parent = path
        .parent()
        .ok_or_else(|| "Installation cohort marker has no parent directory".to_string())?;
    let bytes = serde_json::to_vec(&record)
        .map_err(|error| format!("Failed to serialize installation cohort marker: {error}"))?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)
        .map_err(|error| format!("Failed to create installation cohort marker: {error}"))?;
    temporary
        .write_all(&bytes)
        .and_then(|_| temporary.as_file().sync_all())
        .map_err(|error| format!("Failed to write installation cohort marker: {error}"))?;

    match temporary.persist_noclobber(path) {
        Ok(_) => {
            sync_parent_directory(path)?;
            Ok(cohort)
        }
        Err(error) if error.error.kind() == std::io::ErrorKind::AlreadyExists => {
            read_published_cohort(path)
        }
        Err(error) => Err(format!(
            "Failed to publish installation cohort marker: {}",
            error.error
        )),
    }
}

fn read_published_cohort(path: &Path) -> Result<InstallationCohort, String> {
    let bytes = fs::read(path)
        .map_err(|error| format!("Failed to read published installation cohort marker: {error}"))?;
    let record: InstallationCohortRecord = serde_json::from_slice(&bytes)
        .map_err(|error| format!("Invalid published installation cohort marker: {error}"))?;
    if record.version != MARKER_VERSION || record.cohort == InstallationCohort::Unknown {
        return Err("Published installation cohort marker is unsupported".to_string());
    }
    Ok(record.cohort)
}

#[cfg(unix)]
fn sync_parent_directory(path: &Path) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Installation cohort marker has no parent directory".to_string())?;
    fs::File::open(parent)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| format!("Failed to sync installation cohort directory: {error}"))
}

#[cfg(not(unix))]
fn sync_parent_directory(_path: &Path) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn classifies_and_persists_a_fresh_installation() {
        let root = tempdir().unwrap();
        let first = initialize_installation_cohort(root.path(), Ok(false)).unwrap();
        assert_eq!(first, InstallationCohort::FreshWithLandingV1);

        fs::write(root.path().join(CURRENT_LAYOUT_DATABASE), b"later").unwrap();
        let second = initialize_installation_cohort(root.path(), Ok(false)).unwrap();
        assert_eq!(second, InstallationCohort::FreshWithLandingV1);
    }

    #[test]
    fn classifies_current_or_legacy_layouts_as_established() {
        let current = tempdir().unwrap();
        fs::write(current.path().join(CURRENT_LAYOUT_DATABASE), b"existing").unwrap();
        assert_eq!(
            initialize_installation_cohort(current.path(), Ok(false)).unwrap(),
            InstallationCohort::EstablishedBeforeLandingV1
        );

        let legacy = tempdir().unwrap();
        assert_eq!(
            initialize_installation_cohort(legacy.path(), Ok(true)).unwrap(),
            InstallationCohort::EstablishedBeforeLandingV1
        );
    }

    #[test]
    fn concurrent_initializers_use_the_published_winner() {
        use std::sync::{Arc, Barrier};

        let root = tempdir().unwrap();
        let path = Arc::new(root.path().to_path_buf());
        let barrier = Arc::new(Barrier::new(3));
        let handles = [false, false].map(|legacy_exists| {
            let path = Arc::clone(&path);
            let barrier = Arc::clone(&barrier);
            std::thread::spawn(move || {
                barrier.wait();
                initialize_installation_cohort(&path, Ok(legacy_exists)).unwrap()
            })
        });
        barrier.wait();

        let cohorts = handles.map(|handle| handle.join().unwrap());
        assert_eq!(cohorts[0], InstallationCohort::FreshWithLandingV1);
        assert_eq!(cohorts[1], cohorts[0]);
        assert_eq!(
            initialize_installation_cohort(&path, Ok(false)).unwrap(),
            cohorts[0]
        );
    }

    #[test]
    fn detection_failure_does_not_publish_a_fresh_marker() {
        let root = tempdir().unwrap();
        assert!(initialize_installation_cohort(root.path(), Err("unavailable".into())).is_err());
        assert!(!root.path().join(MARKER_FILE_NAME).exists());
    }

    #[test]
    fn treats_an_unsupported_marker_as_unknown_and_preserves_it() {
        let root = tempdir().unwrap();
        let marker = root.path().join(MARKER_FILE_NAME);
        fs::write(
            &marker,
            br#"{"version":2,"cohort":"fresh-with-landing-v1"}"#,
        )
        .unwrap();

        assert_eq!(
            initialize_installation_cohort(root.path(), Ok(false)).unwrap(),
            InstallationCohort::Unknown
        );
        assert!(String::from_utf8(fs::read(marker).unwrap())
            .unwrap()
            .contains("\"version\":2"));
    }
}
