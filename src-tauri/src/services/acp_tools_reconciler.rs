//! Startup reconciler for the Berd-managed ACP bridges.
//!
//! Spawned from app setup (same pattern as `app_data_migration`): installs or
//! upgrades every managed bridge ([`managed_acp_tools::MANAGED_TOOLS`]) to the
//! latest published version on launch, so a new bridge release ships to users
//! the next time Berd starts. Each install runs a floating
//! `npm install <pkg>@latest` onto the Berd-managed Node runtime in app data.
//! Failures are logged, recorded in `packages/state.json`, and retried on the next
//! launch; a previously installed version keeps working in the meantime, so an
//! offline launch never removes a working bridge. Superseded managed Node
//! runtimes are pruned only in the epilogue of a fully-successful run — every
//! bridge shim execs its Node by absolute versioned path, so the old runtime
//! must outlive the last shim that references it.
//!
//! Silent when there is nothing to manage: the `BERD_ACP_TOOLS_DIR` dev
//! override is active, the `no-managed-acp-tools` build feature is set, or the
//! target is unsupported.
//!
//! Completion is broadcast to the renderer as [`ACP_TOOLS_RECONCILED_EVENT`]:
//! on a fresh profile the frontend caches its Doctor report (bridges missing)
//! long before the reconciler finishes downloading Node and installing the
//! bridges, and nothing re-probes on its own — without a signal the agent
//! picker keeps offering "Install" for bridges that are already installed
//! until the user opens Settings or restarts.

use tauri::{AppHandle, Emitter};

use crate::services::managed_acp_tools;

/// Emitted once per launch after the reconciler finishes, successful or not —
/// a partial failure still installs the other bridge, so the renderer should
/// re-probe either way. Mirrored in `src/shared/api/acpTools.ts`.
pub const ACP_TOOLS_RECONCILED_EVENT: &str = "berd:acp-tools-reconciled";

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AcpToolsReconciledPayload {
    ok: bool,
    provider_ids: Vec<&'static str>,
}

pub fn spawn_startup_reconcile(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        reconcile(app).await;
    });
}

async fn reconcile(app: AppHandle) {
    let tools = managed_acp_tools::managed_tools();
    if tools.is_empty() {
        return;
    }

    let mut errors = Vec::new();
    for tool in &tools {
        let log_prefix = format!("[acp-tools reconcile {}]", tool.id);
        let on_line = |line: &str| log::info!("{log_prefix} {line}");
        match managed_acp_tools::install_managed_tool(&app, tool.id, &on_line).await {
            Ok(()) => log::info!("{log_prefix} {} is up to date", tool.package),
            Err(error) => {
                log::warn!("{log_prefix} install failed (will retry next launch): {error}");
                errors.push(format!("{}: {error}", tool.id));
            }
        }
    }
    let ok = errors.is_empty();
    managed_acp_tools::finish_reconcile(&app, &tools, errors).await;

    if let Err(error) = app.emit(
        ACP_TOOLS_RECONCILED_EVENT,
        AcpToolsReconciledPayload {
            ok,
            provider_ids: tools.iter().map(|tool| tool.id).collect(),
        },
    ) {
        log::warn!("failed to emit {ACP_TOOLS_RECONCILED_EVENT}: {error}");
    }
}
