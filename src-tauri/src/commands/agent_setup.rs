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

use doctor::FixType;
use tauri::{AppHandle, Emitter, State};

/// Block's internal Artifactory npm registry. Direct access to
/// `registry.npmjs.org` is blocked by Cloudflare WARP, so npm-backed agent
/// installs must route through this proxy. The doctor crate exposes an optional
/// `npm_registry` param but bakes in no registry of its own, so Berd
/// supplies this URL at every fix/run call site (BOT-686).
pub(crate) const BLOCK_NPM_REGISTRY_URL: &str =
    "https://global.block-artifacts.com/artifactory/api/npm/square-npm/";

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

/// The execution recipe captured at click time. Keeping readout *derivation* in
/// TS (it already has the doctor report) avoids porting `actionableReadouts`
/// into Rust; the backend just runs the recipe autonomously so the chain
/// survives reload.
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupPlan {
    /// The install recipe to seed the install loop with (`command` for the main
    /// CLI, `bridge` for a missing ACP bridge). `null` for a pure update/auth.
    #[serde(default)]
    install_fix_type: Option<FixType>,
    /// Per-readout source-aware update commands to run after the install loop.
    #[serde(default)]
    update_commands: Vec<UpdateCommand>,
    /// Whether the post-fix step probes PATH to confirm the agent resolved on
    /// disk. The frontend sends `hasBinary && !isBuiltIn`: a built-in or
    /// binary-less provider has nothing to resolve, so a clean fix run is taken
    /// as success — mirroring the old in-card `refreshInstallStatus`
    /// short-circuit (`isBuiltIn || !hasBinary => installed`). Defaults to
    /// `false` so an omitted flag skips verification rather than fabricating a
    /// failure against the absent doctor check.
    #[serde(default)]
    verify_install: bool,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateCommand {
    /// `updateMain` or `updateBridge`.
    fix_type: FixType,
    /// The readout's `updateCommand`, run verbatim as `command_override`.
    command: String,
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

/// Whether the agent's main CLI or ACP bridge resolved on disk. Used as the
/// post-install / post-auth verification: a clean run that still leaves nothing
/// on PATH surfaces a clear error instead of a false success.
async fn agent_is_installed(provider_id: &str) -> Result<bool, String> {
    let check = find_check(provider_id).await?;
    Ok(check.path.is_some() || check.bridge_path.is_some())
}

/// Post-fix verification, gated by the plan's `verify_install`. When the
/// provider ships a real binary (`verify_install`), confirm the main CLI or ACP
/// bridge resolved on disk so a clean run that left nothing on PATH surfaces a
/// clear error instead of a false success. When it doesn't (a built-in or
/// binary-less provider, `!verify_install`), there is nothing to resolve, so the
/// clean run is taken as success — the old in-card flow short-circuited the same
/// way (`isBuiltIn || !hasBinary => installed`) rather than failing closed on the
/// absent doctor check that `agent_is_installed` would surface for it.
async fn verify_installed(provider_id: &str, verify_install: bool) -> Result<(), String> {
    if !verify_install {
        return Ok(());
    }
    if agent_is_installed(provider_id).await.unwrap_or(false) {
        Ok(())
    } else {
        // Sentinel the card localizes via `providers.agents.errors.*`.
        Err("installVerificationFailed".to_string())
    }
}

/// The install recipe a check still needs, if any. Only the two *install* fix
/// types qualify — `Auth` (installed-but-signed-out) and the per-readout update
/// types are handled by later chain steps, not the install loop.
fn install_fix_for_check(check: &doctor::DoctorCheck) -> Option<FixType> {
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
        SetupAction::Auth => run_auth(&app, &registry, &provider_id, plan.verify_install).await,
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
    let mut pending = plan.install_fix_type.clone();
    let mut ran: Vec<FixType> = Vec::new();
    while let Some(fix) = next_install_fix(&pending, &ran) {
        ran.push(fix.clone());
        run_fix(app, registry, provider_id, fix, None).await?;
        let check = find_check(provider_id).await?;
        pending = install_fix_for_check(&check);
    }

    // Update-after-install: a partial install with stale binaries (the "Fix"
    // state) is brought fully current in the same pass; for a plain install this
    // list is empty and the loop is a no-op.
    for update in &plan.update_commands {
        run_fix(
            app,
            registry,
            provider_id,
            update.fix_type.clone(),
            Some(update.command.clone()),
        )
        .await?;
    }

    // Only enter the visible Checking phase when there's a binary to probe;
    // built-in / binary-less providers (`!verify_install`) skip straight to the
    // terminal status, matching the former in-card flow.
    if plan.verify_install {
        set_phase(app, registry, provider_id, SetupPhase::Checking);
    }
    verify_installed(provider_id, plan.verify_install).await
}

/// Mirror of the former in-card `runAuth`: run the auth fix, then verify the CLI
/// is on PATH so a clean-but-unfinished sign-in surfaces a clear error. A
/// binary-less provider (`!verify_install`) has nothing to probe, so the clean
/// auth run is taken as success — see [`verify_installed`].
async fn run_auth(
    app: &AppHandle,
    registry: &AgentSetupRegistry,
    provider_id: &str,
    verify_install: bool,
) -> Result<(), String> {
    set_phase(app, registry, provider_id, SetupPhase::Authenticating);
    run_fix(app, registry, provider_id, FixType::Auth, None).await?;

    if verify_install {
        set_phase(app, registry, provider_id, SetupPhase::Checking);
    }
    verify_installed(provider_id, verify_install).await
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

    let app_for_lines = app.clone();
    let registry_for_lines = registry.clone();
    let provider_for_lines = provider_id.to_string();
    let log_tag_for_lines = log_tag.clone();
    // No cancellation token in `execute_fix_streaming_with_options` by design —
    // `run_fix` always runs to completion. Leaving the screen never stopped the
    // work; the registry just tracks the work that was already running.
    let result = doctor::execute_fix_streaming_with_options(
        check_id,
        fix_type,
        command_override,
        Some(BLOCK_NPM_REGISTRY_URL),
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

    #[tokio::test]
    async fn verify_installed_skips_probe_when_not_required() {
        // A built-in / binary-less provider sends `verify_install = false`: it
        // has no binary to resolve, so verification must report success rather
        // than failing closed on the absent doctor check (the old in-card
        // `refreshInstallStatus` short-circuited the same way). The `false` arm
        // returns before touching the doctor crate, so this needs no real check
        // on PATH — and a provider id with no check is exactly the case the old
        // path passed and the unconditional probe would have failed.
        assert!(verify_installed("provider-without-a-check", false)
            .await
            .is_ok());
    }
}
