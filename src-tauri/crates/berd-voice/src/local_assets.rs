//! Shared local-model roots, cross-process coordination, and installation helpers.

use fs2::FileExt;
use futures_util::StreamExt;
use sha2::{Digest, Sha256};
use std::fmt;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::time::Duration;

const LOCK_FILE: &str = ".berd-voice-assets.lock";
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const READ_TIMEOUT: Duration = Duration::from_secs(30);
const TOTAL_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const MUTATION_LOCK_TIMEOUT: Duration = Duration::from_secs(15);
const MUTATION_LOCK_RETRY: Duration = Duration::from_millis(20);

/// The two exact bundle roots in one host-selected local-model store.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LocalAssetRoots {
    coordination_root: PathBuf,
    pocket_bundle_root: PathBuf,
    parakeet_bundle_root: PathBuf,
}

impl LocalAssetRoots {
    /// Define the current closed Pocket/Parakeet store layout.
    pub fn new(
        coordination_root: impl Into<PathBuf>,
        pocket_bundle_root: impl Into<PathBuf>,
        parakeet_bundle_root: impl Into<PathBuf>,
    ) -> Result<Self, LocalAssetLockError> {
        let roots = Self {
            coordination_root: coordination_root.into(),
            pocket_bundle_root: pocket_bundle_root.into(),
            parakeet_bundle_root: parakeet_bundle_root.into(),
        };
        for root in [
            &roots.coordination_root,
            &roots.pocket_bundle_root,
            &roots.parakeet_bundle_root,
        ] {
            validate_root(root)?;
        }
        if roots.parakeet_bundle_root != roots.pocket_bundle_root.join("stt") {
            return Err(LocalAssetLockError::InvalidRoot(
                "the Parakeet bundle root must be the Pocket bundle root's stt directory"
                    .to_string(),
            ));
        }
        if roots.pocket_bundle_root.parent() != Some(roots.coordination_root.as_path()) {
            return Err(LocalAssetLockError::InvalidRoot(
                "the Pocket bundle root must be an immediate child of the coordination root"
                    .to_string(),
            ));
        }
        Ok(roots)
    }

    pub fn coordination_root(&self) -> &Path {
        &self.coordination_root
    }

    pub fn pocket_bundle_root(&self) -> &Path {
        &self.pocket_bundle_root
    }

    pub fn parakeet_bundle_root(&self) -> &Path {
        &self.parakeet_bundle_root
    }
}

/// Error acquiring the store's advisory process lock.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LocalAssetLockError {
    Busy,
    InvalidRoot(String),
    Io(String),
}

impl fmt::Display for LocalAssetLockError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Busy => write!(
                formatter,
                "another local voice asset mutation is in progress"
            ),
            Self::InvalidRoot(message) | Self::Io(message) => formatter.write_str(message),
        }
    }
}

/// Shared reader guard. Model construction holds this across bundle loading.
pub struct LocalAssetReadGuard {
    _file: File,
}

/// Exclusive mutation guard. Install and host-owned removal use the same lock.
pub struct LocalAssetMutationGuard {
    _file: File,
    roots: LocalAssetRoots,
}

impl LocalAssetMutationGuard {
    /// Recover one unambiguous interrupted publication while this guard owns
    /// the store's exclusive process lock.
    pub fn recover_interrupted_publication(&self) -> Result<(), LocalInstallError> {
        recover_interrupted_publication_with(&self.roots, combined_tree_has_ready_engine)
    }

    pub(crate) fn roots(&self) -> &LocalAssetRoots {
        &self.roots
    }

    pub(crate) fn validate_staging_paths(
        &self,
        source: &Path,
        expected_source: &Path,
        destination: &Path,
    ) -> Result<(), LocalInstallError> {
        validate_root(destination).map_err(LocalInstallError::from)?;
        let coordination_root = self.roots.coordination_root();
        let live_root = self.roots.pocket_bundle_root();
        if source != expected_source
            || destination == coordination_root
            || !destination.starts_with(coordination_root)
            || destination.starts_with(live_root)
        {
            return Err(LocalInstallError::new(
                LocalInstallErrorKind::InvalidRoot,
                "staging paths do not belong to the locked local asset store",
            ));
        }
        Ok(())
    }
}

pub fn try_lock_for_read(
    roots: &LocalAssetRoots,
) -> Result<LocalAssetReadGuard, LocalAssetLockError> {
    let file = open_lock(roots)?;
    match FileExt::try_lock_shared(&file) {
        Ok(()) => Ok(LocalAssetReadGuard { _file: file }),
        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
            Err(LocalAssetLockError::Busy)
        }
        Err(error) => Err(LocalAssetLockError::Io(format!(
            "lock local voice assets for reading: {error}"
        ))),
    }
}

pub fn try_lock_for_mutation(
    roots: &LocalAssetRoots,
) -> Result<LocalAssetMutationGuard, LocalAssetLockError> {
    let file = open_lock(roots)?;
    match FileExt::try_lock_exclusive(&file) {
        Ok(()) => Ok(LocalAssetMutationGuard {
            _file: file,
            roots: roots.clone(),
        }),
        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
            Err(LocalAssetLockError::Busy)
        }
        Err(error) => Err(LocalAssetLockError::Io(format!(
            "lock local voice assets for mutation: {error}"
        ))),
    }
}

/// Wait for the short publication transaction lock without discarding a
/// completed download because a reader happened to be constructing a model.
pub async fn lock_for_mutation(
    roots: &LocalAssetRoots,
) -> Result<LocalAssetMutationGuard, LocalAssetLockError> {
    let deadline = tokio::time::Instant::now() + MUTATION_LOCK_TIMEOUT;
    loop {
        match try_lock_for_mutation(roots) {
            Ok(guard) => return Ok(guard),
            Err(LocalAssetLockError::Busy) if tokio::time::Instant::now() < deadline => {
                tokio::time::sleep(MUTATION_LOCK_RETRY).await;
            }
            result => return result,
        }
    }
}

/// Blocking counterpart for host mutations already running on a blocking
/// worker. Readers remain fail-fast.
pub fn lock_for_mutation_blocking(
    roots: &LocalAssetRoots,
) -> Result<LocalAssetMutationGuard, LocalAssetLockError> {
    let deadline = std::time::Instant::now() + MUTATION_LOCK_TIMEOUT;
    loop {
        match try_lock_for_mutation(roots) {
            Ok(guard) => return Ok(guard),
            Err(LocalAssetLockError::Busy) if std::time::Instant::now() < deadline => {
                std::thread::sleep(MUTATION_LOCK_RETRY);
            }
            result => return result,
        }
    }
}

fn recover_interrupted_publication_with(
    roots: &LocalAssetRoots,
    is_valid: impl Fn(&Path) -> bool,
) -> Result<(), LocalInstallError> {
    let entries = fs::read_dir(roots.coordination_root()).map_err(|error| {
        LocalInstallError::new(
            LocalInstallErrorKind::Recovery,
            format!("inspect local voice asset recovery state: {error}"),
        )
    })?;
    let mut backups = Vec::new();
    for entry in entries {
        let path = entry
            .map_err(|error| {
                LocalInstallError::new(
                    LocalInstallErrorKind::Recovery,
                    format!("read local voice asset recovery entry: {error}"),
                )
            })?
            .path();
        if path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with(".voice-backup-"))
        {
            backups.push(path);
        }
    }
    backups.sort();
    if backups.is_empty() {
        return Ok(());
    }
    let final_root = roots.pocket_bundle_root();
    let final_valid = final_root.exists() && is_valid(final_root);
    if final_valid {
        for backup in backups {
            fs::remove_dir_all(&backup).map_err(|error| {
                let mut failure = LocalInstallError::new(
                    LocalInstallErrorKind::Cleanup,
                    format!("remove stale local voice asset backup: {error}"),
                );
                failure.recovery_paths.push(backup);
                failure
            })?;
        }
        return Ok(());
    }
    if final_root.exists() || backups.len() != 1 || !is_valid(&backups[0]) {
        let mut failure = LocalInstallError::new(
            LocalInstallErrorKind::Recovery,
            "local voice asset recovery state is ambiguous or invalid",
        );
        if final_root.exists() {
            failure.recovery_paths.push(final_root.to_path_buf());
        }
        failure.recovery_paths.extend(backups);
        return Err(failure);
    }
    fs::rename(&backups[0], final_root).map_err(|error| {
        let mut failure = LocalInstallError::new(
            LocalInstallErrorKind::Recovery,
            format!("restore interrupted local voice asset publication: {error}"),
        );
        failure.recovery_paths.push(backups[0].clone());
        failure
    })
}

fn combined_tree_has_ready_engine(root: &Path) -> bool {
    matches!(
        crate::pocket_assets::inspect(root),
        Ok(crate::pocket_assets::PocketAssetStatus::Ready { .. })
    ) || matches!(
        crate::parakeet_assets::inspect(&root.join("stt")),
        Ok(crate::parakeet_assets::ParakeetAssetStatus::Ready { .. })
    )
}

fn open_lock(roots: &LocalAssetRoots) -> Result<File, LocalAssetLockError> {
    fs::create_dir_all(&roots.coordination_root).map_err(|error| {
        LocalAssetLockError::Io(format!(
            "create local voice asset coordination root: {error}"
        ))
    })?;
    OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(roots.coordination_root.join(LOCK_FILE))
        .map_err(|error| LocalAssetLockError::Io(format!("open local asset lock: {error}")))
}

fn validate_root(root: &Path) -> Result<(), LocalAssetLockError> {
    if !root.is_absolute() {
        return Err(LocalAssetLockError::InvalidRoot(
            "local voice asset roots must be absolute".to_string(),
        ));
    }
    if root
        .components()
        .any(|component| matches!(component, Component::ParentDir | Component::CurDir))
    {
        return Err(LocalAssetLockError::InvalidRoot(
            "local voice asset roots must not contain traversal components".to_string(),
        ));
    }
    Ok(())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LocalInstallErrorKind {
    Busy,
    InvalidRoot,
    Download,
    Integrity,
    Extraction,
    Io,
    Publish,
    Rollback,
    Recovery,
    Cleanup,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LocalInstallPhase {
    Downloading,
    Extracting,
    Verifying,
    Publishing,
    Complete,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LocalInstallProgress {
    pub phase: LocalInstallPhase,
    pub downloaded_bytes: u64,
    pub total_download_bytes: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LocalInstallError {
    pub kind: LocalInstallErrorKind,
    pub message: String,
    pub recovery_paths: Vec<PathBuf>,
}

impl LocalInstallError {
    pub(crate) fn new(kind: LocalInstallErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
            recovery_paths: Vec::new(),
        }
    }
}

impl fmt::Display for LocalInstallError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl From<LocalAssetLockError> for LocalInstallError {
    fn from(error: LocalAssetLockError) -> Self {
        match error {
            LocalAssetLockError::Busy => Self::new(LocalInstallErrorKind::Busy, error.to_string()),
            LocalAssetLockError::InvalidRoot(message) => {
                Self::new(LocalInstallErrorKind::InvalidRoot, message)
            }
            LocalAssetLockError::Io(message) => Self::new(LocalInstallErrorKind::Io, message),
        }
    }
}

#[derive(Clone, Copy)]
pub(crate) struct DownloadSpec<'a> {
    pub source_url: &'a str,
    pub relative_path: &'a str,
    pub size_bytes: u64,
    pub sha256: &'a str,
}

pub(crate) fn inspect_download_specs(
    root: &Path,
    specs: &[DownloadSpec<'static>],
) -> Result<crate::asset_verification::AssetInspection, String> {
    let manifest = specs
        .iter()
        .map(|spec| crate::asset_verification::PinnedAsset {
            relative_path: spec.relative_path,
            size_bytes: spec.size_bytes,
            sha256: spec.sha256,
        })
        .collect::<Vec<_>>();
    crate::asset_verification::inspect_assets(root, &manifest)
}

pub(crate) struct TemporaryDirectory {
    path: PathBuf,
    keep: bool,
}

impl TemporaryDirectory {
    pub(crate) fn create(parent: &Path, label: &str) -> Result<Self, LocalInstallError> {
        fs::create_dir_all(parent).map_err(|error| {
            LocalInstallError::new(
                LocalInstallErrorKind::Io,
                format!("create local voice asset root: {error}"),
            )
        })?;
        let path = parent.join(format!(".{label}-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&path).map_err(|error| {
            LocalInstallError::new(
                LocalInstallErrorKind::Io,
                format!("create local voice asset temporary directory: {error}"),
            )
        })?;
        Ok(Self { path, keep: false })
    }

    pub(crate) fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TemporaryDirectory {
    fn drop(&mut self) {
        if !self.keep {
            let _ = fs::remove_dir_all(&self.path);
        }
    }
}

pub(crate) struct CombinedPublication {
    final_root: PathBuf,
    staging: TemporaryDirectory,
    backup_root: PathBuf,
}

impl CombinedPublication {
    pub(crate) fn prepare(roots: &LocalAssetRoots) -> Result<Self, LocalInstallError> {
        let staging = TemporaryDirectory::create(roots.coordination_root(), "voice-stage")?;
        let backup_root = roots
            .coordination_root()
            .join(format!(".voice-backup-{}", uuid::Uuid::new_v4()));
        Ok(Self {
            final_root: roots.pocket_bundle_root().to_path_buf(),
            staging,
            backup_root,
        })
    }

    pub(crate) fn root(&self) -> &Path {
        self.staging.path()
    }

    pub(crate) fn publish(
        mut self,
        verify: impl Fn(&Path) -> bool,
    ) -> Result<Option<PathBuf>, LocalInstallError> {
        let had_previous = self.final_root.exists();
        if had_previous {
            fs::rename(&self.final_root, &self.backup_root).map_err(|error| {
                LocalInstallError::new(
                    LocalInstallErrorKind::Publish,
                    format!("retire prior local voice asset bundle: {error}"),
                )
            })?;
        }
        if let Err(error) = fs::rename(self.staging.path(), &self.final_root) {
            if had_previous {
                if let Err(rollback_error) = fs::rename(&self.backup_root, &self.final_root) {
                    let mut failure = LocalInstallError::new(
                        LocalInstallErrorKind::Rollback,
                        format!(
                            "publish local voice asset bundle failed ({error}); restoring the prior bundle also failed: {rollback_error}"
                        ),
                    );
                    failure.recovery_paths.push(self.backup_root.clone());
                    failure
                        .recovery_paths
                        .push(self.staging.path().to_path_buf());
                    self.staging.keep = true;
                    return Err(failure);
                }
            }
            return Err(LocalInstallError::new(
                LocalInstallErrorKind::Publish,
                format!("publish local voice asset bundle: {error}"),
            ));
        }
        self.staging.keep = true;
        if !verify(&self.final_root) {
            let failed_root = self
                .final_root
                .with_file_name(format!(".voice-failed-{}", uuid::Uuid::new_v4()));
            if let Err(error) = fs::rename(&self.final_root, &failed_root) {
                let mut failure = LocalInstallError::new(
                    LocalInstallErrorKind::Rollback,
                    format!("preserve invalid published local voice asset bundle: {error}"),
                );
                failure.recovery_paths.push(self.final_root.clone());
                if had_previous {
                    failure.recovery_paths.push(self.backup_root.clone());
                }
                return Err(failure);
            }
            if had_previous {
                if let Err(error) = fs::rename(&self.backup_root, &self.final_root) {
                    let mut failure = LocalInstallError::new(
                        LocalInstallErrorKind::Rollback,
                        format!("restore prior local voice asset bundle: {error}"),
                    );
                    failure.recovery_paths.push(self.backup_root.clone());
                    failure.recovery_paths.push(failed_root);
                    return Err(failure);
                }
            }
            if let Err(error) = fs::remove_dir_all(&failed_root) {
                let mut failure = LocalInstallError::new(
                    LocalInstallErrorKind::Cleanup,
                    format!("remove failed local voice asset publication: {error}"),
                );
                failure.recovery_paths.push(failed_root);
                return Err(failure);
            }
            return Err(LocalInstallError::new(
                LocalInstallErrorKind::Integrity,
                "published local voice asset bundle failed verification",
            ));
        }
        if had_previous && fs::remove_dir_all(&self.backup_root).is_err() {
            // The new verified tree is authoritative. Preserve the cleanup
            // evidence without turning an applied install into a failure;
            // the next locked recovery preflight retries stale cleanup.
            return Ok(Some(self.backup_root));
        }
        Ok(None)
    }
}

pub(crate) fn copy_exact_files(
    source: &Path,
    destination: &Path,
    files: impl IntoIterator<Item = (&'static str, u64, &'static str)>,
) -> Result<(), LocalInstallError> {
    for (relative, size, hash) in files {
        let source = source.join(relative);
        let metadata = fs::symlink_metadata(&source).map_err(|error| {
            LocalInstallError::new(
                LocalInstallErrorKind::Integrity,
                format!("inspect retained local voice asset: {error}"),
            )
        })?;
        if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() != size {
            return Err(LocalInstallError::new(
                LocalInstallErrorKind::Integrity,
                "retained local voice asset is not a pinned regular file",
            ));
        }
        let destination = destination.join(relative);
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent).map_err(|error| {
                LocalInstallError::new(
                    LocalInstallErrorKind::Io,
                    format!("create staged local voice asset directory: {error}"),
                )
            })?;
        }
        fs::copy(&source, &destination).map_err(|error| {
            LocalInstallError::new(
                LocalInstallErrorKind::Io,
                format!("copy retained local voice asset: {error}"),
            )
        })?;
        let mut file = File::open(&destination).map_err(|error| {
            LocalInstallError::new(
                LocalInstallErrorKind::Io,
                format!("open staged local voice asset: {error}"),
            )
        })?;
        let mut hasher = Sha256::new();
        std::io::copy(&mut file, &mut hasher).map_err(|error| {
            LocalInstallError::new(
                LocalInstallErrorKind::Io,
                format!("hash staged local voice asset: {error}"),
            )
        })?;
        if format!("{:x}", hasher.finalize()) != hash {
            return Err(LocalInstallError::new(
                LocalInstallErrorKind::Integrity,
                "retained local voice asset checksum changed while staging",
            ));
        }
    }
    Ok(())
}

pub(crate) fn default_client() -> Result<reqwest::Client, LocalInstallError> {
    reqwest::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .read_timeout(READ_TIMEOUT)
        .timeout(TOTAL_TIMEOUT)
        .build()
        .map_err(|error| {
            LocalInstallError::new(
                LocalInstallErrorKind::Download,
                format!("create local voice asset download client: {error}"),
            )
        })
}

pub(crate) async fn download(
    client: &reqwest::Client,
    root: &Path,
    spec: DownloadSpec<'_>,
    mut on_chunk: impl FnMut(u64),
) -> Result<(), LocalInstallError> {
    let destination = root.join(spec.relative_path);
    if let Some(parent) = destination.parent() {
        tokio::fs::create_dir_all(parent).await.map_err(|error| {
            LocalInstallError::new(
                LocalInstallErrorKind::Io,
                format!("create local voice asset directory: {error}"),
            )
        })?;
    }
    let response = client
        .get(spec.source_url)
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
        .map_err(|error| {
            LocalInstallError::new(
                LocalInstallErrorKind::Download,
                format!("download local voice asset: {error}"),
            )
        })?;
    let mut file = tokio::fs::File::create(destination)
        .await
        .map_err(|error| {
            LocalInstallError::new(
                LocalInstallErrorKind::Io,
                format!("create local voice asset file: {error}"),
            )
        })?;
    let mut stream = response.bytes_stream();
    let mut size = 0_u64;
    let mut hasher = Sha256::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| {
            LocalInstallError::new(
                LocalInstallErrorKind::Download,
                format!("read local voice asset response: {error}"),
            )
        })?;
        size = size.checked_add(chunk.len() as u64).ok_or_else(|| {
            LocalInstallError::new(
                LocalInstallErrorKind::Integrity,
                "local voice asset size overflow",
            )
        })?;
        if size > spec.size_bytes {
            return Err(LocalInstallError::new(
                LocalInstallErrorKind::Integrity,
                "local voice asset exceeded its pinned size",
            ));
        }
        hasher.update(&chunk);
        tokio::io::AsyncWriteExt::write_all(&mut file, &chunk)
            .await
            .map_err(|error| {
                LocalInstallError::new(
                    LocalInstallErrorKind::Io,
                    format!("write local voice asset: {error}"),
                )
            })?;
        on_chunk(chunk.len() as u64);
    }
    tokio::io::AsyncWriteExt::flush(&mut file)
        .await
        .map_err(|error| {
            LocalInstallError::new(
                LocalInstallErrorKind::Io,
                format!("flush local voice asset: {error}"),
            )
        })?;
    if size != spec.size_bytes || format!("{:x}", hasher.finalize()) != spec.sha256 {
        return Err(LocalInstallError::new(
            LocalInstallErrorKind::Integrity,
            "local voice asset did not match its pinned size and checksum",
        ));
    }
    Ok(())
}

pub(crate) fn extract_exact_tar_bz2(
    archive_path: &Path,
    destination: &Path,
    archive_directory: &str,
    expected: &[(&str, u64, &str)],
) -> Result<(), LocalInstallError> {
    let archive = File::open(archive_path).map_err(|error| {
        LocalInstallError::new(
            LocalInstallErrorKind::Extraction,
            format!("open local voice asset archive: {error}"),
        )
    })?;
    let decoder = bzip2::read::BzDecoder::new(archive);
    let mut archive = tar::Archive::new(decoder);
    let mut remaining = expected.to_vec();
    for entry in archive.entries().map_err(|error| {
        LocalInstallError::new(
            LocalInstallErrorKind::Extraction,
            format!("read local voice asset archive: {error}"),
        )
    })? {
        let mut entry = entry.map_err(|error| {
            LocalInstallError::new(
                LocalInstallErrorKind::Extraction,
                format!("read local voice asset archive entry: {error}"),
            )
        })?;
        if !entry.header().entry_type().is_file() {
            continue;
        }
        let path = entry.path().map_err(|error| {
            LocalInstallError::new(
                LocalInstallErrorKind::Extraction,
                format!("read local voice asset archive path: {error}"),
            )
        })?;
        let Some(relative) = path
            .strip_prefix(archive_directory)
            .ok()
            .and_then(|path| path.to_str())
        else {
            continue;
        };
        let Some(index) = remaining.iter().position(|(path, _, _)| *path == relative) else {
            continue;
        };
        let (_, expected_size, expected_hash) = remaining.remove(index);
        let target = destination.join(relative);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|error| {
                LocalInstallError::new(
                    LocalInstallErrorKind::Extraction,
                    format!("create extracted local voice asset directory: {error}"),
                )
            })?;
        }
        let mut output = File::create(target).map_err(|error| {
            LocalInstallError::new(
                LocalInstallErrorKind::Extraction,
                format!("create extracted local voice asset: {error}"),
            )
        })?;
        let mut hasher = Sha256::new();
        let mut size = 0_u64;
        let mut buffer = [0_u8; 64 * 1024];
        loop {
            let read = entry.read(&mut buffer).map_err(|error| {
                LocalInstallError::new(
                    LocalInstallErrorKind::Extraction,
                    format!("read extracted local voice asset: {error}"),
                )
            })?;
            if read == 0 {
                break;
            }
            size = size.checked_add(read as u64).ok_or_else(|| {
                LocalInstallError::new(
                    LocalInstallErrorKind::Integrity,
                    "extracted local voice asset size overflow",
                )
            })?;
            if size > expected_size {
                return Err(LocalInstallError::new(
                    LocalInstallErrorKind::Integrity,
                    "extracted local voice asset exceeded its pinned size",
                ));
            }
            hasher.update(&buffer[..read]);
            output.write_all(&buffer[..read]).map_err(|error| {
                LocalInstallError::new(
                    LocalInstallErrorKind::Extraction,
                    format!("write extracted local voice asset: {error}"),
                )
            })?;
        }
        if size != expected_size || format!("{:x}", hasher.finalize()) != expected_hash {
            return Err(LocalInstallError::new(
                LocalInstallErrorKind::Integrity,
                "extracted local voice asset did not match its pinned size and checksum",
            ));
        }
    }
    if !remaining.is_empty() {
        return Err(LocalInstallError::new(
            LocalInstallErrorKind::Integrity,
            "local voice asset archive omitted a pinned file",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        recover_interrupted_publication_with, try_lock_for_mutation, try_lock_for_read,
        CombinedPublication, DownloadSpec, LocalAssetLockError, LocalAssetRoots,
        LocalInstallErrorKind,
    };
    use sha2::{Digest, Sha256};
    use std::fs;
    use std::process::Command;
    use std::time::Duration;
    use tokio::io::AsyncWriteExt;

    fn roots(parent: &std::path::Path) -> LocalAssetRoots {
        LocalAssetRoots::new(
            parent,
            parent.join("native-voice-v2"),
            parent.join("native-voice-v2/stt"),
        )
        .expect("asset roots")
    }

    #[test]
    fn process_lock_excludes_readers_and_mutators_until_release() {
        if let Ok(path) = std::env::var("BERD_ASSET_LOCK_CHILD") {
            let roots = roots(std::path::Path::new(&path));
            assert!(matches!(
                try_lock_for_mutation(&roots),
                Err(LocalAssetLockError::Busy)
            ));
            return;
        }
        let root = tempfile::tempdir().expect("temporary directory");
        let roots = roots(root.path());
        let first = try_lock_for_mutation(&roots).expect("first mutation lock");
        assert!(matches!(
            try_lock_for_mutation(&roots),
            Err(LocalAssetLockError::Busy)
        ));
        assert!(matches!(
            try_lock_for_read(&roots),
            Err(LocalAssetLockError::Busy)
        ));
        let child = Command::new(std::env::current_exe().expect("current test executable"))
            .args([
                "--exact",
                "local_assets::tests::process_lock_excludes_readers_and_mutators_until_release",
                "--nocapture",
            ])
            .env("BERD_ASSET_LOCK_CHILD", root.path())
            .status()
            .expect("run lock contender process");
        assert!(child.success());
        drop(first);
        try_lock_for_read(&roots).expect("read lock after release");
    }

    #[test]
    fn mutation_processes_serialize_and_recheck_after_the_lock() {
        if let Ok(path) = std::env::var("BERD_ASSET_SERIAL_CHILD") {
            let roots = roots(std::path::Path::new(&path));
            let _mutation =
                super::lock_for_mutation_blocking(&roots).expect("wait for preceding mutation");
            assert_eq!(
                fs::read(roots.pocket_bundle_root().join("winner"))
                    .expect("recheck preceding publication"),
                b"first"
            );
            fs::write(roots.coordination_root().join("second-observed"), b"yes")
                .expect("record second mutation");
            return;
        }
        let root = tempfile::tempdir().expect("temporary directory");
        let roots = roots(root.path());
        let first = try_lock_for_mutation(&roots).expect("first mutation lock");
        let mut child = Command::new(std::env::current_exe().expect("current test executable"))
            .args([
                "--exact",
                "local_assets::tests::mutation_processes_serialize_and_recheck_after_the_lock",
                "--nocapture",
            ])
            .env("BERD_ASSET_SERIAL_CHILD", root.path())
            .spawn()
            .expect("spawn second mutation process");
        std::thread::sleep(Duration::from_millis(50));
        fs::create_dir_all(roots.pocket_bundle_root()).expect("create first publication");
        fs::write(roots.pocket_bundle_root().join("winner"), b"first")
            .expect("write first publication");
        drop(first);
        assert!(child.wait().expect("wait for second process").success());
        assert!(roots.coordination_root().join("second-observed").is_file());
    }

    #[test]
    fn next_process_recovers_the_single_valid_interrupted_backup() {
        if let Ok(path) = std::env::var("BERD_ASSET_CRASH_CHILD") {
            let roots = roots(std::path::Path::new(&path));
            let _mutation = try_lock_for_mutation(&roots).expect("child mutation lock");
            fs::create_dir_all(roots.pocket_bundle_root()).expect("create live tree");
            fs::write(roots.pocket_bundle_root().join("valid"), b"yes").expect("write fixture");
            fs::rename(
                roots.pocket_bundle_root(),
                roots.coordination_root().join(".voice-backup-crashed"),
            )
            .expect("inject exit between publication renames");
            return;
        }
        let root = tempfile::tempdir().expect("temporary directory");
        let child = Command::new(std::env::current_exe().expect("current test executable"))
            .args([
                "--exact",
                "local_assets::tests::next_process_recovers_the_single_valid_interrupted_backup",
                "--nocapture",
            ])
            .env("BERD_ASSET_CRASH_CHILD", root.path())
            .status()
            .expect("run interrupted publisher process");
        assert!(child.success());

        let roots = roots(root.path());
        let _mutation = try_lock_for_mutation(&roots).expect("mutation lock");
        recover_interrupted_publication_with(&roots, |candidate| candidate.join("valid").is_file())
            .expect("recover interrupted publication");
        assert_eq!(
            fs::read(roots.pocket_bundle_root().join("valid")).expect("restored fixture"),
            b"yes"
        );
        assert!(!roots
            .coordination_root()
            .join(".voice-backup-crashed")
            .exists());
    }

    #[test]
    fn failed_final_verification_restores_the_previous_tree() {
        let root = tempfile::tempdir().expect("temporary directory");
        let roots = roots(root.path());
        fs::create_dir(roots.pocket_bundle_root()).expect("create old bundle");
        fs::write(roots.pocket_bundle_root().join("old"), b"old").expect("old bundle");
        let publication = CombinedPublication::prepare(&roots).expect("publication");
        fs::write(publication.root().join("new"), b"new").expect("new bundle");
        let error = publication
            .publish(|_| false)
            .expect_err("verification failure");
        assert_eq!(error.kind, LocalInstallErrorKind::Integrity);
        assert_eq!(
            fs::read(roots.pocket_bundle_root().join("old")).expect("restored old bundle"),
            b"old"
        );
        assert!(!roots.pocket_bundle_root().join("new").exists());
    }

    #[test]
    fn combined_publication_preserves_each_counterpart_direction() {
        for target in ["pocket", "parakeet"] {
            let root = tempfile::tempdir().expect("temporary directory");
            let roots = roots(root.path());
            fs::create_dir_all(roots.parakeet_bundle_root()).expect("create combined bundle");
            fs::write(roots.pocket_bundle_root().join("pocket"), b"old-pocket")
                .expect("write Pocket counterpart");
            fs::write(
                roots.parakeet_bundle_root().join("parakeet"),
                b"old-parakeet",
            )
            .expect("write Parakeet counterpart");
            let publication = CombinedPublication::prepare(&roots).expect("publication");
            fs::create_dir_all(publication.root().join("stt")).expect("create stage");
            let pocket = if target == "pocket" {
                b"new-pocket"
            } else {
                b"old-pocket"
            };
            let parakeet = if target == "parakeet" {
                b"new-parakeet"
            } else {
                b"old-parakeet"
            };
            fs::write(publication.root().join("pocket"), pocket).expect("stage Pocket");
            fs::write(publication.root().join("stt/parakeet"), parakeet).expect("stage Parakeet");
            publication
                .publish(|candidate| {
                    candidate.join("pocket").is_file() && candidate.join("stt/parakeet").is_file()
                })
                .expect("publish combined bundle");
            assert_eq!(
                fs::read(roots.pocket_bundle_root().join("pocket")).expect("Pocket final"),
                pocket
            );
            assert_eq!(
                fs::read(roots.parakeet_bundle_root().join("parakeet")).expect("Parakeet final"),
                parakeet
            );
        }
    }

    #[test]
    fn failed_final_verification_reports_rollback_failure_and_preserves_evidence() {
        let root = tempfile::tempdir().expect("temporary directory");
        let roots = roots(root.path());
        fs::create_dir(roots.pocket_bundle_root()).expect("create old bundle");
        fs::write(roots.pocket_bundle_root().join("old"), b"old").expect("old bundle");
        let publication = CombinedPublication::prepare(&roots).expect("publication");
        fs::write(publication.root().join("new"), b"new").expect("new bundle");
        let backup = publication.backup_root.clone();
        let error = publication
            .publish(|_| {
                fs::remove_dir_all(&backup).expect("inject missing rollback source");
                false
            })
            .expect_err("rollback failure");
        assert_eq!(error.kind, LocalInstallErrorKind::Rollback);
        assert!(!error.recovery_paths.is_empty());
        assert!(error.recovery_paths.iter().any(|path| path.exists()));
    }

    #[test]
    fn exact_copy_preserves_only_pinned_regular_files() {
        let root = tempfile::tempdir().expect("temporary directory");
        let source = root.path().join("source");
        let destination = root.path().join("destination");
        fs::create_dir(&source).expect("create source");
        fs::write(source.join("keep"), b"keep").expect("write pinned file");
        fs::write(source.join("unknown"), b"unknown").expect("write unknown file");
        super::copy_exact_files(
            &source,
            &destination,
            [(
                "keep",
                4,
                "6ca7ea2feefc88ecb5ed6356ed963f47dc9137f82526fdd25d618ea626d0803f",
            )],
        )
        .expect("copy exact manifest");
        assert_eq!(
            fs::read(destination.join("keep")).expect("pinned copy"),
            b"keep"
        );
        assert!(!destination.join("unknown").exists());
    }

    #[cfg(unix)]
    #[test]
    fn exact_copy_rejects_a_pinned_symlink() {
        use std::os::unix::fs::symlink;

        let root = tempfile::tempdir().expect("temporary directory");
        let source = root.path().join("source");
        fs::create_dir(&source).expect("create source");
        fs::write(source.join("target"), b"keep").expect("write target");
        symlink(source.join("target"), source.join("keep")).expect("create symlink");
        let error = super::copy_exact_files(
            &source,
            &root.path().join("destination"),
            [(
                "keep",
                4,
                "6ca7ea2feefc88ecb5ed6356ed963f47dc9137f82526fdd25d618ea626d0803f",
            )],
        )
        .expect_err("symlink must be rejected");
        assert_eq!(error.kind, LocalInstallErrorKind::Integrity);
    }

    #[test]
    fn archive_extraction_writes_only_exact_regular_manifest_entries() {
        use bzip2::write::BzEncoder;
        use bzip2::Compression;

        let root = tempfile::tempdir().expect("temporary directory");
        let archive_path = root.path().join("fixture.tar.bz2");
        let archive_file = fs::File::create(&archive_path).expect("create archive");
        let encoder = BzEncoder::new(archive_file, Compression::fast());
        let mut archive = tar::Builder::new(encoder);
        let mut header = tar::Header::new_gnu();
        header.set_size(4);
        header.set_mode(0o644);
        header.set_cksum();
        archive
            .append_data(&mut header, "bundle/keep", &b"keep"[..])
            .expect("append pinned entry");
        let mut unknown = tar::Header::new_gnu();
        unknown.set_size(7);
        unknown.set_mode(0o644);
        unknown.set_cksum();
        archive
            .append_data(&mut unknown, "bundle/unknown", &b"unknown"[..])
            .expect("append unknown entry");
        let encoder = archive.into_inner().expect("finish tar");
        encoder.finish().expect("finish compression");

        let destination = root.path().join("output");
        super::extract_exact_tar_bz2(
            &archive_path,
            &destination,
            "bundle",
            &[(
                "keep",
                4,
                "6ca7ea2feefc88ecb5ed6356ed963f47dc9137f82526fdd25d618ea626d0803f",
            )],
        )
        .expect("extract exact manifest");
        assert_eq!(
            fs::read(destination.join("keep")).expect("pinned output"),
            b"keep"
        );
        assert!(!destination.join("unknown").exists());
    }

    #[tokio::test]
    async fn bounded_download_rejects_a_response_larger_than_the_manifest() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind fixture server");
        let address = listener.local_addr().expect("fixture address");
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.expect("accept request");
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nlarge")
                .await
                .expect("write response");
        });
        let root = tempfile::tempdir().expect("temporary directory");
        let error = super::download(
            &reqwest::Client::new(),
            root.path(),
            DownloadSpec {
                source_url: Box::leak(format!("http://{address}/asset").into_boxed_str()),
                relative_path: "asset",
                size_bytes: 4,
                sha256: Box::leak(format!("{:x}", Sha256::digest(b"nope")).into_boxed_str()),
            },
            |_| {},
        )
        .await
        .expect_err("oversized response");
        assert_eq!(error.kind, LocalInstallErrorKind::Integrity);
        server.await.expect("fixture server");
    }

    #[tokio::test]
    async fn download_honors_the_clients_read_timeout_for_a_stalled_body() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind fixture server");
        let address = listener.local_addr().expect("fixture address");
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.expect("accept request");
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nx")
                .await
                .expect("write partial response");
            tokio::time::sleep(Duration::from_secs(1)).await;
        });
        let client = reqwest::Client::builder()
            .read_timeout(Duration::from_millis(50))
            .build()
            .expect("timeout client");
        let root = tempfile::tempdir().expect("temporary directory");
        let error = super::download(
            &client,
            root.path(),
            DownloadSpec {
                source_url: Box::leak(format!("http://{address}/asset").into_boxed_str()),
                relative_path: "asset",
                size_bytes: 2,
                sha256: Box::leak(format!("{:x}", Sha256::digest(b"xx")).into_boxed_str()),
            },
            |_| {},
        )
        .await
        .expect_err("stalled response");
        assert_eq!(error.kind, LocalInstallErrorKind::Download);
        server.abort();
    }
}
