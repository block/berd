use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::body::{Body, Bytes};
use axum::extract::{ConnectInfo, Path, State};
use axum::http::{header, HeaderMap, HeaderName, HeaderValue, StatusCode, Uri};
use axum::middleware;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::Router;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use futures_util::StreamExt;
use reqwest::redirect::Policy;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::acp::GooseServeProcess;

const CAPABILITY_BYTES: usize = 32;
const PROXY_CAPABILITY_TTL: Duration = Duration::from_secs(30);
const STORE_CAPABILITY_TTL: Duration = Duration::from_secs(30);
const GUEST_GRANT_TTL: Duration = Duration::from_secs(300);
const MAX_CAPABILITY_ENTRIES: usize = 256;
const MAX_CSP_DOMAINS_PER_DIRECTIVE: usize = 64;
const MAX_CSP_DOMAIN_BYTES: usize = 2 * 1024;
const UPSTREAM_CONNECT_TIMEOUT: Duration = Duration::from_secs(2);
const UPSTREAM_REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
const PROXY_ROUTE_PREFIX: &str = "/mcp-app-sandbox/proxy/";
const STORE_ROUTE_PREFIX: &str = "/mcp-app-sandbox/store/";
const GUEST_ROUTE_PREFIX: &str = "/mcp-app-sandbox/guest/";
const UPSTREAM_PROXY_PATH: &str = "/mcp-app-proxy";
const UPSTREAM_GUEST_PATH: &str = "/mcp-app-guest";
const MAX_PROXY_BYTES: usize = 1024 * 1024;
const MAX_STORE_RESPONSE_BYTES: usize = 16 * 1024;
const MAX_GUEST_BYTES: usize = 16 * 1024 * 1024;
const ORIGIN_HEADER: &str = "origin";
const SEC_FETCH_DEST_HEADER: &str = "sec-fetch-dest";
const SEC_FETCH_MODE_HEADER: &str = "sec-fetch-mode";
const SEC_FETCH_SITE_HEADER: &str = "sec-fetch-site";
const DOCUMENT_FETCH_DEST: &str = "iframe";
const DOCUMENT_FETCH_MODE: &str = "navigate";
const FETCH_SITE_SAME_ORIGIN: &str = "same-origin";
const TRUSTED_IPC_NONCE_BYTES: usize = 32;
const TRUSTED_IPC_NONCE_PROPERTY: &str = "__BERD_MCP_SANDBOX_IPC_NONCE__";

// Byte-for-byte copy of `crates/goose/src/acp/templates/mcp_app_proxy.html`
// from the Goose commit in `goose-backend.lock.json`. The digest regression
// pins provenance and the runtime rejects any upstream template drift.
const PINNED_GOOSE_PROXY_TEMPLATE: &str =
    include_str!("../../testdata/goose/mcp_app_proxy_1c1bd529.html");
const PINNED_GOOSE_COMMIT: &str = "1c1bd5299a243f309cb251d2bbe429c7f470793e";
const SECRET_QUERY_EXPRESSION: &str = "params.get('secret') || ''";
const LOCATION_QUERY_EXPRESSION: &str = "new URLSearchParams(window.location.search)";
const COLOR_SCHEME_QUERY_EXPRESSION: &str = "params.get('color_scheme')";
const PROXY_BASE_EXPRESSION: &str = "baseUrl: getProxyBaseUrl(),";
const UPSTREAM_STORE_EXPRESSION: &str = "proxyParams.baseUrl + '/mcp-app-guest'";
const SECRET_BODY_FIELD: &str = "secret: proxyParams.secret,";
const STORE_BODY_CLOSE_EXPRESSION: &str = "csp: cspMeta ? cspMeta.content : ''\n            })";
const GUEST_HTML_PREPARATION_EXPRESSION: &str =
    "var guestHtml = injectGuestColorScheme(html, proxyParams.colorScheme);";
const HEAD_TAG: &str = "  <head>";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct McpAppProxyConfig {
    pub connect_domains: Vec<String>,
    pub resource_domains: Vec<String>,
    pub frame_domains: Vec<String>,
    pub base_uri_domains: Vec<String>,
    pub script_domains: Vec<String>,
    pub color_scheme: String,
    pub document_binding: String,
    pub document_digest: String,
}

#[derive(Debug)]
struct Capability<T> {
    value: T,
    expires_at: Instant,
    available: bool,
}

#[derive(Debug)]
struct CapabilityStore<T> {
    entries: HashMap<String, Capability<T>>,
}

impl<T> Default for CapabilityStore<T> {
    fn default() -> Self {
        Self {
            entries: HashMap::new(),
        }
    }
}

impl<T> CapabilityStore<T> {
    fn purge_expired(&mut self) {
        let now = Instant::now();
        self.entries.retain(|_, entry| entry.expires_at > now);
    }

    fn insert(&mut self, value: T, ttl: Duration) -> Result<String, String> {
        self.purge_expired();
        if self.entries.len() >= MAX_CAPABILITY_ENTRIES {
            return Err("MCP app proxy capability store is full".to_string());
        }
        let token = random_capability();
        self.entries.insert(
            token.clone(),
            Capability {
                value,
                expires_at: Instant::now() + ttl,
                available: true,
            },
        );
        Ok(token)
    }

    fn take(&mut self, token: &str) -> Option<T> {
        self.purge_expired();
        self.entries.remove(token).and_then(|entry| {
            if entry.available {
                Some(entry.value)
            } else {
                None
            }
        })
    }

    fn reserve(&mut self, token: &str) -> bool {
        self.purge_expired();
        self.entries.get_mut(token).is_some_and(|entry| {
            if entry.available {
                entry.available = false;
                true
            } else {
                false
            }
        })
    }

    fn take_reserved(&mut self, token: &str) -> Option<T> {
        self.purge_expired();
        self.entries.remove(token).and_then(|entry| {
            if !entry.available {
                Some(entry.value)
            } else {
                None
            }
        })
    }

    fn release(&mut self, token: &str) {
        if let Some(entry) = self.entries.get_mut(token) {
            if entry.expires_at > Instant::now() {
                entry.available = true;
            }
        }
    }
}

#[derive(Debug)]
struct ProxyGrant {
    config: McpAppProxyConfig,
    upstream_base_url: String,
    upstream_secret: String,
}

#[derive(Clone, Debug)]
struct StoreGrant {
    upstream_base_url: String,
    upstream_secret: String,
    upstream_guest_origin: String,
    outer_csp: String,
    document_binding: String,
    document_digest: String,
}

#[derive(Debug)]
struct GuestGrant {
    html: Bytes,
    csp: Option<HeaderValue>,
}

#[derive(Clone, Debug)]
struct ServerState {
    proxy_grants: Arc<Mutex<CapabilityStore<ProxyGrant>>>,
    store_grants: Arc<Mutex<CapabilityStore<StoreGrant>>>,
    guest_grants: Arc<Mutex<CapabilityStore<GuestGrant>>>,
    client: reqwest::Client,
    public_origin: String,
    guest_base_url: String,
}

#[derive(Debug)]
pub struct McpAppProxyServer {
    public_base_url: String,
    #[cfg(test)]
    guest_base_url: String,
    proxy_grants: Arc<Mutex<CapabilityStore<ProxyGrant>>>,
    proxy_task: tauri::async_runtime::JoinHandle<()>,
    guest_task: tauri::async_runtime::JoinHandle<()>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct McpAppSandboxRequest {
    pub connect_domains: Vec<String>,
    pub resource_domains: Vec<String>,
    pub frame_domains: Vec<String>,
    pub base_uri_domains: Vec<String>,
    pub script_domains: Vec<String>,
    pub color_scheme: String,
    pub document_binding: String,
    pub document_digest: String,
    pub ipc_nonce: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpAppSandboxInfo {
    pub proxy_url: String,
}

#[derive(Debug)]
pub struct TrustedMcpSandboxIpc {
    nonce: [u8; TRUSTED_IPC_NONCE_BYTES],
}

impl TrustedMcpSandboxIpc {
    pub fn new() -> Self {
        Self {
            nonce: random_bytes(),
        }
    }

    // Tauri/Wry injects this script into the top-level frame only on macOS and
    // Linux. WebView2 injects initialization scripts into child frames too, so
    // the runtime top-level check is also load-bearing on Windows.
    pub fn initialization_script(&self) -> String {
        let property =
            serde_json::to_string(TRUSTED_IPC_NONCE_PROPERTY).expect("static property is JSON");
        let nonce =
            serde_json::to_string(&URL_SAFE_NO_PAD.encode(self.nonce)).expect("nonce is JSON");
        let trusted_context = concat!(
            "window.top === window && (window.location.protocol === 'tauri:' || ",
            "window.location.hostname === 'tauri.localhost' || ",
            "window.location.hostname === 'localhost')"
        );
        format!(
            "if ({trusted_context}) {{ Object.defineProperty(window, {property}, {{ value: {nonce}, configurable: false, enumerable: false, writable: false }}); }}",
        )
    }

    fn allows(&self, nonce: &str) -> bool {
        let Ok(nonce) = URL_SAFE_NO_PAD.decode(nonce) else {
            return false;
        };
        constant_time_eq(&self.nonce, &nonce)
    }
}

impl Default for TrustedMcpSandboxIpc {
    fn default() -> Self {
        Self::new()
    }
}

impl McpAppProxyServer {
    pub async fn start() -> Result<Self, String> {
        let proxy_listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .map_err(|error| format!("Failed to bind MCP app sandbox proxy: {error}"))?;
        let guest_listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .map_err(|error| format!("Failed to bind MCP app sandbox guest server: {error}"))?;
        let proxy_addr = proxy_listener
            .local_addr()
            .map_err(|error| format!("Failed to read MCP app sandbox proxy address: {error}"))?;
        let guest_addr = guest_listener
            .local_addr()
            .map_err(|error| format!("Failed to read MCP app sandbox guest address: {error}"))?;
        let proxy_base_url = format!("http://127.0.0.1:{}", proxy_addr.port());
        let guest_base_url = format!("http://127.0.0.1:{}", guest_addr.port());
        let proxy_grants = Arc::new(Mutex::new(CapabilityStore::default()));
        let state = ServerState {
            proxy_grants: proxy_grants.clone(),
            store_grants: Arc::new(Mutex::new(CapabilityStore::default())),
            guest_grants: Arc::new(Mutex::new(CapabilityStore::default())),
            client: build_proxy_client()?,
            public_origin: proxy_base_url.clone(),
            guest_base_url: guest_base_url.clone(),
        };
        let proxy_app = build_proxy_router(state.clone());
        let guest_app = build_guest_router(state);
        let proxy_task = tauri::async_runtime::spawn(async move {
            if let Err(error) = axum::serve(
                proxy_listener,
                proxy_app.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .await
            {
                log::error!("MCP app sandbox proxy stopped: {error}");
            }
        });
        let guest_task = tauri::async_runtime::spawn(async move {
            if let Err(error) = axum::serve(
                guest_listener,
                guest_app.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .await
            {
                log::error!("MCP app sandbox guest server stopped: {error}");
            }
        });

        Ok(Self {
            public_base_url: proxy_base_url,
            #[cfg(test)]
            guest_base_url,
            proxy_grants,
            proxy_task,
            guest_task,
        })
    }

    pub fn mint_proxy_url(
        &self,
        config: McpAppProxyConfig,
        upstream_base_url: String,
        upstream_secret: String,
    ) -> Result<String, String> {
        self.mint_proxy_url_with_ttl(
            config,
            upstream_base_url,
            upstream_secret,
            PROXY_CAPABILITY_TTL,
        )
    }

    fn mint_proxy_url_with_ttl(
        &self,
        config: McpAppProxyConfig,
        upstream_base_url: String,
        upstream_secret: String,
        ttl: Duration,
    ) -> Result<String, String> {
        let config = normalize_proxy_config(config)?;
        let document_binding = config.document_binding.clone();
        let token = self
            .proxy_grants
            .lock()
            .map_err(|_| "MCP app proxy capability store is unavailable".to_string())?
            .insert(
                ProxyGrant {
                    config,
                    upstream_base_url,
                    upstream_secret,
                },
                ttl,
            )?;
        Ok(build_proxy_capability_url(
            &self.public_base_url,
            &token,
            &document_binding,
        ))
    }
}

impl Drop for McpAppProxyServer {
    fn drop(&mut self) {
        self.proxy_task.abort();
        self.guest_task.abort();
    }
}

#[tauri::command]
pub async fn create_mcp_app_sandbox(
    app_handle: tauri::AppHandle,
    webview: tauri::Webview,
    proxy_server: tauri::State<'_, McpAppProxyServer>,
    trusted_ipc: tauri::State<'_, TrustedMcpSandboxIpc>,
    request: McpAppSandboxRequest,
) -> Result<McpAppSandboxInfo, String> {
    ensure_trusted_renderer(&webview)?;
    let McpAppSandboxRequest {
        connect_domains,
        resource_domains,
        frame_domains,
        base_uri_domains,
        script_domains,
        color_scheme,
        document_binding,
        document_digest,
        ipc_nonce,
    } = request;
    if !trusted_ipc.allows(&ipc_nonce) {
        return Err("MCP app sandboxes are unavailable to this renderer".to_string());
    }
    let config = McpAppProxyConfig {
        connect_domains,
        resource_domains,
        frame_domains,
        base_uri_domains,
        script_domains,
        color_scheme,
        document_binding,
        document_digest,
    };
    let (upstream_base_url, upstream_secret) = goose_proxy_credentials(&app_handle).await?;
    let proxy_url = proxy_server.mint_proxy_url(config, upstream_base_url, upstream_secret)?;
    Ok(McpAppSandboxInfo { proxy_url })
}

fn ensure_trusted_renderer<R: tauri::Runtime>(webview: &tauri::Webview<R>) -> Result<(), String> {
    let label = webview.label();
    let window_label = webview.window().label().to_string();
    if trusted_renderer_label(label) && label == window_label {
        Ok(())
    } else {
        Err("MCP app sandboxes are unavailable to this renderer".to_string())
    }
}

fn trusted_renderer_label(label: &str) -> bool {
    label == "main"
        || label.strip_prefix("session:").is_some_and(|digest| {
            digest.len() == 64
                && digest
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
        })
}

fn normalize_proxy_config(mut config: McpAppProxyConfig) -> Result<McpAppProxyConfig, String> {
    validate_color_scheme(&config.color_scheme)?;
    config.connect_domains = normalize_domain_list("connectDomains", config.connect_domains)?;
    config.resource_domains = normalize_domain_list("resourceDomains", config.resource_domains)?;
    config.frame_domains = normalize_domain_list("frameDomains", config.frame_domains)?;
    config.base_uri_domains = normalize_domain_list("baseUriDomains", config.base_uri_domains)?;
    config.script_domains = normalize_domain_list("scriptDomains", config.script_domains)?;
    validate_document_binding(&config.document_binding)?;
    validate_document_digest(&config.document_digest)?;
    Ok(config)
}

fn validate_document_binding(document_binding: &str) -> Result<(), String> {
    if valid_capability(document_binding) {
        Ok(())
    } else {
        Err("MCP app sandbox document binding is invalid".to_string())
    }
}

fn validate_document_digest(document_digest: &str) -> Result<(), String> {
    if valid_capability(document_digest) {
        Ok(())
    } else {
        Err("MCP app sandbox document digest is invalid".to_string())
    }
}

fn validate_color_scheme(color_scheme: &str) -> Result<(), String> {
    if matches!(color_scheme, "light" | "dark") {
        Ok(())
    } else {
        Err("MCP app sandbox color scheme must be light or dark".to_string())
    }
}

fn normalize_domain_list(name: &str, domains: Vec<String>) -> Result<Vec<String>, String> {
    if domains.len() > MAX_CSP_DOMAINS_PER_DIRECTIVE {
        return Err(format!(
            "MCP app sandbox {name} exceeds the {MAX_CSP_DOMAINS_PER_DIRECTIVE}-domain limit"
        ));
    }
    if domains.iter().map(String::len).sum::<usize>() > MAX_CSP_DOMAIN_BYTES {
        return Err(format!(
            "MCP app sandbox {name} exceeds the {MAX_CSP_DOMAIN_BYTES}-byte limit"
        ));
    }

    // Match the pinned Goose parser: trim safe values and reduce URLs to CSP
    // origins. Reject unsafe entries instead of silently weakening the policy.
    domains
        .into_iter()
        .map(|domain| {
            normalize_csp_source(&domain)
                .ok_or_else(|| format!("MCP app sandbox {name} contains an invalid CSP source"))
        })
        .collect()
}

// Keep this contract aligned with the pinned Goose `normalize_csp_source`.
// The broker rejects instead of silently dropping a source so the policy bound
// to a capability is byte-for-byte the policy Goose will render.
fn normalize_csp_source(source: &str) -> Option<String> {
    let source = source.trim();
    if source.is_empty()
        || source.chars().any(|character| {
            character.is_ascii_whitespace() || matches!(character, ';' | ',' | '"' | '\'')
        })
    {
        return None;
    }

    if let Some((scheme, rest)) = source.split_once("://") {
        let scheme = scheme.to_ascii_lowercase();
        if !matches!(scheme.as_str(), "http" | "https" | "ws" | "wss") {
            return None;
        }
        let authority = rest.split(['/', '?', '#']).next()?;
        if !is_valid_csp_host_source(authority) {
            return None;
        }
        return Some(format!("{scheme}://{}", authority.to_ascii_lowercase()));
    }

    is_valid_csp_host_source(source).then(|| source.to_ascii_lowercase())
}

fn is_valid_csp_host_source(source: &str) -> bool {
    if source.is_empty() || source == "*" || source.contains('@') {
        return false;
    }
    let (host, port) = split_host_and_port(source);
    if host.is_empty() || port.is_some_and(|port| port.is_empty() || port.parse::<u16>().is_err()) {
        return false;
    }
    let host = host.strip_prefix("*.").unwrap_or(host);
    if host.eq_ignore_ascii_case("localhost")
        || host.parse::<std::net::Ipv4Addr>().is_ok()
        || host.parse::<std::net::Ipv6Addr>().is_ok()
    {
        return true;
    }
    host.contains('.')
        && host
            .split('.')
            .all(|label| is_valid_dns_label(label) && label != "*")
}

fn split_host_and_port(source: &str) -> (&str, Option<&str>) {
    if let Some(remainder) = source.strip_prefix('[') {
        if let Some((host, tail)) = remainder.split_once(']') {
            return (host, tail.strip_prefix(':'));
        }
    }
    match source.rsplit_once(':') {
        Some((host, port)) if !host.contains(':') => (host, Some(port)),
        _ => (source, None),
    }
}

fn is_valid_dns_label(label: &str) -> bool {
    !label.is_empty()
        && !label.starts_with('-')
        && !label.ends_with('-')
        && label
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '-')
}

fn build_proxy_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(UPSTREAM_CONNECT_TIMEOUT)
        .timeout(UPSTREAM_REQUEST_TIMEOUT)
        .redirect(Policy::none())
        .no_proxy()
        .build()
        .map_err(|error| format!("Failed to build MCP app proxy client: {error}"))
}

fn build_proxy_router(state: ServerState) -> Router {
    Router::new()
        .route("/mcp-app-sandbox/proxy/{capability}", get(serve_proxy))
        .route("/mcp-app-sandbox/store/{capability}", post(store_guest))
        .layer(middleware::map_response(apply_private_headers))
        .with_state(state)
}

fn build_guest_router(state: ServerState) -> Router {
    Router::new()
        .route("/mcp-app-sandbox/guest/{capability}", get(serve_guest))
        .layer(middleware::map_response(apply_private_headers))
        .with_state(state)
}

async fn apply_private_headers(mut response: Response) -> Response {
    apply_private_response_headers(response.headers_mut());
    response
}

async fn serve_proxy(
    State(state): State<ServerState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Path(capability): Path<String>,
    uri: Uri,
    headers: HeaderMap,
) -> Response {
    if !peer.ip().is_loopback()
        || !request_targets_bound_origin(&uri, &headers, &state.public_origin)
        || !valid_document_request(&headers, "cross-site")
    {
        return not_found();
    }
    let Some(grant) = take_capability(&state.proxy_grants, &capability) else {
        return not_found();
    };
    let ProxyGrant {
        config,
        upstream_base_url,
        upstream_secret,
    } = grant;
    let upstream_url = match build_upstream_proxy_url(&upstream_base_url, &upstream_secret, &config)
    {
        Ok(url) => url,
        Err(_) => return upstream_unavailable(),
    };
    let upstream = match state
        .client
        .get(upstream_url)
        .header("x-secret-key", &upstream_secret)
        .send()
        .await
    {
        Ok(response) => response,
        Err(_) => return upstream_unavailable(),
    };
    if upstream.status() != reqwest::StatusCode::OK {
        return upstream_unavailable();
    }
    let html = match read_limited_response(upstream, MAX_PROXY_BYTES).await {
        Ok(html) => html,
        Err(_) => return upstream_unavailable(),
    };
    let upstream_guest_origin = match validate_pinned_proxy_template(&html, &config) {
        Ok(origin) => origin,
        Err(error) => {
            log::error!("Refusing incompatible Goose MCP app proxy document: {error}");
            return upstream_unavailable();
        }
    };
    let outer_csp = build_outer_csp(&config, &state.guest_base_url);
    let store_capability = match state
        .store_grants
        .lock()
        .map_err(|_| ())
        .and_then(|mut grants| {
            grants
                .insert(
                    StoreGrant {
                        upstream_base_url,
                        upstream_secret,
                        upstream_guest_origin: upstream_guest_origin.clone(),
                        outer_csp: outer_csp.clone(),
                        document_binding: config.document_binding.clone(),
                        document_digest: config.document_digest.clone(),
                    },
                    STORE_CAPABILITY_TTL,
                )
                .map_err(|_| ())
        }) {
        Ok(token) => token,
        Err(_) => return upstream_unavailable(),
    };
    let store_path = format!("{STORE_ROUTE_PREFIX}{store_capability}");
    let html = match rewrite_proxy_html(
        &html,
        &store_path,
        &config.color_scheme,
        &upstream_guest_origin,
        &state.guest_base_url,
    ) {
        Ok(html) => html,
        Err(error) => {
            remove_capability(&state.store_grants, &store_capability);
            log::error!("Refusing incompatible Goose MCP app proxy document: {error}");
            return upstream_unavailable();
        }
    };
    let mut response = html.into_response();
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/html; charset=utf-8"),
    );
    apply_private_response_headers(response.headers_mut());
    response
}

async fn store_guest(
    State(state): State<ServerState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Path(capability): Path<String>,
    uri: Uri,
    headers: HeaderMap,
    body: Body,
) -> Response {
    if !peer.ip().is_loopback()
        || !request_targets_bound_origin(&uri, &headers, &state.public_origin)
        || !valid_store_request(&headers, &state.public_origin)
    {
        return not_found();
    }
    let Some(grant) = reserve_capability(&state.store_grants, &capability) else {
        return not_found();
    };
    let body = match axum::body::to_bytes(body, MAX_GUEST_BYTES).await {
        Ok(body) => body,
        Err(_) => {
            release_capability(&state.store_grants, &capability);
            return (StatusCode::PAYLOAD_TOO_LARGE, "Guest document is too large").into_response();
        }
    };
    let body = match attach_upstream_secret(
        &body,
        &grant.upstream_secret,
        &grant.outer_csp,
        &grant.document_binding,
        &grant.document_digest,
    ) {
        Ok(body) => body,
        Err(_) => {
            release_capability(&state.store_grants, &capability);
            return (StatusCode::BAD_REQUEST, "Invalid guest document").into_response();
        }
    };
    let Some(grant) = take_reserved_capability(&state.store_grants, &capability) else {
        return not_found();
    };
    let upstream_url = match join_route(&grant.upstream_base_url, UPSTREAM_GUEST_PATH) {
        Ok(url) => url,
        Err(_) => return upstream_unavailable(),
    };
    // The HTML/CSP exchange carries the host credential only on loopback, but
    // URLs are commonly logged by HTTP stacks. Put it in a header here rather
    // than reproducing Goose's authenticated query URL.
    let upstream = match state
        .client
        .post(upstream_url)
        .header(header::CONTENT_TYPE, "application/json")
        .header("x-secret-key", &grant.upstream_secret)
        .body(body)
        .send()
        .await
    {
        Ok(response) => response,
        Err(_) => return upstream_unavailable(),
    };
    if upstream.status() != reqwest::StatusCode::OK {
        return upstream_unavailable();
    }
    let payload: serde_json::Value = match read_limited_response(upstream, MAX_STORE_RESPONSE_BYTES)
        .await
        .and_then(|body| serde_json::from_str(&body).map_err(|error| error.to_string()))
    {
        Ok(payload) => payload,
        Err(_) => return upstream_unavailable(),
    };
    let upstream_nonce = match payload.get("nonce").and_then(serde_json::Value::as_str) {
        Some(nonce) if valid_nonce(nonce) => nonce.to_string(),
        _ => return upstream_unavailable(),
    };
    let upstream_guest_url = match validate_upstream_guest_url(
        payload.get("guestUrl").and_then(serde_json::Value::as_str),
        &grant.upstream_guest_origin,
        &upstream_nonce,
    ) {
        Ok(url) => url,
        Err(_) => return upstream_unavailable(),
    };
    let upstream_guest = match state.client.get(upstream_guest_url).send().await {
        Ok(response) if response.status() == reqwest::StatusCode::OK => response,
        Ok(_) | Err(_) => return upstream_unavailable(),
    };
    if upstream_guest
        .content_length()
        .is_some_and(|length| length > MAX_GUEST_BYTES as u64)
    {
        return upstream_unavailable();
    }
    let guest_headers = upstream_guest.headers().clone();
    let html = match read_limited_bytes(upstream_guest, MAX_GUEST_BYTES).await {
        Ok(html) => html,
        Err(_) => return upstream_unavailable(),
    };
    let content_type_is_html = guest_headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.to_ascii_lowercase().starts_with("text/html"));
    if !content_type_is_html {
        return upstream_unavailable();
    }
    let csp = guest_headers.get(header::CONTENT_SECURITY_POLICY).cloned();
    let document_binding = grant.document_binding.clone();
    let guest_capability = match state
        .guest_grants
        .lock()
        .map_err(|_| ())
        .and_then(|mut grants| {
            grants
                .insert(GuestGrant { html, csp }, GUEST_GRANT_TTL)
                .map_err(|_| ())
        }) {
        Ok(token) => token,
        Err(_) => return upstream_unavailable(),
    };
    let guest_url = format!(
        "{}{}{}#{}",
        state.guest_base_url,
        GUEST_ROUTE_PREFIX,
        guest_capability,
        fragment_document_binding(&document_binding)
    );
    let mut response = axum::Json(serde_json::json!({ "guestUrl": guest_url })).into_response();
    apply_private_response_headers(response.headers_mut());
    response
}

async fn serve_guest(
    State(state): State<ServerState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Path(capability): Path<String>,
    uri: Uri,
    headers: HeaderMap,
) -> Response {
    if !peer.ip().is_loopback()
        || !request_targets_bound_origin(&uri, &headers, &state.guest_base_url)
        || !valid_document_request(&headers, "same-site")
    {
        return not_found();
    }
    let Some(grant) = take_capability(&state.guest_grants, &capability) else {
        return not_found();
    };
    let mut response = grant.html.into_response();
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/html; charset=utf-8"),
    );
    if let Some(csp) = grant.csp {
        response
            .headers_mut()
            .insert(header::CONTENT_SECURITY_POLICY, csp);
    }
    apply_private_response_headers(response.headers_mut());
    response
}

fn header_matches(headers: &HeaderMap, name: &'static str, expected: &str) -> bool {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value == expected)
}

fn request_targets_bound_origin(uri: &Uri, headers: &HeaderMap, expected_origin: &str) -> bool {
    let Ok(expected) = reqwest::Url::parse(expected_origin) else {
        return false;
    };
    let Some(expected_authority) = expected.host_str().map(|host| match expected.port() {
        Some(port) => format!("{host}:{port}"),
        None => host.to_string(),
    }) else {
        return false;
    };
    if !header_matches(headers, header::HOST.as_str(), &expected_authority) {
        return false;
    }
    uri.scheme()
        .is_none_or(|scheme| scheme.as_str() == expected.scheme())
        && uri
            .authority()
            .is_none_or(|authority| authority.as_str() == expected_authority)
}

fn valid_document_request(headers: &HeaderMap, expected_site: &str) -> bool {
    !headers.contains_key(ORIGIN_HEADER)
        && header_matches(headers, SEC_FETCH_DEST_HEADER, DOCUMENT_FETCH_DEST)
        && header_matches(headers, SEC_FETCH_MODE_HEADER, DOCUMENT_FETCH_MODE)
        && header_matches(headers, SEC_FETCH_SITE_HEADER, expected_site)
}

fn valid_store_request(headers: &HeaderMap, expected_origin: &str) -> bool {
    header_matches(headers, ORIGIN_HEADER, expected_origin)
        && header_matches(headers, SEC_FETCH_DEST_HEADER, "empty")
        && header_matches(headers, SEC_FETCH_MODE_HEADER, "cors")
        && header_matches(headers, SEC_FETCH_SITE_HEADER, FETCH_SITE_SAME_ORIGIN)
        && headers
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| {
                value
                    .split(';')
                    .next()
                    .is_some_and(|mime| mime.trim().eq_ignore_ascii_case("application/json"))
            })
}

fn reserve_capability<T: Clone>(store: &Mutex<CapabilityStore<T>>, token: &str) -> Option<T> {
    if !valid_capability(token) {
        return None;
    }
    let mut store = store.lock().ok()?;
    if !store.reserve(token) {
        return None;
    }
    store.entries.get(token).map(|entry| entry.value.clone())
}

fn take_reserved_capability<T>(store: &Mutex<CapabilityStore<T>>, token: &str) -> Option<T> {
    if !valid_capability(token) {
        return None;
    }
    store.lock().ok()?.take_reserved(token)
}

fn release_capability<T>(store: &Mutex<CapabilityStore<T>>, token: &str) {
    if let Ok(mut store) = store.lock() {
        store.release(token);
    }
}

fn take_capability<T>(store: &Mutex<CapabilityStore<T>>, token: &str) -> Option<T> {
    if !valid_capability(token) {
        return None;
    }
    store.lock().ok()?.take(token)
}

fn remove_capability<T>(store: &Mutex<CapabilityStore<T>>, token: &str) {
    if let Ok(mut store) = store.lock() {
        store.entries.remove(token);
    }
}

async fn read_limited_bytes(
    response: reqwest::Response,
    max_bytes: usize,
) -> Result<Bytes, String> {
    if response
        .content_length()
        .is_some_and(|length| length > max_bytes as u64)
    {
        return Err("upstream response exceeds size limit".to_string());
    }

    let mut stream = response.bytes_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| format!("failed to read upstream response: {error}"))?;
        let next_len = bytes
            .len()
            .checked_add(chunk.len())
            .ok_or_else(|| "upstream response exceeds size limit".to_string())?;
        if next_len > max_bytes {
            return Err("upstream response exceeds size limit".to_string());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(Bytes::from(bytes))
}

async fn read_limited_response(
    response: reqwest::Response,
    max_bytes: usize,
) -> Result<String, String> {
    let bytes = read_limited_bytes(response, max_bytes).await?;
    String::from_utf8(bytes.to_vec())
        .map_err(|error| format!("upstream response is not UTF-8: {error}"))
}

fn random_bytes() -> [u8; CAPABILITY_BYTES] {
    let mut bytes = [0_u8; CAPABILITY_BYTES];
    let first = uuid::Uuid::new_v4();
    let second = uuid::Uuid::new_v4();
    bytes[..16].copy_from_slice(first.as_bytes());
    bytes[16..].copy_from_slice(second.as_bytes());
    bytes
}

fn random_capability() -> String {
    URL_SAFE_NO_PAD.encode(random_bytes())
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    let mut difference = left.len() ^ right.len();
    let max_len = left.len().max(right.len());
    for index in 0..max_len {
        difference |= usize::from(left.get(index).copied().unwrap_or_default())
            ^ usize::from(right.get(index).copied().unwrap_or_default());
    }
    difference == 0
}

fn valid_capability(token: &str) -> bool {
    token.len() == 43
        && token
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn valid_nonce(nonce: &str) -> bool {
    !nonce.is_empty()
        && nonce.len() <= 128
        && nonce
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn fragment_document_binding(document_binding: &str) -> String {
    url::form_urlencoded::Serializer::new(String::new())
        .append_pair("document", document_binding)
        .finish()
}

fn build_proxy_capability_url(
    public_base_url: &str,
    capability: &str,
    document_binding: &str,
) -> String {
    format!(
        "{public_base_url}{PROXY_ROUTE_PREFIX}{capability}#{}",
        fragment_document_binding(document_binding)
    )
}

async fn goose_proxy_credentials(
    app_handle: &tauri::AppHandle,
) -> Result<(String, String), String> {
    if let Some(url) = configured_goose_serve_url() {
        return configured_goose_proxy_credentials(&url);
    }
    let process = GooseServeProcess::get(app_handle.clone()).await?;
    let (base_url, secret) = process.proxy_credentials();
    Ok((base_url, secret.to_string()))
}

fn configured_goose_proxy_credentials(goose_serve_url: &str) -> Result<(String, String), String> {
    super::super::commands::acp::ensure_configured_goose_serve_supports_inline_apps(
        goose_serve_url,
    )?;
    Ok((
        super::super::commands::acp::goose_serve_http_base_url(goose_serve_url)?,
        super::super::commands::acp::goose_serve_url_token(goose_serve_url)?,
    ))
}

fn configured_goose_serve_url() -> Option<String> {
    std::env::var("GOOSE_SERVE_URL")
        .ok()
        .map(|url| url.trim().to_string())
        .filter(|url| !url.is_empty())
}

fn build_outer_csp(config: &McpAppProxyConfig, guest_origin: &str) -> String {
    fn sources(domains: &[String]) -> String {
        if domains.is_empty() {
            String::new()
        } else {
            format!(" {}", domains.join(" "))
        }
    }

    let resources = sources(&config.resource_domains);
    let scripts = sources(&config.script_domains);
    let connections = sources(&config.connect_domains);
    let base_uris = sources(&config.base_uri_domains);
    let frames = sources(&config.frame_domains);

    format!(
        "default-src 'none'; \
         script-src 'self' 'unsafe-inline'{resources}{scripts}; \
         script-src-elem 'self' 'unsafe-inline'{resources}{scripts}; \
         style-src 'self' 'unsafe-inline'{resources}; \
         style-src-elem 'self' 'unsafe-inline'{resources}; \
         connect-src 'self'{connections}; \
         img-src 'self' data: blob:{resources}; \
         font-src 'self'{resources}; \
         media-src 'self' data: blob:{resources}; \
         frame-src 'self' {guest_origin}{frames}; \
         object-src 'none'; \
         form-action 'none'; \
         base-uri 'self'{base_uris}"
    )
}

fn build_upstream_proxy_url(
    base_url: &str,
    secret: &str,
    config: &McpAppProxyConfig,
) -> Result<reqwest::Url, String> {
    let mut url = join_route(base_url, UPSTREAM_PROXY_PATH)?;
    {
        let mut params = url.query_pairs_mut();
        params.append_pair("secret", secret);
        append_domains(&mut params, "connect_domains", &config.connect_domains);
        append_domains(&mut params, "resource_domains", &config.resource_domains);
        append_domains(&mut params, "frame_domains", &config.frame_domains);
        append_domains(&mut params, "base_uri_domains", &config.base_uri_domains);
        append_domains(&mut params, "script_domains", &config.script_domains);
    }
    Ok(url)
}

fn append_domains(
    params: &mut url::form_urlencoded::Serializer<'_, url::UrlQuery<'_>>,
    name: &str,
    domains: &[String],
) {
    if !domains.is_empty() {
        params.append_pair(name, &domains.join(","));
    }
}

fn join_route(base_url: &str, route: &str) -> Result<reqwest::Url, String> {
    let base = reqwest::Url::parse(base_url)
        .map_err(|error| format!("Invalid Goose HTTP base URL: {error}"))?;
    if !matches!(base.scheme(), "http" | "https")
        || base.host_str().is_none()
        || base.cannot_be_a_base()
        || base.query().is_some()
        || base.fragment().is_some()
        || !base.username().is_empty()
        || base.password().is_some()
    {
        return Err("Invalid Goose HTTP base URL".to_string());
    }
    let mut url = base
        .join(route.trim_start_matches('/'))
        .map_err(|error| format!("Invalid Goose proxy route: {error}"))?;
    if !base.path().is_empty() && base.path() != "/" {
        let prefix = base.path().trim_end_matches('/');
        url.set_path(&format!("{prefix}{route}"));
    }
    Ok(url)
}

fn validate_upstream_guest_url(
    guest_url: Option<&str>,
    expected_origin: &str,
    expected_nonce: &str,
) -> Result<reqwest::Url, String> {
    let url =
        reqwest::Url::parse(guest_url.ok_or_else(|| "upstream guest URL is missing".to_string())?)
            .map_err(|error| format!("invalid upstream guest URL: {error}"))?;
    let expected = reqwest::Url::parse(expected_origin)
        .map_err(|error| format!("invalid expected upstream guest origin: {error}"))?;
    if !matches!(url.scheme(), "http" | "https")
        || url.origin() != expected.origin()
        || url.path() != UPSTREAM_GUEST_PATH
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err("upstream guest URL does not match the pinned Goose contract".to_string());
    }
    let mut query = url.query_pairs();
    if !matches!(
        (query.next(), query.next()),
        (Some((name, value)), None) if name == "nonce" && value == expected_nonce
    ) {
        return Err("upstream guest URL nonce does not match the store grant".to_string());
    }
    Ok(url)
}

fn attach_upstream_secret(
    body: &[u8],
    secret: &str,
    outer_csp: &str,
    expected_document_binding: &str,
    expected_document_digest: &str,
) -> Result<Vec<u8>, serde_json::Error> {
    let mut value: serde_json::Value = serde_json::from_slice(body)?;
    let object = value
        .as_object_mut()
        .ok_or_else(|| serde_json::Error::io(std::io::Error::other("expected object")))?;
    object.remove("secret");
    let document_binding_matches = object
        .remove("documentBinding")
        .and_then(|value| value.as_str().map(str::to_string))
        .is_some_and(|binding| binding == expected_document_binding);
    if !document_binding_matches {
        return Err(serde_json::Error::io(std::io::Error::other(
            "document binding mismatch",
        )));
    }
    let html = object
        .get("html")
        .and_then(serde_json::Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| serde_json::Error::io(std::io::Error::other("expected string html")))?;
    let actual_document_digest = URL_SAFE_NO_PAD.encode(Sha256::digest(html.as_bytes()));
    if actual_document_digest != expected_document_digest {
        return Err(serde_json::Error::io(std::io::Error::other(
            "document digest mismatch",
        )));
    }
    object.clear();
    object.insert(
        "secret".to_string(),
        serde_json::Value::String(secret.to_string()),
    );
    object.insert(
        "html".to_string(),
        serde_json::Value::String(html.to_string()),
    );
    object.insert(
        "csp".to_string(),
        serde_json::Value::String(outer_csp.to_string()),
    );
    serde_json::to_vec(&value)
}

fn rewrite_once(
    html: String,
    pattern: &str,
    replacement: &str,
    description: &str,
) -> Result<String, String> {
    let count = html.matches(pattern).count();
    if count != 1 {
        return Err(format!("expected one {description} marker, found {count}"));
    }
    Ok(html.replacen(pattern, replacement, 1))
}

fn inject_proxy_connect_path(outer_csp: &str, store_path: &str) -> Result<String, String> {
    let count = outer_csp.matches("connect-src 'self'").count();
    if count != 1 {
        return Err(format!(
            "expected one proxy CSP connect-src marker, found {count}"
        ));
    }
    Ok(outer_csp.replacen(
        "connect-src 'self'",
        &format!("connect-src 'self' {store_path}"),
        1,
    ))
}

fn extract_proxy_csp_meta(html: &str) -> Result<&str, String> {
    const MARKER: &str = "<meta http-equiv=\"Content-Security-Policy\" content=\"";
    if html.matches(MARKER).count() != 1 {
        return Err("proxy CSP meta tag does not match the pinned template".to_string());
    }
    let value_start = html
        .find(MARKER)
        .map(|start| start + MARKER.len())
        .ok_or_else(|| "proxy CSP meta tag is missing".to_string())?;
    let value_end = html[value_start..]
        .find("\"/>")
        .map(|offset| value_start + offset)
        .ok_or_else(|| "proxy CSP meta content is malformed".to_string())?;
    Ok(&html[value_start..value_end])
}

fn pinned_proxy_template_with_csp(outer_csp: &str) -> String {
    PINNED_GOOSE_PROXY_TEMPLATE.replace("{{OUTER_CSP}}", outer_csp)
}

fn validate_pinned_proxy_template(
    html: &str,
    config: &McpAppProxyConfig,
) -> Result<String, String> {
    const GUEST_ORIGIN_SENTINEL: &str = "http://127.0.0.1:1";
    let outer_csp = extract_proxy_csp_meta(html)?;
    let sentinel_csp = build_outer_csp(config, GUEST_ORIGIN_SENTINEL);
    let sentinel_start = sentinel_csp
        .find(GUEST_ORIGIN_SENTINEL)
        .ok_or_else(|| "pinned CSP guest origin marker is missing".to_string())?;
    if sentinel_csp.matches(GUEST_ORIGIN_SENTINEL).count() != 1 {
        return Err("pinned CSP guest origin marker is ambiguous".to_string());
    }
    let prefix = &sentinel_csp[..sentinel_start];
    let suffix = &sentinel_csp[sentinel_start + GUEST_ORIGIN_SENTINEL.len()..];
    let origin = outer_csp
        .strip_prefix(prefix)
        .and_then(|value| value.strip_suffix(suffix))
        .ok_or_else(|| "proxy CSP does not match the capability policy".to_string())?;
    let parsed = reqwest::Url::parse(origin)
        .map_err(|error| format!("invalid upstream Goose guest origin: {error}"))?;
    if parsed.scheme() != "http"
        || parsed.host_str().is_none()
        || parsed.port().is_none()
        || parsed.path() != "/"
        || parsed.query().is_some()
        || parsed.fragment().is_some()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return Err("upstream Goose guest origin is invalid".to_string());
    }
    if html != pinned_proxy_template_with_csp(outer_csp) {
        return Err(format!(
            "proxy template does not match pinned Goose commit {PINNED_GOOSE_COMMIT}"
        ));
    }
    Ok(origin.to_string())
}

fn rewrite_proxy_html(
    html: &str,
    store_path: &str,
    color_scheme: &str,
    upstream_guest_origin: &str,
    guest_base_url: &str,
) -> Result<String, String> {
    let outer_csp = extract_proxy_csp_meta(html)?;
    let local_outer_csp = rewrite_once(
        outer_csp.to_string(),
        upstream_guest_origin,
        guest_base_url,
        "upstream guest origin",
    )?;
    let local_outer_csp = inject_proxy_connect_path(&local_outer_csp, store_path)?;
    let html = rewrite_once(
        html.to_string(),
        outer_csp,
        &local_outer_csp,
        "proxy CSP policy",
    )?;
    let html = rewrite_once(html, SECRET_QUERY_EXPRESSION, "''", "secret query")?;
    let html = rewrite_once(
        html,
        LOCATION_QUERY_EXPRESSION,
        "new URLSearchParams()",
        "location query",
    )?;
    let html = rewrite_once(
        html,
        COLOR_SCHEME_QUERY_EXPRESSION,
        &serde_json::to_string(color_scheme).map_err(|error| error.to_string())?,
        "color scheme query",
    )?;
    let html = rewrite_once(
        html,
        PROXY_BASE_EXPRESSION,
        "baseUrl: window.location.origin,",
        "proxy base URL",
    )?;
    let html = rewrite_once(
        html,
        UPSTREAM_STORE_EXPRESSION,
        &serde_json::to_string(store_path).map_err(|error| error.to_string())?,
        "guest store route",
    )?;
    let html = rewrite_once(html, SECRET_BODY_FIELD, "", "secret body field")?;
    let html = rewrite_once(
        html,
        GUEST_HTML_PREPARATION_EXPRESSION,
        "var guestHtml = html;",
        "guest HTML preparation",
    )?;
    let html = rewrite_once(
        html,
        STORE_BODY_CLOSE_EXPRESSION,
        "csp: ''\n            })",
        "guest CSP body field",
    )?;
    let html = rewrite_once(
        html,
        "csp: ''\n            })",
        "csp: '', documentBinding: new URLSearchParams(window.location.hash.slice(1)).get('document') || ''\n            })",
        "document binding body field",
    )?;
    let boot = format!(
        "<script>document.documentElement.style.colorScheme={scheme};</script>",
        scheme = serde_json::to_string(color_scheme).map_err(|error| error.to_string())?
    );
    rewrite_once(
        html,
        HEAD_TAG,
        &format!("{HEAD_TAG}{boot}"),
        "document head element",
    )
}

fn apply_private_response_headers(headers: &mut HeaderMap) {
    headers.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        HeaderName::from_static("clear-site-data"),
        HeaderValue::from_static("\"cache\", \"cookies\", \"storage\""),
    );
}

fn not_found() -> Response {
    (StatusCode::NOT_FOUND, "Not found").into_response()
}

fn upstream_unavailable() -> Response {
    (
        StatusCode::BAD_GATEWAY,
        "MCP app sandbox service unavailable",
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::extract::RawQuery;
    use tokio::net::TcpListener;

    fn query_value(query: Option<&str>, name: &str) -> Option<String> {
        url::form_urlencoded::parse(query.unwrap_or_default().as_bytes())
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.into_owned())
    }

    fn environment_lock() -> std::sync::MutexGuard<'static, ()> {
        crate::test_support::env_lock()
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    struct RemoveConfiguredGooseOnDrop;

    impl Drop for RemoveConfiguredGooseOnDrop {
        fn drop(&mut self) {
            std::env::remove_var("GOOSE_SERVE_URL");
        }
    }

    fn proxy_template(outer_csp: &str) -> String {
        pinned_proxy_template_with_csp(outer_csp)
    }

    #[test]
    fn trusted_ipc_nonce_is_top_level_only_and_not_a_capability() {
        let trusted_ipc = TrustedMcpSandboxIpc::new();
        let script = trusted_ipc.initialization_script();

        assert!(script.contains("window.top === window"));
        assert!(script.contains(TRUSTED_IPC_NONCE_PROPERTY));
        assert!(script.contains("configurable: false"));
        assert!(script.contains("enumerable: false"));
        assert!(script.contains("writable: false"));
        let encoded_nonce = URL_SAFE_NO_PAD.encode(trusted_ipc.nonce);
        assert!(trusted_ipc.allows(&encoded_nonce));
        assert!(!trusted_ipc.allows("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"));
    }

    #[test]
    fn renderer_label_check_rejects_unowned_webviews() {
        assert!(trusted_renderer_label("main"));
        assert!(trusted_renderer_label(&format!(
            "session:{}",
            "a".repeat(64)
        )));
        assert!(!trusted_renderer_label("session:chat-id"));
        assert!(!trusted_renderer_label(&format!(
            "session:{}",
            "A".repeat(64)
        )));
        assert!(!trusted_renderer_label("mcp-app-sandbox"));
        assert!(!trusted_renderer_label("settings"));
    }

    #[test]
    fn local_request_shape_is_confined_to_the_bound_origin_and_route_context() {
        let origin = "http://127.0.0.1:4243";
        let relative_uri = Uri::from_static("/mcp-app-sandbox/proxy/capability");
        let mut document_headers = HeaderMap::new();
        document_headers.insert(header::HOST, HeaderValue::from_static("127.0.0.1:4243"));
        document_headers.insert(
            SEC_FETCH_DEST_HEADER,
            HeaderValue::from_static(DOCUMENT_FETCH_DEST),
        );
        document_headers.insert(
            SEC_FETCH_MODE_HEADER,
            HeaderValue::from_static(DOCUMENT_FETCH_MODE),
        );
        document_headers.insert(
            SEC_FETCH_SITE_HEADER,
            HeaderValue::from_static("cross-site"),
        );
        assert!(request_targets_bound_origin(
            &relative_uri,
            &document_headers,
            origin
        ));
        assert!(valid_document_request(&document_headers, "cross-site"));

        let mut missing_fetch_metadata = document_headers.clone();
        missing_fetch_metadata.remove(SEC_FETCH_DEST_HEADER);
        assert!(!valid_document_request(
            &missing_fetch_metadata,
            "cross-site"
        ));
        missing_fetch_metadata = document_headers.clone();
        missing_fetch_metadata.remove(SEC_FETCH_SITE_HEADER);
        assert!(!valid_document_request(
            &missing_fetch_metadata,
            "cross-site"
        ));

        document_headers.insert(header::HOST, HeaderValue::from_static("localhost:4243"));
        assert!(!request_targets_bound_origin(
            &relative_uri,
            &document_headers,
            origin
        ));
        document_headers.insert(header::HOST, HeaderValue::from_static("127.0.0.1:4243"));
        document_headers.insert(
            ORIGIN_HEADER,
            HeaderValue::from_static("https://attacker.test"),
        );
        assert!(!valid_document_request(&document_headers, "cross-site"));
        document_headers.remove(ORIGIN_HEADER);
        document_headers.insert(SEC_FETCH_MODE_HEADER, HeaderValue::from_static("cors"));
        assert!(!valid_document_request(&document_headers, "cross-site"));
        document_headers.insert(
            SEC_FETCH_MODE_HEADER,
            HeaderValue::from_static(DOCUMENT_FETCH_MODE),
        );
        document_headers.insert(
            SEC_FETCH_SITE_HEADER,
            HeaderValue::from_static(FETCH_SITE_SAME_ORIGIN),
        );
        assert!(!valid_document_request(&document_headers, "cross-site"));

        let mut guest_headers = document_headers.clone();
        guest_headers.insert(SEC_FETCH_SITE_HEADER, HeaderValue::from_static("same-site"));
        assert!(valid_document_request(&guest_headers, "same-site"));
        guest_headers.insert(
            SEC_FETCH_SITE_HEADER,
            HeaderValue::from_static("cross-site"),
        );
        assert!(!valid_document_request(&guest_headers, "same-site"));

        let mut store_headers = HeaderMap::new();
        store_headers.insert(header::HOST, HeaderValue::from_static("127.0.0.1:4243"));
        store_headers.insert(ORIGIN_HEADER, HeaderValue::from_static(origin));
        store_headers.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/json; charset=utf-8"),
        );
        store_headers.insert(SEC_FETCH_DEST_HEADER, HeaderValue::from_static("empty"));
        store_headers.insert(SEC_FETCH_MODE_HEADER, HeaderValue::from_static("cors"));
        store_headers.insert(
            SEC_FETCH_SITE_HEADER,
            HeaderValue::from_static(FETCH_SITE_SAME_ORIGIN),
        );
        assert!(valid_store_request(&store_headers, origin));
        let mut missing_store_metadata = store_headers.clone();
        missing_store_metadata.remove(SEC_FETCH_MODE_HEADER);
        assert!(!valid_store_request(&missing_store_metadata, origin));
        missing_store_metadata = store_headers.clone();
        missing_store_metadata.remove(SEC_FETCH_SITE_HEADER);
        assert!(!valid_store_request(&missing_store_metadata, origin));
        store_headers.insert(ORIGIN_HEADER, HeaderValue::from_static("null"));
        assert!(!valid_store_request(&store_headers, origin));
        store_headers.insert(ORIGIN_HEADER, HeaderValue::from_static(origin));
        store_headers.insert(
            SEC_FETCH_SITE_HEADER,
            HeaderValue::from_static("cross-site"),
        );
        assert!(!valid_store_request(&store_headers, origin));
    }

    #[test]
    fn capability_is_single_use_and_expires_closed() {
        let mut store = CapabilityStore::default();
        let token = store.insert("document-a", Duration::from_secs(1)).unwrap();
        assert_eq!(store.take(&token), Some("document-a"));
        assert_eq!(store.take(&token), None);

        let expired = store.insert("document-b", Duration::ZERO).unwrap();
        assert_eq!(store.take(&expired), None);
    }

    #[test]
    fn capability_store_is_bounded() {
        let mut store = CapabilityStore::default();
        for value in 0..MAX_CAPABILITY_ENTRIES {
            store.insert(value, Duration::from_secs(1)).unwrap();
        }
        assert!(store
            .insert(MAX_CAPABILITY_ENTRIES, Duration::from_secs(1))
            .is_err());
    }

    #[test]
    fn capability_tokens_do_not_cross_route_scopes() {
        let mut proxy_store = CapabilityStore::default();
        let mut store_store = CapabilityStore::default();
        let mut guest_store = CapabilityStore::default();
        let proxy_token = proxy_store.insert("proxy", Duration::from_secs(1)).unwrap();
        let store_token = store_store.insert("store", Duration::from_secs(1)).unwrap();
        let guest_token = guest_store.insert("guest", Duration::from_secs(1)).unwrap();

        assert_eq!(store_store.take(&proxy_token), None);
        assert_eq!(guest_store.take(&proxy_token), None);
        assert_eq!(proxy_store.take(&store_token), None);
        assert_eq!(guest_store.take(&store_token), None);
        assert_eq!(proxy_store.take(&guest_token), None);
        assert_eq!(store_store.take(&guest_token), None);
        assert_eq!(proxy_store.take(&proxy_token), Some("proxy"));
        assert_eq!(store_store.take(&store_token), Some("store"));
        assert_eq!(guest_store.take(&guest_token), Some("guest"));
    }

    #[test]
    fn proxy_config_bounds_csp_domains() {
        let mut config = McpAppProxyConfig {
            connect_domains: vec![],
            resource_domains: vec![],
            frame_domains: vec![],
            base_uri_domains: vec![],
            script_domains: vec![],
            color_scheme: "light".to_string(),
            document_binding: "A".repeat(43),
            document_digest: "B".repeat(43),
        };
        config.connect_domains =
            vec!["https://example.test".to_string(); MAX_CSP_DOMAINS_PER_DIRECTIVE + 1];
        assert!(normalize_proxy_config(config.clone()).is_err());

        config.connect_domains = vec!["x".repeat(MAX_CSP_DOMAIN_BYTES + 1)];
        assert!(normalize_proxy_config(config.clone()).is_err());

        config.connect_domains = vec!["https://EXAMPLE.test/path".to_string()];
        let config = normalize_proxy_config(config).unwrap();
        assert_eq!(
            config.connect_domains,
            vec!["https://example.test".to_string()]
        );

        let mut config = config;
        config.connect_domains = vec!["https://example.test;".to_string()];
        assert!(normalize_proxy_config(config).is_err());
    }

    #[test]
    fn guest_store_body_requires_the_goose_contract_and_replaces_secret() {
        let binding = "A".repeat(43);
        let html = "<p>guest</p>";
        let digest = URL_SAFE_NO_PAD.encode(Sha256::digest(html.as_bytes()));
        let body = attach_upstream_secret(
            format!(
                r#"{{"secret":"attacker","html":"{html}","csp":"attacker-policy","documentBinding":"{binding}"}}"#
            )
            .as_bytes(),
            "host-secret",
            "trusted-policy",
            &binding,
            &digest,
        )
        .unwrap();
        let payload: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(payload["secret"], "host-secret");
        assert_eq!(payload["html"], html);
        assert_eq!(payload["csp"], "trusted-policy");
        assert_eq!(payload.as_object().unwrap().len(), 3);
        assert!(payload.get("documentBinding").is_none());
        assert!(attach_upstream_secret(
            br#"{"html":42,"documentBinding":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}"#,
            "host-secret",
            "trusted",
            &binding,
            &digest,
        )
        .is_err());
        assert!(attach_upstream_secret(
            br#"{"html":"<p>different</p>","documentBinding":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}"#,
            "host-secret",
            "trusted",
            &binding,
            &digest,
        )
        .is_err());
    }

    #[test]
    fn upstream_routes_preserve_a_configured_path_prefix() {
        let url = join_route("http://127.0.0.1:1234/goose", UPSTREAM_PROXY_PATH).unwrap();
        assert_eq!(url.as_str(), "http://127.0.0.1:1234/goose/mcp-app-proxy");
        assert!(join_route("file:///tmp/goose", UPSTREAM_PROXY_PATH).is_err());
        assert!(join_route("http://user@127.0.0.1:1234", UPSTREAM_PROXY_PATH).is_err());
        assert!(join_route("http://127.0.0.1:1234?token=x", UPSTREAM_PROXY_PATH).is_err());
    }

    #[test]
    fn rewritten_proxy_document_contains_no_host_secret_or_store_bearer_field() {
        let upstream_guest_origin = "http://127.0.0.1:5678";
        let guest_base_url = "http://127.0.0.1:6789";
        let outer_csp = format!(
            "default-src 'none'; script-src 'self' 'unsafe-inline'; connect-src 'self'; frame-src 'self' {upstream_guest_origin}"
        );
        let html = proxy_template(&outer_csp);
        let store_path = "/mcp-app-sandbox/store/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
        let rewritten = rewrite_proxy_html(
            &html,
            store_path,
            "dark",
            upstream_guest_origin,
            guest_base_url,
        )
        .unwrap();
        assert!(!rewritten.contains("params.get('secret')"));
        assert!(!rewritten.contains("params.get('color_scheme')"));
        assert!(rewritten.contains("var colorScheme = \"dark\""));
        assert!(!rewritten.contains("secret: proxyParams.secret"));
        assert!(!rewritten.contains("cspMeta ? cspMeta.content"));
        assert!(!rewritten.contains(GUEST_HTML_PREPARATION_EXPRESSION));
        assert!(rewritten.contains("var guestHtml = html;"));
        assert!(rewritten.contains("csp: ''"));
        assert!(rewritten.contains("documentBinding:"));
        assert!(rewritten.contains("window.location.hash.slice(1)"));
        assert!(!rewritten.contains("window.location.href"));
        assert!(!rewritten.contains("window.location.search"));
        assert!(!rewritten.contains("baseUrl: getProxyBaseUrl()"));
        assert!(rewritten.contains("baseUrl: window.location.origin"));
        assert!(rewritten.contains(store_path));
        assert!(rewritten.contains("style.colorScheme=\"dark\""));
        assert!(rewritten.contains(&format!("connect-src 'self' {store_path}")));
        assert!(rewritten.contains(&format!("frame-src 'self' {guest_base_url}")));
        assert!(!rewritten.contains(upstream_guest_origin));
    }

    #[test]
    fn pinned_proxy_fixture_matches_the_locked_goose_source() {
        let lock: serde_json::Value =
            serde_json::from_str(include_str!("../../../goose-backend.lock.json")).unwrap();
        assert_eq!(
            lock.get("commit").and_then(serde_json::Value::as_str),
            Some(PINNED_GOOSE_COMMIT)
        );
        assert_eq!(
            hex::encode(Sha256::digest(PINNED_GOOSE_PROXY_TEMPLATE.as_bytes())),
            "d7cc6970e5e443b8e423975445328a902a9bf80020a173b4d6a052fc8e709eb9"
        );
    }

    #[test]
    fn proxy_rewrite_fails_closed_when_upstream_template_changes() {
        let outer_csp = "default-src 'none'; connect-src 'self'";
        let changed = proxy_template(outer_csp).replace(
            "params.get('secret') || ''",
            "params.get('credential') || ''",
        );

        assert!(rewrite_proxy_html(
            &changed,
            "/mcp-app-sandbox/store/capability",
            "dark",
            "http://127.0.0.1:5678",
            "http://127.0.0.1:6789",
        )
        .is_err());
    }

    #[test]
    fn outer_csp_matches_the_pinned_goose_builder() {
        let config = McpAppProxyConfig {
            connect_domains: vec!["https://api.example".to_string()],
            resource_domains: vec!["https://cdn.example".to_string()],
            frame_domains: vec!["https://frame.example".to_string()],
            base_uri_domains: vec!["https://base.example".to_string()],
            script_domains: vec!["https://scripts.example".to_string()],
            color_scheme: "dark".to_string(),
            document_binding: "A".repeat(43),
            document_digest: "B".repeat(43),
        };
        assert_eq!(
            build_outer_csp(&config, "http://127.0.0.1:5678"),
            "default-src 'none'; script-src 'self' 'unsafe-inline' https://cdn.example https://scripts.example; script-src-elem 'self' 'unsafe-inline' https://cdn.example https://scripts.example; style-src 'self' 'unsafe-inline' https://cdn.example; style-src-elem 'self' 'unsafe-inline' https://cdn.example; connect-src 'self' https://api.example; img-src 'self' data: blob: https://cdn.example; font-src 'self' https://cdn.example; media-src 'self' data: blob: https://cdn.example; frame-src 'self' http://127.0.0.1:5678 https://frame.example; object-src 'none'; form-action 'none'; base-uri 'self' https://base.example"
        );
    }

    #[test]
    fn upstream_proxy_url_preserves_csp_but_not_color_scheme() {
        let config = McpAppProxyConfig {
            connect_domains: vec!["https://api.example".to_string()],
            resource_domains: vec!["https://cdn.example".to_string()],
            frame_domains: vec![],
            base_uri_domains: vec![],
            script_domains: vec!["https://scripts.example".to_string()],
            color_scheme: "dark".to_string(),
            document_binding: "A".repeat(43),
            document_digest: "B".repeat(43),
        };
        let url =
            build_upstream_proxy_url("http://127.0.0.1:1234", "host-secret", &config).unwrap();
        assert_eq!(url.path(), "/mcp-app-proxy");
        assert_eq!(
            url.query_pairs()
                .find(|(name, _)| name == "secret")
                .map(|(_, value)| value.into_owned()),
            Some("host-secret".to_string())
        );
        assert_eq!(
            url.query_pairs()
                .find(|(name, _)| name == "connect_domains")
                .map(|(_, value)| value.into_owned()),
            Some("https://api.example".to_string())
        );
        assert!(url.query_pairs().all(|(name, _)| name != "frame_domains"));
        assert!(!url.query_pairs().any(|(name, _)| name == "color_scheme"));
    }

    #[derive(Clone, Debug)]
    struct UpstreamMainState {
        counts: UpstreamRequestCounts,
        guest_origin: String,
    }

    async fn upstream_proxy(
        State(state): State<UpstreamMainState>,
        headers: HeaderMap,
        RawQuery(query): RawQuery,
    ) -> Response {
        state
            .counts
            .proxy
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let secret = query_value(query.as_deref(), "secret");
        let connect_domains = query_value(query.as_deref(), "connect_domains")
            .map(|domains| domains.split(',').map(str::to_string).collect::<Vec<_>>())
            .unwrap_or_default();
        let resource_domains = query_value(query.as_deref(), "resource_domains")
            .map(|domains| domains.split(',').map(str::to_string).collect::<Vec<_>>())
            .unwrap_or_default();
        let frame_domains = query_value(query.as_deref(), "frame_domains")
            .map(|domains| domains.split(',').map(str::to_string).collect::<Vec<_>>())
            .unwrap_or_default();
        let base_uri_domains = query_value(query.as_deref(), "base_uri_domains")
            .map(|domains| domains.split(',').map(str::to_string).collect::<Vec<_>>())
            .unwrap_or_default();
        let script_domains = query_value(query.as_deref(), "script_domains")
            .map(|domains| domains.split(',').map(str::to_string).collect::<Vec<_>>())
            .unwrap_or_default();
        if secret.as_deref() != Some("host-secret")
            || headers
                .get("x-secret-key")
                .and_then(|value| value.to_str().ok())
                != Some("host-secret")
        {
            return StatusCode::UNAUTHORIZED.into_response();
        }
        let config = McpAppProxyConfig {
            connect_domains,
            resource_domains,
            frame_domains,
            base_uri_domains,
            script_domains,
            color_scheme: "light".to_string(),
            document_binding: "A".repeat(43),
            document_digest: "B".repeat(43),
        };
        let csp = build_outer_csp(&config, &state.guest_origin);
        (
            [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
            proxy_template(&csp),
        )
            .into_response()
    }

    #[derive(Clone, Debug)]
    struct UpstreamRequestCounts {
        proxy: Arc<std::sync::atomic::AtomicUsize>,
        store: Arc<std::sync::atomic::AtomicUsize>,
        guest: Arc<std::sync::atomic::AtomicUsize>,
    }

    impl Default for UpstreamRequestCounts {
        fn default() -> Self {
            Self {
                proxy: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
                store: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
                guest: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
            }
        }
    }

    async fn upstream_store_guest(
        State(state): State<UpstreamMainState>,
        headers: HeaderMap,
        body: Bytes,
    ) -> Response {
        state
            .counts
            .store
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        if headers
            .get("x-secret-key")
            .and_then(|value| value.to_str().ok())
            != Some("host-secret")
        {
            return StatusCode::UNAUTHORIZED.into_response();
        }
        let payload: serde_json::Value = match serde_json::from_slice(&body) {
            Ok(payload) => payload,
            Err(_) => return StatusCode::BAD_REQUEST.into_response(),
        };
        if payload.as_object().is_none_or(|object| {
            object.len() != 3
                || !object.contains_key("secret")
                || !object.contains_key("html")
                || !object.contains_key("csp")
        }) {
            return StatusCode::BAD_REQUEST.into_response();
        }
        if payload.get("secret").and_then(serde_json::Value::as_str) != Some("host-secret") {
            return StatusCode::UNAUTHORIZED.into_response();
        }
        if !payload
            .get("csp")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|csp| csp.contains("frame-src 'self' http://127.0.0.1:"))
        {
            return StatusCode::BAD_REQUEST.into_response();
        }
        axum::Json(serde_json::json!({
            "nonce": "guest-nonce",
            "guestUrl": format!(
                "{}/mcp-app-guest?nonce=guest-nonce",
                state.guest_origin
            )
        }))
        .into_response()
    }

    async fn upstream_serve_guest(
        State(counts): State<UpstreamRequestCounts>,
        RawQuery(query): RawQuery,
    ) -> Response {
        counts
            .guest
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        if query_value(query.as_deref(), "nonce").as_deref() != Some("guest-nonce") {
            return StatusCode::NOT_FOUND.into_response();
        }
        (
            [
                (header::CONTENT_TYPE, "text/html; charset=utf-8"),
                (
                    header::CONTENT_SECURITY_POLICY,
                    "default-src 'none'; script-src 'self'",
                ),
            ],
            "<html><body>rendered guest</body></html>",
        )
            .into_response()
    }

    async fn spawn_test_upstream() -> (String, UpstreamRequestCounts) {
        let guest_listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let guest_addr = guest_listener.local_addr().unwrap();
        let guest_origin = format!("http://{guest_addr}");
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let addr = listener.local_addr().unwrap();
        let counts = UpstreamRequestCounts::default();
        let guest_app = Router::new()
            .route(UPSTREAM_GUEST_PATH, get(upstream_serve_guest))
            .with_state(counts.clone());
        let main_state = UpstreamMainState {
            counts: counts.clone(),
            guest_origin,
        };
        let app = Router::new()
            .route(UPSTREAM_PROXY_PATH, get(upstream_proxy))
            .route(UPSTREAM_GUEST_PATH, post(upstream_store_guest))
            .with_state(main_state);
        tokio::spawn(async move { axum::serve(guest_listener, guest_app).await.unwrap() });
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (format!("http://{addr}"), counts)
    }

    #[tokio::test]
    async fn proxy_capability_renders_once_and_confines_each_route_and_document() {
        let _environment = environment_lock();
        let _remove_configured_goose = RemoveConfiguredGooseOnDrop;
        let (upstream_base_url, upstream_counts) = spawn_test_upstream().await;
        std::env::set_var(
            "GOOSE_SERVE_URL",
            format!("{upstream_base_url}/acp?token=host-secret"),
        );
        let server = McpAppProxyServer::start().await.unwrap();
        let proxy_url = server
            .mint_proxy_url(
                McpAppProxyConfig {
                    connect_domains: vec![],
                    resource_domains: vec![],
                    frame_domains: vec![],
                    base_uri_domains: vec![],
                    script_domains: vec![],
                    color_scheme: "light".to_string(),
                    document_binding: "A".repeat(43),
                    document_digest: URL_SAFE_NO_PAD
                        .encode(Sha256::digest(b"<html><body>rendered guest</body></html>")),
                },
                upstream_base_url.clone(),
                "host-secret".to_string(),
            )
            .unwrap();
        let client = reqwest::Client::new();

        let response = client
            .get(&proxy_url)
            .header(SEC_FETCH_DEST_HEADER, DOCUMENT_FETCH_DEST)
            .header(SEC_FETCH_MODE_HEADER, DOCUMENT_FETCH_MODE)
            .header(SEC_FETCH_SITE_HEADER, "cross-site")
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::OK);
        assert_eq!(
            response.headers().get(header::REFERRER_POLICY).unwrap(),
            "no-referrer"
        );
        assert_eq!(
            response.headers().get(header::CACHE_CONTROL).unwrap(),
            "no-store"
        );
        assert_eq!(
            response
                .headers()
                .get(header::X_CONTENT_TYPE_OPTIONS)
                .unwrap(),
            "nosniff"
        );
        assert_eq!(
            response.headers().get("clear-site-data").unwrap(),
            "\"cache\", \"cookies\", \"storage\""
        );
        assert_eq!(
            response.headers().get(header::CONTENT_TYPE).unwrap(),
            "text/html; charset=utf-8"
        );
        let body = response.text().await.unwrap();
        assert!(!body.contains("host-secret"));
        assert!(!proxy_url.contains("host-secret"));
        let proxy_parsed = reqwest::Url::parse(&proxy_url).unwrap();
        assert!(proxy_parsed.query().is_none());
        assert_eq!(
            proxy_parsed.path().matches('/').count(),
            3,
            "the visible URL should carry only the route-scoped capability"
        );
        assert!(!body.contains("window.location.href"));
        assert!(!body.contains("window.location.search"));
        assert!(!body.contains("baseUrl: getProxyBaseUrl()"));
        assert!(body.contains("baseUrl: window.location.origin"));
        assert!(!body.contains("params.get('color_scheme')"));
        assert!(body.contains("var colorScheme = \"light\""));
        let proxy_csp = extract_proxy_csp_meta(&body).unwrap();
        assert!(proxy_csp.contains(&format!("frame-src 'self' {}", server.guest_base_url)));
        assert!(!proxy_csp.contains(&upstream_base_url));
        assert!(!body.contains("cspMeta ? cspMeta.content"));

        assert_eq!(
            client.get(&proxy_url).send().await.unwrap().status(),
            reqwest::StatusCode::NOT_FOUND
        );
        let replay = client.get(&proxy_url).send().await.unwrap();
        assert_eq!(replay.status(), reqwest::StatusCode::NOT_FOUND);
        assert_eq!(
            replay.headers().get(header::REFERRER_POLICY).unwrap(),
            "no-referrer"
        );
        assert_eq!(
            replay.headers().get(header::CACHE_CONTROL).unwrap(),
            "no-store"
        );
        let document_binding = proxy_parsed
            .fragment()
            .and_then(|fragment| {
                url::form_urlencoded::parse(fragment.as_bytes())
                    .find(|(name, _)| name == "document")
                    .map(|(_, value)| value.into_owned())
            })
            .unwrap();
        let proxy_token = proxy_parsed.path_segments().unwrap().next_back().unwrap();
        let unrelated_store = format!(
            "{}{STORE_ROUTE_PREFIX}{proxy_token}",
            server.public_base_url
        );
        assert_eq!(
            client
                .post(unrelated_store)
                .json(&serde_json::json!({"html":"<p>x</p>"}))
                .send()
                .await
                .unwrap()
                .status(),
            reqwest::StatusCode::NOT_FOUND
        );
        let unrelated_guest = format!("{}{GUEST_ROUTE_PREFIX}{proxy_token}", server.guest_base_url);
        assert_eq!(
            client.get(unrelated_guest).send().await.unwrap().status(),
            reqwest::StatusCode::NOT_FOUND
        );

        let store_path = body
            .split('"')
            .find(|part| part.starts_with(STORE_ROUTE_PREFIX))
            .unwrap();
        let store_url = format!("{}{}", server.public_base_url, store_path);
        let document_binding = document_binding.as_str();
        let response = client
            .post(&store_url)
            .header(ORIGIN_HEADER, "https://attacker.test")
            .json(&serde_json::json!({
                "html": "<html><body>rendered guest</body></html>",
                "documentBinding": document_binding,
            }))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::NOT_FOUND);
        let public_base_url = server.public_base_url.clone();
        let malformed = client
            .post(&store_url)
            .header(ORIGIN_HEADER, &public_base_url)
            .header(SEC_FETCH_DEST_HEADER, "empty")
            .header(SEC_FETCH_MODE_HEADER, "cors")
            .header(SEC_FETCH_SITE_HEADER, FETCH_SITE_SAME_ORIGIN)
            .json(&serde_json::json!({
                "html": "<html><body>different document</body></html>",
                "documentBinding": document_binding,
            }))
            .send()
            .await
            .unwrap();
        assert_eq!(malformed.status(), reqwest::StatusCode::BAD_REQUEST);
        assert_eq!(
            upstream_counts
                .store
                .load(std::sync::atomic::Ordering::SeqCst),
            0,
            "a malformed document must release the reservation before upstream work"
        );

        let valid_request = || {
            client
                .post(&store_url)
                .header(ORIGIN_HEADER, &public_base_url)
                .header(SEC_FETCH_DEST_HEADER, "empty")
                .header(SEC_FETCH_MODE_HEADER, "cors")
                .header(SEC_FETCH_SITE_HEADER, FETCH_SITE_SAME_ORIGIN)
                .json(&serde_json::json!({
                    "secret": "attacker-value",
                    "html": "<html><body>rendered guest</body></html>",
                    "csp": "default-src 'none'; script-src 'self'",
                    "documentBinding": document_binding,
                    "unexpected": "must-not-reach-goose",
                }))
                .send()
        };
        let (first, second) = tokio::join!(valid_request(), valid_request());
        let first = first.unwrap();
        let second = second.unwrap();
        let mut statuses = [first.status(), second.status()];
        statuses.sort();
        assert_eq!(
            statuses,
            [reqwest::StatusCode::OK, reqwest::StatusCode::NOT_FOUND,],
            "concurrent redemption must let exactly one request proceed"
        );
        let response = if first.status() == reqwest::StatusCode::OK {
            first
        } else {
            second
        };
        assert_eq!(response.status(), reqwest::StatusCode::OK);
        assert_eq!(
            upstream_counts
                .store
                .load(std::sync::atomic::Ordering::SeqCst),
            1
        );
        assert_eq!(
            upstream_counts
                .guest
                .load(std::sync::atomic::Ordering::SeqCst),
            1,
            "the trusted broker must redeem the upstream nonce before exposing a guest capability"
        );
        let payload: serde_json::Value = response.json().await.unwrap();
        assert_eq!(payload.get("nonce"), None);
        let guest_url = payload.get("guestUrl").unwrap().as_str().unwrap();
        assert!(!guest_url.contains("guest-nonce"));
        assert!(!guest_url.contains("host-secret"));
        assert_ne!(
            reqwest::Url::parse(guest_url).unwrap().origin(),
            reqwest::Url::parse(&proxy_url).unwrap().origin()
        );

        assert_eq!(
            client.post(&store_url).send().await.unwrap().status(),
            reqwest::StatusCode::NOT_FOUND
        );
        let store_token = store_url.rsplit('/').next().unwrap();
        let wrong_guest_url = format!(
            "{}{GUEST_ROUTE_PREFIX}{store_token}",
            server.public_base_url
        );
        assert_eq!(
            client.get(wrong_guest_url).send().await.unwrap().status(),
            reqwest::StatusCode::NOT_FOUND
        );

        let (guest_capability_url, _) = guest_url.split_once('#').unwrap();
        assert_eq!(
            client
                .get(guest_capability_url)
                .header(ORIGIN_HEADER, "https://attacker.test")
                .send()
                .await
                .unwrap()
                .status(),
            reqwest::StatusCode::NOT_FOUND
        );
        assert_eq!(
            client
                .get(guest_capability_url)
                .header(SEC_FETCH_DEST_HEADER, DOCUMENT_FETCH_DEST)
                .header(SEC_FETCH_MODE_HEADER, DOCUMENT_FETCH_MODE)
                .header(SEC_FETCH_SITE_HEADER, "cross-site")
                .send()
                .await
                .unwrap()
                .status(),
            reqwest::StatusCode::NOT_FOUND
        );
        let response = client
            .get(guest_url)
            .header(SEC_FETCH_DEST_HEADER, DOCUMENT_FETCH_DEST)
            .header(SEC_FETCH_MODE_HEADER, DOCUMENT_FETCH_MODE)
            .header(SEC_FETCH_SITE_HEADER, "same-site")
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::OK);
        assert_eq!(
            response.headers().get(header::REFERRER_POLICY).unwrap(),
            "no-referrer"
        );
        assert_eq!(
            response.headers().get(header::CACHE_CONTROL).unwrap(),
            "no-store"
        );
        assert_eq!(
            response
                .headers()
                .get(header::X_CONTENT_TYPE_OPTIONS)
                .unwrap(),
            "nosniff"
        );
        assert_eq!(
            response.headers().get("clear-site-data").unwrap(),
            "\"cache\", \"cookies\", \"storage\""
        );
        assert_eq!(
            response
                .headers()
                .get(header::CONTENT_SECURITY_POLICY)
                .unwrap(),
            "default-src 'none'; script-src 'self'"
        );
        assert_eq!(
            response.text().await.unwrap(),
            "<html><body>rendered guest</body></html>"
        );
        assert_eq!(
            upstream_counts
                .guest
                .load(std::sync::atomic::Ordering::SeqCst),
            1,
            "guest capability reads must not forward the capability or another nonce upstream"
        );
        assert_eq!(
            client.get(guest_url).send().await.unwrap().status(),
            reqwest::StatusCode::NOT_FOUND
        );
    }

    #[tokio::test]
    async fn expired_proxy_capability_fails_before_upstream_work() {
        let _environment = environment_lock();
        let _remove_configured_goose = RemoveConfiguredGooseOnDrop;
        let (upstream_base_url, upstream_counts) = spawn_test_upstream().await;
        std::env::set_var(
            "GOOSE_SERVE_URL",
            format!("{upstream_base_url}/acp?token=host-secret"),
        );
        let server = McpAppProxyServer::start().await.unwrap();
        let proxy_url = server
            .mint_proxy_url_with_ttl(
                McpAppProxyConfig {
                    connect_domains: vec![],
                    resource_domains: vec![],
                    frame_domains: vec![],
                    base_uri_domains: vec![],
                    script_domains: vec![],
                    color_scheme: "light".to_string(),
                    document_binding: "A".repeat(43),
                    document_digest: "B".repeat(43),
                },
                upstream_base_url,
                "host-secret".to_string(),
                Duration::ZERO,
            )
            .unwrap();

        assert_eq!(
            reqwest::get(proxy_url).await.unwrap().status(),
            reqwest::StatusCode::NOT_FOUND
        );
        assert_eq!(
            upstream_counts
                .proxy
                .load(std::sync::atomic::Ordering::SeqCst),
            0,
            "an expired capability must fail before contacting Goose"
        );
    }
}
