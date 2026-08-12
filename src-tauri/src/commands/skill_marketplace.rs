//! Skill marketplace discovery.
//!
//! Bridges the renderer to the `sq agents skills` CLI so users can browse the
//! full catalog of Block skills (not just the ones they already have enabled)
//! and install them without leaving the app.
//!
//! Design notes:
//! - The CLI is the source of truth for the remote catalog and, crucially, for
//!   the install/symlink wiring (`~/.agents/skills` plus the per-agent symlink
//!   farm under `~/.claude`, `~/.cursor`, `~/.codex`, ...). Shelling out keeps
//!   that logic in one place instead of duplicating it in the app.
//! - We resolve the binary through the same extended-PATH machinery the rest of
//!   the app uses for external tools, so Finder-launched builds still find `sq`.
//! - All calls are time-boxed; a missing or hung CLI degrades to a structured
//!   error the renderer can render as "install the CLI" rather than hanging.

use std::process::Stdio;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::process::Command;
use tokio::time::timeout;

use crate::services::path_env;

/// Upper bound for listing the remote catalog. `list-remote` hits the network
/// and can be slow on a cold cache, so give it generous headroom.
const LIST_TIMEOUT: Duration = Duration::from_secs(45);
/// `show-remote` fetches a single SKILL.md.
const SHOW_TIMEOUT: Duration = Duration::from_secs(30);
/// Installs clone + symlink; can be slower than a read.
const INSTALL_TIMEOUT: Duration = Duration::from_secs(120);
/// `list-local` and `--version` are cheap, local-only calls.
const QUICK_TIMEOUT: Duration = Duration::from_secs(15);

/// Raw shape of one entry from `sq agents skills list-remote --json`.
#[derive(Debug, Deserialize)]
struct RemoteSkillRaw {
    name: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    roles: Option<Vec<String>>,
    #[serde(default)]
    references: Option<Vec<String>>,
    #[serde(default)]
    metadata: Option<RemoteSkillMetadataRaw>,
}

#[derive(Debug, Deserialize)]
struct RemoteSkillMetadataRaw {
    #[serde(default)]
    author: Option<String>,
    #[serde(default)]
    status: Option<String>,
}

/// Raw shape of one entry from `sq agents skills list-local --json`. We only
/// need the name to compute which remote skills are already installed.
#[derive(Debug, Deserialize)]
struct LocalSkillRaw {
    name: String,
}

/// A remote skill, annotated with whether it is already installed locally.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteSkill {
    pub name: String,
    pub description: String,
    pub roles: Vec<String>,
    pub references: Vec<String>,
    pub author: Option<String>,
    pub status: Option<String>,
    pub installed: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteSkillCatalog {
    pub skills: Vec<RemoteSkill>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallSkillRequest {
    pub name: String,
    /// When set, install into the current project (`--project`) rather than
    /// globally. The renderer passes the active project's working directory.
    #[serde(default)]
    pub project_dir: Option<String>,
}

/// Availability of the `sq agents skills` CLI, so the renderer can show an
/// actionable "install the CLI" state instead of a dead marketplace.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillCliStatus {
    pub available: bool,
    pub version: Option<String>,
}

/// Build the environment (PATH + captured login-shell vars) used for every
/// `sq` invocation. Mirrors how the app resolves other external tools.
async fn sq_command() -> Command {
    let vars = path_env::home_env_vars_with_extended_path_and_prepended_dirs(&[]).await;
    let mut command = Command::new("sq");
    command.env_clear();
    for (key, value) in vars {
        command.env(key, value);
    }
    command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    crate::services::process::apply_no_window_async(&mut command);
    command
}

async fn run_sq(args: &[&str], command_timeout: Duration) -> Result<Vec<u8>, String> {
    let mut command = sq_command().await;
    command.args(args);

    let output = timeout(command_timeout, command.output())
        .await
        .map_err(|_| {
            format!(
                "`sq {}` timed out after {}s",
                args.join(" "),
                command_timeout.as_secs()
            )
        })?
        .map_err(|error| {
            format!(
                "Failed to run `sq {}`: {error}. Is the sq-agents CLI installed?",
                args.join(" ")
            )
        })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let trimmed = stderr.trim();
        let detail = if trimmed.is_empty() {
            format!("exited with status {}", output.status)
        } else {
            trimmed.to_string()
        };
        return Err(format!("`sq {}` failed: {detail}", args.join(" ")));
    }

    Ok(output.stdout)
}

/// Report whether `sq agents skills` is available and, if so, its version.
#[tauri::command]
pub async fn skill_cli_status() -> SkillCliStatus {
    match run_sq(&["agents", "--version"], QUICK_TIMEOUT).await {
        Ok(stdout) => {
            let version = String::from_utf8_lossy(&stdout).trim().to_string();
            SkillCliStatus {
                available: true,
                version: (!version.is_empty()).then_some(version),
            }
        }
        Err(_) => SkillCliStatus {
            available: false,
            version: None,
        },
    }
}

async fn installed_skill_names() -> std::collections::HashSet<String> {
    match run_sq(&["agents", "skills", "list-local", "--json"], QUICK_TIMEOUT).await {
        Ok(stdout) => match serde_json::from_slice::<Vec<LocalSkillRaw>>(&stdout) {
            Ok(skills) => skills.into_iter().map(|skill| skill.name).collect(),
            Err(error) => {
                log::warn!("Could not parse local skill list: {error}");
                std::collections::HashSet::new()
            }
        },
        Err(error) => {
            log::warn!("Could not list local skills: {error}");
            std::collections::HashSet::new()
        }
    }
}

/// List the remote skill catalog, annotated with local install state.
#[tauri::command]
pub async fn list_remote_skills() -> Result<RemoteSkillCatalog, String> {
    // `--include-team` surfaces team-scoped skills alongside public ones;
    // without it `list-remote` omits team skills, so Discover would silently
    // hide part of the catalog and users would still need go/skills.
    let stdout = run_sq(
        &[
            "agents",
            "skills",
            "list-remote",
            "--include-team",
            "--json",
        ],
        LIST_TIMEOUT,
    )
    .await?;

    let raw: Vec<RemoteSkillRaw> = serde_json::from_slice(&stdout)
        .map_err(|error| format!("Could not parse skill catalog: {error}"))?;

    let installed = installed_skill_names().await;

    let skills = raw
        .into_iter()
        .map(|entry| {
            let (author, status) = entry
                .metadata
                .map(|meta| (meta.author, meta.status))
                .unwrap_or((None, None));
            RemoteSkill {
                installed: installed.contains(&entry.name),
                name: entry.name,
                description: entry.description,
                roles: entry.roles.unwrap_or_default(),
                references: entry.references.unwrap_or_default(),
                author,
                status,
            }
        })
        .collect();

    Ok(RemoteSkillCatalog { skills })
}

/// Fetch the full SKILL.md for a single remote skill (for the detail preview).
#[tauri::command]
pub async fn show_remote_skill(name: String) -> Result<String, String> {
    validate_skill_name(&name)?;
    let stdout = run_sq(&["agents", "skills", "show-remote", &name], SHOW_TIMEOUT).await?;
    Ok(String::from_utf8_lossy(&stdout).to_string())
}

/// Install a remote skill globally, or into the active project with
/// `--project`. Returns the CLI's stdout for surfacing to the user.
#[tauri::command]
pub async fn install_remote_skill(request: InstallSkillRequest) -> Result<String, String> {
    validate_skill_name(&request.name)?;

    let mut command = sq_command().await;
    command.args(["agents", "skills", "add"]);

    if let Some(project_dir) = request.project_dir.as_deref() {
        if !project_dir.trim().is_empty() {
            // `--project` installs to ./.agents/skills/<name> relative to cwd,
            // so run the CLI in the target project directory.
            command.current_dir(project_dir);
            command.arg("--project");
        }
    }

    // Pass the (validated) skill name after an end-of-options separator so a
    // name can never be reinterpreted as a flag.
    command.args(["--", &request.name]);

    let output = timeout(INSTALL_TIMEOUT, command.output())
        .await
        .map_err(|_| {
            format!(
                "Installing \"{}\" timed out after {}s",
                request.name,
                INSTALL_TIMEOUT.as_secs()
            )
        })?
        .map_err(|error| format!("Failed to install \"{}\": {error}", request.name))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let trimmed = stderr.trim();
        let detail = if trimmed.is_empty() {
            format!("exited with status {}", output.status)
        } else {
            trimmed.to_string()
        };
        return Err(format!("Failed to install \"{}\": {detail}", request.name));
    }

    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// Guard against argument injection: skill names are a constrained slug. A
/// leading hyphen is rejected so a name can never be parsed as a CLI flag (in
/// addition to the `--` separator used at the call site).
fn validate_skill_name(name: &str) -> Result<(), String> {
    let valid = !name.is_empty()
        && name.len() <= 128
        && !name.starts_with('-')
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if valid {
        Ok(())
    } else {
        Err(format!("Invalid skill name: {name:?}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_skill_name_accepts_slugs() {
        assert!(validate_skill_name("agent-browser").is_ok());
        assert!(validate_skill_name("ach_tables").is_ok());
        assert!(validate_skill_name("a11y-web-audit-and-fix").is_ok());
    }

    #[test]
    fn validate_skill_name_rejects_injection() {
        assert!(validate_skill_name("").is_err());
        assert!(validate_skill_name("foo; rm -rf /").is_err());
        assert!(validate_skill_name("../escape").is_err());
        assert!(validate_skill_name("has space").is_err());
        // Leading hyphens are rejected so a name can't be parsed as a CLI flag.
        assert!(validate_skill_name("--project").is_err());
        assert!(validate_skill_name("-x").is_err());
    }

    #[test]
    fn parses_remote_catalog_shape() {
        let json = r#"[
            {"name":"a","description":"desc","roles":["risk"],"references":["evident"],"metadata":{"author":"me","status":"experimental"}},
            {"name":"b","treeSha":"abc"}
        ]"#;
        let raw: Vec<RemoteSkillRaw> = serde_json::from_str(json).unwrap();
        assert_eq!(raw.len(), 2);
        assert_eq!(raw[0].name, "a");
        assert_eq!(raw[0].roles.as_ref().unwrap(), &["risk"]);
        assert!(raw[1].roles.is_none());
    }
}
