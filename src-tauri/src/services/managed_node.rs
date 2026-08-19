//! Berd-managed Node.js runtime.
//!
//! Downloads the Node.js version pinned in `node-runtime.lock.json` (repo
//! root, embedded at compile time; refresh with `just bump-node-runtime`),
//! verifies it against the lock's SHA-256, and atomically installs it under
//! `<app-data>/packages/node/<version>/<platform>/`. The tarball comes from
//! `https://nodejs.org/dist` by default; its lockfile SHA-256 is the trust root.
//! A distribution may override that base URL for its own builds.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;

use crate::services::distro_bundle::DistroBundleState;
use futures_util::StreamExt;
use sha2::{Digest, Sha256};
use tauri::Manager;
use tokio::io::AsyncWriteExt;

const NODE_RUNTIME_LOCK_JSON: &str = include_str!("../../../node-runtime.lock.json");

const UPSTREAM_NODE_DIST_BASE_URL: &str = "https://nodejs.org/dist";

/// Hard cap on the compressed tarball; the largest pinned artifact today is
/// ~49 MB, so anything near this is a wrong or corrupted download.
const MAX_ARCHIVE_BYTES: u64 = 90 * 1024 * 1024;
/// Hard cap on the total uncompressed bytes an archive may expand to, a
/// zip/tar-bomb guard independent of the compressed download cap. The largest
/// pinned Node release unpacks to well under 300 MB.
const MAX_EXTRACTED_BYTES: u64 = 600 * 1024 * 1024;
/// Hard cap on the number of entries an archive may contain, guarding against
/// entry-count exhaustion. A Node release holds a few thousand files.
const MAX_EXTRACTED_ENTRIES: u64 = 100_000;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(10 * 60);

#[derive(Clone, Debug, serde::Deserialize)]
pub struct NodeRuntimeLock {
    /// Pinned Node.js version, `v`-prefixed (`v24.11.0`) — the exact string
    /// `node --version` prints.
    pub version: String,
    /// Rust target triple → release tarball pin.
    pub artifacts: BTreeMap<String, NodeRuntimeArtifact>,
}

#[derive(Clone, Debug, serde::Deserialize)]
pub struct NodeRuntimeArtifact {
    pub filename: String,
    pub sha256: String,
}

impl NodeRuntimeArtifact {
    /// Node's platform string (`darwin-arm64`, `win-x64`, …), derived from the
    /// tarball/zip name so the lock stays the single source of truth.
    fn platform<'a>(&'a self, version: &str) -> Option<&'a str> {
        let stem = self
            .filename
            .strip_prefix(format!("node-{version}-").as_str())?;
        stem.strip_suffix(".tar.gz")
            .or_else(|| stem.strip_suffix(".zip"))
    }
}

/// The two release archive shapes Node ships: `.tar.gz` for macOS/Linux,
/// `.zip` for Windows. Derived from the pinned filename so the lock remains
/// the single source of truth for format as well as platform.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ArchiveFormat {
    TarGz,
    Zip,
}

fn archive_format(filename: &str) -> ArchiveFormat {
    if filename.ends_with(".zip") {
        ArchiveFormat::Zip
    } else {
        ArchiveFormat::TarGz
    }
}

/// Whether a platform lays runtime executables out Windows-style — flat in the
/// runtime root with `.exe`/`.cmd` suffixes — rather than Unix-style under
/// `bin/` with no extension.
fn is_windows_platform(platform: &str) -> bool {
    platform.starts_with("win-")
}

/// Directory holding a runtime's `node`/`npm` executables: the runtime root on
/// Windows, `<runtime>/bin` everywhere else.
fn node_bin_dir(runtime_dir: &Path, platform: &str) -> PathBuf {
    if is_windows_platform(platform) {
        runtime_dir.to_path_buf()
    } else {
        runtime_dir.join("bin")
    }
}

fn node_exe_name(platform: &str) -> &'static str {
    if is_windows_platform(platform) {
        "node.exe"
    } else {
        "node"
    }
}

/// The npm entrypoint that verifies a runtime tree is complete. On Windows
/// that is the `npm.cmd` batch shim (the extensionless `npm` shipped alongside
/// it is a POSIX shell script); elsewhere it is the extensionless `npm`.
fn npm_exe_name(platform: &str) -> &'static str {
    if is_windows_platform(platform) {
        "npm.cmd"
    } else {
        "npm"
    }
}

/// The npm CLI entrypoint the managed npm command drives directly, when the
/// platform has one that must exist independently of the executables in the
/// runtime's bin dir. On Windows npm is spawned as `node.exe <npm-cli.js>`, so
/// `<runtime>/node_modules/npm/bin/npm-cli.js` is load-bearing and can go
/// missing (AV quarantine, disk cleanup) while `node.exe` stays healthy. On
/// Unix the `bin/npm` shim is spawned directly and is already covered by
/// [`npm_exe_name`], so there is no separate entrypoint to check.
fn npm_cli_entrypoint(runtime_dir: &Path, platform: &str) -> Option<PathBuf> {
    is_windows_platform(platform).then(|| {
        runtime_dir
            .join("node_modules")
            .join("npm")
            .join("bin")
            .join("npm-cli.js")
    })
}

/// How to spawn npm for an installed runtime: the program to execute plus any
/// leading arguments that must precede npm's own arguments. On Windows npm is
/// driven through `node.exe <npm-cli.js>` so no `cmd.exe` batch semantics or
/// `PATHEXT` resolution are involved; on Unix the `bin/npm` shim is spawned
/// directly, exactly as before.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NpmCommand {
    pub program: PathBuf,
    pub leading_args: Vec<PathBuf>,
}

/// Platform-aware layout of an installed managed Node runtime: where its
/// `node`/`npm` executables live, how npm must be invoked, and where npm
/// writes global-prefix executables. Resolved once from the embedded lock's
/// pinned artifact for the current target so every consumer (installer,
/// bridge provisioner, doctor) agrees on one contract.
#[derive(Clone, Copy, Debug)]
pub struct RuntimeLayout {
    platform: &'static str,
}

impl RuntimeLayout {
    /// The layout for the current target's pinned artifact, or `None` when the
    /// embedded lock has no artifact for this target.
    pub fn current() -> Option<Self> {
        Some(Self {
            platform: pinned_platform()?,
        })
    }

    /// A layout for an explicit Node platform string, so tests can exercise
    /// both the Unix and Windows shapes on any host.
    #[cfg(test)]
    pub(crate) fn for_platform(platform: &'static str) -> Self {
        Self { platform }
    }

    /// Whether executables lay out Windows-style (flat in the runtime root,
    /// `.exe`/`.cmd` suffixed) rather than Unix-style under `bin/`.
    pub fn is_windows(&self) -> bool {
        is_windows_platform(self.platform)
    }

    /// The directory holding the runtime's executables under `install_dir`.
    pub fn bin_dir(&self, install_dir: &Path) -> PathBuf {
        node_bin_dir(install_dir, self.platform)
    }

    /// The `node` executable path under `install_dir`.
    pub fn node_exe(&self, install_dir: &Path) -> PathBuf {
        self.bin_dir(install_dir).join(node_exe_name(self.platform))
    }

    /// How to spawn npm for a runtime installed at `install_dir`.
    pub fn npm_command(&self, install_dir: &Path) -> NpmCommand {
        match npm_cli_entrypoint(install_dir, self.platform) {
            // The Windows release ships npm's CLI at
            // `<runtime>/node_modules/npm/bin/npm-cli.js`; driving it through
            // `node.exe` avoids the `npm.cmd` shell wrapper entirely.
            Some(npm_cli) => NpmCommand {
                program: self.node_exe(install_dir),
                leading_args: vec![npm_cli],
            },
            None => NpmCommand {
                program: self.bin_dir(install_dir).join(npm_exe_name(self.platform)),
                leading_args: Vec::new(),
            },
        }
    }

    /// The directory npm writes global-prefix executables into under `prefix`:
    /// the prefix root on Windows, `<prefix>/bin` everywhere else.
    pub fn npm_prefix_bin_dir(&self, prefix: &Path) -> PathBuf {
        if self.is_windows() {
            prefix.to_path_buf()
        } else {
            prefix.join("bin")
        }
    }
}

pub fn node_runtime_lock() -> &'static NodeRuntimeLock {
    static LOCK: OnceLock<NodeRuntimeLock> = OnceLock::new();
    LOCK.get_or_init(|| {
        serde_json::from_str(NODE_RUNTIME_LOCK_JSON)
            .expect("embedded node-runtime.lock.json must parse")
    })
}

/// Every target triple Berd manages a Node runtime for — the artifact keys of
/// the embedded `node-runtime.lock.json`, which is the one place that set is
/// written down. [`current_target_triple`] returns a member of this set on any
/// host Berd ships to, so downstream per-target data (npm target selectors,
/// `acp-tools.lock.json`'s `nativeExecutables`) must cover exactly these.
/// Exists so those tests read one list instead of keeping hand copies.
#[cfg(test)]
pub(crate) fn supported_target_triples() -> impl Iterator<Item = &'static str> {
    node_runtime_lock()
        .artifacts
        .keys()
        .map(std::string::String::as_str)
}

pub(crate) fn current_target_triple() -> Option<&'static str> {
    if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        Some("aarch64-apple-darwin")
    } else if cfg!(all(target_os = "macos", target_arch = "x86_64")) {
        Some("x86_64-apple-darwin")
    } else if cfg!(all(target_os = "linux", target_arch = "aarch64")) {
        Some("aarch64-unknown-linux-gnu")
    } else if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
        Some("x86_64-unknown-linux-gnu")
    } else if cfg!(all(target_os = "windows", target_arch = "x86_64")) {
        Some("x86_64-pc-windows-msvc")
    } else {
        None
    }
}

fn node_dist_base_url<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> String {
    node_dist_base_url_for_distribution(
        app.try_state::<DistroBundleState>()
            .and_then(|state| state.distribution_config().cloned()),
    )
}

fn node_dist_base_url_for_distribution(
    distribution: Option<crate::services::distro_bundle::DistributionDistroConfig>,
) -> String {
    distribution
        .map(|config| config.node_dist_base_url().to_string())
        .unwrap_or_else(|| UPSTREAM_NODE_DIST_BASE_URL.to_string())
}

#[derive(Debug)]
pub enum ManagedNodeError {
    UnsupportedTarget {
        os: &'static str,
        arch: &'static str,
    },
    AppData(String),
    LockMissingTarget(String),
    InvalidLockFilename(String),
    Network(String),
    HttpStatus(u16),
    ArchiveTooLarge {
        limit_bytes: u64,
    },
    Sha256Mismatch {
        expected: String,
        actual: String,
    },
    UnsafeArchiveEntry(String),
    ArchiveExpandedTooLarge {
        limit_bytes: u64,
    },
    ArchiveTooManyEntries {
        limit: u64,
    },
    IncompleteRuntime(String),
    Io(String),
}

impl std::fmt::Display for ManagedNodeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::UnsupportedTarget { os, arch } => {
                write!(f, "Berd does not provide a managed Node.js runtime for {os}-{arch}")
            }
            Self::AppData(message) => {
                write!(f, "failed to resolve the managed Node.js runtime directory: {message}")
            }
            Self::LockMissingTarget(target) => {
                write!(f, "node-runtime.lock.json has no artifact for target {target}")
            }
            Self::InvalidLockFilename(filename) => write!(
                f,
                "node-runtime.lock.json artifact '{filename}' is not a node-<version>-<platform>.tar.gz tarball"
            ),
            Self::Network(message) => write!(f, "Node.js runtime download failed: {message}"),
            Self::HttpStatus(status) => write!(f, "Node.js runtime download failed: HTTP {status}"),
            Self::ArchiveTooLarge { limit_bytes } => {
                write!(f, "Node.js runtime archive exceeds the {limit_bytes}-byte limit")
            }
            Self::Sha256Mismatch { expected, actual } => write!(
                f,
                "Node.js runtime archive SHA-256 mismatch: expected {expected}, got {actual}"
            ),
            Self::UnsafeArchiveEntry(path) => {
                write!(f, "Node.js runtime archive contains an unsafe entry path: {path}")
            }
            Self::ArchiveExpandedTooLarge { limit_bytes } => write!(
                f,
                "Node.js runtime archive expands beyond the {limit_bytes}-byte limit"
            ),
            Self::ArchiveTooManyEntries { limit } => write!(
                f,
                "Node.js runtime archive exceeds the {limit}-entry limit"
            ),
            Self::IncompleteRuntime(message) => {
                write!(f, "managed Node.js runtime install is incomplete: {message}")
            }
            Self::Io(message) => write!(f, "{message}"),
        }
    }
}

impl std::error::Error for ManagedNodeError {}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ManagedNodeProgress {
    Downloading {
        received_bytes: u64,
        total_bytes: Option<u64>,
    },
    Extracting,
    Installing,
}

pub type ManagedNodeProgressFn<'a> = dyn Fn(ManagedNodeProgress) + Send + Sync + 'a;

/// Chunk-level download callbacks fire far too often to surface one-per-line;
/// report at this granularity instead.
const PROGRESS_LINE_STEP_BYTES: u64 = 10 * 1024 * 1024;

/// Adapt a line sink (a log target, the agent-setup output buffer) into a
/// progress callback: download progress every [`PROGRESS_LINE_STEP_BYTES`]
/// plus the extract/install transitions.
pub fn progress_line_reporter<F>(on_line: F) -> impl Fn(ManagedNodeProgress) + Send + Sync
where
    F: Fn(String) + Send + Sync,
{
    let last_step = std::sync::atomic::AtomicU64::new(0);
    move |progress| match progress {
        ManagedNodeProgress::Downloading {
            received_bytes,
            total_bytes,
        } => {
            let step = received_bytes / PROGRESS_LINE_STEP_BYTES;
            if step > last_step.swap(step, std::sync::atomic::Ordering::Relaxed) {
                let received_mb = received_bytes / (1024 * 1024);
                on_line(match total_bytes {
                    Some(total) => format!(
                        "Downloading Node.js: {received_mb} MB of {} MB",
                        total.div_ceil(1024 * 1024)
                    ),
                    None => format!("Downloading Node.js: {received_mb} MB"),
                });
            }
        }
        ManagedNodeProgress::Extracting => on_line("Extracting Node.js runtime".to_string()),
        ManagedNodeProgress::Installing => on_line("Installing Node.js runtime".to_string()),
    }
}

/// `<app-data>/packages/node` — every managed runtime version lives under here.
pub fn managed_node_root<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Option<PathBuf> {
    let data_dir = app.path().app_data_dir().ok()?;
    Some(data_dir.join("packages").join("node"))
}

pub fn managed_node_bin_dir<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Option<PathBuf> {
    pinned_node_bin_dir(&managed_node_root(app)?)
}

/// The directory holding the pinned runtime's `node`/`npm` executables under
/// `root` — the runtime root on Windows, `<runtime>/bin` elsewhere. `None`
/// when the embedded lock has no artifact for this target.
pub fn pinned_node_bin_dir(root: &Path) -> Option<PathBuf> {
    let lock = node_runtime_lock();
    let artifact = lock.artifacts.get(current_target_triple()?)?;
    let platform = artifact.platform(&lock.version)?;
    Some(node_bin_dir(&pinned_install_dir(root)?, platform))
}

/// Where the pinned runtime for the current target lives (or belongs) under
/// `root` — `<root>/<version>/<platform>`. `None` when the embedded lock has
/// no artifact for this target.
pub fn pinned_install_dir(root: &Path) -> Option<PathBuf> {
    let lock = node_runtime_lock();
    let artifact = lock.artifacts.get(current_target_triple()?)?;
    let platform = artifact.platform(&lock.version)?;
    Some(install_dir(root, &lock.version, platform))
}

/// Whether the pinned runtime under `root` is installed and healthy for the
/// current target. `false` on unsupported targets.
pub async fn pinned_runtime_ready(root: &Path) -> bool {
    let lock = node_runtime_lock();
    match (pinned_install_dir(root), pinned_platform()) {
        (Some(final_dir), Some(platform)) => {
            runtime_ready(&final_dir, &lock.version, platform).await
        }
        _ => false,
    }
}

/// The pinned artifact's Node platform string for the current target, or
/// `None` when the embedded lock has no artifact for it.
fn pinned_platform() -> Option<&'static str> {
    let lock = node_runtime_lock();
    lock.artifacts
        .get(current_target_triple()?)?
        .platform(&lock.version)
}

fn install_dir(root: &Path, version: &str, platform: &str) -> PathBuf {
    root.join(version).join(platform)
}

/// Make sure the pinned Node.js runtime is installed and healthy, downloading
/// and atomically swapping it into place when it is not. Safe to call
/// concurrently: installs are serialized on a process-wide lock and re-check
/// readiness after acquiring it.
pub async fn ensure_managed_node_runtime<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    progress: &ManagedNodeProgressFn<'_>,
) -> Result<(), ManagedNodeError> {
    let root = managed_node_root(app).ok_or_else(|| {
        ManagedNodeError::AppData("app data directory is unavailable".to_string())
    })?;
    ensure_managed_node_runtime_at(
        &root,
        &node_dist_base_url(app),
        node_runtime_lock(),
        MAX_ARCHIVE_BYTES,
        progress,
    )
    .await
}

pub(crate) async fn ensure_managed_node_runtime_at(
    root: &Path,
    base_url: &str,
    lock: &NodeRuntimeLock,
    max_archive_bytes: u64,
    progress: &ManagedNodeProgressFn<'_>,
) -> Result<(), ManagedNodeError> {
    let target = current_target_triple().ok_or(ManagedNodeError::UnsupportedTarget {
        os: std::env::consts::OS,
        arch: std::env::consts::ARCH,
    })?;
    let artifact = lock
        .artifacts
        .get(target)
        .ok_or_else(|| ManagedNodeError::LockMissingTarget(target.to_string()))?;
    let platform = artifact
        .platform(&lock.version)
        .ok_or_else(|| ManagedNodeError::InvalidLockFilename(artifact.filename.clone()))?;

    let final_dir = install_dir(root, &lock.version, platform);
    if runtime_ready(&final_dir, &lock.version, platform).await {
        return Ok(());
    }

    let _guard = install_serialization_lock().lock().await;
    if runtime_ready(&final_dir, &lock.version, platform).await {
        return Ok(());
    }

    let plan = InstallPlan {
        root,
        version: &lock.version,
        platform,
        filename: &artifact.filename,
        sha256: &artifact.sha256,
        base_url,
        max_archive_bytes,
    };
    install_runtime(&plan, progress).await?;

    if runtime_ready(&final_dir, &lock.version, platform).await {
        Ok(())
    } else {
        Err(ManagedNodeError::IncompleteRuntime(
            "installed runtime failed the readiness probe".to_string(),
        ))
    }
}

fn install_serialization_lock() -> &'static tokio::sync::Mutex<()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

/// Fast-path readiness probe: the installed `node` executable runs and reports
/// exactly the pinned version, and the platform's required npm entrypoints are
/// present. The executable name and layout are target-aware (`node.exe` in the
/// runtime root on Windows, `bin/node` elsewhere). On Windows the managed npm
/// command executes `node.exe <node_modules/npm/bin/npm-cli.js>`, while other
/// setup and doctor paths may resolve the runtime's `npm.cmd` from PATH. Both
/// files are load-bearing: if either is deleted or quarantined while `node.exe`
/// stays healthy, the runtime is not usable and must be repaired rather than
/// reported ready.
async fn runtime_ready(final_dir: &Path, version: &str, platform: &str) -> bool {
    let bin_dir = node_bin_dir(final_dir, platform);
    let node = bin_dir.join(node_exe_name(platform));
    if !node.is_file() {
        return false;
    }
    if npm_cli_entrypoint(final_dir, platform).is_some_and(|npm_cli| {
        !bin_dir.join(npm_exe_name(platform)).is_file() || !npm_cli.is_file()
    }) {
        return false;
    }
    let output = {
        let mut cmd = tokio::process::Command::new(&node);
        cmd.arg("--version")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null());
        crate::services::process::apply_no_window_async(&mut cmd);
        cmd.output().await
    };
    output
        .ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).trim() == version)
        .unwrap_or(false)
}

struct InstallPlan<'a> {
    root: &'a Path,
    version: &'a str,
    platform: &'a str,
    filename: &'a str,
    sha256: &'a str,
    base_url: &'a str,
    max_archive_bytes: u64,
}

async fn install_runtime(
    plan: &InstallPlan<'_>,
    progress: &ManagedNodeProgressFn<'_>,
) -> Result<(), ManagedNodeError> {
    let final_dir = install_dir(plan.root, plan.version, plan.platform);
    let temp_dir = plan
        .root
        .join(format!("{}.{}.tmp", plan.version, plan.platform));
    let archive_path = plan.root.join(format!("{}.download", plan.filename));

    if temp_dir.exists() {
        std::fs::remove_dir_all(&temp_dir)
            .map_err(|error| ManagedNodeError::Io(format!("remove stale temp dir: {error}")))?;
    }
    if let Some(parent) = final_dir.parent() {
        std::fs::create_dir_all(parent).map_err(|error| {
            ManagedNodeError::Io(format!("create runtime version dir: {error}"))
        })?;
    }

    let url = format!(
        "{}/{}/{}",
        plan.base_url.trim_end_matches('/'),
        plan.version,
        plan.filename
    );
    download_archive(
        &url,
        &archive_path,
        plan.sha256,
        plan.max_archive_bytes,
        progress,
    )
    .await?;

    progress(ManagedNodeProgress::Extracting);
    std::fs::create_dir_all(&temp_dir)
        .map_err(|error| ManagedNodeError::Io(format!("create temp dir: {error}")))?;
    let format = archive_format(plan.filename);
    let max_extracted_bytes = MAX_EXTRACTED_BYTES;
    let extract_result = {
        let archive_path = archive_path.clone();
        let temp_dir = temp_dir.clone();
        tokio::task::spawn_blocking(move || {
            extract_archive(&archive_path, &temp_dir, format, max_extracted_bytes)
        })
        .await
        .map_err(|error| ManagedNodeError::Io(format!("extract task failed: {error}")))?
    };
    let _ = std::fs::remove_file(&archive_path);
    extract_result?;

    // Node archives unpack into a single `node-<version>-<platform>` dir.
    let extracted_dir = temp_dir.join(format!("node-{}-{}", plan.version, plan.platform));
    let source_dir = if extracted_dir.is_dir() {
        extracted_dir
    } else {
        temp_dir.clone()
    };
    verify_runtime_tree(&source_dir, plan.platform)?;

    progress(ManagedNodeProgress::Installing);
    swap_runtime_into_place(&source_dir, &final_dir)?;
    let _ = std::fs::remove_dir_all(&temp_dir);
    // Superseded version dirs are deliberately NOT pruned here: bridge shims
    // exec the absolute path of the Node version they were installed against,
    // so the old runtime must survive until every shim has been rewritten
    // onto this one. The reconcile epilogue prunes via
    // `prune_superseded_node_runtimes` once every bridge install succeeded.
    Ok(())
}

/// Atomically replace the runtime at `final_dir` with the freshly validated
/// tree at `source_dir`: stage any existing runtime aside to `<final>.old`,
/// rename the new tree into place, then drop the staged copy. On a failed
/// swap the previous runtime is rolled back so an install failure never leaves
/// the pinned runtime missing. A rollback that itself fails is surfaced with
/// the staged path so the broken state is diagnosable rather than silent.
fn swap_runtime_into_place(source_dir: &Path, final_dir: &Path) -> Result<(), ManagedNodeError> {
    let old_dir = final_dir.with_extension("old");
    if old_dir.exists() {
        std::fs::remove_dir_all(&old_dir)
            .map_err(|error| ManagedNodeError::Io(format!("remove stale old dir: {error}")))?;
    }
    if final_dir.exists() {
        std::fs::rename(final_dir, &old_dir)
            .map_err(|error| ManagedNodeError::Io(format!("stage previous runtime: {error}")))?;
    }
    if let Err(error) = std::fs::rename(source_dir, final_dir) {
        if old_dir.exists() {
            if let Err(rollback) = std::fs::rename(&old_dir, final_dir) {
                return Err(ManagedNodeError::Io(format!(
                    "install Node.js runtime: {error}; rolling the previous runtime back \
                     also failed: {rollback} (previous runtime is staged at {})",
                    old_dir.display()
                )));
            }
        }
        return Err(ManagedNodeError::Io(format!(
            "install Node.js runtime: {error}"
        )));
    }
    let _ = std::fs::remove_dir_all(&old_dir);
    Ok(())
}

/// Remove every managed runtime version under `root` except the embedded pin,
/// along with stale temp dirs and orphaned downloads. Callers must only prune
/// once nothing execs a superseded version anymore — i.e. after a reconcile
/// in which every managed bridge reinstalled (and re-shimmed) onto the pin.
/// Serialized against in-flight installs so a concurrent install's temp
/// artifacts are never swept out from under it.
pub async fn prune_superseded_node_runtimes(root: &Path) {
    let _guard = install_serialization_lock().lock().await;
    prune_superseded(root, &node_runtime_lock().version);
}

/// Everything under the root that is not the kept version dir — superseded
/// version dirs, stale temp dirs, orphaned downloads — is garbage once no
/// shim points into it. Best-effort only; a locked file just logs and is
/// retried on the next successful reconcile.
fn prune_superseded(root: &Path, version: &str) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        if entry.file_name().to_string_lossy() == version {
            // The kept version dir survives, but a `<platform>.old` staged
            // inside it by a swap whose cleanup was interrupted (or blocked by
            // a locked file on Windows) would otherwise leak forever, since
            // this loop never descends into the kept dir. Sweep those here.
            prune_stale_old_dirs(&entry.path());
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
                "failed to prune superseded managed Node.js entry {}: {error}",
                path.display()
            );
        }
    }
}

/// Remove `<platform>.old` staging dirs left inside the kept version dir when
/// a swap's best-effort cleanup did not complete.
fn prune_stale_old_dirs(version_dir: &Path) {
    let Ok(entries) = std::fs::read_dir(version_dir) else {
        return;
    };
    for entry in entries.flatten() {
        if entry.path().extension().and_then(|ext| ext.to_str()) != Some("old") {
            continue;
        }
        if let Err(error) = std::fs::remove_dir_all(entry.path()) {
            log::warn!(
                "failed to prune stale managed Node.js staging dir {}: {error}",
                entry.path().display()
            );
        }
    }
}

async fn download_archive(
    url: &str,
    dest: &Path,
    expected_sha256: &str,
    max_bytes: u64,
    progress: &ManagedNodeProgressFn<'_>,
) -> Result<(), ManagedNodeError> {
    let result = stream_archive(url, dest, expected_sha256, max_bytes, progress).await;
    if result.is_err() {
        let _ = tokio::fs::remove_file(dest).await;
    }
    result
}

async fn stream_archive(
    url: &str,
    dest: &Path,
    expected_sha256: &str,
    max_bytes: u64,
    progress: &ManagedNodeProgressFn<'_>,
) -> Result<(), ManagedNodeError> {
    let client = reqwest::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(DOWNLOAD_TIMEOUT)
        .build()
        .map_err(|error| ManagedNodeError::Network(format!("build download client: {error}")))?;
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|error| ManagedNodeError::Network(error.to_string()))?;
    let status = response.status();
    if !status.is_success() {
        return Err(ManagedNodeError::HttpStatus(status.as_u16()));
    }
    let total_bytes = response.content_length();
    if let Some(total) = total_bytes {
        if total > max_bytes {
            return Err(ManagedNodeError::ArchiveTooLarge {
                limit_bytes: max_bytes,
            });
        }
    }

    let mut file = tokio::fs::File::create(dest)
        .await
        .map_err(|error| ManagedNodeError::Io(format!("create archive file: {error}")))?;
    let mut stream = response.bytes_stream();
    let mut hasher = Sha256::new();
    let mut received_bytes = 0_u64;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| ManagedNodeError::Network(error.to_string()))?;
        received_bytes += chunk.len() as u64;
        if received_bytes > max_bytes {
            return Err(ManagedNodeError::ArchiveTooLarge {
                limit_bytes: max_bytes,
            });
        }
        hasher.update(&chunk);
        file.write_all(&chunk)
            .await
            .map_err(|error| ManagedNodeError::Io(format!("write archive file: {error}")))?;
        progress(ManagedNodeProgress::Downloading {
            received_bytes,
            total_bytes,
        });
    }
    file.flush()
        .await
        .map_err(|error| ManagedNodeError::Io(format!("flush archive file: {error}")))?;
    drop(file);

    let actual = hex::encode(hasher.finalize());
    if !actual.eq_ignore_ascii_case(expected_sha256) {
        return Err(ManagedNodeError::Sha256Mismatch {
            expected: expected_sha256.to_string(),
            actual,
        });
    }
    Ok(())
}

fn extract_archive(
    archive_path: &Path,
    dest_dir: &Path,
    format: ArchiveFormat,
    max_extracted_bytes: u64,
) -> Result<(), ManagedNodeError> {
    match format {
        ArchiveFormat::TarGz => extract_tar_gz(archive_path, dest_dir, max_extracted_bytes),
        ArchiveFormat::Zip => extract_zip(archive_path, dest_dir, max_extracted_bytes),
    }
}

fn extract_tar_gz(
    archive_path: &Path,
    dest_dir: &Path,
    max_extracted_bytes: u64,
) -> Result<(), ManagedNodeError> {
    // Two passes over the (seekable) file: validate every entry path and the
    // size/entry budgets before a single byte is written, then unpack. The
    // second pass uses `tar::Archive::unpack` so symlink entries (npm's
    // `bin/npm` → `lib/node_modules/...`) are recreated exactly as on macOS
    // and Linux today.
    let file = std::fs::File::open(archive_path)
        .map_err(|error| ManagedNodeError::Io(format!("open archive: {error}")))?;
    let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(file));
    validate_tar_entries(&mut archive, max_extracted_bytes)?;

    let file = std::fs::File::open(archive_path)
        .map_err(|error| ManagedNodeError::Io(format!("open archive for extraction: {error}")))?;
    let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(file));
    archive
        .unpack(dest_dir)
        .map_err(|error| ManagedNodeError::Io(format!("extract archive: {error}")))
}

fn validate_tar_entries<R: std::io::Read>(
    archive: &mut tar::Archive<R>,
    max_extracted_bytes: u64,
) -> Result<(), ManagedNodeError> {
    let entries = archive
        .entries()
        .map_err(|error| ManagedNodeError::Io(format!("read archive entries: {error}")))?;
    let mut total_bytes = 0_u64;
    let mut entry_count = 0_u64;
    for entry in entries {
        let entry =
            entry.map_err(|error| ManagedNodeError::Io(format!("read archive entry: {error}")))?;
        let path = entry
            .path()
            .map_err(|error| ManagedNodeError::Io(format!("read archive entry path: {error}")))?;
        if !is_safe_relative_path(&path) {
            return Err(ManagedNodeError::UnsafeArchiveEntry(
                path.to_string_lossy().into_owned(),
            ));
        }
        entry_count += 1;
        if entry_count > MAX_EXTRACTED_ENTRIES {
            return Err(ManagedNodeError::ArchiveTooManyEntries {
                limit: MAX_EXTRACTED_ENTRIES,
            });
        }
        total_bytes = total_bytes.saturating_add(entry.size());
        if total_bytes > max_extracted_bytes {
            return Err(ManagedNodeError::ArchiveExpandedTooLarge {
                limit_bytes: max_extracted_bytes,
            });
        }
    }
    Ok(())
}

/// Extract a `.zip` (Windows Node release) without shelling out to any host
/// tool. Rejects unsafe entry paths, then copies every file while enforcing a
/// running uncompressed-byte budget against the declared entry size — so a
/// lying header cannot expand past the cap.
fn extract_zip(
    archive_path: &Path,
    dest_dir: &Path,
    max_extracted_bytes: u64,
) -> Result<(), ManagedNodeError> {
    let file = std::fs::File::open(archive_path)
        .map_err(|error| ManagedNodeError::Io(format!("open archive: {error}")))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|error| ManagedNodeError::Io(format!("read zip archive: {error}")))?;
    if archive.len() as u64 > MAX_EXTRACTED_ENTRIES {
        return Err(ManagedNodeError::ArchiveTooManyEntries {
            limit: MAX_EXTRACTED_ENTRIES,
        });
    }

    let mut written_bytes = 0_u64;
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|error| ManagedNodeError::Io(format!("read zip entry: {error}")))?;
        let relative = zip_entry_relative_path(entry.name())
            .ok_or_else(|| ManagedNodeError::UnsafeArchiveEntry(entry.name().to_string()))?;
        let out_path = dest_dir.join(&relative);
        if entry.is_dir() {
            std::fs::create_dir_all(&out_path)
                .map_err(|error| ManagedNodeError::Io(format!("create zip dir: {error}")))?;
            continue;
        }
        if let Some(parent) = out_path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| {
                ManagedNodeError::Io(format!("create zip entry parent: {error}"))
            })?;
        }
        let remaining = max_extracted_bytes.saturating_sub(written_bytes);
        let mut out_file = std::fs::File::create(&out_path)
            .map_err(|error| ManagedNodeError::Io(format!("create zip entry file: {error}")))?;
        // `+ 1` so an entry that exactly fills the budget still copies while a
        // stream that runs one byte over is detected.
        let mut limited = std::io::Read::take(&mut entry, remaining + 1);
        let copied = std::io::copy(&mut limited, &mut out_file)
            .map_err(|error| ManagedNodeError::Io(format!("write zip entry: {error}")))?;
        if copied > remaining {
            return Err(ManagedNodeError::ArchiveExpandedTooLarge {
                limit_bytes: max_extracted_bytes,
            });
        }
        written_bytes += copied;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if let Some(mode) = entry.unix_mode() {
                let _ = std::fs::set_permissions(&out_path, std::fs::Permissions::from_mode(mode));
            }
        }
    }
    Ok(())
}

/// A tar/zip entry path is safe to extract when it is relative and made of
/// only normal path components — no absolute root, drive prefix, or `..`
/// traversal.
fn is_safe_relative_path(path: &Path) -> bool {
    use std::path::Component;
    path.components().next().is_some()
        && path
            .components()
            .all(|component| matches!(component, Component::Normal(_) | Component::CurDir))
}

/// The safe relative path for a raw zip entry name, or `None` when it would
/// escape the destination. Zip names are `/`-separated per spec; a backslash
/// is rejected outright so a `..\` payload cannot slip past the `/`-only
/// component check on non-Windows hosts.
fn zip_entry_relative_path(name: &str) -> Option<PathBuf> {
    if name.contains('\\') {
        return None;
    }
    let path = Path::new(name);
    is_safe_relative_path(path).then(|| path.to_path_buf())
}

fn verify_runtime_tree(dir: &Path, platform: &str) -> Result<(), ManagedNodeError> {
    let bin_dir = node_bin_dir(dir, platform);
    for binary in [node_exe_name(platform), npm_exe_name(platform)] {
        if !bin_dir.join(binary).is_file() {
            return Err(ManagedNodeError::IncompleteRuntime(format!(
                "archive is missing {binary}"
            )));
        }
    }
    // The Windows npm command execs `node.exe <node_modules/npm/bin/npm-cli.js>`,
    // so a tree without that CLI would install "ready" yet fail every npm run.
    if let Some(npm_cli) = npm_cli_entrypoint(dir, platform) {
        if !npm_cli.is_file() {
            return Err(ManagedNodeError::IncompleteRuntime(
                "archive is missing node_modules/npm/bin/npm-cli.js".to_string(),
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write as _;
    use std::sync::Mutex;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    const TEST_VERSION: &str = "v9.9.9";
    const TEST_PLATFORM: &str = "testos-testarch";
    const WIN_PLATFORM: &str = "win-x64";

    fn target() -> &'static str {
        current_target_triple().expect("tests only run on supported targets")
    }

    fn test_lock(sha256: &str) -> NodeRuntimeLock {
        let mut artifacts = BTreeMap::new();
        artifacts.insert(
            target().to_string(),
            NodeRuntimeArtifact {
                filename: format!("node-{TEST_VERSION}-{TEST_PLATFORM}.tar.gz"),
                sha256: sha256.to_string(),
            },
        );
        NodeRuntimeLock {
            version: TEST_VERSION.to_string(),
            artifacts,
        }
    }

    fn sha256_hex(bytes: &[u8]) -> String {
        hex::encode(Sha256::digest(bytes))
    }

    fn node_script(version: &str) -> String {
        format!("#!/bin/sh\necho {version}\n")
    }

    fn ignore_progress(_: ManagedNodeProgress) {}

    fn gzip(tar_bytes: &[u8]) -> Vec<u8> {
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        encoder.write_all(tar_bytes).unwrap();
        encoder.finish().unwrap()
    }

    fn append_file(builder: &mut tar::Builder<Vec<u8>>, path: &str, contents: &str, mode: u32) {
        let mut header = tar::Header::new_gnu();
        header.set_size(contents.len() as u64);
        header.set_mode(mode);
        builder
            .append_data(&mut header, path, contents.as_bytes())
            .unwrap();
    }

    /// A minimal but shape-faithful Node release tarball: executable
    /// `bin/node` stub plus the `bin/npm` symlink into `lib/node_modules`.
    fn node_tarball(version: &str) -> Vec<u8> {
        let prefix = format!("node-{version}-{TEST_PLATFORM}");
        let mut builder = tar::Builder::new(Vec::new());
        append_file(
            &mut builder,
            &format!("{prefix}/bin/node"),
            &node_script(version),
            0o755,
        );
        append_file(
            &mut builder,
            &format!("{prefix}/lib/node_modules/npm/bin/npm-cli.js"),
            "#!/usr/bin/env node\n",
            0o755,
        );
        let mut header = tar::Header::new_gnu();
        header.set_entry_type(tar::EntryType::Symlink);
        header.set_size(0);
        header.set_mode(0o777);
        builder
            .append_link(
                &mut header,
                format!("{prefix}/bin/npm"),
                "../lib/node_modules/npm/bin/npm-cli.js",
            )
            .unwrap();
        gzip(&builder.into_inner().unwrap())
    }

    /// `tar::Builder` refuses to author unsafe paths, so write the name field
    /// into the raw header bytes.
    fn raw_entry_tar(name: &str) -> Vec<u8> {
        let mut header = tar::Header::new_gnu();
        header.as_mut_bytes()[..name.len()].copy_from_slice(name.as_bytes());
        header.set_size(4);
        header.set_mode(0o644);
        header.set_cksum();
        let mut builder = tar::Builder::new(Vec::new());
        builder.append(&header, &b"evil"[..]).unwrap();
        builder.into_inner().unwrap()
    }

    /// One-shot HTTP server; without a Content-Length header the body is
    /// delimited by connection close, which exercises the streaming size cap.
    async fn serve_once(body: Vec<u8>, with_content_length: bool) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0_u8; 1024];
            let _ = socket.read(&mut request).await;
            let head = if with_content_length {
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                )
            } else {
                "HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n".to_string()
            };
            socket.write_all(head.as_bytes()).await.unwrap();
            socket.write_all(&body).await.unwrap();
            let _ = socket.shutdown().await;
        });
        format!("http://{addr}")
    }

    /// A ready Unix runtime whose `bin/node` is an executable `#!/bin/sh`
    /// stub. Unix-only: the stub relies on the shebang, so the readiness probe
    /// that runs it cannot execute on native Windows. Windows execution is
    /// covered by the real-ZIP native gate.
    #[cfg(unix)]
    fn write_ready_runtime(root: &Path, version: &str) {
        let bin = install_dir(root, version, TEST_PLATFORM).join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let node = bin.join("node");
        std::fs::write(&node, node_script(version)).unwrap();
        set_test_executable(&node);
        std::fs::write(bin.join("npm"), "").unwrap();
    }

    #[cfg(unix)]
    fn set_test_executable(path: &Path) {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    #[cfg(windows)]
    fn set_test_executable(_path: &Path) {}

    #[test]
    fn embedded_lock_pins_every_release_target() {
        let lock = node_runtime_lock();
        assert!(lock.version.starts_with('v'), "version: {}", lock.version);
        for target in [
            "aarch64-apple-darwin",
            "x86_64-apple-darwin",
            "aarch64-unknown-linux-gnu",
            "x86_64-unknown-linux-gnu",
            "x86_64-pc-windows-msvc",
        ] {
            let artifact = lock
                .artifacts
                .get(target)
                .unwrap_or_else(|| panic!("lock is missing {target}"));
            assert_eq!(artifact.sha256.len(), 64, "{target}");
            assert!(
                artifact.sha256.chars().all(|c| c.is_ascii_hexdigit()),
                "{target}"
            );
            assert!(artifact.platform(&lock.version).is_some(), "{target}");
        }
    }

    #[test]
    fn artifact_platform_derives_from_filename() {
        let artifact = NodeRuntimeArtifact {
            filename: "node-v24.11.0-darwin-arm64.tar.gz".to_string(),
            sha256: String::new(),
        };
        assert_eq!(artifact.platform("v24.11.0"), Some("darwin-arm64"));
        assert_eq!(artifact.platform("v24.12.0"), None);
    }

    #[test]
    fn base_url_defaults_upstream_and_distribution_override_wins() {
        assert_eq!(
            node_dist_base_url_for_distribution(None),
            UPSTREAM_NODE_DIST_BASE_URL
        );

        let distribution = serde_json::from_str(
            r#"{"npmRegistryUrl":"https://packages.example.test/npm/","nodeDistBaseUrl":"https://node.example.test/dist/"}"#,
        )
        .unwrap();
        assert_eq!(
            node_dist_base_url_for_distribution(Some(distribution)),
            "https://node.example.test/dist/"
        );
    }

    #[test]
    fn archive_validation_rejects_traversal_and_absolute_paths() {
        for name in ["../evil.sh", "/abs/evil.sh"] {
            let mut archive = tar::Archive::new(std::io::Cursor::new(raw_entry_tar(name)));
            let error = validate_tar_entries(&mut archive, MAX_EXTRACTED_BYTES).unwrap_err();
            assert!(
                matches!(error, ManagedNodeError::UnsafeArchiveEntry(_)),
                "{name}: {error}"
            );
        }
    }

    // These tests drive the full install/readiness path against a `#!/bin/sh`
    // fake `node`, so the readiness probe actually executes it. That stub
    // cannot run on native Windows; the real-ZIP native gate covers Windows
    // execution.
    #[cfg(unix)]
    #[tokio::test]
    async fn install_keeps_superseded_versions_until_reconcile_prunes() {
        let root_dir = tempfile::tempdir().unwrap();
        let root = root_dir.path();
        // Leftovers from a superseded install and a crashed one.
        std::fs::create_dir_all(install_dir(root, "v9.9.8", TEST_PLATFORM)).unwrap();
        std::fs::create_dir_all(root.join(format!("{TEST_VERSION}.{TEST_PLATFORM}.tmp"))).unwrap();
        std::fs::write(root.join("node-v9.9.8-old.tar.gz.download"), b"stale").unwrap();

        let archive = node_tarball(TEST_VERSION);
        let lock = test_lock(&sha256_hex(&archive));
        let base_url = serve_once(archive, true).await;

        let events = Mutex::new(Vec::new());
        let record = |event: ManagedNodeProgress| events.lock().unwrap().push(event);
        ensure_managed_node_runtime_at(root, &base_url, &lock, MAX_ARCHIVE_BYTES, &record)
            .await
            .unwrap();

        let bin = install_dir(root, TEST_VERSION, TEST_PLATFORM).join("bin");
        assert!(bin.join("node").is_file());
        assert!(bin.join("npm").is_file());
        // The install cleans up its own temp dir but leaves the superseded
        // version (and the other install's orphaned download) alone: shims
        // written against v9.9.8 must keep working until the reconcile
        // epilogue confirms every bridge migrated and prunes.
        assert!(root.join("v9.9.8").exists());
        assert!(!root
            .join(format!("{TEST_VERSION}.{TEST_PLATFORM}.tmp"))
            .exists());
        assert!(root.join("node-v9.9.8-old.tar.gz.download").exists());

        prune_superseded(root, TEST_VERSION);
        assert!(bin.join("node").is_file());
        assert!(!root.join("v9.9.8").exists());
        assert!(!root.join("node-v9.9.8-old.tar.gz.download").exists());

        let recorded = events.lock().unwrap().clone();
        assert!(recorded
            .iter()
            .any(|event| matches!(event, ManagedNodeProgress::Downloading { .. })));
        assert!(recorded.contains(&ManagedNodeProgress::Extracting));
        assert!(recorded.contains(&ManagedNodeProgress::Installing));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn fast_path_skips_download_when_runtime_matches_pin() {
        let root_dir = tempfile::tempdir().unwrap();
        write_ready_runtime(root_dir.path(), TEST_VERSION);

        // An unroutable base URL: any download attempt fails the test.
        ensure_managed_node_runtime_at(
            root_dir.path(),
            "http://127.0.0.1:1",
            &test_lock(&"0".repeat(64)),
            MAX_ARCHIVE_BYTES,
            &ignore_progress,
        )
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn sha_mismatch_fails_and_preserves_previous_install() {
        let root_dir = tempfile::tempdir().unwrap();
        let root = root_dir.path();
        std::fs::create_dir_all(install_dir(root, "v9.9.8", TEST_PLATFORM)).unwrap();

        let lock = test_lock(&sha256_hex(b"something else entirely"));
        let base_url = serve_once(node_tarball(TEST_VERSION), true).await;
        let error = ensure_managed_node_runtime_at(
            root,
            &base_url,
            &lock,
            MAX_ARCHIVE_BYTES,
            &ignore_progress,
        )
        .await
        .unwrap_err();

        assert!(
            matches!(error, ManagedNodeError::Sha256Mismatch { .. }),
            "{error}"
        );
        assert!(!install_dir(root, TEST_VERSION, TEST_PLATFORM).exists());
        // The failed download is cleaned up and the previous install is only
        // pruned by a later fully-successful reconcile.
        assert!(install_dir(root, "v9.9.8", TEST_PLATFORM).exists());
        let downloads = std::fs::read_dir(root)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().ends_with(".download"))
            .count();
        assert_eq!(downloads, 0);
    }

    #[tokio::test]
    async fn download_size_cap_aborts_stream() {
        let root_dir = tempfile::tempdir().unwrap();
        let body = vec![0_u8; 4096];
        let lock = test_lock(&sha256_hex(&body));
        let base_url = serve_once(body, false).await;

        let error = ensure_managed_node_runtime_at(
            root_dir.path(),
            &base_url,
            &lock,
            1024,
            &ignore_progress,
        )
        .await
        .unwrap_err();

        assert!(
            matches!(error, ManagedNodeError::ArchiveTooLarge { .. }),
            "{error}"
        );
        let leftovers = std::fs::read_dir(root_dir.path())
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().ends_with(".download"))
            .count();
        assert_eq!(leftovers, 0);
    }

    #[tokio::test]
    async fn traversal_entry_fails_install() {
        let root_dir = tempfile::tempdir().unwrap();
        let archive = gzip(&raw_entry_tar("../evil.sh"));
        let lock = test_lock(&sha256_hex(&archive));
        let base_url = serve_once(archive, true).await;

        let error = ensure_managed_node_runtime_at(
            root_dir.path(),
            &base_url,
            &lock,
            MAX_ARCHIVE_BYTES,
            &ignore_progress,
        )
        .await
        .unwrap_err();

        assert!(
            matches!(error, ManagedNodeError::UnsafeArchiveEntry(_)),
            "{error}"
        );
        assert!(!install_dir(root_dir.path(), TEST_VERSION, TEST_PLATFORM).exists());
        // `../evil.sh` would have escaped the temp dir into the root.
        assert!(!root_dir.path().join("evil.sh").exists());
    }

    #[tokio::test]
    async fn archive_missing_npm_fails_install() {
        let root_dir = tempfile::tempdir().unwrap();
        let prefix = format!("node-{TEST_VERSION}-{TEST_PLATFORM}");
        let mut builder = tar::Builder::new(Vec::new());
        append_file(
            &mut builder,
            &format!("{prefix}/bin/node"),
            &node_script(TEST_VERSION),
            0o755,
        );
        let archive = gzip(&builder.into_inner().unwrap());
        let lock = test_lock(&sha256_hex(&archive));
        let base_url = serve_once(archive, true).await;

        let error = ensure_managed_node_runtime_at(
            root_dir.path(),
            &base_url,
            &lock,
            MAX_ARCHIVE_BYTES,
            &ignore_progress,
        )
        .await
        .unwrap_err();

        assert!(
            matches!(error, ManagedNodeError::IncompleteRuntime(_)),
            "{error}"
        );
        assert!(!install_dir(root_dir.path(), TEST_VERSION, TEST_PLATFORM).exists());
    }

    #[test]
    fn pinned_install_dir_follows_the_embedded_lock() {
        let lock = node_runtime_lock();
        let artifact = &lock.artifacts[target()];
        let platform = artifact.platform(&lock.version).unwrap();
        assert_eq!(
            pinned_install_dir(Path::new("/data/packages/node")),
            Some(
                Path::new("/data/packages/node")
                    .join(&lock.version)
                    .join(platform)
            )
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn pinned_runtime_ready_probes_the_embedded_pin() {
        let root_dir = tempfile::tempdir().unwrap();
        let root = root_dir.path();
        assert!(!pinned_runtime_ready(root).await);

        // A runtime matching the real embedded pin at the pinned install dir.
        let bin = pinned_install_dir(root).unwrap().join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let node = bin.join("node");
        std::fs::write(&node, node_script(&node_runtime_lock().version)).unwrap();
        set_test_executable(&node);
        assert!(pinned_runtime_ready(root).await);
    }

    #[tokio::test]
    async fn prune_superseded_node_runtimes_keeps_only_the_embedded_pin() {
        let root_dir = tempfile::tempdir().unwrap();
        let root = root_dir.path();
        let pinned_bin = pinned_install_dir(root).unwrap().join("bin");
        std::fs::create_dir_all(&pinned_bin).unwrap();
        std::fs::create_dir_all(install_dir(root, "v9.9.8", TEST_PLATFORM)).unwrap();
        std::fs::write(root.join("node-v9.9.8-old.tar.gz.download"), b"stale").unwrap();

        prune_superseded_node_runtimes(root).await;

        assert!(pinned_bin.exists());
        assert!(!root.join("v9.9.8").exists());
        assert!(!root.join("node-v9.9.8-old.tar.gz.download").exists());
    }

    #[test]
    fn progress_line_reporter_throttles_download_chunks() {
        let lines = Mutex::new(Vec::new());
        let report = progress_line_reporter(|line| lines.lock().unwrap().push(line));

        let mb = 1024 * 1024;
        for received in [mb, 5 * mb, 12 * mb, 15 * mb, 25 * mb] {
            report(ManagedNodeProgress::Downloading {
                received_bytes: received,
                total_bytes: Some(49 * mb),
            });
        }
        report(ManagedNodeProgress::Extracting);
        report(ManagedNodeProgress::Installing);

        assert_eq!(
            *lines.lock().unwrap(),
            vec![
                "Downloading Node.js: 12 MB of 49 MB",
                "Downloading Node.js: 25 MB of 49 MB",
                "Extracting Node.js runtime",
                "Installing Node.js runtime",
            ]
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn readiness_probe_requires_exact_pinned_version() {
        let root_dir = tempfile::tempdir().unwrap();
        let root = root_dir.path();
        let final_dir = install_dir(root, TEST_VERSION, TEST_PLATFORM);
        assert!(!runtime_ready(&final_dir, TEST_VERSION, TEST_PLATFORM).await);

        write_ready_runtime(root, TEST_VERSION);
        assert!(runtime_ready(&final_dir, TEST_VERSION, TEST_PLATFORM).await);
        assert!(!runtime_ready(&final_dir, "v9.9.8", TEST_PLATFORM).await);
    }

    // ── Windows target ──────────────────────────────────────────────────

    #[test]
    fn windows_target_maps_to_zip_and_win_platform() {
        let lock = node_runtime_lock();
        let artifact = lock
            .artifacts
            .get("x86_64-pc-windows-msvc")
            .expect("lock is missing the Windows target");
        assert_eq!(artifact.platform(&lock.version), Some("win-x64"));
        assert_eq!(archive_format(&artifact.filename), ArchiveFormat::Zip);
        assert!(artifact.filename.ends_with(".zip"));
    }

    #[test]
    fn artifact_platform_parses_zip_filenames() {
        let artifact = NodeRuntimeArtifact {
            filename: "node-v24.11.0-win-x64.zip".to_string(),
            sha256: String::new(),
        };
        assert_eq!(artifact.platform("v24.11.0"), Some("win-x64"));
        assert_eq!(artifact.platform("v24.12.0"), None);
    }

    #[test]
    fn archive_format_and_layout_are_target_aware() {
        assert_eq!(
            archive_format("node-v1-linux-x64.tar.gz"),
            ArchiveFormat::TarGz
        );
        assert_eq!(archive_format("node-v1-win-x64.zip"), ArchiveFormat::Zip);

        assert!(is_windows_platform("win-x64"));
        assert!(!is_windows_platform("linux-x64"));

        let root = Path::new("/data/v1/win-x64");
        assert_eq!(node_bin_dir(root, "win-x64"), root.to_path_buf());
        assert_eq!(node_bin_dir(root, "linux-x64"), root.join("bin"));
        assert_eq!(node_exe_name("win-x64"), "node.exe");
        assert_eq!(node_exe_name("linux-x64"), "node");
        assert_eq!(npm_exe_name("win-x64"), "npm.cmd");
        assert_eq!(npm_exe_name("linux-x64"), "npm");
    }

    /// A minimal but shape-faithful Windows Node release zip: `node.exe`,
    /// `npm`, and `npm.cmd` flat in the runtime root (no `bin/`), plus the
    /// `node_modules/npm/bin/npm-cli.js` the Windows npm command execs.
    fn node_win_zip(version: &str, extra: &[(&str, &[u8])]) -> Vec<u8> {
        use zip::write::SimpleFileOptions;
        let prefix = format!("node-{version}-{WIN_PLATFORM}");
        let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        let options =
            SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        let files: &[(&str, &[u8])] = &[
            ("node.exe", b"MZ node"),
            ("npm", b"#!/bin/sh\n"),
            ("npm.cmd", b"@echo off\n"),
            ("node_modules/npm/bin/npm-cli.js", b"// npm-cli\n"),
        ];
        writer.add_directory(format!("{prefix}/"), options).unwrap();
        for (name, contents) in files {
            writer
                .start_file(format!("{prefix}/{name}"), options)
                .unwrap();
            writer.write_all(contents).unwrap();
        }
        for (name, contents) in extra {
            writer
                .start_file(format!("{prefix}/{name}"), options)
                .unwrap();
            writer.write_all(contents).unwrap();
        }
        writer.finish().unwrap().into_inner()
    }

    fn win_test_lock(sha256: &str) -> NodeRuntimeLock {
        let mut artifacts = BTreeMap::new();
        artifacts.insert(
            "x86_64-pc-windows-msvc".to_string(),
            NodeRuntimeArtifact {
                filename: format!("node-{TEST_VERSION}-{WIN_PLATFORM}.zip"),
                sha256: sha256.to_string(),
            },
        );
        NodeRuntimeLock {
            version: TEST_VERSION.to_string(),
            artifacts,
        }
    }

    #[test]
    fn zip_extraction_lays_out_windows_runtime_flat() {
        let root_dir = tempfile::tempdir().unwrap();
        let dest = root_dir.path().join("out");
        std::fs::create_dir_all(&dest).unwrap();
        let zip = node_win_zip(TEST_VERSION, &[("subdir/extra.txt", b"data")]);
        let archive = root_dir.path().join("node.zip");
        std::fs::write(&archive, &zip).unwrap();

        extract_zip(&archive, &dest, MAX_EXTRACTED_BYTES).unwrap();

        let runtime = dest.join(format!("node-{TEST_VERSION}-{WIN_PLATFORM}"));
        assert!(runtime.join("node.exe").is_file());
        assert!(runtime.join("npm.cmd").is_file());
        assert!(runtime.join("subdir").join("extra.txt").is_file());
        // Windows layout: executables sit in the runtime root, not under bin/.
        verify_runtime_tree(&runtime, WIN_PLATFORM).unwrap();
    }

    #[test]
    fn verify_runtime_tree_requires_windows_npm_cli() {
        let root_dir = tempfile::tempdir().unwrap();
        let runtime = root_dir.path();
        // A Windows tree with node.exe + npm.cmd but no npm-cli.js: the npm
        // command would exec a missing `node.exe <npm-cli.js>` and fail every
        // run, so the tree must be rejected as incomplete rather than accepted.
        std::fs::write(runtime.join("node.exe"), b"MZ node").unwrap();
        std::fs::write(runtime.join("npm.cmd"), b"@echo off\n").unwrap();
        let error = verify_runtime_tree(runtime, WIN_PLATFORM).unwrap_err();
        assert!(
            matches!(error, ManagedNodeError::IncompleteRuntime(ref message)
                if message.contains("npm-cli.js")),
            "{error:?}"
        );

        // Adding the CLI entrypoint completes the tree.
        let npm_cli = npm_cli_entrypoint(runtime, WIN_PLATFORM).unwrap();
        std::fs::create_dir_all(npm_cli.parent().unwrap()).unwrap();
        std::fs::write(&npm_cli, b"// npm-cli\n").unwrap();
        verify_runtime_tree(runtime, WIN_PLATFORM).unwrap();
    }

    #[tokio::test]
    async fn readiness_probe_requires_windows_npm_entrypoints() {
        // On Windows both npm.cmd (for PATH-resolved setup/doctor paths) and
        // npm-cli.js (for the managed Node-driven npm command) are required.
        // Losing either one must mark the runtime not ready so ensure repairs
        // the installation. These file gates run before node.exe is executed,
        // so this detection test remains host-independent.
        let root_dir = tempfile::tempdir().unwrap();
        let runtime = install_dir(root_dir.path(), TEST_VERSION, WIN_PLATFORM);
        std::fs::create_dir_all(&runtime).unwrap();
        std::fs::write(runtime.join("node.exe"), b"MZ node").unwrap();
        std::fs::write(runtime.join("npm.cmd"), b"@echo off\n").unwrap();

        // node.exe + npm.cmd present but npm-cli.js missing: not ready.
        assert!(
            !runtime_ready(&runtime, TEST_VERSION, WIN_PLATFORM).await,
            "runtime with a missing npm-cli.js must not be reported ready"
        );

        let npm_cli = npm_cli_entrypoint(&runtime, WIN_PLATFORM).unwrap();
        std::fs::create_dir_all(npm_cli.parent().unwrap()).unwrap();
        std::fs::write(&npm_cli, b"// npm-cli\n").unwrap();

        // node.exe + npm-cli.js present but npm.cmd missing: also not ready.
        std::fs::remove_file(runtime.join("npm.cmd")).unwrap();
        assert!(
            !runtime_ready(&runtime, TEST_VERSION, WIN_PLATFORM).await,
            "runtime with a missing npm.cmd must not be reported ready"
        );

        // Restoring npm.cmd clears both file-existence gates. The probe then
        // proceeds to execute node.exe, which is covered by the Windows gate.
        std::fs::write(runtime.join("npm.cmd"), b"@echo off\n").unwrap();
        assert!(npm_cli.is_file() && runtime.join("npm.cmd").is_file());
    }

    #[test]
    fn zip_extraction_rejects_traversal_entries() {
        for name in [
            "../evil.txt",
            "..\\evil.txt",
            "/abs/evil.txt",
            "sub/../../evil",
        ] {
            use zip::write::SimpleFileOptions;
            let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
            let options = SimpleFileOptions::default();
            writer.start_file(name, options).unwrap();
            writer.write_all(b"evil").unwrap();
            let bytes = writer.finish().unwrap().into_inner();

            let root_dir = tempfile::tempdir().unwrap();
            let dest = root_dir.path().join("out");
            std::fs::create_dir_all(&dest).unwrap();
            let archive = root_dir.path().join("node.zip");
            std::fs::write(&archive, &bytes).unwrap();

            let error = extract_zip(&archive, &dest, MAX_EXTRACTED_BYTES).unwrap_err();
            assert!(
                matches!(error, ManagedNodeError::UnsafeArchiveEntry(_)),
                "{name}: {error:?}"
            );
            // Nothing escaped the destination dir.
            assert!(!root_dir.path().join("evil.txt").exists());
        }
    }

    #[test]
    fn zip_extraction_enforces_uncompressed_byte_cap() {
        let root_dir = tempfile::tempdir().unwrap();
        let dest = root_dir.path().join("out");
        std::fs::create_dir_all(&dest).unwrap();
        // A single 4 KiB entry against a 1 KiB budget.
        let zip = node_win_zip(TEST_VERSION, &[("big.bin", &vec![0_u8; 4096])]);
        let archive = root_dir.path().join("node.zip");
        std::fs::write(&archive, &zip).unwrap();

        let error = extract_zip(&archive, &dest, 1024).unwrap_err();
        assert!(
            matches!(error, ManagedNodeError::ArchiveExpandedTooLarge { .. }),
            "{error:?}"
        );
    }

    #[tokio::test]
    async fn windows_zip_installs_flat_layout() {
        let root_dir = tempfile::tempdir().unwrap();
        let root = root_dir.path();
        let zip = node_win_zip(TEST_VERSION, &[]);
        let lock = win_test_lock(&sha256_hex(&zip));
        let base_url = serve_once(zip, true).await;

        install_windows_runtime(root, &base_url, &lock)
            .await
            .unwrap();

        let runtime = install_dir(root, TEST_VERSION, WIN_PLATFORM);
        // node.exe / npm.cmd sit flat in the runtime root.
        assert!(runtime.join("node.exe").is_file());
        assert!(runtime.join("npm.cmd").is_file());
        // The bin-dir resolver points at the runtime root on Windows.
        assert_eq!(node_bin_dir(&runtime, WIN_PLATFORM), runtime);
    }

    #[tokio::test]
    async fn windows_install_recovers_from_partial_temp_dir() {
        let root_dir = tempfile::tempdir().unwrap();
        let root = root_dir.path();
        // A crashed prior install left a half-written temp dir behind.
        let stale_temp = root.join(format!("{TEST_VERSION}.{WIN_PLATFORM}.tmp"));
        std::fs::create_dir_all(stale_temp.join("garbage")).unwrap();
        std::fs::write(stale_temp.join("garbage").join("f"), b"junk").unwrap();

        let zip = node_win_zip(TEST_VERSION, &[]);
        let lock = win_test_lock(&sha256_hex(&zip));
        let base_url = serve_once(zip, true).await;

        install_windows_runtime(root, &base_url, &lock)
            .await
            .unwrap();

        let runtime = install_dir(root, TEST_VERSION, WIN_PLATFORM);
        assert!(runtime.join("node.exe").is_file());
        assert!(runtime.join("npm.cmd").is_file());
        assert!(!stale_temp.exists());
    }

    #[tokio::test]
    async fn windows_install_handles_paths_with_spaces() {
        let root_dir = tempfile::tempdir().unwrap();
        let root = root_dir.path().join("App Data").join("packages node");
        std::fs::create_dir_all(&root).unwrap();

        let zip = node_win_zip(TEST_VERSION, &[]);
        let lock = win_test_lock(&sha256_hex(&zip));
        let base_url = serve_once(zip, true).await;

        install_windows_runtime(&root, &base_url, &lock)
            .await
            .unwrap();

        let runtime = install_dir(&root, TEST_VERSION, WIN_PLATFORM);
        assert!(runtime.join("node.exe").is_file());
        assert!(runtime.join("npm.cmd").is_file());
    }

    #[tokio::test]
    async fn windows_zip_missing_node_exe_fails_install() {
        use zip::write::SimpleFileOptions;
        let prefix = format!("node-{TEST_VERSION}-{WIN_PLATFORM}");
        let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        let options = SimpleFileOptions::default();
        writer
            .start_file(format!("{prefix}/npm.cmd"), options)
            .unwrap();
        writer.write_all(b"@echo off\n").unwrap();
        let zip = writer.finish().unwrap().into_inner();

        let root_dir = tempfile::tempdir().unwrap();
        let lock = win_test_lock(&sha256_hex(&zip));
        let base_url = serve_once(zip, true).await;

        let error = install_windows_runtime(root_dir.path(), &base_url, &lock)
            .await
            .unwrap_err();
        assert!(
            matches!(error, ManagedNodeError::IncompleteRuntime(_)),
            "{error:?}"
        );
        assert!(!install_dir(root_dir.path(), TEST_VERSION, WIN_PLATFORM).exists());
    }

    #[tokio::test]
    async fn windows_zip_sha_mismatch_fails_install() {
        let root_dir = tempfile::tempdir().unwrap();
        let zip = node_win_zip(TEST_VERSION, &[]);
        let lock = win_test_lock(&sha256_hex(b"not the archive"));
        let base_url = serve_once(zip, true).await;

        let error = install_windows_runtime(root_dir.path(), &base_url, &lock)
            .await
            .unwrap_err();
        assert!(
            matches!(error, ManagedNodeError::Sha256Mismatch { .. }),
            "{error:?}"
        );
        assert!(!install_dir(root_dir.path(), TEST_VERSION, WIN_PLATFORM).exists());
    }

    // ── Atomic swap + repair durability ─────────────────────────────────

    #[test]
    fn swap_installs_when_no_previous_runtime_exists() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("source");
        let final_dir = dir.path().join("final");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::write(source.join("node"), b"new").unwrap();

        swap_runtime_into_place(&source, &final_dir).unwrap();

        assert!(final_dir.join("node").is_file());
        assert!(!source.exists());
        assert!(!final_dir.with_extension("old").exists());
    }

    #[test]
    fn swap_replaces_previous_runtime_and_drops_staged_copy() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("source");
        let final_dir = dir.path().join("final");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::write(source.join("node"), b"new").unwrap();
        std::fs::create_dir_all(&final_dir).unwrap();
        std::fs::write(final_dir.join("node"), b"old").unwrap();

        swap_runtime_into_place(&source, &final_dir).unwrap();

        assert_eq!(std::fs::read(final_dir.join("node")).unwrap(), b"new");
        assert!(!final_dir.with_extension("old").exists());
    }

    #[test]
    fn swap_rolls_the_previous_runtime_back_when_the_second_rename_fails() {
        // Force the `source -> final` rename to fail by removing the source
        // after staging the previous runtime aside: a non-existent source is
        // a rename error, exercising the rollback branch. We drive the swap in
        // two steps to inject the failure between stage and rename, so this
        // stays a host test with no Windows file-locking needed.
        let dir = tempfile::tempdir().unwrap();
        let final_dir = dir.path().join("final");
        std::fs::create_dir_all(&final_dir).unwrap();
        std::fs::write(final_dir.join("node"), b"old").unwrap();
        // A source path that does not exist: `rename(source, final)` fails.
        let missing_source = dir.path().join("missing-source");

        let error = swap_runtime_into_place(&missing_source, &final_dir).unwrap_err();

        assert!(matches!(error, ManagedNodeError::Io(_)), "{error:?}");
        // Rollback restored the previous runtime rather than leaving it staged.
        assert_eq!(std::fs::read(final_dir.join("node")).unwrap(), b"old");
        assert!(!final_dir.with_extension("old").exists());
    }

    #[test]
    fn prune_sweeps_stale_old_dirs_inside_the_kept_version() {
        let root_dir = tempfile::tempdir().unwrap();
        let root = root_dir.path();
        // The kept version dir with a leaked `<platform>.old` staging dir that
        // a prior swap's best-effort cleanup never removed.
        let kept_version = root.join(TEST_VERSION);
        let platform_dir = kept_version.join(TEST_PLATFORM);
        let stale_old = kept_version.join(format!("{TEST_PLATFORM}.old"));
        std::fs::create_dir_all(&platform_dir).unwrap();
        std::fs::create_dir_all(stale_old.join("junk")).unwrap();
        std::fs::write(stale_old.join("junk").join("f"), b"leak").unwrap();
        // A superseded version dir that must be removed wholesale.
        std::fs::create_dir_all(install_dir(root, "v0.0.1", TEST_PLATFORM)).unwrap();

        prune_superseded(root, TEST_VERSION);

        // Kept version and its real platform dir survive.
        assert!(platform_dir.exists());
        // The leaked `.old` inside the kept version is swept.
        assert!(!stale_old.exists());
        // Superseded version is gone.
        assert!(!root.join("v0.0.1").exists());
    }

    /// Drive the platform-parameterized install path directly for the Windows
    /// artifact, bypassing the host's `current_target_triple()` so the
    /// zip/`node.exe` layout is exercised on any CI host. `node.exe` is not
    /// executed here (it is not a real binary on non-Windows CI); the
    /// native-Windows readiness probe is covered by the CI test matrix.
    async fn install_windows_runtime(
        root: &Path,
        base_url: &str,
        lock: &NodeRuntimeLock,
    ) -> Result<(), ManagedNodeError> {
        let artifact = lock
            .artifacts
            .get("x86_64-pc-windows-msvc")
            .expect("windows lock must have the windows artifact");
        let platform = artifact
            .platform(&lock.version)
            .expect("windows filename must parse");
        let plan = InstallPlan {
            root,
            version: &lock.version,
            platform,
            filename: &artifact.filename,
            sha256: &artifact.sha256,
            base_url,
            max_archive_bytes: MAX_ARCHIVE_BYTES,
        };
        install_runtime(&plan, &ignore_progress).await
    }

    // ── Native Windows gate (real pinned ZIP) ───────────────────────────
    //
    // These tests download and execute the real pinned Node runtime. They
    // compile on every host (so the mac/Linux CI lanes type-check them) but
    // only execute on native Windows when opted in via `BERD_WS2_NATIVE_GATE=1`
    // — the native Windows CI gate sets that variable. Off Windows, or
    // without the variable, they skip immediately. They cover the audit's
    // minimum native matrix items 2-3: exact `node.exe --version`, npm
    // execution through the layout's npm command, the fast path, and repair
    // after the installed tree is corrupted — all under a path with a space.

    /// Whether the opt-in native gate should execute on this run: native
    /// Windows plus the explicit opt-in variable.
    fn native_gate_enabled() -> bool {
        cfg!(windows) && std::env::var_os("BERD_WS2_NATIVE_GATE").is_some_and(|value| value == "1")
    }

    #[tokio::test]
    async fn native_gate_installs_and_probes_the_real_pinned_runtime() {
        if !native_gate_enabled() {
            eprintln!(
                "skipping: native Windows gate runs only on Windows with BERD_WS2_NATIVE_GATE=1"
            );
            return;
        }
        // A root under a directory whose name contains a space, matching a real
        // `%LOCALAPPDATA%\Berd\App Data` install path.
        let base = tempfile::tempdir().unwrap();
        let root = base.path().join("App Data").join("packages node");
        std::fs::create_dir_all(&root).unwrap();
        let lock = node_runtime_lock();

        // Fresh install from the pinned upstream distribution; SHA and readiness are enforced
        // inside `ensure_managed_node_runtime_at`.
        ensure_managed_node_runtime_at(
            &root,
            UPSTREAM_NODE_DIST_BASE_URL,
            lock,
            MAX_ARCHIVE_BYTES,
            &ignore_progress,
        )
        .await
        .expect("real pinned Node runtime installs on native Windows");

        let platform = pinned_platform().expect("windows target is pinned");
        let install = install_dir(&root, &lock.version, platform);

        // node.exe runs and reports exactly the pinned version.
        let layout = RuntimeLayout::current().expect("windows layout resolves");
        let node = layout.node_exe(&install);
        let output = tokio::process::Command::new(&node)
            .arg("--version")
            .output()
            .await
            .expect("node.exe --version runs");
        assert!(output.status.success(), "node.exe --version failed");
        assert_eq!(
            String::from_utf8_lossy(&output.stdout).trim(),
            lock.version,
            "node.exe reports the pinned version"
        );

        // npm runs through the layout's Windows-safe command (node.exe +
        // npm-cli.js) and reports a version.
        let npm = layout.npm_command(&install);
        let npm_output = tokio::process::Command::new(&npm.program)
            .args(&npm.leading_args)
            .arg("--version")
            .output()
            .await
            .expect("npm runs through the managed runtime");
        assert!(npm_output.status.success(), "npm --version failed");
        assert!(
            !String::from_utf8_lossy(&npm_output.stdout)
                .trim()
                .is_empty(),
            "npm --version prints a version"
        );

        // Fast path: a second ensure with an unroutable base URL must not
        // download — the ready runtime satisfies the probe.
        ensure_managed_node_runtime_at(
            &root,
            "http://127.0.0.1:1",
            lock,
            MAX_ARCHIVE_BYTES,
            &ignore_progress,
        )
        .await
        .expect("fast path skips download when the runtime is already ready");

        // Repair: corrupt node.exe so the probe fails, then re-install and
        // confirm the runtime is healthy again.
        let overwrite_deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            match std::fs::write(&node, b"corrupt") {
                Ok(()) => break,
                Err(error)
                    if error.raw_os_error() == Some(32)
                        && std::time::Instant::now() < overwrite_deadline =>
                {
                    std::thread::sleep(std::time::Duration::from_millis(50));
                }
                Err(error) => panic!("failed to corrupt node.exe for repair test: {error}"),
            }
        }
        assert!(
            !runtime_ready(&install, &lock.version, platform).await,
            "corrupted node.exe fails the readiness probe"
        );
        ensure_managed_node_runtime_at(
            &root,
            UPSTREAM_NODE_DIST_BASE_URL,
            lock,
            MAX_ARCHIVE_BYTES,
            &ignore_progress,
        )
        .await
        .expect("repair re-installs a healthy runtime");
        assert!(
            runtime_ready(&install, &lock.version, platform).await,
            "runtime is healthy after repair"
        );

        // Repair after npm.cmd loss: PATH-resolved npm users require the
        // shipped batch launcher even though the managed npm command bypasses
        // it. Deletion must make readiness fail and trigger reinstall.
        let npm_cmd = install.join("npm.cmd");
        std::fs::remove_file(&npm_cmd).unwrap();
        assert!(
            !runtime_ready(&install, &lock.version, platform).await,
            "a missing npm.cmd fails the readiness probe even though node.exe is healthy"
        );
        ensure_managed_node_runtime_at(
            &root,
            UPSTREAM_NODE_DIST_BASE_URL,
            lock,
            MAX_ARCHIVE_BYTES,
            &ignore_progress,
        )
        .await
        .expect("repair restores npm.cmd");
        assert!(
            npm_cmd.is_file() && runtime_ready(&install, &lock.version, platform).await,
            "npm.cmd is restored and the runtime is healthy after repair"
        );

        // Repair after npm-cli.js loss: deleting the CLI leaves node.exe
        // healthy but makes every npm run fail. The readiness probe must
        // detect this and re-install repairs the CLI (audit P2).
        let npm_cli = npm_cli_entrypoint(&install, platform)
            .expect("windows layout has an npm CLI entrypoint");
        std::fs::remove_file(&npm_cli).unwrap();
        assert!(
            !runtime_ready(&install, &lock.version, platform).await,
            "a missing npm-cli.js fails the readiness probe even though node.exe is healthy"
        );
        ensure_managed_node_runtime_at(
            &root,
            UPSTREAM_NODE_DIST_BASE_URL,
            lock,
            MAX_ARCHIVE_BYTES,
            &ignore_progress,
        )
        .await
        .expect("repair restores npm-cli.js");
        assert!(
            npm_cli.is_file() && runtime_ready(&install, &lock.version, platform).await,
            "npm-cli.js is restored and the runtime is healthy after repair"
        );
    }
}
