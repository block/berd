use chrono::Utc;
use serde::Serialize;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous};
use sqlx::SqlitePool;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

pub(crate) const DATABASE_FILENAME: &str = "berd.sqlite";
const RECOVERY_MARKER_SUFFIX: &str = ".recovery-required.json";

#[derive(Clone, Debug)]
pub struct BerdPersistenceState {
    pub(crate) pool: SqlitePool,
}

impl BerdPersistenceState {
    pub async fn new(app_data_dir: PathBuf) -> Result<Self, String> {
        fs::create_dir_all(&app_data_dir)
            .map_err(|error| format!("Failed to create app data directory: {error}"))?;
        Self::new_for_path(app_data_dir.join(DATABASE_FILENAME)).await
    }

    #[cfg(test)]
    pub(crate) async fn new_for_tests(db_path: PathBuf) -> Result<Self, String> {
        Self::new_for_path(db_path).await
    }

    async fn new_for_path(db_path: PathBuf) -> Result<Self, String> {
        refuse_unresolved_recovery(&db_path)?;
        if database_file_has_invalid_header(&db_path)? {
            let marker = preserve_corrupt_database_files(&db_path)?;
            return Err(recovery_required_error(&marker));
        }

        match open_migrated_pool(&db_path).await {
            Ok(pool) => Ok(Self { pool }),
            Err(error) if is_sqlite_corruption_error(&error) => {
                let marker = preserve_corrupt_database_files(&db_path)?;
                Err(recovery_required_error(&marker))
            }
            Err(error) => Err(format!("Failed to initialize Berd database: {error}")),
        }
    }

    pub(crate) fn pool(&self) -> &SqlitePool {
        &self.pool
    }
}

async fn open_migrated_pool(db_path: &Path) -> Result<SqlitePool, sqlx::Error> {
    let options = SqliteConnectOptions::new()
        .filename(db_path)
        .create_if_missing(true)
        .foreign_keys(true)
        .journal_mode(SqliteJournalMode::Wal)
        .synchronous(SqliteSynchronous::Full)
        .busy_timeout(Duration::from_millis(5_000));
    let pool = SqlitePoolOptions::new()
        .max_connections(5)
        .connect_with(options)
        .await?;

    if let Err(error) = sqlx::migrate!("./migrations").run(&pool).await {
        pool.close().await;
        return Err(error.into());
    }
    if let Err(error) = read_initial_state(&pool).await {
        pool.close().await;
        return Err(error);
    }
    Ok(pool)
}

async fn read_initial_state(pool: &SqlitePool) -> Result<(), sqlx::Error> {
    sqlx::query("SELECT layout_id FROM layout_state WHERE layout_id = ?")
        .bind(crate::commands::layout::HOME_LAYOUT_ID)
        .fetch_one(pool)
        .await?;
    Ok(())
}

fn database_file_has_invalid_header(db_path: &Path) -> Result<bool, String> {
    const SQLITE_HEADER: &[u8] = b"SQLite format 3\0";

    if !db_path.exists() {
        return Ok(false);
    }

    let mut file = File::open(db_path)
        .map_err(|error| format!("Failed to inspect Berd database header: {error}"))?;
    let mut header = [0; SQLITE_HEADER.len()];
    let bytes_read = file
        .read(&mut header)
        .map_err(|error| format!("Failed to inspect Berd database header: {error}"))?;
    Ok(bytes_read < SQLITE_HEADER.len() || header.as_slice() != SQLITE_HEADER)
}

fn is_sqlite_corruption_error(error: &sqlx::Error) -> bool {
    let mut current: Option<&(dyn std::error::Error + 'static)> = Some(error);
    while let Some(error) = current {
        if let Some(database_error) = error.downcast_ref::<sqlx::Error>().and_then(|error| {
            if let sqlx::Error::Database(database_error) = error {
                Some(database_error)
            } else {
                None
            }
        }) {
            if is_sqlite_corruption_code(database_error.code().as_deref()) {
                return true;
            }
        }
        current = error.source();
    }
    false
}

fn is_sqlite_corruption_code(code: Option<&str>) -> bool {
    code.and_then(|code| code.parse::<i32>().ok())
        .is_some_and(|code| matches!(code & 0xff, 11 | 26))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RecoveryMarker {
    detected_at: String,
    database_path: String,
    preserved_files: Vec<String>,
}

fn recovery_marker_path(db_path: &Path) -> PathBuf {
    PathBuf::from(format!("{}{}", db_path.display(), RECOVERY_MARKER_SUFFIX))
}

fn refuse_unresolved_recovery(db_path: &Path) -> Result<(), String> {
    let marker = recovery_marker_path(db_path);
    if marker.exists() {
        return Err(recovery_required_error(&marker));
    }
    Ok(())
}

fn recovery_required_error(marker: &Path) -> String {
    format!(
        "Berd database recovery is required. Preserved data and recovery details are recorded at {}. Refusing to create an empty replacement database.",
        marker.display()
    )
}

fn preserve_corrupt_database_files(db_path: &Path) -> Result<PathBuf, String> {
    let detected_at = Utc::now();
    let suffix = format!(".corrupt-{}", detected_at.format("%Y%m%dT%H%M%SZ"));
    let files: Vec<(PathBuf, PathBuf)> = [
        db_path.to_path_buf(),
        PathBuf::from(format!("{}-wal", db_path.display())),
        PathBuf::from(format!("{}-shm", db_path.display())),
    ]
    .into_iter()
    .filter(|path| path.exists())
    .map(|path| {
        let file_name = path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| DATABASE_FILENAME.to_string());
        let preserved = path.with_file_name(format!("{file_name}{suffix}"));
        (path, preserved)
    })
    .collect();

    let marker_path = recovery_marker_path(db_path);
    let marker = RecoveryMarker {
        detected_at: detected_at.to_rfc3339(),
        database_path: db_path.to_string_lossy().into_owned(),
        preserved_files: files
            .iter()
            .map(|(_, preserved)| preserved.to_string_lossy().into_owned())
            .collect(),
    };
    let marker_bytes = serde_json::to_vec_pretty(&marker)
        .map_err(|error| format!("Failed to serialize database recovery marker: {error}"))?;
    let temporary_marker = PathBuf::from(format!(
        "{}.{}.tmp",
        marker_path.display(),
        uuid::Uuid::new_v4()
    ));
    let mut marker_file = File::create(&temporary_marker).map_err(|error| {
        format!(
            "Failed to write database recovery marker {}: {error}",
            temporary_marker.display()
        )
    })?;
    marker_file.write_all(&marker_bytes).map_err(|error| {
        format!(
            "Failed to write database recovery marker {}: {error}",
            temporary_marker.display()
        )
    })?;
    marker_file.sync_all().map_err(|error| {
        format!(
            "Failed to sync database recovery marker {}: {error}",
            temporary_marker.display()
        )
    })?;
    drop(marker_file);
    fs::rename(&temporary_marker, &marker_path).map_err(|error| {
        format!(
            "Failed to publish database recovery marker {}: {error}",
            marker_path.display()
        )
    })?;
    sync_parent_directory(&marker_path)?;

    let mut errors = Vec::new();
    for (path, preserved) in &files {
        match fs::rename(path, preserved) {
            Ok(()) => log::error!(
                "Preserved corrupt Berd database file {} as {}",
                path.display(),
                preserved.display()
            ),
            Err(error) => errors.push(format!(
                "Failed to preserve corrupt database file {} as {}: {error}",
                path.display(),
                preserved.display()
            )),
        }
    }

    if errors.is_empty() {
        sync_parent_directory(db_path)?;
        Ok(marker_path)
    } else {
        Err(format!(
            "{}; recovery remains blocked by {}",
            errors.join("; "),
            marker_path.display()
        ))
    }
}

#[cfg(unix)]
fn sync_parent_directory(path: &Path) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("Database recovery path has no parent: {}", path.display()))?;
    File::open(parent)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| {
            format!(
                "Failed to sync database recovery directory {}: {error}",
                parent.display()
            )
        })
}

#[cfg(not(unix))]
fn sync_parent_directory(_path: &Path) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::error::{DatabaseError, ErrorKind};
    use std::borrow::Cow;
    use std::fmt;
    use tempfile::tempdir;

    #[derive(Debug)]
    struct FakeDatabaseError {
        code: &'static str,
    }

    impl fmt::Display for FakeDatabaseError {
        fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
            write!(formatter, "fake sqlite error {}", self.code)
        }
    }

    impl std::error::Error for FakeDatabaseError {}

    impl DatabaseError for FakeDatabaseError {
        fn message(&self) -> &str {
            "fake sqlite error"
        }
        fn code(&self) -> Option<Cow<'_, str>> {
            Some(Cow::Borrowed(self.code))
        }
        fn as_error(&self) -> &(dyn std::error::Error + Send + Sync + 'static) {
            self
        }
        fn as_error_mut(&mut self) -> &mut (dyn std::error::Error + Send + Sync + 'static) {
            self
        }
        fn into_error(self: Box<Self>) -> Box<dyn std::error::Error + Send + Sync + 'static> {
            self
        }
        fn kind(&self) -> ErrorKind {
            ErrorKind::Other
        }
    }

    #[tokio::test]
    async fn corruption_is_preserved_and_blocks_recreation_across_restarts() {
        let dir = tempdir().expect("tempdir");
        let db_path = dir.path().join(DATABASE_FILENAME);
        fs::write(&db_path, "not sqlite").expect("db");
        fs::write(format!("{}-wal", db_path.display()), "wal").expect("wal");
        fs::write(format!("{}-shm", db_path.display()), "shm").expect("shm");

        let first_error = BerdPersistenceState::new_for_tests(db_path.clone())
            .await
            .expect_err("corrupt database must fail closed");
        assert!(first_error.contains("recovery is required"));
        assert!(!db_path.exists());

        let second_error = BerdPersistenceState::new_for_tests(db_path.clone())
            .await
            .expect_err("relaunch must remain blocked");
        assert!(second_error.contains("Refusing to create an empty replacement"));

        assert!(recovery_marker_path(&db_path).is_file());
        let renamed: Vec<String> = fs::read_dir(dir.path())
            .expect("read dir")
            .filter_map(Result::ok)
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.contains(".corrupt-"))
            .collect();
        assert_eq!(renamed.len(), 3);
    }

    #[tokio::test]
    async fn truncated_empty_database_is_corruption_and_cannot_be_recreated() {
        let dir = tempdir().expect("tempdir");
        let db_path = dir.path().join(DATABASE_FILENAME);
        fs::write(&db_path, []).expect("empty database");

        let first_error = BerdPersistenceState::new_for_tests(db_path.clone())
            .await
            .expect_err("an existing empty database must fail closed");
        assert!(first_error.contains("recovery is required"));
        assert!(!db_path.exists());

        let second_error = BerdPersistenceState::new_for_tests(db_path.clone())
            .await
            .expect_err("relaunch must not migrate an empty replacement");
        assert!(second_error.contains("Refusing to create an empty replacement"));
        assert!(recovery_marker_path(&db_path).is_file());
    }

    #[tokio::test]
    async fn non_corruption_open_errors_do_not_create_recovery_marker() {
        let dir = tempdir().expect("tempdir");
        let db_path = dir.path().join(DATABASE_FILENAME);
        fs::create_dir(&db_path).expect("db path directory");

        let error = BerdPersistenceState::new_for_tests(db_path.clone())
            .await
            .expect_err("directory path should not be recoverable corruption");

        assert!(error.contains("Failed to inspect Berd database header"));
        assert!(db_path.is_dir());
        assert!(!recovery_marker_path(&db_path).exists());
    }

    #[test]
    fn corruption_detector_matches_migration_errors_and_extended_codes() {
        let top_level_corruption = sqlx::Error::database(FakeDatabaseError { code: "11" });
        assert!(is_sqlite_corruption_error(&top_level_corruption));
        let extended_corruption = sqlx::Error::database(FakeDatabaseError { code: "267" });
        assert!(is_sqlite_corruption_error(&extended_corruption));
        let migration_corruption =
            sqlx::Error::Migrate(Box::new(sqlx::migrate::MigrateError::ExecuteMigration(
                sqlx::Error::database(FakeDatabaseError { code: "267" }),
                20260519180000,
            )));
        assert!(is_sqlite_corruption_error(&migration_corruption));
        let constraint_error = sqlx::Error::database(FakeDatabaseError { code: "2067" });
        assert!(!is_sqlite_corruption_error(&constraint_error));
    }
}
