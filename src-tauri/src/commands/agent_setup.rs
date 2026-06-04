//! Thin shims over the `doctor` crate's check / install / auth APIs.
//!
//! The frontend identifies agents by their provider id (e.g. `claude-acp`)
//! while the crate uses `ai-agent-claude` etc. — [`crate_check_id`] handles
//! the translation at this boundary so the frontend's id space stays stable.

use doctor::FixType;
use tauri::{AppHandle, Emitter};

/// Block's internal Artifactory npm registry. Direct access to
/// `registry.npmjs.org` is blocked by Cloudflare WARP, so npm-backed agent
/// installs must route through this proxy. The doctor crate exposes an optional
/// `npm_registry` param but bakes in no registry of its own, so goose-internal
/// supplies this URL at every fix/run call site (BOT-686).
pub(crate) const BLOCK_NPM_REGISTRY_URL: &str =
    "https://global.block-artifacts.com/artifactory/api/npm/square-npm/";

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AgentSetupOutput {
    provider_id: String,
    line: String,
}

/// Translate a frontend provider id like `claude-acp` / `cursor-agent` into the
/// crate's `ai-agent-<name>` check id.
fn crate_check_id(provider_id: &str) -> String {
    let name = provider_id
        .strip_suffix("-acp")
        .unwrap_or(match provider_id {
            "cursor-agent" => "cursor",
            other => other,
        });
    format!("ai-agent-{name}")
}

async fn find_check(provider_id: &str) -> Result<doctor::DoctorCheck, String> {
    let target = crate_check_id(provider_id);
    let report = doctor::run_checks().await;
    report
        .checks
        .into_iter()
        .find(|check| check.id == target)
        .ok_or_else(|| format!("Unknown agent provider '{provider_id}'"))
}

#[tauri::command]
pub async fn check_agent_installed(provider_id: String) -> Result<bool, String> {
    let check = find_check(&provider_id).await?;
    Ok(check.path.is_some() || check.bridge_path.is_some())
}

#[tauri::command]
pub async fn install_agent(app_handle: AppHandle, provider_id: String) -> Result<(), String> {
    run_fix(app_handle, provider_id, FixType::Command, None).await
}

#[tauri::command]
pub async fn authenticate_agent(app_handle: AppHandle, provider_id: String) -> Result<(), String> {
    run_fix(app_handle, provider_id, FixType::Auth, None).await
}

/// Update an agent binary (main CLI or ACP bridge) using the per-readout
/// source-aware command derived by the doctor crate's freshness pass. The
/// frontend passes the readout's `updateCommand` verbatim as `command_override`
/// so the executor runs it as-is (still routed through `apply_npm_registry`),
/// not the static install recipe.
#[tauri::command]
pub async fn update_agent(
    app_handle: AppHandle,
    provider_id: String,
    fix_type: FixType,
    command_override: String,
) -> Result<(), String> {
    run_fix(app_handle, provider_id, fix_type, Some(command_override)).await
}

async fn run_fix(
    app_handle: AppHandle,
    provider_id: String,
    fix_type: FixType,
    command_override: Option<String>,
) -> Result<(), String> {
    let check_id = crate_check_id(&provider_id);
    let log_tag = format!("[agent-setup {provider_id} {fix_type:?}]");
    let log_tag_for_lines = log_tag.clone();
    let provider_id_for_event = provider_id.clone();
    log::info!("{log_tag} starting fix");
    let result = doctor::execute_fix_streaming_with_options(
        check_id,
        fix_type,
        command_override,
        Some(BLOCK_NPM_REGISTRY_URL),
        move |line| {
            log::info!("{log_tag_for_lines} {line}");
            let _ = app_handle.emit(
                "agent-setup:output",
                AgentSetupOutput {
                    provider_id: provider_id_for_event.clone(),
                    line: line.to_string(),
                },
            );
        },
    )
    .await;
    match &result {
        Ok(()) => log::info!("{log_tag} fix succeeded"),
        Err(error) => log::info!("{log_tag} fix failed: {error}"),
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crate_check_id_strips_acp_suffix() {
        assert_eq!(crate_check_id("claude-acp"), "ai-agent-claude");
        assert_eq!(crate_check_id("codex-acp"), "ai-agent-codex");
        assert_eq!(crate_check_id("copilot-acp"), "ai-agent-copilot");
        assert_eq!(crate_check_id("amp-acp"), "ai-agent-amp");
        assert_eq!(crate_check_id("pi-acp"), "ai-agent-pi");
    }

    #[test]
    fn crate_check_id_maps_cursor_agent() {
        assert_eq!(crate_check_id("cursor-agent"), "ai-agent-cursor");
    }

    #[test]
    fn crate_check_id_passes_through_goose() {
        assert_eq!(crate_check_id("goose"), "ai-agent-goose");
    }
}
