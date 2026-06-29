use serde::{Deserialize, Serialize};
use std::env;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

const DISTRO_DIR_NAME: &str = "distro";
const DISTRO_JSON_NAME: &str = "distro.json";
const DISTRO_CONFIG_NAME: &str = "config.yaml";
const DISTRO_BIN_DIR_NAME: &str = "bin";

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DistroManifest {
    pub app_version: Option<String>,
    pub kgoose: Option<KgooseDistroConfig>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KgooseDistroConfig {
    pub base_url: Option<String>,
    pub path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DistroBundleInfo {
    pub present: bool,
    #[serde(flatten)]
    pub manifest: DistroManifest,
}

#[derive(Debug, Clone)]
pub struct DistroBundle {
    pub root_dir: PathBuf,
    pub config_path: Option<PathBuf>,
    pub bin_dir: Option<PathBuf>,
    pub manifest: DistroManifest,
}

pub struct DistroBundleState {
    bundle: Option<DistroBundle>,
}

impl DistroBundleState {
    pub fn new(app_handle: &AppHandle) -> Self {
        let bundle = load_distro_bundle(app_handle)
            .map_err(|error| {
                log::warn!("Failed to load distro bundle: {error}");
                error
            })
            .ok()
            .flatten();

        Self { bundle }
    }

    #[cfg(test)]
    pub(crate) fn empty_for_tests() -> Self {
        Self { bundle: None }
    }

    pub fn info(&self) -> DistroBundleInfo {
        let Some(bundle) = &self.bundle else {
            return DistroBundleInfo {
                present: false,
                manifest: DistroManifest::default(),
            };
        };

        DistroBundleInfo {
            present: true,
            manifest: bundle.manifest.clone(),
        }
    }

    pub fn bundle(&self) -> Option<&DistroBundle> {
        self.bundle.as_ref()
    }

    pub fn kgoose_config(&self) -> Option<&KgooseDistroConfig> {
        self.bundle
            .as_ref()
            .and_then(|bundle| bundle.manifest.kgoose.as_ref())
    }
}

fn load_distro_bundle(app_handle: &AppHandle) -> Result<Option<DistroBundle>, String> {
    let Some(root_dir) = resolve_distro_root(app_handle)? else {
        return Ok(None);
    };

    let manifest_path = root_dir.join(DISTRO_JSON_NAME);
    if !manifest_path.exists() {
        return Ok(None);
    }

    let manifest = read_manifest(&manifest_path)?;
    let config_path = root_dir.join(DISTRO_CONFIG_NAME);
    let bin_dir = root_dir.join(DISTRO_BIN_DIR_NAME);

    Ok(Some(DistroBundle {
        root_dir,
        config_path: config_path.exists().then_some(config_path),
        bin_dir: bin_dir.is_dir().then_some(bin_dir),
        manifest,
    }))
}

fn resolve_distro_root(app_handle: &AppHandle) -> Result<Option<PathBuf>, String> {
    if let Ok(override_dir) = env::var("GOOSE_DISTRO_DIR") {
        let path = PathBuf::from(override_dir);
        if path.is_dir() {
            return Ok(Some(path));
        }
        return Err(format!(
            "GOOSE_DISTRO_DIR points to a non-directory path: {}",
            path.display()
        ));
    }

    let resource_dir = app_handle
        .path()
        .resource_dir()
        .map_err(|error| format!("Failed to resolve Tauri resource dir: {error}"))?;
    let distro_dir = resource_dir.join(DISTRO_DIR_NAME);

    Ok(distro_dir.is_dir().then_some(distro_dir))
}

fn read_manifest(path: &Path) -> Result<DistroManifest, String> {
    let contents = std::fs::read_to_string(path).map_err(|error| {
        format!(
            "Failed to read distro manifest '{}': {error}",
            path.display()
        )
    })?;

    serde_json::from_str::<DistroManifest>(&contents).map_err(|error| {
        format!(
            "Failed to parse distro manifest '{}': {error}",
            path.display()
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_partial_manifest() {
        let manifest = serde_json::from_str::<DistroManifest>(
            r#"{
                "appVersion": "development",
                "kgoose": {
                    "baseUrl": "https://kgoose.sqprod.co/",
                    "path": "cash-app/goose"
                }
            }"#,
        )
        .expect("manifest should parse");

        let kgoose = manifest.kgoose.as_ref().expect("kgoose should parse");

        assert_eq!(manifest.app_version.as_deref(), Some("development"));
        assert_eq!(
            kgoose.base_url.as_deref(),
            Some("https://kgoose.sqprod.co/")
        );
        assert_eq!(kgoose.path.as_deref(), Some("cash-app/goose"));
    }
}
