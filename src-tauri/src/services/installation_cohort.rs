use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

const MARKER_FILE_NAME: &str = "installation-cohort-v1.json";
const MARKER_VERSION: u32 = 1;
const CURRENT_LAYOUT_DATABASE: &str = "berd.sqlite";

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum InstallationCohort {
    FreshWithLandingV1,
    EstablishedBeforeLandingV1,
}

#[derive(Clone, Debug)]
pub struct InstallationCohortState(pub InstallationCohort);

#[derive(Deserialize, Serialize)]
struct InstallationCohortRecord {
    version: u32,
    cohort: InstallationCohort,
}

pub fn initialize_installation_cohort(
    app_data_dir: &Path,
    legacy_layout_exists: bool,
) -> Result<InstallationCohortState, String> {
    fs::create_dir_all(app_data_dir)
        .map_err(|error| format!("Failed to create app data directory: {error}"))?;
    let marker_path = app_data_dir.join(MARKER_FILE_NAME);

    if marker_path.exists() {
        let bytes = fs::read(&marker_path)
            .map_err(|error| format!("Failed to read installation cohort marker: {error}"))?;
        let Ok(record) = serde_json::from_slice::<InstallationCohortRecord>(&bytes) else {
            return Ok(InstallationCohortState(
                InstallationCohort::EstablishedBeforeLandingV1,
            ));
        };
        if record.version != MARKER_VERSION {
            return Ok(InstallationCohortState(
                InstallationCohort::EstablishedBeforeLandingV1,
            ));
        }
        return Ok(InstallationCohortState(record.cohort));
    }

    let cohort = if app_data_dir.join(CURRENT_LAYOUT_DATABASE).is_file() || legacy_layout_exists {
        InstallationCohort::EstablishedBeforeLandingV1
    } else {
        InstallationCohort::FreshWithLandingV1
    };
    persist_marker(&marker_path, cohort)?;
    Ok(InstallationCohortState(cohort))
}

fn persist_marker(path: &Path, cohort: InstallationCohort) -> Result<(), String> {
    let record = InstallationCohortRecord {
        version: MARKER_VERSION,
        cohort,
    };
    let bytes = serde_json::to_vec(&record)
        .map_err(|error| format!("Failed to serialize installation cohort marker: {error}"))?;
    let part_path = part_path(path);
    let mut file = fs::File::create(&part_path)
        .map_err(|error| format!("Failed to create installation cohort marker: {error}"))?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|error| format!("Failed to write installation cohort marker: {error}"))?;
    fs::rename(&part_path, path)
        .map_err(|error| format!("Failed to publish installation cohort marker: {error}"))
}

fn part_path(path: &Path) -> PathBuf {
    path.with_extension("json.part")
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn classifies_and_persists_a_fresh_installation() {
        let root = tempdir().unwrap();
        let first = initialize_installation_cohort(root.path(), false).unwrap();
        assert_eq!(first.0, InstallationCohort::FreshWithLandingV1);

        fs::write(root.path().join(CURRENT_LAYOUT_DATABASE), b"later").unwrap();
        let second = initialize_installation_cohort(root.path(), false).unwrap();
        assert_eq!(second.0, InstallationCohort::FreshWithLandingV1);
    }

    #[test]
    fn classifies_current_or_legacy_layouts_as_established() {
        let current = tempdir().unwrap();
        fs::write(current.path().join(CURRENT_LAYOUT_DATABASE), b"existing").unwrap();
        assert_eq!(
            initialize_installation_cohort(current.path(), false)
                .unwrap()
                .0,
            InstallationCohort::EstablishedBeforeLandingV1
        );

        let legacy = tempdir().unwrap();
        assert_eq!(
            initialize_installation_cohort(legacy.path(), true)
                .unwrap()
                .0,
            InstallationCohort::EstablishedBeforeLandingV1
        );
    }

    #[test]
    fn treats_an_unsupported_marker_as_established_and_preserves_it() {
        let root = tempdir().unwrap();
        let marker = root.path().join(MARKER_FILE_NAME);
        fs::write(
            &marker,
            br#"{"version":2,"cohort":"fresh-with-landing-v1"}"#,
        )
        .unwrap();

        assert_eq!(
            initialize_installation_cohort(root.path(), false)
                .unwrap()
                .0,
            InstallationCohort::EstablishedBeforeLandingV1
        );
        assert!(String::from_utf8(fs::read(marker).unwrap())
            .unwrap()
            .contains("\"version\":2"));
    }
}
