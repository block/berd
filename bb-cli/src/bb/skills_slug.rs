//! Skill slug validation and path confinement.
//!
//! Marketplace plan data is untrusted. Keep every skill name to one portable
//! path component before joining it to an installation root.

use std::path::{Component, Path, PathBuf};

use anyhow::{Context, Result};

pub const MAX_SKILL_SLUG_BYTES: usize = 128;

pub fn validate_slug(slug: &str) -> Result<()> {
    let portable_component = !slug.is_empty()
        && slug.len() <= MAX_SKILL_SLUG_BYTES
        && !slug.starts_with('-')
        && slug
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
        && matches!(
            Path::new(slug).components().collect::<Vec<_>>().as_slice(),
            [Component::Normal(_)]
        );

    if portable_component {
        Ok(())
    } else {
        anyhow::bail!(
            "invalid skill name `{slug}`; use 1-{MAX_SKILL_SLUG_BYTES} bytes of lowercase letters, digits, `-`, and `_`, without a leading `-`"
        )
    }
}

/// Joins a validated slug to a filesystem root and verifies the resulting
/// lexical path remains an immediate child. This is deliberately repeated at
/// mutation boundaries so future callers cannot bypass plan validation.
pub fn confined_skill_path(root: &Path, slug: &str) -> Result<PathBuf> {
    validate_slug(slug)?;
    let path = root.join(slug);
    if path.parent() != Some(root) || path.file_name() != Some(slug.as_ref()) {
        anyhow::bail!(
            "skill path {} escapes installation root {}",
            path.display(),
            root.display()
        );
    }
    Ok(path)
}

pub fn ensure_confined_skill_path(root: &Path, path: &Path) -> Result<()> {
    let slug = path
        .file_name()
        .and_then(|name| name.to_str())
        .context("skill path has no UTF-8 file name")?;
    let expected = confined_skill_path(root, slug)?;
    if path != expected {
        anyhow::bail!(
            "skill path {} is outside installation root {}",
            path.display(),
            root.display()
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_portable_marketplace_slugs() {
        for slug in ["builderbot-tools", "ach_tables", "a11y-web-audit-and-fix"] {
            assert!(validate_slug(slug).is_ok(), "expected valid slug: {slug}");
        }
    }

    #[test]
    fn rejects_traversal_absolute_windows_and_oversized_slugs() {
        let oversized = "a".repeat(MAX_SKILL_SLUG_BYTES + 1);
        for slug in [
            "",
            ".",
            "..",
            "../escape",
            "foo/bar",
            r"foo\bar",
            "/absolute",
            r"C:\absolute",
            r"C:relative",
            r"\\server\share",
            "--project",
            "has space",
            "Uppercase",
            oversized.as_str(),
        ] {
            assert!(
                validate_slug(slug).is_err(),
                "expected invalid slug: {slug:?}"
            );
        }
    }

    #[test]
    fn confined_paths_are_immediate_children() {
        let root = Path::new("skills");
        assert_eq!(
            confined_skill_path(root, "demo").unwrap(),
            root.join("demo")
        );
        assert!(confined_skill_path(root, "../escape").is_err());
        assert!(ensure_confined_skill_path(root, Path::new("other/demo")).is_err());
    }
}
