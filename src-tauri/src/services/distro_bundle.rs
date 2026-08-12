use crate::services::kgoose;
use serde::{Deserialize, Serialize};
use std::env;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};
use url::Url;

const DISTRO_DIR_NAME: &str = "distro";
const DISTRO_JSON_NAME: &str = "distro.json";
const DISTRO_CONFIG_NAME: &str = "config.yaml";
const DISTRO_BIN_DIR_NAME: &str = "bin";
const SKILL_ID_TEMPLATE_PLACEHOLDER: &str = "{skillId}";
const MAX_MARKETPLACE_TEMPLATE_LENGTH: usize = 2_048;

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DistroManifest {
    pub app_version: Option<String>,
    pub kgoose: Option<KgooseDistroConfig>,
    pub diagnostics: Option<DiagnosticsDistroConfig>,
    pub distribution: Option<DistributionDistroConfig>,
    pub marketplace: Option<MarketplaceDistroConfig>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketplaceDistroConfig {
    pub skill_url_template: String,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum DiagnosticsCheck {
    SqAgentTools,
}

impl DiagnosticsCheck {
    pub fn id(self) -> &'static str {
        match self {
            Self::SqAgentTools => "sq-agent-tools",
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DiagnosticsDistroConfig {
    checks: Vec<DiagnosticsCheck>,
}

impl DiagnosticsDistroConfig {
    pub fn enables(&self, check_id: &str) -> bool {
        self.checks.iter().any(|check| check.id() == check_id)
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DistributionDistroConfig {
    npm_registry_url: String,
    node_dist_base_url: String,
}

impl DistributionDistroConfig {
    pub fn npm_registry_url(&self) -> &str {
        &self.npm_registry_url
    }

    pub fn node_dist_base_url(&self) -> &str {
        &self.node_dist_base_url
    }
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KgooseDistroConfig {
    pub base_url: Option<String>,
    pub path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DistroBundleInfo {
    pub present: bool,
    pub kgoose_configured: bool,
    #[serde(flatten)]
    pub manifest: DistroManifest,
}

#[derive(Debug, Clone)]
pub struct DistroBundle {
    pub root_dir: PathBuf,
    pub config_path: Option<PathBuf>,
    pub bin_dir: Option<PathBuf>,
    pub manifest: DistroManifest,
}

pub struct DistroBundleState {
    bundle: Option<DistroBundle>,
}

impl DistroBundleState {
    pub fn new(app_handle: &AppHandle) -> Self {
        let bundle = load_distro_bundle(app_handle)
            .map_err(|error| {
                log::warn!("Failed to load distro bundle: {error}");
                error
            })
            .ok()
            .flatten();

        Self { bundle }
    }

    #[cfg(test)]
    pub(crate) fn empty_for_tests() -> Self {
        Self { bundle: None }
    }

    #[cfg(test)]
    pub(crate) fn with_kgoose_for_tests(kgoose: KgooseDistroConfig) -> Self {
        Self {
            bundle: Some(DistroBundle {
                root_dir: PathBuf::new(),
                config_path: None,
                bin_dir: None,
                manifest: DistroManifest {
                    app_version: None,
                    kgoose: Some(kgoose),
                    diagnostics: None,
                    distribution: None,
                    marketplace: None,
                },
            }),
        }
    }

    #[cfg(test)]
    pub(crate) fn with_diagnostics_for_tests(checks: Vec<DiagnosticsCheck>) -> Self {
        Self {
            bundle: Some(DistroBundle {
                root_dir: PathBuf::new(),
                config_path: None,
                bin_dir: None,
                manifest: DistroManifest {
                    app_version: None,
                    kgoose: None,
                    diagnostics: Some(DiagnosticsDistroConfig { checks }),
                    distribution: None,
                    marketplace: None,
                },
            }),
        }
    }

    pub fn info(
        &self,
        runtime_config: Option<&crate::commands::runtime_config::RuntimeKgooseConfig>,
    ) -> DistroBundleInfo {
        let Some(bundle) = &self.bundle else {
            return DistroBundleInfo {
                present: false,
                kgoose_configured: kgoose::is_configured(runtime_config, None),
                manifest: DistroManifest::default(),
            };
        };

        DistroBundleInfo {
            present: true,
            kgoose_configured: kgoose::is_configured(
                runtime_config,
                bundle.manifest.kgoose.as_ref(),
            ),
            manifest: bundle.manifest.clone(),
        }
    }

    pub fn bundle(&self) -> Option<&DistroBundle> {
        self.bundle.as_ref()
    }

    pub fn kgoose_config(&self) -> Option<&KgooseDistroConfig> {
        self.bundle
            .as_ref()
            .and_then(|bundle| bundle.manifest.kgoose.as_ref())
    }

    pub fn diagnostics_config(&self) -> Option<&DiagnosticsDistroConfig> {
        self.bundle
            .as_ref()
            .and_then(|bundle| bundle.manifest.diagnostics.as_ref())
    }

    pub fn distribution_config(&self) -> Option<&DistributionDistroConfig> {
        self.bundle
            .as_ref()
            .and_then(|bundle| bundle.manifest.distribution.as_ref())
    }
}

fn load_distro_bundle(app_handle: &AppHandle) -> Result<Option<DistroBundle>, String> {
    let Some(root_dir) = resolve_distro_root(app_handle)? else {
        return Ok(None);
    };

    Ok(Some(load_distro_bundle_from_root(root_dir)?))
}

fn load_distro_bundle_from_root(root_dir: PathBuf) -> Result<DistroBundle, String> {
    let manifest_path = root_dir.join(DISTRO_JSON_NAME);
    let manifest = if manifest_path.exists() {
        read_manifest(&manifest_path)?
    } else {
        DistroManifest::default()
    };
    let config_path = root_dir.join(DISTRO_CONFIG_NAME);
    let bin_dir = root_dir.join(DISTRO_BIN_DIR_NAME);

    Ok(DistroBundle {
        root_dir,
        config_path: config_path.exists().then_some(config_path),
        bin_dir: bin_dir.is_dir().then_some(bin_dir),
        manifest,
    })
}

fn resolve_distro_root(app_handle: &AppHandle) -> Result<Option<PathBuf>, String> {
    if let Ok(override_dir) = env::var("GOOSE_DISTRO_DIR") {
        let path = PathBuf::from(override_dir);
        if path.is_dir() {
            return Ok(Some(path));
        }
        return Err(format!(
            "GOOSE_DISTRO_DIR points to a non-directory path: {}",
            path.display()
        ));
    }

    let resource_dir = app_handle
        .path()
        .resource_dir()
        .map_err(|error| format!("Failed to resolve Tauri resource dir: {error}"))?;
    let distro_dir = resource_dir.join(DISTRO_DIR_NAME);

    Ok(distro_dir.is_dir().then_some(distro_dir))
}

fn read_manifest(path: &Path) -> Result<DistroManifest, String> {
    let contents = std::fs::read_to_string(path).map_err(|error| {
        format!(
            "Failed to read distro manifest '{}': {error}",
            path.display()
        )
    })?;

    let mut manifest = serde_json::from_str::<DistroManifest>(&contents).map_err(|error| {
        format!(
            "Failed to parse distro manifest '{}': {error}",
            path.display()
        )
    })?;

    if let Some(distribution) = manifest.distribution.as_mut() {
        validate_distribution_config(distribution)?;
    }
    if let Some(marketplace) = manifest.marketplace.as_ref() {
        validate_marketplace_config(marketplace)?;
    }

    Ok(manifest)
}

fn validate_marketplace_config(config: &MarketplaceDistroConfig) -> Result<(), String> {
    let template = &config.skill_url_template;
    if template.len() > MAX_MARKETPLACE_TEMPLATE_LENGTH {
        return Err(format!(
            "marketplace.skillUrlTemplate must not exceed {MAX_MARKETPLACE_TEMPLATE_LENGTH} bytes"
        ));
    }
    if template.matches(SKILL_ID_TEMPLATE_PLACEHOLDER).count() != 1 {
        return Err(format!(
            "marketplace.skillUrlTemplate must contain exactly one {SKILL_ID_TEMPLATE_PLACEHOLDER} placeholder"
        ));
    }

    let placeholder_index = template
        .find(SKILL_ID_TEMPLATE_PLACEHOLDER)
        .expect("exactly one placeholder was validated");
    let authority_start = template
        .find("://")
        .map(|index| index + 3)
        .unwrap_or_default();
    let authority_end = template[authority_start..]
        .find(['/', '?', '#'])
        .map(|index| authority_start + index)
        .unwrap_or(template.len());
    if placeholder_index < authority_end {
        return Err(
            "marketplace.skillUrlTemplate placeholder must appear in the path or query".to_string(),
        );
    }

    let without_placeholder = template.replace(SKILL_ID_TEMPLATE_PLACEHOLDER, "skill-id");
    if without_placeholder.contains('{') || without_placeholder.contains('}') {
        return Err(
            "marketplace.skillUrlTemplate must not contain unknown placeholders".to_string(),
        );
    }
    let url = Url::parse(&without_placeholder).map_err(|error| {
        format!("marketplace.skillUrlTemplate must be a valid URL template: {error}")
    })?;
    if url.scheme() != "https" {
        return Err("marketplace.skillUrlTemplate must use HTTPS".to_string());
    }
    if url.host_str().is_none() {
        return Err("marketplace.skillUrlTemplate must include a host".to_string());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("marketplace.skillUrlTemplate must not include credentials".to_string());
    }
    if url.fragment().is_some() {
        return Err("marketplace.skillUrlTemplate must not include a fragment".to_string());
    }
    Ok(())
}

fn validate_distribution_config(config: &mut DistributionDistroConfig) -> Result<(), String> {
    for (name, value) in [
        ("npmRegistryUrl", &mut config.npm_registry_url),
        ("nodeDistBaseUrl", &mut config.node_dist_base_url),
    ] {
        let mut url = Url::parse(value)
            .map_err(|error| format!("distribution.{name} must be a valid URL: {error}"))?;
        if url.scheme() != "https" {
            return Err(format!("distribution.{name} must use HTTPS"));
        }
        if url.host_str().is_none() {
            return Err(format!("distribution.{name} must include a host"));
        }
        if !url.username().is_empty() || url.password().is_some() {
            return Err(format!("distribution.{name} must not include credentials"));
        }
        if url.query().is_some() || url.fragment().is_some() {
            return Err(format!(
                "distribution.{name} must not include a query or fragment"
            ));
        }
        if !url.path().ends_with('/') {
            url.set_path(&format!("{}/", url.path()));
        }
        *value = url.into();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::env_lock;

    #[test]
    fn info_reports_kgoose_unconfigured_without_an_explicit_endpoint() {
        let _guard = env_lock().lock().expect("env lock");
        env::remove_var("KGOOSE_BASE_URL");

        assert!(
            !DistroBundleState::empty_for_tests()
                .info(None)
                .kgoose_configured
        );
    }

    #[test]
    fn info_reports_explicit_distro_kgoose_endpoint() {
        let _guard = env_lock().lock().expect("env lock");
        env::remove_var("KGOOSE_BASE_URL");
        let state = DistroBundleState {
            bundle: Some(DistroBundle {
                root_dir: PathBuf::new(),
                config_path: None,
                bin_dir: None,
                manifest: DistroManifest {
                    app_version: None,
                    kgoose: Some(KgooseDistroConfig {
                        base_url: Some("https://kgoose.example.test/".to_string()),
                        path: None,
                    }),
                    diagnostics: None,
                    distribution: None,
                    marketplace: None,
                },
            }),
        };

        assert!(state.info(None).kgoose_configured);
    }

    #[test]
    fn loads_bundle_assets_without_manifest() {
        let root_dir = tempfile::tempdir().expect("temp distro root");
        let config_path = root_dir.path().join(DISTRO_CONFIG_NAME);
        let bin_dir = root_dir.path().join(DISTRO_BIN_DIR_NAME);
        std::fs::write(&config_path, "extensions: {}\n").expect("write config");
        std::fs::create_dir(&bin_dir).expect("create bin dir");

        let bundle = load_distro_bundle_from_root(root_dir.path().to_path_buf())
            .expect("bundle should load without manifest");

        assert_eq!(bundle.root_dir, root_dir.path());
        assert_eq!(bundle.config_path.as_deref(), Some(config_path.as_path()));
        assert_eq!(bundle.bin_dir.as_deref(), Some(bin_dir.as_path()));
        assert!(bundle.manifest.app_version.is_none());
        assert!(bundle.manifest.kgoose.is_none());
        assert!(bundle.manifest.diagnostics.is_none());
    }

    #[test]
    fn parses_closed_diagnostics_checks() {
        let manifest = parse_manifest(r#"{"diagnostics":{"checks":["sqAgentTools"]}}"#)
            .expect("known diagnostic check should parse");
        let diagnostics = manifest
            .diagnostics
            .as_ref()
            .expect("diagnostics should be present");
        assert!(diagnostics.enables("sq-agent-tools"));
        assert!(!diagnostics.enables("arbitrary-command"));
        assert_eq!(
            serde_json::to_value(&manifest).expect("diagnostics should serialize")["diagnostics"],
            serde_json::json!({"checks": ["sqAgentTools"]})
        );
    }

    #[test]
    fn rejects_unknown_diagnostics_checks_and_fields() {
        for json in [
            r#"{"diagnostics":{"checks":["shellCommand"]}}"#,
            r#"{"diagnostics":{"checks":[],"command":"sq agent-tools --version"}}"#,
        ] {
            assert!(
                parse_manifest(json).is_err(),
                "manifest should fail: {json}"
            );
        }
    }

    #[test]
    fn parses_partial_manifest() {
        let manifest = parse_manifest(
            r#"{
                "appVersion": "development",
                "kgoose": {
                    "baseUrl": "https://kgoose.example.test/",
                    "path": "example/goose"
                }
            }"#,
        )
        .expect("manifest should parse");

        let kgoose = manifest.kgoose.as_ref().expect("kgoose should parse");

        assert_eq!(manifest.app_version.as_deref(), Some("development"));
        assert_eq!(
            kgoose.base_url.as_deref(),
            Some("https://kgoose.example.test/")
        );
        assert_eq!(kgoose.path.as_deref(), Some("example/goose"));
        assert!(manifest.distribution.is_none());
        assert!(manifest.marketplace.is_none());
    }

    #[test]
    fn parses_complete_distribution_and_normalizes_base_urls() {
        let manifest = parse_manifest(r#"{"distribution":{"npmRegistryUrl":"https://packages.example.test/npm","nodeDistBaseUrl":"https://node.example.test"}}"#).expect("complete distribution should parse");
        let distribution = manifest
            .distribution
            .expect("distribution should be present");
        assert_eq!(
            distribution.npm_registry_url(),
            "https://packages.example.test/npm/"
        );
        assert_eq!(
            distribution.node_dist_base_url(),
            "https://node.example.test/"
        );
    }

    #[test]
    fn rejects_partial_distribution() {
        let error = parse_manifest(
            r#"{"distribution":{"npmRegistryUrl":"https://packages.example.test/"}}"#,
        )
        .expect_err("partial distribution should be rejected");
        assert!(error.contains("missing field"), "{error}");
    }

    #[test]
    fn rejects_insecure_or_credential_bearing_distribution_urls() {
        for url in [
            "http://packages.example.test/npm/",
            "https://user:password@packages.example.test/npm/",
        ] {
            let error = parse_manifest(&distribution_manifest(url)).expect_err("URL should fail");
            assert!(
                error.contains("must use HTTPS") || error.contains("must not include credentials"),
                "{error}"
            );
        }
    }

    #[test]
    fn parses_marketplace_skill_url_template() {
        let manifest = parse_manifest(
            r#"{"marketplace":{"skillUrlTemplate":"https://marketplace.example.test/skills/skill?id={skillId}"}}"#,
        )
        .expect("marketplace template should parse");

        assert_eq!(
            manifest
                .marketplace
                .expect("marketplace should be present")
                .skill_url_template,
            "https://marketplace.example.test/skills/skill?id={skillId}"
        );
    }

    #[test]
    fn rejects_unsafe_or_malformed_marketplace_templates() {
        for template in [
            "http://marketplace.example.test/skill?id={skillId}",
            "https://user:password@marketplace.example.test/skill?id={skillId}",
            "https://marketplace.example.test/skill?id={skillId}#fragment",
            "https://marketplace.example.test/skill",
            "https://marketplace.example.test/{skillId}/{skillId}",
            "https://{skillId}.marketplace.example.test/skills/skill",
            "https://marketplace.example.test:{skillId}/skills/skill",
            "https://marketplace.example.test/skill?id={unknown}",
        ] {
            let contents = format!(r#"{{"marketplace":{{"skillUrlTemplate":"{template}"}}}}"#);
            parse_manifest(&contents).expect_err("template should be rejected");
        }
    }

    fn parse_manifest(contents: &str) -> Result<DistroManifest, String> {
        let path = tempfile::NamedTempFile::new().expect("temporary manifest");
        std::fs::write(path.path(), contents).expect("write temporary manifest");
        read_manifest(path.path())
    }

    fn distribution_manifest(npm_registry_url: &str) -> String {
        format!(
            r#"{{"distribution":{{"npmRegistryUrl":"{npm_registry_url}","nodeDistBaseUrl":"https://node.example.test/dist/"}}}}"#
        )
    }
}
