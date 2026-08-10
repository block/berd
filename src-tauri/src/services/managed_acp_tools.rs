//! Berd-managed ACP tool installs.
//!
//! Berd owns both sides of every npm-backed agent install: the managed Node
//! runtime (`managed_node`) supplies `node`/`npm`, and everything npm writes
//! lands in Berd-private directories under `<app-data>/packages` instead of
//! the host's global prefix. Two install families live here:
//!
//! - **Private npm prefix** (`packages/npm-prefix`): the doctor crate's
//!   runtime `npm install -g` fixes (copilot, amp-acp) are steered here by the
//!   env pairs in [`managed_npm_env`].
//! - **Managed bridges** (`packages/tools` + `packages/bin`): the claude/codex
//!   ACP bridges in [`MANAGED_TOOLS`]. [`install_managed_tool`] installs — or
//!   upgrades — each to the latest published version with a floating
//!   `npm install <pkg>@latest --prefix` on the managed runtime, writes an
//!   absolute-path shim into `packages/bin` (no host `node` on PATH required),
//!   and records the installed version in `packages/state.json`. The startup
//!   reconciler (`acp_tools_reconciler`) runs this for every managed bridge on
//!   launch, so a new bridge release ships to users the next time Berd starts.
//!
//! `BERD_ACP_TOOLS_DIR` stays honored as a dev/bridge-developer override: when
//! set, managed resolution short-circuits (no managed tools, no shim dir, no
//! installs) so the override dir is the one source of bridge binaries. The
//! `no-managed-acp-tools` build feature compiles the managed bridge set to
//! empty for restricted builds, so nothing installs and the checks stay silent.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;

use tauri::Manager;
use tokio::io::AsyncBufReadExt;

use crate::services::{env_key, managed_node};

/// Dev/bridge-developer override: a directory of bridge binaries that
/// replaces all managed resolution (no managed tools, no shim dir, no
/// installs).
pub const ACP_TOOLS_DIR_ENV: &str = "BERD_ACP_TOOLS_DIR";

/// Floating bridge installs download ~70-95 MB of packages through the
/// registry; a hung npm must not wedge the install mutex forever.
const NPM_INSTALL_TIMEOUT: Duration = Duration::from_secs(15 * 60);

/// `<app-data>/packages` — the root every Berd-managed npm asset (node
/// runtime, npm prefix, managed bridge installs, and bin shims) lives under.
/// Named `packages` rather than `acp` because npm pulls in dependencies that
/// are not themselves ACP bridges (and the Node runtime lives here too).
pub fn managed_packages_root<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|dir| dir.join("packages"))
}

/// The Berd-private npm global prefix, `<app-data>/packages/npm-prefix`.
pub fn npm_prefix_dir<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Option<PathBuf> {
    managed_packages_root(app).map(|dir| dir.join("npm-prefix"))
}

/// Where npm writes global bin shims for the private prefix. Target-aware:
/// `<prefix>/bin` on Unix, the prefix root itself on Windows (npm places
/// global `.cmd`/`.exe` shims at the prefix root, not under `bin/`).
pub fn npm_prefix_bin_dir<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Option<PathBuf> {
    npm_prefix_dir(app).map(|dir| npm_global_bin_dir(&dir))
}

/// The directory npm writes global-prefix executables into under `prefix`,
/// following the current target's runtime layout. Falls back to the Unix
/// `<prefix>/bin` when no runtime is pinned for this target (no managed tools
/// run there anyway).
pub fn npm_global_bin_dir(prefix: &Path) -> PathBuf {
    match managed_node::RuntimeLayout::current() {
        Some(layout) => layout.npm_prefix_bin_dir(prefix),
        None => prefix.join("bin"),
    }
}

/// `<app-data>/packages/bin` — the Berd-written shims for managed bridges.
/// `None` when this build does not manage bridges or while the
/// `BERD_ACP_TOOLS_DIR` dev override is active, so stale managed shims cannot
/// resolve in either posture.
pub fn managed_shim_bin_dir<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Option<PathBuf> {
    if !managed_bridges_enabled() {
        return None;
    }
    managed_packages_root(app).map(|root| shim_bin_dir(&root))
}

fn managed_bridges_enabled() -> bool {
    managed_bridges_enabled_from_parts(
        dev_tools_override_active(),
        cfg!(feature = "no-managed-acp-tools"),
        managed_node::current_target_triple().is_some(),
    )
}

fn managed_bridges_enabled_from_parts(
    override_active: bool,
    managed_tools_disabled: bool,
    supported_target: bool,
) -> bool {
    !override_active && !managed_tools_disabled && supported_target
}

fn dev_tools_override_active() -> bool {
    dev_tools_override_dir().is_some()
}

/// The `BERD_ACP_TOOLS_DIR` override dir, when set and non-empty.
pub fn dev_tools_override_dir() -> Option<PathBuf> {
    std::env::var_os(ACP_TOOLS_DIR_ENV)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

fn shim_bin_dir(packages_root: &Path) -> PathBuf {
    packages_root.join("bin")
}

fn tools_root(packages_root: &Path) -> PathBuf {
    packages_root.join("tools")
}

/// `<app-data>/packages/tools/<id>` — the npm `--prefix` a managed bridge installs
/// into. Floating upgrades reuse the same prefix, so the entrypoint path the
/// shim points at is version-independent.
fn tool_install_dir(packages_root: &Path, id: &str) -> PathBuf {
    tools_root(packages_root).join(id)
}

fn state_path(packages_root: &Path) -> PathBuf {
    packages_root.join("state.json")
}

/// `<install-dir>/node_modules/<package>/dist/index.js` — the bridge
/// entrypoint convention both managed bridges follow.
fn npm_entrypoint(install_dir: &Path, package: &str) -> PathBuf {
    package_dir(install_dir, package)
        .join("dist")
        .join("index.js")
}

fn package_dir(install_dir: &Path, package: &str) -> PathBuf {
    package
        .split('/')
        .fold(install_dir.join("node_modules"), |dir, part| dir.join(part))
}

/// Directories to prepend (in order) wherever agent binaries must resolve:
/// the `BERD_ACP_TOOLS_DIR` dev override when active (it replaces the
/// managed shim dir), then the managed bridge shims, the private prefix's bin
/// shims, and the managed Node runtime's bin dir — the latter is what makes
/// npm's `#!/usr/bin/env node` shims run without host Node, and what resolves
/// `npm` itself for install fixes.
pub fn managed_prepend_dirs<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Vec<PathBuf> {
    managed_prepend_dirs_from_parts(
        dev_tools_override_dir(),
        managed_shim_bin_dir(app),
        npm_prefix_bin_dir(app),
        managed_node::managed_node_bin_dir(app),
    )
}

fn managed_prepend_dirs_from_parts(
    override_bin: Option<PathBuf>,
    shim_bin: Option<PathBuf>,
    npm_prefix_bin: Option<PathBuf>,
    node_bin: Option<PathBuf>,
) -> Vec<PathBuf> {
    override_bin
        .into_iter()
        .chain(shim_bin)
        .chain(npm_prefix_bin)
        .chain(node_bin)
        .collect()
}

/// The directory whose binaries the doctor crate labels `Bundled` (no
/// registry install/update fix): the dev override dir when active, otherwise
/// the managed shim dir the bridge installer writes into. Berd upgrades these
/// bridges itself on launch, so the crate must not nag the user to update
/// them manually.
pub fn bundled_tools_dir_for_checks(app: &tauri::AppHandle) -> Option<PathBuf> {
    dev_tools_override_dir().or_else(|| managed_shim_bin_dir(app))
}

/// Env pairs steering every npm invocation Berd spawns into the private
/// prefix. Both spellings are set: npm canonically reads the lowercase
/// `npm_config_*` form, but tooling conventionally exports the uppercase one.
/// `sanitize_shell_env` already strips user-shell values for these keys from
/// captured snapshots, so these pairs are authoritative, not a race.
pub fn managed_npm_env<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Vec<(String, String)> {
    npm_prefix_dir(app)
        .map(|prefix| managed_npm_env_at(&prefix))
        .unwrap_or_default()
}

pub fn managed_npm_env_at(prefix: &Path) -> Vec<(String, String)> {
    let prefix_value = prefix.to_string_lossy().into_owned();
    let cache_value = prefix.join("cache").to_string_lossy().into_owned();
    let corepack_value = prefix.join("corepack").to_string_lossy().into_owned();
    vec![
        ("NPM_CONFIG_PREFIX".to_string(), prefix_value.clone()),
        ("npm_config_prefix".to_string(), prefix_value),
        ("NPM_CONFIG_CACHE".to_string(), cache_value.clone()),
        ("npm_config_cache".to_string(), cache_value),
        ("COREPACK_HOME".to_string(), corepack_value),
    ]
}

/// Overlay the managed npm env onto an environment snapshot, replacing any
/// same-named entries so a stray inherited value can never win.
pub fn apply_managed_npm_env(vars: &mut Vec<(String, String)>, overrides: &[(String, String)]) {
    for (key, value) in overrides {
        env_key::upsert_vec(vars, key, value.clone());
    }
}

/// Whether a doctor fix command runs through npm — and therefore needs the
/// managed Node runtime installed first. Mirrors the doctor crate's (private)
/// npm-command predicate so the two stay in agreement about which commands
/// get registry/env treatment.
pub fn is_npm_backed_command(command: &str) -> bool {
    command.starts_with("npm ") || command.contains("npm install") || command.contains("npm view")
}

// ---------------------------------------------------------------------------
// The managed bridge set — installed and upgraded from the private npm registry
// ---------------------------------------------------------------------------

/// A Berd-managed ACP bridge: installed and upgraded from the private npm
/// registry at runtime (see [`install_managed_tool`]) rather than pinned or
/// bundled.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ManagedTool {
    /// The frontend provider id (e.g. `claude-acp`).
    pub id: &'static str,
    /// The bin name the shim is written under and that goosed resolves.
    pub binary: &'static str,
    /// The npm package installed from the private registry.
    pub package: &'static str,
}

/// The ACP bridges Berd installs and upgrades on every launch. Both vendor
/// their agent's full CLI (Claude Code, `codex`) inside the npm package, so
/// no separate main-CLI install is needed.
pub const MANAGED_TOOLS: &[ManagedTool] = &[
    ManagedTool {
        id: "claude-acp",
        binary: "claude-agent-acp",
        package: "@agentclientprotocol/claude-agent-acp",
    },
    ManagedTool {
        id: "codex-acp",
        binary: "codex-acp",
        package: "@agentclientprotocol/codex-acp",
    },
];

/// The managed bridges this build installs at runtime, or an empty list when
/// nothing is managed: the `BERD_ACP_TOOLS_DIR` dev override supplies bridges
/// from its own dir, the `no-managed-acp-tools` feature compiles the set out
/// for restricted builds, and an unsupported target has no managed runtime to
/// install onto.
pub fn managed_tools() -> Vec<ManagedTool> {
    if !managed_bridges_enabled() {
        return Vec::new();
    }
    MANAGED_TOOLS.to_vec()
}

/// The managed bridge for a provider id, when this build manages it.
pub fn managed_tool(provider_id: &str) -> Option<ManagedTool> {
    managed_tools()
        .into_iter()
        .find(|tool| tool.id == provider_id)
}

/// Whether this provider id installs through the managed bridge installer on
/// this build and target (claude-acp / codex-acp, unless the dev override or
/// the disable feature is active).
pub fn is_managed(provider_id: &str) -> bool {
    managed_tool(provider_id).is_some()
}

// ---------------------------------------------------------------------------
// state.json — installed versions + last reconcile result
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ManagedToolsState {
    pub tools: BTreeMap<String, InstalledToolPin>,
    pub last_reconcile: Option<ReconcileRecord>,
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledToolPin {
    pub binary: String,
    /// The version npm resolved for `<pkg>@latest`, recorded for the reconcile
    /// log and the doctor readout. Empty when the installed `package.json`
    /// could not be read.
    pub version: String,
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReconcileRecord {
    pub at_ms: u64,
    pub ok: bool,
    #[serde(default)]
    pub errors: Vec<String>,
}

/// Read `packages/state.json`; a missing or corrupt file is an empty state.
pub(crate) fn read_state(packages_root: &Path) -> ManagedToolsState {
    std::fs::read_to_string(state_path(packages_root))
        .ok()
        .and_then(|json| serde_json::from_str(&json).ok())
        .unwrap_or_default()
}

fn write_state(packages_root: &Path, state: &ManagedToolsState) -> std::io::Result<()> {
    std::fs::create_dir_all(packages_root)?;
    let path = state_path(packages_root);
    let temp = path.with_extension("json.tmp");
    let json = serde_json::to_string_pretty(state).map_err(std::io::Error::other)?;
    std::fs::write(&temp, format!("{json}\n"))?;
    std::fs::rename(&temp, &path)
}

/// The runtime layout for the current target. `install_managed_tool` only
/// runs when a managed runtime is pinned (bridges are disabled otherwise), so
/// resolution failing here means the managed set changed under a running
/// operation.
fn runtime_layout() -> Result<managed_node::RuntimeLayout, ManagedToolError> {
    managed_node::RuntimeLayout::current().ok_or_else(|| {
        ManagedToolError::NotManaged("no managed Node.js runtime pin for this target".to_string())
    })
}

fn node_binary(layout: &managed_node::RuntimeLayout, node_install_dir: &Path) -> PathBuf {
    layout.node_exe(node_install_dir)
}

/// The file name a bridge shim is written under and that goosed resolves by
/// bare name. On Windows that is `<binary>.cmd` (a batch launcher resolved via
/// `PATHEXT`); elsewhere it is the extensionless `<binary>`.
fn shim_file_name(layout: &managed_node::RuntimeLayout, binary: &str) -> String {
    if layout.is_windows() {
        format!("{binary}.cmd")
    } else {
        binary.to_string()
    }
}

// ---------------------------------------------------------------------------
// install_managed_tool — floating npm install + shim + state
// ---------------------------------------------------------------------------

#[derive(Debug)]
pub enum ManagedToolError {
    AppData(String),
    /// This provider is not managed on this build/target; callers route it
    /// before installing, so surfacing one means the managed set changed under
    /// a running operation.
    NotManaged(String),
    Node(managed_node::ManagedNodeError),
    NpmInstall(String),
    /// The install exited cleanly but produced no runnable bridge — a floor
    /// check replacing the old lock's integrity validation.
    Incomplete(String),
    Io(String),
}

impl std::fmt::Display for ManagedToolError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::AppData(message) => {
                write!(
                    f,
                    "failed to resolve the managed ACP tools directory: {message}"
                )
            }
            Self::NotManaged(message) => {
                write!(f, "not a Berd-managed ACP bridge: {message}")
            }
            Self::Node(error) => error.fmt(f),
            Self::NpmInstall(message) => write!(f, "npm install failed: {message}"),
            Self::Incomplete(message) => {
                write!(f, "installed ACP bridge is incomplete: {message}")
            }
            Self::Io(message) => write!(f, "{message}"),
        }
    }
}

impl std::error::Error for ManagedToolError {}

pub type InstallLineFn<'a> = dyn Fn(&str) + Send + Sync + 'a;

fn tool_install_lock() -> &'static tokio::sync::Mutex<()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

/// Install (or upgrade) one managed bridge to the latest published version:
/// ensure the managed Node runtime, run the floating `npm install
/// <pkg>@latest --prefix`, write the absolute-path shim, and record the
/// installed version in `state.json`. Safe to call concurrently — provider
/// installs, doctor fixes, and the startup reconciler all serialize on one
/// process-wide install mutex. A failed install leaves any previously
/// installed version in place — including the Node runtime its shim execs,
/// since superseded runtimes are pruned only after a fully-successful
/// reconcile — so an offline launch never removes a working bridge.
pub async fn install_managed_tool(
    app: &tauri::AppHandle,
    provider_id: &str,
    on_line: &InstallLineFn<'_>,
) -> Result<(), ManagedToolError> {
    let tool = managed_tool(provider_id).ok_or_else(|| {
        ManagedToolError::NotManaged(format!("'{provider_id}' is not a Berd-managed ACP bridge"))
    })?;
    let packages_root = managed_packages_root(app).ok_or_else(|| {
        ManagedToolError::AppData("app data directory is unavailable".to_string())
    })?;
    let node_root = managed_node::managed_node_root(app).ok_or_else(|| {
        ManagedToolError::AppData("app data directory is unavailable".to_string())
    })?;
    let node_install_dir = managed_node::pinned_install_dir(&node_root).ok_or_else(|| {
        ManagedToolError::NotManaged("no managed Node.js runtime pin for this target".to_string())
    })?;
    let layout = runtime_layout()?;

    let _guard = tool_install_lock().lock().await;
    let progress = managed_node::progress_line_reporter(|line| on_line(&line));
    managed_node::ensure_managed_node_runtime(app, &progress)
        .await
        .map_err(ManagedToolError::Node)?;
    let npm_registry = crate::commands::agent_setup::npm_registry(app);
    install_npm_tool(
        &packages_root,
        &node_install_dir,
        &layout,
        &tool,
        npm_registry.as_deref(),
        on_line,
    )
    .await
}

/// The install body, path-parameterized so tests drive it with a fixture
/// `npm`. Caller holds the install mutex and has ensured the runtime.
async fn install_npm_tool(
    packages_root: &Path,
    node_install_dir: &Path,
    layout: &managed_node::RuntimeLayout,
    tool: &ManagedTool,
    registry: Option<&str>,
    on_line: &InstallLineFn<'_>,
) -> Result<(), ManagedToolError> {
    let install_dir = tool_install_dir(packages_root, tool.id);
    let shim_path = shim_bin_dir(packages_root).join(shim_file_name(layout, tool.binary));
    let state_file = state_path(packages_root);
    let transaction = InstallTransaction::new(&install_dir, &shim_path, &state_file);
    transaction.prepare().map_err(|error| {
        ManagedToolError::Io(format!("prepare ACP install transaction: {error}"))
    })?;

    on_line(&format!(
        "Installing {}@latest into Berd's app data",
        tool.package
    ));
    let install_result = run_floating_npm_install(
        packages_root,
        node_install_dir,
        layout,
        &transaction.staged_tree,
        tool,
        registry,
        on_line,
    )
    .await;
    if let Err(error) = install_result {
        transaction.cleanup_staged();
        return Err(error);
    }

    let staged_entrypoint = npm_entrypoint(&transaction.staged_tree, tool.package);
    if !staged_entrypoint.is_file() {
        transaction.cleanup_staged();
        return Err(ManagedToolError::Incomplete(format!(
            "{}: bridge entrypoint {} is missing after install",
            tool.package,
            staged_entrypoint.display()
        )));
    }
    let version = installed_version(&transaction.staged_tree, tool.package).unwrap_or_default();
    let live_entrypoint = npm_entrypoint(&install_dir, tool.package);

    write_staged_shim(
        &transaction.staged_shim,
        &shim_contents(
            layout,
            &node_binary(layout, node_install_dir),
            &live_entrypoint,
        ),
    )
    .map_err(|error| {
        transaction.cleanup_staged();
        ManagedToolError::Io(format!("stage bridge shim: {error}"))
    })?;

    let mut state = read_state(packages_root);
    state.tools.insert(
        tool.id.to_string(),
        InstalledToolPin {
            binary: tool.binary.to_string(),
            version: version.clone(),
        },
    );
    write_staged_state(&transaction.staged_state, &state).map_err(|error| {
        transaction.cleanup_staged();
        ManagedToolError::Io(format!("stage state.json: {error}"))
    })?;

    transaction.commit().map_err(|error| {
        ManagedToolError::Io(format!("commit ACP install transaction: {error}"))
    })?;
    on_line(&format!(
        "{}@{} is ready",
        tool.package,
        if version.is_empty() {
            "latest"
        } else {
            version.as_str()
        }
    ));
    Ok(())
}

#[derive(Clone, Copy, serde::Serialize, serde::Deserialize)]
enum ArtifactKind {
    Directory,
    File,
}

#[derive(serde::Serialize, serde::Deserialize)]
struct TransactionArtifact {
    staged: PathBuf,
    live: PathBuf,
    backup: PathBuf,
    kind: ArtifactKind,
    existed: bool,
}

impl TransactionArtifact {
    fn new(staged: PathBuf, live: PathBuf, backup: PathBuf, kind: ArtifactKind) -> Self {
        Self {
            staged,
            live,
            backup,
            kind,
            existed: false,
        }
    }

    fn remove(path: &Path, kind: ArtifactKind) -> std::io::Result<()> {
        if !path.exists() {
            return Ok(());
        }
        match kind {
            ArtifactKind::Directory => std::fs::remove_dir_all(path),
            ArtifactKind::File => std::fs::remove_file(path),
        }
    }
}

#[derive(serde::Serialize, serde::Deserialize)]
struct TransactionJournal {
    committed: bool,
    artifacts: Vec<TransactionArtifact>,
}

struct InstallTransaction {
    staged_tree: PathBuf,
    staged_shim: PathBuf,
    staged_state: PathBuf,
    artifacts: [TransactionArtifact; 3],
    journal: PathBuf,
}

impl InstallTransaction {
    fn new(install_dir: &Path, shim_path: &Path, state_file: &Path) -> Self {
        let nonce = now_ms();
        static TRANSACTION_SEQUENCE: std::sync::atomic::AtomicU64 =
            std::sync::atomic::AtomicU64::new(0);
        let sequence = TRANSACTION_SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let suffix = format!("{}-{nonce}-{sequence}", std::process::id());
        let paths = |live: &Path| {
            let parent = live.parent().expect("managed artifact has a parent");
            let name = live
                .file_name()
                .expect("managed artifact has a name")
                .to_string_lossy();
            (
                parent.join(format!(".{name}.berd-stage-{suffix}")),
                parent.join(format!(".{name}.berd-backup")),
            )
        };
        let (staged_tree, backup_tree) = paths(install_dir);
        let (staged_shim, backup_shim) = paths(shim_path);
        let (staged_state, backup_state) = paths(state_file);
        let journal = state_file
            .parent()
            .expect("state file has a parent")
            .join(".managed-acp-transaction.json");
        Self {
            staged_tree: staged_tree.clone(),
            staged_shim: staged_shim.clone(),
            staged_state: staged_state.clone(),
            artifacts: [
                TransactionArtifact::new(
                    staged_tree,
                    install_dir.to_path_buf(),
                    backup_tree,
                    ArtifactKind::Directory,
                ),
                TransactionArtifact::new(
                    staged_shim,
                    shim_path.to_path_buf(),
                    backup_shim,
                    ArtifactKind::File,
                ),
                TransactionArtifact::new(
                    staged_state,
                    state_file.to_path_buf(),
                    backup_state,
                    ArtifactKind::File,
                ),
            ],
            journal,
        }
    }

    fn prepare(&self) -> std::io::Result<()> {
        for artifact in &self.artifacts {
            if let Some(parent) = artifact.live.parent() {
                std::fs::create_dir_all(parent)?;
            }
        }
        recover_transaction(&self.journal)?;
        remove_transaction_journal_temp(&self.journal)?;
        for artifact in &self.artifacts {
            prune_stale_transaction_stages(artifact)?;
            TransactionArtifact::remove(&artifact.staged, artifact.kind)?;
            if artifact.backup.exists() {
                return Err(std::io::Error::other(format!(
                    "orphaned ACP backup without transaction journal: {}",
                    artifact.backup.display()
                )));
            }
        }
        std::fs::create_dir_all(&self.staged_tree)
    }

    fn cleanup_staged(&self) {
        for artifact in &self.artifacts {
            if let Err(error) = TransactionArtifact::remove(&artifact.staged, artifact.kind) {
                log::warn!(
                    "failed to remove staged ACP artifact {}: {error}",
                    artifact.staged.display()
                );
            }
        }
    }

    fn commit(mut self) -> std::io::Result<()> {
        for artifact in &mut self.artifacts {
            artifact.existed = artifact.live.exists();
        }
        write_transaction_journal(&self.journal, false, &self.artifacts)?;
        let result = (|| {
            for artifact in &self.artifacts {
                if artifact.existed {
                    transaction_rename(&artifact.live, &artifact.backup)?;
                }
            }
            for artifact in &self.artifacts {
                transaction_rename(&artifact.staged, &artifact.live)?;
            }
            write_transaction_journal(&self.journal, true, &self.artifacts)
        })();
        if let Err(commit_error) = result {
            if let Err(rollback) = recover_transaction(&self.journal) {
                self.cleanup_staged();
                return Err(std::io::Error::other(format!("{commit_error}; rollback also failed: {rollback}; recovery journal remains at {}", self.journal.display())));
            }
            self.cleanup_staged();
            return Err(commit_error);
        }
        if let Err(finalize) = recover_transaction(&self.journal) {
            return Err(std::io::Error::other(format!("install committed but backup cleanup failed: {finalize}; committed journal remains at {}", self.journal.display())));
        }
        Ok(())
    }
}

fn transaction_journal_temp_path(path: &Path) -> PathBuf {
    path.with_extension("json.tmp")
}

fn remove_transaction_journal_temp(path: &Path) -> std::io::Result<()> {
    match std::fs::remove_file(transaction_journal_temp_path(path)) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

fn write_transaction_journal(
    path: &Path,
    committed: bool,
    artifacts: &[TransactionArtifact],
) -> std::io::Result<()> {
    let journal = TransactionJournal {
        committed,
        artifacts: artifacts
            .iter()
            .map(|artifact| TransactionArtifact {
                staged: artifact.staged.clone(),
                live: artifact.live.clone(),
                backup: artifact.backup.clone(),
                kind: artifact.kind,
                existed: artifact.existed,
            })
            .collect(),
    };
    let temp = transaction_journal_temp_path(path);
    let json = serde_json::to_string_pretty(&journal).map_err(std::io::Error::other)?;
    std::fs::write(&temp, format!("{json}\n"))?;
    std::fs::rename(temp, path)
}

fn journal_recovery_error(path: &Path, detail: impl std::fmt::Display) -> std::io::Error {
    std::io::Error::other(format!(
        "cannot recover managed ACP transaction journal {}: {detail}. Preserve this file and any .berd-backup artifacts, restore access or repair/remove the journal after inspecting those backups, then restart Berd",
        path.display()
    ))
}

fn recover_transaction(path: &Path) -> std::io::Result<()> {
    let json = match std::fs::read_to_string(path) {
        Ok(json) => json,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(journal_recovery_error(path, error)),
    };
    let journal: TransactionJournal = serde_json::from_str(&json)
        .map_err(|error| journal_recovery_error(path, format!("invalid JSON: {error}")))?;
    validate_transaction_journal(path, &journal)
        .map_err(|error| journal_recovery_error(path, error))?;
    if journal.committed {
        for artifact in &journal.artifacts {
            TransactionArtifact::remove(&artifact.backup, artifact.kind)?;
        }
    } else {
        for artifact in journal.artifacts.iter().rev() {
            if artifact.existed {
                if artifact.backup.exists() {
                    TransactionArtifact::remove(&artifact.live, artifact.kind)?;
                    transaction_rename(&artifact.backup, &artifact.live)?;
                }
            } else {
                TransactionArtifact::remove(&artifact.live, artifact.kind)?;
            }
        }
    }
    for artifact in &journal.artifacts {
        TransactionArtifact::remove(&artifact.staged, artifact.kind)?;
    }
    std::fs::remove_file(path)
}

fn validate_transaction_journal(path: &Path, journal: &TransactionJournal) -> std::io::Result<()> {
    let root = path
        .parent()
        .ok_or_else(|| std::io::Error::other("ACP transaction journal has no parent"))?;
    if journal.artifacts.len() != 3 {
        return Err(std::io::Error::other(
            "ACP transaction journal must contain exactly three artifacts",
        ));
    }
    for artifact in &journal.artifacts {
        for candidate in [&artifact.live, &artifact.staged, &artifact.backup] {
            if !candidate.is_absolute() || !candidate.starts_with(root) {
                return Err(std::io::Error::other(format!(
                    "ACP transaction journal path escapes packages root: {}",
                    candidate.display()
                )));
            }
        }
    }
    Ok(())
}

fn prune_stale_transaction_stages(artifact: &TransactionArtifact) -> std::io::Result<()> {
    let Some(parent) = artifact.live.parent() else {
        return Ok(());
    };
    let name = artifact
        .live
        .file_name()
        .expect("managed artifact has a name")
        .to_string_lossy();
    let prefix = format!(".{name}.berd-stage-");
    for entry in std::fs::read_dir(parent)? {
        let entry = entry?;
        if entry.file_name().to_string_lossy().starts_with(&prefix) {
            TransactionArtifact::remove(&entry.path(), artifact.kind)?;
        }
    }
    Ok(())
}

fn write_staged_shim(path: &Path, contents: &str) -> std::io::Result<()> {
    std::fs::write(path, contents)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755))?;
    }
    Ok(())
}

fn write_staged_state(path: &Path, state: &ManagedToolsState) -> std::io::Result<()> {
    let json = serde_json::to_string_pretty(state).map_err(std::io::Error::other)?;
    std::fs::write(path, format!("{json}\n"))
}

#[cfg(not(test))]
fn transaction_rename(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::rename(from, to)
}

#[cfg(test)]
thread_local! {
    static RENAME_FAILURES: std::cell::RefCell<Vec<usize>> = const { std::cell::RefCell::new(Vec::new()) };
    static RENAME_COUNT: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

#[cfg(test)]
fn transaction_rename(from: &Path, to: &Path) -> std::io::Result<()> {
    let call = RENAME_COUNT.with(|count| {
        let call = count.get();
        count.set(call + 1);
        call
    });
    let fail = RENAME_FAILURES.with(|calls| calls.borrow().contains(&call));
    if fail {
        Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "injected transaction rename failure",
        ))
    } else {
        std::fs::rename(from, to)
    }
}

/// The version npm resolved for the just-installed package, from its
/// `package.json`. Best-effort: the state record is informational, so an
/// unreadable version does not fail the install.
fn installed_version(install_dir: &Path, package: &str) -> Option<String> {
    let json =
        std::fs::read_to_string(package_dir(install_dir, package).join("package.json")).ok()?;
    let value: serde_json::Value = serde_json::from_str(&json).ok()?;
    value
        .get("version")
        .and_then(serde_json::Value::as_str)
        .map(str::to_string)
}

async fn run_floating_npm_install(
    packages_root: &Path,
    node_install_dir: &Path,
    layout: &managed_node::RuntimeLayout,
    install_dir: &Path,
    tool: &ManagedTool,
    registry: Option<&str>,
    on_line: &InstallLineFn<'_>,
) -> Result<(), ManagedToolError> {
    let node_bin_dir = layout.bin_dir(node_install_dir);
    // On Windows npm is driven through `node.exe <npm-cli.js>` so no `cmd.exe`
    // batch/`PATHEXT` resolution is involved; on Unix the `bin/npm` shim is
    // spawned directly. Either way npm's own args follow any leading args.
    let npm = layout.npm_command(node_install_dir);
    let mut command = tokio::process::Command::new(&npm.program);
    command
        .args(&npm.leading_args)
        .arg("install")
        .arg("--prefix")
        .arg(install_dir)
        .args([
            "--omit=dev",
            "--include=optional",
            "--ignore-scripts",
            "--no-audit",
            "--no-fund",
        ]);
    if let Some(registry) = registry {
        command.arg("--registry").arg(registry);
    }
    // `@latest` floats to the newest published version; npm on the managed
    // runtime resolves the platform-native optional dependency for the running
    // machine on its own, so no `--os`/`--cpu` pinning is needed.
    command.arg(format!("{}@latest", tool.package));

    // npm's own `#!/usr/bin/env node` shebang (Unix) or its child `node`
    // lookups must resolve the managed node first.
    let mut paths = vec![node_bin_dir.clone()];
    paths.extend(std::env::split_paths(
        &std::env::var_os("PATH").unwrap_or_default(),
    ));
    if let Ok(path_value) = std::env::join_paths(paths) {
        command.env("PATH", path_value);
    }
    // Share the private prefix's download cache; `--prefix` on the command
    // line outranks any inherited prefix config.
    let cache = packages_root.join("npm-prefix").join("cache");
    command.env("NPM_CONFIG_CACHE", &cache);
    command.env("npm_config_cache", &cache);
    command
        .current_dir(install_dir)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    crate::services::process::apply_no_window_async(&mut command);

    let mut child = command
        .spawn()
        .map_err(|error| ManagedToolError::NpmInstall(format!("spawn managed npm: {error}")))?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let forward_out = async {
        if let Some(stream) = stdout {
            let mut lines = tokio::io::BufReader::new(stream).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                on_line(&line);
            }
        }
    };
    let forward_err = async {
        if let Some(stream) = stderr {
            let mut lines = tokio::io::BufReader::new(stream).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                on_line(&line);
            }
        }
    };
    let wait = async {
        match tokio::time::timeout(NPM_INSTALL_TIMEOUT, child.wait()).await {
            Ok(result) => result
                .map_err(|error| ManagedToolError::NpmInstall(format!("wait on npm: {error}"))),
            Err(_) => {
                let _ = child.kill().await;
                Err(ManagedToolError::NpmInstall(format!(
                    "timed out after {} seconds",
                    NPM_INSTALL_TIMEOUT.as_secs()
                )))
            }
        }
    };
    let (status, (), ()) = tokio::join!(wait, forward_out, forward_err);
    let status = status?;
    if status.success() {
        Ok(())
    } else {
        Err(ManagedToolError::NpmInstall(format!(
            "npm install exited with {status}"
        )))
    }
}

/// Shim body for a managed bridge. Both paths are absolute, so the shim needs
/// no `node` on PATH and cannot hit the old wrapper's exit-127 mode. On
/// Windows the launcher is a `.cmd` batch script (resolved by bare name via
/// `PATHEXT`); elsewhere it is a `#!/bin/sh` script.
fn shim_contents(layout: &managed_node::RuntimeLayout, node: &Path, entrypoint: &Path) -> String {
    if layout.is_windows() {
        // `@echo off` suppresses command echo; `%*` forwards every argument
        // verbatim; the bare final invocation propagates node's exit code as
        // the batch script's exit code.
        format!(
            "@echo off\r\nREM Written by Berd's managed ACP tools installer; do not edit.\r\n{} {} %*\r\n",
            cmd_quote(node),
            cmd_quote(entrypoint)
        )
    } else {
        format!(
            "#!/bin/sh\n# Written by Berd's managed ACP tools installer; do not edit.\nexec {} {} \"$@\"\n",
            sh_quote(node),
            sh_quote(entrypoint)
        )
    }
}

fn sh_quote(path: &Path) -> String {
    format!("'{}'", path.to_string_lossy().replace('\'', r"'\''"))
}

/// Double-quote a path for a `.cmd` batch script. Windows paths cannot contain
/// `"`, so wrapping in double quotes is sufficient to tolerate spaces.
fn cmd_quote(path: &Path) -> String {
    format!("\"{}\"", path.to_string_lossy())
}

/// Reconcile epilogue: drop installs for ids no longer in the managed set
/// (their shims, tool dirs, and state entries), record the run's outcome in
/// `state.json`, and — only when every managed bridge installed cleanly —
/// prune superseded managed Node runtimes. Takes the install mutex so it
/// cannot race an in-flight install.
pub(crate) async fn finish_reconcile(
    app: &tauri::AppHandle,
    managed: &[ManagedTool],
    errors: Vec<String>,
) {
    let (Some(packages_root), Some(node_root)) = (
        managed_packages_root(app),
        managed_node::managed_node_root(app),
    ) else {
        return;
    };
    finish_reconcile_at(&packages_root, &node_root, managed, errors).await;
}

async fn finish_reconcile_at(
    packages_root: &Path,
    node_root: &Path,
    managed: &[ManagedTool],
    errors: Vec<String>,
) {
    let all_installed = errors.is_empty();
    let _guard = tool_install_lock().lock().await;
    if let Err(error) = recover_transaction(&packages_root.join(".managed-acp-transaction.json")) {
        log::error!("failed to recover interrupted managed ACP transaction: {error}");
        return;
    }
    prune_stale_managed_tools(packages_root, managed);
    record_reconcile(packages_root, errors);
    // Success-gated Node prune: `errors` empty means every managed bridge
    // reinstalled this run, so every shim now embeds the pinned runtime's
    // path and superseded runtimes are unreferenced. On partial failure the
    // old runtime is kept — the failed bridge's un-rewritten shim still
    // resolves a real Node, so an offline launch never breaks a working
    // bridge.
    if all_installed {
        managed_node::prune_superseded_node_runtimes(node_root).await;
    }
}

pub(crate) fn prune_stale_managed_tools(packages_root: &Path, managed: &[ManagedTool]) {
    let managed_ids: Vec<&str> = managed.iter().map(|tool| tool.id).collect();
    // The on-disk shim file names (target-aware: `<binary>.cmd` on Windows),
    // not the bare binary names — so the directory sweep keeps the real
    // launcher and does not delete it as an unknown file.
    let layout = managed_node::RuntimeLayout::current();
    let shim_name = |binary: &str| match layout {
        Some(layout) => shim_file_name(&layout, binary),
        None => binary.to_string(),
    };
    let managed_shim_names: Vec<String> =
        managed.iter().map(|tool| shim_name(tool.binary)).collect();

    let mut state = read_state(packages_root);
    let stale: Vec<String> = state
        .tools
        .keys()
        .filter(|id| !managed_ids.contains(&id.as_str()))
        .cloned()
        .collect();
    for id in &stale {
        if let Some(pin) = state.tools.remove(id) {
            let _ = std::fs::remove_file(shim_bin_dir(packages_root).join(shim_name(&pin.binary)));
        }
    }
    if !stale.is_empty() {
        if let Err(error) = write_state(packages_root, &state) {
            log::warn!("failed to write ACP tools state after prune: {error}");
        }
    }

    // Tool dirs with no state entry (crashed installs) and shims for binaries
    // no longer managed. `packages/bin` holds only Berd-written shims, so pruning
    // by name is safe.
    if let Ok(entries) = std::fs::read_dir(tools_root(packages_root)) {
        for entry in entries.flatten() {
            if !managed_ids.contains(&entry.file_name().to_string_lossy().as_ref()) {
                let _ = std::fs::remove_dir_all(entry.path());
            }
        }
    }
    if let Ok(entries) = std::fs::read_dir(shim_bin_dir(packages_root)) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if !name.starts_with('.') && !managed_shim_names.iter().any(|kept| kept == &name) {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
}

pub(crate) fn record_reconcile(packages_root: &Path, errors: Vec<String>) {
    let mut state = read_state(packages_root);
    state.last_reconcile = Some(ReconcileRecord {
        at_ms: now_ms(),
        ok: errors.is_empty(),
        errors,
    });
    if let Err(error) = write_state(packages_root, &state) {
        log::warn!("failed to record ACP tools reconcile result: {error}");
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_shim(bin_dir: &Path, binary: &str, contents: &str) -> std::io::Result<()> {
        std::fs::create_dir_all(bin_dir)?;
        let path = bin_dir.join(binary);
        let temp = bin_dir.join(format!(".{binary}.tmp"));
        std::fs::write(&temp, contents)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&temp, std::fs::Permissions::from_mode(0o755))?;
        }
        std::fs::rename(&temp, &path)
    }

    fn is_executable(path: &Path) -> bool {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            path.metadata()
                .map(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
                .unwrap_or(false)
        }
        #[cfg(not(unix))]
        {
            path.is_file()
        }
    }

    #[test]
    fn managed_tools_lists_the_two_bridges() {
        let ids: Vec<&str> = MANAGED_TOOLS.iter().map(|tool| tool.id).collect();
        assert_eq!(ids, vec!["claude-acp", "codex-acp"]);
        for tool in MANAGED_TOOLS {
            assert!(
                tool.package.starts_with("@agentclientprotocol/"),
                "{}",
                tool.package
            );
            assert!(!tool.binary.is_empty(), "{}", tool.id);
        }
    }

    #[test]
    fn managed_npm_env_points_every_pair_into_the_prefix() {
        let prefix = Path::new("/data/packages/npm-prefix");
        let env = managed_npm_env_at(prefix);
        let prefix = prefix.to_string_lossy().into_owned();
        let cache = Path::new(&prefix)
            .join("cache")
            .to_string_lossy()
            .into_owned();
        let corepack = Path::new(&prefix)
            .join("corepack")
            .to_string_lossy()
            .into_owned();
        let expect = |key: &str, value: &str| {
            assert_eq!(
                env.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str()),
                Some(value),
                "{key}"
            );
        };
        expect("NPM_CONFIG_PREFIX", &prefix);
        expect("npm_config_prefix", &prefix);
        expect("NPM_CONFIG_CACHE", &cache);
        expect("npm_config_cache", &cache);
        expect("COREPACK_HOME", &corepack);
        assert_eq!(env.len(), 5);
    }

    #[test]
    fn apply_managed_npm_env_replaces_and_inserts() {
        let mut vars = vec![
            ("PATH".to_string(), "/usr/bin".to_string()),
            ("NPM_CONFIG_PREFIX".to_string(), "/stray/prefix".to_string()),
        ];

        let prefix = Path::new("/data/npm-prefix");
        apply_managed_npm_env(&mut vars, &managed_npm_env_at(prefix));
        let prefix = prefix.to_string_lossy().into_owned();
        let corepack = Path::new(&prefix)
            .join("corepack")
            .to_string_lossy()
            .into_owned();

        assert_eq!(vars.len(), if cfg!(windows) { 4 } else { 6 });
        assert_eq!(vars[0], ("PATH".to_string(), "/usr/bin".to_string()));
        assert_eq!(vars[1], ("NPM_CONFIG_PREFIX".to_string(), prefix));
        assert!(vars
            .iter()
            .any(|(k, v)| k == "COREPACK_HOME" && v == &corepack));
    }

    #[cfg(windows)]
    #[test]
    fn managed_npm_env_replaces_inherited_mixed_case_prefix() {
        let mut vars = vec![
            ("Path".to_string(), "C:\\Windows".to_string()),
            ("Npm_Config_Prefix".to_string(), "C:\\stray".to_string()),
        ];

        apply_managed_npm_env(
            &mut vars,
            &managed_npm_env_at(Path::new("C:\\Berd Data\\npm-prefix")),
        );

        assert_eq!(
            vars.iter()
                .filter(|(key, _)| key.eq_ignore_ascii_case("NPM_CONFIG_PREFIX"))
                .count(),
            1
        );
        assert_eq!(
            vars.iter()
                .find(|(key, _)| key.eq_ignore_ascii_case("NPM_CONFIG_PREFIX"))
                .map(|(_, value)| value.as_str()),
            Some("C:\\Berd Data\\npm-prefix")
        );
    }

    #[test]
    fn managed_bridge_shims_require_management_to_be_enabled() {
        assert!(managed_bridges_enabled_from_parts(false, false, true));
        assert!(!managed_bridges_enabled_from_parts(true, false, true));
        assert!(!managed_bridges_enabled_from_parts(false, true, true));
        assert!(!managed_bridges_enabled_from_parts(false, false, false));
    }

    #[test]
    fn managed_prepend_dirs_orders_shims_then_prefix_then_node() {
        assert_eq!(
            managed_prepend_dirs_from_parts(
                None,
                Some(PathBuf::from("/data/packages/bin")),
                Some(PathBuf::from("/data/packages/npm-prefix/bin")),
                Some(PathBuf::from("/data/packages/node/v1/plat/bin")),
            ),
            vec![
                PathBuf::from("/data/packages/bin"),
                PathBuf::from("/data/packages/npm-prefix/bin"),
                PathBuf::from("/data/packages/node/v1/plat/bin"),
            ]
        );
        // The dev override replaces the managed shim dir and resolves first;
        // the prefix bin still resolves already-installed shims (host node
        // may run them).
        assert_eq!(
            managed_prepend_dirs_from_parts(
                Some(PathBuf::from("/dev/packages/bin")),
                None,
                Some(PathBuf::from("/data/packages/npm-prefix/bin")),
                None
            ),
            vec![
                PathBuf::from("/dev/packages/bin"),
                PathBuf::from("/data/packages/npm-prefix/bin"),
            ]
        );
    }

    #[test]
    fn npm_backed_commands_are_detected() {
        for command in [
            "npm install -g @github/copilot",
            "npm install -g amp-acp@latest --registry=https://example.test/npm/",
            "sh -c 'npm install -g @agentclientprotocol/claude-agent-acp'",
        ] {
            assert!(is_npm_backed_command(command), "{command}");
        }
        for command in [
            "curl -fsSL https://cursor.com/install | bash",
            "brew install --cask codex",
            "claude /login",
        ] {
            assert!(!is_npm_backed_command(command), "{command}");
        }
    }

    // -- fixtures -----------------------------------------------------------

    fn test_tool() -> ManagedTool {
        ManagedTool {
            id: "claude-acp",
            binary: "claude-agent-acp",
            package: "@agentclientprotocol/claude-agent-acp",
        }
    }

    /// The host's runtime layout — these `#[cfg(unix)]` install-flow tests run
    /// on the host, so `RuntimeLayout::current()` is the Unix layout.
    fn test_layout() -> managed_node::RuntimeLayout {
        managed_node::RuntimeLayout::current().expect("tests run on a supported target")
    }

    fn write_json(path: &Path, value: &serde_json::Value) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, serde_json::to_string_pretty(value).unwrap()).unwrap();
    }

    /// A fixture install tree: the package's `package.json` (with the resolved
    /// version) and its `dist/index.js` entrypoint.
    fn write_fixture_install(install_dir: &Path, tool: &ManagedTool, version: &str) {
        write_json(
            &package_dir(install_dir, tool.package).join("package.json"),
            &serde_json::json!({ "name": tool.package, "version": version }),
        );
        let entrypoint = npm_entrypoint(install_dir, tool.package);
        std::fs::create_dir_all(entrypoint.parent().unwrap()).unwrap();
        std::fs::write(&entrypoint, "// bridge\n").unwrap();
    }

    // -- shims --------------------------------------------------------------

    #[test]
    fn shim_contents_execs_absolute_paths_and_quotes_spaces() {
        let unix = managed_node::RuntimeLayout::for_platform("linux-x64");
        let contents = shim_contents(
            &unix,
            Path::new("/data/Application Support/packages/node/v1/plat/bin/node"),
            Path::new("/data/Application Support/packages/tools/claude-acp/node_modules/@scope/claude-acp/dist/index.js"),
        );
        assert!(contents.starts_with("#!/bin/sh\n"));
        assert!(contents.ends_with(
            "exec '/data/Application Support/packages/node/v1/plat/bin/node' '/data/Application Support/packages/tools/claude-acp/node_modules/@scope/claude-acp/dist/index.js' \"$@\"\n"
        ));
    }

    #[test]
    fn windows_shim_contents_is_a_cmd_launcher_forwarding_args() {
        let win = managed_node::RuntimeLayout::for_platform("win-x64");
        let contents = shim_contents(
            &win,
            Path::new(r"C:\Users\Me\AppData\packages\node\v1\win-x64\node.exe"),
            Path::new(
                r"C:\Users\Me\AppData\packages\tools\claude-acp\node_modules\@scope\claude-acp\dist\index.js",
            ),
        );
        assert!(contents.starts_with("@echo off\r\n"), "{contents}");
        // Both paths double-quoted (tolerating spaces), `%*` forwards args,
        // CRLF line endings for cmd.exe.
        assert!(contents.ends_with(
            "\"C:\\Users\\Me\\AppData\\packages\\node\\v1\\win-x64\\node.exe\" \"C:\\Users\\Me\\AppData\\packages\\tools\\claude-acp\\node_modules\\@scope\\claude-acp\\dist\\index.js\" %*\r\n"
        ), "{contents}");
        // The shim file name carries the `.cmd` extension so bare-name launch
        // resolves it through PATHEXT.
        assert_eq!(
            shim_file_name(&win, "claude-agent-acp"),
            "claude-agent-acp.cmd"
        );
    }

    #[test]
    fn windows_layout_drives_npm_through_node() {
        let win = managed_node::RuntimeLayout::for_platform("win-x64");
        let install = Path::new(r"C:\rt\v1\win-x64");
        let npm = win.npm_command(install);
        assert_eq!(npm.program, win.node_exe(install));
        assert_eq!(
            npm.leading_args,
            vec![install
                .join("node_modules")
                .join("npm")
                .join("bin")
                .join("npm-cli.js")]
        );
        // npm's global bin dir is the prefix root, not `<prefix>/bin`.
        assert_eq!(
            win.npm_prefix_bin_dir(Path::new(r"C:\prefix")),
            PathBuf::from(r"C:\prefix")
        );
    }

    #[cfg(unix)]
    #[test]
    fn write_shim_is_executable() {
        let dir = tempfile::tempdir().unwrap();
        let bin_dir = dir.path().join("bin");
        write_shim(&bin_dir, "claude-agent-acp", "#!/bin/sh\nexec true\n").unwrap();
        let shim = bin_dir.join("claude-agent-acp");
        assert!(is_executable(&shim));
        assert_eq!(
            std::fs::read_to_string(&shim).unwrap(),
            "#!/bin/sh\nexec true\n"
        );
    }

    // -- state --------------------------------------------------------------

    #[test]
    fn state_round_trips_through_disk() {
        let dir = tempfile::tempdir().unwrap();
        let mut state = ManagedToolsState::default();
        state.tools.insert(
            "claude-acp".to_string(),
            InstalledToolPin {
                binary: "claude-agent-acp".to_string(),
                version: "1.2.3".to_string(),
            },
        );
        state.last_reconcile = Some(ReconcileRecord {
            at_ms: 42,
            ok: false,
            errors: vec!["codex-acp: boom".to_string()],
        });
        write_state(dir.path(), &state).unwrap();
        assert_eq!(read_state(dir.path()), state);

        // Missing and corrupt files read as the empty state.
        assert_eq!(
            read_state(&dir.path().join("absent")),
            ManagedToolsState::default()
        );
        std::fs::write(state_path(dir.path()), "not json").unwrap();
        assert_eq!(read_state(dir.path()), ManagedToolsState::default());
    }

    // -- install flow (fake npm) --------------------------------------------

    /// A fake managed-node install dir whose `npm` copies a pre-built fixture
    /// tree into the `--prefix` dir, standing in for a real floating install.
    #[cfg(unix)]
    fn write_fake_node_with_npm(node_install_dir: &Path, template: &Path, exit_code: i32) {
        let bin = node_install_dir.join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::write(bin.join("node"), "#!/bin/sh\necho v9.9.9\n").unwrap();
        let npm = format!(
            "#!/bin/sh\nprefix=\"\"\nprev=\"\"\nfor arg in \"$@\"; do\n  if [ \"$prev\" = \"--prefix\" ]; then prefix=\"$arg\"; fi\n  prev=\"$arg\"\ndone\ncp -R '{}/.' \"$prefix/\"\necho \"added 3 packages\"\nexit {exit_code}\n",
            template.display()
        );
        std::fs::write(bin.join("npm"), npm).unwrap();
        use std::os::unix::fs::PermissionsExt;
        for name in ["node", "npm"] {
            std::fs::set_permissions(bin.join(name), std::fs::Permissions::from_mode(0o755))
                .unwrap();
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn install_npm_tool_installs_shims_and_records_version() {
        let dir = tempfile::tempdir().unwrap();
        let packages_root = dir.path().join("packages");
        let node_install_dir = packages_root.join("node").join("v9.9.9").join("plat");
        let tool = test_tool();

        let template = dir.path().join("template");
        std::fs::create_dir_all(&template).unwrap();
        write_fixture_install(&template, &tool, "1.2.3");
        write_fake_node_with_npm(&node_install_dir, &template, 0);

        // A per-version dir left behind by the old lock-pinned layout.
        std::fs::create_dir_all(tool_install_dir(&packages_root, tool.id).join("1.0.0")).unwrap();

        let lines = std::sync::Mutex::new(Vec::new());
        let on_line = |line: &str| lines.lock().unwrap().push(line.to_string());
        install_npm_tool(
            &packages_root,
            &node_install_dir,
            &test_layout(),
            &tool,
            None,
            &on_line,
        )
        .await
        .unwrap();

        let shim = shim_bin_dir(&packages_root).join(tool.binary);
        let entrypoint = npm_entrypoint(&tool_install_dir(&packages_root, tool.id), tool.package);
        assert!(is_executable(&shim));
        assert_eq!(
            std::fs::read_to_string(&shim).unwrap(),
            shim_contents(
                &test_layout(),
                &node_binary(&test_layout(), &node_install_dir),
                &entrypoint
            )
        );
        assert_eq!(
            read_state(&packages_root).tools.get(tool.id),
            Some(&InstalledToolPin {
                binary: tool.binary.to_string(),
                version: "1.2.3".to_string(),
            })
        );
        // The stale per-version dir is pruned; the npm prefix files stay.
        assert!(!tool_install_dir(&packages_root, tool.id)
            .join("1.0.0")
            .exists());
        assert!(entrypoint.is_file());

        let recorded = lines.lock().unwrap().clone();
        assert!(recorded
            .iter()
            .any(|line| line.contains("added 3 packages")));
        assert!(recorded.iter().any(|line| line.contains("1.2.3 is ready")));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn failed_npm_install_preserves_the_previous_tree_shim_and_state() {
        let dir = tempfile::tempdir().unwrap();
        let packages_root = dir.path().join("packages");
        let node_install_dir = packages_root.join("node").join("v9.9.9").join("plat");
        let tool = test_tool();
        write_installed_tool(&packages_root, &node_install_dir, &tool);
        let old_entrypoint =
            npm_entrypoint(&tool_install_dir(&packages_root, tool.id), tool.package);
        std::fs::write(&old_entrypoint, "// old working bridge\n").unwrap();
        let old_shim = std::fs::read(shim_bin_dir(&packages_root).join(tool.binary)).unwrap();
        let old_state = std::fs::read(state_path(&packages_root)).unwrap();

        let template = dir.path().join("template");
        std::fs::create_dir_all(&template).unwrap();
        write_fixture_install(&template, &tool, "9.9.9");
        write_fake_node_with_npm(&node_install_dir, &template, 7);

        let error = install_npm_tool(
            &packages_root,
            &node_install_dir,
            &test_layout(),
            &tool,
            None,
            &|_| {},
        )
        .await
        .unwrap_err();

        assert!(matches!(error, ManagedToolError::NpmInstall(_)), "{error}");
        assert_eq!(
            std::fs::read_to_string(old_entrypoint).unwrap(),
            "// old working bridge\n"
        );
        assert_eq!(
            std::fs::read(shim_bin_dir(&packages_root).join(tool.binary)).unwrap(),
            old_shim
        );
        assert_eq!(
            std::fs::read(state_path(&packages_root)).unwrap(),
            old_state
        );
        let launch = std::process::Command::new(shim_bin_dir(&packages_root).join(tool.binary))
            .output()
            .unwrap();
        assert!(launch.status.success(), "preserved old shim still launches");
        assert_eq!(String::from_utf8_lossy(&launch.stdout).trim(), "v9.9.9");
        assert!(!tools_root(&packages_root)
            .read_dir()
            .unwrap()
            .flatten()
            .any(|entry| entry.file_name().to_string_lossy().contains("berd-stage")));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn install_without_entrypoint_fails_incomplete_before_shims() {
        let dir = tempfile::tempdir().unwrap();
        let packages_root = dir.path().join("packages");
        let node_install_dir = packages_root.join("node").join("v9.9.9").join("plat");
        let tool = test_tool();

        // A clean npm exit that produced no bridge entrypoint (empty template).
        let template = dir.path().join("template");
        std::fs::create_dir_all(&template).unwrap();
        write_fake_node_with_npm(&node_install_dir, &template, 0);

        let error = install_npm_tool(
            &packages_root,
            &node_install_dir,
            &test_layout(),
            &tool,
            None,
            &|_| {},
        )
        .await
        .unwrap_err();

        assert!(matches!(error, ManagedToolError::Incomplete(_)), "{error}");
        assert!(!shim_bin_dir(&packages_root).join(tool.binary).exists());
        assert!(read_state(&packages_root).tools.is_empty());
    }

    fn transaction_fixture(root: &Path) -> (InstallTransaction, [PathBuf; 3]) {
        let live_tree = root.join("tools").join("claude-acp");
        let live_shim = root.join("bin").join("claude-agent-acp.cmd");
        let live_state = root.join("state.json");
        std::fs::create_dir_all(&live_tree).unwrap();
        std::fs::create_dir_all(live_shim.parent().unwrap()).unwrap();
        std::fs::write(live_tree.join("entrypoint.js"), "old tree").unwrap();
        std::fs::write(&live_shim, "old shim").unwrap();
        std::fs::write(&live_state, "old state").unwrap();
        let tx = InstallTransaction::new(&live_tree, &live_shim, &live_state);
        tx.prepare().unwrap();
        std::fs::write(tx.staged_tree.join("entrypoint.js"), "new tree").unwrap();
        write_staged_shim(&tx.staged_shim, "new shim").unwrap();
        std::fs::write(&tx.staged_state, "new state").unwrap();
        (tx, [live_tree, live_shim, live_state])
    }

    fn assert_artifacts(paths: &[PathBuf; 3], expected: &str) {
        assert_eq!(
            std::fs::read_to_string(paths[0].join("entrypoint.js")).unwrap(),
            format!("{expected} tree")
        );
        assert_eq!(
            std::fs::read_to_string(&paths[1]).unwrap(),
            format!("{expected} shim")
        );
        assert_eq!(
            std::fs::read_to_string(&paths[2]).unwrap(),
            format!("{expected} state")
        );
    }

    #[test]
    fn prepare_propagates_unreadable_journal_and_preserves_recovery_files() {
        let dir = tempfile::tempdir().unwrap();
        let live_tree = dir.path().join("tools").join("claude-acp");
        let live_shim = dir.path().join("bin").join("claude-agent-acp.cmd");
        let live_state = dir.path().join("state.json");
        let tx = InstallTransaction::new(&live_tree, &live_shim, &live_state);
        std::fs::create_dir_all(&tx.journal).unwrap();
        let temp = transaction_journal_temp_path(&tx.journal);
        std::fs::write(&temp, "pending journal write").unwrap();

        let error = tx.prepare().unwrap_err();

        assert!(error
            .to_string()
            .contains("cannot recover managed ACP transaction journal"));
        assert!(tx.journal.is_dir());
        assert!(
            temp.is_file(),
            "prepare must not mutate recovery files after a read failure"
        );
        assert!(!tx.staged_tree.exists());
    }

    #[test]
    fn prepare_removes_stale_journal_temp_after_successful_recovery() {
        let dir = tempfile::tempdir().unwrap();
        let live_tree = dir.path().join("tools").join("claude-acp");
        let live_shim = dir.path().join("bin").join("claude-agent-acp.cmd");
        let live_state = dir.path().join("state.json");
        let tx = InstallTransaction::new(&live_tree, &live_shim, &live_state);
        std::fs::create_dir_all(dir.path()).unwrap();
        let temp = transaction_journal_temp_path(&tx.journal);
        std::fs::write(&temp, "interrupted journal write").unwrap();

        tx.prepare().unwrap();

        assert!(!temp.exists());
        assert!(tx.staged_tree.is_dir());
    }

    #[test]
    fn malformed_journal_error_includes_operator_remediation() {
        let dir = tempfile::tempdir().unwrap();
        let journal = dir.path().join(".managed-acp-transaction.json");
        std::fs::write(&journal, "not json").unwrap();

        let error = recover_transaction(&journal).unwrap_err().to_string();

        assert!(error.contains("invalid JSON"), "{error}");
        assert!(
            error.contains("Preserve this file and any .berd-backup artifacts"),
            "{error}"
        );
        assert!(error.contains("repair/remove the journal"), "{error}");
        assert!(journal.is_file());
    }

    #[test]
    fn transaction_replaces_existing_tree_shim_and_state() {
        let dir = tempfile::tempdir().unwrap();
        let (tx, paths) = transaction_fixture(dir.path());
        tx.commit().unwrap();
        assert_artifacts(&paths, "new");
    }

    #[test]
    fn pending_journal_rolls_back_partial_promotion_as_one_group() {
        let dir = tempfile::tempdir().unwrap();
        let (mut tx, paths) = transaction_fixture(dir.path());
        for artifact in &mut tx.artifacts {
            artifact.existed = true;
        }
        write_transaction_journal(&tx.journal, false, &tx.artifacts).unwrap();
        for artifact in &tx.artifacts {
            std::fs::rename(&artifact.live, &artifact.backup).unwrap();
        }
        std::fs::rename(&tx.staged_tree, &paths[0]).unwrap();

        recover_transaction(&tx.journal).unwrap();

        assert_artifacts(&paths, "old");
        assert!(!tx.journal.exists());
    }

    #[test]
    fn another_tool_recovers_the_global_journal_before_staging() {
        let dir = tempfile::tempdir().unwrap();
        let (mut interrupted, paths) = transaction_fixture(dir.path());
        for artifact in &mut interrupted.artifacts {
            artifact.existed = true;
        }
        write_transaction_journal(&interrupted.journal, false, &interrupted.artifacts).unwrap();
        for artifact in &interrupted.artifacts {
            std::fs::rename(&artifact.live, &artifact.backup).unwrap();
        }
        std::fs::rename(&interrupted.staged_tree, &paths[0]).unwrap();

        let other = InstallTransaction::new(
            &dir.path().join("tools").join("codex-acp"),
            &dir.path().join("bin").join("codex-acp.cmd"),
            &paths[2],
        );
        other.prepare().unwrap();

        assert_artifacts(&paths, "old");
        assert!(!interrupted.journal.exists());
    }

    #[test]
    fn committed_journal_finalizes_new_group() {
        let dir = tempfile::tempdir().unwrap();
        let (mut tx, paths) = transaction_fixture(dir.path());
        for artifact in &mut tx.artifacts {
            artifact.existed = true;
        }
        for artifact in &tx.artifacts {
            std::fs::rename(&artifact.live, &artifact.backup).unwrap();
            std::fs::rename(&artifact.staged, &artifact.live).unwrap();
        }
        write_transaction_journal(&tx.journal, true, &tx.artifacts).unwrap();

        recover_transaction(&tx.journal).unwrap();

        assert_artifacts(&paths, "new");
        assert!(!tx.journal.exists());
        assert!(tx
            .artifacts
            .iter()
            .all(|artifact| !artifact.backup.exists()));
    }

    #[test]
    fn pending_journal_preserves_artifacts_not_yet_backed_up() {
        let dir = tempfile::tempdir().unwrap();
        let (mut tx, paths) = transaction_fixture(dir.path());
        for artifact in &mut tx.artifacts {
            artifact.existed = true;
        }
        write_transaction_journal(&tx.journal, false, &tx.artifacts).unwrap();
        std::fs::rename(&tx.artifacts[0].live, &tx.artifacts[0].backup).unwrap();

        recover_transaction(&tx.journal).unwrap();

        assert_artifacts(&paths, "old");
    }

    #[test]
    fn pending_journal_removes_promotions_for_absent_prior_artifacts() {
        let dir = tempfile::tempdir().unwrap();
        let live_tree = dir.path().join("tools").join("claude-acp");
        let live_shim = dir.path().join("bin").join("claude-agent-acp.cmd");
        let live_state = dir.path().join("state.json");
        let tx = InstallTransaction::new(&live_tree, &live_shim, &live_state);
        tx.prepare().unwrap();
        std::fs::write(tx.staged_tree.join("entrypoint.js"), "new tree").unwrap();
        write_staged_shim(&tx.staged_shim, "new shim").unwrap();
        std::fs::write(&tx.staged_state, "new state").unwrap();
        write_transaction_journal(&tx.journal, false, &tx.artifacts).unwrap();
        for artifact in &tx.artifacts {
            std::fs::rename(&artifact.staged, &artifact.live).unwrap();
        }

        recover_transaction(&tx.journal).unwrap();

        assert!(!live_tree.exists());
        assert!(!live_shim.exists());
        assert!(!live_state.exists());
    }

    #[test]
    fn commit_and_rollback_failure_remains_recoverable() {
        let dir = tempfile::tempdir().unwrap();
        let (tx, paths) = transaction_fixture(dir.path());
        RENAME_COUNT.with(|count| count.set(0));
        // Fail the first promotion (call 3), then the first rollback restore
        // (call 4). The pending global journal and backups must survive.
        RENAME_FAILURES.with(|calls| *calls.borrow_mut() = vec![3, 4]);
        let error = tx.commit().unwrap_err();
        assert!(error.to_string().contains("rollback also failed"));

        RENAME_COUNT.with(|count| count.set(0));
        RENAME_FAILURES.with(|calls| calls.borrow_mut().clear());
        let recovery = InstallTransaction::new(&paths[0], &paths[1], &paths[2]);
        recovery.prepare().unwrap();
        assert_artifacts(&paths, "old");
    }

    #[cfg(windows)]
    #[test]
    fn locked_live_tree_causes_real_windows_rollback() {
        use std::os::windows::fs::OpenOptionsExt;

        let dir = tempfile::tempdir().unwrap();
        let (tx, paths) = transaction_fixture(dir.path());
        let locked_entrypoint = paths[0].join("entrypoint.js");
        // Permit other readers/writers but deliberately omit FILE_SHARE_DELETE.
        // Windows must then reject renaming the containing live tree.
        let lock = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(0x0000_0001 | 0x0000_0002)
            .open(&locked_entrypoint)
            .unwrap();

        let error = tx.commit().unwrap_err();

        assert!(
            matches!(
                error.kind(),
                std::io::ErrorKind::PermissionDenied | std::io::ErrorKind::Other
            ),
            "unexpected locked-tree error: {error}"
        );
        assert_artifacts(&paths, "old");
        drop(lock);
    }

    #[test]
    fn every_transaction_move_failure_rolls_back_all_artifacts() {
        for failure in 0..6 {
            let dir = tempfile::tempdir().unwrap();
            let (tx, paths) = transaction_fixture(dir.path());
            RENAME_COUNT.with(|count| count.set(0));
            RENAME_FAILURES.with(|calls| *calls.borrow_mut() = vec![failure]);
            let error = tx.commit().unwrap_err();
            assert!(error
                .to_string()
                .contains("injected transaction rename failure"));
            assert_artifacts(&paths, "old");
        }
    }

    // -- reconcile prune ----------------------------------------------------

    /// Lay down a complete healthy install (tree + shim + state) for `tool`.
    fn write_installed_tool(packages_root: &Path, node_install_dir: &Path, tool: &ManagedTool) {
        let install_dir = tool_install_dir(packages_root, tool.id);
        write_fixture_install(&install_dir, tool, "1.2.3");
        let entrypoint = npm_entrypoint(&install_dir, tool.package);
        write_shim(
            &shim_bin_dir(packages_root),
            &shim_file_name(&test_layout(), tool.binary),
            &shim_contents(
                &test_layout(),
                &node_binary(&test_layout(), node_install_dir),
                &entrypoint,
            ),
        )
        .unwrap();
        let mut state = read_state(packages_root);
        state.tools.insert(
            tool.id.to_string(),
            InstalledToolPin {
                binary: tool.binary.to_string(),
                version: "1.2.3".to_string(),
            },
        );
        write_state(packages_root, &state).unwrap();
    }

    #[test]
    fn prune_removes_installs_dropped_from_the_managed_set() {
        let dir = tempfile::tempdir().unwrap();
        let packages_root = dir.path();
        let node_install_dir = packages_root.join("node").join("v9.9.9").join("plat");
        let kept = test_tool();
        let dropped = ManagedTool {
            id: "codex-acp",
            binary: "codex-acp",
            package: "@agentclientprotocol/codex-acp",
        };
        write_installed_tool(packages_root, &node_install_dir, &kept);
        write_installed_tool(packages_root, &node_install_dir, &dropped);
        // A crashed install with no state entry.
        std::fs::create_dir_all(tools_root(packages_root).join("ghost-acp")).unwrap();

        prune_stale_managed_tools(packages_root, std::slice::from_ref(&kept));

        let state = read_state(packages_root);
        assert!(state.tools.contains_key(kept.id));
        assert!(!state.tools.contains_key(dropped.id));
        assert!(shim_bin_dir(packages_root)
            .join(shim_file_name(&test_layout(), kept.binary))
            .exists());
        assert!(!shim_bin_dir(packages_root)
            .join(shim_file_name(&test_layout(), dropped.binary))
            .exists());
        assert!(tools_root(packages_root).join(kept.id).exists());
        assert!(!tools_root(packages_root).join(dropped.id).exists());
        assert!(!tools_root(packages_root).join("ghost-acp").exists());
    }

    #[test]
    fn record_reconcile_stamps_the_state() {
        let dir = tempfile::tempdir().unwrap();
        record_reconcile(dir.path(), vec!["codex-acp: boom".to_string()]);
        let record = read_state(dir.path()).last_reconcile.unwrap();
        assert!(!record.ok);
        assert_eq!(record.errors, vec!["codex-acp: boom".to_string()]);
        assert!(record.at_ms > 0);

        record_reconcile(dir.path(), Vec::new());
        let record = read_state(dir.path()).last_reconcile.unwrap();
        assert!(record.ok);
        assert!(record.errors.is_empty());
    }

    /// A packages root with the pinned Node runtime dir plus a superseded
    /// version left over from before a Node pin bump. Returns
    /// `(packages_root, node_root, pinned_dir, superseded_dir)`.
    fn write_node_bump_leftovers(dir: &Path) -> (PathBuf, PathBuf, PathBuf, PathBuf) {
        let packages_root = dir.join("packages");
        let node_root = packages_root.join("node");
        let pinned_dir = managed_node::pinned_install_dir(&node_root).unwrap();
        let superseded_dir = node_root.join("v0.0.1").join("plat");
        std::fs::create_dir_all(&pinned_dir).unwrap();
        std::fs::create_dir_all(&superseded_dir).unwrap();
        (packages_root, node_root, pinned_dir, superseded_dir)
    }

    #[tokio::test]
    async fn clean_reconcile_prunes_the_superseded_node_runtime() {
        let dir = tempfile::tempdir().unwrap();
        let (packages_root, node_root, pinned_dir, superseded_dir) =
            write_node_bump_leftovers(dir.path());
        let tool = test_tool();
        write_installed_tool(&packages_root, &pinned_dir, &tool);

        finish_reconcile_at(
            &packages_root,
            &node_root,
            std::slice::from_ref(&tool),
            Vec::new(),
        )
        .await;

        assert!(pinned_dir.exists());
        assert!(!superseded_dir.exists());
        assert!(read_state(&packages_root).last_reconcile.unwrap().ok);
    }

    #[tokio::test]
    async fn partial_failure_keeps_the_superseded_node_runtime() {
        let dir = tempfile::tempdir().unwrap();
        let (packages_root, node_root, pinned_dir, superseded_dir) =
            write_node_bump_leftovers(dir.path());
        let tool = test_tool();
        // The failed bridge's shim was never rewritten: it still execs the
        // superseded runtime, which must therefore survive the epilogue.
        write_installed_tool(&packages_root, &superseded_dir, &tool);

        finish_reconcile_at(
            &packages_root,
            &node_root,
            std::slice::from_ref(&tool),
            vec![format!("{}: npm install failed", tool.id)],
        )
        .await;

        assert!(pinned_dir.exists());
        assert!(superseded_dir.exists());
        let shim = std::fs::read_to_string(
            shim_bin_dir(&packages_root).join(shim_file_name(&test_layout(), tool.binary)),
        )
        .unwrap();
        assert!(shim.contains(&superseded_dir.to_string_lossy().into_owned()));
        assert!(!read_state(&packages_root).last_reconcile.unwrap().ok);
    }

    // ── Native Windows gate (real runtime + real bridge launch) ─────────
    //
    // Installs the real pinned Node runtime plus a real managed bridge, then
    // launches the bridge by its bare name through the exact PATH /
    // GOOSE_SEARCH_PATHS shim directory goosed prepends. This compiles on every
    // host (so the mac/Linux CI lanes type-check it) but only executes on
    // native Windows when opted in via `BERD_WS2_NATIVE_GATE=1` (set by the
    // Buildkite `windows-native` lane). `node.exe` and the `.cmd` launcher are
    // not runnable on the Unix host, so off Windows it skips immediately.
    // Covers the audit's native matrix item 5: bridge install, Windows launcher
    // generation, and bare-name launch through goosed's search path.

    fn native_gate_enabled() -> bool {
        cfg!(windows) && std::env::var_os("BERD_WS2_NATIVE_GATE").is_some_and(|value| value == "1")
    }

    #[tokio::test]
    async fn native_gate_installs_and_launches_a_bridge_by_bare_name() {
        if !native_gate_enabled() {
            eprintln!(
                "skipping: native Windows gate runs only on Windows with BERD_WS2_NATIVE_GATE=1"
            );
            return;
        }
        // A packages root under a directory whose name contains a space.
        let base = tempfile::tempdir().unwrap();
        let packages_root = base.path().join("App Data").join("packages node");
        let node_root = packages_root.join("node");
        std::fs::create_dir_all(&packages_root).unwrap();

        // Install the real pinned Node runtime the bridge shim will exec.
        managed_node::ensure_managed_node_runtime_at(
            &node_root,
            "https://nodejs.org/dist",
            managed_node::node_runtime_lock(),
            90 * 1024 * 1024,
            &|_| {},
        )
        .await
        .expect("real pinned Node runtime installs on native Windows");
        let node_install_dir =
            managed_node::pinned_install_dir(&node_root).expect("windows target is pinned");
        let layout = runtime_layout().expect("windows layout resolves");

        // Install a real managed bridge into the private prefix.
        let tool = test_tool();
        install_npm_tool(
            &packages_root,
            &node_install_dir,
            &layout,
            &tool,
            None,
            &|_| {},
        )
        .await
        .expect("managed bridge installs on native Windows");
        // Repeat with the existing directory, .cmd launcher, and state.json in
        // place. This is the Windows replacement shape that directory rename
        // cannot handle without the transaction's backup step.
        install_npm_tool(
            &packages_root,
            &node_install_dir,
            &layout,
            &tool,
            None,
            &|_| {},
        )
        .await
        .expect("managed bridge upgrades repeatedly on native Windows");

        // The launcher is the `.cmd` name goosed resolves by bare name.
        let shim_dir = shim_bin_dir(&packages_root);
        let launcher = shim_dir.join(shim_file_name(&layout, tool.binary));
        assert!(launcher.is_file(), "bridge .cmd launcher was written");

        // Launch the bridge by its bare name through the exact search-path
        // directory goosed prepends (shim dir + managed node bin dir), with
        // `--help` so a real ACP bridge exits promptly. Goose spawns bridges in
        // two stages — resolve the bare name against the search path, then spawn
        // the resolved path — so the gate mirrors that here. `which_in_global`
        // is the same resolver goosed uses (crates/goose config/search_path.rs),
        // and on Windows it applies `PATHEXT`, so it must return the generated
        // `.cmd` launcher rather than the extensionless name. Spawning that
        // resolved path is what proves the launcher is Windows-launchable;
        // spawning the bare name directly would fail because Rust's `Command`
        // does not apply `PATHEXT`.
        let mut search_path = vec![shim_dir.clone(), layout.bin_dir(&node_install_dir)];
        search_path.extend(std::env::split_paths(
            &std::env::var_os("PATH").unwrap_or_default(),
        ));
        let path_value = std::env::join_paths(search_path).unwrap();
        let resolved = which::which_in_global(tool.binary, Some(&path_value))
            .expect("which_in_global runs")
            .next()
            .expect("goosed's resolver finds the bridge launcher by bare name");
        // `which` canonicalizes its result, so compare canonicalized paths
        // rather than the raw tempdir join.
        assert_eq!(
            dunce::canonicalize(&resolved).expect("resolved launcher canonicalizes"),
            dunce::canonicalize(&launcher).expect("generated launcher canonicalizes"),
            "bare-name resolution returns the generated .cmd launcher"
        );
        let output = tokio::process::Command::new(&resolved)
            .arg("--help")
            .env("PATH", &path_value)
            .output()
            .await
            .expect("bridge launches through the resolved goosed search path");
        assert!(
            output.status.code().is_some(),
            "bridge process ran to completion"
        );
    }
}
