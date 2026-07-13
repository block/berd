use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use builderbot_auth::auth_login::{
    build_auth_http_client, exchange_login_code_and_verify, login_url, logout_session_credential,
    verify_session_credential, AuthMeResponse,
};
use builderbot_auth::auth_storage::{
    default_session_storage_for_bb_home,
    stored_session_credential_header_value_for_kgoose_base_url, SessionStorageKey,
    StoredSessionCredential,
};
use builderbot_auth::config::{
    default_bb_home, default_preferences_path, kgoose_service_url,
    normalize_kgoose_base_url_with_service_path, normalize_kgoose_service_path, read_optional_env,
    read_preferences_file, write_preferences_file, BB_HOME_ENV_VAR, BB_SKILLS_PROFILE_ENV_VAR,
    DEFAULT_KGOOSE_SERVICE_PATH, DEFAULT_PROFILE_NAME, KGOOSE_SERVICE_PATH_ENV_VAR,
};
use builderbot_auth::org_routing::{normalize_org, resolve_org_kgoose_base_url};
use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;
use url::Url;

const DEFAULT_KGOOSE_BASE_URL: &str = "https://kgoose.sqprod.co";
const KGOOSE_BASE_URL_ENV_VAR: &str = "KGOOSE_BASE_URL";
const BB_KGOOSE_PLAYPEN_ENV_VAR: &str = "BB_KGOOSE_PLAYPEN";
const KGOOSE_PLAYPEN_ENV_VAR: &str = "KGOOSE_PLAYPEN";
const BB_SKILLS_CONFIG_ENV_VAR: &str = "BB_SKILLS_CONFIG";
const SKILLS_CONFIG_FILE_NAME: &str = "skills.yaml";
const CALLBACK_PATH: &str = "/callback";
const CANCEL_CALLBACK_PATH: &str = "/cancel";
const AUTH_HTTP_TIMEOUT: Duration = Duration::from_secs(30);
const LOOPBACK_CONNECT_TIMEOUT: Duration = Duration::from_secs(1);

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AuthStatus {
    pub logged_in: bool,
    pub requires_org: bool,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub org: Option<String>,
    pub profile: String,
    pub kgoose_base_url: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub expires_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub user: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub email: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub user_id: Option<String>,
}

#[derive(Debug, Clone)]
struct AuthContext {
    bb_home: PathBuf,
    org: Option<String>,
    profile: String,
    kgoose_base_url: String,
    kgoose_service_path: String,
    kgoose_service_url: String,
    playpen: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct VerifiedAuthContext {
    pub session_credential: String,
    pub user: String,
}

#[derive(Debug, Default, Deserialize)]
struct SkillsFileConfig {
    current_profile: Option<String>,
}

#[derive(Debug, Clone, Copy)]
struct LoginAttempt {
    id: u64,
    callback_addr: SocketAddr,
    callback_received: bool,
    canceled: bool,
}

fn login_attempt_state() -> &'static Mutex<Option<LoginAttempt>> {
    static STATE: OnceLock<Mutex<Option<LoginAttempt>>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(None))
}

fn next_login_attempt_id() -> u64 {
    static NEXT_ID: AtomicU64 = AtomicU64::new(1);
    NEXT_ID.fetch_add(1, Ordering::Relaxed)
}

#[tauri::command]
pub async fn auth_status() -> Result<AuthStatus, String> {
    tauri::async_runtime::spawn_blocking(auth_status_blocking)
        .await
        .map_err(|error| format!("BuilderBot auth status task failed: {error}"))?
        .map_err(auth_error)
}

#[tauri::command]
pub async fn start_login(app_handle: AppHandle, org: Option<String>) -> Result<AuthStatus, String> {
    run_login_command(app_handle, org).await
}

#[tauri::command]
pub async fn login(app_handle: AppHandle, org: Option<String>) -> Result<AuthStatus, String> {
    run_login_command(app_handle, org).await
}

#[tauri::command]
pub async fn cancel_login() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(cancel_login_blocking)
        .await
        .map_err(|error| format!("BuilderBot auth cancel task failed: {error}"))?
        .map_err(auth_error)
}

#[tauri::command]
pub async fn logout() -> Result<AuthStatus, String> {
    tauri::async_runtime::spawn_blocking(logout_blocking)
        .await
        .map_err(|error| format!("BuilderBot auth logout task failed: {error}"))?
        .map_err(auth_error)
}

pub(crate) async fn verified_auth_context() -> Result<VerifiedAuthContext, String> {
    tauri::async_runtime::spawn_blocking(verified_auth_context_blocking)
        .await
        .map_err(|error| format!("BuilderBot auth task failed: {error}"))?
        .map_err(auth_error)
}

async fn run_login_command(
    app_handle: AppHandle,
    org: Option<String>,
) -> Result<AuthStatus, String> {
    tauri::async_runtime::spawn_blocking(move || login_blocking(app_handle, org))
        .await
        .map_err(|error| format!("BuilderBot auth login task failed: {error}"))?
        .map_err(auth_error)
}

fn auth_status_blocking() -> Result<AuthStatus> {
    let context = resolve_auth_context(None, false)?;
    status_for_context(&context)
}

fn register_login_attempt(callback_addr: SocketAddr) -> u64 {
    let id = next_login_attempt_id();
    *login_attempt_state()
        .lock()
        .expect("login attempt state mutex poisoned") = Some(LoginAttempt {
        id,
        callback_addr,
        callback_received: false,
        canceled: false,
    });
    id
}

fn clear_login_attempt_if_current(id: u64) {
    let mut current = login_attempt_state()
        .lock()
        .expect("login attempt state mutex poisoned");
    if current.is_some_and(|attempt| attempt.id == id) {
        *current = None;
    }
}

fn mark_login_attempt_callback_received(id: u64) {
    let mut current = login_attempt_state()
        .lock()
        .expect("login attempt state mutex poisoned");
    if let Some(attempt) = current.as_mut().filter(|attempt| attempt.id == id) {
        attempt.callback_received = true;
    }
}

fn is_login_attempt_canceled(id: u64) -> bool {
    login_attempt_state()
        .lock()
        .expect("login attempt state mutex poisoned")
        .is_some_and(|attempt| attempt.id == id && attempt.canceled)
}

fn complete_login_attempt_if_not_canceled(id: u64) -> bool {
    let mut current = login_attempt_state()
        .lock()
        .expect("login attempt state mutex poisoned");
    let Some(attempt) = current.as_ref().filter(|attempt| attempt.id == id) else {
        return false;
    };
    if attempt.canceled {
        *current = None;
        return false;
    }
    *current = None;
    true
}

fn cancel_login_blocking() -> Result<()> {
    let Some(attempt) = mark_login_attempt_canceled() else {
        return Ok(());
    };

    if attempt.callback_received {
        return Ok(());
    }

    let stream = TcpStream::connect_timeout(&attempt.callback_addr, LOOPBACK_CONNECT_TIMEOUT)
        .with_context(|| format!("connect to auth callback at {}", attempt.callback_addr))?;
    stream
        .set_write_timeout(Some(LOOPBACK_CONNECT_TIMEOUT))
        .context("set auth cancel write timeout")?;
    write_cancel_request(stream)
}

fn mark_login_attempt_canceled() -> Option<LoginAttempt> {
    let mut current = login_attempt_state()
        .lock()
        .expect("login attempt state mutex poisoned");
    let attempt = current.as_mut()?;
    attempt.canceled = true;
    Some(*attempt)
}

fn login_blocking(app_handle: AppHandle, org: Option<String>) -> Result<AuthStatus> {
    let context = resolve_auth_context(org.as_deref(), true)?;
    if context.org.is_none() {
        return Ok(AuthStatus::logged_out(&context, true));
    }

    let storage = default_session_storage_for_bb_home(context.bb_home.clone())?;
    let storage_key = session_storage_key(&context);
    let client = build_auth_http_client(AUTH_HTTP_TIMEOUT)?;

    if let Some(stored) = storage.get(&storage_key)? {
        if let Some(me) = verify_session_credential(
            &client,
            context.playpen.as_deref(),
            &context.kgoose_service_url,
            &stored,
        )? {
            return Ok(AuthStatus::logged_in_from_me(&context, &stored, me));
        }
    }

    let listener = TcpListener::bind("127.0.0.1:0").context("listen on loopback callback port")?;
    let callback_addr = listener.local_addr()?;
    let attempt_id = register_login_attempt(callback_addr);
    let callback_url = format!("http://{}{}", callback_addr, CALLBACK_PATH);
    let login_url = login_url(&context.kgoose_service_url, &callback_url)?;
    if let Err(error) = app_handle
        .opener()
        .open_url(login_url.as_str(), None::<&str>)
        .with_context(|| format!("open BuilderBot auth login URL {}", login_url.as_str()))
    {
        clear_login_attempt_if_current(attempt_id);
        return Err(error);
    }

    let code = match receive_exchange_code(listener) {
        Ok(code) => code,
        Err(error) => {
            clear_login_attempt_if_current(attempt_id);
            return Err(error);
        }
    };
    mark_login_attempt_callback_received(attempt_id);
    if is_login_attempt_canceled(attempt_id) {
        clear_login_attempt_if_current(attempt_id);
        return Err(anyhow!("BuilderBot auth login was canceled"));
    }
    let verified = match exchange_login_code_and_verify(
        &client,
        context.playpen.as_deref(),
        &context.kgoose_service_url,
        &code,
    ) {
        Ok(exchange) => exchange,
        Err(error) => {
            clear_login_attempt_if_current(attempt_id);
            return Err(error);
        }
    };
    if !complete_login_attempt_if_not_canceled(attempt_id) {
        return Err(anyhow!("BuilderBot auth login was canceled"));
    }
    let stored = verified.credential;
    let me = verified.me;
    storage.set(&storage_key, &stored)?;

    Ok(AuthStatus::logged_in_from_me(&context, &stored, me))
}

fn logout_blocking() -> Result<AuthStatus> {
    let context = resolve_auth_context(None, false)?;
    if context.org.is_none() {
        return Ok(AuthStatus::logged_out(&context, true));
    }

    let storage = default_session_storage_for_bb_home(context.bb_home.clone())?;
    let storage_key = session_storage_key(&context);
    if let Some(stored) = storage.get(&storage_key)? {
        let client = build_auth_http_client(AUTH_HTTP_TIMEOUT)?;
        if let Err(error) = logout_session_credential(
            &client,
            context.playpen.as_deref(),
            &context.kgoose_service_url,
            &stored,
        ) {
            log::warn!("failed to destroy server auth session during logout: {error:#}");
        }
    }
    storage.delete(&storage_key)?;
    Ok(AuthStatus::logged_out(&context, false))
}

fn status_for_context(context: &AuthContext) -> Result<AuthStatus> {
    if context.org.is_none() {
        return Ok(AuthStatus::logged_out(context, true));
    }

    let storage = default_session_storage_for_bb_home(context.bb_home.clone())?;
    let Some(stored) = storage.get(&session_storage_key(context))? else {
        return Ok(AuthStatus::logged_out(context, false));
    };

    let client = build_auth_http_client(AUTH_HTTP_TIMEOUT)?;
    match verify_session_credential(
        &client,
        context.playpen.as_deref(),
        &context.kgoose_service_url,
        &stored,
    )? {
        Some(me) => Ok(AuthStatus::logged_in_from_me(context, &stored, me)),
        None => Ok(AuthStatus::logged_out(context, false)),
    }
}

fn verified_auth_context_blocking() -> Result<VerifiedAuthContext> {
    let context = resolve_auth_context(None, false)?;
    context
        .org
        .as_ref()
        .ok_or_else(|| anyhow!("org is not configured; log in to BuilderBot and try again"))?;
    let storage = default_session_storage_for_bb_home(context.bb_home.clone())?;
    let stored = storage
        .get(&session_storage_key(&context))?
        .ok_or_else(|| anyhow!("BuilderBot session is missing; log in and try again"))?;
    let session_credential = stored
        .session_credential_header_value()
        .ok_or_else(|| anyhow!("BuilderBot session credential is empty; log in again"))?;
    let client = build_auth_http_client(AUTH_HTTP_TIMEOUT)?;
    let me = verify_session_credential(
        &client,
        context.playpen.as_deref(),
        &context.kgoose_service_url,
        &stored,
    )?
    .ok_or_else(|| anyhow!("BuilderBot session is no longer valid; log in again"))?;
    let user_id = me.subject;
    let user = builderbot_user(me.email.as_ref(), me.name.as_ref(), user_id.as_ref()).ok_or_else(
        || anyhow!("BuilderBot auth identity did not include an email, name, or user id"),
    )?;

    Ok(VerifiedAuthContext {
        session_credential,
        user,
    })
}

pub(crate) fn route_kgoose_base_url_for_shared_org(base_url: &str) -> Result<String> {
    let bb_home = read_trimmed_env(BB_HOME_ENV_VAR)?
        .map(PathBuf::from)
        .unwrap_or_else(default_bb_home);
    let preferences = read_preferences_file(&default_preferences_path(&bb_home))?;
    let org = preferences.org.as_deref().map(normalize_org).transpose()?;
    let kgoose_service_path = resolve_kgoose_service_path()?;

    resolve_org_kgoose_base_url(base_url, org.as_deref(), false, &kgoose_service_path)
}

pub(crate) fn shared_session_credential_for_kgoose_base_url(
    request_base_url: &str,
) -> Result<Option<String>> {
    let context = resolve_auth_context(None, false)?;
    if context.org.is_none() {
        return Ok(None);
    }

    if let Some(session_credential) = stored_session_credential_header_value_for_kgoose_base_url(
        &context.profile,
        request_base_url,
        &context.kgoose_service_path,
        context.bb_home.clone(),
    )? {
        return Ok(Some(session_credential));
    }

    Ok(None)
}

fn resolve_auth_context(org_override: Option<&str>, persist_org: bool) -> Result<AuthContext> {
    let bb_home = read_trimmed_env(BB_HOME_ENV_VAR)?
        .map(PathBuf::from)
        .unwrap_or_else(default_bb_home);
    let preferences_path = default_preferences_path(&bb_home);
    let mut preferences = read_preferences_file(&preferences_path)?;

    if let Some(org_override) = org_override {
        let org = normalize_org(org_override)?;
        if preferences.org.as_deref() != Some(org.as_str()) {
            preferences.org = Some(org);
            if persist_org {
                write_preferences_file(&preferences_path, &preferences)?;
            }
        }
    }

    let org = preferences.org.as_deref().map(normalize_org).transpose()?;
    let profile = resolve_profile(&bb_home)?;
    let kgoose_service_path = resolve_kgoose_service_path()?;
    let raw_kgoose_base_url = resolve_raw_kgoose_base_url(&kgoose_service_path)?;
    let kgoose_base_url = resolve_org_kgoose_base_url(
        &raw_kgoose_base_url,
        org.as_deref(),
        false,
        &kgoose_service_path,
    )?;
    let kgoose_service_url = kgoose_service_url(&kgoose_base_url, &kgoose_service_path);
    let playpen = resolve_playpen()?;

    Ok(AuthContext {
        bb_home,
        org,
        profile,
        kgoose_base_url,
        kgoose_service_path,
        kgoose_service_url,
        playpen,
    })
}

fn resolve_profile(bb_home: &Path) -> Result<String> {
    if let Some(profile) = read_trimmed_env(BB_SKILLS_PROFILE_ENV_VAR)? {
        return Ok(profile);
    }

    let skills_config_path = read_trimmed_env(BB_SKILLS_CONFIG_ENV_VAR)?
        .map(PathBuf::from)
        .unwrap_or_else(|| bb_home.join(SKILLS_CONFIG_FILE_NAME));
    if !skills_config_path.exists() {
        return Ok(DEFAULT_PROFILE_NAME.to_string());
    }

    let bytes = fs::read(&skills_config_path)
        .with_context(|| format!("read {}", skills_config_path.display()))?;
    let skills_config: SkillsFileConfig = yaml_serde::from_slice(&bytes)
        .with_context(|| format!("parse {}", skills_config_path.display()))?;
    Ok(skills_config
        .current_profile
        .map(|profile| profile.trim().to_string())
        .filter(|profile| !profile.is_empty())
        .unwrap_or_else(|| DEFAULT_PROFILE_NAME.to_string()))
}

fn resolve_raw_kgoose_base_url(kgoose_service_path: &str) -> Result<String> {
    Ok(read_trimmed_env(KGOOSE_BASE_URL_ENV_VAR)?
        .map(|value| normalize_kgoose_base_url_with_service_path(&value, kgoose_service_path))
        .unwrap_or_else(|| DEFAULT_KGOOSE_BASE_URL.to_string()))
}

fn resolve_kgoose_service_path() -> Result<String> {
    read_trimmed_env(KGOOSE_SERVICE_PATH_ENV_VAR)?
        .map(|value| normalize_kgoose_service_path(&value))
        .transpose()
        .map(|path| path.unwrap_or_else(|| DEFAULT_KGOOSE_SERVICE_PATH.to_string()))
}

fn resolve_playpen() -> Result<Option<String>> {
    Ok(read_trimmed_env(BB_KGOOSE_PLAYPEN_ENV_VAR)?.or(read_trimmed_env(KGOOSE_PLAYPEN_ENV_VAR)?))
}

fn read_trimmed_env(name: &str) -> Result<Option<String>> {
    Ok(read_optional_env(name)?
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty()))
}

fn session_storage_key(context: &AuthContext) -> SessionStorageKey {
    SessionStorageKey::from_profile_and_kgoose_base_url(
        context.profile.clone(),
        &context.kgoose_base_url,
        &context.kgoose_service_path,
    )
}

fn receive_exchange_code(listener: TcpListener) -> Result<String> {
    for stream in listener.incoming() {
        let stream = stream.context("accept loopback auth callback")?;
        if let Some(code) = handle_callback_stream(stream)? {
            return Ok(code);
        }
    }

    Err(anyhow!(
        "loopback auth server stopped without receiving a callback"
    ))
}

fn handle_callback_stream(mut stream: TcpStream) -> Result<Option<String>> {
    let mut reader = BufReader::new(stream.try_clone().context("clone callback stream")?);
    let mut request_line = String::new();
    reader
        .read_line(&mut request_line)
        .context("read callback request line")?;
    while {
        let mut header = String::new();
        reader
            .read_line(&mut header)
            .context("read callback header")?;
        header != "\r\n" && !header.is_empty()
    } {}

    let request_target = request_line
        .split_whitespace()
        .nth(1)
        .ok_or_else(|| anyhow!("auth callback request did not include a path"))?;
    let parsed = Url::parse(&format!("http://127.0.0.1{request_target}"))
        .context("parse loopback callback URL")?;

    if parsed.path() == CANCEL_CALLBACK_PATH {
        write_loopback_response(&mut stream, 200, "BuilderBot auth canceled.")?;
        return Err(anyhow!("BuilderBot auth login was canceled"));
    }

    if parsed.path() != CALLBACK_PATH {
        write_loopback_response(
            &mut stream,
            404,
            "BuilderBot auth is waiting for the callback.",
        )?;
        return Ok(None);
    }

    if let Some(error) = parsed
        .query_pairs()
        .find(|(key, _)| key == "error")
        .map(|(_, value)| value.into_owned())
    {
        write_loopback_response(&mut stream, 400, "BuilderBot auth failed. Return to Goose.")?;
        return Err(anyhow!("auth callback returned error: {error}"));
    }

    let code = parsed
        .query_pairs()
        .find(|(key, _)| key == "code")
        .map(|(_, value)| value.into_owned())
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| anyhow!("auth callback did not include an exchange code"))?;
    write_loopback_response(
        &mut stream,
        200,
        "BuilderBot auth complete. Return to Goose.",
    )?;
    Ok(Some(code))
}

fn write_cancel_request(mut stream: TcpStream) -> Result<()> {
    let request = format!(
        "GET {CANCEL_CALLBACK_PATH} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n"
    );
    stream
        .write_all(request.as_bytes())
        .context("write auth cancel request")
}

fn write_loopback_response(stream: &mut TcpStream, status: u16, body: &str) -> Result<()> {
    let status_text = match status {
        200 => "OK",
        400 => "Bad Request",
        404 => "Not Found",
        _ => "OK",
    };
    let response = format!(
        "HTTP/1.1 {status} {status_text}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    stream
        .write_all(response.as_bytes())
        .context("write loopback callback response")
}

fn best_user(
    email: Option<&String>,
    name: Option<&String>,
    user_id: Option<&String>,
) -> Option<String> {
    email
        .cloned()
        .or_else(|| name.cloned())
        .or_else(|| user_id.cloned())
}

fn builderbot_user(
    email: Option<&String>,
    name: Option<&String>,
    user_id: Option<&String>,
) -> Option<String> {
    // Direct BuilderBot APIs are keyed by the short user name. The verified
    // auth identity normally carries email, so trim it to the local part.
    email
        .and_then(|email| short_user_from_email(email))
        .or_else(|| name.cloned())
        .or_else(|| user_id.cloned())
}

fn short_user_from_email(email: &str) -> Option<String> {
    let trimmed = email.trim();
    let local_part = trimmed
        .split_once('@')
        .map(|(local_part, _)| local_part)
        .unwrap_or(trimmed)
        .trim();
    (!local_part.is_empty()).then(|| local_part.to_string())
}

fn auth_error(error: anyhow::Error) -> String {
    format!("BuilderBot auth failed: {error:#}")
}

impl AuthStatus {
    fn logged_out(context: &AuthContext, requires_org: bool) -> Self {
        Self {
            logged_in: false,
            requires_org,
            org: context.org.clone(),
            profile: context.profile.clone(),
            kgoose_base_url: context.kgoose_base_url.clone(),
            expires_at: None,
            user: None,
            email: None,
            name: None,
            user_id: None,
        }
    }

    fn logged_in_from_me(
        context: &AuthContext,
        stored: &StoredSessionCredential,
        me: AuthMeResponse,
    ) -> Self {
        let user_id = me.subject;
        let expires_at = me.expires_at.or_else(|| stored.expires_at.clone());
        Self {
            logged_in: true,
            requires_org: false,
            org: context.org.clone(),
            profile: context.profile.clone(),
            kgoose_base_url: context.kgoose_base_url.clone(),
            expires_at,
            user: best_user(me.email.as_ref(), me.name.as_ref(), user_id.as_ref()),
            email: me.email,
            name: me.name,
            user_id,
        }
    }
}

#[cfg(test)]
mod tests {
    use std::env;
    use std::io::{BufRead, BufReader, Write};
    use std::net::{SocketAddr, TcpListener, TcpStream};
    use std::thread;

    use crate::test_support::env_lock;

    use super::*;
    use builderbot_auth::auth::SESSION_CREDENTIAL_HEADER;
    use builderbot_auth::auth_storage::{
        FileSessionCredentialStorage, SessionCredentialStorage, BB_AUTH_STORAGE_ENV_VAR,
        BB_AUTH_STORAGE_FILE_ENV_VAR,
    };
    use builderbot_auth::preferences::BuilderBotPreferences;
    use tempfile::tempdir;

    fn clear_auth_env() {
        env::remove_var(BB_HOME_ENV_VAR);
        env::remove_var(BB_SKILLS_PROFILE_ENV_VAR);
        env::remove_var(BB_SKILLS_CONFIG_ENV_VAR);
        env::remove_var(KGOOSE_BASE_URL_ENV_VAR);
        env::remove_var(KGOOSE_SERVICE_PATH_ENV_VAR);
        env::remove_var(BB_KGOOSE_PLAYPEN_ENV_VAR);
        env::remove_var(KGOOSE_PLAYPEN_ENV_VAR);
        env::remove_var(BB_AUTH_STORAGE_ENV_VAR);
        env::remove_var(BB_AUTH_STORAGE_FILE_ENV_VAR);
    }

    fn write_test_preferences(bb_home: &Path, org: &str) {
        write_preferences_file(
            &default_preferences_path(bb_home),
            &BuilderBotPreferences {
                org: Some(org.to_string()),
                ..Default::default()
            },
        )
        .expect("write preferences");
    }

    fn write_test_session(storage_path: PathBuf, base_url: &str, session_credential: &str) {
        write_test_session_with_service_path(
            storage_path,
            base_url,
            DEFAULT_KGOOSE_SERVICE_PATH,
            session_credential,
        );
    }

    fn write_test_session_with_service_path(
        storage_path: PathBuf,
        base_url: &str,
        service_path: &str,
        session_credential: &str,
    ) {
        let storage = FileSessionCredentialStorage::new(storage_path);
        storage
            .set(
                &SessionStorageKey::from_profile_and_kgoose_base_url(
                    DEFAULT_PROFILE_NAME,
                    base_url,
                    service_path,
                ),
                &StoredSessionCredential {
                    session_credential: session_credential.to_string(),
                    expires_at: Some("2026-06-25T00:00:00Z".to_string()),
                },
            )
            .expect("write session");
    }

    #[test]
    fn resolve_auth_context_requires_org_when_preferences_are_empty() {
        let _guard = env_lock().lock().expect("env lock");
        clear_auth_env();
        let dir = tempdir().expect("tempdir");
        env::set_var(BB_HOME_ENV_VAR, dir.path());

        let context = resolve_auth_context(None, false).expect("resolve auth context");
        let status = AuthStatus::logged_out(&context, context.org.is_none());

        assert_eq!(context.profile, DEFAULT_PROFILE_NAME);
        assert_eq!(context.org, None);
        assert_eq!(context.kgoose_base_url, DEFAULT_KGOOSE_BASE_URL);
        assert!(status.requires_org);

        clear_auth_env();
    }

    #[test]
    fn resolve_auth_context_stores_login_org_and_routes_kgoose() {
        let _guard = env_lock().lock().expect("env lock");
        clear_auth_env();
        let dir = tempdir().expect("tempdir");
        env::set_var(BB_HOME_ENV_VAR, dir.path());
        env::set_var(KGOOSE_BASE_URL_ENV_VAR, "https://blockstaging.build");

        let context = resolve_auth_context(Some(" Test "), true).expect("resolve auth context");
        let preferences =
            read_preferences_file(&default_preferences_path(dir.path())).expect("read prefs");

        assert_eq!(context.org.as_deref(), Some("test"));
        assert_eq!(context.kgoose_base_url, "https://test.blockstaging.build");
        assert_eq!(
            context.kgoose_service_url,
            "https://test.blockstaging.build/cash-app/goose"
        );
        assert_eq!(preferences.org.as_deref(), Some("test"));

        clear_auth_env();
    }

    #[test]
    fn resolve_auth_context_honors_custom_kgoose_service_path() {
        let _guard = env_lock().lock().expect("env lock");
        clear_auth_env();
        let dir = tempdir().expect("tempdir");
        env::set_var(BB_HOME_ENV_VAR, dir.path());
        env::set_var(
            KGOOSE_BASE_URL_ENV_VAR,
            "https://blockstaging.build/cash-app/goose-square",
        );
        env::set_var(KGOOSE_SERVICE_PATH_ENV_VAR, "cash-app/goose-square");

        let context = resolve_auth_context(Some(" Test "), true).expect("resolve auth context");

        assert_eq!(context.org.as_deref(), Some("test"));
        assert_eq!(context.kgoose_base_url, "https://test.blockstaging.build");
        assert_eq!(context.kgoose_service_path, "/cash-app/goose-square");
        assert_eq!(
            context.kgoose_service_url,
            "https://test.blockstaging.build/cash-app/goose-square"
        );

        clear_auth_env();
    }

    #[test]
    fn resolve_auth_context_reads_current_profile_from_skills_config() {
        let _guard = env_lock().lock().expect("env lock");
        clear_auth_env();
        let dir = tempdir().expect("tempdir");
        fs::write(
            dir.path().join(SKILLS_CONFIG_FILE_NAME),
            "current_profile: work\n",
        )
        .expect("write skills config");
        env::set_var(BB_HOME_ENV_VAR, dir.path());

        let context = resolve_auth_context(None, false).expect("resolve auth context");

        assert_eq!(context.profile, "work");

        clear_auth_env();
    }

    #[test]
    fn receive_exchange_code_stops_on_cancel_callback() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind callback server");
        let addr = listener.local_addr().expect("local addr");
        let handle = thread::spawn(move || receive_exchange_code(listener));

        send_cancel_request(addr);

        let error = handle
            .join()
            .expect("join callback server")
            .expect_err("login canceled");
        assert!(
            format!("{error:#}").contains("canceled"),
            "unexpected error: {error:#}"
        );
    }

    #[test]
    fn verified_auth_context_uses_verified_identity_and_session() {
        let _guard = env_lock().lock().expect("env lock");
        clear_auth_env();
        let dir = tempdir().expect("tempdir");
        let server = AuthMeServer::start(
            r#"{"subject":"auth0|user_123","email":"morgan@example.com","name":"Morgan","expires_at":"2026-06-25T00:00:00Z","roles":["ROLE_USER"]}"#,
        );
        let storage_path = dir.path().join("sessions.json");
        env::set_var(BB_HOME_ENV_VAR, dir.path());
        env::set_var(KGOOSE_BASE_URL_ENV_VAR, &server.base_url);
        env::set_var(BB_AUTH_STORAGE_ENV_VAR, "file");
        env::set_var(BB_AUTH_STORAGE_FILE_ENV_VAR, &storage_path);
        write_test_preferences(dir.path(), "test");
        write_test_session(storage_path, &server.base_url, "verified-session");

        let context = verified_auth_context_blocking().expect("verified auth context");
        let request = server.finish();

        assert_eq!(context.session_credential, "verified-session");
        assert_eq!(context.user, "morgan");
        assert_eq!(request.path, "/cash-app/goose/v1/auth/me");
        assert_eq!(
            request.session_credential.as_deref(),
            Some("verified-session")
        );

        clear_auth_env();
    }

    #[test]
    fn builderbot_user_prefers_email_local_part_with_verified_fallbacks() {
        assert_eq!(
            builderbot_user(
                Some(&" MorganM@example.com ".to_string()),
                Some(&"Morgan".to_string()),
                Some(&"auth0|123".to_string()),
            ),
            Some("MorganM".to_string())
        );
        assert_eq!(
            builderbot_user(
                None,
                Some(&"Morgan".to_string()),
                Some(&"auth0|123".to_string())
            ),
            Some("Morgan".to_string())
        );
    }

    #[test]
    fn shared_kgoose_auth_uses_custom_service_path_storage_key() {
        let _guard = env_lock().lock().expect("env lock");
        clear_auth_env();
        let dir = tempdir().expect("tempdir");
        let storage_path = dir.path().join("sessions.json");
        env::set_var(BB_HOME_ENV_VAR, dir.path());
        env::set_var(KGOOSE_BASE_URL_ENV_VAR, "https://blockstaging.build");
        env::set_var(KGOOSE_SERVICE_PATH_ENV_VAR, "/cash-app/goose-square");
        env::set_var(BB_AUTH_STORAGE_ENV_VAR, "file");
        env::set_var(BB_AUTH_STORAGE_FILE_ENV_VAR, &storage_path);
        write_test_preferences(dir.path(), "test");
        write_test_session_with_service_path(
            storage_path,
            "https://test.blockstaging.build",
            "/cash-app/goose-square",
            "custom-path-session",
        );

        let session =
            shared_session_credential_for_kgoose_base_url("https://test.blockstaging.build")
                .expect("read shared session");

        assert_eq!(session.as_deref(), Some("custom-path-session"));

        clear_auth_env();
    }

    #[test]
    fn shared_kgoose_auth_does_not_fall_back_to_unrelated_login_session() {
        let _guard = env_lock().lock().expect("env lock");
        clear_auth_env();
        let dir = tempdir().expect("tempdir");
        let storage_path = dir.path().join("sessions.json");
        env::set_var(BB_HOME_ENV_VAR, dir.path());
        env::set_var(KGOOSE_BASE_URL_ENV_VAR, "https://blockstaging.build");
        env::set_var(BB_AUTH_STORAGE_ENV_VAR, "file");
        env::set_var(BB_AUTH_STORAGE_FILE_ENV_VAR, &storage_path);
        write_test_preferences(dir.path(), "test");
        write_test_session(
            storage_path,
            "https://test.blockstaging.build",
            "login-base-session",
        );

        let routed = route_kgoose_base_url_for_shared_org("https://kgoose.sqprod.co")
            .expect("route request base");
        let session = shared_session_credential_for_kgoose_base_url("https://kgoose.sqprod.co")
            .expect("read shared session");

        assert_eq!(routed, "https://kgoose.sqprod.co");
        assert_eq!(session, None);

        clear_auth_env();
    }

    fn send_cancel_request(addr: SocketAddr) {
        let stream = TcpStream::connect(addr).expect("connect cancel request");
        write_cancel_request(stream).expect("write cancel request");
    }

    struct RecordedAuthRequest {
        path: String,
        session_credential: Option<String>,
    }

    struct AuthMeServer {
        base_url: String,
        handle: thread::JoinHandle<RecordedAuthRequest>,
    }

    impl AuthMeServer {
        fn start(body: &'static str) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").expect("bind auth test server");
            let base_url = format!("http://{}", listener.local_addr().expect("local addr"));
            let handle = thread::spawn(move || {
                let (stream, _) = listener.accept().expect("accept auth request");
                handle_auth_me_connection(stream, body)
            });
            Self { base_url, handle }
        }

        fn finish(self) -> RecordedAuthRequest {
            self.handle.join().expect("join auth test server")
        }
    }

    fn handle_auth_me_connection(mut stream: TcpStream, body: &str) -> RecordedAuthRequest {
        let mut reader = BufReader::new(stream.try_clone().expect("clone stream"));
        let mut request_line = String::new();
        reader.read_line(&mut request_line).expect("request line");
        let path = request_line
            .split_whitespace()
            .nth(1)
            .expect("request path")
            .to_string();
        let mut session_credential = None;
        loop {
            let mut line = String::new();
            reader.read_line(&mut line).expect("request header");
            if line == "\r\n" || line.is_empty() {
                break;
            }
            if let Some((name, value)) = line.split_once(':') {
                if name.eq_ignore_ascii_case(SESSION_CREDENTIAL_HEADER) {
                    session_credential = Some(value.trim().to_string());
                }
            }
        }

        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        );
        stream
            .write_all(response.as_bytes())
            .expect("write auth response");

        RecordedAuthRequest {
            path,
            session_credential,
        }
    }
}
