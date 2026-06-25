//! API and local DTOs for `bb skills`.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Deserialize)]
pub struct MeResponse {
    pub tenant_id: String,
    pub subject: String,
}

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
    pub channel: String,
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
    pub tenant_id: String,
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

/// One `bb config` preference key. [`PREFERENCE_KEYS`] is the single source
/// of truth for the key list: `bb config` builds its help text and
/// unknown-key errors from it.
pub struct PreferenceKeySpec {
    pub key: &'static str,
    pub help: &'static str,
}

/// Keep in sync with the fields of [`SkillsPreferences`] below (and the
/// get/set match arms in `skills.rs`); adding a field without an entry here
/// leaves it undocumented and unsettable.
pub const PREFERENCE_KEYS: &[PreferenceKeySpec] = &[
    PreferenceKeySpec {
        key: "org",
        help: "Org used for access",
    },
    PreferenceKeySpec {
        key: "channel",
        help: "release channel for installs/updates (default: stable)",
    },
    PreferenceKeySpec {
        key: "targets",
        help: "comma-separated default install targets (default: agents)",
    },
    PreferenceKeySpec {
        key: "install_strategy",
        help: "symlink | copy (default: symlink)",
    },
    PreferenceKeySpec {
        key: "no_auto_updates",
        help: "true | false (default: false)",
    },
];

/// User preferences stored in `~/.bb/config.yaml`. Every field needs a
/// matching [`PREFERENCE_KEYS`] entry.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SkillsPreferences {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub org: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub channel: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub targets: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub install_strategy: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub no_auto_updates: Option<bool>,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Drift guard for PREFERENCE_KEYS: the exhaustive struct literal stops
    /// compiling when a SkillsPreferences field is added, and the assertions
    /// catch a missing or stale key entry.
    #[test]
    fn preference_keys_match_skills_preferences_fields() {
        let populated = SkillsPreferences {
            org: Some("test".to_string()),
            channel: Some("stable".to_string()),
            targets: vec!["agents".to_string()],
            install_strategy: Some("symlink".to_string()),
            no_auto_updates: Some(false),
        };
        let yaml = serde_yaml::to_value(&populated).expect("serialize preferences");
        let fields = yaml
            .as_mapping()
            .expect("preferences serialize to a mapping")
            .keys()
            .map(|key| key.as_str().expect("string key").to_string())
            .collect::<Vec<_>>();
        let keys = PREFERENCE_KEYS
            .iter()
            .map(|spec| spec.key)
            .collect::<Vec<_>>();
        for field in &fields {
            assert!(
                keys.contains(&field.as_str()),
                "SkillsPreferences field `{field}` is missing from PREFERENCE_KEYS"
            );
        }
        for key in &keys {
            assert!(
                fields.iter().any(|field| field == key),
                "PREFERENCE_KEYS entry `{key}` has no SkillsPreferences field"
            );
        }
    }
}
