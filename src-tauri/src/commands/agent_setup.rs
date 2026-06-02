use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};

use crate::services::path_env::build_extended_path;

#[derive(Clone, Copy)]
enum InstallCommand {
    Shell(&'static str),
    Platform {
        unix: &'static str,
        windows: &'static str,
    },
}

impl InstallCommand {
    fn current(self) -> &'static str {
        match self {
            InstallCommand::Shell(command) => command,
            InstallCommand::Platform { unix, windows } => {
                if cfg!(target_os = "windows") {
                    windows
                } else {
                    unix
                }
            }
        }
    }
}

struct AgentCommandDef {
    id: &'static str,
    binary_name: &'static str,
    install_command: Option<InstallCommand>,
    install_npm_registry_url: Option<&'static str>,
    auth_command: Option<&'static str>,
    auth_status_command: Option<&'static str>,
}

impl AgentCommandDef {
    fn current_install_command(&self) -> Option<String> {
        let mut command = self.install_command?.current().to_string();

        if let Some(registry_url) = self.install_npm_registry_url {
            command.push_str(" --registry=");
            command.push_str(registry_url);
        }

        Some(command)
    }
}

const BLOCK_NPM_REGISTRY_URL: &str =
    "https://global.block-artifacts.com/artifactory/api/npm/square-npm/";

const CLAUDE_INSTALL_COMMAND: &str =
    "npm install -g @anthropic-ai/claude-code @agentclientprotocol/claude-agent-acp";
const CODEX_INSTALL_COMMAND: &str = "npm install -g @openai/codex @zed-industries/codex-acp";
const COPILOT_INSTALL_COMMAND: &str = "npm install -g @github/copilot";

const AMP_INSTALL_COMMAND_UNIX: &str =
    "curl -fsSL https://ampcode.com/install.sh | bash && npm install -g amp-acp";

const AMP_INSTALL_COMMAND_WINDOWS: &str =
    r#"powershell -c "irm https://ampcode.com/install.ps1 | iex" && npm install -g amp-acp"#;

/// Agent CLI definitions. npm install commands must route through Block's
/// internal Artifactory proxy, because direct registry.npmjs.org access is
/// blocked by Cloudflare WARP dependency-confusion protection.
const AGENT_COMMAND_DEFS: &[AgentCommandDef] = &[
    AgentCommandDef {
        id: "claude-acp",
        binary_name: "claude-agent-acp",
        install_command: Some(InstallCommand::Shell(CLAUDE_INSTALL_COMMAND)),
        install_npm_registry_url: Some(BLOCK_NPM_REGISTRY_URL),
        auth_command: Some("claude auth login"),
        auth_status_command: Some("claude auth status"),
    },
    AgentCommandDef {
        id: "codex-acp",
        binary_name: "codex-acp",
        install_command: Some(InstallCommand::Shell(CODEX_INSTALL_COMMAND)),
        install_npm_registry_url: Some(BLOCK_NPM_REGISTRY_URL),
        auth_command: Some("codex login"),
        auth_status_command: Some("codex login status"),
    },
    AgentCommandDef {
        id: "copilot-acp",
        binary_name: "copilot",
        install_command: Some(InstallCommand::Shell(COPILOT_INSTALL_COMMAND)),
        install_npm_registry_url: Some(BLOCK_NPM_REGISTRY_URL),
        auth_command: Some("copilot login"),
        auth_status_command: None,
    },
    AgentCommandDef {
        id: "amp-acp",
        binary_name: "amp-acp",
        install_command: Some(InstallCommand::Platform {
            unix: AMP_INSTALL_COMMAND_UNIX,
            windows: AMP_INSTALL_COMMAND_WINDOWS,
        }),
        install_npm_registry_url: Some(BLOCK_NPM_REGISTRY_URL),
        auth_command: Some("amp login"),
        auth_status_command: Some("amp usage"),
    },
    AgentCommandDef {
        id: "cursor-agent",
        binary_name: "cursor-agent",
        install_command: Some(InstallCommand::Shell(
            "curl -fsSL https://cursor.com/install | bash",
        )),
        install_npm_registry_url: None,
        auth_command: Some("cursor-agent login"),
        auth_status_command: Some("cursor-agent status"),
    },
    AgentCommandDef {
        id: "pi-acp",
        binary_name: "pi-acp",
        install_command: None,
        install_npm_registry_url: None,
        auth_command: None,
        auth_status_command: None,
    },
];

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AgentSetupOutput {
    provider_id: String,
    line: String,
}

fn find_agent_command_def(provider_id: &str) -> Option<&'static AgentCommandDef> {
    AGENT_COMMAND_DEFS.iter().find(|def| def.id == provider_id)
}

fn get_agent_command_def(provider_id: &str) -> Result<&'static AgentCommandDef, String> {
    find_agent_command_def(provider_id)
        .ok_or_else(|| format!("Unknown agent provider '{provider_id}'"))
}

#[tauri::command]
pub async fn check_agent_installed(provider_id: String) -> Result<bool, String> {
    let def = get_agent_command_def(&provider_id)?;
    let extended_path = build_extended_path().await;

    let (cmd, flag) = if cfg!(target_os = "windows") {
        ("where", "/Q")
    } else {
        ("which", "")
    };

    let mut command = std::process::Command::new(cmd);
    if !flag.is_empty() {
        command.arg(flag);
    }
    command.arg(def.binary_name);
    command.env("PATH", &extended_path);

    Ok(command
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false))
}

#[tauri::command]
pub async fn check_agent_auth(provider_id: String) -> Result<bool, String> {
    let def = get_agent_command_def(&provider_id)?;
    let Some(auth_status_command) = def.auth_status_command else {
        return Ok(false);
    };

    let extended_path = build_extended_path().await;

    let shell = if cfg!(target_os = "windows") {
        "cmd"
    } else {
        "sh"
    };
    let flag = if cfg!(target_os = "windows") {
        "/C"
    } else {
        "-c"
    };

    std::process::Command::new(shell)
        .arg(flag)
        .arg(auth_status_command)
        .env("PATH", &extended_path)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output()
        .map(|output| output.status.success())
        .map_err(|e| format!("Failed to check auth status: {e}"))
}

#[tauri::command]
pub async fn install_agent(app_handle: AppHandle, provider_id: String) -> Result<(), String> {
    let def = get_agent_command_def(&provider_id)?;
    let install_command = def
        .current_install_command()
        .ok_or_else(|| format!("Agent provider '{provider_id}' does not support install"))?;
    run_shell_command(&app_handle, &provider_id, &install_command).await
}

#[tauri::command]
pub async fn authenticate_agent(app_handle: AppHandle, provider_id: String) -> Result<(), String> {
    let def = get_agent_command_def(&provider_id)?;
    let auth_command = def
        .auth_command
        .ok_or_else(|| format!("Agent provider '{provider_id}' does not support auth"))?;
    run_shell_command(&app_handle, &provider_id, auth_command).await
}

fn strip_npm_config_env(cmd: &mut tokio::process::Command) {
    for (key, _) in std::env::vars() {
        if key.starts_with("npm_config") || key.starts_with("NPM_CONFIG") {
            cmd.env_remove(&key);
        }
    }
}

async fn run_shell_command(
    app_handle: &AppHandle,
    provider_id: &str,
    command: &str,
) -> Result<(), String> {
    let extended_path = build_extended_path().await;

    let shell = if cfg!(target_os = "windows") {
        "cmd"
    } else {
        "sh"
    };
    let flag = if cfg!(target_os = "windows") {
        "/C"
    } else {
        "-c"
    };

    let mut child_cmd = tokio::process::Command::new(shell);
    child_cmd
        .arg(flag)
        .arg(command)
        .env("PATH", &extended_path)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    strip_npm_config_env(&mut child_cmd);

    let mut child = child_cmd
        .spawn()
        .map_err(|e| format!("Failed to start command: {e}"))?;

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    let provider_id_owned = provider_id.to_string();
    let app_for_stdout = app_handle.clone();

    let stdout_task = tokio::spawn(async move {
        if let Some(stdout) = stdout {
            let reader = BufReader::new(stdout);
            let mut lines = reader.lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let _ = app_for_stdout.emit(
                    "agent-setup:output",
                    AgentSetupOutput {
                        provider_id: provider_id_owned.clone(),
                        line,
                    },
                );
            }
        }
    });

    let provider_id_owned2 = provider_id.to_string();
    let app_for_stderr = app_handle.clone();

    let stderr_task = tokio::spawn(async move {
        if let Some(stderr) = stderr {
            let reader = BufReader::new(stderr);
            let mut lines = reader.lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let _ = app_for_stderr.emit(
                    "agent-setup:output",
                    AgentSetupOutput {
                        provider_id: provider_id_owned2.clone(),
                        line,
                    },
                );
            }
        }
    });

    let _ = tokio::join!(stdout_task, stderr_task);

    let status = child
        .wait()
        .await
        .map_err(|e| format!("Failed to wait for command: {e}"))?;

    if status.success() {
        Ok(())
    } else {
        let code = status.code().unwrap_or(-1);
        Err(format!("Command exited with code {code}"))
    }
}

#[cfg(test)]
mod tests {
    use super::{
        AgentCommandDef, InstallCommand, AMP_INSTALL_COMMAND_UNIX, AMP_INSTALL_COMMAND_WINDOWS,
        BLOCK_NPM_REGISTRY_URL, CODEX_INSTALL_COMMAND,
    };

    #[test]
    fn npm_install_command_uses_block_registry() {
        let def = AgentCommandDef {
            id: "codex-acp",
            binary_name: "codex-acp",
            install_command: Some(InstallCommand::Shell(CODEX_INSTALL_COMMAND)),
            install_npm_registry_url: Some(BLOCK_NPM_REGISTRY_URL),
            auth_command: None,
            auth_status_command: None,
        };
        let command = def.current_install_command().unwrap();

        assert_eq!(
            command,
            format!(
                "npm install -g @openai/codex @zed-industries/codex-acp --registry={BLOCK_NPM_REGISTRY_URL}",
            ),
        );
    }

    #[test]
    fn amp_install_command_uses_official_cli_and_acp_npm_adapter() {
        let def = AgentCommandDef {
            id: "amp-acp",
            binary_name: "amp-acp",
            install_command: Some(InstallCommand::Shell(AMP_INSTALL_COMMAND_UNIX)),
            install_npm_registry_url: Some(BLOCK_NPM_REGISTRY_URL),
            auth_command: None,
            auth_status_command: None,
        };

        assert_eq!(
            def.current_install_command().unwrap(),
            format!(
                "curl -fsSL https://ampcode.com/install.sh | bash && npm install -g amp-acp --registry={BLOCK_NPM_REGISTRY_URL}",
            ),
        );
        assert_eq!(
            AMP_INSTALL_COMMAND_WINDOWS,
            r#"powershell -c "irm https://ampcode.com/install.ps1 | iex" && npm install -g amp-acp"#,
        );
    }
}
