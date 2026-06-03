use crate::services::distro_bundle::{DistroBundleState, KgooseDistroConfig};
use bytes::Bytes;
use reqwest::{
    header::{HeaderValue, ACCEPT, CACHE_CONTROL, CONTENT_TYPE},
    multipart::Form,
    redirect::Policy,
    StatusCode,
};
use serde::Serialize;
use serde_json::Value;
use std::{env, fmt, sync::OnceLock, time::Duration};
use tokio::time::timeout;

const KGOOSE_BASE_URL_ENV: &str = "GOOSE_INTERNAL_KGOOSE_BASE_URL";
const KGOOSE_PATH_ENV: &str = "GOOSE_INTERNAL_KGOOSE_PATH";
const KGOOSE_PLAYPEN_ENV: &str = "GOOSE_INTERNAL_KGOOSE_PLAYPEN";
const DEFAULT_KGOOSE_BASE_URL: &str = "https://kgoose.stage.sqprod.co/";
const DEFAULT_KGOOSE_PATH: &str = "cash-app/goose";
const KGOOSE_NETWORK_ACCESS_MESSAGE: &str =
    "Unable to reach the internal service. Please check that you're connected to Cloudflare WARP and try again.";
const MAX_ERROR_BODY_CHARS: usize = 500;
const KGOOSE_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const KGOOSE_JSON_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const KGOOSE_UPLOAD_READ_TIMEOUT: Duration = Duration::from_secs(120);
const KGOOSE_SSE_IDLE_TIMEOUT: Duration = Duration::from_secs(120);
const KGOOSE_PROBE_TIMEOUT: Duration = Duration::from_secs(5);
const KGOOSE_CONNECTIVITY_PROBE_ENDPOINT: &str = "list-oauth-extensions";

pub(crate) async fn post_json(
    distro_state: &DistroBundleState,
    endpoint: &str,
    body: Value,
) -> Result<Value, String> {
    post_json_detailed(distro_state, endpoint, body)
        .await
        .map_err(|error| error.user_message())
}

pub(crate) async fn post_json_detailed(
    distro_state: &DistroBundleState,
    endpoint: &str,
    body: Value,
) -> Result<Value, KgooseJsonError> {
    let url = build_url(endpoint, distro_state.kgoose_config())?;
    let request = add_playpen_baggage(json_post_request(url.clone()));
    send_json_request_detailed(request, url, &body).await
}

pub(crate) async fn post_multipart_detailed(
    distro_state: &DistroBundleState,
    endpoint: &str,
    form: Form,
) -> Result<Value, KgooseJsonError> {
    let url = build_url(endpoint, distro_state.kgoose_config())?;
    let request = add_playpen_baggage(
        upload_client()
            .post(url.clone())
            .header(ACCEPT, "application/json"),
    );
    send_multipart_request_detailed(request, url, form).await
}

/// Posts JSON to a fully resolved external URL without distro routing or playpen baggage.
pub(crate) async fn post_json_external_url(url: &str, body: Value) -> Result<Value, String> {
    let url = reqwest::Url::parse(url)
        .map_err(|error| format!("Invalid kgoose request URL {url}: {error}"))?;
    send_json_request(json_post_request(url.clone()), url, &body).await
}

fn json_post_request(url: reqwest::Url) -> reqwest::RequestBuilder {
    client()
        .post(url)
        .header(ACCEPT, "application/json")
        .header(CONTENT_TYPE, "application/json")
}

async fn send_json_request(
    request: reqwest::RequestBuilder,
    url: reqwest::Url,
    body: &Value,
) -> Result<Value, String> {
    send_json_request_detailed(request, url, body)
        .await
        .map_err(|error| error.user_message())
}

async fn send_json_request_detailed(
    request: reqwest::RequestBuilder,
    url: reqwest::Url,
    body: &Value,
) -> Result<Value, KgooseJsonError> {
    let response = request
        .timeout(KGOOSE_JSON_REQUEST_TIMEOUT)
        .json(body)
        .send()
        .await
        .map_err(|error| KgooseJsonError::request(&url, error))?;

    response_to_json_value(url, response).await
}

async fn send_multipart_request_detailed(
    request: reqwest::RequestBuilder,
    url: reqwest::Url,
    form: Form,
) -> Result<Value, KgooseJsonError> {
    let response = request
        .multipart(form)
        .send()
        .await
        .map_err(|error| KgooseJsonError::multipart_request(&url, error))?;

    response_to_json_value(url, response).await
}

async fn response_to_json_value(
    url: reqwest::Url,
    response: reqwest::Response,
) -> Result<Value, KgooseJsonError> {
    let status = response.status();
    let content_type = response_content_type(response.headers());
    let response_body = response
        .text()
        .await
        .map_err(|error| KgooseJsonError::read(&url, error))?;

    if !status.is_success() {
        let body_preview = truncate_error_body(&response_body);
        return Err(KgooseJsonError::response(
            Some(status),
            content_type,
            format!(
                "kgoose request to {} failed with {}: {}",
                url.as_str(),
                status,
                body_preview
            ),
        ));
    }

    serde_json::from_str(&response_body).map_err(|error| {
        KgooseJsonError::response(
            Some(status),
            content_type,
            format!(
                "Failed to parse kgoose response from {}: {error}",
                url.as_str()
            ),
        )
    })
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum KgooseRequestErrorKind {
    Timeout,
    Connect,
    Redirect,
    Other,
}

impl KgooseRequestErrorKind {
    fn from_reqwest_error(error: &reqwest::Error) -> Self {
        if error.is_timeout() {
            Self::Timeout
        } else if error.is_connect() {
            Self::Connect
        } else if error.is_redirect() {
            Self::Redirect
        } else {
            Self::Other
        }
    }

    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Timeout => "timeout",
            Self::Connect => "connect",
            Self::Redirect => "redirect",
            Self::Other => "request",
        }
    }
}

#[derive(Debug)]
pub(crate) struct KgooseJsonError {
    message: String,
    kind: &'static str,
    status: Option<StatusCode>,
    content_type: Option<String>,
    request_error_kind: Option<KgooseRequestErrorKind>,
    likely_access_failure: bool,
}

impl KgooseJsonError {
    fn request(url: &reqwest::Url, error: reqwest::Error) -> Self {
        let kind = KgooseRequestErrorKind::from_reqwest_error(&error);
        Self::request_with_kind(url, error, kind, is_access_request_error_kind(kind))
    }

    fn multipart_request(url: &reqwest::Url, error: reqwest::Error) -> Self {
        let kind = KgooseRequestErrorKind::from_reqwest_error(&error);
        Self::request_with_kind(
            url,
            error,
            kind,
            is_multipart_access_request_error_kind(kind),
        )
    }

    fn request_with_kind(
        url: &reqwest::Url,
        error: reqwest::Error,
        kind: KgooseRequestErrorKind,
        likely_access_failure: bool,
    ) -> Self {
        Self {
            message: format!("Failed to call kgoose at {}: {error}", url.as_str()),
            kind: "request",
            status: None,
            content_type: None,
            request_error_kind: Some(kind),
            likely_access_failure,
        }
    }

    fn read(url: &reqwest::Url, error: reqwest::Error) -> Self {
        Self {
            message: format!(
                "Failed to read kgoose response from {}: {error}",
                url.as_str()
            ),
            kind: "read",
            status: None,
            content_type: None,
            request_error_kind: None,
            likely_access_failure: false,
        }
    }

    fn response(status: Option<StatusCode>, content_type: Option<String>, message: String) -> Self {
        let kind = match status {
            Some(status) if status.is_success() => "json_parse",
            Some(_) => "http_status",
            None => "read",
        };
        Self {
            message,
            kind,
            status,
            content_type,
            request_error_kind: None,
            likely_access_failure: status.is_some_and(is_access_status),
        }
    }

    pub(crate) fn kind(&self) -> &'static str {
        self.kind
    }

    pub(crate) fn is_likely_access_failure(&self) -> bool {
        self.likely_access_failure
    }

    pub(crate) fn user_message(&self) -> String {
        if self.is_likely_access_failure() {
            KGOOSE_NETWORK_ACCESS_MESSAGE.to_string()
        } else {
            self.to_string()
        }
    }

    pub(crate) fn status(&self) -> Option<StatusCode> {
        self.status
    }

    pub(crate) fn content_type(&self) -> Option<&str> {
        self.content_type.as_deref()
    }

    pub(crate) fn request_error_kind(&self) -> Option<KgooseRequestErrorKind> {
        self.request_error_kind
    }
}

impl fmt::Display for KgooseJsonError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl From<String> for KgooseJsonError {
    fn from(message: String) -> Self {
        Self {
            message,
            kind: "configuration",
            status: None,
            content_type: None,
            request_error_kind: None,
            likely_access_failure: false,
        }
    }
}

fn response_content_type(headers: &reqwest::header::HeaderMap) -> Option<String> {
    headers
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string)
}

fn is_access_status(status: StatusCode) -> bool {
    status.is_redirection()
        || matches!(
            status,
            StatusCode::UNAUTHORIZED
                | StatusCode::FORBIDDEN
                | StatusCode::PROXY_AUTHENTICATION_REQUIRED
        )
}

fn is_access_request_error_kind(kind: KgooseRequestErrorKind) -> bool {
    matches!(
        kind,
        KgooseRequestErrorKind::Timeout
            | KgooseRequestErrorKind::Connect
            | KgooseRequestErrorKind::Redirect
    )
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct KgooseProbeResult {
    pub likely_warp_failure: bool,
    pub status: Option<u16>,
    pub kind: &'static str,
    pub message: String,
}

/// Issues a small read-only request against a configured kgoose endpoint and
/// classifies the response. Used by the startup-error diagnostic flow to
/// distinguish a WARP/network failure from a backend bug.
pub(crate) async fn probe_connectivity(
    distro_state: &DistroBundleState,
) -> Result<KgooseProbeResult, String> {
    let url = build_url(
        KGOOSE_CONNECTIVITY_PROBE_ENDPOINT,
        distro_state.kgoose_config(),
    )?;
    Ok(probe_url(url).await)
}

async fn probe_url(url: reqwest::Url) -> KgooseProbeResult {
    let request = add_playpen_baggage(json_post_request(url.clone()))
        .timeout(KGOOSE_PROBE_TIMEOUT)
        .json(&serde_json::json!({}));
    match request.send().await {
        Ok(response) => {
            let status = response.status();
            KgooseProbeResult {
                likely_warp_failure: is_access_status(status),
                status: Some(status.as_u16()),
                kind: "http_status",
                message: format!("kgoose probe to {} returned {}", url.as_str(), status),
            }
        }
        Err(error) => {
            let kind = KgooseRequestErrorKind::from_reqwest_error(&error);
            KgooseProbeResult {
                likely_warp_failure: is_access_request_error_kind(kind),
                status: None,
                kind: "request",
                message: format!(
                    "kgoose probe to {} failed ({}): {error}",
                    url.as_str(),
                    kind.as_str()
                ),
            }
        }
    }
}

fn is_multipart_access_request_error_kind(kind: KgooseRequestErrorKind) -> bool {
    matches!(
        kind,
        KgooseRequestErrorKind::Connect | KgooseRequestErrorKind::Redirect
    )
}

pub(crate) async fn open_sse_stream(
    url: reqwest::Url,
    last_event_id: Option<HeaderValue>,
) -> Result<reqwest::Response, String> {
    let request = client()
        .get(url.clone())
        .header(ACCEPT, "text/event-stream")
        .header(CACHE_CONTROL, "no-cache");
    let request = add_playpen_baggage(request);
    let request = match last_event_id {
        Some(last_event_id) => request.header("Last-Event-ID", last_event_id),
        None => request,
    };

    let response = request.send().await.map_err(|error| {
        let kind = KgooseRequestErrorKind::from_reqwest_error(&error);
        if is_access_request_error_kind(kind) {
            KGOOSE_NETWORK_ACCESS_MESSAGE.to_string()
        } else {
            format!("Failed to open kgoose stream at {}: {error}", url.as_str())
        }
    })?;
    let status = response.status();
    if status.is_success() {
        return Ok(response);
    }

    let response_body = response.text().await.unwrap_or_default();
    if is_access_status(status) {
        return Err(KGOOSE_NETWORK_ACCESS_MESSAGE.to_string());
    }

    Err(format!(
        "kgoose stream to {} failed with {}: {}",
        url.as_str(),
        status,
        truncate_error_body(&response_body)
    ))
}

pub(crate) async fn read_sse_chunk(
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

pub(crate) fn build_sse_url(
    endpoint: &str,
    session_id: &str,
    distro_config: Option<&KgooseDistroConfig>,
) -> Result<reqwest::Url, String> {
    let mut url = build_url(endpoint, distro_config)?;
    url.query_pairs_mut().append_pair("session_id", session_id);
    Ok(url)
}

fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .connect_timeout(KGOOSE_CONNECT_TIMEOUT)
            .redirect(Policy::none())
            .build()
            .expect("failed to build kgoose HTTP client")
    })
}

fn upload_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .connect_timeout(KGOOSE_CONNECT_TIMEOUT)
            .read_timeout(KGOOSE_UPLOAD_READ_TIMEOUT)
            .redirect(Policy::none())
            .build()
            .expect("failed to build kgoose upload HTTP client")
    })
}

fn add_playpen_baggage(request: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
    match playpen_baggage() {
        Some(playpen_baggage) => request.header("Baggage", playpen_baggage),
        None => request,
    }
}

fn playpen_baggage() -> Option<String> {
    env_value(KGOOSE_PLAYPEN_ENV).map(|playpen| format!("kgoose-playpen={playpen}"))
}

fn build_url(
    endpoint: &str,
    distro_config: Option<&KgooseDistroConfig>,
) -> Result<reqwest::Url, String> {
    let base_url = config_value(
        KGOOSE_BASE_URL_ENV,
        distro_config.and_then(|config| config.base_url.as_deref()),
        DEFAULT_KGOOSE_BASE_URL,
        "distro kgoose baseUrl",
        "default kgoose base URL",
    );
    let path_prefix = config_value(
        KGOOSE_PATH_ENV,
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
    use super::{
        build_sse_url, build_url, is_access_request_error_kind,
        is_multipart_access_request_error_kind, playpen_baggage, probe_url, truncate_error_body,
        KgooseDistroConfig, KgooseJsonError, KgooseRequestErrorKind, KGOOSE_BASE_URL_ENV,
        KGOOSE_PATH_ENV, KGOOSE_PLAYPEN_ENV,
    };
    use reqwest::StatusCode;
    use std::env;
    use std::sync::Mutex;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    // All tests that mutate GOOSE_INTERNAL_KGOOSE_* must use this lock.
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn builds_default_kgoose_url() {
        let _guard = ENV_LOCK.lock().unwrap();
        env::remove_var(KGOOSE_BASE_URL_ENV);
        env::remove_var(KGOOSE_PATH_ENV);

        assert_eq!(
            build_url("v3/get-user-tiles", None).unwrap().as_str(),
            "https://kgoose.stage.sqprod.co/cash-app/goose/v3/get-user-tiles"
        );
    }

    #[test]
    fn builds_distro_kgoose_url() {
        let _guard = ENV_LOCK.lock().unwrap();
        env::remove_var(KGOOSE_BASE_URL_ENV);
        env::remove_var(KGOOSE_PATH_ENV);
        let config = KgooseDistroConfig {
            base_url: Some("https://kgoose.sqprod.co/base/".to_string()),
            path: Some("/prod/path/".to_string()),
        };

        assert_eq!(
            build_url("/v3/get-tile", Some(&config)).unwrap().as_str(),
            "https://kgoose.sqprod.co/base/prod/path/v3/get-tile"
        );
    }

    #[test]
    fn env_overrides_distro_kgoose_url_without_double_slashes() {
        let _guard = ENV_LOCK.lock().unwrap();
        env::set_var(KGOOSE_BASE_URL_ENV, "https://example.test/base/");
        env::set_var(KGOOSE_PATH_ENV, "/custom/path/");
        let config = KgooseDistroConfig {
            base_url: Some("https://kgoose.sqprod.co/".to_string()),
            path: Some("ignored".to_string()),
        };

        assert_eq!(
            build_url("/v3/get-tile", Some(&config)).unwrap().as_str(),
            "https://example.test/base/custom/path/v3/get-tile"
        );

        env::remove_var(KGOOSE_BASE_URL_ENV);
        env::remove_var(KGOOSE_PATH_ENV);
    }

    #[test]
    fn rejects_non_http_base_url() {
        let _guard = ENV_LOCK.lock().unwrap();
        env::set_var(KGOOSE_BASE_URL_ENV, "file:///tmp");

        let error = build_url("v3/get-user-tiles", None).unwrap_err();
        assert!(error.contains(KGOOSE_BASE_URL_ENV));

        env::remove_var(KGOOSE_BASE_URL_ENV);
    }

    #[test]
    fn attributes_bad_distro_base_url_to_distro_config() {
        let _guard = ENV_LOCK.lock().unwrap();
        env::remove_var(KGOOSE_BASE_URL_ENV);
        env::remove_var(KGOOSE_PATH_ENV);
        let config = KgooseDistroConfig {
            base_url: Some("file:///tmp".to_string()),
            path: Some("prod/path".to_string()),
        };

        let error = build_url("v3/get-user-tiles", Some(&config)).unwrap_err();

        assert!(error.contains("distro kgoose baseUrl"));
        assert!(!error.contains(KGOOSE_BASE_URL_ENV));
    }

    #[test]
    fn truncates_long_error_bodies() {
        let body = "x".repeat(600);
        let truncated = truncate_error_body(&body);

        assert_eq!(truncated.chars().count(), 503);
        assert!(truncated.ends_with("..."));
    }

    #[test]
    fn classifies_access_failures_from_transport_and_status() {
        for kind in [
            KgooseRequestErrorKind::Timeout,
            KgooseRequestErrorKind::Connect,
            KgooseRequestErrorKind::Redirect,
        ] {
            assert!(is_access_request_error_kind(kind));
        }

        for status in [
            StatusCode::FOUND,
            StatusCode::UNAUTHORIZED,
            StatusCode::FORBIDDEN,
            StatusCode::PROXY_AUTHENTICATION_REQUIRED,
        ] {
            let error = KgooseJsonError::response(
                Some(status),
                Some("text/html".to_string()),
                "http status".to_string(),
            );

            assert!(error.is_likely_access_failure());
        }
    }

    #[test]
    fn does_not_classify_service_or_json_failures_as_access() {
        let service_error = KgooseJsonError::response(
            Some(StatusCode::INTERNAL_SERVER_ERROR),
            Some("application/json".to_string()),
            "service error".to_string(),
        );
        let json_error = KgooseJsonError::response(
            Some(StatusCode::OK),
            Some("application/json".to_string()),
            "json parse error".to_string(),
        );

        assert!(!is_access_request_error_kind(KgooseRequestErrorKind::Other));
        assert!(!service_error.is_likely_access_failure());
        assert!(!json_error.is_likely_access_failure());
    }

    #[test]
    fn does_not_classify_multipart_timeouts_as_access_failures() {
        assert!(!is_multipart_access_request_error_kind(
            KgooseRequestErrorKind::Timeout
        ));
        assert!(is_multipart_access_request_error_kind(
            KgooseRequestErrorKind::Connect
        ));
        assert!(is_multipart_access_request_error_kind(
            KgooseRequestErrorKind::Redirect
        ));
    }

    #[test]
    fn string_api_uses_warp_message_for_access_failures() {
        let access_error = KgooseJsonError::response(
            Some(StatusCode::FOUND),
            Some("text/html".to_string()),
            "302 html body".to_string(),
        );
        let service_error = KgooseJsonError::response(
            Some(StatusCode::INTERNAL_SERVER_ERROR),
            Some("application/json".to_string()),
            "service unavailable".to_string(),
        );

        assert_eq!(
            access_error.user_message(),
            "Unable to reach the internal service. Please check that you're connected to Cloudflare WARP and try again."
        );
        assert_eq!(service_error.user_message(), "service unavailable");
    }

    #[test]
    fn builds_sse_url_with_encoded_session_id() {
        let _guard = ENV_LOCK.lock().unwrap();
        env::remove_var(KGOOSE_BASE_URL_ENV);
        env::remove_var(KGOOSE_PATH_ENV);

        assert_eq!(
            build_sse_url("v3/get-messages-sse", "session/1", None)
                .unwrap()
                .as_str(),
            "https://kgoose.stage.sqprod.co/cash-app/goose/v3/get-messages-sse?session_id=session%2F1"
        );
    }

    #[test]
    fn builds_playpen_baggage_from_trimmed_env() {
        let _guard = ENV_LOCK.lock().unwrap();
        env::set_var(KGOOSE_PLAYPEN_ENV, " kalvin ");

        assert_eq!(playpen_baggage(), Some("kgoose-playpen=kalvin".to_string()));

        env::remove_var(KGOOSE_PLAYPEN_ENV);
    }

    #[test]
    fn omits_empty_playpen_baggage() {
        let _guard = ENV_LOCK.lock().unwrap();
        env::set_var(KGOOSE_PLAYPEN_ENV, " ");

        assert_eq!(playpen_baggage(), None);

        env::remove_var(KGOOSE_PLAYPEN_ENV);
    }

    async fn spawn_probe_server(raw_response: &'static [u8]) -> reqwest::Url {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            if let Ok((mut socket, _)) = listener.accept().await {
                let mut buffer = [0u8; 1024];
                let _ = socket.read(&mut buffer).await;
                let _ = socket.write_all(raw_response).await;
                let _ = socket.shutdown().await;
            }
        });
        reqwest::Url::parse(&format!("http://{}/", addr)).unwrap()
    }

    #[tokio::test]
    async fn probe_flags_redirect_to_access_as_warp_failure() {
        let url = spawn_probe_server(
            b"HTTP/1.1 302 Found\r\nLocation: https://sqprod.cloudflareaccess.com/\r\nContent-Length: 0\r\n\r\n",
        )
        .await;

        let result = probe_url(url).await;

        assert!(result.likely_warp_failure);
        assert_eq!(result.status, Some(302));
        assert_eq!(result.kind, "http_status");
    }

    #[tokio::test]
    async fn probe_does_not_flag_upstream_404_as_warp_failure() {
        let url = spawn_probe_server(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n").await;

        let result = probe_url(url).await;

        assert!(!result.likely_warp_failure);
        assert_eq!(result.status, Some(404));
        assert_eq!(result.kind, "http_status");
    }

    #[tokio::test]
    async fn probe_flags_connect_failure_as_warp_failure() {
        // Bind then drop the listener so the port is almost certainly free.
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        drop(listener);
        let url = reqwest::Url::parse(&format!("http://{}/", addr)).unwrap();

        let result = probe_url(url).await;

        assert!(result.likely_warp_failure);
        assert_eq!(result.status, None);
        assert_eq!(result.kind, "request");
    }
}
