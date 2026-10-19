use crate::services::distro_bundle::DistroBundleState;
#[cfg(feature = "admin-runtime-config")]
use crate::services::kgoose;
#[cfg(any(feature = "admin-runtime-config", test))]
use chrono::Utc;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;
use tauri::State;

const NEW_CHAT_RUNTIME_CONFIG_TIMEOUT: Duration = Duration::from_secs(5);

const RUNTIME_CONFIG_DIR_NAME: &str = "runtime-config";
const FAKE_RUNTIME_CONFIG_FILE_NAME: &str = "fake-endpoint.json";
const ADMIN_RUNTIME_CONFIG_CACHE_FILE_NAME: &str = "admin-cache.json";
// Bundled runtime config staged into the Tauri resource dir (see the `resources`
// map in `tauri.conf.json`). When the `admin-runtime-config` feature is disabled
// (the default) this file is the runtime config source of truth, replacing the
// compiled-in `default_runtime_config()`.
pub(crate) const BUNDLED_RUNTIME_CONFIG_FILE_NAME: &str = "runtime-config.json";
#[cfg(feature = "admin-runtime-config")]
pub(crate) const RUNTIME_CONFIG_ENDPOINT: &str = "desktop/v1/runtime-config";
const RUNTIME_CONFIG_SCHEMA_VERSION: u16 = 1;
#[cfg(any(feature = "admin-runtime-config", test))]
const ADMIN_CACHE_SCHEMA_VERSION: u16 = 1;
#[cfg(feature = "admin-runtime-config")]
const ADMIN_RUNTIME_CONFIG_REQUEST_TIMEOUT: Duration = Duration::from_secs(5);
const ADMIN_OWNED_CUSTOM_PROVIDER_ID: &str = "block_openai_compatible";
#[cfg(debug_assertions)]
const BYO_KEY_PROVIDERS_ENV: &str = "VITE_BYO_KEY_PROVIDERS";
const ALLOWED_ENDPOINT_ENV_KEYS: &[&str] = &["DATABRICKS_HOST"];

#[cfg(debug_assertions)]
pub(crate) fn local_byo_key_providers_enabled() -> bool {
    std::env::var(BYO_KEY_PROVIDERS_ENV).as_deref() == Ok("1")
}

#[cfg(not(debug_assertions))]
pub(crate) fn local_byo_key_providers_enabled() -> bool {
    false
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeConfig {
    pub schema_version: u16,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub customer: Option<RuntimeIdentity>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub workspace: Option<RuntimeIdentity>,
    pub goose: RuntimeGooseConfig,
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
pub struct RuntimeGooseConfig {
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub default_model_provider_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub default_model_id: Option<String>,
    pub model_providers: Vec<RuntimeGooseModelProvider>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub auto_routing: Option<RuntimeAutoRoutingConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeAutoRoutingConfig {
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub bearer_token_env: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub timeout_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub route_selector: Option<RuntimeRouteSelector>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub default_mode_id: Option<String>,
    pub modes: Vec<RuntimeAutoRoutingMode>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RuntimeRouteSelector {
    pub router_name: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub config: Option<serde_json::Map<String, serde_json::Value>>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeAutoRoutingMode {
    pub id: String,
    pub display_name: String,
    pub model_provider_id: String,
    pub fallback: RuntimeAutoRoutingFallback,
    pub models: Vec<RuntimeAutoRoutingModel>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeAutoRoutingFallback {
    pub model_id: String,
    pub effort: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeAutoRoutingModel {
    pub model_id: String,
    pub router_model: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub harness: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub min_effort: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub max_effort: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeGooseModelProvider {
    pub id: String,
    pub display_name: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub setup_method: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub group: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub aliases: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub native_connect_query: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub custom_provider: Option<RuntimeCustomProvider>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub endpoint_env: Option<HashMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub model_inventory_mode: Option<String>,
    /// Optional allowlist for provider-discovered model IDs. Runtime-declared
    /// models remain available regardless of this discovery policy.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub allowed_model_id_prefixes: Option<Vec<String>>,
    /// Model Goose's lightweight "fast" tasks run on (exported to `goose
    /// serve` as GOOSE_FAST_MODEL). A served endpoint id the provider must be
    /// able to route (databricks_v2 routes by model-name substring, e.g. a
    /// `claude` id takes the Anthropic Messages route), not necessarily one
    /// of `models` — fast models are not surfaced in the picker. Stock berd
    /// defaults declare none; a distribution supplies one at release time via
    /// scripts/set-runtime-config-distribution.ts.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub fast_model_id: Option<String>,
    pub models: Vec<RuntimeGooseModel>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeCustomProvider {
    pub provider_id: String,
    pub engine: String,
    pub display_name: String,
    pub api_url: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub base_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub models: Option<Vec<String>>,
    pub requires_auth: bool,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub supports_streaming: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub preserves_thinking: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub headers: Option<HashMap<String, String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeGooseModel {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub recommended: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub featured: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub context_limit: Option<i64>,
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
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub response_rating_enabled: Option<bool>,
    /// Per-eligible-completion opportunity hazard, not a session allocation.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub session_survey_sampling_rate_basis_points: Option<u16>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeKgooseConfig {
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub base_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub path: Option<String>,
}

#[cfg(any(feature = "admin-runtime-config", test))]
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RuntimeConfigAdminCache {
    cache_schema_version: u16,
    fetched_at: String,
    source_url: String,
    config: RuntimeConfig,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RuntimeConfigSource {
    AppDefault,
    BundledFile,
    CachedEndpoint,
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
        /// Opaque native fingerprint. Callers echo it without re-encoding the
        /// configuration, whose free JSON numbers can change in JavaScript.
        #[serde(
            rename = "autoRoutingRevision",
            skip_serializing_if = "Option::is_none",
            default
        )]
        auto_routing_revision: Option<String>,
    },
    Unavailable {
        source: RuntimeConfigSource,
        reason: RuntimeConfigUnavailableReason,
        message: String,
    },
}

impl RuntimeConfigLoadResult {
    fn ready(source: RuntimeConfigSource, config: RuntimeConfig) -> Self {
        let revision = config
            .goose
            .auto_routing
            .as_ref()
            .map(auto_routing_revision)
            .transpose();
        match revision {
            Ok(auto_routing_revision) => Self::Ready {
                source,
                config: Box::new(config),
                auto_routing_revision,
            },
            Err(message) => Self::Unavailable {
                source,
                reason: RuntimeConfigUnavailableReason::Invalid,
                message,
            },
        }
    }
}

/// Hash only native-owned data. In particular, never recreate this revision
/// from renderer JSON: JavaScript rounds integers and normalizes float types.
pub(crate) fn auto_routing_revision(config: &RuntimeAutoRoutingConfig) -> Result<String, String> {
    let encoded = serde_json::to_vec(config)
        .map_err(|_| "Failed to encode Auto routing revision".to_string())?;
    Ok(hex::encode(Sha256::digest(encoded)))
}

pub struct RuntimeConfigState {
    fake_config_path: PathBuf,
    admin_cache_path: PathBuf,
    bundled_config_path: Option<PathBuf>,
    cached: Mutex<RuntimeConfigCache>,
}

#[derive(Default)]
struct RuntimeConfigCache {
    generation: u64,
    current: Option<RuntimeConfigLoadResult>,
    // Compiled defaults are a development fallback, not evidence that a
    // configured routing mode was deliberately removed from the source.
    last_valid: Option<RuntimeConfigLoadResult>,
}

impl RuntimeConfigState {
    pub fn new(app_data_dir: PathBuf, bundled_config_path: Option<PathBuf>) -> Self {
        Self {
            fake_config_path: fake_runtime_config_path(&app_data_dir),
            admin_cache_path: admin_cache_path(&app_data_dir),
            bundled_config_path,
            cached: Mutex::new(RuntimeConfigCache::default()),
        }
    }

    pub async fn get(
        &self,
        distro_state: &DistroBundleState,
    ) -> Result<RuntimeConfigLoadResult, String> {
        let generation = {
            let mut cached = self
                .cached
                .lock()
                .map_err(|_| "Runtime config cache lock poisoned".to_string())?;
            if let Some(result) = &cached.current {
                return Ok(result.clone());
            }
            cached.generation += 1;
            cached.generation
        };
        let result = load_runtime_config_from_source(
            &self.fake_config_path,
            &self.admin_cache_path,
            self.bundled_config_path.as_deref(),
            distro_state,
            true,
        )
        .await;
        self.finish_load(generation, result, false)
    }

    pub async fn ready_config(
        &self,
        distro_state: &DistroBundleState,
    ) -> Result<RuntimeConfig, String> {
        match self.get(distro_state).await? {
            RuntimeConfigLoadResult::Ready { config, .. } => Ok(*config),
            RuntimeConfigLoadResult::Unavailable {
                reason, message, ..
            } => Err(format!(
                "Runtime config unavailable ({reason:?}): {message}"
            )),
        }
    }

    pub async fn refresh(
        &self,
        distro_state: &DistroBundleState,
    ) -> Result<RuntimeConfigLoadResult, String> {
        let generation = self.begin_load()?;
        let result = load_runtime_config_from_source(
            &self.fake_config_path,
            &self.admin_cache_path,
            self.bundled_config_path.as_deref(),
            distro_state,
            true,
        )
        .await;
        self.finish_load(generation, result, false)
    }

    #[cfg(debug_assertions)]
    pub fn set_fake_config(
        &self,
        config: RuntimeConfig,
    ) -> Result<RuntimeConfigLoadResult, String> {
        validate_runtime_config(&config)?;
        let generation = {
            let mut cached = self
                .cached
                .lock()
                .map_err(|_| "Runtime config cache lock poisoned".to_string())?;
            write_fake_runtime_config_to_path(&self.fake_config_path, &config)?;
            cached.generation += 1;
            cached.generation
        };
        self.finish_load(
            generation,
            RuntimeConfigLoadResult::ready(RuntimeConfigSource::FakeEndpoint, config),
            false,
        )
    }

    #[cfg(not(debug_assertions))]
    pub fn set_fake_config(
        &self,
        _config: RuntimeConfig,
    ) -> Result<RuntimeConfigLoadResult, String> {
        Ok(unsupported_fake_runtime_config())
    }

    #[cfg(debug_assertions)]
    pub async fn clear_fake_config(
        &self,
        distro_state: &DistroBundleState,
    ) -> Result<RuntimeConfigLoadResult, String> {
        let generation = {
            let mut cached = self
                .cached
                .lock()
                .map_err(|_| "Runtime config cache lock poisoned".to_string())?;
            match std::fs::remove_file(&self.fake_config_path) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => {
                    return Err(format!(
                        "Failed to remove fake runtime config '{}': {error}",
                        self.fake_config_path.display()
                    ))
                }
            }
            if matches!(
                &cached.last_valid,
                Some(RuntimeConfigLoadResult::Ready {
                    source: RuntimeConfigSource::FakeEndpoint,
                    ..
                })
            ) {
                cached.last_valid = None;
            }
            cached.generation += 1;
            cached.generation
        };
        let result = load_runtime_config_from_source(
            &self.fake_config_path,
            &self.admin_cache_path,
            self.bundled_config_path.as_deref(),
            distro_state,
            true,
        )
        .await;
        self.finish_load(generation, result, false)
    }

    #[cfg(not(debug_assertions))]
    pub async fn clear_fake_config(
        &self,
        _distro_state: &DistroBundleState,
    ) -> Result<RuntimeConfigLoadResult, String> {
        Ok(unsupported_fake_runtime_config())
    }

    /// Refresh the source for a new chat without discarding a working config
    /// when the source is temporarily unavailable. The returned value is also
    /// the effective config read by native routing commands.
    pub async fn refresh_for_new_chat(
        &self,
        distro_state: &DistroBundleState,
    ) -> Result<RuntimeConfigLoadResult, String> {
        self.refresh_for_new_chat_with(
            load_runtime_config_from_source(
                &self.fake_config_path,
                &self.admin_cache_path,
                self.bundled_config_path.as_deref(),
                distro_state,
                false,
            ),
            NEW_CHAT_RUNTIME_CONFIG_TIMEOUT,
        )
        .await
    }

    async fn refresh_for_new_chat_with(
        &self,
        load: impl Future<Output = RuntimeConfigLoadResult>,
        timeout: Duration,
    ) -> Result<RuntimeConfigLoadResult, String> {
        let generation = self.begin_load()?;
        let result = tokio::time::timeout(timeout, load)
            .await
            .unwrap_or_else(|_| {
                runtime_config_refresh_unavailable("Runtime config refresh timed out".to_string())
            });
        self.finish_load(generation, result, true)
    }

    fn begin_load(&self) -> Result<u64, String> {
        let mut cached = self
            .cached
            .lock()
            .map_err(|_| "Runtime config cache lock poisoned".to_string())?;
        cached.generation += 1;
        Ok(cached.generation)
    }

    fn finish_load(
        &self,
        generation: u64,
        result: RuntimeConfigLoadResult,
        retain_last_valid: bool,
    ) -> Result<RuntimeConfigLoadResult, String> {
        let result = runtime_config_load_result_for_local_byo_dev(result);
        let mut cached = self
            .cached
            .lock()
            .map_err(|_| "Runtime config cache lock poisoned".to_string())?;
        if generation != cached.generation {
            return Ok(cached.current.clone().unwrap_or_else(|| {
                runtime_config_refresh_unavailable(
                    "A newer runtime config refresh is pending".to_string(),
                )
            }));
        }
        let result =
            if retain_last_valid && matches!(result, RuntimeConfigLoadResult::Unavailable { .. }) {
                cached
                    .last_valid
                    .clone()
                    .or_else(|| {
                        // Defaults still support unrelated native operations. Their
                        // AppDefault source remains non-authoritative for Auto intent.
                        cached.current.clone().filter(|current| {
                            matches!(
                                current,
                                RuntimeConfigLoadResult::Ready {
                                    source: RuntimeConfigSource::AppDefault,
                                    ..
                                }
                            )
                        })
                    })
                    .unwrap_or(result)
            } else {
                result
            };
        if matches!(&result, RuntimeConfigLoadResult::Ready { source, .. } if *source != RuntimeConfigSource::AppDefault)
        {
            cached.last_valid = Some(result.clone());
        }
        cached.current = Some(result.clone());
        Ok(result)
    }
}

fn fake_runtime_config_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir
        .join(RUNTIME_CONFIG_DIR_NAME)
        .join(FAKE_RUNTIME_CONFIG_FILE_NAME)
}
fn admin_cache_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir
        .join(RUNTIME_CONFIG_DIR_NAME)
        .join(ADMIN_RUNTIME_CONFIG_CACHE_FILE_NAME)
}

async fn load_runtime_config_from_source(
    fake_config_path: &Path,
    cache_path: &Path,
    bundled_config_path: Option<&Path>,
    distro_state: &DistroBundleState,
    allow_default_fallback: bool,
) -> RuntimeConfigLoadResult {
    #[cfg(debug_assertions)]
    {
        let path = fake_config_path.to_owned();
        match tokio::task::spawn_blocking(move || {
            path.exists()
                .then(|| read_fake_runtime_config_from_path(&path))
        })
        .await
        {
            Ok(Some(result)) => return result,
            Ok(None) => {}
            Err(error) => return runtime_config_refresh_unavailable(error.to_string()),
        }
    }
    #[cfg(not(debug_assertions))]
    let _ = fake_config_path;

    #[cfg(feature = "admin-runtime-config")]
    {
        let _ = bundled_config_path;
        match fetch_admin_runtime_config(distro_state).await {
            Ok((config, source_url)) => {
                let path = cache_path.to_owned();
                let cache_config = config.clone();
                match tokio::task::spawn_blocking(move || {
                    write_admin_cache_to_path(&path, &cache_config, &source_url)
                })
                .await
                {
                    Ok(Ok(())) => {}
                    error => log::warn!("failed to write admin runtime config cache: {error:?}"),
                }
                return RuntimeConfigLoadResult::ready(RuntimeConfigSource::Endpoint, config);
            }
            Err(error) => {
                log::warn!("failed to fetch admin runtime config: {error}");
                if !allow_default_fallback {
                    return runtime_config_refresh_unavailable(error);
                }
            }
        }

        match read_admin_cache_from_path(cache_path) {
            Ok(cache) => {
                log::info!("using cached admin runtime config");
                return RuntimeConfigLoadResult::ready(
                    RuntimeConfigSource::CachedEndpoint,
                    cache.config,
                );
            }
            Err(error) => log::warn!("failed to read cached admin runtime config: {error}"),
        }

        default_runtime_config_result(RuntimeConfigSource::AppDefault)
    }

    #[cfg(not(feature = "admin-runtime-config"))]
    {
        // The admin runtime config endpoint is compiled out, so the bundled
        // runtime-config.json is the source of truth. A stale admin cache must
        // not shadow it, so the cache is intentionally ignored in this mode.
        let _ = (cache_path, distro_state);
        let path = bundled_config_path.map(Path::to_owned);
        tokio::task::spawn_blocking(move || {
            load_bundled_runtime_config_from_source(
                path.as_deref(),
                allow_default_fallback && allow_bundled_runtime_config_default_fallback(),
            )
        })
        .await
        .unwrap_or_else(|error| runtime_config_refresh_unavailable(error.to_string()))
    }
}

fn runtime_config_refresh_unavailable(message: String) -> RuntimeConfigLoadResult {
    RuntimeConfigLoadResult::Unavailable {
        source: if cfg!(feature = "admin-runtime-config") {
            RuntimeConfigSource::Endpoint
        } else {
            RuntimeConfigSource::BundledFile
        },
        reason: if cfg!(feature = "admin-runtime-config") {
            RuntimeConfigUnavailableReason::EndpointUnavailable
        } else {
            RuntimeConfigUnavailableReason::ReadFailed
        },
        message,
    }
}

#[cfg(feature = "admin-runtime-config")]
async fn fetch_admin_runtime_config(
    distro_state: &DistroBundleState,
) -> Result<(RuntimeConfig, String), String> {
    let url = kgoose::build_bootstrap_url(RUNTIME_CONFIG_ENDPOINT, distro_state.kgoose_config())?;
    let source_url = url.as_str().to_string();
    let value =
        kgoose::get_json_url_with_timeout(url, ADMIN_RUNTIME_CONFIG_REQUEST_TIMEOUT).await?;
    let config: RuntimeConfig = serde_json::from_value(value)
        .map_err(|error| format!("failed to parse admin runtime config: {error}"))?;
    validate_runtime_config(&config)?;
    Ok((config, source_url))
}

/// Read the bundled `runtime-config.json` staged into the Tauri resource dir.
/// Used as the runtime config source of truth when the `admin-runtime-config`
/// feature is disabled.
#[cfg(not(feature = "admin-runtime-config"))]
fn load_bundled_runtime_config_from_source(
    bundled_config_path: Option<&Path>,
    allow_default_fallback: bool,
) -> RuntimeConfigLoadResult {
    match bundled_config_path {
        Some(path) if path.exists() => match read_bundled_runtime_config_from_path(path) {
            Ok(config) => {
                log::info!("using bundled runtime config '{}'", path.display());
                RuntimeConfigLoadResult::ready(RuntimeConfigSource::BundledFile, config)
            }
            Err((reason, message)) => bundled_runtime_config_unavailable_or_default(
                reason,
                message,
                allow_default_fallback,
            ),
        },
        Some(path) => bundled_runtime_config_unavailable_or_default(
            RuntimeConfigUnavailableReason::Missing,
            format!("Bundled runtime config '{}' not found", path.display()),
            allow_default_fallback,
        ),
        None => bundled_runtime_config_unavailable_or_default(
            RuntimeConfigUnavailableReason::Missing,
            "Bundled runtime config path unavailable".to_string(),
            allow_default_fallback,
        ),
    }
}

#[cfg(not(feature = "admin-runtime-config"))]
fn allow_bundled_runtime_config_default_fallback() -> bool {
    cfg!(any(debug_assertions, test))
}

#[cfg(not(feature = "admin-runtime-config"))]
fn bundled_runtime_config_unavailable_or_default(
    reason: RuntimeConfigUnavailableReason,
    message: String,
    allow_default_fallback: bool,
) -> RuntimeConfigLoadResult {
    if allow_default_fallback {
        log::warn!("{message}; using compiled-in default runtime config");
        return default_runtime_config_result(RuntimeConfigSource::AppDefault);
    }

    log::error!("{message}");
    RuntimeConfigLoadResult::Unavailable {
        source: RuntimeConfigSource::BundledFile,
        reason,
        message,
    }
}

#[cfg(not(feature = "admin-runtime-config"))]
fn read_bundled_runtime_config_from_path(
    path: &Path,
) -> Result<RuntimeConfig, (RuntimeConfigUnavailableReason, String)> {
    let contents = std::fs::read_to_string(path).map_err(|error| {
        (
            RuntimeConfigUnavailableReason::ReadFailed,
            format!(
                "Failed to read bundled runtime config '{}': {error}",
                path.display()
            ),
        )
    })?;
    let config = serde_json::from_str::<RuntimeConfig>(&contents).map_err(|error| {
        (
            RuntimeConfigUnavailableReason::Invalid,
            format!(
                "Failed to parse bundled runtime config '{}': {error}",
                path.display()
            ),
        )
    })?;
    validate_runtime_config(&config).map_err(|error| {
        (
            RuntimeConfigUnavailableReason::Invalid,
            format!(
                "Bundled runtime config '{}' failed validation: {error}",
                path.display()
            ),
        )
    })?;
    Ok(config)
}

#[cfg(debug_assertions)]
fn read_fake_runtime_config_from_path(path: &Path) -> RuntimeConfigLoadResult {
    let contents = match std::fs::read_to_string(path) {
        Ok(contents) => contents,
        Err(error) => {
            return RuntimeConfigLoadResult::Unavailable {
                source: RuntimeConfigSource::FakeEndpoint,
                reason: if error.kind() == std::io::ErrorKind::NotFound {
                    RuntimeConfigUnavailableReason::Missing
                } else {
                    RuntimeConfigUnavailableReason::ReadFailed
                },
                message: format!(
                    "Failed to read fake runtime config '{}': {error}",
                    path.display()
                ),
            }
        }
    };
    let config = match serde_json::from_str::<RuntimeConfig>(&contents) {
        Ok(config) => config,
        Err(error) => {
            return invalid_fake_runtime_config(format!(
                "Failed to parse fake runtime config '{}': {error}",
                path.display()
            ))
        }
    };
    if let Err(error) = validate_runtime_config(&config) {
        return invalid_fake_runtime_config(format!(
            "Fake runtime config '{}' failed validation: {error}",
            path.display()
        ));
    }
    RuntimeConfigLoadResult::ready(RuntimeConfigSource::FakeEndpoint, config)
}

#[cfg(any(feature = "admin-runtime-config", test))]
fn read_admin_cache_from_path(path: &Path) -> Result<RuntimeConfigAdminCache, String> {
    let contents = std::fs::read_to_string(path).map_err(|error| {
        format!(
            "Failed to read admin runtime config cache '{}': {error}",
            path.display()
        )
    })?;
    let cache: RuntimeConfigAdminCache = serde_json::from_str(&contents).map_err(|error| {
        format!(
            "Failed to parse admin runtime config cache '{}': {error}",
            path.display()
        )
    })?;
    if cache.cache_schema_version != ADMIN_CACHE_SCHEMA_VERSION {
        return Err(format!(
            "admin runtime config cache schema must be {ADMIN_CACHE_SCHEMA_VERSION}"
        ));
    }
    validate_runtime_config(&cache.config)?;
    Ok(cache)
}

#[cfg(any(feature = "admin-runtime-config", test))]
fn write_admin_cache_to_path(
    path: &Path,
    config: &RuntimeConfig,
    source_url: &str,
) -> Result<(), String> {
    validate_runtime_config(config)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| {
            format!(
                "Failed to create admin runtime config cache directory '{}': {error}",
                parent.display()
            )
        })?;
    }
    let cache = RuntimeConfigAdminCache {
        cache_schema_version: ADMIN_CACHE_SCHEMA_VERSION,
        fetched_at: Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        source_url: source_url.to_string(),
        config: config.clone(),
    };
    let serialized = serde_json::to_vec_pretty(&cache)
        .map_err(|error| format!("Failed to serialize admin runtime config cache: {error}"))?;
    std::fs::write(path, serialized).map_err(|error| {
        format!(
            "Failed to write admin runtime config cache '{}': {error}",
            path.display()
        )
    })
}

fn runtime_config_load_result_for_local_byo_dev(
    result: RuntimeConfigLoadResult,
) -> RuntimeConfigLoadResult {
    #[cfg(debug_assertions)]
    if local_byo_key_providers_enabled() {
        return match result {
            RuntimeConfigLoadResult::Ready { source, config, .. }
                if matches!(
                    source,
                    RuntimeConfigSource::AppDefault | RuntimeConfigSource::BundledFile
                ) =>
            {
                let mut config = *config;
                clear_default_databricks_distribution_config(&mut config);
                RuntimeConfigLoadResult::ready(source, config)
            }
            other => other,
        };
    }

    result
}

/// Strip the default provider's distribution-owned endpoint, fast-model, and
/// model-discovery policy so BYO-key dev sessions keep their own provider's
/// endpoint and models. This covers dev only (`cfg(debug_assertions)`); the
/// release-build twin is the BYO strip jq in scripts/release/build-macos.sh.
#[cfg(debug_assertions)]
pub(crate) fn clear_default_databricks_distribution_config(config: &mut RuntimeConfig) {
    let Some(default_provider_id) = config.goose.default_model_provider_id.as_deref() else {
        return;
    };
    let Some(provider) = config
        .goose
        .model_providers
        .iter_mut()
        .find(|provider| provider.id == default_provider_id)
    else {
        return;
    };
    provider.fast_model_id = None;
    provider.allowed_model_id_prefixes = None;
    let Some(endpoint_env) = provider.endpoint_env.as_mut() else {
        return;
    };

    endpoint_env.remove("DATABRICKS_HOST");
    if endpoint_env.is_empty() {
        provider.endpoint_env = None;
    }
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
    RuntimeConfigLoadResult::ready(source, config)
}

pub(crate) fn default_runtime_config() -> RuntimeConfig {
    RuntimeConfig {
        schema_version: RUNTIME_CONFIG_SCHEMA_VERSION,
        customer: None,
        workspace: None,
        goose: default_goose_config(),
        feature_toggles: None,
        doctor: None,
        feedback: None,
        kgoose: None,
    }
}

pub(crate) fn default_goose_config() -> RuntimeGooseConfig {
    RuntimeGooseConfig {
        default_model_provider_id: None,
        default_model_id: None,
        auto_routing: None,
        model_providers: vec![],
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
    validate_goose_config(&config.goose)?;
    if let Some(feature_toggles) = &config.feature_toggles {
        validate_feature_toggles(feature_toggles)?;
    }
    if let Some(feedback) = &config.feedback {
        validate_optional_non_empty(feedback.project_key.as_deref(), "feedback.projectKey")?;
        if feedback.session_survey_sampling_rate_basis_points > Some(10_000) {
            return Err(
                "feedback.sessionSurveySamplingRateBasisPoints must be at most 10000".to_string(),
            );
        }
    }
    if let Some(kgoose) = &config.kgoose {
        validate_kgoose(kgoose)?;
    }
    Ok(())
}

fn validate_goose_config(goose: &RuntimeGooseConfig) -> Result<(), String> {
    if let Some(config) = &goose.auto_routing {
        validate_auto_routing(config, &goose.model_providers)?;
    }
    validate_optional_runtime_id(
        goose.default_model_provider_id.as_deref(),
        "goose.defaultModelProviderId",
    )?;
    validate_optional_runtime_id(goose.default_model_id.as_deref(), "goose.defaultModelId")?;

    if goose.model_providers.is_empty() {
        if goose.default_model_provider_id.is_some() {
            return Err(
                "goose.defaultModelProviderId must be omitted when goose.modelProviders is empty"
                    .to_string(),
            );
        }
        if goose.default_model_id.is_some() {
            return Err(
                "goose.defaultModelId must be omitted when goose.modelProviders is empty"
                    .to_string(),
            );
        }
        return Ok(());
    }

    let default_provider_id = goose.default_model_provider_id.as_deref().ok_or_else(|| {
        "goose.defaultModelProviderId is required when goose.modelProviders is not empty"
            .to_string()
    })?;
    let mut provider_ids = HashSet::new();
    for provider in &goose.model_providers {
        validate_runtime_id(&provider.id, "goose.modelProviders.id")?;
        if !provider_ids.insert(provider.id.clone()) {
            return Err(format!(
                "goose.modelProviders must not contain duplicate provider '{}'",
                provider.id
            ));
        }
        validate_non_empty(&provider.display_name, "goose.modelProviders.displayName")?;
        validate_optional_non_empty(
            provider.description.as_deref(),
            "goose.modelProviders.description",
        )?;
        validate_optional_non_empty(
            provider.setup_method.as_deref(),
            "goose.modelProviders.setupMethod",
        )?;
        if let Some(setup_method) = provider.setup_method.as_deref() {
            validate_provider_setup_method(setup_method)?;
        }
        validate_optional_non_empty(provider.group.as_deref(), "goose.modelProviders.group")?;
        if let Some(group) = provider.group.as_deref() {
            validate_provider_group(group)?;
        }
        if let Some(aliases) = &provider.aliases {
            validate_provider_allowlist(aliases)?;
        }
        if let Some(custom_provider) = &provider.custom_provider {
            validate_custom_provider(custom_provider, &provider.id)?;
        }
        if let Some(endpoint_env) = &provider.endpoint_env {
            validate_endpoint_env(endpoint_env)?;
        }
        validate_optional_non_empty(
            provider.model_inventory_mode.as_deref(),
            "goose.modelProviders.modelInventoryMode",
        )?;
        if let Some(mode) = provider.model_inventory_mode.as_deref() {
            validate_model_inventory_mode(mode)?;
        }
        if let Some(prefixes) = &provider.allowed_model_id_prefixes {
            if provider.id != "databricks_v2" {
                return Err(
                    "goose.modelProviders.allowedModelIdPrefixes is supported only for databricks_v2"
                        .to_string(),
                );
            }
            if prefixes.is_empty() {
                return Err(
                    "goose.modelProviders.allowedModelIdPrefixes must not be empty".to_string(),
                );
            }
            let mut seen_prefixes = HashSet::new();
            for prefix in prefixes {
                validate_runtime_id(
                    prefix,
                    "goose.modelProviders.allowedModelIdPrefixes entries",
                )?;
                if !seen_prefixes.insert(prefix) {
                    return Err(format!(
                        "goose.modelProviders.allowedModelIdPrefixes must not contain duplicate entry '{prefix}'"
                    ));
                }
            }
        }
        validate_optional_runtime_id(
            provider.fast_model_id.as_deref(),
            "goose.modelProviders.fastModelId",
        )?;

        let mut model_ids = HashSet::new();
        for model in &provider.models {
            validate_runtime_id(&model.id, "goose.modelProviders.models.id")?;
            if !model_ids.insert(model.id.clone()) {
                return Err(format!(
                    "goose.modelProvider '{}' contains duplicate model '{}'",
                    provider.id, model.id
                ));
            }
            validate_non_empty(&model.name, "goose.modelProviders.models.name")?;
            if matches!(model.context_limit, Some(limit) if limit <= 0) {
                return Err("goose.modelProviders.models.contextLimit must be positive".to_string());
            }
        }
    }
    if !provider_ids.contains(default_provider_id) {
        return Err("goose.defaultModelProviderId must reference goose.modelProviders".to_string());
    }
    Ok(())
}

fn normalized_router_model(value: &str) -> String {
    let chars: Vec<char> = value
        .strip_prefix("system.ai.")
        .unwrap_or(value)
        .chars()
        .collect();
    chars
        .iter()
        .enumerate()
        .map(|(index, c)| {
            if *c == '.'
                && index > 0
                && chars[index - 1].is_ascii_digit()
                && chars.get(index + 1).is_some_and(char::is_ascii_digit)
            {
                '-'
            } else {
                *c
            }
        })
        .collect()
}

fn effort_rank(value: &str) -> Result<usize, String> {
    ["none", "minimal", "low", "medium", "high", "xhigh", "max"]
        .iter()
        .position(|item| *item == value)
        .ok_or_else(|| "autoRouting effort has unsupported value".to_string())
}
fn validate_router_json(value: &serde_json::Value) -> Result<(), String> {
    match value {
        serde_json::Value::Object(map) => {
            for (key, item) in map {
                if [
                    "secret",
                    "token",
                    "apikey",
                    "api-key",
                    "api_key",
                    "password",
                    "authorization",
                    "bearer",
                ]
                .iter()
                .any(|word| key.to_lowercase().contains(word))
                {
                    return Err("autoRouting routeSelector must not contain secrets".to_string());
                }
                validate_router_json(item)?;
            }
        }
        serde_json::Value::Array(items) => {
            for item in items {
                validate_router_json(item)?;
            }
        }
        serde_json::Value::String(item)
            if item.to_lowercase().contains("bearer ")
                || (item.contains("-----BEGIN") && item.contains("PRIVATE KEY")) =>
        {
            return Err("autoRouting routeSelector must not contain secrets".to_string())
        }
        _ => (),
    }
    Ok(())
}
fn validate_auto_routing(
    config: &RuntimeAutoRoutingConfig,
    providers: &[RuntimeGooseModelProvider],
) -> Result<(), String> {
    validate_runtime_id(&config.url, "autoRouting.url")?;
    let url = reqwest::Url::parse(&config.url)
        .map_err(|_| "autoRouting url must be valid".to_string())?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(
            "autoRouting url must be http or https without credentials, query or fragment"
                .to_string(),
        );
    }
    if let Some(name) = &config.bearer_token_env {
        let mut chars = name.chars();
        if !chars
            .next()
            .is_some_and(|c| c.is_ascii_uppercase() || c == '_')
            || !chars.all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
        {
            return Err(
                "autoRouting bearerTokenEnv must be an environment variable name".to_string(),
            );
        }
    }
    if matches!(config.timeout_ms, Some(0 | 120001..)) {
        return Err("autoRouting timeoutMs must be between 1 and 120000".to_string());
    }
    if let Some(selector) = &config.route_selector {
        validate_runtime_id(
            &selector.router_name,
            "autoRouting.routeSelector.router_name",
        )?;
        validate_router_json(
            &serde_json::to_value(selector).map_err(|_| "Invalid routeSelector".to_string())?,
        )?;
    }
    if config.modes.is_empty() {
        return Err("autoRouting modes must not be empty".to_string());
    }
    let mut ids = HashSet::new();
    for mode in &config.modes {
        validate_runtime_id(&mode.id, "autoRouting.mode.id")?;
        validate_non_empty(&mode.display_name, "autoRouting.mode.displayName")?;
        validate_runtime_id(&mode.model_provider_id, "autoRouting.mode.modelProviderId")?;
        if !ids.insert(&mode.id) {
            return Err("autoRouting modes must have unique ids".to_string());
        }
        if !providers
            .iter()
            .any(|provider| provider.id == mode.model_provider_id)
        {
            return Err("autoRouting modelProviderId must reference modelProviders".to_string());
        }
        if mode.models.is_empty() {
            return Err("autoRouting models must not be empty".to_string());
        }
        let mut models = HashSet::new();
        let mut routes = HashSet::new();
        for model in &mode.models {
            validate_runtime_id(&model.model_id, "autoRouting.modelId")?;
            validate_runtime_id(&model.router_model, "autoRouting.routerModel")?;
            validate_optional_runtime_id(model.harness.as_deref(), "autoRouting.harness")?;
            if !models.insert(&model.model_id)
                || !routes.insert((
                    normalized_router_model(&model.router_model),
                    model.harness.as_deref().unwrap_or("codex"),
                ))
            {
                return Err(
                    "autoRouting models must have unique modelIds and router model/harness pairs"
                        .to_string(),
                );
            }
            if effort_rank(model.min_effort.as_deref().unwrap_or("none"))?
                > effort_rank(model.max_effort.as_deref().unwrap_or("max"))?
            {
                return Err("autoRouting minEffort must not exceed maxEffort".to_string());
            }
        }
        let fallback = mode
            .models
            .iter()
            .find(|model| model.model_id == mode.fallback.model_id)
            .ok_or("autoRouting fallback must reference a candidate model")?;
        let effort = effort_rank(&mode.fallback.effort)?;
        if effort < effort_rank(fallback.min_effort.as_deref().unwrap_or("none"))?
            || effort > effort_rank(fallback.max_effort.as_deref().unwrap_or("max"))?
        {
            return Err("autoRouting fallback effort must be within candidate bounds".to_string());
        }
    }
    validate_optional_runtime_id(
        config.default_mode_id.as_deref(),
        "autoRouting.defaultModeId",
    )?;
    if config
        .default_mode_id
        .as_ref()
        .is_some_and(|id| !ids.contains(id))
    {
        return Err("autoRouting defaultModeId must reference a mode".to_string());
    }
    Ok(())
}

fn validate_custom_provider(
    provider: &RuntimeCustomProvider,
    parent_provider_id: &str,
) -> Result<(), String> {
    validate_runtime_id(&provider.provider_id, "customProvider.providerId")?;
    if provider.provider_id != parent_provider_id {
        return Err("customProvider.providerId must match containing modelProvider id".to_string());
    }
    if provider.provider_id == ADMIN_OWNED_CUSTOM_PROVIDER_ID
        && provider.engine != "openai_compatible"
    {
        return Err(
            "admin custom provider block_openai_compatible must use engine openai_compatible"
                .to_string(),
        );
    }
    validate_non_empty(&provider.engine, "customProvider.engine")?;
    validate_non_empty(&provider.display_name, "customProvider.displayName")?;
    validate_non_empty(&provider.api_url, "customProvider.apiUrl")?;
    let parsed = reqwest::Url::parse(&provider.api_url)
        .map_err(|error| format!("customProvider.apiUrl must be a valid URL: {error}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("customProvider.apiUrl must use http or https".to_string());
    }
    validate_optional_non_empty(provider.base_path.as_deref(), "customProvider.basePath")?;
    if provider.requires_auth {
        return Err("customProvider.requiresAuth must be false for runtime config".to_string());
    }
    if let Some(models) = &provider.models {
        validate_provider_allowlist(models)?;
    }
    if let Some(headers) = &provider.headers {
        validate_non_secret_map(headers, "customProvider.headers")?;
    }
    Ok(())
}

fn validate_provider_setup_method(value: &str) -> Result<(), String> {
    if matches!(
        value,
        "none"
            | "single_api_key"
            | "config_fields"
            | "host_with_oauth_fallback"
            | "oauth_browser"
            | "oauth_device_code"
            | "cloud_credentials"
            | "local"
            | "cli_auth"
    ) {
        Ok(())
    } else {
        Err(format!(
            "goose.modelProviders.setupMethod has unsupported value '{value}'"
        ))
    }
}

fn validate_provider_group(value: &str) -> Result<(), String> {
    if matches!(value, "default" | "additional") {
        Ok(())
    } else {
        Err(format!(
            "goose.modelProviders.group has unsupported value '{value}'"
        ))
    }
}

fn validate_model_inventory_mode(value: &str) -> Result<(), String> {
    if matches!(value, "authoritative" | "refreshable") {
        Ok(())
    } else {
        Err(format!(
            "goose.modelProviders.modelInventoryMode has unsupported value '{value}'"
        ))
    }
}

fn validate_endpoint_env(values: &HashMap<String, String>) -> Result<(), String> {
    for (key, value) in values {
        validate_non_empty(key, "endpointEnv keys")?;
        validate_non_empty(value, &format!("endpointEnv.{key}"))?;
        if !is_allowed_endpoint_env_key(key) {
            return Err(format!(
                "endpointEnv key '{key}' is not allowed for runtime config"
            ));
        }
        if contains_endpoint_env_secret_token(value) {
            return Err(format!(
                "endpointEnv must not contain secret-looking value for key '{key}'"
            ));
        }
    }
    Ok(())
}

fn is_allowed_endpoint_env_key(key: &str) -> bool {
    ALLOWED_ENDPOINT_ENV_KEYS.contains(&key)
}

fn contains_endpoint_env_secret_token(value: &str) -> bool {
    let upper = value.to_ascii_uppercase();
    [
        "KEY",
        "TOKEN",
        "SECRET",
        "PASSWORD",
        "AUTHORIZATION",
        "BEARER",
    ]
    .iter()
    .any(|token| upper.contains(token))
}

fn validate_non_secret_map(values: &HashMap<String, String>, field: &str) -> Result<(), String> {
    for (key, value) in values {
        validate_non_empty(key, &format!("{field} keys"))?;
        validate_non_empty(value, &format!("{field}.{key}"))?;
        let lowered = format!("{} {}", key, value).to_ascii_lowercase();
        for token in [
            "secret",
            "token",
            "apikey",
            "api-key",
            "api_key",
            "password",
            "authorization",
            "bearer",
        ] {
            if lowered.contains(token) {
                return Err(format!(
                    "{field} must not contain secret-looking key or value '{key}'"
                ));
            }
        }
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
fn validate_optional_runtime_id(value: Option<&str>, field: &str) -> Result<(), String> {
    if let Some(value) = value {
        validate_runtime_id(value, field)?;
    }
    Ok(())
}
fn validate_runtime_id(value: &str, field: &str) -> Result<(), String> {
    validate_non_empty(value, field)?;
    if value != value.trim() {
        return Err(format!(
            "{field} must not have leading or trailing whitespace"
        ));
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
pub async fn get_runtime_config(
    state: State<'_, RuntimeConfigState>,
    distro_state: State<'_, DistroBundleState>,
) -> Result<RuntimeConfigLoadResult, String> {
    state.get(distro_state.inner()).await
}

#[tauri::command]
pub async fn refresh_runtime_config(
    state: State<'_, RuntimeConfigState>,
    distro_state: State<'_, DistroBundleState>,
) -> Result<RuntimeConfigLoadResult, String> {
    state.refresh(distro_state.inner()).await
}

#[tauri::command]
pub async fn refresh_runtime_config_for_new_chat(
    state: State<'_, RuntimeConfigState>,
    distro_state: State<'_, DistroBundleState>,
) -> Result<RuntimeConfigLoadResult, String> {
    state.refresh_for_new_chat(distro_state.inner()).await
}

#[tauri::command]
pub fn set_fake_runtime_config(
    state: State<'_, RuntimeConfigState>,
    config: RuntimeConfig,
) -> Result<RuntimeConfigLoadResult, String> {
    state.set_fake_config(config)
}

#[tauri::command]
pub async fn clear_fake_runtime_config(
    state: State<'_, RuntimeConfigState>,
    distro_state: State<'_, DistroBundleState>,
) -> Result<RuntimeConfigLoadResult, String> {
    state.clear_fake_config(distro_state.inner()).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::distro_bundle::DistroBundleState;
    use tempfile::tempdir;

    const TEST_RUNTIME_PROVIDER_ID: &str = "databricks_v2";
    const TEST_RUNTIME_MODEL_ID: &str = "goose-gpt-5-5";

    fn managed_goose_config() -> RuntimeGooseConfig {
        RuntimeGooseConfig {
            auto_routing: None,
            default_model_provider_id: Some(TEST_RUNTIME_PROVIDER_ID.to_string()),
            default_model_id: Some(TEST_RUNTIME_MODEL_ID.to_string()),
            model_providers: vec![RuntimeGooseModelProvider {
                id: TEST_RUNTIME_PROVIDER_ID.to_string(),
                display_name: "Databricks AI Gateway".to_string(),
                description: None,
                setup_method: None,
                group: None,
                aliases: None,
                native_connect_query: None,
                custom_provider: None,
                endpoint_env: None,
                model_inventory_mode: Some("refreshable".to_string()),
                allowed_model_id_prefixes: None,
                fast_model_id: None,
                models: vec![RuntimeGooseModel {
                    id: TEST_RUNTIME_MODEL_ID.to_string(),
                    name: "GPT-5.5".to_string(),
                    recommended: Some(true),
                    featured: None,
                    context_limit: None,
                }],
            }],
        }
    }

    fn valid_config() -> RuntimeConfig {
        RuntimeConfig {
            schema_version: RUNTIME_CONFIG_SCHEMA_VERSION,
            customer: Some(RuntimeIdentity {
                id: "customer-1".to_string(),
                display_name: Some("Customer One".to_string()),
            }),
            workspace: Some(RuntimeIdentity {
                id: "workspace-1".to_string(),
                display_name: Some("Workspace One".to_string()),
            }),
            goose: default_goose_config(),
            feature_toggles: Some(HashMap::from([("doctor".to_string(), true)])),
            doctor: Some(RuntimeDoctorConfig {
                enabled: Some(true),
                kgoose_connectivity: Some(false),
                internal_tooling_checks: Some(true),
            }),
            feedback: Some(RuntimeFeedbackConfig {
                enabled: Some(true),
                project_key: Some("BOT".to_string()),
                response_rating_enabled: Some(true),
                session_survey_sampling_rate_basis_points: Some(250),
            }),
            kgoose: Some(RuntimeKgooseConfig {
                base_url: Some("https://kgoose.example.test".to_string()),
                path: Some("cash-app/goose".to_string()),
            }),
        }
    }

    fn custom_provider() -> RuntimeCustomProvider {
        RuntimeCustomProvider {
            provider_id: ADMIN_OWNED_CUSTOM_PROVIDER_ID.to_string(),
            engine: "openai_compatible".to_string(),
            display_name: "Block AI Gateway".to_string(),
            api_url: "https://example.internal/openai/v1".to_string(),
            base_path: Some("/v1".to_string()),
            models: Some(vec!["goose-gpt-5-5".to_string()]),
            requires_auth: false,
            supports_streaming: Some(true),
            preserves_thinking: Some(false),
            headers: Some(HashMap::from([(
                "X-Goose-Runtime".to_string(),
                "enabled".to_string(),
            )])),
        }
    }

    fn temp_state() -> (tempfile::TempDir, RuntimeConfigState) {
        let dir = tempdir().expect("temp dir");
        let state = RuntimeConfigState::new(dir.path().to_path_buf(), None);
        (dir, state)
    }

    #[cfg(not(feature = "admin-runtime-config"))]
    fn restricted_bundled_config() -> RuntimeConfig {
        let mut config = default_runtime_config();
        config.feature_toggles = Some(HashMap::from([
            ("voiceDictation".to_string(), false),
            ("telemetry".to_string(), false),
        ]));
        config
    }

    #[cfg(not(feature = "admin-runtime-config"))]
    fn write_bundled_config(path: &Path, config: &RuntimeConfig) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("create bundled config dir");
        }
        std::fs::write(
            path,
            serde_json::to_vec_pretty(config).expect("serialize bundled config"),
        )
        .expect("write bundled config");
    }

    // Build a state whose bundled config path lives under the temp dir. When
    // `bundled` is provided, the file is written; otherwise the path is supplied
    // but the file is absent (exercising the missing-file fallback).
    #[cfg(not(feature = "admin-runtime-config"))]
    fn temp_state_with_bundled(
        bundled: Option<&RuntimeConfig>,
    ) -> (tempfile::TempDir, RuntimeConfigState) {
        let dir = tempdir().expect("temp dir");
        let bundled_path = dir
            .path()
            .join("resources")
            .join(BUNDLED_RUNTIME_CONFIG_FILE_NAME);
        if let Some(config) = bundled {
            write_bundled_config(&bundled_path, config);
        }
        let state = RuntimeConfigState::new(dir.path().to_path_buf(), Some(bundled_path));
        (dir, state)
    }

    fn empty_distro_state() -> DistroBundleState {
        DistroBundleState::empty_for_tests()
    }

    fn expect_ready(result: RuntimeConfigLoadResult) -> (RuntimeConfigSource, RuntimeConfig) {
        match result {
            RuntimeConfigLoadResult::Ready { source, config, .. } => (source, *config),
            other => panic!("expected ready result, got {other:?}"),
        }
    }

    fn expect_unavailable(
        result: RuntimeConfigLoadResult,
    ) -> (RuntimeConfigSource, RuntimeConfigUnavailableReason, String) {
        match result {
            RuntimeConfigLoadResult::Unavailable {
                source,
                reason,
                message,
            } => (source, reason, message),
            other => panic!("expected unavailable result, got {other:?}"),
        }
    }

    #[test]
    fn validates_complete_runtime_config() {
        validate_runtime_config(&valid_config()).expect("valid config");
    }

    #[test]
    fn rejects_invalid_runtime_config() {
        let mut invalid = valid_config();
        invalid.schema_version = 2;
        assert!(validate_runtime_config(&invalid)
            .unwrap_err()
            .contains("schemaVersion must be 1"));

        let mut invalid = valid_config();
        invalid.goose = managed_goose_config();
        invalid.goose.model_providers[0].aliases =
            Some(vec!["databricks".to_string(), " databricks ".to_string()]);
        assert!(validate_runtime_config(&invalid)
            .unwrap_err()
            .contains("duplicate entry 'databricks'"));

        let mut invalid = valid_config();
        invalid.kgoose = Some(RuntimeKgooseConfig {
            base_url: Some("file:///tmp/kgoose".to_string()),
            path: None,
        });
        assert!(validate_runtime_config(&invalid)
            .unwrap_err()
            .contains("kgoose.baseUrl must use http or https"));
    }

    #[test]
    fn default_runtime_config_is_valid() {
        validate_runtime_config(&default_runtime_config()).expect("default config");
    }

    // Stock defaults declare no fastModelId (the release-time distribution
    // injector supplies it), so pin the mechanism with an explicit fixture: a
    // declared id validates and round-trips through the camelCase wire name
    // the injected config uses.
    #[test]
    fn declared_fast_model_id_validates_and_round_trips() {
        let mut config = default_runtime_config();
        config.goose = managed_goose_config();
        config.goose.model_providers[0].fast_model_id = Some("goose-fast-model".to_string());
        validate_runtime_config(&config).expect("declared fastModelId must validate");

        let serialized = serde_json::to_string(&config).expect("serialize config");
        assert!(serialized.contains(r#""fastModelId":"goose-fast-model""#));
        let parsed = serde_json::from_str::<RuntimeConfig>(&serialized).expect("parse config");
        assert_eq!(parsed, config);
    }

    #[test]
    fn allowed_model_id_prefixes_validate_and_round_trip() {
        let mut config = default_runtime_config();
        config.goose = managed_goose_config();
        config.goose.model_providers[0].allowed_model_id_prefixes =
            Some(vec!["goose-".to_string(), "team.approved.".to_string()]);
        validate_runtime_config(&config).expect("allowedModelIdPrefixes must validate");

        let serialized = serde_json::to_string(&config).expect("serialize config");
        assert!(serialized.contains(r#""allowedModelIdPrefixes":["goose-","team.approved."]"#));
        let parsed = serde_json::from_str::<RuntimeConfig>(&serialized).expect("parse config");
        assert_eq!(parsed, config);
    }

    // BYO-key dev must not inherit the default provider's distribution config:
    // the databricks endpoint, fast-model override, and discovery allowlist are
    // cleared. Set optional fields to mimic a distribution-injected config.
    #[cfg(debug_assertions)]
    #[test]
    fn clear_default_databricks_distribution_config_clears_provider_policy() {
        let mut config = default_runtime_config();
        config.goose = managed_goose_config();
        config.goose.model_providers[0].fast_model_id = Some("goose-fast-model".to_string());
        config.goose.model_providers[0].allowed_model_id_prefixes =
            Some(vec!["goose-".to_string()]);

        clear_default_databricks_distribution_config(&mut config);

        let provider = &config.goose.model_providers[0];
        assert_eq!(provider.endpoint_env, None);
        assert_eq!(provider.fast_model_id, None);
        assert_eq!(provider.allowed_model_id_prefixes, None);
    }

    #[test]
    fn bundled_runtime_config_resource_is_valid_and_carries_no_restrictive_toggles() {
        // Pins the checked-in resource that ships as the official default source
        // of truth (bundled via tauri.conf.json `resources`). It must parse
        // against the real `deny_unknown_fields` struct and validate.
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join(BUNDLED_RUNTIME_CONFIG_FILE_NAME);
        let contents = std::fs::read_to_string(&path).unwrap_or_else(|error| {
            panic!("read bundled runtime config '{}': {error}", path.display())
        });
        let config = serde_json::from_str::<RuntimeConfig>(&contents)
            .unwrap_or_else(|error| panic!("parse bundled runtime config: {error}"));
        validate_runtime_config(&config).expect("bundled runtime config must validate");

        // The official default disables nothing: all features ship ON. Feature
        // disabling (e.g. voice dictation / telemetry, which commits b8a95e90 /
        // 71d19399 made runtimeFeature capabilities) is supplied only at
        // custom-build time and is not committed here.
        let toggles = config.feature_toggles.clone().unwrap_or_default();
        assert!(
            toggles.is_empty(),
            "official default must not carry feature toggles, got {toggles:?}"
        );

        // Single source of truth: the goose block mirrors the compiled-in
        // default.
        assert_eq!(config.goose, default_runtime_config().goose);
    }

    #[test]
    fn read_fake_runtime_config_from_path_round_trips_and_reports_errors() {
        let dir = tempdir().expect("temp dir");
        let path = dir.path().join("fake.json");
        write_fake_runtime_config_to_path(&path, &valid_config()).expect("write fake config");

        let (source, config) = expect_ready(read_fake_runtime_config_from_path(&path));
        assert_eq!(source, RuntimeConfigSource::FakeEndpoint);
        assert_eq!(config, valid_config());

        std::fs::write(&path, r#"{"schemaVersion":1}"#).expect("write invalid config");
        let (source, reason, message) =
            expect_unavailable(read_fake_runtime_config_from_path(&path));
        assert_eq!(source, RuntimeConfigSource::FakeEndpoint);
        assert_eq!(reason, RuntimeConfigUnavailableReason::Invalid);
        assert!(message.contains("failed validation") || message.contains("Failed to parse"));

        let missing = dir.path().join("missing.json");
        let (source, reason, message) =
            expect_unavailable(read_fake_runtime_config_from_path(&missing));
        assert_eq!(source, RuntimeConfigSource::FakeEndpoint);
        assert_eq!(reason, RuntimeConfigUnavailableReason::Missing);
        assert!(message.contains("Failed to read fake runtime config"));
    }

    #[test]
    fn ready_wire_result_exposes_native_auto_revision_without_renderer_reencoding() {
        let mut config = valid_config();
        let absent = serde_json::to_value(RuntimeConfigLoadResult::ready(
            RuntimeConfigSource::BundledFile,
            config.clone(),
        ))
        .unwrap();
        assert!(absent.get("autoRoutingRevision").is_none());
        config.goose = managed_goose_config();
        config.goose.auto_routing = Some(serde_json::from_value(serde_json::json!({
            "url":"https://gateway.example.com/route",
            "routeSelector":{"router_name":"task_v3","config":{"float":1.0,"large":9007199254740993u64}},
            "modes":[{"id":"auto","displayName":"Auto","modelProviderId":TEST_RUNTIME_PROVIDER_ID,
            "fallback":{"modelId":TEST_RUNTIME_MODEL_ID,"effort":"high"},
            "models":[{"modelId":TEST_RUNTIME_MODEL_ID,"routerModel":"system.ai.sol"}]}]
        })).unwrap());
        validate_runtime_config(&config).unwrap();
        let revision = auto_routing_revision(config.goose.auto_routing.as_ref().unwrap()).unwrap();
        let mut wire = serde_json::to_value(RuntimeConfigLoadResult::ready(
            RuntimeConfigSource::BundledFile,
            config,
        ))
        .unwrap();
        assert_eq!(wire["autoRoutingRevision"], revision);
        assert_eq!(revision.len(), 64);
        wire["config"]["goose"]["autoRouting"]["routeSelector"]["config"]["float"] =
            serde_json::json!(1);
        wire["config"]["goose"]["autoRouting"]["routeSelector"]["config"]["large"] =
            serde_json::json!(9007199254740992u64);
        let echoed: RuntimeConfigLoadResult = serde_json::from_value(wire).unwrap();
        match echoed {
            RuntimeConfigLoadResult::Ready {
                config,
                auto_routing_revision: Some(echoed_revision),
                ..
            } => {
                assert_eq!(echoed_revision, revision);
                assert_ne!(
                    auto_routing_revision(config.goose.auto_routing.as_ref().unwrap()).unwrap(),
                    revision
                );
            }
            other => panic!("Expected Ready with native revision, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn new_chat_refresh_retains_last_valid_config_on_source_failure() {
        let (_dir, state) = temp_state();
        let distro = empty_distro_state();
        let expected = state.set_fake_config(valid_config()).unwrap();
        std::fs::write(&state.fake_config_path, "invalid JSON").unwrap();
        assert_eq!(state.refresh_for_new_chat(&distro).await.unwrap(), expected);
        assert_eq!(state.get(&distro).await.unwrap(), expected);
    }

    #[cfg(not(feature = "admin-runtime-config"))]
    #[tokio::test]
    async fn new_chat_refresh_reloads_bundled_source_and_retains_it_when_deleted() {
        let (_dir, state) = temp_state_with_bundled(Some(&valid_config()));
        let distro = empty_distro_state();
        state.get(&distro).await.unwrap();
        let mut updated = valid_config();
        updated.feature_toggles = Some(HashMap::from([("updated".to_string(), true)]));
        let path = state.bundled_config_path.as_ref().unwrap();
        std::fs::write(path, serde_json::to_vec(&updated).unwrap()).unwrap();
        let expected = state.refresh_for_new_chat(&distro).await.unwrap();
        assert_eq!(expect_ready(expected.clone()).1, updated);
        std::fs::remove_file(path).unwrap();
        assert_eq!(state.refresh_for_new_chat(&distro).await.unwrap(), expected);
    }

    #[cfg(not(feature = "admin-runtime-config"))]
    #[tokio::test]
    async fn new_chat_source_failure_preserves_operational_app_default() {
        let (_dir, state) = temp_state();
        let distro = empty_distro_state();
        let initial = state.get(&distro).await.unwrap();
        assert_eq!(
            expect_ready(initial.clone()).0,
            RuntimeConfigSource::AppDefault
        );
        let result = state.refresh_for_new_chat(&distro).await.unwrap();
        assert_eq!(result, initial);
        assert_eq!(state.get(&distro).await.unwrap(), result);
        assert_eq!(
            state.ready_config(&distro).await.unwrap(),
            default_runtime_config()
        );
        // Ready defaults keep native operations usable without claiming that
        // the source successfully removed any previously configured Auto mode.
        assert!(matches!(
            result,
            RuntimeConfigLoadResult::Ready {
                source: RuntimeConfigSource::AppDefault,
                ..
            }
        ));
    }

    #[cfg(not(feature = "admin-runtime-config"))]
    #[tokio::test]
    async fn new_chat_timeout_preserves_operational_app_default() {
        let (_dir, state) = temp_state();
        let distro = empty_distro_state();
        let initial = state.get(&distro).await.unwrap();
        assert_eq!(
            expect_ready(initial.clone()).0,
            RuntimeConfigSource::AppDefault
        );
        let result = state
            .refresh_for_new_chat_with(std::future::pending(), Duration::from_millis(1))
            .await
            .unwrap();
        assert_eq!(result, initial);
        assert_eq!(
            state.ready_config(&distro).await.unwrap(),
            default_runtime_config()
        );
    }

    #[tokio::test]
    async fn new_chat_refresh_timeout_keeps_native_and_returned_config_equal() {
        let (_dir, state) = temp_state();
        let distro = empty_distro_state();
        let expected = state.set_fake_config(valid_config()).unwrap();
        let result = state
            .refresh_for_new_chat_with(std::future::pending(), Duration::from_millis(1))
            .await
            .unwrap();
        assert_eq!(result, expected);
        assert_eq!(state.get(&distro).await.unwrap(), result);
    }

    #[cfg(not(feature = "admin-runtime-config"))]
    #[tokio::test]
    async fn new_chat_source_failure_does_not_restore_cleared_fake_override() {
        let (_dir, state) = temp_state();
        let distro = empty_distro_state();
        state.set_fake_config(valid_config()).unwrap();
        state.clear_fake_config(&distro).await.unwrap();
        let result = state.refresh_for_new_chat(&distro).await.unwrap();
        let (source, config) = expect_ready(result);
        assert_eq!(source, RuntimeConfigSource::AppDefault);
        assert_eq!(config, default_runtime_config());
        assert_eq!(state.ready_config(&distro).await.unwrap(), config);
    }

    #[cfg(not(feature = "admin-runtime-config"))]
    #[tokio::test]
    async fn concurrent_new_chat_failure_does_not_restore_cleared_fake_override() {
        let (_dir, state) = temp_state();
        let distro = empty_distro_state();
        state.set_fake_config(valid_config()).unwrap();
        let (_, refreshed) = tokio::join!(
            state.clear_fake_config(&distro),
            state.refresh_for_new_chat(&distro),
        );
        let result = refreshed.unwrap();
        assert!(!matches!(
            result,
            RuntimeConfigLoadResult::Ready {
                source: RuntimeConfigSource::FakeEndpoint,
                ..
            }
        ));
        assert_eq!(state.get(&distro).await.unwrap(), result);
    }

    #[tokio::test]
    async fn new_chat_initial_timeout_stays_unavailable() {
        let (_dir, state) = temp_state();
        let result = state
            .refresh_for_new_chat_with(std::future::pending(), Duration::from_millis(1))
            .await
            .unwrap();
        assert!(matches!(
            result,
            RuntimeConfigLoadResult::Unavailable { .. }
        ));
        assert_eq!(state.get(&empty_distro_state()).await.unwrap(), result);
    }

    #[tokio::test]
    async fn older_refresh_cannot_overwrite_new_fake_override() {
        let (_dir, state) = temp_state();
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (finish_tx, finish_rx) = tokio::sync::oneshot::channel();
        let stale = RuntimeConfigLoadResult::ready(
            RuntimeConfigSource::BundledFile,
            default_runtime_config(),
        );
        let (result, expected) = tokio::join!(
            state.refresh_for_new_chat_with(
                async {
                    started_tx.send(()).unwrap();
                    finish_rx.await.unwrap();
                    stale
                },
                Duration::from_secs(5)
            ),
            async {
                started_rx.await.unwrap();
                let expected = state.set_fake_config(valid_config()).unwrap();
                finish_tx.send(()).unwrap();
                expected
            },
        );
        assert_eq!(result.unwrap(), expected);
        assert_eq!(state.get(&empty_distro_state()).await.unwrap(), expected);
    }

    #[tokio::test]
    async fn older_startup_load_cannot_replace_new_chat_refresh() {
        let (_dir, state) = temp_state();
        // The startup get/explicit refresh use this same reservation/commit
        // pair around their source await.
        let startup_generation = state.begin_load().unwrap();
        let expected = state
            .refresh_for_new_chat_with(
                async {
                    RuntimeConfigLoadResult::ready(RuntimeConfigSource::BundledFile, valid_config())
                },
                Duration::from_secs(5),
            )
            .await
            .unwrap();
        let result = state
            .finish_load(
                startup_generation,
                default_runtime_config_result(RuntimeConfigSource::AppDefault),
                false,
            )
            .unwrap();
        assert_eq!(result, expected);
        assert_eq!(state.get(&empty_distro_state()).await.unwrap(), expected);
    }

    #[tokio::test]
    async fn runtime_config_state_get_caches_until_refresh() {
        let (_dir, state) = temp_state();
        let distro_state = empty_distro_state();
        let mut first = valid_config();
        first.feature_toggles = Some(HashMap::from([("first".to_string(), true)]));
        let mut second = valid_config();
        second.feature_toggles = Some(HashMap::from([("second".to_string(), true)]));
        write_fake_runtime_config_to_path(&state.fake_config_path, &first).expect("write first");

        let (_, config) = expect_ready(state.get(&distro_state).await.expect("get first"));
        assert_eq!(config.feature_toggles, first.feature_toggles);

        write_fake_runtime_config_to_path(&state.fake_config_path, &second).expect("write second");
        let (_, cached) = expect_ready(state.get(&distro_state).await.expect("get cached"));
        assert_eq!(cached.feature_toggles, first.feature_toggles);

        let (_, refreshed) = expect_ready(state.refresh(&distro_state).await.expect("refresh"));
        assert_eq!(refreshed.feature_toggles, second.feature_toggles);
    }

    #[tokio::test]
    async fn runtime_config_state_clear_fake_config_restores_default_and_removes_file() {
        let (_dir, state) = temp_state();
        let distro_state = empty_distro_state();
        state
            .set_fake_config(valid_config())
            .expect("set fake config");
        assert!(state.fake_config_path.exists());

        let (source, config) = expect_ready(
            state
                .clear_fake_config(&distro_state)
                .await
                .expect("clear fake config"),
        );
        assert_eq!(source, RuntimeConfigSource::AppDefault);
        assert_eq!(config, default_runtime_config());
        assert!(!state.fake_config_path.exists());
    }

    #[tokio::test]
    async fn runtime_config_state_ready_config_returns_default_when_none_saved() {
        let (_dir, state) = temp_state();
        let distro_state = empty_distro_state();

        let result = state.get(&distro_state).await.expect("get default");
        let (source, config) = expect_ready(result);
        assert_eq!(source, RuntimeConfigSource::AppDefault);
        assert_eq!(config, default_runtime_config());

        let ready = state
            .ready_config(&distro_state)
            .await
            .expect("ready default config");
        assert_eq!(ready, default_runtime_config());
    }

    #[tokio::test]
    async fn runtime_config_state_ready_config_surfaces_validation_errors() {
        let (_dir, state) = temp_state();
        let distro_state = empty_distro_state();
        std::fs::create_dir_all(state.fake_config_path.parent().expect("parent"))
            .expect("create dir");
        std::fs::write(&state.fake_config_path, r#"{"schemaVersion":1}"#)
            .expect("write invalid fake config");

        let error = state
            .ready_config(&distro_state)
            .await
            .expect_err("invalid fake config should fail ready_config");
        assert!(error.contains("Runtime config unavailable"));
        assert!(error.contains("Invalid"));
    }

    #[cfg(not(feature = "admin-runtime-config"))]
    #[tokio::test]
    async fn load_uses_bundled_runtime_config_when_present() {
        let bundled = restricted_bundled_config();
        let (_dir, state) = temp_state_with_bundled(Some(&bundled));
        let distro_state = empty_distro_state();

        let (source, config) =
            expect_ready(state.get(&distro_state).await.expect("get bundled config"));
        assert_eq!(source, RuntimeConfigSource::BundledFile);
        assert_eq!(config, bundled);
        assert_eq!(
            config.feature_toggles,
            Some(HashMap::from([
                ("voiceDictation".to_string(), false),
                ("telemetry".to_string(), false),
            ]))
        );
    }

    #[cfg(not(feature = "admin-runtime-config"))]
    #[tokio::test]
    async fn load_uses_dev_default_fallback_when_bundled_runtime_config_missing() {
        let (_dir, state) = temp_state_with_bundled(None);
        let distro_state = empty_distro_state();

        let (source, config) =
            expect_ready(state.get(&distro_state).await.expect("get default config"));
        assert_eq!(source, RuntimeConfigSource::AppDefault);
        assert_eq!(config, default_runtime_config());
    }

    #[cfg(not(feature = "admin-runtime-config"))]
    #[tokio::test]
    async fn load_uses_dev_default_fallback_when_bundled_runtime_config_invalid() {
        let dir = tempdir().expect("temp dir");
        let bundled_path = dir
            .path()
            .join("resources")
            .join(BUNDLED_RUNTIME_CONFIG_FILE_NAME);
        std::fs::create_dir_all(bundled_path.parent().expect("parent")).expect("create dir");
        std::fs::write(&bundled_path, r#"{"schemaVersion":1}"#)
            .expect("write invalid bundled config");
        let state = RuntimeConfigState::new(dir.path().to_path_buf(), Some(bundled_path));
        let distro_state = empty_distro_state();

        let (source, config) = expect_ready(
            state
                .get(&distro_state)
                .await
                .expect("get fallback default config"),
        );
        assert_eq!(source, RuntimeConfigSource::AppDefault);
        assert_eq!(config, default_runtime_config());
    }

    #[cfg(not(feature = "admin-runtime-config"))]
    #[test]
    fn bundled_runtime_config_fails_closed_when_missing_and_fallback_disabled() {
        let dir = tempdir().expect("temp dir");
        let bundled_path = dir
            .path()
            .join("resources")
            .join(BUNDLED_RUNTIME_CONFIG_FILE_NAME);

        let (source, reason, message) = expect_unavailable(
            load_bundled_runtime_config_from_source(Some(&bundled_path), false),
        );

        assert_eq!(source, RuntimeConfigSource::BundledFile);
        assert_eq!(reason, RuntimeConfigUnavailableReason::Missing);
        assert!(message.contains("not found"));
    }

    #[cfg(not(feature = "admin-runtime-config"))]
    #[test]
    fn bundled_runtime_config_fails_closed_when_path_unavailable_and_fallback_disabled() {
        let (source, reason, message) =
            expect_unavailable(load_bundled_runtime_config_from_source(None, false));

        assert_eq!(source, RuntimeConfigSource::BundledFile);
        assert_eq!(reason, RuntimeConfigUnavailableReason::Missing);
        assert!(message.contains("path unavailable"));
    }

    #[cfg(not(feature = "admin-runtime-config"))]
    #[test]
    fn bundled_runtime_config_fails_closed_when_invalid_and_fallback_disabled() {
        let dir = tempdir().expect("temp dir");
        let bundled_path = dir
            .path()
            .join("resources")
            .join(BUNDLED_RUNTIME_CONFIG_FILE_NAME);
        std::fs::create_dir_all(bundled_path.parent().expect("parent")).expect("create dir");
        std::fs::write(&bundled_path, r#"{"schemaVersion":1}"#)
            .expect("write invalid bundled config");

        let (source, reason, message) = expect_unavailable(
            load_bundled_runtime_config_from_source(Some(&bundled_path), false),
        );

        assert_eq!(source, RuntimeConfigSource::BundledFile);
        assert_eq!(reason, RuntimeConfigUnavailableReason::Invalid);
        assert!(message.contains("failed validation") || message.contains("Failed to parse"));
    }

    #[cfg(not(feature = "admin-runtime-config"))]
    #[tokio::test]
    async fn load_ignores_admin_cache_when_bundled_runtime_config_present() {
        // A stale admin cache must not shadow the bundled-file source of truth.
        let bundled = restricted_bundled_config();
        let (_dir, state) = temp_state_with_bundled(Some(&bundled));
        let distro_state = empty_distro_state();

        let mut cached = valid_config();
        cached.feature_toggles = Some(HashMap::from([("fromCache".to_string(), true)]));
        write_admin_cache_to_path(
            &state.admin_cache_path,
            &cached,
            "https://kgoose.example.test/runtime",
        )
        .expect("write admin cache");

        let (source, config) =
            expect_ready(state.get(&distro_state).await.expect("get bundled config"));
        assert_eq!(source, RuntimeConfigSource::BundledFile);
        assert_eq!(config, bundled);
        assert_ne!(config.feature_toggles, cached.feature_toggles);
    }

    #[cfg(not(feature = "admin-runtime-config"))]
    #[tokio::test]
    async fn load_ignores_admin_cache_without_bundled_runtime_config() {
        // With no bundled file, the admin cache is still ignored: the loader
        // falls through to the compiled-in default rather than the stale cache.
        let (_dir, state) = temp_state_with_bundled(None);
        let distro_state = empty_distro_state();

        let mut cached = valid_config();
        cached.feature_toggles = Some(HashMap::from([("fromCache".to_string(), true)]));
        write_admin_cache_to_path(
            &state.admin_cache_path,
            &cached,
            "https://kgoose.example.test/runtime",
        )
        .expect("write admin cache");

        let (source, config) =
            expect_ready(state.get(&distro_state).await.expect("get default config"));
        assert_eq!(source, RuntimeConfigSource::AppDefault);
        assert_eq!(config, default_runtime_config());
    }

    #[test]
    fn auto_routing_validation_matches_frontend_contract() {
        let valid = serde_json::json!({
            "url":"https://gateway.example.com/route", "bearerTokenEnv":"DATABRICKS_TOKEN",
            "modes":[{"id":"auto","displayName":"Auto","modelProviderId":TEST_RUNTIME_PROVIDER_ID,
            "fallback":{"modelId":"served","effort":"high"},
            "models":[{"modelId":"served","routerModel":"system.ai.sol","minEffort":"high","maxEffort":"max"}]}]
        });
        let providers = managed_goose_config().model_providers;
        let parse = |value: serde_json::Value| {
            serde_json::from_value::<RuntimeAutoRoutingConfig>(value).unwrap()
        };
        validate_auto_routing(&parse(valid.clone()), &providers).unwrap();
        let mut invalid = Vec::new();
        for url in [
            "file:///tmp/route",
            "https://user:secret@example.com/route",
            "https://example.com/route?token=value",
            "https://example.com/route#fragment",
        ] {
            let mut value = valid.clone();
            value["url"] = serde_json::json!(url);
            invalid.push(value);
        }
        for env in ["", "token-value", "lowercase", "1TOKEN"] {
            let mut value = valid.clone();
            value["bearerTokenEnv"] = serde_json::json!(env);
            invalid.push(value);
        }
        let mut value = valid.clone();
        value["timeoutMs"] = serde_json::json!(0);
        invalid.push(value);
        let mut value = valid.clone();
        value["defaultModeId"] = serde_json::json!("missing");
        invalid.push(value);
        let mut value = valid.clone();
        value["modes"][0]["modelProviderId"] = serde_json::json!("missing");
        invalid.push(value);
        let mut value = valid.clone();
        value["modes"][0]["fallback"]["modelId"] = serde_json::json!("missing");
        invalid.push(value);
        let mut value = valid.clone();
        value["modes"][0]["fallback"]["effort"] = serde_json::json!("low");
        invalid.push(value);
        let mut value = valid.clone();
        value["modes"][0]["models"][0]["minEffort"] = serde_json::json!("invented");
        invalid.push(value);
        let mut value = valid.clone();
        value["modes"][0]["models"][0]["maxEffort"] = serde_json::json!("low");
        invalid.push(value);
        let mut value = valid.clone();
        value["routeSelector"] =
            serde_json::json!({"router_name":"task_v3","config":{"nested":{"api_key":"secret"}}});
        invalid.push(value);
        let mut value = valid.clone();
        value["modes"] = serde_json::json!([valid["modes"][0], valid["modes"][0]]);
        invalid.push(value);
        for value in invalid {
            assert!(
                validate_auto_routing(&parse(value.clone()), &providers).is_err(),
                "unexpected valid config: {value}"
            );
        }
    }

    #[test]
    fn validate_goose_config_rejects_invalid_shapes() {
        validate_goose_config(&default_goose_config()).unwrap();

        let mut goose = managed_goose_config();
        goose.model_providers.push(RuntimeGooseModelProvider {
            id: TEST_RUNTIME_PROVIDER_ID.to_string(),
            display_name: "Duplicate".to_string(),
            description: None,
            setup_method: None,
            group: None,
            aliases: None,
            native_connect_query: None,
            custom_provider: None,
            endpoint_env: None,
            model_inventory_mode: None,
            allowed_model_id_prefixes: None,
            fast_model_id: None,
            models: vec![],
        });
        assert!(validate_goose_config(&goose)
            .unwrap_err()
            .contains("duplicate provider 'databricks_v2'"));

        let mut goose = managed_goose_config();
        goose.default_model_provider_id = Some("unknown".to_string());
        assert!(validate_goose_config(&goose)
            .unwrap_err()
            .contains("defaultModelProviderId must reference"));

        let mut goose = managed_goose_config();
        goose.model_providers[0].models = vec![
            RuntimeGooseModel {
                id: TEST_RUNTIME_MODEL_ID.to_string(),
                name: "GPT-5.5".to_string(),
                recommended: None,
                featured: None,
                context_limit: None,
            },
            RuntimeGooseModel {
                id: TEST_RUNTIME_MODEL_ID.to_string(),
                name: "GPT-5.5 duplicate".to_string(),
                recommended: None,
                featured: None,
                context_limit: None,
            },
        ];
        assert!(validate_goose_config(&goose)
            .unwrap_err()
            .contains("duplicate model 'goose-gpt-5-5'"));

        let mut goose = managed_goose_config();
        goose.model_providers[0].models[0].context_limit = Some(0);
        assert!(validate_goose_config(&goose)
            .unwrap_err()
            .contains("contextLimit must be positive"));

        let mut goose = managed_goose_config();
        goose.model_providers[0].setup_method = Some("magic".to_string());
        assert!(validate_goose_config(&goose)
            .unwrap_err()
            .contains("setupMethod has unsupported value"));

        let mut goose = managed_goose_config();
        goose.model_providers[0].group = Some("primary".to_string());
        assert!(validate_goose_config(&goose)
            .unwrap_err()
            .contains("group has unsupported value"));

        let mut goose = managed_goose_config();
        goose.model_providers[0].model_inventory_mode = Some("dynamic".to_string());
        assert!(validate_goose_config(&goose)
            .unwrap_err()
            .contains("modelInventoryMode has unsupported value"));

        let mut goose = managed_goose_config();
        goose.model_providers[0].allowed_model_id_prefixes = Some(vec![]);
        assert!(validate_goose_config(&goose)
            .unwrap_err()
            .contains("allowedModelIdPrefixes must not be empty"));

        let mut goose = managed_goose_config();
        goose.model_providers[0].allowed_model_id_prefixes =
            Some(vec!["goose-".to_string(), "goose-".to_string()]);
        assert!(validate_goose_config(&goose)
            .unwrap_err()
            .contains("allowedModelIdPrefixes must not contain duplicate"));

        let mut goose = managed_goose_config();
        goose.model_providers[0].id = "other-managed".to_string();
        goose.default_model_provider_id = Some("other-managed".to_string());
        goose.model_providers[0].allowed_model_id_prefixes = Some(vec!["team.".to_string()]);
        assert!(validate_goose_config(&goose)
            .unwrap_err()
            .contains("allowedModelIdPrefixes is supported only for databricks_v2"));

        let mut goose = managed_goose_config();
        goose.model_providers[0].custom_provider = Some(custom_provider());
        goose.model_providers[0].id = "other_provider".to_string();
        goose.default_model_provider_id = Some("other_provider".to_string());
        assert!(validate_goose_config(&goose)
            .unwrap_err()
            .contains("providerId must match"));
    }

    #[test]
    fn validate_goose_config_accepts_default_model_outside_recommendation_metadata() {
        let mut goose = managed_goose_config();
        goose.default_model_id = Some("new-upstream-model".to_string());
        validate_goose_config(&goose).unwrap();
    }

    #[test]
    fn validate_goose_config_rejects_ids_with_boundary_whitespace() {
        let mut goose = managed_goose_config();
        goose.default_model_provider_id = Some(format!(" {TEST_RUNTIME_PROVIDER_ID}"));
        assert!(validate_goose_config(&goose)
            .unwrap_err()
            .contains("goose.defaultModelProviderId must not have leading or trailing whitespace"));

        let mut goose = managed_goose_config();
        goose.default_model_id = Some(format!("{TEST_RUNTIME_MODEL_ID} "));
        assert!(validate_goose_config(&goose)
            .unwrap_err()
            .contains("goose.defaultModelId must not have leading or trailing whitespace"));

        let mut goose = managed_goose_config();
        goose.model_providers[0].id = format!("{TEST_RUNTIME_PROVIDER_ID} ");
        assert!(validate_goose_config(&goose)
            .unwrap_err()
            .contains("goose.modelProviders.id must not have leading or trailing whitespace"));

        let mut goose = managed_goose_config();
        goose.model_providers[0].fast_model_id = Some("goose-fast-model ".to_string());
        assert!(validate_goose_config(&goose).unwrap_err().contains(
            "goose.modelProviders.fastModelId must not have leading or trailing whitespace"
        ));

        let mut goose = managed_goose_config();
        goose.model_providers[0].allowed_model_id_prefixes =
            Some(vec![" team.approved.".to_string()]);
        assert!(validate_goose_config(&goose).unwrap_err().contains(
            "goose.modelProviders.allowedModelIdPrefixes entries must not have leading or trailing whitespace"
        ));

        let mut goose = managed_goose_config();
        goose.model_providers[0].models[0].id = format!(" {TEST_RUNTIME_MODEL_ID}");
        assert!(validate_goose_config(&goose).unwrap_err().contains(
            "goose.modelProviders.models.id must not have leading or trailing whitespace"
        ));

        let mut provider = custom_provider();
        provider.provider_id = format!(" {ADMIN_OWNED_CUSTOM_PROVIDER_ID} ");
        provider.engine = "not_openai".to_string();
        assert!(
            validate_custom_provider(&provider, ADMIN_OWNED_CUSTOM_PROVIDER_ID)
                .unwrap_err()
                .contains("customProvider.providerId must not have leading or trailing whitespace")
        );
    }

    #[test]
    fn validate_custom_provider_rejects_invalid_shapes() {
        let mut provider = custom_provider();
        validate_custom_provider(&provider, ADMIN_OWNED_CUSTOM_PROVIDER_ID)
            .expect("valid custom provider");

        provider.requires_auth = true;
        assert!(
            validate_custom_provider(&provider, ADMIN_OWNED_CUSTOM_PROVIDER_ID)
                .unwrap_err()
                .contains("requiresAuth must be false")
        );

        let mut provider = custom_provider();
        provider.engine = "not_openai".to_string();
        assert!(
            validate_custom_provider(&provider, ADMIN_OWNED_CUSTOM_PROVIDER_ID)
                .unwrap_err()
                .contains("must use engine openai_compatible")
        );

        let mut provider = custom_provider();
        provider.api_url = "file:///tmp/provider".to_string();
        assert!(
            validate_custom_provider(&provider, ADMIN_OWNED_CUSTOM_PROVIDER_ID)
                .unwrap_err()
                .contains("apiUrl must use http or https")
        );
    }

    #[test]
    fn validate_non_secret_map_rejects_secret_looking_keys_and_values() {
        // Mirrored in src/shared/runtime-config/schema.test.ts to keep TS/Rust parity.
        let benign = HashMap::from([("X-Goose-Runtime".to_string(), "enabled".to_string())]);
        validate_non_secret_map(&benign, "headers").expect("benign map");

        let secret_key = HashMap::from([("Authorization".to_string(), "enabled".to_string())]);
        assert!(validate_non_secret_map(&secret_key, "headers")
            .unwrap_err()
            .contains("secret-looking"));

        let secret_value =
            HashMap::from([("X-Goose-Runtime".to_string(), "Bearer nope".to_string())]);
        assert!(validate_non_secret_map(&secret_value, "headers")
            .unwrap_err()
            .contains("secret-looking"));
    }

    #[test]
    fn validate_endpoint_env_allows_only_runtime_owned_keys_and_rejects_secret_values() {
        // Mirrored in src/shared/runtime-config/schema.test.ts to keep TS/Rust parity.
        let benign = HashMap::from([(
            "DATABRICKS_HOST".to_string(),
            "https://example.internal".to_string(),
        )]);
        validate_endpoint_env(&benign).expect("benign endpoint env");

        for key in [
            "HOME",
            "SSL_CERT_FILE",
            "NODE_OPTIONS",
            "PYTHONPATH",
            "GOOSE_CONFIG_FILE",
            "PATH",
            "LD_PRELOAD",
            "DYLD_INSERT_LIBRARIES",
            "HTTP_PROXY",
            "HTTPS_PROXY",
            "ALL_PROXY",
            "NO_PROXY",
            "CUSTOM_PROXY",
            "databricks_host",
            "OPENAI_API_KEY",
        ] {
            let invalid = HashMap::from([(key.to_string(), "value".to_string())]);
            assert!(
                validate_endpoint_env(&invalid)
                    .unwrap_err()
                    .contains("is not allowed"),
                "expected key {key} to be rejected"
            );
        }

        let secret_value =
            HashMap::from([("DATABRICKS_HOST".to_string(), "Bearer nope".to_string())]);
        assert!(validate_endpoint_env(&secret_value)
            .unwrap_err()
            .contains("secret-looking"));
    }

    #[test]
    fn admin_cache_round_trips_and_rejects_invalid_cache() {
        let dir = tempdir().expect("temp dir");
        let path = dir.path().join("admin-cache.json");
        let config = valid_config();
        write_admin_cache_to_path(&path, &config, "https://kgoose.example.test/runtime")
            .expect("write cache");

        let cache = read_admin_cache_from_path(&path).expect("read cache");
        assert_eq!(cache.cache_schema_version, ADMIN_CACHE_SCHEMA_VERSION);
        assert_eq!(cache.source_url, "https://kgoose.example.test/runtime");
        assert_eq!(cache.config, config);

        let mut cache_value: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).expect("read file"))
                .expect("cache json");
        cache_value["cacheSchemaVersion"] = serde_json::json!(ADMIN_CACHE_SCHEMA_VERSION + 1);
        std::fs::write(&path, serde_json::to_vec_pretty(&cache_value).unwrap())
            .expect("write cache mismatch");
        assert!(read_admin_cache_from_path(&path)
            .unwrap_err()
            .contains("cache schema must be"));

        cache_value["cacheSchemaVersion"] = serde_json::json!(ADMIN_CACHE_SCHEMA_VERSION);
        cache_value["config"]["schemaVersion"] = serde_json::json!(2);
        std::fs::write(&path, serde_json::to_vec_pretty(&cache_value).unwrap())
            .expect("write invalid embedded config");
        assert!(read_admin_cache_from_path(&path)
            .unwrap_err()
            .contains("schemaVersion must be 1"));
    }
}
