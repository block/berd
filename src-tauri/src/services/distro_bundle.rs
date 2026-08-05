use crate::services::kgoose;
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
    pub kgoose_configured: bool,
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

    #[cfg(test)]
    pub(crate) fn with_kgoose_for_tests(kgoose: KgooseDistroConfig) -> Self {
        Self {
            bundle: Some(DistroBundle {
                root_dir: PathBuf::new(),
                config_path: None,
                bin_dir: None,
                manifest: DistroManifest {
                    app_version: None,
                    kgoose: Some(kgoose),
                },
            }),
        }
    }

    pub fn info(
        &self,
        runtime_config: Option<&crate::commands::runtime_config::RuntimeKgooseConfig>,
    ) -> DistroBundleInfo {
        let Some(bundle) = &self.bundle else {
            return DistroBundleInfo {
                present: false,
                kgoose_configured: kgoose::is_configured(runtime_config, None),
                manifest: DistroManifest::default(),
            };
        };

        DistroBundleInfo {
            present: true,
            kgoose_configured: kgoose::is_configured(
                runtime_config,
                bundle.manifest.kgoose.as_ref(),
            ),
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

    Ok(Some(load_distro_bundle_from_root(root_dir)?))
}

fn load_distro_bundle_from_root(root_dir: PathBuf) -> Result<DistroBundle, String> {
    let manifest_path = root_dir.join(DISTRO_JSON_NAME);
    let manifest = if manifest_path.exists() {
        read_manifest(&manifest_path)?
    } else {
        DistroManifest::default()
    };
    let config_path = root_dir.join(DISTRO_CONFIG_NAME);
    let bin_dir = root_dir.join(DISTRO_BIN_DIR_NAME);

    Ok(DistroBundle {
        root_dir,
        config_path: config_path.exists().then_some(config_path),
        bin_dir: bin_dir.is_dir().then_some(bin_dir),
        manifest,
    })
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
    use crate::test_support::env_lock;

    #[test]
    fn info_reports_kgoose_unconfigured_without_an_explicit_endpoint() {
        let _guard = env_lock().lock().expect("env lock");
        env::remove_var("KGOOSE_BASE_URL");

        assert!(
            !DistroBundleState::empty_for_tests()
                .info(None)
                .kgoose_configured
        );
    }

    #[test]
    fn info_reports_explicit_distro_kgoose_endpoint() {
        let _guard = env_lock().lock().expect("env lock");
        env::remove_var("KGOOSE_BASE_URL");
        let state = DistroBundleState {
            bundle: Some(DistroBundle {
                root_dir: PathBuf::new(),
                config_path: None,
                bin_dir: None,
                manifest: DistroManifest {
                    app_version: None,
                    kgoose: Some(KgooseDistroConfig {
                        base_url: Some("https://kgoose.example.test/".to_string()),
                        path: None,
                    }),
                },
            }),
        };

        assert!(state.info(None).kgoose_configured);
    }

    #[test]
    fn loads_bundle_assets_without_manifest() {
        let root_dir = tempfile::tempdir().expect("temp distro root");
        let config_path = root_dir.path().join(DISTRO_CONFIG_NAME);
        let bin_dir = root_dir.path().join(DISTRO_BIN_DIR_NAME);
        std::fs::write(&config_path, "extensions: {}\n").expect("write config");
        std::fs::create_dir(&bin_dir).expect("create bin dir");

        let bundle = load_distro_bundle_from_root(root_dir.path().to_path_buf())
            .expect("bundle should load without manifest");

        assert_eq!(bundle.root_dir, root_dir.path());
        assert_eq!(bundle.config_path.as_deref(), Some(config_path.as_path()));
        assert_eq!(bundle.bin_dir.as_deref(), Some(bin_dir.as_path()));
        assert!(bundle.manifest.app_version.is_none());
        assert!(bundle.manifest.kgoose.is_none());
    }

    #[test]
    fn parses_partial_manifest() {
        let manifest = serde_json::from_str::<DistroManifest>(
            r#"{
                "appVersion": "development",
                "kgoose": {
                    "baseUrl": "https://kgoose.example.test/",
                    "path": "example/goose"
                }
            }"#,
        )
        .expect("manifest should parse");

        let kgoose = manifest.kgoose.as_ref().expect("kgoose should parse");

        assert_eq!(manifest.app_version.as_deref(), Some("development"));
        assert_eq!(
            kgoose.base_url.as_deref(),
            Some("https://kgoose.example.test/")
        );
        assert_eq!(kgoose.path.as_deref(), Some("example/goose"));
    }
}
