//! Install-plan execution, local metadata, locking, and removal for
//! `bb skills`.

use std::fs;
use std::io::Write as IoWrite;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use serde_json::{json, Value};

use super::display::stdin_is_tty;
use super::skills_api::{exit_codes, failure, MarketplaceClient};
use super::skills_archive::{extract_zip_safely, sha256_hex, verify_artifact};
use super::skills_config::{SkillsConfig, META_FILE_NAME};
use super::skills_models::{
    InstallOperation, InstallPlanResponse, InstalledSkillMetadata, InstalledSkillRequest,
    MeResponse, SkillDetail, Warning,
};
use super::skills_targets::{
    copy_dir_recursive, link_into_target, LinkOutcome, ResolvedTarget, Scope,
};

const LOCK_FILE_NAME: &str = "skills.lock";
/// Locks older than this are treated as leftovers from a crashed process.
const LOCK_STALE_SECS: u64 = 15 * 60;
pub const SETUP_FILE_NAME: &str = "SETUP.md";

/// Filesystem lock covering install/update/remove for one skills home, so
/// concurrent `bb skills` runs cannot race on `packages/` and target dirs.
#[derive(Debug)]
pub struct InstallLock {
    path: PathBuf,
}

impl InstallLock {
    pub fn acquire(config: &SkillsConfig) -> Result<Self> {
        let locks_dir = config.locks_dir();
        fs::create_dir_all(&locks_dir)
            .with_context(|| format!("create {}", locks_dir.display()))?;
        let path = locks_dir.join(LOCK_FILE_NAME);

        for _ in 0..2 {
            match fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&path)
            {
                Ok(mut file) => {
                    let _ = writeln!(file, "{}", std::process::id());
                    return Ok(Self { path });
                }
                Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => {
                    let stale = fs::metadata(&path)
                        .and_then(|metadata| metadata.modified())
                        .ok()
                        .and_then(|modified| modified.elapsed().ok())
                        .is_some_and(|age| age.as_secs() > LOCK_STALE_SECS);
                    if stale {
                        config
                            .style
                            .warn("removing stale install lock left by a previous run");
                        let _ = fs::remove_file(&path);
                        continue;
                    }
                    let holder = fs::read_to_string(&path).unwrap_or_default();
                    return Err(failure(
                        exit_codes::FS_CONFLICT,
                        "install_locked",
                        format!(
                            "another bb skills install appears to be running (pid {}); remove {} if this is stale",
                            holder.trim(),
                            path.display()
                        ),
                    ));
                }
                Err(err) => {
                    return Err(err).with_context(|| format!("create lock {}", path.display()))
                }
            }
        }
        Err(failure(
            exit_codes::FS_CONFLICT,
            "install_locked",
            format!("could not acquire install lock at {}", path.display()),
        ))
    }
}

impl Drop for InstallLock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

/// Canonical package directory for a slug in the given scope. Global
/// installs are real files in the shared agents skills directory (default
/// `~/.agents/skills`); other targets link to them. Project-scope installs
/// are materialized under `./.agents/skills` (committable to VCS),
/// mirroring sq-agents' project layout.
pub fn canonical_dir(config: &SkillsConfig, scope: Scope, slug: &str) -> PathBuf {
    match scope {
        Scope::Global => config.packages_dir().join(slug),
        Scope::Project => PathBuf::from("./.agents/skills").join(slug),
    }
}

pub fn canonical_root(config: &SkillsConfig, scope: Scope) -> PathBuf {
    match scope {
        Scope::Global => config.packages_dir(),
        Scope::Project => PathBuf::from("./.agents/skills"),
    }
}

pub fn read_installed(config: &SkillsConfig, scope: Scope) -> Result<Vec<InstalledSkillMetadata>> {
    let root = canonical_root(config, scope);
    if !root.exists() {
        return Ok(Vec::new());
    }
    let mut installed = Vec::new();
    for entry in fs::read_dir(&root).with_context(|| format!("read {}", root.display()))? {
        let entry = entry.with_context(|| format!("read entry in {}", root.display()))?;
        if !entry
            .file_type()
            .with_context(|| format!("stat {}", entry.path().display()))?
            .is_dir()
        {
            continue;
        }
        let meta_path = entry.path().join(META_FILE_NAME);
        if !meta_path.is_file() {
            continue;
        }
        let metadata = serde_json::from_slice::<InstalledSkillMetadata>(
            &fs::read(&meta_path).with_context(|| format!("read {}", meta_path.display()))?,
        )
        .with_context(|| format!("parse {}", meta_path.display()))?;
        installed.push(metadata);
    }
    installed.sort_by(|left, right| left.slug.cmp(&right.slug));
    Ok(installed)
}

pub fn installed_request_payload(
    installed: &[InstalledSkillMetadata],
    force_slugs: &[String],
) -> Vec<InstalledSkillRequest> {
    installed
        .iter()
        // Omitting a forced slug makes the server plan a fresh install even
        // when the installed content already matches the latest version.
        .filter(|meta| !force_slugs.contains(&meta.slug))
        .map(|meta| InstalledSkillRequest {
            slug: meta.slug.clone(),
            version_id: Some(meta.version_id.clone()),
            content_sha256: Some(meta.content_sha256.clone()),
            scope: Some(meta.scope.clone()),
            targets: meta.targets.clone(),
            installed_via: Some(meta.installed_via.clone()),
            local_source: meta.local_source,
        })
        .collect()
}

pub fn ensure_base_dirs(config: &SkillsConfig) -> Result<()> {
    fs::create_dir_all(&config.bb_home)
        .with_context(|| format!("create {}", config.bb_home.display()))?;
    fs::create_dir_all(&config.skills_home)
        .with_context(|| format!("create {}", config.skills_home.display()))?;
    fs::create_dir_all(config.packages_dir()).context("create packages directory")?;
    fs::create_dir_all(config.downloads_dir()).context("create downloads directory")?;
    fs::create_dir_all(config.cache_dir()).context("create cache directory")?;
    Ok(())
}

pub fn ensure_managed_or_absent(path: &Path) -> Result<()> {
    if !path.exists() {
        return Ok(());
    }
    if path.is_dir() && path.join(META_FILE_NAME).is_file() {
        return Ok(());
    }
    Err(failure(
        exit_codes::FS_CONFLICT,
        "unmanaged_package_dir",
        format!(
            "{} already exists and is not managed by bb skills; refusing to overwrite",
            path.display()
        ),
    ))
}

pub fn replace_managed_dir(staging: &Path, final_dir: &Path) -> Result<()> {
    ensure_managed_or_absent(final_dir)?;
    let backup = final_dir.with_file_name(format!(
        ".{}.previous-{}",
        final_dir
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("package"),
        unique_suffix()
    ));
    if final_dir.exists() {
        fs::rename(final_dir, &backup)
            .with_context(|| format!("backup {}", final_dir.display()))?;
    }
    match fs::rename(staging, final_dir) {
        Ok(()) => {
            if backup.exists() {
                fs::remove_dir_all(&backup)
                    .with_context(|| format!("remove {}", backup.display()))?;
            }
            Ok(())
        }
        Err(err) => {
            if backup.exists() {
                let _ = fs::rename(&backup, final_dir);
            }
            Err(err).with_context(|| format!("install {}", final_dir.display()))
        }
    }
}

#[derive(Debug)]
pub struct InstalledChange {
    pub slug: String,
    pub action: String,
    pub version_id: String,
    pub artifact_sha256: String,
    pub installed_via: String,
    pub targets: Vec<String>,
    pub links: Vec<LinkOutcome>,
    pub setup: Option<SetupSummary>,
}

#[derive(Debug, Default)]
pub struct PlanExecution {
    pub plan_id: String,
    pub installed: Vec<InstalledChange>,
    pub up_to_date: Vec<String>,
    pub removed: Vec<String>,
    pub skipped: Vec<(String, String)>,
    pub warnings: Vec<Warning>,
}

impl PlanExecution {
    pub fn to_json(&self) -> Value {
        json!({
            "plan_id": self.plan_id,
            "installed": self
                .installed
                .iter()
                .map(|change| {
                    json!({
                        "slug": change.slug,
                        "action": change.action,
                        "version_id": change.version_id,
                        "artifact_sha256": change.artifact_sha256,
                        "installed_via": change.installed_via,
                        "targets": change.targets,
                        "links": change.links,
                        "setup": change.setup.as_ref().map(|setup| json!({
                            "path": setup.path,
                            "title": setup.title,
                            "sections": setup.sections,
                        })),
                    })
                })
                .collect::<Vec<_>>(),
            "up_to_date": self.up_to_date,
            "removed": self.removed,
            "skipped": self
                .skipped
                .iter()
                .map(|(slug, reason)| json!({"slug": slug, "reason": reason}))
                .collect::<Vec<_>>(),
            "warnings": self.warnings,
        })
    }
}

pub struct ExecuteOptions<'a> {
    pub targets: &'a [ResolvedTarget],
    pub scope: Scope,
    pub allow_removals: bool,
    /// Slugs explicitly pinned with `--version` (recorded in metadata).
    pub pinned_slugs: &'a [String],
}

/// Executes the install/update/remove operations of a server plan. Unknown
/// future actions are skipped with a warning instead of aborting mid-plan
/// with some packages already mutated.
pub fn execute_plan(
    config: &SkillsConfig,
    client: &MarketplaceClient,
    plan: InstallPlanResponse,
    options: &ExecuteOptions,
) -> Result<PlanExecution> {
    let mut execution = PlanExecution {
        plan_id: plan.plan_id,
        warnings: plan.warnings,
        ..Default::default()
    };
    let tenant_id = fetch_tenant_id(config, client);

    for operation in &plan.operations {
        match operation.action.as_str() {
            "noop" => execution.up_to_date.push(operation.skill.slug.clone()),
            "install" | "update" => {
                let change = execute_install_operation(
                    config,
                    client,
                    operation,
                    options,
                    tenant_id.as_deref(),
                )?;
                execution.installed.push(change);
            }
            "remove" if options.allow_removals => {
                let report = remove_skill(
                    config,
                    &operation.skill.slug,
                    None,
                    options.scope,
                    false,
                    false,
                )?;
                execution.removed.push(operation.skill.slug.clone());
                let _ = report;
            }
            other => {
                config.style.warn(&format!(
                    "skipping unsupported plan action `{other}` for {}",
                    operation.skill.slug
                ));
                execution.skipped.push((
                    operation.skill.slug.clone(),
                    format!("unsupported action `{other}`"),
                ));
            }
        }
    }
    Ok(execution)
}

fn fetch_tenant_id(config: &SkillsConfig, client: &MarketplaceClient) -> Option<String> {
    if !client.has_auth() {
        return None;
    }
    match client.get_json::<MeResponse>("/v1/marketplace/me") {
        Ok(me) => Some(me.tenant_id),
        Err(err) => {
            config
                .style
                .verbose(&format!("could not resolve tenant from /me: {err:#}"));
            None
        }
    }
}

fn execute_install_operation(
    config: &SkillsConfig,
    client: &MarketplaceClient,
    operation: &InstallOperation,
    options: &ExecuteOptions,
    tenant_id: Option<&str>,
) -> Result<InstalledChange> {
    let slug = &operation.skill.slug;
    let artifact = operation
        .artifact
        .as_ref()
        .context("install operation did not include artifact metadata")?;

    let final_dir = canonical_dir(config, options.scope, slug);
    ensure_managed_or_absent(&final_dir).with_context(|| format!("prepare package {slug}"))?;

    // Source provenance comes from the catalog detail; failures downgrade to
    // missing provenance rather than blocking the install.
    let detail = client
        .get_json::<SkillDetail>(&format!("/v1/marketplace/skills/{slug}"))
        .ok();

    let download = client.download(&artifact.download_url)?;
    verify_artifact(&download, artifact)?;
    persist_download(config, slug, &operation.skill.version_id, &download.bytes);

    let metadata = InstalledSkillMetadata {
        schema_version: "bb-skills-install/v1".to_string(),
        tenant_id: tenant_id.unwrap_or("unknown").to_string(),
        server_url: config.server_url.clone(),
        slug: slug.clone(),
        version_id: operation.skill.version_id.clone(),
        content_sha256: operation.skill.content_sha256.clone(),
        artifact_sha256: artifact.sha256.clone(),
        artifact_size_bytes: artifact.size_bytes,
        installed_at: iso8601_utc(unix_seconds()?),
        installed_via: operation.installed_via.clone(),
        source_id: detail.as_ref().and_then(|detail| detail.source_id.clone()),
        source_revision: detail
            .as_ref()
            .and_then(|detail| detail.source_revision.clone()),
        scope: options.scope.as_str().to_string(),
        targets: options
            .targets
            .iter()
            .map(|target| target.name.clone())
            .collect(),
        local_source: false,
        pinned: options.pinned_slugs.contains(slug),
    };

    write_package(config, &final_dir, &download.bytes, &metadata)?;
    let links = link_targets(&final_dir, options.targets, slug)?;
    let setup = setup_summary(&final_dir);

    Ok(InstalledChange {
        slug: slug.clone(),
        action: operation.action.clone(),
        version_id: operation.skill.version_id.clone(),
        artifact_sha256: artifact.sha256.clone(),
        installed_via: operation.installed_via.clone(),
        targets: metadata.targets,
        links,
        setup,
    })
}

/// Keeps the verified artifact in `<skills_home>/downloads` for audit and
/// re-install without re-downloading.
fn persist_download(config: &SkillsConfig, slug: &str, version_id: &str, bytes: &[u8]) {
    let downloads = config.downloads_dir();
    if fs::create_dir_all(&downloads).is_err() {
        return;
    }
    let _ = fs::write(downloads.join(format!("{slug}-{version_id}.zip")), bytes);
}

fn write_package(
    config: &SkillsConfig,
    final_dir: &Path,
    zip_bytes: &[u8],
    metadata: &InstalledSkillMetadata,
) -> Result<()> {
    let parent = final_dir
        .parent()
        .context("package directory has no parent")?;
    fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;

    let staging = parent.join(format!(".{}.tmp-{}", metadata.slug, unique_suffix()));
    if staging.exists() {
        fs::remove_dir_all(&staging).context("remove stale staging directory")?;
    }
    fs::create_dir_all(&staging).context("create staging package directory")?;

    let result = (|| -> Result<()> {
        extract_zip_safely(zip_bytes, &staging).context("extract artifact")?;
        if !staging.join("SKILL.md").is_file() {
            anyhow::bail!(
                "artifact for {} did not contain SKILL.md at package root",
                metadata.slug
            );
        }
        fs::write(
            staging.join(META_FILE_NAME),
            serde_json::to_vec_pretty(metadata).context("serialize install metadata")?,
        )
        .context("write install metadata")?;
        replace_managed_dir(&staging, final_dir)
    })();
    if result.is_err() && staging.exists() {
        let _ = fs::remove_dir_all(&staging);
    }
    let _ = config;
    result
}

pub fn link_targets(
    package_dir: &Path,
    targets: &[ResolvedTarget],
    slug: &str,
) -> Result<Vec<LinkOutcome>> {
    let mut links = Vec::new();
    for target in targets {
        for base_dir in &target.base_dirs {
            links.push(link_into_target(
                package_dir,
                base_dir,
                slug,
                target.prefer_symlink,
            )?);
        }
    }
    Ok(links)
}

/// Confirms a mutating plan with the user. `--yes` skips the prompt; JSON
/// mode and non-interactive shells require it.
pub fn confirm_or_bail(config: &SkillsConfig, yes: bool, summary: &str) -> Result<()> {
    if yes {
        return Ok(());
    }
    if config.json {
        return Err(failure(
            exit_codes::CANCELED,
            "confirmation_required",
            "--json mode never prompts; pass --yes to confirm the changes",
        ));
    }
    if !stdin_is_tty() {
        return Err(failure(
            exit_codes::CANCELED,
            "confirmation_required",
            "Non-interactive shell — pass --yes to confirm the changes",
        ));
    }
    eprint!("{summary} Proceed? [y/N] ");
    let mut answer = String::new();
    std::io::stdin()
        .read_line(&mut answer)
        .context("read confirmation")?;
    let answer = answer.trim().to_ascii_lowercase();
    if answer == "y" || answer == "yes" {
        Ok(())
    } else {
        Err(failure(
            exit_codes::CANCELED,
            "canceled",
            "canceled by user",
        ))
    }
}

#[derive(Debug, Clone)]
pub struct SetupSummary {
    pub path: PathBuf,
    pub title: String,
    pub sections: Vec<String>,
}

/// Extracts a short summary from a package's SETUP.md so installs can prompt
/// "this skill needs one-time setup" like sq-agents does.
pub fn setup_summary(package_dir: &Path) -> Option<SetupSummary> {
    let path = package_dir.join(SETUP_FILE_NAME);
    let contents = fs::read_to_string(&path).ok()?;
    let mut title = "Setup Required".to_string();
    let mut sections = Vec::new();
    for line in contents.lines() {
        let line = line.trim();
        if let Some(heading) = line.strip_prefix("# ") {
            if title == "Setup Required" {
                title = heading.trim().to_string();
            }
        } else if let Some(section) = line.strip_prefix("## ") {
            if sections.len() < 5 {
                sections.push(section.trim().to_string());
            }
        }
    }
    Some(SetupSummary {
        path,
        title,
        sections,
    })
}

/// Installs a skill from a local directory (the skill-author dev loop).
/// Never goes through the marketplace; metadata records `local_source: true`
/// so remote updates refuse to overwrite it without `--force`.
pub fn install_local_path(
    config: &SkillsConfig,
    source: &Path,
    slug_override: Option<&str>,
    targets: &[ResolvedTarget],
    scope: Scope,
    force: bool,
) -> Result<PlanExecution> {
    if !source.is_dir() {
        anyhow::bail!("local install path {} is not a directory", source.display());
    }
    if !source.join("SKILL.md").is_file() {
        anyhow::bail!(
            "local install path {} does not contain SKILL.md",
            source.display()
        );
    }
    let slug = match slug_override {
        Some(name) => name.to_string(),
        None => source
            .file_name()
            .and_then(|name| name.to_str())
            .context("could not derive a skill name from the path; pass --name")?
            .to_string(),
    };
    validate_slug(&slug)?;

    let final_dir = canonical_dir(config, scope, &slug);
    if let Ok(existing) = read_metadata(&final_dir) {
        if existing.local_source && !force {
            return Err(failure(
                exit_codes::FS_CONFLICT,
                "local_source_installed",
                format!(
                    "skill `{slug}` is already installed from a local source; pass --force to overwrite"
                ),
            ));
        }
    }
    ensure_managed_or_absent(&final_dir)?;

    let parent = final_dir
        .parent()
        .context("package directory has no parent")?;
    fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
    let staging = parent.join(format!(".{slug}.tmp-{}", unique_suffix()));
    if staging.exists() {
        fs::remove_dir_all(&staging).context("remove stale staging directory")?;
    }
    copy_dir_recursive(source, &staging)?;
    // Drop any metadata copied from a previously installed source directory.
    let _ = fs::remove_file(staging.join(META_FILE_NAME));

    let content_sha = hash_directory(&staging)?;
    let metadata = InstalledSkillMetadata {
        schema_version: "bb-skills-install/v1".to_string(),
        tenant_id: "local".to_string(),
        server_url: config.server_url.clone(),
        slug: slug.clone(),
        version_id: format!("local-{}", &content_sha[..12]),
        content_sha256: content_sha,
        artifact_sha256: String::new(),
        artifact_size_bytes: 0,
        installed_at: iso8601_utc(unix_seconds()?),
        installed_via: "local-path".to_string(),
        source_id: None,
        source_revision: Some(source.display().to_string()),
        scope: scope.as_str().to_string(),
        targets: targets.iter().map(|target| target.name.clone()).collect(),
        local_source: true,
        pinned: false,
    };
    fs::write(
        staging.join(META_FILE_NAME),
        serde_json::to_vec_pretty(&metadata).context("serialize install metadata")?,
    )
    .context("write install metadata")?;
    replace_managed_dir(&staging, &final_dir)?;

    let links = link_targets(&final_dir, targets, &slug)?;
    let setup = setup_summary(&final_dir);

    Ok(PlanExecution {
        plan_id: "local".to_string(),
        installed: vec![InstalledChange {
            slug,
            action: "install".to_string(),
            version_id: metadata.version_id,
            artifact_sha256: String::new(),
            installed_via: "local-path".to_string(),
            targets: metadata.targets,
            links,
            setup,
        }],
        ..Default::default()
    })
}

fn validate_slug(slug: &str) -> Result<()> {
    let valid = !slug.is_empty()
        && slug
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_');
    if valid {
        Ok(())
    } else {
        anyhow::bail!("invalid skill name `{slug}`; use lowercase letters, digits, `-`, and `_`")
    }
}

/// Deterministic content hash over a directory's files (path + bytes).
fn hash_directory(dir: &Path) -> Result<String> {
    let mut entries = Vec::new();
    collect_files(dir, dir, &mut entries)?;
    entries.sort();
    let mut rollup = String::new();
    for relative in entries {
        let bytes = fs::read(dir.join(&relative))
            .with_context(|| format!("read {}", dir.join(&relative).display()))?;
        rollup.push_str(&relative);
        rollup.push(':');
        rollup.push_str(&sha256_hex(&bytes));
        rollup.push('\n');
    }
    Ok(sha256_hex(rollup.as_bytes()))
}

fn collect_files(root: &Path, dir: &Path, into: &mut Vec<String>) -> Result<()> {
    for entry in fs::read_dir(dir).with_context(|| format!("read {}", dir.display()))? {
        let entry = entry.with_context(|| format!("read entry in {}", dir.display()))?;
        let path = entry.path();
        if path.is_dir() {
            collect_files(root, &path, into)?;
        } else if path.is_file() {
            if let Ok(relative) = path.strip_prefix(root) {
                into.push(relative.to_string_lossy().to_string());
            }
        }
    }
    Ok(())
}

pub fn read_metadata(package_dir: &Path) -> Result<InstalledSkillMetadata> {
    let meta_path = package_dir.join(META_FILE_NAME);
    let bytes = fs::read(&meta_path).with_context(|| format!("read {}", meta_path.display()))?;
    serde_json::from_slice(&bytes).with_context(|| format!("parse {}", meta_path.display()))
}

#[derive(Debug, Default)]
pub struct RemovalReport {
    pub slug: String,
    pub removed_links: Vec<PathBuf>,
    pub skipped_paths: Vec<(PathBuf, String)>,
    pub removed_package: bool,
}

impl RemovalReport {
    pub fn to_json(&self) -> Value {
        json!({
            "slug": self.slug,
            "removed_links": self.removed_links,
            "skipped": self
                .skipped_paths
                .iter()
                .map(|(path, reason)| json!({"path": path, "reason": reason}))
                .collect::<Vec<_>>(),
            "removed_package": self.removed_package,
        })
    }
}

/// Removes a skill: target links first, then the canonical package when no
/// target subset was requested. Unmanaged directories are skipped unless
/// `--include-unmanaged --force`.
pub fn remove_skill(
    config: &SkillsConfig,
    slug: &str,
    only_targets: Option<&[ResolvedTarget]>,
    scope: Scope,
    include_unmanaged: bool,
    force: bool,
) -> Result<RemovalReport> {
    use super::skills_targets::{inspect_link, remove_any, LinkState, TargetRegistry};

    let final_dir = canonical_dir(config, scope, slug);
    let metadata = read_metadata(&final_dir).ok();
    if metadata.is_none() && !(include_unmanaged && force) {
        return Err(failure(
            exit_codes::GENERAL,
            "not_installed",
            format!(
                "skill `{slug}` is not installed (no managed package at {}); pass --include-unmanaged --force to remove unmanaged files",
                final_dir.display()
            ),
        ));
    }

    let registry = TargetRegistry::load_offline(config);
    let resolved_storage;
    let targets: &[ResolvedTarget] = match only_targets {
        Some(targets) => targets,
        None => {
            // Default to the targets recorded at install time; fall back to
            // every known target when metadata is missing.
            let names = metadata
                .as_ref()
                .map(|meta| meta.targets.clone())
                .unwrap_or_else(|| registry.targets.keys().cloned().collect());
            resolved_storage = registry.resolve(&names, scope).unwrap_or_default();
            &resolved_storage
        }
    };

    let mut report = RemovalReport {
        slug: slug.to_string(),
        ..Default::default()
    };

    let canonical_root = final_dir.parent();
    for target in targets {
        for base_dir in &target.base_dirs {
            let link_path = base_dir.join(slug);
            // The agents target's directory is the canonical packages root
            // itself (skills live there; other targets link to it), so its
            // entry is never a link to remove — package removal below
            // handles it.
            if canonical_root.is_some_and(|root| is_same_location(base_dir, root)) {
                if only_targets.is_some() {
                    report.skipped_paths.push((
                        link_path,
                        "canonical package directory; run remove without --target to delete the skill"
                            .to_string(),
                    ));
                }
                continue;
            }
            match inspect_link(&link_path, &final_dir) {
                LinkState::Missing => {}
                LinkState::Ok | LinkState::Broken => {
                    remove_any(&link_path)?;
                    report.removed_links.push(link_path);
                }
                LinkState::Unmanaged => {
                    if include_unmanaged && force {
                        remove_any(&link_path)?;
                        report.removed_links.push(link_path);
                    } else {
                        report.skipped_paths.push((
                            link_path,
                            "unmanaged; pass --include-unmanaged --force".to_string(),
                        ));
                    }
                }
            }
        }
        // Clean up legacy Phase 1 copies under <skills_home>/targets/.
        let legacy = config.legacy_target_dir(&target.name).join(slug);
        if legacy.exists() {
            if legacy.join(META_FILE_NAME).is_file() || (include_unmanaged && force) {
                remove_any(&legacy)?;
                report.removed_links.push(legacy);
            } else {
                report
                    .skipped_paths
                    .push((legacy, "unmanaged legacy copy".to_string()));
            }
        }
    }

    if only_targets.is_none() {
        if final_dir.exists() && (metadata.is_some() || (include_unmanaged && force)) {
            remove_any(&final_dir)?;
            report.removed_package = true;
        }
    } else if let Some(mut meta) = metadata {
        // Partial removal: drop the removed targets from metadata, keeping
        // any target whose directory is the canonical packages root (nothing
        // was removed for it).
        let removed_names: Vec<&str> = targets
            .iter()
            .filter(|target| {
                !target.base_dirs.iter().any(|base_dir| {
                    canonical_root.is_some_and(|root| is_same_location(base_dir, root))
                })
            })
            .map(|target| target.name.as_str())
            .collect();
        meta.targets
            .retain(|name| !removed_names.contains(&name.as_str()));
        fs::write(
            final_dir.join(META_FILE_NAME),
            serde_json::to_vec_pretty(&meta).context("serialize install metadata")?,
        )
        .context("update install metadata")?;
    }

    Ok(report)
}

/// True when both paths refer to the same location (canonicalized when they
/// exist). Detects the agents target whose directory IS the canonical
/// packages root.
fn is_same_location(left: &Path, right: &Path) -> bool {
    match (fs::canonicalize(left), fs::canonicalize(right)) {
        (Ok(left), Ok(right)) => left == right,
        _ => left == right,
    }
}

pub fn unix_seconds() -> Result<u64> {
    Ok(SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .context("system clock is before UNIX epoch")?
        .as_secs())
}

pub fn unique_suffix() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    format!("{}-{nanos}", std::process::id())
}

/// Formats a UNIX timestamp as ISO-8601 UTC (`2026-06-10T12:34:56Z`) without
/// pulling in a date dependency. Uses Howard Hinnant's civil-date algorithm.
pub fn iso8601_utc(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let secs_of_day = secs % 86_400;
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { year + 1 } else { year };
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        secs_of_day / 3600,
        (secs_of_day % 3600) / 60,
        secs_of_day % 60
    )
}

/// Detects orphaned staging/backup directories left behind by crashes.
pub fn find_orphaned_work_dirs(root: &Path) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(root) else {
        return Vec::new();
    };
    entries
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| {
                    name.starts_with('.') && (name.contains(".tmp-") || name.contains(".previous-"))
                })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso8601_formats_known_timestamps() {
        assert_eq!(iso8601_utc(0), "1970-01-01T00:00:00Z");
        // 2026-06-10T00:00:00Z
        assert_eq!(iso8601_utc(1_781_049_600), "2026-06-10T00:00:00Z");
    }

    #[test]
    fn setup_summary_extracts_title_and_sections() {
        let temp = std::env::temp_dir().join(format!("bb-setup-{}", unique_suffix()));
        fs::create_dir_all(&temp).expect("create temp");
        fs::write(
            temp.join(SETUP_FILE_NAME),
            "# Slack Setup\n\nIntro\n\n## Create a token\n\n## Configure env\n",
        )
        .expect("write SETUP.md");

        let summary = setup_summary(&temp).expect("summary");
        assert_eq!(summary.title, "Slack Setup");
        assert_eq!(summary.sections, vec!["Create a token", "Configure env"]);
        fs::remove_dir_all(temp).expect("cleanup");
    }

    #[test]
    fn find_orphaned_work_dirs_matches_staging_and_backup() {
        let temp = std::env::temp_dir().join(format!("bb-orphans-{}", unique_suffix()));
        fs::create_dir_all(temp.join(".slack.tmp-123")).expect("staging");
        fs::create_dir_all(temp.join(".slack.previous-123")).expect("backup");
        fs::create_dir_all(temp.join("slack")).expect("real package");

        let orphans = find_orphaned_work_dirs(&temp);
        assert_eq!(orphans.len(), 2);
        fs::remove_dir_all(temp).expect("cleanup");
    }
}
