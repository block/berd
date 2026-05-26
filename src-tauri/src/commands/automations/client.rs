use crate::services::distro_bundle::{DistroBundleState, KgooseDistroConfig};
use bytes::Bytes;
use reqwest::header::{HeaderValue, ACCEPT, CACHE_CONTROL, CONTENT_TYPE};
use serde_json::Value;
use std::{env, sync::OnceLock, time::Duration};
use tokio::time::timeout;

use crate::commands::sse::{SseDecoder, SseMessage};

const KGOOSE_AUTOMATIONS_BASE_URL_ENV: &str = "GOOSE_INTERNAL_KGOOSE_BASE_URL";
const KGOOSE_AUTOMATIONS_PATH_ENV: &str = "GOOSE_INTERNAL_KGOOSE_PATH";
const KGOOSE_AUTOMATIONS_PLAYPEN_ENV: &str = "GOOSE_INTERNAL_KGOOSE_PLAYPEN";
const DEFAULT_KGOOSE_BASE_URL: &str = "https://kgoose.stage.sqprod.co/";
const DEFAULT_KGOOSE_PATH: &str = "cash-app/goose";
const MAX_ERROR_BODY_CHARS: usize = 500;
const KGOOSE_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const KGOOSE_JSON_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const KGOOSE_SSE_IDLE_TIMEOUT: Duration = Duration::from_secs(120);
const KGOOSE_MESSAGES_SNAPSHOT_TIMEOUT: Duration = Duration::from_secs(30);

pub(super) const GET_USER_TILES_ENDPOINT: &str = "v3/get-user-tiles";
pub(super) const GET_TILE_ENDPOINT: &str = "v3/get-tile";
pub(super) const GET_TILE_RESULTS_ENDPOINT: &str = "v3/get-tile-results";
pub(super) const CREATE_TILE_ENDPOINT: &str = "v3/create-tile";
pub(super) const PUSH_MESSAGES_ENDPOINT: &str = "v3/push-messages";
pub(super) const CANCEL_LAST_USER_MESSAGE_ENDPOINT: &str = "v3/cancel-last-user-message";
pub(super) const GET_MESSAGES_SSE_ENDPOINT: &str = "v3/get-messages-sse";
pub(super) const UPDATE_TILE_ENDPOINT: &str = "v3/update-tile";
pub(super) const DELETE_TILE_ENDPOINT: &str = "v3/delete-tile";
pub(super) const GENERATE_CRON_SCHEDULE_ENDPOINT: &str = "v3/generate-cron-schedule";

pub(crate) async fn post_kgoose_json(
    distro_state: &DistroBundleState,
    endpoint: &str,
    body: Value,
) -> Result<Value, String> {
    let url = build_kgoose_url(endpoint, distro_state.kgoose_config())?;
    let request = kgoose_client()
        .post(url.clone())
        .header(ACCEPT, "application/json")
        .header(CONTENT_TYPE, "application/json");
    let request = add_kgoose_playpen_baggage(request);
    let response = request
        .timeout(KGOOSE_JSON_REQUEST_TIMEOUT)
        .json(&body)
        .send()
        .await
        .map_err(|error| format!("Failed to call kgoose at {}: {error}", url.as_str()))?;

    let status = response.status();
    let response_body = response.text().await.map_err(|error| {
        format!(
            "Failed to read kgoose response from {}: {error}",
            url.as_str()
        )
    })?;

    if !status.is_success() {
        return Err(format!(
            "kgoose request to {} failed with {}: {}",
            url.as_str(),
            status,
            truncate_error_body(&response_body)
        ));
    }

    serde_json::from_str(&response_body).map_err(|error| {
        format!(
            "Failed to parse kgoose response from {}: {error}",
            url.as_str()
        )
    })
}

pub(super) async fn open_kgoose_sse_stream(
    url: reqwest::Url,
    last_event_id: Option<HeaderValue>,
) -> Result<reqwest::Response, String> {
    let mut request = kgoose_client()
        .get(url.clone())
        .header(ACCEPT, "text/event-stream")
        .header(CACHE_CONTROL, "no-cache");
    request = add_kgoose_playpen_baggage(request);
    if let Some(last_event_id) = last_event_id {
        request = request.header("Last-Event-ID", last_event_id);
    }

    let response = request
        .send()
        .await
        .map_err(|error| format!("Failed to open kgoose stream at {}: {error}", url.as_str()))?;
    let status = response.status();
    if status.is_success() {
        return Ok(response);
    }

    let response_body = response.text().await.unwrap_or_default();
    Err(format!(
        "kgoose stream to {} failed with {}: {}",
        url.as_str(),
        status,
        truncate_error_body(&response_body)
    ))
}

pub(super) async fn read_kgoose_sse_chunk(
    response: &mut reqwest::Response,
    url: &reqwest::Url,
) -> Result<Option<Bytes>, String> {
    timeout(KGOOSE_SSE_IDLE_TIMEOUT, response.chunk())
        .await
        .map_err(|_| {
            format!(
                "Timed out waiting for kgoose stream data from {}",
                url.as_str()
            )
        })?
        .map_err(|error| {
            format!(
                "Failed to read kgoose stream from {}: {error}",
                url.as_str()
            )
        })
}

pub(super) fn build_kgoose_sse_url(
    endpoint: &str,
    session_id: &str,
    distro_config: Option<&KgooseDistroConfig>,
) -> Result<reqwest::Url, String> {
    let mut url = build_kgoose_url(endpoint, distro_config)?;
    url.query_pairs_mut().append_pair("session_id", session_id);
    Ok(url)
}

pub(super) async fn get_kgoose_messages_snapshot(
    distro_state: &DistroBundleState,
    session_id: &str,
) -> Result<Value, String> {
    timeout(KGOOSE_MESSAGES_SNAPSHOT_TIMEOUT, async {
        let mut url = build_kgoose_sse_url(
            GET_MESSAGES_SSE_ENDPOINT,
            session_id,
            distro_state.kgoose_config(),
        )?;
        url.query_pairs_mut()
            .append_pair("update_last_read_at", "false");

        let mut response = open_kgoose_sse_stream(url.clone(), None).await?;
        let mut decoder = SseDecoder::default();
        while let Some(chunk) = read_kgoose_sse_chunk(&mut response, &url).await? {
            for event in decoder.push_chunk(&chunk) {
                if let Some(payload) = messages_payload_from_sse_message(&event)? {
                    return Ok(payload);
                }
            }
        }

        Err("kgoose messages stream ended before returning session messages".to_string())
    })
    .await
    .map_err(|_| "Timed out waiting for kgoose session messages".to_string())?
}

fn kgoose_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .connect_timeout(KGOOSE_CONNECT_TIMEOUT)
            .build()
            .expect("failed to build kgoose HTTP client")
    })
}

fn add_kgoose_playpen_baggage(request: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
    match kgoose_playpen_baggage() {
        Some(playpen_baggage) => request.header("Baggage", playpen_baggage),
        None => request,
    }
}

fn kgoose_playpen_baggage() -> Option<String> {
    env_value(KGOOSE_AUTOMATIONS_PLAYPEN_ENV).map(|playpen| format!("kgoose-playpen={playpen}"))
}

fn build_kgoose_url(
    endpoint: &str,
    distro_config: Option<&KgooseDistroConfig>,
) -> Result<reqwest::Url, String> {
    let base_url = config_value(
        KGOOSE_AUTOMATIONS_BASE_URL_ENV,
        distro_config.and_then(|config| config.base_url.as_deref()),
        DEFAULT_KGOOSE_BASE_URL,
        "distro kgoose baseUrl",
        "default kgoose base URL",
    );
    let path_prefix = config_value(
        KGOOSE_AUTOMATIONS_PATH_ENV,
        distro_config.and_then(|config| config.path.as_deref()),
        DEFAULT_KGOOSE_PATH,
        "distro kgoose path",
        "default kgoose path",
    );

    let mut url = reqwest::Url::parse(&ensure_trailing_slash(&base_url.value))
        .map_err(|error| format!("Invalid {}: {error}", base_url.label))?;

    if !matches!(url.scheme(), "http" | "https") {
        return Err(format!("{} must use http or https", base_url.label));
    }

    let path = [url.path(), path_prefix.value.as_str(), endpoint]
        .into_iter()
        .map(|segment| segment.trim_matches('/'))
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>()
        .join("/");
    url.set_path(&path);

    Ok(url)
}

struct ConfigValue {
    value: String,
    label: String,
}

fn config_value(
    env_name: &str,
    distro_value: Option<&str>,
    default: &str,
    distro_label: &str,
    default_label: &str,
) -> ConfigValue {
    if let Some(value) = env_value(env_name) {
        return ConfigValue {
            value,
            label: env_name.to_string(),
        };
    }

    if let Some(value) = distro_value.and_then(trim_non_empty) {
        return ConfigValue {
            value,
            label: distro_label.to_string(),
        };
    }

    ConfigValue {
        value: default.to_string(),
        label: default_label.to_string(),
    }
}

fn env_value(name: &str) -> Option<String> {
    env::var(name).ok().and_then(|value| trim_non_empty(&value))
}

fn trim_non_empty(value: &str) -> Option<String> {
    let trimmed = value.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

fn ensure_trailing_slash(value: &str) -> String {
    if value.ends_with('/') {
        value.to_string()
    } else {
        format!("{value}/")
    }
}

fn truncate_error_body(body: &str) -> String {
    let trimmed = body.trim();
    if trimmed.chars().count() <= MAX_ERROR_BODY_CHARS {
        return trimmed.to_string();
    }

    let mut truncated: String = trimmed.chars().take(MAX_ERROR_BODY_CHARS).collect();
    truncated.push_str("...");
    truncated
}

fn messages_payload_from_sse_message(event: &SseMessage) -> Result<Option<Value>, String> {
    if event.event != "messages" || event.data.is_empty() {
        return Ok(None);
    }

    let payload: Value = serde_json::from_str(&event.data)
        .map_err(|error| format!("Failed to parse kgoose SSE event: {error}"))?;

    // kgoose has sent both proto/snake casing and generated/camel casing across
    // clients; keep accepting both at this boundary.
    if payload.get("get_messages_response").is_some()
        || payload.get("getMessagesResponse").is_some()
    {
        Ok(Some(payload))
    } else {
        Ok(None)
    }
}

#[cfg(test)]
mod tests {
    use super::{
        build_kgoose_sse_url, build_kgoose_url, kgoose_playpen_baggage,
        messages_payload_from_sse_message, truncate_error_body, KgooseDistroConfig,
        KGOOSE_AUTOMATIONS_BASE_URL_ENV, KGOOSE_AUTOMATIONS_PATH_ENV,
        KGOOSE_AUTOMATIONS_PLAYPEN_ENV,
    };
    use crate::commands::sse::SseMessage;
    use serde_json::json;
    use std::env;
    use std::sync::Mutex;

    // All tests that mutate GOOSE_INTERNAL_KGOOSE_* must use this lock.
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn builds_default_kgoose_url() {
        let _guard = ENV_LOCK.lock().unwrap();
        env::remove_var(KGOOSE_AUTOMATIONS_BASE_URL_ENV);
        env::remove_var(KGOOSE_AUTOMATIONS_PATH_ENV);

        assert_eq!(
            build_kgoose_url("v3/get-user-tiles", None)
                .unwrap()
                .as_str(),
            "https://kgoose.stage.sqprod.co/cash-app/goose/v3/get-user-tiles"
        );
    }

    #[test]
    fn builds_distro_kgoose_url() {
        let _guard = ENV_LOCK.lock().unwrap();
        env::remove_var(KGOOSE_AUTOMATIONS_BASE_URL_ENV);
        env::remove_var(KGOOSE_AUTOMATIONS_PATH_ENV);
        let config = KgooseDistroConfig {
            base_url: Some("https://kgoose.sqprod.co/base/".to_string()),
            path: Some("/prod/path/".to_string()),
        };

        assert_eq!(
            build_kgoose_url("/v3/get-tile", Some(&config))
                .unwrap()
                .as_str(),
            "https://kgoose.sqprod.co/base/prod/path/v3/get-tile"
        );
    }

    #[test]
    fn env_overrides_distro_kgoose_url_without_double_slashes() {
        let _guard = ENV_LOCK.lock().unwrap();
        env::set_var(
            KGOOSE_AUTOMATIONS_BASE_URL_ENV,
            "https://example.test/base/",
        );
        env::set_var(KGOOSE_AUTOMATIONS_PATH_ENV, "/custom/path/");
        let config = KgooseDistroConfig {
            base_url: Some("https://kgoose.sqprod.co/".to_string()),
            path: Some("ignored".to_string()),
        };

        assert_eq!(
            build_kgoose_url("/v3/get-tile", Some(&config))
                .unwrap()
                .as_str(),
            "https://example.test/base/custom/path/v3/get-tile"
        );

        env::remove_var(KGOOSE_AUTOMATIONS_BASE_URL_ENV);
        env::remove_var(KGOOSE_AUTOMATIONS_PATH_ENV);
    }

    #[test]
    fn rejects_non_http_base_url() {
        let _guard = ENV_LOCK.lock().unwrap();
        env::set_var(KGOOSE_AUTOMATIONS_BASE_URL_ENV, "file:///tmp");

        let error = build_kgoose_url("v3/get-user-tiles", None).unwrap_err();
        assert!(error.contains(KGOOSE_AUTOMATIONS_BASE_URL_ENV));

        env::remove_var(KGOOSE_AUTOMATIONS_BASE_URL_ENV);
    }

    #[test]
    fn attributes_bad_distro_base_url_to_distro_config() {
        let _guard = ENV_LOCK.lock().unwrap();
        env::remove_var(KGOOSE_AUTOMATIONS_BASE_URL_ENV);
        env::remove_var(KGOOSE_AUTOMATIONS_PATH_ENV);
        let config = KgooseDistroConfig {
            base_url: Some("file:///tmp".to_string()),
            path: Some("prod/path".to_string()),
        };

        let error = build_kgoose_url("v3/get-user-tiles", Some(&config)).unwrap_err();

        assert!(error.contains("distro kgoose baseUrl"));
        assert!(!error.contains(KGOOSE_AUTOMATIONS_BASE_URL_ENV));
    }

    #[test]
    fn truncates_long_error_bodies() {
        let body = "x".repeat(600);
        let truncated = truncate_error_body(&body);

        assert_eq!(truncated.chars().count(), 503);
        assert!(truncated.ends_with("..."));
    }

    #[test]
    fn builds_sse_url_with_encoded_session_id() {
        let _guard = ENV_LOCK.lock().unwrap();
        env::remove_var(KGOOSE_AUTOMATIONS_BASE_URL_ENV);
        env::remove_var(KGOOSE_AUTOMATIONS_PATH_ENV);

        assert_eq!(
            build_kgoose_sse_url("v3/get-messages-sse", "session/1", None)
                .unwrap()
                .as_str(),
            "https://kgoose.stage.sqprod.co/cash-app/goose/v3/get-messages-sse?session_id=session%2F1"
        );
    }

    #[test]
    fn builds_playpen_baggage_from_trimmed_env() {
        let _guard = ENV_LOCK.lock().unwrap();
        env::set_var(KGOOSE_AUTOMATIONS_PLAYPEN_ENV, " kalvin ");

        assert_eq!(
            kgoose_playpen_baggage(),
            Some("kgoose-playpen=kalvin".to_string())
        );

        env::remove_var(KGOOSE_AUTOMATIONS_PLAYPEN_ENV);
    }

    #[test]
    fn omits_empty_playpen_baggage() {
        let _guard = ENV_LOCK.lock().unwrap();
        env::set_var(KGOOSE_AUTOMATIONS_PLAYPEN_ENV, " ");

        assert_eq!(kgoose_playpen_baggage(), None);

        env::remove_var(KGOOSE_AUTOMATIONS_PLAYPEN_ENV);
    }

    #[test]
    fn extracts_only_full_messages_sse_payloads() {
        let delta = SseMessage {
            id: None,
            event: "messages".to_string(),
            data: "{\"delta_message_content\":{\"streaming_message_id\":\"msg-1\"}}".to_string(),
        };
        assert!(messages_payload_from_sse_message(&delta).unwrap().is_none());

        let snapshot = SseMessage {
            id: None,
            event: "messages".to_string(),
            data: "{\"get_messages_response\":{\"messages\":[{\"id\":\"msg-1\"}]}}".to_string(),
        };
        assert_eq!(
            messages_payload_from_sse_message(&snapshot).unwrap(),
            Some(json!({
                "get_messages_response": {
                    "messages": [{ "id": "msg-1" }]
                }
            }))
        );
    }
}
