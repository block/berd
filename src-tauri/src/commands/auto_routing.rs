//! Runtime-configured routing transport. Requests and credentials are never logged.
//! Full responses stay in session memory; logs contain transport metadata only.
use crate::commands::runtime_config::{
    auto_routing_revision, RuntimeAutoRoutingConfig, RuntimeAutoRoutingMode, RuntimeConfigState,
};
use crate::services::distro_bundle::DistroBundleState;
use serde_json::{json, Value};
use std::time::Duration;
use tauri::State;

const AUTO_ROUTING_CONFIG_CHANGED: &str = "AUTO_ROUTING_CONFIG_CHANGED";

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
) -> Result<Value, String> {
    // Allow four UTF-8 bytes per character in the 176k renderer context budget.
    if prompt.len() > 704_000 {
        return Err("Routing context exceeds limit".to_string());
    }
    let runtime = runtime_config.ready_config(&distro_bundle).await?;
    // Echo the native-issued revision, never re-encoded renderer config.
    // Native JSON numbers retain their original precision and representation.
    let config = checked_routing_config(
        runtime.goose.auto_routing.as_ref(),
        expected_auto_routing_revision.as_deref(),
    )?;
    let mode = config
        .modes
        .iter()
        .find(|mode| mode.id == mode_id)
        .ok_or("Auto routing mode is not configured")?;
    request_route(config, mode, &prompt).await
}

async fn request_route(
    config: &RuntimeAutoRoutingConfig,
    mode: &RuntimeAutoRoutingMode,
    prompt: &str,
) -> Result<Value, String> {
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_millis(config.timeout_ms.unwrap_or(5_000)))
        .build()
        .map_err(|_| "Routing client unavailable".to_string())?;
    let mut request = client
        .post(&config.url)
        .json(&build_request(config, mode, prompt));
    if let Some(name) = &config.bearer_token_env {
        let token =
            std::env::var(name).map_err(|_| "Routing credential unavailable".to_string())?;
        if token.trim().is_empty() {
            return Err("Routing credential unavailable".to_string());
        }
        request = request.bearer_auth(token);
    }
    let response = request
        .send()
        .await
        .map_err(|_| "Routing request failed".to_string())?;
    if !response.status().is_success() {
        return Err(format!(
            "Routing request returned HTTP {}",
            response.status().as_u16()
        ));
    }
    // Keep the opaque response for session-local inspection, with a bounded body.
    let mut response = response;
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Routing response read failed".to_string())?
    {
        if bytes.len() + chunk.len() > 1_048_576 {
            return Err("Routing response exceeds limit".to_string());
        }
        bytes.extend_from_slice(&chunk);
    }
    log::info!(target: "auto_routing", "Routing response received ({} bytes)", bytes.len());
    serde_json::from_slice(&bytes).map_err(|_| "Routing response is not JSON".to_string())
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
    async fn transport_fails_for_http_status_invalid_json_timeouts_and_oversized_responses() {
        for (status, body, timeout, delay, expected) in [
            (503, "unavailable".to_string(), 1000, 0, "HTTP 503"),
            (200, "not JSON".to_string(), 1000, 0, "not JSON"),
            (200, "{}".to_string(), 10, 100, "request failed"),
            (200, "x".repeat(1_048_577), 1000, 0, "exceeds limit"),
            (302, "{}".to_string(), 1000, 0, "HTTP 302"),
        ] {
            let (url, handle) = server(status, body, Duration::from_millis(delay)).await;
            let mut config = config(url);
            config.timeout_ms = Some(timeout);
            let error = request_route(&config, &config.modes[0], "task")
                .await
                .unwrap_err();
            assert!(error.contains(expected), "{error}");
            handle.await.unwrap();
        }
    }
    #[tokio::test]
    async fn missing_credential_fails_before_sending() {
        let mut config = config("http://127.0.0.1:1/route".to_string());
        config.bearer_token_env =
            Some("BERD_AUTO_ROUTING_TEST_MISSING_CREDENTIAL_18A854".to_string());
        let error = request_route(&config, &config.modes[0], "task")
            .await
            .unwrap_err();
        assert_eq!(error, "Routing credential unavailable");
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
