use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use futures_util::{stream, StreamExt};
use reqwest::{StatusCode, Url};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::future::Future;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
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
const AVATAR_REFRESH_INTERVAL: Duration = Duration::from_secs(12 * 60 * 60);
const AVATAR_REFRESH_RETRY_BASE: Duration = Duration::from_secs(30);
const AVATAR_REFRESH_RETRY_MAX: Duration = Duration::from_secs(30 * 60);
const METADATA_CONNECT_TIMEOUT: Duration = Duration::from_secs(3);
const METADATA_REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
const ASSET_CONNECT_TIMEOUT: Duration = Duration::from_secs(3);
const ASSET_DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(60);
const DEFAULT_DOWNLOAD_CONCURRENCY: usize = 8;
const MAX_IMPORTED_AVATAR_BYTES: usize = 5 * 1024 * 1024;
const MAX_IMPORTED_POSTER_BYTES: usize = 5 * 1024 * 1024;
const PNG_SIGNATURE: &[u8; 8] = b"\x89PNG\r\n\x1a\n";
const WEBM_SIGNATURE: &[u8; 4] = b"\x1a\x45\xdf\xa3";
const MP4_FILE_TYPE_BOX: &[u8; 4] = b"ftyp";
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
    pub media_refreshing: bool,
    pub media_refresh_completed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub media_error_code: Option<AvatarErrorCode>,
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
pub struct CachedAvatarAnimation {
    pub bytes: Vec<u8>,
    pub mime_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub alpha_mode: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AvatarCacheWarmedPayload {
    avatar_refs: Vec<String>,
}

#[derive(Debug, Clone, Copy, Default)]
struct AvatarRefreshStatus {
    active_refreshes: usize,
    completed: bool,
    error_code: Option<AvatarErrorCode>,
}

impl AvatarRefreshStatus {
    fn snapshot(self) -> (bool, bool, Option<AvatarErrorCode>) {
        (self.active_refreshes > 0, self.completed, self.error_code)
    }

    fn complete(&mut self, result: &AvatarCommandResult<AvatarRefreshResult>) {
        self.active_refreshes = self.active_refreshes.saturating_sub(1);
        self.completed = true;
        self.error_code = match result {
            Ok(result) => result.error_code,
            Err(error) => Some(error.code),
        };
    }
}

struct AvatarRefreshResult {
    cached: usize,
    failed: usize,
    error_code: Option<AvatarErrorCode>,
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

fn dominant_avatar_error_code(
    current: Option<AvatarErrorCode>,
    candidate: Option<AvatarErrorCode>,
) -> Option<AvatarErrorCode> {
    match (current, candidate) {
        (Some(AvatarErrorCode::NetworkAccess), _) | (_, Some(AvatarErrorCode::NetworkAccess)) => {
            Some(AvatarErrorCode::NetworkAccess)
        }
        (Some(AvatarErrorCode::Unavailable), _) | (_, Some(AvatarErrorCode::Unavailable)) => {
            Some(AvatarErrorCode::Unavailable)
        }
        (None, None) => None,
    }
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

    fn classified(code: AvatarErrorCode, raw: impl AsRef<str>) -> Self {
        match code {
            AvatarErrorCode::NetworkAccess => Self::network_access(raw),
            AvatarErrorCode::Unavailable => Self::unavailable(raw),
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    poster_path: Option<String>,
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
        read_cached_catalog(&paths)?
    };
    let catalog = match catalog {
        Some(catalog) => catalog,
        None => {
            // The scheduler owns stale refreshes. Snapshot reads must not launch
            // metadata-only generations that can race a clear or full refresh.
            // A cold-cache fetch is still required to render the library, so it
            // joins the same whole-generation coordinator and rechecks after
            // waiting in case another refresh populated the catalog.
            coordinate_avatar_cache_operation(async {
                let _catalog_guard = catalog_lock().lock().await;
                if let Some(catalog) = read_cached_catalog(&paths)? {
                    return Ok::<AvatarCatalog, AvatarCommandError>(catalog);
                }
                let catalog = refresh_cached_catalog(&paths).await?;
                prune_obsolete_versions(&paths, &catalog.catalog_version)?;
                Ok(catalog)
            })
            .await?
        }
    };

    // Reading cached collections only inspects atomically-placed files, so it
    // does not need the catalog lock.
    let mut cached_collections = cached_collections_for_catalog(&paths, &catalog)?;
    // User-generated gloopies are local library citizens: they ride the same
    // snapshot so the picker and the collection gallery see one source of
    // truth, stamped with the user catalog version instead of the published
    // catalog's version.
    if let Some(user_collection) = user_avatar_cached_collection(&app) {
        cached_collections.push(user_collection);
    }
    let (media_refreshing, media_refresh_completed, media_error_code) =
        avatar_refresh_status().lock().unwrap().snapshot();
    Ok(AvatarLibrarySnapshot {
        catalog,
        cached_collections,
        media_refreshing,
        media_refresh_completed,
        media_error_code,
    })
}

#[tauri::command]
pub async fn read_cached_avatar_animation(
    app: AppHandle,
    avatar_ref: String,
) -> Result<Option<CachedAvatarAnimation>, String> {
    let cached = get_cached_avatar_for_ref(app, avatar_ref).await?;
    let Some(cached) = cached else {
        return Ok(None);
    };
    read_cached_avatar_animation_asset(cached.asset)
}

fn read_cached_avatar_animation_asset(
    asset: CachedAvatarAsset,
) -> Result<Option<CachedAvatarAnimation>, String> {
    if !matches!(asset.mime_type.as_str(), "video/webm" | "video/mp4") {
        return Ok(None);
    }
    let metadata = fs::metadata(&asset.path)
        .map_err(|error| format!("Failed to inspect cached avatar animation: {error}"))?;
    if metadata.len() == 0 || metadata.len() > MAX_IMPORTED_AVATAR_BYTES as u64 {
        return Ok(None);
    }
    let bytes = fs::read(&asset.path)
        .map_err(|error| format!("Failed to read cached avatar animation: {error}"))?;
    // Recheck the actual payload after reading; metadata is only an early exit
    // and the cache file could be replaced between the stat and read calls.
    if bytes.is_empty() || bytes.len() > MAX_IMPORTED_AVATAR_BYTES {
        return Ok(None);
    }
    if validate_imported_avatar_signature(&bytes, &asset.mime_type).is_err() {
        return Ok(None);
    }
    Ok(Some(CachedAvatarAnimation {
        bytes,
        mime_type: asset.mime_type,
        alpha_mode: asset.alpha_mode,
    }))
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
pub async fn import_user_avatar_data_url(
    app: AppHandle,
    data_url: String,
    alpha_mode: Option<String>,
    poster_data_url: Option<String>,
) -> Result<String, String> {
    let (bytes, mime_type) = decode_imported_avatar_data_url(&data_url)?;
    let poster = poster_data_url
        .as_deref()
        .map(decode_imported_poster_data_url)
        .transpose()?;
    write_user_avatar_with_poster(
        &app,
        &bytes,
        mime_type,
        alpha_mode.as_deref(),
        poster.as_deref().map(|bytes| (bytes, "image/png")),
    )
}

fn decode_imported_avatar_data_url(data_url: &str) -> Result<(Vec<u8>, &'static str), String> {
    const WEBM_PREFIX: &str = "data:video/webm;base64,";
    const MP4_PREFIX: &str = "data:video/mp4;base64,";
    let (mime_type, encoded) = data_url
        .strip_prefix(WEBM_PREFIX)
        .map(|encoded| ("video/webm", encoded))
        .or_else(|| {
            data_url
                .strip_prefix(MP4_PREFIX)
                .map(|encoded| ("video/mp4", encoded))
        })
        .ok_or_else(|| "Imported avatar animation has an unsupported format".to_string())?;
    let decoded_size = decoded_base64_len(encoded)
        .ok_or_else(|| "Imported avatar animation contains invalid base64".to_string())?;
    if decoded_size == 0 || decoded_size > MAX_IMPORTED_AVATAR_BYTES {
        return Err("Imported avatar animation must be 5 MB or smaller".to_string());
    }
    let bytes = BASE64
        .decode(encoded)
        .map_err(|_| "Imported avatar animation contains invalid base64".to_string())?;
    validate_imported_avatar_signature(&bytes, mime_type)?;
    Ok((bytes, mime_type))
}

fn decoded_base64_len(encoded: &str) -> Option<usize> {
    if encoded.is_empty() || !encoded.len().is_multiple_of(4) {
        return None;
    }
    let padding = encoded
        .as_bytes()
        .iter()
        .rev()
        .take_while(|&&byte| byte == b'=')
        .count();
    if padding > 2 {
        return None;
    }
    encoded
        .len()
        .checked_div(4)?
        .checked_mul(3)?
        .checked_sub(padding)
}

fn validate_imported_avatar_signature(bytes: &[u8], mime_type: &str) -> Result<(), String> {
    let valid = match mime_type {
        "video/webm" => bytes.starts_with(WEBM_SIGNATURE),
        // ISO BMFF files begin with a sized box; imported MP4 must identify its
        // first box as the mandatory file-type box.
        "video/mp4" => bytes.get(4..8) == Some(MP4_FILE_TYPE_BOX.as_slice()),
        _ => false,
    };
    if valid {
        Ok(())
    } else {
        Err(format!(
            "Imported avatar animation is not a valid {} file",
            mime_type.strip_prefix("video/").unwrap_or("video")
        ))
    }
}

fn decode_imported_poster_data_url(data_url: &str) -> Result<Vec<u8>, String> {
    const PNG_PREFIX: &str = "data:image/png;base64,";
    let encoded = data_url
        .strip_prefix(PNG_PREFIX)
        .ok_or_else(|| "Imported avatar poster has an unsupported format".to_string())?;
    let max_encoded_len = MAX_IMPORTED_POSTER_BYTES.div_ceil(3) * 4;
    if encoded.is_empty() || encoded.len() > max_encoded_len {
        return Err("Imported avatar poster must be 5 MB or smaller".to_string());
    }
    let bytes = BASE64
        .decode(encoded)
        .map_err(|_| "Imported avatar poster contains invalid base64".to_string())?;
    if bytes.is_empty() || bytes.len() > MAX_IMPORTED_POSTER_BYTES {
        return Err("Imported avatar poster must be 5 MB or smaller".to_string());
    }
    if !bytes.starts_with(PNG_SIGNATURE) {
        return Err("Imported avatar poster is not a valid PNG".to_string());
    }
    Ok(bytes)
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
    let poster_path = manifest
        .poster_path
        .as_deref()
        .map(|relative_path| paths.media.join(relative_path));
    delete_file_if_exists(&media_path)?;
    if let Some(poster_path) = poster_path {
        delete_file_if_exists(&poster_path)?;
    }
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

pub fn spawn_avatar_cache_refresh(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut consecutive_failures = 0;
        loop {
            let delay = match tracked_avatar_cache_refresh(app.clone()).await {
                Ok(AvatarRefreshResult {
                    cached, failed: 0, ..
                }) => {
                    consecutive_failures = 0;
                    log::info!("Avatar asset refresh completed: {cached} cached");
                    AVATAR_REFRESH_INTERVAL
                }
                Ok(AvatarRefreshResult { cached, failed, .. }) => {
                    consecutive_failures += 1;
                    let delay = avatar_refresh_retry_delay(consecutive_failures);
                    log::warn!(
                        "Avatar asset refresh degraded: {cached} cached, {failed} failed; retrying in {delay:?}"
                    );
                    delay
                }
                Err(error) => {
                    consecutive_failures += 1;
                    let delay = avatar_refresh_retry_delay(consecutive_failures);
                    log::warn!(
                        "Failed to refresh avatar asset cache: {error}; retrying in {delay:?}"
                    );
                    delay
                }
            };

            tokio::time::sleep(delay).await;
        }
    });
}

fn avatar_refresh_retry_delay(consecutive_failures: u32) -> Duration {
    let exponent = consecutive_failures.saturating_sub(1).min(6);
    AVATAR_REFRESH_RETRY_BASE
        .saturating_mul(1 << exponent)
        .min(AVATAR_REFRESH_RETRY_MAX)
}

#[tauri::command]
pub async fn refresh_avatar_cache(app: AppHandle) -> AvatarCommandResult<()> {
    let result = tracked_avatar_cache_refresh(app).await?;
    if result.failed == 0 {
        Ok(())
    } else {
        Err(AvatarCommandError::classified(
            result.error_code.unwrap_or(AvatarErrorCode::Unavailable),
            format!("{} avatar assets failed to cache", result.failed),
        ))
    }
}

fn avatar_refresh_status() -> &'static Mutex<AvatarRefreshStatus> {
    static STATUS: OnceLock<Mutex<AvatarRefreshStatus>> = OnceLock::new();
    STATUS.get_or_init(|| Mutex::new(AvatarRefreshStatus::default()))
}

/// Serializes complete cache refresh generations and cache clears.
///
/// The narrower catalog and download locks protect individual filesystem
/// operations. They cannot prevent one refresh from resuming between another
/// refresh's collections or after a clear. This coordinator owns that lifecycle
/// boundary: a refresh holds it from metadata fetch through final pruning, and
/// a clear holds it until both cache roots are gone.
fn avatar_refresh_coordinator() -> &'static tokio::sync::Mutex<()> {
    static COORDINATOR: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    COORDINATOR.get_or_init(|| tokio::sync::Mutex::new(()))
}

async fn coordinate_avatar_cache_operation<T>(operation: impl Future<Output = T>) -> T {
    let _refresh_guard = avatar_refresh_coordinator().lock().await;
    operation.await
}

async fn tracked_avatar_cache_refresh(app: AppHandle) -> AvatarCommandResult<AvatarRefreshResult> {
    {
        let mut status = avatar_refresh_status().lock().unwrap();
        status.active_refreshes += 1;
    }

    let result = coordinate_avatar_cache_operation(refresh_all_avatar_assets(&app)).await;
    {
        avatar_refresh_status().lock().unwrap().complete(&result);
    }

    let avatar_refs = result
        .as_ref()
        .map(|result| result.avatar_refs.clone())
        .unwrap_or_default();
    if let Err(error) = app.emit(
        AVATAR_CACHE_WARMED_EVENT,
        AvatarCacheWarmedPayload { avatar_refs },
    ) {
        log::warn!("Failed to emit avatar cache refresh event: {error}");
    }
    result
}

async fn refresh_all_avatar_assets(app: &AppHandle) -> AvatarCommandResult<AvatarRefreshResult> {
    let paths = avatar_cache_paths(app)?;
    let catalog = {
        let _catalog_guard = catalog_lock().lock().await;
        clean_part_files(&paths)?;
        let catalog = refresh_cached_catalog(&paths).await?;
        prepare_legacy_media(&paths, &catalog.catalog_version)?;
        catalog
    };

    let mut downloaded = 0;
    let mut failed = 0;
    let mut error_code = None;
    for collection in &catalog.collections {
        let (assets, failed_asset_ids, collection_error_code) =
            ensure_collection_assets(&paths, &catalog, collection, platform_avatar_format())
                .await?;
        downloaded += assets.len();
        failed += failed_asset_ids.len();
        error_code = dominant_avatar_error_code(error_code, collection_error_code);
    }

    {
        let _catalog_guard = catalog_lock().lock().await;
        prune_obsolete_versions(&paths, &catalog.catalog_version)?;
    }

    let avatar_refs = catalog
        .assets
        .iter()
        .map(|entry| format!("{APP_AVATAR_REF_PREFIX}{}", entry.id))
        .collect();
    Ok(AvatarRefreshResult {
        cached: downloaded,
        failed,
        error_code,
        avatar_refs,
    })
}

pub async fn clear_avatar_cache(app: AppHandle) -> Result<(), String> {
    let paths = avatar_cache_paths(&app)?;
    clear_avatar_cache_and_then(&paths, move || {
        // Clearing is an explicit request to rebuild from a clean state. Do not
        // leave recovery to the scheduler's current (potentially 12-hour) sleep.
        tauri::async_runtime::spawn(async move {
            if let Err(error) = tracked_avatar_cache_refresh(app).await {
                log::warn!("Failed to refresh avatar asset cache after clear: {error}");
            }
        });
    })
    .await
}

async fn clear_avatar_cache_and_then(
    paths: &AvatarCachePaths,
    after_clear: impl FnOnce(),
) -> Result<(), String> {
    clear_avatar_cache_paths_coordinated(paths).await?;
    after_clear();
    Ok(())
}

async fn clear_avatar_cache_paths_coordinated(paths: &AvatarCachePaths) -> Result<(), String> {
    // Lock order is refresh coordinator -> catalog -> downloads everywhere.
    // The outer guard waits for the current generation to finish and prevents
    // queued refreshes from starting until the clear has fully removed both
    // roots. The narrower guards preserve safety for non-refresh cache users.
    coordinate_avatar_cache_operation(async {
        let _catalog_guard = catalog_lock().lock().await;
        let _download_guard = download_guard().write().await;
        clear_avatar_cache_paths(paths).await
    })
    .await
}

async fn clear_avatar_cache_paths(paths: &AvatarCachePaths) -> Result<(), String> {
    remove_dir_all_if_exists(&paths.meta, "avatar metadata").await?;
    remove_dir_all_if_exists(&paths.media, "avatar media").await
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
                if poster_error_code.is_some() {
                    failed_asset_ids.push(asset.id.clone());
                    error_code = dominant_avatar_error_code(error_code, poster_error_code);
                }
                assets.push(asset);
            }
            Err((id, code)) => {
                failed_asset_ids.push(id);
                error_code = dominant_avatar_error_code(error_code, Some(code));
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
    cached_collections_for_catalog_with_format(paths, catalog, platform_avatar_format())
}

fn cached_collections_for_catalog_with_format(
    paths: &AvatarCachePaths,
    catalog: &AvatarCatalog,
    format: &str,
) -> Result<Vec<CachedAvatarCollection>, String> {
    let mut cached_collections = Vec::new();
    for collection in &catalog.collections {
        let (assets, failed_asset_ids) =
            cached_collection_assets(paths, catalog, collection, format)?;
        if !assets.is_empty() {
            cached_collections.push(CachedAvatarCollection {
                catalog_version: catalog.catalog_version.clone(),
                collection_id: collection.id.clone(),
                assets,
                failed_asset_ids,
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
) -> Result<(Vec<CachedAvatarAsset>, Vec<String>), String> {
    let mut assets = Vec::new();
    let mut failed_asset_ids = Vec::new();

    for avatar_id in &collection.avatar_ids {
        let entry = catalog
            .assets
            .iter()
            .find(|entry| &entry.id == avatar_id)
            .ok_or_else(|| format!("Avatar asset not found: {avatar_id}"))?;
        let Some(asset) = cached_avatar_asset_for_entry(paths, entry, format)? else {
            failed_asset_ids.push(avatar_id.clone());
            continue;
        };
        assets.push(asset);
    }

    Ok((assets, failed_asset_ids))
}

fn cached_avatar_asset_for_entry(
    paths: &AvatarCachePaths,
    entry: &AvatarCatalogEntry,
    format: &str,
) -> Result<Option<CachedAvatarAsset>, String> {
    let poster = cached_poster_asset(paths, entry)?;
    let variant = variant_for_format(entry, format)?;
    let target = media_blob_path(paths, variant)?;
    // This runs on the lock-free snapshot read path, concurrently with
    // downloads that hold no catalog lock. Preserve whichever presentation is
    // already valid: a video without its poster and a poster without its video
    // are both usable while the missing counterpart retries.
    match valid_cached_asset(entry, variant, &target)? {
        Some(mut asset) => {
            asset.poster_path = poster.as_ref().map(|poster| poster.path.clone());
            Ok(Some(asset))
        }
        None => Ok(poster),
    }
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

pub(crate) fn write_user_avatar_with_poster(
    app: &AppHandle,
    bytes: &[u8],
    mime_type: &str,
    alpha_mode: Option<&str>,
    poster: Option<(&[u8], &str)>,
) -> Result<String, String> {
    let id = format!("gloopie-{}", Uuid::new_v4());
    let paths = user_avatar_paths(app)?;
    write_user_avatar_at(&paths, &id, bytes, mime_type, alpha_mode, poster)
}

fn write_user_avatar_at(
    paths: &UserAvatarPaths,
    id: &str,
    bytes: &[u8],
    mime_type: &str,
    alpha_mode: Option<&str>,
    poster: Option<(&[u8], &str)>,
) -> Result<String, String> {
    validate_user_avatar_alpha_mode(alpha_mode)?;
    validate_avatar_id(id)?;
    let extension = user_avatar_extension(mime_type)
        .ok_or_else(|| format!("Unsupported generated avatar media type: {mime_type}"))?;
    let poster_extension = poster
        .map(|(_, poster_mime_type)| {
            user_avatar_extension(poster_mime_type)
                .filter(|_| poster_mime_type.starts_with("image/"))
                .ok_or_else(|| "Unsupported generated avatar poster type".to_string())
        })
        .transpose()?;

    let media_relative_path = format!("{id}.{extension}");
    let media_path = paths.media.join(&media_relative_path);
    atomic_write(&media_path, bytes)?;

    let poster_relative_path = poster_extension.map(|extension| format!("{id}.poster.{extension}"));
    let poster_path = poster_relative_path
        .as_deref()
        .map(|relative_path| paths.media.join(relative_path));
    if let (Some((poster_bytes, _)), Some(poster_path)) = (poster, poster_path.as_ref()) {
        if let Err(error) = atomic_write(poster_path, poster_bytes) {
            rollback_user_avatar_files(&[&media_path]);
            return Err(error);
        }
    }

    let created_at_ms = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map_or(0, |duration| duration.as_millis());
    let manifest = UserAvatarManifest {
        id: id.to_string(),
        path: media_relative_path,
        mime_type: mime_type.to_string(),
        alpha_mode: alpha_mode.map(str::to_string),
        poster_path: poster_relative_path,
        byte_size: bytes.len() as u64,
        created_at_ms,
    };
    let result = serde_json::to_vec_pretty(&manifest)
        .map_err(|error| format!("Failed to serialize generated avatar manifest: {error}"))
        .and_then(|bytes| atomic_write(&paths.meta.join(format!("{id}.json")), &bytes));
    if let Err(error) = result {
        let mut written_paths: Vec<&Path> = vec![media_path.as_path()];
        if let Some(poster_path) = poster_path.as_ref() {
            written_paths.push(poster_path.as_path());
        }
        rollback_user_avatar_files(&written_paths);
        return Err(error);
    }

    Ok(format!("{USER_AVATAR_REF_PREFIX}{id}"))
}

fn rollback_user_avatar_files(paths: &[&Path]) {
    for path in paths {
        if let Err(error) = delete_file_if_exists(path) {
            log::warn!(
                "Failed to roll back generated avatar file '{}': {error}",
                path.display()
            );
        }
    }
}

/// Enumerates every user-generated gloopie on this machine as a cached
/// collection, so the avatar library snapshot can surface them alongside the
/// bundled catalog. Enumeration is best-effort: a corrupt or half-written
/// manifest skips that avatar instead of hiding the whole collection. A
/// machine with no gloopies yields an empty collection; browsing surfaces omit
/// it entirely.
fn user_avatar_cached_collection(app: &AppHandle) -> Option<CachedAvatarCollection> {
    let paths = user_avatar_paths(app).ok()?;
    user_avatar_cached_collection_at(&paths)
}

fn user_avatar_cached_collection_at(paths: &UserAvatarPaths) -> Option<CachedAvatarCollection> {
    let mut manifests: Vec<UserAvatarManifest> = Vec::new();
    if paths.meta.exists() {
        let entries = fs::read_dir(&paths.meta).ok()?;
        for entry in entries.flatten() {
            let file_name = entry.file_name();
            let Some(avatar_id) = file_name
                .to_str()
                .and_then(|name| name.strip_suffix(".json"))
            else {
                continue;
            };
            let Ok(manifest) = read_user_avatar_manifest(paths, avatar_id) else {
                log::warn!("Skipping unreadable user avatar manifest: {avatar_id}");
                continue;
            };
            let Ok(media_path) = user_avatar_media_path(paths, &manifest) else {
                continue;
            };
            if media_path.exists() {
                manifests.push(manifest);
            }
        }
    }
    // Newest first, so the collection reads as a timeline of what the user
    // made most recently; the id tiebreak keeps the order deterministic.
    manifests.sort_by(|left, right| {
        right
            .created_at_ms
            .cmp(&left.created_at_ms)
            .then_with(|| left.id.cmp(&right.id))
    });
    let assets = manifests
        .into_iter()
        .map(|manifest| CachedAvatarAsset {
            path: paths
                .media
                .join(&manifest.path)
                .to_string_lossy()
                .into_owned(),
            poster_path: manifest
                .poster_path
                .as_deref()
                .map(|poster| paths.media.join(poster).to_string_lossy().into_owned()),
            id: manifest.id,
            mime_type: manifest.mime_type,
            alpha_mode: manifest.alpha_mode,
        })
        .collect();
    Some(CachedAvatarCollection {
        catalog_version: USER_AVATAR_CATALOG_VERSION.to_string(),
        collection_id: USER_AVATAR_COLLECTION_ID.to_string(),
        assets,
        failed_asset_ids: Vec::new(),
        error_code: None,
    })
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
            poster_path: manifest
                .poster_path
                .map(|poster| paths.media.join(poster).to_string_lossy().to_string()),
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
    validate_user_avatar_manifest_paths(&manifest)?;
    if user_avatar_extension(&manifest.mime_type).is_none() {
        return Err("Generated avatar manifest has unsupported media type".to_string());
    }
    validate_user_avatar_alpha_mode(manifest.alpha_mode.as_deref())?;
    Ok(manifest)
}

fn validate_user_avatar_manifest_paths(manifest: &UserAvatarManifest) -> Result<(), String> {
    let extension = user_avatar_extension(&manifest.mime_type)
        .ok_or_else(|| "Generated avatar manifest has unsupported media type".to_string())?;
    let expected_media_path = format!("{}.{}", manifest.id, extension);
    if manifest.path != expected_media_path {
        return Err("Generated avatar manifest media path does not belong to its id".to_string());
    }
    validate_safe_relative_path(&manifest.path)?;

    if let Some(poster_path) = manifest.poster_path.as_deref() {
        validate_safe_relative_path(poster_path)?;
        let prefix = format!("{}.poster.", manifest.id);
        let poster_extension = poster_path.strip_prefix(&prefix);
        if !matches!(poster_extension, Some("png" | "jpg" | "webp")) {
            return Err(
                "Generated avatar manifest poster path does not belong to its id".to_string(),
            );
        }
    }
    Ok(())
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
            poster_path: None,
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

    fn imported_webm_data_url(size: usize) -> String {
        let mut bytes = vec![0; size];
        bytes[..WEBM_SIGNATURE.len()].copy_from_slice(WEBM_SIGNATURE);
        format!("data:video/webm;base64,{}", BASE64.encode(bytes))
    }

    #[test]
    fn cached_animation_reader_enforces_type_and_payload_bounds() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("avatar.webm");
        fs::write(&path, WEBM_SIGNATURE).unwrap();
        let asset = |mime_type: &str| CachedAvatarAsset {
            id: "gloopy-1".to_string(),
            path: path.to_string_lossy().into_owned(),
            mime_type: mime_type.to_string(),
            alpha_mode: Some("stacked".to_string()),
            poster_path: None,
        };

        let animation = read_cached_avatar_animation_asset(asset("video/webm"))
            .unwrap()
            .unwrap();
        assert_eq!(animation.bytes, WEBM_SIGNATURE);
        assert_eq!(animation.mime_type, "video/webm");
        assert_eq!(animation.alpha_mode.as_deref(), Some("stacked"));

        assert!(read_cached_avatar_animation_asset(asset("image/png"))
            .unwrap()
            .is_none());
        fs::write(&path, b"not webm").unwrap();
        assert!(read_cached_avatar_animation_asset(asset("video/webm"))
            .unwrap()
            .is_none());
        fs::write(&path, []).unwrap();
        assert!(read_cached_avatar_animation_asset(asset("video/webm"))
            .unwrap()
            .is_none());
        fs::write(&path, vec![0; MAX_IMPORTED_AVATAR_BYTES + 1]).unwrap();
        assert!(read_cached_avatar_animation_asset(asset("video/webm"))
            .unwrap()
            .is_none());
    }

    #[test]
    fn imported_avatar_limit_accounts_for_base64_padding_exactly() {
        for size in [MAX_IMPORTED_AVATAR_BYTES - 1, MAX_IMPORTED_AVATAR_BYTES] {
            let (bytes, mime_type) =
                decode_imported_avatar_data_url(&imported_webm_data_url(size)).unwrap();
            assert_eq!(bytes.len(), size);
            assert_eq!(mime_type, "video/webm");
        }

        let error =
            decode_imported_avatar_data_url(&imported_webm_data_url(MAX_IMPORTED_AVATAR_BYTES + 1))
                .unwrap_err();
        assert!(error.contains("5 MB or smaller"));
    }

    #[test]
    fn imported_avatar_requires_matching_webm_or_mp4_signature() {
        let disguised_webm = format!("data:video/webm;base64,{}", BASE64.encode(b"not webm"));
        assert!(decode_imported_avatar_data_url(&disguised_webm)
            .unwrap_err()
            .contains("valid webm"));

        let valid_mp4 = format!(
            "data:video/mp4;base64,{}",
            BASE64.encode(b"\0\0\0\x18ftypisom")
        );
        assert!(decode_imported_avatar_data_url(&valid_mp4).is_ok());

        let webm_as_mp4 = format!("data:video/mp4;base64,{}", BASE64.encode(WEBM_SIGNATURE));
        assert!(decode_imported_avatar_data_url(&webm_as_mp4)
            .unwrap_err()
            .contains("valid mp4"));
    }

    #[test]
    fn imported_poster_requires_png_data_url_and_signature() {
        let png = BASE64.encode([PNG_SIGNATURE.as_slice(), b"payload"].concat());
        assert!(decode_imported_poster_data_url(&format!("data:image/png;base64,{png}")).is_ok());

        let disguised = BASE64.encode(b"not a png");
        assert!(
            decode_imported_poster_data_url(&format!("data:image/png;base64,{disguised}"))
                .unwrap_err()
                .contains("not a valid PNG")
        );
        assert!(
            decode_imported_poster_data_url("data:image/jpeg;base64,AAAA")
                .unwrap_err()
                .contains("unsupported format")
        );
    }

    #[test]
    fn imported_poster_rejects_oversized_encoded_input_before_decode() {
        let encoded = "A".repeat(MAX_IMPORTED_POSTER_BYTES.div_ceil(3) * 4 + 1);
        assert!(
            decode_imported_poster_data_url(&format!("data:image/png;base64,{encoded}"))
                .unwrap_err()
                .contains("5 MB or smaller")
        );
    }

    #[test]
    fn imported_poster_rejects_oversized_decoded_input() {
        let mut bytes = vec![0; MAX_IMPORTED_POSTER_BYTES + 1];
        bytes[..PNG_SIGNATURE.len()].copy_from_slice(PNG_SIGNATURE);
        let encoded = BASE64.encode(bytes);
        assert!(
            decode_imported_poster_data_url(&format!("data:image/png;base64,{encoded}"))
                .unwrap_err()
                .contains("5 MB or smaller")
        );
    }

    #[test]
    fn user_avatar_collection_lists_gloopies_newest_first_and_skips_broken_entries() {
        let (_dir, paths) = temp_user_avatar_paths();

        // Older avatar.
        seed_user_avatar(&paths, "gloopie-old");
        // Newer avatar with a poster and stacked alpha.
        let newer_media = paths.media.join("gloopie-new.webm");
        fs::write(&newer_media, b"webm-bytes").unwrap();
        let poster = paths.media.join("gloopie-new.poster.png");
        fs::write(&poster, b"poster").unwrap();
        let manifest = UserAvatarManifest {
            id: "gloopie-new".to_string(),
            path: "gloopie-new.webm".to_string(),
            mime_type: "video/webm".to_string(),
            alpha_mode: Some("stacked".to_string()),
            poster_path: Some("gloopie-new.poster.png".to_string()),
            byte_size: 10,
            created_at_ms: 5,
        };
        fs::write(
            paths.meta.join("gloopie-new.json"),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();
        // Manifest without media on disk: excluded.
        let manifest = UserAvatarManifest {
            id: "gloopie-missing".to_string(),
            path: "gloopie-missing.png".to_string(),
            mime_type: "image/png".to_string(),
            alpha_mode: None,
            poster_path: None,
            byte_size: 1,
            created_at_ms: 9,
        };
        fs::write(
            paths.meta.join("gloopie-missing.json"),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();
        // Corrupt manifest: skipped, does not fail the collection.
        fs::write(paths.meta.join("gloopie-corrupt.json"), b"not json").unwrap();

        let collection = user_avatar_cached_collection_at(&paths).unwrap();

        assert_eq!(collection.collection_id, USER_AVATAR_COLLECTION_ID);
        assert_eq!(collection.catalog_version, USER_AVATAR_CATALOG_VERSION);
        assert!(collection.failed_asset_ids.is_empty());
        let ids: Vec<&str> = collection
            .assets
            .iter()
            .map(|asset| asset.id.as_str())
            .collect();
        assert_eq!(ids, vec!["gloopie-new", "gloopie-old"]);
        let newest = &collection.assets[0];
        assert_eq!(newest.mime_type, "video/webm");
        assert_eq!(newest.alpha_mode.as_deref(), Some("stacked"));
        assert!(newest
            .poster_path
            .as_deref()
            .unwrap()
            .ends_with("gloopie-new.poster.png"));
    }

    #[test]
    fn user_avatar_collection_is_empty_when_no_gloopies_exist() {
        let (_dir, paths) = temp_user_avatar_paths();
        let collection = user_avatar_cached_collection_at(&paths).unwrap();
        assert!(collection.assets.is_empty());
        assert!(collection.failed_asset_ids.is_empty());
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
    fn delete_user_avatar_removes_poster_and_is_idempotent() {
        let (_dir, paths) = temp_user_avatar_paths();
        let media_path = seed_user_avatar(&paths, "gloopie-1");
        let poster_path = paths.media.join("gloopie-1.poster.png");
        fs::write(&poster_path, b"poster").unwrap();
        let manifest_path = paths.meta.join("gloopie-1.json");
        let mut manifest: UserAvatarManifest = read_json_file(&manifest_path).unwrap();
        manifest.poster_path = Some("gloopie-1.poster.png".to_string());
        fs::write(&manifest_path, serde_json::to_vec(&manifest).unwrap()).unwrap();

        delete_user_avatar_at(&paths, "user-avatar:gloopie-1").unwrap();
        delete_user_avatar_at(&paths, "user-avatar:gloopie-1").unwrap();

        assert!(!media_path.exists());
        assert!(!poster_path.exists());
        assert!(!manifest_path.exists());
    }

    #[test]
    fn write_user_avatar_rolls_back_media_and_poster_when_manifest_write_fails() {
        let (dir, mut paths) = temp_user_avatar_paths();
        paths.meta = dir.path().join("not-a-directory");
        fs::write(&paths.meta, b"block directory creation").unwrap();

        let result = write_user_avatar_at(
            &paths,
            "gloopie-rollback",
            b"media",
            "video/webm",
            None,
            Some((b"poster", "image/png")),
        );

        assert!(result.is_err());
        assert!(!paths.media.join("gloopie-rollback.webm").exists());
        assert!(!paths.media.join("gloopie-rollback.poster.png").exists());
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
    fn corrupted_manifest_for_avatar_a_cannot_delete_avatar_b_files() {
        let (_dir, paths) = temp_user_avatar_paths();
        let avatar_a_media = seed_user_avatar(&paths, "gloopie-a");
        let avatar_b_media = seed_user_avatar(&paths, "gloopie-b");
        let avatar_b_poster = paths.media.join("gloopie-b.poster.png");
        fs::write(&avatar_b_poster, b"poster").unwrap();
        let avatar_a_manifest_path = paths.meta.join("gloopie-a.json");

        let mut manifest: UserAvatarManifest = read_json_file(&avatar_a_manifest_path).unwrap();
        manifest.path = "gloopie-b.png".to_string();
        manifest.poster_path = Some("gloopie-b.poster.png".to_string());
        fs::write(
            &avatar_a_manifest_path,
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();

        assert!(delete_user_avatar_at(&paths, "user-avatar:gloopie-a").is_err());
        assert!(avatar_a_media.exists());
        assert!(avatar_b_media.exists());
        assert!(avatar_b_poster.exists());
        assert!(avatar_a_manifest_path.exists());
    }

    #[test]
    fn corrupted_manifest_poster_for_avatar_a_cannot_delete_avatar_b_poster() {
        let (_dir, paths) = temp_user_avatar_paths();
        seed_user_avatar(&paths, "gloopie-a");
        let avatar_b_poster = paths.media.join("gloopie-b.poster.png");
        fs::write(&avatar_b_poster, b"poster").unwrap();
        let avatar_a_manifest_path = paths.meta.join("gloopie-a.json");

        let mut manifest: UserAvatarManifest = read_json_file(&avatar_a_manifest_path).unwrap();
        manifest.poster_path = Some("gloopie-b.poster.png".to_string());
        fs::write(
            &avatar_a_manifest_path,
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();

        assert!(delete_user_avatar_at(&paths, "user-avatar:gloopie-a").is_err());
        assert!(avatar_b_poster.exists());
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
        let (assets, failed) =
            cached_collection_assets(&paths, &catalog, collection, "webm").unwrap();
        assert!(assets.is_empty());
        assert_eq!(failed, vec!["gloopy-1"]);
        assert!(target.exists());

        let target = write_cached_webm(&paths, &catalog, bytes);
        let (assets, failed) =
            cached_collection_assets(&paths, &catalog, collection, "webm").unwrap();
        assert!(failed.is_empty());
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

        let (assets, failed) =
            cached_collection_assets(&paths, &catalog, collection, "webm").unwrap();
        assert!(failed.is_empty());
        assert_eq!(assets.len(), 1);
        assert!(assets[0].poster_path.is_none());

        let poster = catalog.assets[0].variants.poster.as_ref().unwrap();
        let poster_target = media_blob_path(&paths, poster).unwrap();
        fs::create_dir_all(poster_target.parent().unwrap()).unwrap();
        fs::write(&poster_target, poster_bytes).unwrap();

        let (assets, failed) =
            cached_collection_assets(&paths, &catalog, collection, "webm").unwrap();
        assert!(failed.is_empty());
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
    fn snapshot_keeps_cached_assets_from_an_incomplete_collection() {
        let bytes = b"avatar-bytes";
        let mut catalog = valid_catalog(bytes);
        add_second_avatar(
            &mut catalog,
            variant("webm/gloopies/gloopy-2.webm", b"other"),
        );
        let (_dir, paths) = temp_paths();
        write_cached_webm(&paths, &catalog, bytes);

        let collections =
            cached_collections_for_catalog_with_format(&paths, &catalog, "webm").unwrap();

        assert_eq!(collections.len(), 1);
        assert_eq!(collections[0].assets.len(), 1);
        assert_eq!(collections[0].assets[0].id, "gloopy-1");
        assert_eq!(collections[0].failed_asset_ids, vec!["gloopy-2"]);
    }

    #[test]
    fn refresh_status_preserves_partial_network_failure_classification() {
        let result = Ok(AvatarRefreshResult {
            cached: 1,
            failed: 1,
            error_code: Some(AvatarErrorCode::NetworkAccess),
            avatar_refs: Vec::new(),
        });
        let mut status = AvatarRefreshStatus {
            active_refreshes: 1,
            ..AvatarRefreshStatus::default()
        };

        status.complete(&result);

        assert_eq!(
            status.snapshot(),
            (false, true, Some(AvatarErrorCode::NetworkAccess)),
        );
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
        let (assets, failed) =
            cached_collection_assets(&paths, &catalog, &catalog.collections[0], "webm").unwrap();
        assert_eq!(assets.len(), 1);
        assert_eq!(failed, vec!["gloopy-2"]);
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
    fn avatar_refresh_retry_uses_bounded_exponential_backoff() {
        assert_eq!(avatar_refresh_retry_delay(1), Duration::from_secs(30));
        assert_eq!(avatar_refresh_retry_delay(2), Duration::from_secs(60));
        assert_eq!(avatar_refresh_retry_delay(6), Duration::from_secs(16 * 60));
        assert_eq!(avatar_refresh_retry_delay(7), AVATAR_REFRESH_RETRY_MAX);
        assert_eq!(
            avatar_refresh_retry_delay(u32::MAX),
            AVATAR_REFRESH_RETRY_MAX
        );
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
    async fn clear_waits_for_refresh_generation_and_recovery_starts_afterward() {
        let (_dir, paths) = temp_paths();
        let stale_paths = paths.clone();
        let (paused_tx, paused_rx) = tokio::sync::oneshot::channel();
        let (resume_tx, resume_rx) = tokio::sync::oneshot::channel();

        let stale_refresh = tokio::spawn(coordinate_avatar_cache_operation(async move {
            fs::create_dir_all(&stale_paths.meta).unwrap();
            fs::write(stale_paths.meta.join("before-clear"), b"stale").unwrap();
            paused_tx.send(()).unwrap();
            resume_rx.await.unwrap();
            fs::create_dir_all(&stale_paths.media).unwrap();
            fs::write(stale_paths.media.join("after-pause"), b"stale").unwrap();
        }));
        paused_rx.await.unwrap();

        let recovery_started = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let recovery_started_by_clear = recovery_started.clone();
        let clear_paths = paths.clone();
        let clear = tokio::spawn(async move {
            clear_avatar_cache_and_then(&clear_paths, move || {
                recovery_started_by_clear.store(true, std::sync::atomic::Ordering::SeqCst);
            })
            .await
        });
        tokio::task::yield_now().await;
        assert!(
            !clear.is_finished(),
            "clear must wait for the whole refresh"
        );

        resume_tx.send(()).unwrap();
        stale_refresh.await.unwrap();
        clear.await.unwrap().unwrap();
        assert!(!paths.meta.exists());
        assert!(!paths.media.exists());
        assert!(
            recovery_started.load(std::sync::atomic::Ordering::SeqCst),
            "a successful clear must start recovery immediately"
        );

        let recovery_path = paths.meta.join("recovered");
        coordinate_avatar_cache_operation(async {
            fs::create_dir_all(&paths.meta).unwrap();
            fs::write(&recovery_path, b"fresh").unwrap();
        })
        .await;
        assert_eq!(fs::read(recovery_path).unwrap(), b"fresh");
    }

    #[tokio::test]
    async fn concurrent_refresh_generations_are_serialized() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let active = Arc::new(AtomicUsize::new(0));
        let maximum = Arc::new(AtomicUsize::new(0));
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (resume_tx, resume_rx) = tokio::sync::oneshot::channel();

        let first_active = active.clone();
        let first_maximum = maximum.clone();
        let first = tokio::spawn(coordinate_avatar_cache_operation(async move {
            let current = first_active.fetch_add(1, Ordering::SeqCst) + 1;
            first_maximum.fetch_max(current, Ordering::SeqCst);
            started_tx.send(()).unwrap();
            resume_rx.await.unwrap();
            first_active.fetch_sub(1, Ordering::SeqCst);
        }));
        started_rx.await.unwrap();

        let second_active = active.clone();
        let second_maximum = maximum.clone();
        let second = tokio::spawn(coordinate_avatar_cache_operation(async move {
            let current = second_active.fetch_add(1, Ordering::SeqCst) + 1;
            second_maximum.fetch_max(current, Ordering::SeqCst);
            second_active.fetch_sub(1, Ordering::SeqCst);
        }));
        tokio::task::yield_now().await;
        assert!(!second.is_finished(), "a second refresh must wait");

        resume_tx.send(()).unwrap();
        first.await.unwrap();
        second.await.unwrap();
        assert_eq!(maximum.load(Ordering::SeqCst), 1);
        assert_eq!(active.load(Ordering::SeqCst), 0);
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
