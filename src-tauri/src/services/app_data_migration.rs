//! One-time compatibility copy from the pre-rename Goose Internal app-owned
//! directories to Berd's app-owned directories.
//!
//! The upstream goose backend still owns `~/.goose`, `GOOSE_*`, and its
//! `Block/goose` config/state paths. This module only copies Tauri desktop app
//! data that moved because the app identifier changed from
//! `com.squareup.goose-internal` to `xyz.block.berd`.

use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Manager, Runtime};

use crate::services::diagnostic_log::{
    self, DiagnosticCategory, DiagnosticFieldValue, DiagnosticLevel,
};

const OLD_APP_IDENTIFIER: &str = "com.squareup.goose-internal";
const CURRENT_APP_IDENTIFIER: &str = "xyz.block.berd";

const OLD_DEV_APP_IDENTIFIER: &str = "com.squareup.goose-internal.dev";
const CURRENT_DEV_APP_IDENTIFIER: &str = "xyz.block.berd.dev";

const OLD_LAYOUT_DATABASE: &str = "goose-internal.sqlite";
const OLD_LAYOUT_DATABASE_WAL: &str = "goose-internal.sqlite-wal";
const OLD_LAYOUT_DATABASE_SHM: &str = "goose-internal.sqlite-shm";
const CURRENT_LAYOUT_DATABASE: &str = "berd.sqlite";
const CURRENT_LAYOUT_DATABASE_WAL: &str = "berd.sqlite-wal";
const CURRENT_LAYOUT_DATABASE_SHM: &str = "berd.sqlite-shm";

const WINDOW_STATE_FILE: &str = ".window-state.json";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AppDirectoryKind {
    Data,
    Config,
    LocalData,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct DirectoryPair {
    kind: AppDirectoryKind,
    old: PathBuf,
    current: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct CopyPlanEntry {
    label: &'static str,
    old_relative_path: PathBuf,
    current_relative_path: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct CopyCandidate {
    label: &'static str,
    old_path: PathBuf,
    current_path: PathBuf,
}

#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct AppDataMigrationSummary {
    copied: usize,
    skipped_missing: usize,
    skipped_existing: usize,
    skipped_invalid: usize,
    failed: usize,
}

/// Copy old app-owned local data before Berd services open files in the new
/// location. Failures are logged and non-fatal so a single locked/cache file
/// does not prevent app startup.
pub(crate) fn legacy_layout_database_exists<R: Runtime>(app: &AppHandle<R>) -> bool {
    legacy_directory_pairs(app)
        .ok()
        .into_iter()
        .flatten()
        .any(|pair| {
            pair.kind == AppDirectoryKind::Data && pair.old.join(OLD_LAYOUT_DATABASE).is_file()
        })
}

pub(crate) fn migrate_legacy_app_data<R: Runtime>(app: &AppHandle<R>) {
    if app
        .try_state::<crate::services::e2e_mode::E2eMode>()
        .is_some()
    {
        log::info!("Skipping legacy app data migration in isolated E2E mode");
        record_summary("skipped_e2e", &AppDataMigrationSummary::default());
        return;
    }

    let pairs = match legacy_directory_pairs(app) {
        Ok(pairs) => pairs,
        Err(error) => {
            log::warn!("Failed to resolve legacy app data migration paths: {error}");
            record_summary("resolve_failed", &AppDataMigrationSummary::default());
            return;
        }
    };

    let summary = migrate_legacy_app_data_for_pairs(&pairs);
    log::info!(
        "Berd app data migration complete: copied={}, skipped_missing={}, skipped_existing={}, skipped_invalid={}, failed={}",
        summary.copied,
        summary.skipped_missing,
        summary.skipped_existing,
        summary.skipped_invalid,
        summary.failed
    );
    record_summary("completed", &summary);
}

fn record_summary(status: &str, summary: &AppDataMigrationSummary) {
    let fields = diagnostic_log::fields([
        ("status", DiagnosticFieldValue::from(status)),
        ("copied", DiagnosticFieldValue::from(summary.copied as u64)),
        (
            "skipped_missing",
            DiagnosticFieldValue::from(summary.skipped_missing as u64),
        ),
        (
            "skipped_existing",
            DiagnosticFieldValue::from(summary.skipped_existing as u64),
        ),
        (
            "skipped_invalid",
            DiagnosticFieldValue::from(summary.skipped_invalid as u64),
        ),
        ("failed", DiagnosticFieldValue::from(summary.failed as u64)),
    ]);
    let level = if summary.failed > 0 {
        DiagnosticLevel::Warn
    } else {
        DiagnosticLevel::Info
    };
    diagnostic_log::record_event(
        level,
        DiagnosticCategory::Startup,
        "app_data_migration",
        None,
        fields,
    );
}

fn legacy_directory_pairs<R: Runtime>(app: &AppHandle<R>) -> Result<Vec<DirectoryPair>, String> {
    let current_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Failed to resolve current app data directory: {error}"))?;
    let current_config_dir = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("Failed to resolve current app config directory: {error}"))?;
    let current_local_data_dir = app
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("Failed to resolve current app local data directory: {error}"))?;

    let current_identifier = app.config().identifier.as_str();
    let old_identifier = legacy_identifier_for(current_identifier).ok_or_else(|| {
        format!("legacy app data migration is not supported for identifier {current_identifier}")
    })?;

    let old_data_dir = sibling_app_dir(&current_data_dir, current_identifier, old_identifier);
    let old_config_dir = sibling_app_dir(&current_config_dir, current_identifier, old_identifier);
    let old_local_data_dir =
        sibling_app_dir(&current_local_data_dir, current_identifier, old_identifier);

    let mut pairs = vec![DirectoryPair {
        kind: AppDirectoryKind::Data,
        old: old_data_dir,
        current: current_data_dir,
    }];

    pairs.push(DirectoryPair {
        kind: AppDirectoryKind::Config,
        old: old_config_dir,
        current: current_config_dir,
    });

    let local_data_pair = DirectoryPair {
        kind: AppDirectoryKind::LocalData,
        old: old_local_data_dir,
        current: current_local_data_dir,
    };
    if !pairs
        .iter()
        .any(|pair| pair.old == local_data_pair.old && pair.current == local_data_pair.current)
    {
        pairs.push(local_data_pair);
    }

    Ok(pairs)
}

fn legacy_identifier_for(current_identifier: &str) -> Option<&'static str> {
    match current_identifier {
        CURRENT_DEV_APP_IDENTIFIER => Some(OLD_DEV_APP_IDENTIFIER),
        CURRENT_APP_IDENTIFIER => Some(OLD_APP_IDENTIFIER),
        _ => None,
    }
}

fn sibling_app_dir(
    current_dir: &Path,
    current_identifier: &str,
    legacy_identifier: &str,
) -> PathBuf {
    if current_dir
        .file_name()
        .is_some_and(|name| name == current_identifier)
    {
        return current_dir.with_file_name(legacy_identifier);
    }

    current_dir
        .parent()
        .map(|parent| parent.join(legacy_identifier))
        .unwrap_or_else(|| PathBuf::from(legacy_identifier))
}

fn migrate_legacy_app_data_for_pairs(pairs: &[DirectoryPair]) -> AppDataMigrationSummary {
    let mut summary = AppDataMigrationSummary::default();
    for pair in pairs {
        if pair.kind == AppDirectoryKind::Data {
            migrate_layout_database(pair, &mut summary);
        }
        if pair.kind == AppDirectoryKind::LocalData {
            migrate_local_data_dir(pair, &mut summary);
        }
    }
    for candidate in migration_candidates(pairs) {
        migrate_candidate(&candidate, &mut summary);
    }
    summary
}

fn migrate_layout_database(pair: &DirectoryPair, summary: &mut AppDataMigrationSummary) {
    let old_db_path = pair.old.join(OLD_LAYOUT_DATABASE);
    let old_db_metadata = match fs::symlink_metadata(&old_db_path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            summary.skipped_missing += 1;
            log::debug!(
                "Skipping legacy app data migration for layout_database: source missing ({})",
                old_db_path.display()
            );
            return;
        }
        Err(error) => {
            summary.failed += 1;
            log::warn!(
                "Skipping legacy app data migration for layout_database: failed to inspect source {}: {error}",
                old_db_path.display()
            );
            return;
        }
    };
    if old_db_metadata.file_type().is_symlink() || !old_db_metadata.is_file() {
        summary.skipped_invalid += 1;
        log::warn!(
            "Skipping legacy app data migration for layout_database: source is not a file ({})",
            old_db_path.display()
        );
        return;
    }

    // Copying only the WAL sidecar without its main database can create an
    // unusable target. If the Berd DB already exists, the existing Berd state
    // wins and all SQLite sidecars are skipped together.
    let current_db_path = pair.current.join(CURRENT_LAYOUT_DATABASE);
    if sqlite_target_paths(pair).any(|path| path.exists()) {
        let skipped = sqlite_source_paths(pair)
            .filter(|path| path.exists())
            .count();
        summary.skipped_existing += skipped.max(1);
        log::info!(
            "Skipping legacy app data migration for layout_database: Berd database or sidecar already exists ({})",
            current_db_path.display()
        );
        return;
    }

    for candidate in sqlite_candidates(pair) {
        migrate_candidate(&candidate, summary);
    }
}

fn sqlite_candidates(pair: &DirectoryPair) -> Vec<CopyCandidate> {
    sqlite_file_names()
        .into_iter()
        .map(|(label, old_name, current_name)| CopyCandidate {
            label,
            old_path: pair.old.join(old_name),
            current_path: pair.current.join(current_name),
        })
        .collect()
}

fn sqlite_source_paths(pair: &DirectoryPair) -> impl Iterator<Item = PathBuf> + '_ {
    sqlite_file_names()
        .into_iter()
        .map(|(_, old_name, _)| pair.old.join(old_name))
}

fn sqlite_target_paths(pair: &DirectoryPair) -> impl Iterator<Item = PathBuf> + '_ {
    sqlite_file_names()
        .into_iter()
        .map(|(_, _, current_name)| pair.current.join(current_name))
}

fn sqlite_file_names() -> Vec<(&'static str, String, String)> {
    vec![
        (
            "layout_database",
            OLD_LAYOUT_DATABASE.to_string(),
            CURRENT_LAYOUT_DATABASE.to_string(),
        ),
        (
            "layout_database_wal",
            OLD_LAYOUT_DATABASE_WAL.to_string(),
            CURRENT_LAYOUT_DATABASE_WAL.to_string(),
        ),
        (
            "layout_database_shm",
            OLD_LAYOUT_DATABASE_SHM.to_string(),
            CURRENT_LAYOUT_DATABASE_SHM.to_string(),
        ),
    ]
}

fn migrate_local_data_dir(pair: &DirectoryPair, summary: &mut AppDataMigrationSummary) {
    // On Linux/Windows Tauri defaults the webview data directory to
    // `<local_data_dir>/<app_identifier>`. Copy the old app's whole local data
    // directory into Berd's local data directory, but do it per child so any
    // existing Berd-created state still wins.
    let metadata = match fs::symlink_metadata(&pair.old) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            summary.skipped_missing += 1;
            log::debug!(
                "Skipping legacy app data migration for local_data_dir: source missing ({})",
                pair.old.display()
            );
            return;
        }
        Err(error) => {
            summary.failed += 1;
            log::warn!(
                "Skipping legacy app data migration for local_data_dir: failed to inspect source {}: {error}",
                pair.old.display()
            );
            return;
        }
    };

    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        summary.skipped_invalid += 1;
        log::warn!(
            "Skipping legacy app data migration for local_data_dir: source is not a directory ({})",
            pair.old.display()
        );
        return;
    }

    let entries = match fs::read_dir(&pair.old) {
        Ok(entries) => entries,
        Err(error) => {
            summary.failed += 1;
            log::warn!(
                "Skipping legacy app data migration for local_data_dir: failed to read source {}: {error}",
                pair.old.display()
            );
            return;
        }
    };

    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                summary.failed += 1;
                log::warn!(
                    "Failed to inspect legacy local data entry in {}: {error}",
                    pair.old.display()
                );
                continue;
            }
        };
        let label = local_data_label(entry.file_name().to_string_lossy().as_ref());
        migrate_candidate(
            &CopyCandidate {
                label,
                old_path: entry.path(),
                current_path: pair.current.join(entry.file_name()),
            },
            summary,
        );
    }
}

fn local_data_label(name: &str) -> &'static str {
    if [
        OLD_APP_IDENTIFIER,
        OLD_DEV_APP_IDENTIFIER,
        CURRENT_APP_IDENTIFIER,
        CURRENT_DEV_APP_IDENTIFIER,
    ]
    .contains(&name)
    {
        "webview_data"
    } else {
        "local_data_entry"
    }
}

fn migration_candidates(pairs: &[DirectoryPair]) -> Vec<CopyCandidate> {
    let mut candidates_by_target = BTreeMap::<PathBuf, CopyCandidate>::new();

    for pair in pairs {
        for entry in copy_plan(pair.kind) {
            let old_path = pair.old.join(&entry.old_relative_path);
            let current_path = pair.current.join(&entry.current_relative_path);
            candidates_by_target
                .entry(current_path.clone())
                .or_insert(CopyCandidate {
                    label: entry.label,
                    old_path,
                    current_path,
                });
        }
    }

    candidates_by_target.into_values().collect()
}

fn copy_plan(kind: AppDirectoryKind) -> Vec<CopyPlanEntry> {
    match kind {
        AppDirectoryKind::Data => vec![
            same_name_entry("migration_marker", "migration.json"),
            same_name_entry(
                "installer_suppression_marker",
                "suppress-move-to-applications",
            ),
            same_name_entry("runtime_config", "runtime-config"),
            same_name_entry("avatar_cache", "avatars"),
            same_name_entry("artifact_cache", "artifacts"),
            same_name_entry("legacy_project_artifact_cache", "project-artifacts"),
        ],
        AppDirectoryKind::Config => vec![same_name_entry("window_state", WINDOW_STATE_FILE)],
        AppDirectoryKind::LocalData => Vec::new(),
    }
}

fn same_name_entry(label: &'static str, relative_path: &str) -> CopyPlanEntry {
    CopyPlanEntry {
        label,
        old_relative_path: PathBuf::from(relative_path),
        current_relative_path: PathBuf::from(relative_path),
    }
}

fn migrate_candidate(candidate: &CopyCandidate, summary: &mut AppDataMigrationSummary) {
    let source_metadata = match fs::symlink_metadata(&candidate.old_path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            summary.skipped_missing += 1;
            log::debug!(
                "Skipping legacy app data migration for {}: source missing ({})",
                candidate.label,
                candidate.old_path.display()
            );
            return;
        }
        Err(error) => {
            summary.failed += 1;
            log::warn!(
                "Skipping legacy app data migration for {}: failed to inspect source {}: {error}",
                candidate.label,
                candidate.old_path.display()
            );
            return;
        }
    };

    if source_metadata.file_type().is_symlink() {
        summary.skipped_invalid += 1;
        log::warn!(
            "Skipping legacy app data migration for {}: source is a symbolic link ({})",
            candidate.label,
            candidate.old_path.display()
        );
        return;
    }

    match fs::symlink_metadata(&candidate.current_path) {
        Ok(_) => {
            summary.skipped_existing += 1;
            log::info!(
                "Skipping legacy app data migration for {}: Berd target already exists ({})",
                candidate.label,
                candidate.current_path.display()
            );
            return;
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => {
            summary.failed += 1;
            log::warn!(
                "Skipping legacy app data migration for {}: failed to inspect target {}: {error}",
                candidate.label,
                candidate.current_path.display()
            );
            return;
        }
    }

    let result = if source_metadata.is_file() {
        copy_file_without_overwrite(&candidate.old_path, &candidate.current_path)
    } else if source_metadata.is_dir() {
        copy_dir_without_overwrite(&candidate.old_path, &candidate.current_path)
    } else {
        summary.skipped_invalid += 1;
        log::warn!(
            "Skipping legacy app data migration for {}: source is not a file or directory ({})",
            candidate.label,
            candidate.old_path.display()
        );
        return;
    };

    match result {
        Ok(()) => {
            summary.copied += 1;
            log::info!(
                "Migrated legacy app data for {} from {} to {}",
                candidate.label,
                candidate.old_path.display(),
                candidate.current_path.display()
            );
        }
        Err(error) => {
            cleanup_partial_target(&candidate.current_path, source_metadata.is_dir());
            summary.failed += 1;
            log::warn!(
                "Failed to migrate legacy app data for {} from {} to {}: {error}",
                candidate.label,
                candidate.old_path.display(),
                candidate.current_path.display()
            );
        }
    }
}

fn copy_file_without_overwrite(source: &Path, target: &Path) -> io::Result<()> {
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(target)
        .and_then(|mut target_file| {
            let mut source_file = fs::File::open(source)?;
            io::copy(&mut source_file, &mut target_file)?;
            Ok(())
        })
}

fn copy_dir_without_overwrite(source: &Path, target: &Path) -> io::Result<()> {
    let metadata = fs::symlink_metadata(source)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "source is not a directory",
        ));
    }

    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::create_dir(target)?;
    copy_dir_contents(source, target)
}

fn copy_dir_contents(source: &Path, target: &Path) -> io::Result<()> {
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let source_path = entry.path();
        let target_path = target.join(entry.file_name());
        let metadata = fs::symlink_metadata(&source_path)?;

        if metadata.file_type().is_symlink() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("refusing to copy symbolic link {}", source_path.display()),
            ));
        }
        if metadata.is_dir() {
            copy_dir_without_overwrite(&source_path, &target_path)?;
        } else if metadata.is_file() {
            copy_file_without_overwrite(&source_path, &target_path)?;
        }
    }

    Ok(())
}

fn cleanup_partial_target(target: &Path, is_dir: bool) {
    let result = if is_dir {
        fs::remove_dir_all(target)
    } else {
        fs::remove_file(target)
    };
    if let Err(error) = result {
        if error.kind() != io::ErrorKind::NotFound {
            log::debug!(
                "Failed to clean up partial legacy app data migration target {}: {error}",
                target.display()
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn data_pair(old: &Path, current: &Path) -> DirectoryPair {
        DirectoryPair {
            kind: AppDirectoryKind::Data,
            old: old.to_path_buf(),
            current: current.to_path_buf(),
        }
    }

    fn config_pair(old: &Path, current: &Path) -> DirectoryPair {
        DirectoryPair {
            kind: AppDirectoryKind::Config,
            old: old.to_path_buf(),
            current: current.to_path_buf(),
        }
    }

    fn local_data_pair(old: &Path, current: &Path) -> DirectoryPair {
        DirectoryPair {
            kind: AppDirectoryKind::LocalData,
            old: old.to_path_buf(),
            current: current.to_path_buf(),
        }
    }

    #[test]
    fn migration_is_noop_when_old_data_is_missing() {
        let temp = tempdir().unwrap();
        let old = temp.path().join("com.squareup.goose-internal");
        let current = temp.path().join("xyz.block.berd");

        let summary = migrate_legacy_app_data_for_pairs(&[data_pair(&old, &current)]);

        assert_eq!(summary.copied, 0);
        assert_eq!(summary.failed, 0);
        assert_eq!(
            summary.skipped_missing,
            copy_plan(AppDirectoryKind::Data).len() + 1
        );
        assert!(!current.exists());
    }

    #[test]
    fn migration_copies_sqlite_database_to_renamed_file() {
        let temp = tempdir().unwrap();
        let old = temp.path().join("com.squareup.goose-internal");
        let current = temp.path().join("xyz.block.berd");
        fs::create_dir_all(&old).unwrap();
        fs::write(old.join(OLD_LAYOUT_DATABASE), b"sqlite bytes").unwrap();
        fs::write(old.join(OLD_LAYOUT_DATABASE_WAL), b"wal bytes").unwrap();
        fs::write(old.join(OLD_LAYOUT_DATABASE_SHM), b"shm bytes").unwrap();

        let summary = migrate_legacy_app_data_for_pairs(&[data_pair(&old, &current)]);

        assert_eq!(summary.copied, 3);
        assert_eq!(summary.failed, 0);
        assert_eq!(
            fs::read(current.join(CURRENT_LAYOUT_DATABASE)).unwrap(),
            b"sqlite bytes"
        );
        assert_eq!(
            fs::read(current.join(CURRENT_LAYOUT_DATABASE_WAL)).unwrap(),
            b"wal bytes"
        );
        assert_eq!(
            fs::read(current.join(CURRENT_LAYOUT_DATABASE_SHM)).unwrap(),
            b"shm bytes"
        );
        assert!(
            old.join(OLD_LAYOUT_DATABASE).exists(),
            "old DB is copied, not moved"
        );
    }

    #[test]
    fn migration_does_not_overwrite_existing_berd_data() {
        let temp = tempdir().unwrap();
        let old = temp.path().join("com.squareup.goose-internal");
        let current = temp.path().join("xyz.block.berd");
        fs::create_dir_all(&old).unwrap();
        fs::create_dir_all(&current).unwrap();
        fs::write(old.join(OLD_LAYOUT_DATABASE), b"old sqlite").unwrap();
        fs::write(old.join(OLD_LAYOUT_DATABASE_WAL), b"old wal").unwrap();
        fs::write(current.join(CURRENT_LAYOUT_DATABASE), b"new sqlite").unwrap();

        let summary = migrate_legacy_app_data_for_pairs(&[data_pair(&old, &current)]);

        assert_eq!(summary.copied, 0);
        assert_eq!(summary.skipped_existing, 2);
        assert_eq!(
            fs::read(current.join(CURRENT_LAYOUT_DATABASE)).unwrap(),
            b"new sqlite"
        );
        assert_eq!(
            fs::read(old.join(OLD_LAYOUT_DATABASE)).unwrap(),
            b"old sqlite"
        );
    }

    #[test]
    fn migration_copies_nested_app_owned_directories() {
        let temp = tempdir().unwrap();
        let old = temp.path().join("com.squareup.goose-internal");
        let current = temp.path().join("xyz.block.berd");
        let nested_avatar = old.join("avatars").join("media").join("v1");
        let nested_runtime = old.join("runtime-config");
        fs::create_dir_all(&nested_avatar).unwrap();
        fs::create_dir_all(&nested_runtime).unwrap();
        fs::write(nested_avatar.join("bird.webm"), b"avatar bytes").unwrap();
        fs::write(nested_runtime.join("fake-endpoint.json"), b"{}").unwrap();

        let summary = migrate_legacy_app_data_for_pairs(&[data_pair(&old, &current)]);

        assert_eq!(summary.copied, 2);
        assert_eq!(summary.failed, 0);
        assert_eq!(
            fs::read(current.join("avatars/media/v1/bird.webm")).unwrap(),
            b"avatar bytes"
        );
        assert_eq!(
            fs::read(current.join("runtime-config/fake-endpoint.json")).unwrap(),
            b"{}"
        );
    }

    #[test]
    fn migration_copies_window_state_from_app_config_dir() {
        let temp = tempdir().unwrap();
        let old_data = temp.path().join("old-data");
        let current_data = temp.path().join("current-data");
        let old_config = temp.path().join("old-config");
        let current_config = temp.path().join("current-config");
        fs::create_dir_all(&old_config).unwrap();
        fs::write(old_config.join(WINDOW_STATE_FILE), b"{\"main\":{}}").unwrap();

        let summary = migrate_legacy_app_data_for_pairs(&[
            data_pair(&old_data, &current_data),
            config_pair(&old_config, &current_config),
        ]);

        assert_eq!(summary.copied, 1);
        assert_eq!(summary.failed, 0);
        assert_eq!(
            fs::read(current_config.join(WINDOW_STATE_FILE)).unwrap(),
            b"{\"main\":{}}"
        );
    }

    #[test]
    fn migration_copies_webview_local_data_from_app_local_data_dir() {
        let temp = tempdir().unwrap();
        let old_local_data = temp.path().join("old-local-data");
        let current_local_data = temp.path().join("current-local-data");
        let old_webview = old_local_data.join("Default");
        fs::create_dir_all(&old_webview).unwrap();
        fs::create_dir_all(old_local_data.join("GPUCache")).unwrap();
        fs::write(old_webview.join("Local Storage"), b"renderer state").unwrap();
        fs::write(old_local_data.join("Preferences"), b"prefs").unwrap();

        let summary = migrate_legacy_app_data_for_pairs(&[local_data_pair(
            &old_local_data,
            &current_local_data,
        )]);

        assert_eq!(summary.copied, 3);
        assert_eq!(summary.failed, 0);
        assert_eq!(
            fs::read(current_local_data.join("Default").join("Local Storage")).unwrap(),
            b"renderer state"
        );
        assert_eq!(
            fs::read(current_local_data.join("Preferences")).unwrap(),
            b"prefs"
        );
        assert!(current_local_data.join("GPUCache").is_dir());
    }

    #[test]
    fn migration_is_idempotent_on_rerun() {
        let temp = tempdir().unwrap();
        let old = temp.path().join("com.squareup.goose-internal");
        let current = temp.path().join("xyz.block.berd");
        fs::create_dir_all(&old).unwrap();
        fs::write(old.join(OLD_LAYOUT_DATABASE), b"sqlite bytes").unwrap();

        let first = migrate_legacy_app_data_for_pairs(&[data_pair(&old, &current)]);
        let second = migrate_legacy_app_data_for_pairs(&[data_pair(&old, &current)]);

        assert_eq!(first.copied, 1);
        assert_eq!(second.copied, 0);
        assert_eq!(second.skipped_existing, 1);
        assert_eq!(
            fs::read(current.join(CURRENT_LAYOUT_DATABASE)).unwrap(),
            b"sqlite bytes"
        );
    }

    #[cfg(unix)]
    #[test]
    fn migration_skips_symlink_sources() {
        let temp = tempdir().unwrap();
        let old = temp.path().join("com.squareup.goose-internal");
        let current = temp.path().join("xyz.block.berd");
        fs::create_dir_all(&old).unwrap();
        fs::write(temp.path().join("outside.sqlite"), b"outside").unwrap();
        std::os::unix::fs::symlink(
            temp.path().join("outside.sqlite"),
            old.join(OLD_LAYOUT_DATABASE),
        )
        .unwrap();

        let summary = migrate_legacy_app_data_for_pairs(&[data_pair(&old, &current)]);

        assert_eq!(summary.copied, 0);
        assert_eq!(summary.skipped_invalid, 1);
        assert!(!current.join(CURRENT_LAYOUT_DATABASE).exists());
    }

    #[test]
    fn migration_identifiers_are_explicit_and_unknown_identifiers_are_rejected() {
        assert_eq!(
            legacy_identifier_for(CURRENT_APP_IDENTIFIER),
            Some(OLD_APP_IDENTIFIER)
        );
        assert_eq!(
            legacy_identifier_for(CURRENT_DEV_APP_IDENTIFIER),
            Some(OLD_DEV_APP_IDENTIFIER)
        );
        assert_eq!(legacy_identifier_for("xyz.block.berd.e2e.run-123"), None);
        assert_eq!(legacy_identifier_for("xyz.block.unrelated"), None);
    }

    #[test]
    fn an_e2e_identifier_cannot_select_normal_migration_sources() {
        let temp = tempdir().unwrap();
        let production_source = temp.path().join(OLD_APP_IDENTIFIER);
        let dev_source = temp.path().join(OLD_DEV_APP_IDENTIFIER);
        fs::create_dir_all(&production_source).unwrap();
        fs::create_dir_all(&dev_source).unwrap();
        fs::write(production_source.join("sentinel"), b"production").unwrap();
        fs::write(dev_source.join("sentinel"), b"dev").unwrap();

        let e2e_identifier = "xyz.block.berd.e2e.run-123";
        assert_eq!(legacy_identifier_for(e2e_identifier), None);

        assert_eq!(
            fs::read(production_source.join("sentinel")).unwrap(),
            b"production"
        );
        assert_eq!(fs::read(dev_source.join("sentinel")).unwrap(), b"dev");
        assert!(!temp.path().join(e2e_identifier).exists());
    }

    #[test]
    fn sibling_app_dir_replaces_current_identifier() {
        let current = Path::new("/tmp/base/xyz.block.berd");
        assert_eq!(
            sibling_app_dir(current, CURRENT_APP_IDENTIFIER, OLD_APP_IDENTIFIER),
            Path::new("/tmp/base/com.squareup.goose-internal")
        );
    }
}
