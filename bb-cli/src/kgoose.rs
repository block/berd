use std::collections::BTreeMap;
use std::env;
use std::time::Duration;

use anyhow::{Context, Result};
use reqwest::blocking::{Client, ClientBuilder};
use reqwest::header::{HeaderMap, HeaderName, HeaderValue, ACCEPT, CONTENT_TYPE};
use serde::de::DeserializeOwned;
use serde::Serialize;

use crate::bb::auth::SESSION_CREDENTIAL_HEADER;
use crate::bb::skills_config::normalize_kgoose_service_path;
pub use crate::proto::squareup::cash::kgoose::api::v3::{
    CallToolRequest, CallToolResponse, ExtensionInfo, ListExtensionsRequest,
    ListExtensionsResponse, ListToolsRequest, ListToolsResponse, Source, ToolConfig,
};
use crate::proto::{CALL_TOOL_PATH, LIST_EXTENSIONS_PATH, LIST_TOOLS_PATH};

pub const DEFAULT_KGOOSE_BASE_URL: &str = "https://kgoose.sqprod.co";
pub const DEFAULT_KGOOSE_TIMEOUT_SECS: f64 = 600.0;
const STS_ACCESS_TOKEN_ENV_VAR: &str = "STS_ACCESS_TOKEN";
const KGOOSE_DEBUG_ENV_VAR: &str = "KGOOSE_DEBUG";

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
        let client = build_http_client(config)?;
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

        let response = client
            .post(&url)
            .json(body)
            .send()
            .with_context(|| format!("POST {request_path}"))?;

        let status = response.status();
        let final_url = response.url().to_string();
        let response_body = response
            .text()
            .with_context(|| format!("read {request_path} response"))?;

        debug_log(format!(
            "POST {request_path} status={status} final_url={final_url} response_bytes={}",
            response_body.len()
        ));

        // Check for Cloudflare Access redirect (indicates VPN is off)
        // Note: Cloudflare returns 200 OK with an HTML login page, not an error status
        if final_url.contains("cloudflareaccess.com") {
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

fn build_http_client(config: &KgooseConfig) -> Result<Client> {
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

    ClientBuilder::new()
        .default_headers(headers)
        .timeout(config.timeout())
        .build()
        .context("build HTTP client")
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
    use super::{CallToolResponse, ListExtensionsResponse, ListToolsResponse};
    use crate::proto::squareup::cash::kgoose::api::v3::user_content;

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
