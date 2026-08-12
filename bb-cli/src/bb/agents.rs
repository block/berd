//! Public `bb agents` command surface over the managed Agent Markdown lifecycle.

use std::fs;

use anyhow::{Context, Result};
use clap::{Arg, ArgMatches, Command};
use serde_json::{json, Value};

use super::agents_install::{
    agent_paths, classify, install_or_update, remove, update, validate_slug, AgentLifecycleResult,
    AgentLifecycleStatus, AgentOwnership, InstalledAgentMetadata,
};
use super::agents_models::{AgentDetail, AgentSummary, AgentVersion};
use super::description::describe_command_tree;
use super::display::print_json;
use super::runner::{self, ensure_org_configured};
use super::skills::EXIT_CODES_HELP;
use super::skills_api::{exit_codes, CliFailure, MarketplaceClient};
use super::skills_config::SkillsConfig;

pub fn agents_command() -> Command {
    Command::new("agents")
        .about("Manage BuilderBot marketplace agents")
        .long_about(
            "Discover marketplace agents and manage the Agent Markdown documents that BB owns. \
             Installing always requires an explicit agent slug.",
        )
        .after_help(EXIT_CODES_HELP)
        .subcommand_required(true)
        .arg_required_else_help(true)
        .disable_help_subcommand(true)
        .subcommand(Command::new("list").about("List marketplace agents"))
        .subcommand(
            Command::new("search")
                .about("Search marketplace agents")
                .arg(
                    Arg::new("query")
                        .required(true)
                        .help("Free-text search query"),
                ),
        )
        .subcommand(agent_version_command("show", "Show one marketplace agent"))
        .subcommand(agent_version_command(
            "install",
            "Install one marketplace agent",
        ))
        .subcommand(agent_version_command(
            "update",
            "Update one managed marketplace agent",
        ))
        .subcommand(Command::new("installed").about("List BB-managed agents"))
        .subcommand(
            Command::new("which")
                .about("Show one agent's managed location")
                .arg(Arg::new("slug").required(true)),
        )
        .subcommand(
            Command::new("remove")
                .about("Remove one BB-managed agent")
                .arg(Arg::new("slug").required(true)),
        )
}

fn agent_version_command(name: &'static str, about: &'static str) -> Command {
    Command::new(name)
        .about(about)
        .arg(Arg::new("slug").required(true))
        .arg(
            Arg::new("version")
                .long("version")
                .value_name("VERSION_ID")
                .help("Use a specific marketplace version"),
        )
}

pub fn run(matches: &ArgMatches) -> Result<()> {
    runner::run(matches, dispatch)
}

fn dispatch(config: &SkillsConfig, matches: &ArgMatches) -> Result<()> {
    let command = matches.subcommand_name().unwrap_or("unknown");
    config.style.verbose(&format!("agents command={command}"));
    match matches.subcommand() {
        Some(("list", _)) => list(config, None),
        Some(("search", submatches)) => {
            let query = required_slug(submatches, "query")?;
            list(config, Some(query))
        }
        Some(("show", submatches)) => show(config, submatches),
        Some(("install", submatches)) => install(config, submatches, false),
        Some(("update", submatches)) => install(config, submatches, true),
        Some(("installed", _)) => installed(config),
        Some(("which", submatches)) => which(config, submatches),
        Some(("remove", submatches)) => remove_agent(config, submatches),
        _ => anyhow::bail!("expected an agents subcommand"),
    }
}

fn list(config: &SkillsConfig, query: Option<&str>) -> Result<()> {
    ensure_org_configured(config)?;
    let items = MarketplaceClient::new(config)?.agents().list_all(query)?;
    if config.json {
        return print_json(&json!({ "items": items.iter().map(summary_json).collect::<Vec<_>>() }));
    }
    if items.is_empty() {
        println!("No marketplace agents found.");
        return Ok(());
    }
    for item in items {
        println!("{} {}", config.style.slug(&item.slug), item.name);
        println!("  {} {}", config.style.label("status:"), item.status);
        println!(
            "  {} {}",
            config.style.label("version:"),
            item.latest_version_id
        );
        if !item.description.is_empty() {
            println!(
                "  {} {}",
                config.style.label("description:"),
                item.description
            );
        }
        println!();
    }
    Ok(())
}

fn show(config: &SkillsConfig, matches: &ArgMatches) -> Result<()> {
    ensure_org_configured(config)?;
    let slug = required_slug(matches, "slug")?;
    config.style.verbose(&format!("agents show slug={slug}"));
    let client = MarketplaceClient::new(config)?;
    let marketplace = client.agents();
    if let Some(version) = matches.get_one::<String>("version") {
        let version = marketplace.version(slug, version)?;
        if config.json {
            return print_json(&version_json(&version));
        }
        display_version(config, &version);
        return Ok(());
    }
    let detail = marketplace.show(slug)?;
    if config.json {
        return print_json(&detail_json(&detail));
    }
    display_detail(config, &detail);
    Ok(())
}

fn install(config: &SkillsConfig, matches: &ArgMatches, update_only: bool) -> Result<()> {
    ensure_org_configured(config)?;
    let slug = required_slug(matches, "slug")?;
    let version = matches.get_one::<String>("version").cloned();
    let action = if update_only { "update" } else { "install" };
    config
        .style
        .verbose(&format!("agents {action} slug={slug}"));
    let client = MarketplaceClient::new(config)?;
    let result = if update_only {
        update(config, &client, slug, version)?
    } else {
        install_or_update(config, &client, slug, version)?
    };
    report_lifecycle(config, result)
}

fn remove_agent(config: &SkillsConfig, matches: &ArgMatches) -> Result<()> {
    ensure_org_configured(config)?;
    let slug = required_slug(matches, "slug")?;
    config.style.verbose(&format!("agents remove slug={slug}"));
    report_lifecycle(config, remove(config, slug)?)
}

fn installed(config: &SkillsConfig) -> Result<()> {
    ensure_org_configured(config)?;
    let state_root = config.bb_home.join("agents").join("installed");
    let entries = match fs::read_dir(&state_root) {
        Ok(entries) => entries.collect::<std::io::Result<Vec<_>>>()?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(error) => return Err(error).with_context(|| format!("read {}", state_root.display())),
    };
    let mut items = entries
        .into_iter()
        .filter(|entry| {
            entry
                .path()
                .extension()
                .is_some_and(|extension| extension == "json")
        })
        .map(|entry| installed_item(config, entry.path()))
        .collect::<Result<Vec<_>>>()?;
    items.sort_by(|left, right| left["slug"].as_str().cmp(&right["slug"].as_str()));
    if config.json {
        return print_json(&json!({ "items": items }));
    }
    if items.is_empty() {
        println!("No BB-managed agents installed.");
        return Ok(());
    }
    for item in items {
        display_local_item(config, &item);
    }
    Ok(())
}

fn installed_item(config: &SkillsConfig, state_path: std::path::PathBuf) -> Result<Value> {
    let slug = state_path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or_default();
    if validate_slug(slug).is_err() {
        return Ok(local_item(
            "conflict",
            slug,
            None,
            &state_path,
            None,
            Some("invalid managed-state filename"),
        ));
    }
    let paths = agent_paths(config, slug)?;
    let ownership = classify(&paths, slug)?;
    config.style.verbose(&format!(
        "agents installed slug={slug} ownership={}",
        ownership_status(&ownership)
    ));
    Ok(ownership_item(slug, &paths.target, ownership))
}

fn which(config: &SkillsConfig, matches: &ArgMatches) -> Result<()> {
    ensure_org_configured(config)?;
    let slug = required_slug(matches, "slug")?;
    let paths = agent_paths(config, slug)?;
    let ownership = classify(&paths, slug)?;
    config.style.verbose(&format!(
        "agents which slug={slug} ownership={}",
        ownership_status(&ownership)
    ));
    match ownership {
        AgentOwnership::Absent => Err(super::skills_api::failure(
            exit_codes::GENERAL,
            "not_installed",
            format!("agent `{slug}` is not installed; run `bb agents install {slug}`"),
        )),
        AgentOwnership::ProtectedConflict { reason } => {
            Err(agent_conflict(slug, &paths.target, reason))
        }
        ownership => {
            let item = ownership_item(slug, &paths.target, ownership);
            if config.json {
                print_json(&item)
            } else {
                display_local_item(config, &item);
                Ok(())
            }
        }
    }
}

fn report_lifecycle(config: &SkillsConfig, result: AgentLifecycleResult) -> Result<()> {
    if result.status == AgentLifecycleStatus::Conflict {
        return Err(agent_conflict(
            &result.slug,
            &result.path,
            result
                .reason
                .unwrap_or_else(|| "agent ownership conflict".to_string()),
        ));
    }
    let value = lifecycle_json(&result);
    if config.json {
        return print_json(&value);
    }
    let action = value["status"]
        .as_str()
        .unwrap_or("completed")
        .replace('_', " ");
    config
        .style
        .success(&format!("Agent `{}` {action}", result.slug));
    println!(
        "  {} {}",
        config.style.label("path:"),
        result.path.display()
    );
    if let Some(metadata) = result.metadata {
        println!(
            "  {} {}",
            config.style.label("version:"),
            metadata.version_id
        );
        println!(
            "  {} {}",
            config.style.label("source:"),
            metadata.source_revision
        );
        println!(
            "  {} {}",
            config.style.label("installed via:"),
            metadata.installed_via
        );
    }
    if let Some(reason) = result.reason {
        println!("  {} {reason}", config.style.label("reason:"));
    }
    Ok(())
}

fn required_slug<'a>(matches: &'a ArgMatches, name: &str) -> Result<&'a str> {
    matches
        .get_one::<String>(name)
        .map(String::as_str)
        .with_context(|| format!("expected {name}"))
}

fn agent_conflict(slug: &str, path: &std::path::Path, reason: String) -> anyhow::Error {
    anyhow::Error::new(CliFailure {
        exit_code: exit_codes::FS_CONFLICT,
        code: "agent_conflict".to_string(),
        message: format!("agent `{slug}` conflicts with local content: {reason}"),
        details: Some(json!({
            "status": "conflict",
            "slug": slug,
            "path": path,
            "reason": reason,
        })),
    })
}

fn lifecycle_json(result: &AgentLifecycleResult) -> Value {
    local_item(
        lifecycle_status(&result.status),
        &result.slug,
        result.metadata.as_ref(),
        &result.path,
        result
            .metadata
            .as_ref()
            .map(|metadata| metadata.content_sha256.as_str()),
        result.reason.as_deref(),
    )
}

fn ownership_item(slug: &str, path: &std::path::Path, ownership: AgentOwnership) -> Value {
    match ownership {
        AgentOwnership::ManagedExact(metadata) => local_item(
            "installed",
            slug,
            Some(&metadata),
            path,
            Some(&metadata.content_sha256),
            None,
        ),
        AgentOwnership::ManagedMissingFile(metadata) => local_item(
            "missing",
            slug,
            Some(&metadata),
            path,
            Some(&metadata.content_sha256),
            None,
        ),
        AgentOwnership::ProtectedConflict { reason } => {
            local_item("conflict", slug, None, path, None, Some(&reason))
        }
        AgentOwnership::Absent => local_item("absent", slug, None, path, None, None),
    }
}

fn local_item(
    status: &str,
    slug: &str,
    metadata: Option<&InstalledAgentMetadata>,
    path: &std::path::Path,
    content_sha256: Option<&str>,
    reason: Option<&str>,
) -> Value {
    json!({
        "status": status,
        "slug": slug,
        "path": path,
        "version_id": metadata.map(|metadata| &metadata.version_id),
        "content_sha256": content_sha256,
        "source": metadata.map(source_json),
        "installed_via": metadata.map(|metadata| &metadata.installed_via),
        "reason": reason,
    })
}

fn source_json(metadata: &InstalledAgentMetadata) -> Value {
    json!({
        "id": metadata.source_id,
        "snapshot_id": metadata.source_snapshot_id,
        "revision": metadata.source_revision,
        "path": metadata.source_path,
    })
}

fn summary_json(item: &AgentSummary) -> Value {
    json!({
        "slug": item.slug,
        "name": item.name,
        "description": item.description,
        "status": item.status,
        "enabled": item.enabled,
        "latest_version_id": item.latest_version_id,
        "latest_content_sha256": item.latest_content_sha256,
        "source": { "id": item.source_id, "revision": item.source_revision, "path": item.source_path },
        "tags": item.tags,
    })
}

fn detail_json(item: &AgentDetail) -> Value {
    let mut value = summary_json(&AgentSummary {
        slug: item.slug.clone(),
        name: item.name.clone(),
        description: item.description.clone(),
        status: item.status.clone(),
        enabled: item.enabled,
        latest_version_id: item.latest_version_id.clone(),
        latest_content_sha256: item.latest_content_sha256.clone(),
        source_id: item.source_id.clone(),
        source_revision: item.source_revision.clone(),
        source_path: item.source_path.clone(),
        tags: item.tags.clone(),
    });
    value["latest_version"] = version_detail_json(&item.latest_version);
    value["versions"] = json!(item.versions.iter().map(|version| json!({ "id": version.id, "status": version.status, "content_sha256": version.content_sha256, "created_at": version.created_at })).collect::<Vec<_>>());
    value
}

fn version_detail_json(item: &super::agents_models::AgentVersionDetail) -> Value {
    json!({
        "id": item.id,
        "slug": item.slug,
        "name": item.name,
        "status": item.status,
        "content_sha256": item.content_sha256,
        "created_at": item.created_at,
        "artifact": {
            "id": item.artifact.id,
            "sha256": item.artifact.sha256,
            "size_bytes": item.artifact.size_bytes,
            "media_type": item.artifact.media_type,
        },
        "source": {
            "id": item.source.source_id,
            "snapshot_id": item.source.snapshot_id,
            "revision": item.source.revision,
            "path": item.source.path,
        },
    })
}

fn version_json(item: &AgentVersion) -> Value {
    json!({
        "id": item.id,
        "slug": item.slug,
        "name": item.name,
        "status": item.status,
        "content_sha256": item.content_sha256,
        "created_at": item.created_at,
        "artifact": {
            "id": item.artifact.id,
            "sha256": item.artifact.sha256,
            "size_bytes": item.artifact.size_bytes,
            "media_type": item.artifact.media_type,
        },
        "source": {
            "id": item.source.source_id,
            "snapshot_id": item.source.snapshot_id,
            "revision": item.source.revision,
            "path": item.source.path,
        },
    })
}

fn display_detail(config: &SkillsConfig, item: &AgentDetail) {
    println!("{} {}", config.style.slug(&item.slug), item.name);
    println!("  {} {}", config.style.label("status:"), item.status);
    println!(
        "  {} {}",
        config.style.label("version:"),
        item.latest_version_id
    );
    println!(
        "  {} {}",
        config.style.label("content sha:"),
        item.latest_content_sha256
    );
    println!(
        "  {} {}",
        config.style.label("source:"),
        item.source_revision
    );
    if !item.description.is_empty() {
        println!(
            "  {} {}",
            config.style.label("description:"),
            item.description
        );
    }
}

fn display_version(config: &SkillsConfig, item: &AgentVersion) {
    println!("{} @ {}", config.style.slug(&item.slug), item.id);
    println!("  {} {}", config.style.label("status:"), item.status);
    println!(
        "  {} {}",
        config.style.label("content sha:"),
        item.content_sha256
    );
    println!(
        "  {} {}",
        config.style.label("source:"),
        item.source.revision
    );
}

fn display_local_item(config: &SkillsConfig, item: &Value) {
    println!(
        "{} {}",
        config
            .style
            .slug(item["slug"].as_str().unwrap_or("invalid")),
        item["status"].as_str().unwrap_or("unknown")
    );
    println!(
        "  {} {}",
        config.style.label("path:"),
        item["path"].as_str().unwrap_or_default()
    );
    if let Some(version) = item["version_id"].as_str() {
        println!("  {} {version}", config.style.label("version:"));
    }
    if let Some(reason) = item["reason"].as_str() {
        println!("  {} {reason}", config.style.label("reason:"));
    }
    println!();
}

fn lifecycle_status(status: &AgentLifecycleStatus) -> &'static str {
    match status {
        AgentLifecycleStatus::Installed => "installed",
        AgentLifecycleStatus::Updated => "updated",
        AgentLifecycleStatus::UpToDate => "up_to_date",
        AgentLifecycleStatus::Removed => "removed",
        AgentLifecycleStatus::AlreadyAbsent => "already_absent",
        AgentLifecycleStatus::Conflict => "conflict",
    }
}

fn ownership_status(ownership: &AgentOwnership) -> &'static str {
    match ownership {
        AgentOwnership::Absent => "absent",
        AgentOwnership::ManagedExact(_) => "installed",
        AgentOwnership::ManagedMissingFile(_) => "missing",
        AgentOwnership::ProtectedConflict { .. } => "conflict",
    }
}

pub fn describe_commands() -> Value {
    describe_command_tree(&agents_command())
}

#[cfg(test)]
mod tests {
    use clap::error::ErrorKind;

    use super::*;

    #[test]
    fn command_tree_exposes_only_agent_lifecycle_commands() {
        let command = agents_command();
        let commands = command
            .get_subcommands()
            .map(Command::get_name)
            .collect::<Vec<_>>();

        assert_eq!(
            commands,
            [
                "list",
                "search",
                "show",
                "install",
                "update",
                "installed",
                "which",
                "remove",
            ]
        );
    }

    #[test]
    fn install_requires_an_explicit_slug() {
        let error = agents_command()
            .try_get_matches_from(["agents", "install"])
            .expect_err("install without a slug must fail clap parsing");

        assert_eq!(error.kind(), ErrorKind::MissingRequiredArgument);
    }
}
