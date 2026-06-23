use std::env;
use std::fs;
use std::path::Path;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use crate::runtime::{compact_text, ExtensionSummary};

pub const EXTENSIONS_CATALOG_ENV_VAR: &str = "KGOOSE_EXTENSIONS_CATALOG";

const DEFAULT_EXTENSIONS_CATALOG: &str = include_str!("../extensions.yaml");
const GENERATED_HEADER: &str =
    "# Generated via `just update-extensions-catalog`, then curated manually.\n";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct ExtensionCatalogEntry {
    name: String,
    #[serde(default)]
    about: String,
}

pub fn load_extensions_catalog() -> Result<Vec<ExtensionSummary>> {
    match env::var(EXTENSIONS_CATALOG_ENV_VAR) {
        Ok(path) => load_extensions_catalog_from_path(path),
        Err(env::VarError::NotPresent) => parse_extensions_catalog(DEFAULT_EXTENSIONS_CATALOG),
        Err(err) => anyhow::bail!("failed to read {EXTENSIONS_CATALOG_ENV_VAR}: {err}"),
    }
}

pub fn load_extensions_catalog_from_path(path: impl AsRef<Path>) -> Result<Vec<ExtensionSummary>> {
    let path = path.as_ref();
    let source = fs::read_to_string(path)
        .with_context(|| format!("read extensions catalog {}", path.display()))?;

    parse_extensions_catalog(&source)
        .with_context(|| format!("parse extensions catalog {}", path.display()))
}

pub fn write_extensions_catalog(
    path: impl AsRef<Path>,
    extensions: &[ExtensionSummary],
) -> Result<()> {
    let path = path.as_ref();
    let rendered = render_extensions_catalog(extensions)?;
    fs::write(path, rendered)
        .with_context(|| format!("write extensions catalog {}", path.display()))
}

fn parse_extensions_catalog(source: &str) -> Result<Vec<ExtensionSummary>> {
    let entries = serde_yaml::from_str::<Vec<ExtensionCatalogEntry>>(source)
        .context("parse extensions catalog YAML")?;

    Ok(normalize_entries(entries))
}

fn render_extensions_catalog(extensions: &[ExtensionSummary]) -> Result<String> {
    let entries = normalize_entries(
        extensions
            .iter()
            .map(|extension| ExtensionCatalogEntry {
                name: extension.name.clone(),
                about: extension.about.clone(),
            })
            .collect(),
    );
    let yaml = serde_yaml::to_string(&entries).context("serialize extensions catalog YAML")?;

    Ok(format!("{GENERATED_HEADER}{yaml}"))
}

fn normalize_entries(entries: Vec<ExtensionCatalogEntry>) -> Vec<ExtensionSummary> {
    let mut normalized = entries
        .into_iter()
        .filter_map(|entry| {
            let name = entry.name.trim().to_string();
            if name.is_empty() {
                return None;
            }

            Some(ExtensionSummary {
                about: extension_about(&name, &entry.about),
                name,
            })
        })
        .collect::<Vec<_>>();
    normalized.sort_by(|left, right| left.name.cmp(&right.name));
    normalized.dedup_by(|left, right| left.name == right.name);
    normalized
}

fn extension_about(name: &str, about: &str) -> String {
    let about = about.trim().trim_start_matches('#').trim();
    if about.is_empty() {
        format!("{name} tools")
    } else {
        compact_text(about)
    }
}

#[cfg(test)]
mod tests {
    use super::{load_extensions_catalog_from_path, render_extensions_catalog};
    use crate::runtime::ExtensionSummary;
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn embedded_extensions_catalog_is_valid_yaml() {
        let extensions = super::parse_extensions_catalog(super::DEFAULT_EXTENSIONS_CATALOG)
            .expect("parse embedded catalog");

        assert!(!extensions.is_empty());
    }

    #[test]
    fn render_extensions_catalog_sorts_and_normalizes_entries() {
        let rendered = render_extensions_catalog(&[
            ExtensionSummary {
                name: " utils ".to_string(),
                about: " Utility helpers ".to_string(),
            },
            ExtensionSummary {
                name: "slack".to_string(),
                about: String::new(),
            },
        ])
        .expect("render catalog");

        assert!(rendered.starts_with("# Generated via `just update-extensions-catalog`"));
        assert!(rendered.contains("name: slack"));
        assert!(rendered.contains("about: slack tools"));
        assert!(rendered.contains("name: utils"));
        assert!(rendered.contains("about: Utility helpers"));
    }

    #[test]
    fn load_extensions_catalog_from_path_sorts_and_deduplicates_entries() {
        let path = temp_catalog_path("catalog-load");
        fs::write(
            &path,
            r#"
- name: slack
  about: Slack tools
- name: utils
  about: Utility helpers
- name: slack
  about: Duplicate
"#,
        )
        .expect("write catalog");

        let extensions = load_extensions_catalog_from_path(&path).expect("load catalog");
        fs::remove_file(&path).expect("remove catalog");

        assert_eq!(
            extensions,
            vec![
                ExtensionSummary {
                    name: "slack".to_string(),
                    about: "Slack tools".to_string(),
                },
                ExtensionSummary {
                    name: "utils".to_string(),
                    about: "Utility helpers".to_string(),
                },
            ]
        );
    }

    fn temp_catalog_path(prefix: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        std::env::temp_dir().join(format!("{prefix}-{unique}.yaml"))
    }
}
