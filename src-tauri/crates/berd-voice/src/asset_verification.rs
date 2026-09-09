use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs::File;
use std::io::{ErrorKind, Read};
use std::path::{Component, Path};

#[derive(Clone, Copy, Debug)]
pub(crate) struct PinnedAsset {
    pub(crate) relative_path: &'static str,
    pub(crate) size_bytes: u64,
    pub(crate) sha256: &'static str,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum AssetInspection {
    Missing,
    Invalid,
    Ready { verified_bytes: u64 },
}

pub(crate) fn inspect_assets(
    root: &Path,
    assets: &[PinnedAsset],
) -> Result<AssetInspection, String> {
    validate_manifest(assets)?;
    let expected_bytes = assets.iter().try_fold(0_u64, |total, asset| {
        total
            .checked_add(asset.size_bytes)
            .ok_or_else(|| "pinned asset byte total overflow".to_string())
    })?;
    let mut found = false;
    let mut verified_bytes = 0_u64;
    for asset in assets {
        let path = root.join(asset.relative_path);
        match std::fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
                return Ok(AssetInspection::Invalid)
            }
            Ok(_) => {}
            Err(error) if error.kind() == ErrorKind::NotFound => continue,
            Err(_) => return Ok(AssetInspection::Invalid),
        }
        let mut file = match File::open(&path) {
            Ok(file) => {
                found = true;
                file
            }
            Err(error) if error.kind() == ErrorKind::NotFound => continue,
            Err(_) => return Ok(AssetInspection::Invalid),
        };
        let Ok(metadata) = file.metadata() else {
            return Ok(AssetInspection::Invalid);
        };
        if !metadata.is_file() || metadata.len() != asset.size_bytes {
            return Ok(AssetInspection::Invalid);
        }

        let mut hasher = Sha256::new();
        let mut read_bytes = 0_u64;
        let mut buffer = [0_u8; 64 * 1024];
        loop {
            let read = match file.read(&mut buffer) {
                Ok(read) => read,
                Err(_) => return Ok(AssetInspection::Invalid),
            };
            if read == 0 {
                break;
            }
            read_bytes = match read_bytes.checked_add(read as u64) {
                Some(total) if total <= asset.size_bytes => total,
                _ => return Ok(AssetInspection::Invalid),
            };
            hasher.update(&buffer[..read]);
        }
        if read_bytes != asset.size_bytes || format!("{:x}", hasher.finalize()) != asset.sha256 {
            return Ok(AssetInspection::Invalid);
        }
        verified_bytes = verified_bytes
            .checked_add(read_bytes)
            .ok_or_else(|| "pinned asset byte total overflow".to_string())?;
    }

    if !found {
        Ok(AssetInspection::Missing)
    } else if verified_bytes == expected_bytes {
        Ok(AssetInspection::Ready { verified_bytes })
    } else {
        Ok(AssetInspection::Invalid)
    }
}

fn validate_manifest(assets: &[PinnedAsset]) -> Result<(), String> {
    if assets.is_empty() {
        return Err("pinned asset manifest cannot be empty".into());
    }
    let mut paths = HashSet::new();
    for asset in assets {
        let path = Path::new(asset.relative_path);
        if asset.relative_path.is_empty()
            || path.is_absolute()
            || path
                .components()
                .any(|component| !matches!(component, Component::Normal(_)))
        {
            return Err(format!(
                "pinned asset path must be a safe relative path: {}",
                asset.relative_path
            ));
        }
        if !paths.insert(asset.relative_path) {
            return Err(format!(
                "pinned asset path must be unique: {}",
                asset.relative_path
            ));
        }
        if asset.size_bytes == 0 {
            return Err(format!(
                "pinned asset size must be nonzero: {}",
                asset.relative_path
            ));
        }
        if asset.sha256.len() != 64
            || !asset
                .sha256
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err(format!(
                "pinned asset SHA-256 must be 64 lowercase hexadecimal characters: {}",
                asset.relative_path
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{inspect_assets, AssetInspection, PinnedAsset};
    use sha2::{Digest, Sha256};
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new() -> Self {
            static NEXT: AtomicU64 = AtomicU64::new(1);
            let path = std::env::temp_dir().join(format!(
                "berd-voice-assets-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&path).expect("create temporary directory");
            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn asset(path: &'static str, contents: &[u8]) -> PinnedAsset {
        PinnedAsset {
            relative_path: path,
            size_bytes: contents.len() as u64,
            sha256: Box::leak(format!("{:x}", Sha256::digest(contents)).into_boxed_str()),
        }
    }

    #[test]
    fn inspection_distinguishes_missing_valid_and_same_size_corruption() {
        let directory = TestDirectory::new();
        let manifest = [asset("model.bin", b"model")];
        assert_eq!(
            inspect_assets(directory.path(), &manifest).expect("inspect missing"),
            AssetInspection::Missing
        );

        fs::write(directory.path().join("model.bin"), b"model").expect("write model");
        assert_eq!(
            inspect_assets(directory.path(), &manifest).expect("inspect valid"),
            AssetInspection::Ready { verified_bytes: 5 }
        );

        fs::write(directory.path().join("model.bin"), b"other").expect("corrupt model");
        assert_eq!(
            inspect_assets(directory.path(), &manifest).expect("inspect corrupt"),
            AssetInspection::Invalid
        );
    }

    #[test]
    fn partial_manifest_is_invalid_not_missing() {
        let directory = TestDirectory::new();
        let manifest = [asset("one", b"one"), asset("two", b"two")];
        fs::write(directory.path().join("one"), b"one").expect("write first asset");
        assert_eq!(
            inspect_assets(directory.path(), &manifest).expect("inspect partial"),
            AssetInspection::Invalid
        );
    }

    #[cfg(unix)]
    #[test]
    fn pinned_file_symlinks_are_invalid_even_when_the_target_matches() {
        use std::os::unix::fs::symlink;

        let directory = TestDirectory::new();
        let manifest = [asset("model.bin", b"model")];
        fs::write(directory.path().join("target.bin"), b"model").expect("write target");
        symlink("target.bin", directory.path().join("model.bin")).expect("create symlink");
        assert_eq!(
            inspect_assets(directory.path(), &manifest).expect("inspect symlink"),
            AssetInspection::Invalid
        );
    }

    #[test]
    fn unsafe_duplicate_zero_and_malformed_hash_manifest_entries_are_rejected() {
        let directory = TestDirectory::new();
        let valid_hash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
        for manifest in [
            vec![PinnedAsset {
                relative_path: "../outside",
                size_bytes: 1,
                sha256: valid_hash,
            }],
            vec![
                PinnedAsset {
                    relative_path: "same",
                    size_bytes: 1,
                    sha256: valid_hash,
                },
                PinnedAsset {
                    relative_path: "same",
                    size_bytes: 1,
                    sha256: valid_hash,
                },
            ],
            vec![PinnedAsset {
                relative_path: "zero",
                size_bytes: 0,
                sha256: valid_hash,
            }],
            vec![PinnedAsset {
                relative_path: "hash",
                size_bytes: 1,
                sha256: "ABC",
            }],
        ] {
            assert!(inspect_assets(directory.path(), &manifest).is_err());
        }
    }
}
