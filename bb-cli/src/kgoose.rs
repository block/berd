use std::collections::BTreeMap;
use std::env;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use anyhow::{Context, Result};
use reqwest::blocking::{Client, ClientBuilder};
use reqwest::header::{HeaderMap, HeaderName, HeaderValue, ACCEPT, CONTENT_TYPE};
use serde::de::DeserializeOwned;
use serde::Serialize;
use url::Url;

use crate::bb::auth::SESSION_CREDENTIAL_HEADER;
use crate::bb::skills_config::normalize_kgoose_service_path;
use crate::http_origin::{origin_label, parse_http_url, same_origin_redirect_policy_with};
pub use crate::proto::squareup::cash::kgoose::api::v3::{
    CallToolRequest, CallToolResponse, ExtensionInfo, ListExtensionsRequest,
    ListExtensionsResponse, ListToolsRequest, ListToolsResponse, Source, ToolConfig,
};
use crate::proto::{CALL_TOOL_PATH, LIST_EXTENSIONS_PATH, LIST_TOOLS_PATH};

pub const DEFAULT_KGOOSE_BASE_URL: &str = "https://kgoose.sqprod.co";
pub const DEFAULT_KGOOSE_TIMEOUT_SECS: f64 = 600.0;
const STS_ACCESS_TOKEN_ENV_VAR: &str = "STS_ACCESS_TOKEN";
const KGOOSE_DEBUG_ENV_VAR: &str = "KGOOSE_DEBUG";
/// Registrable domain Cloudflare Access redirects to when WARP is off.
const CLOUDFLARE_ACCESS_DOMAIN: &str = "cloudflareaccess.com";

#[derive(Debug, Clone, PartialEq)]
pub struct KgooseConfig {
    pub base_url: String,
    pub service_path: String,
    pub playpen: Option<String>,
    pub goosemcp_playpen: Option<String>,
    pub timeout_secs: f64,
    pub session_credential: Option<String>,
}

impl KgooseConfig {
    pub fn timeout(&self) -> Duration {
        Duration::from_secs_f64(self.timeout_secs)
    }
}

pub trait KgooseClient {
    fn list_extensions(&self, config: &KgooseConfig) -> Result<ListExtensionsResponse>;
    fn list_tools(&self, config: &KgooseConfig, extension_name: &str) -> Result<ListToolsResponse>;
    fn call_tool(
        &self,
        config: &KgooseConfig,
        extension_name: &str,
        tool_name: &str,
        arguments_json: &str,
        headers: &BTreeMap<String, String>,
    ) -> Result<CallToolResponse>;
}

pub struct HttpKgooseClient;

impl KgooseClient for HttpKgooseClient {
    fn list_extensions(&self, config: &KgooseConfig) -> Result<ListExtensionsResponse> {
        debug_log("ListExtensions".to_string());
        self.post_json(config, LIST_EXTENSIONS_PATH, &ListExtensionsRequest {})
    }

    fn list_tools(&self, config: &KgooseConfig, extension_name: &str) -> Result<ListToolsResponse> {
        debug_log(format!("ListTools extension={extension_name}"));
        self.post_json(
            config,
            LIST_TOOLS_PATH,
            &ListToolsRequest {
                extension_name: Some(extension_name.to_string()),
            },
        )
    }

    fn call_tool(
        &self,
        config: &KgooseConfig,
        extension_name: &str,
        tool_name: &str,
        arguments_json: &str,
        headers: &BTreeMap<String, String>,
    ) -> Result<CallToolResponse> {
        debug_log(format!(
            "CallTool extension={extension_name} tool={tool_name} arguments_bytes={} tool_header_keys=[{}]",
            arguments_json.len(),
            headers.keys().cloned().collect::<Vec<_>>().join(",")
        ));
        self.post_json(
            config,
            CALL_TOOL_PATH,
            &CallToolRequest {
                extension_name: Some(extension_name.to_string()),
                tool_name: Some(tool_name.to_string()),
                arguments_json: Some(arguments_json.to_string()),
                headers: headers
                    .iter()
                    .map(|(key, value)| (key.clone(), value.clone()))
                    .collect(),
                source: Some(Source::SqAgentTools.into()),
                tenancy: None,
            },
        )
    }
}

impl HttpKgooseClient {
    fn post_json<T, B>(&self, config: &KgooseConfig, path: &str, body: &B) -> Result<T>
    where
        T: DeserializeOwned,
        B: Serialize + ?Sized,
    {
        let base_url = parse_http_url(&config.base_url, "kgoose base URL")?;
        let (client, refused_redirect) = build_http_client(config, &base_url)?;
        let service_path = normalize_kgoose_service_path(&config.service_path)?;
        let request_path = format!(
            "{}/{}",
            service_path.trim_end_matches('/'),
            path.trim_start_matches('/')
        );
        let url = format!("{}{}", config.base_url.trim_end_matches('/'), request_path);

        debug_log(format!(
            "POST {url} timeout_secs={} playpen={} goosemcp_playpen={}",
            config.timeout_secs,
            option_for_debug(config.playpen.as_deref()),
            option_for_debug(config.goosemcp_playpen.as_deref())
        ));

        let response = match client.post(&url).json(body).send() {
            Ok(response) => response,
            Err(err) => {
                // The slot is only filled when our redirect policy refused a
                // hop, so a recorded target means the credential stayed home.
                if let Some(target) = refused_redirect.take() {
                    return Err(cross_origin_redirect_error(&base_url, &target));
                }
                return Err(err).with_context(|| format!("POST {request_path}"));
            }
        };

        let status = response.status();
        let served_by_cloudflare_access = is_cloudflare_access(response.url());
        let final_url = response.url().to_string();
        let response_body = response
            .text()
            .with_context(|| format!("read {request_path} response"))?;

        debug_log(format!(
            "POST {request_path} status={status} final_url={final_url} response_bytes={}",
            response_body.len()
        ));

        // Backstop for a Cloudflare Access login page (indicates VPN is off).
        // A redirect to Cloudflare Access is refused before the credential is
        // sent, so this only fires when the configured base URL is itself a
        // Cloudflare Access host. Note that Cloudflare returns 200 OK with an
        // HTML login page, not an error status.
        if served_by_cloudflare_access {
            anyhow::bail!(
                "Cannot connect to kgoose - received Cloudflare Access redirect.\n\
                 This usually means you need to connect to the corporate VPN (WARP).\n\
                 Please enable WARP and try again."
            );
        }

        if !status.is_success() {
            let body = truncate(&response_body, 800);
            anyhow::bail!("POST {request_path} failed with {status}: {body}");
        }

        serde_json::from_str(&response_body)
            .with_context(|| format!("deserialize JSON response from {request_path}"))
    }
}

/// Records the redirect target the client refused to follow, so `post_json` can
/// name the host it declined to send credentials to.
#[derive(Clone, Debug, Default)]
struct RefusedRedirect(Arc<Mutex<Option<Url>>>);

impl RefusedRedirect {
    fn record(&self, url: &Url) {
        *self.0.lock().unwrap_or_else(PoisonError::into_inner) = Some(url.clone());
    }

    fn take(&self) -> Option<Url> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner).take()
    }
}

fn is_cloudflare_access(url: &Url) -> bool {
    url.host_str().is_some_and(|host| {
        host == CLOUDFLARE_ACCESS_DOMAIN || host.ends_with(&format!(".{CLOUDFLARE_ACCESS_DOMAIN}"))
    })
}

fn cross_origin_redirect_error(base_url: &Url, target: &Url) -> anyhow::Error {
    let base_origin = origin_label(base_url);
    let target_origin = origin_label(target);
    if is_cloudflare_access(target) {
        anyhow::anyhow!(
            "Cannot connect to kgoose - {base_origin} redirected to Cloudflare Access \
             ({target_origin}).\n\
             This usually means you need to connect to the corporate VPN (WARP).\n\
             Please enable WARP and try again.\n\
             Your kgoose credentials were not sent to {target_origin}."
        )
    } else {
        anyhow::anyhow!(
            "Cannot connect to kgoose - {base_origin} redirected to {target_origin}, a different \
             origin.\n\
             Your kgoose credentials were not sent to {target_origin}; point KGOOSE_BASE_URL at \
             {target_origin} directly if that host is the intended service."
        )
    }
}

/// Builds the request client alongside the slot that records a refused
/// cross-origin redirect.
fn build_http_client(config: &KgooseConfig, base_url: &Url) -> Result<(Client, RefusedRedirect)> {
    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    headers.insert(ACCEPT, HeaderValue::from_static("application/json"));
    if let Some(session_credential) = config.session_credential.as_deref() {
        headers.insert(
            SESSION_CREDENTIAL_HEADER,
            HeaderValue::from_str(session_credential)
                .context("build X-BB-Session-Credential header")?,
        );
    }

    // Build the Baggage header from independent playpen knobs:
    //   * KGOOSE_PLAYPEN routes the kgoose service itself.
    //   * GOOSEMCP_PLAYPEN routes the downstream goosemcp Envoy. Setting it
    //     when no matching playpen pod exists makes every call fail with an
    //     opaque 5xx, so it is opt-in independent of KGOOSE_PLAYPEN.
    let mut baggage_parts = Vec::new();
    if let Some(playpen) = &config.playpen {
        baggage_parts.push(format!("kgoose-playpen={playpen}"));
    }
    if let Some(playpen) = &config.goosemcp_playpen {
        baggage_parts.push(format!("envoy-route--goosemcp=playpen-{playpen}"));
    }
    if !baggage_parts.is_empty() {
        headers.insert(
            "Baggage",
            HeaderValue::from_str(&baggage_parts.join(",")).context("build Baggage header")?,
        );
    }

    match env::var(STS_ACCESS_TOKEN_ENV_VAR) {
        Ok(access_token) => {
            headers.insert(
                HeaderName::from_static("x-forwarded-identity-token"),
                HeaderValue::from_str(&access_token)
                    .context("build x-forwarded-identity-token header")?,
            );
        }
        Err(env::VarError::NotPresent) => {}
        Err(err) => anyhow::bail!("failed to read {STS_ACCESS_TOKEN_ENV_VAR}: {err}"),
    }

    debug_log(format!(
        "HTTP client default_header_keys=[{}]",
        headers
            .keys()
            .map(|name| name.as_str())
            .collect::<Vec<_>>()
            .join(",")
    ));

    // The session credential and identity token ride on every request as
    // default headers, so redirects stay inside the configured origin: reqwest
    // would otherwise replay them to whatever host a redirect names, which is
    // exactly what happens when Cloudflare Access bounces us off-origin.
    let refused_redirect = RefusedRedirect::default();
    let redirect_policy = same_origin_redirect_policy_with(base_url.clone(), {
        let refused_redirect = refused_redirect.clone();
        move |target| {
            refused_redirect.record(target);
            format!(
                "refusing to send kgoose credentials across a redirect to {}",
                origin_label(target)
            )
        }
    });

    let client = ClientBuilder::new()
        .default_headers(headers)
        .redirect(redirect_policy)
        .timeout(config.timeout())
        .build()
        .context("build HTTP client")?;
    Ok((client, refused_redirect))
}

fn truncate(value: &str, max_len: usize) -> String {
    if value.len() <= max_len {
        return value.to_string();
    }

    format!("{}...", &value[..max_len])
}

fn debug_enabled() -> bool {
    match env::var(KGOOSE_DEBUG_ENV_VAR) {
        Ok(value) => !matches!(
            value.trim().to_ascii_lowercase().as_str(),
            "" | "0" | "false" | "off" | "no"
        ),
        Err(env::VarError::NotPresent) => false,
        Err(_) => false,
    }
}

fn debug_log(message: String) {
    if debug_enabled() {
        eprintln!("{KGOOSE_DEBUG_ENV_VAR}: {message}");
    }
}

fn option_for_debug(value: Option<&str>) -> &str {
    value.filter(|value| !value.is_empty()).unwrap_or("<unset>")
}

#[cfg(test)]
mod tests {
    use std::io::{self, BufRead, BufReader, Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::thread;

    use super::*;
    use crate::bb::skills_config::DEFAULT_KGOOSE_SERVICE_PATH;
    use crate::proto::squareup::cash::kgoose::api::v3::user_content;

    const TEST_SESSION_CREDENTIAL: &str = "test-session-credential";

    #[derive(Clone, Debug)]
    struct RecordedRequest {
        path: String,
        headers: HeaderMap,
    }

    impl RecordedRequest {
        fn session_credential(&self) -> Option<&str> {
            self.headers
                .get(SESSION_CREDENTIAL_HEADER)
                .and_then(|value| value.to_str().ok())
        }
    }

    /// Minimal HTTP server for the redirect tests. It accepts non-blocking and
    /// stops on drop, so a test that expects *no* request cannot hang waiting
    /// for one that never arrives.
    struct TestServer {
        base_url: String,
        requests: Arc<Mutex<Vec<RecordedRequest>>>,
        stop: Arc<AtomicBool>,
        handle: Option<thread::JoinHandle<()>>,
    }

    impl TestServer {
        fn start(responses: Vec<String>) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").expect("bind test server");
            listener
                .set_nonblocking(true)
                .expect("set listener non-blocking");
            let base_url = format!("http://{}", listener.local_addr().expect("server address"));
            let requests = Arc::new(Mutex::new(Vec::new()));
            let stop = Arc::new(AtomicBool::new(false));
            let thread_requests = Arc::clone(&requests);
            let thread_stop = Arc::clone(&stop);
            let handle = thread::spawn(move || {
                let mut responses = responses.into_iter();
                while !thread_stop.load(Ordering::Relaxed) {
                    match listener.accept() {
                        Ok((stream, _)) => match responses.next() {
                            Some(response) => {
                                record_and_respond(stream, &thread_requests, &response)
                            }
                            None => break,
                        },
                        Err(err) if err.kind() == io::ErrorKind::WouldBlock => {
                            thread::sleep(Duration::from_millis(5));
                        }
                        Err(_) => break,
                    }
                }
            });
            Self {
                base_url,
                requests,
                stop,
                handle: Some(handle),
            }
        }

        fn requests(&self) -> Vec<RecordedRequest> {
            self.requests.lock().expect("lock requests").clone()
        }
    }

    impl Drop for TestServer {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::Relaxed);
            if let Some(handle) = self.handle.take() {
                let _ = handle.join();
            }
        }
    }

    fn record_and_respond(
        stream: TcpStream,
        requests: &Arc<Mutex<Vec<RecordedRequest>>>,
        response: &str,
    ) {
        stream
            .set_nonblocking(false)
            .expect("set stream blocking(false)");
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .expect("set stream read timeout");
        let mut reader = BufReader::new(stream.try_clone().expect("clone test stream"));
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
        let mut content_length = 0usize;
        loop {
            let mut line = String::new();
            reader.read_line(&mut line).expect("read request header");
            if line == "\r\n" || line.is_empty() {
                break;
            }
            if let Some((name, value)) = line.split_once(':') {
                if name.eq_ignore_ascii_case("content-length") {
                    content_length = value.trim().parse().expect("content length");
                }
                headers.insert(
                    HeaderName::from_bytes(name.as_bytes()).expect("valid header name"),
                    HeaderValue::from_str(value.trim()).expect("valid header value"),
                );
            }
        }
        let mut body = vec![0; content_length];
        reader.read_exact(&mut body).expect("read request body");
        requests
            .lock()
            .expect("lock requests")
            .push(RecordedRequest { path, headers });
        let mut stream = stream;
        stream
            .write_all(response.as_bytes())
            .expect("write test response");
    }

    fn json_response(body: &str) -> String {
        format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
    }

    /// 307 keeps the method and body, so the retried hop is another authenticated POST.
    fn redirect_response(location: &str) -> String {
        format!(
            "HTTP/1.1 307 Temporary Redirect\r\nLocation: {location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
        )
    }

    fn test_config(base_url: &str) -> KgooseConfig {
        KgooseConfig {
            base_url: base_url.to_string(),
            service_path: DEFAULT_KGOOSE_SERVICE_PATH.to_string(),
            playpen: None,
            goosemcp_playpen: None,
            timeout_secs: 5.0,
            session_credential: Some(TEST_SESSION_CREDENTIAL.to_string()),
        }
    }

    fn list_extensions(config: &KgooseConfig) -> Result<ListExtensionsResponse> {
        HttpKgooseClient.post_json(config, LIST_EXTENSIONS_PATH, &ListExtensionsRequest {})
    }

    #[test]
    fn post_json_keeps_credential_across_same_origin_redirect() {
        let server = TestServer::start(vec![
            redirect_response("/cash-app/goose/v3/list-extensions?retry=1"),
            json_response("{}"),
        ]);

        let response =
            list_extensions(&test_config(&server.base_url)).expect("follow same-origin redirect");

        assert!(response.extensions.is_empty());
        let requests = server.requests();
        assert_eq!(requests.len(), 2);
        assert_eq!(
            requests[1].path,
            "/cash-app/goose/v3/list-extensions?retry=1"
        );
        for request in &requests {
            assert_eq!(
                request.session_credential(),
                Some(TEST_SESSION_CREDENTIAL),
                "same-origin hop {} lost the credential",
                request.path
            );
        }
    }

    #[test]
    fn post_json_refuses_cross_origin_redirect_without_sending_credential() {
        // Queue a response the destination would happily serve, so the empty
        // request log below reflects a refusal rather than a dead listener.
        let destination = TestServer::start(vec![json_response("{}")]);
        let kgoose = TestServer::start(vec![redirect_response(&format!(
            "{}/cash-app/goose/v3/list-extensions",
            destination.base_url
        ))]);

        let error =
            list_extensions(&test_config(&kgoose.base_url)).expect_err("refuse cross-origin hop");

        let message = format!("{error:#}");
        assert!(message.contains(&destination.base_url), "{message}");
        assert!(message.contains("credentials were not sent"), "{message}");
        assert_eq!(kgoose.requests().len(), 1);
        assert!(
            destination.requests().is_empty(),
            "credential-bearing request reached the redirect target"
        );
    }

    #[test]
    fn post_json_reports_cloudflare_access_redirect_as_vpn_hint() {
        let server = TestServer::start(vec![redirect_response(
            "https://block.cloudflareaccess.com/cdn-cgi/access/login/kgoose.sqprod.co",
        )]);

        let error = list_extensions(&test_config(&server.base_url))
            .expect_err("refuse Cloudflare Access hop");

        let message = format!("{error:#}");
        assert!(message.contains("WARP"), "{message}");
        assert!(
            message.contains("https://block.cloudflareaccess.com"),
            "{message}"
        );
        assert!(message.contains("credentials were not sent"), "{message}");
    }

    #[test]
    fn cloudflare_access_detection_requires_the_real_domain() {
        for host in [
            "https://block.cloudflareaccess.com/login",
            "https://cloudflareaccess.com/login",
        ] {
            assert!(
                is_cloudflare_access(&Url::parse(host).expect("parse URL")),
                "{host}"
            );
        }
        for host in [
            "https://notcloudflareaccess.com/login",
            "https://cloudflareaccess.com.evil.example/login",
            "https://kgoose.sqprod.co/cash-app/goose",
        ] {
            assert!(
                !is_cloudflare_access(&Url::parse(host).expect("parse URL")),
                "{host}"
            );
        }
    }

    #[test]
    fn list_tools_response_deserializes_generated_proto_shape() {
        let response: ListToolsResponse = serde_json::from_str(
            r#"
        {
          "extension_name": "developer",
          "extension_description": "Developer tools",
          "tools": [
            {
              "tool": "shell",
              "description": "Run a shell command",
              "config_json": "{\"type\":\"object\",\"properties\":{}}",
              "mutates_state": false
            }
          ]
        }
        "#,
        )
        .expect("deserialize list tools response");

        assert_eq!(response.extension_name.as_deref(), Some("developer"));
        assert_eq!(response.tools[0].tool.as_deref(), Some("shell"));
        assert_eq!(response.tools[0].mutates_state, Some(false));
    }

    #[test]
    fn call_tool_response_deserializes_generated_proto_shape() {
        let response: CallToolResponse = serde_json::from_str(
            r#"
            {
              "content": [{"text":{"text":"hello"}}],
              "is_error": false,
              "structured_content_json": "{\"ok\":true}"
            }
            "#,
        )
        .expect("deserialize call response");

        assert_eq!(response.is_error, Some(false));
        assert_eq!(
            response.structured_content_json.as_deref(),
            Some("{\"ok\":true}")
        );
        assert_eq!(
            response.content[0]
                .content
                .as_ref()
                .and_then(|content| match content {
                    user_content::Content::Text(text) => text.text.as_deref(),
                    _ => None,
                }),
            Some("hello")
        );
    }

    #[test]
    fn list_extensions_response_defaults_missing_extensions() {
        let response: ListExtensionsResponse =
            serde_json::from_str("{}").expect("deserialize extensions response");

        assert!(response.extensions.is_empty());
    }

    #[test]
    fn list_extensions_response_deserializes_auth_status_fields() {
        let response: ListExtensionsResponse = serde_json::from_str(
            r#"
            {
              "extensions": [
                {
                  "name": "slack",
                  "description": "Slack tools",
                  "tool_count": 12,
                  "anyToolRequiresUserAuth": true,
                  "authSatisfiedForCaller": true
                },
                {
                  "name": "airtable",
                  "description": "Airtable tools",
                  "tool_count": 4,
                  "any_tool_requires_user_auth": false,
                  "auth_satisfied_for_caller": false
                }
              ]
            }
            "#,
        )
        .expect("deserialize list extensions response");

        assert_eq!(response.extensions[0].name.as_deref(), Some("slack"));
        assert_eq!(response.extensions[0].tool_count, Some(12));
        assert_eq!(
            response.extensions[0].any_tool_requires_user_auth,
            Some(true)
        );
        assert_eq!(response.extensions[0].auth_satisfied_for_caller, Some(true));

        assert_eq!(response.extensions[1].name.as_deref(), Some("airtable"));
        assert_eq!(response.extensions[1].tool_count, Some(4));
        assert_eq!(
            response.extensions[1].any_tool_requires_user_auth,
            Some(false)
        );
        assert_eq!(
            response.extensions[1].auth_satisfied_for_caller,
            Some(false)
        );
    }
}
