use crate::services::distro_bundle::{DistroBundleState, KgooseDistroConfig};
use reqwest::header::{ACCEPT, CONTENT_TYPE};
use serde_json::Value;
use std::{env, sync::OnceLock, time::Duration};

const KGOOSE_CONNECTIONS_BASE_URL_ENV: &str = "GOOSE_INTERNAL_KGOOSE_BASE_URL";
const KGOOSE_CONNECTIONS_PATH_ENV: &str = "GOOSE_INTERNAL_KGOOSE_PATH";
const DEFAULT_KGOOSE_BASE_URL: &str = "https://kgoose.stage.sqprod.co/";
const DEFAULT_KGOOSE_PATH: &str = "cash-app/goose";
const MAX_ERROR_BODY_CHARS: usize = 500;
const KGOOSE_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const KGOOSE_JSON_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

pub(super) const LIST_OAUTH_EXTENSIONS_ENDPOINT: &str = "list-oauth-extensions";

pub(super) async fn post_kgoose_json(
    distro_state: &DistroBundleState,
    endpoint: &str,
    body: Value,
) -> Result<Value, String> {
    let url = build_kgoose_url(endpoint, distro_state.kgoose_config())?;
    // TODO(connect-in-app): forward Auth0 G2 JWT — see kgoose note. Until the
    // backend wires that up, parity with automations endpoints means going
    // unauthenticated here.
    let response = kgoose_client()
        .post(url.clone())
        .header(ACCEPT, "application/json")
        .header(CONTENT_TYPE, "application/json")
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

pub(super) async fn list_oauth_extensions(
    distro_state: &DistroBundleState,
) -> Result<Value, String> {
    post_kgoose_json(
        distro_state,
        LIST_OAUTH_EXTENSIONS_ENDPOINT,
        Value::Object(Default::default()),
    )
    .await
}

fn kgoose_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .connect_timeout(KGOOSE_CONNECT_TIMEOUT)
            .build()
            .expect("failed to build kgoose connections HTTP client")
    })
}

fn build_kgoose_url(
    endpoint: &str,
    distro_config: Option<&KgooseDistroConfig>,
) -> Result<reqwest::Url, String> {
    let base_url = config_value(
        KGOOSE_CONNECTIONS_BASE_URL_ENV,
        distro_config.and_then(|config| config.base_url.as_deref()),
        DEFAULT_KGOOSE_BASE_URL,
        "distro kgoose baseUrl",
        "default kgoose base URL",
    );
    let path_prefix = config_value(
        KGOOSE_CONNECTIONS_PATH_ENV,
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

#[cfg(test)]
mod tests {
    use super::{build_kgoose_url, KgooseDistroConfig, LIST_OAUTH_EXTENSIONS_ENDPOINT};
    use std::env;
    use std::sync::Mutex;

    // Shared with the automations client tests because they mutate the same
    // process-wide env vars.
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn builds_distro_kgoose_url() {
        let _guard = ENV_LOCK.lock().unwrap();
        env::remove_var("GOOSE_INTERNAL_KGOOSE_BASE_URL");
        env::remove_var("GOOSE_INTERNAL_KGOOSE_PATH");

        let config = KgooseDistroConfig {
            base_url: Some("https://kgoose.sqprod.co/base/".to_string()),
            path: Some("/prod/path/".to_string()),
        };
        assert_eq!(
            build_kgoose_url(LIST_OAUTH_EXTENSIONS_ENDPOINT, Some(&config))
                .unwrap()
                .as_str(),
            "https://kgoose.sqprod.co/base/prod/path/list-oauth-extensions"
        );
    }
}
