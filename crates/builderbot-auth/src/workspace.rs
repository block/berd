use std::fmt;

use anyhow::{anyhow, Context, Result};
use reqwest::blocking::Client;
use reqwest::header::{ACCEPT, USER_AGENT};
use serde::{Deserialize, Serialize};

use crate::auth::SESSION_CREDENTIAL_HEADER;
use crate::auth_login::{auth_url, playpen_baggage, CLI_USER_AGENT};
use crate::auth_storage::StoredSessionCredential;

const LIST_WORKSPACES_PATH: &str = "/v1/workspaces/list";
const SWITCH_WORKSPACE_PATH: &str = "/v1/workspaces/switch";

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Workspace {
    pub workspace_identifier: Option<String>,
    pub display_name: Option<String>,
    #[serde(default)]
    pub roles: Vec<String>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct ListWorkspacesResponse {
    #[serde(default)]
    pub workspaces: Vec<Workspace>,
    pub active_workspace_identifier: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct SwitchWorkspaceResponse {
    pub workspace: Option<Workspace>,
    pub session_credential: Option<String>,
}

#[derive(Debug)]
pub struct WorkspaceHttpError {
    pub status: u16,
    pub path: &'static str,
    pub body: String,
}

impl fmt::Display for WorkspaceHttpError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "{} failed with {}: {}",
            self.path, self.status, self.body
        )
    }
}

impl std::error::Error for WorkspaceHttpError {}

#[derive(Debug, Serialize)]
struct ListWorkspacesRequest {}

#[derive(Debug, Serialize)]
struct SwitchWorkspaceRequest<'a> {
    workspace_identifier: &'a str,
}

pub fn list_workspaces(
    client: &Client,
    playpen: Option<&str>,
    server_url: &str,
    credential: &StoredSessionCredential,
) -> Result<ListWorkspacesResponse> {
    post_authenticated_json(
        client,
        playpen,
        server_url,
        LIST_WORKSPACES_PATH,
        credential,
        &ListWorkspacesRequest {},
    )
}

pub fn switch_workspace(
    client: &Client,
    playpen: Option<&str>,
    server_url: &str,
    credential: &StoredSessionCredential,
    workspace_identifier: &str,
) -> Result<SwitchWorkspaceResponse> {
    post_authenticated_json(
        client,
        playpen,
        server_url,
        SWITCH_WORKSPACE_PATH,
        credential,
        &SwitchWorkspaceRequest {
            workspace_identifier,
        },
    )
}

fn post_authenticated_json<T, B>(
    client: &Client,
    playpen: Option<&str>,
    server_url: &str,
    path: &'static str,
    credential: &StoredSessionCredential,
    body: &B,
) -> Result<T>
where
    T: for<'de> Deserialize<'de>,
    B: Serialize + ?Sized,
{
    let session_credential = credential
        .session_credential_header_value()
        .ok_or_else(|| anyhow!("stored BuilderBot CLI auth session is empty"))?;
    let url = auth_url(server_url, path)?;
    let mut request = client
        .post(url)
        .header(USER_AGENT, CLI_USER_AGENT)
        .header(ACCEPT, "application/json")
        .header(SESSION_CREDENTIAL_HEADER, session_credential)
        .json(body);
    if let Some(baggage) = playpen_baggage(playpen) {
        request = request.header("Baggage", baggage);
    }
    let response = request.send().with_context(|| format!("request {path}"))?;
    let status = response.status();
    let body = response
        .text()
        .with_context(|| format!("read {path} response"))?;
    if !status.is_success() {
        return Err(anyhow::Error::new(WorkspaceHttpError {
            status: status.as_u16(),
            path,
            body: terminal_safe_text(&body),
        }));
    }
    serde_json::from_str(&body).with_context(|| format!("parse {path} response"))
}

fn terminal_safe_text(value: &str) -> String {
    value.chars().flat_map(char::escape_default).collect()
}
