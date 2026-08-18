use std::{
    collections::HashSet,
    env, fs,
    path::{Path, PathBuf},
};

use serde::Serialize;
use serde_json::Value as JsonValue;
use yaml_serde::Value as YamlValue;

use crate::services::goose_config;

const MAX_CONFIG_BYTES: u64 = 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum McpHarnessId {
    Goose,
    ClaudeCode,
    Codex,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum McpConfigScope {
    User,
    Project,
    LocalProject,
    Profile,
    Additional,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum McpTransportKind {
    Stdio,
    Http,
    Sse,
    Acp,
    Builtin,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum McpInventoryStatus {
    Configured,
    Unavailable,
    Partial,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpConfigSource {
    pub scope: McpConfigScope,
    pub label: String,
    pub path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpConfiguredServer {
    pub id: String,
    pub harness: McpHarnessId,
    pub source: McpConfigSource,
    pub config_key: String,
    pub name: String,
    pub transport: McpTransportKind,
    pub enabled: Option<bool>,
    pub command: Option<String>,
    pub url_host: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum McpSourceStatus {
    Found,
    Missing,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpCheckedLocation {
    pub scope: McpConfigScope,
    pub label: String,
    pub path: Option<String>,
    pub status: McpSourceStatus,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpHarnessInventory {
    pub harness: McpHarnessId,
    pub status: McpInventoryStatus,
    pub checked_locations: Vec<McpCheckedLocation>,
    pub servers: Vec<McpConfiguredServer>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpInventory {
    pub harnesses: Vec<McpHarnessInventory>,
}

#[derive(Debug, Clone)]
pub struct ConfigFile {
    pub path: PathBuf,
    pub scope: McpConfigScope,
    pub label: String,
}

impl ConfigFile {
    fn with_scope(&self, scope: McpConfigScope, label: &str) -> Self {
        Self {
            path: self.path.clone(),
            scope,
            label: label.to_string(),
        }
    }
}

#[tauri::command]
pub async fn list_local_mcp_inventory(
    workspace_paths: Option<Vec<String>>,
) -> Result<McpInventory, String> {
    let workspace_paths = workspace_paths.unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || {
        list_local_mcp_inventory_blocking(&workspace_paths)
    })
    .await
    .map_err(|error| format!("MCP inventory task failed: {error}"))?
}

fn list_local_mcp_inventory_blocking(workspace_paths: &[String]) -> Result<McpInventory, String> {
    Ok(McpInventory {
        harnesses: vec![
            discover_goose(),
            discover_claude_code(workspace_paths),
            discover_codex(workspace_paths),
        ],
    })
}

fn discover_goose() -> McpHarnessInventory {
    let mut files = Vec::new();
    if let Ok(path) = goose_config::config_path() {
        files.push(ConfigFile {
            path,
            scope: McpConfigScope::User,
            label: "Goose user config".to_string(),
        });
    }

    for path in goose_additional_config_paths() {
        files.push(ConfigFile {
            path,
            scope: McpConfigScope::Additional,
            label: "Goose additional config".to_string(),
        });
    }

    let mut inventory = empty_inventory(McpHarnessId::Goose);
    let mut messages = Vec::new();

    for file in files {
        let Some(value) = read_yaml_config(&file, &mut inventory, &mut messages) else {
            continue;
        };
        collect_goose_servers(&mut inventory.servers, &file, &value);
    }

    finish_inventory(inventory, messages)
}

/// Claude Code config files Berd passively inspects. Local-project MCPs do not
/// live in a separate workspace file; they are selected from the active
/// workspace records in `~/.claude.json` during collection.
fn claude_code_config_files(workspace_paths: &[String]) -> Vec<ConfigFile> {
    let mut files = Vec::new();
    if let Some(home) = home_dir() {
        files.push(ConfigFile {
            path: home.join(".claude.json"),
            scope: McpConfigScope::User,
            label: "Claude Code user config".to_string(),
        });
    }

    for workspace in canonical_workspace_paths(workspace_paths) {
        files.push(ConfigFile {
            path: workspace.join(".mcp.json"),
            scope: McpConfigScope::Project,
            label: "Claude Code project config".to_string(),
        });
    }

    files
}

/// The complete allowlist of Codex config locations Berd will read or modify.
pub fn codex_config_files(workspace_paths: &[String]) -> Vec<ConfigFile> {
    let mut files = Vec::new();
    if let Some(home) = home_dir() {
        let codex_root = env::var_os("CODEX_HOME")
            .map(PathBuf::from)
            .filter(|path| path.is_absolute())
            .unwrap_or_else(|| home.join(".codex"));
        files.push(ConfigFile {
            path: codex_root.join("config.toml"),
            scope: McpConfigScope::User,
            label: "Codex user config".to_string(),
        });
    }

    for workspace in canonical_workspace_paths(workspace_paths) {
        files.push(ConfigFile {
            path: workspace.join(".codex").join("config.toml"),
            scope: McpConfigScope::Project,
            label: "Codex project config".to_string(),
        });
    }

    files
}

fn discover_claude_code(workspace_paths: &[String]) -> McpHarnessInventory {
    let active_workspaces = canonical_workspace_paths(workspace_paths);
    let files = claude_code_config_files(workspace_paths);
    let mut inventory = empty_inventory(McpHarnessId::ClaudeCode);
    let mut messages = Vec::new();

    for file in files {
        let Some(value) = read_json_config(&file, &mut inventory, &mut messages) else {
            continue;
        };
        collect_claude_code_servers(&mut inventory.servers, &file, &value, &active_workspaces);
    }

    finish_inventory(inventory, messages)
}

fn discover_codex(workspace_paths: &[String]) -> McpHarnessInventory {
    let files = codex_config_files(workspace_paths);
    let mut inventory = empty_inventory(McpHarnessId::Codex);
    let mut messages = Vec::new();

    for file in files {
        let Some(value) = read_toml_config(&file, &mut inventory, &mut messages) else {
            continue;
        };
        collect_codex_servers(&mut inventory.servers, &file, &value);
    }

    finish_inventory(inventory, messages)
}

fn empty_inventory(harness: McpHarnessId) -> McpHarnessInventory {
    McpHarnessInventory {
        harness,
        status: McpInventoryStatus::Unavailable,
        checked_locations: Vec::new(),
        servers: Vec::new(),
        message: None,
    }
}

fn finish_inventory(
    mut inventory: McpHarnessInventory,
    messages: Vec<String>,
) -> McpHarnessInventory {
    if !inventory.servers.is_empty() {
        inventory.status = if messages.is_empty() {
            McpInventoryStatus::Configured
        } else {
            McpInventoryStatus::Partial
        };
    } else if !messages.is_empty() {
        inventory.status = McpInventoryStatus::Error;
    }

    if !messages.is_empty() {
        inventory.message = Some(messages.join(" "));
    }

    inventory
}

fn source_from_file(file: &ConfigFile) -> McpConfigSource {
    McpConfigSource {
        scope: file.scope,
        label: file.label.clone(),
        path: Some(file.path.to_string_lossy().into_owned()),
    }
}

fn checked_location_from_file(file: &ConfigFile, status: McpSourceStatus) -> McpCheckedLocation {
    McpCheckedLocation {
        scope: file.scope,
        label: file.label.clone(),
        path: Some(file.path.to_string_lossy().into_owned()),
        status,
    }
}

fn record_checked_location(
    inventory: &mut McpHarnessInventory,
    file: &ConfigFile,
    status: McpSourceStatus,
) {
    inventory
        .checked_locations
        .push(checked_location_from_file(file, status));
}

fn read_json_config(
    file: &ConfigFile,
    inventory: &mut McpHarnessInventory,
    messages: &mut Vec<String>,
) -> Option<JsonValue> {
    let contents = read_config_file(file, inventory, messages)?;
    match serde_json::from_str(&contents) {
        Ok(value) => {
            record_checked_location(inventory, file, McpSourceStatus::Found);
            Some(value)
        }
        Err(error) => {
            record_checked_location(inventory, file, McpSourceStatus::Error);
            messages.push(format!("{} could not be parsed.", file.label));
            log::warn!(
                "failed to parse MCP JSON config {}: {error}",
                file.path.display()
            );
            None
        }
    }
}

fn read_yaml_config(
    file: &ConfigFile,
    inventory: &mut McpHarnessInventory,
    messages: &mut Vec<String>,
) -> Option<YamlValue> {
    let contents = read_config_file(file, inventory, messages)?;
    match yaml_serde::from_str(&contents) {
        Ok(value) => {
            record_checked_location(inventory, file, McpSourceStatus::Found);
            Some(value)
        }
        Err(error) => {
            record_checked_location(inventory, file, McpSourceStatus::Error);
            messages.push(format!("{} could not be parsed.", file.label));
            log::warn!(
                "failed to parse MCP YAML config {}: {error}",
                file.path.display()
            );
            None
        }
    }
}

fn read_toml_config(
    file: &ConfigFile,
    inventory: &mut McpHarnessInventory,
    messages: &mut Vec<String>,
) -> Option<JsonValue> {
    let contents = read_config_file(file, inventory, messages)?;
    match toml::from_str::<toml::Value>(&contents) {
        Ok(value) => {
            record_checked_location(inventory, file, McpSourceStatus::Found);
            serde_json::to_value(value).ok()
        }
        Err(error) => {
            record_checked_location(inventory, file, McpSourceStatus::Error);
            messages.push(format!("{} could not be parsed.", file.label));
            log::warn!(
                "failed to parse MCP TOML config {}: {error}",
                file.path.display()
            );
            None
        }
    }
}

fn read_config_file(
    file: &ConfigFile,
    inventory: &mut McpHarnessInventory,
    messages: &mut Vec<String>,
) -> Option<String> {
    let metadata = match fs::metadata(&file.path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            record_checked_location(inventory, file, McpSourceStatus::Missing);
            return None;
        }
        Err(error) => {
            record_checked_location(inventory, file, McpSourceStatus::Error);
            messages.push(format!("{} could not be inspected.", file.label));
            log::warn!(
                "failed to inspect MCP config {}: {error}",
                file.path.display()
            );
            return None;
        }
    };

    if !metadata.is_file() {
        record_checked_location(inventory, file, McpSourceStatus::Error);
        messages.push(format!("{} is not a file.", file.label));
        return None;
    }

    if metadata.len() > MAX_CONFIG_BYTES {
        record_checked_location(inventory, file, McpSourceStatus::Error);
        messages.push(format!("{} is too large to inspect safely.", file.label));
        return None;
    }

    match fs::read_to_string(&file.path) {
        Ok(contents) => Some(contents),
        Err(error) => {
            record_checked_location(inventory, file, McpSourceStatus::Error);
            messages.push(format!("{} could not be read.", file.label));
            log::warn!("failed to read MCP config {}: {error}", file.path.display());
            None
        }
    }
}

fn collect_goose_servers(
    servers: &mut Vec<McpConfiguredServer>,
    file: &ConfigFile,
    value: &YamlValue,
) {
    let Some(root) = value.as_mapping() else {
        return;
    };
    let Some(extensions) = yaml_lookup(root, "extensions").and_then(YamlValue::as_mapping) else {
        return;
    };

    for (key, extension) in extensions {
        let Some(config_key) = key.as_str() else {
            continue;
        };
        let Some(extension_map) = extension.as_mapping() else {
            continue;
        };
        let extension_type = yaml_lookup_string(extension_map, "type");
        let enabled = yaml_lookup(extension_map, "enabled").and_then(YamlValue::as_bool);
        let name = yaml_lookup_string(extension_map, "name")
            .or_else(|| yaml_lookup_string(extension_map, "display_name"))
            .unwrap_or_else(|| config_key.to_string());

        let (transport, command, url_host) = match extension_type.as_deref() {
            Some("stdio") => (
                McpTransportKind::Stdio,
                yaml_lookup_string(extension_map, "cmd")
                    .as_deref()
                    .map(command_basename),
                None,
            ),
            Some("streamable_http") | Some("http") => (
                McpTransportKind::Http,
                None,
                yaml_lookup_string(extension_map, "uri").and_then(|url| url_host(&url)),
            ),
            Some("sse") => (
                McpTransportKind::Sse,
                None,
                yaml_lookup_string(extension_map, "uri").and_then(|url| url_host(&url)),
            ),
            Some("acp") => (McpTransportKind::Acp, None, None),
            Some("builtin") | Some("platform") | Some("frontend") | Some("inline_python") => {
                (McpTransportKind::Builtin, None, None)
            }
            _ => (McpTransportKind::Unknown, None, None),
        };

        // Connections inventories MCP servers, not Goose-native capabilities.
        // Builtin/platform/frontend extensions never belong in this section,
        // regardless of whether a distro marked them bundled.
        if transport == McpTransportKind::Builtin {
            continue;
        }

        push_server(
            servers,
            McpConfiguredServer {
                id: server_id(McpHarnessId::Goose, file, config_key),
                harness: McpHarnessId::Goose,
                source: source_from_file(file),
                config_key: config_key.to_string(),
                name,
                transport,
                enabled,
                command,
                url_host,
            },
        );
    }
}

fn collect_claude_code_servers(
    servers: &mut Vec<McpConfiguredServer>,
    file: &ConfigFile,
    value: &JsonValue,
    active_workspaces: &[PathBuf],
) {
    collect_json_server_map(
        servers,
        McpHarnessId::ClaudeCode,
        file,
        value.get("mcpServers").or_else(|| value.get("mcp_servers")),
    );

    if file.scope != McpConfigScope::User || active_workspaces.is_empty() {
        return;
    }

    let Some(projects) = value.get("projects").and_then(JsonValue::as_object) else {
        return;
    };

    for (project_path, project_config) in projects {
        let Some(workspace) = canonical_matching_workspace(project_path, active_workspaces) else {
            continue;
        };
        let local_file = ConfigFile {
            path: file.path.clone(),
            scope: McpConfigScope::LocalProject,
            label: format!("Claude Code local project config ({})", workspace.display()),
        };
        collect_json_server_map(
            servers,
            McpHarnessId::ClaudeCode,
            &local_file,
            project_config
                .get("mcpServers")
                .or_else(|| project_config.get("mcp_servers")),
        );
    }
}

fn collect_json_server_map(
    servers: &mut Vec<McpConfiguredServer>,
    harness: McpHarnessId,
    file: &ConfigFile,
    value: Option<&JsonValue>,
) {
    let Some(map) = value.and_then(JsonValue::as_object) else {
        return;
    };
    for (config_key, server_value) in map {
        let Some(server) = json_server_from_value(servers, harness, file, config_key, server_value)
        else {
            continue;
        };
        push_server(servers, server);
    }
}

fn json_server_from_value(
    servers: &[McpConfiguredServer],
    harness: McpHarnessId,
    file: &ConfigFile,
    config_key: &str,
    value: &JsonValue,
) -> Option<McpConfiguredServer> {
    let object = value.as_object()?;
    let name = object
        .get("name")
        .and_then(JsonValue::as_str)
        .unwrap_or(config_key)
        .to_string();
    let command = object
        .get("command")
        .or_else(|| object.get("cmd"))
        .and_then(JsonValue::as_str);
    let url = object
        .get("url")
        .or_else(|| object.get("uri"))
        .and_then(JsonValue::as_str);
    let server_type = object
        .get("type")
        .or_else(|| object.get("transport"))
        .and_then(JsonValue::as_str);
    let transport = infer_transport(server_type, command, url);

    let duplicate_in_same_source = servers.iter().any(|server| {
        server.harness == harness
            && server.source.path == source_from_file(file).path
            && server.source.scope == file.scope
            && server.config_key == config_key
    });
    if duplicate_in_same_source {
        return None;
    }

    Some(McpConfiguredServer {
        id: server_id(harness, file, config_key),
        harness,
        source: source_from_file(file),
        config_key: config_key.to_string(),
        name,
        transport,
        enabled: object.get("enabled").and_then(JsonValue::as_bool),
        command: command.map(command_basename),
        url_host: url.and_then(url_host),
    })
}

fn collect_codex_servers(
    servers: &mut Vec<McpConfiguredServer>,
    file: &ConfigFile,
    value: &JsonValue,
) {
    collect_json_server_map(
        servers,
        McpHarnessId::Codex,
        file,
        value.get("mcp_servers").or_else(|| value.get("mcpServers")),
    );

    if let Some(profiles) = value.get("profiles").and_then(JsonValue::as_object) {
        for (profile_name, profile_value) in profiles {
            let profile_file = file.with_scope(
                McpConfigScope::Profile,
                &format!("Codex profile config ({profile_name})"),
            );
            collect_json_server_map(
                servers,
                McpHarnessId::Codex,
                &profile_file,
                profile_value
                    .get("mcp_servers")
                    .or_else(|| profile_value.get("mcpServers")),
            );
        }
    }
}

fn push_server(servers: &mut Vec<McpConfiguredServer>, server: McpConfiguredServer) {
    if server.config_key.trim().is_empty() || server.name.trim().is_empty() {
        return;
    }
    servers.push(server);
}

fn infer_transport(
    server_type: Option<&str>,
    command: Option<&str>,
    url: Option<&str>,
) -> McpTransportKind {
    match server_type
        .map(|value| value.to_ascii_lowercase())
        .as_deref()
    {
        Some("stdio") => McpTransportKind::Stdio,
        Some("http") | Some("streamable_http") | Some("streamable-http") => McpTransportKind::Http,
        Some("sse") => McpTransportKind::Sse,
        Some("acp") => McpTransportKind::Acp,
        Some("builtin") => McpTransportKind::Builtin,
        _ if command.is_some() => McpTransportKind::Stdio,
        _ if url.is_some() => McpTransportKind::Http,
        _ => McpTransportKind::Unknown,
    }
}

fn goose_additional_config_paths() -> Vec<PathBuf> {
    let process_value = env::var_os(goose_config::ADDITIONAL_CONFIG_FILES_ENV);
    match process_value {
        Some(value) => env::split_paths(&value)
            .filter(|path| path.is_absolute())
            .collect(),
        None => Vec::new(),
    }
}

fn canonical_matching_workspace<'a>(
    project_path: &str,
    active_workspaces: &'a [PathBuf],
) -> Option<&'a PathBuf> {
    let canonical_project = expand_home_prefix(project_path.trim())
        .canonicalize()
        .ok()?;
    active_workspaces
        .iter()
        .find(|workspace| **workspace == canonical_project)
}

fn canonical_workspace_paths(paths: &[String]) -> Vec<PathBuf> {
    let mut seen = HashSet::new();
    let mut result = Vec::new();
    for path in paths {
        let path = expand_home_prefix(path.trim());
        let Ok(canonical) = path.canonicalize() else {
            continue;
        };
        if canonical.is_dir() && seen.insert(canonical.clone()) {
            result.push(canonical);
        }
    }
    result
}

fn expand_home_prefix(path: &str) -> PathBuf {
    if path == "~" {
        return home_dir().unwrap_or_else(|| PathBuf::from(path));
    }
    if let Some(rest) = path.strip_prefix("~/") {
        if let Some(home) = home_dir() {
            return home.join(rest);
        }
    }
    PathBuf::from(path)
}

fn home_dir() -> Option<PathBuf> {
    dirs::home_dir()
}

fn yaml_lookup<'a>(map: &'a yaml_serde::Mapping, key: &str) -> Option<&'a YamlValue> {
    map.get(YamlValue::String(key.to_string()))
}

fn yaml_lookup_string(map: &yaml_serde::Mapping, key: &str) -> Option<String> {
    yaml_lookup(map, key)
        .and_then(YamlValue::as_str)
        .map(str::to_string)
}

fn command_basename(command: &str) -> String {
    Path::new(command)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(command)
        .to_string()
}

fn url_host(raw_url: &str) -> Option<String> {
    url::Url::parse(raw_url)
        .ok()
        .and_then(|url| url.host_str().map(str::to_string))
}

fn server_id(harness: McpHarnessId, file: &ConfigFile, config_key: &str) -> String {
    format!(
        "{:?}:{:?}:{}:{}",
        harness,
        file.scope,
        file.path.to_string_lossy(),
        config_key
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn file(path: &Path, contents: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, contents).unwrap();
    }

    #[test]
    fn json_discovery_returns_only_structural_metadata() {
        let dir = tempdir().unwrap();
        let config = ConfigFile {
            path: dir.path().join(".mcp.json"),
            scope: McpConfigScope::Project,
            label: "fixture".to_string(),
        };
        file(
            &config.path,
            r#"{
              "mcpServers": {
                "github": {
                  "command": "/opt/bin/npx",
                  "args": ["-y", "@modelcontextprotocol/server-github"],
                  "env": { "GITHUB_TOKEN": "ghp_secret" },
                  "headers": { "Authorization": "Bearer secret" }
                },
                "remote": {
                  "type": "http",
                  "url": "https://api.example.com/mcp?token=secret"
                }
              }
            }"#,
        );

        let mut inventory = empty_inventory(McpHarnessId::ClaudeCode);
        let value = read_json_config(&config, &mut inventory, &mut Vec::new()).unwrap();
        let mut servers = Vec::new();
        collect_claude_code_servers(&mut servers, &config, &value, &[]);

        assert_eq!(servers.len(), 2);
        assert_eq!(servers[0].command.as_deref(), Some("npx"));
        assert_eq!(servers[1].url_host.as_deref(), Some("api.example.com"));
        let rendered = serde_json::to_string(&servers).unwrap();
        assert!(!rendered.contains("ghp_secret"));
        assert!(!rendered.contains("Bearer"));
        assert!(!rendered.contains("token=secret"));
    }

    #[test]
    fn goose_discovery_ignores_native_capabilities_and_redacts_env() {
        let dir = tempdir().unwrap();
        let config = ConfigFile {
            path: dir.path().join("config.yaml"),
            scope: McpConfigScope::User,
            label: "fixture".to_string(),
        };
        file(
            &config.path,
            r#"
extensions:
  developer:
    type: builtin
    name: developer
    bundled: true
    enabled: true
  github:
    type: stdio
    name: GitHub
    cmd: /usr/local/bin/npx
    envs:
      GITHUB_TOKEN: ghp_secret
    enabled: false
"#,
        );

        let mut inventory = empty_inventory(McpHarnessId::Goose);
        let value = read_yaml_config(&config, &mut inventory, &mut Vec::new()).unwrap();
        let mut servers = Vec::new();
        collect_goose_servers(&mut servers, &config, &value);

        assert_eq!(servers.len(), 1);
        assert_eq!(servers[0].name, "GitHub");
        assert_eq!(servers[0].transport, McpTransportKind::Stdio);
        assert_eq!(servers[0].enabled, Some(false));
        assert_eq!(servers[0].command.as_deref(), Some("npx"));
        let rendered = serde_json::to_string(&servers).unwrap();
        assert!(!rendered.contains("ghp_secret"));
    }

    #[test]
    fn codex_toml_discovers_mcp_servers() {
        let dir = tempdir().unwrap();
        let config = ConfigFile {
            path: dir.path().join("config.toml"),
            scope: McpConfigScope::User,
            label: "fixture".to_string(),
        };
        file(
            &config.path,
            r#"
[mcp_servers.context7]
command = "node"
args = ["server.js"]

[mcp_servers.remote]
type = "sse"
url = "https://mcp.example.test/sse?api_key=secret"
"#,
        );

        let mut inventory = empty_inventory(McpHarnessId::Codex);
        let value = read_toml_config(&config, &mut inventory, &mut Vec::new()).unwrap();
        let mut servers = Vec::new();
        collect_codex_servers(&mut servers, &config, &value);

        assert_eq!(servers.len(), 2);
        assert_eq!(servers[0].name, "context7");
        assert_eq!(servers[0].transport, McpTransportKind::Stdio);
        assert_eq!(servers[1].transport, McpTransportKind::Sse);
        assert_eq!(servers[1].url_host.as_deref(), Some("mcp.example.test"));
        assert!(!serde_json::to_string(&servers).unwrap().contains("api_key"));
    }

    #[test]
    fn malformed_file_marks_harness_error_without_raw_contents() {
        let dir = tempdir().unwrap();
        let config = ConfigFile {
            path: dir.path().join("bad.json"),
            scope: McpConfigScope::User,
            label: "fixture secret-token-value".to_string(),
        };
        file(&config.path, "{ secret: ghp_secret");
        let mut inventory = empty_inventory(McpHarnessId::ClaudeCode);
        let mut messages = Vec::new();
        assert!(read_json_config(&config, &mut inventory, &mut messages).is_none());
        inventory = finish_inventory(inventory, messages);
        assert_eq!(inventory.status, McpInventoryStatus::Error);
        assert!(!inventory.message.unwrap_or_default().contains("ghp_secret"));
    }

    #[test]
    fn configured_harness_with_read_errors_is_marked_partial() {
        let mut inventory = empty_inventory(McpHarnessId::Codex);
        inventory.servers.push(McpConfiguredServer {
            id: "codex:user:context7".to_string(),
            harness: McpHarnessId::Codex,
            source: McpConfigSource {
                scope: McpConfigScope::User,
                label: "Codex user config".to_string(),
                path: None,
            },
            config_key: "context7".to_string(),
            name: "Context7".to_string(),
            transport: McpTransportKind::Http,
            enabled: None,
            command: None,
            url_host: Some("mcp.context7.com".to_string()),
        });

        inventory = finish_inventory(
            inventory,
            vec!["Codex project config could not be parsed.".to_string()],
        );

        assert_eq!(inventory.status, McpInventoryStatus::Partial);
        assert_eq!(inventory.servers.len(), 1);
    }

    #[test]
    fn canonical_workspace_paths_ignores_missing_paths() {
        let dir = tempdir().unwrap();
        let existing = dir.path().join("workspace");
        fs::create_dir_all(&existing).unwrap();
        let result = canonical_workspace_paths(&[
            existing.to_string_lossy().into_owned(),
            dir.path().join("missing").to_string_lossy().into_owned(),
        ]);
        assert_eq!(result, vec![existing.canonicalize().unwrap()]);
    }

    #[test]
    fn all_inventory_messages_are_generic() {
        let mut inventory = empty_inventory(McpHarnessId::ClaudeCode);
        inventory = finish_inventory(
            inventory,
            vec!["Claude Code user config could not be parsed.".to_string()],
        );
        assert_eq!(inventory.status, McpInventoryStatus::Error);
        assert_eq!(
            inventory.message.as_deref(),
            Some("Claude Code user config could not be parsed.")
        );
    }

    #[test]
    fn empty_workspace_list_checks_only_user_claude_location() {
        let inventory = discover_claude_code(&[]);
        assert!(inventory
            .checked_locations
            .iter()
            .any(|location| location.scope == McpConfigScope::User));
        assert!(!inventory
            .checked_locations
            .iter()
            .any(|location| location.scope == McpConfigScope::Project));
    }

    #[test]
    fn missing_candidate_locations_are_marked_missing_not_sources() {
        let dir = tempdir().unwrap();
        let config = ConfigFile {
            path: dir.path().join("missing.json"),
            scope: McpConfigScope::User,
            label: "fixture".to_string(),
        };
        let mut inventory = empty_inventory(McpHarnessId::ClaudeCode);
        let mut messages = Vec::new();

        assert!(read_json_config(&config, &mut inventory, &mut messages).is_none());

        assert_eq!(inventory.checked_locations.len(), 1);
        assert_eq!(
            inventory.checked_locations[0].status,
            McpSourceStatus::Missing
        );
        assert!(inventory.servers.is_empty());
        assert!(messages.is_empty());
    }

    #[test]
    fn claude_user_config_does_not_recursively_inventory_unrelated_projects() {
        let dir = tempdir().unwrap();
        let config = ConfigFile {
            path: dir.path().join(".claude.json"),
            scope: McpConfigScope::User,
            label: "fixture".to_string(),
        };
        file(
            &config.path,
            r#"{
              "projects": {
                "/elsewhere": {
                  "mcpServers": {
                    "unrelated": { "command": "node" }
                  }
                }
              }
            }"#,
        );
        let mut inventory = empty_inventory(McpHarnessId::ClaudeCode);
        let value = read_json_config(&config, &mut inventory, &mut Vec::new()).unwrap();
        let mut servers = Vec::new();

        collect_claude_code_servers(&mut servers, &config, &value, &[]);

        assert!(servers.is_empty());
    }

    #[test]
    fn claude_user_config_includes_only_active_workspace_local_servers() {
        let dir = tempdir().unwrap();
        let active_workspace = dir.path().join("active");
        let unrelated_workspace = dir.path().join("unrelated");
        fs::create_dir_all(&active_workspace).unwrap();
        fs::create_dir_all(&unrelated_workspace).unwrap();
        let config = ConfigFile {
            path: dir.path().join(".claude.json"),
            scope: McpConfigScope::User,
            label: "fixture".to_string(),
        };
        file(
            &config.path,
            &format!(
                r#"{{
                  "mcpServers": {{
                    "shared": {{ "command": "node" }}
                  }},
                  "projects": {{
                    "{}": {{
                      "mcpServers": {{
                        "shared": {{ "command": "npx", "env": {{ "TOKEN": "secret" }} }}
                      }}
                    }},
                    "{}": {{
                      "mcpServers": {{
                        "unrelated": {{ "command": "node" }}
                      }}
                    }}
                  }}
                }}"#,
                active_workspace.display(),
                unrelated_workspace.display(),
            ),
        );
        let mut inventory = empty_inventory(McpHarnessId::ClaudeCode);
        let value = read_json_config(&config, &mut inventory, &mut Vec::new()).unwrap();
        let mut servers = Vec::new();
        let active_workspaces = vec![active_workspace.canonicalize().unwrap()];

        collect_claude_code_servers(&mut servers, &config, &value, &active_workspaces);

        assert_eq!(
            servers
                .iter()
                .map(|server| (server.config_key.as_str(), server.source.scope))
                .collect::<Vec<_>>(),
            vec![
                ("shared", McpConfigScope::User),
                ("shared", McpConfigScope::LocalProject),
            ]
        );
        assert_ne!(servers[0].id, servers[1].id);
        let rendered = serde_json::to_string(&servers).unwrap();
        assert!(!rendered.contains("unrelated"));
        assert!(!rendered.contains("secret"));
    }

    #[test]
    fn codex_discovery_does_not_treat_generic_servers_as_mcp() {
        let dir = tempdir().unwrap();
        let config = ConfigFile {
            path: dir.path().join("config.toml"),
            scope: McpConfigScope::User,
            label: "fixture".to_string(),
        };
        file(
            &config.path,
            r#"
[servers.not_mcp]
command = "node"
"#,
        );
        let mut inventory = empty_inventory(McpHarnessId::Codex);
        let value = read_toml_config(&config, &mut inventory, &mut Vec::new()).unwrap();
        let mut servers = Vec::new();

        collect_codex_servers(&mut servers, &config, &value);

        assert!(servers.is_empty());
    }
}
