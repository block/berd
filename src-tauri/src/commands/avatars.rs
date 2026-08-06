use futures_util::{stream, StreamExt};
use reqwest::{StatusCode, Url};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeSet, HashMap, HashSet};
use std::fs;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, SystemTime};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::AsyncWriteExt;
use tokio::sync::broadcast;
use uuid::Uuid;

const AVATAR_CDN_BASE: &str = "https://dwwgwmfqqjotj.cloudfront.net/avatars/";
const APP_AVATAR_REF_PREFIX: &str = "app-avatar:";
const USER_AVATAR_REF_PREFIX: &str = "user-avatar:";
const USER_AVATAR_CATALOG_VERSION: &str = "user-generated";
const USER_AVATAR_COLLECTION_ID: &str = "generated-gloopies";
const AVATAR_CACHE_WARMED_EVENT: &str = "berd:avatar-cache-warmed";
const LATEST_PATH: &str = "latest.json";
const MANIFEST_FILE: &str = "manifest.json";
const CATALOG_TTL: Duration = Duration::from_secs(24 * 60 * 60);
const METADATA_CONNECT_TIMEOUT: Duration = Duration::from_secs(3);
const METADATA_REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
const ASSET_CONNECT_TIMEOUT: Duration = Duration::from_secs(3);
const ASSET_DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(60);
const AVATAR_WARM_RETRY_DELAY: Duration = Duration::from_secs(5);
const DEFAULT_DOWNLOAD_CONCURRENCY: usize = 8;
// A `.part` file older than this is treated as an orphan left behind by a
// crashed process and is safe to delete. It must comfortably exceed the longest
// a live download can run (connect + download timeout) so cleanup never removes
// a part file that an in-flight download — which no longer holds any lock — is
// still actively writing.
const PART_FILE_STALE_AGE: Duration = Duration::from_secs(5 * 60);

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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub poster: Option<AvatarVariant>,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub alpha_mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub poster_path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedAvatarCollection {
    pub catalog_version: String,
    pub collection_id: String,
    pub assets: Vec<CachedAvatarAsset>,
    pub failed_asset_ids: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_code: Option<AvatarErrorCode>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedAvatar {
    pub catalog_version: String,
    pub collection_id: String,
    pub asset: CachedAvatarAsset,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AvatarCacheWarmedPayload {
    avatar_refs: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AvatarCommandError {
    code: AvatarErrorCode,
    message: String,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AvatarErrorCode {
    NetworkAccess,
    Unavailable,
}

type AvatarCommandResult<T> = Result<T, AvatarCommandError>;

impl AvatarCommandError {
    fn network_access(raw: impl AsRef<str>) -> Self {
        log::warn!("Avatar library network access error: {}", raw.as_ref());
        Self {
            code: AvatarErrorCode::NetworkAccess,
            message: "Unable to load avatar library. Check your network connection and try again."
                .to_string(),
        }
    }

    fn unavailable(raw: impl AsRef<str>) -> Self {
        log::warn!("Avatar library unavailable: {}", raw.as_ref());
        Self {
            code: AvatarErrorCode::Unavailable,
            message: "Avatar library unavailable. Try again.".to_string(),
        }
    }
}

impl From<String> for AvatarCommandError {
    fn from(error: String) -> Self {
        AvatarCommandError::unavailable(error)
    }
}

impl std::fmt::Display for AvatarCommandError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

#[derive(Debug, Clone)]
struct AvatarAssetError {
    code: AvatarErrorCode,
    detail: String,
}

impl AvatarAssetError {
    fn unavailable(detail: impl Into<String>) -> Self {
        Self {
            code: AvatarErrorCode::Unavailable,
            detail: detail.into(),
        }
    }

    fn request(label: &str, error: reqwest::Error) -> Self {
        let code = if error.is_timeout() || error.is_connect() || error.is_redirect() {
            AvatarErrorCode::NetworkAccess
        } else {
            AvatarErrorCode::Unavailable
        };
        Self {
            code,
            detail: format!("{label}: {error}"),
        }
    }

    fn status(label: &str, status: StatusCode) -> Self {
        Self::unavailable(format!("{label}: HTTP status {status}"))
    }
}

impl From<String> for AvatarAssetError {
    fn from(detail: String) -> Self {
        AvatarAssetError::unavailable(detail)
    }
}

impl std::fmt::Display for AvatarAssetError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.detail)
    }
}

#[derive(Debug, Clone)]
struct AvatarCachePaths {
    meta: PathBuf,
    media: PathBuf,
}

#[derive(Debug, Clone)]
struct UserAvatarPaths {
    meta: PathBuf,
    media: PathBuf,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct UserAvatarManifest {
    id: String,
    path: String,
    mime_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    alpha_mode: Option<String>,
    byte_size: u64,
    created_at_ms: u128,
}

fn platform_avatar_format() -> &'static str {
    if cfg!(target_os = "macos") {
        "hevc"
    } else {
        "webm"
    }
}

#[tauri::command]
pub async fn get_avatar_library_snapshot(
    app: AppHandle,
) -> AvatarCommandResult<AvatarLibrarySnapshot> {
    let paths = avatar_cache_paths(&app)?;

    let catalog = {
        let _catalog_guard = catalog_lock().lock().await;
        clean_part_files(&paths)?;

        match read_cached_catalog(&paths)? {
            Some(catalog) => {
                prune_obsolete_versions(&paths, &catalog.catalog_version)?;
                if is_catalog_cache_stale(&paths) {
                    let refresh_paths = paths.clone();
                    tauri::async_runtime::spawn(async move {
                        let _catalog_guard = catalog_lock().lock().await;
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
        }
    };

    // Reading cached collections only inspects atomically-placed files, so it
    // does not need the catalog lock.
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
    // No lock needed: reads immutable, atomically placed media blobs.
    if let Some(avatar_id) = parse_user_avatar_ref(&avatar_ref)? {
        return cached_user_avatar_for_id(&app, &avatar_id);
    }

    let avatar_id = parse_app_avatar_ref(&avatar_ref)?;
    let paths = avatar_cache_paths(&app)?;
    let Some(catalog) = read_cached_catalog(&paths)? else {
        return Ok(None);
    };
    if let Some(avatar) = cached_avatar_for_id(&paths, &catalog, &avatar_id)? {
        return Ok(Some(avatar));
    }

    let _catalog_guard = catalog_lock().lock().await;
    prepare_legacy_media(&paths, &catalog.catalog_version)?;
    cached_avatar_for_id(&paths, &catalog, &avatar_id)
}

#[tauri::command]
pub async fn delete_user_avatar(app: AppHandle, avatar_ref: String) -> Result<(), String> {
    delete_user_avatar_by_ref(&app, &avatar_ref)
}

/// Synchronous delete for backend callers that need to clean up their own
/// partially written avatars (for example, when a multi-option generation
/// fails after some options were already persisted).
pub(crate) fn delete_user_avatar_by_ref(app: &AppHandle, avatar_ref: &str) -> Result<(), String> {
    let paths = user_avatar_paths(app)?;
    delete_user_avatar_at(&paths, avatar_ref)
}

/// Deletes a generated avatar's media and manifest.
///
/// Deleting an avatar that is already gone is a success: callers clean up
/// abandoned generations best-effort and must not fail on a double delete.
fn delete_user_avatar_at(paths: &UserAvatarPaths, avatar_ref: &str) -> Result<(), String> {
    let avatar_id = parse_user_avatar_ref(avatar_ref)?
        .ok_or_else(|| "Invalid user avatar reference".to_string())?;
    let manifest_path = paths.meta.join(format!("{avatar_id}.json"));
    if !manifest_path.exists() {
        return Ok(());
    }

    let manifest = read_user_avatar_manifest(paths, &avatar_id)?;
    let media_path = user_avatar_media_path(paths, &manifest)?;
    delete_file_if_exists(&media_path)?;
    delete_file_if_exists(&manifest_path)
}

#[tauri::command]
pub async fn get_cached_avatars_for_refs(
    app: AppHandle,
    avatar_refs: Vec<String>,
) -> Result<HashMap<String, Option<CachedAvatar>>, String> {
    if avatar_refs.is_empty() {
        return Ok(HashMap::new());
    }

    let mut parsed_refs = Vec::with_capacity(avatar_refs.len());
    let mut resolved = HashMap::new();
    for avatar_ref in avatar_refs {
        match parse_user_avatar_ref(&avatar_ref) {
            Ok(Some(avatar_id)) => {
                resolved.insert(
                    avatar_ref,
                    cached_user_avatar_for_id(&app, &avatar_id).unwrap_or(None),
                );
            }
            Ok(None) => {
                let avatar_id = parse_app_avatar_ref(&avatar_ref).ok();
                parsed_refs.push((avatar_ref, avatar_id));
            }
            Err(_) => {
                resolved.insert(avatar_ref, None);
            }
        }
    }

    // No lock needed: reads immutable, atomically placed media blobs.
    let paths = avatar_cache_paths(&app)?;
    let Some(catalog) = read_cached_catalog(&paths)? else {
        resolved.extend(
            parsed_refs
                .into_iter()
                .map(|(avatar_ref, _)| (avatar_ref, None)),
        );
        return Ok(resolved);
    };

    let format = platform_avatar_format();
    let mut cached =
        cached_avatars_for_parsed_refs_with_format(&paths, &catalog, parsed_refs.clone(), format)?;
    let unresolved = parsed_refs
        .into_iter()
        .filter(|(avatar_ref, avatar_id)| {
            avatar_id.is_some() && cached.get(avatar_ref).is_some_and(Option::is_none)
        })
        .collect::<Vec<_>>();
    if !unresolved.is_empty() {
        let _catalog_guard = catalog_lock().lock().await;
        prepare_legacy_media(&paths, &catalog.catalog_version)?;
        cached.extend(cached_avatars_for_parsed_refs_with_format(
            &paths, &catalog, unresolved, format,
        )?);
    }
    resolved.extend(cached);
    Ok(resolved)
}

fn cached_avatar_for_id(
    paths: &AvatarCachePaths,
    catalog: &AvatarCatalog,
    avatar_id: &str,
) -> Result<Option<CachedAvatar>, String> {
    cached_avatar_for_id_with_format(paths, catalog, avatar_id, platform_avatar_format())
}

fn cached_avatars_for_parsed_refs_with_format(
    paths: &AvatarCachePaths,
    catalog: &AvatarCatalog,
    parsed_refs: Vec<(String, Option<String>)>,
    format: &str,
) -> Result<HashMap<String, Option<CachedAvatar>>, String> {
    let mut cached_by_id = HashMap::new();
    for avatar_id in parsed_refs
        .iter()
        .filter_map(|(_, avatar_id)| avatar_id.as_ref())
    {
        if cached_by_id.contains_key(avatar_id) {
            continue;
        }
        cached_by_id.insert(
            avatar_id.clone(),
            cached_avatar_for_id_with_format(paths, catalog, avatar_id, format)?,
        );
    }

    Ok(parsed_refs
        .into_iter()
        .map(|(avatar_ref, avatar_id)| {
            (
                avatar_ref,
                avatar_id
                    .and_then(|avatar_id| cached_by_id.get(&avatar_id).cloned())
                    .unwrap_or(None),
            )
        })
        .collect())
}

fn cached_avatar_for_id_with_format(
    paths: &AvatarCachePaths,
    catalog: &AvatarCatalog,
    avatar_id: &str,
    format: &str,
) -> Result<Option<CachedAvatar>, String> {
    let Some(entry) = catalog.assets.iter().find(|entry| entry.id == avatar_id) else {
        return Ok(None);
    };
    let poster = cached_poster_asset(paths, entry)?;
    let variant = variant_for_format(entry, format)?;
    let target = media_blob_path(paths, variant)?;
    let asset = match valid_cached_asset(entry, variant, &target)? {
        Some(mut asset) => {
            asset.poster_path = poster.as_ref().map(|poster| poster.path.clone());
            asset
        }
        None => match poster {
            Some(poster) => poster,
            None => return Ok(None),
        },
    };
    let catalog_version = catalog.catalog_version.clone();
    let collection_id = entry.collection_id.clone();

    Ok(Some(CachedAvatar {
        catalog_version,
        collection_id,
        asset,
    }))
}

fn cached_poster_asset(
    paths: &AvatarCachePaths,
    entry: &AvatarCatalogEntry,
) -> Result<Option<CachedAvatarAsset>, String> {
    let Some(poster) = entry.variants.poster.as_ref() else {
        return Ok(None);
    };
    let target = media_blob_path(paths, poster)?;
    valid_cached_asset(entry, poster, &target)
}

#[tauri::command]
pub async fn ensure_avatar_collection(
    app: AppHandle,
    catalog_version: String,
    collection_id: String,
) -> AvatarCommandResult<CachedAvatarCollection> {
    validate_safe_segment(&catalog_version)?;
    let paths = avatar_cache_paths(&app)?;

    // Hold catalog lock only for metadata operations.
    let catalog = {
        let _catalog_guard = catalog_lock().lock().await;
        clean_part_files(&paths)?;

        let catalog = catalog_for_requested_version(&paths, &catalog_version).await?;
        if catalog.catalog_version != catalog_version {
            return Err(format!(
                "Avatar catalog version conflict: requested {}, current {}",
                catalog_version, catalog.catalog_version
            )
            .into());
        }

        // Migrate verified legacy media before deciding which assets need downloads.
        prepare_legacy_media(&paths, &catalog.catalog_version)?;
        find_collection(&catalog, &collection_id)?;
        catalog
    };

    // Downloads happen outside the catalog lock, using per-asset dedup.
    let collection = find_collection(&catalog, &collection_id)?;
    let (assets, failed_asset_ids, error_code) =
        ensure_collection_assets(&paths, &catalog, collection, platform_avatar_format()).await?;

    // Brief lock for pruning.
    {
        let _catalog_guard = catalog_lock().lock().await;
        prune_obsolete_versions(&paths, &catalog.catalog_version)?;
    }

    Ok(CachedAvatarCollection {
        catalog_version: catalog.catalog_version,
        collection_id,
        assets,
        failed_asset_ids,
        error_code,
    })
}

pub async fn clear_avatar_cache(app: AppHandle) -> Result<(), String> {
    // The catalog lock serializes against metadata writes and pruning. The
    // exclusive download guard is what makes the clear wait for in-flight
    // downloads to finish — and blocks new ones from starting — since downloads
    // no longer hold the catalog lock. Without it, a download could place its
    // media blob right after we wiped the cache dirs, leaving an orphan behind
    // while the clear reported success.
    let _catalog_guard = catalog_lock().lock().await;
    let _download_guard = download_guard().write().await;
    let paths = avatar_cache_paths(&app)?;
    clear_avatar_cache_paths(&paths).await
}

pub async fn warm_avatar_refs(app: AppHandle, avatar_refs: Vec<String>) -> Result<usize, String> {
    let avatar_ids = avatar_refs
        .iter()
        .filter_map(|avatar_ref| parse_app_avatar_ref(avatar_ref).ok())
        .collect::<BTreeSet<_>>();
    if avatar_ids.is_empty() {
        return Ok(0);
    }

    let paths = avatar_cache_paths(&app)?;

    // Hold catalog lock only for metadata resolution.
    let catalog = {
        let _catalog_guard = catalog_lock().lock().await;
        clean_part_files(&paths)?;
        let mut catalog = current_catalog(&paths)
            .await
            .map_err(|error| error.to_string())?;
        if catalog_needs_refresh_for_avatar_ids(&catalog, &avatar_ids) {
            match refresh_cached_catalog(&paths).await {
                Ok(refreshed) => catalog = refreshed,
                Err(error) => {
                    log::warn!(
                        "Failed to refresh avatar catalog for agent avatar warm-up: {error}"
                    );
                }
            }
        }
        // Reuse verified legacy bytes before any network-backed warm-up.
        prepare_legacy_media(&paths, &catalog.catalog_version)?;
        catalog
    };

    // Downloads happen outside the catalog lock, using per-asset dedup.
    let client = asset_http_client()?;
    let format = platform_avatar_format();
    let mut warmed = 0usize;
    let mut warmed_avatar_refs = Vec::new();
    let mut incomplete_avatar_refs = Vec::new();

    for avatar_id in avatar_ids {
        let Some(entry) = catalog.assets.iter().find(|entry| entry.id == avatar_id) else {
            log::warn!("Agent avatar '{avatar_id}' was not found in the avatar catalog");
            continue;
        };
        match ensure_avatar_media(&client, &paths, &catalog, entry, format).await {
            Ok((_, partial_error_code)) => {
                let avatar_ref = format!("app-avatar:{avatar_id}");
                warmed += 1;
                warmed_avatar_refs.push(avatar_ref.clone());
                if partial_error_code.is_some() || entry.variants.poster.is_none() {
                    incomplete_avatar_refs.push(avatar_ref);
                }
            }
            Err(error) => log::warn!("Failed to warm agent avatar '{avatar_id}': {error}"),
        }
    }

    if !warmed_avatar_refs.is_empty() {
        let payload = AvatarCacheWarmedPayload {
            avatar_refs: warmed_avatar_refs,
        };
        if let Err(error) = app.emit(AVATAR_CACHE_WARMED_EVENT, payload) {
            log::warn!("Failed to emit avatar cache warm event: {error}");
        }
    }

    if !incomplete_avatar_refs.is_empty() {
        let retry_app = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(AVATAR_WARM_RETRY_DELAY).await;
            if let Err(error) =
                retry_incomplete_avatar_refs(retry_app, incomplete_avatar_refs).await
            {
                log::warn!("Failed to retry incomplete agent avatar warm-up: {error}");
            }
        });
    }

    // Brief lock for pruning.
    {
        let _catalog_guard = catalog_lock().lock().await;
        prune_obsolete_versions(&paths, &catalog.catalog_version)?;
    }

    Ok(warmed)
}

async fn retry_incomplete_avatar_refs(
    app: AppHandle,
    avatar_refs: Vec<String>,
) -> Result<(), String> {
    let avatar_ids = avatar_refs
        .iter()
        .filter_map(|avatar_ref| parse_app_avatar_ref(avatar_ref).ok())
        .collect::<BTreeSet<_>>();
    if avatar_ids.is_empty() {
        return Ok(());
    }

    let paths = avatar_cache_paths(&app)?;
    let catalog = {
        let _catalog_guard = catalog_lock().lock().await;
        current_catalog(&paths)
            .await
            .map_err(|error| error.to_string())?
    };
    let client = asset_http_client()?;
    let format = platform_avatar_format();
    let mut warmed_avatar_refs = Vec::new();

    for avatar_id in avatar_ids {
        let Some(entry) = catalog.assets.iter().find(|entry| entry.id == avatar_id) else {
            continue;
        };
        if let Ok((_, partial_error_code)) =
            ensure_avatar_media(&client, &paths, &catalog, entry, format).await
        {
            if partial_error_code.is_none() && entry.variants.poster.is_some() {
                warmed_avatar_refs.push(format!("app-avatar:{avatar_id}"));
            }
        }
    }

    if !warmed_avatar_refs.is_empty() {
        let payload = AvatarCacheWarmedPayload {
            avatar_refs: warmed_avatar_refs,
        };
        if let Err(error) = app.emit(AVATAR_CACHE_WARMED_EVENT, payload) {
            log::warn!("Failed to emit avatar cache retry event: {error}");
        }
    }

    Ok(())
}

fn catalog_needs_refresh_for_avatar_ids(
    catalog: &AvatarCatalog,
    avatar_ids: &BTreeSet<String>,
) -> bool {
    avatar_ids.iter().any(|avatar_id| {
        catalog
            .assets
            .iter()
            .find(|entry| &entry.id == avatar_id)
            .is_none_or(|entry| entry.variants.poster.is_none())
    })
}

async fn clear_avatar_cache_paths(paths: &AvatarCachePaths) -> Result<(), String> {
    remove_dir_all_if_exists(&paths.meta, "avatar metadata").await?;
    remove_dir_all_if_exists(&paths.media, "avatar media").await
}

async fn current_catalog(paths: &AvatarCachePaths) -> AvatarCommandResult<AvatarCatalog> {
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
) -> AvatarCommandResult<AvatarCatalog> {
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

async fn refresh_cached_catalog(paths: &AvatarCachePaths) -> AvatarCommandResult<AvatarCatalog> {
    let (latest, catalog) = fetch_current_catalog().await?;
    write_cached_catalog(paths, &latest, &catalog)?;
    Ok(catalog)
}

async fn fetch_current_catalog() -> AvatarCommandResult<(AvatarLatest, AvatarCatalog)> {
    let client = metadata_http_client()?;
    let latest: AvatarLatest =
        fetch_metadata_json(&client, LATEST_PATH, "avatar latest pointer").await?;

    let manifest_path = manifest_path_for_latest(&latest)?;
    let catalog: AvatarCatalog =
        fetch_metadata_json(&client, &manifest_path, "avatar catalog").await?;

    validate_catalog(&catalog)?;
    if catalog.catalog_version != latest.catalog_version {
        return Err("Avatar catalog version does not match latest pointer"
            .to_string()
            .into());
    }

    Ok((latest, catalog))
}

async fn fetch_metadata_json<T>(
    client: &reqwest::Client,
    relative_path: &str,
    label: &str,
) -> AvatarCommandResult<T>
where
    T: DeserializeOwned,
{
    let response = client
        .get(allowed_cdn_url(relative_path)?)
        .send()
        .await
        .map_err(|error| metadata_request_error(label, error))?;
    let status = response.status();
    if !status.is_success() {
        return Err(metadata_status_error(label, status));
    }

    response.json().await.map_err(|error| {
        AvatarCommandError::unavailable(format!("Failed to parse {label}: {error}"))
    })
}

fn metadata_http_client() -> AvatarCommandResult<reqwest::Client> {
    reqwest::Client::builder()
        .connect_timeout(METADATA_CONNECT_TIMEOUT)
        .timeout(METADATA_REQUEST_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|error| {
            AvatarCommandError::unavailable(format!(
                "Failed to create avatar metadata HTTP client: {error}"
            ))
        })
}

fn asset_http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(ASSET_CONNECT_TIMEOUT)
        .timeout(ASSET_DOWNLOAD_TIMEOUT)
        .build()
        .map_err(|error| format!("Failed to create avatar asset HTTP client: {error}"))
}

fn classify_metadata_request_error(error: &reqwest::Error) -> AvatarErrorCode {
    if error.is_timeout() || error.is_connect() {
        AvatarErrorCode::NetworkAccess
    } else {
        AvatarErrorCode::Unavailable
    }
}

fn metadata_request_error(label: &str, error: reqwest::Error) -> AvatarCommandError {
    let raw = format!("Failed to fetch {label}: {error}");
    match classify_metadata_request_error(&error) {
        AvatarErrorCode::NetworkAccess => AvatarCommandError::network_access(raw),
        AvatarErrorCode::Unavailable => AvatarCommandError::unavailable(raw),
    }
}

fn metadata_status_error(label: &str, status: StatusCode) -> AvatarCommandError {
    AvatarCommandError::unavailable(format!("{label} returned HTTP status {status}"))
}

/// Lock that protects catalog metadata reads/writes, pruning, and part-file
/// cleanup. This is NOT held during asset downloads — downloads use per-asset
/// deduplication instead.
fn catalog_lock() -> &'static tokio::sync::Mutex<()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

/// Shared/exclusive guard that serializes cache clears against in-flight
/// downloads. A downloader holds the *read* guard for the duration of its
/// download and placement, so many downloads still run concurrently;
/// [`clear_avatar_cache`] holds the *write* guard, which waits for in-flight
/// downloads to finish and blocks new ones from starting.
///
/// Downloads no longer hold [`catalog_lock`], so without this guard an in-flight
/// download could place its media blob right after a clear wiped the cache,
/// leaving an orphan behind while the clear reported success. Read-only avatar
/// resolution does not take this guard, so
/// the UI never blocks on it.
fn download_guard() -> &'static tokio::sync::RwLock<()> {
    static GUARD: OnceLock<tokio::sync::RwLock<()>> = OnceLock::new();
    GUARD.get_or_init(|| tokio::sync::RwLock::new(()))
}

// Followers need only the verified blob placement result. Each caller builds
// its own CachedAvatarAsset metadata because multiple avatar IDs may reference
// the same content-addressed blob.
type InflightResult = Result<(), AvatarAssetError>;

struct InflightDownload {
    sender: broadcast::Sender<InflightResult>,
    byte_size: u64,
    mime_type: String,
}

impl InflightDownload {
    fn is_compatible(&self, variant: &AvatarVariant) -> bool {
        self.byte_size == variant.byte_size && self.mime_type == variant.mime_type
    }
}

type InflightMap = HashMap<String, InflightDownload>;

/// Per-blob download deduplication. Variants with the same SHA-256 subscribe
/// to one download even when different catalogs or avatar IDs reference it.
///
/// This is a synchronous mutex: it is only ever held for brief map lookups and
/// a cache re-check, never across an `.await`. Keeping it synchronous lets
/// [`InflightGuard`] remove a registration from a `Drop` impl, which is what
/// makes a canceled download clean up after itself.
fn inflight_downloads() -> &'static std::sync::Mutex<InflightMap> {
    static MAP: OnceLock<std::sync::Mutex<InflightMap>> = OnceLock::new();
    MAP.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

fn lock_inflight_downloads() -> std::sync::MutexGuard<'static, InflightMap> {
    // The map is a plain cache; a poisoned lock only means a previous holder
    // panicked, so recover the guard rather than propagate the panic.
    inflight_downloads()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn inflight_key(variant: &AvatarVariant) -> Result<String, String> {
    media_blob_filename(variant)
}

/// Either we became the downloader for an asset (`Leader`, holding the sender
/// other tasks subscribe to) or another task already owns the download
/// (`Follower`, holding a receiver for its result).
enum InflightRole {
    Leader(broadcast::Sender<InflightResult>),
    Follower(broadcast::Receiver<InflightResult>),
}

/// Removes an in-flight download registration when dropped. The leader is the
/// only task that can remove its own key, so dropping this guard — on normal
/// completion or on cancellation (future dropped mid-download) — guarantees the
/// key never lingers. Without it, a canceled leader would leave a sender in the
/// map that never sends, wedging every later subscriber forever.
struct InflightGuard<'a> {
    key: &'a str,
}

impl<'a> InflightGuard<'a> {
    fn new(key: &'a str) -> Self {
        Self { key }
    }
}

impl Drop for InflightGuard<'_> {
    fn drop(&mut self) {
        lock_inflight_downloads().remove(self.key);
    }
}

/// Download a single asset with deduplication. If another task is already
/// downloading the same asset, this waits for that result instead of starting
/// a second download.
async fn ensure_avatar_media(
    client: &reqwest::Client,
    paths: &AvatarCachePaths,
    catalog: &AvatarCatalog,
    entry: &AvatarCatalogEntry,
    format: &str,
) -> Result<(CachedAvatarAsset, Option<AvatarErrorCode>), AvatarAssetError> {
    // Keep the poster and platform video in one cache lifecycle. A clear waits
    // for both attempts to finish, so it cannot delete a poster between the two
    // downloads and leave the returned media pointing at a removed file.
    let _download_guard = download_guard().read().await;

    let (poster, poster_error_code) = if entry.variants.poster.is_some() {
        match ensure_entry_deduped_without_download_guard(client, paths, catalog, entry, "poster")
            .await
        {
            Ok(poster) => (Some(poster), None),
            Err(error) => {
                log::warn!("Failed to ensure avatar poster '{}': {error}", entry.id);
                (None, Some(error.code))
            }
        }
    } else {
        (None, None)
    };

    match ensure_entry_deduped_without_download_guard(client, paths, catalog, entry, format).await {
        Ok(mut media) => {
            media.poster_path = poster.as_ref().map(|poster| poster.path.clone());
            Ok((media, poster_error_code))
        }
        Err(error) => poster.map(|poster| (poster, Some(error.code))).ok_or(error),
    }
}

async fn ensure_entry_deduped_without_download_guard(
    client: &reqwest::Client,
    paths: &AvatarCachePaths,
    catalog: &AvatarCatalog,
    entry: &AvatarCatalogEntry,
    format: &str,
) -> Result<CachedAvatarAsset, AvatarAssetError> {
    let variant = variant_for_format(entry, format)?;
    validate_variant_path(variant, format, &entry.collection_id)?;
    let target = media_blob_path(paths, variant)?;

    // Fast path: already cached on disk.
    if let Some(asset) = valid_cached_asset(entry, variant, &target)? {
        return Ok(asset);
    }

    let key = inflight_key(variant)?;

    loop {
        // Atomically become the downloader or subscribe to an in-flight one.
        // Holding the map lock across the cache re-check and the insert closes
        // the check-then-act window where two tasks could both register.
        let role = {
            let mut inflight = lock_inflight_downloads();
            // Another task may have finished between the fast path and here.
            if let Some(asset) = valid_cached_asset(entry, variant, &target)? {
                return Ok(asset);
            }
            match inflight.get(&key) {
                Some(download) if download.is_compatible(variant) => {
                    InflightRole::Follower(download.sender.subscribe())
                }
                Some(_) => {
                    return Err(AvatarAssetError::unavailable(
                        "Avatar variants sharing a blob disagree on size or MIME type",
                    ));
                }
                None => {
                    let (tx, _) = broadcast::channel::<InflightResult>(1);
                    inflight.insert(
                        key.clone(),
                        InflightDownload {
                            sender: tx.clone(),
                            byte_size: variant.byte_size,
                            mime_type: variant.mime_type.clone(),
                        },
                    );
                    InflightRole::Leader(tx)
                }
            }
        };

        match role {
            InflightRole::Follower(mut receiver) => match receiver.recv().await {
                Ok(result) => {
                    return cached_asset_after_blob_placement(result, entry, variant, &target);
                }
                // The leader dropped its sender without a result (it was
                // canceled). Its guard has removed the key, so retry: we may
                // become the leader ourselves this time.
                Err(_) => continue,
            },
            InflightRole::Leader(tx) => {
                // The guard removes our registration on every exit path,
                // including cancellation, so subscribers never wait on a
                // channel that will never receive.
                let _guard = InflightGuard::new(&key);
                let result = ensure_entry_download(client, catalog, variant, &target).await;
                let _ = tx.send(result.clone());
                result?;
                return Ok(cached_asset(entry, variant, target));
            }
        }
    }
}

fn cached_asset_after_blob_placement(
    result: InflightResult,
    entry: &AvatarCatalogEntry,
    variant: &AvatarVariant,
    target: &Path,
) -> Result<CachedAvatarAsset, AvatarAssetError> {
    result?;
    valid_cached_asset(entry, variant, target)?
        .ok_or_else(|| AvatarAssetError::unavailable("Downloaded avatar blob was not valid"))
}

/// The actual download + verify + place logic, extracted from the old
/// `ensure_entry` so it can be called within the dedup wrapper.
async fn ensure_entry_download(
    client: &reqwest::Client,
    catalog: &AvatarCatalog,
    variant: &AvatarVariant,
    target: &Path,
) -> Result<(), AvatarAssetError> {
    delete_file_if_exists(target)?;

    let url = allowed_cdn_url(&format!("{}/{}", catalog.catalog_version, variant.path))?;
    download_asset(client, url, target, variant).await
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

async fn download_asset(
    client: &reqwest::Client,
    url: Url,
    target: &Path,
    variant: &AvatarVariant,
) -> Result<(), AvatarAssetError> {
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|error| AvatarAssetError::request("Failed to download avatar asset", error))?;
    let status = response.status();
    if !status.is_success() {
        return Err(AvatarAssetError::status(
            "Avatar asset returned an error",
            status,
        ));
    }
    if let Some(content_length) = response.content_length() {
        if content_length != variant.byte_size {
            return Err(AvatarAssetError::unavailable(
                "Avatar asset byte size did not match manifest",
            ));
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
        let chunk = chunk.map_err(|error| {
            AvatarAssetError::request("Failed to read avatar asset response", error)
        })?;
        downloaded += chunk.len() as u64;
        if downloaded > variant.byte_size {
            return Err(AvatarAssetError::unavailable(
                "Avatar asset byte size exceeded manifest",
            ));
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
        return Err(AvatarAssetError::unavailable(
            "Avatar asset byte size did not match manifest",
        ));
    }
    let actual = hex_digest(hasher.finalize().as_slice());
    if actual != variant.sha256.to_ascii_lowercase() {
        return Err(AvatarAssetError::unavailable(
            "Avatar asset checksum did not match manifest",
        ));
    }

    if let Err(error) = tokio::fs::rename(part_file.path(), target).await {
        return Err(AvatarAssetError::unavailable(format!(
            "Failed to finalize avatar cache file: {error}"
        )));
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

async fn ensure_collection_assets(
    paths: &AvatarCachePaths,
    catalog: &AvatarCatalog,
    collection: &AvatarCollection,
    format: &str,
) -> Result<(Vec<CachedAvatarAsset>, Vec<String>, Option<AvatarErrorCode>), String> {
    let client = asset_http_client()?;
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
                match ensure_avatar_media(&client, &paths, &catalog, &entry, format).await {
                    Ok((asset, error_code)) => Ok((asset, error_code)),
                    Err(error) => {
                        log::warn!("Failed to ensure avatar asset '{id}': {error}");
                        Err((id, error.code))
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
    let mut error_code = None;
    for result in results {
        match result {
            Ok((asset, poster_error_code)) => {
                if let Some(code) = poster_error_code {
                    failed_asset_ids.push(asset.id.clone());
                    if code == AvatarErrorCode::NetworkAccess {
                        error_code = Some(AvatarErrorCode::NetworkAccess);
                    } else if error_code.is_none() {
                        error_code = Some(AvatarErrorCode::Unavailable);
                    }
                }
                assets.push(asset);
            }
            Err((id, code)) => {
                failed_asset_ids.push(id);
                if code == AvatarErrorCode::NetworkAccess {
                    error_code = Some(AvatarErrorCode::NetworkAccess);
                } else if error_code.is_none() {
                    error_code = Some(AvatarErrorCode::Unavailable);
                }
            }
        }
    }
    assets.sort_by_key(|asset| collection_order.get(asset.id.as_str()).copied());
    failed_asset_ids.sort_by_key(|id| collection_order.get(id.as_str()).copied());

    Ok((assets, failed_asset_ids, error_code))
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
    std::env::var("BERD_AVATAR_DOWNLOAD_CONCURRENCY")
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
                error_code: None,
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
        let variant = variant_for_format(entry, format)?;
        let target = media_blob_path(paths, variant)?;
        // This runs on the lock-free snapshot read path, concurrently with
        // downloads that hold no catalog lock. A poster-only avatar remains
        // usable as a fallback, but does not make the collection fully cached:
        // reopening the collection must retry its missing animation.
        let Some(mut asset) = valid_cached_asset(entry, variant, &target)? else {
            return Ok(None);
        };
        if entry.variants.poster.is_some() {
            let Some(poster) = cached_poster_asset(paths, entry)? else {
                return Ok(None);
            };
            asset.poster_path = Some(poster.path);
        }
        assets.push(asset);
    }

    Ok(Some(assets))
}

fn valid_cached_asset(
    entry: &AvatarCatalogEntry,
    variant: &AvatarVariant,
    target: &Path,
) -> Result<Option<CachedAvatarAsset>, String> {
    if !valid_cached_asset_for_variant(variant, target)? {
        return Ok(None);
    }
    Ok(Some(cached_asset(entry, variant, target.to_path_buf())))
}

fn valid_cached_asset_for_variant(variant: &AvatarVariant, target: &Path) -> Result<bool, String> {
    // Downloads and legacy migration verify SHA-256 before atomically placing a
    // blob at its digest-derived path. Steady-state gallery probes intentionally
    // trust that identity and check only size to avoid rehashing multi-MB media.
    if !target.exists() {
        return Ok(false);
    }
    let metadata = fs::metadata(target).map_err(|error| {
        format!(
            "Failed to inspect cached avatar '{}': {error}",
            target.display()
        )
    })?;
    Ok(metadata.len() == variant.byte_size)
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
        alpha_mode: None,
        poster_path: None,
    }
}

fn avatar_cache_paths(app: &AppHandle) -> Result<AvatarCachePaths, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Failed to resolve app data directory: {error}"))?;
    Ok(cache_paths_for_root(app_data_dir.join("avatars")))
}

fn user_avatar_paths(app: &AppHandle) -> Result<UserAvatarPaths, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Failed to resolve app data directory: {error}"))?;
    let root = app_data_dir.join("user-avatars");
    Ok(UserAvatarPaths {
        meta: root.join("meta"),
        media: root.join("media"),
    })
}

pub(crate) fn write_user_avatar(
    app: &AppHandle,
    bytes: &[u8],
    mime_type: &str,
) -> Result<String, String> {
    write_user_avatar_with_alpha_mode(app, bytes, mime_type, None)
}

pub(crate) fn write_user_avatar_with_alpha_mode(
    app: &AppHandle,
    bytes: &[u8],
    mime_type: &str,
    alpha_mode: Option<&str>,
) -> Result<String, String> {
    validate_user_avatar_alpha_mode(alpha_mode)?;
    let extension = user_avatar_extension(mime_type)
        .ok_or_else(|| format!("Unsupported generated avatar media type: {mime_type}"))?;
    let id = format!("gloopie-{}", Uuid::new_v4());
    validate_avatar_id(&id)?;

    let paths = user_avatar_paths(app)?;
    let media_relative_path = format!("{id}.{extension}");
    let media_path = paths.media.join(&media_relative_path);
    atomic_write(&media_path, bytes)?;

    let created_at_ms = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map_or(0, |duration| duration.as_millis());
    let manifest = UserAvatarManifest {
        id: id.clone(),
        path: media_relative_path,
        mime_type: mime_type.to_string(),
        alpha_mode: alpha_mode.map(str::to_string),
        byte_size: bytes.len() as u64,
        created_at_ms,
    };
    let manifest_bytes = serde_json::to_vec_pretty(&manifest)
        .map_err(|error| format!("Failed to serialize generated avatar manifest: {error}"))?;
    atomic_write(&paths.meta.join(format!("{id}.json")), &manifest_bytes)?;

    Ok(format!("{USER_AVATAR_REF_PREFIX}{id}"))
}

pub(crate) fn read_user_avatar_bytes(
    app: &AppHandle,
    avatar_ref: &str,
) -> Result<(Vec<u8>, String), String> {
    let avatar_id = parse_user_avatar_ref(avatar_ref)?
        .ok_or_else(|| "Invalid user avatar reference".to_string())?;
    let paths = user_avatar_paths(app)?;
    let manifest = read_user_avatar_manifest(&paths, &avatar_id)?;
    let media_path = user_avatar_media_path(&paths, &manifest)?;
    let bytes = fs::read(&media_path).map_err(|error| {
        format!(
            "Failed to read generated avatar media '{}': {error}",
            media_path.display()
        )
    })?;
    Ok((bytes, manifest.mime_type))
}

fn cached_user_avatar_for_id(
    app: &AppHandle,
    avatar_id: &str,
) -> Result<Option<CachedAvatar>, String> {
    let paths = user_avatar_paths(app)?;
    let manifest_path = paths.meta.join(format!("{avatar_id}.json"));
    if !manifest_path.exists() {
        return Ok(None);
    }
    let manifest = read_user_avatar_manifest(&paths, avatar_id)?;
    let media_path = user_avatar_media_path(&paths, &manifest)?;
    if !media_path.exists() {
        return Ok(None);
    }
    Ok(Some(CachedAvatar {
        catalog_version: USER_AVATAR_CATALOG_VERSION.to_string(),
        collection_id: USER_AVATAR_COLLECTION_ID.to_string(),
        asset: CachedAvatarAsset {
            id: manifest.id,
            path: media_path.to_string_lossy().to_string(),
            mime_type: manifest.mime_type,
            alpha_mode: manifest.alpha_mode,
            poster_path: None,
        },
    }))
}

fn read_user_avatar_manifest(
    paths: &UserAvatarPaths,
    avatar_id: &str,
) -> Result<UserAvatarManifest, String> {
    validate_avatar_id(avatar_id)?;
    let manifest: UserAvatarManifest =
        read_json_file(&paths.meta.join(format!("{avatar_id}.json")))?;
    if manifest.id != avatar_id {
        return Err("Generated avatar manifest id mismatch".to_string());
    }
    validate_safe_relative_path(&manifest.path)?;
    if user_avatar_extension(&manifest.mime_type).is_none() {
        return Err("Generated avatar manifest has unsupported media type".to_string());
    }
    validate_user_avatar_alpha_mode(manifest.alpha_mode.as_deref())?;
    Ok(manifest)
}

fn user_avatar_media_path(
    paths: &UserAvatarPaths,
    manifest: &UserAvatarManifest,
) -> Result<PathBuf, String> {
    validate_safe_relative_path(&manifest.path)?;
    Ok(paths.media.join(&manifest.path))
}

fn user_avatar_extension(mime_type: &str) -> Option<&'static str> {
    match mime_type
        .split(';')
        .next()?
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "image/png" => Some("png"),
        "image/jpeg" => Some("jpg"),
        "image/webp" => Some("webp"),
        "video/webm" => Some("webm"),
        "video/mp4" => Some("mp4"),
        "video/quicktime" => Some("mov"),
        "video/x-m4v" => Some("m4v"),
        _ => None,
    }
}

fn validate_user_avatar_alpha_mode(value: Option<&str>) -> Result<(), String> {
    match value {
        Some("stacked") | None => Ok(()),
        Some(other) => Err(format!("Unsupported generated avatar alpha mode: {other}")),
    }
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
        "poster" => entry
            .variants
            .poster
            .as_ref()
            .ok_or_else(|| format!("Avatar '{}' does not have a poster variant", entry.id)),
        _ => Err("Unsupported avatar format".to_string()),
    }
}

fn allowed_cdn_url(relative_path: &str) -> Result<Url, String> {
    validate_safe_relative_path(relative_path)?;
    let base = Url::parse(AVATAR_CDN_BASE).map_err(|error| error.to_string())?;
    let url = base
        .join(relative_path)
        .map_err(|error| format!("Invalid avatar artifact URL: {error}"))?;
    if !url.as_str().starts_with(AVATAR_CDN_BASE) {
        return Err("Avatar artifact URL is outside the allowed base".to_string());
    }
    Ok(url)
}

fn media_blob_path(paths: &AvatarCachePaths, variant: &AvatarVariant) -> Result<PathBuf, String> {
    Ok(paths
        .media
        .join("blobs")
        .join(media_blob_filename(variant)?))
}

fn media_blob_filename(variant: &AvatarVariant) -> Result<String, String> {
    let sha256 = variant.sha256.to_ascii_lowercase();
    if sha256.len() != 64 || !sha256.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("Avatar variant checksum must be a SHA-256 hex digest".to_string());
    }
    let extension = Path::new(&variant.path)
        .extension()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "Avatar variant path must have an extension".to_string())?;
    validate_safe_segment(extension)?;
    Ok(format!("{sha256}.{extension}"))
}

fn validate_catalog(catalog: &AvatarCatalog) -> Result<(), String> {
    if catalog.schema_version != 1 {
        return Err("Unsupported avatar catalog schema".to_string());
    }
    validate_safe_segment(&catalog.catalog_version)?;

    let mut asset_collections: HashMap<&str, &str> = HashMap::new();
    let mut blob_metadata: HashMap<String, (u64, &str)> = HashMap::new();
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
        if let Some(poster) = entry.variants.poster.as_ref() {
            validate_variant_path(poster, "poster", &entry.collection_id)?;
        }
        for variant in [Some(webm), Some(hevc), entry.variants.poster.as_ref()]
            .into_iter()
            .flatten()
        {
            let blob = media_blob_filename(variant)?;
            match blob_metadata.get(&blob) {
                Some((byte_size, mime_type))
                    if *byte_size != variant.byte_size || *mime_type != variant.mime_type =>
                {
                    return Err(
                        "Avatar variants sharing a blob must agree on size and MIME type"
                            .to_string(),
                    );
                }
                Some(_) => {}
                None => {
                    blob_metadata.insert(blob, (variant.byte_size, variant.mime_type.as_str()));
                }
            }
        }
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

fn parse_app_avatar_ref(value: &str) -> Result<String, String> {
    let id = value
        .trim()
        .strip_prefix(APP_AVATAR_REF_PREFIX)
        .ok_or_else(|| "Invalid app avatar reference".to_string())?;
    validate_avatar_id(id)?;
    Ok(id.to_string())
}

fn parse_user_avatar_ref(value: &str) -> Result<Option<String>, String> {
    let Some(id) = value.trim().strip_prefix(USER_AVATAR_REF_PREFIX) else {
        return Ok(None);
    };
    validate_avatar_id(id)?;
    Ok(Some(id.to_string()))
}

fn prepare_legacy_media(
    paths: &AvatarCachePaths,
    current_version: &str,
) -> Result<Option<String>, String> {
    let previous_versions = valid_previous_versions(paths, current_version)?;
    migrate_legacy_media(paths, current_version, &previous_versions)?;
    Ok(previous_versions.into_iter().next())
}

fn prune_obsolete_versions(paths: &AvatarCachePaths, current_version: &str) -> Result<(), String> {
    let previous_version = prepare_legacy_media(paths, current_version)?;
    prune_catalog_versions(&paths.meta, current_version, previous_version.as_deref())?;
    prune_media_blobs(paths, current_version, previous_version.as_deref())
}

fn valid_previous_versions(
    paths: &AvatarCachePaths,
    current_version: &str,
) -> Result<Vec<String>, String> {
    let mut valid_versions = Vec::new();
    for version in previous_versions(&paths.meta, current_version)? {
        let manifest = paths.meta.join(&version).join(MANIFEST_FILE);
        let valid = read_json_file::<AvatarCatalog>(&manifest).and_then(|catalog| {
            if catalog.catalog_version != version {
                return Err(
                    "Retained avatar catalog version does not match its directory".to_string(),
                );
            }
            validate_catalog(&catalog)
        });
        match valid {
            Ok(()) => valid_versions.push(version),
            Err(error) => {
                log::warn!("Discarding invalid retained avatar catalog '{version}': {error}");
            }
        }
    }
    Ok(valid_versions)
}

fn migrate_legacy_media(
    paths: &AvatarCachePaths,
    current_version: &str,
    previous_versions: &[String],
) -> Result<(), String> {
    for version in
        std::iter::once(current_version).chain(previous_versions.iter().map(String::as_str))
    {
        let manifest = paths.meta.join(version).join(MANIFEST_FILE);
        if !manifest.exists() {
            continue;
        }
        let catalog = read_json_file::<AvatarCatalog>(&manifest)?;
        validate_catalog(&catalog)?;
        for entry in &catalog.assets {
            for variant in [
                entry.variants.webm.as_ref(),
                entry.variants.hevc.as_ref(),
                entry.variants.poster.as_ref(),
            ]
            .into_iter()
            .flatten()
            {
                migrate_legacy_variant(paths, version, variant)?;
            }
        }
    }
    Ok(())
}

fn migrate_legacy_variant(
    paths: &AvatarCachePaths,
    catalog_version: &str,
    variant: &AvatarVariant,
) -> Result<(), String> {
    let target = media_blob_path(paths, variant)?;
    let source = paths.media.join(catalog_version).join(&variant.path);
    if !source.exists() {
        return Ok(());
    }
    if target.exists() && legacy_media_matches_variant(&target, variant)? {
        return Ok(());
    }

    if !legacy_media_matches_variant(&source, variant)? {
        log::warn!(
            "Skipping corrupt legacy avatar media '{}'; the blob will be downloaded again",
            source.display()
        );
        return Ok(());
    }

    let parent = target
        .parent()
        .ok_or_else(|| "Avatar blob target has no parent".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Failed to create avatar blob directory: {error}"))?;
    let part_path = unique_part_path(&target);
    let mut part_file = PartFile::new(part_path);
    fs::hard_link(&source, part_file.path())
        .map_err(|error| format!("Failed to stage legacy avatar media: {error}"))?;
    delete_file_if_exists(&target)?;
    match fs::rename(part_file.path(), &target) {
        Ok(()) => {
            part_file.persist();
            Ok(())
        }
        Err(error)
            if error.kind() == std::io::ErrorKind::AlreadyExists
                && legacy_media_matches_variant(&target, variant)? =>
        {
            Ok(())
        }
        Err(error) => Err(format!("Failed to finalize migrated avatar media: {error}")),
    }
}

fn legacy_media_matches_variant(source: &Path, variant: &AvatarVariant) -> Result<bool, String> {
    media_file_matches_variant(source, variant)
}

fn media_file_matches_variant(path: &Path, variant: &AvatarVariant) -> Result<bool, String> {
    let metadata =
        fs::metadata(path).map_err(|error| format!("Failed to inspect avatar media: {error}"))?;
    if metadata.len() != variant.byte_size {
        return Ok(false);
    }

    let mut file =
        fs::File::open(path).map_err(|error| format!("Failed to open avatar media: {error}"))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|error| format!("Failed to read avatar media: {error}"))?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    Ok(hex_digest(hasher.finalize().as_slice()).eq_ignore_ascii_case(&variant.sha256))
}

fn prune_catalog_versions(
    meta_root: &Path,
    current_version: &str,
    previous_version: Option<&str>,
) -> Result<(), String> {
    if !meta_root.exists() {
        return Ok(());
    }
    for entry in fs::read_dir(meta_root)
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
        if version != current_version && Some(version.as_str()) != previous_version {
            fs::remove_dir_all(entry.path())
                .map_err(|error| format!("Failed to prune obsolete avatar cache: {error}"))?;
        }
    }
    Ok(())
}

fn prune_media_blobs(
    paths: &AvatarCachePaths,
    current_version: &str,
    previous_version: Option<&str>,
) -> Result<(), String> {
    if !paths.media.exists() {
        return Ok(());
    }

    let mut retained = HashSet::new();
    for version in [Some(current_version), previous_version]
        .into_iter()
        .flatten()
    {
        let manifest = paths.meta.join(version).join(MANIFEST_FILE);
        if !manifest.exists() {
            continue;
        }
        let catalog = read_json_file::<AvatarCatalog>(&manifest)?;
        validate_catalog(&catalog)?;
        for entry in &catalog.assets {
            for variant in [
                entry.variants.webm.as_ref(),
                entry.variants.hevc.as_ref(),
                entry.variants.poster.as_ref(),
            ]
            .into_iter()
            .flatten()
            {
                retained.insert(media_blob_path(paths, variant)?);
            }
        }
    }

    let blobs = paths.media.join("blobs");
    if blobs.exists() {
        for entry in fs::read_dir(&blobs)
            .map_err(|error| format!("Failed to read avatar blob cache: {error}"))?
        {
            let entry = entry.map_err(|error| format!("Failed to inspect avatar blob: {error}"))?;
            let path = entry.path();
            if entry
                .file_type()
                .map_err(|error| format!("Failed to inspect avatar blob type: {error}"))?
                .is_file()
                && !entry.file_name().to_string_lossy().ends_with(".part")
                && !retained.contains(&path)
            {
                delete_file_if_exists(&path)?;
            }
        }
    }

    // Version-addressed media is legacy data after the content-addressed cache migration.
    for entry in fs::read_dir(&paths.media)
        .map_err(|error| format!("Failed to read avatar media cache: {error}"))?
    {
        let entry = entry.map_err(|error| format!("Failed to inspect avatar media: {error}"))?;
        if entry.file_name() != "blobs" {
            let path = entry.path();
            if entry
                .file_type()
                .map_err(|error| format!("Failed to inspect avatar media type: {error}"))?
                .is_dir()
            {
                fs::remove_dir_all(path)
                    .map_err(|error| format!("Failed to prune legacy avatar media: {error}"))?;
            }
        }
    }

    Ok(())
}

fn previous_versions(meta_root: &Path, current_version: &str) -> Result<Vec<String>, String> {
    if !meta_root.exists() {
        return Ok(Vec::new());
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
    versions.sort_by(|left, right| right.cmp(left));
    Ok(versions)
}

fn clean_part_files(paths: &AvatarCachePaths) -> Result<(), String> {
    let now = SystemTime::now();
    for base in [&paths.meta, &paths.media] {
        clean_part_files_under(base, now)?;
    }
    Ok(())
}

fn clean_part_files_under(path: &Path, now: SystemTime) -> Result<(), String> {
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
            clean_part_files_under(&path, now)?;
        } else if entry.file_name().to_string_lossy().ends_with(".part")
            && part_file_is_stale(&entry, now)?
        {
            delete_file_if_exists(&path)?;
        }
    }
    Ok(())
}

/// Whether a `.part` file is old enough that no live download could still be
/// writing it. Downloads now run without holding any lock, so blanket-deleting
/// part files would race an active download and make its final rename fail;
/// only orphans left behind by a crashed process (which will be older than
/// [`PART_FILE_STALE_AGE`]) are safe to remove.
fn part_file_is_stale(entry: &fs::DirEntry, now: SystemTime) -> Result<bool, String> {
    let metadata = entry
        .metadata()
        .map_err(|error| format!("Failed to inspect avatar cache part file: {error}"))?;
    let Ok(modified_at) = metadata.modified() else {
        // Without a modification time we cannot tell an orphan from a live
        // download, so err on the side of keeping it.
        return Ok(false);
    };
    Ok(now
        .duration_since(modified_at)
        .is_ok_and(|age| age >= PART_FILE_STALE_AGE))
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
            } else if path.ends_with(".png") {
                "image/png".to_string()
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
                    poster: None,
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

    fn temp_user_avatar_paths() -> (tempfile::TempDir, UserAvatarPaths) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("user-avatars");
        let paths = UserAvatarPaths {
            meta: root.join("meta"),
            media: root.join("media"),
        };
        fs::create_dir_all(&paths.meta).unwrap();
        fs::create_dir_all(&paths.media).unwrap();
        (dir, paths)
    }

    fn seed_user_avatar(paths: &UserAvatarPaths, id: &str) -> PathBuf {
        let media_relative_path = format!("{id}.png");
        let media_path = paths.media.join(&media_relative_path);
        fs::write(&media_path, b"png-bytes").unwrap();
        let manifest = UserAvatarManifest {
            id: id.to_string(),
            path: media_relative_path,
            mime_type: "image/png".to_string(),
            alpha_mode: None,
            byte_size: 9,
            created_at_ms: 0,
        };
        fs::write(
            paths.meta.join(format!("{id}.json")),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();
        media_path
    }

    #[test]
    fn delete_user_avatar_removes_media_and_manifest() {
        let (_dir, paths) = temp_user_avatar_paths();
        let media_path = seed_user_avatar(&paths, "gloopie-1");
        let manifest_path = paths.meta.join("gloopie-1.json");

        delete_user_avatar_at(&paths, "user-avatar:gloopie-1").unwrap();

        assert!(!media_path.exists());
        assert!(!manifest_path.exists());
    }

    #[test]
    fn delete_user_avatar_is_idempotent() {
        let (_dir, paths) = temp_user_avatar_paths();
        seed_user_avatar(&paths, "gloopie-1");

        delete_user_avatar_at(&paths, "user-avatar:gloopie-1").unwrap();
        // Abandoned-generation cleanup can fire twice for the same ref.
        delete_user_avatar_at(&paths, "user-avatar:gloopie-1").unwrap();
        delete_user_avatar_at(&paths, "user-avatar:never-existed").unwrap();
    }

    #[test]
    fn delete_user_avatar_rejects_refs_it_does_not_own() {
        let (_dir, paths) = temp_user_avatar_paths();

        // Bundled catalog avatars are not ours to delete.
        assert!(delete_user_avatar_at(&paths, "app-avatar:gloopy-1").is_err());
        assert!(delete_user_avatar_at(&paths, "gloopie-1").is_err());
        assert!(delete_user_avatar_at(&paths, "user-avatar:").is_err());
    }

    #[test]
    fn delete_user_avatar_rejects_path_traversal_in_the_ref() {
        let (_dir, paths) = temp_user_avatar_paths();
        let outside = paths.meta.parent().unwrap().join("secret.json");
        fs::write(&outside, b"keep me").unwrap();

        assert!(delete_user_avatar_at(&paths, "user-avatar:../secret").is_err());
        assert!(delete_user_avatar_at(&paths, "user-avatar:/etc/passwd").is_err());
        assert!(outside.exists());
    }

    #[test]
    fn delete_user_avatar_rejects_a_manifest_pointing_outside_the_media_dir() {
        let (_dir, paths) = temp_user_avatar_paths();
        let escaped = paths.media.parent().unwrap().join("escaped.png");
        fs::write(&escaped, b"keep me").unwrap();
        let manifest = serde_json::json!({
            "id": "gloopie-1",
            "path": "../escaped.png",
            "mimeType": "image/png",
            "byteSize": 7,
            "createdAtMs": 0,
        });
        fs::write(
            paths.meta.join("gloopie-1.json"),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();

        // A tampered manifest must not turn delete into arbitrary file removal.
        assert!(delete_user_avatar_at(&paths, "user-avatar:gloopie-1").is_err());
        assert!(escaped.exists());
    }

    fn temp_paths() -> (tempfile::TempDir, AvatarCachePaths) {
        let dir = tempfile::tempdir().unwrap();
        let paths = cache_paths_for_root(dir.path().join("avatars"));
        (dir, paths)
    }

    fn webm_variant(catalog: &AvatarCatalog) -> &AvatarVariant {
        catalog.assets[0].variants.webm.as_ref().unwrap()
    }

    fn add_poster(catalog: &mut AvatarCatalog, bytes: &[u8]) {
        catalog.assets[0].variants.poster = Some(variant("poster/gloopies/gloopy-1.png", bytes));
    }

    fn cached_webm_target(paths: &AvatarCachePaths, catalog: &AvatarCatalog) -> PathBuf {
        media_blob_path(paths, webm_variant(catalog)).unwrap()
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
                poster: None,
            },
        });
    }

    #[test]
    fn cdn_urls_are_allowlisted() {
        let url = allowed_cdn_url("v1/manifest.json").unwrap();
        assert_eq!(
            url.as_str(),
            "https://dwwgwmfqqjotj.cloudfront.net/avatars/v1/manifest.json"
        );
        assert!(allowed_cdn_url("../manifest.json").is_err());
        assert!(allowed_cdn_url("https://example.com/file").is_err());
    }

    #[test]
    fn media_blob_paths_use_content_identity() {
        let paths = cache_paths_for_root(PathBuf::from("/tmp/avatars"));
        let variant = variant("webm/gloopies/gloopy-1.webm", b"avatar-bytes");
        let path = media_blob_path(&paths, &variant).unwrap();
        assert_eq!(
            path,
            paths
                .media
                .join("blobs")
                .join(format!("{}.webm", variant.sha256))
        );
        assert!(path.starts_with(&paths.media));
        assert!(!path.starts_with(&paths.meta));

        let mut invalid = variant;
        invalid.sha256 = "../not-a-digest".to_string();
        assert!(media_blob_path(&paths, &invalid).is_err());
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
    fn missing_posters_are_omitted_from_catalog_json() {
        let catalog = valid_catalog(b"avatar-bytes");
        let serialized = serde_json::to_value(catalog).unwrap();

        assert!(serialized["assets"][0]["variants"].get("poster").is_none());
    }

    #[test]
    fn catalog_integrity_rejects_invalid_optional_posters() {
        let mut catalog = valid_catalog(b"avatar-bytes");
        add_poster(&mut catalog, b"poster-bytes");
        catalog.assets[0].variants.poster.as_mut().unwrap().path = "../gloopy-1.png".to_string();

        assert!(validate_catalog(&catalog).is_err());
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
    fn refreshes_cached_catalogs_missing_requested_avatars_or_posters() {
        let mut catalog = valid_catalog(b"avatar-bytes");
        let requested = BTreeSet::from(["gloopy-1".to_string()]);
        assert!(catalog_needs_refresh_for_avatar_ids(&catalog, &requested));

        add_poster(&mut catalog, b"poster-bytes");
        assert!(!catalog_needs_refresh_for_avatar_ids(&catalog, &requested));

        let requested = BTreeSet::from(["gloopy-1".to_string(), "gloopy-2".to_string()]);
        assert!(catalog_needs_refresh_for_avatar_ids(&catalog, &requested));
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
    fn cached_collection_assets_require_valid_blob_size() {
        let bytes = b"avatar-bytes";
        let catalog = valid_catalog(bytes);
        let collection = &catalog.collections[0];
        let (_dir, paths) = temp_paths();
        // Wrong-sized bytes at the hash-derived path are not treated as cached.
        let target = write_cached_webm(&paths, &catalog, b"avatar-bytes-plus");
        assert!(
            cached_collection_assets(&paths, &catalog, collection, "webm")
                .unwrap()
                .is_none()
        );
        assert!(target.exists());

        let target = write_cached_webm(&paths, &catalog, bytes);
        let assets = cached_collection_assets(&paths, &catalog, collection, "webm")
            .unwrap()
            .unwrap();
        assert_eq!(assets[0].path, target.to_string_lossy());
        assert!(Path::new(&assets[0].path).starts_with(&paths.media));
    }

    #[test]
    fn cached_collection_requires_poster_when_catalog_provides_one() {
        let video_bytes = b"avatar-bytes";
        let poster_bytes = b"poster-bytes";
        let mut catalog = valid_catalog(video_bytes);
        add_poster(&mut catalog, poster_bytes);
        let collection = &catalog.collections[0];
        let (_dir, paths) = temp_paths();
        write_cached_webm(&paths, &catalog, video_bytes);

        assert!(
            cached_collection_assets(&paths, &catalog, collection, "webm")
                .unwrap()
                .is_none(),
            "a video-only legacy cache must reopen the collection to fetch its poster",
        );

        let poster = catalog.assets[0].variants.poster.as_ref().unwrap();
        let poster_target = media_blob_path(&paths, poster).unwrap();
        fs::create_dir_all(poster_target.parent().unwrap()).unwrap();
        fs::write(&poster_target, poster_bytes).unwrap();

        let assets = cached_collection_assets(&paths, &catalog, collection, "webm")
            .unwrap()
            .unwrap();
        assert_eq!(
            assets[0].poster_path.as_deref(),
            Some(poster_target.to_string_lossy().as_ref()),
        );
    }

    #[test]
    fn cached_avatar_survives_catalog_bump_without_a_download() {
        let bytes = b"avatar-bytes";
        let catalog = valid_catalog(bytes);
        let mut bumped_catalog = catalog.clone();
        bumped_catalog.catalog_version = "v2".to_string();
        let (_dir, paths) = temp_paths();
        write_cached_webm(&paths, &catalog, bytes);

        assert!(
            cached_avatar_for_id_with_format(&paths, &bumped_catalog, "gloopy-1", "webm",)
                .unwrap()
                .is_some()
        );
    }

    #[test]
    fn preparing_legacy_media_satisfies_current_catalog_without_a_download() {
        let bytes = b"avatar-bytes";
        let previous = valid_catalog(bytes);
        let mut current = previous.clone();
        current.catalog_version = "v2".to_string();
        let (_dir, paths) = temp_paths();
        for catalog in [&previous, &current] {
            atomic_write(
                &paths
                    .meta
                    .join(&catalog.catalog_version)
                    .join(MANIFEST_FILE),
                &serde_json::to_vec(catalog).unwrap(),
            )
            .unwrap();
        }
        let variant = webm_variant(&previous);
        let legacy = paths.media.join("v1").join(&variant.path);
        fs::create_dir_all(legacy.parent().unwrap()).unwrap();
        fs::write(legacy, bytes).unwrap();

        assert!(
            cached_avatar_for_id_with_format(&paths, &current, "gloopy-1", "webm")
                .unwrap()
                .is_none()
        );
        prepare_legacy_media(&paths, "v2").unwrap();
        assert!(
            cached_avatar_for_id_with_format(&paths, &current, "gloopy-1", "webm")
                .unwrap()
                .is_some()
        );
    }

    #[test]
    fn preparing_legacy_media_scans_past_a_metadata_only_predecessor() {
        let bytes = b"avatar-bytes";
        let v1 = valid_catalog(bytes);
        let mut v2 = v1.clone();
        v2.catalog_version = "v2".to_string();
        let mut v3 = v1.clone();
        v3.catalog_version = "v3".to_string();
        let (_dir, paths) = temp_paths();
        for catalog in [&v1, &v2, &v3] {
            atomic_write(
                &paths
                    .meta
                    .join(&catalog.catalog_version)
                    .join(MANIFEST_FILE),
                &serde_json::to_vec(catalog).unwrap(),
            )
            .unwrap();
        }
        let variant = webm_variant(&v1);
        let legacy = paths.media.join("v1").join(&variant.path);
        fs::create_dir_all(legacy.parent().unwrap()).unwrap();
        fs::write(legacy, bytes).unwrap();

        let retained = prepare_legacy_media(&paths, "v3").unwrap();

        assert_eq!(retained.as_deref(), Some("v2"));
        assert!(
            cached_avatar_for_id_with_format(&paths, &v3, "gloopy-1", "webm")
                .unwrap()
                .is_some()
        );
    }

    #[test]
    fn shared_blob_followers_keep_their_own_asset_metadata() {
        let catalog = valid_catalog(b"shared-bytes");
        let leader = &catalog.assets[0];
        let variant = webm_variant(&catalog);
        let follower = AvatarCatalogEntry {
            id: "gloopy-2".to_string(),
            label: "Gloopy 2".to_string(),
            collection_id: "gloopies".to_string(),
            variants: leader.variants.clone(),
        };
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("shared.webm");
        fs::write(&target, b"shared-bytes").unwrap();

        let leader_asset =
            cached_asset_after_blob_placement(Ok(()), leader, variant, &target).unwrap();
        let follower_asset =
            cached_asset_after_blob_placement(Ok(()), &follower, variant, &target).unwrap();

        assert_eq!(leader_asset.id, "gloopy-1");
        assert_eq!(follower_asset.id, "gloopy-2");
        assert_eq!(leader_asset.path, follower_asset.path);
        assert_eq!(leader_asset.mime_type, follower_asset.mime_type);
    }

    #[test]
    fn catalogs_reject_incompatible_shared_blob_metadata() {
        let mut catalog = valid_catalog(b"shared-bytes");
        let mut incompatible = webm_variant(&catalog).clone();
        incompatible.byte_size += 1;
        add_second_avatar(&mut catalog, incompatible);

        assert!(validate_catalog(&catalog)
            .unwrap_err()
            .contains("sharing a blob"));
    }

    #[test]
    fn changed_content_and_extensions_use_distinct_blobs() {
        let paths = cache_paths_for_root(PathBuf::from("/tmp/avatars"));
        let before = variant("webm/gloopies/gloopy-1.webm", b"before");
        let after = variant("webm/gloopies/gloopy-1.webm", b"after");
        let same_bytes_mp4 = variant("hevc/gloopies/gloopy-1.mp4", b"before");

        assert_ne!(
            media_blob_path(&paths, &before).unwrap(),
            media_blob_path(&paths, &after).unwrap()
        );
        assert_ne!(
            inflight_key(&before).unwrap(),
            inflight_key(&after).unwrap()
        );
        assert_ne!(
            media_blob_path(&paths, &before).unwrap(),
            media_blob_path(&paths, &same_bytes_mp4).unwrap()
        );
        assert_ne!(
            inflight_key(&before).unwrap(),
            inflight_key(&same_bytes_mp4).unwrap()
        );
    }

    #[test]
    fn clean_part_files_removes_only_stale_orphans() {
        let (_dir, paths) = temp_paths();
        let media_dir = paths.media.join("v1/webm/gloopies");
        fs::create_dir_all(&media_dir).unwrap();
        let part = media_dir.join("gloopy-1.webm.123.456.part");
        fs::write(&part, b"partial").unwrap();

        // A freshly written part file may belong to an in-flight download (which
        // now holds no lock), so cleanup must leave it alone.
        clean_part_files(&paths).unwrap();
        assert!(part.exists());

        // Once it is older than the stale threshold it is an orphan from a
        // crashed process and is safe to remove.
        let future = SystemTime::now() + PART_FILE_STALE_AGE + Duration::from_secs(1);
        clean_part_files_under(&paths.media, future).unwrap();
        assert!(!part.exists());
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

        assert_eq!(
            cached_avatar_for_id_with_format(&paths, &catalog, "gloopy-1", "webm")
                .unwrap()
                .unwrap()
                .asset
                .id,
            "gloopy-1"
        );
        assert!(
            cached_collection_assets(&paths, &catalog, &catalog.collections[0], "webm")
                .unwrap()
                .is_none()
        );
        assert_eq!(
            valid_cached_asset(entry, variant, &target)
                .unwrap()
                .unwrap()
                .id,
            "gloopy-1"
        );
    }

    #[test]
    fn cached_avatar_pairs_video_with_its_matching_poster() {
        let video_bytes = b"avatar-bytes";
        let poster_bytes = b"poster-bytes";
        let mut catalog = valid_catalog(video_bytes);
        add_poster(&mut catalog, poster_bytes);
        let (_dir, paths) = temp_paths();
        write_cached_webm(&paths, &catalog, video_bytes);
        let poster = catalog.assets[0].variants.poster.as_ref().unwrap();
        let poster_target = media_blob_path(&paths, poster).unwrap();
        fs::create_dir_all(poster_target.parent().unwrap()).unwrap();
        fs::write(&poster_target, poster_bytes).unwrap();

        let cached = cached_avatar_for_id_with_format(&paths, &catalog, "gloopy-1", "webm")
            .unwrap()
            .unwrap();

        assert_eq!(cached.asset.mime_type, "video/webm");
        assert_eq!(
            cached.asset.poster_path.as_deref(),
            Some(poster_target.to_string_lossy().as_ref()),
        );
    }

    #[tokio::test]
    async fn paired_ensure_reports_missing_poster_as_retryable() {
        let video_bytes = b"avatar-bytes";
        let mut catalog = valid_catalog(video_bytes);
        add_poster(&mut catalog, b"poster-bytes");
        catalog.assets[0].variants.poster.as_mut().unwrap().path = "../gloopy-1.png".to_string();
        let (_dir, paths) = temp_paths();
        write_cached_webm(&paths, &catalog, video_bytes);

        let (asset, error_code) = ensure_avatar_media(
            &asset_http_client().unwrap(),
            &paths,
            &catalog,
            &catalog.assets[0],
            "webm",
        )
        .await
        .unwrap();

        assert_eq!(asset.mime_type, "video/webm");
        assert_eq!(error_code, Some(AvatarErrorCode::Unavailable));
    }

    #[tokio::test]
    async fn paired_ensure_reports_missing_video_as_retryable() {
        let poster_bytes = b"poster-bytes";
        let mut catalog = valid_catalog(b"avatar-bytes");
        add_poster(&mut catalog, poster_bytes);
        catalog.assets[0].variants.webm.as_mut().unwrap().sha256 = "not-a-sha".to_string();
        let (_dir, paths) = temp_paths();
        let poster = catalog.assets[0].variants.poster.as_ref().unwrap();
        let poster_target = media_blob_path(&paths, poster).unwrap();
        fs::create_dir_all(poster_target.parent().unwrap()).unwrap();
        fs::write(&poster_target, poster_bytes).unwrap();

        let (asset, error_code) = ensure_avatar_media(
            &asset_http_client().unwrap(),
            &paths,
            &catalog,
            &catalog.assets[0],
            "webm",
        )
        .await
        .unwrap();

        assert_eq!(asset.mime_type, "image/png");
        assert_eq!(error_code, Some(AvatarErrorCode::Unavailable));
    }

    #[test]
    fn cached_avatar_uses_matching_poster_when_video_is_unavailable() {
        let mut catalog = valid_catalog(b"avatar-bytes");
        add_poster(&mut catalog, b"poster-bytes");
        let (_dir, paths) = temp_paths();
        let poster = catalog.assets[0].variants.poster.as_ref().unwrap();
        let poster_target = media_blob_path(&paths, poster).unwrap();
        fs::create_dir_all(poster_target.parent().unwrap()).unwrap();
        fs::write(&poster_target, b"poster-bytes").unwrap();

        let cached = cached_avatar_for_id_with_format(&paths, &catalog, "gloopy-1", "webm")
            .unwrap()
            .unwrap();

        assert_eq!(cached.asset.mime_type, "image/png");
        assert_eq!(cached.asset.path, poster_target.to_string_lossy());
        assert!(cached.asset.poster_path.is_none());
    }

    #[test]
    fn cached_avatar_batch_keeps_invalid_refs_isolated() {
        let bytes = b"avatar-bytes";
        let catalog = valid_catalog(bytes);
        let (_dir, paths) = temp_paths();
        write_cached_webm(&paths, &catalog, bytes);

        let cached = cached_avatars_for_parsed_refs_with_format(
            &paths,
            &catalog,
            vec![
                (
                    "app-avatar:gloopy-1".to_string(),
                    Some("gloopy-1".to_string()),
                ),
                ("app-avatar:../gloopy-1".to_string(), None),
            ],
            "webm",
        )
        .unwrap();

        assert_eq!(
            cached
                .get("app-avatar:gloopy-1")
                .and_then(|avatar| avatar.as_ref())
                .unwrap()
                .asset
                .id,
            "gloopy-1"
        );
        assert!(cached.get("app-avatar:../gloopy-1").unwrap().is_none());
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

        let (assets, failed, error_code) =
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
        assert_eq!(error_code, Some(AvatarErrorCode::Unavailable));
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
            &asset_http_client().unwrap(),
            Url::parse(&format!("http://{addr}/avatar.webm")).unwrap(),
            &target,
            &variant,
        )
        .await
        .unwrap_err();

        server.await.unwrap();
        assert!(error.to_string().contains("exceeded"));
        assert!(!target.exists());
        assert_eq!(fs::read_dir(target.parent().unwrap()).unwrap().count(), 0);
    }

    #[test]
    fn pruning_keeps_referenced_blobs_and_removes_legacy_media() {
        let (_dir, paths) = temp_paths();
        let mut v1 = valid_catalog(b"old-avatar");
        add_poster(&mut v1, b"old-poster");
        let mut v2 = valid_catalog(b"previous-avatar");
        v2.catalog_version = "v2".to_string();
        add_poster(&mut v2, b"previous-poster");
        let mut v3 = valid_catalog(b"current-avatar");
        v3.catalog_version = "v3".to_string();
        add_poster(&mut v3, b"current-poster");
        for catalog in [&v1, &v2, &v3] {
            let target = paths
                .meta
                .join(&catalog.catalog_version)
                .join(MANIFEST_FILE);
            atomic_write(&target, &serde_json::to_vec(catalog).unwrap()).unwrap();
        }

        for catalog in [&v1, &v2, &v3] {
            for variant in [
                catalog.assets[0].variants.webm.as_ref().unwrap(),
                catalog.assets[0].variants.hevc.as_ref().unwrap(),
                catalog.assets[0].variants.poster.as_ref().unwrap(),
            ] {
                let path = media_blob_path(&paths, variant).unwrap();
                fs::create_dir_all(path.parent().unwrap()).unwrap();
                fs::write(path, vec![b'x'; variant.byte_size as usize]).unwrap();
            }
        }
        let legacy_variant = webm_variant(&v2);
        let legacy_path = paths.media.join("v2").join(&legacy_variant.path);
        fs::create_dir_all(legacy_path.parent().unwrap()).unwrap();
        fs::write(&legacy_path, b"previous-avatar").unwrap();
        let migrated_blob = media_blob_path(&paths, legacy_variant).unwrap();
        fs::write(&migrated_blob, vec![b'x'; b"previous-avatar".len()]).unwrap();

        prune_obsolete_versions(&paths, "v3").unwrap();

        assert!(!paths.meta.join("v1").exists());
        assert!(paths.meta.join("v2").exists());
        assert!(paths.meta.join("v3").exists());
        assert!(!media_blob_path(&paths, webm_variant(&v1)).unwrap().exists());
        assert!(migrated_blob.exists());
        assert_eq!(fs::read(&migrated_blob).unwrap(), b"previous-avatar");
        assert!(media_blob_path(&paths, webm_variant(&v3)).unwrap().exists());
        assert!(
            media_blob_path(&paths, v3.assets[0].variants.poster.as_ref().unwrap())
                .unwrap()
                .exists(),
        );
        assert!(!paths.media.join("v2").exists());
    }

    #[test]
    fn pruning_skips_corrupt_candidates_and_keeps_previous_valid_manifest() {
        let (_dir, paths) = temp_paths();
        let previous = valid_catalog(b"previous-avatar");
        let mut current = valid_catalog(b"current-avatar");
        current.catalog_version = "v4".to_string();
        for catalog in [&previous, &current] {
            atomic_write(
                &paths
                    .meta
                    .join(&catalog.catalog_version)
                    .join(MANIFEST_FILE),
                &serde_json::to_vec(catalog).unwrap(),
            )
            .unwrap();
        }
        fs::create_dir_all(paths.meta.join("v3")).unwrap();
        fs::write(paths.meta.join("v3").join(MANIFEST_FILE), b"{").unwrap();

        let variant = webm_variant(&previous);
        let legacy = paths.media.join("v1").join(&variant.path);
        fs::create_dir_all(legacy.parent().unwrap()).unwrap();
        fs::write(&legacy, b"previous-avatar").unwrap();
        prune_obsolete_versions(&paths, "v4").unwrap();

        assert!(paths.meta.join("v1").exists());
        assert!(!paths.meta.join("v3").exists());
        assert!(paths.meta.join("v4").exists());
        assert_eq!(
            fs::read(media_blob_path(&paths, variant).unwrap()).unwrap(),
            b"previous-avatar"
        );
        assert!(!paths.media.join("v1").exists());
    }

    #[test]
    fn pruning_skips_corrupt_legacy_media_without_blocking_the_catalog() {
        let bytes = b"avatar-bytes";
        let catalog = valid_catalog(bytes);
        let (_dir, paths) = temp_paths();
        let manifest = paths.meta.join("v1").join(MANIFEST_FILE);
        atomic_write(&manifest, &serde_json::to_vec(&catalog).unwrap()).unwrap();

        let variant = webm_variant(&catalog);
        let legacy = paths.media.join("v1").join(&variant.path);
        fs::create_dir_all(legacy.parent().unwrap()).unwrap();
        fs::write(&legacy, vec![b'x'; bytes.len()]).unwrap();
        prune_obsolete_versions(&paths, "v1").unwrap();

        assert!(!legacy.exists());
        assert!(!media_blob_path(&paths, variant).unwrap().exists());
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
        std::env::remove_var("BERD_AVATAR_DOWNLOAD_CONCURRENCY");
        assert_eq!(avatar_download_concurrency(), 8);
        std::env::set_var("BERD_AVATAR_DOWNLOAD_CONCURRENCY", "2");
        assert_eq!(avatar_download_concurrency(), 2);
        std::env::set_var("BERD_AVATAR_DOWNLOAD_CONCURRENCY", "0");
        assert_eq!(avatar_download_concurrency(), 8);
        std::env::remove_var("BERD_AVATAR_DOWNLOAD_CONCURRENCY");
    }

    #[test]
    fn metadata_timeout_constants_are_short_and_assets_keep_long_timeout() {
        assert_eq!(METADATA_CONNECT_TIMEOUT, Duration::from_secs(3));
        assert_eq!(METADATA_REQUEST_TIMEOUT, Duration::from_secs(10));
        assert_eq!(ASSET_CONNECT_TIMEOUT, Duration::from_secs(3));
        assert_eq!(ASSET_DOWNLOAD_TIMEOUT, Duration::from_secs(60));
    }

    #[tokio::test]
    async fn metadata_request_errors_are_classified() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        drop(listener);
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_millis(200))
            .timeout(Duration::from_millis(200))
            .build()
            .unwrap();

        let error = client
            .get(format!("http://{addr}/latest.json"))
            .send()
            .await
            .unwrap_err();

        assert_eq!(
            classify_metadata_request_error(&error),
            AvatarErrorCode::NetworkAccess
        );

        let error = reqwest::Client::new()
            .get("http://127.0.0.1/latest.json")
            .header("x-test", "line\nbreak")
            .send()
            .await
            .unwrap_err();

        assert_eq!(
            classify_metadata_request_error(&error),
            AvatarErrorCode::Unavailable
        );
    }

    #[test]
    fn metadata_http_errors_are_unavailable() {
        for status in [
            StatusCode::FOUND,
            StatusCode::UNAUTHORIZED,
            StatusCode::FORBIDDEN,
            StatusCode::PROXY_AUTHENTICATION_REQUIRED,
            StatusCode::INTERNAL_SERVER_ERROR,
        ] {
            assert_eq!(
                metadata_status_error("avatar metadata", status).code,
                AvatarErrorCode::Unavailable,
                "{status}"
            );
        }
    }

    #[test]
    fn parse_and_validation_failures_map_to_unavailable() {
        assert_eq!(
            AvatarCommandError::unavailable("Failed to parse avatar catalog: expected value").code,
            AvatarErrorCode::Unavailable
        );

        let mut catalog = valid_catalog(b"avatar-bytes");
        catalog.schema_version = 2;
        let error = validate_catalog(&catalog).unwrap_err();
        assert_eq!(
            AvatarCommandError::from(error).code,
            AvatarErrorCode::Unavailable
        );
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

    #[tokio::test]
    async fn paired_avatar_ensure_stays_inside_the_clear_guard() {
        let video_bytes = b"avatar-bytes";
        let poster_bytes = b"poster-bytes";
        let mut catalog = valid_catalog(video_bytes);
        add_poster(&mut catalog, poster_bytes);
        let (_dir, paths) = temp_paths();
        write_cached_webm(&paths, &catalog, video_bytes);
        let poster = catalog.assets[0].variants.poster.as_ref().unwrap();
        let poster_target = media_blob_path(&paths, poster).unwrap();
        fs::create_dir_all(poster_target.parent().unwrap()).unwrap();
        fs::write(&poster_target, poster_bytes).unwrap();

        let clear = download_guard().write().await;
        let task_paths = paths.clone();
        let task_catalog = catalog.clone();
        let task = tokio::spawn(async move {
            let client = asset_http_client().unwrap();
            ensure_avatar_media(
                &client,
                &task_paths,
                &task_catalog,
                &task_catalog.assets[0],
                "webm",
            )
            .await
        });
        tokio::task::yield_now().await;
        assert!(
            !task.is_finished(),
            "paired media resolution must wait while cache clear owns the guard",
        );

        drop(clear);
        let (asset, error_code) = task.await.unwrap().unwrap();
        assert_eq!(asset.mime_type, "video/webm");
        assert_eq!(
            asset.poster_path.as_deref(),
            Some(poster_target.to_string_lossy().as_ref())
        );
        assert_eq!(error_code, None);
    }

    #[tokio::test]
    async fn clear_waits_for_in_flight_downloads() {
        // A held read guard models an in-flight download; the exclusive write
        // guard that clear_avatar_cache takes must not be grantable until the
        // download releases it, so a clear cannot wipe the cache dirs while a
        // download is still placing files.
        let download = download_guard().read().await;
        assert!(
            download_guard().try_write().is_err(),
            "clear must not proceed while a download holds the guard"
        );

        drop(download);
        assert!(
            download_guard().try_write().is_ok(),
            "clear may proceed once in-flight downloads release the guard"
        );
    }

    #[tokio::test]
    async fn deduped_follower_preserves_leader_error_code() {
        // A follower subscribes to the blob leader's channel and preserves the
        // full error code so concurrent requests receive the same recovery hint.
        let (tx, _) = broadcast::channel::<InflightResult>(1);
        let mut follower = tx.subscribe();

        tx.send(Err(AvatarAssetError {
            code: AvatarErrorCode::NetworkAccess,
            detail: "connect to WARP".to_string(),
        }))
        .unwrap();

        // Mirrors the follower arm in ensure_entry_deduped_without_download_guard.
        let error = match follower.recv().await {
            Ok(Ok(())) => panic!("expected the leader's error, not success"),
            Ok(Err(error)) => error,
            Err(error) => panic!("unexpected channel error: {error}"),
        };
        assert_eq!(error.code, AvatarErrorCode::NetworkAccess);
        assert_eq!(error.detail, "connect to WARP");
    }
}
