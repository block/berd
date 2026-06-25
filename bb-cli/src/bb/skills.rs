//! `bb skills` command tree and dispatch.
//!
//! Catalog and install-plan resolution stay on the server; this module wires
//! the marketplace client, local package state, and target linking together.

use std::collections::BTreeMap;
use std::io::Write as IoWrite;

use anyhow::{Context, Result};
use clap::{Arg, ArgAction, ArgMatches, Command};
use serde::Serialize;
use serde_json::{json, Value};

use super::auth_login::{
    logout_stored_session, run_browser_login, verify_stored_session, BrowserLoginCredentialSource,
};
use super::auth_storage::default_session_storage;
use super::display::{stdin_is_tty, Style};
use super::org_routing::{normalize_org, resolve_org_kgoose_base_url};
use super::skills_api::{exit_codes, failure, failure_info, MarketplaceClient, SilentJsonExit};
use super::skills_archive::validate_preview_path;
use super::skills_config::SkillsConfig;
use super::skills_doctor::{run_doctor, CheckStatus};
use super::skills_install::{
    canonical_dir, confirm_or_bail, ensure_base_dirs, execute_plan, install_local_path,
    installed_request_payload, read_installed, read_metadata, remove_skill, ExecuteOptions,
    InstallLock, PlanExecution, SetupSummary,
};
use super::skills_models::{
    BundleSummary, InstallPlanRequest, InstallPlanResponse, InstalledSkillMetadata,
    RequestedTarget, SkillDetail, SkillSummary, SkillVersionDetail, PREFERENCE_KEYS,
};
use super::skills_targets::{inspect_link, LinkState, ResolvedTarget, Scope, TargetRegistry};

const EXIT_CODES_HELP: &str = "EXIT CODES:\n  \
0  success\n  \
1  general failure\n  \
2  invalid CLI usage\n  \
3  authentication required or expired\n  \
4  authorization denied\n  \
5  network or server unavailable\n  \
6  install plan blocked by policy or validation\n  \
7  local filesystem conflict\n  \
8  checksum or artifact verification failed\n  \
9  user canceled or confirmation required";

pub fn skills_command() -> Command {
    Command::new("skills")
        .about("Manage BuilderBot skills")
        .long_about(
            "Manage BuilderBot skills: discover them in the marketplace, install them \
             into your agents' skill directories, keep them updated, and diagnose the \
             local installation.\n\n\
             Skills are installed canonically under `~/.agents/skills/<slug>` and \
             linked (symlink with copy fallback) into each other target agent's real \
             skills directory, e.g. `~/.claude/skills`. `~/.bb` holds only bb state \
             (downloads, cache, locks) and configuration, never the skills themselves. \
             The server's target registry defines which targets exist.",
        )
        .after_help(EXIT_CODES_HELP)
        .subcommand_required(true)
        .arg_required_else_help(true)
        .disable_help_subcommand(true)
        .subcommand(
            Command::new("search")
                .about("Search marketplace skills")
                .long_about(
                    "Search marketplace skills by free-text query. Matches slug, name, \
                     description, and tags server-side. Use --json for machine-readable \
                     output.",
                )
                .arg(Arg::new("query").required(true).help("Free-text search query")),
        )
        .subcommand(
            Command::new("list")
                .about("List marketplace skills")
                .long_about(
                    "List marketplace skills. Follows pagination so large catalogs are \
                     fully listed. Installed skills are marked and sorted to the top. \
                     Filter with --installed, --source, or --status.",
                )
                .arg(
                    Arg::new("installed")
                        .long("installed")
                        .help("Only show skills that are installed locally")
                        .action(ArgAction::SetTrue),
                )
                .arg(
                    Arg::new("source")
                        .long("source")
                        .value_name("SOURCE_ID")
                        .help("Only show skills from this source"),
                )
                .arg(
                    Arg::new("status")
                        .long("status")
                        .value_name("STATUS")
                        .help("Only show skills with this status (e.g. stable)"),
                ),
        )
        .subcommand(
            Command::new("show")
                .about("Show one marketplace skill")
                .long_about(
                    "Show one marketplace skill. Use --version to inspect a specific \
                     version and --file to print a file from the skill package before \
                     installing it (e.g. --file SKILL.md).",
                )
                .arg(Arg::new("slug").required(true))
                .arg(
                    Arg::new("version")
                        .long("version")
                        .value_name("VERSION_ID")
                        .help("Show a specific version instead of the latest"),
                )
                .arg(
                    Arg::new("file")
                        .long("file")
                        .value_name("PATH")
                        .help("Print one file from the skill package (validated, relative path)"),
                ),
        )
        .subcommand(
            Command::new("files")
                .about("List the files inside a marketplace skill")
                .long_about(
                    "List the files inside a marketplace skill version without \
                     installing it. Defaults to the latest version; use --version for \
                     a specific one. Pair with `show <slug> --file <path>` to read a \
                     file's contents.",
                )
                .arg(Arg::new("slug").required(true))
                .arg(
                    Arg::new("version")
                        .long("version")
                        .value_name("VERSION_ID")
                        .help("Inspect a specific version instead of the latest"),
                ),
        )
        .subcommand(
            Command::new("bundles")
                .about("List marketplace bundles")
                .long_about(
                    "List marketplace bundles (curated sets of skills). Install one \
                     with `bb skills install --bundle <bundle-name>`.",
                )
                .arg(Arg::new("query").help("Optional free-text filter")),
        )
        .subcommand(install_command())
        .subcommand(update_command())
        .subcommand(remove_command())
        .subcommand(
            Command::new("installed")
                .about("List locally installed skills")
                .long_about(
                    "List locally installed skills with their versions and targets. \
                     When the marketplace is reachable, each skill is checked against \
                     the latest catalog version and stale skills are marked \
                     'update available'. Works offline (the remote check degrades to \
                     a warning).",
                )
                .arg(project_flag()),
        )
        .subcommand(
            Command::new("which")
                .about("Show where a skill is installed and where it is linked")
                .long_about(
                    "Show where a skill is installed (canonical package directory), \
                     where it came from, and the state of every target link (ok, \
                     missing, broken, or unmanaged).",
                )
                .arg(Arg::new("slug").required(true))
                .arg(project_flag()),
        )
        .subcommand(
            Command::new("doctor")
                .about("Diagnose the local skills installation")
                .long_about(
                    "Run independent diagnostic probes: config parse, profile, \
                     stored auth session, server reachability (distinguishing auth \
                     failures from the server being down), capabilities, package \
                     metadata, target links, and leftover staging directories. Each \
                     probe reports pass/warn/fail; an unreachable server never hides \
                     the local checks.\n\n\
                     `--fix` repairs what is safe to repair: creates missing base \
                     directories, removes orphaned staging/backup directories, and \
                     re-links broken target links. It never deletes unmanaged files.",
                )
                .arg(
                    Arg::new("fix")
                        .long("fix")
                        .help("Repair safe-to-repair problems (missing dirs, stale staging dirs, broken links)")
                        .action(ArgAction::SetTrue),
                ),
        )
        .subcommand(config_command().hide(true))
}

pub fn config_command() -> Command {
    // The key list and help lines come from PREFERENCE_KEYS so the help can
    // never drift from the keys `config get`/`config set` accept.
    let keys = PREFERENCE_KEYS
        .iter()
        .map(|spec| format!("  {:<17} {}", spec.key, spec.help))
        .collect::<Vec<_>>()
        .join("\n");
    Command::new("config")
        .about("Get and set bb preferences")
        .long_about(format!(
            "Get and set local preferences stored in `~/.bb/config.yaml`.\n\nKeys:\n{keys}"
        ))
        .subcommand_required(true)
        .arg_required_else_help(true)
        .disable_help_subcommand(true)
        .subcommand(
            Command::new("get")
                .about("Print one preference value")
                .arg(Arg::new("key").required(true)),
        )
        .subcommand(
            Command::new("set")
                .about("Set one preference value")
                .arg(Arg::new("key").required(true))
                .arg(Arg::new("value").required(true)),
        )
        .subcommand(Command::new("path").about("Print the preferences file path"))
}

pub fn auth_command() -> Command {
    Command::new("auth")
        .about("Manage BuilderBot marketplace authentication")
        .subcommand_required(true)
        .arg_required_else_help(true)
        .disable_help_subcommand(true)
        .subcommand(
            Command::new("status")
                .about("Print marketplace auth status")
                .long_about(
                    "Print marketplace auth status. With a stored CLI auth session \
                     this calls the server's /me endpoint and prints the authenticated \
                     tenant, subject, and scopes.",
                ),
        )
        .subcommand(
            Command::new("login")
                .about("Log in with browser-based CLI auth")
                .long_about(
                    "Log in with the browser-based CLI auth flow. This first checks \
                     stored CLI session credentials with /auth/me. If none are present \
                     or valid, it starts a loopback callback server, opens the backend \
                     Auth0 login flow with type=cli, exchanges the returned one-time \
                     code, and stores the session credential in OS keyring storage.",
                ),
        )
        .subcommand(
            Command::new("logout")
                .about("Remove browser-based CLI auth for the selected profile")
                .long_about(
                    "Remove the browser-based CLI auth session credential for the selected \
                     profile and server URL from the configured browser auth storage.",
                ),
        )
}

fn install_command() -> Command {
    Command::new("install")
        .about("Install a marketplace skill, bundle, or local skill directory")
        .long_about(
            "Install a skill from the marketplace, a bundle of skills, or a local \
             skill directory.\n\n\
             Remote installs ask the server for an install plan (which resolves \
             dependencies), download and verify each artifact (sha256 + size), \
             extract it safely into `~/.agents/skills/<slug>`, and link it \
             into every requested target's skills directory.\n\n\
             Local installs (`bb skills install ./my-skill`) copy the directory \
             instead, mark it `local_source`, and protect it from remote updates \
             unless --force is passed — the skill-author dev loop.\n\n\
             Without --yes, a TTY prompt confirms the plan; non-interactive shells \
             and --json require --yes.",
        )
        .arg(
            Arg::new("skill")
                .value_name("SLUG_OR_PATH")
                .help("Marketplace skill slug, or a local path (./my-skill) to install from disk")
                .required_unless_present("bundle"),
        )
        .arg(
            Arg::new("bundle")
                .long("bundle")
                .value_name("BUNDLE_NAME")
                .conflicts_with("skill")
                .help("Install every skill in a marketplace bundle"),
        )
        .arg(target_flag())
        .arg(project_flag())
        .arg(
            Arg::new("version")
                .long("version")
                .value_name("VERSION_ID")
                .help("Pin to a specific version (recorded as pinned; skipped by `update`)"),
        )
        .arg(
            Arg::new("name")
                .long("name")
                .value_name("SLUG")
                .help("Override the slug for a local path install"),
        )
        .arg(channel_flag())
        .arg(dry_run_flag())
        .arg(
            Arg::new("force")
                .long("force")
                .help("Reinstall even if up to date; required to overwrite local-source installs")
                .action(ArgAction::SetTrue),
        )
        .arg(yes_flag())
}

fn update_command() -> Command {
    Command::new("update")
        .about("Update installed skills to the latest marketplace versions")
        .long_about(
            "Update one skill, or every installed skill when no slug is given.\n\n\
             Sends the locally installed versions to the server's install-plan \
             endpoint and applies only the operations that changed; up-to-date \
             skills are reported and skipped. Pinned skills (installed with \
             --version) and local-source skills are skipped unless named \
             explicitly with --force. Respects the `no_auto_updates` preference \
             in non-interactive shells.",
        )
        .arg(Arg::new("skill").value_name("SLUG").help("Update only this skill"))
        .arg(target_flag())
        .arg(project_flag())
        .arg(channel_flag())
        .arg(dry_run_flag())
        .arg(
            Arg::new("force")
                .long("force")
                .help("Reinstall even when content is up to date; overrides pins and local-source protection")
                .action(ArgAction::SetTrue),
        )
        .arg(yes_flag())
}

fn remove_command() -> Command {
    Command::new("remove")
        .about("Remove an installed skill and its target links")
        .long_about(
            "Remove an installed skill: target links/copies first, then the \
             canonical package directory. With --target, only those target links \
             are removed and the package stays installed for the rest.\n\n\
             Directories that are not managed by bb skills are never deleted \
             unless both --include-unmanaged and --force are passed.",
        )
        .visible_alias("rm")
        .arg(Arg::new("slug").required(true))
        .arg(target_flag())
        .arg(project_flag())
        .arg(
            Arg::new("include-unmanaged")
                .long("include-unmanaged")
                .help("Also remove unmanaged directories at the skill's paths (requires --force)")
                .action(ArgAction::SetTrue),
        )
        .arg(
            Arg::new("force")
                .long("force")
                .requires("include-unmanaged")
                .help("Confirm removal of unmanaged directories")
                .action(ArgAction::SetTrue),
        )
        .arg(yes_flag())
}

fn target_flag() -> Arg {
    Arg::new("target")
        .long("target")
        .value_name("TARGET")
        .action(ArgAction::Append)
        .help("Agent target(s) to link into (default: `targets` preference, else `agents`)")
}

fn project_flag() -> Arg {
    Arg::new("project")
        .long("project")
        .help("Operate on project-local skill directories (./.agents/skills, ...) instead of global ones")
        .action(ArgAction::SetTrue)
}

fn channel_flag() -> Arg {
    Arg::new("channel")
        .long("channel")
        .value_name("CHANNEL")
        .help("Release channel (default: `channel` preference, else stable)")
}

fn dry_run_flag() -> Arg {
    Arg::new("dry-run")
        .long("dry-run")
        .help("Print the install plan without changing anything")
        .action(ArgAction::SetTrue)
}

fn yes_flag() -> Arg {
    Arg::new("yes")
        .long("yes")
        .help(
            "Apply changes without prompting (required in non-interactive shells and with --json)",
        )
        .action(ArgAction::SetTrue)
}

pub fn skills_global_args(command: Command) -> Command {
    command
        .arg(
            Arg::new("skills-config")
                .long("config")
                .value_name("PATH")
                .global(true)
                .help("BuilderBot skills config file"),
        )
        .arg(
            Arg::new("skills-profile")
                .long("profile")
                .value_name("NAME")
                .global(true)
                .help("BuilderBot skills config profile"),
        )
        .arg(
            Arg::new("json")
                .long("json")
                .global(true)
                .help("Print JSON output (suppresses color and prompts)")
                .action(ArgAction::SetTrue),
        )
        .arg(
            Arg::new("no-color")
                .long("no-color")
                .global(true)
                .help("Disable colored output")
                .action(ArgAction::SetTrue),
        )
        .arg(
            Arg::new("verbose")
                .long("verbose")
                .global(true)
                .help("Log HTTP requests and other diagnostics to stderr")
                .action(ArgAction::SetTrue),
        )
        .arg(
            Arg::new("local-dev")
                .long("local-dev")
                .global(true)
                .hide(true)
                .help("Use the checked-in BuilderBot local development config")
                .action(ArgAction::SetTrue),
        )
}

pub fn run(matches: &ArgMatches) -> Result<()> {
    run_with(matches, dispatch)
}

/// Entry point for the top-level `bb auth` command.
pub fn run_auth(matches: &ArgMatches) -> Result<()> {
    run_with(matches, dispatch_auth)
}

/// Entry point for the top-level `bb config` command.
pub fn run_config(matches: &ArgMatches) -> Result<()> {
    run_with_config(matches, preferences)
}

fn run_with(
    matches: &ArgMatches,
    dispatch: fn(&SkillsConfig, &ArgMatches) -> Result<()>,
) -> Result<()> {
    let config = SkillsConfig::resolve(matches)?;
    run_resolved(&config, matches, dispatch)
}

fn run_with_config(
    matches: &ArgMatches,
    dispatch: fn(&SkillsConfig, &ArgMatches) -> Result<()>,
) -> Result<()> {
    let config = SkillsConfig::resolve_for_config(matches)?;
    run_resolved(&config, matches, dispatch)
}

fn run_resolved(
    config: &SkillsConfig,
    matches: &ArgMatches,
    dispatch: fn(&SkillsConfig, &ArgMatches) -> Result<()>,
) -> Result<()> {
    match dispatch(config, matches) {
        Ok(()) => Ok(()),
        Err(err) => {
            if config.json {
                // Keep stderr machine-readable in JSON mode: one structured
                // error object instead of human prose.
                let (exit_code, payload) = failure_info(&err);
                eprintln!("{payload}");
                return Err(anyhow::Error::new(SilentJsonExit(exit_code)));
            }
            Err(err)
        }
    }
}

fn dispatch_auth(config: &SkillsConfig, matches: &ArgMatches) -> Result<()> {
    match matches.subcommand() {
        Some(("status", _)) => {
            ensure_org_configured(config)?;
            auth_status(config)
        }
        Some(("login", _)) => auth_login_browser(config),
        Some(("logout", _)) => {
            ensure_org_configured(config)?;
            auth_logout_browser(config)
        }
        _ => anyhow::bail!("expected an auth subcommand"),
    }
}

fn dispatch(config: &SkillsConfig, matches: &ArgMatches) -> Result<()> {
    match matches.subcommand() {
        Some(("search", search_matches)) => {
            ensure_org_configured(config)?;
            let query = search_matches
                .get_one::<String>("query")
                .context("expected search query")?;
            list_skills(config, Some(query), search_matches)
        }
        Some(("list", list_matches)) => {
            ensure_org_configured(config)?;
            list_skills(config, None, list_matches)
        }
        Some(("show", show_matches)) => {
            ensure_org_configured(config)?;
            show_skill(config, show_matches)
        }
        Some(("files", files_matches)) => {
            ensure_org_configured(config)?;
            list_files(config, files_matches)
        }
        Some(("bundles", bundles_matches)) => {
            ensure_org_configured(config)?;
            list_bundles(config, bundles_matches)
        }
        Some(("install", install_matches)) => {
            ensure_org_configured(config)?;
            install(config, install_matches)
        }
        Some(("update", update_matches)) => {
            ensure_org_configured(config)?;
            update(config, update_matches)
        }
        Some(("remove", remove_matches)) => {
            ensure_org_configured(config)?;
            remove(config, remove_matches)
        }
        Some(("installed", installed_matches)) => {
            ensure_org_configured(config)?;
            installed(config, installed_matches)
        }
        Some(("which", which_matches)) => {
            ensure_org_configured(config)?;
            which(config, which_matches)
        }
        Some(("doctor", doctor_matches)) => {
            ensure_org_configured(config)?;
            doctor(config, doctor_matches)
        }
        Some(("config", config_matches)) => preferences(config, config_matches),
        _ => anyhow::bail!("expected a skills subcommand"),
    }
}

fn ensure_org_configured(config: &SkillsConfig) -> Result<()> {
    if config.local_dev || config.org.is_some() {
        return Ok(());
    }
    Err(missing_org_error())
}

fn missing_org_error() -> anyhow::Error {
    failure(
        exit_codes::AUTH_REQUIRED,
        "org_required",
        "bb org is not configured; run `bb auth login` or `bb config set org <org>`",
    )
}

fn config_with_login_org(config: &SkillsConfig) -> Result<SkillsConfig> {
    if config.local_dev || config.org.is_some() {
        return Ok(config.clone());
    }
    if config.json || !stdin_is_tty() {
        return Err(missing_org_error());
    }

    eprint!("Enter your org: ");
    std::io::stderr().flush().context("flush org prompt")?;
    let mut answer = String::new();
    std::io::stdin()
        .read_line(&mut answer)
        .context("read org")?;
    let org = normalize_org(&answer)?;
    let mut preferences = config.read_preferences()?;
    preferences.org = Some(org.clone());
    config.write_preferences(&preferences)?;

    let mut resolved = config.clone();
    resolved.org = Some(org);
    resolved.kgoose_base_url = resolve_org_kgoose_base_url(
        &config.kgoose_base_url,
        resolved.org.as_deref(),
        config.local_dev,
    )?;
    Ok(resolved)
}

// ---------------------------------------------------------------------------
// auth

fn auth_status(config: &SkillsConfig) -> Result<()> {
    let storage = default_session_storage(config)?;
    let Some(me) = verify_stored_session(config, storage.as_ref())? else {
        if !config.json {
            println!("BuilderBot CLI auth");
            println!("  profile: {}", config.profile);
            println!("  kgoose base: {}", config.kgoose_base_url);
            println!("  authenticated: no");
            return Ok(());
        }
        return print_json(&json!({
            "authenticated": false,
            "kgoose_base_url": config.kgoose_base_url,
            "profile": config.profile,
        }));
    };

    if !config.json {
        println!("BuilderBot CLI auth");
        println!("  profile: {}", config.profile);
        println!("  kgoose base: {}", config.kgoose_base_url);
        println!("  authenticated: yes");
        if let Some(subject) = &me.subject {
            println!("  subject: {subject}");
        }
        if let Some(email) = &me.email {
            println!("  email: {email}");
        }
        if let Some(name) = &me.name {
            println!("  name: {name}");
        }
        if let Some(expires_at) = &me.expires_at {
            println!("  expires at: {expires_at}");
        }
        return Ok(());
    }
    print_json(&json!({
        "authenticated": true,
        "kgoose_base_url": config.kgoose_base_url,
        "profile": config.profile,
        "subject": me.subject,
        "email": me.email,
        "name": me.name,
        "expires_at": me.expires_at,
    }))
}

fn auth_login_browser(config: &SkillsConfig) -> Result<()> {
    let config = config_with_login_org(config)?;
    let storage = default_session_storage(&config)?;
    let summary = run_browser_login(&config, storage.as_ref())?;
    if config.json {
        return print_json(&summary);
    }

    match summary.source {
        BrowserLoginCredentialSource::Stored => config
            .style
            .success("BuilderBot CLI auth session is already valid"),
        BrowserLoginCredentialSource::BrowserLogin => config
            .style
            .success("BuilderBot CLI auth browser login succeeded"),
    }
    println!("  kgoose base: {}", summary.kgoose_base_url);
    println!("  storage: {}", summary.storage);
    if let Some(expires_at) = &summary.expires_at {
        println!("  expires at: {expires_at}");
    }
    if let Some(subject) = &summary.subject {
        println!("  subject: {subject}");
    }
    if let Some(email) = &summary.email {
        println!("  email: {email}");
    }
    if let Some(prefix) = &summary.credential_prefix {
        println!("  credential prefix: {prefix}...");
    }
    if let Some(prefix) = &summary.credential_sha256_prefix {
        println!("  credential sha256 prefix: {prefix}");
    }
    println!("  stored: yes");
    Ok(())
}

fn auth_logout_browser(config: &SkillsConfig) -> Result<()> {
    let storage = default_session_storage(config)?;
    let storage_key = super::auth_storage::SessionStorageKey::from_config(config);
    let mut warnings = Vec::new();
    let server_revoked = match logout_stored_session(config, storage.as_ref()) {
        Ok(server_revoked) => server_revoked,
        Err(err) => {
            warnings.push(format!("failed to destroy server auth session: {err}"));
            false
        }
    };
    let removed = match storage.delete(&storage_key) {
        Ok(removed) => removed,
        Err(err) => {
            warnings.push(format!("failed to remove local auth session: {err}"));
            false
        }
    };

    if config.json {
        return print_json(&json!({
            "profile": config.profile,
            "kgoose_base_url": config.kgoose_base_url,
            "storage": storage.kind(),
            "server_revoked": server_revoked,
            "removed": removed,
            "warnings": warnings,
        }));
    }

    if server_revoked {
        config
            .style
            .success("Destroyed BuilderBot CLI auth session on the server");
    }
    if removed {
        config.style.success("Removed BuilderBot CLI auth session");
    } else {
        println!("No BuilderBot CLI auth session was stored");
    }
    for warning in warnings {
        config.style.warn(&warning);
    }
    println!("  profile: {}", config.profile);
    println!("  kgoose base: {}", config.kgoose_base_url);
    println!("  storage: {}", storage.kind());
    Ok(())
}

// ---------------------------------------------------------------------------
// discovery

fn list_skills(config: &SkillsConfig, query: Option<&str>, matches: &ArgMatches) -> Result<()> {
    let client = MarketplaceClient::new(config)?;
    let mut filters: Vec<(&str, &str)> = Vec::new();
    if let Some(query) = query {
        filters.push(("query", query));
    }
    let source = matches.try_get_one::<String>("source").ok().flatten();
    if let Some(source) = source {
        filters.push(("source_id", source));
    }
    let status = matches.try_get_one::<String>("status").ok().flatten();
    if let Some(status) = status {
        filters.push(("status", status));
    }
    let mut items = client.list_skills_all(&filters)?;
    // Bundle membership is best-effort flavor text: an unreachable bundles
    // endpoint should never break listing skills.
    let bundles_by_skill = bundle_membership(&client);

    let installed_map = installed_by_slug(config);
    let installed_only = matches
        .try_get_one::<bool>("installed")
        .ok()
        .flatten()
        .copied()
        .unwrap_or(false);
    if installed_only {
        items.retain(|item| installed_map.contains_key(&item.slug));
    }
    // Installed skills sort to the top so the installed and available
    // sections can be cross-referenced at a glance.
    items.sort_by(|left, right| {
        let left_installed = installed_map.contains_key(&left.slug);
        let right_installed = installed_map.contains_key(&right.slug);
        right_installed
            .cmp(&left_installed)
            .then_with(|| left.slug.cmp(&right.slug))
    });

    if config.json {
        let items = items
            .iter()
            .map(|item| annotate_summary(item, &installed_map, &bundles_by_skill))
            .collect::<Vec<_>>();
        return print_json(&json!({ "items": items, "next_cursor": Value::Null }));
    }
    display_marketplace_skills(config.style, &items, &installed_map, &bundles_by_skill);
    Ok(())
}

/// Maps each skill slug to the bundle slugs that include it. Empty when the
/// bundles endpoint is unavailable.
fn bundle_membership(client: &MarketplaceClient) -> BTreeMap<String, Vec<String>> {
    let mut membership: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for bundle in client.list_bundles_all(None).unwrap_or_default() {
        for skill in &bundle.skills {
            membership
                .entry(skill.clone())
                .or_default()
                .push(bundle.slug.clone());
        }
    }
    membership
}

fn annotate_summary(
    item: &SkillSummary,
    installed_map: &BTreeMap<String, InstalledSkillMetadata>,
    bundles_by_skill: &BTreeMap<String, Vec<String>>,
) -> Value {
    let mut value = serde_json::to_value(item).unwrap_or_else(|_| json!({}));
    let installed_meta = installed_map.get(&item.slug);
    value["installed"] = json!(installed_meta.is_some());
    value["update_available"] = match installed_meta {
        Some(meta) => json!(item
            .latest_content_sha256
            .as_deref()
            .is_some_and(|latest| latest != meta.content_sha256)),
        None => Value::Null,
    };
    value["bundles"] = json!(bundles_by_skill
        .get(&item.slug)
        .cloned()
        .unwrap_or_default());
    value
}

fn installed_by_slug(config: &SkillsConfig) -> BTreeMap<String, InstalledSkillMetadata> {
    read_installed(config, Scope::Global)
        .unwrap_or_default()
        .into_iter()
        .map(|meta| (meta.slug.clone(), meta))
        .collect()
}

fn show_skill(config: &SkillsConfig, matches: &ArgMatches) -> Result<()> {
    let slug = matches
        .get_one::<String>("slug")
        .context("expected skill slug")?;
    let version = matches.get_one::<String>("version");
    let file = matches.get_one::<String>("file");
    let client = MarketplaceClient::new(config)?;

    if let Some(file) = file {
        // Validate locally before asking the server, so `--file ../../x`
        // never leaves the package root even if the server also validates.
        validate_preview_path(file)?;
        let version_id = match version {
            Some(version) => version.clone(),
            None => {
                client
                    .get_json::<SkillDetail>(&format!("/v1/marketplace/skills/{slug}"))?
                    .latest_version_id
            }
        };
        let bytes = client.get_bytes(&format!(
            "/v1/marketplace/skills/{slug}/versions/{version_id}/files?path={file}"
        ))?;
        std::io::stdout()
            .write_all(&bytes)
            .context("write file contents")?;
        return Ok(());
    }

    if let Some(version) = version {
        let detail = client.get_json::<SkillVersionDetail>(&format!(
            "/v1/marketplace/skills/{slug}/versions/{version}"
        ))?;
        if config.json {
            return print_json(&detail);
        }
        println!("{} @ {}", detail.slug, detail.id);
        println!("  status: {}", detail.status);
        println!("  content sha: {}", detail.content_sha256);
        if let Some(created_at) = &detail.created_at {
            println!("  created: {created_at}");
        }
        if !detail.files.is_empty() {
            println!("  files ({}):", detail.files.len());
            for file in &detail.files {
                println!("    {} ({} bytes)", file.path, file.size_bytes);
            }
        }
        return Ok(());
    }

    let detail = client.get_json::<SkillDetail>(&format!("/v1/marketplace/skills/{slug}"))?;
    if config.json {
        return print_json(&detail);
    }
    display_skill_detail(config.style, &detail);
    Ok(())
}

fn list_files(config: &SkillsConfig, matches: &ArgMatches) -> Result<()> {
    let slug = matches
        .get_one::<String>("slug")
        .context("expected skill slug")?;
    let version = matches.get_one::<String>("version");
    let client = MarketplaceClient::new(config)?;

    let (version_id, files) = match version {
        Some(version) => {
            let detail = client.get_json::<SkillVersionDetail>(&format!(
                "/v1/marketplace/skills/{slug}/versions/{version}"
            ))?;
            (detail.id, detail.files)
        }
        None => {
            let detail =
                client.get_json::<SkillDetail>(&format!("/v1/marketplace/skills/{slug}"))?;
            let files = detail
                .latest_version
                .as_ref()
                .and_then(|version| version.get("files"))
                .cloned()
                .map(serde_json::from_value)
                .transpose()
                .context("parse latest version files")?
                .unwrap_or_default();
            (detail.latest_version_id, files)
        }
    };

    if config.json {
        return print_json(&json!({
            "slug": slug,
            "version_id": version_id,
            "files": files,
        }));
    }
    println!("{slug} @ {version_id} ({} files):", files.len());
    for file in &files {
        println!("  {} ({} bytes)", file.path, file.size_bytes);
    }
    println!();
    println!("Read one with: bb skills show {slug} --file <path>");
    Ok(())
}

fn list_bundles(config: &SkillsConfig, matches: &ArgMatches) -> Result<()> {
    let query = matches.get_one::<String>("query");
    let client = MarketplaceClient::new(config)?;
    let items = client.list_bundles_all(query.map(String::as_str))?;
    if config.json {
        return print_json(&json!({ "items": items }));
    }
    display_bundles(config.style, &items);
    Ok(())
}

// ---------------------------------------------------------------------------
// install / update / remove

struct PlanContext {
    client: MarketplaceClient,
    targets: Vec<ResolvedTarget>,
    target_names: Vec<String>,
    scope: Scope,
    channel: String,
}

fn plan_context(
    config: &SkillsConfig,
    matches: &ArgMatches,
    explicit_target_default: Option<Vec<String>>,
) -> Result<PlanContext> {
    let preferences = config.read_preferences()?;
    let scope = if matches.get_flag("project") {
        Scope::Project
    } else {
        Scope::Global
    };
    let channel = matches
        .get_one::<String>("channel")
        .cloned()
        .or_else(|| preferences.channel.clone())
        .unwrap_or_else(|| "stable".to_string());
    let target_names = matches
        .get_many::<String>("target")
        .map(|values| values.cloned().collect::<Vec<_>>())
        .or(explicit_target_default)
        .or_else(|| (!preferences.targets.is_empty()).then(|| preferences.targets.clone()))
        .unwrap_or_else(|| vec!["agents".to_string()]);

    let client = MarketplaceClient::new(config)?;
    let registry = TargetRegistry::load(config, &client)?;
    let targets = registry.resolve(&target_names, scope)?;
    Ok(PlanContext {
        client,
        targets,
        target_names,
        scope,
        channel,
    })
}

fn is_path_like(input: &str) -> bool {
    input.starts_with("./")
        || input.starts_with("../")
        || input.starts_with('/')
        || input.starts_with("~/")
        || input.contains(std::path::MAIN_SEPARATOR)
}

fn install(config: &SkillsConfig, matches: &ArgMatches) -> Result<()> {
    ensure_base_dirs(config)?;
    let slug_or_path = matches.get_one::<String>("skill");
    let bundle = matches.get_one::<String>("bundle");
    let version = matches.get_one::<String>("version");
    let dry_run = matches.get_flag("dry-run");
    let force = matches.get_flag("force");
    let yes = matches.get_flag("yes");
    let context = plan_context(config, matches, None)?;

    // Local path install: short-circuits all remote resolution.
    if let Some(input) = slug_or_path {
        if is_path_like(input) {
            if version.is_some() {
                anyhow::bail!("--version does not apply to local path installs");
            }
            let source = super::skills_targets::expand_path(input);
            confirm_or_bail(
                config,
                yes || dry_run,
                &format!("Install local skill from {}.", source.display()),
            )?;
            if dry_run {
                config
                    .style
                    .info(&format!("dry run: would install {}", source.display()));
                if config.json {
                    return print_json(&json!({"dry_run": true, "source": source}));
                }
                return Ok(());
            }
            let _lock = InstallLock::acquire(config)?;
            let execution = install_local_path(
                config,
                &source,
                matches.get_one::<String>("name").map(String::as_str),
                &context.targets,
                context.scope,
                force,
            )?;
            return report_execution(config, execution);
        }
    }

    let lock = if dry_run {
        None
    } else {
        Some(InstallLock::acquire(config)?)
    };
    let installed = read_installed(config, context.scope)?;

    // Never silently overwrite local-source skills with marketplace content.
    if let Some(slug) = slug_or_path {
        if !force
            && installed
                .iter()
                .any(|meta| &meta.slug == slug && meta.local_source)
        {
            return Err(failure(
                exit_codes::FS_CONFLICT,
                "local_source_installed",
                format!("skill `{slug}` is installed from a local source; pass --force to overwrite it with marketplace content"),
            ));
        }
    }

    let force_slugs = match (force, slug_or_path) {
        (true, Some(slug)) => vec![slug.clone()],
        _ => Vec::new(),
    };
    let requested = match (bundle, slug_or_path) {
        (Some(bundle), _) => RequestedTarget {
            target_type: "bundle".to_string(),
            slug: bundle.clone(),
            version_id: None,
        },
        (None, Some(slug)) => RequestedTarget {
            target_type: "skill".to_string(),
            slug: slug.clone(),
            version_id: version.cloned(),
        },
        (None, None) => anyhow::bail!("expected a skill slug, path, or --bundle"),
    };

    let request = InstallPlanRequest {
        channel: context.channel.clone(),
        scope: context.scope.as_str().to_string(),
        targets: vec![requested],
        installed: installed_request_payload(&installed, &force_slugs),
        client: BTreeMap::from([("install_targets".to_string(), json!(context.target_names))]),
        include_dependencies: true,
        allow_removals: false,
        dry_run,
    };
    let plan = context
        .client
        .post_json::<InstallPlanResponse, _>("/v1/marketplace/install-plan", &request)?;

    // The server resolves to the latest visible version; surface a clear
    // error instead of silently installing something else when a pin was
    // requested.
    if let (Some(version), Some(slug)) = (version, slug_or_path) {
        if let Some(operation) = plan
            .operations
            .iter()
            .find(|operation| &operation.skill.slug == slug)
        {
            if &operation.skill.version_id != version {
                return Err(failure(
                    exit_codes::PLAN_BLOCKED,
                    "version_pin_unresolved",
                    format!(
                        "requested version `{version}` but the server resolved `{}`; the marketplace currently serves only the latest stable version",
                        operation.skill.version_id
                    ),
                ));
            }
        }
    }

    if dry_run {
        return report_plan(config, &plan, true);
    }

    let pending = plan
        .operations
        .iter()
        .filter(|operation| operation.action != "noop")
        .count();
    if pending > 0 && !yes {
        display_plan(config.style, &plan);
    }
    if pending > 0 {
        confirm_or_bail(config, yes, &format!("{pending} change(s) planned."))?;
    }

    let pinned_slugs = match (version.is_some(), slug_or_path) {
        (true, Some(slug)) => vec![slug.clone()],
        _ => Vec::new(),
    };
    let options = ExecuteOptions {
        targets: &context.targets,
        scope: context.scope,
        allow_removals: false,
        pinned_slugs: &pinned_slugs,
    };
    let execution = execute_plan(config, &context.client, plan, &options)?;
    drop(lock);
    report_execution(config, execution)
}

fn update(config: &SkillsConfig, matches: &ArgMatches) -> Result<()> {
    ensure_base_dirs(config)?;
    let slug = matches.get_one::<String>("skill");
    let dry_run = matches.get_flag("dry-run");
    let force = matches.get_flag("force");
    let yes = matches.get_flag("yes");

    let preferences = config.read_preferences()?;
    if preferences.no_auto_updates.unwrap_or(false)
        && !force
        && !dry_run
        && !super::display::stdin_is_tty()
    {
        return Err(failure(
            exit_codes::CANCELED,
            "no_auto_updates",
            "the `no_auto_updates` preference is set and this shell is non-interactive; pass --force to update anyway",
        ));
    }

    let scope = if matches.get_flag("project") {
        Scope::Project
    } else {
        Scope::Global
    };
    let installed = read_installed(config, scope)?;
    if installed.is_empty() {
        if config.json {
            return print_json(&json!({"updated": [], "up_to_date": [], "skipped": []}));
        }
        println!("No local skills installed.");
        return Ok(());
    }

    let mut update_slugs = Vec::new();
    let mut skipped: Vec<(String, String)> = Vec::new();
    match slug {
        Some(slug) => {
            let Some(meta) = installed.iter().find(|meta| &meta.slug == slug) else {
                return Err(failure(
                    exit_codes::GENERAL,
                    "not_installed",
                    format!("skill `{slug}` is not installed; run `bb skills install {slug}`"),
                ));
            };
            if meta.local_source && !force {
                return Err(failure(
                    exit_codes::FS_CONFLICT,
                    "local_source_installed",
                    format!("skill `{slug}` is installed from a local source; pass --force to overwrite it"),
                ));
            }
            if meta.pinned && !force {
                return Err(failure(
                    exit_codes::PLAN_BLOCKED,
                    "pinned",
                    format!(
                        "skill `{slug}` is pinned to {}; pass --force to update anyway",
                        meta.version_id
                    ),
                ));
            }
            update_slugs.push(slug.clone());
        }
        None => {
            for meta in &installed {
                if meta.local_source {
                    skipped.push((meta.slug.clone(), "local source".to_string()));
                } else if meta.pinned && !force {
                    skipped.push((meta.slug.clone(), format!("pinned to {}", meta.version_id)));
                } else {
                    update_slugs.push(meta.slug.clone());
                }
            }
        }
    }

    if update_slugs.is_empty() {
        if config.json {
            return print_json(&json!({
                "updated": [],
                "up_to_date": [],
                "skipped": skipped
                    .iter()
                    .map(|(slug, reason)| json!({"slug": slug, "reason": reason}))
                    .collect::<Vec<_>>(),
            }));
        }
        println!("Nothing to update.");
        for (slug, reason) in &skipped {
            println!("  skipped {slug}: {reason}");
        }
        return Ok(());
    }

    // Default the link targets to everything the updating skills were
    // installed into, so updates preserve existing placements.
    let default_targets = {
        let mut names: Vec<String> = installed
            .iter()
            .filter(|meta| update_slugs.contains(&meta.slug))
            .flat_map(|meta| meta.targets.clone())
            .collect();
        names.sort();
        names.dedup();
        (!names.is_empty()).then_some(names)
    };
    let context = plan_context(config, matches, default_targets)?;

    let lock = if dry_run {
        None
    } else {
        Some(InstallLock::acquire(config)?)
    };
    let force_slugs = if force {
        update_slugs.clone()
    } else {
        Vec::new()
    };
    let request = InstallPlanRequest {
        channel: context.channel.clone(),
        scope: context.scope.as_str().to_string(),
        targets: update_slugs
            .iter()
            .map(|slug| RequestedTarget {
                target_type: "skill".to_string(),
                slug: slug.clone(),
                version_id: None,
            })
            .collect(),
        installed: installed_request_payload(&installed, &force_slugs),
        client: BTreeMap::from([("install_targets".to_string(), json!(context.target_names))]),
        include_dependencies: true,
        allow_removals: false,
        dry_run,
    };
    let plan = context
        .client
        .post_json::<InstallPlanResponse, _>("/v1/marketplace/install-plan", &request)?;

    if dry_run {
        return report_plan(config, &plan, true);
    }

    let pending = plan
        .operations
        .iter()
        .filter(|operation| operation.action != "noop")
        .count();
    if pending > 0 && !yes {
        display_plan(config.style, &plan);
    }
    if pending > 0 {
        confirm_or_bail(config, yes, &format!("{pending} change(s) planned."))?;
    }

    let options = ExecuteOptions {
        targets: &context.targets,
        scope: context.scope,
        allow_removals: false,
        pinned_slugs: &[],
    };
    let mut execution = execute_plan(config, &context.client, plan, &options)?;
    execution.skipped.extend(skipped);
    drop(lock);
    report_execution(config, execution)
}

fn remove(config: &SkillsConfig, matches: &ArgMatches) -> Result<()> {
    let slug = matches
        .get_one::<String>("slug")
        .context("expected skill slug")?;
    let include_unmanaged = matches.get_flag("include-unmanaged");
    let force = matches.get_flag("force");
    let yes = matches.get_flag("yes");
    let scope = if matches.get_flag("project") {
        Scope::Project
    } else {
        Scope::Global
    };

    let only_targets = match matches.get_many::<String>("target") {
        Some(values) => {
            let names = values.cloned().collect::<Vec<_>>();
            let registry = TargetRegistry::load_offline(config);
            Some(registry.resolve(&names, scope)?)
        }
        None => None,
    };

    let what = match &only_targets {
        Some(targets) => format!(
            "Remove `{slug}` from target(s) {}.",
            targets
                .iter()
                .map(|target| target.name.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        ),
        None => format!("Remove skill `{slug}` and all of its target links."),
    };
    confirm_or_bail(config, yes, &what)?;

    let _lock = InstallLock::acquire(config)?;
    let report = remove_skill(
        config,
        slug,
        only_targets.as_deref(),
        scope,
        include_unmanaged,
        force,
    )?;

    if config.json {
        return print_json(&report.to_json());
    }
    if report.removed_package {
        config.style.success(&format!("Removed skill `{slug}`"));
    } else {
        config
            .style
            .success(&format!("Removed `{slug}` target links"));
    }
    for link in &report.removed_links {
        println!("  removed {}", link.display());
    }
    for (path, reason) in &report.skipped_paths {
        config
            .style
            .warn(&format!("skipped {}: {reason}", path.display()));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// installed / which / doctor / config

fn installed(config: &SkillsConfig, matches: &ArgMatches) -> Result<()> {
    let scope = if matches.get_flag("project") {
        Scope::Project
    } else {
        Scope::Global
    };
    let installed = read_installed(config, scope)?;

    // Best-effort remote comparison; offline degrades to "unknown".
    let latest_by_slug: Option<BTreeMap<String, Option<String>>> = MarketplaceClient::new(config)
        .ok()
        .and_then(|client| client.list_skills_all(&[]).ok())
        .map(|items| {
            items
                .into_iter()
                .map(|item| (item.slug, item.latest_content_sha256))
                .collect()
        });
    if latest_by_slug.is_none() && !installed.is_empty() && !config.json {
        config
            .style
            .warn("marketplace unreachable; update checks skipped");
    }

    let update_available = |meta: &InstalledSkillMetadata| -> Option<bool> {
        let latest = latest_by_slug.as_ref()?.get(&meta.slug)?;
        latest
            .as_deref()
            .map(|latest| latest != meta.content_sha256)
    };

    if config.json {
        let items = installed
            .iter()
            .map(|meta| {
                let mut value = serde_json::to_value(meta).unwrap_or_else(|_| json!({}));
                value["update_available"] = match update_available(meta) {
                    Some(stale) => json!(stale),
                    None => Value::Null,
                };
                value
            })
            .collect::<Vec<_>>();
        return print_json(&json!({ "items": items }));
    }

    if installed.is_empty() {
        println!("No local skills installed.");
        return Ok(());
    }
    let style = config.style;
    println!(
        "{}",
        style.bold(&format!("Installed skills ({}):", installed.len()))
    );
    println!();
    for meta in &installed {
        let marker = match update_available(meta) {
            Some(true) => style.yellow(" (update available)"),
            Some(false) => style.dim(" (up to date)"),
            None => String::new(),
        };
        println!(
            "  {} {}{marker}",
            style.slug(&meta.slug),
            style.dim(&format!("[{}]", meta.scope))
        );
        println!("    {} {}", style.label("version:"), meta.version_id);
        if meta.pinned {
            println!("    {} yes", style.label("pinned:"));
        }
        if meta.local_source {
            println!("    {} yes", style.label("local source:"));
        }
        if !meta.targets.is_empty() {
            println!(
                "    {} {}",
                style.label("targets:"),
                meta.targets.join(", ")
            );
        }
        if let Some(source_revision) = &meta.source_revision {
            println!("    {} {source_revision}", style.label("source:"));
        }
        println!(
            "    {} {}",
            style.label("path:"),
            canonical_dir(config, scope, &meta.slug).display()
        );
        println!();
    }
    Ok(())
}

fn which(config: &SkillsConfig, matches: &ArgMatches) -> Result<()> {
    let slug = matches
        .get_one::<String>("slug")
        .context("expected skill slug")?;
    let scope = if matches.get_flag("project") {
        Scope::Project
    } else {
        Scope::Global
    };
    let package_dir = canonical_dir(config, scope, slug);
    let metadata = read_metadata(&package_dir).map_err(|_| {
        failure(
            exit_codes::GENERAL,
            "not_installed",
            format!("skill `{slug}` is not installed; run `bb skills install {slug}`"),
        )
    })?;

    let registry = TargetRegistry::load_offline(config);
    let mut links = Vec::new();
    if let Ok(resolved) = registry.resolve(&metadata.targets, scope) {
        for target in &resolved {
            for base_dir in &target.base_dirs {
                let link_path = base_dir.join(slug);
                links.push((
                    target.name.clone(),
                    link_path.clone(),
                    inspect_link(&link_path, &package_dir),
                ));
            }
        }
    }

    if config.json {
        return print_json(&json!({
            "slug": slug,
            "package_dir": package_dir,
            "metadata": metadata,
            "links": links
                .iter()
                .map(|(target, path, state)| json!({
                    "target": target,
                    "path": path,
                    "state": state,
                }))
                .collect::<Vec<_>>(),
        }));
    }

    let style = config.style;
    println!("{}", style.slug(slug));
    println!("  {} {}", style.label("package:"), package_dir.display());
    println!("  {} {}", style.label("version:"), metadata.version_id);
    println!(
        "  {} {}",
        style.label("installed at:"),
        metadata.installed_at
    );
    println!(
        "  {} {}",
        style.label("installed via:"),
        metadata.installed_via
    );
    println!("  {} {}", style.label("scope:"), metadata.scope);
    if let Some(source_revision) = &metadata.source_revision {
        println!("  {} {source_revision}", style.label("source:"));
    }
    if metadata.local_source {
        println!("  {} yes", style.label("local source:"));
    }
    if metadata.pinned {
        println!("  {} yes", style.label("pinned:"));
    }
    if !links.is_empty() {
        println!("  {}", style.label("links:"));
        for (target, path, state) in &links {
            let state_text = match state {
                LinkState::Ok => config.style.green("ok"),
                LinkState::Missing => config.style.red("missing"),
                LinkState::Broken => config.style.red("broken"),
                LinkState::Unmanaged => config.style.yellow("unmanaged"),
            };
            println!("    [{state_text}] {target}: {}", path.display());
        }
    }
    Ok(())
}

fn doctor(config: &SkillsConfig, matches: &ArgMatches) -> Result<()> {
    let fix = matches.get_flag("fix");
    let (report, payload) = run_doctor(config, fix)?;
    if config.json {
        return print_json(&payload);
    }

    println!("BuilderBot skills doctor");
    println!("  profile: {}", config.profile);
    println!("  local dev: {}", yes_no(config.local_dev));
    println!("  kgoose base: {}", config.kgoose_base_url);
    println!("  config: {}", config.config_path.display());
    println!("  bb home: {}", config.bb_home.display());
    println!("  skills home: {}", config.skills_home.display());
    println!();
    for check in &report.checks {
        let badge = match check.status {
            CheckStatus::Pass => config.style.green("PASS"),
            CheckStatus::Warn => config.style.yellow("WARN"),
            CheckStatus::Fail => config.style.red("FAIL"),
        };
        println!("  [{badge}] {}: {}", check.name, check.detail);
    }
    for fixed in &report.fixed {
        config.style.success(&format!("fixed: {fixed}"));
    }
    if !report.ok() && !fix {
        println!();
        config
            .style
            .info("some checks failed; `bb skills doctor --fix` repairs the safe ones");
    }
    Ok(())
}

fn preferences(config: &SkillsConfig, matches: &ArgMatches) -> Result<()> {
    let known_keys = || {
        PREFERENCE_KEYS
            .iter()
            .map(|spec| spec.key)
            .collect::<Vec<_>>()
            .join(", ")
    };
    match matches.subcommand() {
        Some(("path", _)) => {
            if config.json {
                return print_json(&json!({"path": config.preferences_path()}));
            }
            println!("{}", config.preferences_path().display());
            Ok(())
        }
        Some(("get", get_matches)) => {
            let key = get_matches
                .get_one::<String>("key")
                .context("expected preference key")?;
            let preferences = config.read_preferences()?;
            let value: Value = match key.as_str() {
                "org" => json!(preferences.org.unwrap_or_default()),
                "channel" => json!(preferences.channel.unwrap_or_else(|| "stable".to_string())),
                "targets" => json!(if preferences.targets.is_empty() {
                    "agents".to_string()
                } else {
                    preferences.targets.join(",")
                }),
                "install_strategy" => json!(preferences
                    .install_strategy
                    .unwrap_or_else(|| "symlink".to_string())),
                "no_auto_updates" => json!(preferences.no_auto_updates.unwrap_or(false)),
                other => {
                    anyhow::bail!("unknown preference `{other}`; known keys: {}", known_keys())
                }
            };
            if config.json {
                return print_json(&json!({key: value}));
            }
            match value {
                Value::String(text) => println!("{text}"),
                other => println!("{other}"),
            }
            Ok(())
        }
        Some(("set", set_matches)) => {
            let key = set_matches
                .get_one::<String>("key")
                .context("expected preference key")?;
            let value = set_matches
                .get_one::<String>("value")
                .context("expected preference value")?;
            let mut preferences = config.read_preferences()?;
            match key.as_str() {
                "org" => preferences.org = Some(normalize_org(value)?),
                "channel" => preferences.channel = Some(value.clone()),
                "targets" => {
                    let names = value
                        .split(',')
                        .map(|name| name.trim().to_string())
                        .filter(|name| !name.is_empty())
                        .collect::<Vec<_>>();
                    if names.is_empty() {
                        anyhow::bail!("targets cannot be empty; e.g. `agents,claude`");
                    }
                    let registry = TargetRegistry::load_offline(config);
                    registry.resolve(&names, Scope::Global)?;
                    preferences.targets = names;
                }
                "install_strategy" => {
                    if value != "symlink" && value != "copy" {
                        anyhow::bail!("install_strategy must be `symlink` or `copy`");
                    }
                    preferences.install_strategy = Some(value.clone());
                }
                "no_auto_updates" => {
                    preferences.no_auto_updates = Some(match value.as_str() {
                        "true" | "1" | "yes" => true,
                        "false" | "0" | "no" => false,
                        other => {
                            anyhow::bail!("no_auto_updates must be true or false, got `{other}`")
                        }
                    });
                }
                other => {
                    anyhow::bail!("unknown preference `{other}`; known keys: {}", known_keys())
                }
            }
            config.write_preferences(&preferences)?;
            if config.json {
                return print_json(&json!({"updated": key, "path": config.preferences_path()}));
            }
            config.style.success(&format!(
                "set {key} in {}",
                config.preferences_path().display()
            ));
            Ok(())
        }
        _ => anyhow::bail!("expected a config subcommand"),
    }
}

// ---------------------------------------------------------------------------
// output

fn print_json<T: Serialize>(value: &T) -> Result<()> {
    println!(
        "{}",
        serde_json::to_string_pretty(value).context("serialize JSON output")?
    );
    Ok(())
}

fn report_plan(config: &SkillsConfig, plan: &InstallPlanResponse, dry_run: bool) -> Result<()> {
    if config.json {
        return print_json(&json!({
            "plan_id": plan.plan_id,
            "dry_run": dry_run,
            "operations": plan
                .operations
                .iter()
                .map(|operation| json!({
                    "action": operation.action,
                    "slug": operation.skill.slug,
                    "version_id": operation.skill.version_id,
                    "installed_via": operation.installed_via,
                    "reason": operation.reason,
                }))
                .collect::<Vec<_>>(),
            "warnings": plan.warnings,
        }));
    }
    display_plan(config.style, plan);
    if dry_run {
        config.style.info("dry run: no changes were made");
    }
    Ok(())
}

fn display_plan(style: Style, plan: &InstallPlanResponse) {
    println!("Install plan {}", plan.plan_id);
    if plan.operations.is_empty() {
        println!("  No operations.");
    }
    for operation in &plan.operations {
        let line = format!(
            "{:>8}  {} @ {}{}",
            operation.action,
            operation.skill.slug,
            operation.skill.version_id,
            provenance_suffix(&operation.installed_via),
        );
        match operation.action.as_str() {
            "noop" => println!("  {}", style.dim(&line)),
            "remove" => println!("  {}", style.red(&line)),
            _ => println!("  {line}"),
        }
    }
    display_warnings(style, &plan.warnings);
}

/// Human-readable provenance: distinguish "you asked for X" from "X was
/// pulled in by a dependency or bundle".
fn provenance_suffix(installed_via: &str) -> String {
    if let Some(parent) = installed_via.strip_prefix("depends-on:") {
        format!("  (dependency of {parent})")
    } else if let Some(bundle) = installed_via.strip_prefix("bundle:") {
        format!("  (from bundle {bundle})")
    } else {
        String::new()
    }
}

fn display_warnings(style: Style, warnings: &[super::skills_models::Warning]) {
    for warning in warnings {
        let mut message = format!("{} ({})", warning.message, warning.code);
        if let Some(action) = &warning.suggested_action {
            message.push_str(&format!(" — {action}"));
        }
        style.warn(&message);
    }
}

fn report_execution(config: &SkillsConfig, execution: PlanExecution) -> Result<()> {
    if config.json {
        return print_json(&execution.to_json());
    }
    let style = config.style;
    println!("Install plan {}", execution.plan_id);
    if execution.installed.is_empty() && execution.removed.is_empty() {
        println!("  No skill changes.");
    }
    for change in &execution.installed {
        style.success(&format!(
            "{} {} @ {}{}",
            if change.action == "update" {
                "updated"
            } else {
                "installed"
            },
            style.bold(&change.slug),
            change.version_id,
            provenance_suffix(&change.installed_via),
        ));
        for link in &change.links {
            println!("    {} -> {}", link.strategy, link.path.display());
        }
    }
    for slug in &execution.removed {
        style.success(&format!("removed {slug}"));
    }
    for slug in &execution.up_to_date {
        println!("  {}", style.dim(&format!("{slug} is up to date")));
    }
    for (slug, reason) in &execution.skipped {
        style.warn(&format!("skipped {slug}: {reason}"));
    }
    display_warnings(style, &execution.warnings);
    for change in &execution.installed {
        if let Some(setup) = &change.setup {
            display_setup_prompt(style, &change.slug, setup);
        }
    }
    Ok(())
}

fn display_setup_prompt(style: Style, slug: &str, setup: &SetupSummary) {
    println!();
    style.info(&format!(
        "{} needs one-time setup: {}",
        style.bold(slug),
        setup.title
    ));
    for section in &setup.sections {
        println!("    - {section}");
    }
    println!("    See {}", setup.path.display());
}

fn display_marketplace_skills(
    style: Style,
    skills: &[SkillSummary],
    installed_map: &BTreeMap<String, InstalledSkillMetadata>,
    bundles_by_skill: &BTreeMap<String, Vec<String>>,
) {
    let (installed, available): (Vec<&SkillSummary>, Vec<&SkillSummary>) = skills
        .iter()
        .partition(|skill| installed_map.contains_key(&skill.slug));
    // Skills installed from a local path (or a server the catalog no longer
    // lists) still belong in the installed section.
    let local_only = installed_map
        .values()
        .filter(|meta| !skills.iter().any(|skill| skill.slug == meta.slug))
        .collect::<Vec<_>>();

    if installed.is_empty() && available.is_empty() && local_only.is_empty() {
        println!("No skills available.");
        return;
    }

    if !installed.is_empty() || !local_only.is_empty() {
        println!(
            "{}",
            style.bold(&format!(
                "Installed ({}):",
                installed.len() + local_only.len()
            ))
        );
        println!();
        for skill in &installed {
            let meta = &installed_map[&skill.slug];
            let stale = skill
                .latest_content_sha256
                .as_deref()
                .is_some_and(|latest| latest != meta.content_sha256);
            let marker = if stale {
                style.yellow(" (update available)")
            } else {
                style.dim(" (up to date)")
            };
            display_skill_entry(style, skill, Some(meta), &marker, bundles_by_skill);
        }
        for meta in &local_only {
            display_local_only_entry(style, meta);
        }
    }

    if !available.is_empty() {
        println!(
            "{}",
            style.bold(&format!("Available ({}):", available.len()))
        );
        println!();
        for skill in &available {
            display_skill_entry(style, skill, None, "", bundles_by_skill);
        }
        println!("Install one with: bb skills install <slug>");
    }
}

fn display_skill_entry(
    style: Style,
    skill: &SkillSummary,
    meta: Option<&InstalledSkillMetadata>,
    marker: &str,
    bundles_by_skill: &BTreeMap<String, Vec<String>>,
) {
    println!(
        "  {} {}{marker}",
        style.slug(&skill.slug),
        status_badge(style, &skill.status, skill.enabled),
    );
    if !skill.description.is_empty() {
        println!(
            "    {}",
            super::skills_api::truncate(&skill.description, 80)
        );
    }
    if !skill.name.is_empty() && skill.name != skill.slug {
        println!("    {} {}", style.label("name:"), skill.name);
    }
    if let Some(meta) = meta {
        let pin = if meta.pinned { " (pinned)" } else { "" };
        println!("    {} {}{pin}", style.label("version:"), meta.version_id);
        if !meta.targets.is_empty() {
            println!(
                "    {} {}",
                style.label("targets:"),
                meta.targets.join(", ")
            );
        }
    }
    if !skill.tags.is_empty() {
        println!("    {} {}", style.label("tags:"), skill.tags.join(", "));
    }
    if let Some(bundles) = bundles_by_skill.get(&skill.slug) {
        println!("    {} {}", style.label("bundles:"), bundles.join(", "));
    }
    println!();
}

fn display_local_only_entry(style: Style, meta: &InstalledSkillMetadata) {
    let marker = if meta.local_source {
        style.cyan(" (local install)")
    } else {
        style.dim(" (not in marketplace)")
    };
    println!("  {}{marker}", style.slug(&meta.slug));
    println!("    {} {}", style.label("version:"), meta.version_id);
    if !meta.targets.is_empty() {
        println!(
            "    {} {}",
            style.label("targets:"),
            meta.targets.join(", ")
        );
    }
    println!();
}

fn display_skill_detail(style: Style, skill: &SkillDetail) {
    println!(
        "{} {}",
        style.slug(&skill.slug),
        status_badge(style, &skill.status, skill.enabled)
    );
    if !skill.name.is_empty() && skill.name != skill.slug {
        println!("  {} {}", style.label("name:"), skill.name);
    }
    if !skill.description.is_empty() {
        println!("  {}", skill.description);
    }
    println!("  {} {}", style.label("version:"), skill.latest_version_id);
    if !skill.latest_content_sha256.is_empty() {
        println!(
            "  {} {}",
            style.label("content sha:"),
            skill.latest_content_sha256
        );
    }
    if let Some(source_id) = &skill.source_id {
        println!("  {} {source_id}", style.label("source:"));
    }
    if !skill.tags.is_empty() {
        println!("  {} {}", style.label("tags:"), skill.tags.join(", "));
    }
    if !skill.dependencies.is_empty() {
        println!(
            "  {} {}",
            style.label("dependencies:"),
            skill.dependencies.join(", ")
        );
    }
}

fn display_bundles(style: Style, bundles: &[BundleSummary]) {
    if bundles.is_empty() {
        println!("No bundles available.");
        return;
    }
    println!(
        "{}",
        style.bold(&format!("Available bundles ({}):", bundles.len()))
    );
    println!();
    for bundle in bundles {
        println!(
            "  {} {}",
            style.slug(&bundle.slug),
            status_badge(style, &bundle.status, bundle.enabled)
        );
        if !bundle.description.is_empty() {
            println!(
                "    {}",
                super::skills_api::truncate(&bundle.description, 80)
            );
        }
        if !bundle.skills.is_empty() {
            println!(
                "    {} {}",
                style.label("skills:"),
                bundle.skills.join(", ")
            );
        }
        println!();
    }
    println!("Install one with: bb skills install --bundle <slug>");
}

fn status_label(status: &str, enabled: bool) -> String {
    if enabled {
        status.to_string()
    } else {
        format!("{status}, disabled")
    }
}

/// `[stable]`-style badge: quiet for healthy statuses, yellow when the skill
/// is disabled or deprecated.
fn status_badge(style: Style, status: &str, enabled: bool) -> String {
    let badge = format!("[{}]", status_label(status, enabled));
    if !enabled || status == "deprecated" {
        style.yellow(&badge)
    } else {
        style.dim(&badge)
    }
}

fn yes_no(value: bool) -> &'static str {
    if value {
        "yes"
    } else {
        "no"
    }
}

fn describe_command_tree(command: &Command) -> Value {
    let commands = command
        .get_subcommands()
        .filter(|subcommand| !subcommand.is_hide_set())
        .map(describe_command_tree)
        .collect::<Vec<_>>();
    let mut value = json!({
        "name": command.get_name(),
        "summary": command
            .get_about()
            .map(|about| about.to_string())
            .unwrap_or_default(),
    });
    if !commands.is_empty() {
        value["commands"] = json!(commands);
    }
    value
}

/// Returns a machine-readable description of the `bb skills` command tree
/// for `bb --describe-commands`.
pub fn describe_commands() -> Value {
    describe_command_tree(&skills_command())
}

/// Machine-readable description of the top-level `bb auth` command tree.
pub fn describe_auth_commands() -> Value {
    describe_command_tree(&auth_command())
}

/// Machine-readable description of the top-level `bb config` command tree.
pub fn describe_config_commands() -> Value {
    describe_command_tree(&config_command())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn is_path_like_detects_local_paths() {
        assert!(is_path_like("./my-skill"));
        assert!(is_path_like("../my-skill"));
        assert!(is_path_like("/abs/skill"));
        assert!(is_path_like("~/skills/demo"));
        assert!(is_path_like("dir/skill"));
        assert!(!is_path_like("slack"));
        assert!(!is_path_like("builderbot-tools"));
    }

    #[test]
    fn provenance_suffix_labels_dependencies_and_bundles() {
        assert_eq!(provenance_suffix("explicit"), "");
        assert_eq!(
            provenance_suffix("depends-on:slack"),
            "  (dependency of slack)"
        );
        assert_eq!(
            provenance_suffix("bundle:frontend"),
            "  (from bundle frontend)"
        );
    }

    #[test]
    fn describe_commands_includes_lifecycle_subcommands() {
        let description = describe_commands();
        let names = description["commands"]
            .as_array()
            .expect("commands array")
            .iter()
            .map(|command| command["name"].as_str().expect("name").to_string())
            .collect::<Vec<_>>();
        for expected in [
            "search",
            "list",
            "show",
            "files",
            "bundles",
            "install",
            "update",
            "remove",
            "installed",
            "which",
            "doctor",
        ] {
            assert!(names.contains(&expected.to_string()), "missing {expected}");
        }
        assert!(!names.contains(&"auth".to_string()));
        assert!(!names.contains(&"config".to_string()));
    }

    #[test]
    fn describe_auth_and_config_commands_cover_their_subcommands() {
        let auth = describe_auth_commands();
        assert_eq!(auth["name"], "auth");
        let auth_names = auth["commands"]
            .as_array()
            .expect("auth commands array")
            .iter()
            .map(|command| command["name"].as_str().expect("name").to_string())
            .collect::<Vec<_>>();
        assert_eq!(auth_names, ["status", "login", "logout"]);

        let config = describe_config_commands();
        assert_eq!(config["name"], "config");
        let config_names = config["commands"]
            .as_array()
            .expect("config commands array")
            .iter()
            .map(|command| command["name"].as_str().expect("name").to_string())
            .collect::<Vec<_>>();
        assert_eq!(config_names, ["get", "set", "path"]);
    }
}
