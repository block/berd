use crate::commands::avatars::{
    delete_user_avatar_by_ref, read_user_avatar_bytes, write_user_avatar,
    write_user_avatar_with_alpha_mode,
};
use futures_util::StreamExt;
use reqwest::{
    header::{ACCEPT, CONTENT_LENGTH, CONTENT_TYPE},
    StatusCode, Url,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{env, time::Duration};
use tauri::AppHandle;
use tokio::time::{sleep, Instant};

const DAIM_APPS_BASE_URL_ENV: &str = "DAIM_APPS_BASE_URL";
const DEFAULT_DAIM_APPS_BASE_URL: &str = "https://daim-apps.sqprod.co";
const GLOOPIE_TOOL_ID: &str = "goose-avatar-creator";
const GENERATION_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const POLL_INTERVAL: Duration = Duration::from_secs(2);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const ASSET_DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(120);
const MAX_ASSET_BYTES: usize = 25 * 1024 * 1024;
const OPTION_COUNT: usize = 4;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GloopieOptionResult {
    id: String,
    avatar_ref: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GloopieGenerateOptionsResponse {
    options: Vec<GloopieOptionResult>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GloopieAnimateResponse {
    avatar_ref: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GloopieCommandError {
    code: GloopieErrorCode,
    message: String,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum GloopieErrorCode {
    NetworkAccess,
    ContentBlocked,
    Unavailable,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ComfyToolsGeneration {
    generation_id: String,
    status: String,
    assets: Vec<ComfyToolsAsset>,
    error: Option<ComfyToolsError>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ComfyToolsAsset {
    asset_id: String,
    url: String,
}

#[derive(Debug, Clone, Deserialize)]
struct ComfyToolsError {
    code: String,
    message: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ComfyToolsUploadResponse {
    filename: String,
    session_id: String,
}

#[derive(Debug, Clone)]
struct DownloadedAsset {
    bytes: Vec<u8>,
    mime_type: String,
}

type GloopieCommandResult<T> = Result<T, GloopieCommandError>;

impl GloopieCommandError {
    fn network_access(raw: impl AsRef<str>) -> Self {
        log::warn!("Gloopie creator network access error: {}", raw.as_ref());
        Self {
            code: GloopieErrorCode::NetworkAccess,
            message:
                "Unable to connect to the gloopie creator. Connect to Cloudflare WARP and try again."
                    .to_string(),
        }
    }

    fn content_blocked(raw: impl AsRef<str>) -> Self {
        log::warn!("Gloopie creator blocked prompt: {}", raw.as_ref());
        Self {
            code: GloopieErrorCode::ContentBlocked,
            message: "The image provider couldn't use that description. Try changing it."
                .to_string(),
        }
    }

    fn unavailable(raw: impl AsRef<str>) -> Self {
        log::warn!("Gloopie creator unavailable: {}", raw.as_ref());
        Self {
            code: GloopieErrorCode::Unavailable,
            message: "The gloopie creator is unavailable right now. Try again.".to_string(),
        }
    }
}

impl std::fmt::Display for GloopieCommandError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

#[tauri::command]
pub async fn generate_gloopie_options(
    app: AppHandle,
    object: String,
) -> GloopieCommandResult<GloopieGenerateOptionsResponse> {
    let object = object.trim();
    if object.is_empty() || object.chars().count() > 300 {
        return Err(GloopieCommandError::unavailable(
            "Generated gloopie prompt must be 1-300 characters",
        ));
    }

    let client = client()?;
    let base_url = daim_base_url()?;
    let generation = start_generation(
        &client,
        &base_url,
        json!({
            "inputs": {
                "phase": "generate",
                "object": object,
            }
        }),
    )
    .await?;
    let generation = poll_generation(&client, &base_url, &generation.generation_id).await?;

    // Download every candidate before writing anything to disk. If a write
    // still fails partway through, delete the refs already written: the
    // frontend only learns about refs from a successful response, so any
    // file persisted on a failed command would be orphaned forever.
    let mut downloaded_options = Vec::new();
    for asset in generation.assets.iter().take(OPTION_COUNT) {
        let downloaded = download_asset(&client, &base_url, asset).await?;
        if downloaded.mime_type.starts_with("image/") {
            downloaded_options.push(downloaded);
        }
    }

    let mut options: Vec<GloopieOptionResult> = Vec::new();
    for downloaded in &downloaded_options {
        match write_user_avatar(&app, &downloaded.bytes, &downloaded.mime_type) {
            Ok(avatar_ref) => options.push(GloopieOptionResult {
                id: avatar_ref.clone(),
                avatar_ref,
            }),
            Err(error) => {
                for written in &options {
                    if let Err(cleanup_error) = delete_user_avatar_by_ref(&app, &written.avatar_ref)
                    {
                        log::warn!(
                            "Failed to clean up partially written gloopie option {}: {cleanup_error}",
                            written.avatar_ref
                        );
                    }
                }
                return Err(GloopieCommandError::unavailable(error));
            }
        }
    }

    if options.is_empty() {
        return Err(GloopieCommandError::unavailable(
            "Gloopie generation returned no image assets",
        ));
    }

    Ok(GloopieGenerateOptionsResponse { options })
}

#[tauri::command]
pub async fn animate_gloopie_option(
    app: AppHandle,
    avatar_ref: String,
    object: String,
) -> GloopieCommandResult<GloopieAnimateResponse> {
    let object = object.trim();
    if object.is_empty() || object.chars().count() > 300 {
        return Err(GloopieCommandError::unavailable(
            "Animated gloopie prompt must be 1-300 characters",
        ));
    }

    let (bytes, mime_type) =
        read_user_avatar_bytes(&app, &avatar_ref).map_err(GloopieCommandError::unavailable)?;
    if !mime_type.starts_with("image/") {
        return Err(GloopieCommandError::unavailable(
            "Selected gloopie option is not an image",
        ));
    }

    let client = client()?;
    let base_url = daim_base_url()?;
    let upload = upload_image(&client, &base_url, bytes, &mime_type).await?;
    let generation = start_generation(
        &client,
        &base_url,
        json!({
            "sessionId": upload.session_id,
            "inputs": {
                "phase": "animate",
                "object": object,
                "chosenImage": upload.filename,
            }
        }),
    )
    .await?;
    let generation = poll_generation(&client, &base_url, &generation.generation_id).await?;

    let mut downloaded_assets = Vec::new();
    for asset in &generation.assets {
        downloaded_assets.push(download_asset(&client, &base_url, asset).await?);
    }
    let final_asset = select_final_animated_asset(&downloaded_assets)
        .ok_or_else(|| GloopieCommandError::unavailable("Animation returned no video asset"))?;
    let alpha_mode = if final_asset.mime_type == "video/mp4" {
        Some("stacked")
    } else {
        None
    };
    let avatar_ref = write_user_avatar_with_alpha_mode(
        &app,
        &final_asset.bytes,
        &final_asset.mime_type,
        alpha_mode,
    )
    .map_err(GloopieCommandError::unavailable)?;

    Ok(GloopieAnimateResponse { avatar_ref })
}

fn client() -> GloopieCommandResult<reqwest::Client> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        // DAIM asset capability URLs are same-origin. Disabling redirects keeps
        // a compromised or misconfigured gateway from turning the desktop
        // client into an arbitrary network fetcher.
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|error| {
            GloopieCommandError::unavailable(format!(
                "Failed to create DAIM Apps HTTP client: {error}"
            ))
        })
}

fn daim_base_url() -> GloopieCommandResult<Url> {
    let raw =
        env::var(DAIM_APPS_BASE_URL_ENV).unwrap_or_else(|_| DEFAULT_DAIM_APPS_BASE_URL.to_string());
    let parsed = Url::parse(&format!("{}/", raw.trim_end_matches('/'))).map_err(|error| {
        GloopieCommandError::unavailable(format!("Invalid DAIM Apps base URL '{raw}': {error}"))
    })?;

    // The prompt POST and the chosen-image upload both go to this origin, so an
    // http:// override would put user prompts and images on the wire in
    // plaintext. resolve_asset_url pins downloads to https; this pins the
    // requests that come before them. Loopback stays permitted so a local mock
    // works without weakening the real remote path.
    if parsed.scheme() != "https" && !is_loopback_host(&parsed) {
        return Err(GloopieCommandError::unavailable(format!(
            "DAIM Apps base URL must use https (got '{raw}')"
        )));
    }

    Ok(parsed)
}

fn is_loopback_host(url: &Url) -> bool {
    matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"))
}

fn tool_url(base_url: &Url, path: &str) -> GloopieCommandResult<Url> {
    base_url
        .join(&format!(
            "api/v1/comfy-tools/{GLOOPIE_TOOL_ID}/{}",
            path.trim_start_matches('/')
        ))
        .map_err(|error| GloopieCommandError::unavailable(format!("Invalid DAIM URL: {error}")))
}

async fn start_generation(
    client: &reqwest::Client,
    base_url: &Url,
    body: Value,
) -> GloopieCommandResult<ComfyToolsGeneration> {
    let url = tool_url(base_url, "generations")?;
    let response = client
        .post(url.clone())
        .header(ACCEPT, "application/json")
        .header(CONTENT_TYPE, "application/json")
        .timeout(REQUEST_TIMEOUT)
        .json(&body)
        .send()
        .await
        .map_err(|error| request_error("Failed to start gloopie generation", error))?;

    json_response(url, response, StatusCode::ACCEPTED).await
}

async fn poll_generation(
    client: &reqwest::Client,
    base_url: &Url,
    generation_id: &str,
) -> GloopieCommandResult<ComfyToolsGeneration> {
    let url = tool_url(base_url, &format!("generations/{generation_id}"))?;
    let deadline = Instant::now() + GENERATION_TIMEOUT;

    loop {
        let response = client
            .get(url.clone())
            .header(ACCEPT, "application/json")
            .timeout(REQUEST_TIMEOUT)
            .send()
            .await
            .map_err(|error| request_error("Failed to poll gloopie generation", error))?;
        if is_transient_poll_status(response.status()) {
            let status = response.status();
            let body = response
                .text()
                .await
                .unwrap_or_else(|error| format!("Failed to read transient error body: {error}"));
            log::warn!(
                "Transient DAIM Apps poll error for generation {}: HTTP {}: {}",
                generation_id,
                status,
                truncate(&body)
            );
            if Instant::now() >= deadline {
                return Err(GloopieCommandError::unavailable(format!(
                    "Timed out waiting for gloopie generation after transient HTTP {status}"
                )));
            }
            sleep(POLL_INTERVAL).await;
            continue;
        }
        let generation: ComfyToolsGeneration =
            json_response(url.clone(), response, StatusCode::OK).await?;

        match generation.status.as_str() {
            "succeeded" => return Ok(generation),
            "failed" | "cancelled" => {
                return Err(generation_failure_error(
                    generation.error,
                    &generation.status,
                ));
            }
            _ if Instant::now() >= deadline => {
                return Err(GloopieCommandError::unavailable(
                    "Timed out waiting for gloopie generation",
                ));
            }
            _ => sleep(POLL_INTERVAL).await,
        }
    }
}

fn generation_failure_error(error: Option<ComfyToolsError>, status: &str) -> GloopieCommandError {
    if let Some(error) = error {
        let detail = format!("{}: {}", error.code, error.message);
        if error.code == "COMFYUI_CONTENT_BLOCKED" {
            return GloopieCommandError::content_blocked(detail);
        }
        return GloopieCommandError::unavailable(detail);
    }
    GloopieCommandError::unavailable(format!("Generation ended with {status}"))
}

fn is_transient_poll_status(status: StatusCode) -> bool {
    matches!(
        status,
        StatusCode::TOO_MANY_REQUESTS
            | StatusCode::BAD_GATEWAY
            | StatusCode::SERVICE_UNAVAILABLE
            | StatusCode::GATEWAY_TIMEOUT
    )
}

async fn upload_image(
    client: &reqwest::Client,
    base_url: &Url,
    bytes: Vec<u8>,
    mime_type: &str,
) -> GloopieCommandResult<ComfyToolsUploadResponse> {
    let url = tool_url(base_url, "uploads?filename=gloopie-choice.png")?;
    let response = client
        .post(url.clone())
        .header(ACCEPT, "application/json")
        .header(CONTENT_TYPE, mime_type)
        .timeout(ASSET_DOWNLOAD_TIMEOUT)
        .body(bytes)
        .send()
        .await
        .map_err(|error| request_error("Failed to upload gloopie option", error))?;

    json_response(url, response, StatusCode::OK).await
}

async fn download_asset(
    client: &reqwest::Client,
    base_url: &Url,
    asset: &ComfyToolsAsset,
) -> GloopieCommandResult<DownloadedAsset> {
    let url = resolve_asset_url(base_url, &asset.url)?;
    let response = client
        .get(url.clone())
        .timeout(ASSET_DOWNLOAD_TIMEOUT)
        .send()
        .await
        .map_err(|error| request_error("Failed to download gloopie asset", error))?;
    let status = response.status();
    // Status first: an error response usually has no useful content type, and
    // reporting "no MIME type" would hide the actual HTTP failure.
    if !status.is_success() {
        return Err(GloopieCommandError::unavailable(format!(
            "Gloopie asset '{}' failed with HTTP {status}",
            asset.asset_id
        )));
    }
    let mime_type = response_content_type(response.headers()).ok_or_else(|| {
        GloopieCommandError::unavailable("Gloopie asset response had no MIME type")
    })?;
    if response
        .headers()
        .get(CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<usize>().ok())
        .is_some_and(|size| size > MAX_ASSET_BYTES)
    {
        return Err(GloopieCommandError::unavailable(format!(
            "Gloopie asset '{}' exceeds the {} byte limit",
            asset.asset_id, MAX_ASSET_BYTES
        )));
    }

    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| request_error("Failed to read gloopie asset", error))?;
        if bytes.len().saturating_add(chunk.len()) > MAX_ASSET_BYTES {
            return Err(GloopieCommandError::unavailable(format!(
                "Gloopie asset '{}' exceeds the {} byte limit",
                asset.asset_id, MAX_ASSET_BYTES
            )));
        }
        bytes.extend_from_slice(&chunk);
    }

    Ok(DownloadedAsset { bytes, mime_type })
}

async fn json_response<T>(
    url: Url,
    response: reqwest::Response,
    expected_status: StatusCode,
) -> GloopieCommandResult<T>
where
    T: for<'de> Deserialize<'de>,
{
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|error| request_error("Failed to read DAIM Apps response", error))?;

    if status != expected_status {
        return Err(GloopieCommandError::unavailable(format!(
            "DAIM Apps request to {} failed with HTTP {status}: {}",
            url.as_str(),
            truncate(&body)
        )));
    }

    serde_json::from_str(&body).map_err(|error| {
        GloopieCommandError::unavailable(format!(
            "Failed to parse DAIM Apps response from {}: {error}",
            url.as_str()
        ))
    })
}

fn request_error(label: &str, error: reqwest::Error) -> GloopieCommandError {
    if error.is_timeout() || error.is_connect() || error.is_redirect() {
        GloopieCommandError::network_access(format!("{label}: {error}"))
    } else {
        GloopieCommandError::unavailable(format!("{label}: {error}"))
    }
}

fn response_content_type(headers: &reqwest::header::HeaderMap) -> Option<String> {
    headers
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn resolve_asset_url(base_url: &Url, value: &str) -> GloopieCommandResult<Url> {
    let resolved = base_url
        .join(value)
        .map_err(|error| GloopieCommandError::unavailable(format!("Invalid asset URL: {error}")))?;
    // Mirror the base-URL policy: https everywhere, except an http loopback
    // origin used by a local mock. Without the exception, pointing
    // DAIM_APPS_BASE_URL at http://localhost would pass base-URL validation and
    // then fail every asset download after a successful poll.
    let scheme_ok =
        resolved.scheme() == "https" || (is_loopback_host(&resolved) && is_loopback_host(base_url));
    if !scheme_ok
        || resolved.host_str() != base_url.host_str()
        || resolved.port_or_known_default() != base_url.port_or_known_default()
    {
        return Err(GloopieCommandError::unavailable(
            "Gloopie asset URL must use the configured DAIM Apps origin",
        ));
    }
    Ok(resolved)
}

fn select_final_animated_asset(assets: &[DownloadedAsset]) -> Option<&DownloadedAsset> {
    // DAIM's MP4 is a stacked-alpha transport format: color on top,
    // transparency mask on bottom. WebKit does not reliably composite VP9
    // alpha from WebM, so prefer MP4 and render it through AvatarMedia's
    // stacked-alpha canvas compositor.
    let preferred = ["video/mp4", "video/webm", "video/quicktime"];

    for mime_type in preferred {
        if let Some(asset) = assets.iter().find(|asset| asset.mime_type == mime_type) {
            return Some(asset);
        }
    }

    assets
        .iter()
        .find(|asset| asset.mime_type.starts_with("video/"))
}

fn truncate(value: &str) -> String {
    const MAX_CHARS: usize = 500;
    if value.chars().count() <= MAX_CHARS {
        return value.to_string();
    }
    format!("{}...", value.chars().take(MAX_CHARS).collect::<String>())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn asset_urls_must_stay_on_the_configured_https_origin() {
        let base = Url::parse("https://daim-apps.sqprod.co/").unwrap();

        assert_eq!(
            resolve_asset_url(
                &base,
                "/api/v1/comfy-tools/goose-avatar-creator/assets?id=1"
            )
            .unwrap()
            .as_str(),
            "https://daim-apps.sqprod.co/api/v1/comfy-tools/goose-avatar-creator/assets?id=1"
        );
        assert!(resolve_asset_url(&base, "https://daim-apps.sqprod.co/assets?id=1").is_ok());
        assert!(resolve_asset_url(&base, "http://daim-apps.sqprod.co/assets?id=1").is_err());
        assert!(resolve_asset_url(&base, "https://example.com/assets?id=1").is_err());
    }

    #[test]
    fn asset_urls_allow_an_http_loopback_mock_origin() {
        let local = Url::parse("http://localhost:8080/").unwrap();
        assert!(resolve_asset_url(&local, "/assets?id=1").is_ok());
        assert!(resolve_asset_url(&local, "http://localhost:8080/assets?id=1").is_ok());

        // Loopback must not become an escape hatch to other origins.
        assert!(resolve_asset_url(&local, "http://evil.com/assets?id=1").is_err());
        assert!(resolve_asset_url(&local, "http://localhost:9999/assets?id=1").is_err());

        // A remote origin still cannot be downgraded to http.
        let remote = Url::parse("https://daim-apps.sqprod.co/").unwrap();
        assert!(resolve_asset_url(&remote, "http://daim-apps.sqprod.co/assets?id=1").is_err());
    }

    #[test]
    fn base_url_must_be_https_unless_loopback() {
        assert!(is_loopback_host(
            &Url::parse("http://localhost:8080/").unwrap()
        ));
        assert!(is_loopback_host(
            &Url::parse("http://127.0.0.1:8080/").unwrap()
        ));
        assert!(!is_loopback_host(
            &Url::parse("http://daim-apps.sqprod.co/").unwrap()
        ));
        assert!(!is_loopback_host(
            &Url::parse("http://localhost.evil.com/").unwrap()
        ));
    }

    #[test]
    fn content_blocked_generation_is_actionable() {
        let error = generation_failure_error(
            Some(ComfyToolsError {
                code: "COMFYUI_CONTENT_BLOCKED".to_string(),
                message: "provider declined the prompt".to_string(),
            }),
            "failed",
        );

        assert_eq!(error.code, GloopieErrorCode::ContentBlocked);
        assert_eq!(
            error.message,
            "The image provider couldn't use that description. Try changing it."
        );
    }

    #[test]
    fn final_animation_prefers_stacked_alpha_mp4() {
        let assets = vec![
            DownloadedAsset {
                bytes: vec![1],
                mime_type: "video/webm".to_string(),
            },
            DownloadedAsset {
                bytes: vec![2],
                mime_type: "video/mp4".to_string(),
            },
            DownloadedAsset {
                bytes: vec![3],
                mime_type: "image/png".to_string(),
            },
        ];

        let selected = select_final_animated_asset(&assets).unwrap();
        assert_eq!(selected.mime_type, "video/mp4");
        assert_eq!(selected.bytes, vec![2]);
    }
}
