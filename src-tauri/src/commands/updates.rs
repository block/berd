//! Commands backing the in-app update flow.
//!
//! Release channels are a finite, bundled trust catalog. The renderer sends
//! only a channel ID; endpoint and updater public key resolution stays here.

use base64::Engine as _;
use minisign_verify::{PublicKey, Signature};
use semver::Version;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Manager, ResourceId, Runtime, State, Webview};
use tauri_plugin_updater::UpdaterExt;
use tokio::sync::Mutex;
use url::Url;
use uuid::Uuid;

const CATALOG_FILE_NAME: &str = "release-channels.json";
const STATE_FILE_NAME: &str = "release-channel-state.json";
const STORE_MARKER_FILE_NAME: &str = "release-store-marker.json";
const STATE_SCHEMA_VERSION: u32 = 1;
const CHECK_TIMEOUT_MS: u64 = 10_000;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CompatibilityDescriptor {
    pub store_contract_version: u32,
    pub writes_data_epoch: u64,
    pub min_readable_data_epoch: u64,
    pub max_readable_data_epoch: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SignedCompatibilityEnvelope {
    schema_version: u32,
    channel_id: String,
    version: String,
    artifact_sha256: String,
    compatibility: CompatibilityDescriptor,
    signature: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SignedCompatibilityPayload {
    schema_version: u32,
    channel_id: String,
    version: String,
    artifact_sha256: String,
    compatibility: CompatibilityDescriptor,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoreMarker {
    schema_version: u32,
    store_contract_version: u32,
    data_epoch: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BundledBuildIdentity {
    channel_id: String,
    compatibility: CompatibilityDescriptor,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReleaseChannel {
    id: String,
    label: String,
    #[serde(default)]
    description: Option<String>,
    endpoint: Url,
    pubkey: String,
    #[serde(default)]
    what_to_test: Option<String>,
    compatibility: CompatibilityDescriptor,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReleaseCatalog {
    schema_version: u32,
    default_channel: String,
    running_build: BundledBuildIdentity,
    channels: Vec<ReleaseChannel>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseChannelInfo {
    pub id: String,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RunningBuildInfo {
    pub channel_id: String,
    pub version: String,
    pub compatibility: CompatibilityDescriptor,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub what_to_test: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PendingInstall {
    pub transition_id: String,
    pub source_channel_id: String,
    pub target_channel_id: String,
    pub target_version: String,
    pub target_artifact_sha256: String,
    pub target_compatibility: CompatibilityDescriptor,
    pub installed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WaitingForMain {
    pub source_channel_id: String,
    pub target_channel_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct PersistedReleaseState {
    schema_version: u32,
    selected_feed: String,
    #[serde(default)]
    pending_install: Option<PendingInstall>,
    #[serde(default)]
    waiting_for_main: Option<WaitingForMain>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseRuntime {
    pub enabled: bool,
    pub channels: Vec<ReleaseChannelInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_channel_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selected_feed: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub running_build: Option<RunningBuildInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pending_install: Option<PendingInstall>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub waiting_for_main: Option<WaitingForMain>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notice: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseUpdateMetadata {
    rid: ResourceId,
    current_version: String,
    version: String,
    date: Option<String>,
    body: Option<String>,
    raw_json: Value,
    target_channel_id: String,
    target_channel_label: String,
}

#[derive(Debug, Clone)]
struct VerifiedTarget {
    compatibility: CompatibilityDescriptor,
    artifact_sha256: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepareChannelSwitchRequest {
    pub channel_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfirmChannelSwitchRequest {
    pub channel_id: String,
    pub version: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransitionRequest {
    pub transition_id: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConfirmChannelSwitchResult {
    pub runtime: ReleaseRuntime,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub waiting_message: Option<String>,
}

#[derive(Clone)]
struct ReleaseChannelStateInner {
    catalog: Option<ReleaseCatalog>,
    running_build: Option<RunningBuildInfo>,
    state_path: PathBuf,
    store_marker_path: PathBuf,
    persisted: Arc<Mutex<PersistedReleaseState>>,
    prepared_targets: Arc<Mutex<std::collections::HashMap<String, VerifiedTarget>>>,
    operation: Arc<Mutex<()>>,
    startup_notice: Option<String>,
}

#[derive(Clone)]
pub struct ReleaseChannelState(ReleaseChannelStateInner);

impl ReleaseChannelState {
    pub fn load<R: Runtime>(app: &AppHandle<R>) -> Result<Self, String> {
        let app_data_dir = app
            .path()
            .app_data_dir()
            .map_err(|error| format!("Failed to resolve app data directory: {error}"))?;
        let state_path = app_data_dir.join(STATE_FILE_NAME);
        let store_marker_path = app_data_dir.join(STORE_MARKER_FILE_NAME);
        let catalog = load_catalog(app)?;
        let running_build = catalog.as_ref().and_then(|catalog| {
            catalog
                .channels
                .iter()
                .find(|channel| channel.id == catalog.running_build.channel_id)
                .map(|channel| RunningBuildInfo {
                    channel_id: catalog.running_build.channel_id.clone(),
                    version: app.package_info().version.to_string(),
                    compatibility: catalog.running_build.compatibility.clone(),
                    what_to_test: channel.what_to_test.clone(),
                })
        });

        let (persisted, startup_notice) = reconcile_persisted_state(
            catalog.as_ref(),
            running_build.as_ref(),
            read_persisted_state(&state_path)?,
        );
        if catalog.is_some() {
            write_json_atomically(&state_path, &persisted)?;
        }
        if let Some(running_build) = &running_build {
            initialize_store_marker(&store_marker_path, &running_build.compatibility)?;
        }

        Ok(Self(ReleaseChannelStateInner {
            catalog,
            running_build,
            state_path,
            store_marker_path,
            persisted: Arc::new(Mutex::new(persisted)),
            prepared_targets: Arc::new(Mutex::new(std::collections::HashMap::new())),
            operation: Arc::new(Mutex::new(())),
            startup_notice,
        }))
    }

    async fn runtime(&self) -> ReleaseRuntime {
        let persisted = self.0.persisted.lock().await.clone();
        self.runtime_from(&persisted)
    }

    fn runtime_from(&self, persisted: &PersistedReleaseState) -> ReleaseRuntime {
        let Some(catalog) = &self.0.catalog else {
            return ReleaseRuntime {
                enabled: false,
                channels: Vec::new(),
                default_channel_id: None,
                selected_feed: None,
                running_build: None,
                pending_install: None,
                waiting_for_main: None,
                notice: None,
            };
        };
        ReleaseRuntime {
            enabled: true,
            channels: catalog
                .channels
                .iter()
                .map(|channel| ReleaseChannelInfo {
                    id: channel.id.clone(),
                    label: channel.label.clone(),
                    description: channel.description.clone(),
                })
                .collect(),
            default_channel_id: Some(catalog.default_channel.clone()),
            selected_feed: Some(persisted.selected_feed.clone()),
            running_build: self.0.running_build.clone(),
            pending_install: persisted.pending_install.clone(),
            waiting_for_main: persisted.waiting_for_main.clone(),
            notice: self.0.startup_notice.clone(),
        }
    }

    fn channel(&self, id: &str) -> Result<&ReleaseChannel, String> {
        self.0
            .catalog
            .as_ref()
            .ok_or_else(|| "Updates are unavailable in this build".to_string())?
            .channels
            .iter()
            .find(|channel| channel.id == id)
            .ok_or_else(|| format!("Unknown release channel: {id}"))
    }

    fn persist(&self, state: &PersistedReleaseState) -> Result<(), String> {
        write_json_atomically(&self.0.state_path, state)
    }
}

fn load_catalog<R: Runtime>(app: &AppHandle<R>) -> Result<Option<ReleaseCatalog>, String> {
    let resource_dir = match app.path().resource_dir() {
        Ok(resource_dir) => resource_dir,
        Err(error) if cfg!(dev) => {
            log::debug!("Updater resources unavailable in dev mode: {error}");
            return Ok(None);
        }
        Err(error) => return Err(format!("Failed to resolve app resources: {error}")),
    };
    load_catalog_from_path(&resource_dir.join(CATALOG_FILE_NAME))
}

fn load_catalog_from_path(path: &Path) -> Result<Option<ReleaseCatalog>, String> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(format!(
                "Failed to read release catalog '{}': {error}",
                path.display()
            ))
        }
    };
    let value: Value = serde_json::from_slice(&bytes)
        .map_err(|error| format!("Invalid release catalog '{}': {error}", path.display()))?;
    if value.get("disabled").and_then(Value::as_bool) == Some(true) {
        return Ok(None);
    }
    let catalog: ReleaseCatalog = serde_json::from_value(value)
        .map_err(|error| format!("Invalid release catalog '{}': {error}", path.display()))?;
    validate_catalog(&catalog)?;
    Ok(Some(catalog))
}

fn validate_catalog(catalog: &ReleaseCatalog) -> Result<(), String> {
    if catalog.schema_version != 1 {
        return Err(format!(
            "Unsupported release catalog schema: {}",
            catalog.schema_version
        ));
    }
    if catalog.channels.is_empty() {
        return Err("Release catalog must contain at least one channel".to_string());
    }
    let mut ids = std::collections::HashSet::new();
    let mut labels = std::collections::HashSet::new();
    let mut endpoints = std::collections::HashSet::new();
    for channel in &catalog.channels {
        if channel.id.is_empty()
            || channel.id.len() > 32
            || !channel.id.bytes().enumerate().all(|(index, byte)| {
                if index == 0 {
                    byte.is_ascii_lowercase()
                } else {
                    byte.is_ascii_lowercase()
                        || byte.is_ascii_digit()
                        || (byte == b'-' && index < channel.id.len() - 1)
                }
            })
        {
            return Err(format!("Invalid release channel ID: {}", channel.id));
        }
        validate_compatibility(&channel.compatibility)?;
        if channel.pubkey.trim().is_empty() {
            return Err(format!(
                "Release channel {} has an empty public key",
                channel.id
            ));
        }
        if channel.endpoint.scheme() != "https"
            || !channel.endpoint.username().is_empty()
            || channel.endpoint.password().is_some()
            || channel.endpoint.fragment().is_some()
        {
            return Err(format!(
                "Release channel {} has an unsafe endpoint",
                channel.id
            ));
        }
        if !ids.insert(channel.id.clone()) {
            return Err(format!("Duplicate release channel ID: {}", channel.id));
        }
        if !labels.insert(channel.label.to_lowercase()) {
            return Err(format!(
                "Duplicate release channel label: {}",
                channel.label
            ));
        }
        if !endpoints.insert(channel.endpoint.clone()) {
            return Err(format!(
                "Duplicate release channel endpoint: {}",
                channel.endpoint
            ));
        }
    }
    if !ids.contains(&catalog.default_channel) {
        return Err("Default release channel is missing from the catalog".to_string());
    }
    if !ids.contains(&catalog.running_build.channel_id) {
        return Err("Running build channel is missing from the catalog".to_string());
    }
    let running_entry = catalog
        .channels
        .iter()
        .find(|channel| channel.id == catalog.running_build.channel_id)
        .expect("running build channel was validated");
    if running_entry.compatibility != catalog.running_build.compatibility {
        return Err("Running build compatibility does not match its channel".to_string());
    }
    validate_compatibility(&catalog.running_build.compatibility)?;
    Ok(())
}

fn validate_compatibility(descriptor: &CompatibilityDescriptor) -> Result<(), String> {
    if descriptor.min_readable_data_epoch > descriptor.max_readable_data_epoch {
        return Err("Release compatibility range is inverted".to_string());
    }
    if descriptor.writes_data_epoch < descriptor.min_readable_data_epoch
        || descriptor.writes_data_epoch > descriptor.max_readable_data_epoch
    {
        return Err("Release write epoch is outside the readable range".to_string());
    }
    Ok(())
}

fn read_persisted_state(path: &Path) -> Result<Option<PersistedReleaseState>, String> {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|error| format!("Invalid release state '{}': {error}", path.display())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!(
            "Failed to read release state '{}': {error}",
            path.display()
        )),
    }
}

fn reconcile_persisted_state(
    catalog: Option<&ReleaseCatalog>,
    running_build: Option<&RunningBuildInfo>,
    persisted: Option<PersistedReleaseState>,
) -> (PersistedReleaseState, Option<String>) {
    let Some(catalog) = catalog else {
        return (
            PersistedReleaseState {
                schema_version: STATE_SCHEMA_VERSION,
                selected_feed: String::new(),
                pending_install: None,
                waiting_for_main: None,
            },
            None,
        );
    };
    let running_channel = running_build
        .map(|build| build.channel_id.as_str())
        .unwrap_or(catalog.default_channel.as_str());
    let mut state = persisted.unwrap_or(PersistedReleaseState {
        schema_version: STATE_SCHEMA_VERSION,
        selected_feed: running_channel.to_string(),
        pending_install: None,
        waiting_for_main: None,
    });
    state.schema_version = STATE_SCHEMA_VERSION;
    let mut notice = None;

    if !catalog
        .channels
        .iter()
        .any(|channel| channel.id == state.selected_feed)
    {
        state.selected_feed = running_channel.to_string();
        state.pending_install = None;
        state.waiting_for_main = None;
        notice = Some("The saved release choice is no longer available. Berd kept this build on its current release.".to_string());
    }

    if let Some(pending) = &state.pending_install {
        let installed_target_is_running = running_build.is_some_and(|build| {
            build.channel_id == pending.target_channel_id
                && build.version == pending.target_version
                && build.compatibility == pending.target_compatibility
        });
        let old_source_is_still_running =
            running_build.is_some_and(|build| build.channel_id == pending.source_channel_id);
        if installed_target_is_running || old_source_is_still_running {
            state.pending_install = None;
        }
    }

    (state, notice)
}

fn write_json_atomically(path: &Path, value: &impl Serialize) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("Release state has no parent directory: {}", path.display()))?;
    fs::create_dir_all(parent).map_err(|error| {
        format!(
            "Failed to create release state directory '{}': {error}",
            parent.display()
        )
    })?;
    let bytes = serde_json::to_vec_pretty(value)
        .map_err(|error| format!("Failed to serialize release state: {error}"))?;
    let temporary = parent.join(format!(".{STATE_FILE_NAME}.{}.tmp", Uuid::new_v4()));
    let write_result = (|| -> Result<(), String> {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)
            .map_err(|error| {
                format!(
                    "Failed to create release state '{}': {error}",
                    temporary.display()
                )
            })?;
        file.write_all(&bytes).map_err(|error| {
            format!(
                "Failed to write release state '{}': {error}",
                temporary.display()
            )
        })?;
        file.sync_all().map_err(|error| {
            format!(
                "Failed to sync release state '{}': {error}",
                temporary.display()
            )
        })?;
        fs::rename(&temporary, path).map_err(|error| {
            format!(
                "Failed to replace release state '{}': {error}",
                path.display()
            )
        })?;
        File::open(parent)
            .and_then(|directory| directory.sync_all())
            .map_err(|error| {
                format!(
                    "Failed to sync release state directory '{}': {error}",
                    parent.display()
                )
            })?;
        Ok(())
    })();
    if write_result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    write_result
}

fn initialize_store_marker(path: &Path, running: &CompatibilityDescriptor) -> Result<(), String> {
    let marker = match fs::read(path) {
        Ok(bytes) => serde_json::from_slice::<StoreMarker>(&bytes).map_err(|error| {
            format!("Invalid release store marker '{}': {error}", path.display())
        })?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => StoreMarker {
            schema_version: STATE_SCHEMA_VERSION,
            store_contract_version: running.store_contract_version,
            data_epoch: running.writes_data_epoch,
        },
        Err(error) => {
            return Err(format!(
                "Failed to read release store marker '{}': {error}",
                path.display()
            ))
        }
    };
    if marker.schema_version != STATE_SCHEMA_VERSION
        || marker.store_contract_version != running.store_contract_version
        || marker.data_epoch < running.min_readable_data_epoch
        || marker.data_epoch > running.max_readable_data_epoch
    {
        return Err("The on-disk release data marker is incompatible with this build".to_string());
    }
    let marker = StoreMarker {
        data_epoch: marker.data_epoch.max(running.writes_data_epoch),
        ..marker
    };
    write_json_atomically(path, &marker)
}

fn read_store_marker(path: &Path) -> Result<StoreMarker, String> {
    let bytes = fs::read(path).map_err(|error| {
        format!(
            "Failed to read release store marker '{}': {error}",
            path.display()
        )
    })?;
    serde_json::from_slice(&bytes)
        .map_err(|error| format!("Invalid release store marker '{}': {error}", path.display()))
}

fn canonical_signed_payload(payload: &SignedCompatibilityPayload) -> Result<Vec<u8>, String> {
    serde_json::to_vec(payload)
        .map_err(|error| format!("Failed to encode signed compatibility payload: {error}"))
}

fn decode_tauri_minisign(value: &str, kind: &str) -> Result<String, String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(value.trim())
        .map_err(|error| format!("Invalid {kind} base64: {error}"))?;
    String::from_utf8(bytes).map_err(|error| format!("Invalid {kind} text: {error}"))
}

fn verify_target_descriptor(
    raw_json: &Value,
    channel: &ReleaseChannel,
    version: &str,
) -> Result<VerifiedTarget, String> {
    let envelope: SignedCompatibilityEnvelope = serde_json::from_value(
        raw_json
            .get("signedCompatibility")
            .cloned()
            .ok_or_else(|| {
                format!(
                    "{} update is missing signed compatibility metadata",
                    channel.label
                )
            })?,
    )
    .map_err(|error| {
        format!(
            "Invalid {} signed compatibility metadata: {error}",
            channel.label
        )
    })?;
    if envelope.schema_version != 1
        || envelope.channel_id != channel.id
        || envelope.version != version
        || envelope.artifact_sha256.len() != 64
        || !envelope
            .artifact_sha256
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(format!(
            "{} signed compatibility metadata does not match the target artifact",
            channel.label
        ));
    }
    validate_compatibility(&envelope.compatibility)?;
    let payload = SignedCompatibilityPayload {
        schema_version: envelope.schema_version,
        channel_id: envelope.channel_id,
        version: envelope.version,
        artifact_sha256: envelope.artifact_sha256.to_ascii_lowercase(),
        compatibility: envelope.compatibility.clone(),
    };
    let public_key_text = decode_tauri_minisign(&channel.pubkey, "updater public key")?;
    let signature_text = decode_tauri_minisign(&envelope.signature, "compatibility signature")?;
    let public_key = PublicKey::decode(&public_key_text)
        .map_err(|error| format!("Invalid updater public key: {error}"))?;
    let signature = Signature::decode(&signature_text)
        .map_err(|error| format!("Invalid compatibility signature: {error}"))?;
    public_key
        .verify(&canonical_signed_payload(&payload)?, &signature, true)
        .map_err(|error| format!("Compatibility signature verification failed: {error}"))?;
    Ok(VerifiedTarget {
        compatibility: envelope.compatibility,
        artifact_sha256: payload.artifact_sha256,
    })
}

fn can_read_current_data(target: &CompatibilityDescriptor, marker: &StoreMarker) -> bool {
    target.store_contract_version == marker.store_contract_version
        && target.min_readable_data_epoch <= marker.data_epoch
        && target.max_readable_data_epoch >= marker.data_epoch
}

fn format_update_date(date: Option<time::OffsetDateTime>) -> Result<Option<String>, String> {
    date.map(|date| {
        date.format(&time::format_description::well_known::Rfc3339)
            .map_err(|error| format!("Failed to format update date: {error}"))
    })
    .transpose()
}

fn is_newer_version(current: &Version, target: &Version) -> bool {
    target > current
}

async fn check_channel<R: Runtime>(
    webview: &Webview<R>,
    channel: &ReleaseChannel,
    require_newer_version: bool,
) -> Result<Option<tauri_plugin_updater::Update>, String> {
    let mut builder = webview
        .updater_builder()
        .endpoints(vec![channel.endpoint.clone()])
        .map_err(|error| error.to_string())?
        .pubkey(channel.pubkey.clone())
        .timeout(Duration::from_millis(CHECK_TIMEOUT_MS));
    if require_newer_version {
        builder = builder
            .version_comparator(|current, update| is_newer_version(&current, &update.version));
    }
    builder
        .build()
        .map_err(|error| error.to_string())?
        .check()
        .await
        .map_err(|error| error.to_string())
}

fn metadata_from_update<R: Runtime>(
    webview: &Webview<R>,
    update: tauri_plugin_updater::Update,
    channel: &ReleaseChannel,
) -> Result<ReleaseUpdateMetadata, String> {
    let date = format_update_date(update.date)?;
    let metadata = ReleaseUpdateMetadata {
        current_version: update.current_version.clone(),
        version: update.version.clone(),
        date,
        body: update.body.clone(),
        raw_json: update.raw_json.clone(),
        rid: webview.resources_table().add(update),
        target_channel_id: channel.id.clone(),
        target_channel_label: channel.label.clone(),
    };
    Ok(metadata)
}

#[tauri::command]
pub async fn get_release_runtime(
    state: State<'_, ReleaseChannelState>,
) -> Result<ReleaseRuntime, String> {
    Ok(state.runtime().await)
}

#[tauri::command]
pub async fn check_release_update<R: Runtime>(
    webview: Webview<R>,
    state: State<'_, ReleaseChannelState>,
) -> Result<Option<ReleaseUpdateMetadata>, String> {
    let _operation = state.0.operation.lock().await;
    let persisted = state.0.persisted.lock().await.clone();
    let channel = state.channel(&persisted.selected_feed)?;
    let waiting = persisted.waiting_for_main.is_some();
    let Some(update) = check_channel(&webview, channel, waiting).await? else {
        return Ok(None);
    };
    let verified = verify_target_descriptor(&update.raw_json, channel, &update.version)?;
    let store_marker = read_store_marker(&state.0.store_marker_path)?;
    if !can_read_current_data(&verified.compatibility, &store_marker) {
        return if waiting {
            Ok(None)
        } else {
            Err("The available release cannot safely read the data on this device".to_string())
        };
    }
    let prepared_key = format!("{}:{}", channel.id, update.version);
    state
        .0
        .prepared_targets
        .lock()
        .await
        .insert(prepared_key, verified.clone());
    let running = state
        .0
        .running_build
        .as_ref()
        .ok_or_else(|| "Running build identity is unavailable".to_string())?;
    let mut persisted = state.0.persisted.lock().await;
    persisted.pending_install = Some(PendingInstall {
        transition_id: Uuid::new_v4().to_string(),
        source_channel_id: running.channel_id.clone(),
        target_channel_id: channel.id.clone(),
        target_version: update.version.clone(),
        target_artifact_sha256: verified.artifact_sha256.clone(),
        target_compatibility: verified.compatibility.clone(),
        installed: false,
    });
    if waiting {
        persisted.waiting_for_main = None;
    }
    state.persist(&persisted)?;
    metadata_from_update(&webview, update, channel).map(Some)
}

#[tauri::command]
pub async fn prepare_channel_switch<R: Runtime>(
    webview: Webview<R>,
    state: State<'_, ReleaseChannelState>,
    request: PrepareChannelSwitchRequest,
) -> Result<Option<ReleaseUpdateMetadata>, String> {
    let _operation = state.0.operation.lock().await;
    let channel = state.channel(&request.channel_id)?;
    let running = state
        .0
        .running_build
        .as_ref()
        .ok_or_else(|| "Running build identity is unavailable".to_string())?;
    if channel.id == running.channel_id {
        return Ok(None);
    }
    // Channel switches are forward-only. Compatibility decides whether newer
    // code may read the store; it never authorizes reinstalling older code.
    let Some(update) = check_channel(&webview, channel, true).await? else {
        return Ok(None);
    };
    let verified = verify_target_descriptor(&update.raw_json, channel, &update.version)?;
    state
        .0
        .prepared_targets
        .lock()
        .await
        .insert(format!("{}:{}", channel.id, update.version), verified);
    metadata_from_update(&webview, update, channel).map(Some)
}

#[tauri::command]
pub async fn confirm_channel_switch(
    state: State<'_, ReleaseChannelState>,
    request: ConfirmChannelSwitchRequest,
) -> Result<ConfirmChannelSwitchResult, String> {
    let _operation = state.0.operation.lock().await;
    let channel = state.channel(&request.channel_id)?;
    let running = state
        .0
        .running_build
        .as_ref()
        .ok_or_else(|| "Running build identity is unavailable".to_string())?;
    let verified = state
        .0
        .prepared_targets
        .lock()
        .await
        .remove(&format!("{}:{}", channel.id, request.version))
        .ok_or_else(|| "The checked release no longer matches this confirmation".to_string())?;
    let store_marker = read_store_marker(&state.0.store_marker_path)?;
    let mut persisted = state.0.persisted.lock().await;

    if !can_read_current_data(&verified.compatibility, &store_marker) {
        persisted.selected_feed = channel.id.clone();
        persisted.pending_install = None;
        persisted.waiting_for_main = Some(WaitingForMain {
            source_channel_id: running.channel_id.clone(),
            target_channel_id: channel.id.clone(),
        });
        state.persist(&persisted)?;
        return Ok(ConfirmChannelSwitchResult {
            runtime: state.runtime_from(&persisted),
            waiting_message: Some("One part of this release isn't in the target release yet. Berd will stop updates from the current release and finish the switch as soon as a compatible release ships — you don't need to do anything.".to_string()),
        });
    }

    persisted.selected_feed = channel.id.clone();
    persisted.waiting_for_main = None;
    persisted.pending_install = Some(PendingInstall {
        transition_id: Uuid::new_v4().to_string(),
        source_channel_id: running.channel_id.clone(),
        target_channel_id: channel.id.clone(),
        target_version: request.version,
        target_artifact_sha256: verified.artifact_sha256,
        target_compatibility: verified.compatibility,
        installed: false,
    });
    state.persist(&persisted)?;
    Ok(ConfirmChannelSwitchResult {
        runtime: state.runtime_from(&persisted),
        waiting_message: None,
    })
}

#[tauri::command]
pub async fn download_and_install_release<R: Runtime>(
    webview: Webview<R>,
    state: State<'_, ReleaseChannelState>,
    rid: ResourceId,
    transition_id: Option<String>,
) -> Result<ReleaseRuntime, String> {
    let _operation = state.0.operation.lock().await;
    let update = webview
        .resources_table()
        .get::<tauri_plugin_updater::Update>(rid)
        .map_err(|error| error.to_string())?;
    let pending = state
        .0
        .persisted
        .lock()
        .await
        .pending_install
        .clone()
        .ok_or_else(|| "The checked update no longer has a pending identity".to_string())?;
    let expected_transition_id = transition_id
        .as_deref()
        .unwrap_or(pending.transition_id.as_str());
    if pending.transition_id != expected_transition_id {
        return Err("The channel switch no longer matches this download".to_string());
    }
    let bytes = update
        .download(|_, _| {}, || {})
        .await
        .map_err(|error| error.to_string())?;
    let digest = hex::encode(Sha256::digest(&bytes));
    if digest != pending.target_artifact_sha256 {
        return Err(
            "The downloaded update does not match its signed compatibility descriptor".to_string(),
        );
    }
    update.install(&bytes).map_err(|error| error.to_string())?;
    let mut persisted = state.0.persisted.lock().await;
    let pending = persisted
        .pending_install
        .as_mut()
        .filter(|pending| pending.transition_id == expected_transition_id)
        .ok_or_else(|| "The checked update no longer matches this download".to_string())?;
    pending.installed = true;
    state.persist(&persisted)?;
    Ok(state.runtime_from(&persisted))
}

#[tauri::command]
pub async fn complete_channel_switch_install(
    state: State<'_, ReleaseChannelState>,
    request: TransitionRequest,
) -> Result<ReleaseRuntime, String> {
    let mut persisted = state.0.persisted.lock().await;
    let pending = persisted
        .pending_install
        .as_mut()
        .ok_or_else(|| "No channel switch is pending".to_string())?;
    if pending.transition_id != request.transition_id {
        return Err("The channel switch no longer matches this download".to_string());
    }
    pending.installed = true;
    state.persist(&persisted)?;
    Ok(state.runtime_from(&persisted))
}

#[tauri::command]
pub async fn cancel_channel_switch(
    state: State<'_, ReleaseChannelState>,
    request: TransitionRequest,
) -> Result<ReleaseRuntime, String> {
    let mut persisted = state.0.persisted.lock().await;
    if persisted
        .pending_install
        .as_ref()
        .is_some_and(|pending| pending.transition_id == request.transition_id)
    {
        let source = persisted
            .pending_install
            .as_ref()
            .map(|pending| pending.source_channel_id.clone())
            .unwrap_or_default();
        persisted.selected_feed = source;
        persisted.pending_install = None;
        persisted.waiting_for_main = None;
        state.persist(&persisted)?;
    }
    Ok(state.runtime_from(&persisted))
}

/// Relaunch step of the update flow. The updater installs the new version
/// into the running bundle's existing path, so an install that still carries
/// a legacy name (e.g. "Goose 2.app" from a pre-rename Managed Software
/// Center install) would keep that name after every update. This renames such
/// a bundle in place to `Berd.app`, schedules a relaunch from the renamed
/// path, and exits; it returns `false` when no rename applies (canonical or
/// user-customized names) and the caller should fall back to the standard
/// restart.
#[tauri::command]
pub fn finalize_update_relaunch(app: AppHandle) -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        let handled = crate::services::installer_media::relaunch_into_renamed_bundle()
            .map_err(|error| error.to_string())?;
        if handled {
            app.exit(0);
        }
        Ok(handled)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Ok(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn compatibility(write: u64, min: u64, max: u64) -> CompatibilityDescriptor {
        CompatibilityDescriptor {
            store_contract_version: 1,
            writes_data_epoch: write,
            min_readable_data_epoch: min,
            max_readable_data_epoch: max,
        }
    }

    fn catalog() -> ReleaseCatalog {
        ReleaseCatalog {
            schema_version: 1,
            default_channel: "main".to_string(),
            running_build: BundledBuildIdentity {
                channel_id: "main".to_string(),
                compatibility: compatibility(1, 1, 2),
            },
            channels: vec![
                ReleaseChannel {
                    id: "main".to_string(),
                    label: "Main".to_string(),
                    description: None,
                    endpoint: Url::parse("https://updates.example.test/main.json").unwrap(),
                    pubkey: "main-key".to_string(),
                    what_to_test: None,
                    compatibility: compatibility(1, 1, 2),
                },
                ReleaseChannel {
                    id: "beta".to_string(),
                    label: "Beta".to_string(),
                    description: None,
                    endpoint: Url::parse("https://updates.example.test/beta.json").unwrap(),
                    pubkey: "beta-key".to_string(),
                    what_to_test: Some("Try it".to_string()),
                    compatibility: compatibility(2, 1, 2),
                },
            ],
        }
    }

    #[test]
    fn channel_switch_requires_a_newer_target_version() {
        let running = Version::parse("1.2.0").unwrap();

        assert!(!is_newer_version(
            &running,
            &Version::parse("1.1.9").unwrap()
        ));
        assert!(!is_newer_version(
            &running,
            &Version::parse("1.2.0").unwrap()
        ));
        assert!(is_newer_version(
            &running,
            &Version::parse("1.2.1").unwrap()
        ));
    }

    #[test]
    fn catalog_rejects_duplicate_endpoints() {
        let mut catalog = catalog();
        catalog.channels[1].endpoint = catalog.channels[0].endpoint.clone();
        let error = validate_catalog(&catalog).unwrap_err();
        assert!(
            error.contains("Duplicate release channel endpoint"),
            "unexpected validation error: {error}"
        );
    }

    #[test]
    fn store_marker_advances_before_beta_writes_and_blocks_old_main() {
        let dir = tempdir().unwrap();
        let path = dir.path().join(STORE_MARKER_FILE_NAME);
        initialize_store_marker(&path, &compatibility(1, 1, 1)).unwrap();
        initialize_store_marker(&path, &compatibility(2, 1, 2)).unwrap();
        let marker = read_store_marker(&path).unwrap();
        assert_eq!(marker.data_epoch, 2);
        assert!(!can_read_current_data(&compatibility(1, 1, 1), &marker));
    }

    #[test]
    fn compatibility_gate_accepts_readable_beta_epoch() {
        let marker = StoreMarker {
            schema_version: 1,
            store_contract_version: 1,
            data_epoch: 2,
        };
        assert!(can_read_current_data(&compatibility(1, 1, 2), &marker));
        assert!(!can_read_current_data(&compatibility(1, 1, 1), &marker));
    }

    #[test]
    fn atomic_state_write_round_trips() {
        let dir = tempdir().unwrap();
        let path = dir.path().join(STATE_FILE_NAME);
        let state = PersistedReleaseState {
            schema_version: 1,
            selected_feed: "beta".to_string(),
            pending_install: None,
            waiting_for_main: None,
        };
        write_json_atomically(&path, &state).unwrap();
        assert_eq!(read_persisted_state(&path).unwrap(), Some(state));
    }

    #[test]
    fn reconciliation_never_presents_pending_target_as_running() {
        let catalog = catalog();
        let running = RunningBuildInfo {
            channel_id: "main".to_string(),
            version: "1.0.0".to_string(),
            compatibility: compatibility(1, 1, 2),
            what_to_test: None,
        };
        let pending = PendingInstall {
            transition_id: "transition".to_string(),
            source_channel_id: "main".to_string(),
            target_channel_id: "beta".to_string(),
            target_version: "1.1.0".to_string(),
            target_artifact_sha256: "a".repeat(64),
            target_compatibility: compatibility(2, 1, 2),
            installed: true,
        };
        let (state, _) = reconcile_persisted_state(
            Some(&catalog),
            Some(&running),
            Some(PersistedReleaseState {
                schema_version: 1,
                selected_feed: "beta".to_string(),
                pending_install: Some(pending),
                waiting_for_main: None,
            }),
        );
        assert!(state.pending_install.is_none());
        assert_eq!(state.selected_feed, "beta");
        assert_eq!(running.channel_id, "main");
    }
}
