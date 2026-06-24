use std::collections::BTreeMap;
#[cfg(any(debug_assertions, test))]
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
#[cfg(any(debug_assertions, test))]
use std::sync::Mutex;

use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::skills_config::{kgoose_service_url, SkillsConfig};

#[cfg(target_os = "macos")]
const KEYRING_SERVICE: &str = "com.squareup.builderbot.cli-auth";
#[cfg(target_os = "macos")]
const ERR_SEC_ITEM_NOT_FOUND: i32 = -25300;
pub const BB_AUTH_STORAGE_ENV_VAR: &str = "BB_AUTH_STORAGE";
pub const BB_AUTH_STORAGE_FILE_ENV_VAR: &str = "BB_AUTH_STORAGE_FILE";

#[derive(Debug, Clone)]
pub struct SessionStorageKey {
    profile: String,
    server_url: String,
}

impl SessionStorageKey {
    pub fn new(profile: impl Into<String>, server_url: impl Into<String>) -> Self {
        Self {
            profile: profile.into(),
            server_url: server_url.into().trim_end_matches('/').to_string(),
        }
    }

    pub fn from_config(config: &SkillsConfig) -> Self {
        Self::new(
            config.profile.clone(),
            kgoose_service_url(&config.kgoose_base_url),
        )
    }

    #[cfg(target_os = "macos")]
    fn account(&self) -> String {
        format!("{}@{}", self.profile, self.server_url)
    }

    fn hashed_id(&self) -> String {
        let mut hasher = Sha256::new();
        hasher.update(self.profile.as_bytes());
        hasher.update([0]);
        hasher.update(self.server_url.as_bytes());
        hasher
            .finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredSessionCredential {
    pub session_credential: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<String>,
}

impl StoredSessionCredential {
    pub fn session_credential_header_value(&self) -> Option<String> {
        let session_credential = self.session_credential.trim();
        if session_credential.is_empty() {
            None
        } else {
            Some(session_credential.to_string())
        }
    }
}

pub trait SessionCredentialStorage {
    fn kind(&self) -> &'static str;
    fn get(&self, key: &SessionStorageKey) -> Result<Option<StoredSessionCredential>>;
    fn set(&self, key: &SessionStorageKey, credential: &StoredSessionCredential) -> Result<()>;
    fn delete(&self, key: &SessionStorageKey) -> Result<bool>;
}

pub fn default_session_storage(config: &SkillsConfig) -> Result<Box<dyn SessionCredentialStorage>> {
    default_session_storage_for_bb_home(config.bb_home.clone())
}

pub fn stored_session_credential_header_value(
    profile: &str,
    server_url: &str,
    bb_home: PathBuf,
) -> Result<Option<String>> {
    #[cfg(not(target_os = "macos"))]
    if std::env::var_os(BB_AUTH_STORAGE_ENV_VAR).is_none()
        && std::env::var_os(BB_AUTH_STORAGE_FILE_ENV_VAR).is_none()
    {
        return Ok(None);
    }

    let storage = default_session_storage_for_bb_home(bb_home)?;
    let storage_key = SessionStorageKey::new(profile, server_url);
    Ok(storage
        .get(&storage_key)?
        .and_then(|credential| credential.session_credential_header_value()))
}

fn default_session_storage_for_bb_home(
    bb_home: PathBuf,
) -> Result<Box<dyn SessionCredentialStorage>> {
    match std::env::var(BB_AUTH_STORAGE_ENV_VAR).as_deref() {
        Ok("keyring") => Ok(Box::new(KeyringSessionCredentialStorage)),
        #[cfg(any(debug_assertions, test))]
        Ok("memory") => Ok(Box::new(InMemorySessionCredentialStorage::default())),
        Ok("file") => file_storage_from_env(&bb_home),
        Ok(value) if value.starts_with("file:") => {
            let path = value.trim_start_matches("file:");
            if path.is_empty() {
                anyhow::bail!("{BB_AUTH_STORAGE_ENV_VAR}=file: requires a path");
            }
            Ok(Box::new(FileSessionCredentialStorage::new(PathBuf::from(
                path,
            ))))
        }
        #[cfg(not(any(debug_assertions, test)))]
        Ok("memory") => {
            anyhow::bail!(
                "{BB_AUTH_STORAGE_ENV_VAR}=memory is only available in non-production builds"
            )
        }
        Ok(value) => anyhow::bail!(
            "unsupported {BB_AUTH_STORAGE_ENV_VAR}={value}; expected {}",
            supported_storage_values(),
        ),
        Err(std::env::VarError::NotPresent) => {
            if let Some(path) = std::env::var_os(BB_AUTH_STORAGE_FILE_ENV_VAR) {
                return Ok(Box::new(FileSessionCredentialStorage::new(PathBuf::from(
                    path,
                ))));
            }
            Ok(Box::new(KeyringSessionCredentialStorage))
        }
        Err(error) => Err(anyhow!("read {BB_AUTH_STORAGE_ENV_VAR}: {error}")),
    }
}

fn supported_storage_values() -> &'static str {
    if cfg!(debug_assertions) {
        "keyring, memory, file, or file:<path>"
    } else {
        "keyring, file, or file:<path>"
    }
}

fn file_storage_from_env(bb_home: &std::path::Path) -> Result<Box<dyn SessionCredentialStorage>> {
    let path = std::env::var_os(BB_AUTH_STORAGE_FILE_ENV_VAR)
        .map(PathBuf::from)
        .unwrap_or_else(|| bb_home.join("auth-sessions.json"));
    Ok(Box::new(FileSessionCredentialStorage::new(path)))
}

#[cfg(any(debug_assertions, test))]
#[derive(Debug, Default)]
pub struct InMemorySessionCredentialStorage {
    entries: Mutex<HashMap<String, StoredSessionCredential>>,
}

#[cfg(any(debug_assertions, test))]
impl SessionCredentialStorage for InMemorySessionCredentialStorage {
    fn kind(&self) -> &'static str {
        "memory"
    }

    fn get(&self, key: &SessionStorageKey) -> Result<Option<StoredSessionCredential>> {
        Ok(self
            .entries
            .lock()
            .expect("session storage mutex poisoned")
            .get(&key.hashed_id())
            .cloned())
    }

    fn set(&self, key: &SessionStorageKey, credential: &StoredSessionCredential) -> Result<()> {
        self.entries
            .lock()
            .expect("session storage mutex poisoned")
            .insert(key.hashed_id(), credential.clone());
        Ok(())
    }

    fn delete(&self, key: &SessionStorageKey) -> Result<bool> {
        Ok(self
            .entries
            .lock()
            .expect("session storage mutex poisoned")
            .remove(&key.hashed_id())
            .is_some())
    }
}

#[derive(Debug)]
pub struct FileSessionCredentialStorage {
    path: PathBuf,
}

impl FileSessionCredentialStorage {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    fn read_entries(&self) -> Result<BTreeMap<String, StoredSessionCredential>> {
        if !self.path.exists() {
            return Ok(BTreeMap::new());
        }
        let bytes =
            fs::read(&self.path).with_context(|| format!("read {}", self.path.display()))?;
        serde_json::from_slice(&bytes).with_context(|| format!("parse {}", self.path.display()))
    }

    fn write_entries(&self, entries: &BTreeMap<String, StoredSessionCredential>) -> Result<()> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
        }
        let json = serde_json::to_vec_pretty(entries).context("serialize auth session storage")?;
        fs::write(&self.path, json).with_context(|| format!("write {}", self.path.display()))?;
        restrict_permissions(&self.path)
    }
}

impl SessionCredentialStorage for FileSessionCredentialStorage {
    fn kind(&self) -> &'static str {
        "file"
    }

    fn get(&self, key: &SessionStorageKey) -> Result<Option<StoredSessionCredential>> {
        Ok(self.read_entries()?.get(&key.hashed_id()).cloned())
    }

    fn set(&self, key: &SessionStorageKey, credential: &StoredSessionCredential) -> Result<()> {
        let mut entries = self.read_entries()?;
        entries.insert(key.hashed_id(), credential.clone());
        self.write_entries(&entries)
    }

    fn delete(&self, key: &SessionStorageKey) -> Result<bool> {
        let mut entries = self.read_entries()?;
        let removed = entries.remove(&key.hashed_id()).is_some();
        if removed {
            self.write_entries(&entries)?;
        }
        Ok(removed)
    }
}

#[derive(Debug)]
struct KeyringSessionCredentialStorage;

impl SessionCredentialStorage for KeyringSessionCredentialStorage {
    fn kind(&self) -> &'static str {
        "keyring"
    }

    fn get(&self, key: &SessionStorageKey) -> Result<Option<StoredSessionCredential>> {
        keyring_get(key)
    }

    fn set(&self, key: &SessionStorageKey, credential: &StoredSessionCredential) -> Result<()> {
        keyring_set(key, credential)
    }

    fn delete(&self, key: &SessionStorageKey) -> Result<bool> {
        keyring_delete(key)
    }
}

#[cfg(target_os = "macos")]
fn keyring_get(key: &SessionStorageKey) -> Result<Option<StoredSessionCredential>> {
    match security_framework::passwords::get_generic_password(KEYRING_SERVICE, &key.account()) {
        Ok(value) => {
            let value = String::from_utf8(value)
                .context("BuilderBot CLI auth keyring entry was not UTF-8")?;
            Ok(Some(parse_stored_session(&value)?))
        }
        Err(error) if error.code() == ERR_SEC_ITEM_NOT_FOUND => Ok(None),
        Err(error) => Err(anyhow!(
            "read BuilderBot CLI auth session from keyring: {error}"
        )),
    }
}

#[cfg(target_os = "macos")]
fn keyring_set(key: &SessionStorageKey, credential: &StoredSessionCredential) -> Result<()> {
    let value = serde_json::to_string(credential).context("serialize auth session")?;
    security_framework::passwords::set_generic_password(
        KEYRING_SERVICE,
        &key.account(),
        value.as_bytes(),
    )
    .context("write BuilderBot CLI auth session to keyring")
}

#[cfg(target_os = "macos")]
fn keyring_delete(key: &SessionStorageKey) -> Result<bool> {
    match security_framework::passwords::delete_generic_password(KEYRING_SERVICE, &key.account()) {
        Ok(()) => Ok(true),
        Err(error) if error.code() == ERR_SEC_ITEM_NOT_FOUND => Ok(false),
        Err(error) => Err(anyhow!(
            "delete BuilderBot CLI auth session from keyring: {error}"
        )),
    }
}

#[cfg(not(target_os = "macos"))]
fn keyring_get(_key: &SessionStorageKey) -> Result<Option<StoredSessionCredential>> {
    unsupported_keyring_storage()
}

#[cfg(not(target_os = "macos"))]
fn keyring_set(_key: &SessionStorageKey, _credential: &StoredSessionCredential) -> Result<()> {
    unsupported_keyring_storage()
}

#[cfg(not(target_os = "macos"))]
fn keyring_delete(_key: &SessionStorageKey) -> Result<bool> {
    unsupported_keyring_storage()
}

#[cfg(not(target_os = "macos"))]
fn unsupported_keyring_storage<T>() -> Result<T> {
    anyhow::bail!(
        "OS keyring browser auth storage is currently only implemented on macOS; set {BB_AUTH_STORAGE_ENV_VAR}=file for local testing"
    )
}

#[cfg(any(target_os = "macos", test))]
fn parse_stored_session(value: &str) -> Result<StoredSessionCredential> {
    match serde_json::from_str::<StoredSessionCredential>(value) {
        Ok(stored) => Ok(stored),
        Err(_) => Ok(StoredSessionCredential {
            session_credential: value.to_string(),
            expires_at: None,
        }),
    }
}

fn restrict_permissions(path: &PathBuf) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let permissions = fs::Permissions::from_mode(0o600);
        fs::set_permissions(path, permissions)
            .with_context(|| format!("chmod 600 {}", path.display()))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_storage_scopes_credentials_by_profile_and_server() {
        let directory = std::env::temp_dir().join(format!(
            "bb-auth-storage-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        let storage = FileSessionCredentialStorage::new(directory.join("sessions.json"));
        let local = SessionStorageKey {
            profile: "default".to_string(),
            server_url: "http://localhost:5173/cash-app/goose".to_string(),
        };
        let staging = SessionStorageKey {
            profile: "default".to_string(),
            server_url: "https://kgoose.stage.sqprod.co/cash-app/goose".to_string(),
        };
        let credential = StoredSessionCredential {
            session_credential: "local-session".to_string(),
            expires_at: Some("2026-06-15T00:00:00Z".to_string()),
        };

        storage.set(&local, &credential).expect("store credential");

        assert_eq!(
            storage
                .get(&local)
                .expect("read local credential")
                .expect("local credential")
                .session_credential,
            "local-session"
        );
        assert!(storage
            .get(&staging)
            .expect("read staging credential")
            .is_none());

        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn file_storage_delete_removes_only_matching_session() {
        let directory = std::env::temp_dir().join(format!(
            "bb-auth-storage-delete-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        let storage = FileSessionCredentialStorage::new(directory.join("sessions.json"));
        let local = SessionStorageKey {
            profile: "default".to_string(),
            server_url: "http://localhost:5173/cash-app/goose".to_string(),
        };
        let staging = SessionStorageKey {
            profile: "default".to_string(),
            server_url: "https://kgoose.stage.sqprod.co/cash-app/goose".to_string(),
        };
        let credential = StoredSessionCredential {
            session_credential: "session".to_string(),
            expires_at: None,
        };
        storage.set(&local, &credential).expect("store local");
        storage.set(&staging, &credential).expect("store staging");

        assert!(storage.delete(&local).expect("delete local"));
        assert!(!storage.delete(&local).expect("delete local again"));
        assert!(storage.get(&local).expect("read local").is_none());
        assert!(storage.get(&staging).expect("read staging").is_some());

        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn parse_stored_session_accepts_legacy_raw_credential() {
        let stored = parse_stored_session("raw-session").expect("parse raw credential");

        assert_eq!(stored.session_credential, "raw-session");
        assert_eq!(stored.expires_at, None);
    }
}
