//! Pinned, portable Parakeet model assets.

use crate::asset_verification::{inspect_assets, AssetInspection, PinnedAsset};
use std::path::Path;

/// Stable public identity of Berd's pinned Parakeet model.
pub const MODEL_ID: &str = "parakeet-tdt-ctc-110m-en-int8";
/// License identifier for the upstream model and conversion.
pub const LICENSE_ID: &str = "CC-BY-4.0";
/// Directory inside the pinned upstream archive.
pub const ARCHIVE_DIRECTORY: &str = "sherpa-onnx-nemo-parakeet_tdt_ctc_110m-en-36000-int8";

/// One immutable downloadable archive.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
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
}
