//! Safe local lifecycle for marketplace-managed Agent Markdown documents.

#![allow(dead_code)]

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_yaml::Value as YamlValue;

use super::agents_models::{AgentInstallResolution, InstalledAgentRequest};
use super::skills_api::{exit_codes, failure, MarketplaceClient};
use super::skills_archive::{extract_zip_safely, sha256_hex, verify_agent_artifact};
use super::skills_config::{default_agents_agents_dir, kgoose_service_url, SkillsConfig};
use super::skills_targets::iso8601_utc;

const RECORD_SCHEMA: &str = "bb-agent-install/v1";
const LOCK_STALE_SECS: u64 = 15 * 60;

#[derive(Debug, Clone)]
pub struct AgentPaths {
    pub target: PathBuf,
    pub state: PathBuf,
    lock: PathBuf,
}

pub fn validate_slug(slug: &str) -> Result<()> {
    if slug.is_empty()
        || !slug.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'-' | b'_')
        })
    {
        return Err(failure(
            exit_codes::FS_CONFLICT,
            "invalid_agent_slug",
            format!("invalid agent slug `{slug}`"),
        ));
    }
    Ok(())
}

pub fn agent_paths(config: &SkillsConfig, slug: &str) -> Result<AgentPaths> {
    validate_slug(slug)?;
    let agents_root = if config.local_dev {
        config.skills_home.join("agents")
    } else {
        default_agents_agents_dir()
    };
    let state_root = config.bb_home.join("agents").join("installed");
    Ok(AgentPaths {
        target: agents_root.join(format!("{slug}.md")),
        state: state_root.join(format!("{slug}.json")),
        lock: config
            .bb_home
            .join("agents")
            .join("locks")
            .join(format!("{slug}.lock")),
    })
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InstalledAgentMetadata {
    pub schema_version: String,
    pub kind: String,
    pub slug: String,
    pub version_id: String,
    pub content_sha256: String,
    pub installed_file_sha256: String,
    pub artifact_id: String,
    pub artifact_sha256: String,
    pub artifact_size_bytes: u64,
    pub artifact_media_type: String,
    pub source_id: String,
    pub source_snapshot_id: String,
    pub source_revision: String,
    pub source_path: String,
    pub server_url: String,
    pub installed_at: String,
    pub installed_via: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AgentOwnership {
    Absent,
    ManagedExact(InstalledAgentMetadata),
    ManagedMissingFile(InstalledAgentMetadata),
    ProtectedConflict { reason: String },
}

pub fn classify(paths: &AgentPaths, slug: &str) -> Result<AgentOwnership> {
    validate_slug(slug)?;
    let target = fs::symlink_metadata(&paths.target);
    let state = fs::symlink_metadata(&paths.state);
    match (target, state) {
        (Err(target_err), Err(state_err))
            if target_err.kind() == std::io::ErrorKind::NotFound
                && state_err.kind() == std::io::ErrorKind::NotFound =>
        {
            Ok(AgentOwnership::Absent)
        }
        (target, state) => {
            let metadata = match state {
                Ok(metadata) if metadata.file_type().is_file() => read_metadata(&paths.state),
                Ok(_) => Err(anyhow::anyhow!("state path is not a regular file")),
                Err(err) => Err(anyhow::Error::new(err)),
            };
            let metadata = match metadata {
                Ok(metadata)
                    if metadata.schema_version == RECORD_SCHEMA
                        && metadata.kind == "agent"
                        && metadata.slug == slug =>
                {
                    metadata
                }
                Ok(_) => {
                    return Ok(AgentOwnership::ProtectedConflict {
                        reason: "state record does not prove ownership of this agent".to_string(),
                    })
                }
                Err(_) => {
                    return Ok(AgentOwnership::ProtectedConflict {
                        reason: "state record is missing, malformed, or not a regular file"
                            .to_string(),
                    })
                }
            };
            match target {
                Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                    Ok(AgentOwnership::ManagedMissingFile(metadata))
                }
                Ok(file) if file.file_type().is_file() => {
                    let bytes = fs::read(&paths.target)
                        .with_context(|| format!("read {}", paths.target.display()))?;
                    if sha256_hex(&bytes) == metadata.installed_file_sha256 {
                        Ok(AgentOwnership::ManagedExact(metadata))
                    } else {
                        Ok(AgentOwnership::ProtectedConflict {
                            reason: "agent file differs from its managed record".to_string(),
                        })
                    }
                }
                _ => Ok(AgentOwnership::ProtectedConflict {
                    reason: "agent target is not a regular managed file".to_string(),
                }),
            }
        }
    }
}

pub fn installed_request(ownership: &AgentOwnership) -> Vec<InstalledAgentRequest> {
    match ownership {
        AgentOwnership::ManagedExact(metadata) => vec![InstalledAgentRequest {
            slug: metadata.slug.clone(),
            version_id: Some(metadata.version_id.clone()),
            content_sha256: Some(metadata.content_sha256.clone()),
            scope: Some("global".to_string()),
            targets: Vec::new(),
            installed_via: Some(metadata.installed_via.clone()),
            local_source: false,
        }],
        _ => Vec::new(),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AgentLifecycleStatus {
    Installed,
    Updated,
    UpToDate,
    Removed,
    AlreadyAbsent,
    Conflict,
}

#[derive(Debug, Clone)]
pub struct AgentLifecycleResult {
    pub status: AgentLifecycleStatus,
    pub slug: String,
    pub path: PathBuf,
    pub metadata: Option<InstalledAgentMetadata>,
    pub reason: Option<String>,
}

pub fn install_or_update(
    config: &SkillsConfig,
    client: &MarketplaceClient,
    slug: &str,
    version_id: Option<String>,
) -> Result<AgentLifecycleResult> {
    apply_install_or_update(config, client, slug, version_id, false)
}

pub fn update(
    config: &SkillsConfig,
    client: &MarketplaceClient,
    slug: &str,
    version_id: Option<String>,
) -> Result<AgentLifecycleResult> {
    apply_install_or_update(config, client, slug, version_id, true)
}

fn apply_install_or_update(
    config: &SkillsConfig,
    client: &MarketplaceClient,
    slug: &str,
    version_id: Option<String>,
    update_only: bool,
) -> Result<AgentLifecycleResult> {
    let paths = agent_paths(config, slug)?;
    let _lock = AgentLock::acquire(&paths.lock)?;
    let ownership = classify(&paths, slug)?;
    if update_only && matches!(&ownership, AgentOwnership::Absent) {
        return Err(failure(
            exit_codes::GENERAL,
            "not_installed",
            format!("agent `{slug}` is not installed; run `bb agents install {slug}`"),
        ));
    }
    if let AgentOwnership::ProtectedConflict { reason } = ownership {
        return Ok(conflict_result(slug, &paths, reason));
    }
    let resolution =
        client
            .agents()
            .resolve_install(slug, version_id, installed_request(&ownership))?;
    let document = download_if_required(&ownership, &resolution.action, || {
        download_agent_document(client, &resolution)
    })?;
    if document.is_none() {
        let AgentOwnership::ManagedExact(metadata) = ownership else {
            unreachable!()
        };
        return Ok(up_to_date_result(slug, &paths, metadata, resolution.reason));
    }
    let document = document.expect("agent download is required for a non-noop operation");
    let metadata = metadata_for(config, &resolution, slug, &document)?;
    replace_pair(&paths, &document, &metadata)?;
    Ok(AgentLifecycleResult {
        status: if matches!(
            ownership,
            AgentOwnership::Absent | AgentOwnership::ManagedMissingFile(_)
        ) {
            AgentLifecycleStatus::Installed
        } else {
            AgentLifecycleStatus::Updated
        },
        slug: slug.to_string(),
        path: paths.target,
        metadata: Some(metadata),
        reason: Some(resolution.reason),
    })
}

pub fn remove(config: &SkillsConfig, slug: &str) -> Result<AgentLifecycleResult> {
    let paths = agent_paths(config, slug)?;
    let _lock = AgentLock::acquire(&paths.lock)?;
    remove_at_paths(&paths, slug)
}

fn remove_at_paths(paths: &AgentPaths, slug: &str) -> Result<AgentLifecycleResult> {
    match classify(paths, slug)? {
        AgentOwnership::Absent => Ok(AgentLifecycleResult {
            status: AgentLifecycleStatus::AlreadyAbsent,
            slug: slug.to_string(),
            path: paths.target.clone(),
            metadata: None,
            reason: None,
        }),
        AgentOwnership::ProtectedConflict { reason } => Ok(conflict_result(slug, paths, reason)),
        AgentOwnership::ManagedExact(metadata) => {
            remove_pair(paths, true)?;
            Ok(removed_result(slug, paths.target.clone(), metadata))
        }
        AgentOwnership::ManagedMissingFile(metadata) => {
            remove_pair(paths, false)?;
            Ok(removed_result(slug, paths.target.clone(), metadata))
        }
    }
}

fn conflict_result(slug: &str, paths: &AgentPaths, reason: String) -> AgentLifecycleResult {
    AgentLifecycleResult {
        status: AgentLifecycleStatus::Conflict,
        slug: slug.to_string(),
        path: paths.target.clone(),
        metadata: None,
        reason: Some(reason),
    }
}

fn removed_result(
    slug: &str,
    path: PathBuf,
    metadata: InstalledAgentMetadata,
) -> AgentLifecycleResult {
    AgentLifecycleResult {
        status: AgentLifecycleStatus::Removed,
        slug: slug.to_string(),
        path,
        metadata: Some(metadata),
        reason: None,
    }
}

fn up_to_date_result(
    slug: &str,
    paths: &AgentPaths,
    metadata: InstalledAgentMetadata,
    reason: String,
) -> AgentLifecycleResult {
    AgentLifecycleResult {
        status: AgentLifecycleStatus::UpToDate,
        slug: slug.to_string(),
        path: paths.target.clone(),
        metadata: Some(metadata),
        reason: Some(reason),
    }
}

fn download_if_required<F>(
    ownership: &AgentOwnership,
    action: &str,
    download: F,
) -> Result<Option<Vec<u8>>>
where
    F: FnOnce() -> Result<Vec<u8>>,
{
    if action == "noop" && matches!(ownership, AgentOwnership::ManagedExact(_)) {
        Ok(None)
    } else {
        download().map(Some)
    }
}

fn read_metadata(path: &Path) -> Result<InstalledAgentMetadata> {
    serde_json::from_slice(&fs::read(path).with_context(|| format!("read {}", path.display()))?)
        .with_context(|| format!("parse {}", path.display()))
}

fn download_agent_document(
    client: &MarketplaceClient,
    resolution: &AgentInstallResolution,
) -> Result<Vec<u8>> {
    let artifact = resolution
        .artifact
        .as_ref()
        .context("agent install operation did not include artifact metadata")?;
    let download = client.download(&artifact.download_url)?;
    verify_agent_artifact(&download, artifact)?;
    let parent = std::env::temp_dir().join(format!(
        "bb-agent-validate-{}-{}",
        resolution.plan.slug,
        unique_suffix()
    ));
    fs::create_dir_all(&parent).with_context(|| format!("create {}", parent.display()))?;
    let result = (|| {
        extract_zip_safely(&download.bytes, &parent)?;
        read_agent_document(&parent)
    })();
    let _ = fs::remove_dir_all(&parent);
    result
}

fn read_agent_document(root: &Path) -> Result<Vec<u8>> {
    let mut candidates = Vec::new();
    collect_markdown(root, &mut candidates)?;
    if candidates.len() != 1 {
        anyhow::bail!(
            "agent artifact must contain exactly one Agent Markdown document; found {}",
            candidates.len()
        );
    }
    let bytes =
        fs::read(&candidates[0]).with_context(|| format!("read {}", candidates[0].display()))?;
    validate_agent_document(&bytes)?;
    Ok(bytes)
}

fn collect_markdown(root: &Path, candidates: &mut Vec<PathBuf>) -> Result<()> {
    for entry in fs::read_dir(root).with_context(|| format!("read {}", root.display()))? {
        let entry = entry.with_context(|| format!("read entry in {}", root.display()))?;
        let file_type = entry
            .file_type()
            .with_context(|| format!("stat {}", entry.path().display()))?;
        if file_type.is_symlink() {
            anyhow::bail!("agent artifact contains a symlink")
        }
        if file_type.is_dir() {
            collect_markdown(&entry.path(), candidates)?;
        } else if file_type.is_file()
            && entry
                .path()
                .extension()
                .is_some_and(|ext| ext.eq_ignore_ascii_case("md"))
        {
            candidates.push(entry.path());
        }
    }
    Ok(())
}

fn validate_agent_document(bytes: &[u8]) -> Result<()> {
    let text = std::str::from_utf8(bytes).context("agent document is not UTF-8")?;
    let body = text
        .strip_prefix("---\n")
        .or_else(|| text.strip_prefix("---\r\n"))
        .context("agent document must begin with YAML frontmatter")?;
    let (frontmatter, persona) = if let Some(index) = body.find("\n---\n") {
        (&body[..index], &body[index + 5..])
    } else if let Some(index) = body.find("\r\n---\r\n") {
        (&body[..index], &body[index + 7..])
    } else {
        anyhow::bail!("agent document frontmatter is not terminated")
    };
    let yaml: YamlValue =
        serde_yaml::from_str(frontmatter).context("parse agent YAML frontmatter")?;
    let map = yaml
        .as_mapping()
        .context("agent frontmatter must be a mapping")?;
    for field in ["name", "description"] {
        let value = map
            .get(YamlValue::String(field.to_string()))
            .and_then(YamlValue::as_str)
            .filter(|value| !value.trim().is_empty());
        if value.is_none() {
            anyhow::bail!("agent frontmatter requires a nonblank string {field}")
        }
    }
    if persona.trim().is_empty() {
        anyhow::bail!("agent document requires a nonblank persona body")
    }
    Ok(())
}

fn metadata_for(
    config: &SkillsConfig,
    resolution: &AgentInstallResolution,
    slug: &str,
    document: &[u8],
) -> Result<InstalledAgentMetadata> {
    let artifact = resolution
        .artifact
        .as_ref()
        .context("agent artifact disappeared during install")?;
    Ok(InstalledAgentMetadata {
        schema_version: RECORD_SCHEMA.to_string(),
        kind: "agent".to_string(),
        slug: slug.to_string(),
        version_id: resolution.plan.version_id.clone(),
        content_sha256: resolution.plan.content_sha256.clone(),
        installed_file_sha256: sha256_hex(document),
        artifact_id: artifact.id.clone(),
        artifact_sha256: artifact.sha256.clone(),
        artifact_size_bytes: artifact.size_bytes,
        artifact_media_type: artifact.media_type.clone(),
        source_id: resolution.version.source.source_id.clone(),
        source_snapshot_id: resolution.version.source.snapshot_id.clone(),
        source_revision: resolution.version.source.revision.clone(),
        source_path: resolution.version.source.path.clone(),
        server_url: kgoose_service_url(&config.kgoose_base_url, &config.kgoose_service_path),
        installed_at: iso8601_utc(unix_seconds()?),
        installed_via: resolution.installed_via.clone(),
    })
}

fn replace_pair(
    paths: &AgentPaths,
    document: &[u8],
    metadata: &InstalledAgentMetadata,
) -> Result<()> {
    replace_pair_with_rename(paths, document, metadata, |from, to| fs::rename(from, to))
}

fn replace_pair_with_rename<F>(
    paths: &AgentPaths,
    document: &[u8],
    metadata: &InstalledAgentMetadata,
    mut rename: F,
) -> Result<()>
where
    F: FnMut(&Path, &Path) -> std::io::Result<()>,
{
    let target_parent = paths
        .target
        .parent()
        .context("agent target has no parent")?;
    let state_parent = paths.state.parent().context("agent state has no parent")?;
    fs::create_dir_all(target_parent)
        .with_context(|| format!("create {}", target_parent.display()))?;
    fs::create_dir_all(state_parent)
        .with_context(|| format!("create {}", state_parent.display()))?;
    let suffix = unique_suffix();
    let target_stage = target_parent.join(format!(
        ".{}.stage-{suffix}",
        paths.target.file_name().unwrap().to_string_lossy()
    ));
    let state_stage = state_parent.join(format!(
        ".{}.stage-{suffix}",
        paths.state.file_name().unwrap().to_string_lossy()
    ));
    write_new_file(&target_stage, document)?;
    write_new_file(
        &state_stage,
        &serde_json::to_vec_pretty(metadata).context("serialize agent state")?,
    )?;
    let target_backup = backup_path(&paths.target, suffix);
    let state_backup = backup_path(&paths.state, suffix);
    let target_existed = paths.target.exists();
    let state_existed = paths.state.exists();
    let result = (|| -> Result<()> {
        if target_existed {
            rename(&paths.target, &target_backup)
                .with_context(|| format!("backup {}", paths.target.display()))?;
        }
        if state_existed {
            if let Err(error) = rename(&paths.state, &state_backup) {
                let operation =
                    anyhow::Error::new(error).context(format!("backup {}", paths.state.display()));
                return Err(with_recovery(
                    operation,
                    restore_pair(
                        &mut rename,
                        paths,
                        &target_backup,
                        &state_backup,
                        target_existed,
                        false,
                        false,
                    ),
                ));
            }
        }
        if let Err(error) = rename(&target_stage, &paths.target) {
            let operation =
                anyhow::Error::new(error).context(format!("install {}", paths.target.display()));
            return Err(with_recovery(
                operation,
                restore_pair(
                    &mut rename,
                    paths,
                    &target_backup,
                    &state_backup,
                    target_existed,
                    state_existed,
                    false,
                ),
            ));
        }
        if let Err(error) = rename(&state_stage, &paths.state) {
            let operation =
                anyhow::Error::new(error).context(format!("install {}", paths.state.display()));
            return Err(with_recovery(
                operation,
                restore_pair(
                    &mut rename,
                    paths,
                    &target_backup,
                    &state_backup,
                    target_existed,
                    state_existed,
                    true,
                ),
            ));
        }
        Ok(())
    })();
    match result {
        Ok(()) => {
            remove_backups(&target_backup, &state_backup)?;
            Ok(())
        }
        Err(operation) => Err(with_recovery(
            operation,
            remove_stages(&target_stage, &state_stage),
        )),
    }
}

fn remove_pair(paths: &AgentPaths, has_target: bool) -> Result<()> {
    let suffix = unique_suffix();
    let target_backup = backup_path(&paths.target, suffix);
    let state_backup = backup_path(&paths.state, suffix);
    if has_target {
        fs::rename(&paths.target, &target_backup)
            .with_context(|| format!("stage removal of {}", paths.target.display()))?;
    }
    if let Err(error) = fs::rename(&paths.state, &state_backup) {
        let operation = anyhow::Error::new(error)
            .context(format!("stage removal of {}", paths.state.display()));
        return Err(with_recovery(
            operation,
            restore_pair(
                &mut |from, to| fs::rename(from, to),
                paths,
                &target_backup,
                &state_backup,
                has_target,
                false,
                false,
            ),
        ));
    }
    if has_target {
        fs::remove_file(&target_backup)
            .with_context(|| format!("remove {}", paths.target.display()))?;
    }
    fs::remove_file(&state_backup).with_context(|| format!("remove {}", paths.state.display()))
}

fn restore_pair<F>(
    rename: &mut F,
    paths: &AgentPaths,
    target_backup: &Path,
    state_backup: &Path,
    target_existed: bool,
    state_existed: bool,
    target_replaced: bool,
) -> Result<()>
where
    F: FnMut(&Path, &Path) -> std::io::Result<()>,
{
    let mut failures = Vec::new();
    if target_replaced {
        if let Err(error) = fs::remove_file(&paths.target) {
            failures.push(format!(
                "remove replacement {}: {error}",
                paths.target.display()
            ));
        }
    }
    if state_existed {
        if let Err(error) = rename(state_backup, &paths.state) {
            failures.push(format!("restore {}: {error}", paths.state.display()));
        }
    }
    if target_existed {
        if let Err(error) = rename(target_backup, &paths.target) {
            failures.push(format!("restore {}: {error}", paths.target.display()));
        }
    }
    if failures.is_empty() {
        Ok(())
    } else {
        anyhow::bail!(failures.join("; "))
    }
}

fn with_recovery(operation: anyhow::Error, recovery: Result<()>) -> anyhow::Error {
    match recovery {
        Ok(()) => operation,
        Err(recovery_error) => anyhow::anyhow!(
            "{operation:#}; recovery failed: {recovery_error:#}. Inspect the agent and state paths before retrying."
        ),
    }
}

fn remove_stages(target_stage: &Path, state_stage: &Path) -> Result<()> {
    for stage in [target_stage, state_stage] {
        match fs::remove_file(stage) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(error).with_context(|| format!("remove stage {}", stage.display()))
            }
        }
    }
    Ok(())
}

fn remove_backups(target_backup: &Path, state_backup: &Path) -> Result<()> {
    for backup in [target_backup, state_backup] {
        match fs::remove_file(backup) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(error).with_context(|| format!("remove backup {}", backup.display()))
            }
        }
    }
    Ok(())
}

fn backup_path(path: &Path, suffix: u128) -> PathBuf {
    path.parent().unwrap().join(format!(
        ".{}.previous-{suffix}",
        path.file_name().unwrap().to_string_lossy()
    ))
}

fn write_new_file(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .with_context(|| format!("create {}", path.display()))?;
    file.write_all(bytes)
        .with_context(|| format!("write {}", path.display()))?;
    file.sync_all()
        .with_context(|| format!("sync {}", path.display()))
}

fn unique_suffix() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos()
}

fn unix_seconds() -> Result<u64> {
    Ok(SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .context("system clock is before UNIX epoch")?
        .as_secs())
}

struct AgentLock {
    path: PathBuf,
}

impl AgentLock {
    fn acquire(path: &Path) -> Result<Self> {
        let parent = path.parent().context("agent lock has no parent")?;
        fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
        for _ in 0..2 {
            match fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(path)
            {
                Ok(mut file) => {
                    let _ = writeln!(file, "{}", std::process::id());
                    return Ok(Self {
                        path: path.to_path_buf(),
                    });
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    let stale = fs::metadata(path)
                        .and_then(|metadata| metadata.modified())
                        .ok()
                        .and_then(|modified| modified.elapsed().ok())
                        .is_some_and(|age| age.as_secs() > LOCK_STALE_SECS);
                    if stale {
                        let _ = fs::remove_file(path);
                        continue;
                    }
                    return Err(failure(
                        exit_codes::FS_CONFLICT,
                        "agent_locked",
                        format!(
                            "another bb agents operation is running; remove {} if this is stale",
                            path.display()
                        ),
                    ));
                }
                Err(error) => {
                    return Err(error).with_context(|| format!("create {}", path.display()))
                }
            }
        }
        Err(failure(
            exit_codes::FS_CONFLICT,
            "agent_locked",
            format!("could not acquire {}", path.display()),
        ))
    }
}

impl Drop for AgentLock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_paths(slug: &str) -> (tempfile::TempDir, AgentPaths) {
        let root = tempfile::tempdir().unwrap();
        let paths = AgentPaths {
            target: root.path().join("agents").join(format!("{slug}.md")),
            state: root.path().join("state").join(format!("{slug}.json")),
            lock: root.path().join("lock"),
        };
        (root, paths)
    }

    fn record(slug: &str, contents: &[u8]) -> InstalledAgentMetadata {
        InstalledAgentMetadata {
            schema_version: RECORD_SCHEMA.to_string(),
            kind: "agent".to_string(),
            slug: slug.to_string(),
            version_id: "v1".to_string(),
            content_sha256: "content".to_string(),
            installed_file_sha256: sha256_hex(contents),
            artifact_id: "artifact".to_string(),
            artifact_sha256: "artifact-sha".to_string(),
            artifact_size_bytes: 1,
            artifact_media_type: "application/zip".to_string(),
            source_id: "source".to_string(),
            source_snapshot_id: "snapshot".to_string(),
            source_revision: "revision".to_string(),
            source_path: "agents/demo.md".to_string(),
            server_url: "http://localhost".to_string(),
            installed_at: "0Z".to_string(),
            installed_via: "explicit".to_string(),
        }
    }

    #[test]
    fn rejects_unsafe_slugs() {
        for slug in ["", "../demo", "Demo", "a/b", "a.b"] {
            assert!(validate_slug(slug).is_err());
        }
        assert!(validate_slug("release-notes_2").is_ok());
    }

    #[test]
    fn classifies_absent_exact_missing_and_changed_content() {
        let (_root, paths) = temp_paths("demo");
        assert!(matches!(
            classify(&paths, "demo").unwrap(),
            AgentOwnership::Absent
        ));
        let contents = b"---\nname: Demo\ndescription: Test\n---\nPersona";
        fs::create_dir_all(paths.target.parent().unwrap()).unwrap();
        fs::create_dir_all(paths.state.parent().unwrap()).unwrap();
        fs::write(&paths.target, contents).unwrap();
        fs::write(
            &paths.state,
            serde_json::to_vec(&record("demo", contents)).unwrap(),
        )
        .unwrap();
        assert!(matches!(
            classify(&paths, "demo").unwrap(),
            AgentOwnership::ManagedExact(_)
        ));
        fs::remove_file(&paths.target).unwrap();
        assert!(matches!(
            classify(&paths, "demo").unwrap(),
            AgentOwnership::ManagedMissingFile(_)
        ));
        fs::write(&paths.target, b"changed").unwrap();
        assert!(matches!(
            classify(&paths, "demo").unwrap(),
            AgentOwnership::ProtectedConflict { .. }
        ));
    }

    #[test]
    fn validates_agent_document_contract() {
        assert!(
            validate_agent_document(b"---\nname: Demo\ndescription: Test\n---\nPersona").is_ok()
        );
        assert!(validate_agent_document(b"---\nname: Demo\n---\nPersona").is_err());
        assert!(validate_agent_document(b"---\nname: Demo\ndescription: Test\n---\n  ").is_err());
    }

    #[test]
    fn accepts_crlf_frontmatter_with_a_short_persona() {
        assert!(
            validate_agent_document(b"---\r\nname: Demo\r\ndescription: Test\r\n---\r\nI").is_ok()
        );
    }

    #[test]
    fn restores_existing_pair_when_target_stage_rename_fails() {
        let (_root, paths) = temp_paths("demo");
        let old_document = b"---\nname: Demo\ndescription: Old\n---\nOld";
        let old_state = serde_json::to_vec(&record("demo", old_document)).unwrap();
        fs::create_dir_all(paths.target.parent().unwrap()).unwrap();
        fs::create_dir_all(paths.state.parent().unwrap()).unwrap();
        fs::write(&paths.target, old_document).unwrap();
        fs::write(&paths.state, &old_state).unwrap();

        let replacement = b"---\nname: Demo\ndescription: New\n---\nNew";
        let error = replace_pair_with_rename(
            &paths,
            replacement,
            &record("demo", replacement),
            |from, to| {
                if from.parent() == paths.target.parent()
                    && from
                        .file_name()
                        .is_some_and(|name| name.to_string_lossy().starts_with(".demo.md.stage-"))
                {
                    return Err(std::io::Error::other(
                        "injected target-stage rename failure",
                    ));
                }
                fs::rename(from, to)
            },
        )
        .unwrap_err();

        assert!(format!("{error:#}").contains("injected target-stage rename failure"));
        assert_eq!(fs::read(&paths.target).unwrap(), old_document);
        assert_eq!(fs::read(&paths.state).unwrap(), old_state);
    }

    #[test]
    fn reports_failed_pair_recovery_with_canonical_paths() {
        let (_root, paths) = temp_paths("demo");
        fs::create_dir_all(paths.target.parent().unwrap()).unwrap();
        let suffix = unique_suffix();
        let recovery = restore_pair(
            &mut |_, _| Err(std::io::Error::other("injected restore failure")),
            &paths,
            &backup_path(&paths.target, suffix),
            &backup_path(&paths.state, suffix),
            true,
            true,
            false,
        );

        let error = with_recovery(anyhow::anyhow!("install failed"), recovery);

        let message = format!("{error:#}");
        assert!(message.contains("recovery failed"));
        assert!(message.contains(&paths.target.display().to_string()));
        assert!(message.contains(&paths.state.display().to_string()));
    }

    #[test]
    fn removes_orphaned_managed_state_without_requiring_a_target_backup() {
        let (_root, paths) = temp_paths("demo");
        fs::create_dir_all(paths.state.parent().unwrap()).unwrap();
        fs::write(
            &paths.state,
            serde_json::to_vec(&record("demo", b"old")).unwrap(),
        )
        .unwrap();

        remove_pair(&paths, false).unwrap();

        assert!(!paths.target.exists());
        assert!(!paths.state.exists());
    }

    #[test]
    fn protected_removal_preserves_changed_agent_and_state() {
        let (_root, paths) = temp_paths("demo");
        let original = b"---\nname: Demo\ndescription: Managed\n---\nPersona";
        let changed = b"---\nname: Demo\ndescription: Local\n---\nPersona";
        let state = serde_json::to_vec(&record("demo", original)).unwrap();
        fs::create_dir_all(paths.target.parent().unwrap()).unwrap();
        fs::create_dir_all(paths.state.parent().unwrap()).unwrap();
        fs::write(&paths.target, changed).unwrap();
        fs::write(&paths.state, &state).unwrap();

        let result = remove_at_paths(&paths, "demo").unwrap();

        assert_eq!(result.status, AgentLifecycleStatus::Conflict);
        assert_eq!(fs::read(&paths.target).unwrap(), changed);
        assert_eq!(fs::read(&paths.state).unwrap(), state);
    }

    #[test]
    fn up_to_date_result_does_not_write_the_managed_pair() {
        let (_root, paths) = temp_paths("demo");
        let document = b"---\nname: Demo\ndescription: Test\n---\nPersona";
        let state = serde_json::to_vec(&record("demo", document)).unwrap();
        fs::create_dir_all(paths.target.parent().unwrap()).unwrap();
        fs::create_dir_all(paths.state.parent().unwrap()).unwrap();
        fs::write(&paths.target, document).unwrap();
        fs::write(&paths.state, &state).unwrap();

        let mut downloaded = false;
        let downloaded_document = download_if_required(
            &AgentOwnership::ManagedExact(record("demo", document)),
            "noop",
            || {
                downloaded = true;
                anyhow::bail!("a no-op must not download an artifact")
            },
        )
        .unwrap();
        let result = up_to_date_result(
            "demo",
            &paths,
            record("demo", document),
            "current".to_string(),
        );

        assert!(downloaded_document.is_none());
        assert!(!downloaded);
        assert_eq!(result.status, AgentLifecycleStatus::UpToDate);
        assert_eq!(fs::read(&paths.target).unwrap(), document);
        assert_eq!(fs::read(&paths.state).unwrap(), state);
    }
}
