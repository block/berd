use chrono::Utc;
use serde::{Deserialize, Serialize, Serializer};
use sqlx::pool::PoolConnection;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};
use sqlx::{FromRow, Row, Sqlite, SqlitePool};
use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Duration;
use uuid::Uuid;

const DATABASE_FILENAME: &str = "goose-internal.sqlite";
const MIN_CENTER: f64 = -1_000_000.0;
const MAX_CENTER: f64 = 1_000_000.0;
const MIN_SIZE: f64 = 1.0;
const MAX_SIZE: f64 = 100_000.0;
const MIN_ZOOM_BPS: i32 = 1_000;
const MAX_ZOOM_BPS: i32 = 80_000;
const DEFAULT_ZOOM_BPS: i32 = 10_000;
const MAX_TITLE_OVERRIDE_LENGTH: usize = 200;
const MAX_ITEMS: usize = 500;
pub const HOME_LAYOUT_ID: &str = "home";

#[derive(Clone, Debug)]
pub struct LayoutState {
    pool: SqlitePool,
}

impl LayoutState {
    pub async fn new(app_data_dir: PathBuf) -> Result<Self, String> {
        fs::create_dir_all(&app_data_dir)
            .map_err(|error| format!("Failed to create app data directory: {error}"))?;

        Self::new_for_path(app_data_dir.join(DATABASE_FILENAME)).await
    }

    #[cfg(test)]
    async fn new_for_tests(db_path: PathBuf) -> Result<Self, String> {
        Self::new_for_path(db_path).await
    }

    async fn new_for_path(db_path: PathBuf) -> Result<Self, String> {
        if database_file_has_invalid_header(&db_path)? {
            rename_corrupt_database_files(&db_path)?;
        }
        match open_migrated_pool(&db_path).await {
            Ok(pool) => Ok(Self { pool }),
            Err(error) if is_sqlite_corruption_error(&error) => {
                rename_corrupt_database_files(&db_path)?;
                let pool = open_migrated_pool(&db_path).await.map_err(|retry_error| {
                    format!("Failed to recreate layout database: {retry_error}")
                })?;
                Ok(Self { pool })
            }
            Err(error) => Err(format!("Failed to initialize layout database: {error}")),
        }
    }
}

fn database_file_has_invalid_header(db_path: &Path) -> Result<bool, String> {
    const SQLITE_HEADER: &[u8] = b"SQLite format 3\0";

    if !db_path.exists() {
        return Ok(false);
    }

    let mut file = File::open(db_path)
        .map_err(|error| format!("Failed to inspect layout database header: {error}"))?;
    let mut header = [0; SQLITE_HEADER.len()];
    let bytes_read = file
        .read(&mut header)
        .map_err(|error| format!("Failed to inspect layout database header: {error}"))?;
    Ok(bytes_read != 0 && (bytes_read < SQLITE_HEADER.len() || header.as_slice() != SQLITE_HEADER))
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LayoutConstraints {
    min_center: f64,
    max_center: f64,
    min_size: f64,
    max_size: f64,
    min_zoom_bps: i32,
    max_zoom_bps: i32,
    max_title_override_length: usize,
    max_items: usize,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LayoutCamera {
    center_x: f64,
    center_y: f64,
    zoom_bps: i32,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LayoutItem {
    id: String,
    kind: LayoutItemKind,
    target_id: String,
    center_x: f64,
    center_y: f64,
    width: f64,
    height: f64,
    z_index: i32,
    title_override: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Eq, PartialEq, Hash)]
#[serde(rename_all = "camelCase")]
pub enum LayoutItemKind {
    Session,
    Project,
    Persona,
    Clock,
    StickyNote,
    Automation,
    Skill,
}

impl LayoutItemKind {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Session => "session",
            Self::Project => "project",
            Self::Persona => "persona",
            Self::Clock => "clock",
            Self::StickyNote => "stickyNote",
            Self::Automation => "automation",
            Self::Skill => "skill",
        }
    }
}

impl TryFrom<&str> for LayoutItemKind {
    type Error = String;

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        match value {
            "session" => Ok(Self::Session),
            "project" => Ok(Self::Project),
            "persona" => Ok(Self::Persona),
            "clock" => Ok(Self::Clock),
            "stickyNote" => Ok(Self::StickyNote),
            "automation" => Ok(Self::Automation),
            "skill" => Ok(Self::Skill),
            _ => Err(format!("Unknown layout item kind: {value}")),
        }
    }
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Layout {
    layout_id: String,
    item_revision: i64,
    camera_revision: i64,
    camera: LayoutCamera,
    items: Vec<LayoutItem>,
    constraints: LayoutConstraints,
}

#[derive(Debug, PartialEq)]
pub enum LayoutMutationResult {
    Saved {
        layout: Layout,
    },
    RevisionConflict {
        reason: LayoutMutationConflictReason,
        layout: Layout,
    },
}

impl Serialize for LayoutMutationResult {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Success<'a> {
            ok: bool,
            layout: &'a Layout,
        }

        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Conflict<'a> {
            ok: bool,
            reason: &'a LayoutMutationConflictReason,
            layout: &'a Layout,
        }

        match self {
            Self::Saved { layout } => Success { ok: true, layout }.serialize(serializer),
            Self::RevisionConflict { reason, layout } => Conflict {
                ok: false,
                reason,
                layout,
            }
            .serialize(serializer),
        }
    }
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum LayoutMutationConflictReason {
    RevisionConflict,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SaveLayoutItemsRequest {
    layout_id: String,
    expected_revision: i64,
    replace_kinds: Vec<LayoutItemKind>,
    items: Vec<LayoutItem>,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SaveLayoutCameraRequest {
    layout_id: String,
    expected_revision: i64,
    camera: LayoutCamera,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ResetLayoutRequest {
    layout_id: String,
    expected_item_revision: i64,
    expected_camera_revision: i64,
}

#[derive(FromRow)]
struct LayoutStateRow {
    item_revision: i64,
    camera_revision: i64,
    camera_center_x: f64,
    camera_center_y: f64,
    zoom_bps: i64,
}

#[derive(FromRow)]
struct LayoutItemRow {
    id: String,
    kind: String,
    target_id: String,
    center_x: f64,
    center_y: f64,
    width: f64,
    height: f64,
    z_index: i64,
    title_override: Option<String>,
}

#[tauri::command]
pub async fn get_layout(
    state: tauri::State<'_, LayoutState>,
    layout_id: String,
) -> Result<Layout, String> {
    let layout_id = require_supported_layout_id(layout_id)?;
    read_layout(&state.pool, &layout_id).await
}

#[tauri::command]
pub async fn save_layout_items(
    state: tauri::State<'_, LayoutState>,
    request: SaveLayoutItemsRequest,
) -> Result<LayoutMutationResult, String> {
    save_layout_items_in_pool(&state.pool, request).await
}

#[tauri::command]
pub async fn save_layout_camera(
    state: tauri::State<'_, LayoutState>,
    request: SaveLayoutCameraRequest,
) -> Result<LayoutMutationResult, String> {
    save_layout_camera_in_pool(&state.pool, request).await
}

#[tauri::command]
pub async fn reset_layout(
    state: tauri::State<'_, LayoutState>,
    request: ResetLayoutRequest,
) -> Result<LayoutMutationResult, String> {
    reset_layout_in_pool(&state.pool, request).await
}

async fn open_migrated_pool(db_path: &Path) -> Result<SqlitePool, sqlx::Error> {
    let options = SqliteConnectOptions::new()
        .filename(db_path)
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
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
        .bind(HOME_LAYOUT_ID)
        .fetch_one(pool)
        .await?;
    Ok(())
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

fn rename_corrupt_database_files(db_path: &Path) -> Result<(), String> {
    let suffix = format!(".corrupt-{}", Utc::now().format("%Y%m%dT%H%M%SZ"));
    let mut renamed = Vec::new();
    let mut errors = Vec::new();

    for path in [
        db_path.to_path_buf(),
        PathBuf::from(format!("{}-wal", db_path.display())),
        PathBuf::from(format!("{}-shm", db_path.display())),
    ] {
        if path.exists() {
            let file_name = path
                .file_name()
                .ok_or_else(|| format!("Invalid database path: {}", path.display()))?
                .to_string_lossy();
            let renamed_path = path.with_file_name(format!("{file_name}{suffix}"));
            match fs::rename(&path, &renamed_path) {
                Ok(()) => renamed.push((path, renamed_path)),
                Err(error) => errors.push(format!(
                    "Failed to preserve corrupt database file {} as {}: {error}",
                    path.display(),
                    renamed_path.display()
                )),
            }
        }
    }

    for (path, renamed_path) in &renamed {
        log::warn!(
            "Preserved corrupt layout database file {} as {}",
            path.display(),
            renamed_path.display()
        );
    }

    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("; "))
    }
}

fn require_supported_layout_id(layout_id: String) -> Result<String, String> {
    let layout_id = layout_id.trim().to_string();
    if layout_id.is_empty() {
        return Err("Layout layoutId cannot be empty".to_string());
    }
    if layout_id != HOME_LAYOUT_ID {
        return Err(format!(
            "Unsupported layoutId: {layout_id}. V1 supports only {HOME_LAYOUT_ID}"
        ));
    }
    Ok(layout_id)
}

async fn save_layout_items_in_pool(
    pool: &SqlitePool,
    request: SaveLayoutItemsRequest,
) -> Result<LayoutMutationResult, String> {
    let layout_id = require_supported_layout_id(request.layout_id)?;
    let (replace_kinds, items) = validate_save_items_request(request.replace_kinds, request.items)?;
    let mut conn = begin_immediate(pool).await?;
    let (item_revision, next_sort_seq) =
        match read_item_revision_for_update(&mut conn, &layout_id).await {
            Ok(revisions) => revisions,
            Err(error) => return rollback_with_error(conn, error).await,
        };

    if item_revision != request.expected_revision {
        rollback(conn).await?;
        return Ok(LayoutMutationResult::RevisionConflict {
            reason: LayoutMutationConflictReason::RevisionConflict,
            layout: read_layout(pool, &layout_id).await?,
        });
    }

    let existing_sort_seq = match read_existing_sort_sequences(&mut conn, &layout_id).await {
        Ok(sort_sequences) => sort_sequences,
        Err(error) => return rollback_with_error(conn, error).await,
    };
    let mut next_sort_seq = next_sort_seq;
    let mut assigned_items = Vec::with_capacity(items.len());
    for item in items {
        let sort_seq = if let Some(sort_seq) = existing_sort_seq.get(&item.id) {
            *sort_seq
        } else {
            let sort_seq = next_sort_seq;
            next_sort_seq += 1;
            sort_seq
        };
        assigned_items.push((item, sort_seq));
    }

    for kind in replace_kinds {
        if let Err(error) = sqlx::query("DELETE FROM layout_items WHERE layout_id = ? AND kind = ?")
            .bind(&layout_id)
            .bind(kind.as_str())
            .execute(&mut *conn)
            .await
            .map_err(db_error)
        {
            return rollback_with_error(conn, error).await;
        }
    }

    for (item, sort_seq) in assigned_items {
        if let Err(error) = sqlx::query(
            "INSERT INTO layout_items (
                layout_id, id, kind, target_id, center_x, center_y, width, height, z_index, sort_seq, title_override
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&layout_id)
        .bind(item.id)
        .bind(item.kind.as_str())
        .bind(item.target_id)
        .bind(item.center_x)
        .bind(item.center_y)
        .bind(item.width)
        .bind(item.height)
        .bind(item.z_index)
        .bind(sort_seq)
        .bind(item.title_override)
        .execute(&mut *conn)
        .await
        .map_err(db_error)
        {
            return rollback_with_error(conn, error).await;
        }
    }

    if let Err(error) = sqlx::query(
        "UPDATE layout_state
         SET item_revision = item_revision + 1, next_sort_seq = ?
         WHERE layout_id = ?",
    )
    .bind(next_sort_seq)
    .bind(&layout_id)
    .execute(&mut *conn)
    .await
    .map_err(db_error)
    {
        return rollback_with_error(conn, error).await;
    }

    commit(conn).await?;
    Ok(LayoutMutationResult::Saved {
        layout: read_layout(pool, &layout_id).await?,
    })
}

async fn save_layout_camera_in_pool(
    pool: &SqlitePool,
    request: SaveLayoutCameraRequest,
) -> Result<LayoutMutationResult, String> {
    let layout_id = require_supported_layout_id(request.layout_id)?;
    let camera = validate_camera(request.camera)?;
    let mut conn = begin_immediate(pool).await?;
    let camera_revision = match read_camera_revision_for_update(&mut conn, &layout_id).await {
        Ok(revision) => revision,
        Err(error) => return rollback_with_error(conn, error).await,
    };

    if camera_revision != request.expected_revision {
        rollback(conn).await?;
        return Ok(LayoutMutationResult::RevisionConflict {
            reason: LayoutMutationConflictReason::RevisionConflict,
            layout: read_layout(pool, &layout_id).await?,
        });
    }

    if let Err(error) = sqlx::query(
        "UPDATE layout_state
         SET camera_revision = camera_revision + 1,
             camera_center_x = ?,
             camera_center_y = ?,
             zoom_bps = ?
         WHERE layout_id = ?",
    )
    .bind(camera.center_x)
    .bind(camera.center_y)
    .bind(camera.zoom_bps)
    .bind(&layout_id)
    .execute(&mut *conn)
    .await
    .map_err(db_error)
    {
        return rollback_with_error(conn, error).await;
    }

    commit(conn).await?;
    Ok(LayoutMutationResult::Saved {
        layout: read_layout(pool, &layout_id).await?,
    })
}

async fn reset_layout_in_pool(
    pool: &SqlitePool,
    request: ResetLayoutRequest,
) -> Result<LayoutMutationResult, String> {
    let layout_id = require_supported_layout_id(request.layout_id)?;
    let mut conn = begin_immediate(pool).await?;
    let state = match read_state_row(&mut conn, &layout_id).await {
        Ok(state) => state,
        Err(error) => return rollback_with_error(conn, error).await,
    };

    if state.item_revision != request.expected_item_revision
        || state.camera_revision != request.expected_camera_revision
    {
        rollback(conn).await?;
        return Ok(LayoutMutationResult::RevisionConflict {
            reason: LayoutMutationConflictReason::RevisionConflict,
            layout: read_layout(pool, &layout_id).await?,
        });
    }

    if let Err(error) = sqlx::query("DELETE FROM layout_items WHERE layout_id = ?")
        .bind(&layout_id)
        .execute(&mut *conn)
        .await
        .map_err(db_error)
    {
        return rollback_with_error(conn, error).await;
    }
    if let Err(error) = sqlx::query(
        "UPDATE layout_state
         SET item_revision = item_revision + 1,
             camera_revision = camera_revision + 1,
             camera_center_x = 0,
             camera_center_y = 0,
             zoom_bps = ?
         WHERE layout_id = ?",
    )
    .bind(DEFAULT_ZOOM_BPS)
    .bind(&layout_id)
    .execute(&mut *conn)
    .await
    .map_err(db_error)
    {
        return rollback_with_error(conn, error).await;
    }

    commit(conn).await?;
    Ok(LayoutMutationResult::Saved {
        layout: read_layout(pool, &layout_id).await?,
    })
}

type LayoutConnection = PoolConnection<Sqlite>;

async fn begin_immediate(pool: &SqlitePool) -> Result<LayoutConnection, String> {
    let mut conn = pool.acquire().await.map_err(db_error)?;
    sqlx::query("BEGIN IMMEDIATE")
        .execute(&mut *conn)
        .await
        .map_err(db_error)?;
    Ok(conn)
}

async fn commit(mut conn: LayoutConnection) -> Result<(), String> {
    if let Err(error) = sqlx::query("COMMIT")
        .execute(&mut *conn)
        .await
        .map_err(db_error)
    {
        let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
        return Err(error);
    }
    Ok(())
}

async fn rollback(mut conn: LayoutConnection) -> Result<(), String> {
    sqlx::query("ROLLBACK")
        .execute(&mut *conn)
        .await
        .map_err(db_error)?;
    Ok(())
}

async fn rollback_with_error<T>(conn: LayoutConnection, error: String) -> Result<T, String> {
    let _ = rollback(conn).await;
    Err(error)
}

async fn read_layout(pool: &SqlitePool, layout_id: &str) -> Result<Layout, String> {
    // Read state and items in a single BEGIN DEFERRED transaction so the returned
    // layout is a snapshot from one committed point in time, even if another writer
    // commits between the two SELECTs.
    let mut tx = pool.begin().await.map_err(db_error)?;
    let state = sqlx::query_as::<_, LayoutStateRow>(
        "SELECT item_revision, camera_revision, camera_center_x, camera_center_y, zoom_bps
         FROM layout_state
         WHERE layout_id = ?",
    )
    .bind(layout_id)
    .fetch_one(&mut *tx)
    .await
    .map_err(db_error)?;

    let item_rows = sqlx::query_as::<_, LayoutItemRow>(
        "SELECT id, kind, target_id, center_x, center_y, width, height, z_index, title_override
         FROM layout_items
         WHERE layout_id = ?
         ORDER BY z_index ASC, sort_seq ASC, id ASC",
    )
    .bind(layout_id)
    .fetch_all(&mut *tx)
    .await
    .map_err(db_error)?;

    let mut skipped_unknown_kinds = 0;
    let mut items = Vec::with_capacity(item_rows.len());
    for row in item_rows {
        match layout_item_from_row(row) {
            Ok(Some(item)) => items.push(item),
            Ok(None) => skipped_unknown_kinds += 1,
            Err(error) => return Err(error),
        }
    }
    if skipped_unknown_kinds > 0 {
        log::warn!(
            "Skipped {skipped_unknown_kinds} layout item rows with unknown kind for layout_id={layout_id}"
        );
    }

    Ok(Layout {
        layout_id: layout_id.to_string(),
        item_revision: state.item_revision,
        camera_revision: state.camera_revision,
        camera: LayoutCamera {
            center_x: state.camera_center_x,
            center_y: state.camera_center_y,
            zoom_bps: i32::try_from(state.zoom_bps)
                .map_err(|_| "Stored zoom is outside the supported range".to_string())?,
        },
        items,
        constraints: constraints(),
    })
}

async fn read_state_row(
    conn: &mut LayoutConnection,
    layout_id: &str,
) -> Result<LayoutStateRow, String> {
    sqlx::query_as::<_, LayoutStateRow>(
        "SELECT item_revision, camera_revision, camera_center_x, camera_center_y, zoom_bps
         FROM layout_state
         WHERE layout_id = ?",
    )
    .bind(layout_id)
    .fetch_one(&mut **conn)
    .await
    .map_err(db_error)
}

async fn read_item_revision_for_update(
    conn: &mut LayoutConnection,
    layout_id: &str,
) -> Result<(i64, i64), String> {
    let row = sqlx::query(
        "SELECT item_revision, next_sort_seq
         FROM layout_state
         WHERE layout_id = ?",
    )
    .bind(layout_id)
    .fetch_one(&mut **conn)
    .await
    .map_err(db_error)?;
    Ok((row.get("item_revision"), row.get("next_sort_seq")))
}

async fn read_camera_revision_for_update(
    conn: &mut LayoutConnection,
    layout_id: &str,
) -> Result<i64, String> {
    let row = sqlx::query(
        "SELECT camera_revision
         FROM layout_state
         WHERE layout_id = ?",
    )
    .bind(layout_id)
    .fetch_one(&mut **conn)
    .await
    .map_err(db_error)?;
    Ok(row.get("camera_revision"))
}

async fn read_existing_sort_sequences(
    conn: &mut LayoutConnection,
    layout_id: &str,
) -> Result<HashMap<String, i64>, String> {
    let rows = sqlx::query("SELECT id, sort_seq FROM layout_items WHERE layout_id = ?")
        .bind(layout_id)
        .fetch_all(&mut **conn)
        .await
        .map_err(db_error)?;
    Ok(rows
        .into_iter()
        .map(|row| (row.get("id"), row.get("sort_seq")))
        .collect())
}

fn validate_save_items_request(
    replace_kinds: Vec<LayoutItemKind>,
    items: Vec<LayoutItem>,
) -> Result<(Vec<LayoutItemKind>, Vec<LayoutItem>), String> {
    if replace_kinds.is_empty() {
        return Err("Layout replaceKinds cannot be empty".to_string());
    }
    let mut replace_kind_set = HashSet::with_capacity(replace_kinds.len());
    for kind in &replace_kinds {
        if !replace_kind_set.insert(kind.clone()) {
            return Err("Layout replaceKinds must be unique".to_string());
        }
    }

    let items = validate_items(items)?;
    for item in &items {
        if !replace_kind_set.contains(&item.kind) {
            return Err("Layout item kind must be included in replaceKinds".to_string());
        }
    }

    Ok((replace_kinds, items))
}

fn validate_items(items: Vec<LayoutItem>) -> Result<Vec<LayoutItem>, String> {
    if items.len() > MAX_ITEMS {
        return Err(format!("Layout supports at most {MAX_ITEMS} items"));
    }

    let mut ids = HashSet::with_capacity(items.len());
    let mut target_keys = HashSet::with_capacity(items.len());
    items
        .into_iter()
        .map(|mut item| {
            Uuid::parse_str(&item.id).map_err(|_| "Layout item id must be a UUID".to_string())?;
            if !ids.insert(item.id.clone()) {
                return Err("Layout item ids must be unique".to_string());
            }

            item.target_id = item.target_id.trim().to_string();
            if item.target_id.is_empty() {
                return Err("Layout item targetId cannot be empty".to_string());
            }
            if !target_keys.insert((item.kind.clone(), item.target_id.clone())) {
                return Err("Layout item targets must be unique by kind and targetId".to_string());
            }

            validate_coordinate("centerX", item.center_x)?;
            validate_coordinate("centerY", item.center_y)?;
            validate_size("width", item.width)?;
            validate_size("height", item.height)?;

            item.title_override = item
                .title_override
                .as_deref()
                .map(str::trim)
                .filter(|title| !title.is_empty())
                .map(str::to_string);
            if item
                .title_override
                .as_ref()
                .is_some_and(|title| title.chars().count() > MAX_TITLE_OVERRIDE_LENGTH)
            {
                return Err(format!(
                    "Layout item titleOverride cannot exceed {MAX_TITLE_OVERRIDE_LENGTH} characters"
                ));
            }

            Ok(item)
        })
        .collect()
}

fn validate_camera(camera: LayoutCamera) -> Result<LayoutCamera, String> {
    validate_coordinate("centerX", camera.center_x)?;
    validate_coordinate("centerY", camera.center_y)?;
    if !(MIN_ZOOM_BPS..=MAX_ZOOM_BPS).contains(&camera.zoom_bps) {
        return Err(format!(
            "Layout camera zoomBps must be between {MIN_ZOOM_BPS} and {MAX_ZOOM_BPS}"
        ));
    }
    Ok(camera)
}

fn validate_coordinate(name: &str, value: f64) -> Result<(), String> {
    if !value.is_finite() || !(MIN_CENTER..=MAX_CENTER).contains(&value) {
        return Err(format!(
            "Layout {name} must be finite and between {MIN_CENTER} and {MAX_CENTER}"
        ));
    }
    Ok(())
}

fn validate_size(name: &str, value: f64) -> Result<(), String> {
    if !value.is_finite() || !(MIN_SIZE..=MAX_SIZE).contains(&value) {
        return Err(format!(
            "Layout {name} must be finite and between {MIN_SIZE} and {MAX_SIZE}"
        ));
    }
    Ok(())
}

fn constraints() -> LayoutConstraints {
    LayoutConstraints {
        min_center: MIN_CENTER,
        max_center: MAX_CENTER,
        min_size: MIN_SIZE,
        max_size: MAX_SIZE,
        min_zoom_bps: MIN_ZOOM_BPS,
        max_zoom_bps: MAX_ZOOM_BPS,
        max_title_override_length: MAX_TITLE_OVERRIDE_LENGTH,
        max_items: MAX_ITEMS,
    }
}

fn layout_item_from_row(row: LayoutItemRow) -> Result<Option<LayoutItem>, String> {
    let kind = match LayoutItemKind::try_from(row.kind.as_str()) {
        Ok(kind) => kind,
        Err(_) => return Ok(None),
    };

    Ok(Some(LayoutItem {
        id: row.id,
        kind,
        target_id: row.target_id,
        center_x: row.center_x,
        center_y: row.center_y,
        width: row.width,
        height: row.height,
        z_index: i32::try_from(row.z_index)
            .map_err(|_| "Stored zIndex is outside the supported range".to_string())?,
        title_override: row.title_override,
    }))
}

fn db_error(error: sqlx::Error) -> String {
    error.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use sqlx::error::{DatabaseError, ErrorKind};
    use std::borrow::Cow;
    use std::fmt;
    use tempfile::{tempdir, TempDir};

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

    struct TestState {
        state: LayoutState,
        _dir: TempDir,
    }

    impl std::ops::Deref for TestState {
        type Target = LayoutState;
        fn deref(&self) -> &Self::Target {
            &self.state
        }
    }

    fn item(id: &str, kind: LayoutItemKind, target_id: &str, z_index: i32) -> LayoutItem {
        LayoutItem {
            id: id.to_string(),
            kind,
            target_id: target_id.to_string(),
            center_x: 10.0,
            center_y: 20.0,
            width: 100.0,
            height: 80.0,
            z_index,
            title_override: None,
        }
    }

    fn all_known_kinds() -> Vec<LayoutItemKind> {
        vec![
            LayoutItemKind::Session,
            LayoutItemKind::Project,
            LayoutItemKind::Persona,
            LayoutItemKind::Clock,
            LayoutItemKind::StickyNote,
            LayoutItemKind::Automation,
            LayoutItemKind::Skill,
        ]
    }

    async fn test_state() -> TestState {
        test_state_with_max_connections(5).await
    }

    async fn test_state_with_max_connections(max_connections: u32) -> TestState {
        let dir = tempdir().expect("tempdir");
        let db_path = dir.path().join(DATABASE_FILENAME);
        let options = SqliteConnectOptions::new()
            .filename(&db_path)
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Wal)
            .busy_timeout(Duration::from_millis(5_000));
        let pool = SqlitePoolOptions::new()
            .max_connections(max_connections)
            .connect_with(options)
            .await
            .expect("test database");
        sqlx::migrate!("./migrations")
            .run(&pool)
            .await
            .expect("migrations");
        let state = LayoutState { pool };
        TestState { state, _dir: dir }
    }

    async fn seed_item_and_camera(state: &LayoutState) {
        save_layout_items_in_pool(
            &state.pool,
            SaveLayoutItemsRequest {
                layout_id: HOME_LAYOUT_ID.to_string(),
                expected_revision: 0,
                replace_kinds: all_known_kinds(),
                items: vec![item(
                    "00000000-0000-0000-0000-000000000001",
                    LayoutItemKind::Session,
                    "session-1",
                    1,
                )],
            },
        )
        .await
        .expect("items");
        save_layout_camera_in_pool(
            &state.pool,
            SaveLayoutCameraRequest {
                layout_id: HOME_LAYOUT_ID.to_string(),
                expected_revision: 0,
                camera: LayoutCamera {
                    center_x: 1.0,
                    center_y: 2.0,
                    zoom_bps: 20_000,
                },
            },
        )
        .await
        .expect("camera");
    }

    #[tokio::test]
    async fn missing_database_returns_initial_layout() {
        let state = test_state().await;
        let layout = read_layout(&state.pool, HOME_LAYOUT_ID)
            .await
            .expect("layout");

        assert_eq!(layout.layout_id, HOME_LAYOUT_ID);
        assert_eq!(layout.item_revision, 0);
        assert_eq!(layout.camera_revision, 0);
        assert_eq!(
            layout.camera,
            LayoutCamera {
                center_x: 0.0,
                center_y: 0.0,
                zoom_bps: DEFAULT_ZOOM_BPS,
            }
        );
        assert!(layout.items.is_empty());
        assert_eq!(layout.constraints, constraints());
    }

    #[tokio::test]
    async fn migration_creates_expected_schema() {
        let state = test_state().await;
        let indexes: Vec<(String,)> = sqlx::query_as(
            "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'layout_items'",
        )
        .fetch_all(&state.pool)
        .await
        .expect("indexes");
        assert!(indexes
            .iter()
            .any(|(name,)| name == "layout_items_render_order_idx"));

        let row = sqlx::query(
            "SELECT layout_id, item_revision, camera_revision, zoom_bps, next_sort_seq FROM layout_state",
        )
        .fetch_one(&state.pool)
        .await
        .expect("state row");
        assert_eq!(row.get::<String, _>("layout_id"), HOME_LAYOUT_ID);
        assert_eq!(row.get::<i64, _>("item_revision"), 0);
        assert_eq!(row.get::<i64, _>("camera_revision"), 0);
        assert_eq!(row.get::<i64, _>("zoom_bps"), i64::from(DEFAULT_ZOOM_BPS));
        assert_eq!(row.get::<i64, _>("next_sort_seq"), 1);
    }

    #[tokio::test]
    async fn migration_allows_future_layout_item_kinds() {
        let state = test_state().await;

        sqlx::query(
            "INSERT INTO layout_items (
                layout_id, id, kind, target_id, center_x, center_y, width, height, z_index, sort_seq, title_override
             ) VALUES (?, ?, 'future-kind', 'future-1', 10, 20, 100, 80, 1, 1, NULL)",
        )
        .bind(HOME_LAYOUT_ID)
        .bind("00000000-0000-0000-0000-000000000001")
        .execute(&state.pool)
        .await
        .expect("future kind insert");
    }

    #[tokio::test]
    async fn read_layout_skips_unknown_item_kinds() {
        let state = test_state().await;

        sqlx::query(
            "INSERT INTO layout_items (
                layout_id, id, kind, target_id, center_x, center_y, width, height, z_index, sort_seq, title_override
             ) VALUES
                (?, ?, 'future-kind', 'future-1', 10, 20, 100, 80, 1, 1, NULL),
                (?, ?, 'session', 'session-1', 10, 20, 100, 80, 2, 2, NULL)",
        )
        .bind(HOME_LAYOUT_ID)
        .bind("00000000-0000-0000-0000-000000000001")
        .bind(HOME_LAYOUT_ID)
        .bind("00000000-0000-0000-0000-000000000002")
        .execute(&state.pool)
        .await
        .expect("items");

        let layout = read_layout(&state.pool, HOME_LAYOUT_ID)
            .await
            .expect("layout");

        assert_eq!(layout.items.len(), 1);
        assert_eq!(layout.items[0].kind, LayoutItemKind::Session);
        assert_eq!(layout.items[0].target_id, "session-1");
    }

    #[tokio::test]
    async fn corrupt_database_files_are_renamed_with_matching_suffix() {
        let dir = tempdir().expect("tempdir");
        let db_path = dir.path().join(DATABASE_FILENAME);
        fs::write(&db_path, "not sqlite").expect("db");
        fs::write(format!("{}-wal", db_path.display()), "wal").expect("wal");
        fs::write(format!("{}-shm", db_path.display()), "shm").expect("shm");

        let state = LayoutState::new_for_tests(db_path.clone())
            .await
            .expect("recovered state");
        assert_eq!(
            read_layout(&state.pool, HOME_LAYOUT_ID)
                .await
                .expect("layout")
                .camera
                .zoom_bps,
            DEFAULT_ZOOM_BPS
        );

        let renamed: Vec<String> = fs::read_dir(dir.path())
            .expect("read dir")
            .filter_map(Result::ok)
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.contains(".corrupt-"))
            .collect();
        assert_eq!(renamed.len(), 3);
        let suffixes: HashSet<String> = renamed
            .iter()
            .map(|name| name.split(".corrupt-").nth(1).unwrap().to_string())
            .collect();
        assert_eq!(suffixes.len(), 1);
    }

    #[tokio::test]
    async fn non_corruption_open_errors_do_not_rename_database_path() {
        let dir = tempdir().expect("tempdir");
        let db_path = dir.path().join(DATABASE_FILENAME);
        fs::create_dir(&db_path).expect("db path directory");

        let error = LayoutState::new_for_tests(db_path.clone())
            .await
            .expect_err("directory path should not be recoverable corruption");

        assert!(error.contains("Failed to inspect layout database header"));
        assert!(db_path.is_dir());
        let renamed: Vec<String> = fs::read_dir(dir.path())
            .expect("read dir")
            .filter_map(Result::ok)
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.contains(".corrupt-"))
            .collect();
        assert!(renamed.is_empty());
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

        let migration_not_a_database =
            sqlx::Error::Migrate(Box::new(sqlx::migrate::MigrateError::Execute(
                sqlx::Error::database(FakeDatabaseError { code: "26" }),
            )));
        assert!(is_sqlite_corruption_error(&migration_not_a_database));

        let constraint_error = sqlx::Error::database(FakeDatabaseError { code: "2067" });
        assert!(!is_sqlite_corruption_error(&constraint_error));
    }

    #[tokio::test]
    async fn save_layout_items_replaces_rows_preserves_existing_sort_and_bumps_item_revision_only()
    {
        let state = test_state().await;
        let first_id = "00000000-0000-0000-0000-000000000001";
        let second_id = "00000000-0000-0000-0000-000000000002";
        let third_id = "00000000-0000-0000-0000-000000000003";

        save_layout_items_in_pool(
            &state.pool,
            SaveLayoutItemsRequest {
                layout_id: HOME_LAYOUT_ID.to_string(),
                expected_revision: 0,
                replace_kinds: all_known_kinds(),
                items: vec![
                    item(first_id, LayoutItemKind::Session, "session-1", 1),
                    item(second_id, LayoutItemKind::Project, "project-1", 1),
                ],
            },
        )
        .await
        .expect("first save");

        let result = save_layout_items_in_pool(
            &state.pool,
            SaveLayoutItemsRequest {
                layout_id: HOME_LAYOUT_ID.to_string(),
                expected_revision: 1,
                replace_kinds: all_known_kinds(),
                items: vec![
                    item(third_id, LayoutItemKind::Persona, "persona-1", 1),
                    item(first_id, LayoutItemKind::Session, "session-1", 1),
                ],
            },
        )
        .await
        .expect("second save");

        let LayoutMutationResult::Saved { layout } = result else {
            panic!("expected save");
        };
        assert_eq!(layout.item_revision, 2);
        assert_eq!(layout.camera_revision, 0);
        assert_eq!(
            layout
                .items
                .iter()
                .map(|item| item.id.as_str())
                .collect::<Vec<_>>(),
            vec![first_id, third_id]
        );

        let next_sort_seq: i64 =
            sqlx::query_scalar("SELECT next_sort_seq FROM layout_state WHERE layout_id = ?")
                .bind(HOME_LAYOUT_ID)
                .fetch_one(&state.pool)
                .await
                .expect("next sort seq");
        assert_eq!(next_sort_seq, 4);
    }

    #[tokio::test]
    async fn save_layout_items_preserves_rows_outside_replace_kinds() {
        let state = test_state().await;
        let session_id = "00000000-0000-0000-0000-000000000001";
        let project_id = "00000000-0000-0000-0000-000000000002";
        let next_session_id = "00000000-0000-0000-0000-000000000003";

        save_layout_items_in_pool(
            &state.pool,
            SaveLayoutItemsRequest {
                layout_id: HOME_LAYOUT_ID.to_string(),
                expected_revision: 0,
                replace_kinds: all_known_kinds(),
                items: vec![
                    item(session_id, LayoutItemKind::Session, "session-1", 1),
                    item(project_id, LayoutItemKind::Project, "project-1", 2),
                ],
            },
        )
        .await
        .expect("initial save");

        let result = save_layout_items_in_pool(
            &state.pool,
            SaveLayoutItemsRequest {
                layout_id: HOME_LAYOUT_ID.to_string(),
                expected_revision: 1,
                replace_kinds: vec![LayoutItemKind::Session],
                items: vec![item(
                    next_session_id,
                    LayoutItemKind::Session,
                    "session-2",
                    3,
                )],
            },
        )
        .await
        .expect("scoped save");

        let LayoutMutationResult::Saved { layout } = result else {
            panic!("expected save");
        };
        assert_eq!(
            layout
                .items
                .iter()
                .map(|item| (item.kind.clone(), item.target_id.as_str()))
                .collect::<Vec<_>>(),
            vec![
                (LayoutItemKind::Project, "project-1"),
                (LayoutItemKind::Session, "session-2"),
            ]
        );
    }

    #[tokio::test]
    async fn save_layout_items_preserves_unknown_rows_outside_replace_kinds() {
        let state = test_state().await;

        sqlx::query(
            "INSERT INTO layout_items (
                layout_id, id, kind, target_id, center_x, center_y, width, height, z_index, sort_seq, title_override
             ) VALUES (?, ?, 'future-kind', 'future-1', 10, 20, 100, 80, 1, 1, NULL)",
        )
        .bind(HOME_LAYOUT_ID)
        .bind("00000000-0000-0000-0000-000000000001")
        .execute(&state.pool)
        .await
        .expect("future row");

        save_layout_items_in_pool(
            &state.pool,
            SaveLayoutItemsRequest {
                layout_id: HOME_LAYOUT_ID.to_string(),
                expected_revision: 0,
                replace_kinds: vec![LayoutItemKind::Session],
                items: vec![item(
                    "00000000-0000-0000-0000-000000000002",
                    LayoutItemKind::Session,
                    "session-1",
                    2,
                )],
            },
        )
        .await
        .expect("scoped save");

        let future_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM layout_items WHERE kind = 'future-kind'")
                .fetch_one(&state.pool)
                .await
                .expect("future count");
        assert_eq!(future_count, 1);
    }

    #[tokio::test]
    async fn save_layout_items_deletes_scoped_kind_when_no_items_submitted_for_it() {
        let state = test_state().await;

        save_layout_items_in_pool(
            &state.pool,
            SaveLayoutItemsRequest {
                layout_id: HOME_LAYOUT_ID.to_string(),
                expected_revision: 0,
                replace_kinds: all_known_kinds(),
                items: vec![
                    item(
                        "00000000-0000-0000-0000-000000000001",
                        LayoutItemKind::Session,
                        "session-1",
                        1,
                    ),
                    item(
                        "00000000-0000-0000-0000-000000000002",
                        LayoutItemKind::Project,
                        "project-1",
                        2,
                    ),
                ],
            },
        )
        .await
        .expect("initial save");

        let result = save_layout_items_in_pool(
            &state.pool,
            SaveLayoutItemsRequest {
                layout_id: HOME_LAYOUT_ID.to_string(),
                expected_revision: 1,
                replace_kinds: vec![LayoutItemKind::Session],
                items: vec![],
            },
        )
        .await
        .expect("scoped delete");

        let LayoutMutationResult::Saved { layout } = result else {
            panic!("expected save");
        };
        assert_eq!(layout.items.len(), 1);
        assert_eq!(layout.items[0].kind, LayoutItemKind::Project);
    }

    #[tokio::test]
    async fn save_layout_items_rejects_items_outside_replace_kinds() {
        let state = test_state().await;

        let error = save_layout_items_in_pool(
            &state.pool,
            SaveLayoutItemsRequest {
                layout_id: HOME_LAYOUT_ID.to_string(),
                expected_revision: 0,
                replace_kinds: vec![LayoutItemKind::Session],
                items: vec![item(
                    "00000000-0000-0000-0000-000000000001",
                    LayoutItemKind::Persona,
                    "persona-1",
                    1,
                )],
            },
        )
        .await
        .expect_err("mismatched replace kind");

        assert!(error.contains("included in replaceKinds"));
        let layout = read_layout(&state.pool, HOME_LAYOUT_ID)
            .await
            .expect("layout");
        assert_eq!(layout.item_revision, 0);
    }

    #[tokio::test]
    async fn clock_and_automation_items_round_trip() {
        let state = test_state().await;

        let result = save_layout_items_in_pool(
            &state.pool,
            SaveLayoutItemsRequest {
                layout_id: HOME_LAYOUT_ID.to_string(),
                expected_revision: 0,
                replace_kinds: vec![LayoutItemKind::Clock, LayoutItemKind::Automation],
                items: vec![
                    item(
                        "00000000-0000-0000-0000-000000000001",
                        LayoutItemKind::Clock,
                        "widget:00000000-0000-0000-0000-000000000001",
                        1,
                    ),
                    item(
                        "00000000-0000-0000-0000-000000000002",
                        LayoutItemKind::Automation,
                        "automation-1",
                        2,
                    ),
                ],
            },
        )
        .await
        .expect("save");

        let LayoutMutationResult::Saved { layout } = result else {
            panic!("expected save");
        };
        assert_eq!(
            layout
                .items
                .iter()
                .map(|item| item.kind.clone())
                .collect::<Vec<_>>(),
            vec![LayoutItemKind::Clock, LayoutItemKind::Automation]
        );
    }

    #[tokio::test]
    async fn stale_save_layout_items_returns_latest_layout_without_mutating() {
        let state = test_state().await;
        let first_id = "00000000-0000-0000-0000-000000000001";
        let second_id = "00000000-0000-0000-0000-000000000002";
        let stale_id = "00000000-0000-0000-0000-000000000003";

        save_layout_items_in_pool(
            &state.pool,
            SaveLayoutItemsRequest {
                layout_id: HOME_LAYOUT_ID.to_string(),
                expected_revision: 0,
                replace_kinds: all_known_kinds(),
                items: vec![
                    item(first_id, LayoutItemKind::Session, "session-1", 1),
                    item(second_id, LayoutItemKind::Project, "project-1", 2),
                ],
            },
        )
        .await
        .expect("initial save");

        let result = save_layout_items_in_pool(
            &state.pool,
            SaveLayoutItemsRequest {
                layout_id: HOME_LAYOUT_ID.to_string(),
                expected_revision: 0,
                replace_kinds: all_known_kinds(),
                items: vec![item(stale_id, LayoutItemKind::Persona, "persona-1", 3)],
            },
        )
        .await
        .expect("stale save returns conflict");

        let LayoutMutationResult::RevisionConflict { reason, layout } = result else {
            panic!("expected revision conflict");
        };
        assert_eq!(reason, LayoutMutationConflictReason::RevisionConflict);
        assert_eq!(layout.item_revision, 1);
        assert_eq!(layout.camera_revision, 0);
        assert_eq!(
            layout
                .items
                .iter()
                .map(|item| item.id.as_str())
                .collect::<Vec<_>>(),
            vec![first_id, second_id]
        );

        let stored = read_layout(&state.pool, HOME_LAYOUT_ID)
            .await
            .expect("stored layout");
        assert_eq!(stored, layout);
        let next_sort_seq: i64 =
            sqlx::query_scalar("SELECT next_sort_seq FROM layout_state WHERE layout_id = ?")
                .bind(HOME_LAYOUT_ID)
                .fetch_one(&state.pool)
                .await
                .expect("next sort seq");
        assert_eq!(next_sort_seq, 3);
    }

    #[tokio::test]
    async fn save_layout_items_rejects_more_than_max_items_without_mutating() {
        let state = test_state().await;
        let items = (1..=MAX_ITEMS + 1)
            .map(|index| {
                item(
                    &Uuid::from_u128(index as u128).to_string(),
                    LayoutItemKind::Session,
                    &format!("session-{index}"),
                    1,
                )
            })
            .collect();

        let error = save_layout_items_in_pool(
            &state.pool,
            SaveLayoutItemsRequest {
                layout_id: HOME_LAYOUT_ID.to_string(),
                expected_revision: 0,
                replace_kinds: all_known_kinds(),
                items,
            },
        )
        .await
        .expect_err("too many items should fail validation");

        assert!(error.contains("at most 500 items"));
        let layout = read_layout(&state.pool, HOME_LAYOUT_ID)
            .await
            .expect("layout");
        assert_eq!(layout.item_revision, 0);
        assert!(layout.items.is_empty());
    }

    #[tokio::test]
    async fn save_layout_items_rolls_back_mid_transaction_errors() {
        let state = test_state_with_max_connections(1).await;
        sqlx::query(
            "CREATE TRIGGER fail_layout_item_insert
             BEFORE INSERT ON layout_items
             BEGIN
                 SELECT RAISE(FAIL, 'forced insert failure');
             END",
        )
        .execute(&state.pool)
        .await
        .expect("trigger");

        let error = save_layout_items_in_pool(
            &state.pool,
            SaveLayoutItemsRequest {
                layout_id: HOME_LAYOUT_ID.to_string(),
                expected_revision: 0,
                replace_kinds: all_known_kinds(),
                items: vec![item(
                    "00000000-0000-0000-0000-000000000001",
                    LayoutItemKind::Session,
                    "session-1",
                    1,
                )],
            },
        )
        .await
        .expect_err("trigger should fail insert");
        assert!(error.contains("forced insert failure"));

        sqlx::query("DROP TRIGGER fail_layout_item_insert")
            .execute(&state.pool)
            .await
            .expect("drop trigger after failed write");
        let result = save_layout_camera_in_pool(
            &state.pool,
            SaveLayoutCameraRequest {
                layout_id: HOME_LAYOUT_ID.to_string(),
                expected_revision: 0,
                camera: LayoutCamera {
                    center_x: 1.0,
                    center_y: 2.0,
                    zoom_bps: 20_000,
                },
            },
        )
        .await
        .expect("pool connection remains usable");
        let LayoutMutationResult::Saved { layout } = result else {
            panic!("expected save");
        };

        assert_eq!(layout.item_revision, 0);
        assert!(layout.items.is_empty());
        assert_eq!(layout.camera_revision, 1);
        assert_eq!(layout.camera.zoom_bps, 20_000);
    }

    #[tokio::test]
    async fn save_layout_camera_bumps_only_camera_revision() {
        let state = test_state().await;
        save_layout_items_in_pool(
            &state.pool,
            SaveLayoutItemsRequest {
                layout_id: HOME_LAYOUT_ID.to_string(),
                expected_revision: 0,
                replace_kinds: all_known_kinds(),
                items: vec![item(
                    "00000000-0000-0000-0000-000000000001",
                    LayoutItemKind::Session,
                    "session-1",
                    1,
                )],
            },
        )
        .await
        .expect("items");

        let result = save_layout_camera_in_pool(
            &state.pool,
            SaveLayoutCameraRequest {
                layout_id: HOME_LAYOUT_ID.to_string(),
                expected_revision: 0,
                camera: LayoutCamera {
                    center_x: 1.0,
                    center_y: 2.0,
                    zoom_bps: 20_000,
                },
            },
        )
        .await
        .expect("camera");
        let LayoutMutationResult::Saved { layout } = result else {
            panic!("expected save");
        };

        assert_eq!(layout.item_revision, 1);
        assert_eq!(layout.camera_revision, 1);
        assert_eq!(layout.items.len(), 1);
        assert_eq!(layout.camera.zoom_bps, 20_000);
    }

    #[tokio::test]
    async fn layout_ids_isolate_items_camera_revisions_and_target_uniqueness() {
        let state = test_state().await;
        let project_layout_id = "project-1";

        save_layout_items_in_pool(
            &state.pool,
            SaveLayoutItemsRequest {
                layout_id: HOME_LAYOUT_ID.to_string(),
                expected_revision: 0,
                replace_kinds: all_known_kinds(),
                items: vec![item(
                    "00000000-0000-0000-0000-000000000001",
                    LayoutItemKind::Session,
                    "shared-target",
                    1,
                )],
            },
        )
        .await
        .expect("home items");

        sqlx::query(
            "INSERT INTO layout_state (
                layout_id, item_revision, camera_revision, camera_center_x, camera_center_y, zoom_bps, next_sort_seq
             ) VALUES (?, 1, 1, 30, 40, 15000, 2)",
        )
        .bind(project_layout_id)
        .execute(&state.pool)
        .await
        .expect("project state");

        sqlx::query(
            "INSERT INTO layout_items (
                layout_id, id, kind, target_id, center_x, center_y, width, height, z_index, sort_seq, title_override
             ) VALUES (?, ?, 'session', 'shared-target', 10, 20, 100, 80, 1, 1, NULL)",
        )
        .bind(project_layout_id)
        .bind("00000000-0000-0000-0000-000000000002")
        .execute(&state.pool)
        .await
        .expect("project item");

        let home = read_layout(&state.pool, HOME_LAYOUT_ID)
            .await
            .expect("layout");
        let project = read_layout(&state.pool, project_layout_id)
            .await
            .expect("project layout");

        assert_eq!(home.layout_id, HOME_LAYOUT_ID);
        assert_eq!(home.item_revision, 1);
        assert_eq!(home.camera_revision, 0);
        assert_eq!(home.items.len(), 1);
        assert_eq!(home.items[0].id, "00000000-0000-0000-0000-000000000001");
        assert_eq!(home.camera.zoom_bps, DEFAULT_ZOOM_BPS);

        assert_eq!(project.layout_id, project_layout_id);
        assert_eq!(project.item_revision, 1);
        assert_eq!(project.camera_revision, 1);
        assert_eq!(project.items.len(), 1);
        assert_eq!(project.items[0].id, "00000000-0000-0000-0000-000000000002");
        assert_eq!(project.camera.zoom_bps, 15_000);
    }

    #[tokio::test]
    async fn public_mutations_reject_unknown_layout_ids() {
        let state = test_state().await;

        let items_error = save_layout_items_in_pool(
            &state.pool,
            SaveLayoutItemsRequest {
                layout_id: "project-1".to_string(),
                expected_revision: 0,
                replace_kinds: all_known_kinds(),
                items: vec![],
            },
        )
        .await
        .expect_err("unknown item layout should fail");
        assert!(items_error.contains("V1 supports only home"));

        let camera_error = save_layout_camera_in_pool(
            &state.pool,
            SaveLayoutCameraRequest {
                layout_id: "project-1".to_string(),
                expected_revision: 0,
                camera: LayoutCamera {
                    center_x: 0.0,
                    center_y: 0.0,
                    zoom_bps: DEFAULT_ZOOM_BPS,
                },
            },
        )
        .await
        .expect_err("unknown camera layout should fail");
        assert!(camera_error.contains("V1 supports only home"));

        let reset_error = reset_layout_in_pool(
            &state.pool,
            ResetLayoutRequest {
                layout_id: "project-1".to_string(),
                expected_item_revision: 0,
                expected_camera_revision: 0,
            },
        )
        .await
        .expect_err("unknown reset layout should fail");
        assert!(reset_error.contains("V1 supports only home"));
    }

    #[tokio::test]
    async fn reset_clears_items_resets_camera_and_keeps_next_sort_seq_monotonic() {
        let state = test_state().await;
        seed_item_and_camera(&state).await;

        let result = reset_layout_in_pool(
            &state.pool,
            ResetLayoutRequest {
                layout_id: HOME_LAYOUT_ID.to_string(),
                expected_item_revision: 1,
                expected_camera_revision: 1,
            },
        )
        .await
        .expect("reset");
        let LayoutMutationResult::Saved { layout } = result else {
            panic!("expected reset");
        };

        assert_eq!(layout.item_revision, 2);
        assert_eq!(layout.camera_revision, 2);
        assert!(layout.items.is_empty());
        assert_eq!(layout.camera.zoom_bps, DEFAULT_ZOOM_BPS);
        let next_sort_seq: i64 =
            sqlx::query_scalar("SELECT next_sort_seq FROM layout_state WHERE layout_id = ?")
                .bind(HOME_LAYOUT_ID)
                .fetch_one(&state.pool)
                .await
                .expect("next sort seq");
        assert_eq!(next_sort_seq, 2);
    }

    #[tokio::test]
    async fn reset_deletes_unknown_future_kinds() {
        let state = test_state().await;

        sqlx::query(
            "INSERT INTO layout_items (
                layout_id, id, kind, target_id, center_x, center_y, width, height, z_index, sort_seq, title_override
             ) VALUES (?, ?, 'future-kind', 'future-1', 10, 20, 100, 80, 1, 1, NULL)",
        )
        .bind(HOME_LAYOUT_ID)
        .bind("00000000-0000-0000-0000-000000000001")
        .execute(&state.pool)
        .await
        .expect("future row");

        reset_layout_in_pool(
            &state.pool,
            ResetLayoutRequest {
                layout_id: HOME_LAYOUT_ID.to_string(),
                expected_item_revision: 0,
                expected_camera_revision: 0,
            },
        )
        .await
        .expect("reset");

        let item_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM layout_items")
            .fetch_one(&state.pool)
            .await
            .expect("item count");
        assert_eq!(item_count, 0);
    }

    #[tokio::test]
    async fn reset_conflicts_on_stale_item_revision_without_partial_work() {
        let state = test_state().await;
        seed_item_and_camera(&state).await;

        let result = reset_layout_in_pool(
            &state.pool,
            ResetLayoutRequest {
                layout_id: HOME_LAYOUT_ID.to_string(),
                expected_item_revision: 0,
                expected_camera_revision: 1,
            },
        )
        .await
        .expect("reset conflict");

        let LayoutMutationResult::RevisionConflict { layout, .. } = result else {
            panic!("expected conflict");
        };
        assert_eq!(layout.item_revision, 1);
        assert_eq!(layout.camera_revision, 1);
        assert_eq!(layout.items.len(), 1);
        assert_eq!(layout.camera.zoom_bps, 20_000);
    }

    #[tokio::test]
    async fn reset_conflicts_on_stale_camera_revision_without_partial_work() {
        let state = test_state().await;
        seed_item_and_camera(&state).await;

        let result = reset_layout_in_pool(
            &state.pool,
            ResetLayoutRequest {
                layout_id: HOME_LAYOUT_ID.to_string(),
                expected_item_revision: 1,
                expected_camera_revision: 0,
            },
        )
        .await
        .expect("reset conflict");

        let LayoutMutationResult::RevisionConflict { layout, .. } = result else {
            panic!("expected conflict");
        };
        assert_eq!(layout.item_revision, 1);
        assert_eq!(layout.camera_revision, 1);
        assert_eq!(layout.items.len(), 1);
        assert_eq!(layout.camera.zoom_bps, 20_000);
    }

    #[tokio::test]
    async fn reset_conflicts_when_both_revisions_are_stale_without_partial_work() {
        let state = test_state().await;
        seed_item_and_camera(&state).await;

        let result = reset_layout_in_pool(
            &state.pool,
            ResetLayoutRequest {
                layout_id: HOME_LAYOUT_ID.to_string(),
                expected_item_revision: 0,
                expected_camera_revision: 0,
            },
        )
        .await
        .expect("reset conflict");

        let LayoutMutationResult::RevisionConflict { layout, .. } = result else {
            panic!("expected conflict");
        };
        assert_eq!(layout.item_revision, 1);
        assert_eq!(layout.camera_revision, 1);
        assert_eq!(layout.items.len(), 1);
        assert_eq!(layout.camera.zoom_bps, 20_000);
    }

    #[tokio::test]
    async fn revision_conflicts_return_latest_layout_without_partial_work() {
        let state = test_state().await;
        let result = save_layout_camera_in_pool(
            &state.pool,
            SaveLayoutCameraRequest {
                layout_id: HOME_LAYOUT_ID.to_string(),
                expected_revision: 7,
                camera: LayoutCamera {
                    center_x: 1.0,
                    center_y: 2.0,
                    zoom_bps: 20_000,
                },
            },
        )
        .await
        .expect("conflict");

        let LayoutMutationResult::RevisionConflict { reason, layout } = result else {
            panic!("expected conflict");
        };
        assert_eq!(reason, LayoutMutationConflictReason::RevisionConflict);
        assert_eq!(layout.camera_revision, 0);
        assert_eq!(layout.camera.zoom_bps, DEFAULT_ZOOM_BPS);
    }

    #[test]
    fn validation_trims_fields_and_rejects_duplicates_after_trim() {
        let duplicate = validate_items(vec![
            item(
                "00000000-0000-0000-0000-000000000001",
                LayoutItemKind::Session,
                " target ",
                1,
            ),
            item(
                "00000000-0000-0000-0000-000000000002",
                LayoutItemKind::Session,
                "target",
                1,
            ),
        ]);
        assert!(duplicate.unwrap_err().contains("targets must be unique"));

        let mut with_title = item(
            "00000000-0000-0000-0000-000000000001",
            LayoutItemKind::Session,
            " target ",
            1,
        );
        with_title.title_override = Some("  A title  ".to_string());
        let validated = validate_items(vec![with_title]).expect("validated");
        assert_eq!(validated[0].target_id, "target");
        assert_eq!(validated[0].title_override.as_deref(), Some("A title"));
    }

    #[test]
    fn save_items_validation_rejects_empty_duplicate_or_mismatched_replace_kinds() {
        let session_item = item(
            "00000000-0000-0000-0000-000000000001",
            LayoutItemKind::Session,
            "target",
            1,
        );

        assert!(
            validate_save_items_request(vec![], vec![session_item.clone()])
                .unwrap_err()
                .contains("cannot be empty")
        );
        assert!(validate_save_items_request(
            vec![LayoutItemKind::Session, LayoutItemKind::Session],
            vec![session_item.clone()],
        )
        .unwrap_err()
        .contains("must be unique"));
        assert!(
            validate_save_items_request(vec![LayoutItemKind::Project], vec![session_item])
                .unwrap_err()
                .contains("included in replaceKinds")
        );
    }

    #[test]
    fn validation_counts_title_override_in_unicode_scalar_values() {
        let mut valid = item(
            "00000000-0000-0000-0000-000000000001",
            LayoutItemKind::Session,
            "target",
            1,
        );
        valid.title_override = Some("\u{2600}".repeat(MAX_TITLE_OVERRIDE_LENGTH));
        assert!(validate_items(vec![valid]).is_ok());

        let mut invalid = item(
            "00000000-0000-0000-0000-000000000001",
            LayoutItemKind::Session,
            "target",
            1,
        );
        invalid.title_override = Some("\u{2600}".repeat(MAX_TITLE_OVERRIDE_LENGTH + 1));
        assert!(validate_items(vec![invalid]).is_err());
    }

    #[test]
    fn validation_rejects_invalid_item_shapes() {
        assert!(validate_items(vec![item(
            "not-a-uuid",
            LayoutItemKind::Session,
            "target",
            1
        )])
        .is_err());
        assert!(validate_items(vec![item(
            "00000000-0000-0000-0000-000000000001",
            LayoutItemKind::Session,
            " ",
            1
        )])
        .is_err());

        let mut bad = item(
            "00000000-0000-0000-0000-000000000001",
            LayoutItemKind::Session,
            "target",
            1,
        );
        bad.center_x = f64::INFINITY;
        assert!(validate_items(vec![bad]).is_err());

        let mut bad = item(
            "00000000-0000-0000-0000-000000000001",
            LayoutItemKind::Session,
            "target",
            1,
        );
        bad.width = 0.0;
        assert!(validate_items(vec![bad]).is_err());

        let mut bad = item(
            "00000000-0000-0000-0000-000000000001",
            LayoutItemKind::Session,
            "target",
            1,
        );
        bad.title_override = Some("x".repeat(MAX_TITLE_OVERRIDE_LENGTH + 1));
        assert!(validate_items(vec![bad]).is_err());
    }

    #[test]
    fn serde_rejects_fractional_or_out_of_range_z_index_and_unknown_kind() {
        let base = json!({
            "id": "00000000-0000-0000-0000-000000000001",
            "kind": "session",
            "targetId": "target",
            "centerX": 0,
            "centerY": 0,
            "width": 10,
            "height": 10,
            "zIndex": 1,
            "titleOverride": null
        });

        let mut fractional = base.clone();
        fractional["zIndex"] = json!(1.5);
        assert!(serde_json::from_value::<LayoutItem>(fractional).is_err());

        let mut out_of_range = base.clone();
        out_of_range["zIndex"] = json!(i64::from(i32::MAX) + 1);
        assert!(serde_json::from_value::<LayoutItem>(out_of_range).is_err());

        let mut unknown_kind = base;
        unknown_kind["kind"] = json!("agent");
        assert!(serde_json::from_value::<LayoutItem>(unknown_kind).is_err());
    }

    #[test]
    fn camera_validation_rejects_out_of_bounds_values() {
        assert!(validate_camera(LayoutCamera {
            center_x: 0.0,
            center_y: 0.0,
            zoom_bps: MIN_ZOOM_BPS - 1,
        })
        .is_err());
        assert!(validate_camera(LayoutCamera {
            center_x: f64::NAN,
            center_y: 0.0,
            zoom_bps: DEFAULT_ZOOM_BPS,
        })
        .is_err());
    }

    #[test]
    fn serde_rejects_fractional_camera_zoom() {
        let fractional = json!({
            "centerX": 0,
            "centerY": 0,
            "zoomBps": 1000.5,
        });

        assert!(serde_json::from_value::<LayoutCamera>(fractional).is_err());
    }
}
