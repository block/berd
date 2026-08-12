//! Tauri commands that drive the one-time, silent onboarding migration.
//!
//! The frontend invokes these to:
//!   1. Check whether the migration has already run (`migration_status`).
//!   2. Back up the user's existing `~/.config/goose/config.yaml` before any
//!      ACP-side imports mutate it (`backup_goose_config`).
//!   3. Persist a completion marker, including the disabled extensions and the
//!      backup path, once the orchestrator finishes successfully
//!      (`mark_migration_complete`).
//!
//! The marker lives in the Tauri app data dir (`migration.json`) rather than
//! `localStorage` so it survives a webview cache wipe. The backup file uses a
//! fresh timestamp on every run, so re-runs are non-destructive.
//!
//! Goose config path resolution flows through `services::goose_config`, which
//! matches `crates/goose/src/config/paths.rs` in the goose repo.

use std::fs;
use std::path::{Path, PathBuf};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::services::goose_config;

const MARKER_FILE_NAME: &str = "migration.json";

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DisabledExtension {
    pub config_key: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MigrationStatus {
    pub done: bool,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub completed_at: Option<String>,
    #[serde(default)]
    pub disabled_extensions: Vec<DisabledExtension>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub backup_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub banner_dismissed_at: Option<String>,
    #[serde(default)]
    pub legacy_extension_cleanup_done: bool,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub legacy_extension_cleanup_completed_at: Option<String>,
    #[serde(default)]
    pub legacy_removed_extensions: Vec<DisabledExtension>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub legacy_extension_cleanup_backup_path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupResult {
    pub backed_up: bool,
    pub source_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backup_path: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarkMigrationCompleteRequest {
    #[serde(default)]
    pub disabled_extensions: Vec<DisabledExtension>,
    #[serde(default)]
    pub backup_path: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarkLegacyExtensionCleanupCompleteRequest {
    #[serde(default)]
    pub removed_extensions: Vec<DisabledExtension>,
    #[serde(default)]
    pub backup_path: Option<String>,
}

fn marker_path(app_handle: &AppHandle) -> Result<PathBuf, String> {
    app_handle
        .path()
        .app_data_dir()
        .map(|dir| dir.join(MARKER_FILE_NAME))
        .map_err(|err| format!("Failed to resolve app data directory: {err}"))
}

fn read_status_from_path(path: &Path) -> Result<MigrationStatus, String> {
    match fs::read(path) {
        Ok(bytes) => match serde_json::from_slice::<MigrationStatus>(&bytes) {
            Ok(status) => Ok(status),
            // A corrupted marker (partial write, manual edit, schema drift) would
            // otherwise pin the gate in its error state with no in-app recovery.
            // Treat it the same as a missing marker so the next boot re-runs the
            // migration and self-heals, and log loudly so we can spot it.
            Err(err) => {
                eprintln!(
                    "Migration marker '{}' is unparseable, treating as missing: {}",
                    path.display(),
                    err
                );
                Ok(MigrationStatus::default())
            }
        },
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(MigrationStatus::default()),
        Err(err) => Err(format!(
            "Failed to read migration marker '{}': {}",
            path.display(),
            err
        )),
    }
}

fn write_status_to_path(path: &Path, status: &MigrationStatus) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| {
            format!(
                "Failed to create app data directory '{}': {}",
                parent.display(),
                err
            )
        })?;
    }

    let serialized = serde_json::to_vec_pretty(status)
        .map_err(|err| format!("Failed to serialize migration marker: {err}"))?;

    fs::write(path, serialized).map_err(|err| {
        format!(
            "Failed to write migration marker '{}': {}",
            path.display(),
            err
        )
    })
}

/// Build a sibling backup path next to `source` using an ISO 8601 timestamp
/// safe for filenames (colons replaced with hyphens).
fn build_backup_path(source: &Path, now_iso: &str) -> PathBuf {
    let sanitized = now_iso.replace(':', "-");
    let file_name = source
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| goose_config::CONFIG_FILE_NAME.to_string());
    let backup_name = format!("{file_name}.backup-{sanitized}");

    match source.parent() {
        Some(parent) => parent.join(backup_name),
        None => PathBuf::from(backup_name),
    }
}

fn backup_goose_config_at(source: &Path) -> Result<BackupResult, String> {
    let source_path = source.to_string_lossy().into_owned();

    match fs::metadata(source) {
        Ok(metadata) if metadata.is_file() => {
            let now_iso = Utc::now().to_rfc3339();
            let backup = build_backup_path(source, &now_iso);
            fs::copy(source, &backup).map_err(|err| {
                format!(
                    "Failed to copy goose config '{}' to '{}': {}",
                    source.display(),
                    backup.display(),
                    err
                )
            })?;

            Ok(BackupResult {
                backed_up: true,
                source_path,
                backup_path: Some(backup.to_string_lossy().into_owned()),
            })
        }
        Ok(_) => Ok(BackupResult {
            backed_up: false,
            source_path,
            backup_path: None,
        }),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(BackupResult {
            backed_up: false,
            source_path,
            backup_path: None,
        }),
        Err(err) => Err(format!(
            "Failed to inspect goose config '{}': {}",
            source.display(),
            err
        )),
    }
}

#[tauri::command]
pub fn migration_status(app_handle: AppHandle) -> Result<MigrationStatus, String> {
    let marker = marker_path(&app_handle)?;
    read_status_from_path(&marker)
}

#[tauri::command]
pub fn backup_goose_config() -> Result<BackupResult, String> {
    let source = goose_config::config_path()?;
    backup_goose_config_at(&source)
}

#[tauri::command]
pub fn mark_migration_complete(
    app_handle: AppHandle,
    request: MarkMigrationCompleteRequest,
) -> Result<MigrationStatus, String> {
    let status = MigrationStatus {
        done: true,
        completed_at: Some(Utc::now().to_rfc3339()),
        disabled_extensions: request.disabled_extensions,
        backup_path: request.backup_path,
        banner_dismissed_at: None,
        legacy_extension_cleanup_done: false,
        legacy_extension_cleanup_completed_at: None,
        legacy_removed_extensions: Vec::new(),
        legacy_extension_cleanup_backup_path: None,
    };

    let marker = marker_path(&app_handle)?;
    write_status_to_path(&marker, &status)?;
    Ok(status)
}

fn dismiss_migration_banner_at(path: &Path, now_iso: &str) -> Result<MigrationStatus, String> {
    let mut status = read_status_from_path(path)?;
    if !status.done {
        return Ok(status);
    }
    if status.banner_dismissed_at.is_none() {
        status.banner_dismissed_at = Some(now_iso.to_string());
        write_status_to_path(path, &status)?;
    }
    Ok(status)
}

/// Stamp that the stale legacy bundled-extension cleanup has run. The cleanup
/// may run after the original onboarding migration for existing users, so this
/// updates the existing marker in place instead of overwriting migration data.
#[tauri::command]
pub fn mark_legacy_extension_cleanup_complete(
    app_handle: AppHandle,
    request: MarkLegacyExtensionCleanupCompleteRequest,
) -> Result<MigrationStatus, String> {
    let marker = marker_path(&app_handle)?;
    let mut status = read_status_from_path(&marker)?;
    status.legacy_extension_cleanup_done = true;
    status.legacy_extension_cleanup_completed_at = Some(Utc::now().to_rfc3339());
    status.legacy_removed_extensions = request.removed_extensions;
    status.legacy_extension_cleanup_backup_path = request.backup_path;
    write_status_to_path(&marker, &status)?;
    Ok(status)
}

/// Stamp the disabled-extensions banner as dismissed in the migration marker
/// so the banner stays dismissed across launches. Returns the updated status;
/// no-ops (returning the current status) when the marker hasn't been written
/// yet, since there's no banner to dismiss in that state.
#[tauri::command]
pub fn dismiss_migration_banner(app_handle: AppHandle) -> Result<MigrationStatus, String> {
    let marker = marker_path(&app_handle)?;
    dismiss_migration_banner_at(&marker, &Utc::now().to_rfc3339())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn read_status_from_path_returns_default_when_missing() {
        let dir = tempdir().unwrap();
        let marker = dir.path().join("missing.json");

        let status = read_status_from_path(&marker).unwrap();

        assert_eq!(status, MigrationStatus::default());
        assert!(!status.done);
        assert!(status.disabled_extensions.is_empty());
    }

    #[test]
    fn read_status_from_path_round_trips_written_marker() {
        let dir = tempdir().unwrap();
        let marker = dir.path().join("migration.json");
        let written = MigrationStatus {
            done: true,
            completed_at: Some("2026-05-19T12:00:00Z".to_string()),
            disabled_extensions: vec![DisabledExtension {
                config_key: "memory".to_string(),
                name: "Memory".to_string(),
            }],
            backup_path: Some("/tmp/config.yaml.backup-2026-05-19T12-00-00Z".to_string()),
            banner_dismissed_at: Some("2026-05-19T13:00:00Z".to_string()),
            ..Default::default()
        };

        write_status_to_path(&marker, &written).unwrap();
        let read = read_status_from_path(&marker).unwrap();

        assert_eq!(read, written);
    }

    #[test]
    fn read_status_from_path_treats_unparseable_marker_as_missing() {
        // A corrupted marker (partial write, manual edit, schema drift in a
        // future build) must not pin the gate in its error state; the gate's
        // Retry button just re-reads the same broken file. Falling back to the
        // default means the next boot re-runs the migration and overwrites it.
        let dir = tempdir().unwrap();
        let marker = dir.path().join("corrupt.json");
        fs::write(&marker, b"{not valid json").unwrap();

        let status = read_status_from_path(&marker).unwrap();

        assert_eq!(status, MigrationStatus::default());
        assert!(!status.done);
    }

    #[test]
    fn read_status_from_path_treats_missing_banner_dismissed_at_as_none() {
        // Markers written by older builds won't carry banner_dismissed_at;
        // the field's `#[serde(default)]` should keep us reading those as
        // "not dismissed" rather than failing to parse.
        let dir = tempdir().unwrap();
        let marker = dir.path().join("legacy.json");
        fs::write(
            &marker,
            br#"{"done":true,"completedAt":"2026-05-19T12:00:00Z","disabledExtensions":[],"backupPath":null}"#,
        )
        .unwrap();

        let read = read_status_from_path(&marker).unwrap();

        assert!(read.done);
        assert!(read.banner_dismissed_at.is_none());
    }

    #[test]
    fn write_status_to_path_creates_missing_parent_dirs() {
        let dir = tempdir().unwrap();
        let marker = dir.path().join("nested").join("again").join("marker.json");
        let written = MigrationStatus {
            done: true,
            ..MigrationStatus::default()
        };

        write_status_to_path(&marker, &written).unwrap();

        assert!(marker.exists());
        let read = read_status_from_path(&marker).unwrap();
        assert_eq!(read, written);
    }

    #[test]
    fn backup_goose_config_at_copies_existing_source() {
        let dir = tempdir().unwrap();
        let source = dir.path().join("config.yaml");
        fs::write(&source, b"GOOSE_PROVIDER: databricks\n").unwrap();

        let result = backup_goose_config_at(&source).unwrap();

        assert!(result.backed_up);
        assert_eq!(result.source_path, source.to_string_lossy());
        let backup = result.backup_path.expect("backup path must be set");
        let backup_path = PathBuf::from(&backup);
        assert!(backup_path.exists(), "backup file should exist on disk");
        assert_eq!(
            backup_path.parent(),
            source.parent(),
            "backup should sit next to the original"
        );
        let file_name = backup_path.file_name().unwrap().to_string_lossy();
        assert!(
            file_name.starts_with("config.yaml.backup-"),
            "unexpected backup filename: {file_name}"
        );
        // Filenames must avoid raw colons (Windows-hostile, ugly on macOS too).
        assert!(!file_name.contains(':'), "backup filename contains ':'");
        let original = fs::read(&source).unwrap();
        let copied = fs::read(&backup_path).unwrap();
        assert_eq!(original, copied);
    }

    #[test]
    fn backup_goose_config_at_is_noop_when_source_missing() {
        let dir = tempdir().unwrap();
        let source = dir.path().join("config.yaml");

        let result = backup_goose_config_at(&source).unwrap();

        assert!(!result.backed_up);
        assert!(result.backup_path.is_none());
        assert_eq!(result.source_path, source.to_string_lossy());
    }

    #[test]
    fn backup_goose_config_at_does_not_overwrite_on_rerun() {
        // We can't easily force a duplicate timestamp without mocking time,
        // but we can at least confirm two back-to-back runs leave both files
        // around (or produce identical filenames where the second copy is
        // still byte-equal to the first).
        let dir = tempdir().unwrap();
        let source = dir.path().join("config.yaml");
        fs::write(&source, b"first contents\n").unwrap();

        let first = backup_goose_config_at(&source).unwrap();
        let first_backup = first.backup_path.unwrap();

        fs::write(&source, b"second contents\n").unwrap();
        let second = backup_goose_config_at(&source).unwrap();
        let second_backup = second.backup_path.unwrap();

        assert!(PathBuf::from(&first_backup).exists());
        assert!(PathBuf::from(&second_backup).exists());
    }

    #[test]
    fn dismiss_migration_banner_at_writes_timestamp_when_done_and_undismissed() {
        let dir = tempdir().unwrap();
        let marker = dir.path().join("migration.json");
        let written = MigrationStatus {
            done: true,
            completed_at: Some("2026-05-19T12:00:00Z".to_string()),
            disabled_extensions: vec![DisabledExtension {
                config_key: "github".to_string(),
                name: "GitHub".to_string(),
            }],
            backup_path: None,
            banner_dismissed_at: None,
            ..Default::default()
        };
        write_status_to_path(&marker, &written).unwrap();

        let updated = dismiss_migration_banner_at(&marker, "2026-05-19T13:00:00Z").unwrap();

        assert_eq!(
            updated.banner_dismissed_at.as_deref(),
            Some("2026-05-19T13:00:00Z")
        );
        let read = read_status_from_path(&marker).unwrap();
        assert_eq!(
            read.banner_dismissed_at.as_deref(),
            Some("2026-05-19T13:00:00Z")
        );
    }

    #[test]
    fn dismiss_migration_banner_at_is_idempotent() {
        let dir = tempdir().unwrap();
        let marker = dir.path().join("migration.json");
        write_status_to_path(
            &marker,
            &MigrationStatus {
                done: true,
                completed_at: Some("2026-05-19T12:00:00Z".to_string()),
                disabled_extensions: vec![],
                backup_path: None,
                banner_dismissed_at: Some("2026-05-19T13:00:00Z".to_string()),
                ..Default::default()
            },
        )
        .unwrap();

        let updated = dismiss_migration_banner_at(&marker, "2026-05-19T14:00:00Z").unwrap();

        // The earlier timestamp wins — re-dismissal does not bump it.
        assert_eq!(
            updated.banner_dismissed_at.as_deref(),
            Some("2026-05-19T13:00:00Z")
        );
    }

    #[test]
    fn dismiss_migration_banner_at_is_noop_when_marker_missing() {
        let dir = tempdir().unwrap();
        let marker = dir.path().join("missing.json");

        let updated = dismiss_migration_banner_at(&marker, "2026-05-19T13:00:00Z").unwrap();

        assert!(!updated.done);
        assert!(updated.banner_dismissed_at.is_none());
        assert!(
            !marker.exists(),
            "no marker should be created out of thin air"
        );
    }

    #[test]
    fn build_backup_path_sanitizes_colons() {
        let source = PathBuf::from("/tmp/goose/config.yaml");
        let backup = build_backup_path(&source, "2026-05-19T12:34:56+00:00");

        let file_name = backup.file_name().unwrap().to_string_lossy();
        assert!(!file_name.contains(':'));
        assert!(file_name.starts_with("config.yaml.backup-"));
        assert_eq!(backup.parent(), Some(PathBuf::from("/tmp/goose").as_path()));
    }
}
