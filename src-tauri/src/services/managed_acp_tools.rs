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

use crate::services::managed_node;

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

/// Where npm writes global bin shims for the private prefix.
pub fn npm_prefix_bin_dir<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Option<PathBuf> {
    npm_prefix_dir(app).map(|dir| dir.join("bin"))
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
        match vars.iter_mut().find(|(existing, _)| existing == key) {
            Some(entry) => entry.1 = value.clone(),
            None => vars.push((key.clone(), value.clone())),
        }
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

fn node_binary(node_install_dir: &Path) -> PathBuf {
    node_install_dir.join("bin").join("node")
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

    let _guard = tool_install_lock().lock().await;
    let progress = managed_node::progress_line_reporter(|line| on_line(&line));
    managed_node::ensure_managed_node_runtime(app, &progress)
        .await
        .map_err(ManagedToolError::Node)?;
    install_npm_tool(
        &packages_root,
        &node_install_dir,
        &tool,
        crate::commands::agent_setup::npm_registry(),
        on_line,
    )
    .await
}

/// The install body, path-parameterized so tests drive it with a fixture
/// `npm`. Caller holds the install mutex and has ensured the runtime.
async fn install_npm_tool(
    packages_root: &Path,
    node_install_dir: &Path,
    tool: &ManagedTool,
    registry: Option<&str>,
    on_line: &InstallLineFn<'_>,
) -> Result<(), ManagedToolError> {
    let install_dir = tool_install_dir(packages_root, tool.id);
    // Install in place: a failed floating upgrade leaves the previous tree,
    // shim, and state untouched, so the old bridge keeps working.
    std::fs::create_dir_all(&install_dir)
        .map_err(|error| ManagedToolError::Io(format!("create tool install dir: {error}")))?;

    on_line(&format!(
        "Installing {}@latest into Berd's app data",
        tool.package
    ));
    run_floating_npm_install(
        packages_root,
        node_install_dir,
        &install_dir,
        tool,
        registry,
        on_line,
    )
    .await?;

    let entrypoint = npm_entrypoint(&install_dir, tool.package);
    if !entrypoint.is_file() {
        return Err(ManagedToolError::Incomplete(format!(
            "{}: bridge entrypoint {} is missing after install",
            tool.package,
            entrypoint.display()
        )));
    }
    let version = installed_version(&install_dir, tool.package).unwrap_or_default();

    write_shim(
        &shim_bin_dir(packages_root),
        tool.binary,
        &shim_contents(&node_binary(node_install_dir), &entrypoint),
    )
    .map_err(|error| ManagedToolError::Io(format!("write bridge shim: {error}")))?;

    let mut state = read_state(packages_root);
    state.tools.insert(
        tool.id.to_string(),
        InstalledToolPin {
            binary: tool.binary.to_string(),
            version: version.clone(),
        },
    );
    write_state(packages_root, &state)
        .map_err(|error| ManagedToolError::Io(format!("write state.json: {error}")))?;
    prune_superseded_tool_versions(packages_root, tool.id);
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
    install_dir: &Path,
    tool: &ManagedTool,
    registry: Option<&str>,
    on_line: &InstallLineFn<'_>,
) -> Result<(), ManagedToolError> {
    let node_bin_dir = node_install_dir.join("bin");
    let mut command = tokio::process::Command::new(node_bin_dir.join("npm"));
    command
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

    // npm's own `#!/usr/bin/env node` shebang must resolve the managed node.
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
/// no `node` on PATH and cannot hit the old wrapper's exit-127 mode.
fn shim_contents(node: &Path, entrypoint: &Path) -> String {
    format!(
        "#!/bin/sh\n# Written by Berd's managed ACP tools installer; do not edit.\nexec {} {} \"$@\"\n",
        sh_quote(node),
        sh_quote(entrypoint)
    )
}

fn sh_quote(path: &Path) -> String {
    format!("'{}'", path.to_string_lossy().replace('\'', r"'\''"))
}

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

/// After a successful in-place install, drop everything under `tools/<id>`
/// that is not part of the current npm prefix — chiefly the per-version
/// subdirectories left by the old lock-pinned layout (`tools/<id>/<version>`).
/// Best-effort: a locked file must never fail the install.
fn prune_superseded_tool_versions(packages_root: &Path, id: &str) {
    const KEEP: [&str; 3] = ["node_modules", "package.json", "package-lock.json"];
    let install_dir = tool_install_dir(packages_root, id);
    let Ok(entries) = std::fs::read_dir(&install_dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        if KEEP.iter().any(|keep| name == std::ffi::OsStr::new(keep)) {
            continue;
        }
        let path = entry.path();
        let result = if path.is_dir() {
            std::fs::remove_dir_all(&path)
        } else {
            std::fs::remove_file(&path)
        };
        if let Err(error) = result {
            log::warn!(
                "failed to prune superseded ACP tool entry {}: {error}",
                path.display()
            );
        }
    }
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
    let managed_binaries: Vec<&str> = managed.iter().map(|tool| tool.binary).collect();

    let mut state = read_state(packages_root);
    let stale: Vec<String> = state
        .tools
        .keys()
        .filter(|id| !managed_ids.contains(&id.as_str()))
        .cloned()
        .collect();
    for id in &stale {
        if let Some(pin) = state.tools.remove(id) {
            let _ = std::fs::remove_file(shim_bin_dir(packages_root).join(&pin.binary));
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
            if !name.starts_with('.') && !managed_binaries.contains(&name.as_str()) {
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
        let env = managed_npm_env_at(Path::new("/data/packages/npm-prefix"));
        let expect = |key: &str, value: &str| {
            assert_eq!(
                env.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str()),
                Some(value),
                "{key}"
            );
        };
        expect("NPM_CONFIG_PREFIX", "/data/packages/npm-prefix");
        expect("npm_config_prefix", "/data/packages/npm-prefix");
        expect("NPM_CONFIG_CACHE", "/data/packages/npm-prefix/cache");
        expect("npm_config_cache", "/data/packages/npm-prefix/cache");
        expect("COREPACK_HOME", "/data/packages/npm-prefix/corepack");
        assert_eq!(env.len(), 5);
    }

    #[test]
    fn apply_managed_npm_env_replaces_and_inserts() {
        let mut vars = vec![
            ("PATH".to_string(), "/usr/bin".to_string()),
            ("NPM_CONFIG_PREFIX".to_string(), "/stray/prefix".to_string()),
        ];

        apply_managed_npm_env(
            &mut vars,
            &managed_npm_env_at(Path::new("/data/npm-prefix")),
        );

        assert_eq!(vars.len(), 6);
        assert_eq!(vars[0], ("PATH".to_string(), "/usr/bin".to_string()));
        assert_eq!(
            vars[1],
            (
                "NPM_CONFIG_PREFIX".to_string(),
                "/data/npm-prefix".to_string()
            )
        );
        assert!(vars
            .iter()
            .any(|(k, v)| k == "COREPACK_HOME" && v == "/data/npm-prefix/corepack"));
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
        let contents = shim_contents(
            Path::new("/data/Application Support/packages/node/v1/plat/bin/node"),
            Path::new("/data/Application Support/packages/tools/claude-acp/node_modules/@scope/claude-acp/dist/index.js"),
        );
        assert!(contents.starts_with("#!/bin/sh\n"));
        assert!(contents.ends_with(
            "exec '/data/Application Support/packages/node/v1/plat/bin/node' '/data/Application Support/packages/tools/claude-acp/node_modules/@scope/claude-acp/dist/index.js' \"$@\"\n"
        ));
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
        install_npm_tool(&packages_root, &node_install_dir, &tool, None, &on_line)
            .await
            .unwrap();

        let shim = shim_bin_dir(&packages_root).join(tool.binary);
        let entrypoint = npm_entrypoint(&tool_install_dir(&packages_root, tool.id), tool.package);
        assert!(is_executable(&shim));
        assert_eq!(
            std::fs::read_to_string(&shim).unwrap(),
            shim_contents(&node_binary(&node_install_dir), &entrypoint)
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
    async fn failed_npm_install_writes_no_shim_and_no_state() {
        let dir = tempfile::tempdir().unwrap();
        let packages_root = dir.path().join("packages");
        let node_install_dir = packages_root.join("node").join("v9.9.9").join("plat");
        let tool = test_tool();

        let template = dir.path().join("template");
        std::fs::create_dir_all(&template).unwrap();
        write_fixture_install(&template, &tool, "1.2.3");
        write_fake_node_with_npm(&node_install_dir, &template, 7);

        let error = install_npm_tool(&packages_root, &node_install_dir, &tool, None, &|_| {})
            .await
            .unwrap_err();

        assert!(matches!(error, ManagedToolError::NpmInstall(_)), "{error}");
        assert!(!shim_bin_dir(&packages_root).join(tool.binary).exists());
        assert!(read_state(&packages_root).tools.is_empty());
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

        let error = install_npm_tool(&packages_root, &node_install_dir, &tool, None, &|_| {})
            .await
            .unwrap_err();

        assert!(matches!(error, ManagedToolError::Incomplete(_)), "{error}");
        assert!(!shim_bin_dir(&packages_root).join(tool.binary).exists());
        assert!(read_state(&packages_root).tools.is_empty());
    }

    // -- reconcile prune ----------------------------------------------------

    /// Lay down a complete healthy install (tree + shim + state) for `tool`.
    fn write_installed_tool(packages_root: &Path, node_install_dir: &Path, tool: &ManagedTool) {
        let install_dir = tool_install_dir(packages_root, tool.id);
        write_fixture_install(&install_dir, tool, "1.2.3");
        let entrypoint = npm_entrypoint(&install_dir, tool.package);
        write_shim(
            &shim_bin_dir(packages_root),
            tool.binary,
            &shim_contents(&node_binary(node_install_dir), &entrypoint),
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
        assert!(shim_bin_dir(packages_root).join(kept.binary).exists());
        assert!(!shim_bin_dir(packages_root).join(dropped.binary).exists());
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
        let shim = std::fs::read_to_string(shim_bin_dir(&packages_root).join(tool.binary)).unwrap();
        assert!(shim.contains(&superseded_dir.to_string_lossy().into_owned()));
        assert!(!read_state(&packages_root).last_reconcile.unwrap().ok);
    }
}
