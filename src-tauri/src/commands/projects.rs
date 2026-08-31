use crate::persistence::BerdPersistenceState;
use crate::services::{dir_env, e2e_mode::E2eMode, env_key, goose_config};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use sqlx::{Row, Sqlite, Transaction};
use std::collections::{BTreeMap, HashSet};
use std::ffi::OsString;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, State};
use tokio::sync::Mutex;

const MIGRATION_KEY: &str = "legacy-goose-projects";
const MIGRATION_VERSION: i64 = 1;
const MAX_PROJECT_FILES: usize = 1_000;
const MAX_PROJECT_FILE_BYTES: u64 = 1024 * 1024;
const MAX_BACKUP_BYTES: u64 = MAX_PROJECT_FILES as u64 * MAX_PROJECT_FILE_BYTES;
static SHADOW_IMPORT_LOCK: Mutex<()> = Mutex::const_new(());

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectStorageStatus {
    phase: String,
    collection_revision: i64,
    claimed_scan_generation: i64,
    shadow_completed_at: Option<String>,
    native_activated_at: Option<String>,
    migration_version: Option<i64>,
    migration_scan_generation: Option<i64>,
    migration_state: Option<String>,
    migration_error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShadowImportReport {
    phase: String,
    scan_generation: i64,
    source_count: usize,
    imported: usize,
    updated: usize,
    removed: usize,
    unchanged: usize,
    superseded: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacySessionProjectBackfillRequest {
    session_backend_id: String,
    session_id: String,
    project_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSessionProjectRequest {
    session_backend_id: String,
    session_id: String,
    project_id: Option<String>,
    expected_revision: i64,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionProjectAssociation {
    session_backend_id: String,
    session_id: String,
    has_association: bool,
    project_id: Option<String>,
    revision: Option<i64>,
}

#[derive(Debug)]
struct LegacyProject {
    source_path: String,
    fingerprint: String,
    backup_path: String,
    project: StoredProject,
}

#[derive(Debug)]
struct LegacyScan {
    source_present: bool,
    source_root: Option<String>,
    projects: Vec<LegacyProject>,
}

#[derive(Debug)]
struct StoredProject {
    id: String,
    name: String,
    description: String,
    prompt: String,
    icon: String,
    color: String,
    use_worktrees: bool,
    order: i64,
    archived_at: Option<String>,
    artifact_json: Option<String>,
    chat_groups_json: Option<String>,
    properties_json: String,
    workspaces: Vec<StoredWorkspace>,
}

#[derive(Debug)]
struct StoredWorkspace {
    id: String,
    path: String,
    kind: String,
    source: String,
    branch: Option<String>,
    repository_path: Option<String>,
    worktree_path: Option<String>,
    startup_mode: String,
}

#[derive(Debug, Default, Deserialize)]
struct LegacyFrontmatter {
    #[serde(default)]
    name: String,
    #[serde(default)]
    description: String,
    #[serde(default, flatten)]
    properties: BTreeMap<String, Value>,
}

#[tauri::command]
pub async fn get_project_storage_status(
    state: State<'_, BerdPersistenceState>,
) -> Result<ProjectStorageStatus, String> {
    project_storage_status(state.pool()).await
}

#[tauri::command]
pub async fn shadow_import_legacy_projects(
    app: AppHandle,
    state: State<'_, BerdPersistenceState>,
) -> Result<ShadowImportReport, String> {
    let _import_guard = SHADOW_IMPORT_LOCK.lock().await;
    let scan_generation = claim_shadow_scan(state.pool()).await?;
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Failed to resolve Berd app data directory: {error}"))?;
    let goose_data_dir = if let Some(e2e_mode) = app.try_state::<E2eMode>() {
        e2e_mode.goose_data_dir()
    } else {
        let shell_env = dir_env::capture_home_interactive_env().await;
        goose_config::data_dir_from_values(
            std::env::var_os(goose_config::GOOSE_PATH_ROOT_ENV),
            env_key::get(&shell_env, goose_config::GOOSE_PATH_ROOT_ENV).map(OsString::from),
        )?
    };
    let source_dir = goose_data_dir.join("projects");
    let backup_dir = app_data_dir
        .join("project-migration-backups")
        .join(format!("v{MIGRATION_VERSION}"));

    let scan = match tauri::async_runtime::spawn_blocking(move || {
        scan_legacy_projects(&source_dir, &backup_dir)
    })
    .await
    {
        Ok(Ok(scan)) => scan,
        Ok(Err(error)) => {
            record_import_failure(state.pool(), scan_generation, &error).await?;
            return Err(error);
        }
        Err(error) => {
            let error = format!("Legacy project scan task failed: {error}");
            record_import_failure(state.pool(), scan_generation, &error).await?;
            return Err(error);
        }
    };

    match apply_shadow_import(state.pool(), scan, scan_generation).await {
        Ok(report) => Ok(report),
        Err(error) if error.contains("disabled after native storage activation") => Err(error),
        Err(error) => {
            record_import_failure(state.pool(), scan_generation, &error).await?;
            Err(error)
        }
    }
}

#[tauri::command]
pub async fn backfill_legacy_session_project(
    state: State<'_, BerdPersistenceState>,
    request: LegacySessionProjectBackfillRequest,
) -> Result<SessionProjectAssociation, String> {
    validate_session_key(&request.session_backend_id, &request.session_id)?;
    validate_stored_project_id(&request.project_id)?;
    backfill_legacy_association(state.pool(), request).await
}

#[tauri::command]
pub async fn resolve_session_project(
    state: State<'_, BerdPersistenceState>,
    session_backend_id: String,
    session_id: String,
) -> Result<SessionProjectAssociation, String> {
    validate_session_key(&session_backend_id, &session_id)?;
    read_session_association(state.pool(), &session_backend_id, &session_id).await
}

#[tauri::command]
pub async fn update_native_session_project(
    state: State<'_, BerdPersistenceState>,
    request: UpdateSessionProjectRequest,
) -> Result<SessionProjectAssociation, String> {
    validate_session_key(&request.session_backend_id, &request.session_id)?;
    if request.expected_revision < 0 {
        return Err("Session project expected revision must not be negative".to_string());
    }
    if let Some(project_id) = &request.project_id {
        validate_stored_project_id(project_id)?;
    }
    update_native_association(state.pool(), request).await
}

async fn project_storage_status(pool: &sqlx::SqlitePool) -> Result<ProjectStorageStatus, String> {
    ensure_supported_migration_version(pool).await?;
    let row = sqlx::query(
        "SELECT phase, collection_revision, shadow_scan_generation, shadow_completed_at, native_activated_at \
         FROM project_storage_state WHERE singleton_id = 1",
    )
    .fetch_one(pool)
    .await
    .map_err(db_error)?;
    let migration =
        sqlx::query(
            "SELECT version, scan_generation, state, last_error FROM project_migration_runs WHERE migration_key = ?",
        )
            .bind(MIGRATION_KEY)
            .fetch_optional(pool)
            .await
            .map_err(db_error)?;

    Ok(ProjectStorageStatus {
        phase: row.get("phase"),
        collection_revision: row.get("collection_revision"),
        claimed_scan_generation: row.get("shadow_scan_generation"),
        shadow_completed_at: row.get("shadow_completed_at"),
        native_activated_at: row.get("native_activated_at"),
        migration_version: migration.as_ref().map(|row| row.get("version")),
        migration_scan_generation: migration.as_ref().map(|row| row.get("scan_generation")),
        migration_state: migration.as_ref().map(|row| row.get("state")),
        migration_error: migration.and_then(|row| row.get("last_error")),
    })
}

async fn claim_shadow_scan(pool: &sqlx::SqlitePool) -> Result<i64, String> {
    let mut transaction = pool.begin_with("BEGIN IMMEDIATE").await.map_err(db_error)?;
    ensure_supported_migration_version_in_transaction(&mut transaction).await?;
    let phase: String =
        sqlx::query_scalar("SELECT phase FROM project_storage_state WHERE singleton_id = 1")
            .fetch_one(&mut *transaction)
            .await
            .map_err(db_error)?;
    if phase == "native" {
        return Err(
            "Legacy project import is disabled after native storage activation".to_string(),
        );
    }
    let generation: i64 = sqlx::query_scalar(
        "UPDATE project_storage_state SET shadow_scan_generation = shadow_scan_generation + 1 \
         WHERE singleton_id = 1 RETURNING shadow_scan_generation",
    )
    .fetch_one(&mut *transaction)
    .await
    .map_err(db_error)?;
    transaction.commit().await.map_err(db_error)?;
    Ok(generation)
}

fn scan_legacy_projects(source_dir: &Path, backup_dir: &Path) -> Result<LegacyScan, String> {
    if !source_dir.exists() {
        return Ok(LegacyScan {
            source_present: false,
            source_root: None,
            projects: Vec::new(),
        });
    }

    let unresolved_root_metadata = fs::symlink_metadata(source_dir).map_err(|error| {
        format!(
            "Failed to inspect legacy projects directory {}: {error}",
            source_dir.display()
        )
    })?;
    if unresolved_root_metadata.file_type().is_symlink() {
        return Err(format!(
            "Legacy projects root must not be a symlink: {}",
            source_dir.display()
        ));
    }
    let source_root = source_dir.canonicalize().map_err(|error| {
        format!(
            "Failed to canonicalize legacy projects directory {}: {error}",
            source_dir.display()
        )
    })?;
    let root_metadata = fs::symlink_metadata(&source_root).map_err(|error| {
        format!(
            "Failed to inspect legacy projects directory {}: {error}",
            source_root.display()
        )
    })?;
    if !root_metadata.is_dir() || root_metadata.file_type().is_symlink() {
        return Err(format!(
            "Legacy projects root is not a regular directory: {}",
            source_root.display()
        ));
    }

    let mut paths = Vec::new();
    for entry in fs::read_dir(&source_root).map_err(|error| {
        format!(
            "Failed to read legacy projects directory {}: {error}",
            source_root.display()
        )
    })? {
        let entry =
            entry.map_err(|error| format!("Failed to read legacy project entry: {error}"))?;
        let path = entry.path();
        if path.extension().and_then(|extension| extension.to_str()) != Some("md") {
            continue;
        }
        if paths.len() == MAX_PROJECT_FILES {
            return Err(format!(
                "Legacy project import exceeds the {MAX_PROJECT_FILES}-file safety limit"
            ));
        }
        paths.push(path);
    }
    paths.sort_by(|left, right| left.file_name().cmp(&right.file_name()));

    let (backup_dir, mut backup_bytes) = prepare_backup_directory(backup_dir, &source_root)?;

    let mut candidates = Vec::with_capacity(paths.len());
    let mut ids = HashSet::new();
    for path in paths {
        let (bytes, canonical_path) = read_bounded_regular_file(&source_root, &path)?;
        let raw = std::str::from_utf8(&bytes).map_err(|_| {
            format!(
                "Legacy project is not valid UTF-8: {}",
                canonical_path.display()
            )
        })?;
        let id = canonical_path
            .file_stem()
            .and_then(|stem| stem.to_str())
            .ok_or_else(|| {
                format!(
                    "Legacy project filename is not valid UTF-8: {}",
                    canonical_path.display()
                )
            })?
            .to_string();
        validate_stored_project_id(&id)?;
        if !ids.insert(id.clone()) {
            return Err(format!("Duplicate legacy project id: {id}"));
        }

        let fingerprint = hex::encode(Sha256::digest(&bytes));
        let backup_path = publish_backup(&backup_dir, &fingerprint, &bytes, &mut backup_bytes)?;
        candidates.push(LegacyProject {
            source_path: canonical_path.to_string_lossy().into_owned(),
            fingerprint,
            backup_path: backup_path.to_string_lossy().into_owned(),
            project: parse_legacy_project(&id, raw)?,
        });
    }
    sync_directory(&backup_dir)?;
    Ok(LegacyScan {
        source_present: true,
        source_root: Some(source_root.to_string_lossy().into_owned()),
        projects: candidates,
    })
}

fn read_bounded_regular_file(root: &Path, path: &Path) -> Result<(Vec<u8>, PathBuf), String> {
    let metadata = fs::symlink_metadata(path).map_err(|error| {
        format!(
            "Failed to inspect legacy project {}: {error}",
            path.display()
        )
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(format!(
            "Legacy project must be a regular non-symlink file: {}",
            path.display()
        ));
    }
    if metadata.len() > MAX_PROJECT_FILE_BYTES {
        return Err(format!(
            "Legacy project exceeds the {MAX_PROJECT_FILE_BYTES}-byte safety limit: {}",
            path.display()
        ));
    }

    let canonical_path = path.canonicalize().map_err(|error| {
        format!(
            "Failed to resolve legacy project {}: {error}",
            path.display()
        )
    })?;
    if canonical_path.parent() != Some(root) {
        return Err(format!(
            "Legacy project escaped the fixed projects root: {}",
            canonical_path.display()
        ));
    }

    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let file = options.open(&canonical_path).map_err(|error| {
        format!(
            "Failed to open legacy project {} without following links: {error}",
            canonical_path.display()
        )
    })?;
    let opened_metadata = file.metadata().map_err(|error| {
        format!(
            "Failed to inspect opened legacy project {}: {error}",
            canonical_path.display()
        )
    })?;
    if !opened_metadata.is_file() || opened_metadata.len() > MAX_PROJECT_FILE_BYTES {
        return Err(format!(
            "Legacy project changed while being scanned: {}",
            canonical_path.display()
        ));
    }
    let mut bytes = Vec::with_capacity(opened_metadata.len() as usize);
    file.take(MAX_PROJECT_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| {
            format!(
                "Failed to read legacy project {}: {error}",
                canonical_path.display()
            )
        })?;
    if bytes.len() as u64 > MAX_PROJECT_FILE_BYTES {
        return Err(format!(
            "Legacy project grew beyond the safety limit while being scanned: {}",
            canonical_path.display()
        ));
    }
    Ok((bytes, canonical_path))
}

fn parse_legacy_project(id: &str, raw: &str) -> Result<StoredProject, String> {
    let (frontmatter, prompt) = parse_legacy_frontmatter(raw);
    let mut properties = frontmatter.properties;
    let name = if frontmatter.name.is_empty() {
        id.to_string()
    } else {
        frontmatter.name
    };
    if name != id {
        properties.insert("title".to_string(), Value::String(name.clone()));
    }

    let workspaces = parse_workspaces(&properties)?;
    Ok(StoredProject {
        id: id.to_string(),
        name,
        description: frontmatter.description,
        prompt,
        icon: string_property(&properties, "icon").unwrap_or_default(),
        color: string_property(&properties, "color").unwrap_or_default(),
        use_worktrees: properties
            .get("useWorktrees")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        order: properties.get("order").and_then(Value::as_i64).unwrap_or(0),
        archived_at: string_property(&properties, "archivedAt"),
        artifact_json: optional_json_property(&properties, "artifact")?,
        chat_groups_json: optional_json_property(&properties, "chatGroups")?,
        properties_json: serde_json::to_string(&properties)
            .map_err(|error| format!("Failed to preserve project properties: {error}"))?,
        workspaces,
    })
}

fn parse_legacy_frontmatter(raw: &str) -> (LegacyFrontmatter, String) {
    if !raw.trim_start().starts_with("---") {
        return (LegacyFrontmatter::default(), raw.to_string());
    }
    let parts: Vec<&str> = raw.split("---").collect();
    if parts.len() < 3 {
        return (LegacyFrontmatter::default(), raw.to_string());
    }
    match yaml_serde::from_str::<LegacyFrontmatter>(parts[1].trim()) {
        Ok(frontmatter) => (frontmatter, parts[2..].join("---").trim().to_string()),
        Err(_) => (LegacyFrontmatter::default(), raw.to_string()),
    }
}

fn parse_workspaces(properties: &BTreeMap<String, Value>) -> Result<Vec<StoredWorkspace>, String> {
    if let Some(value) = properties.get("projectWorkspaces") {
        let workspaces: Vec<Value> = serde_json::from_value(value.clone())
            .map_err(|error| format!("Invalid projectWorkspaces metadata: {error}"))?;
        let mut stored = Vec::with_capacity(workspaces.len());
        for workspace in workspaces {
            let Some(workspace) = workspace.as_object() else {
                continue;
            };
            let Some(path) = workspace
                .get("path")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|path| !path.is_empty())
                .map(str::to_string)
            else {
                continue;
            };
            let id = workspace
                .get("id")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
                .map(str::to_string)
                .unwrap_or_else(|| workspace_id(&path));
            stored.push(StoredWorkspace {
                id,
                path,
                kind: valid_workspace_kind(workspace.get("kind")),
                source: valid_workspace_source(workspace.get("source")),
                branch: workspace
                    .get("branch")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                repository_path: trimmed_string(workspace.get("repositoryPath")),
                worktree_path: trimmed_string(workspace.get("worktreePath")),
                startup_mode: valid_startup_mode(workspace.get("startupMode")),
            });
        }
        let stored = dedupe_workspaces(stored);
        if !stored.is_empty() {
            return Ok(stored);
        }
    }

    let working_dirs: Vec<String> = properties
        .get("workingDirs")
        .cloned()
        .map(serde_json::from_value)
        .transpose()
        .map_err(|error| format!("Invalid workingDirs metadata: {error}"))?
        .unwrap_or_default();
    let startup_mode = if properties
        .get("useWorktrees")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        "auto-worktree"
    } else {
        "none"
    };
    Ok(dedupe_workspaces(
        working_dirs
            .into_iter()
            .filter_map(|path| {
                let path = path.trim().to_string();
                (!path.is_empty()).then(|| StoredWorkspace {
                    id: workspace_id(&path),
                    path,
                    kind: "directory".to_string(),
                    source: "inferred".to_string(),
                    branch: None,
                    repository_path: None,
                    worktree_path: None,
                    startup_mode: startup_mode.to_string(),
                })
            })
            .collect(),
    ))
}

fn workspace_id(path: &str) -> String {
    format!("path:{}", workspace_identity_key(path))
}

fn dedupe_workspaces(workspaces: Vec<StoredWorkspace>) -> Vec<StoredWorkspace> {
    let mut identities = Vec::<String>::new();
    let mut deduped = Vec::<StoredWorkspace>::new();
    for workspace in workspaces {
        let identity = workspace_identity_key(&workspace.path);
        if let Some(position) = identities.iter().position(|existing| existing == &identity) {
            deduped[position] = workspace;
        } else {
            identities.push(identity);
            deduped.push(workspace);
        }
    }
    deduped
}

fn valid_workspace_kind(value: Option<&Value>) -> String {
    match value.and_then(Value::as_str) {
        Some(
            value @ ("repository"
            | "git-main-worktree"
            | "git-linked-worktree"
            | "git-detached-checkout"
            | "subdirectory"
            | "non-git-directory"),
        ) => value.to_string(),
        _ => "directory".to_string(),
    }
}

fn valid_workspace_source(value: Option<&Value>) -> String {
    match value.and_then(Value::as_str) {
        Some(value @ ("selected" | "created" | "excluded" | "inferred")) => value.to_string(),
        _ => "inferred".to_string(),
    }
}

fn valid_startup_mode(value: Option<&Value>) -> String {
    match value.and_then(Value::as_str) {
        Some("worktree") => "auto-worktree".to_string(),
        Some("branch") => "ask-worktree".to_string(),
        Some(value @ ("ask-worktree" | "auto-worktree")) => value.to_string(),
        _ => "none".to_string(),
    }
}

fn trimmed_string(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn workspace_identity_key(path: &str) -> String {
    let normalized = normalize_lexical_path(path);
    if is_windows_absolute_path(path) || cfg!(target_os = "macos") {
        normalized.to_lowercase()
    } else {
        normalized
    }
}

fn is_windows_absolute_path(path: &str) -> bool {
    let path = path.trim().replace('\\', "/");
    let bytes = path.as_bytes();
    (bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && bytes[2] == b'/')
        || windows_unc_root_parts(&path).is_some_and(|(server, share, _)| {
            !matches!(server, "." | "..") && !matches!(share, "." | "..")
        })
}

fn windows_unc_root_parts(path: &str) -> Option<(&str, &str, &str)> {
    let unc = path.strip_prefix("//")?;
    let mut parts = unc.splitn(3, '/');
    let server = parts.next()?;
    let share = parts.next()?;
    if server.is_empty() || share.is_empty() || server == "." || share == ".." {
        return None;
    }
    Some((server, share, parts.next().unwrap_or_default()))
}

fn normalize_lexical_path(path: &str) -> String {
    let mut path = path.trim().replace('\\', "/");
    let is_drive_root = path.len() == 3
        && path.as_bytes()[0].is_ascii_alphabetic()
        && path.as_bytes()[1] == b':'
        && path.as_bytes()[2] == b'/';
    if path != "/" && !is_drive_root {
        while path.ends_with('/') {
            path.pop();
        }
    }

    let bytes = path.as_bytes();
    let (prefix, remainder) = if bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && bytes[2] == b'/'
    {
        (path[..3].to_string(), path[3..].to_string())
    } else if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        (path[..2].to_string(), path[2..].to_string())
    } else if let Some((server, share, remainder)) = windows_unc_root_parts(&path) {
        (format!("//{server}/{share}"), remainder.to_string())
    } else if let Some(remainder) = path.strip_prefix('/') {
        ("/".to_string(), remainder.to_string())
    } else {
        (String::new(), path)
    };
    let clamps_parent = prefix == "/" || prefix.ends_with('/') || prefix.starts_with("//");
    let mut segments: Vec<&str> = Vec::new();
    for segment in remainder.split('/') {
        match segment {
            "" | "." => {}
            ".." if segments.last().is_some_and(|last| *last != "..") => {
                segments.pop();
            }
            ".." if !clamps_parent => segments.push(segment),
            ".." => {}
            _ => segments.push(segment),
        }
    }
    let joined = segments.join("/");
    match (prefix.as_str(), joined.is_empty()) {
        ("", _) => joined,
        ("/", true) => "/".to_string(),
        (_, true) => prefix,
        (_, false) if prefix.ends_with('/') || is_drive_relative_prefix(&prefix) => {
            format!("{prefix}{joined}")
        }
        (_, false) => format!("{prefix}/{joined}"),
    }
}

fn is_drive_relative_prefix(prefix: &str) -> bool {
    let bytes = prefix.as_bytes();
    bytes.len() == 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':'
}

fn string_property(properties: &BTreeMap<String, Value>, key: &str) -> Option<String> {
    properties
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn optional_json_property(
    properties: &BTreeMap<String, Value>,
    key: &str,
) -> Result<Option<String>, String> {
    properties
        .get(key)
        .filter(|value| !value.is_null())
        .map(serde_json::to_string)
        .transpose()
        .map_err(|error| format!("Failed to preserve project {key}: {error}"))
}

fn validate_stored_project_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > 255 {
        return Err(format!("Invalid legacy project id: {id:?}"));
    }
    Ok(())
}

fn prepare_backup_directory(
    backup_dir: &Path,
    source_root: &Path,
) -> Result<(PathBuf, u64), String> {
    let anchor = backup_dir
        .parent()
        .and_then(Path::parent)
        .ok_or_else(|| format!("Invalid project backup path: {}", backup_dir.display()))?;
    let canonical_anchor = anchor.canonicalize().map_err(|error| {
        format!(
            "Failed to resolve Berd app data directory {}: {error}",
            anchor.display()
        )
    })?;
    let relative = backup_dir.strip_prefix(anchor).map_err(|_| {
        format!(
            "Project backup path escaped Berd app data: {}",
            backup_dir.display()
        )
    })?;
    let mut current = canonical_anchor.clone();
    for component in relative.components() {
        let std::path::Component::Normal(component) = component else {
            return Err(format!(
                "Project backup path contains an unsafe component: {}",
                backup_dir.display()
            ));
        };
        current.push(component);
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
                return Err(format!(
                    "Project backup path component must be a non-symlink directory: {}",
                    current.display()
                ));
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                fs::create_dir(&current).map_err(|error| {
                    format!(
                        "Failed to create project backup directory {}: {error}",
                        current.display()
                    )
                })?;
            }
            Err(error) => {
                return Err(format!(
                    "Failed to inspect project backup directory {}: {error}",
                    current.display()
                ));
            }
        }
    }
    let canonical_backup = current.canonicalize().map_err(|error| {
        format!(
            "Failed to resolve project backup directory {}: {error}",
            current.display()
        )
    })?;
    if !canonical_backup.starts_with(&canonical_anchor)
        || canonical_backup.starts_with(source_root)
        || source_root.starts_with(&canonical_backup)
    {
        return Err(format!(
            "Project backup directory escaped its fixed Berd app-data root: {}",
            canonical_backup.display()
        ));
    }

    let mut total_bytes = 0_u64;
    for entry in fs::read_dir(&canonical_backup).map_err(|error| {
        format!(
            "Failed to inspect project backup directory {}: {error}",
            canonical_backup.display()
        )
    })? {
        let entry = entry.map_err(|error| format!("Failed to inspect project backup: {error}"))?;
        let metadata = fs::symlink_metadata(entry.path()).map_err(|error| {
            format!(
                "Failed to inspect project backup {}: {error}",
                entry.path().display()
            )
        })?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(format!(
                "Project backup entries must be regular non-symlink files: {}",
                entry.path().display()
            ));
        }
        total_bytes = total_bytes
            .checked_add(metadata.len())
            .ok_or_else(|| "Project backup size overflowed".to_string())?;
    }
    if total_bytes > MAX_BACKUP_BYTES {
        return Err(format!(
            "Project backups exceed the {MAX_BACKUP_BYTES}-byte safety limit"
        ));
    }
    Ok((canonical_backup, total_bytes))
}

fn publish_backup(
    backup_dir: &Path,
    fingerprint: &str,
    bytes: &[u8],
    total_bytes: &mut u64,
) -> Result<PathBuf, String> {
    let path = backup_dir.join(format!("{fingerprint}.md"));
    if path.exists() {
        verify_backup(&path, bytes)?;
        return Ok(path);
    }
    let next_total = total_bytes
        .checked_add(bytes.len() as u64)
        .ok_or_else(|| "Project backup size overflowed".to_string())?;
    if next_total > MAX_BACKUP_BYTES {
        return Err(format!(
            "Project backups would exceed the {MAX_BACKUP_BYTES}-byte safety limit"
        ));
    }

    let temporary = backup_dir.join(format!(".{fingerprint}.{}.tmp", uuid::Uuid::new_v4()));
    let mut options = OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let mut file = options.open(&temporary).map_err(|error| {
        format!(
            "Failed to stage legacy project backup {}: {error}",
            temporary.display()
        )
    })?;
    file.write_all(bytes).map_err(|error| {
        format!(
            "Failed to write legacy project backup {}: {error}",
            temporary.display()
        )
    })?;
    file.sync_all().map_err(|error| {
        format!(
            "Failed to sync legacy project backup {}: {error}",
            temporary.display()
        )
    })?;
    if let Err(error) = fs::hard_link(&temporary, &path) {
        if path.exists() {
            verify_backup(&path, bytes)?;
            let _ = fs::remove_file(&temporary);
        } else {
            let _ = fs::remove_file(&temporary);
            return Err(format!(
                "Failed to publish legacy project backup {}: {error}",
                path.display()
            ));
        }
    } else {
        fs::remove_file(&temporary).map_err(|error| {
            format!(
                "Failed to remove staged project backup {}: {error}",
                temporary.display()
            )
        })?;
        *total_bytes = next_total;
    }
    Ok(path)
}

fn verify_backup(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path).map_err(|error| {
        format!(
            "Failed to inspect project backup {}: {error}",
            path.display()
        )
    })?;
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.len() > MAX_PROJECT_FILE_BYTES
    {
        return Err(format!(
            "Project backup must be a bounded regular non-symlink file: {}",
            path.display()
        ));
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let file = options.open(path).map_err(|error| {
        format!(
            "Failed to verify project backup {}: {error}",
            path.display()
        )
    })?;
    let mut existing = Vec::with_capacity(metadata.len() as usize);
    file.take(MAX_PROJECT_FILE_BYTES + 1)
        .read_to_end(&mut existing)
        .map_err(|error| {
            format!(
                "Failed to verify project backup {}: {error}",
                path.display()
            )
        })?;
    if Sha256::digest(existing) != Sha256::digest(bytes) {
        return Err(format!(
            "Project backup fingerprint collision at {}",
            path.display()
        ));
    }
    Ok(())
}

#[cfg(unix)]
fn sync_directory(path: &Path) -> Result<(), String> {
    File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| format!("Failed to sync directory {}: {error}", path.display()))
}

#[cfg(not(unix))]
fn sync_directory(_path: &Path) -> Result<(), String> {
    Ok(())
}

async fn apply_shadow_import(
    pool: &sqlx::SqlitePool,
    scan: LegacyScan,
    expected_generation: i64,
) -> Result<ShadowImportReport, String> {
    let mut transaction = pool.begin_with("BEGIN IMMEDIATE").await.map_err(db_error)?;
    ensure_supported_migration_version_in_transaction(&mut transaction).await?;
    let state = sqlx::query(
        "SELECT phase, shadow_scan_generation FROM project_storage_state WHERE singleton_id = 1",
    )
    .fetch_one(&mut *transaction)
    .await
    .map_err(db_error)?;
    let phase: String = state.get("phase");
    if phase == "native" {
        return Err(
            "Legacy project import is disabled after native storage activation".to_string(),
        );
    }
    if state.get::<i64, _>("shadow_scan_generation") != expected_generation {
        return Ok(ShadowImportReport {
            phase,
            scan_generation: expected_generation,
            source_count: scan.projects.len(),
            imported: 0,
            updated: 0,
            removed: 0,
            unchanged: 0,
            superseded: true,
        });
    }

    let previous_migration =
        sqlx::query("SELECT checkpoint_json FROM project_migration_runs WHERE migration_key = ?")
            .bind(MIGRATION_KEY)
            .fetch_optional(&mut *transaction)
            .await
            .map_err(db_error)?;
    let previous_checkpoint = previous_migration
        .as_ref()
        .map(|row| row.get::<String, _>("checkpoint_json"));
    let previous_root = previous_checkpoint
        .as_deref()
        .and_then(|checkpoint| serde_json::from_str::<Value>(checkpoint).ok())
        .and_then(|checkpoint| {
            checkpoint
                .get("sourceRoot")
                .and_then(Value::as_str)
                .map(str::to_string)
        });
    if let (Some(previous_root), Some(current_root)) = (&previous_root, &scan.source_root) {
        if previous_root != current_root {
            return Err(format!(
                "Legacy projects root changed from {previous_root} to {current_root}; refusing to replace the existing shadow mirror"
            ));
        }
    }

    let now = Utc::now().to_rfc3339();
    let mut imported = 0;
    let mut updated = 0;
    let mut unchanged = 0;
    let mut source_paths = HashSet::new();
    for candidate in &scan.projects {
        source_paths.insert(candidate.source_path.clone());
        let receipt = sqlx::query(
            "SELECT source_fingerprint, project_id FROM legacy_project_imports WHERE source_path = ?",
        )
        .bind(&candidate.source_path)
        .fetch_optional(&mut *transaction)
        .await
        .map_err(db_error)?;
        match receipt {
            Some(row)
                if row.get::<String, _>("source_fingerprint") == candidate.fingerprint
                    && row.get::<String, _>("project_id") == candidate.project.id =>
            {
                unchanged += 1;
                continue;
            }
            Some(row) if row.get::<String, _>("project_id") != candidate.project.id => {
                return Err(format!(
                    "Legacy source {} changed project identity",
                    candidate.source_path
                ));
            }
            Some(_) => updated += 1,
            None => {
                let owner: Option<String> = sqlx::query_scalar(
                    "SELECT source_path FROM legacy_project_imports WHERE project_id = ?",
                )
                .bind(&candidate.project.id)
                .fetch_optional(&mut *transaction)
                .await
                .map_err(db_error)?;
                if let Some(owner) = owner {
                    return Err(format!(
                        "Legacy project id {} is already owned by {}",
                        candidate.project.id, owner
                    ));
                }
                imported += 1;
            }
        }
        upsert_project(&mut transaction, &candidate.project, &now).await?;
        sqlx::query(
            "INSERT INTO legacy_project_imports \
             (source_path, source_fingerprint, project_id, backup_path, imported_at) \
             VALUES (?, ?, ?, ?, ?) \
             ON CONFLICT(source_path) DO UPDATE SET \
             source_fingerprint = excluded.source_fingerprint, \
             project_id = excluded.project_id, backup_path = excluded.backup_path, \
             imported_at = excluded.imported_at",
        )
        .bind(&candidate.source_path)
        .bind(&candidate.fingerprint)
        .bind(&candidate.project.id)
        .bind(&candidate.backup_path)
        .bind(&now)
        .execute(&mut *transaction)
        .await
        .map_err(db_error)?;
    }

    let mut removed = 0;
    if scan.source_present {
        let receipts = sqlx::query("SELECT source_path, project_id FROM legacy_project_imports")
            .fetch_all(&mut *transaction)
            .await
            .map_err(db_error)?;
        for receipt in receipts {
            let source_path: String = receipt.get("source_path");
            if source_paths.contains(&source_path) {
                continue;
            }
            let project_id: String = receipt.get("project_id");
            sqlx::query("DELETE FROM legacy_project_imports WHERE source_path = ?")
                .bind(&source_path)
                .execute(&mut *transaction)
                .await
                .map_err(db_error)?;
            sqlx::query(
                "DELETE FROM session_projects WHERE project_id = ? AND source = 'legacy-backfill'",
            )
            .bind(&project_id)
            .execute(&mut *transaction)
            .await
            .map_err(db_error)?;
            sqlx::query("DELETE FROM projects WHERE id = ?")
                .bind(&project_id)
                .execute(&mut *transaction)
                .await
                .map_err(db_error)?;
            removed += 1;
        }
    }

    let changed = imported > 0 || updated > 0 || removed > 0;
    let checkpoint_root = scan.source_root.as_ref().or(previous_root.as_ref());
    let checkpoint = serde_json::json!({
        "scanGeneration": expected_generation,
        "sourcePresent": scan.source_present,
        "sourceRoot": checkpoint_root,
        "sourceCount": scan.projects.len(),
        "imported": imported,
        "updated": updated,
        "removed": removed,
        "unchanged": unchanged,
    });
    sqlx::query(
        "INSERT INTO project_migration_runs \
         (migration_key, version, scan_generation, state, checkpoint_json, completed_at, last_error, updated_at) \
         VALUES (?, ?, ?, 'complete', ?, ?, NULL, ?) \
         ON CONFLICT(migration_key) DO UPDATE SET \
         scan_generation = excluded.scan_generation, state = 'complete', \
         checkpoint_json = excluded.checkpoint_json, \
         completed_at = excluded.completed_at, last_error = NULL, \
         updated_at = excluded.updated_at",
    )
    .bind(MIGRATION_KEY)
    .bind(MIGRATION_VERSION)
    .bind(expected_generation)
    .bind(checkpoint.to_string())
    .bind(&now)
    .bind(&now)
    .execute(&mut *transaction)
    .await
    .map_err(db_error)?;
    if changed || phase == "legacy" {
        sqlx::query(
            "UPDATE project_storage_state SET phase = 'shadow', \
             collection_revision = collection_revision + 1, shadow_completed_at = ? \
             WHERE singleton_id = 1 AND phase IN ('legacy', 'shadow')",
        )
        .bind(&now)
        .execute(&mut *transaction)
        .await
        .map_err(db_error)?;
    }
    transaction.commit().await.map_err(db_error)?;

    Ok(ShadowImportReport {
        phase: "shadow".to_string(),
        scan_generation: expected_generation,
        source_count: scan.projects.len(),
        imported,
        updated,
        removed,
        unchanged,
        superseded: false,
    })
}

async fn upsert_project(
    transaction: &mut Transaction<'_, Sqlite>,
    project: &StoredProject,
    now: &str,
) -> Result<(), String> {
    sqlx::query(
        "INSERT INTO projects \
         (id, name, description, prompt, icon, color, use_worktrees, order_index, \
          archived_at, artifact_json, chat_groups_json, extra_properties_json, revision, \
          created_at, updated_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?) \
         ON CONFLICT(id) DO UPDATE SET \
         name = excluded.name, description = excluded.description, prompt = excluded.prompt, \
         icon = excluded.icon, color = excluded.color, use_worktrees = excluded.use_worktrees, \
         order_index = excluded.order_index, archived_at = excluded.archived_at, \
         artifact_json = excluded.artifact_json, chat_groups_json = excluded.chat_groups_json, \
         extra_properties_json = excluded.extra_properties_json, \
         revision = projects.revision + 1, updated_at = excluded.updated_at",
    )
    .bind(&project.id)
    .bind(&project.name)
    .bind(&project.description)
    .bind(&project.prompt)
    .bind(&project.icon)
    .bind(&project.color)
    .bind(project.use_worktrees)
    .bind(project.order)
    .bind(&project.archived_at)
    .bind(&project.artifact_json)
    .bind(&project.chat_groups_json)
    .bind(&project.properties_json)
    .bind(now)
    .bind(now)
    .execute(&mut **transaction)
    .await
    .map_err(db_error)?;

    sqlx::query("DELETE FROM project_workspaces WHERE project_id = ?")
        .bind(&project.id)
        .execute(&mut **transaction)
        .await
        .map_err(db_error)?;
    for (position, workspace) in project.workspaces.iter().enumerate() {
        sqlx::query(
            "INSERT INTO project_workspaces \
             (project_id, position, workspace_id, path, kind, source, branch, repository_path, \
              worktree_path, startup_mode) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&project.id)
        .bind(position as i64)
        .bind(&workspace.id)
        .bind(&workspace.path)
        .bind(&workspace.kind)
        .bind(&workspace.source)
        .bind(&workspace.branch)
        .bind(&workspace.repository_path)
        .bind(&workspace.worktree_path)
        .bind(&workspace.startup_mode)
        .execute(&mut **transaction)
        .await
        .map_err(db_error)?;
    }
    Ok(())
}

async fn backfill_legacy_association(
    pool: &sqlx::SqlitePool,
    request: LegacySessionProjectBackfillRequest,
) -> Result<SessionProjectAssociation, String> {
    let mut transaction = pool.begin_with("BEGIN IMMEDIATE").await.map_err(db_error)?;
    require_phase_one_of(&mut transaction, &["shadow", "native"]).await?;
    let existing = read_session_association_in_transaction(
        &mut transaction,
        &request.session_backend_id,
        &request.session_id,
    )
    .await?;
    if existing.has_association {
        transaction.commit().await.map_err(db_error)?;
        return Ok(existing);
    }
    require_existing_project(&mut transaction, Some(&request.project_id)).await?;
    let now = Utc::now().to_rfc3339();
    sqlx::query(
        "INSERT OR IGNORE INTO session_projects \
         (session_backend_id, session_id, project_id, source, revision, updated_at) \
         VALUES (?, ?, ?, 'legacy-backfill', 1, ?)",
    )
    .bind(&request.session_backend_id)
    .bind(&request.session_id)
    .bind(&request.project_id)
    .bind(now)
    .execute(&mut *transaction)
    .await
    .map_err(db_error)?;
    let association = read_session_association_in_transaction(
        &mut transaction,
        &request.session_backend_id,
        &request.session_id,
    )
    .await?;
    transaction.commit().await.map_err(db_error)?;
    Ok(association)
}

async fn update_native_association(
    pool: &sqlx::SqlitePool,
    request: UpdateSessionProjectRequest,
) -> Result<SessionProjectAssociation, String> {
    let mut transaction = pool.begin_with("BEGIN IMMEDIATE").await.map_err(db_error)?;
    require_phase(&mut transaction, "native").await?;
    require_existing_project(&mut transaction, request.project_id.as_deref()).await?;
    let now = Utc::now().to_rfc3339();

    let changed = if request.expected_revision == 0 {
        sqlx::query(
            "INSERT OR IGNORE INTO session_projects \
             (session_backend_id, session_id, project_id, source, revision, updated_at) \
             VALUES (?, ?, ?, 'native', 1, ?)",
        )
        .bind(&request.session_backend_id)
        .bind(&request.session_id)
        .bind(&request.project_id)
        .bind(&now)
        .execute(&mut *transaction)
        .await
        .map_err(db_error)?
        .rows_affected()
    } else {
        sqlx::query(
            "UPDATE session_projects SET project_id = ?, source = 'native', \
             revision = revision + 1, updated_at = ? \
             WHERE session_backend_id = ? AND session_id = ? AND revision = ?",
        )
        .bind(&request.project_id)
        .bind(&now)
        .bind(&request.session_backend_id)
        .bind(&request.session_id)
        .bind(request.expected_revision)
        .execute(&mut *transaction)
        .await
        .map_err(db_error)?
        .rows_affected()
    };
    if changed != 1 {
        let current = read_session_association_in_transaction(
            &mut transaction,
            &request.session_backend_id,
            &request.session_id,
        )
        .await?;
        return Err(format!(
            "Session project revision conflict; current revision is {}",
            current
                .revision
                .map(|revision| revision.to_string())
                .unwrap_or_else(|| "absent".to_string())
        ));
    }

    let association = read_session_association_in_transaction(
        &mut transaction,
        &request.session_backend_id,
        &request.session_id,
    )
    .await?;
    transaction.commit().await.map_err(db_error)?;
    Ok(association)
}

async fn read_session_association(
    pool: &sqlx::SqlitePool,
    session_backend_id: &str,
    session_id: &str,
) -> Result<SessionProjectAssociation, String> {
    let row = sqlx::query(
        "SELECT project_id, revision FROM session_projects \
         WHERE session_backend_id = ? AND session_id = ?",
    )
    .bind(session_backend_id)
    .bind(session_id)
    .fetch_optional(pool)
    .await
    .map_err(db_error)?;
    Ok(association_from_row(session_backend_id, session_id, row))
}

async fn read_session_association_in_transaction(
    transaction: &mut Transaction<'_, Sqlite>,
    session_backend_id: &str,
    session_id: &str,
) -> Result<SessionProjectAssociation, String> {
    let row = sqlx::query(
        "SELECT project_id, revision FROM session_projects \
         WHERE session_backend_id = ? AND session_id = ?",
    )
    .bind(session_backend_id)
    .bind(session_id)
    .fetch_optional(&mut **transaction)
    .await
    .map_err(db_error)?;
    Ok(association_from_row(session_backend_id, session_id, row))
}

fn association_from_row(
    session_backend_id: &str,
    session_id: &str,
    row: Option<sqlx::sqlite::SqliteRow>,
) -> SessionProjectAssociation {
    SessionProjectAssociation {
        session_backend_id: session_backend_id.to_string(),
        session_id: session_id.to_string(),
        has_association: row.is_some(),
        project_id: row
            .as_ref()
            .and_then(|row| row.get::<Option<String>, _>("project_id")),
        revision: row.map(|row| row.get("revision")),
    }
}

async fn require_phase(
    transaction: &mut Transaction<'_, Sqlite>,
    required: &str,
) -> Result<(), String> {
    require_phase_one_of(transaction, &[required]).await
}

async fn require_phase_one_of(
    transaction: &mut Transaction<'_, Sqlite>,
    allowed: &[&str],
) -> Result<(), String> {
    let phase: String =
        sqlx::query_scalar("SELECT phase FROM project_storage_state WHERE singleton_id = 1")
            .fetch_one(&mut **transaction)
            .await
            .map_err(db_error)?;
    if !allowed.contains(&phase.as_str()) {
        return Err(format!(
            "Project storage phase must be {}; current phase is {phase}",
            allowed.join(" or ")
        ));
    }
    Ok(())
}

async fn require_existing_project(
    transaction: &mut Transaction<'_, Sqlite>,
    project_id: Option<&str>,
) -> Result<(), String> {
    let Some(project_id) = project_id else {
        return Ok(());
    };
    let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM projects WHERE id = ?)")
        .bind(project_id)
        .fetch_one(&mut **transaction)
        .await
        .map_err(db_error)?;
    if !exists {
        return Err(format!("Project {project_id:?} does not exist"));
    }
    Ok(())
}

async fn ensure_supported_migration_version(pool: &sqlx::SqlitePool) -> Result<(), String> {
    let version: Option<i64> =
        sqlx::query_scalar("SELECT version FROM project_migration_runs WHERE migration_key = ?")
            .bind(MIGRATION_KEY)
            .fetch_optional(pool)
            .await
            .map_err(db_error)?;
    reject_future_migration_version(version)
}

async fn ensure_supported_migration_version_in_transaction(
    transaction: &mut Transaction<'_, Sqlite>,
) -> Result<(), String> {
    let version: Option<i64> =
        sqlx::query_scalar("SELECT version FROM project_migration_runs WHERE migration_key = ?")
            .bind(MIGRATION_KEY)
            .fetch_optional(&mut **transaction)
            .await
            .map_err(db_error)?;
    reject_future_migration_version(version)
}

fn reject_future_migration_version(version: Option<i64>) -> Result<(), String> {
    if let Some(version) = version.filter(|version| *version > MIGRATION_VERSION) {
        return Err(format!(
            "Project migration version {version} is newer than this Berd build supports ({MIGRATION_VERSION}); refusing to modify it"
        ));
    }
    Ok(())
}

fn validate_session_key(session_backend_id: &str, session_id: &str) -> Result<(), String> {
    if session_backend_id.trim().is_empty()
        || session_backend_id.trim() != session_backend_id
        || session_backend_id.len() > 128
    {
        return Err("Session backend id must contain 1 to 128 bytes".to_string());
    }
    if session_id.trim().is_empty() || session_id.trim() != session_id || session_id.len() > 512 {
        return Err("Session id must contain 1 to 512 bytes".to_string());
    }
    Ok(())
}

async fn record_import_failure(
    pool: &sqlx::SqlitePool,
    expected_generation: i64,
    error: &str,
) -> Result<bool, String> {
    let mut transaction = pool.begin_with("BEGIN IMMEDIATE").await.map_err(db_error)?;
    ensure_supported_migration_version_in_transaction(&mut transaction).await?;
    let state = sqlx::query(
        "SELECT phase, shadow_scan_generation FROM project_storage_state WHERE singleton_id = 1",
    )
    .fetch_one(&mut *transaction)
    .await
    .map_err(db_error)?;
    if state.get::<String, _>("phase") == "native"
        || state.get::<i64, _>("shadow_scan_generation") != expected_generation
    {
        transaction.commit().await.map_err(db_error)?;
        return Ok(false);
    }
    let now = Utc::now().to_rfc3339();
    sqlx::query(
        "INSERT INTO project_migration_runs \
         (migration_key, version, scan_generation, state, checkpoint_json, completed_at, last_error, updated_at) \
         VALUES (?, ?, ?, 'failed', '{}', NULL, ?, ?) \
         ON CONFLICT(migration_key) DO UPDATE SET \
         scan_generation = excluded.scan_generation, state = 'failed', completed_at = NULL, \
         last_error = excluded.last_error, \
         updated_at = excluded.updated_at \
         WHERE project_migration_runs.version <= excluded.version",
    )
    .bind(MIGRATION_KEY)
    .bind(MIGRATION_VERSION)
    .bind(expected_generation)
    .bind(error)
    .bind(now)
    .execute(&mut *transaction)
    .await
    .map_err(db_error)?;
    transaction.commit().await.map_err(db_error)?;
    Ok(true)
}

fn db_error(error: sqlx::Error) -> String {
    format!("Project storage database operation failed: {error}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn project_markdown(name: &str, prompt: &str) -> String {
        format!(
            "---\nname: {name}\ndescription: test project\nicon: wrench\norder: 7\nunknownProperty:\n  nested: true\nworkingDirs:\n  - /tmp/work\n---\n\n{prompt}\n"
        )
    }

    async fn state() -> (tempfile::TempDir, BerdPersistenceState) {
        let dir = tempdir().unwrap();
        let state = BerdPersistenceState::new_for_tests(dir.path().join("test.sqlite"))
            .await
            .unwrap();
        (dir, state)
    }

    async fn activate_for_test(state: &BerdPersistenceState) {
        sqlx::query("UPDATE project_storage_state SET phase = 'shadow' WHERE singleton_id = 1")
            .execute(state.pool())
            .await
            .unwrap();
        sqlx::query("UPDATE project_storage_state SET phase = 'native' WHERE singleton_id = 1")
            .execute(state.pool())
            .await
            .unwrap();
    }

    async fn apply_scan(
        state: &BerdPersistenceState,
        scan: LegacyScan,
    ) -> Result<ShadowImportReport, String> {
        let generation = claim_shadow_scan(state.pool()).await?;
        apply_shadow_import(state.pool(), scan, generation).await
    }

    #[tokio::test]
    async fn shadow_import_is_idempotent_and_preserves_unknown_properties() {
        let (db_dir, state) = state().await;
        let source = tempdir().unwrap();
        let backup = db_dir.path().join("backups");
        fs::write(
            source.path().join("alpha.md"),
            project_markdown("Alpha", "Always test."),
        )
        .unwrap();

        let first = scan_legacy_projects(source.path(), &backup).unwrap();
        let report = apply_scan(&state, first).await.unwrap();
        assert_eq!(report.imported, 1);
        assert_eq!(report.unchanged, 0);

        let second = scan_legacy_projects(source.path(), &backup).unwrap();
        let report = apply_scan(&state, second).await.unwrap();
        assert_eq!(report.imported, 0);
        assert_eq!(report.unchanged, 1);

        let row = sqlx::query(
            "SELECT name, prompt, extra_properties_json FROM projects WHERE id = 'alpha'",
        )
        .fetch_one(state.pool())
        .await
        .unwrap();
        assert_eq!(row.get::<String, _>("name"), "Alpha");
        assert_eq!(row.get::<String, _>("prompt"), "Always test.");
        let properties: Value =
            serde_json::from_str(&row.get::<String, _>("extra_properties_json")).unwrap();
        assert_eq!(properties["unknownProperty"]["nested"], true);
        assert_eq!(properties["title"], "Alpha");
        assert_eq!(fs::read_dir(backup).unwrap().count(), 1);
    }

    #[tokio::test]
    async fn shadow_rescan_updates_changed_sources_and_removes_deleted_sources() {
        let (_db_dir, state) = state().await;
        let source = tempdir().unwrap();
        let backup = tempdir().unwrap();
        let project_path = source.path().join("alpha.md");
        fs::write(&project_path, project_markdown("Alpha", "First")).unwrap();
        apply_scan(
            &state,
            scan_legacy_projects(source.path(), backup.path()).unwrap(),
        )
        .await
        .unwrap();

        fs::write(&project_path, project_markdown("Alpha", "Second")).unwrap();
        let report = apply_scan(
            &state,
            scan_legacy_projects(source.path(), backup.path()).unwrap(),
        )
        .await
        .unwrap();
        assert_eq!(report.updated, 1);
        assert_eq!(
            sqlx::query_scalar::<_, String>("SELECT prompt FROM projects WHERE id = 'alpha'")
                .fetch_one(state.pool())
                .await
                .unwrap(),
            "Second"
        );

        fs::remove_file(project_path).unwrap();
        let report = apply_scan(
            &state,
            scan_legacy_projects(source.path(), backup.path()).unwrap(),
        )
        .await
        .unwrap();
        assert_eq!(report.removed, 1);
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM projects")
                .fetch_one(state.pool())
                .await
                .unwrap(),
            0
        );
    }

    #[tokio::test]
    async fn missing_or_changed_legacy_root_cannot_erase_an_existing_mirror() {
        let (_db_dir, state) = state().await;
        let source = tempdir().unwrap();
        let backup = tempdir().unwrap();
        fs::write(
            source.path().join("alpha.md"),
            project_markdown("Alpha", "Prompt"),
        )
        .unwrap();
        apply_scan(
            &state,
            scan_legacy_projects(source.path(), backup.path()).unwrap(),
        )
        .await
        .unwrap();

        let missing = apply_scan(
            &state,
            LegacyScan {
                source_present: false,
                source_root: None,
                projects: Vec::new(),
            },
        )
        .await
        .unwrap();
        assert_eq!(missing.removed, 0);
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM projects")
                .fetch_one(state.pool())
                .await
                .unwrap(),
            1
        );

        let different_root = tempdir().unwrap();
        let error = apply_scan(
            &state,
            scan_legacy_projects(different_root.path(), backup.path()).unwrap(),
        )
        .await
        .unwrap_err();
        assert!(error.contains("root changed"));
    }

    #[cfg(unix)]
    #[test]
    fn scan_rejects_symlinked_project_files() {
        use std::os::unix::fs::symlink;

        let source = tempdir().unwrap();
        let outside = tempdir().unwrap();
        let target = outside.path().join("secret.md");
        fs::write(&target, project_markdown("Secret", "do not import")).unwrap();
        symlink(target, source.path().join("secret.md")).unwrap();

        let error = scan_legacy_projects(source.path(), outside.path()).unwrap_err();
        assert!(error.contains("regular non-symlink"));
    }

    #[test]
    fn scan_rejects_oversize_and_invalid_utf8_files() {
        let source = tempdir().unwrap();
        let backup = tempdir().unwrap();
        fs::write(
            source.path().join("large.md"),
            vec![b'a'; MAX_PROJECT_FILE_BYTES as usize + 1],
        )
        .unwrap();
        assert!(scan_legacy_projects(source.path(), backup.path())
            .unwrap_err()
            .contains("safety limit"));

        fs::remove_file(source.path().join("large.md")).unwrap();
        fs::write(source.path().join("invalid.md"), [0xff, 0xfe]).unwrap();
        assert!(scan_legacy_projects(source.path(), backup.path())
            .unwrap_err()
            .contains("UTF-8"));
    }

    #[tokio::test]
    async fn legacy_import_cannot_run_after_native_activation() {
        let (_dir, state) = state().await;
        activate_for_test(&state).await;

        let error = apply_shadow_import(
            state.pool(),
            LegacyScan {
                source_present: true,
                source_root: Some("/legacy/projects".to_string()),
                projects: Vec::new(),
            },
            0,
        )
        .await
        .unwrap_err();
        assert!(error.contains("disabled after native"));
    }

    #[tokio::test]
    async fn legacy_backfill_is_first_write_wins_and_uses_stable_backend_namespace() {
        let (_db_dir, state) = state().await;
        let source = tempdir().unwrap();
        let backup = tempdir().unwrap();
        fs::write(
            source.path().join("alpha.md"),
            project_markdown("Alpha", "Prompt"),
        )
        .unwrap();
        apply_scan(
            &state,
            scan_legacy_projects(source.path(), backup.path()).unwrap(),
        )
        .await
        .unwrap();

        let first = backfill_legacy_association(
            state.pool(),
            LegacySessionProjectBackfillRequest {
                session_backend_id: "goose-serve".to_string(),
                session_id: "session-1".to_string(),
                project_id: "alpha".to_string(),
            },
        )
        .await
        .unwrap();
        assert_eq!(first.project_id.as_deref(), Some("alpha"));
        assert_eq!(first.revision, Some(1));

        let repeated = backfill_legacy_association(
            state.pool(),
            LegacySessionProjectBackfillRequest {
                session_backend_id: "goose-serve".to_string(),
                session_id: "session-1".to_string(),
                project_id: "alpha".to_string(),
            },
        )
        .await
        .unwrap();
        assert_eq!(repeated, first);

        let other_backend = read_session_association(state.pool(), "external-acp", "session-1")
            .await
            .unwrap();
        assert!(!other_backend.has_association);
    }

    #[tokio::test]
    async fn native_association_uses_cas_and_preserves_explicit_null_tombstone() {
        let (_dir, state) = state().await;
        activate_for_test(&state).await;

        let tombstone = update_native_association(
            state.pool(),
            UpdateSessionProjectRequest {
                session_backend_id: "goose-serve".to_string(),
                session_id: "session-1".to_string(),
                project_id: None,
                expected_revision: 0,
            },
        )
        .await
        .unwrap();
        assert!(tombstone.has_association);
        assert_eq!(tombstone.project_id, None);
        assert_eq!(tombstone.revision, Some(1));

        let conflict = update_native_association(
            state.pool(),
            UpdateSessionProjectRequest {
                session_backend_id: "goose-serve".to_string(),
                session_id: "session-1".to_string(),
                project_id: None,
                expected_revision: 0,
            },
        )
        .await
        .unwrap_err();
        assert!(conflict.contains("current revision is 1"));

        let regression =
            sqlx::query("UPDATE project_storage_state SET phase = 'shadow' WHERE singleton_id = 1")
                .execute(state.pool())
                .await
                .unwrap_err();
        assert!(regression.to_string().contains("cannot move backwards"));
    }

    #[tokio::test]
    async fn concurrent_native_updates_serialize_into_one_success_and_one_cas_conflict() {
        let (_dir, state) = state().await;
        activate_for_test(&state).await;
        update_native_association(
            state.pool(),
            UpdateSessionProjectRequest {
                session_backend_id: "goose-serve".to_string(),
                session_id: "session-1".to_string(),
                project_id: None,
                expected_revision: 0,
            },
        )
        .await
        .unwrap();

        let first = update_native_association(
            state.pool(),
            UpdateSessionProjectRequest {
                session_backend_id: "goose-serve".to_string(),
                session_id: "session-1".to_string(),
                project_id: None,
                expected_revision: 1,
            },
        );
        let second = update_native_association(
            state.pool(),
            UpdateSessionProjectRequest {
                session_backend_id: "goose-serve".to_string(),
                session_id: "session-1".to_string(),
                project_id: None,
                expected_revision: 1,
            },
        );
        let (first, second) = tokio::join!(first, second);
        assert_ne!(first.is_ok(), second.is_ok());
        let conflict = first.err().or_else(|| second.err()).unwrap();
        assert!(conflict.contains("current revision is 2"));
    }

    #[tokio::test]
    async fn stale_scan_generation_cannot_overwrite_a_newer_snapshot() {
        let (_db_dir, state) = state().await;
        let source = tempdir().unwrap();
        let backup = tempdir().unwrap();
        let project_path = source.path().join("alpha.md");

        fs::write(&project_path, project_markdown("Alpha", "Old")).unwrap();
        let old_generation = claim_shadow_scan(state.pool()).await.unwrap();
        let old_scan = scan_legacy_projects(source.path(), backup.path()).unwrap();

        fs::write(&project_path, project_markdown("Alpha", "New")).unwrap();
        let new_generation = claim_shadow_scan(state.pool()).await.unwrap();
        let new_scan = scan_legacy_projects(source.path(), backup.path()).unwrap();

        apply_shadow_import(state.pool(), new_scan, new_generation)
            .await
            .unwrap();
        let stale = apply_shadow_import(state.pool(), old_scan, old_generation)
            .await
            .unwrap();
        assert!(stale.superseded);
        assert_eq!(
            sqlx::query_scalar::<_, String>("SELECT prompt FROM projects WHERE id = 'alpha'")
                .fetch_one(state.pool())
                .await
                .unwrap(),
            "New"
        );
    }

    #[tokio::test]
    async fn unchanged_rescan_does_not_manufacture_a_collection_revision() {
        let (_db_dir, state) = state().await;
        let source = tempdir().unwrap();
        let backup = tempdir().unwrap();
        fs::write(
            source.path().join("alpha.md"),
            project_markdown("Alpha", "Prompt"),
        )
        .unwrap();

        apply_scan(
            &state,
            scan_legacy_projects(source.path(), backup.path()).unwrap(),
        )
        .await
        .unwrap();
        let before: (i64, Option<String>) = sqlx::query_as(
            "SELECT collection_revision, shadow_completed_at FROM project_storage_state",
        )
        .fetch_one(state.pool())
        .await
        .unwrap();

        let report = apply_scan(
            &state,
            scan_legacy_projects(source.path(), backup.path()).unwrap(),
        )
        .await
        .unwrap();
        let after: (i64, Option<String>) = sqlx::query_as(
            "SELECT collection_revision, shadow_completed_at FROM project_storage_state",
        )
        .fetch_one(state.pool())
        .await
        .unwrap();
        assert_eq!(report.unchanged, 1);
        assert_eq!(after, before);
        let generations: (i64, i64) = sqlx::query_as(
            "SELECT project_storage_state.shadow_scan_generation, project_migration_runs.scan_generation \
             FROM project_storage_state JOIN project_migration_runs ON migration_key = ? \
             WHERE singleton_id = 1",
        )
        .bind(MIGRATION_KEY)
        .fetch_one(state.pool())
        .await
        .unwrap();
        assert_eq!(generations.0, generations.1);
    }

    #[test]
    fn workspace_import_matches_renderer_normalization_and_legacy_fallback() {
        let explicit: BTreeMap<String, Value> = serde_json::from_value(serde_json::json!({
            "projectWorkspaces": [
                {"path": "  C:\\\\Repo\\\\app\\\\..  ", "kind": "invalid", "source": "invalid", "startupMode": "branch", "repositoryPath": "  C:\\\\Repo  "},
                {"path": "c:/repo", "kind": "repository", "source": "selected", "startupMode": "worktree"}
            ],
            "workingDirs": ["/ignored"]
        }))
        .unwrap();
        let workspaces = parse_workspaces(&explicit).unwrap();
        assert_eq!(workspaces.len(), 1);
        assert_eq!(workspaces[0].path, "c:/repo");
        assert_eq!(workspaces[0].kind, "repository");
        assert_eq!(workspaces[0].source, "selected");
        assert_eq!(workspaces[0].startup_mode, "auto-worktree");
        assert_eq!(workspaces[0].id, "path:c:/repo");

        let fallback: BTreeMap<String, Value> = serde_json::from_value(serde_json::json!({
            "projectWorkspaces": [],
            "workingDirs": ["  /tmp/work  ", ""],
            "useWorktrees": true
        }))
        .unwrap();
        let workspaces = parse_workspaces(&fallback).unwrap();
        assert_eq!(workspaces.len(), 1);
        assert_eq!(workspaces[0].path, "/tmp/work");
        assert_eq!(workspaces[0].startup_mode, "auto-worktree");

        let duplicate_ids: BTreeMap<String, Value> = serde_json::from_value(serde_json::json!({
            "projectWorkspaces": [
                {"id": "explicit", "path": "/tmp/one"},
                {"id": "explicit", "path": "/tmp/two"}
            ]
        }))
        .unwrap();
        let workspaces = parse_workspaces(&duplicate_ids).unwrap();
        assert_eq!(workspaces.len(), 2);
        assert_eq!(workspaces[0].id, "explicit");
        assert_eq!(workspaces[1].id, "explicit");

        assert_eq!(normalize_lexical_path("//server"), "/server");
        assert!(!is_windows_absolute_path("//server"));
        assert!(is_windows_absolute_path("//server/share"));
        assert_eq!(normalize_lexical_path("//server/./dir"), "//server/./dir");
        assert!(!is_windows_absolute_path("//server/./dir"));
        assert_eq!(normalize_lexical_path("//../share"), "//../share");
        assert!(!is_windows_absolute_path("//../share"));
    }

    #[tokio::test]
    async fn import_accepts_existing_goose_project_filename_identity() {
        let (_db_dir, state) = state().await;
        let source = tempdir().unwrap();
        let backup = tempdir().unwrap();
        fs::write(
            source.path().join("Legacy Project.md"),
            project_markdown("Legacy Project", "Prompt"),
        )
        .unwrap();

        apply_scan(
            &state,
            scan_legacy_projects(source.path(), backup.path()).unwrap(),
        )
        .await
        .unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, String>("SELECT id FROM projects")
                .fetch_one(state.pool())
                .await
                .unwrap(),
            "Legacy Project"
        );
    }

    #[tokio::test]
    async fn native_phase_allows_absent_legacy_backfill_but_existing_tombstone_wins() {
        let (_db_dir, state) = state().await;
        let source = tempdir().unwrap();
        let backup = tempdir().unwrap();
        fs::write(
            source.path().join("alpha.md"),
            project_markdown("Alpha", "Prompt"),
        )
        .unwrap();
        apply_scan(
            &state,
            scan_legacy_projects(source.path(), backup.path()).unwrap(),
        )
        .await
        .unwrap();
        activate_for_test(&state).await;

        let backfilled = backfill_legacy_association(
            state.pool(),
            LegacySessionProjectBackfillRequest {
                session_backend_id: "goose-serve".to_string(),
                session_id: "session-new".to_string(),
                project_id: "alpha".to_string(),
            },
        )
        .await
        .unwrap();
        assert_eq!(backfilled.project_id.as_deref(), Some("alpha"));

        update_native_association(
            state.pool(),
            UpdateSessionProjectRequest {
                session_backend_id: "goose-serve".to_string(),
                session_id: "session-cleared".to_string(),
                project_id: None,
                expected_revision: 0,
            },
        )
        .await
        .unwrap();
        let tombstone = backfill_legacy_association(
            state.pool(),
            LegacySessionProjectBackfillRequest {
                session_backend_id: "goose-serve".to_string(),
                session_id: "session-cleared".to_string(),
                project_id: "missing-project".to_string(),
            },
        )
        .await
        .unwrap();
        assert!(tombstone.has_association);
        assert_eq!(tombstone.project_id, None);
    }

    #[tokio::test]
    async fn project_delete_must_explicitly_revision_session_associations() {
        let (_db_dir, state) = state().await;
        let source = tempdir().unwrap();
        let backup = tempdir().unwrap();
        fs::write(
            source.path().join("alpha.md"),
            project_markdown("Alpha", "Prompt"),
        )
        .unwrap();
        apply_scan(
            &state,
            scan_legacy_projects(source.path(), backup.path()).unwrap(),
        )
        .await
        .unwrap();
        activate_for_test(&state).await;
        update_native_association(
            state.pool(),
            UpdateSessionProjectRequest {
                session_backend_id: "goose-serve".to_string(),
                session_id: "session-1".to_string(),
                project_id: Some("alpha".to_string()),
                expected_revision: 0,
            },
        )
        .await
        .unwrap();

        let error = sqlx::query("DELETE FROM projects WHERE id = 'alpha'")
            .execute(state.pool())
            .await
            .unwrap_err();
        assert!(error.to_string().contains("FOREIGN KEY constraint failed"));
        let association = read_session_association(state.pool(), "goose-serve", "session-1")
            .await
            .unwrap();
        assert_eq!(association.project_id.as_deref(), Some("alpha"));
        assert_eq!(association.revision, Some(1));
    }

    #[tokio::test]
    async fn newer_migration_version_is_never_downgraded_or_rewritten() {
        let (_db_dir, state) = state().await;
        sqlx::query(
            "INSERT INTO project_migration_runs \
             (migration_key, version, state, checkpoint_json, completed_at, last_error, updated_at) \
             VALUES (?, 2, 'complete', '{\"future\":true}', 'later', NULL, 'later')",
        )
        .bind(MIGRATION_KEY)
        .execute(state.pool())
        .await
        .unwrap();

        assert!(claim_shadow_scan(state.pool())
            .await
            .unwrap_err()
            .contains("newer than this Berd build"));
        assert!(record_import_failure(state.pool(), 0, "old build failure")
            .await
            .unwrap_err()
            .contains("newer than this Berd build"));
        let row: (i64, String, String) = sqlx::query_as(
            "SELECT version, state, checkpoint_json FROM project_migration_runs WHERE migration_key = ?",
        )
        .bind(MIGRATION_KEY)
        .fetch_one(state.pool())
        .await
        .unwrap();
        assert_eq!(
            row,
            (2, "complete".to_string(), "{\"future\":true}".to_string())
        );
    }

    #[tokio::test]
    async fn accepted_retry_clears_failure_without_bumping_unchanged_collection() {
        let (_db_dir, state) = state().await;
        let source = tempdir().unwrap();
        let backup = tempdir().unwrap();
        fs::write(
            source.path().join("alpha.md"),
            project_markdown("Alpha", "Prompt"),
        )
        .unwrap();
        apply_scan(
            &state,
            scan_legacy_projects(source.path(), backup.path()).unwrap(),
        )
        .await
        .unwrap();
        let collection_revision: i64 = sqlx::query_scalar(
            "SELECT collection_revision FROM project_storage_state WHERE singleton_id = 1",
        )
        .fetch_one(state.pool())
        .await
        .unwrap();

        let failed_generation = claim_shadow_scan(state.pool()).await.unwrap();
        assert!(
            record_import_failure(state.pool(), failed_generation, "transient scan failure")
                .await
                .unwrap()
        );
        let retry_generation = claim_shadow_scan(state.pool()).await.unwrap();
        let retry = scan_legacy_projects(source.path(), backup.path()).unwrap();
        apply_shadow_import(state.pool(), retry, retry_generation)
            .await
            .unwrap();

        assert_eq!(
            sqlx::query_scalar::<_, String>(
                "SELECT state FROM project_migration_runs WHERE migration_key = ?",
            )
            .bind(MIGRATION_KEY)
            .fetch_one(state.pool())
            .await
            .unwrap(),
            "complete"
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT collection_revision FROM project_storage_state WHERE singleton_id = 1",
            )
            .fetch_one(state.pool())
            .await
            .unwrap(),
            collection_revision
        );

        let stale_generation = claim_shadow_scan(state.pool()).await.unwrap();
        let _newer_generation = claim_shadow_scan(state.pool()).await.unwrap();
        assert!(
            !record_import_failure(state.pool(), stale_generation, "stale failure")
                .await
                .unwrap()
        );
        assert_eq!(
            sqlx::query_scalar::<_, String>(
                "SELECT state FROM project_migration_runs WHERE migration_key = ?",
            )
            .bind(MIGRATION_KEY)
            .fetch_one(state.pool())
            .await
            .unwrap(),
            "complete"
        );
    }

    #[cfg(unix)]
    #[test]
    fn scan_rejects_symlinked_backup_directory() {
        use std::os::unix::fs::symlink;

        let source = tempdir().unwrap();
        let app_data = tempdir().unwrap();
        let outside = tempdir().unwrap();
        let backup_parent = app_data.path().join("project-migration-backups");
        fs::create_dir(&backup_parent).unwrap();
        symlink(outside.path(), backup_parent.join("v1")).unwrap();

        let error = scan_legacy_projects(source.path(), &backup_parent.join("v1")).unwrap_err();
        assert!(error.contains("non-symlink directory"));
    }

    #[test]
    fn backup_quota_fails_before_writing_more_data() {
        let backup = tempdir().unwrap();
        let mut total = MAX_BACKUP_BYTES;
        let error = publish_backup(backup.path(), &"a".repeat(64), b"x", &mut total).unwrap_err();
        assert!(error.contains("safety limit"));
        assert_eq!(fs::read_dir(backup.path()).unwrap().count(), 0);
    }
}
