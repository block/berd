//! Loopback-only HTTP broker for the berdctl CLI.
//!
//! Serves `GET /v1/ping` (generation/protocol handshake) and `POST /v1/call`
//! (command dispatch over the renderer bridge). There is no application auth
//! in v1; the header rejection below (any `Origin`, any `Sec-Fetch-*`, `Host`
//! mismatch) is the sole defense against browser-JS-to-localhost and DNS
//! rebinding, so it applies to every route.

use crate::bridge::{Bridge, BridgeError, BridgeRequest, BridgeResult};
use crate::discovery::PROTOCOL_VERSION;
use axum::body::Bytes;
use axum::extract::State;
use axum::http::header::{HOST, ORIGIN};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, OnceLock, RwLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Runtime};
use tokio::sync::{oneshot, Semaphore};

pub const IN_FLIGHT_LIMIT: usize = 4;

const DEFAULT_COMMAND_TIMEOUT: Duration = Duration::from_secs(30);
const MIN_REQUEST_TIMEOUT: Duration = Duration::from_secs(1);
const MAX_COMMAND_TIMEOUT: Duration = Duration::from_secs(900);

/// Resolve the bridge timeout for a call: a request `timeout_ms` wins
/// (clamped to [`MIN_REQUEST_TIMEOUT`]..=[`MAX_COMMAND_TIMEOUT`]); otherwise
/// the renderer-pushed per-command timeout; otherwise the default.
fn command_timeout(request_timeout_ms: Option<u64>, configured: Option<Duration>) -> Duration {
    if let Some(ms) = request_timeout_ms {
        return Duration::from_millis(ms).clamp(MIN_REQUEST_TIMEOUT, MAX_COMMAND_TIMEOUT);
    }
    configured.map_or(DEFAULT_COMMAND_TIMEOUT, |timeout| {
        timeout.min(MAX_COMMAND_TIMEOUT)
    })
}

/// Abstraction over the bridge so the server is testable with a stub.
pub trait CommandDispatcher: Send + Sync + 'static {
    fn dispatch(
        &self,
        req: BridgeRequest,
        timeout: Duration,
    ) -> impl Future<Output = Result<BridgeResult, BridgeError>> + Send;
}

/// Production dispatcher: forwards through the bridge into the main window.
pub struct BridgeDispatcher<R: Runtime> {
    pub app: AppHandle<R>,
    pub bridge: Arc<Bridge>,
}

impl<R: Runtime> CommandDispatcher for BridgeDispatcher<R> {
    fn dispatch(
        &self,
        req: BridgeRequest,
        timeout: Duration,
    ) -> impl Future<Output = Result<BridgeResult, BridgeError>> + Send {
        let app = self.app.clone();
        let bridge = self.bridge.clone();
        async move { bridge.dispatch(&app, req, timeout).await }
    }
}

/// Per-command bridge timeouts pushed by the renderer via `set_timeouts`.
/// Without an entry a command falls back to [`DEFAULT_COMMAND_TIMEOUT`], so
/// the renderer pushes the map at broker start, before the first call.
#[derive(Default)]
pub struct TimeoutStore {
    timeouts: RwLock<HashMap<String, Duration>>,
}

impl TimeoutStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// Replaces the map; values are clamped to [`MAX_COMMAND_TIMEOUT`].
    pub fn set(&self, timeouts: HashMap<String, u64>) {
        let clamped = timeouts
            .into_iter()
            .map(|(command, ms)| (command, Duration::from_millis(ms).min(MAX_COMMAND_TIMEOUT)))
            .collect();
        *self.timeouts.write().unwrap() = clamped;
    }

    pub fn timeout_for(&self, command: &str) -> Option<Duration> {
        self.timeouts.read().unwrap().get(command).copied()
    }

    pub fn command_timeout(
        &self,
        command: &str,
        action: Option<&str>,
        request_timeout_ms: Option<u64>,
    ) -> Duration {
        let configured = action
            .and_then(|action| self.timeout_for(&format!("{command}.{action}")))
            .or_else(|| self.timeout_for(command));
        command_timeout(request_timeout_ms, configured)
    }
}

pub struct ServerContext<D> {
    dispatcher: D,
    timeouts: Arc<TimeoutStore>,
    // Global in-flight cap: the bridge holds a permit for the full command
    // timeout, so an unresponsive renderer can pin at most the semaphore's
    // size ([`IN_FLIGHT_LIMIT`] in production) in calls. Owned permits stay
    // bound to this semaphore, so handlers outliving a server restart release
    // against their own instance, never the next server's.
    inflight: Arc<Semaphore>,
    generation: u64,
    // Set by `start_server` once the listener is bound, before any request.
    port: OnceLock<u16>,
}

impl<D: CommandDispatcher> ServerContext<D> {
    pub fn new(
        dispatcher: D,
        timeouts: Arc<TimeoutStore>,
        inflight: Arc<Semaphore>,
        generation: u64,
    ) -> Self {
        Self {
            dispatcher,
            timeouts,
            inflight,
            generation,
            port: OnceLock::new(),
        }
    }
}

/// Handle to a running server. Dropping it (or calling [`Self::shutdown`])
/// gracefully shuts the server down.
pub struct ServerHandle {
    pub port: u16,
    shutdown: oneshot::Sender<()>,
}

impl ServerHandle {
    pub fn shutdown(self) {
        let _ = self.shutdown.send(());
    }
}

/// Bind 127.0.0.1:0 and serve the v1 router until shut down.
pub async fn start_server<D: CommandDispatcher>(
    ctx: Arc<ServerContext<D>>,
) -> std::io::Result<ServerHandle> {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await?;
    let port = listener.local_addr()?.port();
    let _ = ctx.port.set(port);
    let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
    let router = build_router(ctx);
    tokio::spawn(async move {
        let serve = axum::serve(listener, router).with_graceful_shutdown(async move {
            let _ = shutdown_rx.await;
        });
        if let Err(err) = serve.await {
            log::error!("[berdctl] server error: {err}");
        }
    });
    Ok(ServerHandle {
        port,
        shutdown: shutdown_tx,
    })
}

pub fn build_router<D: CommandDispatcher>(ctx: Arc<ServerContext<D>>) -> Router {
    Router::new()
        .route("/v1/ping", get(handle_ping::<D>))
        .route("/v1/call", post(handle_call::<D>))
        .with_state(ctx)
}

/// Reject requests that look like they came from a browser (any `Origin` or
/// `Sec-Fetch-*` header) or through DNS rebinding (`Host` other than our
/// loopback bind). Applied by every handler before anything else.
fn forbidden_header_response<D>(ctx: &ServerContext<D>, headers: &HeaderMap) -> Option<Response> {
    let violation = if headers.contains_key(ORIGIN) {
        Some("Origin header not allowed".to_string())
    } else if headers
        .keys()
        .any(|name| name.as_str().starts_with("sec-fetch-"))
    {
        Some("Sec-Fetch-* headers not allowed".to_string())
    } else {
        let expected = format!("127.0.0.1:{}", ctx.port.get().copied().unwrap_or(0));
        match headers.get(HOST).and_then(|value| value.to_str().ok()) {
            Some(host) if host == expected => None,
            _ => Some(format!("Host must be {expected}")),
        }
    };
    violation.map(|message| {
        log::warn!("[berdctl] rejected request: {message}");
        error_response(StatusCode::FORBIDDEN, "forbidden", &message)
    })
}

async fn handle_ping<D: CommandDispatcher>(
    State(ctx): State<Arc<ServerContext<D>>>,
    headers: HeaderMap,
) -> Response {
    if let Some(rejection) = forbidden_header_response(&ctx, &headers) {
        return rejection;
    }
    Json(json!({
        "generation": ctx.generation,
        "protocolVersion": PROTOCOL_VERSION,
    }))
    .into_response()
}

// Unknown body fields are ignored (serde's default), so additions to the wire
// format stay backward-compatible with older brokers.
#[derive(Deserialize)]
struct CallBody {
    command: String,
    #[serde(default = "empty_object")]
    args: Value,
    #[serde(default)]
    timeout_ms: Option<u64>,
}

fn empty_object() -> Value {
    json!({})
}

async fn handle_call<D: CommandDispatcher>(
    State(ctx): State<Arc<ServerContext<D>>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if let Some(rejection) = forbidden_header_response(&ctx, &headers) {
        return rejection;
    }

    let call = match serde_json::from_slice::<CallBody>(&body) {
        Ok(call) => call,
        Err(err) => {
            return error_response(
                StatusCode::BAD_REQUEST,
                "bad_request",
                &format!("invalid request body: {err}"),
            );
        }
    };
    if !call.args.is_object() {
        return error_response(
            StatusCode::BAD_REQUEST,
            "bad_request",
            "args must be an object",
        );
    }

    let command = call.command;
    let started = Instant::now();

    let Some(_permit) = ctx.inflight.clone().try_acquire_owned().ok() else {
        log_call(&command, "busy", started);
        return error_response(
            StatusCode::TOO_MANY_REQUESTS,
            "busy",
            "too many concurrent app commands; retry shortly",
        );
    };

    let action = call.args.get("action").and_then(Value::as_str);
    let timeout = ctx
        .timeouts
        .command_timeout(&command, action, call.timeout_ms);
    let request = BridgeRequest {
        id: uuid::Uuid::new_v4().to_string(),
        command: command.clone(),
        args: call.args,
        // The renderer derives its deadline from the same resolved timeout
        // the broker waits on, so a request override cannot skew them apart.
        timeout_ms: timeout.as_millis() as u64,
    };
    let outcome = ctx.dispatcher.dispatch(request, timeout).await;

    match outcome {
        Ok(result) if result.ok => {
            log_call(&command, "ok", started);
            Json(json!({ "ok": true, "result": result.data.unwrap_or(Value::Null) }))
                .into_response()
        }
        Ok(result) => {
            let (code, message) = result
                .error
                .map(|err| (err.code, err.message))
                .unwrap_or_else(|| ("error".to_string(), "Command failed".to_string()));
            log_call(&command, &code, started);
            // Command-level failures are a successful broker exchange: 200.
            error_response(StatusCode::OK, &code, &message)
        }
        Err(BridgeError::Timeout) => {
            log_call(&command, "timeout", started);
            error_response(
                StatusCode::GATEWAY_TIMEOUT,
                "app_timeout",
                "App did not respond (renderer busy or closed)",
            )
        }
        Err(err @ (BridgeError::Emit(_) | BridgeError::RendererDropped)) => {
            if let BridgeError::Emit(err) = &err {
                log::warn!("[berdctl] emit to main window failed: {err}");
            }
            log_call(&command, "renderer_unavailable", started);
            error_response(
                StatusCode::SERVICE_UNAVAILABLE,
                "app_unavailable",
                "App window unavailable",
            )
        }
    }
}

fn error_response(status: StatusCode, code: &str, message: &str) -> Response {
    (
        status,
        Json(json!({ "ok": false, "error": { "code": code, "message": message } })),
    )
        .into_response()
}

/// Caller-controlled text reaches logs only truncated and with control
/// characters replaced, so it cannot forge log lines or dump prompt text.
fn sanitize_for_log(text: &str, max_chars: usize) -> String {
    text.chars()
        .take(max_chars)
        .map(|c| if c.is_control() { '?' } else { c })
        .collect()
}

// Never log raw args (they may contain prompt text). `command` is
// caller-controlled free text, so it is sanitized.
fn log_call(command: &str, result_code: &str, started: Instant) {
    let command = sanitize_for_log(command, 32);
    let duration_ms = started.elapsed().as_millis();
    log::info!(
        "[berdctl] /v1/call command={command} result={result_code} duration_ms={duration_ms}"
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bridge::BridgeErrorBody;
    use tokio::sync::{mpsc, Notify};

    const TEST_GENERATION: u64 = 3;

    #[derive(Clone)]
    enum StubBehavior {
        Echo,
        CommandError {
            code: String,
            message: String,
        },
        BridgeTimeout,
        RendererDropped,
        Block {
            entered: mpsc::UnboundedSender<()>,
            release: Arc<Notify>,
        },
    }

    struct StubDispatcher(StubBehavior);

    impl CommandDispatcher for StubDispatcher {
        fn dispatch(
            &self,
            req: BridgeRequest,
            timeout: Duration,
        ) -> impl Future<Output = Result<BridgeResult, BridgeError>> + Send {
            let behavior = self.0.clone();
            async move {
                match behavior {
                    StubBehavior::Echo => Ok(BridgeResult {
                        id: req.id,
                        ok: true,
                        data: Some(json!({
                            "command": req.command,
                            "args": req.args,
                            "timeoutMs": timeout.as_millis() as u64,
                            "requestTimeoutMs": req.timeout_ms,
                        })),
                        error: None,
                    }),
                    StubBehavior::CommandError { code, message } => Ok(BridgeResult {
                        id: req.id,
                        ok: false,
                        data: None,
                        error: Some(BridgeErrorBody { code, message }),
                    }),
                    StubBehavior::BridgeTimeout => Err(BridgeError::Timeout),
                    StubBehavior::RendererDropped => Err(BridgeError::RendererDropped),
                    StubBehavior::Block { entered, release } => {
                        // Register the wakeup before signaling `entered` so the
                        // test can use `notify_waiters()` to release every
                        // parked call without a registration race.
                        let notified = release.notified();
                        tokio::pin!(notified);
                        notified.as_mut().enable();
                        let _ = entered.send(());
                        notified.await;
                        Ok(BridgeResult {
                            id: req.id,
                            ok: true,
                            data: Some(json!("released")),
                            error: None,
                        })
                    }
                }
            }
        }
    }

    struct TestServer {
        base: String,
        _handle: ServerHandle,
    }

    struct Limits {
        permits: usize,
    }

    impl Default for Limits {
        fn default() -> Self {
            Self {
                permits: IN_FLIGHT_LIMIT,
            }
        }
    }

    async fn spawn_server(behavior: StubBehavior, limits: Limits) -> TestServer {
        let timeouts = Arc::new(TimeoutStore::new());
        timeouts.set(HashMap::from([("sessions".to_string(), 60_000)]));
        let ctx = Arc::new(ServerContext::new(
            StubDispatcher(behavior),
            timeouts,
            Arc::new(Semaphore::new(limits.permits)),
            TEST_GENERATION,
        ));
        let handle = start_server(ctx).await.unwrap();
        TestServer {
            base: format!("http://127.0.0.1:{}", handle.port),
            _handle: handle,
        }
    }

    async fn post_call(base: &str, body: &Value) -> reqwest::Response {
        reqwest::Client::new()
            .post(format!("{base}/v1/call"))
            .json(body)
            .send()
            .await
            .unwrap()
    }

    fn call_body(command: &str, args: Value) -> Value {
        json!({ "command": command, "args": args })
    }

    #[tokio::test]
    async fn ping_echoes_generation_and_protocol_version() {
        let server = spawn_server(StubBehavior::Echo, Limits::default()).await;
        let response = reqwest::get(format!("{}/v1/ping", server.base))
            .await
            .unwrap();
        assert_eq!(response.status(), 200);
        let body: Value = response.json().await.unwrap();
        assert_eq!(body["generation"], TEST_GENERATION);
        assert_eq!(body["protocolVersion"], PROTOCOL_VERSION);
    }

    #[tokio::test]
    async fn origin_header_is_rejected_on_all_routes() {
        let server = spawn_server(StubBehavior::Echo, Limits::default()).await;
        let client = reqwest::Client::new();

        let ping = client
            .get(format!("{}/v1/ping", server.base))
            .header("Origin", "https://evil.example")
            .send()
            .await
            .unwrap();
        assert_eq!(ping.status(), 403);
        let body: Value = ping.json().await.unwrap();
        assert_eq!(body["ok"], false);
        assert_eq!(body["error"]["code"], "forbidden");

        let call = client
            .post(format!("{}/v1/call", server.base))
            .header("Origin", "http://localhost:3000")
            .json(&call_body("sessions", json!({ "action": "list" })))
            .send()
            .await
            .unwrap();
        assert_eq!(call.status(), 403);
        let body: Value = call.json().await.unwrap();
        assert_eq!(body["error"]["code"], "forbidden");
    }

    #[tokio::test]
    async fn sec_fetch_headers_are_rejected() {
        let server = spawn_server(StubBehavior::Echo, Limits::default()).await;
        let client = reqwest::Client::new();
        for header in ["Sec-Fetch-Site", "Sec-Fetch-Mode", "Sec-Fetch-Dest"] {
            let response = client
                .post(format!("{}/v1/call", server.base))
                .header(header, "cross-site")
                .json(&call_body("sessions", json!({ "action": "list" })))
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), 403, "{header} must be rejected");
            let body: Value = response.json().await.unwrap();
            assert_eq!(body["error"]["code"], "forbidden");
        }
    }

    #[tokio::test]
    async fn host_mismatch_is_rejected() {
        let server = spawn_server(StubBehavior::Echo, Limits::default()).await;
        let client = reqwest::Client::new();
        // `localhost` resolves to the loopback bind but is not the literal
        // Host the broker expects — DNS-rebinding-shaped names are rejected.
        for host in ["evil.example:1234", "localhost:80"] {
            let response = client
                .get(format!("{}/v1/ping", server.base))
                .header("Host", host)
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), 403, "Host {host} must be rejected");
            let body: Value = response.json().await.unwrap();
            assert_eq!(body["error"]["code"], "forbidden");
        }
    }

    #[tokio::test]
    async fn call_round_trips_through_dispatcher() {
        let server = spawn_server(StubBehavior::Echo, Limits::default()).await;
        let response = post_call(
            &server.base,
            &call_body("sessions", json!({ "action": "list", "limit": 5 })),
        )
        .await;
        assert_eq!(response.status(), 200);
        let body: Value = response.json().await.unwrap();
        assert_eq!(body["ok"], true);
        assert_eq!(body["result"]["command"], "sessions");
        assert_eq!(body["result"]["args"]["action"], "list");
        assert_eq!(body["result"]["args"]["limit"], 5);
    }

    #[tokio::test]
    async fn call_maps_command_error_to_ok_false() {
        let server = spawn_server(
            StubBehavior::CommandError {
                code: "target_session_running".to_string(),
                message: "Cannot archive this session".to_string(),
            },
            Limits::default(),
        )
        .await;
        let response = post_call(
            &server.base,
            &call_body("sessions", json!({ "action": "archive", "sessionId": "x" })),
        )
        .await;
        assert_eq!(response.status(), 200);
        let body: Value = response.json().await.unwrap();
        assert_eq!(body["ok"], false);
        assert_eq!(body["error"]["code"], "target_session_running");
        assert_eq!(body["error"]["message"], "Cannot archive this session");
    }

    #[tokio::test]
    async fn call_maps_bridge_timeout_to_504() {
        let server = spawn_server(StubBehavior::BridgeTimeout, Limits::default()).await;
        let response = post_call(
            &server.base,
            &call_body("sessions", json!({ "action": "list" })),
        )
        .await;
        assert_eq!(response.status(), 504);
        let body: Value = response.json().await.unwrap();
        assert_eq!(body["ok"], false);
        assert_eq!(body["error"]["code"], "app_timeout");
        assert_eq!(
            body["error"]["message"],
            "App did not respond (renderer busy or closed)"
        );
    }

    #[tokio::test]
    async fn call_maps_renderer_dropped_to_503() {
        let server = spawn_server(StubBehavior::RendererDropped, Limits::default()).await;
        let response = post_call(
            &server.base,
            &call_body("sessions", json!({ "action": "list" })),
        )
        .await;
        assert_eq!(response.status(), 503);
        let body: Value = response.json().await.unwrap();
        assert_eq!(body["error"]["code"], "app_unavailable");
    }

    #[tokio::test]
    async fn malformed_bodies_are_400_bad_request() {
        let server = spawn_server(StubBehavior::Echo, Limits::default()).await;
        let client = reqwest::Client::new();

        // Not JSON at all.
        let response = client
            .post(format!("{}/v1/call", server.base))
            .header("Content-Type", "application/json")
            .body("{not json")
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 400);
        let body: Value = response.json().await.unwrap();
        assert_eq!(body["error"]["code"], "bad_request");

        // Missing `command`.
        let response = post_call(&server.base, &json!({ "args": { "action": "list" } })).await;
        assert_eq!(response.status(), 400);
        let body: Value = response.json().await.unwrap();
        assert_eq!(body["error"]["code"], "bad_request");

        // Non-object `args`.
        let response = post_call(
            &server.base,
            &json!({ "command": "sessions", "args": [1, 2] }),
        )
        .await;
        assert_eq!(response.status(), 400);
        let body: Value = response.json().await.unwrap();
        assert_eq!(body["error"]["code"], "bad_request");
        assert_eq!(body["error"]["message"], "args must be an object");
    }

    #[tokio::test]
    async fn in_flight_cap_is_global() {
        let (entered_tx, mut entered_rx) = mpsc::unbounded_channel();
        let release = Arc::new(Notify::new());
        let server = spawn_server(
            StubBehavior::Block {
                entered: entered_tx,
                release: release.clone(),
            },
            Limits::default(),
        )
        .await;

        // Park IN_FLIGHT_LIMIT calls, filling the global cap.
        let mut parked = Vec::new();
        for _ in 0..IN_FLIGHT_LIMIT {
            let base = server.base.clone();
            parked.push(tokio::spawn(async move {
                post_call(&base, &call_body("sessions", json!({ "action": "list" })))
                    .await
                    .json::<Value>()
                    .await
                    .unwrap()
            }));
        }
        for _ in 0..IN_FLIGHT_LIMIT {
            entered_rx.recv().await.unwrap();
        }

        // One more call is over the cap and is refused immediately.
        let over = post_call(
            &server.base,
            &call_body("sessions", json!({ "action": "list" })),
        )
        .await;
        assert_eq!(over.status(), 429);
        let over_body: Value = over.json().await.unwrap();
        assert_eq!(over_body["error"]["code"], "busy");

        // Release all parked calls; they all succeed.
        release.notify_waiters();
        for handle in parked {
            let body = handle.await.unwrap();
            assert_eq!(body["ok"], true);
        }
    }

    #[tokio::test]
    async fn call_resolves_timeouts_from_store_override_and_default() {
        let server = spawn_server(StubBehavior::Echo, Limits::default()).await;

        // The resolved timeout must reach the renderer in the BridgeRequest
        // (`requestTimeoutMs`) and be the same value the dispatch waits on
        // (`timeoutMs`), so the two sides' deadlines never skew apart.
        async fn assert_resolved_timeout(server: &TestServer, body: &Value, expected_ms: u64) {
            let response = post_call(&server.base, body).await;
            let body: Value = response.json().await.unwrap();
            assert_eq!(body["result"]["timeoutMs"], expected_ms);
            assert_eq!(body["result"]["requestTimeoutMs"], expected_ms);
        }

        // Store entry (set in spawn_server): sessions → 60s.
        assert_resolved_timeout(
            &server,
            &call_body("sessions", json!({ "action": "list" })),
            60_000,
        )
        .await;

        // No store entry: default 30s.
        assert_resolved_timeout(
            &server,
            &call_body("projects", json!({ "action": "list" })),
            30_000,
        )
        .await;

        // Request override wins over the store and is clamped to 1s..900s.
        assert_resolved_timeout(
            &server,
            &json!({ "command": "sessions", "args": { "action": "list" }, "timeout_ms": 500 }),
            1_000,
        )
        .await;
        assert_resolved_timeout(
            &server,
            &json!({ "command": "sessions", "args": { "action": "list" }, "timeout_ms": 999_000 }),
            900_000,
        )
        .await;
    }

    #[test]
    fn command_timeout_prefers_override_and_clamps() {
        // Request override wins over the configured value.
        assert_eq!(
            command_timeout(Some(45_000), Some(Duration::from_secs(60))),
            Duration::from_millis(45_000)
        );
        // Override clamped at both ends.
        assert_eq!(command_timeout(Some(10), None), MIN_REQUEST_TIMEOUT);
        assert_eq!(command_timeout(Some(999_000), None), MAX_COMMAND_TIMEOUT);
        // Configured value clamped to the ceiling.
        assert_eq!(
            command_timeout(None, Some(Duration::from_secs(999))),
            MAX_COMMAND_TIMEOUT
        );
        // Neither: default.
        assert_eq!(command_timeout(None, None), DEFAULT_COMMAND_TIMEOUT);
    }

    #[test]
    fn timeout_store_clamps_and_replaces() {
        let store = TimeoutStore::new();
        store.set(HashMap::from([
            ("sessions".to_string(), 60_000),
            ("sessions.create".to_string(), 900_000),
            ("projects".to_string(), 999_000),
        ]));
        assert_eq!(
            store.command_timeout("sessions", Some("create"), None),
            Duration::from_millis(900_000)
        );
        assert_eq!(
            store.command_timeout("sessions", Some("list"), None),
            Duration::from_millis(60_000)
        );
        assert_eq!(store.timeout_for("projects"), Some(MAX_COMMAND_TIMEOUT));
        assert_eq!(store.timeout_for("missing"), None);

        // A new push fully replaces the previous map.
        store.set(HashMap::from([("projects".to_string(), 5_000)]));
        assert_eq!(store.timeout_for("sessions"), None);
        assert_eq!(
            store.timeout_for("projects"),
            Some(Duration::from_millis(5_000))
        );
    }

    #[test]
    fn sanitize_for_log_truncates_and_replaces_control_chars() {
        assert_eq!(sanitize_for_log("sessions", 32), "sessions");
        // Newlines (log-line forgery) and other control chars become '?'.
        assert_eq!(
            sanitize_for_log("bad\ncommand\r\t\u{7f}", 32),
            "bad?command???"
        );
        assert_eq!(sanitize_for_log(&"x".repeat(64), 32), "x".repeat(32));
    }

    /// The non-test portion of a plugin source file: everything before its
    /// `mod tests` module, which must be unique and must run to end-of-file
    /// so no scannable code can hide after it. The brace walk is naive about
    /// braces inside test string literals, but that confusion fails CLOSED
    /// (the gate then scans test code too and trips loudly).
    fn non_test_source<'a>(name: &str, source: &'a str) -> &'a str {
        const MARKER: &str = "#[cfg(test)]\nmod tests {";
        match source.matches(MARKER).count() {
            0 => source,
            1 => {
                let head = source.split(MARKER).next().unwrap();
                let tail = &source[head.len() + MARKER.len()..];
                let mut depth: i64 = 1;
                let mut after = "";
                for (i, c) in tail.char_indices() {
                    match c {
                        '{' => depth += 1,
                        '}' => {
                            depth -= 1;
                            if depth == 0 {
                                after = &tail[i + 1..];
                                break;
                            }
                        }
                        _ => {}
                    }
                }
                assert!(
                    after.trim().is_empty(),
                    "{name}: code after the tests module would escape the command-literal \
                     gate; move it above `mod tests`"
                );
                head
            }
            n => panic!("{name}: expected at most one `mod tests` marker, found {n}"),
        }
    }

    /// Invariant #1 of the berdctl architecture
    /// (docs/berdctl-architecture.md): no command-specific knowledge below
    /// the renderer registry. Fails when the non-test source of any plugin
    /// file contains a quoted command/action literal from the contract. A
    /// tripwire, not a sandbox: constructed literals (concat!, format!) evade
    /// it.
    #[test]
    fn broker_source_stays_free_of_command_literals() {
        let sources: &[(&str, &str)] = &[
            ("server.rs", include_str!("server.rs")),
            ("bridge.rs", include_str!("bridge.rs")),
            ("discovery.rs", include_str!("discovery.rs")),
            ("lib.rs", include_str!("lib.rs")),
        ];

        let api: Value =
            serde_json::from_str(include_str!("../../../crates/berdctl/api-surface.json"))
                .expect("api-surface.json parses");
        let groups = api["groups"].as_object().expect("groups object");

        const ALLOWED: &[&str] = &[];

        let mut names: Vec<String> = Vec::new();
        for (group, spec) in groups {
            names.push(group.clone());
            names.extend(
                spec["actions"]
                    .as_object()
                    .expect("actions object")
                    .keys()
                    .cloned(),
            );
        }
        for (file, source) in sources {
            let non_test = non_test_source(file, source);
            for name in &names {
                if ALLOWED.contains(&name.as_str()) {
                    continue;
                }
                let literal = format!("\"{name}\"");
                assert!(
                    !non_test.contains(&literal),
                    "broker {file} contains the command literal {literal}: the broker is \
                     transport-only (invariant #1, docs/berdctl-architecture.md); command \
                     semantics belong in the renderer command registry"
                );
            }
        }
    }
}
