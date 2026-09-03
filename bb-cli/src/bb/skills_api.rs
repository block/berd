//! BuilderBot marketplace HTTP client and error handling for `bb skills`.

use anyhow::{Context, Result};
use reqwest::blocking::Client;
use reqwest::header::{HeaderMap, HeaderValue, ACCEPT, CONTENT_TYPE};
use reqwest::redirect::Policy;
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use url::Url;

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
    base_url: Url,
    client: Client,
    authenticated_artifact_client: Client,
    artifact_client: Client,
    has_auth: bool,
    style: Style,
}

impl MarketplaceClient {
    pub fn new(config: &SkillsConfig) -> Result<Self> {
        let service_url = kgoose_service_url(&config.kgoose_base_url, &config.kgoose_service_path);
        let base_url = parse_http_url(&service_url, "marketplace service URL")?;
        let marketplace_origin = base_url.clone();
        let mut headers = HeaderMap::new();
        headers.insert(ACCEPT, HeaderValue::from_static("application/json"));
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        let session_credential = stored_session_credential_header_value(
            &config.profile,
            &service_url,
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
            base_url,
            client: Client::builder()
                .default_headers(headers.clone())
                .redirect(same_origin_redirect_policy(marketplace_origin))
                .build()
                .context("build marketplace HTTP client")?,
            authenticated_artifact_client: Client::builder()
                .default_headers(headers)
                .redirect(Policy::none())
                .build()
                .context("build authenticated artifact HTTP client")?,
            artifact_client: Client::builder()
                .redirect(Policy::none())
                .build()
                .context("build artifact HTTP client")?,
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
            .get(self.url(path)?)
            .send()
            .map_err(|err| network_failure("GET", path, err))?;
        let status = response.status();
        let body = response
            .text()
            .with_context(|| format!("read GET {path} response"))?;
        self.style
            .verbose(&format!("GET {path} -> {status} ({} bytes)", body.len()));
        self.ensure_success("GET", path, status, body.as_bytes(), true)?;
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
            .post(self.url(path)?)
            .json(body)
            .send()
            .map_err(|err| network_failure("POST", path, err))?;
        let status = response.status();
        let body = response
            .text()
            .with_context(|| format!("read POST {path} response"))?;
        self.style
            .verbose(&format!("POST {path} -> {status} ({} bytes)", body.len()));
        self.ensure_success("POST", path, status, body.as_bytes(), true)?;
        serde_json::from_str(&body).with_context(|| format!("deserialize POST {path} response"))
    }

    /// Fetch raw bytes from a marketplace path; used for file previews.
    pub fn get_bytes(&self, path: &str) -> Result<Vec<u8>> {
        self.style.verbose(&format!("GET {path}"));
        let response = self
            .client
            .get(self.url(path)?)
            .send()
            .map_err(|err| network_failure("GET", path, err))?;
        let status = response.status();
        let bytes = response
            .bytes()
            .with_context(|| format!("read GET {path} response"))?;
        self.ensure_success("GET", path, status, &bytes, true)?;
        Ok(bytes.to_vec())
    }

    pub fn download(&self, path_or_url: &str) -> Result<DownloadedArtifact> {
        let mut url = self.artifact_url(path_or_url)?;
        let mut authenticated = same_origin(&url, &self.base_url);
        self.style.verbose(&format!("GET {path_or_url} (artifact)"));

        for redirects in 0..=10 {
            let client = if authenticated {
                &self.authenticated_artifact_client
            } else {
                &self.artifact_client
            };
            let response = client
                .get(url.clone())
                .send()
                .map_err(|err| network_failure("GET", path_or_url, err))?;
            let status = response.status();
            if is_redirect(status) {
                if redirects == 10 {
                    return Err(failure(
                        exit_codes::NETWORK,
                        "too_many_redirects",
                        format!("GET {path_or_url} failed: too many redirects"),
                    ));
                }
                let location = response
                    .headers()
                    .get(reqwest::header::LOCATION)
                    .ok_or_else(|| {
                        failure(
                            exit_codes::NETWORK,
                            "invalid_redirect",
                            format!("GET {path_or_url} failed: redirect response omitted Location"),
                        )
                    })?;
                let location = location.to_str().map_err(|_| {
                    failure(
                        exit_codes::NETWORK,
                        "invalid_redirect",
                        format!("GET {path_or_url} failed: redirect Location is not valid text"),
                    )
                })?;
                url = url.join(location).with_context(|| {
                    format!("resolve artifact redirect `{location}` from `{url}`")
                })?;
                ensure_http_url(&url, "artifact redirect URL")?;
                // Once a chain leaves the marketplace origin it remains unauthenticated,
                // even if a later redirect points back to the marketplace.
                authenticated = authenticated && same_origin(&url, &self.base_url);
                continue;
            }

            let headers = response.headers().clone();
            let bytes = response
                .bytes()
                .with_context(|| format!("read GET {path_or_url} response"))?;
            self.style.verbose(&format!(
                "GET {path_or_url} -> {status} ({} bytes)",
                bytes.len()
            ));
            self.ensure_success("GET", path_or_url, status, &bytes, authenticated)?;
            return Ok(DownloadedArtifact {
                bytes: bytes.to_vec(),
                header_sha256: headers
                    .get("X-Artifact-SHA256")
                    .and_then(|value| value.to_str().ok())
                    .map(ToOwned::to_owned),
                header_size: headers
                    .get("X-Artifact-Size")
                    .and_then(|value| value.to_str().ok())
                    .and_then(|value| value.parse::<u64>().ok()),
            });
        }

        unreachable!("redirect loop returns within its fixed bound")
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

    fn url(&self, path: &str) -> Result<Url> {
        let separator = if path.starts_with('/') { "" } else { "/" };
        let value = format!(
            "{}{}{}",
            self.base_url.as_str().trim_end_matches('/'),
            separator,
            path
        );
        parse_http_url(&value, "marketplace URL")
            .with_context(|| format!("resolve marketplace path `{path}`"))
    }

    fn artifact_url(&self, path_or_url: &str) -> Result<Url> {
        let url = match Url::parse(path_or_url) {
            Ok(url) => url,
            Err(url::ParseError::RelativeUrlWithoutBase) => self.url(path_or_url)?,
            Err(error) => {
                return Err(error).with_context(|| format!("parse artifact URL `{path_or_url}`"))
            }
        };
        ensure_http_url(&url, "artifact URL")?;
        Ok(url)
    }

    fn ensure_success(
        &self,
        method: &str,
        path: &str,
        status: StatusCode,
        body: &[u8],
        marketplace_request: bool,
    ) -> Result<()> {
        if status.is_success() {
            return Ok(());
        }
        let mut message = format_http_error(method, path, status, body);
        let exit_code = match status.as_u16() {
            401 => {
                message.push_str(if !marketplace_request {
                    "\nhint: the artifact host rejected the request (401); no marketplace credential was sent, so `bb auth login` will not help"
                } else if self.has_auth {
                    "\nhint: the marketplace rejected your credentials; run `bb auth login` to refresh your session"
                } else {
                    "\nhint: no credentials are configured; run `bb auth login` first"
                });
                exit_codes::AUTH_REQUIRED
            }
            403 => {
                message.push_str(if marketplace_request {
                    "\nhint: your credentials lack the required scope; run `bb auth login` with an authorized account"
                } else {
                    "\nhint: the artifact host denied access (403); no marketplace credential was sent, so `bb auth login` will not help"
                });
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

fn parse_http_url(value: &str, label: &str) -> Result<Url> {
    let url = Url::parse(value).with_context(|| format!("parse {label} `{value}`"))?;
    ensure_http_url(&url, label)?;
    Ok(url)
}

fn ensure_http_url(url: &Url, label: &str) -> Result<()> {
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        anyhow::bail!("{label} must be an absolute HTTP(S) URL: `{url}`");
    }
    Ok(())
}

fn same_origin(left: &Url, right: &Url) -> bool {
    left.scheme() == right.scheme()
        && left.host_str() == right.host_str()
        && left.port_or_known_default() == right.port_or_known_default()
}

fn is_redirect(status: StatusCode) -> bool {
    matches!(
        status,
        StatusCode::MOVED_PERMANENTLY
            | StatusCode::FOUND
            | StatusCode::SEE_OTHER
            | StatusCode::TEMPORARY_REDIRECT
            | StatusCode::PERMANENT_REDIRECT
    )
}

fn same_origin_redirect_policy(origin: Url) -> Policy {
    Policy::custom(move |attempt| {
        if attempt.previous().len() > 10 {
            attempt.error("too many redirects")
        } else if same_origin(attempt.url(), &origin) {
            attempt.follow()
        } else {
            attempt.error("refusing authenticated cross-origin redirect")
        }
    })
}

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

    use super::*;
    use crate::test_server::{prepare_stream, ServerThread};
    use serde_json::json;

    type RecordedRequest = (String, String, Value);

    #[derive(Clone, Debug)]
    struct ArtifactRequest {
        path: String,
        headers: HeaderMap,
    }

    struct ArtifactServer {
        base_url: String,
        requests: Arc<Mutex<Vec<ArtifactRequest>>>,
        _thread: ServerThread,
    }

    impl ArtifactServer {
        fn start(responses: Vec<String>) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").expect("bind artifact server");
            Self::start_with_listener(listener, responses)
        }

        fn start_with_listener(listener: TcpListener, responses: Vec<String>) -> Self {
            let base_url = format!("http://{}", listener.local_addr().expect("server address"));
            let requests = Arc::new(Mutex::new(Vec::new()));
            let thread_requests = Arc::clone(&requests);
            let thread = ServerThread::spawn(listener, responses, move |stream, response| {
                let response = response.unwrap_or_else(unexpected_request_response);
                record_and_respond_raw(stream, &thread_requests, &response);
            });
            Self {
                base_url,
                requests,
                _thread: thread,
            }
        }

        /// Requests recorded so far. Each request is recorded before its
        /// response is written, so every hop the client saw completed is
        /// already here by the time the client call returns.
        fn requests(&self) -> Vec<ArtifactRequest> {
            self.requests.lock().expect("lock requests").clone()
        }
    }

    fn artifact_response(body: &[u8]) -> String {
        format!(
            "HTTP/1.1 200 OK\r\nX-Artifact-SHA256: test-sha\r\nX-Artifact-Size: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body.len(),
            String::from_utf8_lossy(body)
        )
    }

    fn redirect_response(location: &str) -> String {
        format!(
            "HTTP/1.1 302 Found\r\nLocation: {location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
        )
    }

    fn status_response(status_line: &str) -> String {
        format!("HTTP/1.1 {status_line}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
    }

    /// Served for a request the test queued no response for, so that request is
    /// still recorded rather than dropped.
    fn unexpected_request_response() -> String {
        status_response("500 Internal Server Error")
    }

    fn record_and_respond_raw(
        stream: TcpStream,
        requests: &Arc<Mutex<Vec<ArtifactRequest>>>,
        response: &str,
    ) {
        prepare_stream(&stream);
        let mut reader = BufReader::new(stream.try_clone().expect("clone artifact stream"));
        let mut request_line = String::new();
        reader
            .read_line(&mut request_line)
            .expect("read request line");
        let path = request_line
            .split_whitespace()
            .nth(1)
            .expect("request path")
            .to_string();
        let mut headers = HeaderMap::new();
        loop {
            let mut line = String::new();
            reader.read_line(&mut line).expect("read request header");
            if line == "\r\n" {
                break;
            }
            if let Some((name, value)) = line.split_once(':') {
                headers.insert(
                    reqwest::header::HeaderName::from_bytes(name.as_bytes())
                        .expect("valid header name"),
                    HeaderValue::from_str(value.trim()).expect("valid header value"),
                );
            }
        }
        requests
            .lock()
            .expect("lock requests")
            .push(ArtifactRequest { path, headers });
        let mut stream = stream;
        stream
            .write_all(response.as_bytes())
            .expect("write artifact response");
    }

    fn authenticated_client(base_url: &str) -> MarketplaceClient {
        let base_url = Url::parse(base_url).expect("parse marketplace URL");
        let mut headers = HeaderMap::new();
        headers.insert(
            SESSION_CREDENTIAL_HEADER,
            HeaderValue::from_static("secret-session"),
        );
        MarketplaceClient {
            base_url: base_url.clone(),
            client: Client::builder()
                .default_headers(headers.clone())
                .redirect(same_origin_redirect_policy(base_url))
                .build()
                .expect("build API client"),
            authenticated_artifact_client: Client::builder()
                .default_headers(headers)
                .redirect(Policy::none())
                .build()
                .expect("build authenticated artifact client"),
            artifact_client: Client::builder()
                .redirect(Policy::none())
                .build()
                .expect("build artifact client"),
            has_auth: true,
            style: Style::new(true, true, false),
        }
    }

    struct TestServer {
        base_url: String,
        requests: Arc<Mutex<Vec<RecordedRequest>>>,
        _thread: ServerThread,
    }

    impl TestServer {
        fn start(responses: Vec<Value>) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").expect("bind test server");
            let base_url = format!("http://{}", listener.local_addr().expect("server address"));
            let requests = Arc::new(Mutex::new(Vec::new()));
            let thread_requests = Arc::clone(&requests);
            let thread = ServerThread::spawn(listener, responses, move |stream, response| {
                let response = response.unwrap_or_else(|| json!({"error": "unexpected request"}));
                record_and_respond(stream, &thread_requests, response);
            });
            Self {
                base_url,
                requests,
                _thread: thread,
            }
        }

        fn client(&self) -> MarketplaceClient {
            MarketplaceClient {
                base_url: Url::parse(&self.base_url).expect("parse test server URL"),
                client: Client::new(),
                authenticated_artifact_client: Client::builder()
                    .redirect(Policy::none())
                    .build()
                    .expect("build test authenticated artifact client"),
                artifact_client: Client::builder()
                    .redirect(Policy::none())
                    .build()
                    .expect("build test artifact client"),
                has_auth: false,
                style: Style::new(true, true, false),
            }
        }

        /// Requests recorded so far; see [`ArtifactServer::requests`].
        fn requests(&self) -> Vec<RecordedRequest> {
            self.requests.lock().expect("lock requests").clone()
        }
    }

    fn record_and_respond(
        stream: TcpStream,
        requests: &Arc<Mutex<Vec<RecordedRequest>>>,
        response: Value,
    ) {
        prepare_stream(&stream);
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

        let requests = server.requests();
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
    }

    #[test]
    fn authenticated_api_client_refuses_cross_origin_redirect() {
        let destination = ArtifactServer::start(Vec::new());
        let marketplace = ArtifactServer::start(vec![redirect_response(&format!(
            "{}/catalog",
            destination.base_url
        ))]);
        let client = authenticated_client(&marketplace.base_url);

        let error = client
            .get_json::<Value>("/catalog")
            .expect_err("authenticated API redirect must fail");

        let (exit_code, payload) = failure_info(&error);
        assert_eq!(exit_code, exit_codes::NETWORK);
        assert_eq!(payload["error"]["code"], "server_unreachable");
        assert!(format!("{error:#}").contains("redirect"));
        let marketplace_requests = marketplace.requests();
        assert_eq!(marketplace_requests.len(), 1);
        assert!(marketplace_requests[0]
            .headers
            .get(SESSION_CREDENTIAL_HEADER)
            .is_some());
        assert!(
            destination.requests().is_empty(),
            "credential-bearing request reached the redirect target"
        );
    }

    #[test]
    fn download_authenticates_same_origin_and_preserves_verification_headers() {
        let server = ArtifactServer::start(vec![artifact_response(b"artifact")]);
        let client = authenticated_client(&server.base_url);

        let download = client.download("/artifact.zip").expect("download artifact");

        assert_eq!(download.bytes, b"artifact");
        assert_eq!(download.header_sha256.as_deref(), Some("test-sha"));
        assert_eq!(download.header_size, Some(8));
        let requests = server.requests();
        assert_eq!(requests[0].path, "/artifact.zip");
        assert_eq!(
            requests[0]
                .headers
                .get(SESSION_CREDENTIAL_HEADER)
                .and_then(|value| value.to_str().ok()),
            Some("secret-session")
        );
    }

    #[test]
    fn download_uses_no_credential_for_cross_origin_initial_url() {
        let marketplace = ArtifactServer::start(Vec::new());
        let artifact = ArtifactServer::start(vec![artifact_response(b"artifact")]);
        let client = authenticated_client(&marketplace.base_url);

        client
            .download(&format!("{}/artifact.zip", artifact.base_url))
            .expect("download cross-origin artifact");

        let requests = artifact.requests();
        assert!(requests[0].headers.get(SESSION_CREDENTIAL_HEADER).is_none());
        assert!(
            marketplace.requests().is_empty(),
            "cross-origin artifact URL was fetched through the marketplace"
        );
    }

    #[test]
    fn download_cross_origin_401_does_not_suggest_marketplace_login() {
        let marketplace = ArtifactServer::start(Vec::new());
        let artifact = ArtifactServer::start(vec![status_response("401 Unauthorized")]);
        let client = authenticated_client(&marketplace.base_url);

        let error = client
            .download(&format!("{}/artifact.zip", artifact.base_url))
            .expect_err("cross-origin 401 must fail");

        let (exit_code, _) = failure_info(&error);
        assert_eq!(exit_code, exit_codes::AUTH_REQUIRED);
        let rendered = format!("{error:#}");
        assert!(rendered.contains("artifact host"));
        assert!(!rendered.contains("run `bb auth login`"));
        assert_eq!(artifact.requests().len(), 1);
        assert!(
            marketplace.requests().is_empty(),
            "artifact host failure was retried against the marketplace"
        );
    }

    #[test]
    fn download_cross_origin_403_does_not_suggest_marketplace_login() {
        let marketplace = ArtifactServer::start(Vec::new());
        let artifact = ArtifactServer::start(vec![status_response("403 Forbidden")]);
        let client = authenticated_client(&marketplace.base_url);

        let error = client
            .download(&format!("{}/artifact.zip", artifact.base_url))
            .expect_err("cross-origin 403 must fail");

        let (exit_code, _) = failure_info(&error);
        assert_eq!(exit_code, exit_codes::FORBIDDEN);
        let rendered = format!("{error:#}");
        assert!(rendered.contains("artifact host"));
        assert!(!rendered.contains("run `bb auth login`"));
        assert_eq!(artifact.requests().len(), 1);
        assert!(
            marketplace.requests().is_empty(),
            "artifact host failure was retried against the marketplace"
        );
    }

    #[test]
    fn download_same_origin_401_keeps_marketplace_login_hint() {
        let server = ArtifactServer::start(vec![status_response("401 Unauthorized")]);
        let client = authenticated_client(&server.base_url);

        let error = client
            .download("/artifact.zip")
            .expect_err("same-origin 401 must fail");

        let (exit_code, _) = failure_info(&error);
        assert_eq!(exit_code, exit_codes::AUTH_REQUIRED);
        assert!(format!("{error:#}").contains("run `bb auth login`"));
        assert_eq!(server.requests().len(), 1);
    }

    #[test]
    fn download_keeps_credential_across_same_origin_redirect() {
        let server = ArtifactServer::start(vec![
            redirect_response("/final.zip"),
            artifact_response(b"artifact"),
        ]);
        let client = authenticated_client(&server.base_url);

        client
            .download("/redirect")
            .expect("follow same-origin artifact redirect");

        let requests = server.requests();
        assert_eq!(requests.len(), 2);
        assert!(requests
            .iter()
            .all(|request| request.headers.get(SESSION_CREDENTIAL_HEADER).is_some()));
    }

    #[test]
    fn download_drops_credential_on_cross_origin_redirect() {
        let destination = ArtifactServer::start(vec![artifact_response(b"artifact")]);
        let marketplace = ArtifactServer::start(vec![redirect_response(&format!(
            "{}/artifact.zip",
            destination.base_url
        ))]);
        let client = authenticated_client(&marketplace.base_url);

        client
            .download("/redirect")
            .expect("follow cross-origin artifact redirect");

        let marketplace_requests = marketplace.requests();
        assert!(marketplace_requests[0]
            .headers
            .get(SESSION_CREDENTIAL_HEADER)
            .is_some());
        let destination_requests = destination.requests();
        assert!(destination_requests[0]
            .headers
            .get(SESSION_CREDENTIAL_HEADER)
            .is_none());
    }

    #[test]
    fn download_never_restores_credential_after_cross_origin_redirect() {
        let marketplace_listener = TcpListener::bind("127.0.0.1:0").expect("bind marketplace");
        let marketplace_url = format!(
            "http://{}",
            marketplace_listener
                .local_addr()
                .expect("marketplace address")
        );
        let cross_origin = ArtifactServer::start(vec![redirect_response(&format!(
            "{marketplace_url}/final.zip"
        ))]);
        let marketplace = ArtifactServer::start_with_listener(
            marketplace_listener,
            vec![
                redirect_response(&format!("{}/bounce", cross_origin.base_url)),
                artifact_response(b"artifact"),
            ],
        );
        let client = authenticated_client(&marketplace.base_url);
        client.download("/start").expect("download redirect chain");

        let requests = marketplace.requests();
        assert_eq!(requests.len(), 2);
        assert!(requests[0].headers.get(SESSION_CREDENTIAL_HEADER).is_some());
        assert!(requests[1].headers.get(SESSION_CREDENTIAL_HEADER).is_none());
        assert_eq!(cross_origin.requests().len(), 1);
    }

    #[test]
    fn download_rejects_malformed_and_unsafe_urls_without_requesting() {
        let marketplace = ArtifactServer::start(Vec::new());
        let client = authenticated_client(&marketplace.base_url);

        for url in ["ftp://example.com/artifact", "http://[::1"] {
            let error = client.download(url).expect_err("unsafe URL must fail");
            assert!(format!("{error:#}").contains("artifact URL"));
        }
        assert!(
            marketplace.requests().is_empty(),
            "rejected URL still produced a request"
        );
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
