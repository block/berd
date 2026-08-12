use std::fmt::Write as _;
use std::io::Write as _;
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use builderbot_auth::auth_login::build_auth_http_client;
use builderbot_auth::auth_storage::{SessionCredentialStorage, StoredSessionCredential};
use builderbot_auth::workspace::{
    list_workspaces, switch_workspace, ListWorkspacesResponse, Workspace, WorkspaceHttpError,
};
use clap::{Arg, ArgAction, ArgMatches, Command};
use reqwest::header::HeaderValue;
use serde_json::json;

use super::auth_storage::{
    default_session_storage, session_storage_key_from_config, SessionStorageKey,
};
use super::display::{print_json, stdin_is_tty, terminal_safe_text};
use super::runner;
use super::skills_api::{exit_codes, failure};
use super::skills_config::{kgoose_service_url, SkillsConfig};

pub fn command() -> Command {
    Command::new("workspace")
        .about("Manage BuilderBot workspaces")
        .subcommand_required(true)
        .arg_required_else_help(true)
        .disable_help_subcommand(true)
        .subcommand(Command::new("list").about("List accessible workspaces"))
        .subcommand(
            Command::new("switch")
                .about("Switch the active workspace")
                .long_about(
                    "Switch the active BuilderBot workspace. Without --workspace, \
                     lists accessible workspaces and prompts for a selection.",
                )
                .arg(
                    Arg::new("workspace")
                        .long("workspace")
                        .value_name("ID")
                        .help("Workspace identifier; skips interactive selection")
                        .action(ArgAction::Set),
                ),
        )
}

pub fn run(matches: &ArgMatches) -> Result<()> {
    runner::run(matches, dispatch)
}

fn dispatch(config: &SkillsConfig, matches: &ArgMatches) -> Result<()> {
    match matches.subcommand() {
        Some(("list", _)) => run_list(config),
        Some(("switch", switch_matches)) => run_switch(config, switch_matches),
        _ => anyhow::bail!("expected a workspace subcommand"),
    }
}

pub fn describe_commands() -> serde_json::Value {
    super::description::describe_command_tree(&command())
}

fn run_list(config: &SkillsConfig) -> Result<()> {
    runner::ensure_org_configured(config)?;
    let session = WorkspaceSession::load(config)?;
    let response = session.list(config).map_err(map_workspace_request_error)?;

    if config.json {
        return print_json(&response);
    }

    print_workspace_list(config, &response);
    Ok(())
}

fn run_switch(config: &SkillsConfig, matches: &ArgMatches) -> Result<()> {
    runner::ensure_org_configured(config)?;
    let session = WorkspaceSession::load(config)?;
    let requested_workspace = matches
        .get_one::<String>("workspace")
        .map(|value| value.trim())
        .filter(|value| !value.is_empty());
    let workspace_identifier = match requested_workspace {
        Some(identifier) => identifier.to_string(),
        None if config.json => {
            return Err(failure(
                exit_codes::GENERAL,
                "workspace_required",
                "`bb workspace switch --json` requires --workspace <ID>",
            ))
        }
        None if !stdin_is_tty() => {
            return Err(failure(
                exit_codes::GENERAL,
                "workspace_required",
                "Non-interactive shell — pass --workspace <ID>",
            ))
        }
        None => {
            let response = session.list(config).map_err(map_workspace_request_error)?;
            prompt_for_workspace(config, &response)?
        }
    };

    let response = session
        .switch(config, &workspace_identifier)
        .map_err(map_workspace_request_error)?;
    let switched = if let Some(new_credential) = response.session_credential {
        if new_credential.trim().is_empty() {
            anyhow::bail!(
                "/v1/workspaces/switch returned an empty replacement credential; run `bb auth login`"
            );
        }
        HeaderValue::from_str(&new_credential).context(
            "/v1/workspaces/switch returned an invalid replacement credential; run `bb auth login`",
        )?;
        session
            .storage
            .set(
                &session.storage_key,
                &StoredSessionCredential {
                    session_credential: new_credential,
                    expires_at: session.credential.expires_at.clone(),
                },
            )
            .context(
                "store rotated workspace credential; the previous credential is invalid, so run `bb auth login` to recover",
            )?;
        true
    } else {
        false
    };
    let workspace = response
        .workspace
        .context("/v1/workspaces/switch returned no workspace")?;

    if config.json {
        return print_json(&json!({
            "workspace": workspace,
            "switched": switched,
        }));
    }

    let display_name = workspace
        .display_name
        .as_deref()
        .filter(|name| !name.trim().is_empty())
        .unwrap_or("Unnamed workspace");
    let identifier = workspace
        .workspace_identifier
        .as_deref()
        .unwrap_or(&workspace_identifier);
    if switched {
        config.style.success(&format!(
            "Switched to {} ({})",
            terminal_safe_text(display_name),
            terminal_safe_text(identifier)
        ));
    } else {
        config.style.info(&format!(
            "{} ({}) is already active",
            terminal_safe_text(display_name),
            terminal_safe_text(identifier)
        ));
    }
    Ok(())
}

struct WorkspaceSession {
    storage: Box<dyn SessionCredentialStorage>,
    storage_key: SessionStorageKey,
    credential: StoredSessionCredential,
}

impl WorkspaceSession {
    fn load(config: &SkillsConfig) -> Result<Self> {
        let storage = default_session_storage(config)?;
        let storage_key = session_storage_key_from_config(config);
        let credential = storage.get(&storage_key)?.ok_or_else(auth_required_error)?;
        if credential.session_credential_header_value().is_none() {
            return Err(auth_required_error());
        }
        Ok(Self {
            storage,
            storage_key,
            credential,
        })
    }

    fn list(&self, config: &SkillsConfig) -> Result<ListWorkspacesResponse> {
        let client = build_auth_http_client(Duration::from_secs(30))?;
        list_workspaces(
            &client,
            config.playpen.as_deref(),
            &kgoose_service_url(&config.kgoose_base_url, &config.kgoose_service_path),
            &self.credential,
        )
    }

    fn switch(
        &self,
        config: &SkillsConfig,
        workspace_identifier: &str,
    ) -> Result<builderbot_auth::workspace::SwitchWorkspaceResponse> {
        let client = build_auth_http_client(Duration::from_secs(30))?;
        switch_workspace(
            &client,
            config.playpen.as_deref(),
            &kgoose_service_url(&config.kgoose_base_url, &config.kgoose_service_path),
            &self.credential,
            workspace_identifier,
        )
    }
}

fn auth_required_error() -> anyhow::Error {
    failure(
        exit_codes::AUTH_REQUIRED,
        "auth_required",
        "BuilderBot CLI auth is required; run `bb auth login`",
    )
}

fn map_workspace_request_error(error: anyhow::Error) -> anyhow::Error {
    let Some(http_error) = error.downcast_ref::<WorkspaceHttpError>() else {
        return error;
    };
    match http_error.status {
        401 => auth_required_error(),
        403 => failure(
            exit_codes::FORBIDDEN,
            "forbidden",
            format!("workspace request is forbidden: {}", http_error.body),
        ),
        _ => error,
    }
}

fn print_workspace_list(config: &SkillsConfig, response: &ListWorkspacesResponse) {
    if response.workspaces.is_empty() {
        println!("No workspaces found.");
        return;
    }
    for workspace in &response.workspaces {
        let active = workspace.workspace_identifier.as_deref()
            == response.active_workspace_identifier.as_deref();
        println!("{}", workspace_line(config, workspace, active));
    }
}

fn prompt_for_workspace(
    config: &SkillsConfig,
    response: &ListWorkspacesResponse,
) -> Result<String> {
    if response.workspaces.is_empty() {
        anyhow::bail!("No workspaces are available to switch to");
    }
    eprintln!("Select a workspace:");
    for (index, workspace) in response.workspaces.iter().enumerate() {
        let active = workspace.workspace_identifier.as_deref()
            == response.active_workspace_identifier.as_deref();
        eprintln!(
            "  {}) {}",
            index + 1,
            workspace_line(config, workspace, active)
        );
    }
    eprint!("Selection: ");
    std::io::stderr()
        .flush()
        .context("flush workspace prompt")?;
    let mut answer = String::new();
    std::io::stdin()
        .read_line(&mut answer)
        .context("read workspace selection")?;
    select_workspace(&response.workspaces, &answer)
}

fn select_workspace(workspaces: &[Workspace], answer: &str) -> Result<String> {
    let selection = answer
        .trim()
        .parse::<usize>()
        .ok()
        .filter(|selection| (1..=workspaces.len()).contains(selection))
        .ok_or_else(|| anyhow!("Enter a workspace number from 1 to {}", workspaces.len()))?;
    workspaces[selection - 1]
        .workspace_identifier
        .clone()
        .filter(|identifier| !identifier.trim().is_empty())
        .context("Selected workspace has no identifier")
}

fn workspace_line(config: &SkillsConfig, workspace: &Workspace, active: bool) -> String {
    let display_name = workspace
        .display_name
        .as_deref()
        .filter(|name| !name.trim().is_empty())
        .unwrap_or("Unnamed workspace");
    let identifier = workspace
        .workspace_identifier
        .as_deref()
        .unwrap_or("unknown");
    let mut line = format!(
        "{}  {}",
        terminal_safe_text(display_name),
        config.style.dim(&terminal_safe_text(identifier))
    );
    if active {
        write!(line, "  {}", config.style.green("(active)"))
            .expect("writing to a String cannot fail");
    }
    line
}

#[cfg(test)]
mod tests {
    use super::*;

    fn workspace(identifier: Option<&str>) -> Workspace {
        Workspace {
            workspace_identifier: identifier.map(str::to_string),
            display_name: Some("Test".to_string()),
            roles: vec![],
        }
    }

    #[test]
    fn selection_resolves_one_based_workspace_number() {
        let workspaces = vec![
            workspace(Some("workspace-one")),
            workspace(Some("workspace-two")),
        ];

        assert_eq!(
            select_workspace(&workspaces, "2\n").expect("selection"),
            "workspace-two"
        );
    }

    #[test]
    fn selection_rejects_invalid_number_and_missing_identifier() {
        let workspaces = vec![workspace(Some("workspace-one")), workspace(None)];

        assert!(select_workspace(&workspaces, "3").is_err());
        assert!(select_workspace(&workspaces, "2").is_err());
    }
}
