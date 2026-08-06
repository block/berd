//! Berd-managed Node.js runtime.
//!
//! Downloads the Node.js version pinned in `node-runtime.lock.json` (repo
//! root, embedded at compile time; refresh with `just bump-node-runtime`),
//! verifies it against the lock's SHA-256, and atomically installs it under
//! `<app-data>/packages/node/<version>/<platform>/`. The tarball comes from
//! Block's Artifactory `nodejs` repo — a read-through mirror of
//! `https://nodejs.org/dist` — so the lock's hash pin is the trust root, not
//! the mirror; `no-block-npm-registry` builds fetch from nodejs.org directly.

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

const BLOCK_NODE_DIST_BASE_URL: &str = "https://global.block-artifacts.com/artifactory/nodejs";
const UPSTREAM_NODE_DIST_BASE_URL: &str = "https://nodejs.org/dist";

/// Hard cap on the compressed tarball; the largest pinned artifact today is
/// ~49 MB, so anything near this is a wrong or corrupted download.
const MAX_ARCHIVE_BYTES: u64 = 90 * 1024 * 1024;
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
    /// Node's platform string (`darwin-arm64`, …), derived from the tarball
    /// name so the lock stays the single source of truth.
    fn platform<'a>(&'a self, version: &str) -> Option<&'a str> {
        self.filename
            .strip_prefix(format!("node-{version}-").as_str())?
            .strip_suffix(".tar.gz")
    }
}

pub fn node_runtime_lock() -> &'static NodeRuntimeLock {
    static LOCK: OnceLock<NodeRuntimeLock> = OnceLock::new();
    LOCK.get_or_init(|| {
        serde_json::from_str(NODE_RUNTIME_LOCK_JSON)
            .expect("embedded node-runtime.lock.json must parse")
    })
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
    } else {
        None
    }
}

fn node_dist_base_url<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> String {
    app.try_state::<DistroBundleState>()
        .and_then(|state| {
            state
                .distribution_config()
                .map(|config| config.node_dist_base_url().to_string())
        })
        .unwrap_or_else(fallback_node_dist_base_url)
}

fn fallback_node_dist_base_url() -> String {
    if cfg!(feature = "no-block-npm-registry") {
        UPSTREAM_NODE_DIST_BASE_URL.to_string()
    } else {
        BLOCK_NODE_DIST_BASE_URL.to_string()
    }
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
    Some(pinned_install_dir(&managed_node_root(app)?)?.join("bin"))
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
    match pinned_install_dir(root) {
        Some(final_dir) => runtime_ready(&final_dir, &node_runtime_lock().version).await,
        None => false,
    }
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

async fn ensure_managed_node_runtime_at(
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
    if runtime_ready(&final_dir, &lock.version).await {
        return Ok(());
    }

    let _guard = install_serialization_lock().lock().await;
    if runtime_ready(&final_dir, &lock.version).await {
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

    if runtime_ready(&final_dir, &lock.version).await {
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

/// Fast-path readiness probe: the installed `bin/node` runs and reports
/// exactly the pinned version.
async fn runtime_ready(final_dir: &Path, version: &str) -> bool {
    let node = final_dir.join("bin").join("node");
    if !node.is_file() {
        return false;
    }
    let output = tokio::process::Command::new(&node)
        .arg("--version")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .output()
        .await;
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
    let extract_result = {
        let archive_path = archive_path.clone();
        let temp_dir = temp_dir.clone();
        tokio::task::spawn_blocking(move || extract_archive(&archive_path, &temp_dir))
            .await
            .map_err(|error| ManagedNodeError::Io(format!("extract task failed: {error}")))?
    };
    let _ = std::fs::remove_file(&archive_path);
    extract_result?;

    // Node tarballs unpack into a single `node-<version>-<platform>` dir.
    let extracted_dir = temp_dir.join(format!("node-{}-{}", plan.version, plan.platform));
    let source_dir = if extracted_dir.is_dir() {
        extracted_dir
    } else {
        temp_dir.clone()
    };
    verify_runtime_tree(&source_dir)?;

    progress(ManagedNodeProgress::Installing);
    let old_dir = final_dir.with_extension("old");
    if old_dir.exists() {
        std::fs::remove_dir_all(&old_dir)
            .map_err(|error| ManagedNodeError::Io(format!("remove stale old dir: {error}")))?;
    }
    if final_dir.exists() {
        std::fs::rename(&final_dir, &old_dir)
            .map_err(|error| ManagedNodeError::Io(format!("stage previous runtime: {error}")))?;
    }
    if let Err(error) = std::fs::rename(&source_dir, &final_dir) {
        if old_dir.exists() {
            let _ = std::fs::rename(&old_dir, &final_dir);
        }
        return Err(ManagedNodeError::Io(format!(
            "install Node.js runtime: {error}"
        )));
    }
    let _ = std::fs::remove_dir_all(&old_dir);
    let _ = std::fs::remove_dir_all(&temp_dir);
    // Superseded version dirs are deliberately NOT pruned here: bridge shims
    // exec the absolute path of the Node version they were installed against,
    // so the old runtime must survive until every shim has been rewritten
    // onto this one. The reconcile epilogue prunes via
    // `prune_superseded_node_runtimes` once every bridge install succeeded.
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

fn extract_archive(archive_path: &Path, dest_dir: &Path) -> Result<(), ManagedNodeError> {
    // Two passes over the (seekable) file: validate every entry path before a
    // single byte is written, then unpack.
    let file = std::fs::File::open(archive_path)
        .map_err(|error| ManagedNodeError::Io(format!("open archive: {error}")))?;
    let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(file));
    validate_archive_entries(&mut archive)?;

    let file = std::fs::File::open(archive_path)
        .map_err(|error| ManagedNodeError::Io(format!("open archive for extraction: {error}")))?;
    let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(file));
    archive
        .unpack(dest_dir)
        .map_err(|error| ManagedNodeError::Io(format!("extract archive: {error}")))
}

fn validate_archive_entries<R: std::io::Read>(
    archive: &mut tar::Archive<R>,
) -> Result<(), ManagedNodeError> {
    let entries = archive
        .entries()
        .map_err(|error| ManagedNodeError::Io(format!("read archive entries: {error}")))?;
    for entry in entries {
        let entry =
            entry.map_err(|error| ManagedNodeError::Io(format!("read archive entry: {error}")))?;
        let path = entry
            .path()
            .map_err(|error| ManagedNodeError::Io(format!("read archive entry path: {error}")))?;
        if path.is_absolute()
            || path
                .components()
                .any(|component| matches!(component, std::path::Component::ParentDir))
        {
            return Err(ManagedNodeError::UnsafeArchiveEntry(
                path.to_string_lossy().into_owned(),
            ));
        }
    }
    Ok(())
}

fn verify_runtime_tree(dir: &Path) -> Result<(), ManagedNodeError> {
    for binary in ["node", "npm"] {
        if !dir.join("bin").join(binary).is_file() {
            return Err(ManagedNodeError::IncompleteRuntime(format!(
                "archive is missing bin/{binary}"
            )));
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

    fn write_ready_runtime(root: &Path, version: &str) {
        use std::os::unix::fs::PermissionsExt;
        let bin = install_dir(root, version, TEST_PLATFORM).join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let node = bin.join("node");
        std::fs::write(&node, node_script(version)).unwrap();
        std::fs::set_permissions(&node, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::fs::write(bin.join("npm"), "").unwrap();
    }

    #[test]
    fn embedded_lock_pins_every_release_target() {
        let lock = node_runtime_lock();
        assert!(lock.version.starts_with('v'), "version: {}", lock.version);
        for target in [
            "aarch64-apple-darwin",
            "x86_64-apple-darwin",
            "aarch64-unknown-linux-gnu",
            "x86_64-unknown-linux-gnu",
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
    fn base_url_follows_registry_feature() {
        if cfg!(feature = "no-block-npm-registry") {
            assert_eq!(fallback_node_dist_base_url(), UPSTREAM_NODE_DIST_BASE_URL);
        } else {
            assert_eq!(fallback_node_dist_base_url(), BLOCK_NODE_DIST_BASE_URL);
        }
    }

    #[test]
    fn archive_validation_rejects_traversal_and_absolute_paths() {
        for name in ["../evil.sh", "/abs/evil.sh"] {
            let mut archive = tar::Archive::new(std::io::Cursor::new(raw_entry_tar(name)));
            let error = validate_archive_entries(&mut archive).unwrap_err();
            assert!(
                matches!(error, ManagedNodeError::UnsafeArchiveEntry(_)),
                "{name}: {error}"
            );
        }
    }

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

    #[tokio::test]
    async fn pinned_runtime_ready_probes_the_embedded_pin() {
        let root_dir = tempfile::tempdir().unwrap();
        let root = root_dir.path();
        assert!(!pinned_runtime_ready(root).await);

        // A runtime matching the real embedded pin at the pinned install dir.
        use std::os::unix::fs::PermissionsExt;
        let bin = pinned_install_dir(root).unwrap().join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let node = bin.join("node");
        std::fs::write(&node, node_script(&node_runtime_lock().version)).unwrap();
        std::fs::set_permissions(&node, std::fs::Permissions::from_mode(0o755)).unwrap();
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

    #[tokio::test]
    async fn readiness_probe_requires_exact_pinned_version() {
        let root_dir = tempfile::tempdir().unwrap();
        let root = root_dir.path();
        let final_dir = install_dir(root, TEST_VERSION, TEST_PLATFORM);
        assert!(!runtime_ready(&final_dir, TEST_VERSION).await);

        write_ready_runtime(root, TEST_VERSION);
        assert!(runtime_ready(&final_dir, TEST_VERSION).await);
        assert!(!runtime_ready(&final_dir, "v9.9.8").await);
    }
}
