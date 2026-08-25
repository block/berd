//! Native discovery and parsing for Berd's silent first-boot import.
//!
//! The renderer receives a bounded, non-secret plan. Imported secrets are
//! applied through a native ACP connection so Goose remains authoritative and
//! plaintext never crosses into the webview. No renderer-provided filesystem
//! path is accepted by this module.

use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use tauri::{AppHandle, Manager};
use tokio_tungstenite::tungstenite::Message;
use yaml_serde::Value as YamlValue;

use crate::services::goose_config;

const MAX_CONFIG_BYTES: u64 = 1024 * 1024;
const MAX_SKILLS_PER_ROOT: usize = 256;
const MAX_SKILL_ROOT_ENTRIES: usize = 1024;
const MAX_ENTRIES_PER_SKILL: usize = 512;
const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_SKILL_BYTES: u64 = 16 * 1024 * 1024;
const MAX_SECRET_UPDATES: usize = 256;
const MAX_EXTENSION_UPDATES: usize = 256;
const DEFAULT_EXTENSION_TIMEOUT_SECONDS: u64 = 300;
const ACP_REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const ACP_CLOSE_TIMEOUT: Duration = Duration::from_secs(1);

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OnboardingImportPlan {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_defaults: Option<ImportedProviderDefaults>,
    pub imported_skills: u32,
    pub skipped_skills: u32,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedProviderDefaults {
    pub provider_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ImportedSecretUpdate {
    pub key: String,
    pub value: JsonValue,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeDesktopConfig {
    #[serde(default)]
    mcp_servers: BTreeMap<String, ClaudeMcpServer>,
}

#[derive(Debug, Deserialize)]
struct ClaudeMcpServer {
    command: Option<String>,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    env: BTreeMap<String, String>,
}

#[derive(Debug, Default)]
struct SkillCopyCounts {
    imported: u32,
    skipped: u32,
}

struct SkillCopyOutcome {
    counts: SkillCopyCounts,
    warnings: Vec<String>,
}

struct PreparedOnboardingImport {
    plan: OnboardingImportPlan,
    secret_updates: Vec<ImportedSecretUpdate>,
    extensions: BTreeMap<String, JsonValue>,
}

struct ImportLocations {
    goose_configs: Vec<PathBuf>,
    claude_configs: Vec<PathBuf>,
    personal_skills_root: PathBuf,
}

#[tauri::command]
pub async fn prepare_onboarding_import(app: AppHandle) -> Result<OnboardingImportPlan, String> {
    let active_goose_config = goose_config::config_path()?;
    let locations = if let Some(mode) = app.try_state::<crate::services::e2e_mode::E2eMode>() {
        isolated_import_locations(&active_goose_config, mode.goose_skills_dir())
    } else {
        let home = dirs::home_dir().ok_or_else(|| {
            "Failed to resolve the home directory for onboarding import".to_string()
        })?;
        standard_import_locations(&active_goose_config, &home, dirs::config_dir().as_deref())
    };

    let mut prepared = prepare_onboarding_import_from_locations(&locations)?;
    if !prepared.secret_updates.is_empty() || !prepared.extensions.is_empty() {
        let goose_serve_url = super::acp::get_goose_serve_url(app).await?;
        // Each bounded request gets its own deadline. A single aggregate deadline
        // would make a valid multi-update import fail forever at the same entry.
        let warnings = apply_import_updates_via_goose(
            &goose_serve_url,
            &prepared.secret_updates,
            &prepared.extensions,
        )
        .await?;
        prepared.plan.warnings.extend(warnings);
    }
    Ok(prepared.plan)
}

fn standard_import_locations(
    active_goose_config: &Path,
    home: &Path,
    platform_config: Option<&Path>,
) -> ImportLocations {
    ImportLocations {
        goose_configs: goose_config_candidate_paths(active_goose_config, home),
        claude_configs: claude_desktop_candidate_paths(platform_config, home),
        personal_skills_root: personal_skills_root(home),
    }
}

fn isolated_import_locations(
    active_goose_config: &Path,
    isolated_skills_root: PathBuf,
) -> ImportLocations {
    ImportLocations {
        goose_configs: vec![active_goose_config.to_path_buf()],
        claude_configs: Vec::new(),
        personal_skills_root: isolated_skills_root,
    }
}

fn prepare_onboarding_import_from_locations(
    locations: &ImportLocations,
) -> Result<PreparedOnboardingImport, String> {
    let mut plan = OnboardingImportPlan::default();
    let mut imported_extensions = BTreeMap::new();

    // Goose sorted candidates by display name, which put Claude Desktop ahead
    // of existing Goose configuration. Preserve that collision precedence.
    for path in &locations.claude_configs {
        match read_bounded_regular_file(path) {
            Ok(Some(bytes)) => match parse_claude_extensions(&bytes) {
                Ok((extensions, warnings)) => {
                    for (key, extension) in extensions {
                        imported_extensions.entry(key).or_insert(extension);
                    }
                    plan.warnings.extend(warnings);
                }
                Err(error) => plan.warnings.push(format!(
                    "Skipped Claude Desktop import at '{}': {error}",
                    path.display()
                )),
            },
            Ok(None) => {}
            Err(error) => plan.warnings.push(format!(
                "Skipped Claude Desktop import at '{}': {error}",
                path.display()
            )),
        }
    }

    let mut secret_updates = BTreeMap::new();
    for path in &locations.goose_configs {
        match read_bounded_regular_file(path) {
            Ok(Some(bytes)) => match parse_goose_config(&bytes) {
                Ok(config) => {
                    if let Some(defaults) = config.provider_defaults {
                        plan.provider_defaults = Some(defaults);
                    }
                    for (key, extension) in config.extensions {
                        imported_extensions.entry(key).or_insert(extension);
                    }
                    plan.warnings.extend(config.warnings);
                }
                Err(error) => {
                    plan.warnings.push(format!(
                        "Skipped Goose configuration import at '{}': {error}",
                        path.display()
                    ));
                    continue;
                }
            },
            Ok(None) => continue,
            Err(error) => {
                plan.warnings.push(format!(
                    "Skipped Goose configuration import at '{}': {error}",
                    path.display()
                ));
                continue;
            }
        }

        let Some(source_dir) = path.parent() else {
            continue;
        };
        let secrets_path = source_dir.join("secrets.yaml");
        match read_bounded_regular_file(&secrets_path) {
            Ok(Some(bytes)) => match parse_secret_updates(&bytes) {
                Ok(updates) => {
                    for update in updates {
                        secret_updates.insert(update.key, update.value);
                    }
                }
                Err(error) => plan.warnings.push(format!(
                    "Skipped Goose secrets import at '{}': {error}",
                    secrets_path.display()
                )),
            },
            Ok(None) => {}
            Err(error) => plan.warnings.push(format!(
                "Skipped Goose secrets import at '{}': {error}",
                secrets_path.display()
            )),
        }

        let outcome =
            copy_legacy_skills(&source_dir.join("skills"), &locations.personal_skills_root);
        plan.imported_skills += outcome.counts.imported;
        plan.skipped_skills += outcome.counts.skipped;
        plan.warnings.extend(outcome.warnings);
    }

    if secret_updates.len() > MAX_SECRET_UPDATES {
        let skipped = secret_updates.len() - MAX_SECRET_UPDATES;
        plan.warnings.push(format!(
            "Skipped {skipped} Goose secrets beyond the {MAX_SECRET_UPDATES}-entry import limit."
        ));
    }
    if imported_extensions.len() > MAX_EXTENSION_UPDATES {
        let skipped = imported_extensions.len() - MAX_EXTENSION_UPDATES;
        plan.warnings.push(format!(
            "Skipped {skipped} extensions beyond the {MAX_EXTENSION_UPDATES}-entry import limit."
        ));
    }
    let secret_updates = secret_updates
        .into_iter()
        .take(MAX_SECRET_UPDATES)
        .map(|(key, value)| ImportedSecretUpdate { key, value })
        .collect();
    let imported_extensions = imported_extensions
        .into_iter()
        .take(MAX_EXTENSION_UPDATES)
        .collect();
    Ok(PreparedOnboardingImport {
        plan,
        secret_updates,
        extensions: imported_extensions,
    })
}

async fn apply_import_updates_via_goose(
    goose_serve_url: &str,
    secret_updates: &[ImportedSecretUpdate],
    imported_extensions: &BTreeMap<String, JsonValue>,
) -> Result<Vec<String>, String> {
    let mut warnings = Vec::new();
    let connect = tokio_tungstenite::connect_async(goose_serve_url);
    let (mut socket, _) = tokio::time::timeout(ACP_REQUEST_TIMEOUT, connect)
        .await
        .map_err(|_| "Timed out connecting to Goose for onboarding import".to_string())?
        .map_err(|error| format!("Failed to connect to Goose for onboarding import: {error}"))?;

    let _ = send_acp_request(
        &mut socket,
        1,
        "initialize",
        serde_json::json!({
            "protocolVersion": 1,
            "clientCapabilities": {},
            "clientInfo": {
                "name": "berd-onboarding-import",
                "version": env!("CARGO_PKG_VERSION"),
            },
        }),
        "initialize secret import",
        ACP_REQUEST_TIMEOUT,
    )
    .await?;

    let mut next_id = 2;
    for update in secret_updates {
        let _ = send_acp_request(
            &mut socket,
            next_id,
            "_goose/unstable/config/upsert",
            serde_json::json!({
                "key": update.key,
                "value": update.value,
                "isSecret": true,
            }),
            "write an imported secret",
            ACP_REQUEST_TIMEOUT,
        )
        .await?;
        next_id += 1;
    }

    if !imported_extensions.is_empty() {
        let read_result = send_acp_request(
            &mut socket,
            next_id,
            "_goose/unstable/config/read",
            serde_json::json!({
                "key": "extensions",
                "isSecret": false,
            }),
            "read Goose extensions",
            ACP_REQUEST_TIMEOUT,
        )
        .await?;
        next_id += 1;

        let mut merged = match read_result.get("value") {
            None | Some(JsonValue::Null) => serde_json::Map::new(),
            Some(JsonValue::Object(current)) => current.clone(),
            Some(_) => {
                warnings.push(
                    "Skipped extension import because the existing Goose extensions config is not an object."
                        .to_string(),
                );
                let _ = tokio::time::timeout(ACP_CLOSE_TIMEOUT, socket.close(None)).await;
                return Ok(warnings);
            }
        };
        let mut changed = false;
        for (key, extension) in imported_extensions {
            if !merged.contains_key(key) {
                merged.insert(key.clone(), extension.clone());
                changed = true;
            }
        }
        if changed {
            let _ = send_acp_request(
                &mut socket,
                next_id,
                "_goose/unstable/config/upsert",
                serde_json::json!({
                    "key": "extensions",
                    "value": merged,
                    "isSecret": false,
                }),
                "write imported Goose extensions",
                ACP_REQUEST_TIMEOUT,
            )
            .await?;
        }
    }

    let _ = tokio::time::timeout(ACP_CLOSE_TIMEOUT, socket.close(None)).await;
    Ok(warnings)
}

async fn send_acp_request<S>(
    socket: &mut tokio_tungstenite::WebSocketStream<S>,
    id: u64,
    method: &str,
    params: JsonValue,
    operation: &str,
    request_timeout: Duration,
) -> Result<JsonValue, String>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let request = serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": method,
        "params": params,
    });
    tokio::time::timeout(request_timeout, async {
        socket
            .send(Message::Text(request.to_string().into()))
            .await
            .map_err(|error| format!("Failed to {operation}: {error}"))?;
        loop {
            let message = socket
                .next()
                .await
                .ok_or_else(|| "Goose closed the onboarding import connection".to_string())?
                .map_err(|error| format!("Goose onboarding import connection failed: {error}"))?;
            let value = match message {
                Message::Text(text) => serde_json::from_str::<JsonValue>(&text),
                Message::Binary(bytes) => serde_json::from_slice::<JsonValue>(&bytes),
                Message::Close(_) => {
                    return Err("Goose closed the onboarding import connection".to_string())
                }
                Message::Ping(payload) => {
                    socket
                        .send(Message::Pong(payload))
                        .await
                        .map_err(|error| format!("Failed to answer Goose heartbeat: {error}"))?;
                    continue;
                }
                Message::Pong(_) | Message::Frame(_) => continue,
            }
            .map_err(|error| format!("Goose returned invalid ACP data: {error}"))?;

            if value.get("id").and_then(JsonValue::as_u64) != Some(id) {
                continue;
            }
            if value.get("error").is_some() {
                return Err(format!("Goose failed to {operation}"));
            }
            let Some(result) = value.get("result") else {
                return Err(format!(
                    "Goose returned no result while attempting to {operation}"
                ));
            };
            return Ok(result.clone());
        }
    })
    .await
    .map_err(|_| format!("Timed out while asking Goose to {operation}"))?
}

struct ParsedGooseConfig {
    provider_defaults: Option<ImportedProviderDefaults>,
    extensions: BTreeMap<String, JsonValue>,
    warnings: Vec<String>,
}

fn parse_goose_config(bytes: &[u8]) -> Result<ParsedGooseConfig, String> {
    let root: YamlValue =
        yaml_serde::from_slice(bytes).map_err(|error| format!("invalid YAML: {error}"))?;
    let mapping = root
        .as_mapping()
        .ok_or_else(|| "top-level value must be a mapping".to_string())?;
    let provider_id = yaml_string(mapping, "GOOSE_PROVIDER");
    let model_id = yaml_string(mapping, "GOOSE_MODEL");
    let provider_defaults = provider_id.map(|provider_id| ImportedProviderDefaults {
        provider_id,
        model_id,
    });

    let mut extensions = BTreeMap::new();
    let mut warnings = Vec::new();
    if let Some(raw_extensions) = yaml_lookup(mapping, "extensions").and_then(YamlValue::as_mapping)
    {
        for (key, raw_extension) in raw_extensions {
            let Some(key) = key.as_str().filter(|key| !key.trim().is_empty()) else {
                warnings
                    .push("Skipped a Goose extension with a non-string or empty key.".to_string());
                continue;
            };
            match extension_with_name(raw_extension, key) {
                Ok(normalized) => {
                    extensions.insert(key.to_string(), normalized);
                }
                Err(error) => warnings.push(format!("Skipped Goose extension '{key}': {error}")),
            }
        }
    }

    Ok(ParsedGooseConfig {
        provider_defaults,
        extensions,
        warnings,
    })
}

fn extension_with_name(value: &YamlValue, config_key: &str) -> Result<JsonValue, String> {
    let mut mapping = value
        .as_mapping()
        .cloned()
        .ok_or_else(|| format!("extension '{config_key}' must be a mapping"))?;
    let name_key = YamlValue::String("name".to_string());
    if !mapping.contains_key(&name_key) {
        mapping.insert(name_key, YamlValue::String(config_key.to_string()));
    }
    serde_json::to_value(YamlValue::Mapping(mapping))
        .map_err(|error| format!("extension '{config_key}' is not JSON-compatible: {error}"))
}

fn parse_secret_updates(bytes: &[u8]) -> Result<Vec<ImportedSecretUpdate>, String> {
    let root: YamlValue =
        yaml_serde::from_slice(bytes).map_err(|error| format!("invalid YAML: {error}"))?;
    let mapping = root
        .as_mapping()
        .ok_or_else(|| "top-level value must be a mapping".to_string())?;
    let mut updates = Vec::new();
    for (key, value) in mapping {
        let Some(key) = key.as_str().filter(|key| !key.trim().is_empty()) else {
            continue;
        };
        let value = serde_json::to_value(value)
            .map_err(|error| format!("secret '{key}' is not JSON-compatible: {error}"))?;
        updates.push(ImportedSecretUpdate {
            key: key.to_string(),
            value,
        });
    }
    Ok(updates)
}

fn parse_claude_extensions(
    bytes: &[u8],
) -> Result<(BTreeMap<String, JsonValue>, Vec<String>), String> {
    let config: ClaudeDesktopConfig =
        serde_json::from_slice(bytes).map_err(|error| format!("invalid JSON: {error}"))?;
    let mut extensions = BTreeMap::new();
    let mut warnings = Vec::new();

    for (name, server) in config.mcp_servers {
        let Some(command) = server.command.filter(|command| !command.trim().is_empty()) else {
            warnings.push(format!("Claude MCP server '{name}' has no command."));
            continue;
        };
        let envs = server
            .env
            .into_iter()
            .filter(|(key, _)| !is_disallowed_environment_key(key))
            .collect::<BTreeMap<_, _>>();
        let config_key = extension_config_key(&name);
        let mut extension = serde_json::Map::new();
        extension.insert("enabled".to_string(), JsonValue::Bool(true));
        extension.insert("type".to_string(), JsonValue::String("stdio".to_string()));
        extension.insert("name".to_string(), JsonValue::String(name));
        extension.insert(
            "description".to_string(),
            JsonValue::String("Imported from Claude Desktop".to_string()),
        );
        extension.insert("cmd".to_string(), JsonValue::String(command));
        extension.insert(
            "args".to_string(),
            serde_json::to_value(server.args).expect("string arguments serialize"),
        );
        extension.insert(
            "envs".to_string(),
            serde_json::to_value(envs).expect("string environment map serializes"),
        );
        extension.insert("env_keys".to_string(), JsonValue::Array(Vec::new()));
        extension.insert(
            "timeout".to_string(),
            JsonValue::Number(DEFAULT_EXTENSION_TIMEOUT_SECONDS.into()),
        );
        extensions.insert(config_key, JsonValue::Object(extension));
    }

    Ok((extensions, warnings))
}

fn read_bounded_regular_file(path: &Path) -> Result<Option<Vec<u8>>, String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("failed to inspect file: {error}")),
    };
    if metadata.file_type().is_symlink() {
        return Err("symbolic links are not allowed".to_string());
    }
    if !metadata.file_type().is_file() {
        return Err("path is not a regular file".to_string());
    }
    if metadata.len() > MAX_CONFIG_BYTES {
        return Err(format!("file exceeds {MAX_CONFIG_BYTES} bytes"));
    }

    let file = fs::File::open(path).map_err(|error| format!("failed to open file: {error}"))?;
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(MAX_CONFIG_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("failed to read file: {error}"))?;
    if bytes.len() as u64 > MAX_CONFIG_BYTES {
        return Err(format!("file exceeds {MAX_CONFIG_BYTES} bytes"));
    }
    Ok(Some(bytes))
}

fn copy_legacy_skills(source_root: &Path, target_root: &Path) -> SkillCopyOutcome {
    let mut outcome = SkillCopyOutcome {
        counts: SkillCopyCounts::default(),
        warnings: Vec::new(),
    };
    let metadata = match fs::symlink_metadata(source_root) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return outcome;
        }
        Err(error) => {
            outcome.warnings.push(format!(
                "Failed to inspect legacy skills at '{}': {error}",
                source_root.display()
            ));
            return outcome;
        }
    };
    if metadata.file_type().is_symlink() || !metadata.file_type().is_dir() {
        return outcome;
    }

    if let Ok(target_metadata) = fs::symlink_metadata(target_root) {
        if target_metadata.file_type().is_symlink() || !target_metadata.file_type().is_dir() {
            outcome.warnings.push(format!(
                "Personal skills path '{}' must be a directory and cannot be a symbolic link",
                target_root.display()
            ));
            return outcome;
        }
    }
    if let Err(error) = fs::create_dir_all(target_root) {
        outcome.warnings.push(format!(
            "Failed to create personal skills directory '{}': {error}",
            target_root.display()
        ));
        return outcome;
    }
    let directory = match fs::read_dir(source_root) {
        Ok(directory) => directory,
        Err(error) => {
            outcome.warnings.push(format!(
                "Failed to read legacy skills directory '{}': {error}",
                source_root.display()
            ));
            return outcome;
        }
    };
    let mut entries = Vec::new();
    for entry in directory {
        if entries.len() >= MAX_SKILL_ROOT_ENTRIES {
            outcome.warnings.push(format!(
                "Legacy skill directory '{}' exceeds the {MAX_SKILL_ROOT_ENTRIES}-entry import limit",
                source_root.display()
            ));
            return outcome;
        }
        match entry {
            Ok(entry) => entries.push(entry),
            Err(error) => outcome
                .warnings
                .push(format!("Skipped a legacy skill entry: {error}")),
        }
    }
    entries.sort_by_key(|entry| entry.file_name());

    let mut candidates = Vec::new();
    for entry in entries {
        let file_type = match entry.file_type() {
            Ok(file_type) => file_type,
            Err(error) => {
                outcome
                    .warnings
                    .push(format!("Skipped a legacy skill: {error}"));
                outcome.counts.skipped += 1;
                continue;
            }
        };
        if file_type.is_symlink() || !file_type.is_dir() {
            continue;
        }
        let source = entry.path();
        let skill_file = source.join("SKILL.md");
        let Ok(skill_metadata) = fs::symlink_metadata(&skill_file) else {
            continue;
        };
        if skill_metadata.file_type().is_symlink() || !skill_metadata.file_type().is_file() {
            continue;
        }
        candidates.push(entry);
    }
    if candidates.len() > MAX_SKILLS_PER_ROOT {
        outcome.warnings.push(format!(
            "Legacy skill directory '{}' contains {} skills; the import limit is {MAX_SKILLS_PER_ROOT}",
            source_root.display(),
            candidates.len()
        ));
        outcome.counts.skipped += candidates.len() as u32;
        return outcome;
    }

    for entry in candidates {
        let source = entry.path();
        let target = target_root.join(entry.file_name());
        if target.exists() {
            outcome.counts.skipped += 1;
            continue;
        }
        let staging = target_root.join(format!(
            ".berd-onboarding-{}",
            uuid::Uuid::new_v4().simple()
        ));
        if let Err(error) = copy_skill_tree(&source, &staging) {
            let _ = fs::remove_dir_all(&staging);
            outcome.warnings.push(format!(
                "Failed to import legacy skill '{}': {error}",
                source.display()
            ));
            outcome.counts.skipped += 1;
            continue;
        }
        if target.exists() {
            let _ = fs::remove_dir_all(&staging);
            outcome.counts.skipped += 1;
            continue;
        }
        if let Err(error) = fs::rename(&staging, &target) {
            let _ = fs::remove_dir_all(&staging);
            outcome.warnings.push(format!(
                "Failed to publish imported skill '{}': {error}",
                target.display()
            ));
            outcome.counts.skipped += 1;
            continue;
        }
        outcome.counts.imported += 1;
    }

    outcome
}

fn copy_skill_tree(source: &Path, target: &Path) -> Result<(), String> {
    fs::create_dir(target)
        .map_err(|error| format!("failed to create staging directory: {error}"))?;
    let mut pending = vec![(source.to_path_buf(), target.to_path_buf())];
    let mut entry_count = 0usize;
    let mut total_bytes = 0u64;

    while let Some((source_dir, target_dir)) = pending.pop() {
        let directory = fs::read_dir(&source_dir)
            .map_err(|error| format!("failed to read directory: {error}"))?;
        let mut entries = Vec::new();
        for entry in directory {
            entry_count += 1;
            if entry_count > MAX_ENTRIES_PER_SKILL {
                return Err(format!(
                    "skill exceeds the {MAX_ENTRIES_PER_SKILL}-entry import limit"
                ));
            }
            entries
                .push(entry.map_err(|error| format!("failed to read directory entry: {error}"))?);
        }
        entries.sort_by_key(|entry| entry.file_name());

        for entry in entries {
            let metadata = fs::symlink_metadata(entry.path())
                .map_err(|error| format!("failed to inspect entry: {error}"))?;
            if metadata.file_type().is_symlink() {
                continue;
            }
            let destination = target_dir.join(entry.file_name());
            if metadata.file_type().is_dir() {
                fs::create_dir(&destination)
                    .map_err(|error| format!("failed to create directory: {error}"))?;
                pending.push((entry.path(), destination));
                continue;
            }
            if !metadata.file_type().is_file() {
                continue;
            }
            if metadata.len() > MAX_FILE_BYTES {
                return Err("skill exceeds import size limits".to_string());
            }
            let input = fs::File::open(entry.path())
                .map_err(|error| format!("failed to open source file: {error}"))?;
            let mut output = fs::File::create(&destination)
                .map_err(|error| format!("failed to create destination file: {error}"))?;
            let copied = std::io::copy(&mut input.take(MAX_FILE_BYTES + 1), &mut output)
                .map_err(|error| format!("failed to copy file: {error}"))?;
            total_bytes = total_bytes.saturating_add(copied);
            if copied > MAX_FILE_BYTES || total_bytes > MAX_SKILL_BYTES {
                return Err("skill exceeds import size limits".to_string());
            }
            output
                .flush()
                .map_err(|error| format!("failed to flush destination file: {error}"))?;
        }
    }
    Ok(())
}

fn goose_config_candidate_paths(active_config: &Path, home: &Path) -> Vec<PathBuf> {
    dedupe_paths(vec![
        active_config.to_path_buf(),
        home.join(".config").join("goose").join("config.yaml"),
    ])
}

fn claude_desktop_candidate_paths(platform_config: Option<&Path>, home: &Path) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Some(config) = platform_config {
        paths.push(config.join("Claude").join("claude_desktop_config.json"));
    }
    paths.push(
        home.join("Library")
            .join("Application Support")
            .join("Claude")
            .join("claude_desktop_config.json"),
    );
    paths.push(
        home.join("AppData")
            .join("Roaming")
            .join("Claude")
            .join("claude_desktop_config.json"),
    );
    dedupe_paths(paths)
}

fn personal_skills_root(home: &Path) -> PathBuf {
    home.join(".agents").join("skills")
}

fn dedupe_paths(paths: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut seen = HashSet::new();
    paths
        .into_iter()
        .filter(|path| seen.insert(path.clone()))
        .collect()
}

fn yaml_lookup<'a>(mapping: &'a yaml_serde::Mapping, key: &str) -> Option<&'a YamlValue> {
    mapping.get(YamlValue::String(key.to_string()))
}

fn yaml_string(mapping: &yaml_serde::Mapping, key: &str) -> Option<String> {
    yaml_lookup(mapping, key)
        .and_then(YamlValue::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn extension_config_key(name: &str) -> String {
    name.chars()
        .map(|character| match character {
            character
                if character.is_ascii_alphanumeric() || character == '_' || character == '-' =>
            {
                character
            }
            character if character.is_whitespace() => '\0',
            _ => '_',
        })
        .filter(|character| *character != '\0')
        .collect::<String>()
        .to_ascii_lowercase()
}

fn is_disallowed_environment_key(key: &str) -> bool {
    const DISALLOWED: &[&str] = &[
        "PATH",
        "PATHEXT",
        "SystemRoot",
        "windir",
        "LD_LIBRARY_PATH",
        "LD_PRELOAD",
        "LD_AUDIT",
        "LD_DEBUG",
        "LD_BIND_NOW",
        "LD_ASSUME_KERNEL",
        "DYLD_LIBRARY_PATH",
        "DYLD_INSERT_LIBRARIES",
        "DYLD_FRAMEWORK_PATH",
        "PYTHONPATH",
        "PYTHONHOME",
        "NODE_OPTIONS",
        "RUBYOPT",
        "GEM_PATH",
        "GEM_HOME",
        "CLASSPATH",
        "GO111MODULE",
        "GOROOT",
        "APPINIT_DLLS",
        "SESSIONNAME",
        "ComSpec",
        "TEMP",
        "TMP",
        "LOCALAPPDATA",
        "USERPROFILE",
        "HOMEDRIVE",
        "HOMEPATH",
    ];
    DISALLOWED
        .iter()
        .any(|disallowed| disallowed.eq_ignore_ascii_case(key))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn candidate_roots_match_goose_on_linux_macos_and_windows() {
        let linux_home = Path::new("/home/alice");
        assert_eq!(
            goose_config_candidate_paths(
                Path::new("/home/alice/.config/goose/config.yaml"),
                linux_home,
            ),
            vec![PathBuf::from("/home/alice/.config/goose/config.yaml")]
        );

        let mac_home = Path::new("/Users/alice");
        let mac_config = mac_home.join("Library").join("Application Support");
        let mac_paths = claude_desktop_candidate_paths(Some(&mac_config), mac_home);
        assert_eq!(
            mac_paths[0],
            PathBuf::from(
                "/Users/alice/Library/Application Support/Claude/claude_desktop_config.json"
            )
        );
        assert_eq!(
            personal_skills_root(mac_home),
            PathBuf::from("/Users/alice/.agents/skills")
        );

        let windows_home = Path::new("C:/Users/Alice");
        let windows_config = windows_home.join("AppData").join("Roaming");
        let windows_paths = claude_desktop_candidate_paths(Some(&windows_config), windows_home);
        assert!(windows_paths.contains(&PathBuf::from(
            "C:/Users/Alice/AppData/Roaming/Claude/claude_desktop_config.json"
        )));
        assert_eq!(
            personal_skills_root(windows_home),
            PathBuf::from("C:/Users/Alice/.agents/skills")
        );
    }

    #[test]
    fn parses_goose_defaults_extensions_and_secrets() {
        let config = parse_goose_config(
            br#"
GOOSE_PROVIDER: openai
GOOSE_MODEL: gpt-5.1
extensions:
  github:
    enabled: true
    type: stdio
    description: GitHub
    cmd: npx
    args: [github-mcp]
"#,
        )
        .unwrap();
        assert_eq!(
            config.provider_defaults,
            Some(ImportedProviderDefaults {
                provider_id: "openai".to_string(),
                model_id: Some("gpt-5.1".to_string()),
            })
        );
        assert_eq!(config.extensions["github"]["name"], "github");

        let secrets = parse_secret_updates(b"OPENAI_API_KEY: secret\nCOUNT: 2\n").unwrap();
        assert_eq!(secrets.len(), 2);
        assert!(secrets
            .iter()
            .any(|update| update.key == "OPENAI_API_KEY" && update.value == "secret"));
    }

    #[test]
    fn malformed_goose_extension_does_not_hide_valid_candidate_data() {
        let config = parse_goose_config(
            br#"
GOOSE_PROVIDER: openai
extensions:
  broken: not-a-mapping
  github:
    enabled: true
    type: stdio
    cmd: npx
    args: []
"#,
        )
        .unwrap();

        assert_eq!(
            config
                .provider_defaults
                .as_ref()
                .map(|defaults| defaults.provider_id.as_str()),
            Some("openai")
        );
        assert!(config.extensions.contains_key("github"));
        assert!(!config.extensions.contains_key("broken"));
        assert_eq!(config.warnings.len(), 1);
        assert!(config.warnings[0].contains("broken"));
    }

    #[test]
    fn parses_claude_servers_and_filters_unsafe_environment() {
        let (extensions, warnings) = parse_claude_extensions(
            br#"{
              "mcpServers": {
                "Git Hub": {
                  "command": "npx",
                  "args": ["github-mcp"],
                  "env": {"TOKEN": "secret", "PATH": "/untrusted"}
                },
                "broken": {"args": []}
              }
            }"#,
        )
        .unwrap();

        assert_eq!(warnings, vec!["Claude MCP server 'broken' has no command."]);
        let extension = &extensions["github"];
        assert_eq!(extension["name"], "Git Hub");
        assert_eq!(extension["envs"]["TOKEN"], "secret");
        assert!(extension["envs"].get("PATH").is_none());
    }

    #[test]
    fn copies_skill_supporting_files_without_overwriting_collisions() {
        let temp = TempDir::new().unwrap();
        let source = temp.path().join("legacy");
        let target = temp.path().join("personal");
        let legacy_skill = source.join("reviewer");
        fs::create_dir_all(legacy_skill.join("references")).unwrap();
        fs::write(legacy_skill.join("SKILL.md"), "# Reviewer").unwrap();
        fs::write(legacy_skill.join("references").join("guide.md"), "guide").unwrap();

        let first = copy_legacy_skills(&source, &target);
        assert_eq!(first.counts.imported, 1);
        assert_eq!(
            fs::read_to_string(target.join("reviewer/references/guide.md")).unwrap(),
            "guide"
        );

        fs::write(legacy_skill.join("SKILL.md"), "changed").unwrap();
        let second = copy_legacy_skills(&source, &target);
        assert_eq!(second.counts.skipped, 1);
        assert_eq!(
            fs::read_to_string(target.join("reviewer/SKILL.md")).unwrap(),
            "# Reviewer"
        );
    }

    #[test]
    fn skill_count_over_limit_warns_instead_of_aborting_migration() {
        let temp = TempDir::new().unwrap();
        let source = temp.path().join("legacy");
        let target = temp.path().join("personal");
        for index in 0..=MAX_SKILLS_PER_ROOT {
            let skill = source.join(format!("skill-{index}"));
            fs::create_dir_all(&skill).unwrap();
            fs::write(skill.join("SKILL.md"), "# Skill").unwrap();
        }

        let outcome = copy_legacy_skills(&source, &target);

        assert!(outcome.warnings[0].contains("contains 257 skills"));
        assert_eq!(outcome.counts.skipped, 257);
        assert!(!target.join("skill-0").exists());
    }

    #[test]
    fn invalid_skill_is_skipped_without_hiding_valid_imports() {
        let temp = TempDir::new().unwrap();
        let source = temp.path().join("legacy");
        let target = temp.path().join("personal");
        let invalid = source.join("a-invalid");
        let valid = source.join("b-valid");
        fs::create_dir_all(&invalid).unwrap();
        fs::create_dir_all(&valid).unwrap();
        fs::File::create(invalid.join("SKILL.md"))
            .unwrap()
            .set_len(MAX_FILE_BYTES + 1)
            .unwrap();
        fs::write(valid.join("SKILL.md"), "# Valid").unwrap();

        let outcome = copy_legacy_skills(&source, &target);

        assert_eq!(outcome.counts.imported, 1);
        assert_eq!(outcome.counts.skipped, 1);
        assert_eq!(outcome.warnings.len(), 1);
        assert!(outcome.warnings[0].contains("a-invalid"));
        assert!(target.join("b-valid/SKILL.md").exists());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinked_config_and_skips_symlinked_skill_content() {
        use std::os::unix::fs::symlink;

        let temp = TempDir::new().unwrap();
        let real_config = temp.path().join("real.yaml");
        let linked_config = temp.path().join("linked.yaml");
        fs::write(&real_config, "GOOSE_PROVIDER: openai\n").unwrap();
        symlink(&real_config, &linked_config).unwrap();
        assert!(read_bounded_regular_file(&linked_config)
            .unwrap_err()
            .contains("symbolic links"));

        let source = temp.path().join("skills");
        let target = temp.path().join("personal");
        let skill = source.join("reviewer");
        fs::create_dir_all(&skill).unwrap();
        fs::write(skill.join("SKILL.md"), "# Reviewer").unwrap();
        let outside = temp.path().join("outside.txt");
        fs::write(&outside, "private").unwrap();
        symlink(&outside, skill.join("linked.txt")).unwrap();

        let outcome = copy_legacy_skills(&source, &target);
        assert_eq!(outcome.counts.imported, 1);
        assert!(!target.join("reviewer/linked.txt").exists());
    }

    #[test]
    fn end_to_end_plan_uses_only_fixed_sources_and_personal_skill_root() {
        let temp = TempDir::new().unwrap();
        let home = temp.path().join("home");
        let active = temp.path().join("active/config/config.yaml");
        fs::create_dir_all(active.parent().unwrap().join("skills/reviewer/assets")).unwrap();
        fs::write(
            &active,
            "GOOSE_PROVIDER: openai\nextensions:\n  github:\n    enabled: true\n    type: stdio\n    cmd: npx\n    args: []\n    envs:\n      TOKEN: extension-secret\n",
        )
        .unwrap();
        fs::write(
            active.parent().unwrap().join("secrets.yaml"),
            "OPENAI_API_KEY: secret\n",
        )
        .unwrap();
        fs::write(
            active.parent().unwrap().join("skills/reviewer/SKILL.md"),
            "# Reviewer",
        )
        .unwrap();
        fs::write(
            active
                .parent()
                .unwrap()
                .join("skills/reviewer/assets/checklist.md"),
            "checklist",
        )
        .unwrap();

        let locations = standard_import_locations(&active, &home, None);
        let prepared = prepare_onboarding_import_from_locations(&locations).unwrap();

        assert_eq!(prepared.plan.imported_skills, 1);
        assert_eq!(prepared.secret_updates.len(), 1);
        assert!(prepared.extensions.contains_key("github"));
        let serialized_plan = serde_json::to_string(&prepared.plan).unwrap();
        assert!(!serialized_plan.contains("extension-secret"));
        assert!(!serialized_plan.contains("OPENAI_API_KEY"));
        assert!(home
            .join(".agents/skills/reviewer/assets/checklist.md")
            .exists());
    }

    #[test]
    fn caps_native_secret_updates_without_exposing_values() {
        let temp = TempDir::new().unwrap();
        let active = temp.path().join("active/config/config.yaml");
        fs::create_dir_all(active.parent().unwrap()).unwrap();
        fs::write(&active, "GOOSE_PROVIDER: openai\n").unwrap();
        let secrets = (0..=MAX_SECRET_UPDATES)
            .map(|index| format!("SECRET_{index:03}: value-{index}\n"))
            .collect::<String>();
        fs::write(active.parent().unwrap().join("secrets.yaml"), secrets).unwrap();
        let locations = ImportLocations {
            goose_configs: vec![active],
            claude_configs: Vec::new(),
            personal_skills_root: temp.path().join("skills"),
        };

        let prepared = prepare_onboarding_import_from_locations(&locations).unwrap();

        assert_eq!(prepared.secret_updates.len(), MAX_SECRET_UPDATES);
        assert!(prepared
            .plan
            .warnings
            .iter()
            .any(|warning| warning.contains("Skipped 1 Goose secrets")));
        let serialized_plan = serde_json::to_string(&prepared.plan).unwrap();
        assert!(!serialized_plan.contains("value-0"));
    }

    #[tokio::test]
    async fn applies_secrets_over_native_acp_connection() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
            let mut requests = Vec::new();
            for _ in 0..2 {
                let message = socket.next().await.unwrap().unwrap();
                let Message::Text(text) = message else {
                    panic!("expected a text ACP request");
                };
                let request: JsonValue = serde_json::from_str(&text).unwrap();
                let id = request["id"].as_u64().unwrap();
                requests.push(request);
                socket
                    .send(Message::Text(
                        serde_json::json!({"jsonrpc": "2.0", "id": id, "result": {}})
                            .to_string()
                            .into(),
                    ))
                    .await
                    .unwrap();
            }
            requests
        });
        let updates = vec![ImportedSecretUpdate {
            key: "OPENAI_API_KEY".to_string(),
            value: JsonValue::String("native-only-secret".to_string()),
        }];

        apply_import_updates_via_goose(&format!("ws://{address}"), &updates, &BTreeMap::new())
            .await
            .unwrap();
        let requests = server.await.unwrap();

        assert_eq!(requests[0]["method"], "initialize");
        assert_eq!(requests[1]["method"], "_goose/unstable/config/upsert");
        assert_eq!(requests[1]["params"]["isSecret"], true);
        assert_eq!(requests[1]["params"]["value"], "native-only-secret");
    }

    #[tokio::test]
    async fn merges_extensions_without_overwriting_existing_config() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
            let mut requests = Vec::new();
            for index in 0..3 {
                let message = socket.next().await.unwrap().unwrap();
                let Message::Text(text) = message else {
                    panic!("expected a text ACP request");
                };
                let request: JsonValue = serde_json::from_str(&text).unwrap();
                let id = request["id"].as_u64().unwrap();
                requests.push(request);
                let result = if index == 1 {
                    serde_json::json!({
                        "value": {"github": {"enabled": false, "source": "existing"}}
                    })
                } else {
                    serde_json::json!({})
                };
                socket
                    .send(Message::Text(
                        serde_json::json!({"jsonrpc": "2.0", "id": id, "result": result})
                            .to_string()
                            .into(),
                    ))
                    .await
                    .unwrap();
            }
            requests
        });
        let extensions = BTreeMap::from([
            (
                "github".to_string(),
                serde_json::json!({"enabled": true, "source": "imported"}),
            ),
            (
                "slack".to_string(),
                serde_json::json!({"enabled": true, "envs": {"TOKEN": "native-only"}}),
            ),
        ]);

        apply_import_updates_via_goose(&format!("ws://{address}"), &[], &extensions)
            .await
            .unwrap();
        let requests = server.await.unwrap();

        assert_eq!(requests[1]["method"], "_goose/unstable/config/read");
        let persisted = &requests[2]["params"]["value"];
        assert_eq!(persisted["github"]["source"], "existing");
        assert_eq!(persisted["slack"]["envs"]["TOKEN"], "native-only");
    }

    #[tokio::test]
    async fn preserves_malformed_existing_extensions_config() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
            let mut requests = Vec::new();
            for index in 0..2 {
                let message = socket.next().await.unwrap().unwrap();
                let Message::Text(text) = message else {
                    panic!("expected a text ACP request");
                };
                let request: JsonValue = serde_json::from_str(&text).unwrap();
                let id = request["id"].as_u64().unwrap();
                requests.push(request);
                let result = if index == 1 {
                    serde_json::json!({"value": "malformed"})
                } else {
                    serde_json::json!({})
                };
                socket
                    .send(Message::Text(
                        serde_json::json!({"jsonrpc": "2.0", "id": id, "result": result})
                            .to_string()
                            .into(),
                    ))
                    .await
                    .unwrap();
            }
            requests
        });
        let extensions =
            BTreeMap::from([("github".to_string(), serde_json::json!({"enabled": true}))]);

        let warnings = apply_import_updates_via_goose(&format!("ws://{address}"), &[], &extensions)
            .await
            .unwrap();
        let requests = server.await.unwrap();

        assert_eq!(warnings.len(), 1);
        assert!(warnings[0].contains("Skipped extension import"));
        assert_eq!(requests.len(), 2);
        assert_eq!(requests[1]["method"], "_goose/unstable/config/read");
    }

    #[tokio::test]
    async fn delayed_peer_can_apply_multiple_secret_updates() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
            let mut request_count = 0;
            for _ in 0..4 {
                let message = socket.next().await.unwrap().unwrap();
                let Message::Text(text) = message else {
                    panic!("expected a text ACP request");
                };
                let request: JsonValue = serde_json::from_str(&text).unwrap();
                let id = request["id"].as_u64().unwrap();
                tokio::time::sleep(Duration::from_millis(25)).await;
                socket
                    .send(Message::Text(
                        serde_json::json!({"jsonrpc": "2.0", "id": id, "result": {}})
                            .to_string()
                            .into(),
                    ))
                    .await
                    .unwrap();
                request_count += 1;
            }
            request_count
        });
        let updates = (0..3)
            .map(|index| ImportedSecretUpdate {
                key: format!("SECRET_{index}"),
                value: JsonValue::String(format!("value-{index}")),
            })
            .collect::<Vec<_>>();

        apply_import_updates_via_goose(&format!("ws://{address}"), &updates, &BTreeMap::new())
            .await
            .unwrap();

        assert_eq!(server.await.unwrap(), 4);
    }

    #[tokio::test]
    async fn acp_request_timeout_includes_a_blocked_send() {
        let (client, _stalled_peer) = tokio::io::duplex(64);
        let mut socket = tokio_tungstenite::WebSocketStream::from_raw_socket(
            client,
            tokio_tungstenite::tungstenite::protocol::Role::Client,
            None,
        )
        .await;

        let error = send_acp_request(
            &mut socket,
            1,
            "test",
            JsonValue::String("x".repeat(1024 * 1024)),
            "send a test request",
            Duration::from_millis(25),
        )
        .await
        .unwrap_err();

        assert!(error.contains("Timed out while asking Goose"));
    }

    #[test]
    fn isolated_locations_never_scan_or_write_the_real_home() {
        let active = PathBuf::from("/tmp/e2e/goose/config/config.yaml");
        let isolated_skills = PathBuf::from("/tmp/e2e/goose/.agents/skills");

        let locations = isolated_import_locations(&active, isolated_skills.clone());

        assert_eq!(locations.goose_configs, vec![active]);
        assert!(locations.claude_configs.is_empty());
        assert_eq!(locations.personal_skills_root, isolated_skills);
        assert!(!locations
            .personal_skills_root
            .starts_with(Path::new("/Users/developer")));
    }
}
