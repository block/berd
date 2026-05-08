use std::env;

use crate::services::distro_bundle::{DistroBundleState, KgooseDistroConfig};
use reqwest::header::{ACCEPT, CONTENT_TYPE};
use serde_json::{json, Value};
use tauri::State;

const KGOOSE_AUTOMATIONS_BASE_URL_ENV: &str = "GOOSE_INTERNAL_KGOOSE_BASE_URL";
const KGOOSE_AUTOMATIONS_PATH_ENV: &str = "GOOSE_INTERNAL_KGOOSE_PATH";
const DEFAULT_KGOOSE_BASE_URL: &str = "https://kgoose.stage.sqprod.co/";
const DEFAULT_KGOOSE_PATH: &str = "cash-app/goose";
const GET_USER_TILES_ENDPOINT: &str = "v3/get-user-tiles";
const GET_TILE_ENDPOINT: &str = "v3/get-tile";
const GET_TILE_RESULTS_ENDPOINT: &str = "v3/get-tile-results";
const MAX_ERROR_BODY_CHARS: usize = 500;

#[tauri::command]
pub async fn get_automation_tiles(state: State<'_, DistroBundleState>) -> Result<Value, String> {
    post_kgoose_json(
        state.inner(),
        GET_USER_TILES_ENDPOINT,
        json!({ "spaceId": null }),
    )
    .await
}

#[tauri::command]
pub async fn get_automation_tile(
    state: State<'_, DistroBundleState>,
    id: String,
) -> Result<Value, String> {
    let id = validate_id(id, "automation id")?;
    post_kgoose_json(state.inner(), GET_TILE_ENDPOINT, json!({ "id": id })).await
}

#[tauri::command]
pub async fn get_automation_tile_results(
    state: State<'_, DistroBundleState>,
    tile_id: String,
) -> Result<Value, String> {
    let tile_id = validate_id(tile_id, "automation id")?;
    post_kgoose_json(
        state.inner(),
        GET_TILE_RESULTS_ENDPOINT,
        json!({ "tileId": tile_id }),
    )
    .await
}

async fn post_kgoose_json(
    distro_state: &DistroBundleState,
    endpoint: &str,
    body: Value,
) -> Result<Value, String> {
    let url = build_kgoose_url(endpoint, distro_state.kgoose_config())?;
    let response = reqwest::Client::new()
        .post(url.clone())
        .header(ACCEPT, "application/json")
        .header(CONTENT_TYPE, "application/json")
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

fn validate_id(value: String, label: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(format!("{label} must not be empty"));
    }
    Ok(trimmed.to_string())
}

fn build_kgoose_url(
    endpoint: &str,
    distro_config: Option<&KgooseDistroConfig>,
) -> Result<reqwest::Url, String> {
    let base_url = config_value(
        KGOOSE_AUTOMATIONS_BASE_URL_ENV,
        distro_config.and_then(|config| config.base_url.as_deref()),
        DEFAULT_KGOOSE_BASE_URL,
    );
    let path_prefix = config_value(
        KGOOSE_AUTOMATIONS_PATH_ENV,
        distro_config.and_then(|config| config.path.as_deref()),
        DEFAULT_KGOOSE_PATH,
    );

    let mut url = reqwest::Url::parse(&ensure_trailing_slash(&base_url))
        .map_err(|error| format!("Invalid {KGOOSE_AUTOMATIONS_BASE_URL_ENV}: {error}"))?;

    if !matches!(url.scheme(), "http" | "https") {
        return Err(format!(
            "{KGOOSE_AUTOMATIONS_BASE_URL_ENV} must use http or https"
        ));
    }

    let path = [url.path(), path_prefix.as_str(), endpoint]
        .into_iter()
        .map(|segment| segment.trim_matches('/'))
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>()
        .join("/");
    url.set_path(&path);

    Ok(url)
}

fn config_value(name: &str, distro_value: Option<&str>, default: &str) -> String {
    env_value(name)
        .or_else(|| distro_value.and_then(trim_non_empty))
        .unwrap_or_else(|| default.to_string())
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

#[cfg(test)]
mod tests {
    use super::{
        build_kgoose_url, truncate_error_body, KgooseDistroConfig, KGOOSE_AUTOMATIONS_BASE_URL_ENV,
        KGOOSE_AUTOMATIONS_PATH_ENV,
    };
    use std::env;
    use std::sync::Mutex;

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

        assert!(build_kgoose_url("v3/get-user-tiles", None).is_err());

        env::remove_var(KGOOSE_AUTOMATIONS_BASE_URL_ENV);
    }

    #[test]
    fn truncates_long_error_bodies() {
        let body = "x".repeat(600);
        let truncated = truncate_error_body(&body);

        assert_eq!(truncated.chars().count(), 503);
        assert!(truncated.ends_with("..."));
    }
}
