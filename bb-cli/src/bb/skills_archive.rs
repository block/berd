//! Checksum verification and safe zip extraction for skill artifacts.

use std::io::Cursor;
use std::path::{Component, Path, PathBuf};

use anyhow::{Context, Result};
use sha2::{Digest, Sha256};
use zip::ZipArchive;

use super::agents_models::AgentInstallArtifact;
use super::skills_api::{exit_codes, failure, DownloadedArtifact};
use super::skills_models::PlanArtifact;

pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let digest = hasher.finalize();
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub fn verify_artifact(download: &DownloadedArtifact, artifact: &PlanArtifact) -> Result<()> {
    verify_artifact_parts(
        download,
        &artifact.id,
        artifact.size_bytes,
        &artifact.sha256,
    )
}

#[allow(dead_code)]
pub fn verify_agent_artifact(
    download: &DownloadedArtifact,
    artifact: &AgentInstallArtifact,
) -> Result<()> {
    if artifact.media_type != "application/zip" {
        return Err(failure(
            exit_codes::VERIFICATION,
            "unsupported_agent_artifact_media_type",
            format!(
                "agent artifact {} has media type {}; expected application/zip",
                artifact.id, artifact.media_type
            ),
        ));
    }
    verify_artifact_parts(
        download,
        &artifact.id,
        artifact.size_bytes,
        &artifact.sha256,
    )
}

fn verify_artifact_parts(
    download: &DownloadedArtifact,
    artifact_id: &str,
    expected_size: u64,
    expected_sha256: &str,
) -> Result<()> {
    let size = download.bytes.len() as u64;
    if size != expected_size {
        return Err(failure(
            exit_codes::VERIFICATION,
            "artifact_size_mismatch",
            format!(
                "artifact size mismatch for {}: expected {}, got {}",
                artifact_id, expected_size, size
            ),
        ));
    }
    if let Some(header_size) = download.header_size {
        if header_size != expected_size {
            return Err(failure(
                exit_codes::VERIFICATION,
                "artifact_header_size_mismatch",
                format!(
                    "artifact header size mismatch for {}: expected {}, got {}",
                    artifact_id, expected_size, header_size
                ),
            ));
        }
    }

    let sha = sha256_hex(&download.bytes);
    if sha != expected_sha256 {
        return Err(failure(
            exit_codes::VERIFICATION,
            "artifact_checksum_mismatch",
            format!(
                "artifact checksum mismatch for {}: expected {}, got {}",
                artifact_id, expected_sha256, sha
            ),
        ));
    }
    if let Some(header_sha256) = &download.header_sha256 {
        if header_sha256 != expected_sha256 {
            return Err(failure(
                exit_codes::VERIFICATION,
                "artifact_header_checksum_mismatch",
                format!(
                    "artifact header checksum mismatch for {}: expected {}, got {}",
                    artifact_id, expected_sha256, header_sha256
                ),
            ));
        }
    }
    Ok(())
}

pub fn extract_zip_safely(zip_bytes: &[u8], destination: &Path) -> Result<()> {
    let mut archive = ZipArchive::new(Cursor::new(zip_bytes)).context("open zip artifact")?;
    for index in 0..archive.len() {
        let mut file = archive.by_index(index).context("read zip entry")?;
        let name = file.name().to_string();
        let relative_path =
            safe_zip_path(&name).with_context(|| format!("unsafe zip entry `{name}`"))?;
        if is_unix_symlink(file.unix_mode()) {
            anyhow::bail!("unsafe zip entry `{name}` is a symlink");
        }
        let out_path = destination.join(relative_path);
        if file.is_dir() {
            fs_create_dir_all(&out_path)?;
            continue;
        }
        if let Some(parent) = out_path.parent() {
            fs_create_dir_all(parent)?;
        }
        let mut out = std::fs::File::create(&out_path)
            .with_context(|| format!("create {}", out_path.display()))?;
        std::io::copy(&mut file, &mut out)
            .with_context(|| format!("write {}", out_path.display()))?;
    }
    Ok(())
}

fn fs_create_dir_all(path: &Path) -> Result<()> {
    std::fs::create_dir_all(path).with_context(|| format!("create {}", path.display()))
}

pub fn safe_zip_path(name: &str) -> Result<PathBuf> {
    if name.is_empty() || name.contains('\\') || name.contains('\0') || name.contains(':') {
        anyhow::bail!("path contains unsupported characters")
    }
    let path = Path::new(name);
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(part) => out.push(part),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                anyhow::bail!("path escapes package root")
            }
        }
    }
    if out.as_os_str().is_empty() {
        anyhow::bail!("path is empty")
    }
    Ok(out)
}

fn is_unix_symlink(unix_mode: Option<u32>) -> bool {
    unix_mode
        .map(|mode| mode & 0o170000 == 0o120000)
        .unwrap_or(false)
}

/// Validates a user-supplied `--file` path before sending it to the server:
/// relative, no traversal, no special characters.
pub fn validate_preview_path(path: &str) -> Result<()> {
    safe_zip_path(path)
        .map(|_| ())
        .map_err(|err| anyhow::anyhow!("invalid --file path `{path}`: {err}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_zip_path_rejects_traversal_and_absolute_paths() {
        assert!(safe_zip_path("../escape.md").is_err());
        assert!(safe_zip_path("/abs.md").is_err());
        assert!(safe_zip_path("a\\b.md").is_err());
        assert!(safe_zip_path("ok/nested.md").is_ok());
    }

    #[test]
    fn validate_preview_path_rejects_escapes() {
        assert!(validate_preview_path("../../secret").is_err());
        assert!(validate_preview_path("references/setup.md").is_ok());
    }

    #[test]
    fn rejects_non_zip_agent_artifacts_before_extraction() {
        let download = DownloadedArtifact {
            bytes: b"not a zip".to_vec(),
            header_sha256: None,
            header_size: None,
        };
        let artifact = AgentInstallArtifact {
            id: "agent-artifact".to_string(),
            download_url: "/artifact".to_string(),
            sha256: sha256_hex(&download.bytes),
            size_bytes: download.bytes.len() as u64,
            media_type: "text/plain".to_string(),
        };

        assert!(verify_agent_artifact(&download, &artifact).is_err());
    }
}
