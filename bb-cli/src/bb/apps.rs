//! External Builderlab Apps Platform control-plane commands.
//!
//! This module serves only the external pilot: first in `bb-block` staging,
//! then in the multi-tenant `bb-public` environment. It does not replace the
//! existing Cloudflare-backed internal Block App Kit CLI exposed through
//! `bb tools appkit`, and it does not migrate the separate internal Compose
//! workflow. Both internal paths remain unchanged.
//!
//! The CLI sends its stored bbidentity session only to the allowlisted Compose
//! control-plane origins. Public ingress authorizes that session through kgoose
//! `ext_authz` and removes it before forwarding the request internally. Compose
//! never receives the session credential.

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{Context, Result};
use builderbot_auth::auth_login::{auth_url, build_auth_http_client};
use clap::{Arg, ArgMatches, Command};
use reqwest::blocking::{multipart, Client, RequestBuilder, Response};
use reqwest::header::{HeaderValue, ACCEPT, AUTHORIZATION, USER_AGENT};
use reqwest::StatusCode;
use serde::Serialize;
use serde_json::{json, Map, Value};

use super::auth_login::{ensure_browser_login, verify_stored_session};
use super::auth_storage::{default_session_storage, session_storage_key_from_config};
use super::display::{print_json, stdin_is_tty, terminal_safe_text, Style};
use super::runner;
use super::skills_api::{exit_codes, failure};
use super::skills_config::SkillsConfig;

const APPS_BASE_URL_ENV_VAR: &str = "BB_APPS_CONTROL_PLANE_URL";
const APPS_CLIENT_VERSION_ENV_VAR: &str = "BB_APPS_CLIENT_VERSION";
const APPS_CONTRACT_PATH: &str = "/v1/agent/contract";
const APPS_PLAN_PATH: &str = "/v1/agent/apps/plan";
const HOTPOD_AGENT_CLIENT_VERSION_HEADER: &str = "X-Hotpod-Agent-Client-Version";
// Compose may synchronously wait up to two minutes for an initialize or
// deploy rollout. Leave enough headroom for the response to traverse ingress.
const CONTROL_PLANE_REQUEST_TIMEOUT: Duration = Duration::from_secs(3 * 60);
const CONTROL_PLANE_RESPONSE_MAX_BYTES: usize = 2 * 1024 * 1024;
const TRUSTED_CONTROL_PLANE_HOSTS: &[&str] = &[
    "compose-ctrl.test.blockstaging.build",
    "compose-ctrl.app.builderlab.xyz",
];

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
        .subcommand(control_plane_args(
            Command::new("contract")
                .about(
                    "Read the control-plane contract, runtime metadata, and supported operations",
                ),
        ))
        .subcommand(control_plane_args(
            Command::new("create")
                .about("Plan and initialize an app")
                .long_about(
                    "Plan an app identity through Apps Platform, then initialize it only when the \
                     returned plan marks initialization as required or recommended.",
                )
                .arg(
                    Arg::new("app-id")
                        .long("app-id")
                        .value_name("APP_ID")
                        .help("Requested DNS-safe app identifier; the control plane generates one when omitted"),
                )
                .arg(
                    Arg::new("name")
                        .long("name")
                        .value_name("NAME")
                        .help("Human-readable app name"),
                )
                .arg(
                    Arg::new("environment")
                        .long("environment")
                        .value_name("ENVIRONMENT")
                        .help("Compose environment to plan and initialize"),
                )
                .arg(
                    Arg::new("runtime-profile")
                        .long("runtime-profile")
                        .value_name("PROFILE")
                        .help("Artifact runtime profile advertised by the control-plane contract"),
                )
                .arg(
                    Arg::new("persistence")
                        .long("persistence")
                        .value_name("MODE")
                        .value_parser(["none", "sqlite"])
                        .help("Requested persistence mode"),
                ),
        ))
        .subcommand(control_plane_args(
            Command::new("deploy")
                .about("Deploy a prebuilt app artifact")
                .long_about(
                    "Upload a prebuilt Hot Pod artifact.tar.gz to Apps Platform. The response \
                     includes the deployed URL and control-plane readiness and diagnostics endpoints.",
                )
                .arg(
                    Arg::new("app-id")
                        .value_name("APP_ID")
                        .required(true)
                        .help("App identifier returned by `bb apps create`"),
                )
                .arg(
                    Arg::new("artifact")
                        .value_name("ARTIFACT_TAR_GZ")
                        .required(true)
                        .value_parser(clap::value_parser!(PathBuf))
                        .help("Path to the prebuilt artifact.tar.gz"),
                )
                .arg(
                    Arg::new("environment")
                        .long("environment")
                        .value_name("ENVIRONMENT")
                        .help("Optional Compose environment override"),
                )
                .arg(
                    Arg::new("version-id")
                        .long("version-id")
                        .value_name("VERSION_ID")
                        .help("Optional idempotent version identifier"),
                )
                .arg(
                    Arg::new("deployment-id")
                        .long("deployment-id")
                        .value_name("DEPLOYMENT_ID")
                        .help("Optional deployment identifier"),
                ),
        ))
}

fn control_plane_args(command: Command) -> Command {
    command
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
        Some(("create", create_matches)) => run_create(config, create_matches),
        Some(("deploy", deploy_matches)) => run_deploy(config, deploy_matches),
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
    let credential = ComposeSessionCredential::from_config(config)?;
    let contract = client.contract(&credential)?;
    print_json(&contract)
}

fn run_create(config: &SkillsConfig, matches: &ArgMatches) -> Result<()> {
    let (client, credential) = control_plane_context(config, matches)?;
    let request = PlanRequest {
        app_id: matches.get_one::<String>("app-id").map(String::as_str),
        name: matches.get_one::<String>("name").map(String::as_str),
        environment: matches.get_one::<String>("environment").map(String::as_str),
        runtime_profile: matches
            .get_one::<String>("runtime-profile")
            .map(String::as_str),
        persistence: matches.get_one::<String>("persistence").map(String::as_str),
        client_version: client.client_version_text(),
    };
    let plan = client.plan(&credential, &request)?;
    let app_id = required_response_string(&plan, "app_id", "Apps Platform plan")?.to_string();
    let initialize_required = plan
        .pointer("/initialize/required")
        .and_then(Value::as_bool);
    let initialize_recommended = plan
        .pointer("/initialize/recommended")
        .and_then(Value::as_bool);
    if initialize_required.is_none() && initialize_recommended.is_none() {
        anyhow::bail!(
            "Apps Platform plan response did not include initialize.required or initialize.recommended"
        );
    }
    let should_initialize =
        initialize_required.unwrap_or(false) || initialize_recommended.unwrap_or(false);
    let initialize = if should_initialize {
        let request = initialize_request_from_plan(&plan);
        Some(client.initialize(&credential, &app_id, &request)?)
    } else {
        None
    };
    let (effective_app_id, effective_external_url) = match initialize.as_ref() {
        Some(response) => (
            required_response_string(response, "app_id", "Apps Platform initialize")?.to_string(),
            Value::String(
                required_response_string(response, "external_url", "Apps Platform initialize")?
                    .to_string(),
            ),
        ),
        None => (
            app_id,
            plan.get("external_url").cloned().unwrap_or(Value::Null),
        ),
    };
    print_json(&json!({
        "ok": true,
        "app_id": effective_app_id,
        "external_url": effective_external_url,
        "initialized": initialize.is_some(),
        "plan": plan,
        "initialize": initialize,
    }))
}

fn run_deploy(config: &SkillsConfig, matches: &ArgMatches) -> Result<()> {
    let artifact = matches
        .get_one::<PathBuf>("artifact")
        .context("expected artifact.tar.gz path")?;
    validate_artifact_path(artifact)?;
    let app_id = matches
        .get_one::<String>("app-id")
        .context("expected app id")?;
    let options = DeployOptions {
        environment: matches.get_one::<String>("environment").cloned(),
        version_id: matches.get_one::<String>("version-id").cloned(),
        deployment_id: matches.get_one::<String>("deployment-id").cloned(),
    };
    let (client, credential) = control_plane_context(config, matches)?;
    let response = client.deploy(&credential, app_id, artifact, &options)?;
    print_json(&response)
}

fn control_plane_context(
    config: &SkillsConfig,
    matches: &ArgMatches,
) -> Result<(ControlPlaneClient, ComposeSessionCredential)> {
    let base_url = matches
        .get_one::<String>("apps-base-url")
        .context("expected Apps Platform control-plane URL")?;
    let client_version = matches
        .get_one::<String>("apps-client-version")
        .context("expected Apps Platform client version")?;
    let client = ControlPlaneClient::new(base_url, client_version, config.style)?;
    let credential = ComposeSessionCredential::from_config(config)?;
    Ok((client, credential))
}

#[derive(Serialize)]
struct PlanRequest<'a> {
    #[serde(skip_serializing_if = "Option::is_none")]
    app_id: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    environment: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    runtime_profile: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    persistence: Option<&'a str>,
    client_version: &'a str,
}

#[derive(Default)]
struct DeployOptions {
    environment: Option<String>,
    version_id: Option<String>,
    deployment_id: Option<String>,
}

fn initialize_request_from_plan(plan: &Value) -> Value {
    let mut request = Map::new();
    for field in ["environment", "persistence", "runtime_class"] {
        if let Some(value) = plan.get(field).and_then(Value::as_str) {
            if !value.is_empty() {
                request.insert(field.to_string(), Value::String(value.to_string()));
            }
        }
    }
    if let Some(display_name) = plan.get("display_name").and_then(Value::as_str) {
        if !display_name.is_empty() {
            request.insert("name".to_string(), Value::String(display_name.to_string()));
        }
    }
    Value::Object(request)
}

fn required_response_string<'a>(
    value: &'a Value,
    field: &str,
    description: &str,
) -> Result<&'a str> {
    value
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .with_context(|| format!("{description} response did not include {field}"))
}

fn validate_artifact_path(path: &Path) -> Result<()> {
    let metadata = fs::metadata(path)
        .with_context(|| format!("read Apps Platform artifact {}", path.display()))?;
    if !metadata.is_file() {
        anyhow::bail!(
            "Apps Platform artifact must be a file containing a prebuilt artifact.tar.gz: {}",
            path.display()
        );
    }
    Ok(())
}

struct ComposeSessionCredential {
    authorization: HeaderValue,
    secret: String,
}

impl ComposeSessionCredential {
    fn from_config(config: &SkillsConfig) -> Result<Self> {
        let storage = default_session_storage(config)?;
        let session_storage_key = session_storage_key_from_config(config);
        if config.json || !stdin_is_tty() {
            if verify_stored_session(config, storage.as_ref())?.is_none() {
                return Err(auth_required_error());
            }
            Self::after_login(storage.as_ref(), &session_storage_key, || Ok(()))
        } else {
            Self::after_login(storage.as_ref(), &session_storage_key, || {
                ensure_browser_login(config, storage.as_ref())
            })
        }
    }

    fn after_login<F>(
        storage: &dyn super::auth_storage::SessionCredentialStorage,
        session_storage_key: &super::auth_storage::SessionStorageKey,
        login: F,
    ) -> Result<Self>
    where
        F: FnOnce() -> Result<()>,
    {
        login()?;
        let credential = storage
            .get(session_storage_key)?
            .ok_or_else(auth_required_error)?;
        let secret = credential
            .session_credential_header_value()
            .ok_or_else(auth_required_error)?;
        Self::new(secret)
    }

    fn new(secret: String) -> Result<Self> {
        let authorization = HeaderValue::from_str(&format!("BBIdentity {secret}"))
            .context("stored BuilderBot CLI auth session is invalid; run `bb auth login`")?;
        Ok(Self {
            authorization,
            secret,
        })
    }

    fn authorization_header(&self) -> HeaderValue {
        self.authorization.clone()
    }

    fn redact(&self, value: &str) -> String {
        value.replace(&self.secret, "[REDACTED]")
    }
}

struct ControlPlaneClient {
    client: Client,
    base_url: String,
    client_version: HeaderValue,
    client_version_text: String,
    style: Style,
}

impl ControlPlaneClient {
    fn new(base_url: &str, client_version: &str, style: Style) -> Result<Self> {
        Self::new_with_timeout(
            base_url,
            client_version,
            style,
            CONTROL_PLANE_REQUEST_TIMEOUT,
        )
    }

    fn new_with_timeout(
        base_url: &str,
        client_version: &str,
        style: Style,
        request_timeout: Duration,
    ) -> Result<Self> {
        let contract_url = auth_url(base_url, APPS_CONTRACT_PATH)
            .context("build Apps Platform control-plane contract URL")?;
        if !is_trusted_control_plane_url(&contract_url) {
            anyhow::bail!(
                "Apps Platform control-plane URL must use HTTPS and target an approved Builderlab ingress host"
            );
        }
        Self::build(base_url, client_version, style, request_timeout)
    }

    fn build(
        base_url: &str,
        client_version: &str,
        style: Style,
        request_timeout: Duration,
    ) -> Result<Self> {
        let client_version_text = client_version.to_string();
        let client_version = HeaderValue::from_str(client_version)
            .context("Apps Platform client version is not a valid HTTP header value")?;
        Ok(Self {
            client: build_auth_http_client(request_timeout)?,
            base_url: base_url.to_string(),
            client_version,
            client_version_text,
            style,
        })
    }

    #[cfg(test)]
    fn new_for_test(
        base_url: &str,
        client_version: &str,
        style: Style,
        request_timeout: Duration,
    ) -> Result<Self> {
        Self::build(base_url, client_version, style, request_timeout)
    }

    fn client_version_text(&self) -> &str {
        &self.client_version_text
    }

    fn contract(&self, credential: &ComposeSessionCredential) -> Result<Value> {
        let url = self.endpoint(APPS_CONTRACT_PATH)?;
        self.authorized_json_request(credential, "GET", APPS_CONTRACT_PATH, |authorization| {
            self.standard_request(self.client.get(url.clone()), authorization)
                .send()
                .map_err(|error| network_failure("GET", APPS_CONTRACT_PATH, error))
        })
    }

    fn plan(
        &self,
        credential: &ComposeSessionCredential,
        request: &PlanRequest<'_>,
    ) -> Result<Value> {
        let url = self.endpoint(APPS_PLAN_PATH)?;
        self.authorized_json_request(credential, "POST", APPS_PLAN_PATH, |authorization| {
            self.standard_request(self.client.post(url.clone()), authorization)
                .json(request)
                .send()
                .map_err(|error| network_failure("POST", APPS_PLAN_PATH, error))
        })
    }

    fn initialize(
        &self,
        credential: &ComposeSessionCredential,
        app_id: &str,
        request: &Value,
    ) -> Result<Value> {
        let url = self.app_action_url(app_id, "initialize")?;
        let path = url.path().to_string();
        self.authorized_json_request(credential, "POST", &path, |authorization| {
            self.standard_request(self.client.post(url.clone()), authorization)
                .json(request)
                .send()
                .map_err(|error| network_failure("POST", &path, error))
        })
    }

    fn deploy(
        &self,
        credential: &ComposeSessionCredential,
        app_id: &str,
        artifact: &Path,
        options: &DeployOptions,
    ) -> Result<Value> {
        let url = self.app_action_url(app_id, "deploy")?;
        let path = url.path().to_string();
        self.authorized_json_request(credential, "POST", &path, |authorization| {
            let form = deploy_form(artifact, options)?;
            self.standard_request(self.client.post(url.clone()), authorization)
                .multipart(form)
                .send()
                .map_err(|error| network_failure("POST", &path, error))
        })
    }

    fn endpoint(&self, path: &str) -> Result<url::Url> {
        auth_url(&self.base_url, path)
            .with_context(|| format!("build Apps Platform control-plane {path} URL"))
    }

    fn app_action_url(&self, app_id: &str, action: &str) -> Result<url::Url> {
        let mut url = self.endpoint("/v1/agent/apps")?;
        url.path_segments_mut()
            .map_err(|_| {
                anyhow::anyhow!("Apps Platform control-plane URL cannot contain path segments")
            })?
            .push(app_id)
            .push(action);
        Ok(url)
    }

    fn standard_request(
        &self,
        request: RequestBuilder,
        authorization: HeaderValue,
    ) -> RequestBuilder {
        request
            .header(USER_AGENT, apps_user_agent())
            .header(ACCEPT, "application/json")
            .header(
                HOTPOD_AGENT_CLIENT_VERSION_HEADER,
                self.client_version.clone(),
            )
            .header(AUTHORIZATION, authorization)
    }

    fn authorized_json_request<F>(
        &self,
        credential: &ComposeSessionCredential,
        method: &str,
        path: &str,
        send: F,
    ) -> Result<Value>
    where
        F: Fn(HeaderValue) -> Result<Response>,
    {
        let authorization = credential.authorization_header();
        let (status, body) = self.request_response(method, path, &send, authorization)?;
        if !status.is_success() {
            return Err(control_plane_http_failure(
                method, path, status, &body, credential,
            ));
        }
        serde_json::from_str(&body)
            .with_context(|| format!("parse Apps Platform {method} {path} response"))
    }

    fn request_response<F>(
        &self,
        method: &str,
        path: &str,
        send: &F,
        authorization: HeaderValue,
    ) -> Result<(StatusCode, String)>
    where
        F: Fn(HeaderValue) -> Result<Response>,
    {
        self.style.verbose(&format!("{method} {path}"));
        let response = send(authorization)?;
        let status = response.status();
        let body = read_limited_response_body(
            response,
            CONTROL_PLANE_RESPONSE_MAX_BYTES,
            "Apps Platform control-plane",
        )?;
        self.style.verbose(&format!(
            "{method} {path} -> {status} ({} bytes)",
            body.len()
        ));
        Ok((status, body))
    }
}

fn deploy_form(artifact: &Path, options: &DeployOptions) -> Result<multipart::Form> {
    let artifact_part = multipart::Part::file(artifact)
        .with_context(|| format!("open Apps Platform artifact {}", artifact.display()))?
        .file_name("artifact.tar.gz")
        .mime_str("application/gzip")
        .context("set Apps Platform artifact content type")?;
    let mut form = multipart::Form::new().part("artifact", artifact_part);
    for (name, value) in [
        ("environment", options.environment.as_deref()),
        ("version_id", options.version_id.as_deref()),
        ("deployment_id", options.deployment_id.as_deref()),
    ] {
        if let Some(value) = value {
            form = form.text(name.to_string(), value.to_string());
        }
    }
    Ok(form)
}

fn is_trusted_control_plane_url(url: &url::Url) -> bool {
    if url.scheme() != "https"
        || url.port_or_known_default() != Some(443)
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return false;
    }
    let Some(url::Host::Domain(host)) = url.host() else {
        return false;
    };
    TRUSTED_CONTROL_PLANE_HOSTS
        .iter()
        .any(|trusted| host.eq_ignore_ascii_case(trusted))
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

fn control_plane_http_failure(
    method: &str,
    path: &str,
    status: StatusCode,
    body: &str,
    credential: &ComposeSessionCredential,
) -> anyhow::Error {
    let parsed = serde_json::from_str::<Value>(body).ok();
    let code = parsed
        .as_ref()
        .and_then(|value| value.pointer("/error/code"))
        .and_then(Value::as_str)
        .unwrap_or("control_plane_request_failed");
    let code = credential.redact(&terminal_safe_text(code));
    let next_action = if status == StatusCode::UNAUTHORIZED {
        Some("Run `bb auth logout`, then `bb auth login` to replace your session.".to_string())
    } else {
        parsed
            .as_ref()
            .and_then(|value| {
                value
                    .get("next_action")
                    .or_else(|| value.pointer("/error/next_action"))
            })
            .and_then(Value::as_str)
            .map(terminal_safe_text)
            .map(|value| credential.redact(&value))
    };
    let mut message = format!("{method} {path} failed with {status}");
    if let Some(next_action) = next_action {
        message.push_str("\nnext_action: ");
        message.push_str(&next_action);
    }
    let exit_code = match status.as_u16() {
        401 => exit_codes::AUTH_REQUIRED,
        403 => exit_codes::FORBIDDEN,
        value if value >= 500 => exit_codes::NETWORK,
        _ => exit_codes::GENERAL,
    };
    failure(exit_code, &code, message)
}

#[cfg(test)]
mod tests {
    use std::thread;

    use builderbot_auth::auth_storage::{
        InMemorySessionCredentialStorage, SessionCredentialStorage, SessionStorageKey,
        StoredSessionCredential,
    };
    use tiny_http::{Header, Response, Server};

    use super::*;

    fn test_credential(secret: &str) -> ComposeSessionCredential {
        ComposeSessionCredential::new(secret.to_string()).expect("build test credential")
    }

    #[test]
    fn compose_session_header_matches_kgoose_contract() {
        let secret = "opaque.session+credential/with=punctuation";
        let credential = test_credential(secret);

        assert_eq!(
            credential
                .authorization_header()
                .to_str()
                .expect("authorization text"),
            format!("BBIdentity {secret}")
        );
        for invalid in ["credential\r\nInjected: header", "credential\nheader"] {
            let error = ComposeSessionCredential::new(invalid.to_string())
                .err()
                .expect("reject invalid session credential");
            assert!(!error.to_string().contains(invalid));
        }
    }

    #[test]
    fn compose_session_continues_with_the_session_stored_by_login() {
        let storage = InMemorySessionCredentialStorage::default();
        let storage_key = SessionStorageKey::new("default", "https://kgoose.example");
        let secret = "session_stored_after_browser_login_12345";

        let credential = ComposeSessionCredential::after_login(&storage, &storage_key, || {
            storage.set(
                &storage_key,
                &StoredSessionCredential {
                    session_credential: secret.to_string(),
                    expires_at: Some("2099-01-01T00:00:00Z".to_string()),
                },
            )
        })
        .expect("continue after login");

        assert_eq!(
            credential
                .authorization_header()
                .to_str()
                .expect("authorization text"),
            format!("BBIdentity {secret}")
        );
    }

    #[test]
    fn control_plane_allowlist_is_exact_and_https_only() {
        let style = Style::new(true, false, false);

        for trusted in [
            "https://compose-ctrl.test.blockstaging.build",
            "https://compose-ctrl.app.builderlab.xyz",
            "https://compose-ctrl.test.blockstaging.build:443",
        ] {
            assert!(
                ControlPlaneClient::new(trusted, "1.0.0", style).is_ok(),
                "allowlisted control-plane origin should be accepted"
            );
        }

        for untrusted in [
            "http://compose-ctrl.test.blockstaging.build",
            "https://attacker.example",
            "https://test.blockstaging.build",
            "https://app.builderlab.xyz",
            "https://compose-ctrl.test.blockstaging.build.attacker.example",
            "https://compose-ctrl.test.blockstaging.build:444",
            "https://compose-ctrl.app.builderlab.xyz.attacker.example",
            "https://compose-ctrl.app.builderlab.xyz:444",
            "https://user@compose-ctrl.test.blockstaging.build",
            "http://localhost:8080",
            "https://localhost:8080",
            "http://127.0.0.1:8080",
            "https://127.0.0.1:8443",
            "http://[::1]:8080",
            "https://[::1]:8443",
        ] {
            let error = ControlPlaneClient::new(untrusted, "1.0.0", style)
                .err()
                .expect("reject untrusted control-plane origin");
            assert!(error.to_string().contains("approved Builderlab ingress"));
        }
    }

    #[test]
    fn control_plane_uses_bbidentity_authorization_without_identity_headers() {
        let secret = "opaque_session_credential_1234567890";
        let server = Server::http("127.0.0.1:0").expect("bind control-plane server");
        let base_url = format!("http://{}", server.server_addr());
        let server_thread = thread::spawn(move || {
            let request = server.recv().expect("receive contract request");
            assert_eq!(request.method().as_str(), "GET");
            assert_eq!(request.url(), APPS_CONTRACT_PATH);
            assert_eq!(
                request
                    .headers()
                    .iter()
                    .find(|header| header.field.equiv("Authorization"))
                    .map(|header| header.value.as_str()),
                Some("BBIdentity opaque_session_credential_1234567890")
            );
            for forbidden in [
                "Cookie",
                "X-BB-Session-Credential",
                "X-Forwarded-User",
                "X-Forwarded-Workspace-Id",
            ] {
                assert!(!request
                    .headers()
                    .iter()
                    .any(|header| header.field.equiv(forbidden)));
            }
            request
                .respond(
                    Response::from_string(r#"{"contract_version":"test"}"#).with_header(
                        Header::from_bytes("Content-Type", "application/json")
                            .expect("build content type"),
                    ),
                )
                .expect("respond to contract request");
        });
        let client = ControlPlaneClient::new_for_test(
            &base_url,
            "1.0.0",
            Style::new(true, false, false),
            Duration::from_secs(2),
        )
        .expect("build test control-plane client");

        let contract = client
            .contract(&test_credential(secret))
            .expect("read contract");

        assert_eq!(contract["contract_version"], "test");
        server_thread.join().expect("join request server");
    }

    #[test]
    fn control_plane_does_not_follow_redirects_or_forward_the_session() {
        let target = Server::http("127.0.0.1:0").expect("bind redirect target");
        let target_url = format!("http://{}/stolen", target.server_addr());
        let redirector = Server::http("127.0.0.1:0").expect("bind redirector");
        let base_url = format!("http://{}", redirector.server_addr());
        let redirect_thread = thread::spawn(move || {
            let request = redirector.recv().expect("receive original request");
            request
                .respond(Response::empty(302).with_header(
                    Header::from_bytes("Location", target_url).expect("build redirect header"),
                ))
                .expect("send redirect");
        });
        let client = ControlPlaneClient::new_for_test(
            &base_url,
            "1.0.0",
            Style::new(true, false, false),
            Duration::from_secs(2),
        )
        .expect("build test control-plane client");
        let secret = "redirect_session_credential_123456";

        let error = client
            .contract(&test_credential(secret))
            .expect_err("reject redirect response");

        assert!(error.to_string().contains("302"));
        assert!(!error.to_string().contains(secret));
        assert!(target
            .recv_timeout(Duration::from_millis(250))
            .expect("wait for redirect target")
            .is_none());
        redirect_thread.join().expect("join redirect server");
    }

    #[test]
    fn expired_session_is_not_retried_and_returns_login_guidance() {
        let server = Server::http("127.0.0.1:0").expect("bind control-plane server");
        let base_url = format!("http://{}", server.server_addr());
        let server_thread = thread::spawn(move || {
            let request = server.recv().expect("receive expired session request");
            request
                .respond(Response::from_string("expired").with_status_code(401))
                .expect("reject expired session");
            assert!(server
                .recv_timeout(Duration::from_millis(250))
                .expect("wait for unexpected retry")
                .is_none());
        });
        let client = ControlPlaneClient::new_for_test(
            &base_url,
            "1.0.0",
            Style::new(true, false, false),
            Duration::from_secs(2),
        )
        .expect("build test control-plane client");
        let secret = "expired_session_credential_1234567";

        let error = client
            .contract(&test_credential(secret))
            .expect_err("reject expired session");
        let message = error.to_string();

        assert!(message.contains("401"));
        assert!(message.contains("bb auth logout"));
        assert!(message.contains("bb auth login"));
        assert!(!message.contains(secret));
        server_thread.join().expect("join request server");
    }

    #[test]
    fn control_plane_errors_redact_the_session_credential() {
        let server = Server::http("127.0.0.1:0").expect("bind control-plane server");
        let base_url = format!("http://{}", server.server_addr());
        let secret = "reflected_session_credential_123456";
        let response_body = json!({
            "error": {"code": secret},
            "next_action": format!("remove {secret} from the request")
        })
        .to_string();
        let server_thread = thread::spawn(move || {
            let request = server.recv().expect("receive request");
            request
                .respond(Response::from_string(response_body).with_status_code(400))
                .expect("send reflected error");
        });
        let client = ControlPlaneClient::new_for_test(
            &base_url,
            "1.0.0",
            Style::new(true, false, false),
            Duration::from_secs(2),
        )
        .expect("build test control-plane client");

        let error = client
            .contract(&test_credential(secret))
            .expect_err("reject failed request");
        let message = format!("{error:#}");

        assert!(!message.contains(secret));
        assert!(message.contains("[REDACTED]"));
        server_thread.join().expect("join request server");
    }

    #[test]
    fn initialize_and_deploy_allow_delayed_rollout_responses() {
        assert!(CONTROL_PLANE_REQUEST_TIMEOUT > Duration::from_secs(2 * 60));

        let temporary_directory = tempfile::tempdir().expect("create temporary directory");
        let artifact_path = temporary_directory.path().join("artifact.tar.gz");
        fs::write(&artifact_path, b"delayed-rollout-artifact").expect("write artifact");
        let server = Server::http("127.0.0.1:0").expect("bind control-plane server");
        let base_url = format!("http://{}", server.server_addr());
        let server_thread = thread::spawn(move || {
            let initialize = server.recv().expect("receive initialize request");
            assert_eq!(initialize.url(), "/v1/agent/apps/delayed-app/initialize");
            thread::sleep(Duration::from_millis(75));
            initialize
                .respond(
                    Response::from_string(
                        r#"{"ok":true,"app_id":"delayed-app","external_url":"https://delayed-app.example"}"#,
                    )
                    .with_header(
                        Header::from_bytes("Content-Type", "application/json")
                            .expect("build content type"),
                    ),
                )
                .expect("respond to initialize request");

            let mut deploy = server.recv().expect("receive deploy request");
            assert_eq!(deploy.url(), "/v1/agent/apps/delayed-app/deploy");
            let mut body = Vec::new();
            deploy
                .as_reader()
                .read_to_end(&mut body)
                .expect("read deploy body");
            assert!(body
                .windows(b"delayed-rollout-artifact".len())
                .any(|window| window == b"delayed-rollout-artifact"));
            thread::sleep(Duration::from_millis(75));
            deploy
                .respond(
                    Response::from_string(r#"{"ok":true,"version_id":"ver-delayed"}"#).with_header(
                        Header::from_bytes("Content-Type", "application/json")
                            .expect("build content type"),
                    ),
                )
                .expect("respond to deploy request");
        });
        let client = ControlPlaneClient::new_for_test(
            &base_url,
            "1.0.0",
            Style::new(true, false, false),
            Duration::from_secs(1),
        )
        .expect("build control-plane client");

        let initialized = client
            .initialize(
                &test_credential("delayed_session_credential_123456"),
                "delayed-app",
                &json!({"environment": "staging"}),
            )
            .expect("wait for delayed initialize response");
        let deployed = client
            .deploy(
                &test_credential("delayed_session_credential_123456"),
                "delayed-app",
                &artifact_path,
                &DeployOptions::default(),
            )
            .expect("wait for delayed deploy response");

        assert_eq!(initialized["app_id"], "delayed-app");
        assert_eq!(deployed["version_id"], "ver-delayed");
        server_thread.join().expect("join control-plane server");
    }

    #[test]
    fn control_plane_bounds_plan_responses() {
        let server = Server::http("127.0.0.1:0").expect("bind control-plane server");
        let base_url = format!("http://{}", server.server_addr());
        let server_thread = thread::spawn(move || {
            let request = server.recv().expect("receive plan request");
            request
                .respond(Response::from_data(vec![
                    b'x';
                    CONTROL_PLANE_RESPONSE_MAX_BYTES
                        + 1
                ]))
                .expect("respond with oversized plan response");
        });
        let client = ControlPlaneClient::new_for_test(
            &base_url,
            "1.0.0",
            Style::new(true, false, false),
            Duration::from_secs(2),
        )
        .expect("build test control-plane client");
        let request = PlanRequest {
            app_id: Some("bounded-app"),
            name: None,
            environment: None,
            runtime_profile: None,
            persistence: None,
            client_version: "1.0.0",
        };

        let error = client
            .plan(
                &test_credential("bounded_session_credential_123456"),
                &request,
            )
            .expect_err("reject oversized plan response");

        assert!(error.to_string().contains("exceeded 2097152 bytes"));
        assert!(!error
            .to_string()
            .contains("bounded_session_credential_123456"));
        server_thread.join().expect("join control-plane server");
    }

    #[test]
    fn app_ids_are_encoded_as_single_path_segments() {
        let client = ControlPlaneClient::new_for_test(
            "http://127.0.0.1:9",
            "1.0.0",
            Style::new(true, false, false),
            Duration::from_secs(2),
        )
        .expect("build control-plane client");

        let url = client
            .app_action_url("app/../../identity", "deploy")
            .expect("build app deploy URL");

        assert_eq!(url.path(), "/v1/agent/apps/app%2F..%2F..%2Fidentity/deploy");
    }
}
