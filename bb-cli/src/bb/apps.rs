//! External Builderlab Apps Platform control-plane commands.
//!
//! This module serves only the external pilot: first in `bb-block` staging,
//! then in the multi-tenant `bb-public` environment. It does not replace the
//! existing Cloudflare-backed internal Block App Kit CLI exposed through
//! `bb tools appkit`, and it does not migrate the separate internal Compose
//! workflow. Both internal paths remain unchanged.
//!
//! The CLI exchanges its stored bbidentity session for a short-lived
//! Compose-purpose bearer token. Public ingress validates that token online
//! through kgoose `ext_authz`, removes it, and forwards only verified identity
//! headers to Compose. Compose never receives the bearer token.

use std::fs::{self, File, OpenOptions};
use std::io::Read;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use builderbot_auth::auth_login::{auth_url, build_auth_http_client, playpen_baggage};
use clap::{Arg, ArgMatches, Command};
use fs2::FileExt;
use reqwest::blocking::Client;
use reqwest::header::{HeaderValue, ACCEPT, AUTHORIZATION, USER_AGENT};
use reqwest::StatusCode;
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::auth::SESSION_CREDENTIAL_HEADER;
use super::auth_storage::{
    default_session_storage, session_storage_key_from_config, PurposeTokenStorageKey,
    SessionCredentialStorage, StoredPurposeTokenCredential,
};
use super::display::{print_json, terminal_safe_text, Style};
use super::runner;
use super::skills_api::{exit_codes, failure};
use super::skills_config::{kgoose_service_url, SkillsConfig};

const APPS_BASE_URL_ENV_VAR: &str = "BB_APPS_CONTROL_PLANE_URL";
const APPS_CLIENT_VERSION_ENV_VAR: &str = "BB_APPS_CLIENT_VERSION";
const APPS_CONTRACT_PATH: &str = "/v1/agent/contract";
const COMPOSE_TOKEN_EXCHANGE_PATH: &str = "/v1/auth/token/compose";
const HOTPOD_AGENT_CLIENT_VERSION_HEADER: &str = "X-Hotpod-Agent-Client-Version";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const TOKEN_EXCHANGE_RESPONSE_MAX_BYTES: usize = 32 * 1024;
const CONTROL_PLANE_RESPONSE_MAX_BYTES: usize = 2 * 1024 * 1024;
const COMPOSE_TOKEN_PURPOSE: &str = "compose";
const PURPOSE_TOKEN_REFRESH_SKEW: Duration = Duration::from_secs(60);
const PURPOSE_TOKEN_REPLACEMENT_INTERVAL: Duration = Duration::from_secs(60);
const PURPOSE_TOKEN_LOCK_FILE: &str = "apps-purpose-token.lock";
const TRUSTED_CONTROL_PLANE_HOSTS: &[&str] = &["test.blockstaging.build", "app.builderlab.xyz"];

pub fn command() -> Command {
    Command::new("apps")
        .about("Manage apps through Apps Platform")
        .long_about(
            "Manage apps through the Builderlab Apps Platform control plane on Compose, first in \
             `bb-block` staging and then in multi-tenant `bb-public`. This does not replace the \
             Cloudflare-backed internal App Kit CLI (`bb tools appkit`) or migrate the separate internal \
             Compose workflow.",
        )
        .subcommand_required(true)
        .arg_required_else_help(true)
        .disable_help_subcommand(true)
        .subcommand(
            Command::new("contract")
                .about(
                    "Read the control-plane contract, runtime metadata, and supported operations",
                )
                .arg(
                    Arg::new("apps-base-url")
                        .long("base-url")
                        .visible_alias("control-plane-url")
                        .value_name("URL")
                        .env(APPS_BASE_URL_ENV_VAR)
                        .required(true)
                        .help("Approved Builderlab Compose control-plane ingress URL"),
                )
                .arg(
                    Arg::new("apps-client-version")
                        .long("client-version")
                        .value_name("VERSION")
                        .env(APPS_CLIENT_VERSION_ENV_VAR)
                        .default_value(env!("CARGO_PKG_VERSION"))
                        .help("Agent client version sent to the Compose control plane"),
                ),
        )
}

pub fn describe_commands() -> Value {
    super::description::describe_command_tree(&command())
}

pub fn run(matches: &ArgMatches) -> Result<()> {
    runner::run(matches, dispatch)
}

fn dispatch(config: &SkillsConfig, matches: &ArgMatches) -> Result<()> {
    runner::ensure_org_configured(config)?;
    match matches.subcommand() {
        Some(("contract", contract_matches)) => run_contract(config, contract_matches),
        _ => anyhow::bail!("expected an apps subcommand"),
    }
}

fn run_contract(config: &SkillsConfig, matches: &ArgMatches) -> Result<()> {
    let base_url = matches
        .get_one::<String>("apps-base-url")
        .context("expected Apps Platform control-plane URL")?;
    let client_version = matches
        .get_one::<String>("apps-client-version")
        .context("expected Apps Platform client version")?;

    let client = ControlPlaneClient::new(base_url, client_version, config.style)?;
    let token_provider = KgoosePurposeTokenProvider::from_config(config)?;
    let contract = client.contract(&token_provider)?;
    print_json(&contract)
}

/// Supplies the short-lived Compose bearer accepted by public ingress. Keeping
/// exchange and request construction separate makes the credential lifecycle
/// independently testable. The provider shares a session-bound token across
/// CLI processes so kgoose's one-active-token contract is respected.
trait ComposeCredentialProvider {
    fn authorization_header(&self) -> Result<HeaderValue>;

    /// Returns a replacement credential after ingress rejects `rejected`, or
    /// `None` when retrying cannot help yet. Implementations must not return
    /// the rejected value, which keeps the control-plane retry bounded.
    fn authorization_header_after_rejection(
        &self,
        _rejected: &HeaderValue,
    ) -> Result<Option<HeaderValue>> {
        Ok(None)
    }
}

struct KgoosePurposeTokenProvider {
    client: Client,
    exchange_url: url::Url,
    session_credential: HeaderValue,
    session_credential_sha256: String,
    baggage: Option<HeaderValue>,
    style: Style,
    storage: Box<dyn SessionCredentialStorage>,
    storage_key: PurposeTokenStorageKey,
    refresh_lock_path: PathBuf,
    refresh_mutex: Mutex<()>,
}

impl KgoosePurposeTokenProvider {
    fn from_config(config: &SkillsConfig) -> Result<Self> {
        let storage = default_session_storage(config)?;
        let session_storage_key = session_storage_key_from_config(config);
        let credential = storage
            .get(&session_storage_key)?
            .ok_or_else(auth_required_error)?;
        let session_credential = credential
            .session_credential_header_value()
            .ok_or_else(auth_required_error)?;
        let session_credential_sha256 = sha256(&session_credential);
        let session_credential = HeaderValue::from_str(&session_credential)
            .context("stored BuilderBot CLI auth session is invalid; run `bb auth login`")?;
        let server_url = kgoose_service_url(&config.kgoose_base_url, &config.kgoose_service_path);
        let exchange_url = auth_url(&server_url, COMPOSE_TOKEN_EXCHANGE_PATH)
            .context("build Compose credential exchange URL")?;
        let baggage = playpen_baggage(config.playpen.as_deref())
            .map(|value| HeaderValue::from_str(&value).context("build kgoose playpen header"))
            .transpose()?;

        Ok(Self {
            client: build_auth_http_client(REQUEST_TIMEOUT)?,
            exchange_url,
            session_credential,
            session_credential_sha256,
            baggage,
            style: config.style,
            storage,
            storage_key: PurposeTokenStorageKey::new(&session_storage_key, COMPOSE_TOKEN_PURPOSE),
            refresh_lock_path: config.bb_home.join(PURPOSE_TOKEN_LOCK_FILE),
            refresh_mutex: Mutex::new(()),
        })
    }

    fn exchange_purpose_token(&self) -> Result<PurposeTokenExchangeOutcome> {
        self.style
            .verbose(&format!("POST {COMPOSE_TOKEN_EXCHANGE_PATH}"));
        let mut request = self
            .client
            .post(self.exchange_url.clone())
            .header(USER_AGENT, apps_user_agent())
            .header(ACCEPT, "application/json")
            .header(SESSION_CREDENTIAL_HEADER, self.session_credential.clone());
        if let Some(baggage) = &self.baggage {
            request = request.header("Baggage", baggage.clone());
        }
        let response = request
            .send()
            .map_err(|error| network_failure("POST", COMPOSE_TOKEN_EXCHANGE_PATH, error))?;
        let status = response.status();
        if status == StatusCode::TOO_MANY_REQUESTS {
            self.style
                .verbose(&format!("POST {COMPOSE_TOKEN_EXCHANGE_PATH} -> {status}"));
            return Ok(PurposeTokenExchangeOutcome::RateLimited);
        }
        if !status.is_success() {
            self.style
                .verbose(&format!("POST {COMPOSE_TOKEN_EXCHANGE_PATH} -> {status}"));
            return Err(exchange_http_failure(status));
        }
        let body = read_limited_response_body(
            response,
            TOKEN_EXCHANGE_RESPONSE_MAX_BYTES,
            "Compose credential exchange",
        )?;
        self.style.verbose(&format!(
            "POST {COMPOSE_TOKEN_EXCHANGE_PATH} -> {status} ({} bytes)",
            body.len()
        ));
        let exchange: PurposeTokenExchangeResponse =
            serde_json::from_str(&body).context("parse Compose credential exchange response")?;
        if exchange.token_type.as_deref() != Some("Bearer") {
            anyhow::bail!("Compose credential exchange returned an unsupported token type");
        }
        let access_token = exchange
            .access_token
            .filter(|token| !token.trim().is_empty())
            .context("Compose credential exchange returned no access token")?;
        purpose_token_authorization_header(&access_token)
            .context("Compose credential exchange returned an invalid access token")?;
        let expires_in_seconds = exchange
            .expires_in_seconds
            .filter(|seconds| *seconds > 0)
            .context("Compose credential exchange returned no positive expiry")?;
        let issued_at_unix_seconds = unix_time_seconds()?;
        let expires_at_unix_seconds = issued_at_unix_seconds
            .checked_add(expires_in_seconds)
            .context("Compose credential exchange returned an invalid expiry")?;
        Ok(PurposeTokenExchangeOutcome::Issued(
            StoredPurposeTokenCredential {
                access_token,
                token_type: "Bearer".to_string(),
                issued_at_unix_seconds,
                expires_at_unix_seconds,
                session_credential_sha256: self.session_credential_sha256.clone(),
            },
        ))
    }

    fn cached_authorization_header(
        &self,
        credential: &StoredPurposeTokenCredential,
    ) -> Result<Option<HeaderValue>> {
        if credential.session_credential_sha256 != self.session_credential_sha256
            || credential.token_type != "Bearer"
            || credential.access_token.trim().is_empty()
        {
            return Ok(None);
        }
        let refresh_after = unix_time_seconds()?
            .checked_add(PURPOSE_TOKEN_REFRESH_SKEW.as_secs())
            .context("system time overflow while checking Compose credential")?;
        if credential.expires_at_unix_seconds <= refresh_after {
            return Ok(None);
        }
        purpose_token_authorization_header(&credential.access_token)
            .map(Some)
            .context("cached Compose credential is invalid")
    }

    fn read_cached_authorization_header(
        &self,
    ) -> Result<Option<(StoredPurposeTokenCredential, HeaderValue)>> {
        let Some(credential) = self.storage.get_purpose_token(&self.storage_key)? else {
            return Ok(None);
        };
        let Some(header) = self.cached_authorization_header(&credential)? else {
            return Ok(None);
        };
        Ok(Some((credential, header)))
    }

    fn refresh_lock(&self) -> Result<File> {
        if let Some(parent) = self.refresh_lock_path.parent() {
            fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
        }
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&self.refresh_lock_path)
            .with_context(|| format!("open {}", self.refresh_lock_path.display()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&self.refresh_lock_path, fs::Permissions::from_mode(0o600))
                .with_context(|| format!("chmod 600 {}", self.refresh_lock_path.display()))?;
        }
        FileExt::lock_exclusive(&file)
            .with_context(|| format!("lock {}", self.refresh_lock_path.display()))?;
        Ok(file)
    }

    fn refresh_or_adopt(&self, rejected: Option<&HeaderValue>) -> Result<Option<HeaderValue>> {
        let _process_guard = self
            .refresh_mutex
            .lock()
            .map_err(|_| anyhow::anyhow!("Compose credential cache lock was poisoned"))?;
        let _file_guard = self.refresh_lock()?;

        let cached = self.read_cached_authorization_header()?;
        if let Some((credential, header)) = cached {
            if rejected.is_none() || rejected != Some(&header) {
                return Ok(Some(header));
            }

            let replacement_allowed_at = credential
                .issued_at_unix_seconds
                .saturating_add(PURPOSE_TOKEN_REPLACEMENT_INTERVAL.as_secs());
            if unix_time_seconds()? < replacement_allowed_at {
                return Ok(None);
            }
        }

        match self.exchange_purpose_token()? {
            PurposeTokenExchangeOutcome::Issued(credential) => {
                let header = self.cached_authorization_header(&credential)?.context(
                    "Compose credential exchange returned a credential too close to expiry",
                )?;
                self.storage
                    .set_purpose_token(&self.storage_key, &credential)
                    .context("store Compose purpose token")?;
                if rejected == Some(&header) {
                    return Ok(None);
                }
                Ok(Some(header))
            }
            PurposeTokenExchangeOutcome::RateLimited => {
                if let Some((_credential, header)) = self.read_cached_authorization_header()? {
                    if rejected != Some(&header) {
                        return Ok(Some(header));
                    }
                }
                Err(exchange_http_failure(StatusCode::TOO_MANY_REQUESTS))
            }
        }
    }
}

#[derive(Deserialize)]
struct PurposeTokenExchangeResponse {
    access_token: Option<String>,
    token_type: Option<String>,
    expires_in_seconds: Option<u64>,
}

enum PurposeTokenExchangeOutcome {
    Issued(StoredPurposeTokenCredential),
    RateLimited,
}

impl ComposeCredentialProvider for KgoosePurposeTokenProvider {
    fn authorization_header(&self) -> Result<HeaderValue> {
        if let Some((_credential, header)) = self.read_cached_authorization_header()? {
            return Ok(header);
        }
        self.refresh_or_adopt(None)?
            .context("Compose credential exchange did not return a usable credential")
    }

    fn authorization_header_after_rejection(
        &self,
        rejected: &HeaderValue,
    ) -> Result<Option<HeaderValue>> {
        self.refresh_or_adopt(Some(rejected))
    }
}

struct ControlPlaneClient {
    client: Client,
    contract_url: url::Url,
    client_version: HeaderValue,
    style: Style,
}

impl ControlPlaneClient {
    fn new(base_url: &str, client_version: &str, style: Style) -> Result<Self> {
        let contract_url = auth_url(base_url, APPS_CONTRACT_PATH)
            .context("build Apps Platform control-plane contract URL")?;
        if !matches!(contract_url.scheme(), "http" | "https") {
            anyhow::bail!("Apps Platform control-plane URL must use http or https");
        }
        if contract_url.scheme() == "http" && !is_loopback_url(&contract_url) {
            anyhow::bail!(
                "Apps Platform control-plane URL must use https unless it targets loopback local development"
            );
        }
        if !is_trusted_control_plane_url(&contract_url) {
            anyhow::bail!(
                "Apps Platform control-plane URL must target an approved Builderlab ingress host or loopback local development"
            );
        }
        let client_version = HeaderValue::from_str(client_version)
            .context("Apps Platform client version is not a valid HTTP header value")?;
        Ok(Self {
            client: build_auth_http_client(REQUEST_TIMEOUT)?,
            contract_url,
            client_version,
            style,
        })
    }

    fn contract(&self, credential_provider: &dyn ComposeCredentialProvider) -> Result<Value> {
        let authorization = credential_provider.authorization_header()?;
        let (mut status, mut body) = self.contract_response(authorization.clone())?;
        if status == StatusCode::UNAUTHORIZED {
            if let Some(replacement) =
                credential_provider.authorization_header_after_rejection(&authorization)?
            {
                (status, body) = self.contract_response(replacement)?;
            }
        }
        if !status.is_success() {
            return Err(control_plane_http_failure(status, &body));
        }
        serde_json::from_str(&body).context("parse Apps Platform control-plane contract response")
    }

    fn contract_response(&self, authorization: HeaderValue) -> Result<(StatusCode, String)> {
        self.style.verbose(&format!("GET {APPS_CONTRACT_PATH}"));
        let request = self
            .client
            .get(self.contract_url.clone())
            .header(USER_AGENT, apps_user_agent())
            .header(ACCEPT, "application/json")
            .header(
                HOTPOD_AGENT_CLIENT_VERSION_HEADER,
                self.client_version.clone(),
            );
        let response = request
            .header(AUTHORIZATION, authorization)
            .send()
            .map_err(|error| network_failure("GET", APPS_CONTRACT_PATH, error))?;
        let status = response.status();
        let body = read_limited_response_body(
            response,
            CONTROL_PLANE_RESPONSE_MAX_BYTES,
            "Apps Platform control-plane",
        )?;
        self.style.verbose(&format!(
            "GET {APPS_CONTRACT_PATH} -> {status} ({} bytes)",
            body.len()
        ));
        Ok((status, body))
    }
}

fn is_trusted_control_plane_url(url: &url::Url) -> bool {
    if is_loopback_url(url) {
        return true;
    }
    if url.scheme() != "https" || url.port_or_known_default() != Some(443) {
        return false;
    }
    let Some(url::Host::Domain(host)) = url.host() else {
        return false;
    };
    TRUSTED_CONTROL_PLANE_HOSTS
        .iter()
        .any(|trusted| host.eq_ignore_ascii_case(trusted))
}

fn is_loopback_url(url: &url::Url) -> bool {
    match url.host() {
        Some(url::Host::Domain(domain)) => domain.eq_ignore_ascii_case("localhost"),
        Some(url::Host::Ipv4(address)) => address.is_loopback(),
        Some(url::Host::Ipv6(address)) => address.is_loopback(),
        None => false,
    }
}

fn read_limited_response_body(
    response: reqwest::blocking::Response,
    max_bytes: usize,
    description: &str,
) -> Result<String> {
    let mut bytes = Vec::new();
    response
        .take((max_bytes + 1) as u64)
        .read_to_end(&mut bytes)
        .with_context(|| format!("read {description} response"))?;
    if bytes.len() > max_bytes {
        anyhow::bail!("{description} response exceeded {max_bytes} bytes");
    }
    String::from_utf8(bytes).with_context(|| format!("decode {description} response as UTF-8"))
}

fn purpose_token_authorization_header(access_token: &str) -> Result<HeaderValue> {
    HeaderValue::from_str(&format!("Bearer {access_token}"))
        .context("build Compose authorization header")
}

fn unix_time_seconds() -> Result<u64> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .context("system clock is before the Unix epoch")
        .map(|duration| duration.as_secs())
}

fn sha256(value: &str) -> String {
    Sha256::digest(value.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn apps_user_agent() -> String {
    format!("bb-apps/{}", env!("CARGO_PKG_VERSION"))
}

fn auth_required_error() -> anyhow::Error {
    failure(
        exit_codes::AUTH_REQUIRED,
        "auth_required",
        "BuilderBot CLI auth is required; run `bb auth login`",
    )
}

fn network_failure(method: &str, path: &str, error: reqwest::Error) -> anyhow::Error {
    failure(
        exit_codes::NETWORK,
        "network_error",
        format!("{method} {path} failed before receiving a response: {error}"),
    )
}

fn exchange_http_failure(status: StatusCode) -> anyhow::Error {
    let (exit_code, code, hint) = match status.as_u16() {
        401 => (
            exit_codes::AUTH_REQUIRED,
            "auth_required",
            "; run `bb auth login` to refresh your session",
        ),
        403 => (
            exit_codes::FORBIDDEN,
            "forbidden",
            "; the current account does not have Builderlab access",
        ),
        429 => (
            exit_codes::GENERAL,
            "credential_exchange_rate_limited",
            "; retry later",
        ),
        value if value >= 500 => (exit_codes::NETWORK, "credential_exchange_unavailable", ""),
        _ => (exit_codes::GENERAL, "credential_exchange_failed", ""),
    };
    failure(
        exit_code,
        code,
        format!("Compose credential exchange failed with {status}{hint}"),
    )
}

fn control_plane_http_failure(status: StatusCode, body: &str) -> anyhow::Error {
    let parsed = serde_json::from_str::<Value>(body).ok();
    let code = parsed
        .as_ref()
        .and_then(|value| value.pointer("/error/code"))
        .and_then(Value::as_str)
        .unwrap_or("control_plane_request_failed");
    let next_action = parsed
        .as_ref()
        .and_then(|value| {
            value
                .get("next_action")
                .or_else(|| value.pointer("/error/next_action"))
        })
        .and_then(Value::as_str);
    let mut message = format!("GET {APPS_CONTRACT_PATH} failed with {status}");
    if let Some(next_action) = next_action {
        message.push_str("\nnext_action: ");
        message.push_str(&terminal_safe_text(next_action));
    }
    let exit_code = match status.as_u16() {
        401 => exit_codes::AUTH_REQUIRED,
        403 => exit_codes::FORBIDDEN,
        value if value >= 500 => exit_codes::NETWORK,
        _ => exit_codes::GENERAL,
    };
    failure(exit_code, code, message)
}

#[cfg(test)]
mod tests {
    use std::thread;

    use builderbot_auth::auth_storage::{FileSessionCredentialStorage, SessionStorageKey};
    use tiny_http::{Header, Response, Server};

    use super::*;

    fn test_provider(
        exchange_url: url::Url,
        temporary_directory: &tempfile::TempDir,
    ) -> KgoosePurposeTokenProvider {
        let session_credential = "test-bbidentity-session";
        let session_storage_key = SessionStorageKey::new("test", exchange_url.as_str());
        KgoosePurposeTokenProvider {
            client: build_auth_http_client(REQUEST_TIMEOUT).expect("build HTTP client"),
            exchange_url,
            session_credential: HeaderValue::from_static(session_credential),
            session_credential_sha256: sha256(session_credential),
            baggage: None,
            style: Style::new(true, false, false),
            storage: Box::new(FileSessionCredentialStorage::new(
                temporary_directory.path().join("sessions.json"),
            )),
            storage_key: PurposeTokenStorageKey::new(&session_storage_key, COMPOSE_TOKEN_PURPOSE),
            refresh_lock_path: temporary_directory.path().join(PURPOSE_TOKEN_LOCK_FILE),
            refresh_mutex: Mutex::new(()),
        }
    }

    #[test]
    fn purpose_token_provider_reuses_token_across_provider_instances() {
        let temporary_directory = tempfile::tempdir().expect("create temporary directory");
        let server = Server::http("127.0.0.1:0").expect("bind token exchange server");
        let exchange_url = url::Url::parse(&format!(
            "http://{}{COMPOSE_TOKEN_EXCHANGE_PATH}",
            server.server_addr()
        ))
        .expect("parse exchange URL");
        let server_thread = thread::spawn(move || {
            let request = server.recv().expect("receive token exchange");
            assert_eq!(request.method().as_str(), "POST");
            assert_eq!(request.url(), COMPOSE_TOKEN_EXCHANGE_PATH);
            request
                .respond(
                    Response::from_string(
                        r#"{"access_token":"cached-compose-token","token_type":"Bearer","expires_in_seconds":300}"#,
                    )
                    .with_header(
                        Header::from_bytes("Content-Type", "application/json")
                            .expect("build content type"),
                    ),
                )
                .expect("respond to token exchange");
        });
        let provider = test_provider(exchange_url.clone(), &temporary_directory);

        let first = provider
            .authorization_header()
            .expect("first authorization header");
        drop(provider);
        let second = test_provider(exchange_url, &temporary_directory)
            .authorization_header()
            .expect("persisted authorization header");

        assert_eq!(
            first,
            HeaderValue::from_static("Bearer cached-compose-token")
        );
        assert_eq!(second, first);
        server_thread.join().expect("join token exchange server");
    }

    #[test]
    fn control_plane_restricts_token_recipients() {
        let style = Style::new(true, false, false);

        assert!(ControlPlaneClient::new("https://test.blockstaging.build", "1.0.0", style).is_ok());
        assert!(ControlPlaneClient::new("https://app.builderlab.xyz", "1.0.0", style).is_ok());
        assert!(ControlPlaneClient::new("http://localhost:8080", "1.0.0", style).is_ok());
        assert!(ControlPlaneClient::new("http://127.0.0.1:8080", "1.0.0", style).is_ok());
        assert!(ControlPlaneClient::new("http://[::1]:8080", "1.0.0", style).is_ok());

        let error = ControlPlaneClient::new("http://compose.example", "1.0.0", style)
            .err()
            .expect("reject cleartext external URL");
        assert!(error.to_string().contains("must use https"));

        for untrusted in [
            "https://attacker.example",
            "https://test.blockstaging.build.attacker.example",
            "https://test.blockstaging.build:444",
        ] {
            let error = ControlPlaneClient::new(untrusted, "1.0.0", style)
                .err()
                .expect("reject untrusted control-plane origin");
            assert!(error.to_string().contains("approved Builderlab ingress"));
        }
    }

    #[test]
    fn cached_token_requires_current_session_and_safe_expiry() {
        let temporary_directory = tempfile::tempdir().expect("create temporary directory");
        let provider = test_provider(
            url::Url::parse("http://127.0.0.1:9/v1/auth/token/compose")
                .expect("parse exchange URL"),
            &temporary_directory,
        );
        let now = unix_time_seconds().expect("read system time");
        let mut credential = StoredPurposeTokenCredential {
            access_token: "cached-token".to_string(),
            token_type: "Bearer".to_string(),
            issued_at_unix_seconds: now,
            expires_at_unix_seconds: now + 300,
            session_credential_sha256: "different-session".to_string(),
        };

        assert!(provider
            .cached_authorization_header(&credential)
            .expect("validate different session")
            .is_none());

        credential.session_credential_sha256 = provider.session_credential_sha256.clone();
        credential.expires_at_unix_seconds = now + PURPOSE_TOKEN_REFRESH_SKEW.as_secs();
        assert!(provider
            .cached_authorization_header(&credential)
            .expect("validate near-expiry token")
            .is_none());

        credential.expires_at_unix_seconds = now + 300;
        assert_eq!(
            provider
                .cached_authorization_header(&credential)
                .expect("validate reusable token"),
            Some(HeaderValue::from_static("Bearer cached-token"))
        );
    }

    #[test]
    fn control_plane_retries_once_with_rotated_cached_token() {
        struct RotatingCredentialProvider;

        impl ComposeCredentialProvider for RotatingCredentialProvider {
            fn authorization_header(&self) -> Result<HeaderValue> {
                Ok(HeaderValue::from_static("Bearer rejected-token"))
            }

            fn authorization_header_after_rejection(
                &self,
                rejected: &HeaderValue,
            ) -> Result<Option<HeaderValue>> {
                assert_eq!(rejected, HeaderValue::from_static("Bearer rejected-token"));
                Ok(Some(HeaderValue::from_static("Bearer rotated-token")))
            }
        }

        let server = Server::http("127.0.0.1:0").expect("bind control-plane server");
        let base_url = format!("http://{}", server.server_addr());
        let server_thread = thread::spawn(move || {
            let first = server.recv().expect("receive first contract request");
            assert_eq!(
                first
                    .headers()
                    .iter()
                    .find(|header| header.field.equiv("Authorization"))
                    .map(|header| header.value.as_str()),
                Some("Bearer rejected-token")
            );
            first
                .respond(Response::from_string("unauthorized").with_status_code(401))
                .expect("reject first contract request");

            let second = server.recv().expect("receive retried contract request");
            assert_eq!(
                second
                    .headers()
                    .iter()
                    .find(|header| header.field.equiv("Authorization"))
                    .map(|header| header.value.as_str()),
                Some("Bearer rotated-token")
            );
            second
                .respond(
                    Response::from_string(r#"{"contract_version":"test"}"#).with_header(
                        Header::from_bytes("Content-Type", "application/json")
                            .expect("build content type"),
                    ),
                )
                .expect("respond to retried contract request");
        });
        let client = ControlPlaneClient::new(&base_url, "1.0.0", Style::new(true, false, false))
            .expect("build control-plane client");

        let contract = client
            .contract(&RotatingCredentialProvider)
            .expect("retry contract request");

        assert_eq!(contract["contract_version"], "test");
        server_thread.join().expect("join control-plane server");
    }

    #[test]
    fn purpose_token_provider_rejects_oversized_exchange_response() {
        let temporary_directory = tempfile::tempdir().expect("create temporary directory");
        let server = Server::http("127.0.0.1:0").expect("bind token exchange server");
        let exchange_url = url::Url::parse(&format!(
            "http://{}{COMPOSE_TOKEN_EXCHANGE_PATH}",
            server.server_addr()
        ))
        .expect("parse exchange URL");
        let server_thread = thread::spawn(move || {
            let request = server.recv().expect("receive token exchange");
            request
                .respond(Response::from_data(vec![
                    b'x';
                    TOKEN_EXCHANGE_RESPONSE_MAX_BYTES
                        + 1
                ]))
                .expect("respond to token exchange");
        });
        let provider = test_provider(exchange_url, &temporary_directory);

        let error = provider
            .authorization_header()
            .expect_err("reject oversized exchange response");

        assert!(error.to_string().contains("exceeded 32768 bytes"));
        assert!(!error.to_string().contains("test-bbidentity-session"));
        server_thread.join().expect("join token exchange server");
    }
}
