//! Berd's persisted telemetry consent and anonymous installation id, shared by
//! Berd.app and the standalone berd-call CLI so both honor one preference. The
//! caller supplies the directory: the app passes its Tauri app-data dir, and
//! the CLI resolves the same platform path. Consent is opt-in and fail-closed.

use std::{fs, io, path::Path};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub const TELEMETRY_SETTINGS_FILE_NAME: &str = "telemetry-settings.json";
pub const TELEMETRY_SETTINGS_SCHEMA_VERSION: u32 = 1;
pub const INSTALLATION_ID_FILE_NAME: &str = "telemetry-installation-id";

/// On-disk shape of the consent file. The schema version is pinned exactly: a
/// file from a future schema fails closed rather than guessing at semantics.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedTelemetrySettings {
    pub schema_version: u32,
    pub enabled: bool,
}

/// The persisted consent. A missing file is `Ok(false)`, the normal first-run
/// state; an unreadable, invalid or future-schema file is an error that callers
/// treat as disabled.
pub fn load_telemetry_consent(dir: &Path) -> Result<bool, String> {
    let path = dir.join(TELEMETRY_SETTINGS_FILE_NAME);
    let raw = match fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(format!("unreadable telemetry settings: {error}")),
    };
    match serde_json::from_str::<PersistedTelemetrySettings>(&raw) {
        Ok(settings) if settings.schema_version == TELEMETRY_SETTINGS_SCHEMA_VERSION => {
            Ok(settings.enabled)
        }
        Ok(settings) => Err(format!(
            "telemetry settings have unknown schema version {}",
            settings.schema_version
        )),
        Err(error) => Err(format!("unreadable telemetry settings: {error}")),
    }
}

/// Persists consent with a write-then-rename, so a crash never leaves a torn
/// file (which would read as disabled anyway).
pub fn persist_telemetry_consent(dir: &Path, enabled: bool) -> Result<(), String> {
    let body = serde_json::to_string_pretty(&PersistedTelemetrySettings {
        schema_version: TELEMETRY_SETTINGS_SCHEMA_VERSION,
        enabled,
    })
    .map_err(|error| format!("Failed to serialize telemetry settings: {error}"))?;
    write_atomically(dir, TELEMETRY_SETTINGS_FILE_NAME, &body)
}

/// Loads the persisted installation id, generating and persisting a fresh UUID
/// when the file is missing or holds a value the gateway would reject.
pub fn load_or_create_installation_id(dir: &Path) -> Result<String, String> {
    if let Ok(existing) = fs::read_to_string(dir.join(INSTALLATION_ID_FILE_NAME)) {
        let existing = existing.trim();
        if is_valid_installation_id(existing) {
            return Ok(existing.to_string());
        }
    }
    let id = Uuid::new_v4().to_string();
    write_atomically(dir, INSTALLATION_ID_FILE_NAME, &id)?;
    Ok(id)
}

/// Mirrors the gateway's accepted installation-id shape
/// (`^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$`).
pub fn is_valid_installation_id(value: &str) -> bool {
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    (8..=128).contains(&value.len())
        && first.is_ascii_alphanumeric()
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | ':' | '-'))
}

fn write_atomically(dir: &Path, name: &str, body: &str) -> Result<(), String> {
    fs::create_dir_all(dir)
        .map_err(|error| format!("Failed to create app data dir {}: {error}", dir.display()))?;
    let path = dir.join(name);
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, body).map_err(|error| format!("Failed to write {}: {error}", tmp.display()))?;
    fs::rename(&tmp, &path).map_err(|error| format!("Failed to persist {}: {error}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn consent_round_trips_and_fails_closed() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(load_telemetry_consent(dir.path()), Ok(false));
        persist_telemetry_consent(dir.path(), true).unwrap();
        assert_eq!(load_telemetry_consent(dir.path()), Ok(true));
        assert_eq!(
            fs::read_to_string(dir.path().join(TELEMETRY_SETTINGS_FILE_NAME)).unwrap(),
            "{\n  \"schemaVersion\": 1,\n  \"enabled\": true\n}"
        );
        for raw in ["not json", r#"{"schemaVersion":2,"enabled":true}"#, r#"{"enabled":true}"#] {
            fs::write(dir.path().join(TELEMETRY_SETTINGS_FILE_NAME), raw).unwrap();
            assert!(load_telemetry_consent(dir.path()).is_err(), "{raw}");
        }
    }

    #[test]
    fn installation_id_is_created_once_and_replaced_when_invalid() {
        let dir = tempfile::tempdir().unwrap();
        let id = load_or_create_installation_id(dir.path()).unwrap();
        assert!(is_valid_installation_id(&id));
        assert_eq!(load_or_create_installation_id(dir.path()).unwrap(), id);
        fs::write(dir.path().join(INSTALLATION_ID_FILE_NAME), "bad id").unwrap();
        assert_ne!(load_or_create_installation_id(dir.path()).unwrap(), id);
    }
}
