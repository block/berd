use reqwest::{
    header::{ACCEPT, CONTENT_TYPE},
    redirect::Policy,
};
use serde::Serialize;
use std::{sync::OnceLock, time::Duration};

const TELEMETRY_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const TELEMETRY_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const ALLOWED_TELEMETRY_BATCH_URLS: [&str; 2] = [
    "https://api.squareup.com/1.0/unifiedevents/batch",
    "https://api.squareupstaging.com/1.0/unifiedevents/batch",
];

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TelemetryBatchResponse {
    pub status: u16,
    pub status_text: String,
    pub body: String,
}

/// Sends a PAE Unified Eventing batch through native networking so WebView CORS
/// cannot block the telemetry SDK's browser fetch path. The URL must be one of
/// the exact production/staging PAE batch endpoints; HTTP 4xx/5xx responses are
/// returned to the renderer so @squareup/cdp can apply its own retry semantics.
#[tauri::command]
pub async fn send_telemetry_batch(
    url: String,
    body: String,
) -> Result<TelemetryBatchResponse, String> {
    let url = allowed_telemetry_batch_url(&url)?;
    let response = client()
        .post(url.clone())
        .header(ACCEPT, "application/json")
        .header(CONTENT_TYPE, "application/json")
        .timeout(TELEMETRY_REQUEST_TIMEOUT)
        .body(body)
        .send()
        .await
        .map_err(|error| {
            format!(
                "Failed to send telemetry batch to {}: {error}",
                url.as_str()
            )
        })?;

    let status = response.status();
    let status_text = status.canonical_reason().unwrap_or("").to_string();
    let body = response
        .text()
        .await
        .map_err(|error| format!("Failed to read telemetry response from {}: {error}", url))?;

    Ok(TelemetryBatchResponse {
        status: status.as_u16(),
        status_text,
        body,
    })
}

fn allowed_telemetry_batch_url(raw_url: &str) -> Result<reqwest::Url, String> {
    let url = reqwest::Url::parse(raw_url)
        .map_err(|error| format!("Invalid telemetry batch URL {raw_url}: {error}"))?;

    if ALLOWED_TELEMETRY_BATCH_URLS
        .iter()
        .any(|allowed_url| *allowed_url == url.as_str())
    {
        Ok(url)
    } else {
        Err(format!("Telemetry batch URL is not allowed: {raw_url}"))
    }
}

fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .connect_timeout(TELEMETRY_CONNECT_TIMEOUT)
            .redirect(Policy::none())
            .build()
            .expect("failed to build telemetry HTTP client")
    })
}

#[cfg(test)]
mod tests {
    use super::allowed_telemetry_batch_url;

    #[test]
    fn allows_exact_production_batch_url() {
        let url = allowed_telemetry_batch_url("https://api.squareup.com/1.0/unifiedevents/batch")
            .unwrap();

        assert_eq!(
            url.as_str(),
            "https://api.squareup.com/1.0/unifiedevents/batch"
        );
    }

    #[test]
    fn allows_exact_staging_batch_url() {
        let url =
            allowed_telemetry_batch_url("https://api.squareupstaging.com/1.0/unifiedevents/batch")
                .unwrap();

        assert_eq!(
            url.as_str(),
            "https://api.squareupstaging.com/1.0/unifiedevents/batch"
        );
    }

    #[test]
    fn rejects_query_string_on_allowed_host() {
        let error = allowed_telemetry_batch_url(
            "https://api.squareup.com/1.0/unifiedevents/batch?redirect=https://example.com",
        )
        .unwrap_err();

        assert!(error.contains("not allowed"));
    }

    #[test]
    fn rejects_spoofed_host() {
        let error = allowed_telemetry_batch_url(
            "https://api.squareup.com.example.com/1.0/unifiedevents/batch",
        )
        .unwrap_err();

        assert!(error.contains("not allowed"));
    }
}
