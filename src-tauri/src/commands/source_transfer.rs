mod secure_read;

use serde::Serialize;
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    env,
    fs::{self, OpenOptions},
    io::{ErrorKind, Read, Write},
    path::{Component, Path, PathBuf},
};
use tauri::{AppHandle, Manager};

const SKILL_FILE_NAME: &str = "SKILL.md";
const MAX_SKILL_FILE_BYTES: u64 = 1024 * 1024;
const MAX_SOURCE_IMPORT_BYTES: usize = 10 * 1024 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportSkillSourceResponse {
    pub json: String,
    pub filename: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSourceResponse {
    pub sources: Vec<PortableSourceEntry>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortableSourceEntry {
    #[serde(rename = "type")]
    pub source_type: &'static str,
    pub name: String,
    pub description: String,
    pub content: String,
    pub path: String,
    pub global: bool,
    pub writable: bool,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub supporting_files: Vec<String>,
    #[serde(skip_serializing_if = "HashMap::is_empty")]
    pub properties: HashMap<String, Value>,
}

#[derive(Debug)]
struct SourceImportV1 {
    name: String,
    description: String,
    content: String,
    properties: HashMap<String, Value>,
}

#[derive(serde::Deserialize)]
struct SkillFrontmatter {
    name: Option<String>,
    #[serde(default)]
    description: String,
}

#[derive(serde::Deserialize)]
struct AgentFrontmatter {
    #[serde(default)]
    name: String,
    #[serde(default)]
    description: String,
    #[serde(default, flatten)]
    properties: HashMap<String, Value>,
}

#[derive(Debug)]
struct AuthorizedSkillPath {
    directory: PathBuf,
    root: PathBuf,
}

#[derive(Clone, serde::Deserialize)]
struct PluginConfigEntry {
    enabled: bool,
}

#[derive(Default, serde::Deserialize)]
struct PluginSettings {
    #[serde(default, rename = "enabledPlugins")]
    enabled: Vec<String>,
    #[serde(default, rename = "disabledPlugins")]
    disabled: Vec<String>,
}

#[derive(Default, serde::Deserialize)]
struct OpenPluginManifest {
    skills: Option<Value>,
}

fn parse_frontmatter<T: for<'de> serde::Deserialize<'de>>(
    content: &str,
) -> Result<Option<(T, String)>, yaml_serde::Error> {
    let parts: Vec<&str> = content.split("---").collect();
    if parts.len() < 3 {
        return Ok(None);
    }

    let metadata = yaml_serde::from_str(parts[1].trim())?;
    Ok(Some((metadata, parts[2..].join("---").trim().to_string())))
}

fn parse_source_import(data: &str, expected_type: &str) -> Result<SourceImportV1, String> {
    if data.len() > MAX_SOURCE_IMPORT_BYTES {
        return Err("Source import data must be 10 MB or smaller".to_string());
    }

    let value: Value = serde_json::from_str(data).map_err(|err| format!("Invalid JSON: {err}"))?;
    let version = value
        .get("version")
        .and_then(Value::as_u64)
        .ok_or_else(|| "Missing or invalid \"version\" field".to_string())?;
    if version != 1 {
        return Err(format!("Unsupported source export version: {version}"));
    }

    let source_type = value.get("type").and_then(Value::as_str).unwrap_or("skill");
    if source_type != expected_type {
        return Err(format!(
            "Source type '{source_type}' import is not supported by this operation."
        ));
    }

    let name = value
        .get("name")
        .and_then(Value::as_str)
        .ok_or_else(|| "Missing or invalid \"name\" field".to_string())?
        .to_string();
    if name.is_empty() {
        return Err("Source name must not be empty".to_string());
    }

    let description = value
        .get("description")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    if expected_type == "skill" && description.is_empty() {
        return Err("Source description must not be empty".to_string());
    }

    let content = value
        .get("content")
        .or_else(|| value.get("instructions"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let mut properties: HashMap<String, Value> = value
        .get("properties")
        .and_then(Value::as_object)
        .map(|properties| {
            properties
                .iter()
                .map(|(key, value)| (key.clone(), value.clone()))
                .collect()
        })
        .unwrap_or_default();

    if expected_type == "agent" {
        if let Some(metadata) = value.get("metadata").and_then(Value::as_object) {
            for (key, value) in metadata {
                properties
                    .entry(key.clone())
                    .or_insert_with(|| value.clone());
            }
        }
    }

    Ok(SourceImportV1 {
        name,
        description,
        content,
        properties,
    })
}

fn validate_skill_name(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("Skill name must not be empty".to_string());
    }
    if name.len() > 64 {
        return Err(format!(
            "Invalid skill name \"{name}\". Names must be at most 64 characters."
        ));
    }
    if !name
        .chars()
        .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '-')
    {
        return Err(format!(
            "Invalid skill name \"{name}\". Names may only contain lowercase letters, digits, and hyphens."
        ));
    }
    if name.starts_with('-') || name.ends_with('-') {
        return Err(format!(
            "Invalid skill name \"{name}\". Names must not start or end with a hyphen."
        ));
    }
    Ok(())
}

fn validate_agent_name(name: &str) -> Result<(), String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("Agent name must not be empty".to_string());
    }
    if trimmed.len() > 80 {
        return Err(format!(
            "Invalid agent name \"{name}\". Names must be at most 80 characters."
        ));
    }
    if trimmed.chars().any(|ch| matches!(ch, '/' | '\\')) {
        return Err(format!(
            "Invalid agent name \"{name}\". Names must not contain path separators."
        ));
    }
    Ok(())
}

fn slugify_agent_name(name: &str) -> String {
    let slug: String = name
        .to_lowercase()
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '-' })
        .collect();
    let mut collapsed = String::with_capacity(slug.len());
    let mut previous_hyphen = false;
    for ch in slug.chars() {
        if ch == '-' {
            if !previous_hyphen {
                collapsed.push('-');
            }
            previous_hyphen = true;
        } else {
            collapsed.push(ch);
            previous_hyphen = false;
        }
    }

    let trimmed = collapsed.trim_matches('-');
    if trimmed.is_empty() {
        "agent".to_string()
    } else {
        trimmed
            .chars()
            .take(64)
            .collect::<String>()
            .trim_end_matches('-')
            .to_string()
    }
}

fn build_skill_markdown(source: &SourceImportV1, name: &str) -> Result<String, String> {
    let safe_description = source.description.replace('\'', "''");
    let mut markdown = format!("---\nname: {name}\ndescription: '{safe_description}'\n");
    if !source.properties.is_empty() {
        markdown.push_str("metadata:\n");
        let yaml = yaml_serde::to_string(&source.properties)
            .map_err(|err| format!("Failed to serialize source property: {err}"))?;
        for line in yaml.lines().filter(|line| !line.is_empty()) {
            markdown.push_str("  ");
            markdown.push_str(line);
            markdown.push('\n');
        }
    }
    markdown.push_str("---\n");
    if !source.content.is_empty() {
        markdown.push('\n');
        markdown.push_str(&source.content);
        markdown.push('\n');
    }
    Ok(markdown)
}

fn build_agent_markdown(source: &SourceImportV1) -> Result<String, String> {
    let mut frontmatter = yaml_serde::Mapping::new();
    frontmatter.insert(
        yaml_serde::Value::String("name".to_string()),
        yaml_serde::Value::String(source.name.clone()),
    );
    frontmatter.insert(
        yaml_serde::Value::String("description".to_string()),
        yaml_serde::Value::String(source.description.clone()),
    );
    for (key, value) in &source.properties {
        if key == "name" || key == "description" {
            continue;
        }
        let value = yaml_serde::to_value(value)
            .map_err(|err| format!("Failed to serialize source property: {err}"))?;
        frontmatter.insert(yaml_serde::Value::String(key.clone()), value);
    }
    let yaml = yaml_serde::to_string(&frontmatter)
        .map_err(|err| format!("Failed to serialize source: {err}"))?;
    let mut markdown = format!("---\n{yaml}---\n");
    if !source.content.is_empty() {
        markdown.push('\n');
        markdown.push_str(&source.content);
        markdown.push('\n');
    }
    Ok(markdown)
}

fn ensure_managed_root(root: &Path, label: &str) -> Result<PathBuf, String> {
    if root.exists() {
        let metadata = fs::metadata(root)
            .map_err(|err| format!("Failed to access {label} directory: {err}"))?;
        if !metadata.is_dir() {
            return Err(format!("{label} path must be a regular directory"));
        }
    } else {
        fs::create_dir_all(root)
            .map_err(|err| format!("Failed to create {label} directory: {err}"))?;
    }
    root.canonicalize()
        .map_err(|err| format!("Failed to resolve {label} directory: {err}"))
}

fn persist_new_file(path: &Path, contents: &str) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Source destination is missing a parent directory".to_string())?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)
        .map_err(|err| format!("Failed to create temporary source file: {err}"))?;
    temporary
        .write_all(contents.as_bytes())
        .map_err(|err| format!("Failed to write temporary source file: {err}"))?;
    temporary
        .as_file()
        .sync_all()
        .map_err(|err| format!("Failed to sync temporary source file: {err}"))?;
    temporary
        .persist_noclobber(path)
        .map_err(|err| format!("Failed to persist source file: {}", err.error))?;
    Ok(())
}

fn read_utf8_regular_file_nofollow(
    path: &Path,
    max_bytes: u64,
    label: &str,
) -> Result<String, String> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // FILE_FLAG_OPEN_REPARSE_POINT keeps the final component from being
        // followed so handle metadata can reject symbolic links.
        options.custom_flags(0x0020_0000);
    }

    let mut file = options
        .open(path)
        .map_err(|err| format!("Failed to read {label}: {err}"))?;
    let metadata = file
        .metadata()
        .map_err(|err| format!("Failed to inspect {label}: {err}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() > max_bytes {
        return Err(format!("Failed to read {label}: invalid source file"));
    }

    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    Read::by_ref(&mut file)
        .take(max_bytes + 1)
        .read_to_end(&mut bytes)
        .map_err(|err| format!("Failed to read {label}: {err}"))?;
    if bytes.len() as u64 > max_bytes {
        return Err(format!("Failed to read {label}: invalid source file"));
    }
    String::from_utf8(bytes).map_err(|err| format!("Failed to read {label}: {err}"))
}

fn next_skill_name(name: &str, index: u32) -> String {
    match index {
        0 => name.to_string(),
        1 => format!("{name}-imported"),
        _ => format!("{name}-imported-{index}"),
    }
}

fn import_skill_at(root: &Path, data: &str) -> Result<PortableSourceEntry, String> {
    let source = parse_source_import(data, "skill")?;
    validate_skill_name(&source.name)?;
    let root = ensure_managed_root(root, "Personal skills")?;

    let mut index = 0;
    let (name, skill_dir) = loop {
        let name = next_skill_name(&source.name, index);
        let skill_dir = root.join(&name);
        match fs::create_dir(&skill_dir) {
            Ok(()) => match build_skill_markdown(&source, &name) {
                Ok(markdown) => {
                    if let Err(error) =
                        persist_new_file(&skill_dir.join(SKILL_FILE_NAME), &markdown)
                    {
                        let _ = fs::remove_dir(&skill_dir);
                        return Err(error.replace("source file", "SKILL.md"));
                    }
                    break (name, skill_dir);
                }
                Err(error) => {
                    let _ = fs::remove_dir(&skill_dir);
                    return Err(error);
                }
            },
            Err(error) if error.kind() == ErrorKind::AlreadyExists => index += 1,
            Err(error) => {
                return Err(format!("Failed to create skill directory: {error}"));
            }
        }
    };

    Ok(PortableSourceEntry {
        source_type: "skill",
        name,
        description: source.description,
        content: source.content,
        path: skill_dir.to_string_lossy().into_owned(),
        global: true,
        writable: true,
        supporting_files: Vec::new(),
        properties: source.properties,
    })
}

fn import_agent_at(root: &Path, data: &str) -> Result<PortableSourceEntry, String> {
    let source = parse_source_import(data, "agent")?;
    validate_agent_name(&source.name)?;
    let root = ensure_managed_root(root, "Personal agents")?;
    let slug = slugify_agent_name(&source.name);
    let markdown = build_agent_markdown(&source)?;

    let mut index = 1u32;
    let file_path = loop {
        let filename = if index == 1 {
            format!("{slug}.md")
        } else {
            format!("{slug}-{index}.md")
        };
        let path = root.join(filename);
        match persist_new_file(&path, &markdown) {
            Ok(()) => break path,
            Err(_error) if path.exists() => index += 1,
            Err(error) => return Err(error),
        }
    };

    let persisted =
        read_utf8_regular_file_nofollow(&file_path, markdown.len() as u64, "imported agent")
            .and_then(|markdown| {
                parse_frontmatter::<AgentFrontmatter>(&markdown)
                    .map_err(|err| format!("Invalid imported agent frontmatter: {err}"))?
                    .ok_or_else(|| "Imported agent file is missing frontmatter".to_string())
            });
    let (frontmatter, content) = match persisted {
        Ok(persisted) => persisted,
        Err(error) => {
            let _ = fs::remove_file(&file_path);
            return Err(error);
        }
    };

    Ok(PortableSourceEntry {
        source_type: "agent",
        name: frontmatter.name,
        description: frontmatter.description,
        content,
        path: file_path.to_string_lossy().into_owned(),
        global: true,
        writable: true,
        supporting_files: Vec::new(),
        properties: frontmatter.properties,
    })
}

fn inferred_managed_skill_root(path: &Path) -> Option<&Path> {
    path.ancestors().find(|ancestor| {
        let Some(parent_name) = ancestor
            .parent()
            .and_then(Path::file_name)
            .and_then(|name| name.to_str())
        else {
            return false;
        };
        match ancestor.file_name().and_then(|name| name.to_str()) {
            Some("skills") => matches!(parent_name, ".agents" | ".goose" | ".claude"),
            _ => false,
        }
    })
}

#[cfg(unix)]
fn system_goose_config_path() -> PathBuf {
    PathBuf::from("/etc/goose/config.yaml")
}

#[cfg(windows)]
fn system_goose_config_path() -> PathBuf {
    env::var_os("PROGRAMDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\ProgramData"))
        .join("goose")
        .join("config.yaml")
}

fn configured_plugins_from_paths(
    config_paths: impl IntoIterator<Item = PathBuf>,
) -> Result<HashMap<PathBuf, PluginConfigEntry>, String> {
    if let Some(value) = env::var_os("PLUGINS") {
        let value = value
            .into_string()
            .map_err(|_| "Goose PLUGINS configuration is not valid UTF-8".to_string())?;
        let entries: HashMap<String, PluginConfigEntry> = serde_json::from_str(&value)
            .map_err(|err| format!("Invalid Goose PLUGINS configuration: {err}"))?;
        return Ok(entries
            .into_iter()
            .map(|(path, entry)| (PathBuf::from(path), entry))
            .collect());
    }

    Ok(configured_plugins_from_files(config_paths))
}

fn configured_plugins_from_files(
    config_paths: impl IntoIterator<Item = PathBuf>,
) -> HashMap<PathBuf, PluginConfigEntry> {
    let mut merged = HashMap::new();
    for path in config_paths {
        let contents = match fs::read_to_string(&path) {
            Ok(contents) => contents,
            Err(_) => continue,
        };
        let Ok(mapping) = yaml_serde::from_str::<yaml_serde::Mapping>(&contents) else {
            continue;
        };
        if let Some(value) = mapping.get(yaml_serde::Value::String("plugins".to_string())) {
            let Ok(entries) =
                yaml_serde::from_value::<HashMap<String, PluginConfigEntry>>(value.clone())
            else {
                continue;
            };
            merged = entries;
        }
    }

    merged
        .into_iter()
        .map(|(path, entry)| (PathBuf::from(path), entry))
        .collect()
}

fn configured_plugins() -> Result<HashMap<PathBuf, PluginConfigEntry>, String> {
    let mut paths = vec![system_goose_config_path()];
    if let Some(value) = env::var_os(crate::services::goose_config::ADDITIONAL_CONFIG_FILES_ENV) {
        paths.extend(env::split_paths(&value));
    }
    paths.push(crate::services::goose_config::config_path()?);
    configured_plugins_from_paths(paths)
}

fn plugin_settings_at(path: &Path) -> Option<PluginSettings> {
    fs::read_to_string(path)
        .ok()
        .and_then(|contents| serde_json::from_str(&contents).ok())
}

fn user_plugin_is_enabled_by_settings(plugin_dir: &Path, user_settings_path: &Path) -> bool {
    let Some(plugin_name) = plugin_dir.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    if let Some(settings) = plugin_settings_at(user_settings_path) {
        if settings.disabled.iter().any(|name| name == plugin_name) {
            return false;
        }
        if settings.enabled.iter().any(|name| name == plugin_name) {
            return true;
        }
    }
    true
}

fn equivalent_paths(left: &Path, right: &Path) -> bool {
    left == right
        || left
            .canonicalize()
            .ok()
            .zip(right.canonicalize().ok())
            .is_some_and(|(left, right)| left == right)
}

fn configured_plugin_enabled(
    plugin_dir: &Path,
    configured: &HashMap<PathBuf, PluginConfigEntry>,
) -> Option<bool> {
    configured
        .get(plugin_dir)
        .or_else(|| {
            configured
                .iter()
                .find_map(|(path, entry)| equivalent_paths(path, plugin_dir).then_some(entry))
        })
        .map(|entry| entry.enabled)
}

fn valid_relative_plugin_path(path: &str) -> Option<PathBuf> {
    if !path.starts_with("./") {
        return None;
    }
    let path = PathBuf::from(path);
    (!path.is_absolute()
        && !path
            .components()
            .any(|component| matches!(component, Component::ParentDir)))
    .then_some(path)
}

fn plugin_component_paths(value: &Value) -> Option<(Vec<String>, bool)> {
    match value {
        Value::Null => Some((Vec::new(), false)),
        Value::String(path) => Some((vec![path.clone()], false)),
        Value::Array(paths) => Some((
            paths
                .iter()
                .map(Value::as_str)
                .map(|path| path.map(str::to_string))
                .collect::<Option<Vec<_>>>()?,
            false,
        )),
        Value::Object(config) => {
            let paths = match config.get("paths") {
                None => Vec::new(),
                Some(Value::String(path)) => vec![path.clone()],
                Some(Value::Array(paths)) => paths
                    .iter()
                    .map(Value::as_str)
                    .map(|path| path.map(str::to_string))
                    .collect::<Option<Vec<_>>>()?,
                Some(_) => return None,
            };
            let exclusive = match config.get("exclusive") {
                None => false,
                Some(Value::Bool(exclusive)) => *exclusive,
                Some(_) => return None,
            };
            Some((paths, exclusive))
        }
        _ => None,
    }
}

fn open_plugin_manifest(plugin_dir: &Path) -> Option<OpenPluginManifest> {
    let manifest = [
        ".goose-plugin/plugin.json",
        ".plugin/plugin.json",
        "plugin.json",
    ]
    .into_iter()
    .map(|path| plugin_dir.join(path))
    .find(|path| path.is_file());

    match manifest {
        Some(path) => serde_json::from_str(&fs::read_to_string(path).ok()?).ok(),
        None => Some(OpenPluginManifest::default()),
    }
}

fn installed_plugin_skill_roots(plugin_dir: &Path) -> Vec<PathBuf> {
    let Some(manifest) = open_plugin_manifest(plugin_dir) else {
        return Vec::new();
    };
    let (custom_paths, exclusive) = match manifest.skills.as_ref() {
        Some(value) => match plugin_component_paths(value) {
            Some(paths) => paths,
            None => return Vec::new(),
        },
        None => (Vec::new(), false),
    };

    let mut roots = Vec::new();
    if !exclusive {
        roots.push(plugin_dir.join("skills"));
    }
    for path in custom_paths {
        let Some(path) = valid_relative_plugin_path(&path) else {
            return Vec::new();
        };
        roots.push(plugin_dir.join(path));
    }
    if !plugin_dir.join("skills").is_dir()
        && manifest.skills.is_none()
        && plugin_dir.join(SKILL_FILE_NAME).is_file()
    {
        roots.push(plugin_dir.to_path_buf());
    }

    let mut seen = HashSet::new();
    roots
        .into_iter()
        .filter(|path| path.is_dir())
        .filter(|path| seen.insert(path.canonicalize().unwrap_or_else(|_| (*path).clone())))
        .collect()
}

fn enabled_plugin_skill_roots_at(
    agents_root: &Path,
    user_settings_path: &Path,
    configured: &HashMap<PathBuf, PluginConfigEntry>,
) -> Vec<PathBuf> {
    let user_plugins_dir = agents_root.join("plugins");
    let plugin_dirs = fs::read_dir(&user_plugins_dir)
        .into_iter()
        .flatten()
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.is_dir())
        .filter(|path| configured_plugin_enabled(path, configured).unwrap_or(true))
        .collect::<Vec<_>>();

    let mut seen = HashSet::new();
    plugin_dirs
        .into_iter()
        .filter(|path| user_plugin_is_enabled_by_settings(path, user_settings_path))
        .flat_map(|path| installed_plugin_skill_roots(&path))
        .filter(|path| seen.insert(path.clone()))
        .collect()
}

fn is_agents_plugin_path(path: &Path) -> bool {
    path.ancestors().any(|ancestor| {
        ancestor.file_name().and_then(|name| name.to_str()) == Some("plugins")
            && ancestor
                .parent()
                .and_then(Path::file_name)
                .and_then(|name| name.to_str())
                == Some(".agents")
    })
}

fn validate_export_skill_path(
    path: &Path,
    trusted_roots: &[PathBuf],
) -> Result<AuthorizedSkillPath, String> {
    if path.as_os_str().is_empty() {
        return Err("Source path must not be empty".to_string());
    }
    let metadata = fs::symlink_metadata(path)
        .map_err(|_| format!("Source \"{}\" not found", path.display()))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(format!("Source \"{}\" not found", path.display()));
    }
    let canonical_dir = path
        .canonicalize()
        .map_err(|_| format!("Source \"{}\" not found", path.display()))?;
    let trusted_roots = trusted_roots
        .iter()
        .filter_map(|root| {
            let canonical_root = root.canonicalize().ok()?;
            canonical_dir
                .starts_with(&canonical_root)
                .then(|| (root.clone(), canonical_root, is_agents_plugin_path(root)))
        })
        .collect::<Vec<_>>();
    let lexical_plugin_path = is_agents_plugin_path(path);
    let canonical_plugin_path = is_agents_plugin_path(&canonical_dir);
    let authorized_root = if lexical_plugin_path {
        trusted_roots
            .iter()
            .find(|(lexical_root, _, plugin_root)| *plugin_root && path.starts_with(lexical_root))
            .map(|(_, root, _)| root.clone())
    } else if canonical_plugin_path {
        trusted_roots
            .iter()
            .find(|(_, _, plugin_root)| *plugin_root)
            .map(|(_, root, _)| root.clone())
    } else {
        trusted_roots
            .first()
            .map(|(_, root, _)| root.clone())
            .or_else(|| inferred_managed_skill_root(&canonical_dir).map(Path::to_path_buf))
    };
    let Some(root) = authorized_root else {
        return Err(format!("Source \"{}\" not found", path.display()));
    };
    Ok(AuthorizedSkillPath {
        directory: canonical_dir,
        root,
    })
}

fn export_skill_at(
    path: &Path,
    trusted_roots: &[PathBuf],
) -> Result<ExportSkillSourceResponse, String> {
    let skill_path = validate_export_skill_path(path, trusted_roots)?;
    let relative = skill_path
        .directory
        .strip_prefix(&skill_path.root)
        .map_err(|_| format!("Source \"{}\" not found", path.display()))?
        .join(SKILL_FILE_NAME);
    let raw = secure_read::read_confined_utf8(&skill_path.root, &relative, MAX_SKILL_FILE_BYTES)
        .map_err(|err| format!("Failed to read {SKILL_FILE_NAME}: {err}"))?;
    let parsed = parse_frontmatter::<SkillFrontmatter>(&raw);
    let frontmatter_name = parsed
        .as_ref()
        .ok()
        .and_then(Option::as_ref)
        .and_then(|(frontmatter, _)| frontmatter.name.clone());
    let (description, content) = match parsed {
        Ok(Some((frontmatter, content))) if raw.trim_start().starts_with("---") => {
            (frontmatter.description, content)
        }
        _ => (String::new(), raw),
    };
    let name = frontmatter_name
        .filter(|name| !name.is_empty())
        .or_else(|| {
            skill_path
                .directory
                .file_name()
                .and_then(|name| name.to_str())
                .map(str::to_string)
        })
        .unwrap_or_else(|| "unnamed".to_string());
    let json = serde_json::to_string_pretty(&serde_json::json!({
        "version": 1,
        "type": "skill",
        "name": name,
        "description": description,
        "content": content,
    }))
    .map_err(|err| format!("Failed to serialize source: {err}"))?;

    Ok(ExportSkillSourceResponse {
        filename: format!("{name}.skill.json"),
        json,
    })
}

fn export_skill_roots(app: &AppHandle) -> Result<Vec<PathBuf>, String> {
    let mut roots = Vec::new();
    let agents_root = crate::services::goose_config::agents_root()?;
    roots.push(agents_root.join("skills"));
    roots.push(crate::services::goose_config::config_dir()?.join("skills"));

    // Plugin paths are authorization roots, so malformed configuration fails
    // closed for plugins without blocking exports from ordinary skill roots.
    if let Ok(configured) = configured_plugins() {
        let user_settings = if let Some(path_root) = crate::services::goose_config::path_root() {
            path_root.join(".config/goose/settings.json")
        } else {
            agents_root
                .parent()
                .ok_or_else(|| "Could not determine home directory".to_string())?
                .join(".config/goose/settings.json")
        };
        roots.extend(enabled_plugin_skill_roots_at(
            &agents_root,
            &user_settings,
            &configured,
        ));
    }

    if crate::services::goose_config::path_root().is_none() {
        let home = agents_root
            .parent()
            .ok_or_else(|| "Could not determine home directory".to_string())?;
        roots.extend([
            home.join(".goose").join("skills"),
            home.join(".claude").join("skills"),
            home.join(".codex").join("skills"),
            home.join(".gemini").join("skills"),
            home.join(".config").join("agents").join("skills"),
        ]);
    }
    roots.push(
        app.path()
            .app_data_dir()
            .map_err(|err| format!("Failed to resolve Berd app data directory: {err}"))?
            .join("skills"),
    );
    Ok(roots)
}

fn personal_skills_root() -> Result<PathBuf, String> {
    Ok(crate::services::goose_config::agents_root()?.join("skills"))
}

fn personal_agents_root() -> Result<PathBuf, String> {
    Ok(crate::services::goose_config::agents_root()?.join("agents"))
}

#[tauri::command]
pub fn export_skill_source(
    app: AppHandle,
    path: String,
) -> Result<ExportSkillSourceResponse, String> {
    export_skill_at(Path::new(&path), &export_skill_roots(&app)?)
}

#[tauri::command]
pub fn import_skill_source(data: String) -> Result<ImportSourceResponse, String> {
    let source = import_skill_at(&personal_skills_root()?, &data)?;
    Ok(ImportSourceResponse {
        sources: vec![source],
    })
}

#[tauri::command]
pub fn import_agent_source(data: String) -> Result<ImportSourceResponse, String> {
    let source = import_agent_at(&personal_agents_root()?, &data)?;
    Ok(ImportSourceResponse {
        sources: vec![source],
    })
}

#[cfg(test)]
mod tests {
    use super::{
        configured_plugins_from_files, enabled_plugin_skill_roots_at, export_skill_at,
        import_agent_at, import_skill_at, parse_source_import, validate_export_skill_path,
        PluginConfigEntry, MAX_SKILL_FILE_BYTES, SKILL_FILE_NAME,
    };
    use serde_json::Value;
    use std::{collections::HashMap, fs};
    use tempfile::TempDir;

    fn skill_json(name: &str) -> String {
        serde_json::json!({
            "version": 1,
            "type": "skill",
            "name": name,
            "description": "Reviews code",
            "content": "Review carefully",
            "properties": { "color": "blue" }
        })
        .to_string()
    }

    #[test]
    fn skill_import_preserves_v1_shape_and_collision_names() {
        let temp = TempDir::new().unwrap();
        let root = temp.path().join(".agents").join("skills");

        let first = import_skill_at(&root, &skill_json("code-review")).unwrap();
        let second = import_skill_at(&root, &skill_json("code-review")).unwrap();
        let third = import_skill_at(&root, &skill_json("code-review")).unwrap();

        assert_eq!(first.name, "code-review");
        assert_eq!(second.name, "code-review-imported");
        assert_eq!(third.name, "code-review-imported-2");
        assert_eq!(
            first.properties.get("color"),
            Some(&Value::String("blue".into()))
        );
        let markdown = fs::read_to_string(root.join("code-review").join("SKILL.md")).unwrap();
        assert!(markdown.contains("metadata:\n  color: blue\n"));
        let frontmatter = markdown.split("---").nth(1).unwrap();
        let parsed: yaml_serde::Value = yaml_serde::from_str(frontmatter).unwrap();
        assert_eq!(parsed["metadata"]["color"].as_str(), Some("blue"));
    }

    #[test]
    fn agent_import_preserves_metadata_and_uses_numbered_collision_names() {
        let temp = TempDir::new().unwrap();
        let root = temp.path().join(".agents").join("agents");
        let data = serde_json::json!({
            "version": 1,
            "type": "agent",
            "name": "Research Helper",
            "description": "Finds evidence",
            "content": "  \nResearch carefully\n\n",
            "properties": {
                "avatar": "app-avatar:gloopy-1",
                "color": "blue",
                "name": "Reserved name",
                "description": "Reserved description"
            },
            "metadata": { "color": "red", "tone": "direct" }
        })
        .to_string();

        let first = import_agent_at(&root, &data).unwrap();
        let second = import_agent_at(&root, &data).unwrap();

        assert!(first.path.ends_with("research-helper.md"));
        assert!(second.path.ends_with("research-helper-2.md"));
        assert_eq!(
            first.properties.get("color"),
            Some(&Value::String("blue".into()))
        );
        assert_eq!(
            first.properties.get("tone"),
            Some(&Value::String("direct".into()))
        );
        assert_eq!(
            first.properties.get("avatar"),
            Some(&Value::String("app-avatar:gloopy-1".into()))
        );
        assert_eq!(first.content, "Research carefully");
        assert!(!first.properties.contains_key("name"));
        assert!(!first.properties.contains_key("description"));
        let markdown = fs::read_to_string(root.join("research-helper.md")).unwrap();
        assert!(markdown.contains("avatar: app-avatar:gloopy-1"));
        assert!(!markdown.contains("Reserved name"));
        assert!(!markdown.contains("Reserved description"));
    }

    #[test]
    fn export_reads_managed_project_skill_and_reproduces_v1_payload() {
        let temp = TempDir::new().unwrap();
        let skill_dir = temp
            .path()
            .join("project")
            .join(".agents")
            .join("skills")
            .join("code-review");
        fs::create_dir_all(&skill_dir).unwrap();
        fs::write(
            skill_dir.join("SKILL.md"),
            "---\nname: code-review\ndescription: Reviews code\nmetadata:\n  color: blue\n---\n\nReview carefully.\n",
        )
        .unwrap();

        let export = export_skill_at(&skill_dir, &[]).unwrap();
        let value: Value = serde_json::from_str(&export.json).unwrap();

        assert_eq!(export.filename, "code-review.skill.json");
        assert_eq!(value["version"], 1);
        assert_eq!(value["type"], "skill");
        assert_eq!(value["description"], "Reviews code");
        assert_eq!(value["content"], "Review carefully.");
        assert!(value.get("properties").is_none());
    }

    #[test]
    fn export_allows_nested_skills_and_requires_exact_plugin_skill_roots() {
        let temp = TempDir::new().unwrap();
        let arbitrary = temp.path().join("secrets");
        fs::create_dir(&arbitrary).unwrap();
        fs::write(arbitrary.join("SKILL.md"), "private").unwrap();

        assert!(validate_export_skill_path(&arbitrary, &[]).is_err());

        let nested = temp
            .path()
            .join("project")
            .join(".agents")
            .join("skills")
            .join("outer")
            .join("nested");
        fs::create_dir_all(&nested).unwrap();
        fs::write(nested.join("SKILL.md"), "nested skill").unwrap();
        assert!(export_skill_at(&nested, &[]).is_ok());

        let plugin_skill = temp
            .path()
            .join(".agents")
            .join("plugins")
            .join("plugin-name")
            .join("custom-skills")
            .join("plugin-skill");
        fs::create_dir_all(&plugin_skill).unwrap();
        fs::write(plugin_skill.join("SKILL.md"), "plugin skill").unwrap();
        assert!(export_skill_at(&plugin_skill, &[]).is_err());
        assert!(export_skill_at(
            &plugin_skill,
            &[plugin_skill.parent().unwrap().to_path_buf()]
        )
        .is_ok());
    }

    #[test]
    fn plugin_exports_use_enabled_manifest_skill_roots() {
        let temp = TempDir::new().unwrap();
        let agents_root = temp.path().join(".agents");
        let user_plugins = agents_root.join("plugins");
        let user_settings = temp.path().join(".config/goose/settings.json");

        for name in ["enabled", "config-disabled", "settings-disabled"] {
            fs::create_dir_all(user_plugins.join(name).join("skills")).unwrap();
        }
        fs::create_dir_all(user_settings.parent().unwrap()).unwrap();
        fs::write(
            &user_settings,
            r#"{"disabledPlugins":["settings-disabled"]}"#,
        )
        .unwrap();

        let custom_plugin = user_plugins.join("custom");
        fs::create_dir_all(custom_plugin.join("custom-skills")).unwrap();
        fs::write(
            custom_plugin.join("plugin.json"),
            r#"{"skills":{"paths":["./custom-skills"],"exclusive":true}}"#,
        )
        .unwrap();
        let project_plugin = temp.path().join("project/.agents/plugins/configured");
        fs::create_dir_all(project_plugin.join("skills")).unwrap();

        let configured = HashMap::from([
            (
                user_plugins.join("config-disabled"),
                PluginConfigEntry { enabled: false },
            ),
            (project_plugin.clone(), PluginConfigEntry { enabled: true }),
        ]);
        let roots = enabled_plugin_skill_roots_at(&agents_root, &user_settings, &configured);

        assert!(roots.contains(&user_plugins.join("enabled/skills")));
        assert!(roots.contains(&custom_plugin.join("custom-skills")));
        assert!(!roots
            .iter()
            .any(|root| root.starts_with(user_plugins.join("config-disabled"))));
        assert!(!roots
            .iter()
            .any(|root| root.starts_with(user_plugins.join("settings-disabled"))));
        assert!(!roots.iter().any(|root| root.starts_with(&project_plugin)));
    }

    #[test]
    fn plugin_paths_cannot_bypass_authorization_with_nested_managed_roots() {
        let temp = TempDir::new().unwrap();
        let agents_root = temp.path().join(".agents");
        let user_plugins = agents_root.join("plugins");
        let disabled_plugin = user_plugins.join("disabled");
        let project_plugin = temp.path().join("project/.agents/plugins/untrusted");
        let enabled_plugin = user_plugins.join("enabled");
        let enabled_skill = enabled_plugin.join("skills/exportable");

        fs::create_dir_all(&enabled_skill).unwrap();
        fs::write(enabled_skill.join(SKILL_FILE_NAME), "enabled").unwrap();
        let configured = HashMap::from([(
            disabled_plugin.clone(),
            PluginConfigEntry { enabled: false },
        )]);
        let trusted_roots = enabled_plugin_skill_roots_at(
            &agents_root,
            &temp.path().join("missing-settings.json"),
            &configured,
        );

        assert!(export_skill_at(&enabled_skill, &trusted_roots).is_ok());
        for manager in [".agents", ".goose", ".claude"] {
            for plugin in [&disabled_plugin, &project_plugin] {
                let bypass = plugin.join("nested").join(manager).join("skills/bypass");
                fs::create_dir_all(&bypass).unwrap();
                fs::write(bypass.join(SKILL_FILE_NAME), "private").unwrap();

                assert!(export_skill_at(&bypass, &trusted_roots).is_err());
            }
        }
    }

    #[cfg(unix)]
    #[test]
    fn project_plugin_symlink_cannot_alias_an_enabled_user_plugin_root() {
        use std::os::unix::fs::symlink;

        let temp = TempDir::new().unwrap();
        let agents_root = temp.path().join(".agents");
        let enabled_plugin = agents_root.join("plugins/enabled");
        let enabled_skill = enabled_plugin.join("skills/exportable");
        fs::create_dir_all(&enabled_skill).unwrap();
        fs::write(enabled_skill.join(SKILL_FILE_NAME), "enabled").unwrap();
        let trusted_roots = enabled_plugin_skill_roots_at(
            &agents_root,
            &temp.path().join("missing-settings.json"),
            &HashMap::new(),
        );
        assert!(export_skill_at(&enabled_skill, &trusted_roots).is_ok());

        let project_plugins = temp.path().join("project/.agents/plugins");
        fs::create_dir_all(&project_plugins).unwrap();
        let alias = project_plugins.join("alias");
        symlink(&enabled_plugin, &alias).unwrap();

        assert!(export_skill_at(&alias.join("skills/exportable"), &trusted_roots).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn enabled_user_plugin_symlink_can_target_an_ordinary_skill_root() {
        use std::os::unix::fs::symlink;

        let temp = TempDir::new().unwrap();
        let agents_root = temp.path().join(".agents");
        let ordinary_root = agents_root.join("skills");
        let plugin_target = ordinary_root.join("plugin-target");
        let target_skill = plugin_target.join("skills/exportable");
        fs::create_dir_all(&target_skill).unwrap();
        fs::write(target_skill.join(SKILL_FILE_NAME), "enabled").unwrap();

        let plugins_root = agents_root.join("plugins");
        fs::create_dir_all(&plugins_root).unwrap();
        let enabled_plugin = plugins_root.join("enabled");
        symlink(&plugin_target, &enabled_plugin).unwrap();
        let requested_skill = enabled_plugin.join("skills/exportable");

        let mut trusted_roots = vec![ordinary_root];
        trusted_roots.extend(enabled_plugin_skill_roots_at(
            &agents_root,
            &temp.path().join("missing-settings.json"),
            &HashMap::new(),
        ));

        assert!(export_skill_at(&requested_skill, &trusted_roots).is_ok());
    }

    #[test]
    fn plugin_config_skips_invalid_layers_without_hiding_valid_layers() {
        let temp = TempDir::new().unwrap();
        let invalid = temp.path().join("invalid.yaml");
        let valid = temp.path().join("valid.yaml");
        let plugin = temp.path().join(".agents/plugins/example");
        fs::write(&invalid, "plugins: [").unwrap();
        fs::write(
            &valid,
            format!("plugins:\n  '{}':\n    enabled: false\n", plugin.display()),
        )
        .unwrap();

        for paths in [[invalid.clone(), valid.clone()], [valid, invalid]] {
            let configured = configured_plugins_from_files(paths);
            assert!(configured.get(&plugin).is_some_and(|entry| !entry.enabled));
        }
    }

    #[test]
    fn export_accepts_one_mebibyte_skill_and_rejects_one_byte_more() {
        let temp = TempDir::new().unwrap();
        let skill_dir = temp.path().join("project/.agents/skills/boundary");
        fs::create_dir_all(&skill_dir).unwrap();
        let skill_file = skill_dir.join(SKILL_FILE_NAME);

        fs::write(&skill_file, vec![b'x'; MAX_SKILL_FILE_BYTES as usize]).unwrap();
        assert!(export_skill_at(&skill_dir, &[]).is_ok());

        fs::write(&skill_file, vec![b'x'; MAX_SKILL_FILE_BYTES as usize + 1]).unwrap();
        assert!(export_skill_at(&skill_dir, &[]).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn secure_read_stays_in_opened_ancestor_after_symlink_swap() {
        use std::os::unix::fs::symlink;
        use std::path::Path;

        let temp = TempDir::new().unwrap();
        let root = temp.path().join("project/.agents/skills");
        fs::create_dir_all(&root).unwrap();
        let root = root.canonicalize().unwrap();
        let original = root.join("outer");
        let moved = root.join("moved");
        let outside = temp.path().join("outside");
        fs::create_dir_all(original.join("nested")).unwrap();
        fs::create_dir_all(outside.join("nested")).unwrap();
        fs::write(original.join("nested/SKILL.md"), "safe").unwrap();
        fs::write(outside.join("nested/SKILL.md"), "secret").unwrap();

        let mut swapped = false;
        let raw = super::secure_read::read_confined_utf8_for_test(
            &root,
            Path::new("outer/nested/SKILL.md"),
            MAX_SKILL_FILE_BYTES,
            |opened| {
                if !swapped && opened == Path::new("outer") {
                    fs::rename(&original, &moved).unwrap();
                    symlink(&outside, &original).unwrap();
                    swapped = true;
                }
            },
        )
        .unwrap();

        assert!(swapped);
        assert_eq!(raw, "safe");
    }

    #[test]
    fn export_rejects_symlinked_skill_files() {
        let temp = TempDir::new().unwrap();
        let arbitrary = temp.path().join("secrets");
        fs::create_dir(&arbitrary).unwrap();
        fs::write(arbitrary.join("SKILL.md"), "private").unwrap();

        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            let skill_dir = temp
                .path()
                .join("project")
                .join(".agents")
                .join("skills")
                .join("linked");
            fs::create_dir_all(&skill_dir).unwrap();
            symlink(arbitrary.join("SKILL.md"), skill_dir.join("SKILL.md")).unwrap();
            assert!(export_skill_at(&skill_dir, &[]).is_err());
        }
    }

    #[test]
    fn export_treats_malformed_or_non_leading_frontmatter_as_plain_content() {
        let temp = TempDir::new().unwrap();
        let skills_root = temp.path().join("project").join(".goose").join("skills");

        for (name, expected_name, markdown) in [
            ("malformed", "malformed", "---\nname: [\n---\nprivate"),
            (
                "non-leading",
                "spoofed",
                "intro\n---\nname: spoofed\ndescription: hidden\n---\nprivate",
            ),
        ] {
            let skill_dir = skills_root.join(name);
            fs::create_dir_all(&skill_dir).unwrap();
            fs::write(skill_dir.join("SKILL.md"), markdown).unwrap();
            let export = export_skill_at(&skill_dir, &[]).unwrap();
            let value: Value = serde_json::from_str(&export.json).unwrap();

            assert_eq!(value["name"], expected_name);
            assert_eq!(value["description"], "");
            assert_eq!(value["content"], markdown);
        }
    }

    #[test]
    fn export_does_not_infer_project_codex_or_gemini_roots() {
        let temp = TempDir::new().unwrap();

        for manager in [".codex", ".gemini"] {
            let root = temp.path().join("project").join(manager).join("skills");
            let skill_dir = root.join("private");
            fs::create_dir_all(&skill_dir).unwrap();
            fs::write(skill_dir.join(SKILL_FILE_NAME), "private").unwrap();

            assert!(export_skill_at(&skill_dir, &[]).is_err());
            assert!(export_skill_at(&skill_dir, &[root]).is_ok());
        }
    }

    #[test]
    fn imports_reject_wrong_type_invalid_version_and_unsafe_names() {
        assert!(
            parse_source_import(r#"{"version":1,"type":"project","name":"x"}"#, "skill").is_err()
        );
        assert!(parse_source_import(
            r#"{"version":2,"type":"skill","name":"x","description":"x"}"#,
            "skill"
        )
        .is_err());

        let temp = TempDir::new().unwrap();
        assert!(import_skill_at(temp.path(), &skill_json("../escape")).is_err());
        let agent = serde_json::json!({
            "version": 1,
            "type": "agent",
            "name": "../escape",
            "content": "x"
        })
        .to_string();
        assert!(import_agent_at(temp.path(), &agent).is_err());
    }
}
