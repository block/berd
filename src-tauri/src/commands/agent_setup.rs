//! Backend-owned AI-agent install / update / auth setup state.
//!
//! The Rust backend is the source of truth for an agent provider's setup
//! progress: a spawned tokio task owns the whole multi-step fix chain and
//! writes phase / streamed output / status into [`AgentSetupRegistry`], a
//! managed Tauri state keyed by provider id. The frontend only *kicks off*
//! (`start_agent_setup`) and *observes* (the `agent-setup:state` event +
//! `list_agent_setup_status` rehydration) the operation, so progress survives
//! navigating away, coming back, and a full window reload — and the fix chain
//! keeps advancing the whole time because it no longer lives in the card.
//!
//! Thin shims over the `doctor` crate's check / install / auth APIs still do
//! the actual work. The frontend identifies agents by their provider id (e.g.
//! `claude-acp`) while the crate uses `ai-agent-claude` etc. —
//! [`crate_check_id`] handles the translation at this boundary so the
//! frontend's id space stays stable.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};

use crate::services::{
    distro_bundle::DistroBundleState, managed_acp_tools, managed_node, path_env,
};
use doctor::FixType;
use tauri::{AppHandle, Emitter, Manager, State};

pub(crate) fn npm_registry(app: &AppHandle) -> Option<String> {
    app.try_state::<DistroBundleState>()
        .and_then(|state| npm_registry_for_distro(state.inner()))
}

pub(crate) fn npm_registry_for_distro(distro_state: &DistroBundleState) -> Option<String> {
    npm_registry_for_distribution(distro_state.distribution_config())
}

fn npm_registry_for_distribution(
    distribution: Option<&crate::services::distro_bundle::DistributionDistroConfig>,
) -> Option<String> {
    distribution.map(|config| config.npm_registry_url().to_string())
}

/// Cap the buffered output so emitting the full snapshot on every streamed line
/// stays cheap and the event payload stays bounded. Lifted from the frontend
/// card (which used the same 50-line window) into the backend now that the
/// registry owns the buffer.
const MAX_OUTPUT_LINES: usize = 50;

/// Coarse TTL backstop: a terminal (`succeeded`/`failed`) entry is swept on the
/// next registry write once it is older than this, so a result is never
/// orphaned if its card never mounts again to call `clear_agent_setup_status`.
/// `running` entries are never swept.
const GC_TTL_MS: u64 = 10 * 60 * 1000;

/// Which user action kicked off the operation. `install` and `update` share the
/// same plan-driven chain; only `auth` takes the small sign-in branch.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SetupAction {
    Install,
    Update,
    Auth,
}

/// The current step of the chain. Drives the card's progress label.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
enum SetupPhase {
    Idle,
    Checking,
    Installing,
    Authenticating,
    /// Downloading/installing the Berd-managed Node.js runtime an npm-backed
    /// fix is about to run on.
    PreparingRuntime,
}

/// Lifecycle of an operation. Terminal states (`succeeded`/`failed`) persist
/// long enough for a reloaded card to read the result, then are GC'd.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
enum SetupStatus {
    Running,
    Succeeded,
    Failed,
}

/// One agent provider's in-flight (or just-finished) setup operation. The whole
/// snapshot is emitted on every change — it is small and bounded, so the store
/// can replace its view wholesale with no incremental-merge to get wrong.
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupOperation {
    action: SetupAction,
    phase: SetupPhase,
    status: SetupStatus,
    /// Bounded to [`MAX_OUTPUT_LINES`]; the streamed doctor fix output.
    output: Vec<String>,
    /// On failure, either a sentinel the card localizes (e.g.
    /// `installVerificationFailed`) or the raw command error.
    error: Option<String>,
    /// For the GC backstop. Milliseconds since the Unix epoch.
    updated_at_ms: u64,
}

impl SetupOperation {
    fn running(action: SetupAction) -> Self {
        SetupOperation {
            action,
            phase: initial_phase(action),
            status: SetupStatus::Running,
            output: Vec::new(),
            error: None,
            updated_at_ms: now_ms(),
        }
    }
}

/// The renderer-selectable install fix identity. Narrowed to the two *install*
/// slots so a forged `auth` / `updateMain` / `updateBridge` cannot deserialize
/// into the install seed at all; the backend still re-authorizes the value
/// against the provider's current doctor state before running it (see
/// [`authorize_install_seed`]). The TypeScript contract mirrors this, but the
/// narrow wire type — not the TS `Extract<>` — is the security boundary.
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum InstallFixType {
    Command,
    Bridge,
}

impl From<InstallFixType> for FixType {
    fn from(value: InstallFixType) -> Self {
        match value {
            InstallFixType::Command => FixType::Command,
            InstallFixType::Bridge => FixType::Bridge,
        }
    }
}

/// The narrow wire type for a per-readout update slot. Only the two update
/// families deserialize here; a forged `command`/`bridge`/`auth` fix can't cross
/// the wire in the update list, and — combined with [`authorize_update_fixes`]'s
/// duplicate rejection — a compromised renderer can't submit the same slot N
/// times to rerun the trusted update command N times off one freshness
/// snapshot. Mirrors [`InstallFixType`]: the narrow wire type, not the TS
/// `Extract<>`, is the security boundary.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum UpdateFixType {
    UpdateMain,
    UpdateBridge,
}

impl From<UpdateFixType> for FixType {
    fn from(value: UpdateFixType) -> Self {
        match value {
            UpdateFixType::UpdateMain => FixType::UpdateMain,
            UpdateFixType::UpdateBridge => FixType::UpdateBridge,
        }
    }
}

/// The execution recipe captured at click time. Keeping readout *derivation* in
/// TS (it already has the doctor report) avoids porting `actionableReadouts`
/// into Rust; the backend just runs the recipe autonomously so the chain
/// survives reload.
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupPlan {
    /// The install recipe to seed the install loop with (`command` for the main
    /// CLI, `bridge` for a missing ACP bridge). `null` for a pure update/auth.
    /// Only the two install variants can deserialize here; the backend still
    /// re-authorizes it against the provider's current doctor state before
    /// running it (see [`authorize_install_seed`]).
    #[serde(default)]
    install_fix_type: Option<InstallFixType>,
    /// Per-readout update fix identities to run after the install loop. Only
    /// `updateMain` / `updateBridge` are valid (enforced by the narrow
    /// [`UpdateFixType`] wire type); the exact source-aware command is resolved
    /// by the backend from the crate's trusted freshness readout, never supplied
    /// verbatim by the renderer. Duplicate slots are rejected before dispatch
    /// (see [`authorize_update_fixes`]) so a compromised renderer can't rerun the
    /// trusted update command N times off one freshness snapshot.
    #[serde(default)]
    update_fix_types: Vec<UpdateFixType>,
    /// Whether the post-fix step probes PATH to confirm the agent resolved on
    /// disk. The frontend sends `hasBinary && !isBuiltIn`: a built-in or
    /// binary-less provider has nothing to resolve, so a clean fix run is taken
    /// as success — mirroring the old in-card `refreshInstallStatus`
    /// short-circuit (`isBuiltIn || !hasBinary => installed`). Defaults to
    /// `false` so an omitted flag skips verification rather than fabricating a
    /// failure against the absent doctor check.
    #[serde(default)]
    verify_install: bool,
    /// Whether Berd bundles this provider's ACP bridge. The bridge vendors the
    /// full harness CLI, so it is the provider's only binary and the doctor
    /// crate reports it under `path`. The frontend readiness gate
    /// (`readinessFromReport`) treats a bundled-bridge provider with no
    /// resolved `path` as not installed (the bundle itself is broken), so
    /// post-fix verification must apply the same gate — otherwise a clean fix
    /// run would verify as success and the card would immediately flip back
    /// to not_installed, an install-succeeds/still-broken loop.
    #[serde(default)]
    bundled_bridge: bool,
}

/// Managed Tauri state: `providerId -> SetupOperation`. Keying by provider lets
/// installs across different providers run concurrently. The spawned task owns
/// an `Arc` clone so it keeps writing after `start_agent_setup` returns.
#[derive(Default, Clone)]
pub struct AgentSetupRegistry(Arc<Mutex<HashMap<String, SetupOperation>>>);

impl AgentSetupRegistry {
    fn lock(&self) -> MutexGuard<'_, HashMap<String, SetupOperation>> {
        // Tolerate a poisoned mutex: the map is plain data and a panic in one
        // operation must not wedge every other provider's setup.
        self.0.lock().unwrap_or_else(|poison| poison.into_inner())
    }

    /// Idempotent start. If an operation is already `running` for this provider,
    /// returns `(false, snapshot)` and leaves it untouched (a reloaded card
    /// re-fires `start` on mount; this guard prevents a double-start).
    /// Otherwise seeds a fresh running operation, replacing any terminal entry,
    /// and returns `(true, snapshot)` so the caller spawns the task.
    fn begin(&self, provider_id: &str, action: SetupAction) -> (bool, SetupOperation) {
        let mut map = self.lock();
        if let Some(existing) = map.get(provider_id) {
            if existing.status == SetupStatus::Running {
                return (false, existing.clone());
            }
        }
        sweep_terminal(&mut map, now_ms(), GC_TTL_MS);
        let operation = SetupOperation::running(action);
        map.insert(provider_id.to_string(), operation.clone());
        (true, operation)
    }

    /// Apply `mutate` to the provider's operation (if present), bump
    /// `updated_at_ms`, GC stale terminal entries, and return the new snapshot.
    fn mutate(
        &self,
        provider_id: &str,
        mutate: impl FnOnce(&mut SetupOperation),
    ) -> Option<SetupOperation> {
        let mut map = self.lock();
        let snapshot = {
            let operation = map.get_mut(provider_id)?;
            mutate(operation);
            operation.updated_at_ms = now_ms();
            operation.clone()
        };
        sweep_terminal(&mut map, now_ms(), GC_TTL_MS);
        Some(snapshot)
    }

    fn get(&self, provider_id: &str) -> Option<SetupOperation> {
        self.lock().get(provider_id).cloned()
    }

    fn list(&self) -> Vec<(String, SetupOperation)> {
        self.lock()
            .iter()
            .map(|(id, operation)| (id.clone(), operation.clone()))
            .collect()
    }

    fn remove(&self, provider_id: &str) {
        self.lock().remove(provider_id);
    }
}

fn initial_phase(action: SetupAction) -> SetupPhase {
    match action {
        SetupAction::Auth => SetupPhase::Authenticating,
        SetupAction::Install | SetupAction::Update => SetupPhase::Installing,
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

/// Drop terminal entries older than `ttl_ms`. `running` operations are kept
/// regardless of age so an in-flight chain is never swept out from under itself.
fn sweep_terminal(map: &mut HashMap<String, SetupOperation>, now_ms: u64, ttl_ms: u64) {
    map.retain(|_, operation| {
        operation.status == SetupStatus::Running
            || now_ms.saturating_sub(operation.updated_at_ms) < ttl_ms
    });
}

/// Append a streamed line into the bounded output buffer (oldest lines drop
/// first once the cap is hit).
fn push_output_line(output: &mut Vec<String>, line: &str) {
    output.push(line.to_string());
    if output.len() > MAX_OUTPUT_LINES {
        let overflow = output.len() - MAX_OUTPUT_LINES;
        output.drain(0..overflow);
    }
}

/// The next install recipe to run, or `None` to stop the loop. A fix runs only
/// if one is pending *and* it hasn't run yet, so each recipe runs at most once
/// (≤2 passes) — terminating a stuck install whose re-probe keeps returning the
/// same type instead of spinning forever.
fn next_install_fix(pending: &Option<FixType>, ran: &[FixType]) -> Option<FixType> {
    match pending {
        Some(fix) if !ran.contains(fix) => Some(fix.clone()),
        _ => None,
    }
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentSetupStateEvent {
    provider_id: String,
    operation: SetupOperation,
}

fn emit_state(app: &AppHandle, provider_id: &str, operation: &SetupOperation) {
    let _ = app.emit(
        "agent-setup:state",
        AgentSetupStateEvent {
            provider_id: provider_id.to_string(),
            operation: operation.clone(),
        },
    );
}

/// Mutate the operation and emit the resulting snapshot in one step. A no-op if
/// the entry was already cleared (e.g. the card consumed a terminal state).
fn apply_and_emit(
    app: &AppHandle,
    registry: &AgentSetupRegistry,
    provider_id: &str,
    mutate: impl FnOnce(&mut SetupOperation),
) {
    if let Some(operation) = registry.mutate(provider_id, mutate) {
        emit_state(app, provider_id, &operation);
    }
}

fn append_output(app: &AppHandle, registry: &AgentSetupRegistry, provider_id: &str, line: &str) {
    apply_and_emit(app, registry, provider_id, |operation| {
        push_output_line(&mut operation.output, line);
    });
}

fn set_phase(app: &AppHandle, registry: &AgentSetupRegistry, provider_id: &str, phase: SetupPhase) {
    apply_and_emit(app, registry, provider_id, |operation| {
        operation.phase = phase;
    });
}

/// Translate a frontend provider id like `claude-acp` / `cursor-agent` into the
/// crate's `ai-agent-<name>` check id.
pub(crate) fn crate_check_id(provider_id: &str) -> String {
    let name = provider_id
        .strip_suffix("-acp")
        .unwrap_or(match provider_id {
            "cursor-agent" => "cursor",
            other => other,
        });
    format!("ai-agent-{name}")
}

/// Binary search dirs for checks and fixes: the managed bridge shims in
/// `packages/bin` (or the `BERD_ACP_TOOLS_DIR` dev override), then the
/// Berd-private npm prefix and the managed Node runtime its shims run on.
/// Bridges resolve only from managed installs — nothing ships inside the
/// bundle anymore.
fn setup_prepend_dirs(app: &AppHandle) -> Vec<std::path::PathBuf> {
    managed_acp_tools::managed_prepend_dirs(app)
}

/// The env snapshot every check/fix subprocess runs with: the captured home
/// shell env with the extended PATH, plus the managed npm env steering global
/// installs into the Berd-private prefix.
async fn setup_env_vars(app: &AppHandle) -> Vec<(String, String)> {
    let prepend_dirs = setup_prepend_dirs(app);
    let mut vars =
        path_env::home_env_vars_with_extended_path_and_prepended_dirs(&prepend_dirs).await;
    managed_acp_tools::apply_managed_npm_env(&mut vars, &managed_acp_tools::managed_npm_env(app));
    vars
}

async fn find_check(app: &AppHandle, provider_id: &str) -> Result<doctor::DoctorCheck, String> {
    find_check_with_options(app, provider_id, false).await
}

/// Like [`find_check`], but runs the crate's freshness pass so the returned
/// check carries populated per-readout `update_command` / `update_fix_type`
/// fields. Used to resolve the source-aware update command for a requested
/// update fix from trusted crate state, rather than trusting a renderer string.
async fn find_check_fresh(
    app: &AppHandle,
    provider_id: &str,
) -> Result<doctor::DoctorCheck, String> {
    find_check_with_options(app, provider_id, true).await
}

async fn find_check_with_options(
    app: &AppHandle,
    provider_id: &str,
    check_freshness: bool,
) -> Result<doctor::DoctorCheck, String> {
    let target = crate_check_id(provider_id);
    run_crate_check_report(app, check_freshness)
        .await
        .into_iter()
        .find(|check| check.id == target)
        .ok_or_else(|| format!("Unknown agent provider '{provider_id}'"))
}

/// The crate's AI-agent doctor report (with the Windows managed-bridge repair
/// applied), built with the same env/registry/bundled-tools view the settings
/// screen reads. `check_freshness` mirrors [`find_check`] vs [`find_check_fresh`]:
/// the cheap path skips version/registry probing. Shared by the provider check
/// lookups and the offered-fix resolver so both authorize against one report.
async fn run_crate_check_report(
    app: &AppHandle,
    check_freshness: bool,
) -> Vec<doctor::DoctorCheck> {
    let env_vars = setup_env_vars(app).await;
    let bundled_tools_dir = managed_acp_tools::bundled_tools_dir_for_checks(app);
    let mut report = doctor::run_checks_with_options(
        doctor::RunChecksOptions {
            npm_registry: npm_registry(app),
            check_freshness,
            offline: false,
            env: None,
            // The crate labels binaries resolving from this dir as bundled and
            // offers no registry install/update fix for them — Berd installs
            // and upgrades these bridges itself (the startup reconciler floats
            // them to the latest version), so the crate must not nag the user
            // to update them manually.
            bundled_tools_dir: bundled_tools_dir.clone(),
        }
        .with_env_snapshot(env_vars.clone()),
    )
    .await;
    if let Some(dir) = bundled_tools_dir.as_deref() {
        crate::commands::doctor::repair_windows_managed_bridge_checks(
            &mut report.checks,
            dir,
            &env_vars,
        )
        .await;
    }
    report.checks
}

/// The top-level fix a crate AI-agent check (`ai-agent-*`) currently offers from
/// trusted state, resolved from the same non-fresh crate report the renderer
/// reads: `Some(Command | Bridge | Auth)` when the check currently offers that
/// fix, `None` when it offers none (already installed and authenticated) or the
/// check id isn't present. `run_doctor_fix` authorizes every agent fix request
/// against this before dispatch, so a forged or stale `(check_id, fix_type)`
/// pair fails closed rather than reaching a shell/native side effect.
pub(crate) async fn offered_crate_check_fix(
    app: &AppHandle,
    check_id: &str,
) -> Result<Option<FixType>, String> {
    Ok(run_crate_check_report(app, false)
        .await
        .into_iter()
        .find(|check| check.id == check_id)
        .and_then(|check| check.fix_type))
}

/// Whether the agent's main CLI or ACP bridge resolved on disk. Used as the
/// post-install / post-auth verification: a clean run that still leaves nothing
/// on PATH surfaces a clear error instead of a false success.
async fn agent_is_installed(
    app: &AppHandle,
    provider_id: &str,
    plan: &SetupPlan,
) -> Result<bool, String> {
    let check = find_check(app, provider_id).await?;
    Ok(check_satisfies_plan(&check, plan))
}

/// The resolved-on-disk gate, mirroring the frontend's `readinessFromReport`.
/// A bundled bridge is the provider's only binary and reports under `path`;
/// its bin dir is always on the doctor PATH, so `None` means the bundle itself
/// is broken and readiness would contradict any verification success reported
/// without it. Everything else accepts either binary of a two-binary agent.
fn check_satisfies_plan(check: &doctor::DoctorCheck, plan: &SetupPlan) -> bool {
    if plan.bundled_bridge {
        check.path.is_some()
    } else {
        check.path.is_some() || check.bridge_path.is_some()
    }
}

/// Post-fix verification, gated by the plan's `verify_install`. When the
/// provider ships a real binary (`verify_install`), confirm the main CLI or ACP
/// bridge resolved on disk so a clean run that left nothing on PATH surfaces a
/// clear error instead of a false success. When it doesn't (a built-in or
/// binary-less provider, `!verify_install`), there is nothing to resolve, so the
/// clean run is taken as success — the old in-card flow short-circuited the same
/// way (`isBuiltIn || !hasBinary => installed`) rather than failing closed on the
/// absent doctor check that `agent_is_installed` would surface for it.
async fn verify_installed(
    app: Option<&AppHandle>,
    provider_id: &str,
    plan: &SetupPlan,
) -> Result<(), String> {
    if !plan.verify_install {
        return Ok(());
    }
    let Some(app) = app else {
        return Err("installVerificationFailed".to_string());
    };
    if agent_is_installed(app, provider_id, plan)
        .await
        .unwrap_or(false)
    {
        Ok(())
    } else {
        // Sentinel the card localizes via `providers.agents.errors.*`.
        Err("installVerificationFailed".to_string())
    }
}

/// Authorize the renderer-requested update slots before any executor runs.
/// Rejects a list with a duplicate slot: `run_install` runs each entry against
/// one freshness snapshot, so N copies of `updateMain` would rerun the trusted
/// update command N times through a single IPC request. The card only ever
/// names each slot at most once (`buildUpdateFixTypes` derives from distinct
/// readouts), so a duplicate is a forged/replayed request. Returns the
/// authorized `FixType` list on success. Pure so the boundary is unit-testable
/// without a Tauri handle.
fn authorize_update_fixes(
    provider_id: &str,
    requested: &[UpdateFixType],
) -> Result<Vec<FixType>, String> {
    let mut seen: Vec<UpdateFixType> = Vec::with_capacity(requested.len());
    for slot in requested {
        if seen.contains(slot) {
            return Err(format!(
                "duplicate '{slot:?}' update slot requested for '{provider_id}'"
            ));
        }
        seen.push(*slot);
    }
    Ok(seen.into_iter().map(FixType::from).collect())
}

/// Resolve the exact, source-aware update command for a requested update fix
/// from the crate's freshness readout — the trusted source of truth. The
/// renderer names only the readout slot (`updateMain` / `updateBridge`); the
/// command string never crosses the wire.
///
/// Rejects (returns `Err`) when:
/// - `fix_type` is not one of the two update slots (a forged/mismatched fix);
/// - the addressed readout is absent (`main` / `bridge` is `None`);
/// - the readout reports no actionable update (`update_command` is `None`), or
///   its own `update_fix_type` doesn't match the requested slot.
fn resolve_update_command(
    check: &doctor::DoctorCheck,
    fix_type: &FixType,
) -> Result<String, String> {
    let readout = match fix_type {
        FixType::UpdateMain => check.main.as_ref(),
        FixType::UpdateBridge => check.bridge.as_ref(),
        other => {
            return Err(format!(
                "unsupported update fix type '{other:?}' for '{}'",
                check.id
            ));
        }
    };
    let readout = readout.ok_or_else(|| {
        format!(
            "no '{fix_type:?}' readout available for '{}' to resolve an update command",
            check.id
        )
    })?;
    // Both fields are set together by the crate's freshness pass, and only when
    // the update is actionable; a mismatched slot means the requested update
    // isn't the one the readout offers.
    if readout.update_fix_type.as_ref() != Some(fix_type) {
        return Err(format!(
            "'{fix_type:?}' does not match the actionable update for '{}'",
            check.id
        ));
    }
    readout.update_command.clone().ok_or_else(|| {
        format!(
            "no actionable '{fix_type:?}' update command for '{}'",
            check.id
        )
    })
}

/// The sign-in capability the pinned doctor crate declares for a check, read
/// from the backend-owned `AI_AGENT_CHECKS` table — never renderer input. It is
/// the authorization oracle for [`authorize_auth`]: "currently offers `Auth`"
/// is only valid for agents Doctor can actually probe.
#[derive(Debug, PartialEq, Eq)]
enum AuthCapability {
    /// No `auth_command` (goose, pi): the agent has no sign-in flow, so a
    /// renderer-requested `Auth` is never authorized.
    None,
    /// Both a login command and a status probe (claude, codex, amp, cursor):
    /// Doctor reports `Auth` when installed-but-signed-out, so authorize a
    /// sign-in only when the check currently offers it.
    Probeable,
    /// A login command but no status probe (copilot): Doctor can't observe the
    /// auth state, so it reports `Pass`/no fix even when a sign-in is needed.
    /// Authorize the registered login for the installed agent directly.
    Unprobeable,
}

/// The sign-in capability the pinned crate declares for a crate check id
/// (`ai-agent-*`). Resolved from the static `AI_AGENT_CHECKS` table so the auth
/// gate authorizes against backend-owned recipe metadata, not a renderer claim.
/// An unknown id has no capability, so auth is never authorized for it.
fn auth_capability(check_id: &str) -> AuthCapability {
    doctor::agents::AI_AGENT_CHECKS
        .iter()
        .find(|info| info.id == check_id)
        .map(|info| {
            match (
                info.auth_command.is_some(),
                info.auth_status_command.is_some(),
            ) {
                (false, _) => AuthCapability::None,
                (true, true) => AuthCapability::Probeable,
                (true, false) => AuthCapability::Unprobeable,
            }
        })
        .unwrap_or(AuthCapability::None)
}

/// Authorize a renderer-requested `Auth` action against the provider's current
/// doctor `check` and its backend-owned [`AuthCapability`]. Sign-in fails closed
/// unless the pinned crate declares a login flow for the check:
///
/// - `None` (no `auth_command`): never authorized.
/// - `Probeable` (has an auth-status probe): authorized only when the check
///   currently offers `Auth` (installed but not authenticated); a check that
///   offers an install fix or is already authenticated (no fix) rejects.
/// - `Unprobeable` (a login command but no status probe, e.g. Copilot): Doctor
///   can't report `Auth`, so authorize the registered login when the agent is
///   installed (`path`/`bridge_path` resolved) and offers no install fix. A
///   not-installed provider still offers `Command`, so a forged sign-in against
///   it rejects.
///
/// Pure so the boundary is unit-testable without a Tauri handle.
fn authorize_auth(provider_id: &str, check: &doctor::DoctorCheck) -> Result<(), String> {
    match auth_capability(&check.id) {
        AuthCapability::None => Err(format!("'{provider_id}' has no sign-in flow")),
        AuthCapability::Probeable => match &check.fix_type {
            Some(FixType::Auth) => Ok(()),
            Some(offered) => Err(format!(
                "'{provider_id}' currently offers the '{offered:?}' fix, not sign-in"
            )),
            None => Err(format!(
                "'{provider_id}' offers no sign-in in its current state"
            )),
        },
        AuthCapability::Unprobeable => {
            if check.path.is_none() && check.bridge_path.is_none() {
                return Err(format!(
                    "'{provider_id}' is not installed, so sign-in is unavailable"
                ));
            }
            match &check.fix_type {
                None => Ok(()),
                Some(offered) => Err(format!(
                    "'{provider_id}' currently offers the '{offered:?}' fix, not sign-in"
                )),
            }
        }
    }
}

/// The install fix (`Command` / `Bridge`) the provider's check currently offers
/// from trusted crate state, or `None` when it offers no install fix (already
/// installed, or exposes only auth/update). Used by [`run_install`] to reject a
/// forged or mismatched managed-install seed before the install loop runs any
/// command.
async fn offered_install_fix(
    app: &AppHandle,
    provider_id: &str,
) -> Result<Option<FixType>, String> {
    let check = find_check(app, provider_id).await?;
    Ok(install_fix_for_check(&check))
}

/// Authorize a renderer-requested install seed against the provider's current
/// doctor state (`offered` = the install fix the check actually offers now).
/// The renderer names *which* install fix it intends; this returns the backend
/// value only when it matches, rejecting a mismatched seed or one against a
/// check that offers no install fix (already installed / auth-or-update only)
/// before any install shell command runs. Pure so the authorization boundary is
/// unit-testable without a Tauri `AppHandle`.
fn authorize_install_seed(
    provider_id: &str,
    requested: &InstallFixType,
    offered: Option<FixType>,
) -> Result<FixType, String> {
    let requested = FixType::from(requested.clone());
    match offered {
        Some(offered) if offered == requested => Ok(offered),
        Some(offered) => Err(format!(
            "'{requested:?}' install is not the '{offered:?}' fix currently offered for '{provider_id}'"
        )),
        None => Err(format!(
            "'{provider_id}' offers no '{requested:?}' install fix in its current state"
        )),
    }
}

/// The install recipe a check still needs, if any. Only the two *install* fix
/// types qualify — `Auth` (installed-but-signed-out) and the per-readout update
/// types are handled by later chain steps, not the install loop.
pub(crate) fn install_fix_for_check(check: &doctor::DoctorCheck) -> Option<FixType> {
    match check.fix_type {
        Some(FixType::Command) => Some(FixType::Command),
        Some(FixType::Bridge) => Some(FixType::Bridge),
        _ => None,
    }
}

/// Idempotently kick off a provider's setup operation and return immediately
/// with the seeded snapshot. The orchestration runs to completion in a spawned
/// task that owns an `Arc` clone of the registry + the `AppHandle`, so it keeps
/// advancing (and writing progress) regardless of which card is mounted.
#[tauri::command]
pub fn start_agent_setup(
    app_handle: AppHandle,
    registry: State<'_, AgentSetupRegistry>,
    provider_id: String,
    action: SetupAction,
    plan: SetupPlan,
) -> SetupOperation {
    let (started, snapshot) = registry.begin(&provider_id, action);
    emit_state(&app_handle, &provider_id, &snapshot);
    if !started {
        // Already running — the idempotent no-op path (a reloaded card re-firing
        // start on mount). Return the live snapshot without a second task.
        return snapshot;
    }

    let registry = registry.inner().clone();
    let app = app_handle.clone();
    let provider_for_task = provider_id.clone();
    tauri::async_runtime::spawn(async move {
        run_setup(app, registry, provider_for_task, action, plan).await;
    });
    snapshot
}

#[tauri::command]
pub fn get_agent_setup_status(
    registry: State<'_, AgentSetupRegistry>,
    provider_id: String,
) -> Option<SetupOperation> {
    registry.get(&provider_id)
}

#[tauri::command]
pub fn list_agent_setup_status(
    registry: State<'_, AgentSetupRegistry>,
) -> Vec<(String, SetupOperation)> {
    registry.list()
}

#[tauri::command]
pub fn clear_agent_setup_status(registry: State<'_, AgentSetupRegistry>, provider_id: String) {
    registry.remove(&provider_id);
}

/// Run the whole chain to completion, then write the terminal status. `auth`
/// takes the small sign-in branch; `install`/`update` share the plan-driven
/// install-loop + updates + verify chain.
async fn run_setup(
    app: AppHandle,
    registry: AgentSetupRegistry,
    provider_id: String,
    action: SetupAction,
    plan: SetupPlan,
) {
    let result = match action {
        SetupAction::Auth => run_auth(&app, &registry, &provider_id, &plan).await,
        SetupAction::Install | SetupAction::Update => {
            run_install(&app, &registry, &provider_id, &plan).await
        }
    };

    apply_and_emit(&app, &registry, &provider_id, |operation| {
        operation.phase = SetupPhase::Idle;
        match &result {
            Ok(()) => {
                operation.status = SetupStatus::Succeeded;
                operation.error = None;
            }
            Err(message) => {
                operation.status = SetupStatus::Failed;
                operation.error = Some(message.clone());
            }
        }
    });
}

/// Mirror of the former in-card `runInstall`: install-loop (seeded by the plan,
/// re-probing after each pass and bounded by `ran` so it runs each recipe at
/// most once), then each per-readout update command, then a final verification.
async fn run_install(
    app: &AppHandle,
    registry: &AgentSetupRegistry,
    provider_id: &str,
    plan: &SetupPlan,
) -> Result<(), String> {
    set_phase(app, registry, provider_id, SetupPhase::Installing);

    // Install every missing component, one recipe per pass. A from-scratch
    // two-binary agent reports its main CLI first (`fixType="command"`); once it
    // lands, the now-visible bridge surfaces as `fixType="bridge"`. Re-probe
    // after each install and run the next install fix the crate reports, so a
    // from-scratch Codex installs `codex` + `codex-acp` under one click. See
    // `next_install_fix` for the ≤2-pass bound that terminates a stuck install.
    //
    // The renderer only names *which* install fix it intends; before running it
    // we re-read the provider's doctor check and authorize the seed against that
    // trusted state, so a forged/mismatched seed (or one against an
    // already-installed check) rejects before the install shell command runs.
    // Subsequent passes re-derive `pending` from the backend check directly, so
    // only the renderer-supplied seed needs this gate.
    let mut pending = match &plan.install_fix_type {
        Some(requested) => {
            let offered = offered_install_fix(app, provider_id).await?;
            Some(authorize_install_seed(provider_id, requested, offered)?)
        }
        None => None,
    };
    let mut ran: Vec<FixType> = Vec::new();
    while let Some(fix) = next_install_fix(&pending, &ran) {
        ran.push(fix.clone());
        run_fix(app, registry, provider_id, fix, None).await?;
        let check = find_check(app, provider_id).await?;
        pending = install_fix_for_check(&check);
    }

    // Update-after-install: a partial install with stale binaries (the "Fix"
    // state) is brought fully current in the same pass; for a plain install this
    // list is empty and the loop is a no-op. The renderer only names *which*
    // readouts to update (`updateMain` / `updateBridge`); the exact source-aware
    // command is resolved here from the crate's trusted freshness readout, so a
    // compromised renderer can't smuggle an arbitrary shell command through.
    // Authorize the slot list first — reject a duplicate slot before any
    // executor runs, so a replayed slot can't rerun the update command N times
    // off one freshness snapshot.
    let update_fixes = authorize_update_fixes(provider_id, &plan.update_fix_types)?;
    if !update_fixes.is_empty() {
        let fresh = find_check_fresh(app, provider_id).await?;
        for fix_type in &update_fixes {
            let command = resolve_update_command(&fresh, fix_type)?;
            run_fix(app, registry, provider_id, fix_type.clone(), Some(command)).await?;
        }
    }

    // Only enter the visible Checking phase when there's a binary to probe;
    // built-in / binary-less providers (`!verify_install`) skip straight to the
    // terminal status, matching the former in-card flow.
    if plan.verify_install {
        set_phase(app, registry, provider_id, SetupPhase::Checking);
    }
    verify_installed(Some(app), provider_id, plan).await
}

/// Mirror of the former in-card `runAuth`: run the auth fix, then verify the CLI
/// is on PATH so a clean-but-unfinished sign-in surfaces a clear error. A
/// binary-less provider (`!verify_install`) has nothing to probe, so the clean
/// auth run is taken as success — see [`verify_installed`].
async fn run_auth(
    app: &AppHandle,
    registry: &AgentSetupRegistry,
    provider_id: &str,
    plan: &SetupPlan,
) -> Result<(), String> {
    // The renderer only names the *action*; before running the auth shell
    // command we re-read the provider's doctor check and authorize `Auth`
    // against its backend-owned sign-in capability (see [`authorize_auth`]). A
    // forged/stale sign-in rejects here — for a probe-capable agent unless it
    // currently offers `Auth`, and for an unprobeable one (Copilot) unless the
    // agent is installed and offers no install fix — rather than executing the
    // static `<agent> login` command on demand. `find_check` also fails closed
    // on an unknown provider.
    let check = find_check(app, provider_id).await?;
    authorize_auth(provider_id, &check)?;
    set_phase(app, registry, provider_id, SetupPhase::Authenticating);
    run_fix(app, registry, provider_id, FixType::Auth, None).await?;

    if plan.verify_install {
        set_phase(app, registry, provider_id, SetupPhase::Checking);
    }
    verify_installed(Some(app), provider_id, plan).await
}

/// Run one doctor fix, appending each streamed line into the registry (which
/// emits `agent-setup:state`) instead of the old per-line `agent-setup:output`.
async fn run_fix(
    app: &AppHandle,
    registry: &AgentSetupRegistry,
    provider_id: &str,
    fix_type: FixType,
    command_override: Option<String>,
) -> Result<(), String> {
    let check_id = crate_check_id(provider_id);
    let log_tag = format!("[agent-setup {provider_id} {fix_type:?}]");
    log::info!("{log_tag} starting fix");

    // Managed bridges (claude, codex) install through the managed installer so
    // the floating `<pkg>@latest` install lands in `packages/tools` with an
    // absolute-path shim in `packages/bin` (labeled bundled, no update nag), rather
    // than the crate's bare `npm install -g` into the shared private prefix.
    if command_override.is_none()
        && matches!(fix_type, FixType::Command | FixType::Bridge)
        && managed_acp_tools::is_managed(provider_id)
    {
        return run_managed_install(app, registry, provider_id, &log_tag).await;
    }

    // npm-backed fixes run the managed npm into the Berd-private prefix, so
    // the managed Node runtime must exist before the command does.
    let resolved_command = command_override
        .clone()
        .or_else(|| doctor::agents::lookup_fix_command(&check_id, &fix_type));
    if resolved_command
        .as_deref()
        .is_some_and(managed_acp_tools::is_npm_backed_command)
    {
        ensure_managed_runtime(app, registry, provider_id).await?;
    }

    let app_for_lines = app.clone();
    let registry_for_lines = registry.clone();
    let provider_for_lines = provider_id.to_string();
    let log_tag_for_lines = log_tag.clone();
    // No cancellation token in `execute_fix_streaming_with_env_options` by design —
    // `run_fix` always runs to completion. Leaving the screen never stopped the
    // work; the registry just tracks the work that was already running.
    let result = doctor::execute_fix_streaming_with_env_options(
        check_id,
        fix_type,
        doctor::ExecuteFixOptions {
            command_override,
            npm_registry: npm_registry(app),
            env: None,
        }
        .with_env_snapshot(setup_env_vars(app).await),
        move |line| {
            log::info!("{log_tag_for_lines} {line}");
            append_output(
                &app_for_lines,
                &registry_for_lines,
                &provider_for_lines,
                line,
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

/// Install (or upgrade) a managed bridge through the managed installer,
/// streaming npm output into the card. The managed-runtime ensure runs first
/// so the visible `preparingRuntime` phase brackets the runtime download; the
/// installer's own ensure is then a no-op.
async fn run_managed_install(
    app: &AppHandle,
    registry: &AgentSetupRegistry,
    provider_id: &str,
    log_tag: &str,
) -> Result<(), String> {
    ensure_managed_runtime(app, registry, provider_id).await?;

    let app_for_lines = app.clone();
    let registry_for_lines = registry.clone();
    let provider_for_lines = provider_id.to_string();
    let log_tag_for_lines = log_tag.to_string();
    let on_line = move |line: &str| {
        log::info!("{log_tag_for_lines} {line}");
        append_output(
            &app_for_lines,
            &registry_for_lines,
            &provider_for_lines,
            line,
        );
    };
    let result = managed_acp_tools::install_managed_tool(app, provider_id, &on_line)
        .await
        .map_err(|error| error.to_string());

    match &result {
        Ok(()) => log::info!("{log_tag} managed install succeeded"),
        Err(error) => log::info!("{log_tag} managed install failed: {error}"),
    }
    result
}

/// Make sure the Berd-managed Node.js runtime is installed before an
/// npm-backed fix runs. Quiet no-op when the pinned runtime is already
/// healthy; otherwise the operation enters the visible `preparingRuntime`
/// phase, streams download/extract progress into the output buffer, and
/// returns to the phase it interrupted.
async fn ensure_managed_runtime(
    app: &AppHandle,
    registry: &AgentSetupRegistry,
    provider_id: &str,
) -> Result<(), String> {
    if let Some(root) = managed_node::managed_node_root(app) {
        if managed_node::pinned_runtime_ready(&root).await {
            return Ok(());
        }
    }

    let version = &managed_node::node_runtime_lock().version;
    let resume_phase = registry.get(provider_id).map(|operation| operation.phase);
    set_phase(app, registry, provider_id, SetupPhase::PreparingRuntime);
    append_output(
        app,
        registry,
        provider_id,
        &format!("Installing Berd-managed Node.js {version}"),
    );

    let app_for_lines = app.clone();
    let registry_for_lines = registry.clone();
    let provider_for_lines = provider_id.to_string();
    let progress = managed_node::progress_line_reporter(move |line| {
        append_output(
            &app_for_lines,
            &registry_for_lines,
            &provider_for_lines,
            &line,
        );
    });
    let result = managed_node::ensure_managed_node_runtime(app, &progress).await;

    if let Some(phase) = resume_phase {
        set_phase(app, registry, provider_id, phase);
    }
    match result {
        Ok(()) => {
            append_output(
                app,
                registry,
                provider_id,
                &format!("Node.js {version} is ready"),
            );
            Ok(())
        }
        Err(error) => Err(error.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn npm_registry_is_quiet_without_a_distribution_and_override_wins() {
        assert_eq!(npm_registry_for_distribution(None), None);

        let distribution = serde_json::from_str(
            r#"{"npmRegistryUrl":"https://packages.example.test/npm/","nodeDistBaseUrl":"https://node.example.test/dist/"}"#,
        )
        .unwrap();
        assert_eq!(
            npm_registry_for_distribution(Some(&distribution)),
            Some("https://packages.example.test/npm/".to_string())
        );
    }

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

    #[test]
    fn npm_backed_install_fixes_trigger_the_managed_runtime_gate() {
        // Pins the cross-crate contract the ensure step in `run_fix` relies
        // on: copilot installs through npm (needs the managed runtime first),
        // cursor installs through curl (host-only, no runtime needed). If the
        // crate changes an install command's shape, this failing points at
        // the gate, not at a mystery install regression.
        let copilot = doctor::agents::lookup_fix_command("ai-agent-copilot", &FixType::Command)
            .expect("copilot install command");
        assert!(managed_acp_tools::is_npm_backed_command(&copilot));

        let cursor = doctor::agents::lookup_fix_command("ai-agent-cursor", &FixType::Command)
            .expect("cursor install command");
        assert!(!managed_acp_tools::is_npm_backed_command(&cursor));
    }

    fn check_with_fix(fix_type: Option<FixType>) -> doctor::DoctorCheck {
        doctor::DoctorCheck {
            id: "ai-agent-codex".into(),
            label: "Codex".into(),
            status: doctor::CheckStatus::Warn,
            message: String::new(),
            fix_url: None,
            fix_command: None,
            fix_type,
            path: None,
            bridge_path: None,
            raw_output: None,
            auth_status: None,
            installed_version: None,
            latest_version: None,
            update_available: None,
            install_source: None,
            self_updating: None,
            main: None,
            bridge: None,
        }
    }

    /// Build a readout with a paired `(update_command, update_fix_type)`, as
    /// the crate's freshness pass emits for an actionable update.
    fn readout_with_update(command: &str, fix_type: FixType) -> doctor::types::AgentVersionInfo {
        doctor::types::AgentVersionInfo {
            update_command: Some(command.to_string()),
            update_fix_type: Some(fix_type),
            ..Default::default()
        }
    }

    #[test]
    fn resolve_update_command_returns_the_trusted_readout_command() {
        let mut check = check_with_fix(None);
        check.main = Some(readout_with_update(
            "npm install -g @anthropic-ai/claude-code@latest",
            FixType::UpdateMain,
        ));
        check.bridge = Some(readout_with_update(
            "npm install -g claude-agent-acp@latest",
            FixType::UpdateBridge,
        ));

        assert_eq!(
            resolve_update_command(&check, &FixType::UpdateMain).unwrap(),
            "npm install -g @anthropic-ai/claude-code@latest"
        );
        assert_eq!(
            resolve_update_command(&check, &FixType::UpdateBridge).unwrap(),
            "npm install -g claude-agent-acp@latest"
        );
    }

    #[test]
    fn resolve_update_command_rejects_non_update_fix_types() {
        // A forged plan naming an install/auth fix as an "update" must never
        // resolve to a command — those are not update slots.
        let mut check = check_with_fix(None);
        check.main = Some(readout_with_update(
            "brew upgrade codex",
            FixType::UpdateMain,
        ));

        for forged in [FixType::Command, FixType::Bridge, FixType::Auth] {
            assert!(
                resolve_update_command(&check, &forged).is_err(),
                "{forged:?} must be rejected"
            );
        }
    }

    #[test]
    fn resolve_update_command_rejects_absent_readout() {
        // No `main` / `bridge` readout means there is no trusted command to run.
        let check = check_with_fix(None);
        assert!(resolve_update_command(&check, &FixType::UpdateMain).is_err());
        assert!(resolve_update_command(&check, &FixType::UpdateBridge).is_err());
    }

    #[test]
    fn resolve_update_command_rejects_mismatched_slot() {
        // The bridge readout carries a bridge update; requesting `updateMain`
        // against it (a mismatched slot) must fail rather than run the bridge
        // command under the wrong identity.
        let mut check = check_with_fix(None);
        check.main = Some(readout_with_update(
            "npm install -g claude-agent-acp@latest",
            FixType::UpdateBridge,
        ));
        assert!(resolve_update_command(&check, &FixType::UpdateMain).is_err());
    }

    #[test]
    fn resolve_update_command_rejects_readout_without_actionable_command() {
        // A readout with no derived update command (e.g. a self-updating or
        // opaque install source) offers nothing to run, even for a valid slot.
        let mut check = check_with_fix(None);
        check.main = Some(doctor::types::AgentVersionInfo {
            update_command: None,
            update_fix_type: None,
            ..Default::default()
        });
        assert!(resolve_update_command(&check, &FixType::UpdateMain).is_err());
    }

    #[test]
    fn authorize_update_fixes_rejects_duplicate_slots_before_dispatch() {
        // Regression: `run_install` runs each slot against one freshness
        // snapshot, so a duplicate `updateMain` would rerun the trusted update
        // command twice through one IPC request. A duplicate must reject before
        // any executor target is produced.
        assert!(authorize_update_fixes(
            "claude",
            &[UpdateFixType::UpdateMain, UpdateFixType::UpdateMain]
        )
        .is_err());
        assert!(authorize_update_fixes(
            "claude",
            &[
                UpdateFixType::UpdateBridge,
                UpdateFixType::UpdateMain,
                UpdateFixType::UpdateBridge,
            ]
        )
        .is_err());
    }

    #[test]
    fn authorize_update_fixes_allows_at_most_one_of_each_slot() {
        // The card only ever names each slot once. An empty list, a single
        // slot, and one of each (in either order) all authorize and map to the
        // corresponding `FixType`.
        assert_eq!(authorize_update_fixes("claude", &[]).unwrap(), Vec::new());
        assert_eq!(
            authorize_update_fixes("claude", &[UpdateFixType::UpdateMain]).unwrap(),
            vec![FixType::UpdateMain]
        );
        assert_eq!(
            authorize_update_fixes(
                "claude",
                &[UpdateFixType::UpdateBridge, UpdateFixType::UpdateMain]
            )
            .unwrap(),
            vec![FixType::UpdateBridge, FixType::UpdateMain]
        );
    }

    #[test]
    fn install_fix_for_check_returns_the_two_install_recipes() {
        assert_eq!(
            install_fix_for_check(&check_with_fix(Some(FixType::Command))),
            Some(FixType::Command)
        );
        assert_eq!(
            install_fix_for_check(&check_with_fix(Some(FixType::Bridge))),
            Some(FixType::Bridge)
        );
    }

    #[test]
    fn install_fix_for_check_ignores_auth_update_and_absent_fixes() {
        // Auth and the per-readout update fixes are handled by later chain
        // steps, not the install loop, so they don't keep the loop running.
        assert_eq!(
            install_fix_for_check(&check_with_fix(Some(FixType::Auth))),
            None
        );
        assert_eq!(
            install_fix_for_check(&check_with_fix(Some(FixType::UpdateMain))),
            None
        );
        assert_eq!(
            install_fix_for_check(&check_with_fix(Some(FixType::UpdateBridge))),
            None
        );
        // A fully-installed agent has no install fix pending.
        assert_eq!(install_fix_for_check(&check_with_fix(None)), None);
    }

    #[test]
    fn authorize_install_seed_returns_the_matching_backend_fix() {
        // The renderer names the install fix it intends; when it matches the
        // fix the check currently offers, the backend value is what runs.
        assert_eq!(
            authorize_install_seed(
                "codex-acp",
                &InstallFixType::Command,
                Some(FixType::Command)
            ),
            Ok(FixType::Command)
        );
        assert_eq!(
            authorize_install_seed("codex-acp", &InstallFixType::Bridge, Some(FixType::Bridge)),
            Ok(FixType::Bridge)
        );
    }

    #[test]
    fn authorize_install_seed_rejects_a_mismatched_seed() {
        // A renderer that requests `bridge` when the check offers only `command`
        // (or vice versa) must reject before any install shell command runs,
        // rather than execute the provider's other install recipe on demand.
        assert!(authorize_install_seed(
            "codex-acp",
            &InstallFixType::Bridge,
            Some(FixType::Command)
        )
        .is_err());
        assert!(authorize_install_seed(
            "codex-acp",
            &InstallFixType::Command,
            Some(FixType::Bridge)
        )
        .is_err());
    }

    #[test]
    fn authorize_install_seed_rejects_when_no_install_fix_is_offered() {
        // An already-installed provider (or one exposing only auth/update)
        // offers no install fix, so a forged install seed must fail closed
        // instead of re-running the install shell command.
        assert!(authorize_install_seed("codex-acp", &InstallFixType::Command, None).is_err());
        assert!(authorize_install_seed("codex-acp", &InstallFixType::Bridge, None).is_err());
    }

    #[test]
    fn authorize_auth_rejects_forged_sign_in_for_a_probeable_agent() {
        // Probe-capable agents (claude/codex/amp/cursor) report `Auth` only when
        // installed-but-signed-out, so a forged sign-in against a missing
        // (offers `Command`/`Bridge`) or already-authenticated (no fix) codex
        // check must reject before the `<agent> login` command runs.
        let mut check = check_with_fix(Some(FixType::Command)); // id = ai-agent-codex
        assert!(authorize_auth("codex-acp", &check).is_err());
        check.fix_type = Some(FixType::Bridge);
        assert!(authorize_auth("codex-acp", &check).is_err());
        check.fix_type = None;
        assert!(authorize_auth("codex-acp", &check).is_err());
    }

    #[test]
    fn authorize_auth_allows_a_currently_offered_sign_in_for_a_probeable_agent() {
        // Installed-but-signed-out is the state a probe-capable agent reports as
        // offering `Auth`, so a legitimate sign-in is authorized.
        let check = check_with_fix(Some(FixType::Auth)); // id = ai-agent-codex
        assert!(authorize_auth("codex-acp", &check).is_ok());
    }

    #[test]
    fn authorize_auth_allows_installed_copilot_despite_no_offered_fix() {
        // Regression for the Copilot auth-gate defect: Copilot declares an
        // `auth_command` but no `auth_status_command`, so Doctor reports
        // `Pass`/`fix_type = None` even when a sign-in is needed. The gate must
        // authorize the registered login for the *installed* agent (resolved
        // `path`) rather than blocking its only sign-in path.
        let mut check = check_with_fix(None);
        check.id = "ai-agent-copilot".into();
        check.path = Some("/opt/homebrew/bin/copilot".into());
        assert!(authorize_auth("copilot-acp", &check).is_ok());
    }

    #[test]
    fn authorize_auth_rejects_copilot_sign_in_when_not_installed() {
        // A not-installed Copilot still offers a `Command` install fix and has no
        // resolved binary, so a forged sign-in against it must reject — the
        // unprobeable capability authorizes login only for an installed agent.
        let mut check = check_with_fix(Some(FixType::Command));
        check.id = "ai-agent-copilot".into();
        check.path = None;
        check.bridge_path = None;
        assert!(authorize_auth("copilot-acp", &check).is_err());
    }

    #[test]
    fn authorize_auth_rejects_sign_in_for_an_agent_with_no_login_flow() {
        // Goose declares no `auth_command`, so a renderer-requested sign-in is
        // never authorized regardless of the reported check state.
        let mut check = check_with_fix(None);
        check.id = "ai-agent-goose".into();
        check.path = Some("/usr/local/bin/goose".into());
        assert!(authorize_auth("goose", &check).is_err());
    }

    #[test]
    fn auth_capability_reflects_the_pinned_crate_table() {
        // The gate's oracle is the backend-owned `AI_AGENT_CHECKS` table, not a
        // renderer claim: probe-capable agents, the unprobeable Copilot, the
        // no-login goose, and an unknown id each resolve to their capability.
        assert_eq!(auth_capability("ai-agent-codex"), AuthCapability::Probeable);
        assert_eq!(
            auth_capability("ai-agent-copilot"),
            AuthCapability::Unprobeable
        );
        assert_eq!(auth_capability("ai-agent-goose"), AuthCapability::None);
        assert_eq!(auth_capability("ai-agent-nope"), AuthCapability::None);
    }

    #[test]
    fn install_fix_type_wire_rejects_non_install_variants() {
        // The security boundary is the narrow Rust wire type: `auth` and the
        // update slots must not deserialize into the install seed at all, so a
        // forged plan can never smuggle a non-install identity through
        // `installFixType` regardless of the TS `Extract<>` contract.
        assert_eq!(
            serde_json::from_str::<InstallFixType>("\"command\"").unwrap(),
            InstallFixType::Command
        );
        assert_eq!(
            serde_json::from_str::<InstallFixType>("\"bridge\"").unwrap(),
            InstallFixType::Bridge
        );
        for forged in ["\"auth\"", "\"updateMain\"", "\"updateBridge\""] {
            assert!(
                serde_json::from_str::<InstallFixType>(forged).is_err(),
                "{forged} must not deserialize into an install seed"
            );
        }
        // And it must not deserialize as the SetupPlan field either.
        assert!(serde_json::from_str::<SetupPlan>(
            "{\"installFixType\":\"auth\",\"updateFixTypes\":[],\"verifyInstall\":false}"
        )
        .is_err());
    }

    /// Test model of the install loop in [`run_install`]: both share
    /// [`next_install_fix`] as their decision core, so this covers the loop's
    /// state transitions without the real (async, system-touching) doctor crate.
    fn plan_install_sequence(
        seed: Option<FixType>,
        mut reprobe: impl FnMut() -> Option<FixType>,
    ) -> Vec<FixType> {
        let mut sequence = Vec::new();
        let mut pending = seed;
        let mut ran: Vec<FixType> = Vec::new();
        while let Some(fix) = next_install_fix(&pending, &ran) {
            ran.push(fix.clone());
            sequence.push(fix);
            pending = reprobe();
        }
        sequence
    }

    #[test]
    fn install_sequence_single_binary_runs_once() {
        // Copilot/Cursor resolve their only binary; the re-probe reports nothing
        // further to install.
        let sequence = plan_install_sequence(Some(FixType::Command), || None);
        assert_eq!(sequence, vec![FixType::Command]);
    }

    #[test]
    fn install_sequence_two_binary_runs_cli_then_bridge() {
        // From scratch the crate reports the main CLI first; once it lands the
        // now-visible bridge surfaces, then nothing remains.
        let mut probes = [Some(FixType::Bridge), None].into_iter();
        let sequence =
            plan_install_sequence(Some(FixType::Command), move || probes.next().flatten());
        assert_eq!(sequence, vec![FixType::Command, FixType::Bridge]);
    }

    #[test]
    fn install_sequence_bridge_only_fix_runs_once() {
        // The bridge-only "Fix" path seeds "bridge"; the re-probe then returns
        // null so the loop runs exactly once.
        let sequence = plan_install_sequence(Some(FixType::Bridge), || None);
        assert_eq!(sequence, vec![FixType::Bridge]);
    }

    #[test]
    fn install_sequence_terminates_on_stuck_reprobe() {
        // An install that didn't take leaves the same fix pending; the `ran`
        // guard must short-circuit so the loop terminates instead of spinning.
        let sequence = plan_install_sequence(Some(FixType::Command), || Some(FixType::Command));
        assert_eq!(sequence, vec![FixType::Command]);
    }

    #[test]
    fn install_sequence_empty_without_a_seed() {
        // A pure update/auth has no install recipe, so the loop never runs.
        let sequence = plan_install_sequence(None, || Some(FixType::Command));
        assert!(sequence.is_empty());
    }

    #[test]
    fn begin_seeds_running_and_is_idempotent() {
        let registry = AgentSetupRegistry::default();

        let (started, operation) = registry.begin("claude-acp", SetupAction::Install);
        assert!(started);
        assert_eq!(operation.status, SetupStatus::Running);
        assert_eq!(operation.phase, SetupPhase::Installing);

        // Re-firing while running is a no-op that returns the live snapshot.
        let (started_again, again) = registry.begin("claude-acp", SetupAction::Install);
        assert!(!started_again);
        assert_eq!(again.status, SetupStatus::Running);
        assert_eq!(registry.list().len(), 1);

        // Once terminal, a fresh begin replaces the entry and starts over.
        registry.mutate("claude-acp", |operation| {
            operation.status = SetupStatus::Failed;
            operation.phase = SetupPhase::Idle;
        });
        let (started_after_terminal, _) = registry.begin("claude-acp", SetupAction::Install);
        assert!(started_after_terminal);
        assert_eq!(
            registry.get("claude-acp").unwrap().status,
            SetupStatus::Running
        );
    }

    #[test]
    fn begin_auth_starts_in_authenticating_phase() {
        let registry = AgentSetupRegistry::default();
        let (_, operation) = registry.begin("claude-acp", SetupAction::Auth);
        assert_eq!(operation.phase, SetupPhase::Authenticating);
    }

    #[test]
    fn mutate_transitions_phase_and_status() {
        let registry = AgentSetupRegistry::default();
        registry.begin("codex-acp", SetupAction::Install);

        registry.mutate("codex-acp", |operation| {
            operation.phase = SetupPhase::Checking;
        });
        assert_eq!(
            registry.get("codex-acp").unwrap().phase,
            SetupPhase::Checking
        );

        registry.mutate("codex-acp", |operation| {
            operation.status = SetupStatus::Succeeded;
            operation.phase = SetupPhase::Idle;
        });
        let operation = registry.get("codex-acp").unwrap();
        assert_eq!(operation.status, SetupStatus::Succeeded);
        assert_eq!(operation.phase, SetupPhase::Idle);
    }

    #[test]
    fn mutate_is_a_noop_for_a_cleared_entry() {
        let registry = AgentSetupRegistry::default();
        assert!(registry
            .mutate("never-started", |operation| operation
                .output
                .push("x".into()))
            .is_none());
    }

    #[test]
    fn push_output_line_caps_to_the_window() {
        let mut output = Vec::new();
        for index in 0..(MAX_OUTPUT_LINES + 25) {
            push_output_line(&mut output, &format!("line {index}"));
        }
        assert_eq!(output.len(), MAX_OUTPUT_LINES);
        // Oldest lines drop first; the last line is retained.
        assert_eq!(output.first().unwrap(), "line 25");
        assert_eq!(
            output.last().unwrap(),
            &format!("line {}", MAX_OUTPUT_LINES + 24)
        );
    }

    fn operation_at(status: SetupStatus, updated_at_ms: u64) -> SetupOperation {
        SetupOperation {
            action: SetupAction::Install,
            phase: SetupPhase::Idle,
            status,
            output: Vec::new(),
            error: None,
            updated_at_ms,
        }
    }

    #[test]
    fn sweep_removes_stale_terminal_but_keeps_running_and_fresh() {
        let now = 1_000_000u64;
        let mut map = HashMap::new();
        // Running entries are never swept, even when older than the TTL.
        map.insert("running".to_string(), operation_at(SetupStatus::Running, 0));
        map.insert(
            "stale".to_string(),
            operation_at(SetupStatus::Succeeded, now - GC_TTL_MS - 1),
        );
        map.insert(
            "fresh".to_string(),
            operation_at(SetupStatus::Failed, now - 1_000),
        );

        sweep_terminal(&mut map, now, GC_TTL_MS);

        assert!(map.contains_key("running"));
        assert!(!map.contains_key("stale"));
        assert!(map.contains_key("fresh"));
    }

    fn plan_with_requirements(verify_install: bool, bundled_bridge: bool) -> SetupPlan {
        SetupPlan {
            install_fix_type: None,
            update_fix_types: Vec::new(),
            verify_install,
            bundled_bridge,
        }
    }

    fn check_with_paths(path: Option<&str>, bridge_path: Option<&str>) -> doctor::DoctorCheck {
        doctor::DoctorCheck {
            path: path.map(str::to_string),
            bridge_path: bridge_path.map(str::to_string),
            ..check_with_fix(None)
        }
    }

    #[tokio::test]
    async fn verify_installed_skips_probe_when_not_required() {
        // A built-in / binary-less provider sends `verify_install = false`: it
        // has no binary to resolve, so verification must report success rather
        // than failing closed on the absent doctor check (the old in-card
        // `refreshInstallStatus` short-circuited the same way). The `false` arm
        // returns before touching the doctor crate, so this needs no real check
        // on PATH — and a provider id with no check is exactly the case the old
        // path passed and the unconditional probe would have failed.
        assert!(verify_installed(
            None,
            "provider-without-a-check",
            &plan_with_requirements(false, false)
        )
        .await
        .is_ok());
    }

    #[test]
    fn check_satisfies_plan_accepts_either_binary_by_default() {
        let plan = plan_with_requirements(true, false);
        assert!(check_satisfies_plan(
            &check_with_paths(Some("/bin/agent"), None),
            &plan
        ));
        assert!(check_satisfies_plan(
            &check_with_paths(None, Some("/bin/agent-acp")),
            &plan
        ));
        assert!(!check_satisfies_plan(&check_with_paths(None, None), &plan));
    }

    #[test]
    fn check_satisfies_plan_bundled_bridge_gates_on_path() {
        // Mirror of the frontend readiness gate: the bundled bridge is the
        // provider's only binary and reports under `path`. A bundled-bridge
        // check with no resolved `path` is a broken bundle, so verification
        // must fail even if a stray `bridge_path` were reported — otherwise
        // the fix reports success and the card immediately flips back to
        // not_installed.
        let plan = plan_with_requirements(true, true);
        assert!(check_satisfies_plan(
            &check_with_paths(Some("/bundled/codex-acp"), None),
            &plan
        ));
        assert!(!check_satisfies_plan(
            &check_with_paths(None, Some("/bundled/codex-acp")),
            &plan
        ));
        assert!(!check_satisfies_plan(&check_with_paths(None, None), &plan));
    }
}
