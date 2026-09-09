//! Pinned, portable Parakeet model assets.

use crate::asset_verification::{inspect_assets, AssetInspection, PinnedAsset};
use crate::local_assets::{
    self, CombinedPublication, DownloadSpec, LocalAssetRoots, LocalInstallError,
    LocalInstallErrorKind, LocalInstallPhase, LocalInstallProgress, TemporaryDirectory,
};
use std::path::Path;

/// Stable public identity of Berd's pinned Parakeet model.
pub const MODEL_ID: &str = "parakeet-tdt-ctc-110m-en-int8";
/// License identifier for the upstream model and conversion.
pub const LICENSE_ID: &str = "CC-BY-4.0";
/// Directory inside the pinned upstream archive.
pub const ARCHIVE_DIRECTORY: &str = "sherpa-onnx-nemo-parakeet_tdt_ctc_110m-en-36000-int8";

/// One immutable downloadable archive.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ParakeetArchive {
    pub filename: &'static str,
    pub size_bytes: u64,
    pub sha256: &'static str,
    pub source_url: &'static str,
}

/// One immutable file in the portable Parakeet bundle root.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ParakeetAsset {
    pub relative_path: &'static str,
    pub size_bytes: u64,
    pub sha256: &'static str,
}

/// Installation state for one explicit portable Parakeet bundle root.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ParakeetAssetStatus {
    Missing,
    Invalid,
    Ready { verified_bytes: u64 },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ParakeetInstallOutcome {
    AlreadyReady {
        verified_bytes: u64,
    },
    Installed {
        verified_bytes: u64,
        cleanup_pending: Option<std::path::PathBuf>,
    },
}

pub const ARCHIVE: ParakeetArchive = ParakeetArchive {
    filename: "parakeet.tar.bz2",
    size_bytes: 104_337_827,
    sha256: "17f945007b52ccd8b7200ffc7c5652e9e8e961dfdf479cefcabd06cf5703630b",
    source_url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet_tdt_ctc_110m-en-36000-int8.tar.bz2",
};

const LICENSE_TEXT: &str = "\
NVIDIA Parakeet TDT-CTC 110M (English)\n\
© NVIDIA Corporation.\n\
\n\
Licensed under the Creative Commons Attribution 4.0 International License:\n\
https://creativecommons.org/licenses/by/4.0/\n\
\n\
Original model: https://huggingface.co/nvidia/parakeet-tdt_ctc-110m\n\
ONNX conversion: https://github.com/k2-fsa/sherpa-onnx\n";

const PUBLISHED_ASSETS: &[ParakeetAsset] = &[
    ParakeetAsset {
        relative_path: "model.int8.onnx",
        size_bytes: 131_652_171,
        sha256: "9177a9146cf32ee0cc8152276ef95116f312018d316be37ccf57f7efea81fc1a",
    },
    ParakeetAsset {
        relative_path: "tokens.txt",
        size_bytes: 9_953,
        sha256: "450e56bd2f036fe5b6aa821865838cc5aa9d8b0106134ce9a9ba0664abe6cd10",
    },
    ParakeetAsset {
        relative_path: "MODEL_LICENSE.txt",
        size_bytes: 307,
        sha256: "7ac2cc80a2b55558dabcdb73bb75ffd6f75dcc854b029f955023a38fb08b337b",
    },
];

pub fn published_assets() -> &'static [ParakeetAsset] {
    PUBLISHED_ASSETS
}

pub fn license_text() -> &'static str {
    LICENSE_TEXT
}

pub fn download_bytes() -> u64 {
    ARCHIVE.size_bytes
}

pub fn published_bytes() -> u64 {
    PUBLISHED_ASSETS.iter().map(|asset| asset.size_bytes).sum()
}

pub fn inspect(root: &Path) -> Result<ParakeetAssetStatus, String> {
    inspect_manifest(root, PUBLISHED_ASSETS)
}

pub async fn install(
    roots: &LocalAssetRoots,
    on_progress: impl FnMut(LocalInstallProgress),
) -> Result<ParakeetInstallOutcome, LocalInstallError> {
    let client = local_assets::default_client()?;
    let archive = DownloadSpec {
        source_url: ARCHIVE.source_url,
        relative_path: ARCHIVE.filename,
        size_bytes: ARCHIVE.size_bytes,
        sha256: ARCHIVE.sha256,
    };
    let published = exact_files()
        .into_iter()
        .map(|(relative_path, size_bytes, sha256)| DownloadSpec {
            source_url: "",
            relative_path,
            size_bytes,
            sha256,
        })
        .collect::<Vec<_>>();
    install_with_client(
        roots,
        &client,
        ParakeetInstallPlan {
            archive,
            archive_directory: ARCHIVE_DIRECTORY,
            runtime_specs: &published[..2],
            published_specs: &published,
            license_text: LICENSE_TEXT.as_bytes(),
        },
        None,
        on_progress,
    )
    .await
}

#[derive(Clone, Copy)]
struct ParakeetInstallPlan<'a> {
    archive: DownloadSpec<'static>,
    archive_directory: &'static str,
    runtime_specs: &'a [DownloadSpec<'static>],
    published_specs: &'a [DownloadSpec<'static>],
    license_text: &'static [u8],
}

async fn install_with_client(
    roots: &LocalAssetRoots,
    client: &reqwest::Client,
    plan: ParakeetInstallPlan<'_>,
    preparation_barrier: Option<&tokio::sync::Barrier>,
    mut on_progress: impl FnMut(LocalInstallProgress),
) -> Result<ParakeetInstallOutcome, LocalInstallError> {
    let ParakeetInstallPlan {
        archive: archive_spec,
        archive_directory,
        runtime_specs,
        published_specs,
        license_text,
    } = plan;
    let total_download_bytes = archive_spec.size_bytes;
    {
        let lock = local_assets::lock_for_mutation(roots)
            .await
            .map_err(LocalInstallError::from)?;
        lock.recover_interrupted_publication()?;
        if let crate::asset_verification::AssetInspection::Ready { verified_bytes } =
            local_assets::inspect_download_specs(roots.parakeet_bundle_root(), published_specs)
                .map_err(|message| LocalInstallError {
                    kind: LocalInstallErrorKind::Integrity,
                    message,
                    recovery_paths: Vec::new(),
                })?
        {
            return Ok(ParakeetInstallOutcome::AlreadyReady { verified_bytes });
        }
    }
    if let Some(barrier) = preparation_barrier {
        barrier.wait().await;
    }

    let prepared = TemporaryDirectory::create(roots.coordination_root(), "parakeet-download")?;
    let mut downloaded_bytes = 0_u64;
    on_progress(LocalInstallProgress {
        phase: LocalInstallPhase::Downloading,
        downloaded_bytes,
        total_download_bytes,
    });
    local_assets::download(client, prepared.path(), archive_spec, |increment| {
        downloaded_bytes = downloaded_bytes.saturating_add(increment);
        on_progress(LocalInstallProgress {
            phase: LocalInstallPhase::Downloading,
            downloaded_bytes,
            total_download_bytes,
        });
    })
    .await?;
    on_progress(LocalInstallProgress {
        phase: LocalInstallPhase::Extracting,
        downloaded_bytes,
        total_download_bytes,
    });
    let archive = prepared.path().join(archive_spec.relative_path);
    let destination = prepared.path().to_path_buf();
    let runtime_specs = runtime_specs.to_vec();
    let extraction_manifest = published_specs.to_vec();
    let (prepared, extraction) = tokio::task::spawn_blocking(move || {
        let expected = runtime_specs
            .iter()
            .map(|asset| (asset.relative_path, asset.size_bytes, asset.sha256))
            .collect::<Vec<_>>();
        let result = local_assets::extract_exact_tar_bz2(
            &archive,
            &destination,
            archive_directory,
            &expected,
        )
        .and_then(|()| {
            let license = extraction_manifest.last().ok_or_else(|| {
                LocalInstallError::new(
                    LocalInstallErrorKind::Integrity,
                    "Parakeet published manifest omitted its license",
                )
            })?;
            std::fs::write(destination.join(license.relative_path), license_text).map_err(|error| {
                LocalInstallError::new(
                    LocalInstallErrorKind::Extraction,
                    format!("write Parakeet attribution: {error}"),
                )
            })
        });
        (prepared, result)
    })
    .await
    .map_err(|error| LocalInstallError {
        kind: LocalInstallErrorKind::Extraction,
        message: format!("Parakeet extraction task failed: {error}"),
        recovery_paths: Vec::new(),
    })?;
    extraction?;
    on_progress(LocalInstallProgress {
        phase: LocalInstallPhase::Verifying,
        downloaded_bytes,
        total_download_bytes,
    });
    if !matches!(
        local_assets::inspect_download_specs(prepared.path(), published_specs),
        Ok(crate::asset_verification::AssetInspection::Ready { .. })
    ) {
        return Err(LocalInstallError {
            kind: LocalInstallErrorKind::Integrity,
            message: "prepared Parakeet bundle failed pinned-file verification".to_string(),
            recovery_paths: Vec::new(),
        });
    }

    on_progress(LocalInstallProgress {
        phase: LocalInstallPhase::Publishing,
        downloaded_bytes,
        total_download_bytes,
    });
    let lock = local_assets::lock_for_mutation(roots)
        .await
        .map_err(LocalInstallError::from)?;
    lock.recover_interrupted_publication()?;
    if let crate::asset_verification::AssetInspection::Ready { verified_bytes } =
        local_assets::inspect_download_specs(roots.parakeet_bundle_root(), published_specs)
            .map_err(|message| LocalInstallError {
                kind: LocalInstallErrorKind::Integrity,
                message,
                recovery_paths: Vec::new(),
            })?
    {
        drop(lock);
        report_complete(&mut on_progress, downloaded_bytes, total_download_bytes);
        return Ok(ParakeetInstallOutcome::AlreadyReady { verified_bytes });
    }
    let preserve_pocket = matches!(
        crate::pocket_assets::inspect(roots.pocket_bundle_root()),
        Ok(crate::pocket_assets::PocketAssetStatus::Ready { .. })
    );
    let publication = CombinedPublication::prepare(roots)?;
    if preserve_pocket {
        local_assets::copy_exact_files(
            roots.pocket_bundle_root(),
            publication.root(),
            crate::pocket_assets::exact_files(),
        )?;
    }
    local_assets::copy_exact_files(
        prepared.path(),
        &publication.root().join("stt"),
        published_specs
            .iter()
            .map(|spec| (spec.relative_path, spec.size_bytes, spec.sha256)),
    )?;
    let target_ready = |root: &Path| {
        matches!(
            local_assets::inspect_download_specs(&root.join("stt"), published_specs),
            Ok(crate::asset_verification::AssetInspection::Ready { .. })
        )
    };
    let combined_ready = |root: &Path| {
        target_ready(root)
            && (!preserve_pocket
                || matches!(
                    crate::pocket_assets::inspect(root),
                    Ok(crate::pocket_assets::PocketAssetStatus::Ready { .. })
                ))
    };
    if !combined_ready(publication.root()) {
        return Err(LocalInstallError {
            kind: LocalInstallErrorKind::Integrity,
            message: "staged Parakeet bundle failed pinned-file verification".to_string(),
            recovery_paths: Vec::new(),
        });
    }
    let cleanup_pending = publication.publish(combined_ready)?;
    let verified_bytes =
        match local_assets::inspect_download_specs(roots.parakeet_bundle_root(), published_specs) {
            Ok(crate::asset_verification::AssetInspection::Ready { verified_bytes }) => {
                verified_bytes
            }
            _ => {
                return Err(LocalInstallError {
                    kind: LocalInstallErrorKind::Integrity,
                    message: "published Parakeet bundle was not ready".to_string(),
                    recovery_paths: Vec::new(),
                })
            }
        };
    drop(lock);
    report_complete(&mut on_progress, downloaded_bytes, total_download_bytes);
    Ok(ParakeetInstallOutcome::Installed {
        verified_bytes,
        cleanup_pending,
    })
}

fn report_complete(
    on_progress: &mut impl FnMut(LocalInstallProgress),
    downloaded_bytes: u64,
    total_download_bytes: u64,
) {
    on_progress(LocalInstallProgress {
        phase: LocalInstallPhase::Complete,
        downloaded_bytes,
        total_download_bytes,
    });
}

pub(crate) fn exact_files() -> Vec<(&'static str, u64, &'static str)> {
    PUBLISHED_ASSETS
        .iter()
        .map(|asset| (asset.relative_path, asset.size_bytes, asset.sha256))
        .collect()
}

/// Copy one verified Parakeet bundle into a host-owned transaction staging root.
pub fn stage_verified_bundle(
    mutation: &crate::local_assets::LocalAssetMutationGuard,
    source: &Path,
    destination: &Path,
) -> Result<(), LocalInstallError> {
    mutation.validate_staging_paths(
        source,
        mutation.roots().parakeet_bundle_root(),
        destination,
    )?;
    local_assets::copy_exact_files(source, destination, exact_files())?;
    if !matches!(inspect(destination), Ok(ParakeetAssetStatus::Ready { .. })) {
        return Err(LocalInstallError::new(
            LocalInstallErrorKind::Integrity,
            "staged Parakeet bundle failed pinned-file verification",
        ));
    }
    Ok(())
}

fn inspect_manifest(root: &Path, assets: &[ParakeetAsset]) -> Result<ParakeetAssetStatus, String> {
    let manifest: Vec<_> = assets
        .iter()
        .map(|asset| PinnedAsset {
            relative_path: asset.relative_path,
            size_bytes: asset.size_bytes,
            sha256: asset.sha256,
        })
        .collect();
    Ok(match inspect_assets(root, &manifest)? {
        AssetInspection::Missing => ParakeetAssetStatus::Missing,
        AssetInspection::Invalid => ParakeetAssetStatus::Invalid,
        AssetInspection::Ready { verified_bytes } => ParakeetAssetStatus::Ready { verified_bytes },
    })
}

#[cfg(test)]
mod tests {
    use super::{
        inspect_manifest, license_text, published_assets, published_bytes, ParakeetAssetStatus,
        ARCHIVE, LICENSE_ID, MODEL_ID,
    };
    use sha2::{Digest, Sha256};
    use std::collections::HashSet;
    use std::fs;
    use std::sync::{Arc, Mutex};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[test]
    fn pinned_catalog_includes_exact_attribution() {
        assert_eq!(MODEL_ID, "parakeet-tdt-ctc-110m-en-int8");
        assert_eq!(LICENSE_ID, "CC-BY-4.0");
        assert!(ARCHIVE.source_url.starts_with("https://"));
        assert_eq!(ARCHIVE.sha256.len(), 64);
        assert_eq!(
            published_assets()
                .iter()
                .map(|asset| asset.relative_path)
                .collect::<Vec<_>>(),
            ["model.int8.onnx", "tokens.txt", "MODEL_LICENSE.txt"]
        );
        assert!(license_text().contains("Creative Commons Attribution 4.0"));
        let license = published_assets()
            .iter()
            .find(|asset| asset.relative_path == "MODEL_LICENSE.txt")
            .expect("license asset");
        assert_eq!(license.size_bytes, license_text().len() as u64);
        assert_eq!(
            license.sha256,
            format!("{:x}", Sha256::digest(license_text().as_bytes()))
        );
        assert_eq!(
            published_bytes(),
            published_assets()
                .iter()
                .map(|asset| asset.size_bytes)
                .sum::<u64>()
        );
        assert_eq!(
            published_assets()
                .iter()
                .map(|asset| asset.relative_path)
                .collect::<HashSet<_>>()
                .len(),
            published_assets().len()
        );
    }

    #[test]
    fn exact_license_text_is_part_of_bundle_readiness() {
        let root =
            std::env::temp_dir().join(format!("berd-parakeet-license-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir(&root).expect("create temporary directory");
        let license = &published_assets()[2..];
        fs::write(root.join("MODEL_LICENSE.txt"), license_text()).expect("write license");
        assert_eq!(
            inspect_manifest(&root, license).expect("inspect exact license"),
            ParakeetAssetStatus::Ready {
                verified_bytes: license_text().len() as u64
            }
        );

        let mut corrupt = license_text().as_bytes().to_vec();
        corrupt[0] ^= 1;
        fs::write(root.join("MODEL_LICENSE.txt"), corrupt).expect("corrupt license");
        assert_eq!(
            inspect_manifest(&root, license).expect("inspect corrupt license"),
            ParakeetAssetStatus::Invalid
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn late_ready_race_reports_terminal_complete_progress() {
        let mut progress = Vec::new();
        super::report_complete(
            &mut |event| progress.push(event),
            super::download_bytes(),
            super::download_bytes(),
        );
        assert_eq!(progress.len(), 1);
        assert_eq!(progress[0].phase, super::LocalInstallPhase::Complete);
        assert_eq!(progress[0].downloaded_bytes, super::download_bytes());
    }

    #[tokio::test]
    async fn concrete_installs_serialize_extract_exactly_and_complete_the_late_racer() {
        let encoder = bzip2::write::BzEncoder::new(Vec::new(), bzip2::Compression::fast());
        let mut archive = tar::Builder::new(encoder);
        let mut header = tar::Header::new_gnu();
        header.set_size(4);
        header.set_mode(0o644);
        header.set_cksum();
        archive
            .append_data(&mut header, "bundle/model", &b"keep"[..])
            .expect("append model");
        let encoder = archive.into_inner().expect("finish tar");
        let archive_bytes = encoder.finish().expect("finish compression");
        let archive_hash =
            Box::leak(format!("{:x}", Sha256::digest(&archive_bytes)).into_boxed_str());
        let archive_size = archive_bytes.len() as u64;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind fixture server");
        let address = listener.local_addr().expect("fixture address");
        let server = tokio::spawn(async move {
            for _ in 0..2 {
                let (mut socket, _) = listener.accept().await.expect("accept request");
                let mut request = [0_u8; 1024];
                let bytes_read = socket.read(&mut request).await.expect("read request");
                assert!(bytes_read > 0, "fixture request was empty");
                socket
                    .write_all(
                        format!(
                            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                            archive_bytes.len()
                        )
                        .as_bytes(),
                    )
                    .await
                    .expect("write response headers");
                socket
                    .write_all(&archive_bytes)
                    .await
                    .expect("write archive");
            }
        });
        let root = tempfile::tempdir().expect("temporary directory");
        let roots = super::LocalAssetRoots::new(
            root.path(),
            root.path().join("native-voice-v2"),
            root.path().join("native-voice-v2/stt"),
        )
        .expect("asset roots");
        let archive_spec = super::DownloadSpec {
            source_url: Box::leak(format!("http://{address}/archive").into_boxed_str()),
            relative_path: "archive.tar.bz2",
            size_bytes: archive_size,
            sha256: archive_hash,
        };
        let published = [
            super::DownloadSpec {
                source_url: "",
                relative_path: "model",
                size_bytes: 4,
                sha256: "6ca7ea2feefc88ecb5ed6356ed963f47dc9137f82526fdd25d618ea626d0803f",
            },
            super::DownloadSpec {
                source_url: "",
                relative_path: "LICENSE",
                size_bytes: 7,
                sha256: "cc1d3b0234846714b0aeda6cc34b057b4305bb83dd447fb88f816efeb59a4e96",
            },
        ];
        let client = reqwest::Client::new();
        let first_progress = Arc::new(Mutex::new(Vec::new()));
        let second_progress = Arc::new(Mutex::new(Vec::new()));
        let first_events = Arc::clone(&first_progress);
        let second_events = Arc::clone(&second_progress);
        let barrier = tokio::sync::Barrier::new(2);
        let (first, second) = tokio::join!(
            super::install_with_client(
                &roots,
                &client,
                super::ParakeetInstallPlan {
                    archive: archive_spec,
                    archive_directory: "bundle",
                    runtime_specs: &published[..1],
                    published_specs: &published,
                    license_text: b"license",
                },
                Some(&barrier),
                move |event| first_events.lock().expect("first progress").push(event),
            ),
            super::install_with_client(
                &roots,
                &client,
                super::ParakeetInstallPlan {
                    archive: archive_spec,
                    archive_directory: "bundle",
                    runtime_specs: &published[..1],
                    published_specs: &published,
                    license_text: b"license",
                },
                Some(&barrier),
                move |event| second_events.lock().expect("second progress").push(event),
            ),
        );
        let outcomes = [
            first.expect("first install"),
            second.expect("second install"),
        ];
        assert!(outcomes
            .iter()
            .any(|outcome| matches!(outcome, super::ParakeetInstallOutcome::Installed { .. })));
        assert!(outcomes
            .iter()
            .any(|outcome| matches!(outcome, super::ParakeetInstallOutcome::AlreadyReady { .. })));
        for events in [first_progress, second_progress] {
            assert_eq!(
                events
                    .lock()
                    .expect("progress")
                    .last()
                    .map(|event| event.phase),
                Some(super::LocalInstallPhase::Complete)
            );
        }
        assert!(!roots
            .parakeet_bundle_root()
            .join("archive.tar.bz2")
            .exists());
        server.await.expect("fixture server");
    }

    #[test]
    fn staging_rejects_a_mutation_guard_from_another_store() {
        let first = tempfile::tempdir().expect("first store");
        let second = tempfile::tempdir().expect("second store");
        let first_roots = super::LocalAssetRoots::new(
            first.path(),
            first.path().join("native-voice-v2"),
            first.path().join("native-voice-v2/stt"),
        )
        .expect("first roots");
        let second_roots = super::LocalAssetRoots::new(
            second.path(),
            second.path().join("native-voice-v2"),
            second.path().join("native-voice-v2/stt"),
        )
        .expect("second roots");
        let guard = crate::local_assets::try_lock_for_mutation(&first_roots).expect("first lock");
        let error = super::stage_verified_bundle(
            &guard,
            second_roots.parakeet_bundle_root(),
            first.path().join("stage/stt").as_path(),
        )
        .expect_err("cross-store guard");
        assert_eq!(error.kind, super::LocalInstallErrorKind::InvalidRoot);

        for destination in [
            first.path().join("../outside/stt"),
            first.path().to_path_buf(),
            first_roots.pocket_bundle_root().join("nested-stage/stt"),
        ] {
            let error = super::stage_verified_bundle(
                &guard,
                first_roots.parakeet_bundle_root(),
                &destination,
            )
            .expect_err("unsafe staging destination");
            assert_eq!(error.kind, super::LocalInstallErrorKind::InvalidRoot);
        }
    }

    #[tokio::test]
    async fn initial_ready_preflight_makes_no_request_and_reports_already_ready() {
        let root = tempfile::tempdir().expect("temporary directory");
        let roots = super::LocalAssetRoots::new(
            root.path(),
            root.path().join("native-voice-v2"),
            root.path().join("native-voice-v2/stt"),
        )
        .expect("asset roots");
        std::fs::create_dir_all(roots.parakeet_bundle_root()).expect("create ready bundle");
        std::fs::write(roots.parakeet_bundle_root().join("model"), b"keep").expect("write model");
        std::fs::write(roots.parakeet_bundle_root().join("LICENSE"), b"license")
            .expect("write license");
        let published = [
            super::DownloadSpec {
                source_url: "",
                relative_path: "model",
                size_bytes: 4,
                sha256: "6ca7ea2feefc88ecb5ed6356ed963f47dc9137f82526fdd25d618ea626d0803f",
            },
            super::DownloadSpec {
                source_url: "",
                relative_path: "LICENSE",
                size_bytes: 7,
                sha256: "cc1d3b0234846714b0aeda6cc34b057b4305bb83dd447fb88f816efeb59a4e96",
            },
        ];
        let archive = super::DownloadSpec {
            source_url: "http://127.0.0.1:1/must-not-be-called",
            relative_path: "archive",
            size_bytes: 1,
            sha256: "00",
        };
        let mut progress = Vec::new();
        let outcome = super::install_with_client(
            &roots,
            &reqwest::Client::new(),
            super::ParakeetInstallPlan {
                archive,
                archive_directory: "bundle",
                runtime_specs: &published[..1],
                published_specs: &published,
                license_text: b"license",
            },
            None,
            |event| progress.push(event),
        )
        .await
        .expect("already ready");
        assert!(matches!(
            outcome,
            super::ParakeetInstallOutcome::AlreadyReady { .. }
        ));
        assert!(progress.is_empty());
    }
}
