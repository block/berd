use futures_util::{stream, StreamExt};
use reqwest::Url;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, SystemTime};
use tauri::{AppHandle, Manager};
use tokio::io::AsyncWriteExt;

const ARTIFACTORY_BASE: &str =
    "https://global.block-artifacts.com/artifactory/goose-internal/avatars/";
const LATEST_PATH: &str = "latest.json";
const MANIFEST_FILE: &str = "manifest.json";
const CATALOG_TTL: Duration = Duration::from_secs(7 * 24 * 60 * 60);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);
const DEFAULT_DOWNLOAD_CONCURRENCY: usize = 8;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AvatarLatest {
    pub catalog_version: String,
    pub manifest_path: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AvatarCatalog {
    pub schema_version: u8,
    pub catalog_version: String,
    pub collections: Vec<AvatarCollection>,
    pub assets: Vec<AvatarCatalogEntry>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AvatarCollection {
    pub id: String,
    pub label: String,
    pub cover_avatar_id: String,
    pub avatar_ids: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AvatarCatalogEntry {
    pub id: String,
    pub label: String,
    pub collection_id: String,
    pub variants: AvatarVariants,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct AvatarVariants {
    pub webm: Option<AvatarVariant>,
    pub hevc: Option<AvatarVariant>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AvatarVariant {
    pub path: String,
    pub mime_type: String,
    pub byte_size: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AvatarLibrarySnapshot {
    pub catalog: AvatarCatalog,
    pub cached_collections: Vec<CachedAvatarCollection>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedAvatarAsset {
    pub id: String,
    pub path: String,
    pub mime_type: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedAvatarCollection {
    pub catalog_version: String,
    pub collection_id: String,
    pub assets: Vec<CachedAvatarAsset>,
    pub failed_asset_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedAvatar {
    pub catalog_version: String,
    pub collection_id: String,
    pub asset: CachedAvatarAsset,
}

#[derive(Debug, Clone)]
struct AvatarCachePaths {
    meta: PathBuf,
    media: PathBuf,
}

fn platform_avatar_format() -> &'static str {
    if cfg!(target_os = "macos") {
        "hevc"
    } else {
        "webm"
    }
}

#[tauri::command]
pub async fn get_avatar_library_snapshot(app: AppHandle) -> Result<AvatarLibrarySnapshot, String> {
    let _cache_guard = avatar_cache_lock().lock().await;
    let paths = avatar_cache_paths(&app)?;
    clean_part_files(&paths)?;

    let catalog = match read_cached_catalog(&paths)? {
        Some(catalog) => {
            prune_obsolete_versions(&paths, &catalog.catalog_version)?;
            if is_catalog_cache_stale(&paths) {
                let refresh_paths = paths.clone();
                tauri::async_runtime::spawn(async move {
                    let _cache_guard = avatar_cache_lock().lock().await;
                    if let Err(error) = refresh_cached_catalog(&refresh_paths).await {
                        log::warn!("Failed to refresh avatar catalog cache: {error}");
                    }
                });
            }
            catalog
        }
        None => {
            let catalog = refresh_cached_catalog(&paths).await?;
            prune_obsolete_versions(&paths, &catalog.catalog_version)?;
            catalog
        }
    };

    let cached_collections = cached_collections_for_catalog(&paths, &catalog)?;
    Ok(AvatarLibrarySnapshot {
        catalog,
        cached_collections,
    })
}

#[tauri::command]
pub async fn get_cached_avatar_for_ref(
    app: AppHandle,
    avatar_ref: String,
) -> Result<Option<CachedAvatar>, String> {
    let _cache_guard = avatar_cache_lock().lock().await;
    let avatar_id = parse_avatar_ref(&avatar_ref)?;
    let paths = avatar_cache_paths(&app)?;
    let Some(catalog) = read_cached_catalog(&paths)? else {
        return Ok(None);
    };
    let Some(entry) = catalog.assets.iter().find(|entry| entry.id == avatar_id) else {
        return Ok(None);
    };
    let variant = variant_for_format(entry, platform_avatar_format())?;
    let target = media_cache_path(&paths, &catalog.catalog_version, &variant.path)?;
    let Some(asset) = valid_cached_asset(&paths, &catalog, entry, variant, &target)? else {
        return Ok(None);
    };
    let catalog_version = catalog.catalog_version.clone();
    let collection_id = entry.collection_id.clone();

    Ok(Some(CachedAvatar {
        catalog_version,
        collection_id,
        asset,
    }))
}

#[tauri::command]
pub async fn ensure_avatar_collection(
    app: AppHandle,
    catalog_version: String,
    collection_id: String,
) -> Result<CachedAvatarCollection, String> {
    let _cache_guard = avatar_cache_lock().lock().await;
    validate_safe_segment(&catalog_version)?;
    let paths = avatar_cache_paths(&app)?;
    clean_part_files(&paths)?;

    let catalog = catalog_for_requested_version(&paths, &catalog_version).await?;
    if catalog.catalog_version != catalog_version {
        return Err(format!(
            "Avatar catalog version conflict: requested {}, current {}",
            catalog_version, catalog.catalog_version
        ));
    }

    let collection = find_collection(&catalog, &collection_id)?;
    let (assets, failed_asset_ids) =
        ensure_collection_assets(&paths, &catalog, collection, platform_avatar_format()).await?;

    prune_obsolete_versions(&paths, &catalog.catalog_version)?;
    Ok(CachedAvatarCollection {
        catalog_version: catalog.catalog_version,
        collection_id,
        assets,
        failed_asset_ids,
    })
}

pub async fn clear_avatar_cache(app: AppHandle) -> Result<(), String> {
    let _cache_guard = avatar_cache_lock().lock().await;
    let paths = avatar_cache_paths(&app)?;
    clear_avatar_cache_paths(&paths).await
}

async fn clear_avatar_cache_paths(paths: &AvatarCachePaths) -> Result<(), String> {
    remove_dir_all_if_exists(&paths.meta, "avatar metadata").await?;
    remove_dir_all_if_exists(&paths.media, "avatar media").await
}

async fn current_catalog(paths: &AvatarCachePaths) -> Result<AvatarCatalog, String> {
    if let Some(catalog) = read_cached_catalog(paths)? {
        if !is_catalog_cache_stale(paths) {
            return Ok(catalog);
        }
    }

    refresh_cached_catalog(paths).await
}

async fn catalog_for_requested_version(
    paths: &AvatarCachePaths,
    catalog_version: &str,
) -> Result<AvatarCatalog, String> {
    match read_cached_catalog(paths)? {
        Some(catalog) if catalog.catalog_version == catalog_version => Ok(catalog),
        _ => current_catalog(paths).await,
    }
}

fn find_collection<'a>(
    catalog: &'a AvatarCatalog,
    collection_id: &str,
) -> Result<&'a AvatarCollection, String> {
    catalog
        .collections
        .iter()
        .find(|collection| collection.id == collection_id)
        .ok_or_else(|| "Avatar collection not found".to_string())
}

async fn refresh_cached_catalog(paths: &AvatarCachePaths) -> Result<AvatarCatalog, String> {
    let (latest, catalog) = fetch_current_catalog().await?;
    write_cached_catalog(paths, &latest, &catalog)?;
    Ok(catalog)
}

async fn fetch_current_catalog() -> Result<(AvatarLatest, AvatarCatalog), String> {
    let client = http_client()?;
    let latest: AvatarLatest = client
        .get(allowed_artifactory_url(LATEST_PATH)?)
        .send()
        .await
        .map_err(|error| format!("Failed to fetch avatar latest pointer: {error}"))?
        .error_for_status()
        .map_err(|error| format!("Avatar latest pointer returned an error: {error}"))?
        .json()
        .await
        .map_err(|error| format!("Failed to parse avatar latest pointer: {error}"))?;

    let manifest_path = manifest_path_for_latest(&latest)?;
    let catalog: AvatarCatalog = client
        .get(allowed_artifactory_url(&manifest_path)?)
        .send()
        .await
        .map_err(|error| format!("Failed to fetch avatar catalog: {error}"))?
        .error_for_status()
        .map_err(|error| format!("Avatar catalog returned an error: {error}"))?
        .json()
        .await
        .map_err(|error| format!("Failed to parse avatar catalog: {error}"))?;

    validate_catalog(&catalog)?;
    if catalog.catalog_version != latest.catalog_version {
        return Err("Avatar catalog version does not match latest pointer".to_string());
    }

    Ok((latest, catalog))
}

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|error| format!("Failed to create avatar HTTP client: {error}"))
}

fn avatar_cache_lock() -> &'static tokio::sync::Mutex<()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

fn read_cached_catalog(paths: &AvatarCachePaths) -> Result<Option<AvatarCatalog>, String> {
    let latest_path = paths.meta.join(LATEST_PATH);
    if !latest_path.exists() {
        return Ok(None);
    }

    let latest = match read_json_file::<AvatarLatest>(&latest_path) {
        Ok(latest) => latest,
        Err(error) => {
            delete_file_if_exists(&latest_path)?;
            log::warn!("Ignoring corrupt avatar latest cache: {error}");
            return Ok(None);
        }
    };
    let manifest_path = match manifest_path_for_latest(&latest) {
        Ok(path) => path,
        Err(error) => {
            delete_file_if_exists(&latest_path)?;
            log::warn!("Ignoring invalid avatar latest cache: {error}");
            return Ok(None);
        }
    };

    let catalog_path = paths.meta.join(manifest_path);
    if !catalog_path.exists() {
        return Ok(None);
    }

    let catalog = match read_json_file::<AvatarCatalog>(&catalog_path) {
        Ok(catalog) => catalog,
        Err(error) => {
            delete_file_if_exists(&catalog_path)?;
            log::warn!("Ignoring corrupt avatar manifest cache: {error}");
            return Ok(None);
        }
    };
    if let Err(error) = validate_catalog(&catalog) {
        delete_file_if_exists(&catalog_path)?;
        log::warn!("Ignoring invalid avatar manifest cache: {error}");
        return Ok(None);
    }
    if catalog.catalog_version != latest.catalog_version {
        delete_file_if_exists(&catalog_path)?;
        return Ok(None);
    }

    Ok(Some(catalog))
}

fn write_cached_catalog(
    paths: &AvatarCachePaths,
    latest: &AvatarLatest,
    catalog: &AvatarCatalog,
) -> Result<(), String> {
    validate_catalog(catalog)?;
    if latest.catalog_version != catalog.catalog_version {
        return Err("Avatar catalog version does not match latest pointer".to_string());
    }

    let manifest_path = manifest_path_for_latest(latest)?;
    let latest_json = serde_json::to_vec_pretty(latest)
        .map_err(|error| format!("Failed to serialize avatar latest pointer: {error}"))?;
    let catalog_json = serde_json::to_vec_pretty(catalog)
        .map_err(|error| format!("Failed to serialize avatar catalog: {error}"))?;
    let manifest_target = paths.meta.join(&manifest_path);

    atomic_write(&manifest_target, &catalog_json)?;
    atomic_write(&paths.meta.join(LATEST_PATH), &latest_json)?;
    Ok(())
}

fn manifest_path_for_latest(latest: &AvatarLatest) -> Result<String, String> {
    validate_safe_segment(&latest.catalog_version)?;
    let expected = format!("{}/{}", latest.catalog_version, MANIFEST_FILE);
    let manifest_path = latest
        .manifest_path
        .clone()
        .unwrap_or_else(|| expected.clone());
    validate_safe_relative_path(&manifest_path)?;
    if manifest_path != expected {
        return Err(
            "Avatar latest manifest path must match catalogVersion/manifest.json".to_string(),
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
    let parent = path
        .parent()
        .ok_or_else(|| "Avatar cache target has no parent".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Failed to create avatar cache directory: {error}"))?;
    let part_path = unique_part_path(path);
    {
        let mut file = fs::File::create(&part_path)
            .map_err(|error| format!("Failed to create avatar cache part file: {error}"))?;
        file.write_all(bytes)
            .map_err(|error| format!("Failed to write avatar cache part file: {error}"))?;
        file.sync_all()
            .map_err(|error| format!("Failed to sync avatar cache part file: {error}"))?;
    }
    fs::rename(&part_path, path).map_err(|error| {
        let _ = fs::remove_file(&part_path);
        format!("Failed to finalize avatar cache file: {error}")
    })
}

fn is_catalog_cache_stale(paths: &AvatarCachePaths) -> bool {
    let Ok(metadata) = fs::metadata(paths.meta.join(LATEST_PATH)) else {
        return true;
    };
    let Ok(modified_at) = metadata.modified() else {
        return true;
    };
    SystemTime::now()
        .duration_since(modified_at)
        .map_or(true, |age| age >= CATALOG_TTL)
}

async fn ensure_entry(
    client: &reqwest::Client,
    paths: &AvatarCachePaths,
    catalog: &AvatarCatalog,
    entry: &AvatarCatalogEntry,
    format: &str,
) -> Result<CachedAvatarAsset, String> {
    let variant = variant_for_format(entry, format)?;
    validate_variant_path(variant, format, &entry.collection_id)?;
    let target = media_cache_path(paths, &catalog.catalog_version, &variant.path)?;

    if let Some(asset) = valid_cached_asset(paths, catalog, entry, variant, &target)? {
        return Ok(asset);
    }
    delete_file_if_exists(&target)?;
    delete_file_if_exists(&checksum_marker_path(
        paths,
        &catalog.catalog_version,
        &variant.path,
    )?)?;

    let url = allowed_artifactory_url(&format!("{}/{}", catalog.catalog_version, variant.path))?;
    download_asset(client, url, &target, variant).await?;
    write_checksum_marker(paths, &catalog.catalog_version, variant)?;

    Ok(cached_asset(entry, variant, target))
}

async fn download_asset(
    client: &reqwest::Client,
    url: Url,
    target: &Path,
    variant: &AvatarVariant,
) -> Result<(), String> {
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|error| format!("Failed to download avatar asset: {error}"))?
        .error_for_status()
        .map_err(|error| format!("Avatar asset returned an error: {error}"))?;
    if let Some(content_length) = response.content_length() {
        if content_length != variant.byte_size {
            return Err("Avatar asset byte size did not match manifest".to_string());
        }
    }

    let parent = target
        .parent()
        .ok_or_else(|| "Avatar cache target has no parent".to_string())?;
    tokio::fs::create_dir_all(parent)
        .await
        .map_err(|error| format!("Failed to create avatar cache directory: {error}"))?;
    let part_path = unique_part_path(target);
    let mut file = tokio::fs::File::create(&part_path)
        .await
        .map_err(|error| format!("Failed to create avatar cache part file: {error}"))?;
    let mut part_file = PartFile::new(part_path);
    let mut stream = response.bytes_stream();
    let mut hasher = Sha256::new();
    let mut downloaded = 0_u64;

    while let Some(chunk) = stream.next().await {
        let chunk =
            chunk.map_err(|error| format!("Failed to read avatar asset response: {error}"))?;
        downloaded += chunk.len() as u64;
        if downloaded > variant.byte_size {
            return Err("Avatar asset byte size exceeded manifest".to_string());
        }
        hasher.update(&chunk);
        file.write_all(&chunk)
            .await
            .map_err(|error| format!("Failed to write avatar cache part file: {error}"))?;
    }
    file.flush()
        .await
        .map_err(|error| format!("Failed to flush avatar cache part file: {error}"))?;

    if downloaded != variant.byte_size {
        return Err("Avatar asset byte size did not match manifest".to_string());
    }
    let actual = hex_digest(hasher.finalize().as_slice());
    if actual != variant.sha256.to_ascii_lowercase() {
        return Err("Avatar asset checksum did not match manifest".to_string());
    }

    if let Err(error) = tokio::fs::rename(part_file.path(), target).await {
        return Err(format!("Failed to finalize avatar cache file: {error}"));
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
    paths: &AvatarCachePaths,
    catalog_version: &str,
    variant_path: &str,
) -> Result<PathBuf, String> {
    validate_safe_segment(catalog_version)?;
    validate_safe_relative_path(variant_path)?;
    Ok(paths
        .meta
        .join(catalog_version)
        .join(format!("{variant_path}.sha256")))
}

fn write_checksum_marker(
    paths: &AvatarCachePaths,
    catalog_version: &str,
    variant: &AvatarVariant,
) -> Result<(), String> {
    atomic_write(
        &checksum_marker_path(paths, catalog_version, &variant.path)?,
        variant.sha256.to_ascii_lowercase().as_bytes(),
    )
}

fn has_valid_checksum_marker(
    paths: &AvatarCachePaths,
    catalog_version: &str,
    variant: &AvatarVariant,
) -> Result<bool, String> {
    let marker_path = checksum_marker_path(paths, catalog_version, &variant.path)?;
    if !marker_path.exists() {
        return Ok(false);
    }
    let checksum = fs::read_to_string(&marker_path).map_err(|error| {
        format!(
            "Failed to read cached avatar checksum marker '{}': {error}",
            marker_path.display()
        )
    })?;
    Ok(checksum.trim().eq_ignore_ascii_case(&variant.sha256))
}

async fn ensure_collection_assets(
    paths: &AvatarCachePaths,
    catalog: &AvatarCatalog,
    collection: &AvatarCollection,
    format: &str,
) -> Result<(Vec<CachedAvatarAsset>, Vec<String>), String> {
    let client = http_client()?;
    let entries = collection
        .avatar_ids
        .iter()
        .map(|avatar_id| {
            catalog
                .assets
                .iter()
                .find(|entry| &entry.id == avatar_id)
                .ok_or_else(|| format!("Avatar asset not found: {avatar_id}"))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let client = Arc::new(client);
    let paths = Arc::new(paths.clone());
    let catalog = Arc::new(catalog.clone());
    let concurrency = avatar_download_concurrency();

    let results = stream::iter(entries.into_iter().cloned())
        .map(|entry| {
            let client = Arc::clone(&client);
            let paths = Arc::clone(&paths);
            let catalog = Arc::clone(&catalog);
            async move {
                let id = entry.id.clone();
                match ensure_entry(&client, &paths, &catalog, &entry, format).await {
                    Ok(asset) => Ok(asset),
                    Err(error) => {
                        log::warn!("Failed to ensure avatar asset '{id}': {error}");
                        Err(id)
                    }
                }
            }
        })
        .buffer_unordered(concurrency)
        .collect::<Vec<_>>()
        .await;
    let collection_order = collection_asset_order(collection);

    let mut assets = Vec::new();
    let mut failed_asset_ids = Vec::new();
    for result in results {
        match result {
            Ok(asset) => assets.push(asset),
            Err(id) => failed_asset_ids.push(id),
        }
    }
    assets.sort_by_key(|asset| collection_order.get(asset.id.as_str()).copied());
    failed_asset_ids.sort_by_key(|id| collection_order.get(id.as_str()).copied());

    Ok((assets, failed_asset_ids))
}

fn collection_asset_order(collection: &AvatarCollection) -> HashMap<&str, usize> {
    collection
        .avatar_ids
        .iter()
        .enumerate()
        .map(|(index, id)| (id.as_str(), index))
        .collect()
}

fn avatar_download_concurrency() -> usize {
    std::env::var("GOOSE_AVATAR_DOWNLOAD_CONCURRENCY")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(DEFAULT_DOWNLOAD_CONCURRENCY)
}

fn cached_collections_for_catalog(
    paths: &AvatarCachePaths,
    catalog: &AvatarCatalog,
) -> Result<Vec<CachedAvatarCollection>, String> {
    let mut cached_collections = Vec::new();
    for collection in &catalog.collections {
        if let Some(assets) =
            cached_collection_assets(paths, catalog, collection, platform_avatar_format())?
        {
            cached_collections.push(CachedAvatarCollection {
                catalog_version: catalog.catalog_version.clone(),
                collection_id: collection.id.clone(),
                assets,
                failed_asset_ids: Vec::new(),
            });
        }
    }
    Ok(cached_collections)
}

fn cached_collection_assets(
    paths: &AvatarCachePaths,
    catalog: &AvatarCatalog,
    collection: &AvatarCollection,
    format: &str,
) -> Result<Option<Vec<CachedAvatarAsset>>, String> {
    let mut assets = Vec::new();

    for avatar_id in &collection.avatar_ids {
        let entry = catalog
            .assets
            .iter()
            .find(|entry| &entry.id == avatar_id)
            .ok_or_else(|| format!("Avatar asset not found: {avatar_id}"))?;
        let Ok(variant) = variant_for_format(entry, format) else {
            return Ok(None);
        };
        validate_variant_path(variant, format, &entry.collection_id)?;
        let target = media_cache_path(paths, &catalog.catalog_version, &variant.path)?;
        let Some(asset) = valid_cached_asset(paths, catalog, entry, variant, &target)? else {
            delete_file_if_exists(&target)?;
            delete_file_if_exists(&checksum_marker_path(
                paths,
                &catalog.catalog_version,
                &variant.path,
            )?)?;
            return Ok(None);
        };
        assets.push(asset);
    }

    Ok(Some(assets))
}

fn valid_cached_asset(
    paths: &AvatarCachePaths,
    catalog: &AvatarCatalog,
    entry: &AvatarCatalogEntry,
    variant: &AvatarVariant,
    target: &Path,
) -> Result<Option<CachedAvatarAsset>, String> {
    if !target.exists() {
        return Ok(None);
    }

    let metadata = fs::metadata(target).map_err(|error| {
        format!(
            "Failed to inspect cached avatar '{}': {error}",
            target.display()
        )
    })?;
    if metadata.len() != variant.byte_size {
        return Ok(None);
    }
    if !has_valid_checksum_marker(paths, &catalog.catalog_version, variant)? {
        return Ok(None);
    }
    Ok(Some(cached_asset(entry, variant, target.to_path_buf())))
}

fn cached_asset(
    entry: &AvatarCatalogEntry,
    variant: &AvatarVariant,
    target: PathBuf,
) -> CachedAvatarAsset {
    CachedAvatarAsset {
        id: entry.id.clone(),
        path: target.to_string_lossy().into_owned(),
        mime_type: variant.mime_type.clone(),
    }
}

fn avatar_cache_paths(app: &AppHandle) -> Result<AvatarCachePaths, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Failed to resolve app data directory: {error}"))?;
    Ok(cache_paths_for_root(app_data_dir.join("avatars")))
}

fn cache_paths_for_root(root: PathBuf) -> AvatarCachePaths {
    AvatarCachePaths {
        meta: root.join("meta"),
        media: root.join("media"),
    }
}

fn variant_for_format<'a>(
    entry: &'a AvatarCatalogEntry,
    format: &str,
) -> Result<&'a AvatarVariant, String> {
    match format {
        "webm" => entry
            .variants
            .webm
            .as_ref()
            .ok_or_else(|| format!("Avatar '{}' does not have a WebM variant", entry.id)),
        "hevc" => entry
            .variants
            .hevc
            .as_ref()
            .ok_or_else(|| format!("Avatar '{}' does not have an HEVC variant", entry.id)),
        _ => Err("Unsupported avatar format".to_string()),
    }
}

fn allowed_artifactory_url(relative_path: &str) -> Result<Url, String> {
    validate_safe_relative_path(relative_path)?;
    let base = Url::parse(ARTIFACTORY_BASE).map_err(|error| error.to_string())?;
    let url = base
        .join(relative_path)
        .map_err(|error| format!("Invalid avatar artifact URL: {error}"))?;
    if !url.as_str().starts_with(ARTIFACTORY_BASE) {
        return Err("Avatar artifact URL is outside the allowed base".to_string());
    }
    Ok(url)
}

fn media_cache_path(
    paths: &AvatarCachePaths,
    catalog_version: &str,
    relative_path: &str,
) -> Result<PathBuf, String> {
    validate_safe_segment(catalog_version)?;
    validate_safe_relative_path(relative_path)?;
    Ok(paths.media.join(catalog_version).join(relative_path))
}

fn validate_catalog(catalog: &AvatarCatalog) -> Result<(), String> {
    if catalog.schema_version != 1 {
        return Err("Unsupported avatar catalog schema".to_string());
    }
    validate_safe_segment(&catalog.catalog_version)?;

    let mut asset_collections: HashMap<&str, &str> = HashMap::new();
    for entry in &catalog.assets {
        validate_avatar_id(&entry.id)?;
        validate_safe_segment(&entry.collection_id)?;
        let webm = entry.variants.webm.as_ref().ok_or_else(|| {
            "Avatar catalog entries must include both WebM and HEVC variants".to_string()
        })?;
        let hevc = entry.variants.hevc.as_ref().ok_or_else(|| {
            "Avatar catalog entries must include both WebM and HEVC variants".to_string()
        })?;
        validate_variant_path(webm, "webm", &entry.collection_id)?;
        validate_variant_path(hevc, "hevc", &entry.collection_id)?;
        if asset_collections
            .insert(entry.id.as_str(), entry.collection_id.as_str())
            .is_some()
        {
            return Err("Avatar catalog contains duplicate asset ids".to_string());
        }
    }

    let mut collection_ids = HashSet::new();
    for collection in &catalog.collections {
        validate_safe_segment(&collection.id)?;
        validate_avatar_id(&collection.cover_avatar_id)?;
        if !collection_ids.insert(collection.id.as_str()) {
            return Err("Avatar catalog contains duplicate collection ids".to_string());
        }
        if asset_collections.get(collection.cover_avatar_id.as_str())
            != Some(&collection.id.as_str())
        {
            return Err("Avatar collection cover does not match a collection asset".to_string());
        }
        let mut avatar_ids = HashSet::new();
        for avatar_id in &collection.avatar_ids {
            validate_avatar_id(avatar_id)?;
            if !avatar_ids.insert(avatar_id.as_str()) {
                return Err("Avatar collection contains duplicate avatar ids".to_string());
            }
            if asset_collections.get(avatar_id.as_str()) != Some(&collection.id.as_str()) {
                return Err("Avatar collection references an invalid asset".to_string());
            }
        }
    }

    Ok(())
}

fn validate_variant_path(
    variant: &AvatarVariant,
    format: &str,
    collection_id: &str,
) -> Result<(), String> {
    validate_safe_relative_path(&variant.path)?;
    let expected_prefix = format!("{format}/{collection_id}/");
    if !variant.path.starts_with(&expected_prefix) {
        return Err("Avatar variant path does not match its format and collection".to_string());
    }
    if !variant.sha256.chars().all(|c| c.is_ascii_hexdigit()) || variant.sha256.len() != 64 {
        return Err("Avatar variant checksum must be a SHA-256 hex digest".to_string());
    }
    Ok(())
}

#[cfg(test)]
fn validate_bytes(bytes: &[u8], variant: &AvatarVariant) -> Result<(), String> {
    if bytes.len() as u64 != variant.byte_size {
        return Err("Avatar asset byte size did not match manifest".to_string());
    }

    let digest = Sha256::digest(bytes);
    let actual = hex_digest(digest.as_slice());
    if actual != variant.sha256.to_ascii_lowercase() {
        return Err("Avatar asset checksum did not match manifest".to_string());
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
        return Err("Invalid avatar artifact path".to_string());
    }
    let path = Path::new(path);
    if path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err("Invalid avatar artifact path".to_string());
    }
    Ok(())
}

fn validate_safe_segment(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 64
        || value.chars().all(|c| c == '.')
        || !value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    {
        return Err("Invalid avatar path segment".to_string());
    }
    Ok(())
}

fn validate_avatar_id(value: &str) -> Result<(), String> {
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
        return Err("Invalid avatar id".to_string());
    }
    Ok(())
}

fn parse_avatar_ref(value: &str) -> Result<String, String> {
    let id = value
        .trim()
        .strip_prefix("app-avatar:")
        .ok_or_else(|| "Invalid app avatar reference".to_string())?;
    validate_avatar_id(id)?;
    Ok(id.to_string())
}

fn prune_obsolete_versions(paths: &AvatarCachePaths, current_version: &str) -> Result<(), String> {
    let previous_version = previous_version_to_keep(&paths.meta, current_version)?;
    for base in [&paths.meta, &paths.media] {
        if !base.exists() {
            continue;
        }
        for entry in fs::read_dir(base)
            .map_err(|error| format!("Failed to read avatar cache directory: {error}"))?
        {
            let entry =
                entry.map_err(|error| format!("Failed to inspect avatar cache entry: {error}"))?;
            if !entry
                .file_type()
                .map_err(|error| format!("Failed to inspect avatar cache file type: {error}"))?
                .is_dir()
            {
                continue;
            }
            let version = entry.file_name().to_string_lossy().into_owned();
            if version != current_version && Some(version.as_str()) != previous_version.as_deref() {
                fs::remove_dir_all(entry.path())
                    .map_err(|error| format!("Failed to prune obsolete avatar cache: {error}"))?;
            }
        }
    }

    Ok(())
}

fn previous_version_to_keep(
    meta_root: &Path,
    current_version: &str,
) -> Result<Option<String>, String> {
    if !meta_root.exists() {
        return Ok(None);
    }
    let mut versions = Vec::new();
    for entry in fs::read_dir(meta_root)
        .map_err(|error| format!("Failed to read avatar cache directory: {error}"))?
    {
        let entry =
            entry.map_err(|error| format!("Failed to inspect avatar cache entry: {error}"))?;
        if entry
            .file_type()
            .map_err(|error| format!("Failed to inspect avatar cache file type: {error}"))?
            .is_dir()
        {
            let version = entry.file_name().to_string_lossy().into_owned();
            if version != current_version {
                versions.push(version);
            }
        }
    }
    versions.sort();
    Ok(versions.pop())
}

fn clean_part_files(paths: &AvatarCachePaths) -> Result<(), String> {
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
        .map_err(|error| format!("Failed to read avatar cache directory: {error}"))?
    {
        let entry =
            entry.map_err(|error| format!("Failed to inspect avatar cache entry: {error}"))?;
        let path = entry.path();
        let file_type = entry
            .file_type()
            .map_err(|error| format!("Failed to inspect avatar cache file type: {error}"))?;
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
        Err(error) => Err(format!("Failed to delete avatar cache file: {error}")),
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

    fn variant(path: &str, bytes: &[u8]) -> AvatarVariant {
        let digest = Sha256::digest(bytes);
        AvatarVariant {
            path: path.to_string(),
            mime_type: if path.ends_with(".mp4") {
                "video/mp4".to_string()
            } else {
                "video/webm".to_string()
            },
            byte_size: bytes.len() as u64,
            sha256: hex_digest(digest.as_slice()),
        }
    }

    fn valid_catalog(bytes: &[u8]) -> AvatarCatalog {
        AvatarCatalog {
            schema_version: 1,
            catalog_version: "v1".to_string(),
            collections: vec![AvatarCollection {
                id: "gloopies".to_string(),
                label: "Gloopies".to_string(),
                cover_avatar_id: "gloopy-1".to_string(),
                avatar_ids: vec!["gloopy-1".to_string()],
            }],
            assets: vec![AvatarCatalogEntry {
                id: "gloopy-1".to_string(),
                label: "Gloopy 1".to_string(),
                collection_id: "gloopies".to_string(),
                variants: AvatarVariants {
                    webm: Some(variant("webm/gloopies/gloopy-1.webm", bytes)),
                    hevc: Some(variant("hevc/gloopies/gloopy-1.mp4", bytes)),
                },
            }],
        }
    }

    fn write_valid_catalog(paths: &AvatarCachePaths, catalog: &AvatarCatalog) {
        let latest = AvatarLatest {
            catalog_version: catalog.catalog_version.clone(),
            manifest_path: Some(format!("{}/manifest.json", catalog.catalog_version)),
        };
        write_cached_catalog(paths, &latest, catalog).unwrap();
    }

    fn temp_paths() -> (tempfile::TempDir, AvatarCachePaths) {
        let dir = tempfile::tempdir().unwrap();
        let paths = cache_paths_for_root(dir.path().join("avatars"));
        (dir, paths)
    }

    fn webm_variant(catalog: &AvatarCatalog) -> &AvatarVariant {
        catalog.assets[0].variants.webm.as_ref().unwrap()
    }

    fn cached_webm_target(paths: &AvatarCachePaths, catalog: &AvatarCatalog) -> PathBuf {
        media_cache_path(paths, &catalog.catalog_version, &webm_variant(catalog).path).unwrap()
    }

    fn write_cached_webm(
        paths: &AvatarCachePaths,
        catalog: &AvatarCatalog,
        bytes: &[u8],
    ) -> PathBuf {
        let target = cached_webm_target(paths, catalog);
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        fs::write(&target, bytes).unwrap();
        target
    }

    fn write_webm_checksum_marker(paths: &AvatarCachePaths, catalog: &AvatarCatalog) {
        write_checksum_marker(paths, &catalog.catalog_version, webm_variant(catalog)).unwrap();
    }

    fn add_second_avatar(catalog: &mut AvatarCatalog, webm_variant: AvatarVariant) {
        catalog.collections[0]
            .avatar_ids
            .push("gloopy-2".to_string());
        catalog.assets.push(AvatarCatalogEntry {
            id: "gloopy-2".to_string(),
            label: "Gloopy 2".to_string(),
            collection_id: "gloopies".to_string(),
            variants: AvatarVariants {
                webm: Some(webm_variant),
                hevc: Some(variant("hevc/gloopies/gloopy-2.mp4", b"other")),
            },
        });
    }

    #[test]
    fn artifactory_urls_are_allowlisted() {
        let url = allowed_artifactory_url("v1/manifest.json").unwrap();
        assert_eq!(
            url.as_str(),
            "https://global.block-artifacts.com/artifactory/goose-internal/avatars/v1/manifest.json"
        );
        assert!(allowed_artifactory_url("../manifest.json").is_err());
        assert!(allowed_artifactory_url("https://example.com/file").is_err());
    }

    #[test]
    fn media_cache_paths_reject_traversal_and_point_under_media() {
        let paths = cache_paths_for_root(PathBuf::from("/tmp/avatars"));
        let path = media_cache_path(&paths, "v1", "webm/gloopies/gloopy-1.webm").unwrap();
        assert_eq!(path, paths.media.join("v1/webm/gloopies/gloopy-1.webm"));
        assert!(path.starts_with(&paths.media));
        assert!(!path.starts_with(&paths.meta));
        assert!(media_cache_path(&paths, "v1", "webm/../secret").is_err());
        assert!(media_cache_path(&paths, "../v1", "webm/gloopies/gloopy-1.webm").is_err());
        assert!(media_cache_path(&paths, ".", "webm/gloopies/gloopy-1.webm").is_err());
    }

    #[test]
    fn checksum_and_byte_size_are_validated() {
        let bytes = b"avatar-bytes";
        let valid = variant("webm/gloopies/gloopy-1.webm", bytes);
        assert!(validate_bytes(bytes, &valid).is_ok());

        let mut bad_size = valid.clone();
        bad_size.byte_size += 1;
        assert!(validate_bytes(bytes, &bad_size).is_err());

        let mut bad_hash = valid;
        bad_hash.sha256 = "0".repeat(64);
        assert!(validate_bytes(bytes, &bad_hash).is_err());
    }

    #[test]
    fn manifest_path_must_match_catalog_version_manifest() {
        assert_eq!(
            manifest_path_for_latest(&AvatarLatest {
                catalog_version: "20260521T121530123Z".to_string(),
                manifest_path: Some("20260521T121530123Z/manifest.json".to_string()),
            })
            .unwrap(),
            "20260521T121530123Z/manifest.json"
        );
        assert!(manifest_path_for_latest(&AvatarLatest {
            catalog_version: "v1".to_string(),
            manifest_path: Some("manifest.json".to_string()),
        })
        .is_err());
        assert!(manifest_path_for_latest(&AvatarLatest {
            catalog_version: "v1".to_string(),
            manifest_path: Some("v2/manifest.json".to_string()),
        })
        .is_err());
    }

    #[test]
    fn catalog_integrity_requires_both_variants() {
        let bytes = b"avatar-bytes";
        assert!(validate_catalog(&valid_catalog(bytes)).is_ok());

        let cases: &[(&str, fn(&mut AvatarCatalog))] = &[
            ("missing hevc variant", |catalog| {
                catalog.assets[0].variants.hevc = None
            }),
            ("missing webm variant", |catalog| {
                catalog.assets[0].variants.webm = None
            }),
            ("invalid collection reference", |catalog| {
                catalog.collections[0].avatar_ids = vec!["missing-avatar".to_string()];
            }),
        ];

        for (case, mutate) in cases {
            let mut catalog = valid_catalog(bytes);
            mutate(&mut catalog);
            assert!(validate_catalog(&catalog).is_err(), "{case}");
        }
    }

    #[test]
    fn corrupt_cached_latest_or_manifest_is_deleted() {
        let (_dir, paths) = temp_paths();
        fs::create_dir_all(&paths.meta).unwrap();
        fs::write(paths.meta.join(LATEST_PATH), b"{").unwrap();
        assert!(read_cached_catalog(&paths).unwrap().is_none());
        assert!(!paths.meta.join(LATEST_PATH).exists());

        let catalog = valid_catalog(b"avatar-bytes");
        let latest = AvatarLatest {
            catalog_version: "v1".to_string(),
            manifest_path: Some("v1/manifest.json".to_string()),
        };
        atomic_write(
            &paths.meta.join("latest.json"),
            serde_json::to_vec(&latest).unwrap().as_slice(),
        )
        .unwrap();
        fs::create_dir_all(paths.meta.join("v1")).unwrap();
        fs::write(paths.meta.join("v1/manifest.json"), b"{").unwrap();
        assert!(read_cached_catalog(&paths).unwrap().is_none());
        assert!(!paths.meta.join("v1/manifest.json").exists());

        write_valid_catalog(&paths, &catalog);
        assert!(read_cached_catalog(&paths).unwrap().is_some());
    }

    #[test]
    fn cached_collection_assets_require_valid_checksum_marker_and_bytes() {
        let bytes = b"avatar-bytes";
        let catalog = valid_catalog(bytes);
        let collection = &catalog.collections[0];
        let (_dir, paths) = temp_paths();
        let target = write_cached_webm(&paths, &catalog, bytes);

        assert!(
            cached_collection_assets(&paths, &catalog, collection, "webm")
                .unwrap()
                .is_none()
        );
        assert!(!target.exists());

        let target = write_cached_webm(&paths, &catalog, b"avatar-bytes-plus");
        write_webm_checksum_marker(&paths, &catalog);
        assert!(
            cached_collection_assets(&paths, &catalog, collection, "webm")
                .unwrap()
                .is_none()
        );
        assert!(!target.exists());

        let target = write_cached_webm(&paths, &catalog, bytes);
        write_webm_checksum_marker(&paths, &catalog);
        let assets = cached_collection_assets(&paths, &catalog, collection, "webm")
            .unwrap()
            .unwrap();
        assert_eq!(assets[0].path, target.to_string_lossy());
        assert!(Path::new(&assets[0].path).starts_with(&paths.media));
    }

    #[test]
    fn single_cached_avatar_does_not_require_whole_collection() {
        let bytes = b"avatar-bytes";
        let mut catalog = valid_catalog(bytes);
        add_second_avatar(
            &mut catalog,
            variant("webm/gloopies/gloopy-2.webm", b"other"),
        );
        let (_dir, paths) = temp_paths();
        let entry = &catalog.assets[0];
        let variant = webm_variant(&catalog);
        let target = write_cached_webm(&paths, &catalog, bytes);
        write_webm_checksum_marker(&paths, &catalog);

        assert!(
            cached_collection_assets(&paths, &catalog, &catalog.collections[0], "webm")
                .unwrap()
                .is_none()
        );
        assert_eq!(
            valid_cached_asset(&paths, &catalog, entry, variant, &target)
                .unwrap()
                .unwrap()
                .id,
            "gloopy-1"
        );
    }

    #[tokio::test]
    async fn requested_version_prefers_matching_cached_catalog() {
        let catalog = valid_catalog(b"avatar-bytes");
        let (_dir, paths) = temp_paths();
        write_valid_catalog(&paths, &catalog);

        let resolved = catalog_for_requested_version(&paths, "v1").await.unwrap();

        assert_eq!(resolved.catalog_version, "v1");
    }

    #[tokio::test]
    async fn collection_ensure_returns_partial_failures() {
        let bytes = b"avatar-bytes";
        let mut catalog = valid_catalog(bytes);
        add_second_avatar(
            &mut catalog,
            AvatarVariant {
                path: "webm/gloopies/gloopy-2.webm".to_string(),
                mime_type: "video/webm".to_string(),
                byte_size: 7,
                sha256: "not-a-sha".to_string(),
            },
        );
        let (_dir, paths) = temp_paths();
        write_cached_webm(&paths, &catalog, bytes);
        write_webm_checksum_marker(&paths, &catalog);

        let (assets, failed) =
            ensure_collection_assets(&paths, &catalog, &catalog.collections[0], "webm")
                .await
                .unwrap();
        assert_eq!(
            assets
                .iter()
                .map(|asset| asset.id.as_str())
                .collect::<Vec<_>>(),
            vec!["gloopy-1"]
        );
        assert_eq!(failed, vec!["gloopy-2"]);
    }

    #[tokio::test]
    async fn streaming_download_stops_when_bytes_exceed_manifest_size() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            socket
                .write_all(
                    b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n4\r\nabcd\r\n4\r\nefgh\r\n0\r\n\r\n",
                )
                .await
                .unwrap();
        });
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("media/v1/webm/gloopies/gloopy-1.webm");
        let variant = variant("webm/gloopies/gloopy-1.webm", b"abcd");
        let error = download_asset(
            &http_client().unwrap(),
            Url::parse(&format!("http://{addr}/avatar.webm")).unwrap(),
            &target,
            &variant,
        )
        .await
        .unwrap_err();

        server.await.unwrap();
        assert!(error.contains("exceeded"));
        assert!(!target.exists());
        assert_eq!(fs::read_dir(target.parent().unwrap()).unwrap().count(), 0);
    }

    #[test]
    fn prunes_obsolete_versions_but_keeps_current_plus_previous() {
        let (_dir, paths) = temp_paths();
        for base in [&paths.meta, &paths.media] {
            fs::create_dir_all(base.join("v1")).unwrap();
            fs::create_dir_all(base.join("v2")).unwrap();
            fs::create_dir_all(base.join("v3")).unwrap();
        }
        prune_obsolete_versions(&paths, "v3").unwrap();
        assert!(!paths.meta.join("v1").exists());
        assert!(paths.meta.join("v2").exists());
        assert!(paths.meta.join("v3").exists());
        assert!(!paths.media.join("v1").exists());
        assert!(paths.media.join("v2").exists());
        assert!(paths.media.join("v3").exists());
    }

    #[test]
    fn atomic_write_uses_part_then_final_path() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("meta/v1/manifest.json");
        atomic_write(&target, br#"{"ok":true}"#).unwrap();
        assert_eq!(fs::read(&target).unwrap(), br#"{"ok":true}"#);
        let part_files = fs::read_dir(target.parent().unwrap())
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().ends_with(".part"))
            .count();
        assert_eq!(part_files, 0);
    }

    #[test]
    fn download_concurrency_defaults_to_eight() {
        std::env::remove_var("GOOSE_AVATAR_DOWNLOAD_CONCURRENCY");
        assert_eq!(avatar_download_concurrency(), 8);
        std::env::set_var("GOOSE_AVATAR_DOWNLOAD_CONCURRENCY", "2");
        assert_eq!(avatar_download_concurrency(), 2);
        std::env::set_var("GOOSE_AVATAR_DOWNLOAD_CONCURRENCY", "0");
        assert_eq!(avatar_download_concurrency(), 8);
        std::env::remove_var("GOOSE_AVATAR_DOWNLOAD_CONCURRENCY");
    }

    #[tokio::test]
    async fn clear_avatar_cache_deletes_meta_and_media_roots() {
        let (_dir, paths) = temp_paths();
        fs::create_dir_all(paths.meta.join("v1")).unwrap();
        fs::create_dir_all(paths.media.join("v1/webm/gloopies")).unwrap();
        fs::write(paths.meta.join("v1/manifest.json"), b"{}").unwrap();
        fs::write(
            paths.media.join("v1/webm/gloopies/gloopy-1.webm"),
            b"avatar",
        )
        .unwrap();

        clear_avatar_cache_paths(&paths).await.unwrap();

        assert!(!paths.meta.exists());
        assert!(!paths.media.exists());
    }

    #[tokio::test]
    async fn clear_avatar_cache_succeeds_when_roots_are_missing() {
        let (_dir, paths) = temp_paths();

        clear_avatar_cache_paths(&paths).await.unwrap();

        assert!(!paths.meta.exists());
        assert!(!paths.media.exists());
    }
}
