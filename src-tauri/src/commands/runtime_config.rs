use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::State;

const RUNTIME_CONFIG_DIR_NAME: &str = "runtime-config";
const FAKE_RUNTIME_CONFIG_FILE_NAME: &str = "fake-endpoint.json";
const RUNTIME_CONFIG_SCHEMA_VERSION: u16 = 1;
const DEFAULT_RUNTIME_PROVIDER_ALLOWLIST: &[&str] = &["databricks_v2"];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeConfig {
    pub schema_version: u16,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub customer: Option<RuntimeIdentity>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub workspace: Option<RuntimeIdentity>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub provider_allowlist: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub feature_toggles: Option<HashMap<String, bool>>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub doctor: Option<RuntimeDoctorConfig>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub feedback: Option<RuntimeFeedbackConfig>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub kgoose: Option<RuntimeKgooseConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeIdentity {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub display_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeDoctorConfig {
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub kgoose_connectivity: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub internal_tooling_checks: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeFeedbackConfig {
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub project_key: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeKgooseConfig {
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub base_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub path: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RuntimeConfigSource {
    AppDefault,
    Endpoint,
    FakeEndpoint,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RuntimeConfigUnavailableReason {
    EndpointUnavailable,
    Invalid,
    Missing,
    ReadFailed,
    UnsupportedBuild,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum RuntimeConfigLoadResult {
    Ready {
        source: RuntimeConfigSource,
        config: Box<RuntimeConfig>,
    },
    Unavailable {
        source: RuntimeConfigSource,
        reason: RuntimeConfigUnavailableReason,
        message: String,
    },
}

pub struct RuntimeConfigState {
    fake_config_path: PathBuf,
    cached: Mutex<Option<RuntimeConfigLoadResult>>,
}

impl RuntimeConfigState {
    pub fn new(app_data_dir: PathBuf) -> Self {
        Self {
            fake_config_path: fake_runtime_config_path(&app_data_dir),
            cached: Mutex::new(None),
        }
    }

    pub fn get(&self) -> Result<RuntimeConfigLoadResult, String> {
        let mut cached = self
            .cached
            .lock()
            .map_err(|_| "Runtime config cache lock poisoned".to_string())?;
        if let Some(result) = cached.clone() {
            return Ok(result);
        }

        let result = load_runtime_config_from_source(&self.fake_config_path);
        *cached = Some(result.clone());
        Ok(result)
    }

    pub fn ready_config(&self) -> Result<RuntimeConfig, String> {
        match self.get()? {
            RuntimeConfigLoadResult::Ready { config, .. } => Ok(*config),
            RuntimeConfigLoadResult::Unavailable {
                reason, message, ..
            } => Err(format!(
                "Runtime config unavailable ({reason:?}): {message}"
            )),
        }
    }

    pub fn refresh(&self) -> Result<RuntimeConfigLoadResult, String> {
        let result = load_runtime_config_from_source(&self.fake_config_path);
        self.replace_cache(result)
    }

    #[cfg(debug_assertions)]
    pub fn set_fake_config(
        &self,
        config: RuntimeConfig,
    ) -> Result<RuntimeConfigLoadResult, String> {
        validate_runtime_config(&config)?;
        write_fake_runtime_config_to_path(&self.fake_config_path, &config)?;
        self.replace_cache(RuntimeConfigLoadResult::Ready {
            source: RuntimeConfigSource::FakeEndpoint,
            config: Box::new(config),
        })
    }

    #[cfg(not(debug_assertions))]
    pub fn set_fake_config(
        &self,
        _config: RuntimeConfig,
    ) -> Result<RuntimeConfigLoadResult, String> {
        Ok(unsupported_fake_runtime_config())
    }

    #[cfg(debug_assertions)]
    pub fn clear_fake_config(&self) -> Result<RuntimeConfigLoadResult, String> {
        match std::fs::remove_file(&self.fake_config_path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(format!(
                    "Failed to remove fake runtime config '{}': {error}",
                    self.fake_config_path.display()
                ));
            }
        }

        self.replace_cache(load_runtime_config_from_source(&self.fake_config_path))
    }

    #[cfg(not(debug_assertions))]
    pub fn clear_fake_config(&self) -> Result<RuntimeConfigLoadResult, String> {
        Ok(unsupported_fake_runtime_config())
    }

    fn replace_cache(
        &self,
        result: RuntimeConfigLoadResult,
    ) -> Result<RuntimeConfigLoadResult, String> {
        let mut cached = self
            .cached
            .lock()
            .map_err(|_| "Runtime config cache lock poisoned".to_string())?;
        *cached = Some(result.clone());
        Ok(result)
    }
}

fn fake_runtime_config_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir
        .join(RUNTIME_CONFIG_DIR_NAME)
        .join(FAKE_RUNTIME_CONFIG_FILE_NAME)
}

#[cfg(debug_assertions)]
fn load_runtime_config_from_source(fake_config_path: &Path) -> RuntimeConfigLoadResult {
    read_fake_runtime_config_from_path(fake_config_path)
}

#[cfg(not(debug_assertions))]
fn load_runtime_config_from_source(_fake_config_path: &Path) -> RuntimeConfigLoadResult {
    default_runtime_config_result(RuntimeConfigSource::AppDefault)
}

#[cfg(debug_assertions)]
fn read_fake_runtime_config_from_path(path: &Path) -> RuntimeConfigLoadResult {
    let contents = match std::fs::read_to_string(path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return default_fake_runtime_config_result();
        }
        Err(error) => {
            return RuntimeConfigLoadResult::Unavailable {
                source: RuntimeConfigSource::FakeEndpoint,
                reason: RuntimeConfigUnavailableReason::ReadFailed,
                message: format!(
                    "Failed to read fake runtime config '{}': {error}",
                    path.display()
                ),
            };
        }
    };

    let config = match serde_json::from_str::<RuntimeConfig>(&contents) {
        Ok(config) => config,
        Err(error) => {
            return invalid_fake_runtime_config(format!(
                "Failed to parse fake runtime config '{}': {error}",
                path.display()
            ));
        }
    };

    if let Err(error) = validate_runtime_config(&config) {
        return invalid_fake_runtime_config(format!(
            "Fake runtime config '{}' failed validation: {error}",
            path.display()
        ));
    }

    RuntimeConfigLoadResult::Ready {
        source: RuntimeConfigSource::FakeEndpoint,
        config: Box::new(config),
    }
}

#[cfg(debug_assertions)]
fn default_fake_runtime_config_result() -> RuntimeConfigLoadResult {
    default_runtime_config_result(RuntimeConfigSource::FakeEndpoint)
}

fn default_runtime_config_result(source: RuntimeConfigSource) -> RuntimeConfigLoadResult {
    let config = default_runtime_config();
    if let Err(error) = validate_runtime_config(&config) {
        return RuntimeConfigLoadResult::Unavailable {
            source,
            reason: RuntimeConfigUnavailableReason::Invalid,
            message: format!("Default runtime config failed validation: {error}"),
        };
    }

    RuntimeConfigLoadResult::Ready {
        source,
        config: Box::new(config),
    }
}

fn default_runtime_config() -> RuntimeConfig {
    RuntimeConfig {
        schema_version: RUNTIME_CONFIG_SCHEMA_VERSION,
        customer: None,
        workspace: None,
        provider_allowlist: Some(
            DEFAULT_RUNTIME_PROVIDER_ALLOWLIST
                .iter()
                .map(|provider| (*provider).to_string())
                .collect(),
        ),
        feature_toggles: None,
        doctor: None,
        feedback: None,
        kgoose: None,
    }
}

#[cfg(debug_assertions)]
fn invalid_fake_runtime_config(message: String) -> RuntimeConfigLoadResult {
    RuntimeConfigLoadResult::Unavailable {
        source: RuntimeConfigSource::FakeEndpoint,
        reason: RuntimeConfigUnavailableReason::Invalid,
        message,
    }
}

#[cfg(not(debug_assertions))]
fn unsupported_fake_runtime_config() -> RuntimeConfigLoadResult {
    RuntimeConfigLoadResult::Unavailable {
        source: RuntimeConfigSource::FakeEndpoint,
        reason: RuntimeConfigUnavailableReason::UnsupportedBuild,
        message: "Fake runtime config is only available in non-release builds.".to_string(),
    }
}

#[cfg(debug_assertions)]
fn write_fake_runtime_config_to_path(path: &Path, config: &RuntimeConfig) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| {
            format!(
                "Failed to create fake runtime config directory '{}': {error}",
                parent.display()
            )
        })?;
    }

    let serialized = serde_json::to_vec_pretty(config)
        .map_err(|error| format!("Failed to serialize fake runtime config: {error}"))?;
    std::fs::write(path, serialized).map_err(|error| {
        format!(
            "Failed to write fake runtime config '{}': {error}",
            path.display()
        )
    })
}

fn validate_runtime_config(config: &RuntimeConfig) -> Result<(), String> {
    if config.schema_version != RUNTIME_CONFIG_SCHEMA_VERSION {
        return Err(format!(
            "schemaVersion must be {RUNTIME_CONFIG_SCHEMA_VERSION}"
        ));
    }

    if let Some(customer) = &config.customer {
        validate_identity(customer, "customer")?;
    }
    if let Some(workspace) = &config.workspace {
        validate_identity(workspace, "workspace")?;
    }
    if let Some(provider_allowlist) = &config.provider_allowlist {
        validate_provider_allowlist(provider_allowlist)?;
    }
    if let Some(feature_toggles) = &config.feature_toggles {
        validate_feature_toggles(feature_toggles)?;
    }
    if let Some(feedback) = &config.feedback {
        validate_optional_non_empty(feedback.project_key.as_deref(), "feedback.projectKey")?;
    }
    if let Some(kgoose) = &config.kgoose {
        validate_kgoose(kgoose)?;
    }

    Ok(())
}

fn validate_identity(identity: &RuntimeIdentity, field: &str) -> Result<(), String> {
    validate_non_empty(&identity.id, &format!("{field}.id"))?;
    validate_optional_non_empty(
        identity.display_name.as_deref(),
        &format!("{field}.displayName"),
    )
}

fn validate_provider_allowlist(provider_allowlist: &[String]) -> Result<(), String> {
    let mut seen = HashSet::new();
    for provider_id in provider_allowlist {
        let normalized = provider_id.trim();
        if normalized.is_empty() {
            return Err("providerAllowlist entries must not be empty".to_string());
        }
        if !seen.insert(normalized.to_string()) {
            return Err(format!(
                "providerAllowlist must not contain duplicate entry '{normalized}'"
            ));
        }
    }
    Ok(())
}

fn validate_feature_toggles(feature_toggles: &HashMap<String, bool>) -> Result<(), String> {
    for key in feature_toggles.keys() {
        validate_non_empty(key, "featureToggles keys")?;
    }
    Ok(())
}

fn validate_kgoose(kgoose: &RuntimeKgooseConfig) -> Result<(), String> {
    if let Some(base_url) = kgoose.base_url.as_deref() {
        validate_non_empty(base_url, "kgoose.baseUrl")?;
        let parsed = reqwest::Url::parse(base_url)
            .map_err(|error| format!("kgoose.baseUrl must be a valid URL: {error}"))?;
        if !matches!(parsed.scheme(), "http" | "https") {
            return Err("kgoose.baseUrl must use http or https".to_string());
        }
    }
    validate_optional_non_empty(kgoose.path.as_deref(), "kgoose.path")
}

fn validate_optional_non_empty(value: Option<&str>, field: &str) -> Result<(), String> {
    if let Some(value) = value {
        validate_non_empty(value, field)?;
    }
    Ok(())
}

fn validate_non_empty(value: &str, field: &str) -> Result<(), String> {
    if value.trim().is_empty() {
        return Err(format!("{field} must not be empty"));
    }
    Ok(())
}

#[tauri::command]
pub fn get_runtime_config(
    state: State<'_, RuntimeConfigState>,
) -> Result<RuntimeConfigLoadResult, String> {
    state.get()
}

#[tauri::command]
pub fn refresh_runtime_config(
    state: State<'_, RuntimeConfigState>,
) -> Result<RuntimeConfigLoadResult, String> {
    state.refresh()
}

#[tauri::command]
pub fn set_fake_runtime_config(
    state: State<'_, RuntimeConfigState>,
    config: RuntimeConfig,
) -> Result<RuntimeConfigLoadResult, String> {
    state.set_fake_config(config)
}

#[tauri::command]
pub fn clear_fake_runtime_config(
    state: State<'_, RuntimeConfigState>,
) -> Result<RuntimeConfigLoadResult, String> {
    state.clear_fake_config()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn valid_config() -> RuntimeConfig {
        RuntimeConfig {
            schema_version: RUNTIME_CONFIG_SCHEMA_VERSION,
            customer: Some(RuntimeIdentity {
                id: "block".to_string(),
                display_name: Some("Block".to_string()),
            }),
            workspace: Some(RuntimeIdentity {
                id: "berd".to_string(),
                display_name: None,
            }),
            provider_allowlist: Some(vec!["databricks_v2".to_string(), "openai".to_string()]),
            feature_toggles: Some(HashMap::from([("doctor".to_string(), true)])),
            doctor: Some(RuntimeDoctorConfig {
                enabled: Some(true),
                kgoose_connectivity: Some(true),
                internal_tooling_checks: Some(false),
            }),
            feedback: Some(RuntimeFeedbackConfig {
                enabled: Some(true),
                project_key: Some("BERD".to_string()),
            }),
            kgoose: Some(RuntimeKgooseConfig {
                base_url: Some("https://kgoose.example.test/".to_string()),
                path: Some("cash-app/goose".to_string()),
            }),
        }
    }

    #[test]
    fn validates_complete_runtime_config() {
        assert!(validate_runtime_config(&valid_config()).is_ok());
    }

    #[test]
    fn rejects_invalid_runtime_config() {
        let mut config = valid_config();
        config.schema_version = 2;
        assert_eq!(
            validate_runtime_config(&config).unwrap_err(),
            "schemaVersion must be 1"
        );

        let mut config = valid_config();
        config.provider_allowlist = Some(vec!["openai".to_string(), " openai ".to_string()]);
        assert!(validate_runtime_config(&config)
            .unwrap_err()
            .contains("duplicate entry 'openai'"));

        let mut config = valid_config();
        config.kgoose = Some(RuntimeKgooseConfig {
            base_url: Some("file:///tmp/kgoose".to_string()),
            path: None,
        });
        assert_eq!(
            validate_runtime_config(&config).unwrap_err(),
            "kgoose.baseUrl must use http or https"
        );
    }

    #[test]
    fn default_fake_runtime_config_is_valid() {
        assert!(validate_runtime_config(&default_runtime_config()).is_ok());
    }

    #[test]
    fn default_runtime_config_uses_databricks_provider_allowlist() {
        assert_eq!(
            default_runtime_config().provider_allowlist,
            Some(vec!["databricks_v2".to_string()])
        );
    }

    #[test]
    fn fake_runtime_config_uses_default_when_no_config_is_saved() {
        let dir = tempdir().unwrap();
        let result = read_fake_runtime_config_from_path(&dir.path().join("missing.json"));

        assert_eq!(
            result,
            RuntimeConfigLoadResult::Ready {
                source: RuntimeConfigSource::FakeEndpoint,
                config: Box::new(default_runtime_config()),
            }
        );
    }

    #[test]
    fn fake_runtime_config_round_trips_saved_config() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("nested").join("fake-endpoint.json");
        let config = valid_config();

        write_fake_runtime_config_to_path(&path, &config).unwrap();
        let result = read_fake_runtime_config_from_path(&path);

        assert_eq!(
            result,
            RuntimeConfigLoadResult::Ready {
                source: RuntimeConfigSource::FakeEndpoint,
                config: Box::new(config),
            }
        );
    }

    #[test]
    fn fake_runtime_config_reports_invalid_saved_config() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("fake-endpoint.json");
        std::fs::write(
            &path,
            br#"{"schemaVersion":1,"providerAllowlist":["openai"," openai "]}"#,
        )
        .unwrap();

        let result = read_fake_runtime_config_from_path(&path);

        match result {
            RuntimeConfigLoadResult::Unavailable {
                source,
                reason,
                message,
            } => {
                assert_eq!(source, RuntimeConfigSource::FakeEndpoint);
                assert_eq!(reason, RuntimeConfigUnavailableReason::Invalid);
                assert!(message.contains("duplicate entry 'openai'"));
            }
            RuntimeConfigLoadResult::Ready { .. } => panic!("expected invalid config"),
        }
    }

    #[test]
    fn state_caches_get_until_refresh() {
        let dir = tempdir().unwrap();
        let state = RuntimeConfigState::new(dir.path().to_path_buf());
        let path = fake_runtime_config_path(dir.path());

        assert_eq!(
            state.get().unwrap(),
            RuntimeConfigLoadResult::Ready {
                source: RuntimeConfigSource::FakeEndpoint,
                config: Box::new(default_runtime_config()),
            }
        );

        let config = valid_config();
        write_fake_runtime_config_to_path(&path, &config).unwrap();
        assert_eq!(
            state.get().unwrap(),
            RuntimeConfigLoadResult::Ready {
                source: RuntimeConfigSource::FakeEndpoint,
                config: Box::new(default_runtime_config()),
            }
        );
        assert_eq!(
            state.refresh().unwrap(),
            RuntimeConfigLoadResult::Ready {
                source: RuntimeConfigSource::FakeEndpoint,
                config: Box::new(config),
            }
        );
    }

    #[test]
    fn state_clear_fake_config_restores_default_response() {
        let dir = tempdir().unwrap();
        let state = RuntimeConfigState::new(dir.path().to_path_buf());
        let path = fake_runtime_config_path(dir.path());

        write_fake_runtime_config_to_path(&path, &valid_config()).unwrap();
        assert!(matches!(
            state.refresh().unwrap(),
            RuntimeConfigLoadResult::Ready {
                config,
                ..
            } if config.as_ref() != &default_runtime_config()
        ));

        assert_eq!(
            state.clear_fake_config().unwrap(),
            RuntimeConfigLoadResult::Ready {
                source: RuntimeConfigSource::FakeEndpoint,
                config: Box::new(default_runtime_config()),
            }
        );
        assert!(!path.exists());
    }

    #[test]
    fn ready_config_uses_default_fake_config_when_no_config_is_saved() {
        let dir = tempdir().unwrap();
        let state = RuntimeConfigState::new(dir.path().to_path_buf());

        assert_eq!(state.ready_config().unwrap(), default_runtime_config());
    }

    #[test]
    fn ready_config_reports_invalid_saved_fake_config() {
        let dir = tempdir().unwrap();
        let state = RuntimeConfigState::new(dir.path().to_path_buf());
        let path = fake_runtime_config_path(dir.path());
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(
            &path,
            br#"{"schemaVersion":1,"providerAllowlist":["openai"," openai "]}"#,
        )
        .unwrap();

        let error = state
            .ready_config()
            .expect_err("invalid config should block runtime consumers");

        assert!(error.contains("Runtime config unavailable"));
        assert!(error.contains("Invalid"));
        assert!(error.contains("duplicate entry 'openai'"));
    }
}
