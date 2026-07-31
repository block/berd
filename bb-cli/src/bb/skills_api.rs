//! BuilderBot marketplace HTTP client and error handling for `bb skills`.

use anyhow::{Context, Result};
use reqwest::blocking::Client;
use reqwest::header::{HeaderMap, HeaderValue, ACCEPT, CONTENT_TYPE};
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::agents_models::{
    AgentCatalogPage, AgentDetail, AgentInstallPlan, AgentInstallPlanRequest,
    AgentInstallResolution, AgentOperationError, AgentVersion, InstalledAgentRequest,
    AGENT_OPERATION_KIND,
};
use super::auth::SESSION_CREDENTIAL_HEADER;
use super::auth_storage::stored_session_credential_header_value;
use super::display::Style;
use super::skills_config::{kgoose_service_url, SkillsConfig};
use super::skills_models::{BundlePage, BundleSummary, SkillPage, SkillSummary};

/// Documented `bb skills` exit codes (see `bb skills --help`).
pub mod exit_codes {
    pub const GENERAL: i32 = 1;
    pub const AUTH_REQUIRED: i32 = 3;
    pub const FORBIDDEN: i32 = 4;
    pub const NETWORK: i32 = 5;
    pub const PLAN_BLOCKED: i32 = 6;
    pub const FS_CONFLICT: i32 = 7;
    pub const VERIFICATION: i32 = 8;
    pub const CANCELED: i32 = 9;
}

/// A failure that carries a process exit code and a structured payload for
/// `--json` error output. `bb_main` walks the error chain looking for this.
#[derive(Debug)]
pub struct CliFailure {
    pub exit_code: i32,
    pub code: String,
    pub message: String,
    pub details: Option<Value>,
}

impl CliFailure {
    pub fn new(exit_code: i32, code: &str, message: impl Into<String>) -> Self {
        Self {
            exit_code,
            code: code.to_string(),
            message: message.into(),
            details: None,
        }
    }

    pub fn to_json(&self) -> Value {
        json!({
            "error": {
                "code": self.code,
                "message": self.message,
                "exit_code": self.exit_code,
                "details": self.details,
            }
        })
    }
}

impl std::fmt::Display for CliFailure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}", self.message)
    }
}

impl std::error::Error for CliFailure {}

/// Builds an `anyhow::Error` carrying an exit code and stable error code.
pub fn failure(exit_code: i32, code: &str, message: impl Into<String>) -> anyhow::Error {
    anyhow::Error::new(CliFailure::new(exit_code, code, message))
}

/// Marker error: the failure was already reported as structured JSON on
/// stderr; `bb_main` should exit with this code without printing again.
#[derive(Debug)]
pub struct SilentJsonExit(pub i32);

impl std::fmt::Display for SilentJsonExit {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "exit {}", self.0)
    }
}

impl std::error::Error for SilentJsonExit {}

/// Finds the exit code and JSON payload for an error chain, defaulting to 1.
pub fn failure_info(error: &anyhow::Error) -> (i32, Value) {
    for cause in error.chain() {
        if let Some(cli) = cause.downcast_ref::<CliFailure>() {
            let mut payload = cli.to_json();
            // The outermost anyhow message may carry extra context; prefer it.
            let full = format!("{error:#}");
            payload["error"]["message"] = json!(full);
            return (cli.exit_code, payload);
        }
    }
    (
        exit_codes::GENERAL,
        json!({
            "error": {
                "code": "cli_error",
                "message": format!("{error:#}"),
                "exit_code": exit_codes::GENERAL,
            }
        }),
    )
}

#[derive(Debug)]
pub struct MarketplaceClient {
    base_url: String,
    client: Client,
    has_auth: bool,
    style: Style,
}

impl MarketplaceClient {
    pub fn new(config: &SkillsConfig) -> Result<Self> {
        let mut headers = HeaderMap::new();
        headers.insert(ACCEPT, HeaderValue::from_static("application/json"));
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        let session_credential = stored_session_credential_header_value(
            &config.profile,
            &kgoose_service_url(&config.kgoose_base_url, &config.kgoose_service_path),
            config.bb_home.clone(),
        )?;
        if let Some(session_credential) = session_credential.as_deref() {
            headers.insert(
                SESSION_CREDENTIAL_HEADER,
                HeaderValue::from_str(session_credential)
                    .context("build marketplace session credential header")?,
            );
        }
        if let Some(playpen) = &config.playpen {
            headers.insert(
                "Baggage",
                HeaderValue::from_str(&format!("kgoose-builderbot-playpen={playpen}"))
                    .context("build marketplace Baggage header")?,
            );
        }
        Ok(Self {
            base_url: kgoose_service_url(&config.kgoose_base_url, &config.kgoose_service_path),
            client: Client::builder()
                .default_headers(headers)
                .build()
                .context("build marketplace HTTP client")?,
            has_auth: session_credential.is_some(),
            style: config.style,
        })
    }

    pub fn has_auth(&self) -> bool {
        self.has_auth
    }

    pub fn get_json<T>(&self, path: &str) -> Result<T>
    where
        T: for<'de> Deserialize<'de>,
    {
        self.style.verbose(&format!("GET {path}"));
        let response = self
            .client
            .get(self.url(path))
            .send()
            .map_err(|err| network_failure("GET", path, err))?;
        let status = response.status();
        let body = response
            .text()
            .with_context(|| format!("read GET {path} response"))?;
        self.style
            .verbose(&format!("GET {path} -> {status} ({} bytes)", body.len()));
        self.ensure_success("GET", path, status, body.as_bytes())?;
        serde_json::from_str(&body).with_context(|| format!("deserialize GET {path} response"))
    }

    pub fn post_json<T, B>(&self, path: &str, body: &B) -> Result<T>
    where
        T: for<'de> Deserialize<'de>,
        B: Serialize + ?Sized,
    {
        self.style.verbose(&format!("POST {path}"));
        let response = self
            .client
            .post(self.url(path))
            .json(body)
            .send()
            .map_err(|err| network_failure("POST", path, err))?;
        let status = response.status();
        let body = response
            .text()
            .with_context(|| format!("read POST {path} response"))?;
        self.style
            .verbose(&format!("POST {path} -> {status} ({} bytes)", body.len()));
        self.ensure_success("POST", path, status, body.as_bytes())?;
        serde_json::from_str(&body).with_context(|| format!("deserialize POST {path} response"))
    }

    /// Fetch raw bytes from a marketplace path; used for file previews.
    pub fn get_bytes(&self, path: &str) -> Result<Vec<u8>> {
        self.style.verbose(&format!("GET {path}"));
        let response = self
            .client
            .get(self.url(path))
            .send()
            .map_err(|err| network_failure("GET", path, err))?;
        let status = response.status();
        let bytes = response
            .bytes()
            .with_context(|| format!("read GET {path} response"))?;
        self.ensure_success("GET", path, status, &bytes)?;
        Ok(bytes.to_vec())
    }

    pub fn download(&self, path_or_url: &str) -> Result<DownloadedArtifact> {
        let url = if path_or_url.starts_with("http://") || path_or_url.starts_with("https://") {
            path_or_url.to_string()
        } else {
            self.url(path_or_url)
        };
        self.style.verbose(&format!("GET {path_or_url} (artifact)"));
        let response = self
            .client
            .get(&url)
            .send()
            .map_err(|err| network_failure("GET", path_or_url, err))?;
        let status = response.status();
        let headers = response.headers().clone();
        let bytes = response
            .bytes()
            .with_context(|| format!("read GET {path_or_url} response"))?;
        self.style.verbose(&format!(
            "GET {path_or_url} -> {status} ({} bytes)",
            bytes.len()
        ));
        self.ensure_success("GET", path_or_url, status, &bytes)?;
        Ok(DownloadedArtifact {
            bytes: bytes.to_vec(),
            header_sha256: headers
                .get("X-Artifact-SHA256")
                .and_then(|value| value.to_str().ok())
                .map(ToOwned::to_owned),
            header_size: headers
                .get("X-Artifact-Size")
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.parse::<u64>().ok()),
        })
    }

    /// Lists skills, following pagination so large catalogs are not silently
    /// truncated. `extra_query` entries are appended to every page request.
    pub fn list_skills_all(&self, extra_query: &[(&str, &str)]) -> Result<Vec<SkillSummary>> {
        let mut items = Vec::new();
        let mut cursor: Option<String> = None;
        loop {
            let mut path = format!("/v1/marketplace/skills?limit={LIST_PAGE_LIMIT}");
            for (key, value) in extra_query {
                path.push_str(&format!("&{key}={}", url_encode(value)));
            }
            if let Some(cursor_value) = &cursor {
                path.push_str(&format!("&cursor={}", url_encode(cursor_value)));
            }
            let page = self.get_json::<SkillPage>(&path)?;
            items.extend(page.items);
            match page.next_cursor.filter(|value| !value.is_empty()) {
                Some(next) => cursor = Some(next),
                None => break,
            }
        }
        Ok(items)
    }

    pub fn list_bundles_all(&self, query: Option<&str>) -> Result<Vec<BundleSummary>> {
        let mut items = Vec::new();
        let mut cursor: Option<String> = None;
        loop {
            let mut path = format!("/v1/marketplace/bundles?limit={LIST_PAGE_LIMIT}");
            if let Some(query) = query {
                path.push_str(&format!("&query={}", url_encode(query)));
            }
            if let Some(cursor_value) = &cursor {
                path.push_str(&format!("&cursor={}", url_encode(cursor_value)));
            }
            let page = self.get_json::<BundlePage>(&path)?;
            items.extend(page.items);
            match page.next_cursor.filter(|value| !value.is_empty()) {
                Some(next) => cursor = Some(next),
                None => break,
            }
        }
        Ok(items)
    }

    pub fn agents(&self) -> AgentMarketplace<'_> {
        AgentMarketplace { client: self }
    }

    fn url(&self, path: &str) -> String {
        if path.starts_with('/') {
            format!("{}{}", self.base_url, path)
        } else {
            format!("{}/{}", self.base_url, path)
        }
    }

    fn ensure_success(
        &self,
        method: &str,
        path: &str,
        status: StatusCode,
        body: &[u8],
    ) -> Result<()> {
        if status.is_success() {
            return Ok(());
        }
        let mut message = format_http_error(method, path, status, body);
        let exit_code = match status.as_u16() {
            401 => {
                message.push_str(if self.has_auth {
                    "\nhint: the marketplace rejected your credentials; run `bb auth login` to refresh your session"
                } else {
                    "\nhint: no credentials are configured; run `bb auth login` first"
                });
                exit_codes::AUTH_REQUIRED
            }
            403 => {
                message.push_str(
                    "\nhint: your credentials lack the required scope; run `bb auth login` with an authorized account",
                );
                exit_codes::FORBIDDEN
            }
            422 => exit_codes::PLAN_BLOCKED,
            status if status >= 500 => exit_codes::NETWORK,
            _ => exit_codes::GENERAL,
        };
        let code = parse_error_envelope(body)
            .map(|envelope| envelope.error.code)
            .unwrap_or_else(|| format!("http_{}", status.as_u16()));
        Err(anyhow::Error::new(CliFailure {
            exit_code,
            code,
            message,
            details: serde_json::from_slice::<Value>(body)
                .ok()
                .and_then(|value| value.get("error").cloned()),
        }))
    }
}

pub struct AgentMarketplace<'a> {
    client: &'a MarketplaceClient,
}

impl AgentMarketplace<'_> {
    pub fn list_all(&self, query: Option<&str>) -> Result<Vec<super::agents_models::AgentSummary>> {
        let mut items = Vec::new();
        let mut cursor: Option<String> = None;
        loop {
            let mut path = format!("/v1/marketplace/agents?limit={LIST_PAGE_LIMIT}");
            if let Some(query) = query {
                path.push_str(&format!("&query={}", url_encode(query)));
            }
            if let Some(cursor_value) = &cursor {
                path.push_str(&format!("&cursor={}", url_encode(cursor_value)));
            }
            let page = self.client.get_json::<AgentCatalogPage>(&path)?;
            items.extend(page.items);
            match page.next_cursor.filter(|value| !value.is_empty()) {
                Some(next) => cursor = Some(next),
                None => break,
            }
        }
        Ok(items)
    }

    pub fn show(&self, slug: &str) -> Result<AgentDetail> {
        self.client
            .get_json::<AgentDetail>(&format!("/v1/marketplace/agents/{}", url_encode(slug)))
    }

    pub fn version(&self, slug: &str, version_id: &str) -> Result<AgentVersion> {
        self.client.get_json::<AgentVersion>(&format!(
            "/v1/marketplace/agents/{}/versions/{}",
            url_encode(slug),
            url_encode(version_id)
        ))
    }

    pub fn resolve_install(
        &self,
        slug: &str,
        version_id: Option<String>,
        installed: Vec<InstalledAgentRequest>,
    ) -> Result<AgentInstallResolution> {
        let agent = self.show(slug)?;
        let requested_version_id = version_id.clone();
        let plan = self.client.post_json::<AgentInstallPlan, _>(
            "/v1/marketplace/install-plan",
            &AgentInstallPlanRequest::for_agent(slug, version_id, installed),
        )?;
        let operation = plan
            .operations
            .into_iter()
            .find(|operation| operation.skill.slug == slug)
            .ok_or_else(|| {
                invalid_agent_operation(AgentOperationError::Missing {
                    slug: slug.to_string(),
                })
            })?;
        if operation.kind != AGENT_OPERATION_KIND {
            return Err(invalid_agent_operation(AgentOperationError::WrongKind {
                slug: slug.to_string(),
                actual: operation.kind,
            }));
        }
        if let Some(requested_version_id) = requested_version_id {
            if operation.skill.version_id != requested_version_id {
                return Err(failure(
                    exit_codes::PLAN_BLOCKED,
                    "version_pin_unresolved",
                    format!(
                        "requested version `{requested_version_id}` but the server resolved `{}`; the marketplace currently serves only the latest stable version",
                        operation.skill.version_id
                    ),
                ));
            }
        }
        let version = self.version(slug, &operation.skill.version_id)?;
        Ok(AgentInstallResolution {
            action: operation.action,
            reason: operation.reason,
            agent,
            version,
            plan: operation.skill,
            artifact: operation.artifact,
            installed_via: operation.installed_via,
        })
    }
}

fn invalid_agent_operation(error: AgentOperationError) -> anyhow::Error {
    failure(
        exit_codes::VERIFICATION,
        "invalid_agent_operation_kind",
        error.to_string(),
    )
}

pub const LIST_PAGE_LIMIT: u32 = 5000;

fn network_failure(method: &str, path: &str, err: reqwest::Error) -> anyhow::Error {
    anyhow::Error::new(CliFailure::new(
        exit_codes::NETWORK,
        "server_unreachable",
        format!("{method} {path} failed: {err}"),
    ))
}

fn url_encode(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                encoded.push(byte as char)
            }
            other => encoded.push_str(&format!("%{other:02X}")),
        }
    }
    encoded
}

#[derive(Debug)]
pub struct DownloadedArtifact {
    pub bytes: Vec<u8>,
    pub header_sha256: Option<String>,
    pub header_size: Option<u64>,
}

pub fn format_http_error(method: &str, path: &str, status: StatusCode, body: &[u8]) -> String {
    if let Some(envelope) = parse_error_envelope(body) {
        return envelope.display_message(method, path, status);
    }

    let body = String::from_utf8_lossy(body);
    let body = truncate(body.trim(), 800);
    if body.is_empty() {
        format!("{method} {path} failed with {status}")
    } else {
        format!("{method} {path} failed with {status}: {body}")
    }
}

fn parse_error_envelope(body: &[u8]) -> Option<MarketplaceErrorEnvelope> {
    serde_json::from_slice::<MarketplaceErrorEnvelope>(body)
        .ok()
        .filter(|envelope| !envelope.error.code.trim().is_empty())
}

#[derive(Debug, Deserialize)]
struct MarketplaceErrorEnvelope {
    error: MarketplaceApiError,
}

#[derive(Debug, Deserialize)]
struct MarketplaceApiError {
    code: String,
    message: String,
    request_id: Option<String>,
    retryable: Option<bool>,
    details: Option<Value>,
}

impl MarketplaceErrorEnvelope {
    fn display_message(&self, method: &str, path: &str, status: StatusCode) -> String {
        let error = &self.error;
        let mut lines = vec![format!(
            "{method} {path} failed with {status}: {} ({})",
            error.message, error.code
        )];
        if let Some(request_id) = error
            .request_id
            .as_deref()
            .filter(|value| !value.is_empty())
        {
            lines.push(format!("request_id: {request_id}"));
        }
        if let Some(retryable) = error.retryable {
            lines.push(format!("retryable: {retryable}"));
        }
        if let Some(details) = error.details.as_ref() {
            let detail = summarize_error_details(details);
            if !detail.is_empty() {
                lines.push(format!("details: {detail}"));
            }
        }
        lines.join("\n")
    }
}

fn summarize_error_details(details: &Value) -> String {
    match details {
        Value::Array(items) => {
            let rendered = items
                .iter()
                .take(3)
                .map(summarize_error_detail)
                .filter(|item| !item.is_empty())
                .collect::<Vec<_>>();
            let mut summary = rendered.join("; ");
            if items.len() > rendered.len() {
                if !summary.is_empty() {
                    summary.push_str("; ");
                }
                summary.push_str(&format!("{} more", items.len() - rendered.len()));
            }
            summary
        }
        other => truncate(&other.to_string(), 500),
    }
}

fn summarize_error_detail(detail: &Value) -> String {
    let Value::Object(fields) = detail else {
        return truncate(&detail.to_string(), 240);
    };

    let message = fields
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let field = fields.get("field").and_then(Value::as_str);
    let path = fields.get("path").and_then(Value::as_str);
    let mut location = Vec::new();
    if let Some(path) = path.filter(|value| !value.is_empty()) {
        location.push(path);
    }
    if let Some(field) = field.filter(|value| !value.is_empty()) {
        location.push(field);
    }

    match (location.is_empty(), message.is_empty()) {
        (false, false) => format!("{}: {message}", location.join(".")),
        (false, true) => location.join("."),
        (true, false) => message.to_string(),
        (true, true) => truncate(&detail.to_string(), 240),
    }
}

pub fn truncate(value: &str, max_len: usize) -> String {
    let mut chars = value.chars();
    let truncated = chars.by_ref().take(max_len).collect::<String>();
    if chars.next().is_none() {
        value.to_string()
    } else {
        format!("{truncated}...")
    }
}

#[cfg(test)]
mod tests {
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::sync::{Arc, Mutex};
    use std::thread;

    use super::*;
    use serde_json::json;

    type RecordedRequest = (String, String, Value);

    struct TestServer {
        base_url: String,
        requests: Arc<Mutex<Vec<RecordedRequest>>>,
        handle: thread::JoinHandle<()>,
    }

    impl TestServer {
        fn start(responses: Vec<Value>) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").expect("bind test server");
            let base_url = format!("http://{}", listener.local_addr().expect("server address"));
            let requests = Arc::new(Mutex::new(Vec::new()));
            let thread_requests = Arc::clone(&requests);
            let handle = thread::spawn(move || {
                for response in responses {
                    let (stream, _) = listener.accept().expect("accept client request");
                    record_and_respond(stream, &thread_requests, response);
                }
            });
            Self {
                base_url,
                requests,
                handle,
            }
        }

        fn client(&self) -> MarketplaceClient {
            MarketplaceClient {
                base_url: self.base_url.clone(),
                client: Client::new(),
                has_auth: false,
                style: Style::new(true, true, false),
            }
        }

        fn finish(self) -> Vec<RecordedRequest> {
            self.handle.join().expect("join test server");
            self.requests.lock().expect("lock requests").clone()
        }
    }

    fn record_and_respond(
        stream: TcpStream,
        requests: &Arc<Mutex<Vec<RecordedRequest>>>,
        response: Value,
    ) {
        let mut reader = BufReader::new(stream.try_clone().expect("clone test stream"));
        let mut request_line = String::new();
        reader
            .read_line(&mut request_line)
            .expect("read request line");
        let mut parts = request_line.split_whitespace();
        let method = parts.next().expect("request method").to_string();
        let path = parts.next().expect("request path").to_string();
        let mut content_length = 0usize;
        loop {
            let mut line = String::new();
            reader.read_line(&mut line).expect("read request header");
            if line == "\r\n" {
                break;
            }
            if let Some((name, value)) = line.split_once(':') {
                if name.eq_ignore_ascii_case("content-length") {
                    content_length = value.trim().parse().expect("content length");
                }
            }
        }
        let mut body = vec![0; content_length];
        reader.read_exact(&mut body).expect("read request body");
        let body = if body.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&body).expect("parse request JSON")
        };
        requests
            .lock()
            .expect("lock requests")
            .push((method, path, body));

        let body = serde_json::to_vec(&response).expect("serialize test response");
        let mut stream = stream;
        write!(
            stream,
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        )
        .expect("write response headers");
        stream.write_all(&body).expect("write response body");
    }

    fn read_artifact() -> Value {
        json!({
            "id": "art_release_notes",
            "sha256": "artifact-sha",
            "size_bytes": 123,
            "media_type": "application/zip"
        })
    }

    fn install_plan_artifact() -> Value {
        let mut artifact = read_artifact();
        artifact
            .as_object_mut()
            .expect("read artifact object")
            .insert(
                "download_url".to_string(),
                json!("/v1/marketplace/artifacts/art_release_notes/download"),
            );
        artifact
    }

    fn version(slug: &str, version_id: &str) -> Value {
        json!({
            "id": version_id,
            "slug": slug,
            "name": "Release Notes",
            "status": "stable",
            "content_sha256": "content-sha",
            "persona_body": "Agent body.",
            "artifact": read_artifact(),
            "frontmatter": {"name": "Release Notes", "description": "Writes release notes."},
            "normalized": {},
            "files": [],
            "source": {
                "source_id": "src_builtin_agents",
                "snapshot_id": "snap_123",
                "revision": "main@abc123",
                "path": "agents/release-notes.md"
            },
            "created_at": "2026-07-29T00:00:00Z"
        })
    }

    fn agent_detail(slug: &str, version_id: &str) -> Value {
        json!({
            "slug": slug,
            "name": "Release Notes",
            "description": "Writes release notes.",
            "status": "stable",
            "visibility": "public",
            "enabled": true,
            "latest_version_id": version_id,
            "latest_content_sha256": "content-sha",
            "source_id": "src_builtin_agents",
            "source_revision": "main@abc123",
            "source_path": "agents/release-notes.md",
            "source_enabled": true,
            "tags": ["release"],
            "updated_at": "2026-07-29T00:00:00Z",
            "source_type": "builtin",
            "risk_level": "low",
            "latest_version": version(slug, version_id),
            "versions": [{
                "id": version_id,
                "status": "stable",
                "content_sha256": "content-sha",
                "created_at": "2026-07-29T00:00:00Z"
            }]
        })
    }

    fn agent_summary(slug: &str, version_id: &str) -> Value {
        let mut detail = agent_detail(slug, version_id);
        detail
            .as_object_mut()
            .expect("agent detail object")
            .remove("latest_version");
        detail
            .as_object_mut()
            .expect("agent detail object")
            .remove("versions");
        detail
    }

    #[test]
    fn marketplace_error_envelope_formats_stably() {
        let body = br#"{
          "error": {
            "code": "validation_failed",
            "message": "Source sync produced validation errors.",
            "request_id": "req_123",
            "retryable": false,
            "details": [
              {
                "path": "skills/foo/SKILL.md",
                "field": "description",
                "message": "description is required"
              }
            ]
          }
        }"#;

        assert_eq!(
            format_http_error(
                "POST",
                "/v1/marketplace/install-plan",
                StatusCode::UNPROCESSABLE_ENTITY,
                body,
            ),
            "POST /v1/marketplace/install-plan failed with 422 Unprocessable Entity: Source sync produced validation errors. (validation_failed)\nrequest_id: req_123\nretryable: false\ndetails: skills/foo/SKILL.md.description: description is required"
        );
    }

    #[test]
    fn non_envelope_http_errors_keep_body_context() {
        assert_eq!(
            format_http_error(
                "GET",
                "/v1/marketplace/skills",
                StatusCode::INTERNAL_SERVER_ERROR,
                b"plain failure",
            ),
            "GET /v1/marketplace/skills failed with 500 Internal Server Error: plain failure"
        );
    }

    #[test]
    fn invalid_agent_operation_uses_the_structured_verification_error() {
        let error = invalid_agent_operation(AgentOperationError::WrongKind {
            slug: "release-notes".to_string(),
            actual: "skill".to_string(),
        });
        let (exit_code, payload) = failure_info(&error);

        assert_eq!(exit_code, exit_codes::VERIFICATION);
        assert_eq!(payload["error"]["code"], "invalid_agent_operation_kind");
    }

    #[test]
    fn agent_marketplace_uses_authoritative_read_and_install_plan_contracts() {
        let server = TestServer::start(vec![
            json!({"items": [agent_summary("release-notes", "agent-v1")], "next_cursor": "next cursor"}),
            json!({"items": [agent_summary("security-review", "agent-v2")], "next_cursor": ""}),
            agent_detail("release-notes", "agent-v1"),
            json!({
                "plan_id": "plan_release_notes",
                "expires_at": "2026-07-29T01:00:00Z",
                "operations": [{
                    "action": "install",
                    "reason": "Install latest stable marketplace agent artifact.",
                    "kind": "agent",
                    "skill": {
                        "slug": "release-notes",
                        "version_id": "agent-v2",
                        "content_sha256": "content-sha-v2"
                    },
                    "artifact": install_plan_artifact(),
                    "installed_via": "explicit"
                }],
                "warnings": []
            }),
            version("release-notes", "agent-v2"),
        ]);
        let client = server.client();
        let marketplace = client.agents();

        let agents = marketplace
            .list_all(Some("release notes"))
            .expect("list agent catalog");
        let resolution = marketplace
            .resolve_install(
                "release-notes",
                Some("agent-v2".to_string()),
                vec![InstalledAgentRequest {
                    slug: "release-notes".to_string(),
                    version_id: Some("agent-v1".to_string()),
                    content_sha256: Some("content-sha".to_string()),
                    scope: Some("global".to_string()),
                    targets: Vec::new(),
                    installed_via: Some("explicit".to_string()),
                    local_source: false,
                }],
            )
            .expect("resolve agent install");

        assert_eq!(agents.len(), 2);
        assert_eq!(agents[0].source_path, "agents/release-notes.md");
        assert_eq!(resolution.plan.version_id, "agent-v2");
        assert_eq!(resolution.agent.source_revision, "main@abc123");
        assert_eq!(resolution.version.source.snapshot_id, "snap_123");
        assert_eq!(resolution.version.source.path, "agents/release-notes.md");
        assert_eq!(
            resolution.artifact.expect("install artifact").media_type,
            "application/zip"
        );

        let requests = server.finish();
        assert_eq!(requests[0].0, "GET");
        assert_eq!(
            requests[0].1,
            "/v1/marketplace/agents?limit=5000&query=release%20notes"
        );
        assert_eq!(
            requests[1].1,
            "/v1/marketplace/agents?limit=5000&query=release%20notes&cursor=next%20cursor"
        );
        assert_eq!(requests[2].1, "/v1/marketplace/agents/release-notes");
        assert_eq!(requests[3].0, "POST");
        assert_eq!(requests[3].1, "/v1/marketplace/install-plan");
        assert_eq!(
            requests[3].2,
            json!({
                "scope": "global",
                "targets": [{"type": "agent", "slug": "release-notes", "version_id": "agent-v2"}],
                "installed": [{
                    "slug": "release-notes",
                    "version_id": "agent-v1",
                    "content_sha256": "content-sha",
                    "scope": "global",
                    "targets": [],
                    "installed_via": "explicit",
                    "local_source": false
                }],
                "client": {},
                "include_dependencies": false,
                "allow_removals": false,
                "dry_run": false
            })
        );
        assert_eq!(
            requests[4].1,
            "/v1/marketplace/agents/release-notes/versions/agent-v2"
        );
    }

    #[test]
    fn agent_install_plan_rejects_missing_or_non_agent_operations() {
        for operations in [
            json!([]),
            json!([{
                "action": "install",
                "reason": "Wrong content type.",
                "kind": "skill",
                "skill": {"slug": "release-notes", "version_id": "agent-v1", "content_sha256": "content-sha"},
                "artifact": null,
                "installed_via": "explicit"
            }]),
        ] {
            let server = TestServer::start(vec![
                agent_detail("release-notes", "agent-v1"),
                json!({"operations": operations}),
            ]);
            let client = server.client();
            let error = client
                .agents()
                .resolve_install("release-notes", None, Vec::new())
                .expect_err("invalid agent operation must fail");
            let (exit_code, payload) = failure_info(&error);
            assert_eq!(exit_code, exit_codes::VERIFICATION);
            assert_eq!(payload["error"]["code"], "invalid_agent_operation_kind");
            server.finish();
        }
    }

    #[test]
    fn agent_install_plan_rejects_unresolved_version_pin() {
        let server = TestServer::start(vec![
            agent_detail("release-notes", "agent-v2"),
            json!({
                "operations": [{
                    "action": "install",
                    "reason": "Install latest stable marketplace agent artifact.",
                    "kind": "agent",
                    "skill": {
                        "slug": "release-notes",
                        "version_id": "agent-v2",
                        "content_sha256": "content-sha-v2"
                    },
                    "artifact": install_plan_artifact(),
                    "installed_via": "explicit"
                }]
            }),
        ]);

        let error = server
            .client()
            .agents()
            .resolve_install("release-notes", Some("agent-v1".to_string()), Vec::new())
            .expect_err("unresolved version pin must fail");
        let (exit_code, payload) = failure_info(&error);

        assert_eq!(exit_code, exit_codes::PLAN_BLOCKED);
        assert_eq!(payload["error"]["code"], "version_pin_unresolved");
        assert_eq!(
            payload["error"]["message"],
            "requested version `agent-v1` but the server resolved `agent-v2`; the marketplace currently serves only the latest stable version"
        );
        server.finish();
    }

    #[test]
    fn agent_install_plan_resolves_noop_without_an_artifact() {
        let server = TestServer::start(vec![
            agent_detail("release-notes", "agent-v1"),
            json!({
                "operations": [{
                    "action": "noop",
                    "reason": "Already at the requested version.",
                    "kind": "agent",
                    "skill": {
                        "slug": "release-notes",
                        "version_id": "agent-v1",
                        "content_sha256": "content-sha"
                    },
                    "artifact": null,
                    "installed_via": "explicit"
                }]
            }),
            version("release-notes", "agent-v1"),
        ]);

        let resolution = server
            .client()
            .agents()
            .resolve_install("release-notes", None, Vec::new())
            .expect("resolve agent noop");

        assert_eq!(resolution.action, "noop");
        assert_eq!(resolution.reason, "Already at the requested version.");
        assert_eq!(resolution.plan.version_id, "agent-v1");
        assert!(resolution.artifact.is_none());
        assert_eq!(resolution.installed_via, "explicit");
        server.finish();
    }

    #[test]
    fn failure_info_defaults_to_general_exit_code() {
        let error = anyhow::anyhow!("boom");
        let (exit_code, payload) = failure_info(&error);
        assert_eq!(exit_code, exit_codes::GENERAL);
        assert_eq!(payload["error"]["code"], "cli_error");
    }

    #[test]
    fn failure_info_extracts_cli_failure_exit_code() {
        let error = failure(
            exit_codes::VERIFICATION,
            "checksum_mismatch",
            "bad artifact",
        )
        .context("install builderbot-tools");
        let (exit_code, payload) = failure_info(&error);
        assert_eq!(exit_code, exit_codes::VERIFICATION);
        assert_eq!(payload["error"]["code"], "checksum_mismatch");
        let message = payload["error"]["message"].as_str().expect("message");
        assert!(message.contains("install builderbot-tools"));
        assert!(message.contains("bad artifact"));
    }

    #[test]
    fn url_encode_escapes_reserved_characters() {
        assert_eq!(url_encode("pull request"), "pull%20request");
        assert_eq!(url_encode("a/b&c"), "a%2Fb%26c");
    }
}
