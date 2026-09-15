use std::collections::BTreeMap;
#[cfg(any(debug_assertions, test))]
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
#[cfg(any(debug_assertions, test))]
use std::sync::Mutex;

use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::config::kgoose_service_url;

#[cfg(target_os = "macos")]
const KEYRING_SERVICE: &str = "com.squareup.builderbot.cli-auth";
#[cfg(target_os = "macos")]
const LEGACY_PURPOSE_TOKEN_KEYRING_SERVICE: &str = "com.squareup.builderbot.cli-auth-purpose-token";
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

    pub fn from_profile_and_kgoose_base_url(
        profile: impl Into<String>,
        kgoose_base_url: &str,
        kgoose_service_path: &str,
    ) -> Self {
        Self::new(
            profile,
            kgoose_service_url(kgoose_base_url, kgoose_service_path),
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

#[cfg(target_os = "macos")]
fn legacy_compose_token_account(session: &SessionStorageKey) -> String {
    format!("compose@{}", session.account())
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
    fn delete_legacy_purpose_token_cache(&self, _key: &SessionStorageKey) -> Result<bool> {
        Ok(false)
    }
}

pub fn default_session_storage_for_bb_home(
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
            // The OS keyring backend exists only on macOS. Elsewhere, default
            // to the file store under bb home so Windows and Linux builds hold
            // a session without every user first exporting BB_AUTH_STORAGE.
            // That file is protected by directory permissions, not a keyring:
            // 0600 on Unix, the user-profile ACL on Windows.
            if cfg!(target_os = "macos") {
                Ok(Box::new(KeyringSessionCredentialStorage))
            } else {
                file_storage_from_env(&bb_home)
            }
        }
        Err(error) => Err(anyhow!("read {BB_AUTH_STORAGE_ENV_VAR}: {error}")),
    }
}

pub fn stored_session_credential_header_value(
    profile: &str,
    server_url: &str,
    bb_home: PathBuf,
) -> Result<Option<String>> {
    let storage = default_session_storage_for_bb_home(bb_home)?;
    let storage_key = SessionStorageKey::new(profile, server_url);
    Ok(storage
        .get(&storage_key)?
        .and_then(|credential| credential.session_credential_header_value()))
}

pub fn stored_session_credential_header_value_for_kgoose_base_url(
    profile: &str,
    base_url: &str,
    service_path: &str,
    bb_home: PathBuf,
) -> Result<Option<String>> {
    for server_url in kgoose_auth_storage_lookup_urls(base_url, service_path) {
        if let Some(credential) =
            stored_session_credential_header_value(profile, &server_url, bb_home.clone())?
        {
            return Ok(Some(credential));
        }
    }

    Ok(None)
}

pub fn kgoose_auth_storage_lookup_urls(base_url: &str, service_path: &str) -> Vec<String> {
    let trimmed = base_url.trim_end_matches('/');
    let mut urls = vec![trimmed.to_string()];
    let service_url = kgoose_service_url(trimmed, service_path);
    if service_url != trimmed {
        urls.push(service_url);
    }
    urls
}

fn supported_storage_values() -> &'static str {
    match (cfg!(target_os = "macos"), cfg!(debug_assertions)) {
        (true, true) => "keyring, memory, file, or file:<path>",
        (true, false) => "keyring, file, or file:<path>",
        (false, true) => "memory, file, or file:<path> (keyring is macOS-only)",
        (false, false) => "file or file:<path> (keyring is macOS-only)",
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

    fn legacy_purpose_tokens_path(&self) -> PathBuf {
        let mut path = self.path.as_os_str().to_os_string();
        path.push(".purpose-tokens");
        PathBuf::from(path)
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

    fn delete_legacy_purpose_token_cache(&self, _key: &SessionStorageKey) -> Result<bool> {
        let path = self.legacy_purpose_tokens_path();
        if !path.exists() {
            return Ok(false);
        }
        // Purpose-token storage has no remaining readers or writers. Remove
        // the obsolete file as a whole instead of rewriting secrets in place.
        fs::remove_file(&path).with_context(|| format!("remove {}", path.display()))?;
        Ok(true)
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

    fn delete_legacy_purpose_token_cache(&self, key: &SessionStorageKey) -> Result<bool> {
        keyring_delete_legacy_compose_token(key)
    }
}

#[cfg(target_os = "macos")]
fn keyring_get(key: &SessionStorageKey) -> Result<Option<StoredSessionCredential>> {
    use crate::keychain;

    let value = keychain::get_generic_password_unscoped(KEYRING_SERVICE, &key.account())
        .context("read BuilderBot auth session from keyring")?;

    match value {
        Some(value) => {
            let value =
                String::from_utf8(value).context("BuilderBot auth keyring entry was not UTF-8")?;
            Ok(Some(parse_stored_session(&value)?))
        }
        None => Ok(None),
    }
}

#[cfg(target_os = "macos")]
fn keyring_set(key: &SessionStorageKey, credential: &StoredSessionCredential) -> Result<()> {
    use crate::keychain;

    let value = serde_json::to_string(credential).context("serialize auth session")?;
    keychain::set_generic_password_unscoped(KEYRING_SERVICE, &key.account(), value.as_bytes())
        .context("write BuilderBot auth session to keyring")
}

#[cfg(target_os = "macos")]
fn keyring_delete(key: &SessionStorageKey) -> Result<bool> {
    use crate::keychain;

    keychain::delete_generic_password_unscoped(KEYRING_SERVICE, &key.account())
        .context("delete BuilderBot auth session from keyring")
}

#[cfg(target_os = "macos")]
fn keyring_delete_legacy_compose_token(key: &SessionStorageKey) -> Result<bool> {
    use crate::keychain;

    keychain::delete_generic_password_unscoped(
        LEGACY_PURPOSE_TOKEN_KEYRING_SERVICE,
        &legacy_compose_token_account(key),
    )
    .context("delete legacy BuilderBot Compose token from keyring")
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
fn keyring_delete_legacy_compose_token(_key: &SessionStorageKey) -> Result<bool> {
    unsupported_keyring_storage()
}

#[cfg(not(target_os = "macos"))]
fn unsupported_keyring_storage<T>() -> Result<T> {
    anyhow::bail!(
        "OS keyring browser auth storage is only implemented on macOS; other platforms default to file storage under bb home, or set {BB_AUTH_STORAGE_ENV_VAR}=file:<path>"
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

fn restrict_permissions(path: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let permissions = fs::Permissions::from_mode(0o600);
        fs::set_permissions(path, permissions)
            .with_context(|| format!("chmod 600 {}", path.display()))?;
    }
    // Windows has no mode bits to tighten; the file inherits the ACL of the
    // user's bb home directory.
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `default_session_storage_for_bb_home` reads process-global environment
    /// variables, so the tests that touch them take this lock and restore the
    /// previous values when the guard drops.
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    struct StorageEnv {
        _guard: std::sync::MutexGuard<'static, ()>,
        saved: Vec<(&'static str, Option<std::ffi::OsString>)>,
    }

    impl StorageEnv {
        fn cleared() -> Self {
            let guard = ENV_LOCK
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let names = [BB_AUTH_STORAGE_ENV_VAR, BB_AUTH_STORAGE_FILE_ENV_VAR];
            let saved = names
                .iter()
                .map(|name| (*name, std::env::var_os(name)))
                .collect();
            for name in names {
                std::env::remove_var(name);
            }
            Self {
                _guard: guard,
                saved,
            }
        }

        fn set(&self, name: &str, value: &str) {
            std::env::set_var(name, value);
        }
    }

    impl Drop for StorageEnv {
        fn drop(&mut self) {
            for (name, value) in self.saved.drain(..) {
                match value {
                    Some(value) => std::env::set_var(name, value),
                    None => std::env::remove_var(name),
                }
            }
        }
    }

    fn scratch_dir(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "bb-auth-storage-{label}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ))
    }

    fn sample_credential() -> StoredSessionCredential {
        StoredSessionCredential {
            session_credential: "session-token".to_string(),
            expires_at: None,
        }
    }

    const SAMPLE_SERVER_URL: &str = "https://kgoose.example.test/cash-app/goose";

    #[test]
    fn default_storage_without_env_matches_the_platform() {
        let _env = StorageEnv::cleared();
        let bb_home = scratch_dir("platform-default");

        let storage = default_session_storage_for_bb_home(bb_home.clone()).expect("storage");

        let expected = if cfg!(target_os = "macos") {
            "keyring"
        } else {
            "file"
        };
        assert_eq!(storage.kind(), expected);
        let _ = fs::remove_dir_all(bb_home);
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn default_file_storage_lives_under_bb_home_and_round_trips() {
        let _env = StorageEnv::cleared();
        let bb_home = scratch_dir("bb-home-default");
        let key = SessionStorageKey::new("default", SAMPLE_SERVER_URL);

        let storage = default_session_storage_for_bb_home(bb_home.clone()).expect("storage");
        storage
            .set(&key, &sample_credential())
            .expect("store credential");

        assert!(
            bb_home.join("auth-sessions.json").is_file(),
            "default file storage must be <bb_home>/auth-sessions.json"
        );
        assert_eq!(
            storage
                .get(&key)
                .expect("read credential")
                .expect("credential")
                .session_credential,
            "session-token"
        );
        assert!(storage.delete(&key).expect("delete credential"));
        assert!(storage.get(&key).expect("read after delete").is_none());
        let _ = fs::remove_dir_all(bb_home);
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn stored_header_value_reads_the_default_file_storage() {
        let _env = StorageEnv::cleared();
        let bb_home = scratch_dir("header-default");
        let key = SessionStorageKey::new("default", SAMPLE_SERVER_URL);

        assert_eq!(
            stored_session_credential_header_value("default", SAMPLE_SERVER_URL, bb_home.clone())
                .expect("lookup before storing"),
            None
        );
        default_session_storage_for_bb_home(bb_home.clone())
            .expect("storage")
            .set(&key, &sample_credential())
            .expect("store credential");

        assert_eq!(
            stored_session_credential_header_value("default", SAMPLE_SERVER_URL, bb_home.clone())
                .expect("lookup after storing"),
            Some("session-token".to_string())
        );
        let _ = fs::remove_dir_all(bb_home);
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn explicit_keyring_request_is_refused_off_macos() {
        let env = StorageEnv::cleared();
        env.set(BB_AUTH_STORAGE_ENV_VAR, "keyring");
        let key = SessionStorageKey::new("default", SAMPLE_SERVER_URL);

        let storage =
            default_session_storage_for_bb_home(scratch_dir("keyring-refused")).expect("storage");

        assert_eq!(storage.kind(), "keyring");
        let error = storage.get(&key).expect_err("keyring is macOS-only");
        assert!(
            error.to_string().contains("only implemented on macOS"),
            "unexpected error: {error}"
        );
    }

    #[test]
    fn explicit_file_path_override_wins_over_the_default() {
        let env = StorageEnv::cleared();
        let directory = scratch_dir("file-path-override");
        let explicit = directory.join("explicit").join("sessions.json");
        env.set(
            BB_AUTH_STORAGE_ENV_VAR,
            &format!("file:{}", explicit.display()),
        );
        let key = SessionStorageKey::new("default", SAMPLE_SERVER_URL);

        let storage =
            default_session_storage_for_bb_home(directory.join("bb-home")).expect("storage");
        storage
            .set(&key, &sample_credential())
            .expect("store credential");

        assert_eq!(storage.kind(), "file");
        assert!(
            explicit.is_file(),
            "credential must land at the explicit path"
        );
        assert!(!directory
            .join("bb-home")
            .join("auth-sessions.json")
            .exists());
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn storage_file_env_var_wins_over_the_default() {
        let env = StorageEnv::cleared();
        let directory = scratch_dir("file-env-override");
        let explicit = directory.join("from-env").join("sessions.json");
        env.set(
            BB_AUTH_STORAGE_FILE_ENV_VAR,
            &explicit.display().to_string(),
        );
        let key = SessionStorageKey::new("default", SAMPLE_SERVER_URL);

        let storage =
            default_session_storage_for_bb_home(directory.join("bb-home")).expect("storage");
        storage
            .set(&key, &sample_credential())
            .expect("store credential");

        assert_eq!(storage.kind(), "file");
        assert!(
            explicit.is_file(),
            "credential must land at BB_AUTH_STORAGE_FILE"
        );
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn unsupported_storage_value_names_the_platform_choices() {
        let env = StorageEnv::cleared();
        env.set(BB_AUTH_STORAGE_ENV_VAR, "cloud");

        let error = default_session_storage_for_bb_home(scratch_dir("unsupported"))
            .err()
            .expect("unsupported storage must fail");

        let message = error.to_string();
        assert!(
            message.contains("file:<path>"),
            "unexpected error: {message}"
        );
        assert_eq!(
            message.contains("keyring, "),
            cfg!(target_os = "macos"),
            "keyring must only be advertised as a choice on macOS: {message}"
        );
    }

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
    fn file_storage_deletes_the_obsolete_legacy_purpose_token_cache() {
        let directory = std::env::temp_dir().join(format!(
            "bb-auth-storage-legacy-compose-delete-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        fs::create_dir_all(&directory).expect("create test directory");
        let storage = FileSessionCredentialStorage::new(directory.join("sessions.json"));
        let local = SessionStorageKey::new("default", "http://localhost:5173");
        let path = storage.legacy_purpose_tokens_path();
        fs::write(&path, b"legacy purpose-token contents").expect("write legacy tokens");

        assert!(storage
            .delete_legacy_purpose_token_cache(&local)
            .expect("delete legacy purpose-token cache"));
        assert!(!storage
            .delete_legacy_purpose_token_cache(&local)
            .expect("delete legacy purpose-token cache again"));
        assert!(!path.exists());

        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn parse_stored_session_accepts_legacy_raw_credential() {
        let stored = parse_stored_session("raw-session").expect("parse raw credential");

        assert_eq!(stored.session_credential, "raw-session");
        assert_eq!(stored.expires_at, None);
    }

    #[test]
    fn kgoose_auth_storage_lookup_urls_includes_legacy_service_url() {
        assert_eq!(
            kgoose_auth_storage_lookup_urls("https://test.blockstaging.build", "/cash-app/goose"),
            vec![
                "https://test.blockstaging.build".to_string(),
                "https://test.blockstaging.build/cash-app/goose".to_string(),
            ]
        );
        assert_eq!(
            kgoose_auth_storage_lookup_urls(
                "https://test.blockstaging.build/cash-app/goose",
                "cash-app/goose"
            ),
            vec!["https://test.blockstaging.build/cash-app/goose".to_string()]
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_keyring_item_shape_uses_legacy_service_and_account() {
        let key =
            SessionStorageKey::new("default", "https://kgoose.stage.sqprod.co/cash-app/goose/");

        assert_eq!(KEYRING_SERVICE, "com.squareup.builderbot.cli-auth");
        assert_eq!(
            key.account(),
            "default@https://kgoose.stage.sqprod.co/cash-app/goose"
        );
        assert_eq!(
            LEGACY_PURPOSE_TOKEN_KEYRING_SERVICE,
            "com.squareup.builderbot.cli-auth-purpose-token"
        );
        assert_eq!(
            legacy_compose_token_account(&key),
            "compose@default@https://kgoose.stage.sqprod.co/cash-app/goose"
        );
    }
}
