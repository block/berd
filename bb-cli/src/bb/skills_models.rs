//! API and local DTOs for `bb skills`.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub use builderbot_auth::preferences::{
    BuilderBotPreferences as SkillsPreferences, PREFERENCE_KEYS,
};

#[derive(Debug, Serialize, Deserialize)]
pub struct SkillPage {
    pub items: Vec<SkillSummary>,
    #[serde(default)]
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillSummary {
    pub slug: String,
    pub name: String,
    pub description: String,
    pub status: String,
    pub enabled: bool,
    pub latest_version_id: String,
    #[serde(default)]
    pub latest_content_sha256: Option<String>,
    #[serde(default)]
    pub source_id: Option<String>,
    #[serde(default)]
    pub source_revision: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SkillDetail {
    pub slug: String,
    pub name: String,
    pub description: String,
    pub status: String,
    pub enabled: bool,
    pub latest_version_id: String,
    pub latest_content_sha256: String,
    #[serde(default)]
    pub source_id: Option<String>,
    #[serde(default)]
    pub source_revision: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub dependencies: Vec<String>,
    pub latest_version: Option<Value>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SkillVersionDetail {
    pub id: String,
    pub slug: String,
    pub status: String,
    pub content_sha256: String,
    #[serde(default)]
    pub files: Vec<FileEntry>,
    #[serde(default)]
    pub created_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileEntry {
    pub path: String,
    #[serde(default)]
    pub size_bytes: u64,
    #[serde(default)]
    pub sha256: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct BundlePage {
    pub items: Vec<BundleSummary>,
    #[serde(default)]
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BundleSummary {
    pub slug: String,
    pub name: String,
    pub description: String,
    pub status: String,
    pub enabled: bool,
    #[serde(default)]
    pub skills: Vec<String>,
    #[serde(default)]
    pub resolved_skills_count: Option<u64>,
}

#[derive(Debug, Deserialize)]
pub struct CapabilitiesResponse {
    #[serde(default)]
    pub target_registry: BTreeMap<String, TargetConfig>,
}

/// One entry of the server's target registry. Unknown or partial entries
/// (older servers, local mocks) deserialize with safe defaults.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TargetConfig {
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub global_paths: Vec<String>,
    #[serde(default)]
    pub project_paths: Vec<String>,
    #[serde(default)]
    pub link_strategies: Vec<String>,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Serialize)]
pub struct InstallPlanRequest {
    pub scope: String,
    pub targets: Vec<RequestedTarget>,
    pub installed: Vec<InstalledSkillRequest>,
    pub client: BTreeMap<String, Value>,
    pub include_dependencies: bool,
    pub allow_removals: bool,
    pub dry_run: bool,
}

#[derive(Debug, Serialize)]
pub struct RequestedTarget {
    #[serde(rename = "type")]
    pub target_type: String,
    pub slug: String,
    pub version_id: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct InstalledSkillRequest {
    pub slug: String,
    pub version_id: Option<String>,
    pub content_sha256: Option<String>,
    pub scope: Option<String>,
    pub targets: Vec<String>,
    pub installed_via: Option<String>,
    pub local_source: bool,
}

#[derive(Debug, Deserialize)]
pub struct InstallPlanResponse {
    pub plan_id: String,
    pub operations: Vec<InstallOperation>,
    pub warnings: Vec<Warning>,
}

#[derive(Debug, Deserialize)]
pub struct InstallOperation {
    pub action: String,
    #[serde(default)]
    pub reason: Option<String>,
    pub skill: PlanSkill,
    pub artifact: Option<PlanArtifact>,
    pub installed_via: String,
}

#[derive(Debug, Deserialize)]
pub struct PlanSkill {
    pub slug: String,
    pub version_id: String,
    pub content_sha256: String,
}

#[derive(Debug, Deserialize)]
pub struct PlanArtifact {
    pub id: String,
    pub download_url: String,
    pub sha256: String,
    pub size_bytes: u64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Warning {
    pub code: String,
    pub message: String,
    pub skill: Option<String>,
    pub suggested_action: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstalledSkillMetadata {
    pub schema_version: String,
    pub server_url: String,
    pub slug: String,
    pub version_id: String,
    pub content_sha256: String,
    pub artifact_sha256: String,
    pub artifact_size_bytes: u64,
    pub installed_at: String,
    pub installed_via: String,
    pub source_id: Option<String>,
    pub source_revision: Option<String>,
    pub scope: String,
    pub targets: Vec<String>,
    pub local_source: bool,
    pub pinned: bool,
}
