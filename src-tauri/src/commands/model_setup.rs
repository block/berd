//! Backend-owned model-provider native sign-in setup state.
//!
//! The Rust backend is the source of truth for a model provider's native
//! sign-in progress: a spawned tokio task owns the whole `goose configure`
//! shell flow and writes phase / streamed output / status into
//! [`ModelSetupRegistry`], a managed Tauri state keyed by provider id. The
//! frontend only *kicks off* (`start_model_setup`) and *observes* (the
//! `model-setup:state` event + `list_model_setup_status` rehydration) the
//! operation, so progress survives navigating away, coming back, and a full
//! window reload — and the sign-in keeps advancing the whole time because it no
//! longer lives in the row.
//!
//! This mirrors `agent_setup.rs` (the agent-provider Phase 1) closely: same
//! registry / begin / idempotent-start shape, same coarse terminal-entry GC
//! sweep, same single bounded-snapshot event. The one intentional divergence is
//! that `mutate` emits the snapshot while still holding the lock: the agent
//! fix-chain streams its output through a single serial callback, but the native
//! sign-in reads stdout and stderr on two concurrent tasks, so emitting *after*
//! the lock is released could deliver snapshots out of mutation order and — since
//! the store replaces its view wholesale — momentarily drop the latest line. The
//! model path is also simpler than the agent fix-chain — there is a single
//! operation (the native sign-in), so there is no `action` discriminant and no
//! install loop; the only recipe captured at start time is the provider's
//! native-connect label, which is enough to rebuild the `goose configure`
//! command after a reload.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};

use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncBufReadExt, BufReader};

use crate::services::acp::goose_serve::get_goose_command;

/// Cap the buffered output so emitting the full snapshot on every streamed line
/// stays cheap and the event payload stays bounded. Lifted from the row (which
/// used the same 8-line window via `MAX_SETUP_OUTPUT_LINES`) into the backend
/// now that the registry owns the buffer.
const MAX_OUTPUT_LINES: usize = 8;

/// Coarse TTL backstop: a terminal (`succeeded`/`failed`) entry is swept on the
/// next registry write once it is older than this, so a result is never
/// orphaned if its row never mounts again to call `clear_model_setup_status`.
/// `running` entries are never swept.
const GC_TTL_MS: u64 = 10 * 60 * 1000;

/// The current step of the sign-in. Drives the row's progress label. The native
/// sign-in is a single shell flow, so there are only the in-flight
/// (`authenticating`) and terminal (`idle`) phases.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
enum ModelSetupPhase {
    Idle,
    Authenticating,
}

/// Lifecycle of an operation. Terminal states (`succeeded`/`failed`) persist
/// long enough for a reloaded row to read the result, then are GC'd.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
enum ModelSetupStatus {
    Running,
    Succeeded,
    Failed,
}

/// One model provider's in-flight (or just-finished) sign-in operation. The
/// whole snapshot is emitted on every change — it is small and bounded, so the
/// store can replace its view wholesale with no incremental-merge to get wrong.
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelSetupOperation {
    phase: ModelSetupPhase,
    status: ModelSetupStatus,
    /// Bounded to [`MAX_OUTPUT_LINES`]; the streamed (and relevance-filtered)
    /// `goose configure` output.
    output: Vec<String>,
    /// On failure, the raw sign-in error the row surfaces verbatim.
    error: Option<String>,
    /// For the GC backstop. Milliseconds since the Unix epoch.
    updated_at_ms: u64,
}

impl ModelSetupOperation {
    fn running() -> Self {
        ModelSetupOperation {
            phase: ModelSetupPhase::Authenticating,
            status: ModelSetupStatus::Running,
            output: Vec::new(),
            error: None,
            updated_at_ms: now_ms(),
        }
    }
}

/// The execution recipe captured at click time. The row already knows the
/// provider's native-connect label, so it passes it in and the backend rebuilds
/// the `goose configure` command autonomously — which is what lets the sign-in
/// survive a reload (the recipe doesn't depend on any live row state).
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelSetupPlan {
    /// The provider's `nativeConnectQuery` (e.g. `databricks`), piped into
    /// `goose configure` to select the provider.
    provider_label: String,
}

/// Managed Tauri state: `providerId -> ModelSetupOperation`. Keying by provider
/// lets sign-ins across different providers run concurrently. The spawned task
/// owns an `Arc` clone so it keeps writing after `start_model_setup` returns.
#[derive(Default, Clone)]
pub struct ModelSetupRegistry(Arc<Mutex<HashMap<String, ModelSetupOperation>>>);

impl ModelSetupRegistry {
    fn lock(&self) -> MutexGuard<'_, HashMap<String, ModelSetupOperation>> {
        // Tolerate a poisoned mutex: the map is plain data and a panic in one
        // operation must not wedge every other provider's sign-in.
        self.0.lock().unwrap_or_else(|poison| poison.into_inner())
    }

    /// Idempotent start. If an operation is already `running` for this provider,
    /// returns `(false, snapshot)` and leaves it untouched (a reloaded row
    /// re-fires `start` on mount; this guard prevents a double-start).
    /// Otherwise seeds a fresh running operation, replacing any terminal entry,
    /// and returns `(true, snapshot)` so the caller spawns the task.
    fn begin(&self, provider_id: &str) -> (bool, ModelSetupOperation) {
        let mut map = self.lock();
        if let Some(existing) = map.get(provider_id) {
            if existing.status == ModelSetupStatus::Running {
                return (false, existing.clone());
            }
        }
        sweep_terminal(&mut map, now_ms(), GC_TTL_MS);
        let operation = ModelSetupOperation::running();
        map.insert(provider_id.to_string(), operation.clone());
        (true, operation)
    }

    /// Apply `mutate` to the provider's operation (if present), bump
    /// `updated_at_ms`, then — **still holding the lock** — hand the new snapshot
    /// to `on_snapshot` before releasing it and GC'ing stale terminal entries.
    /// Emitting from inside `on_snapshot` (rather than off the returned value)
    /// is what keeps the emit order matching the mutation order: two reader
    /// tasks each appending a line can't interleave a mutation between another's
    /// mutate-and-emit, so the wholesale store replace never ends on a stale
    /// snapshot missing the latest line. Returns the new snapshot, or `None` if
    /// the entry was already cleared.
    fn mutate(
        &self,
        provider_id: &str,
        mutate: impl FnOnce(&mut ModelSetupOperation),
        on_snapshot: impl FnOnce(&ModelSetupOperation),
    ) -> Option<ModelSetupOperation> {
        let mut map = self.lock();
        let snapshot = {
            let operation = map.get_mut(provider_id)?;
            mutate(operation);
            operation.updated_at_ms = now_ms();
            on_snapshot(operation);
            operation.clone()
        };
        sweep_terminal(&mut map, now_ms(), GC_TTL_MS);
        Some(snapshot)
    }

    fn get(&self, provider_id: &str) -> Option<ModelSetupOperation> {
        self.lock().get(provider_id).cloned()
    }

    fn list(&self) -> Vec<(String, ModelSetupOperation)> {
        self.lock()
            .iter()
            .map(|(id, operation)| (id.clone(), operation.clone()))
            .collect()
    }

    fn remove(&self, provider_id: &str) {
        self.lock().remove(provider_id);
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

/// Drop terminal entries older than `ttl_ms`. `running` operations are kept
/// regardless of age so an in-flight sign-in is never swept out from under
/// itself.
fn sweep_terminal(map: &mut HashMap<String, ModelSetupOperation>, now_ms: u64, ttl_ms: u64) {
    map.retain(|_, operation| {
        operation.status == ModelSetupStatus::Running
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

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ModelSetupStateEvent {
    provider_id: String,
    operation: ModelSetupOperation,
}

fn emit_state(app: &AppHandle, provider_id: &str, operation: &ModelSetupOperation) {
    let _ = app.emit(
        "model-setup:state",
        ModelSetupStateEvent {
            provider_id: provider_id.to_string(),
            operation: operation.clone(),
        },
    );
}

/// Mutate the operation and emit the resulting snapshot in one step. The emit
/// runs while the registry lock is still held (see [`ModelSetupRegistry::mutate`]),
/// so concurrent writers emit in mutation order. A no-op if the entry was
/// already cleared (e.g. the row consumed a terminal state).
fn apply_and_emit(
    app: &AppHandle,
    registry: &ModelSetupRegistry,
    provider_id: &str,
    mutate: impl FnOnce(&mut ModelSetupOperation),
) {
    registry.mutate(provider_id, mutate, |operation| {
        emit_state(app, provider_id, operation);
    });
}

fn append_output(app: &AppHandle, registry: &ModelSetupRegistry, provider_id: &str, line: &str) {
    apply_and_emit(app, registry, provider_id, |operation| {
        push_output_line(&mut operation.output, line);
    });
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

fn strip_ansi(value: &str) -> String {
    let mut chars = value.chars().peekable();
    let mut output = String::new();

    while let Some(ch) = chars.next() {
        if ch == '\u{1b}' {
            if chars.peek() == Some(&'[') {
                chars.next();
                for next in chars.by_ref() {
                    if ('\u{40}'..='\u{7e}').contains(&next) {
                        break;
                    }
                }
            }
            continue;
        }

        if ch.is_ascii_control() {
            continue;
        }

        output.push(ch);
    }

    output
}

fn normalize_output_line(line: &str) -> Option<String> {
    let cleaned = strip_ansi(line);
    let trimmed = cleaned
        .trim()
        .trim_start_matches(['│', '┌', '└', '◆', '◇', '●', '○'])
        .trim();

    if trimmed.is_empty()
        || trimmed == "Configure Providers"
        || trimmed == "What would you like to configure?"
        || trimmed == "Which model provider should we use?"
        || trimmed == "This will update your existing config files"
        || trimmed.starts_with("if you prefer, you can edit them directly at")
    {
        return None;
    }

    Some(trimmed.to_string())
}

fn is_relevant_output(line: &str) -> bool {
    line.starts_with("Configuring ")
        || line.starts_with("Please visit ")
        || line.starts_with("Open ")
        || line.starts_with("Opening ")
        || line.starts_with("Waiting ")
        || line.starts_with("Authentication")
        || line.starts_with("Authenticated")
        || line.starts_with("Saved ")
        || line.contains("oauth")
        || line.contains("OAuth")
        || line.contains("device code")
        || line.contains("login/device")
        || line.contains("browser")
}

/// Idempotently kick off a provider's native sign-in and return immediately with
/// the seeded snapshot. The sign-in runs to completion in a spawned task that
/// owns an `Arc` clone of the registry + the `AppHandle`, so it keeps advancing
/// (and writing progress) regardless of which row is mounted.
#[tauri::command]
pub fn start_model_setup(
    app_handle: AppHandle,
    registry: State<'_, ModelSetupRegistry>,
    provider_id: String,
    plan: ModelSetupPlan,
) -> ModelSetupOperation {
    let (started, snapshot) = registry.begin(&provider_id);
    emit_state(&app_handle, &provider_id, &snapshot);
    if !started {
        // Already running — the idempotent no-op path (a reloaded row re-firing
        // start on mount). Return the live snapshot without a second task.
        return snapshot;
    }

    let registry = registry.inner().clone();
    let app = app_handle.clone();
    let provider_for_task = provider_id.clone();
    tauri::async_runtime::spawn(async move {
        run_model_setup(app, registry, provider_for_task, plan).await;
    });
    snapshot
}

#[tauri::command]
pub fn get_model_setup_status(
    registry: State<'_, ModelSetupRegistry>,
    provider_id: String,
) -> Option<ModelSetupOperation> {
    registry.get(&provider_id)
}

#[tauri::command]
pub fn list_model_setup_status(
    registry: State<'_, ModelSetupRegistry>,
) -> Vec<(String, ModelSetupOperation)> {
    registry.list()
}

#[tauri::command]
pub fn clear_model_setup_status(registry: State<'_, ModelSetupRegistry>, provider_id: String) {
    registry.remove(&provider_id);
}

/// Run the native sign-in to completion, then write the terminal status. The
/// frontend does the post-success verification (it re-reads provider status over
/// ACP), so the backend just runs the shell flow and reports succeeded/failed.
async fn run_model_setup(
    app: AppHandle,
    registry: ModelSetupRegistry,
    provider_id: String,
    plan: ModelSetupPlan,
) {
    let result = run_native_connect(&app, &registry, &provider_id, &plan).await;

    apply_and_emit(&app, &registry, &provider_id, |operation| {
        operation.phase = ModelSetupPhase::Idle;
        match &result {
            Ok(()) => {
                operation.status = ModelSetupStatus::Succeeded;
                operation.error = None;
            }
            Err(message) => {
                operation.status = ModelSetupStatus::Failed;
                operation.error = Some(message.clone());
            }
        }
    });
}

/// Build the `goose configure` command for `provider_label` and stream it
/// through the registry. Mirrors the former in-row native-connect, now owned by
/// the backend task so it survives a reload.
async fn run_native_connect(
    app: &AppHandle,
    registry: &ModelSetupRegistry,
    provider_id: &str,
    plan: &ModelSetupPlan,
) -> Result<(), String> {
    if cfg!(target_os = "windows") {
        return Err("Native Goose sign-in is not supported on Windows yet".to_string());
    }

    let goose_command = get_goose_command(app)?;
    let quoted_label = shell_quote(&plan.provider_label);
    let quoted_binary = shell_quote(&goose_command.as_std().get_program().to_string_lossy());

    let command = if cfg!(target_os = "linux") {
        format!(
            "printf '\\n%s\\n' {quoted_label} | script -qf /dev/null -c '{quoted_binary} configure'",
        )
    } else {
        format!("printf '\\n%s\\n' {quoted_label} | script -q /dev/null {quoted_binary} configure",)
    };

    run_shell_command(app, registry, provider_id, &command).await
}

/// Spawn the sign-in shell command, streaming each relevant (normalized,
/// ANSI-stripped, relevance-gated) line into the registry — which emits
/// `model-setup:state` — instead of the old per-line `model-setup:output`. The
/// two reader tasks append *and* emit their snapshot under the registry mutex
/// (see [`ModelSetupRegistry::mutate`]), so the emit order matches the mutation
/// order: concurrent stdout/stderr writes can't emit out of order and leave the
/// store's wholesale replace ending on a stale snapshot missing the latest line.
async fn run_shell_command(
    app_handle: &AppHandle,
    registry: &ModelSetupRegistry,
    provider_id: &str,
    command: &str,
) -> Result<(), String> {
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

    append_output(
        app_handle,
        registry,
        provider_id,
        "Starting Goose sign-in...",
    );

    let mut child = tokio::process::Command::new(shell)
        .arg(flag)
        .arg(command)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to start sign-in flow: {e}"))?;

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    let provider_id_stdout = provider_id.to_string();
    let app_stdout = app_handle.clone();
    let registry_stdout = registry.clone();

    let stdout_task = tokio::spawn(async move {
        let mut has_relevant_output = false;
        if let Some(stdout) = stdout {
            let reader = BufReader::new(stdout);
            let mut lines = reader.lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let Some(line) = normalize_output_line(&line) else {
                    continue;
                };

                if !has_relevant_output && is_relevant_output(&line) {
                    has_relevant_output = true;
                }

                if has_relevant_output {
                    append_output(&app_stdout, &registry_stdout, &provider_id_stdout, &line);
                }
            }
        }
    });

    let provider_id_stderr = provider_id.to_string();
    let app_stderr = app_handle.clone();
    let registry_stderr = registry.clone();

    let stderr_task = tokio::spawn(async move {
        let mut has_relevant_output = false;
        if let Some(stderr) = stderr {
            let reader = BufReader::new(stderr);
            let mut lines = reader.lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let Some(line) = normalize_output_line(&line) else {
                    continue;
                };

                if !has_relevant_output && is_relevant_output(&line) {
                    has_relevant_output = true;
                }

                if has_relevant_output {
                    append_output(&app_stderr, &registry_stderr, &provider_id_stderr, &line);
                }
            }
        }
    });

    let _ = tokio::join!(stdout_task, stderr_task);

    let status = child
        .wait()
        .await
        .map_err(|e| format!("Failed to wait for sign-in flow: {e}"))?;

    if status.success() {
        Ok(())
    } else {
        let code = status.code().unwrap_or(-1);
        Err(format!("Goose sign-in exited with code {code}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn begin_seeds_running_and_is_idempotent() {
        let registry = ModelSetupRegistry::default();

        let (started, operation) = registry.begin("databricks_v2");
        assert!(started);
        assert_eq!(operation.status, ModelSetupStatus::Running);
        assert_eq!(operation.phase, ModelSetupPhase::Authenticating);

        // Re-firing while running is a no-op that returns the live snapshot.
        let (started_again, again) = registry.begin("databricks_v2");
        assert!(!started_again);
        assert_eq!(again.status, ModelSetupStatus::Running);
        assert_eq!(registry.list().len(), 1);

        // Once terminal, a fresh begin replaces the entry and starts over.
        registry.mutate(
            "databricks_v2",
            |operation| {
                operation.status = ModelSetupStatus::Failed;
                operation.phase = ModelSetupPhase::Idle;
            },
            |_| {},
        );
        let (started_after_terminal, _) = registry.begin("databricks_v2");
        assert!(started_after_terminal);
        assert_eq!(
            registry.get("databricks_v2").unwrap().status,
            ModelSetupStatus::Running
        );
    }

    #[test]
    fn begin_starts_in_authenticating_phase() {
        let registry = ModelSetupRegistry::default();
        let (_, operation) = registry.begin("databricks_v2");
        assert_eq!(operation.phase, ModelSetupPhase::Authenticating);
    }

    #[test]
    fn mutate_transitions_phase_and_status() {
        let registry = ModelSetupRegistry::default();
        registry.begin("databricks_v2");

        registry.mutate(
            "databricks_v2",
            |operation| {
                operation.status = ModelSetupStatus::Succeeded;
                operation.phase = ModelSetupPhase::Idle;
            },
            |_| {},
        );
        let operation = registry.get("databricks_v2").unwrap();
        assert_eq!(operation.status, ModelSetupStatus::Succeeded);
        assert_eq!(operation.phase, ModelSetupPhase::Idle);
    }

    #[test]
    fn mutate_emits_the_applied_snapshot_under_lock() {
        let registry = ModelSetupRegistry::default();
        registry.begin("databricks_v2");

        // `on_snapshot` runs inside the lock and observes the just-applied
        // mutation, so emits stay ordered with mutations even when the two
        // reader tasks append concurrently.
        let mut emitted_output = None;
        registry.mutate(
            "databricks_v2",
            |operation| operation.output.push("hello".into()),
            |operation| emitted_output = Some(operation.output.clone()),
        );
        assert_eq!(emitted_output, Some(vec!["hello".to_string()]));
    }

    #[test]
    fn mutate_is_a_noop_for_a_cleared_entry() {
        let registry = ModelSetupRegistry::default();
        let mut emitted = false;
        assert!(registry
            .mutate(
                "never-started",
                |operation| operation.output.push("x".into()),
                |_| emitted = true,
            )
            .is_none());
        // No entry → no mutation and, crucially, no emit (otherwise a cleared
        // row could be resurrected by a stale snapshot).
        assert!(!emitted);
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

    fn operation_at(status: ModelSetupStatus, updated_at_ms: u64) -> ModelSetupOperation {
        ModelSetupOperation {
            phase: ModelSetupPhase::Idle,
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
        map.insert(
            "running".to_string(),
            operation_at(ModelSetupStatus::Running, 0),
        );
        map.insert(
            "stale".to_string(),
            operation_at(ModelSetupStatus::Succeeded, now - GC_TTL_MS - 1),
        );
        map.insert(
            "fresh".to_string(),
            operation_at(ModelSetupStatus::Failed, now - 1_000),
        );

        sweep_terminal(&mut map, now, GC_TTL_MS);

        assert!(map.contains_key("running"));
        assert!(!map.contains_key("stale"));
        assert!(map.contains_key("fresh"));
    }

    #[test]
    fn normalize_output_line_strips_ansi_and_drops_noise() {
        // ANSI colour escapes are stripped from a relevant line.
        assert_eq!(
            normalize_output_line("\x1b[32mAuthenticated as user@example.com\x1b[0m"),
            Some("Authenticated as user@example.com".to_string())
        );
        // UTF-8 prompt borders survive stripping so sign-in URLs remain relevant.
        assert_eq!(
            normalize_output_line("\x1b[32m│ Please visit https://example.com/login/device\x1b[0m"),
            Some("Please visit https://example.com/login/device".to_string())
        );
        // A plain relevant line passes through unchanged.
        assert_eq!(
            normalize_output_line("Please visit https://example.com"),
            Some("Please visit https://example.com".to_string())
        );
        // Structural `goose configure` prompts and blank lines are dropped.
        assert_eq!(normalize_output_line("   Configure Providers   "), None);
        assert_eq!(normalize_output_line(""), None);
    }

    #[test]
    fn is_relevant_output_gates_on_sign_in_signal() {
        // Sign-in-relevant lines pass; incidental chatter is held back until one
        // does (mirrors the per-stream `has_relevant_output` latch).
        assert!(is_relevant_output(
            "Please visit https://example.com/login/device"
        ));
        assert!(is_relevant_output("Authenticated as user@example.com"));
        assert!(is_relevant_output("Opening browser..."));
        assert!(!is_relevant_output("some unrelated log line"));
    }
}
