//! Runtime-configured routing transport. Requests and credentials are never logged.
//! Full responses stay in session memory; logs contain transport metadata only.
use crate::commands::runtime_config::{
    auto_routing_revision, RuntimeAutoRoutingConfig, RuntimeAutoRoutingMode, RuntimeConfigState,
};
use crate::services::distro_bundle::DistroBundleState;
use serde::Serialize;
use serde_json::{json, Value};
use std::time::{Duration, Instant};
use tauri::State;

const AUTO_ROUTING_CONFIG_CHANGED: &str = "AUTO_ROUTING_CONFIG_CHANGED";

#[derive(Debug, Serialize)]
#[serde(untagged)]
pub enum AutoRoutingCommandError {
    Preflight(String),
    Transport(RoutingFailure),
}

impl From<String> for AutoRoutingCommandError {
    fn from(message: String) -> Self {
        Self::Preflight(message)
    }
}

impl From<&str> for AutoRoutingCommandError {
    fn from(message: &str) -> Self {
        Self::Preflight(message.to_string())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
enum RoutingFailureCode {
    Timeout,
    ConnectionFailed,
    HttpError,
    InvalidJson,
    ResponseTooLarge,
    ResponseReadFailed,
    ClientUnavailable,
    CredentialUnavailable,
    RequestFailed,
}

impl RoutingFailureCode {
    fn as_str(self) -> &'static str {
        match self {
            Self::Timeout => "timeout",
            Self::ConnectionFailed => "connection_failed",
            Self::HttpError => "http_error",
            Self::InvalidJson => "invalid_json",
            Self::ResponseTooLarge => "response_too_large",
            Self::ResponseReadFailed => "response_read_failed",
            Self::ClientUnavailable => "client_unavailable",
            Self::CredentialUnavailable => "credential_unavailable",
            Self::RequestFailed => "request_failed",
        }
    }
}

/// Only allowlisted transport metadata may cross the command boundary or enter logs.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutingFailure {
    code: RoutingFailureCode,
    elapsed_ms: u64,
    timeout_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    http_status: Option<u16>,
}

struct FailureKind {
    code: RoutingFailureCode,
    http_status: Option<u16>,
}

impl From<RoutingFailureCode> for FailureKind {
    fn from(code: RoutingFailureCode) -> Self {
        Self {
            code,
            http_status: None,
        }
    }
}

fn classify_request_error(error: &reqwest::Error, fallback: RoutingFailureCode) -> FailureKind {
    // A connection timeout can also be a connect error; timeout takes precedence.
    if error.is_timeout() {
        RoutingFailureCode::Timeout.into()
    } else if error.is_connect() {
        RoutingFailureCode::ConnectionFailed.into()
    } else {
        fallback.into()
    }
}

fn checked_routing_config<'a>(
    current: Option<&'a RuntimeAutoRoutingConfig>,
    expected_revision: Option<&str>,
) -> Result<&'a RuntimeAutoRoutingConfig, String> {
    let current = current.ok_or_else(|| AUTO_ROUTING_CONFIG_CHANGED.to_string())?;
    let revision =
        auto_routing_revision(current).map_err(|_| AUTO_ROUTING_CONFIG_CHANGED.to_string())?;
    if Some(revision.as_str()) != expected_revision {
        return Err(AUTO_ROUTING_CONFIG_CHANGED.to_string());
    }
    Ok(current)
}

fn build_request(
    config: &RuntimeAutoRoutingConfig,
    mode: &RuntimeAutoRoutingMode,
    prompt: &str,
) -> Value {
    let options: Vec<Value> = mode.models.iter().map(|model| {
        let mut option = json!({"model": model.router_model, "harness": model.harness.as_deref().unwrap_or("codex")});
        if let Some(effort) = &model.min_effort { option["min_effort"] = json!(effort); }
        if let Some(effort) = &model.max_effort { option["max_effort"] = json!(effort); }
        option
    }).collect();
    let mut body = json!({"task": {"prompt": prompt}, "route_options": options});
    if let Some(selector) = &config.route_selector {
        body["route_selector"] = json!(selector);
    }
    body
}

#[tauri::command]
pub async fn route_auto_model(
    mode_id: String,
    prompt: String,
    expected_auto_routing_revision: Option<String>,
    runtime_config: State<'_, RuntimeConfigState>,
    distro_bundle: State<'_, DistroBundleState>,
) -> Result<Value, AutoRoutingCommandError> {
    // Allow four UTF-8 bytes per character in the 176k renderer context budget.
    if prompt.len() > 704_000 {
        return Err("Routing context exceeds limit".into());
    }
    route_with_current_config(
        &mode_id,
        &prompt,
        expected_auto_routing_revision.as_deref(),
        runtime_config.inner(),
        distro_bundle.inner(),
    )
    .await
}

async fn route_with_current_config(
    mode_id: &str,
    prompt: &str,
    expected_revision: Option<&str>,
    runtime_config: &RuntimeConfigState,
    distro_bundle: &DistroBundleState,
) -> Result<Value, AutoRoutingCommandError> {
    let runtime = runtime_config.ready_config(distro_bundle).await?;
    // Echo the native-issued revision, never re-encoded renderer config.
    // Native JSON numbers retain their original precision and representation.
    let config = checked_routing_config(runtime.goose.auto_routing.as_ref(), expected_revision)?;
    let mode = config
        .modes
        .iter()
        .find(|mode| mode.id == mode_id)
        .ok_or("Auto routing mode is not configured")?;
    let result = request_route(config, mode, prompt).await;
    // A different window may refresh native state while HTTP is pending.
    // Reject both obsolete decisions and obsolete errors (which would otherwise
    // apply the renderer snapshot's old fallback) before releasing the result.
    let current = runtime_config
        .ready_config(distro_bundle)
        .await
        .map_err(|_| AUTO_ROUTING_CONFIG_CHANGED.to_string())?;
    checked_routing_config(current.goose.auto_routing.as_ref(), expected_revision)?;
    result.map_err(AutoRoutingCommandError::Transport)
}

async fn request_route(
    config: &RuntimeAutoRoutingConfig,
    mode: &RuntimeAutoRoutingMode,
    prompt: &str,
) -> Result<Value, RoutingFailure> {
    let started = Instant::now();
    let timeout_ms = config.timeout_ms.unwrap_or(5_000);
    let result = request_route_inner(config, mode, prompt, timeout_ms).await;
    let elapsed_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
    match result {
        Ok(response) => {
            log::info!(target: "auto_routing", "Routing succeeded (elapsed_ms={elapsed_ms}, timeout_ms={timeout_ms})");
            Ok(response)
        }
        Err(kind) => {
            let failure = RoutingFailure {
                code: kind.code,
                elapsed_ms,
                timeout_ms,
                http_status: kind.http_status,
            };
            log::warn!(target: "auto_routing", "Routing failed (code={}, elapsed_ms={}, timeout_ms={}, http_status={:?})", failure.code.as_str(), failure.elapsed_ms, failure.timeout_ms, failure.http_status);
            Err(failure)
        }
    }
}

async fn request_route_inner(
    config: &RuntimeAutoRoutingConfig,
    mode: &RuntimeAutoRoutingMode,
    prompt: &str,
    timeout_ms: u64,
) -> Result<Value, FailureKind> {
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_millis(timeout_ms))
        .build()
        .map_err(|_| RoutingFailureCode::ClientUnavailable)?;
    let mut request = client
        .post(&config.url)
        .json(&build_request(config, mode, prompt));
    if let Some(name) = &config.bearer_token_env {
        let token = std::env::var(name).map_err(|_| RoutingFailureCode::CredentialUnavailable)?;
        if token.trim().is_empty() {
            return Err(RoutingFailureCode::CredentialUnavailable.into());
        }
        request = request.bearer_auth(token);
    }
    let response = request
        .send()
        .await
        .map_err(|error| classify_request_error(&error, RoutingFailureCode::RequestFailed))?;
    if !response.status().is_success() {
        return Err(FailureKind {
            code: RoutingFailureCode::HttpError,
            http_status: Some(response.status().as_u16()),
        });
    }
    // Keep the opaque response for session-local inspection, with a bounded body.
    let mut response = response;
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| classify_request_error(&error, RoutingFailureCode::ResponseReadFailed))?
    {
        if bytes.len() + chunk.len() > 1_048_576 {
            return Err(RoutingFailureCode::ResponseTooLarge.into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let response = serde_json::from_slice(&bytes).map_err(|_| RoutingFailureCode::InvalidJson)?;
    log::info!(target: "auto_routing", "Routing response received ({} bytes)", bytes.len());
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    fn config(url: String) -> RuntimeAutoRoutingConfig {
        serde_json::from_value(json!({"url":url,"timeoutMs":1000,"modes":[{
            "id":"auto","displayName":"Auto","modelProviderId":"provider",
            "fallback":{"modelId":"served","effort":"high"},
            "models":[{"modelId":"served","routerModel":"system.ai.sol","minEffort":"high"}]
        }]}))
        .unwrap()
    }
    #[test]
    fn renderer_revision_must_match_native_before_routing() {
        let current = config("https://trusted.example.com/route".to_string());
        let revision = auto_routing_revision(&current).unwrap();
        assert!(std::ptr::eq(
            checked_routing_config(Some(&current), Some(&revision)).unwrap(),
            &current,
        ));
        let mut changed = current.clone();
        changed.modes[0].fallback.model_id = "changed".to_string();
        assert_eq!(
            checked_routing_config(Some(&changed), Some(&revision)).unwrap_err(),
            AUTO_ROUTING_CONFIG_CHANGED,
        );
        assert_eq!(
            checked_routing_config(None, Some(&revision)).unwrap_err(),
            AUTO_ROUTING_CONFIG_CHANGED,
        );
        assert_eq!(
            checked_routing_config(Some(&current), None).unwrap_err(),
            AUTO_ROUTING_CONFIG_CHANGED,
        );
        assert_eq!(
            checked_routing_config(Some(&current), Some("forged")).unwrap_err(),
            AUTO_ROUTING_CONFIG_CHANGED,
        );
    }

    #[test]
    fn native_revision_survives_renderer_numeric_round_trip() {
        let mut native = config("https://trusted.example.com/route".to_string());
        native.route_selector = Some(
            serde_json::from_str(
                r#"{
            "router_name":"task_v3",
            "config":{"float":1.0,"large":9007199254740993}
        }"#,
            )
            .unwrap(),
        );
        let revision = auto_routing_revision(&native).unwrap();
        // Emulate JSON.parse -> JSON.stringify in JavaScript: integral floats
        // become integers and values beyond MAX_SAFE_INTEGER lose precision.
        let mut renderer = serde_json::to_value(&native).unwrap();
        renderer["routeSelector"]["config"]["float"] = json!(1);
        renderer["routeSelector"]["config"]["large"] = json!(9007199254740992u64);
        let renderer: RuntimeAutoRoutingConfig = serde_json::from_value(renderer).unwrap();
        assert_ne!(native, renderer);
        assert_ne!(auto_routing_revision(&renderer).unwrap(), revision);

        let checked = checked_routing_config(Some(&native), Some(&revision)).unwrap();
        let request = build_request(checked, &checked.modes[0], "context");
        let selector = &request["route_selector"]["config"];
        assert!(selector["float"].is_f64());
        assert_eq!(selector["large"].as_u64(), Some(9007199254740993));
        // A real native number change still invalidates the captured revision.
        assert_eq!(
            checked_routing_config(Some(&renderer), Some(&revision)).unwrap_err(),
            AUTO_ROUTING_CONFIG_CHANGED
        );
    }
    async fn server(
        status: u16,
        body: String,
        delay: Duration,
    ) -> (String, tokio::task::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/route", listener.local_addr().unwrap());
        let handle = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut data = vec![0u8; 16384];
            let size = stream.read(&mut data).await.unwrap();
            let request = String::from_utf8_lossy(&data[..size]).into_owned();
            tokio::time::sleep(delay).await;
            let response = format!(
                "HTTP/1.1 {status} Test\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = stream.write_all(response.as_bytes()).await;
            request
        });
        (url, handle)
    }
    #[tokio::test]
    async fn refresh_during_http_rejects_obsolete_success_and_fallback_error() {
        for status in [200, 503] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let url = format!("http://{}/route", listener.local_addr().unwrap());
            let (started_tx, started_rx) = tokio::sync::oneshot::channel();
            let (release_tx, release_rx) = tokio::sync::oneshot::channel();
            let server = tokio::spawn(async move {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut request = [0u8; 16384];
                stream.read(&mut request).await.unwrap();
                started_tx.send(()).unwrap();
                release_rx.await.unwrap();
                let body = r#"{"route_selection":[]}"#;
                let response = format!("HTTP/1.1 {status} Test\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
                stream.write_all(response.as_bytes()).await.unwrap();
            });
            let dir = tempfile::tempdir().unwrap();
            let state = RuntimeConfigState::new(dir.path().to_owned(), None);
            let distro = DistroBundleState::empty_for_tests();
            let mut runtime = crate::commands::runtime_config::default_runtime_config();
            runtime.goose.model_providers.push(
                serde_json::from_value(json!({
                    "id":"provider", "displayName":"Provider",
                    "models":[{"id":"served", "name":"Served"}]
                }))
                .unwrap(),
            );
            runtime.goose.default_model_provider_id = Some("provider".to_string());
            runtime.goose.default_model_id = Some("served".to_string());
            runtime.goose.auto_routing = Some(config(url));
            state.set_fake_config(runtime.clone()).unwrap();
            let revision =
                auto_routing_revision(runtime.goose.auto_routing.as_ref().unwrap()).unwrap();
            let (result, _) = tokio::join!(
                route_with_current_config("auto", "context", Some(&revision), &state, &distro),
                async {
                    started_rx.await.unwrap();
                    runtime.goose.auto_routing.as_mut().unwrap().modes[0]
                        .fallback
                        .effort = "max".to_string();
                    state.set_fake_config(runtime).unwrap();
                    release_tx.send(()).unwrap();
                },
            );
            assert_eq!(serde_json::to_value(result.unwrap_err()).unwrap(), json!(AUTO_ROUTING_CONFIG_CHANGED),
                "HTTP {status} from an obsolete config must not release its decision or fallback error");
            server.await.unwrap();
        }
    }

    #[tokio::test]
    async fn transport_posts_configured_candidates_and_keeps_complete_response() {
        let raw = json!({"route_selection":[],"rationale":"complete","extra":{"evidence":true}});
        let (url, server) = server(200, raw.to_string(), Duration::ZERO).await;
        let config = config(url);
        let response = request_route(&config, &config.modes[0], "task context")
            .await
            .unwrap();
        assert_eq!(response, raw);
        let request = server.await.unwrap();
        assert!(request.starts_with("POST /route HTTP/1.1"));
        let body: Value = serde_json::from_str(request.split("\r\n\r\n").nth(1).unwrap()).unwrap();
        assert_eq!(body["task"]["prompt"], "task context");
        assert_eq!(
            body["route_options"][0],
            json!({"model":"system.ai.sol","harness":"codex","min_effort":"high"})
        );
        assert!(body.get("route_selector").is_none());
    }
    #[tokio::test]
    async fn transport_preserves_http_json_and_size_failure_categories() {
        for (status, body, expected, http_status) in [
            (
                503,
                "private response".to_string(),
                RoutingFailureCode::HttpError,
                Some(503),
            ),
            (
                401,
                "private response".to_string(),
                RoutingFailureCode::HttpError,
                Some(401),
            ),
            (
                302,
                "{}".to_string(),
                RoutingFailureCode::HttpError,
                Some(302),
            ),
            (
                200,
                "private invalid JSON".to_string(),
                RoutingFailureCode::InvalidJson,
                None,
            ),
            (
                200,
                "x".repeat(1_048_577),
                RoutingFailureCode::ResponseTooLarge,
                None,
            ),
        ] {
            let (url, handle) = server(status, body, Duration::ZERO).await;
            let config = config(url);
            let error = request_route(&config, &config.modes[0], "private prompt")
                .await
                .unwrap_err();
            assert_eq!(error.code, expected);
            assert_eq!(error.http_status, http_status);
            assert_eq!(error.timeout_ms, 1000);
            assert!(error.elapsed_ms < 10_000);
            handle.await.unwrap();
        }
    }

    #[tokio::test]
    async fn header_timeout_reports_elapsed_time_and_configured_budget() {
        let (url, handle) = server(200, "{}".to_string(), Duration::from_millis(200)).await;
        let mut config = config(url);
        config.timeout_ms = Some(50);
        let error = request_route(&config, &config.modes[0], "task")
            .await
            .unwrap_err();
        assert_eq!(error.code, RoutingFailureCode::Timeout);
        assert_eq!(error.timeout_ms, 50);
        assert!(error.elapsed_ms >= 40, "{}", error.elapsed_ms);
        handle.await.unwrap();
    }

    async fn partial_body_server(delay: Duration) -> (String, tokio::task::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/private-endpoint", listener.local_addr().unwrap());
        let handle = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = [0u8; 16384];
            stream.read(&mut request).await.unwrap();
            stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\nConnection: close\r\n\r\n{\"private\":").await.unwrap();
            tokio::time::sleep(delay).await;
        });
        (url, handle)
    }

    #[tokio::test]
    async fn timeout_while_reading_response_body_stays_a_timeout() {
        let (url, handle) = partial_body_server(Duration::from_millis(200)).await;
        let mut config = config(url);
        config.timeout_ms = Some(50);
        let error = request_route(&config, &config.modes[0], "task")
            .await
            .unwrap_err();
        assert_eq!(error.code, RoutingFailureCode::Timeout);
        assert_eq!(error.timeout_ms, 50);
        assert!(error.elapsed_ms >= 40, "{}", error.elapsed_ms);
        handle.await.unwrap();
    }

    #[tokio::test]
    async fn truncated_body_is_a_response_read_failure() {
        let (url, handle) = partial_body_server(Duration::ZERO).await;
        let config = config(url);
        let error = request_route(&config, &config.modes[0], "task")
            .await
            .unwrap_err();
        assert_eq!(error.code, RoutingFailureCode::ResponseReadFailed);
        handle.await.unwrap();
    }

    #[tokio::test]
    async fn connection_refusal_is_distinct_from_request_failure_and_uses_default_budget() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/private-endpoint", listener.local_addr().unwrap());
        drop(listener);
        let mut config = config(url);
        config.timeout_ms = None;
        let error = request_route(&config, &config.modes[0], "private prompt")
            .await
            .unwrap_err();
        assert_eq!(error.code, RoutingFailureCode::ConnectionFailed);
        assert_eq!(error.timeout_ms, 5_000);

        config.url = "invalid-url-private-endpoint".to_string();
        let error = request_route(&config, &config.modes[0], "private prompt")
            .await
            .unwrap_err();
        assert_eq!(error.code, RoutingFailureCode::RequestFailed);
        assert_eq!(
            serde_json::to_value(error)
                .unwrap()
                .as_object()
                .unwrap()
                .len(),
            3
        );
    }

    #[tokio::test]
    async fn missing_credential_fails_before_sending_and_does_not_expose_secrets() {
        let mut config = config("http://127.0.0.1:1/private-endpoint".to_string());
        config.bearer_token_env =
            Some("BERD_AUTO_ROUTING_TEST_MISSING_CREDENTIAL_18A854".to_string());
        let error = request_route(&config, &config.modes[0], "private prompt")
            .await
            .unwrap_err();
        assert_eq!(error.code, RoutingFailureCode::CredentialUnavailable);
        let serialized = serde_json::to_value(AutoRoutingCommandError::Transport(error)).unwrap();
        assert_eq!(serialized["code"], "credential_unavailable");
        assert!(serialized["elapsedMs"].is_u64());
        assert_eq!(serialized["timeoutMs"], 1000);
        assert_eq!(serialized.as_object().unwrap().len(), 3);
        let text = serialized.to_string();
        for private in [
            "private-endpoint",
            "private prompt",
            "127.0.0.1",
            "BERD_AUTO_ROUTING_TEST",
        ] {
            assert!(!text.contains(private));
        }
    }

    #[test]
    fn command_errors_serialize_only_allowlisted_metadata_or_existing_preflight_strings() {
        for code in [
            RoutingFailureCode::Timeout,
            RoutingFailureCode::ConnectionFailed,
            RoutingFailureCode::HttpError,
            RoutingFailureCode::InvalidJson,
            RoutingFailureCode::ResponseTooLarge,
            RoutingFailureCode::ResponseReadFailed,
            RoutingFailureCode::ClientUnavailable,
            RoutingFailureCode::CredentialUnavailable,
            RoutingFailureCode::RequestFailed,
        ] {
            let failure = RoutingFailure {
                code,
                elapsed_ms: 123,
                timeout_ms: 5_000,
                http_status: (code == RoutingFailureCode::HttpError).then_some(503),
            };
            let serialized =
                serde_json::to_value(AutoRoutingCommandError::Transport(failure)).unwrap();
            let mut expected = json!({"code": code.as_str(), "elapsedMs":123, "timeoutMs":5000});
            if code == RoutingFailureCode::HttpError {
                expected["httpStatus"] = json!(503);
            }
            assert_eq!(serialized, expected);
        }
        for preflight in [
            AUTO_ROUTING_CONFIG_CHANGED,
            "Routing context exceeds limit",
            "Auto routing mode is not configured",
        ] {
            assert_eq!(
                serde_json::to_value(AutoRoutingCommandError::from(preflight)).unwrap(),
                json!(preflight)
            );
        }
    }
    #[test]
    fn selector_and_bounds_are_forwarded_without_concrete_model_id() {
        let mut config = config("https://gateway.example.com/route".to_string());
        config.route_selector = Some(
            serde_json::from_value(
                json!({"router_name":"task_v3","config":{"model":"system.ai.luna"}}),
            )
            .unwrap(),
        );
        let body = build_request(&config, &config.modes[0], "task");
        assert_eq!(body["route_selector"]["router_name"], "task_v3");
        assert!(!body.to_string().contains("served"));
    }
}
