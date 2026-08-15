use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use builderbot_auth::auth_login::{
    build_auth_http_client, logout_session_credential, verify_session_credential, AuthMeResponse,
    OAuthCallback, OAuthCallbackRejection, OAuthLoginAttempt,
};
use builderbot_auth::auth_storage::{
    default_session_storage_for_bb_home,
    stored_session_credential_header_value_for_kgoose_base_url, SessionCredentialStorage,
    SessionStorageKey, StoredSessionCredential,
};
use builderbot_auth::config::{
    default_bb_home, default_kgoose_service_path, default_preferences_path,
    is_loopback_kgoose_base_url, kgoose_service_url, normalize_kgoose_base_url_with_service_path,
    normalize_kgoose_service_path, read_optional_env, read_preferences_file,
    write_preferences_file, BB_HOME_ENV_VAR, BB_SKILLS_PROFILE_ENV_VAR, DEFAULT_PROFILE_NAME,
    KGOOSE_SERVICE_PATH_ENV_VAR,
};
use builderbot_auth::org_routing::{normalize_org, resolve_org_kgoose_base_url};
use builderbot_auth::workspace::{
    list_workspaces as request_workspaces, switch_workspace as request_workspace_switch, Workspace,
};
use reqwest::header::HeaderValue;
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
const AUTH_HTTP_TIMEOUT: Duration = Duration::from_secs(30);
const LOGIN_ATTEMPT_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const LOOPBACK_IO_TIMEOUT: Duration = Duration::from_secs(1);
const MAX_LOOPBACK_REQUEST_LINE_BYTES: usize = 4 * 1024;
const MAX_LOOPBACK_HEADER_LINE_BYTES: usize = 8 * 1024;
const MAX_LOOPBACK_HEADER_COUNT: usize = 64;

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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthWorkspace {
    pub workspace_identifier: Option<String>,
    pub display_name: Option<String>,
    pub roles: Vec<String>,
}

impl From<Workspace> for AuthWorkspace {
    fn from(workspace: Workspace) -> Self {
        Self {
            workspace_identifier: workspace.workspace_identifier,
            display_name: workspace.display_name,
            roles: workspace.roles,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListAuthWorkspacesResult {
    pub workspaces: Vec<AuthWorkspace>,
    pub active_workspace_identifier: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SwitchWorkspaceResult {
    pub workspace: AuthWorkspace,
    pub switched: bool,
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
    canceled: bool,
}

struct LoginAttemptGuard(u64);

impl Drop for LoginAttemptGuard {
    fn drop(&mut self) {
        clear_login_attempt_if_current(self.0);
    }
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

#[tauri::command]
pub async fn list_auth_workspaces() -> Result<ListAuthWorkspacesResult, String> {
    tauri::async_runtime::spawn_blocking(list_auth_workspaces_blocking)
        .await
        .map_err(|error| format!("BuilderBot workspace list task failed: {error}"))?
        .map_err(auth_error)
}

#[tauri::command]
pub async fn switch_auth_workspace(
    workspace_identifier: String,
) -> Result<SwitchWorkspaceResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        switch_auth_workspace_blocking(&workspace_identifier)
    })
    .await
    .map_err(|error| format!("BuilderBot workspace switch task failed: {error}"))?
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

fn register_login_attempt(callback_addr: SocketAddr) -> Result<u64> {
    let id = next_login_attempt_id();
    let mut current = login_attempt_state()
        .lock()
        .expect("login attempt state mutex poisoned");
    if current.is_some() {
        return Err(anyhow!("BuilderBot auth login is already in progress"));
    }
    *current = Some(LoginAttempt {
        id,
        callback_addr,
        canceled: false,
    });
    Ok(id)
}

fn clear_login_attempt_if_current(id: u64) {
    let mut current = login_attempt_state()
        .lock()
        .expect("login attempt state mutex poisoned");
    if current.is_some_and(|attempt| attempt.id == id) {
        *current = None;
    }
}

fn is_login_attempt_canceled(id: u64) -> bool {
    login_attempt_state()
        .lock()
        .expect("login attempt state mutex poisoned")
        .is_some_and(|attempt| attempt.id == id && attempt.canceled)
}

fn current_login_attempt_id_for(callback_addr: SocketAddr) -> Option<u64> {
    login_attempt_state()
        .lock()
        .expect("login attempt state mutex poisoned")
        .filter(|attempt| attempt.callback_addr == callback_addr)
        .map(|attempt| attempt.id)
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
    // Cancellation is an in-process command, not a loopback HTTP capability.
    // The nonblocking login worker polls this state at least every 25 ms.
    mark_login_attempt_canceled();
    Ok(())
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
    listener
        .set_nonblocking(true)
        .context("configure loopback callback listener")?;
    let callback_addr = listener.local_addr()?;
    let mut oauth_attempt = OAuthLoginAttempt::generate()?;
    let callback_url = format!("http://{}{}", callback_addr, CALLBACK_PATH);
    let login_url = oauth_attempt.login_url(&context.kgoose_service_url, &callback_url)?;
    let attempt_id = register_login_attempt(callback_addr)?;
    let _attempt_guard = LoginAttemptGuard(attempt_id);
    if let Err(error) = app_handle
        .opener()
        .open_url(login_url.as_str(), None::<&str>)
        .with_context(|| format!("open BuilderBot auth login URL {}", login_url.as_str()))
    {
        clear_login_attempt_if_current(attempt_id);
        return Err(error);
    }

    let code = match receive_exchange_code(listener, &mut oauth_attempt) {
        Ok(code) => code,
        Err(error) => {
            clear_login_attempt_if_current(attempt_id);
            return Err(error);
        }
    };
    if is_login_attempt_canceled(attempt_id) {
        clear_login_attempt_if_current(attempt_id);
        return Err(anyhow!("BuilderBot auth login was canceled"));
    }
    let verified = match oauth_attempt.exchange_login_code_and_verify(
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

struct WorkspaceSession {
    context: AuthContext,
    storage: Box<dyn SessionCredentialStorage>,
    storage_key: SessionStorageKey,
    credential: StoredSessionCredential,
}

fn load_workspace_session() -> Result<WorkspaceSession> {
    let context = resolve_auth_context(None, false)?;
    context
        .org
        .as_ref()
        .ok_or_else(|| anyhow!("org is not configured; log in and try again"))?;
    let storage = default_session_storage_for_bb_home(context.bb_home.clone())?;
    let storage_key = session_storage_key(&context);
    let credential = storage
        .get(&storage_key)?
        .ok_or_else(|| anyhow!("BuilderBot session is missing; log in and try again"))?;
    credential
        .session_credential_header_value()
        .ok_or_else(|| anyhow!("BuilderBot session credential is empty; log in again"))?;

    Ok(WorkspaceSession {
        context,
        storage,
        storage_key,
        credential,
    })
}

fn list_auth_workspaces_blocking() -> Result<ListAuthWorkspacesResult> {
    let session = load_workspace_session()?;
    let client = build_auth_http_client(AUTH_HTTP_TIMEOUT)?;
    let response = request_workspaces(
        &client,
        session.context.playpen.as_deref(),
        &session.context.kgoose_service_url,
        &session.credential,
    )?;
    Ok(ListAuthWorkspacesResult {
        workspaces: response.workspaces.into_iter().map(Into::into).collect(),
        active_workspace_identifier: response.active_workspace_identifier,
    })
}

fn switch_auth_workspace_blocking(workspace_identifier: &str) -> Result<SwitchWorkspaceResult> {
    let workspace_identifier = workspace_identifier.trim();
    if workspace_identifier.is_empty() {
        return Err(anyhow!("workspace identifier must not be empty"));
    }

    let session = load_workspace_session()?;
    let client = build_auth_http_client(AUTH_HTTP_TIMEOUT)?;
    let response = request_workspace_switch(
        &client,
        session.context.playpen.as_deref(),
        &session.context.kgoose_service_url,
        &session.credential,
        workspace_identifier,
    )?;
    let switched = if let Some(new_credential) = response.session_credential {
        if new_credential.trim().is_empty() {
            return Err(anyhow!(
                "workspace switch returned an empty replacement credential"
            ));
        }
        HeaderValue::from_str(&new_credential)
            .context("workspace switch returned an invalid replacement credential")?;
        session.storage.set(
            &session.storage_key,
            &StoredSessionCredential {
                session_credential: new_credential,
                expires_at: session.credential.expires_at,
            },
        )?;
        true
    } else {
        false
    };
    let workspace = response
        .workspace
        .context("workspace switch returned no workspace")?;

    Ok(SwitchWorkspaceResult {
        workspace: workspace.into(),
        switched,
    })
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
    let kgoose_service_path = resolve_kgoose_service_path(base_url)?;

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
    let configured_kgoose_base_url = read_trimmed_env(KGOOSE_BASE_URL_ENV_VAR)?
        .unwrap_or_else(|| DEFAULT_KGOOSE_BASE_URL.to_string());
    let kgoose_service_path = resolve_kgoose_service_path(&configured_kgoose_base_url)?;
    let raw_kgoose_base_url = normalize_kgoose_base_url_with_service_path(
        &configured_kgoose_base_url,
        &kgoose_service_path,
    );
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

fn resolve_kgoose_service_path(base_url: &str) -> Result<String> {
    read_trimmed_env(KGOOSE_SERVICE_PATH_ENV_VAR)?
        .map(|value| normalize_kgoose_service_path(&value))
        .transpose()
        .map(|path| {
            path.unwrap_or_else(|| {
                // The GUI has no `--local-dev` flag, so a loopback base URL is
                // the signal that it is calling KGoose directly.
                default_kgoose_service_path(is_loopback_kgoose_base_url(base_url), base_url)
                    .to_string()
            })
        })
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

fn receive_exchange_code(listener: TcpListener, attempt: &mut OAuthLoginAttempt) -> Result<String> {
    let deadline = std::time::Instant::now() + LOGIN_ATTEMPT_TIMEOUT;
    loop {
        if std::time::Instant::now() >= deadline {
            return Err(anyhow!(
                "BuilderBot auth login expired before receiving a valid callback"
            ));
        }
        if let Some(attempt_id) = current_login_attempt_id_for(listener.local_addr()?) {
            if is_login_attempt_canceled(attempt_id) {
                return Err(anyhow!("BuilderBot auth login was canceled"));
            }
        } else {
            return Err(anyhow!("BuilderBot auth login attempt is no longer active"));
        }

        match listener.accept() {
            Ok((stream, _)) => {
                if let Some(code) = handle_callback_stream(stream, attempt)? {
                    return Ok(code);
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(25));
            }
            Err(error) => return Err(error).context("accept loopback auth callback"),
        }
    }
}

fn handle_callback_stream(
    mut stream: TcpStream,
    attempt: &mut OAuthLoginAttempt,
) -> Result<Option<String>> {
    if let Err(error) = stream.set_read_timeout(Some(LOOPBACK_IO_TIMEOUT)) {
        log::debug!("ignoring loopback auth connection with no read timeout: {error}");
        return Ok(None);
    }
    if let Err(error) = stream.set_write_timeout(Some(LOOPBACK_IO_TIMEOUT)) {
        log::debug!("ignoring loopback auth connection with no write timeout: {error}");
        return Ok(None);
    }
    let outcome = read_callback_stream(&stream, attempt);
    match outcome {
        Err(error) => {
            let _ = write_loopback_response(
                &mut stream,
                400,
                "BuilderBot auth ignored an invalid callback request. The valid login is still waiting.",
            );
            log::debug!("ignoring invalid loopback auth connection: {error:#}");
            Ok(None)
        }
        Ok(CallbackReadOutcome::WrongPath) => {
            let _ = write_loopback_response(
                &mut stream,
                404,
                "BuilderBot auth is waiting for the callback.",
            );
            Ok(None)
        }
        Ok(CallbackReadOutcome::InvalidMethod) => {
            let _ = write_loopback_response(
                &mut stream,
                400,
                "BuilderBot auth ignored an invalid callback request. The valid login is still waiting.",
            );
            Ok(None)
        }
        Ok(CallbackReadOutcome::Callback(OAuthCallback::Code(code))) => {
            let _ = write_loopback_response(
                &mut stream,
                200,
                "BuilderBot auth complete. Return to Goose.",
            );
            Ok(Some(code))
        }
        Ok(CallbackReadOutcome::Callback(OAuthCallback::Error(error))) => {
            let _ = write_loopback_response(
                &mut stream,
                400,
                "BuilderBot auth failed. Return to Goose.",
            );
            Err(anyhow!("auth callback returned error: {error}"))
        }
        Ok(CallbackReadOutcome::Callback(OAuthCallback::Rejected(rejection))) => {
            let _ =
                write_loopback_response(&mut stream, 400, callback_rejection_message(rejection));
            Ok(None)
        }
    }
}

enum CallbackReadOutcome {
    Callback(OAuthCallback),
    WrongPath,
    InvalidMethod,
}

fn read_callback_stream(
    stream: &TcpStream,
    attempt: &mut OAuthLoginAttempt,
) -> Result<CallbackReadOutcome> {
    let mut reader = BufReader::new(stream.try_clone().context("clone callback stream")?);
    let request_line = read_bounded_http_line(
        &mut reader,
        MAX_LOOPBACK_REQUEST_LINE_BYTES,
        "callback request line",
    )?;
    if request_line.is_empty() {
        return Err(anyhow!("auth callback request line was empty"));
    }

    let mut headers_complete = false;
    for _ in 0..MAX_LOOPBACK_HEADER_COUNT {
        let header = read_bounded_http_line(
            &mut reader,
            MAX_LOOPBACK_HEADER_LINE_BYTES,
            "callback header",
        )?;
        if header == "\r\n" {
            headers_complete = true;
            break;
        }
        if header.is_empty() {
            return Err(anyhow!("auth callback request ended before its headers"));
        }
    }
    if !headers_complete {
        return Err(anyhow!(
            "auth callback request exceeded {MAX_LOOPBACK_HEADER_COUNT} headers"
        ));
    }

    let mut request_parts = request_line.split_whitespace();
    let method = request_parts
        .next()
        .ok_or_else(|| anyhow!("auth callback request did not include a method"))?;
    let request_target = request_parts
        .next()
        .ok_or_else(|| anyhow!("auth callback request did not include a path"))?;
    let version = request_parts
        .next()
        .ok_or_else(|| anyhow!("auth callback request did not include an HTTP version"))?;
    if request_parts.next().is_some() || !matches!(version, "HTTP/1.0" | "HTTP/1.1") {
        return Err(anyhow!("auth callback request line was malformed"));
    }

    let parsed = Url::parse(&format!("http://127.0.0.1{request_target}"))
        .context("parse loopback callback URL")?;

    if parsed.path() != CALLBACK_PATH {
        return Ok(CallbackReadOutcome::WrongPath);
    }

    if method != "GET" {
        return Ok(CallbackReadOutcome::InvalidMethod);
    }

    Ok(CallbackReadOutcome::Callback(
        attempt.parse_callback(&parsed),
    ))
}

fn read_bounded_http_line(
    reader: &mut BufReader<TcpStream>,
    max_bytes: usize,
    description: &str,
) -> Result<String> {
    let mut bytes = Vec::new();
    let read = reader
        .take((max_bytes + 1) as u64)
        .read_until(b'\n', &mut bytes)
        .with_context(|| format!("read {description}"))?;
    if read == 0 {
        return Ok(String::new());
    }
    if bytes.len() > max_bytes || !bytes.ends_with(b"\n") {
        return Err(anyhow!("{description} exceeded {max_bytes} bytes"));
    }
    String::from_utf8(bytes).with_context(|| format!("{description} was not valid UTF-8"))
}

fn callback_rejection_message(rejection: OAuthCallbackRejection) -> &'static str {
    match rejection {
        OAuthCallbackRejection::MissingState => {
            "BuilderBot auth ignored a callback with missing state. The valid login is still waiting."
        }
        OAuthCallbackRejection::StateMismatch => {
            "BuilderBot auth ignored a callback for another login. The valid login is still waiting."
        }
        OAuthCallbackRejection::MissingCode => {
            "BuilderBot auth ignored a callback with no exchange code. The valid login is still waiting."
        }
        OAuthCallbackRejection::InvalidState
        | OAuthCallbackRejection::InvalidCode
        | OAuthCallbackRejection::InvalidError => {
            "BuilderBot auth ignored a callback with an invalid parameter. The valid login is still waiting."
        }
        OAuthCallbackRejection::DuplicateParameter | OAuthCallbackRejection::ConflictingOutcome => {
            "BuilderBot auth ignored an ambiguous callback. The valid login is still waiting."
        }
    }
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
    use builderbot_auth::config::DEFAULT_KGOOSE_SERVICE_PATH;
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
        env::set_var(
            KGOOSE_BASE_URL_ENV_VAR,
            "https://blockstaging.build/cash-app/goose",
        );

        let context = resolve_auth_context(Some(" Test "), true).expect("resolve auth context");
        let preferences =
            read_preferences_file(&default_preferences_path(dir.path())).expect("read prefs");

        assert_eq!(context.org.as_deref(), Some("test"));
        assert_eq!(context.kgoose_base_url, "https://test.blockstaging.build");
        assert_eq!(
            context.kgoose_service_url,
            "https://test.blockstaging.build/api/goose"
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
    fn concurrent_login_attempt_is_rejected_without_replacing_the_active_attempt() {
        let _guard = env_lock().lock().expect("login attempt lock");
        let first_listener = TcpListener::bind("127.0.0.1:0").expect("bind first callback server");
        let first_addr = first_listener.local_addr().expect("first local addr");
        let first_attempt_id =
            register_login_attempt(first_addr).expect("register first login attempt");
        let second_listener =
            TcpListener::bind("127.0.0.1:0").expect("bind second callback server");
        let second_addr = second_listener.local_addr().expect("second local addr");

        let error =
            register_login_attempt(second_addr).expect_err("reject concurrent login attempt");

        assert!(
            format!("{error:#}").contains("already in progress"),
            "unexpected error: {error:#}"
        );
        assert_eq!(
            current_login_attempt_id_for(first_addr),
            Some(first_attempt_id)
        );
        assert_eq!(current_login_attempt_id_for(second_addr), None);
        clear_login_attempt_if_current(first_attempt_id);
    }

    #[test]
    fn rejected_callbacks_do_not_terminate_the_valid_attempt() {
        let _guard = env_lock().lock().expect("login attempt lock");
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind callback server");
        listener
            .set_nonblocking(true)
            .expect("configure callback server");
        let addr = listener.local_addr().expect("local addr");
        let attempt_id = register_login_attempt(addr).expect("register login attempt");
        let mut attempt = OAuthLoginAttempt::generate().expect("OAuth attempt");
        let login_url = attempt
            .login_url(
                "https://example.com/cash-app/goose",
                &format!("http://{addr}{CALLBACK_PATH}"),
            )
            .expect("login URL");
        let login_url = Url::parse(&login_url).expect("parse login URL");
        let expected_state = login_url
            .query_pairs()
            .find(|(key, _)| key == "state")
            .map(|(_, value)| value.into_owned())
            .expect("state query parameter");
        let handle = thread::spawn(move || receive_exchange_code(listener, &mut attempt));

        for target in [
            format!("{CALLBACK_PATH}?code=missing-state"),
            format!("{CALLBACK_PATH}?code=wrong-state&state={}", "x".repeat(43)),
            format!("{CALLBACK_PATH}?state={expected_state}"),
            format!("{CALLBACK_PATH}?code=first&code=second&state={expected_state}"),
        ] {
            assert_eq!(send_callback_request(addr, "GET", &target), 400);
        }
        assert_eq!(
            send_callback_request(
                addr,
                "GET",
                &format!("{CALLBACK_PATH}?code=valid-code&state={expected_state}"),
            ),
            200
        );

        assert_eq!(
            handle
                .join()
                .expect("join callback server")
                .expect("valid callback"),
            "valid-code"
        );
        clear_login_attempt_if_current(attempt_id);
    }

    #[test]
    fn cross_attempt_and_replayed_callbacks_are_rejected() {
        let mut first = OAuthLoginAttempt::generate().expect("first OAuth attempt");
        let mut second = OAuthLoginAttempt::generate().expect("second OAuth attempt");
        let first_state = attempt_state(&first);
        let second_state = attempt_state(&second);

        assert_eq!(
            second.parse_callback(
                &Url::parse(&format!(
                    "http://127.0.0.1{CALLBACK_PATH}?code=cross-attempt&state={first_state}"
                ))
                .expect("cross-attempt callback")
            ),
            OAuthCallback::Rejected(OAuthCallbackRejection::StateMismatch)
        );
        assert_eq!(
            first.parse_callback(
                &Url::parse(&format!(
                    "http://127.0.0.1{CALLBACK_PATH}?code=valid&state={first_state}"
                ))
                .expect("valid callback")
            ),
            OAuthCallback::Code("valid".to_string())
        );
        assert_eq!(
            first.parse_callback(
                &Url::parse(&format!(
                    "http://127.0.0.1{CALLBACK_PATH}?code=replay&state={first_state}"
                ))
                .expect("replayed callback")
            ),
            OAuthCallback::Rejected(OAuthCallbackRejection::StateMismatch)
        );
        assert_eq!(
            second.parse_callback(
                &Url::parse(&format!(
                    "http://127.0.0.1{CALLBACK_PATH}?code=second&state={second_state}"
                ))
                .expect("second valid callback")
            ),
            OAuthCallback::Code("second".to_string())
        );
    }

    #[test]
    fn unsolicited_cancel_path_does_not_terminate_the_valid_attempt() {
        let _guard = env_lock().lock().expect("login attempt lock");
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind callback server");
        listener
            .set_nonblocking(true)
            .expect("configure callback server");
        let addr = listener.local_addr().expect("local addr");
        let attempt_id = register_login_attempt(addr).expect("register login attempt");
        let mut attempt = OAuthLoginAttempt::generate().expect("OAuth attempt");
        let expected_state = attempt_state(&attempt);
        let handle = thread::spawn(move || receive_exchange_code(listener, &mut attempt));

        assert_eq!(send_callback_request(addr, "GET", "/cancel"), 404);
        assert_eq!(
            send_callback_request(
                addr,
                "GET",
                &format!("{CALLBACK_PATH}?code=valid-code&state={expected_state}"),
            ),
            200
        );

        assert_eq!(
            handle
                .join()
                .expect("join callback server")
                .expect("valid callback"),
            "valid-code"
        );
        clear_login_attempt_if_current(attempt_id);
    }

    #[test]
    fn cancel_login_command_stops_the_registered_attempt() {
        let _guard = env_lock().lock().expect("login attempt lock");
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind callback server");
        listener
            .set_nonblocking(true)
            .expect("configure callback server");
        let addr = listener.local_addr().expect("local addr");
        let attempt_id = register_login_attempt(addr).expect("register login attempt");
        let mut attempt = OAuthLoginAttempt::generate().expect("OAuth attempt");
        let handle = thread::spawn(move || receive_exchange_code(listener, &mut attempt));

        cancel_login_blocking().expect("cancel login");

        let error = handle
            .join()
            .expect("join callback server")
            .expect_err("login canceled");
        assert!(
            format!("{error:#}").contains("canceled"),
            "unexpected error: {error:#}"
        );
        clear_login_attempt_if_current(attempt_id);
    }

    #[test]
    fn malformed_and_slow_connections_do_not_terminate_the_valid_attempt() {
        let _guard = env_lock().lock().expect("login attempt lock");
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind callback server");
        listener
            .set_nonblocking(true)
            .expect("configure callback server");
        let addr = listener.local_addr().expect("local addr");
        let attempt_id = register_login_attempt(addr).expect("register login attempt");
        let mut attempt = OAuthLoginAttempt::generate().expect("OAuth attempt");
        let expected_state = attempt_state(&attempt);
        let handle = thread::spawn(move || receive_exchange_code(listener, &mut attempt));

        let mut slow_stream = TcpStream::connect(addr).expect("connect slow callback request");
        slow_stream
            .write_all(b"GET /callback")
            .expect("write incomplete callback request");
        let mut status_line = String::new();
        BufReader::new(slow_stream)
            .read_line(&mut status_line)
            .expect("read slow callback response");
        assert!(status_line.starts_with("HTTP/1.1 400 "), "{status_line:?}");

        let oversized_target = format!("/{}", "x".repeat(MAX_LOOPBACK_REQUEST_LINE_BYTES));
        assert_eq!(send_callback_request(addr, "GET", &oversized_target), 400);
        assert_eq!(
            send_callback_request(
                addr,
                "GET",
                &format!("{CALLBACK_PATH}?code=valid-code&state={expected_state}"),
            ),
            200
        );

        assert_eq!(
            handle
                .join()
                .expect("join callback server")
                .expect("valid callback"),
            "valid-code"
        );
        clear_login_attempt_if_current(attempt_id);
    }

    #[test]
    fn cancel_login_without_an_active_attempt_is_a_no_op() {
        let _guard = env_lock().lock().expect("login attempt lock");
        cancel_login_blocking().expect("cancel without active login");
    }

    #[test]
    fn verified_auth_context_uses_verified_identity_and_session() {
        let _guard = env_lock().lock().expect("env lock");
        clear_auth_env();
        let dir = tempdir().expect("tempdir");
        let server = AuthMeServer::start(
            r#"{"subject":"auth0|user_123","email":"morgan@example.com","name":"Morgan","expires_at":"2026-06-25T00:00:00Z","roles":["ROLE_USER"],"workspaces":{"active":[{"name":"Test Workspace"}]}}"#,
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

    fn attempt_state(attempt: &OAuthLoginAttempt) -> String {
        let login_url = attempt
            .login_url(
                "https://example.com/cash-app/goose",
                "http://127.0.0.1:49152/callback",
            )
            .expect("login URL");
        let login_url = Url::parse(&login_url).expect("parse login URL");
        login_url
            .query_pairs()
            .find(|(key, _)| key == "state")
            .map(|(_, value)| value.into_owned())
            .expect("state query parameter")
    }

    fn send_callback_request(addr: SocketAddr, method: &str, target: &str) -> u16 {
        let mut stream = TcpStream::connect(addr).expect("connect callback request");
        write!(
            stream,
            "{method} {target} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n"
        )
        .expect("write callback request");
        let mut status_line = String::new();
        BufReader::new(stream)
            .read_line(&mut status_line)
            .expect("read callback response");
        status_line
            .split_whitespace()
            .nth(1)
            .expect("callback response status")
            .parse()
            .expect("numeric callback response status")
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
