use futures_util::{stream, StreamExt};
use reqwest::Url;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs;
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::sync::OnceLock;
use std::time::{Duration, SystemTime};
use tauri::{AppHandle, Manager};
use tokio::io::AsyncWriteExt;

const ARTIFACTORY_BASE: &str =
    "https://global.block-artifacts.com/artifactory/goose-internal/project-artifacts/";
const LATEST_PATH: &str = "latest.json";
const MANIFEST_FILE: &str = "manifest.json";
const REFRESH_MARKER_FILE: &str = "refresh.marker";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);
const CACHE_TTL: Duration = Duration::from_secs(7 * 24 * 60 * 60);
const DOWNLOAD_CONCURRENCY: usize = 4;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectAssetLatest {
    pub catalog_version: String,
    pub manifest_path: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectAssetCatalog {
    pub schema_version: u8,
    pub catalog_version: String,
    pub images: Vec<ProjectAssetEntry>,
    pub environment: ProjectAssetEntry,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectAssetEntry {
    pub id: String,
    pub path: String,
    pub mime_type: String,
    pub byte_size: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectArtifactAssets {
    pub catalog_version: String,
    pub image_paths: Vec<String>,
    pub environment_path: String,
}

#[derive(Debug, Clone)]
struct ProjectAssetCachePaths {
    meta: PathBuf,
    media: PathBuf,
}

#[tauri::command]
pub async fn get_project_artifact_assets(app: AppHandle) -> Result<ProjectArtifactAssets, String> {
    ensure_project_artifact_assets(app).await
}

pub async fn warm_project_artifact_assets_cache(app: AppHandle) -> Result<(), String> {
    ensure_project_artifact_assets(app).await.map(|_| ())
}

async fn ensure_project_artifact_assets(app: AppHandle) -> Result<ProjectArtifactAssets, String> {
    let _cache_guard = project_asset_cache_lock().lock().await;
    let paths = project_asset_cache_paths(&app)?;
    clean_part_files(&paths)?;

    if let Some((catalog, assets)) = read_complete_cached_assets(&paths).await? {
        prune_obsolete_versions(&paths, &catalog.catalog_version)?;
        if is_cache_fresh(&paths)? {
            return Ok(assets);
        }

        match refresh_project_artifact_assets_cache_unlocked(&paths).await {
            Ok(refreshed) => return Ok(refreshed),
            Err(error) => {
                log::warn!(
                    "Failed to refresh stale project artifact asset cache; using cached assets: {error}"
                );
                return Ok(assets);
            }
        }
    }

    refresh_project_artifact_assets_cache_unlocked(&paths).await
}

async fn read_complete_cached_assets(
    paths: &ProjectAssetCachePaths,
) -> Result<Option<(ProjectAssetCatalog, ProjectArtifactAssets)>, String> {
    let Some(catalog) = read_cached_catalog(paths)? else {
        return Ok(None);
    };

    let client = http_client()?;
    match ensure_assets_for_catalog(&client, paths, &catalog).await {
        Ok(assets) => Ok(Some((catalog, assets))),
        Err(error) => {
            log::warn!("Ignoring incomplete project artifact asset cache: {error}");
            Ok(None)
        }
    }
}

async fn refresh_project_artifact_assets_cache_unlocked(
    paths: &ProjectAssetCachePaths,
) -> Result<ProjectArtifactAssets, String> {
    let catalog = refresh_cached_catalog(paths).await?;
    let client = http_client()?;
    let assets = ensure_assets_for_catalog(&client, paths, &catalog).await?;
    write_refresh_marker(paths)?;
    prune_obsolete_versions(paths, &catalog.catalog_version)?;
    Ok(assets)
}

async fn ensure_assets_for_catalog(
    client: &reqwest::Client,
    paths: &ProjectAssetCachePaths,
    catalog: &ProjectAssetCatalog,
) -> Result<ProjectArtifactAssets, String> {
    let image_paths = ensure_entries(client, paths, catalog, &catalog.images).await?;
    let environment_path = ensure_entry(client, paths, catalog, &catalog.environment).await?;

    Ok(ProjectArtifactAssets {
        catalog_version: catalog.catalog_version.clone(),
        image_paths,
        environment_path,
    })
}

async fn refresh_cached_catalog(
    paths: &ProjectAssetCachePaths,
) -> Result<ProjectAssetCatalog, String> {
    let (latest, catalog) = fetch_current_catalog().await?;
    write_cached_catalog(paths, &latest, &catalog)?;
    Ok(catalog)
}

async fn fetch_current_catalog() -> Result<(ProjectAssetLatest, ProjectAssetCatalog), String> {
    let client = http_client()?;
    let latest: ProjectAssetLatest = client
        .get(allowed_artifactory_url(LATEST_PATH)?)
        .send()
        .await
        .map_err(|error| format!("Failed to fetch project image latest pointer: {error}"))?
        .error_for_status()
        .map_err(|error| format!("Project image latest pointer returned an error: {error}"))?
        .json()
        .await
        .map_err(|error| format!("Failed to parse project image latest pointer: {error}"))?;

    let manifest_path = manifest_path_for_latest(&latest)?;
    let catalog: ProjectAssetCatalog = client
        .get(allowed_artifactory_url(&manifest_path)?)
        .send()
        .await
        .map_err(|error| format!("Failed to fetch project image catalog: {error}"))?
        .error_for_status()
        .map_err(|error| format!("Project image catalog returned an error: {error}"))?
        .json()
        .await
        .map_err(|error| format!("Failed to parse project image catalog: {error}"))?;

    validate_catalog(&catalog)?;
    if catalog.catalog_version != latest.catalog_version {
        return Err("Project image catalog version does not match latest pointer".to_string());
    }

    Ok((latest, catalog))
}

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|error| format!("Failed to create project image HTTP client: {error}"))
}

fn project_asset_cache_lock() -> &'static tokio::sync::Mutex<()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

fn read_cached_catalog(
    paths: &ProjectAssetCachePaths,
) -> Result<Option<ProjectAssetCatalog>, String> {
    let latest_path = paths.meta.join(LATEST_PATH);
    if !latest_path.exists() {
        return Ok(None);
    }

    let latest = match read_json_file::<ProjectAssetLatest>(&latest_path) {
        Ok(latest) => latest,
        Err(error) => {
            delete_file_if_exists(&latest_path)?;
            log::warn!("Ignoring corrupt project image latest cache: {error}");
            return Ok(None);
        }
    };
    let manifest_path = match manifest_path_for_latest(&latest) {
        Ok(path) => path,
        Err(error) => {
            delete_file_if_exists(&latest_path)?;
            log::warn!("Ignoring invalid project image latest cache: {error}");
            return Ok(None);
        }
    };

    let catalog_path = paths.meta.join(manifest_path);
    if !catalog_path.exists() {
        return Ok(None);
    }

    let catalog = match read_json_file::<ProjectAssetCatalog>(&catalog_path) {
        Ok(catalog) => catalog,
        Err(error) => {
            delete_file_if_exists(&catalog_path)?;
            log::warn!("Ignoring corrupt project image manifest cache: {error}");
            return Ok(None);
        }
    };
    if let Err(error) = validate_catalog(&catalog) {
        delete_file_if_exists(&catalog_path)?;
        log::warn!("Ignoring invalid project image manifest cache: {error}");
        return Ok(None);
    }
    if catalog.catalog_version != latest.catalog_version {
        delete_file_if_exists(&catalog_path)?;
        return Ok(None);
    }

    Ok(Some(catalog))
}

fn write_cached_catalog(
    paths: &ProjectAssetCachePaths,
    latest: &ProjectAssetLatest,
    catalog: &ProjectAssetCatalog,
) -> Result<(), String> {
    validate_catalog(catalog)?;
    if latest.catalog_version != catalog.catalog_version {
        return Err("Project image catalog version does not match latest pointer".to_string());
    }

    let manifest_path = manifest_path_for_latest(latest)?;
    let latest_json = serde_json::to_vec_pretty(latest)
        .map_err(|error| format!("Failed to serialize project image latest pointer: {error}"))?;
    let catalog_json = serde_json::to_vec_pretty(catalog)
        .map_err(|error| format!("Failed to serialize project image catalog: {error}"))?;

    atomic_write(&paths.meta.join(&manifest_path), &catalog_json)?;
    atomic_write(&paths.meta.join(LATEST_PATH), &latest_json)?;
    Ok(())
}

fn manifest_path_for_latest(latest: &ProjectAssetLatest) -> Result<String, String> {
    validate_catalog_version(&latest.catalog_version)?;
    let expected = format!("{}/{}", latest.catalog_version, MANIFEST_FILE);
    let manifest_path = latest
        .manifest_path
        .clone()
        .unwrap_or_else(|| expected.clone());
    validate_safe_relative_path(&manifest_path)?;
    if manifest_path != expected {
        return Err(
            "Project image latest manifest path must match catalogVersion/manifest.json"
                .to_string(),
        );
    }
    Ok(manifest_path)
}

fn read_json_file<T>(path: &Path) -> Result<T, String>
where
    T: for<'de> Deserialize<'de>,
{
    let bytes =
        fs::read(path).map_err(|error| format!("Failed to read '{}': {error}", path.display()))?;
    serde_json::from_slice(&bytes)
        .map_err(|error| format!("Failed to parse '{}': {error}", path.display()))
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if fs::read(path).is_ok_and(|existing| existing == bytes) {
        return Ok(());
    }

    let parent = path
        .parent()
        .ok_or_else(|| "Project image cache target has no parent".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Failed to create project image cache directory: {error}"))?;
    let part_path = unique_part_path(path);
    {
        let mut file = fs::File::create(&part_path)
            .map_err(|error| format!("Failed to create project image cache part file: {error}"))?;
        file.write_all(bytes)
            .map_err(|error| format!("Failed to write project image cache part file: {error}"))?;
        file.sync_all()
            .map_err(|error| format!("Failed to sync project image cache part file: {error}"))?;
    }
    fs::rename(&part_path, path).map_err(|error| {
        let _ = fs::remove_file(&part_path);
        format!("Failed to finalize project image cache file: {error}")
    })
}

async fn ensure_entries(
    client: &reqwest::Client,
    paths: &ProjectAssetCachePaths,
    catalog: &ProjectAssetCatalog,
    entries: &[ProjectAssetEntry],
) -> Result<Vec<String>, String> {
    let results: Vec<Result<String, String>> = stream::iter(entries.to_vec())
        .map(|entry| async move { ensure_entry(client, paths, catalog, &entry).await })
        .buffered(DOWNLOAD_CONCURRENCY)
        .collect()
        .await;
    results.into_iter().collect()
}

async fn ensure_entry(
    client: &reqwest::Client,
    paths: &ProjectAssetCachePaths,
    catalog: &ProjectAssetCatalog,
    entry: &ProjectAssetEntry,
) -> Result<String, String> {
    validate_entry_path(entry)?;
    let target = media_cache_path(paths, &catalog.catalog_version, &entry.path)?;

    if valid_cached_asset(paths, catalog, entry, &target)? {
        return Ok(target.to_string_lossy().into_owned());
    }
    delete_file_if_exists(&target)?;
    delete_file_if_exists(&checksum_marker_path(
        paths,
        &catalog.catalog_version,
        &entry.path,
    )?)?;

    let url = allowed_artifactory_url(&format!("{}/{}", catalog.catalog_version, entry.path))?;
    download_asset(client, url, &target, entry).await?;
    write_checksum_marker(paths, &catalog.catalog_version, entry)?;

    Ok(target.to_string_lossy().into_owned())
}

async fn download_asset(
    client: &reqwest::Client,
    url: Url,
    target: &Path,
    entry: &ProjectAssetEntry,
) -> Result<(), String> {
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|error| format!("Failed to download project image asset: {error}"))?
        .error_for_status()
        .map_err(|error| format!("Project image asset returned an error: {error}"))?;
    if let Some(content_length) = response.content_length() {
        if content_length != entry.byte_size {
            return Err("Project image asset byte size did not match manifest".to_string());
        }
    }

    let parent = target
        .parent()
        .ok_or_else(|| "Project image cache target has no parent".to_string())?;
    tokio::fs::create_dir_all(parent)
        .await
        .map_err(|error| format!("Failed to create project image cache directory: {error}"))?;
    let part_path = unique_part_path(target);
    let mut file = tokio::fs::File::create(&part_path)
        .await
        .map_err(|error| format!("Failed to create project image cache part file: {error}"))?;
    let mut part_file = PartFile::new(part_path);
    let mut stream = response.bytes_stream();
    let mut hasher = Sha256::new();
    let mut downloaded = 0_u64;

    while let Some(chunk) = stream.next().await {
        let chunk = chunk
            .map_err(|error| format!("Failed to read project image asset response: {error}"))?;
        downloaded += chunk.len() as u64;
        if downloaded > entry.byte_size {
            return Err("Project image asset byte size exceeded manifest".to_string());
        }
        hasher.update(&chunk);
        file.write_all(&chunk)
            .await
            .map_err(|error| format!("Failed to write project image cache part file: {error}"))?;
    }
    file.flush()
        .await
        .map_err(|error| format!("Failed to flush project image cache part file: {error}"))?;

    if downloaded != entry.byte_size {
        return Err("Project image asset byte size did not match manifest".to_string());
    }
    let actual = hex_digest(hasher.finalize().as_slice());
    if actual != entry.sha256.to_ascii_lowercase() {
        return Err("Project image asset checksum did not match manifest".to_string());
    }

    file.sync_all()
        .await
        .map_err(|error| format!("Failed to sync project image cache part file: {error}"))?;
    drop(file);

    if let Err(error) = tokio::fs::rename(part_file.path(), target).await {
        return Err(format!(
            "Failed to finalize project image cache file: {error}"
        ));
    }
    part_file.persist();
    Ok(())
}

struct PartFile {
    path: Option<PathBuf>,
}

impl PartFile {
    fn new(path: PathBuf) -> Self {
        Self { path: Some(path) }
    }

    fn path(&self) -> &Path {
        self.path.as_deref().expect("part file path is present")
    }

    fn persist(&mut self) {
        self.path = None;
    }
}

impl Drop for PartFile {
    fn drop(&mut self) {
        if let Some(path) = &self.path {
            let _ = fs::remove_file(path);
        }
    }
}

fn unique_part_path(target: &Path) -> PathBuf {
    let extension = target
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("download");
    let nonce = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map_or(0, |duration| duration.as_nanos());
    target.with_extension(format!("{extension}.{}.{}.part", std::process::id(), nonce))
}

fn checksum_marker_path(
    paths: &ProjectAssetCachePaths,
    catalog_version: &str,
    entry_path: &str,
) -> Result<PathBuf, String> {
    validate_catalog_version(catalog_version)?;
    validate_safe_relative_path(entry_path)?;
    Ok(paths
        .meta
        .join(catalog_version)
        .join(format!("{entry_path}.sha256")))
}

fn refresh_marker_path(paths: &ProjectAssetCachePaths) -> PathBuf {
    paths.meta.join(REFRESH_MARKER_FILE)
}

fn write_refresh_marker(paths: &ProjectAssetCachePaths) -> Result<(), String> {
    let refreshed_at = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map_err(|error| format!("Failed to create project image refresh marker: {error}"))?
        .as_nanos()
        .to_string();
    atomic_write(&refresh_marker_path(paths), refreshed_at.as_bytes())
}

fn is_cache_fresh(paths: &ProjectAssetCachePaths) -> Result<bool, String> {
    let marker_path = refresh_marker_path(paths);
    let metadata = match fs::metadata(&marker_path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => {
            return Err(format!(
                "Failed to inspect project image refresh marker '{}': {error}",
                marker_path.display()
            ))
        }
    };
    let modified = metadata.modified().map_err(|error| {
        format!(
            "Failed to read project image refresh marker timestamp '{}': {error}",
            marker_path.display()
        )
    })?;
    Ok(SystemTime::now()
        .duration_since(modified)
        .is_ok_and(|age| age < CACHE_TTL))
}

fn write_checksum_marker(
    paths: &ProjectAssetCachePaths,
    catalog_version: &str,
    entry: &ProjectAssetEntry,
) -> Result<(), String> {
    atomic_write(
        &checksum_marker_path(paths, catalog_version, &entry.path)?,
        entry.sha256.to_ascii_lowercase().as_bytes(),
    )
}

fn has_valid_checksum_marker(
    paths: &ProjectAssetCachePaths,
    catalog_version: &str,
    entry: &ProjectAssetEntry,
) -> Result<bool, String> {
    let marker_path = checksum_marker_path(paths, catalog_version, &entry.path)?;
    if !marker_path.exists() {
        return Ok(false);
    }
    let checksum = fs::read_to_string(&marker_path).map_err(|error| {
        format!(
            "Failed to read cached project image checksum marker '{}': {error}",
            marker_path.display()
        )
    })?;
    Ok(checksum.trim().eq_ignore_ascii_case(&entry.sha256))
}

fn valid_cached_asset(
    paths: &ProjectAssetCachePaths,
    catalog: &ProjectAssetCatalog,
    entry: &ProjectAssetEntry,
    target: &Path,
) -> Result<bool, String> {
    if !target.exists() {
        return Ok(false);
    }
    let metadata = fs::metadata(target).map_err(|error| {
        format!(
            "Failed to inspect cached project image '{}': {error}",
            target.display()
        )
    })?;
    if metadata.len() != entry.byte_size {
        return Ok(false);
    }
    has_valid_checksum_marker(paths, &catalog.catalog_version, entry)
}

fn project_asset_cache_paths(app: &AppHandle) -> Result<ProjectAssetCachePaths, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Failed to resolve app data directory: {error}"))?;
    Ok(cache_paths_for_root(app_data_dir.join("project-artifacts")))
}

fn cache_paths_for_root(root: PathBuf) -> ProjectAssetCachePaths {
    ProjectAssetCachePaths {
        meta: root.join("meta"),
        media: root.join("media"),
    }
}

fn allowed_artifactory_url(relative_path: &str) -> Result<Url, String> {
    // Publishing/promoting require authenticated scripts; app downloads rely on public read access.
    validate_safe_relative_path(relative_path)?;
    let base = Url::parse(ARTIFACTORY_BASE).map_err(|error| error.to_string())?;
    let url = base
        .join(relative_path)
        .map_err(|error| format!("Invalid project image artifact URL: {error}"))?;
    if !url.as_str().starts_with(ARTIFACTORY_BASE) {
        return Err("Project image artifact URL is outside the allowed base".to_string());
    }
    Ok(url)
}

fn media_cache_path(
    paths: &ProjectAssetCachePaths,
    catalog_version: &str,
    relative_path: &str,
) -> Result<PathBuf, String> {
    validate_catalog_version(catalog_version)?;
    validate_safe_relative_path(relative_path)?;
    Ok(paths.media.join(catalog_version).join(relative_path))
}

fn validate_catalog(catalog: &ProjectAssetCatalog) -> Result<(), String> {
    if catalog.schema_version != 1 {
        return Err("Unsupported project image catalog schema".to_string());
    }
    validate_catalog_version(&catalog.catalog_version)?;
    if catalog.images.is_empty() {
        return Err("Project image catalog must contain at least one image".to_string());
    }

    let mut ids = HashSet::new();
    let mut previous_path: Option<&str> = None;
    for entry in &catalog.images {
        validate_asset_id(&entry.id)?;
        validate_entry_path(entry)?;
        if entry.mime_type != "image/webp" {
            return Err("Project memory image mime type must be image/webp".to_string());
        }
        if !entry.path.starts_with("images/") || !entry.path.ends_with(".webp") {
            return Err(
                "Project memory image path must be under images/ with .webp extension".to_string(),
            );
        }
        if previous_path.is_some_and(|previous| previous >= entry.path.as_str()) {
            return Err("Project image catalog paths must be sorted".to_string());
        }
        previous_path = Some(&entry.path);
        if !ids.insert(entry.id.as_str()) {
            return Err("Project image catalog contains duplicate image ids".to_string());
        }
    }

    validate_asset_id(&catalog.environment.id)?;
    validate_entry_path(&catalog.environment)?;
    if catalog.environment.mime_type != "image/x-exr" {
        return Err("Project environment image mime type must be image/x-exr".to_string());
    }
    if !catalog.environment.path.starts_with("hdri/") || !catalog.environment.path.ends_with(".exr")
    {
        return Err(
            "Project environment image path must be under hdri/ with .exr extension".to_string(),
        );
    }

    Ok(())
}

fn validate_entry_path(entry: &ProjectAssetEntry) -> Result<(), String> {
    validate_safe_relative_path(&entry.path)?;
    if entry.byte_size == 0 {
        return Err("Project image asset byte size must be positive".to_string());
    }
    if !entry.sha256.chars().all(|c| c.is_ascii_hexdigit()) || entry.sha256.len() != 64 {
        return Err("Project image asset checksum must be a SHA-256 hex digest".to_string());
    }
    Ok(())
}

#[cfg(test)]
fn validate_bytes(bytes: &[u8], entry: &ProjectAssetEntry) -> Result<(), String> {
    if bytes.len() as u64 != entry.byte_size {
        return Err("Project image asset byte size did not match manifest".to_string());
    }
    let digest = Sha256::digest(bytes);
    let actual = hex_digest(digest.as_slice());
    if actual != entry.sha256.to_ascii_lowercase() {
        return Err("Project image asset checksum did not match manifest".to_string());
    }
    Ok(())
}

fn hex_digest(bytes: &[u8]) -> String {
    bytes
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>()
}

fn validate_safe_relative_path(path: &str) -> Result<(), String> {
    if path.is_empty() || path.contains('\\') || path.contains('\0') {
        return Err("Invalid project image artifact path".to_string());
    }
    let path = Path::new(path);
    if path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err("Invalid project image artifact path".to_string());
    }
    Ok(())
}

fn validate_catalog_version(value: &str) -> Result<(), String> {
    if value.len() != 19
        || !value.as_bytes()[0..8].iter().all(u8::is_ascii_digit)
        || value.as_bytes()[8] != b'T'
        || !value.as_bytes()[9..18].iter().all(u8::is_ascii_digit)
        || value.as_bytes()[18] != b'Z'
    {
        return Err("Project image catalog version must match YYYYMMDDTHHMMSSmmmZ".to_string());
    }
    Ok(())
}

fn validate_asset_id(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 64
        || !value
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        || !value
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '-' | '_'))
    {
        return Err("Invalid project image id".to_string());
    }
    Ok(())
}

fn prune_obsolete_versions(
    paths: &ProjectAssetCachePaths,
    current_version: &str,
) -> Result<(), String> {
    for base in [&paths.meta, &paths.media] {
        if !base.exists() {
            continue;
        }
        for entry in fs::read_dir(base)
            .map_err(|error| format!("Failed to read project image cache directory: {error}"))?
        {
            let entry = entry
                .map_err(|error| format!("Failed to inspect project image cache entry: {error}"))?;
            if !entry
                .file_type()
                .map_err(|error| {
                    format!("Failed to inspect project image cache file type: {error}")
                })?
                .is_dir()
            {
                continue;
            }
            let version = entry.file_name().to_string_lossy().into_owned();
            if version != current_version {
                fs::remove_dir_all(entry.path()).map_err(|error| {
                    format!("Failed to prune obsolete project image cache: {error}")
                })?;
            }
        }
    }

    Ok(())
}

fn clean_part_files(paths: &ProjectAssetCachePaths) -> Result<(), String> {
    for base in [&paths.meta, &paths.media] {
        clean_part_files_under(base)?;
    }
    Ok(())
}

fn clean_part_files_under(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    for entry in fs::read_dir(path)
        .map_err(|error| format!("Failed to read project image cache directory: {error}"))?
    {
        let entry = entry
            .map_err(|error| format!("Failed to inspect project image cache entry: {error}"))?;
        let path = entry.path();
        let file_type = entry
            .file_type()
            .map_err(|error| format!("Failed to inspect project image cache file type: {error}"))?;
        if file_type.is_dir() {
            clean_part_files_under(&path)?;
        } else if entry.file_name().to_string_lossy().ends_with(".part") {
            delete_file_if_exists(&path)?;
        }
    }
    Ok(())
}

fn delete_file_if_exists(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!(
            "Failed to delete project image cache file: {error}"
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(id: &str, path: &str, bytes: &[u8]) -> ProjectAssetEntry {
        let digest = Sha256::digest(bytes);
        ProjectAssetEntry {
            id: id.to_string(),
            path: path.to_string(),
            mime_type: if path.ends_with(".exr") {
                "image/x-exr".to_string()
            } else {
                "image/webp".to_string()
            },
            byte_size: bytes.len() as u64,
            sha256: hex_digest(digest.as_slice()),
        }
    }

    fn valid_catalog(bytes: &[u8]) -> ProjectAssetCatalog {
        ProjectAssetCatalog {
            schema_version: 1,
            catalog_version: "20260521T121530123Z".to_string(),
            images: (1..=12)
                .map(|index| {
                    entry(
                        &format!("memory-{index:02}"),
                        &format!("images/memory-{index:02}.webp"),
                        bytes,
                    )
                })
                .collect(),
            environment: entry("studio-soft", "hdri/studio_soft.exr", bytes),
        }
    }

    fn temp_paths() -> (tempfile::TempDir, ProjectAssetCachePaths) {
        let dir = tempfile::tempdir().unwrap();
        let paths = cache_paths_for_root(dir.path().join("project-artifacts"));
        (dir, paths)
    }

    fn write_valid_catalog(paths: &ProjectAssetCachePaths, catalog: &ProjectAssetCatalog) {
        let latest = ProjectAssetLatest {
            catalog_version: catalog.catalog_version.clone(),
            manifest_path: Some(format!("{}/manifest.json", catalog.catalog_version)),
        };
        write_cached_catalog(paths, &latest, catalog).unwrap();
    }

    #[test]
    fn artifactory_urls_are_allowlisted() {
        let url = allowed_artifactory_url("v1/manifest.json").unwrap();
        assert_eq!(
            url.as_str(),
            "https://global.block-artifacts.com/artifactory/goose-internal/project-artifacts/v1/manifest.json"
        );
        assert!(allowed_artifactory_url("../manifest.json").is_err());
        assert!(allowed_artifactory_url("https://example.com/file").is_err());
    }

    #[test]
    fn media_cache_paths_reject_traversal_and_point_under_media() {
        let paths = cache_paths_for_root(PathBuf::from("/tmp/project-artifacts"));
        let version = "20260521T121530123Z";
        let path = media_cache_path(&paths, version, "images/memory-01.webp").unwrap();
        assert_eq!(
            path,
            paths.media.join(format!("{version}/images/memory-01.webp"))
        );
        assert!(path.starts_with(&paths.media));
        assert!(!path.starts_with(&paths.meta));
        assert!(media_cache_path(&paths, version, "images/../secret").is_err());
        assert!(media_cache_path(&paths, "../v1", "images/memory-01.webp").is_err());
    }

    #[test]
    fn byte_size_and_sha256_are_validated() {
        let bytes = b"asset-bytes";
        let valid = entry("memory-01", "images/memory-01.webp", bytes);
        assert!(validate_bytes(bytes, &valid).is_ok());

        let mut bad_size = valid.clone();
        bad_size.byte_size += 1;
        assert!(validate_bytes(bytes, &bad_size).is_err());

        let mut bad_hash = valid;
        bad_hash.sha256 = "0".repeat(64);
        assert!(validate_bytes(bytes, &bad_hash).is_err());
    }

    #[test]
    fn catalog_validation_allows_variable_images_and_renamed_environment() {
        let bytes = b"asset-bytes";
        let catalog = ProjectAssetCatalog {
            schema_version: 1,
            catalog_version: "20260521T121530123Z".to_string(),
            images: vec![
                entry("alpha", "images/alpha.webp", bytes),
                entry("zebra", "images/zebra.webp", bytes),
            ],
            environment: entry("loft", "hdri/loft.exr", bytes),
        };

        assert!(validate_catalog(&catalog).is_ok());
    }

    #[test]
    fn catalog_validation_rejects_bad_versions_and_entries() {
        let bytes = b"asset-bytes";
        let mut catalog = valid_catalog(bytes);
        catalog.catalog_version = "v1".to_string();
        assert!(validate_catalog(&catalog).is_err());

        let mut catalog = valid_catalog(bytes);
        catalog.images.clear();
        assert!(validate_catalog(&catalog).is_err());

        let mut catalog = valid_catalog(bytes);
        catalog.images[1].id = catalog.images[0].id.clone();
        assert!(validate_catalog(&catalog).is_err());

        let mut catalog = valid_catalog(bytes);
        catalog.images[0].path = "../memory-01.webp".to_string();
        assert!(validate_catalog(&catalog).is_err());

        let mut catalog = valid_catalog(bytes);
        catalog.images[0].mime_type = "image/png".to_string();
        assert!(validate_catalog(&catalog).is_err());
    }

    #[test]
    fn catalog_validation_requires_sorted_image_paths() {
        let bytes = b"asset-bytes";
        let mut catalog = valid_catalog(bytes);
        catalog.images.swap(0, 1);

        assert!(validate_catalog(&catalog).is_err());
    }

    #[test]
    fn corrupt_cached_latest_or_manifest_is_deleted() {
        let (_dir, paths) = temp_paths();
        fs::create_dir_all(&paths.meta).unwrap();
        fs::write(paths.meta.join(LATEST_PATH), b"{").unwrap();
        assert!(read_cached_catalog(&paths).unwrap().is_none());
        assert!(!paths.meta.join(LATEST_PATH).exists());

        let catalog = valid_catalog(b"asset-bytes");
        let latest = ProjectAssetLatest {
            catalog_version: catalog.catalog_version.clone(),
            manifest_path: Some(format!("{}/manifest.json", catalog.catalog_version)),
        };
        atomic_write(
            &paths.meta.join("latest.json"),
            serde_json::to_vec(&latest).unwrap().as_slice(),
        )
        .unwrap();
        fs::create_dir_all(paths.meta.join(&catalog.catalog_version)).unwrap();
        fs::write(
            paths
                .meta
                .join(&catalog.catalog_version)
                .join("manifest.json"),
            b"{",
        )
        .unwrap();
        assert!(read_cached_catalog(&paths).unwrap().is_none());
        assert!(!paths
            .meta
            .join(&catalog.catalog_version)
            .join("manifest.json")
            .exists());

        write_valid_catalog(&paths, &catalog);
        assert!(read_cached_catalog(&paths).unwrap().is_some());
    }

    #[tokio::test]
    async fn existing_valid_cached_assets_are_reused() {
        let bytes = b"asset-bytes";
        let catalog = valid_catalog(bytes);
        let (_dir, paths) = temp_paths();
        let target =
            media_cache_path(&paths, &catalog.catalog_version, &catalog.images[0].path).unwrap();
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        fs::write(&target, bytes).unwrap();
        write_checksum_marker(&paths, &catalog.catalog_version, &catalog.images[0]).unwrap();

        let cached = ensure_entry(
            &http_client().unwrap(),
            &paths,
            &catalog,
            &catalog.images[0],
        )
        .await
        .unwrap();

        assert_eq!(cached, target.to_string_lossy());
    }

    #[tokio::test]
    async fn ensure_entries_preserves_image_order() {
        let bytes = b"asset-bytes";
        let catalog = valid_catalog(bytes);
        let (_dir, paths) = temp_paths();

        for entry in &catalog.images {
            let target = media_cache_path(&paths, &catalog.catalog_version, &entry.path).unwrap();
            fs::create_dir_all(target.parent().unwrap()).unwrap();
            fs::write(&target, bytes).unwrap();
            write_checksum_marker(&paths, &catalog.catalog_version, entry).unwrap();
        }

        let cached = ensure_entries(&http_client().unwrap(), &paths, &catalog, &catalog.images)
            .await
            .unwrap();

        assert_eq!(cached.len(), catalog.images.len());
        for (index, path) in cached.iter().enumerate() {
            assert!(path.ends_with(&catalog.images[index].path));
        }
    }

    #[test]
    fn refresh_marker_controls_cache_freshness() {
        let (_dir, paths) = temp_paths();
        assert!(!is_cache_fresh(&paths).unwrap());

        write_refresh_marker(&paths).unwrap();

        assert!(is_cache_fresh(&paths).unwrap());
    }

    #[tokio::test]
    async fn invalid_cached_assets_are_deleted_and_redownloaded() {
        let bytes = b"asset-bytes";
        let catalog = valid_catalog(bytes);
        let (_dir, paths) = temp_paths();
        let target =
            media_cache_path(&paths, &catalog.catalog_version, &catalog.images[0].path).unwrap();
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        fs::write(&target, b"wrong").unwrap();
        write_checksum_marker(&paths, &catalog.catalog_version, &catalog.images[0]).unwrap();

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let body = bytes.to_vec();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{}",
                body.len(),
                String::from_utf8_lossy(&body)
            );
            socket.write_all(response.as_bytes()).await.unwrap();
        });
        let url = Url::parse(&format!("http://{addr}/memory-01.webp")).unwrap();
        download_asset(&http_client().unwrap(), url, &target, &catalog.images[0])
            .await
            .unwrap();

        server.await.unwrap();
        assert_eq!(fs::read(&target).unwrap(), bytes);
    }
}
