//! Marketplace DTOs used exclusively by `bb agents`.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const AGENT_OPERATION_KIND: &str = "agent";

#[derive(Debug, Clone, Deserialize)]
pub struct AgentCatalogPage {
    pub items: Vec<AgentSummary>,
    #[serde(default)]
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AgentSummary {
    pub slug: String,
    pub name: String,
    pub description: String,
    pub status: String,
    pub enabled: bool,
    pub latest_version_id: String,
    pub latest_content_sha256: String,
    pub source_id: String,
    pub source_revision: String,
    pub source_path: String,
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AgentDetail {
    pub slug: String,
    pub name: String,
    pub description: String,
    pub status: String,
    pub enabled: bool,
    pub latest_version_id: String,
    pub latest_content_sha256: String,
    pub source_id: String,
    pub source_revision: String,
    pub source_path: String,
    pub tags: Vec<String>,
    pub latest_version: AgentVersionDetail,
    pub versions: Vec<AgentVersionSummary>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AgentVersionSummary {
    pub id: String,
    pub status: String,
    pub content_sha256: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AgentVersionDetail {
    pub id: String,
    pub slug: String,
    pub name: String,
    pub status: String,
    pub content_sha256: String,
    pub artifact: AgentReadArtifact,
    pub source: AgentVersionSource,
    pub created_at: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AgentVersion {
    pub id: String,
    pub slug: String,
    pub name: String,
    pub status: String,
    pub content_sha256: String,
    pub artifact: AgentReadArtifact,
    pub source: AgentVersionSource,
    pub created_at: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AgentVersionSource {
    pub source_id: String,
    pub snapshot_id: String,
    pub revision: String,
    pub path: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AgentReadArtifact {
    pub id: String,
    pub sha256: String,
    pub size_bytes: u64,
    pub media_type: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AgentInstallArtifact {
    pub id: String,
    pub download_url: String,
    pub sha256: String,
    pub size_bytes: u64,
    pub media_type: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct AgentInstallPlanRequest {
    pub scope: String,
    pub targets: Vec<AgentInstallTarget>,
    pub installed: Vec<InstalledAgentRequest>,
    pub client: BTreeMap<String, Value>,
    pub include_dependencies: bool,
    pub allow_removals: bool,
    pub dry_run: bool,
}

impl AgentInstallPlanRequest {
    pub fn for_agent(
        slug: impl Into<String>,
        version_id: Option<String>,
        installed: Vec<InstalledAgentRequest>,
    ) -> Self {
        Self {
            scope: "global".to_string(),
            targets: vec![AgentInstallTarget {
                target_type: AGENT_OPERATION_KIND.to_string(),
                slug: slug.into(),
                version_id,
            }],
            installed,
            client: BTreeMap::new(),
            include_dependencies: false,
            allow_removals: false,
            dry_run: false,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct AgentInstallTarget {
    #[serde(rename = "type")]
    pub target_type: String,
    pub slug: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct InstalledAgentRequest {
    pub slug: String,
    pub version_id: Option<String>,
    pub content_sha256: Option<String>,
    pub scope: Option<String>,
    pub targets: Vec<String>,
    pub installed_via: Option<String>,
    pub local_source: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AgentInstallPlan {
    pub operations: Vec<AgentInstallOperation>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AgentInstallOperation {
    pub action: String,
    pub reason: String,
    pub kind: String,
    pub skill: AgentPlanContent,
    pub artifact: Option<AgentInstallArtifact>,
    pub installed_via: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AgentPlanContent {
    pub slug: String,
    pub version_id: String,
    pub content_sha256: String,
}

#[derive(Debug, Clone)]
pub struct AgentInstallResolution {
    pub action: String,
    pub reason: String,
    pub agent: AgentDetail,
    pub version: AgentVersion,
    pub plan: AgentPlanContent,
    pub artifact: Option<AgentInstallArtifact>,
    pub installed_via: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AgentOperationError {
    Missing { slug: String },
    WrongKind { slug: String, actual: String },
}

impl std::fmt::Display for AgentOperationError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Missing { slug } => write!(
                formatter,
                "install plan has no operation for requested agent `{slug}`"
            ),
            Self::WrongKind { slug, actual } => write!(
                formatter,
                "install plan operation for `{slug}` has kind `{actual}`; expected `{AGENT_OPERATION_KIND}`"
            ),
        }
    }
}

impl std::error::Error for AgentOperationError {}
