use futures_util::{stream, StreamExt};
use reqwest::Url;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::sync::OnceLock;
use std::time::{Duration, SystemTime};
use tauri::{AppHandle, Manager};
use tokio::io::AsyncWriteExt;

const ARTIFACTORY_BASE: &str =
    "https://global.block-artifacts.com/artifactory/goose-internal/artifacts/";
const LATEST_PATH: &str = "latest.json";
const MANIFEST_FILE: &str = "manifest.json";
const REFRESH_MARKER_FILE: &str = "refresh.marker";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);
const CACHE_TTL: Duration = Duration::from_secs(7 * 24 * 60 * 60);
const DOWNLOAD_CONCURRENCY: usize = 4;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactLatest {
    pub catalog_version: String,
    pub manifest_path: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactCatalog {
    pub schema_version: u8,
    pub catalog_version: String,
    pub assets: Vec<ArtifactEntry>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactEntry {
    pub kind: ArtifactKind,
    pub path: String,
    pub mime_type: String,
    pub byte_size: u64,
    pub sha256: String,
    pub collection_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ArtifactKind {
    Environment,
    ProjectImage,
    CollectionImage,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Artifacts {
    pub catalog_version: String,
    pub assets: Vec<CachedArtifact>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedArtifact {
    pub kind: ArtifactKind,
    pub path: String,
    pub mime_type: String,
    pub byte_size: u64,
    pub sha256: String,
    pub collection_id: Option<String>,
}

#[derive(Debug, Clone)]
struct ArtifactCachePaths {
    legacy_root: Option<PathBuf>,
    meta: PathBuf,
    media: PathBuf,
}

#[tauri::command]
pub async fn get_artifacts(app: AppHandle) -> Result<Artifacts, String> {
    ensure_artifacts(app).await
}

pub async fn warm_artifacts_cache(app: AppHandle) -> Result<(), String> {
    ensure_artifacts(app).await.map(|_| ())
}

pub async fn clear_artifacts_cache(app: AppHandle) -> Result<(), String> {
    let _cache_guard = artifact_cache_lock().lock().await;
    let paths = artifact_cache_paths(&app)?;
    clear_artifacts_cache_paths(&paths).await
}

async fn clear_artifacts_cache_paths(paths: &ArtifactCachePaths) -> Result<(), String> {
    remove_dir_all_if_exists(&paths.meta, "artifact metadata").await?;
    remove_dir_all_if_exists(&paths.media, "artifact media").await?;
    if let Some(legacy_root) = &paths.legacy_root {
        remove_dir_all_if_exists(legacy_root, "legacy project artifact").await?;
    }
    Ok(())
}

async fn ensure_artifacts(app: AppHandle) -> Result<Artifacts, String> {
    let _cache_guard = artifact_cache_lock().lock().await;
    let paths = artifact_cache_paths(&app)?;
    clean_part_files(&paths)?;

    if let Some((catalog, assets)) = read_complete_cached_assets(&paths).await? {
        if is_cache_fresh(&paths)? {
            prune_obsolete_versions(&paths, &catalog.catalog_version)?;
            return Ok(assets);
        }

        match refresh_artifacts_cache_unlocked(&paths).await {
            Ok(refreshed) => return Ok(refreshed),
            Err(error) => {
                log::warn!(
                    "Failed to refresh stale artifact asset cache; using cached assets: {error}"
                );
                return Ok(assets);
            }
        }
    }

    refresh_artifacts_cache_unlocked(&paths).await
}

async fn read_complete_cached_assets(
    paths: &ArtifactCachePaths,
) -> Result<Option<(ArtifactCatalog, Artifacts)>, String> {
    let Some(catalog) = read_cached_catalog(paths)? else {
        return Ok(None);
    };

    match read_cached_assets_for_catalog(paths, &catalog) {
        Ok(assets) => Ok(Some((catalog, assets))),
        Err(error) => {
            log::warn!("Ignoring incomplete artifact asset cache: {error}");
            Ok(None)
        }
    }
}

async fn refresh_artifacts_cache_unlocked(paths: &ArtifactCachePaths) -> Result<Artifacts, String> {
    let catalog = refresh_cached_catalog(paths).await?;
    let client = http_client()?;
    let assets = ensure_assets_for_catalog(&client, paths, &catalog).await?;
    write_refresh_marker(paths)?;
    prune_obsolete_versions(paths, &catalog.catalog_version)?;
    Ok(assets)
}

async fn ensure_assets_for_catalog(
    client: &reqwest::Client,
    paths: &ArtifactCachePaths,
    catalog: &ArtifactCatalog,
) -> Result<Artifacts, String> {
    let assets = ensure_entries(client, paths, catalog, &catalog.assets).await?;

    Ok(Artifacts {
        catalog_version: catalog.catalog_version.clone(),
        assets,
    })
}

fn read_cached_assets_for_catalog(
    paths: &ArtifactCachePaths,
    catalog: &ArtifactCatalog,
) -> Result<Artifacts, String> {
    let mut assets = Vec::with_capacity(catalog.assets.len());
    for entry in &catalog.assets {
        validate_entry_path(entry)?;
        let target = media_cache_path(paths, &catalog.catalog_version, &entry.path)?;
        if !valid_cached_asset(paths, catalog, entry, &target)? {
            return Err(format!(
                "Cached artifact asset is missing or invalid: {}",
                entry.path
            ));
        }
        assets.push(cached_artifact(entry, &target));
    }

    Ok(Artifacts {
        catalog_version: catalog.catalog_version.clone(),
        assets,
    })
}

async fn refresh_cached_catalog(paths: &ArtifactCachePaths) -> Result<ArtifactCatalog, String> {
    let (latest, catalog) = fetch_current_catalog().await?;
    write_cached_catalog(paths, &latest, &catalog)?;
    Ok(catalog)
}

async fn fetch_current_catalog() -> Result<(ArtifactLatest, ArtifactCatalog), String> {
    let client = http_client()?;
    let latest: ArtifactLatest = client
        .get(allowed_artifactory_url(LATEST_PATH)?)
        .send()
        .await
        .map_err(|error| format!("Failed to fetch artifact latest pointer: {error}"))?
        .error_for_status()
        .map_err(|error| format!("Artifact latest pointer returned an error: {error}"))?
        .json()
        .await
        .map_err(|error| format!("Failed to parse artifact latest pointer: {error}"))?;

    let manifest_path = manifest_path_for_latest(&latest)?;
    let catalog: ArtifactCatalog = client
        .get(allowed_artifactory_url(&manifest_path)?)
        .send()
        .await
        .map_err(|error| format!("Failed to fetch artifact catalog: {error}"))?
        .error_for_status()
        .map_err(|error| format!("Artifact catalog returned an error: {error}"))?
        .json()
        .await
        .map_err(|error| format!("Failed to parse artifact catalog: {error}"))?;

    validate_catalog(&catalog)?;
    if catalog.catalog_version != latest.catalog_version {
        return Err("Artifact catalog version does not match latest pointer".to_string());
    }

    Ok((latest, catalog))
}

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|error| format!("Failed to create artifact HTTP client: {error}"))
}

fn artifact_cache_lock() -> &'static tokio::sync::Mutex<()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

fn read_cached_catalog(paths: &ArtifactCachePaths) -> Result<Option<ArtifactCatalog>, String> {
    let latest_path = paths.meta.join(LATEST_PATH);
    if !latest_path.exists() {
        return Ok(None);
    }

    let latest = match read_json_file::<ArtifactLatest>(&latest_path) {
        Ok(latest) => latest,
        Err(error) => {
            delete_file_if_exists(&latest_path)?;
            log::warn!("Ignoring corrupt artifact latest cache: {error}");
            return Ok(None);
        }
    };
    let manifest_path = match manifest_path_for_latest(&latest) {
        Ok(path) => path,
        Err(error) => {
            delete_file_if_exists(&latest_path)?;
            log::warn!("Ignoring invalid artifact latest cache: {error}");
            return Ok(None);
        }
    };

    let catalog_path = paths.meta.join(manifest_path);
    if !catalog_path.exists() {
        return Ok(None);
    }

    let catalog = match read_json_file::<ArtifactCatalog>(&catalog_path) {
        Ok(catalog) => catalog,
        Err(error) => {
            delete_file_if_exists(&catalog_path)?;
            log::warn!("Ignoring corrupt artifact manifest cache: {error}");
            return Ok(None);
        }
    };
    if let Err(error) = validate_catalog(&catalog) {
        delete_file_if_exists(&catalog_path)?;
        log::warn!("Ignoring invalid artifact manifest cache: {error}");
        return Ok(None);
    }
    if catalog.catalog_version != latest.catalog_version {
        delete_file_if_exists(&catalog_path)?;
        return Ok(None);
    }

    Ok(Some(catalog))
}

fn write_cached_catalog(
    paths: &ArtifactCachePaths,
    latest: &ArtifactLatest,
    catalog: &ArtifactCatalog,
) -> Result<(), String> {
    validate_catalog(catalog)?;
    if latest.catalog_version != catalog.catalog_version {
        return Err("Artifact catalog version does not match latest pointer".to_string());
    }

    let manifest_path = manifest_path_for_latest(latest)?;
    let latest_json = serde_json::to_vec_pretty(latest)
        .map_err(|error| format!("Failed to serialize artifact latest pointer: {error}"))?;
    let catalog_json = serde_json::to_vec_pretty(catalog)
        .map_err(|error| format!("Failed to serialize artifact catalog: {error}"))?;

    atomic_write(&paths.meta.join(&manifest_path), &catalog_json)?;
    atomic_write(&paths.meta.join(LATEST_PATH), &latest_json)?;
    Ok(())
}

fn manifest_path_for_latest(latest: &ArtifactLatest) -> Result<String, String> {
    validate_catalog_version(&latest.catalog_version)?;
    let expected = format!("{}/{}", latest.catalog_version, MANIFEST_FILE);
    let manifest_path = latest
        .manifest_path
        .clone()
        .unwrap_or_else(|| expected.clone());
    validate_safe_relative_path(&manifest_path)?;
    if manifest_path != expected {
        return Err(
            "Artifact latest manifest path must match catalogVersion/manifest.json".to_string(),
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
        .ok_or_else(|| "Artifact cache target has no parent".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Failed to create artifact cache directory: {error}"))?;
    let part_path = unique_part_path(path);
    {
        let mut file = fs::File::create(&part_path)
            .map_err(|error| format!("Failed to create artifact cache part file: {error}"))?;
        file.write_all(bytes)
            .map_err(|error| format!("Failed to write artifact cache part file: {error}"))?;
        file.sync_all()
            .map_err(|error| format!("Failed to sync artifact cache part file: {error}"))?;
    }
    fs::rename(&part_path, path).map_err(|error| {
        let _ = fs::remove_file(&part_path);
        format!("Failed to finalize artifact cache file: {error}")
    })
}

async fn ensure_entries(
    client: &reqwest::Client,
    paths: &ArtifactCachePaths,
    catalog: &ArtifactCatalog,
    entries: &[ArtifactEntry],
) -> Result<Vec<CachedArtifact>, String> {
    let results: Vec<Result<CachedArtifact, String>> = stream::iter(entries.to_vec())
        .map(|entry| async move { ensure_entry(client, paths, catalog, &entry).await })
        .buffered(DOWNLOAD_CONCURRENCY)
        .collect()
        .await;
    results.into_iter().collect()
}

async fn ensure_entry(
    client: &reqwest::Client,
    paths: &ArtifactCachePaths,
    catalog: &ArtifactCatalog,
    entry: &ArtifactEntry,
) -> Result<CachedArtifact, String> {
    validate_entry_path(entry)?;
    let target = media_cache_path(paths, &catalog.catalog_version, &entry.path)?;

    if valid_cached_asset(paths, catalog, entry, &target)? {
        return Ok(cached_artifact(entry, &target));
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

    Ok(cached_artifact(entry, &target))
}

fn cached_artifact(entry: &ArtifactEntry, target: &Path) -> CachedArtifact {
    CachedArtifact {
        kind: entry.kind.clone(),
        path: target.to_string_lossy().into_owned(),
        mime_type: entry.mime_type.clone(),
        byte_size: entry.byte_size,
        sha256: entry.sha256.clone(),
        collection_id: entry.collection_id.clone(),
    }
}

async fn download_asset(
    client: &reqwest::Client,
    url: Url,
    target: &Path,
    entry: &ArtifactEntry,
) -> Result<(), String> {
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|error| format!("Failed to download artifact asset: {error}"))?
        .error_for_status()
        .map_err(|error| format!("Artifact asset returned an error: {error}"))?;
    if let Some(content_length) = response.content_length() {
        if content_length != entry.byte_size {
            return Err("Artifact asset byte size did not match manifest".to_string());
        }
    }

    let parent = target
        .parent()
        .ok_or_else(|| "Artifact cache target has no parent".to_string())?;
    tokio::fs::create_dir_all(parent)
        .await
        .map_err(|error| format!("Failed to create artifact cache directory: {error}"))?;
    let part_path = unique_part_path(target);
    let mut file = tokio::fs::File::create(&part_path)
        .await
        .map_err(|error| format!("Failed to create artifact cache part file: {error}"))?;
    let mut part_file = PartFile::new(part_path);
    let mut stream = response.bytes_stream();
    let mut hasher = Sha256::new();
    let mut downloaded = 0_u64;

    while let Some(chunk) = stream.next().await {
        let chunk =
            chunk.map_err(|error| format!("Failed to read artifact asset response: {error}"))?;
        downloaded += chunk.len() as u64;
        if downloaded > entry.byte_size {
            return Err("Artifact asset byte size exceeded manifest".to_string());
        }
        hasher.update(&chunk);
        file.write_all(&chunk)
            .await
            .map_err(|error| format!("Failed to write artifact cache part file: {error}"))?;
    }
    file.flush()
        .await
        .map_err(|error| format!("Failed to flush artifact cache part file: {error}"))?;

    if downloaded != entry.byte_size {
        return Err("Artifact asset byte size did not match manifest".to_string());
    }
    let actual = hex_digest(hasher.finalize().as_slice());
    if actual != entry.sha256.to_ascii_lowercase() {
        return Err("Artifact asset checksum did not match manifest".to_string());
    }

    file.sync_all()
        .await
        .map_err(|error| format!("Failed to sync artifact cache part file: {error}"))?;
    drop(file);

    if let Err(error) = tokio::fs::rename(part_file.path(), target).await {
        return Err(format!("Failed to finalize artifact cache file: {error}"));
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
    paths: &ArtifactCachePaths,
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

fn refresh_marker_path(paths: &ArtifactCachePaths) -> PathBuf {
    paths.meta.join(REFRESH_MARKER_FILE)
}

fn write_refresh_marker(paths: &ArtifactCachePaths) -> Result<(), String> {
    let refreshed_at = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map_err(|error| format!("Failed to create artifact refresh marker: {error}"))?
        .as_nanos()
        .to_string();
    atomic_write(&refresh_marker_path(paths), refreshed_at.as_bytes())
}

fn is_cache_fresh(paths: &ArtifactCachePaths) -> Result<bool, String> {
    let marker_path = refresh_marker_path(paths);
    let metadata = match fs::metadata(&marker_path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => {
            return Err(format!(
                "Failed to inspect artifact refresh marker '{}': {error}",
                marker_path.display()
            ))
        }
    };
    let modified = metadata.modified().map_err(|error| {
        format!(
            "Failed to read artifact refresh marker timestamp '{}': {error}",
            marker_path.display()
        )
    })?;
    Ok(SystemTime::now()
        .duration_since(modified)
        .is_ok_and(|age| age < CACHE_TTL))
}

fn write_checksum_marker(
    paths: &ArtifactCachePaths,
    catalog_version: &str,
    entry: &ArtifactEntry,
) -> Result<(), String> {
    atomic_write(
        &checksum_marker_path(paths, catalog_version, &entry.path)?,
        entry.sha256.to_ascii_lowercase().as_bytes(),
    )
}

fn has_valid_checksum_marker(
    paths: &ArtifactCachePaths,
    catalog_version: &str,
    entry: &ArtifactEntry,
) -> Result<bool, String> {
    let marker_path = checksum_marker_path(paths, catalog_version, &entry.path)?;
    if !marker_path.exists() {
        return Ok(false);
    }
    let checksum = fs::read_to_string(&marker_path).map_err(|error| {
        format!(
            "Failed to read cached artifact checksum marker '{}': {error}",
            marker_path.display()
        )
    })?;
    Ok(checksum.trim().eq_ignore_ascii_case(&entry.sha256))
}

fn valid_cached_asset(
    paths: &ArtifactCachePaths,
    catalog: &ArtifactCatalog,
    entry: &ArtifactEntry,
    target: &Path,
) -> Result<bool, String> {
    if !target.exists() {
        return Ok(false);
    }
    let metadata = fs::metadata(target).map_err(|error| {
        format!(
            "Failed to inspect cached artifact '{}': {error}",
            target.display()
        )
    })?;
    if metadata.len() != entry.byte_size {
        return Ok(false);
    }
    has_valid_checksum_marker(paths, &catalog.catalog_version, entry)
}

fn artifact_cache_paths(app: &AppHandle) -> Result<ArtifactCachePaths, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Failed to resolve app data directory: {error}"))?;
    Ok(cache_paths_for_root_with_legacy(
        app_data_dir.join("artifacts"),
        Some(app_data_dir.join("project-artifacts")),
    ))
}

#[cfg(test)]
fn cache_paths_for_root(root: PathBuf) -> ArtifactCachePaths {
    cache_paths_for_root_with_legacy(root, None)
}

fn cache_paths_for_root_with_legacy(
    root: PathBuf,
    legacy_root: Option<PathBuf>,
) -> ArtifactCachePaths {
    ArtifactCachePaths {
        legacy_root,
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
        .map_err(|error| format!("Invalid artifact URL: {error}"))?;
    if !url.as_str().starts_with(ARTIFACTORY_BASE) {
        return Err("Artifact URL is outside the allowed base".to_string());
    }
    Ok(url)
}

fn media_cache_path(
    paths: &ArtifactCachePaths,
    catalog_version: &str,
    relative_path: &str,
) -> Result<PathBuf, String> {
    validate_catalog_version(catalog_version)?;
    validate_safe_relative_path(relative_path)?;
    Ok(paths.media.join(catalog_version).join(relative_path))
}

fn validate_catalog(catalog: &ArtifactCatalog) -> Result<(), String> {
    if catalog.schema_version != 1 {
        return Err("Unsupported artifact catalog schema".to_string());
    }
    validate_catalog_version(&catalog.catalog_version)?;
    if catalog.assets.is_empty() {
        return Err("Artifact catalog must contain at least one asset".to_string());
    }

    let mut previous_path: Option<&str> = None;
    for entry in &catalog.assets {
        validate_entry_path(entry)?;
        if previous_path.is_some_and(|previous| previous >= entry.path.as_str()) {
            return Err("Artifact catalog paths must be sorted".to_string());
        }
        previous_path = Some(&entry.path);
        validate_entry_kind(entry)?;
    }

    Ok(())
}

fn validate_entry_kind(entry: &ArtifactEntry) -> Result<(), String> {
    match entry.kind {
        ArtifactKind::Environment => {
            validate_entry_file(entry, "assets/hdri/", ".exr", "image/x-exr")?;
            if entry.collection_id.is_some() {
                return Err("Environment artifacts must not include collectionId".to_string());
            }
        }
        ArtifactKind::ProjectImage => {
            validate_entry_file(entry, "assets/project-images/", ".webp", "image/webp")?;
            if entry.collection_id.is_some() {
                return Err("Project image artifacts must not include collectionId".to_string());
            }
        }
        ArtifactKind::CollectionImage => {
            validate_entry_file(entry, "assets/images/", ".png", "image/png")?;
            let collection_id = entry
                .collection_id
                .as_deref()
                .ok_or_else(|| "Collection image artifacts require collectionId".to_string())?;
            validate_collection_id(collection_id)?;
            if !entry
                .path
                .starts_with(&format!("assets/images/{collection_id}/"))
            {
                return Err("Collection image path must match collectionId".to_string());
            }
        }
    }
    Ok(())
}

fn validate_entry_file(
    entry: &ArtifactEntry,
    prefix: &str,
    extension: &str,
    mime_type: &str,
) -> Result<(), String> {
    if entry.mime_type != mime_type {
        return Err("Artifact mime type does not match kind".to_string());
    }
    if !entry.path.starts_with(prefix) || !entry.path.ends_with(extension) {
        return Err("Artifact path does not match kind".to_string());
    }
    Ok(())
}

fn validate_entry_path(entry: &ArtifactEntry) -> Result<(), String> {
    validate_safe_relative_path(&entry.path)?;
    if entry.byte_size == 0 {
        return Err("Artifact asset byte size must be positive".to_string());
    }
    if !entry.sha256.chars().all(|c| c.is_ascii_hexdigit()) || entry.sha256.len() != 64 {
        return Err("Artifact asset checksum must be a SHA-256 hex digest".to_string());
    }
    Ok(())
}

#[cfg(test)]
fn validate_bytes(bytes: &[u8], entry: &ArtifactEntry) -> Result<(), String> {
    if bytes.len() as u64 != entry.byte_size {
        return Err("Artifact asset byte size did not match manifest".to_string());
    }
    let digest = Sha256::digest(bytes);
    let actual = hex_digest(digest.as_slice());
    if actual != entry.sha256.to_ascii_lowercase() {
        return Err("Artifact asset checksum did not match manifest".to_string());
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
        return Err("Invalid artifact path".to_string());
    }
    let path = Path::new(path);
    if path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err("Invalid artifact path".to_string());
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
        return Err("Artifact catalog version must match YYYYMMDDTHHMMSSmmmZ".to_string());
    }
    Ok(())
}

fn validate_collection_id(value: &str) -> Result<(), String> {
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
        return Err("Invalid artifact collection id".to_string());
    }
    Ok(())
}

fn prune_obsolete_versions(
    paths: &ArtifactCachePaths,
    current_version: &str,
) -> Result<(), String> {
    for base in [&paths.meta, &paths.media] {
        if !base.exists() {
            continue;
        }
        for entry in fs::read_dir(base)
            .map_err(|error| format!("Failed to read artifact cache directory: {error}"))?
        {
            let entry = entry
                .map_err(|error| format!("Failed to inspect artifact cache entry: {error}"))?;
            if !entry
                .file_type()
                .map_err(|error| format!("Failed to inspect artifact cache file type: {error}"))?
                .is_dir()
            {
                continue;
            }
            let version = entry.file_name().to_string_lossy().into_owned();
            if version != current_version {
                fs::remove_dir_all(entry.path())
                    .map_err(|error| format!("Failed to prune obsolete artifact cache: {error}"))?;
            }
        }
    }

    Ok(())
}

fn clean_part_files(paths: &ArtifactCachePaths) -> Result<(), String> {
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
        .map_err(|error| format!("Failed to read artifact cache directory: {error}"))?
    {
        let entry =
            entry.map_err(|error| format!("Failed to inspect artifact cache entry: {error}"))?;
        let path = entry.path();
        let file_type = entry
            .file_type()
            .map_err(|error| format!("Failed to inspect artifact cache file type: {error}"))?;
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
        Err(error) => Err(format!("Failed to delete artifact cache file: {error}")),
    }
}

async fn remove_dir_all_if_exists(path: &Path, label: &str) -> Result<(), String> {
    match tokio::fs::remove_dir_all(path).await {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("Failed to delete {label} cache: {error}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(kind: ArtifactKind, path: &str, bytes: &[u8]) -> ArtifactEntry {
        let digest = Sha256::digest(bytes);
        let collection_id = match kind {
            ArtifactKind::CollectionImage => path
                .strip_prefix("assets/images/")
                .and_then(|rest| rest.split('/').next())
                .map(ToString::to_string),
            _ => None,
        };
        ArtifactEntry {
            kind,
            path: path.to_string(),
            mime_type: if path.ends_with(".exr") {
                "image/x-exr".to_string()
            } else if path.ends_with(".png") {
                "image/png".to_string()
            } else {
                "image/webp".to_string()
            },
            byte_size: bytes.len() as u64,
            sha256: hex_digest(digest.as_slice()),
            collection_id,
        }
    }

    fn valid_catalog(bytes: &[u8]) -> ArtifactCatalog {
        ArtifactCatalog {
            schema_version: 1,
            catalog_version: "20260521T121530123Z".to_string(),
            assets: [
                vec![entry(
                    ArtifactKind::Environment,
                    "assets/hdri/studio_soft.exr",
                    bytes,
                )],
                vec![entry(
                    ArtifactKind::CollectionImage,
                    "assets/images/fuzzies/fuzzy-01.png",
                    bytes,
                )],
                (1..=12)
                    .map(|index| {
                        entry(
                            ArtifactKind::ProjectImage,
                            &format!("assets/project-images/memory-{index:02}.webp"),
                            bytes,
                        )
                    })
                    .collect(),
            ]
            .concat(),
        }
    }

    fn temp_paths() -> (tempfile::TempDir, ArtifactCachePaths) {
        let dir = tempfile::tempdir().unwrap();
        let paths = cache_paths_for_root(dir.path().join("artifacts"));
        (dir, paths)
    }

    fn write_valid_catalog(paths: &ArtifactCachePaths, catalog: &ArtifactCatalog) {
        let latest = ArtifactLatest {
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
            "https://global.block-artifacts.com/artifactory/goose-internal/artifacts/v1/manifest.json"
        );
        assert!(allowed_artifactory_url("../manifest.json").is_err());
        assert!(allowed_artifactory_url("https://example.com/file").is_err());
    }

    #[test]
    fn media_cache_paths_reject_traversal_and_point_under_media() {
        let paths = cache_paths_for_root(PathBuf::from("/tmp/artifacts"));
        let version = "20260521T121530123Z";
        let path =
            media_cache_path(&paths, version, "assets/project-images/memory-01.webp").unwrap();
        assert_eq!(
            path,
            paths
                .media
                .join(format!("{version}/assets/project-images/memory-01.webp"))
        );
        assert!(path.starts_with(&paths.media));
        assert!(!path.starts_with(&paths.meta));
        assert!(media_cache_path(&paths, version, "assets/../secret").is_err());
        assert!(media_cache_path(&paths, "../v1", "assets/project-images/memory-01.webp").is_err());
    }

    #[test]
    fn byte_size_and_sha256_are_validated() {
        let bytes = b"asset-bytes";
        let valid = entry(
            ArtifactKind::ProjectImage,
            "assets/project-images/memory-01.webp",
            bytes,
        );
        assert!(validate_bytes(bytes, &valid).is_ok());

        let mut bad_size = valid.clone();
        bad_size.byte_size += 1;
        assert!(validate_bytes(bytes, &bad_size).is_err());

        let mut bad_hash = valid;
        bad_hash.sha256 = "0".repeat(64);
        assert!(validate_bytes(bytes, &bad_hash).is_err());
    }

    #[test]
    fn catalog_validation_allows_supported_artifact_kinds() {
        let bytes = b"asset-bytes";
        let catalog = ArtifactCatalog {
            schema_version: 1,
            catalog_version: "20260521T121530123Z".to_string(),
            assets: vec![
                entry(ArtifactKind::Environment, "assets/hdri/loft.exr", bytes),
                entry(
                    ArtifactKind::CollectionImage,
                    "assets/images/fuzzies/fuzzy-01.png",
                    bytes,
                ),
                entry(
                    ArtifactKind::ProjectImage,
                    "assets/project-images/alpha.webp",
                    bytes,
                ),
            ],
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
        catalog.assets.clear();
        assert!(validate_catalog(&catalog).is_err());

        let mut catalog = valid_catalog(bytes);
        catalog.assets[1].collection_id = Some("unexpected".to_string());
        assert!(validate_catalog(&catalog).is_err());

        let mut catalog = valid_catalog(bytes);
        catalog.assets[0].path = "../memory-01.webp".to_string();
        assert!(validate_catalog(&catalog).is_err());

        let mut catalog = valid_catalog(bytes);
        catalog.assets[0].mime_type = "image/png".to_string();
        assert!(validate_catalog(&catalog).is_err());
    }

    #[test]
    fn catalog_validation_requires_sorted_image_paths() {
        let bytes = b"asset-bytes";
        let mut catalog = valid_catalog(bytes);
        catalog.assets.swap(0, 1);

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
        let latest = ArtifactLatest {
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
        let entry = &catalog.assets[0];
        let target = media_cache_path(&paths, &catalog.catalog_version, &entry.path).unwrap();
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        fs::write(&target, bytes).unwrap();
        write_checksum_marker(&paths, &catalog.catalog_version, entry).unwrap();

        let cached = ensure_entry(&http_client().unwrap(), &paths, &catalog, entry)
            .await
            .unwrap();

        assert_eq!(cached.path, target.to_string_lossy());
    }

    #[tokio::test]
    async fn cached_catalog_reads_do_not_download_missing_assets() {
        let catalog = valid_catalog(b"asset-bytes");
        let (_dir, paths) = temp_paths();
        write_valid_catalog(&paths, &catalog);

        let cached = read_complete_cached_assets(&paths).await.unwrap();

        assert!(cached.is_none());
    }

    #[tokio::test]
    async fn ensure_entries_preserves_image_order() {
        let bytes = b"asset-bytes";
        let catalog = valid_catalog(bytes);
        let (_dir, paths) = temp_paths();

        for entry in &catalog.assets {
            let target = media_cache_path(&paths, &catalog.catalog_version, &entry.path).unwrap();
            fs::create_dir_all(target.parent().unwrap()).unwrap();
            fs::write(&target, bytes).unwrap();
            write_checksum_marker(&paths, &catalog.catalog_version, entry).unwrap();
        }

        let cached = ensure_entries(&http_client().unwrap(), &paths, &catalog, &catalog.assets)
            .await
            .unwrap();

        assert_eq!(cached.len(), catalog.assets.len());
        for (index, asset) in cached.iter().enumerate() {
            assert!(asset.path.ends_with(&catalog.assets[index].path));
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
        let entry = &catalog.assets[1];
        let target = media_cache_path(&paths, &catalog.catalog_version, &entry.path).unwrap();
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        fs::write(&target, b"wrong").unwrap();
        write_checksum_marker(&paths, &catalog.catalog_version, entry).unwrap();

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
        download_asset(&http_client().unwrap(), url, &target, entry)
            .await
            .unwrap();

        server.await.unwrap();
        assert_eq!(fs::read(&target).unwrap(), bytes);
    }

    #[tokio::test]
    async fn clear_artifacts_cache_deletes_meta_and_media_roots() {
        let (_dir, paths) = temp_paths();
        fs::create_dir_all(paths.meta.join("20260521T121530123Z")).unwrap();
        fs::create_dir_all(
            paths
                .media
                .join("20260521T121530123Z/assets/project-images"),
        )
        .unwrap();
        fs::write(paths.meta.join("20260521T121530123Z/manifest.json"), b"{}").unwrap();
        fs::write(
            paths
                .media
                .join("20260521T121530123Z/assets/project-images/memory-01.webp"),
            b"asset",
        )
        .unwrap();

        clear_artifacts_cache_paths(&paths).await.unwrap();

        assert!(!paths.meta.exists());
        assert!(!paths.media.exists());
    }

    #[tokio::test]
    async fn clear_artifacts_cache_deletes_legacy_project_artifacts_root() {
        let dir = tempfile::tempdir().unwrap();
        let paths = cache_paths_for_root_with_legacy(
            dir.path().join("artifacts"),
            Some(dir.path().join("project-artifacts")),
        );
        let legacy_root = paths.legacy_root.as_ref().unwrap();
        fs::create_dir_all(legacy_root.join("media")).unwrap();
        fs::write(legacy_root.join("media/legacy.webp"), b"asset").unwrap();

        clear_artifacts_cache_paths(&paths).await.unwrap();

        assert!(!legacy_root.exists());
    }

    #[tokio::test]
    async fn clear_artifacts_cache_succeeds_when_roots_are_missing() {
        let (_dir, paths) = temp_paths();

        clear_artifacts_cache_paths(&paths).await.unwrap();

        assert!(!paths.meta.exists());
        assert!(!paths.media.exists());
    }
}
