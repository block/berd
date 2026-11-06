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
            // That file is protected by file permissions, not a keyring (0600
            // on Unix; on Windows an explicit ACL that no other user can
            // read), replaced atomically, and locked across processes; see
            // FileSessionCredentialStorage.
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

    fn parent_dir(&self) -> PathBuf {
        match self.path.parent() {
            Some(parent) if !parent.as_os_str().is_empty() => parent.to_path_buf(),
            _ => PathBuf::from("."),
        }
    }

    /// Sibling lock file (`<store>.lock`). It holds no secrets and stays on
    /// disk; only the OS lock on it matters.
    fn lock_path(&self) -> PathBuf {
        let mut path = self.path.as_os_str().to_os_string();
        path.push(".lock");
        PathBuf::from(path)
    }

    /// Runs `update` while holding an exclusive OS lock, so the desktop app and
    /// the CLI cannot interleave their read-modify-write cycles and silently
    /// drop each other's entries.
    fn with_exclusive_lock<T>(&self, update: impl FnOnce() -> Result<T>) -> Result<T> {
        let parent = self.parent_dir();
        fs::create_dir_all(&parent).with_context(|| format!("create {}", parent.display()))?;
        let lock_path = self.lock_path();
        let lock = fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(false)
            .open(&lock_path)
            .with_context(|| format!("open {}", lock_path.display()))?;
        lock.lock()
            .with_context(|| format!("lock {}", lock_path.display()))?;
        let result = update();
        lock.unlock()
            .with_context(|| format!("unlock {}", lock_path.display()))?;
        result
    }

    /// Writes the full document to a private temporary sibling, then renames
    /// it over the store. The temporary file is restricted to the current
    /// user before any credential bytes reach it, so no other principal can
    /// observe the document at any point, and readers see either the previous
    /// or the new complete document, never a truncated or half-written one.
    fn write_entries(&self, entries: &BTreeMap<String, StoredSessionCredential>) -> Result<()> {
        let parent = self.parent_dir();
        fs::create_dir_all(&parent).with_context(|| format!("create {}", parent.display()))?;
        let json = serde_json::to_vec_pretty(entries).context("serialize auth session storage")?;
        let file_name = self
            .path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| "auth-sessions.json".to_string());
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|elapsed| elapsed.as_nanos())
            .unwrap_or(0);
        let temp_path = parent.join(format!(".{file_name}.tmp-{}-{nanos}", std::process::id()));
        let written = self.replace_with(&temp_path, &json);
        if written.is_err() {
            let _ = fs::remove_file(&temp_path);
        }
        written
    }

    fn replace_with(&self, temp_path: &Path, json: &[u8]) -> Result<()> {
        use std::io::Write;
        let mut file = create_private_file(temp_path)?;
        file.write_all(json)
            .with_context(|| format!("write {}", temp_path.display()))?;
        file.sync_all()
            .with_context(|| format!("flush {}", temp_path.display()))?;
        drop(file);
        fs::rename(temp_path, &self.path).with_context(|| {
            format!(
                "replace {} with {}",
                self.path.display(),
                temp_path.display()
            )
        })
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
        self.with_exclusive_lock(|| {
            let mut entries = self.read_entries()?;
            entries.insert(key.hashed_id(), credential.clone());
            self.write_entries(&entries)
        })
    }

    fn delete(&self, key: &SessionStorageKey) -> Result<bool> {
        self.with_exclusive_lock(|| {
            let mut entries = self.read_entries()?;
            let removed = entries.remove(&key.hashed_id()).is_some();
            if removed {
                self.write_entries(&entries)?;
            }
            Ok(removed)
        })
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

/// Creates `path` as a new, empty file that no other user can read (see
/// `restrict_permissions`) and returns the open handle. On Unix the 0600 mode is part of the create
/// call, so the process umask never gets a say; on Windows the file is
/// created empty, its ACL is reset with `icacls` while it still holds no
/// bytes, and only then is the handle handed back for writing. Fails if
/// `path` already exists, so a stale temporary file is never reused.
fn create_private_file(path: &Path) -> Result<fs::File> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options
        .open(path)
        .with_context(|| format!("create {}", path.display()))?;
    if let Err(error) = restrict_permissions(path) {
        drop(file);
        let _ = fs::remove_file(path);
        return Err(error);
    }
    Ok(file)
}

/// Makes the credential file unreadable by other users: mode 0600 on Unix.
/// On Windows the ACL is detached from the parent (`/inheritance:r`, so
/// nothing granted on the directory, such as `Users` or `Everyone`, applies)
/// and the current user is granted full control. Any other entry left is
/// one Windows wrote from the creating process's default ACL when the parent
/// passed nothing down: `SYSTEM` and `Administrators`, which can take
/// ownership of any file anyway. That is the same set Windows OpenSSH
/// accepts on a private key, and the Windows counterpart of root still
/// being able to read a 0600 file. Windows uses `icacls`, which ships with
/// every supported release, so no additional dependency is needed.
fn restrict_permissions(path: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let permissions = fs::Permissions::from_mode(0o600);
        fs::set_permissions(path, permissions)
            .with_context(|| format!("chmod 600 {}", path.display()))?;
    }
    #[cfg(windows)]
    {
        let user = match (std::env::var("USERDOMAIN"), std::env::var("USERNAME")) {
            (Ok(domain), Ok(name)) if !domain.is_empty() && !name.is_empty() => {
                format!("{domain}\\{name}")
            }
            (_, Ok(name)) if !name.is_empty() => name,
            _ => anyhow::bail!(
                "cannot restrict {}: USERNAME is not set, so the owner of the credential file is unknown",
                path.display()
            ),
        };
        let output = std::process::Command::new("icacls")
            .arg(path)
            .arg("/inheritance:r")
            .arg("/grant:r")
            .arg(format!("{user}:F"))
            .output()
            .with_context(|| format!("run icacls for {}", path.display()))?;
        if !output.status.success() {
            anyhow::bail!(
                "icacls could not restrict {}: {} {}",
                path.display(),
                String::from_utf8_lossy(&output.stdout).trim(),
                String::from_utf8_lossy(&output.stderr).trim()
            );
        }
    }
    #[cfg(not(any(unix, windows)))]
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

    fn credential(value: impl Into<String>) -> StoredSessionCredential {
        StoredSessionCredential {
            session_credential: value.into(),
            expires_at: None,
        }
    }

    #[test]
    fn concurrent_writers_keep_every_entry() {
        let directory = scratch_dir("concurrent-writers");
        let path = directory.join("sessions.json");
        let writers = 8;
        let rounds = 5;

        let handles: Vec<_> = (0..writers)
            .map(|index| {
                let path = path.clone();
                std::thread::spawn(move || {
                    // Each writer opens its own handle, like a separate process.
                    let storage = FileSessionCredentialStorage::new(path);
                    let key = SessionStorageKey::new(format!("profile-{index}"), SAMPLE_SERVER_URL);
                    for round in 0..rounds {
                        storage
                            .set(&key, &credential(format!("token-{index}-{round}")))
                            .expect("store credential");
                    }
                })
            })
            .collect();
        for handle in handles {
            handle.join().expect("writer thread");
        }

        let storage = FileSessionCredentialStorage::new(path);
        let entries = storage.read_entries().expect("merged file parses");
        assert_eq!(entries.len(), writers, "every writer's entry survives");
        for index in 0..writers {
            let key = SessionStorageKey::new(format!("profile-{index}"), SAMPLE_SERVER_URL);
            assert_eq!(
                storage
                    .get(&key)
                    .expect("read credential")
                    .expect("credential")
                    .session_credential,
                format!("token-{index}-{}", rounds - 1)
            );
        }
        let leftovers: Vec<String> = fs::read_dir(&directory)
            .expect("list directory")
            .filter_map(Result::ok)
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.contains(".tmp-"))
            .collect();
        assert!(
            leftovers.is_empty(),
            "temp files left behind: {leftovers:?}"
        );
        let _ = fs::remove_dir_all(directory);
    }

    const CHILD_WRITER_ENV: &str = "BB_AUTH_STORAGE_TEST_CHILD_PATH";

    /// Second process for `concurrent_processes_keep_every_entry`. Runs as a
    /// plain test but does nothing unless the parent set `CHILD_WRITER_ENV`.
    #[test]
    fn file_storage_child_writer() {
        let Some(path) = std::env::var_os(CHILD_WRITER_ENV) else {
            return;
        };
        let storage = FileSessionCredentialStorage::new(PathBuf::from(path));
        let key = SessionStorageKey::new("child", SAMPLE_SERVER_URL);
        for round in 0..25 {
            storage
                .set(&key, &credential(format!("child-{round}")))
                .expect("child stores credential");
        }
    }

    #[test]
    fn concurrent_processes_keep_every_entry() {
        let directory = scratch_dir("concurrent-processes");
        let path = directory.join("sessions.json");
        let mut child = std::process::Command::new(std::env::current_exe().expect("test binary"))
            .args([
                "--exact",
                "auth_storage::tests::file_storage_child_writer",
                "--test-threads=1",
            ])
            .env(CHILD_WRITER_ENV, &path)
            .stdout(std::process::Stdio::null())
            .spawn()
            .expect("spawn child writer");

        let storage = FileSessionCredentialStorage::new(path);
        let parent_key = SessionStorageKey::new("parent", SAMPLE_SERVER_URL);
        for round in 0..25 {
            storage
                .set(&parent_key, &credential(format!("parent-{round}")))
                .expect("parent stores credential");
        }
        let status = child.wait().expect("wait for child writer");
        assert!(status.success(), "child writer failed: {status}");

        let entries = storage.read_entries().expect("merged file parses");
        assert_eq!(entries.len(), 2, "both processes' entries survive");
        assert_eq!(
            storage
                .get(&parent_key)
                .expect("read parent")
                .expect("parent credential")
                .session_credential,
            "parent-24"
        );
        assert_eq!(
            storage
                .get(&SessionStorageKey::new("child", SAMPLE_SERVER_URL))
                .expect("read child")
                .expect("child credential")
                .session_credential,
            "child-24"
        );
        let _ = fs::remove_dir_all(directory);
    }

    #[cfg(windows)]
    #[test]
    fn windows_default_bb_home_uses_the_user_profile_when_home_is_absent() {
        let _guard = ENV_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let saved_home = std::env::var_os("HOME");
        let saved_profile = std::env::var_os("USERPROFILE");
        let profile = scratch_dir("userprofile");

        std::env::remove_var("HOME");
        std::env::set_var("USERPROFILE", &profile);
        let bb_home = crate::config::default_bb_home();

        match saved_home {
            Some(value) => std::env::set_var("HOME", value),
            None => std::env::remove_var("HOME"),
        }
        match saved_profile {
            Some(value) => std::env::set_var("USERPROFILE", value),
            None => std::env::remove_var("USERPROFILE"),
        }

        assert!(
            bb_home.is_absolute(),
            "bb home must not be cwd-relative: {}",
            bb_home.display()
        );
        assert_eq!(bb_home, profile.join(".bb"));
    }

    #[cfg(windows)]
    #[test]
    fn windows_file_storage_grants_only_the_current_user() {
        let directory = scratch_dir("acl");
        let path = directory.join("sessions.json");
        let storage = FileSessionCredentialStorage::new(path.clone());
        storage
            .set(
                &SessionStorageKey::new("default", SAMPLE_SERVER_URL),
                &sample_credential(),
            )
            .expect("store credential");

        assert_private(&path, "credential store");
        let _ = fs::remove_dir_all(directory);
    }

    /// A parent that grants other users access but passes nothing down makes
    /// Windows stamp new files from the process's default ACL instead of
    /// inheriting; the store must still end up private. This reproduces the
    /// GitHub Windows runner's temp directory on any machine.
    #[cfg(windows)]
    #[test]
    fn windows_file_storage_is_private_when_the_parent_passes_nothing_down() {
        let directory = scratch_dir("acl-no-inherit");
        fs::create_dir_all(&directory).expect("scratch dir");
        let status = std::process::Command::new("icacls")
            .arg(&directory)
            .args(["/inheritance:r", "/grant:r", "*S-1-5-32-545:(RX)"])
            .arg("/grant")
            .arg(format!(
                "{}\\{}:(F)",
                std::env::var("USERDOMAIN").expect("USERDOMAIN"),
                std::env::var("USERNAME").expect("USERNAME")
            ))
            .output()
            .expect("icacls sets the parent ACL");
        assert!(status.status.success(), "parent ACL setup failed");
        let path = directory.join("sessions.json");
        let storage = FileSessionCredentialStorage::new(path.clone());
        storage
            .set(
                &SessionStorageKey::new("default", SAMPLE_SERVER_URL),
                &sample_credential(),
            )
            .expect("store credential");

        assert_private(&path, "credential store under a non-inheriting parent");
        let _ = fs::remove_dir_all(directory);
    }

    /// Asserts that no other user can access `path`: mode 0600 on Unix. On
    /// Windows, no entry is inherited, the current user holds full control,
    /// and every other entry is `SYSTEM` or `Administrators` (present only
    /// when the parent passed nothing down and Windows applied the creating
    /// process's default ACL, which is how GitHub's Windows runners create
    /// files in their temp directory).
    fn assert_private(path: &Path, what: &str) {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(path).expect("metadata").permissions().mode() & 0o777;
            assert_eq!(mode, 0o600, "{what} must be mode 0600, got {mode:o}");
        }
        #[cfg(windows)]
        {
            let output = std::process::Command::new("icacls")
                .arg(path)
                .output()
                .expect("icacls lists the ACL");
            assert!(output.status.success(), "icacls failed for {what}");
            let listing = String::from_utf8_lossy(&output.stdout);
            // icacls prints `<path> <principal>:(<rights>)` on the first line
            // and `<padding><principal>:(<rights>)` on the rest.
            let echoed_path = path.to_string_lossy();
            let aces: Vec<(String, String)> = listing
                .lines()
                .filter(|line| line.contains(":("))
                .map(|line| {
                    let entry = line
                        .strip_prefix(echoed_path.as_ref())
                        .unwrap_or(line)
                        .trim();
                    let (principal, rights) = entry.split_once(":(").expect("ACE shape");
                    (principal.trim().to_lowercase(), rights.to_string())
                })
                .collect();
            let user = std::env::var("USERNAME").expect("USERNAME").to_lowercase();
            let is_user =
                |principal: &str| principal == user || principal.ends_with(&format!("\\{user}"));
            assert!(
                aces.iter()
                    .any(|(principal, rights)| is_user(principal) && rights.starts_with("F)")),
                "{what}: the current user must hold full control:\n{listing}"
            );
            for (principal, rights) in &aces {
                assert!(
                    !rights.contains("(I)") && !rights.starts_with("I)"),
                    "{what}: no entry may be inherited from the parent:\n{listing}"
                );
                assert!(
                    is_user(principal)
                        || principal == "nt authority\\system"
                        || principal == "builtin\\administrators",
                    "{what}: {principal} must not have access:\n{listing}"
                );
            }
        }
        #[cfg(not(any(unix, windows)))]
        let _ = (path, what);
    }

    #[test]
    fn private_temp_file_is_restricted_before_any_bytes_are_written() {
        use std::io::Write;
        let directory = scratch_dir("private-temp");
        fs::create_dir_all(&directory).expect("scratch dir");
        let path = directory.join(".sessions.json.tmp-test");

        let mut file = create_private_file(&path).expect("create private file");
        assert_eq!(
            fs::metadata(&path).expect("metadata").len(),
            0,
            "the file must be private before it holds any bytes"
        );
        assert_private(&path, "empty temporary file");

        file.write_all(b"{\"secret\":true}").expect("write");
        file.sync_all().expect("sync");
        drop(file);
        assert_private(&path, "written temporary file");
        assert_eq!(fs::read(&path).expect("read"), b"{\"secret\":true}");
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn private_temp_file_never_reuses_an_existing_path() {
        let directory = scratch_dir("private-temp-existing");
        fs::create_dir_all(&directory).expect("scratch dir");
        let path = directory.join("existing");
        fs::write(&path, b"stale").expect("seed");

        let error = create_private_file(&path).expect_err("an existing path must be refused");
        assert!(error.to_string().contains("create"), "{error}");
        assert_eq!(
            fs::read(&path).expect("read"),
            b"stale",
            "the existing file is left untouched"
        );
        let _ = fs::remove_dir_all(directory);
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
