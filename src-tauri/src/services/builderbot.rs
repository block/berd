use reqwest::{header::ACCEPT, StatusCode};
use serde_json::Value;
use std::{env, sync::OnceLock, time::Duration};

const BUILDERBOT_BASE_URL_ENV: &str = "GOOSE_INTERNAL_BUILDERBOT_BASE_URL";
const DEFAULT_BUILDERBOT_BASE_URL: &str = "https://builderbot.sqprod.co/";
const BUILDERBOT_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_ERROR_BODY_CHARS: usize = 500;

pub(crate) async fn get_json(endpoint: &str, query: &[(&str, String)]) -> Result<Value, String> {
    let url = build_url(endpoint, query)?;
    let response = client()
        .get(url.clone())
        .header(ACCEPT, "application/json")
        .timeout(BUILDERBOT_REQUEST_TIMEOUT)
        .send()
        .await
        .map_err(|error| {
            if error.is_timeout() || error.is_connect() {
                "Unable to reach Builderbot. Check that you're connected to Cloudflare WARP and try again."
                    .to_string()
            } else {
                format!("Builderbot request failed: {error}")
            }
        })?;

    response_to_json(url, response).await
}

pub(crate) async fn put_json(endpoint: &str, body: Value) -> Result<Value, String> {
    let url = build_url(endpoint, &[])?;
    let response = client()
        .put(url.clone())
        .header(ACCEPT, "application/json")
        .json(&body)
        .timeout(BUILDERBOT_REQUEST_TIMEOUT)
        .send()
        .await
        .map_err(|error| {
            if error.is_timeout() || error.is_connect() {
                "Unable to reach Builderbot. Check that you're connected to Cloudflare WARP and try again."
                    .to_string()
            } else {
                format!("Builderbot request failed: {error}")
            }
        })?;

    response_to_json(url, response).await
}

fn build_url(endpoint: &str, query: &[(&str, String)]) -> Result<reqwest::Url, String> {
    let base_url = env::var(BUILDERBOT_BASE_URL_ENV)
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_BUILDERBOT_BASE_URL.to_string());
    let mut url = reqwest::Url::parse(&ensure_trailing_slash(&base_url))
        .map_err(|error| format!("Invalid Builderbot base URL: {error}"))?;
    url = url
        .join(endpoint.trim_start_matches('/'))
        .map_err(|error| format!("Invalid Builderbot endpoint: {error}"))?;
    {
        let mut pairs = url.query_pairs_mut();
        for (key, value) in query {
            if !value.trim().is_empty() {
                pairs.append_pair(key, value);
            }
        }
    }
    Ok(url)
}

async fn response_to_json(url: reqwest::Url, response: reqwest::Response) -> Result<Value, String> {
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|error| format!("Failed to read Builderbot response: {error}"))?;

    if !status.is_success() {
        return Err(format!(
            "Builderbot request failed with {}: {}",
            status_label(status),
            truncate_error_body(&body)
        ));
    }

    serde_json::from_str(&body).map_err(|error| {
        format!(
            "Failed to parse Builderbot response from {}: {error}",
            url.as_str()
        )
    })
}

fn status_label(status: StatusCode) -> String {
    status
        .canonical_reason()
        .map(|reason| format!("{status} {reason}"))
        .unwrap_or_else(|| status.to_string())
}

fn truncate_error_body(body: &str) -> String {
    let trimmed = body.trim();
    if trimmed.chars().count() <= MAX_ERROR_BODY_CHARS {
        return trimmed.to_string();
    }
    let mut preview: String = trimmed.chars().take(MAX_ERROR_BODY_CHARS).collect();
    preview.push_str("...");
    preview
}

fn ensure_trailing_slash(value: &str) -> String {
    if value.ends_with('/') {
        value.to_string()
    } else {
        format!("{value}/")
    }
}

fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("failed to build Builderbot HTTP client")
    })
}
