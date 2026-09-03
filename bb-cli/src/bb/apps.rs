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
use builderbot_auth::auth_login::auth_url;
#[cfg(test)]
use builderbot_auth::auth_login::build_auth_http_client;
use builderbot_auth::auth_storage::StoredSessionCredential;
use clap::{Arg, ArgMatches, Command};
use reqwest::blocking::{multipart, Client, Request, RequestBuilder, Response};
use reqwest::header::{HeaderValue, ACCEPT, AUTHORIZATION, USER_AGENT};
use reqwest::redirect::Policy;
use reqwest::StatusCode;
use serde::Serialize;
use serde_json::{json, Map, Value};

use super::auth_login::verify_stored_session;
use super::auth_storage::default_session_storage;
use super::display::{print_json, terminal_safe_text, Style};
use super::runner;
#[cfg(test)]
use super::skills_api::failure_info;
use super::skills_api::{exit_codes, failure};
use super::skills_config::SkillsConfig;

const APPS_BASE_URL_ENV_VAR: &str = "BB_APPS_CONTROL_PLANE_URL";
const APPS_CLIENT_VERSION_ENV_VAR: &str = "BB_APPS_CLIENT_VERSION";
#[cfg(test)]
const APPS_E2E_CONTROL_PLANE_URL_ENV_VAR: &str = "BB_APPS_E2E_CONTROL_PLANE_URL";
#[cfg(test)]
const APPS_E2E_AUTH_URL_ENV_VAR: &str = "BB_APPS_E2E_AUTH_URL";
#[cfg(test)]
const APPS_E2E_CREDENTIAL_ENV_VAR: &str = "BB_APPS_E2E_CREDENTIAL";
const APPS_CONTRACT_PATH: &str = "/v1/agent/contract";
const APPS_PLAN_PATH: &str = "/v1/agent/apps/plan";
const MAX_DEBUG_TAIL_LINES: u16 = 1000;
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
            Command::new("list")
                .about("List apps the current caller can manage")
                .long_about(
                    "List Apps Platform apps the current caller owns or is approved to publish. \
                     Deleted apps remain hidden unless explicitly included.",
                )
                .arg(
                    Arg::new("scope")
                        .long("scope")
                        .value_name("SCOPE")
                        .value_parser(["manageable", "owned", "publisher"])
                        .help("Filter by relationship to the app (control-plane default: manageable)"),
                )
                .arg(
                    Arg::new("include-deleted")
                        .long("include-deleted")
                        .action(clap::ArgAction::SetTrue)
                        .help("Include logically deleted apps"),
                ),
        ))
        .subcommand(control_plane_args(
            Command::new("get")
                .about("Get one manageable app and its recorded versions")
                .arg(
                    Arg::new("app-id")
                        .value_name("APP_ID")
                        .required(true)
                        .help("App identifier returned by `bb apps list` or `bb apps create`"),
                )
                .arg(
                    Arg::new("environment")
                        .long("environment")
                        .value_name("ENVIRONMENT")
                        .help("Optional Compose environment override"),
                ),
        ))
        .subcommand(control_plane_args(
            Command::new("versions")
                .about("List active and rollback-candidate versions for an app")
                .arg(
                    Arg::new("app-id")
                        .value_name("APP_ID")
                        .required(true)
                        .help("App identifier returned by `bb apps list` or `bb apps create`"),
                )
                .arg(
                    Arg::new("environment")
                        .long("environment")
                        .value_name("ENVIRONMENT")
                        .help("Optional Compose environment override"),
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
        .subcommand(control_plane_args(
            Command::new("rollback")
                .about("Roll back an app to a previous or selected version")
                .long_about(
                    "Request one Apps Platform rollback. Omit --version-id to select the previous \
                     active version, or pass an uploaded version explicitly. The response preserves \
                     the control-plane rollback, readiness, and next-call fields without hidden polling.",
                )
                .arg(
                    Arg::new("app-id")
                        .value_name("APP_ID")
                        .required(true)
                        .help("App identifier returned by `bb apps list` or `bb apps create`"),
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
                        .help("Uploaded version to activate; omit to select the previous version"),
                ),
        ))
        .subcommand(control_plane_args(
            Command::new("delete")
                .about("Logically delete an app and retire its active route")
                .long_about(
                    "Request one owner-only Apps Platform logical deletion. The active route is \
                     retired while uploaded versions, artifacts, and stack resources are retained. \
                     --confirm-app-id and --confirm-environment must exactly match APP_ID and \
                     --environment.",
                )
                .arg(
                    Arg::new("app-id")
                        .value_name("APP_ID")
                        .required(true)
                        .help("App identifier returned by `bb apps list` or `bb apps create`"),
                )
                .arg(
                    Arg::new("confirm-app-id")
                        .long("confirm-app-id")
                        .value_name("APP_ID")
                        .required(true)
                        .help("Repeat the exact app identifier to confirm logical deletion"),
                )
                .arg(
                    Arg::new("environment")
                        .long("environment")
                        .value_name("ENVIRONMENT")
                        .required(true)
                        .help("Exact Compose environment containing the app"),
                )
                .arg(
                    Arg::new("confirm-environment")
                        .long("confirm-environment")
                        .value_name("ENVIRONMENT")
                        .required(true)
                        .help("Repeat the exact environment to confirm logical deletion"),
                ),
        ))
        .subcommand(control_plane_args(
            Command::new("ready")
                .about("Check readiness for an exact deployed app version")
                .long_about(
                    "Request one control-plane readiness snapshot for an exact deployed app version. \
                     The response includes active-route, runner, readiness, and diagnostic fields; \
                     callers can follow the returned guidance to poll again.",
                )
                .arg(
                    Arg::new("app-id")
                        .value_name("APP_ID")
                        .required(true)
                        .help("App identifier returned by `bb apps create`"),
                )
                .arg(
                    Arg::new("version-id")
                        .long("version-id")
                        .value_name("VERSION_ID")
                        .required(true)
                        .help("Exact version identifier returned by `bb apps deploy`"),
                )
                .arg(
                    Arg::new("environment")
                        .long("environment")
                        .value_name("ENVIRONMENT")
                        .help("Optional Compose environment override"),
                ),
        ))
        .subcommand(control_plane_args(
            Command::new("debug")
                .about("Collect a bounded diagnostic snapshot for an app")
                .long_about(
                    "Request one control-plane diagnostic snapshot, preserving partial results when \
                     individual collectors fail. Optionally correlate the snapshot to a deployed \
                     version and control the number of log lines collected per container.",
                )
                .arg(
                    Arg::new("app-id")
                        .value_name("APP_ID")
                        .required(true)
                        .help("App identifier returned by `bb apps create`"),
                )
                .arg(
                    Arg::new("version-id")
                        .long("version-id")
                        .value_name("VERSION_ID")
                        .help("Optional version identifier to correlate with the active route"),
                )
                .arg(
                    Arg::new("environment")
                        .long("environment")
                        .value_name("ENVIRONMENT")
                        .help("Optional Compose environment override"),
                )
                .arg(
                    Arg::new("tail-lines")
                        .long("tail-lines")
                        .value_name("N")
                        .value_parser(clap::value_parser!(u16).range(1..=MAX_DEBUG_TAIL_LINES.into()))
                        .help("Log lines to collect per container (1-1000; control-plane default: 200)"),
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
        Some(("list", list_matches)) => run_list(config, list_matches),
        Some(("get", get_matches)) => run_get(config, get_matches),
        Some(("versions", versions_matches)) => run_versions(config, versions_matches),
        Some(("create", create_matches)) => run_create(config, create_matches),
        Some(("deploy", deploy_matches)) => run_deploy(config, deploy_matches),
        Some(("rollback", rollback_matches)) => run_rollback(config, rollback_matches),
        Some(("delete", delete_matches)) => run_delete(config, delete_matches),
        Some(("ready", ready_matches)) => run_ready(config, ready_matches),
        Some(("debug", debug_matches)) => run_debug(config, debug_matches),
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

fn run_list(config: &SkillsConfig, matches: &ArgMatches) -> Result<()> {
    let scope = matches.get_one::<String>("scope").map(String::as_str);
    let include_deleted = matches.get_flag("include-deleted");
    let (client, credential) = control_plane_context(config, matches)?;
    let response = client.list_apps(&credential, scope, include_deleted)?;
    print_json(&response)
}

fn run_get(config: &SkillsConfig, matches: &ArgMatches) -> Result<()> {
    let app_id = matches
        .get_one::<String>("app-id")
        .context("expected app id")?;
    let environment = matches.get_one::<String>("environment").map(String::as_str);
    let (client, credential) = control_plane_context(config, matches)?;
    let response = client.get_app(&credential, app_id, environment)?;
    print_json(&response)
}

fn run_versions(config: &SkillsConfig, matches: &ArgMatches) -> Result<()> {
    let app_id = matches
        .get_one::<String>("app-id")
        .context("expected app id")?;
    let environment = matches.get_one::<String>("environment").map(String::as_str);
    let (client, credential) = control_plane_context(config, matches)?;
    let response = client.versions(&credential, app_id, environment)?;
    print_json(&response)
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

fn run_rollback(config: &SkillsConfig, matches: &ArgMatches) -> Result<()> {
    let app_id = matches
        .get_one::<String>("app-id")
        .context("expected app id")?;
    let request = RollbackRequest {
        environment: matches.get_one::<String>("environment").map(String::as_str),
        version_id: matches.get_one::<String>("version-id").map(String::as_str),
    };
    let (client, credential) = control_plane_context(config, matches)?;
    let response = client.rollback(&credential, app_id, &request)?;
    print_json(&response)
}

fn run_delete(config: &SkillsConfig, matches: &ArgMatches) -> Result<()> {
    let app_id = matches
        .get_one::<String>("app-id")
        .context("expected app id")?;
    let confirm_app_id = matches
        .get_one::<String>("confirm-app-id")
        .context("expected delete confirmation app id")?;
    let environment = matches
        .get_one::<String>("environment")
        .context("expected delete environment")?;
    let confirm_environment = matches
        .get_one::<String>("confirm-environment")
        .context("expected delete confirmation environment")?;
    validate_delete_confirmation(app_id, environment, confirm_app_id, confirm_environment)?;
    let request = DeleteAppRequest { environment };
    let (client, credential) = control_plane_context(config, matches)?;
    let response = client.delete_app(&credential, app_id, &request)?;
    print_json(&response)
}

fn validate_delete_confirmation(
    app_id: &str,
    environment: &str,
    confirm_app_id: &str,
    confirm_environment: &str,
) -> Result<()> {
    if confirm_app_id != app_id {
        anyhow::bail!("delete requires --confirm-app-id to exactly match APP_ID ({app_id})");
    }
    if confirm_environment != environment {
        anyhow::bail!(
            "delete requires --confirm-environment to exactly match --environment ({environment})"
        );
    }
    Ok(())
}

fn run_ready(config: &SkillsConfig, matches: &ArgMatches) -> Result<()> {
    let app_id = matches
        .get_one::<String>("app-id")
        .context("expected app id")?;
    let version_id = matches
        .get_one::<String>("version-id")
        .context("expected version id")?;
    let environment = matches.get_one::<String>("environment").map(String::as_str);
    let (client, credential) = control_plane_context(config, matches)?;
    let response = client.ready(&credential, app_id, version_id, environment)?;
    print_json(&response)
}

fn run_debug(config: &SkillsConfig, matches: &ArgMatches) -> Result<()> {
    let app_id = matches
        .get_one::<String>("app-id")
        .context("expected app id")?;
    let environment = matches.get_one::<String>("environment").map(String::as_str);
    let version_id = matches.get_one::<String>("version-id").map(String::as_str);
    let tail_lines = matches.get_one::<u16>("tail-lines").copied();
    let (client, credential) = control_plane_context(config, matches)?;
    let response = client.debug(&credential, app_id, environment, version_id, tail_lines)?;
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

#[derive(Serialize)]
struct RollbackRequest<'a> {
    #[serde(skip_serializing_if = "Option::is_none")]
    environment: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    version_id: Option<&'a str>,
}

#[derive(Serialize)]
struct DeleteAppRequest<'a> {
    environment: &'a str,
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
        let verified =
            verify_stored_session(config, storage.as_ref())?.ok_or_else(auth_required_error)?;
        Self::from_stored(verified.credential)
    }

    fn from_stored(credential: StoredSessionCredential) -> Result<Self> {
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
    #[cfg(test)]
    test_transport: Option<Box<dyn ControlPlaneTransport>>,
    base_url: String,
    client_version: HeaderValue,
    client_version_text: String,
    style: Style,
}

#[cfg(test)]
trait ControlPlaneTransport {
    fn execute(&self, request: Request) -> reqwest::Result<Response>;
}

#[cfg(test)]
struct LoopbackTestTransport {
    client: Client,
    base_url: url::Url,
}

#[cfg(test)]
impl LoopbackTestTransport {
    fn new(base_url: &str, timeout: Duration) -> Result<Self> {
        Ok(Self {
            client: build_auth_http_client(timeout)?,
            base_url: validate_apps_e2e_loopback_url(base_url, APPS_E2E_CONTROL_PLANE_URL_ENV_VAR)?,
        })
    }
}

#[cfg(test)]
impl ControlPlaneTransport for LoopbackTestTransport {
    fn execute(&self, mut request: Request) -> reqwest::Result<Response> {
        assert!(
            is_trusted_control_plane_url(request.url()),
            "request must retain its approved production URL until transport execution: {}",
            request.url()
        );
        let query = request.url().query().map(str::to_string);
        let mut loopback_url = self.base_url.clone();
        loopback_url.set_path(request.url().path());
        loopback_url.set_query(query.as_deref());
        *request.url_mut() = loopback_url;
        self.client.execute(request)
    }
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
        validate_control_plane_base_url(base_url)?;
        let client = build_control_plane_http_client(request_timeout)?;
        let control_plane = Self::build(base_url, client_version, style, client)?;
        #[cfg(test)]
        let control_plane = {
            let mut control_plane = control_plane;
            if let Some(loopback_url) = std::env::var_os(APPS_E2E_CONTROL_PLANE_URL_ENV_VAR) {
                let loopback_url = loopback_url.into_string().map_err(|_| {
                    anyhow::anyhow!("{APPS_E2E_CONTROL_PLANE_URL_ENV_VAR} must be UTF-8")
                })?;
                control_plane.test_transport = Some(Box::new(LoopbackTestTransport::new(
                    &loopback_url,
                    request_timeout,
                )?));
            }
            control_plane
        };
        Ok(control_plane)
    }

    fn build(base_url: &str, client_version: &str, style: Style, client: Client) -> Result<Self> {
        let client_version_text = client_version.to_string();
        let client_version = HeaderValue::from_str(client_version)
            .context("Apps Platform client version is not a valid HTTP header value")?;
        Ok(Self {
            client,
            #[cfg(test)]
            test_transport: None,
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
        transport: Box<dyn ControlPlaneTransport>,
    ) -> Result<Self> {
        validate_control_plane_base_url(base_url)?;
        let mut client = Self::build(
            base_url,
            client_version,
            style,
            build_auth_http_client(request_timeout)?,
        )?;
        client.test_transport = Some(transport);
        Ok(client)
    }

    fn client_version_text(&self) -> &str {
        &self.client_version_text
    }

    fn contract(&self, credential: &ComposeSessionCredential) -> Result<Value> {
        let url = self.endpoint(APPS_CONTRACT_PATH)?;
        self.authorized_json_request(credential, "GET", APPS_CONTRACT_PATH, |authorization| {
            self.standard_request(self.client.get(url.clone()), authorization)
                .build()
                .context("build Apps Platform contract request")
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
                .build()
                .context("build Apps Platform plan request")
        })
    }

    fn list_apps(
        &self,
        credential: &ComposeSessionCredential,
        scope: Option<&str>,
        include_deleted: bool,
    ) -> Result<Value> {
        let mut query = Vec::new();
        if let Some(scope) = scope {
            query.push(("scope", scope.to_string()));
        }
        if include_deleted {
            query.push(("include_deleted", "true".to_string()));
        }
        let url = self.apps_url(&query)?;
        self.get_url(credential, url)
    }

    fn get_app(
        &self,
        credential: &ComposeSessionCredential,
        app_id: &str,
        environment: Option<&str>,
    ) -> Result<Value> {
        let query = environment
            .map(|environment| vec![("environment", environment.to_string())])
            .unwrap_or_default();
        let url = self.app_url(app_id, &query)?;
        self.get_url(credential, url)
    }

    fn versions(
        &self,
        credential: &ComposeSessionCredential,
        app_id: &str,
        environment: Option<&str>,
    ) -> Result<Value> {
        let query = environment
            .map(|environment| vec![("environment", environment.to_string())])
            .unwrap_or_default();
        self.get_app_resource(credential, app_id, "versions", &query)
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
                .build()
                .context("build Apps Platform initialize request")
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
                .build()
                .context("build Apps Platform deploy request")
        })
    }

    fn rollback(
        &self,
        credential: &ComposeSessionCredential,
        app_id: &str,
        request: &RollbackRequest<'_>,
    ) -> Result<Value> {
        let url = self.app_action_url(app_id, "rollback")?;
        let path = url.path().to_string();
        self.authorized_json_request(credential, "POST", &path, |authorization| {
            self.standard_request(self.client.post(url.clone()), authorization)
                .json(request)
                .build()
                .context("build Apps Platform rollback request")
        })
    }

    fn delete_app(
        &self,
        credential: &ComposeSessionCredential,
        app_id: &str,
        request: &DeleteAppRequest<'_>,
    ) -> Result<Value> {
        let url = self.app_url(app_id, &[])?;
        let path = url.path().to_string();
        let authorization = credential.authorization_header();
        let http_request = self
            .standard_request(self.client.delete(url), authorization)
            .json(request)
            .build()
            .context("build Apps Platform delete request")?;
        self.style.verbose(&format!("DELETE {path}"));
        let response = self
            .execute_request(http_request)
            .map_err(|_| delete_outcome_unknown())?;
        let status = response.status();
        let body = read_limited_response_body(
            response,
            CONTROL_PLANE_RESPONSE_MAX_BYTES,
            "Apps Platform control-plane",
        )
        .map_err(|_| delete_outcome_unknown())?;
        self.style
            .verbose(&format!("DELETE {path} -> {status} ({} bytes)", body.len()));
        if !status.is_success() {
            return Err(control_plane_http_failure(
                "DELETE", &path, status, &body, credential,
            ));
        }
        let mut value = serde_json::from_str(&body).map_err(|_| delete_outcome_unknown())?;
        redact_json_value(&mut value, credential).map_err(|_| delete_outcome_unknown())?;
        Ok(value)
    }

    fn ready(
        &self,
        credential: &ComposeSessionCredential,
        app_id: &str,
        version_id: &str,
        environment: Option<&str>,
    ) -> Result<Value> {
        let mut query = Vec::new();
        if let Some(environment) = environment {
            query.push(("environment", environment.to_string()));
        }
        query.push(("version_id", version_id.to_string()));
        self.get_app_resource(credential, app_id, "ready", &query)
    }

    fn debug(
        &self,
        credential: &ComposeSessionCredential,
        app_id: &str,
        environment: Option<&str>,
        version_id: Option<&str>,
        tail_lines: Option<u16>,
    ) -> Result<Value> {
        let mut query = Vec::new();
        if let Some(environment) = environment {
            query.push(("environment", environment.to_string()));
        }
        if let Some(version_id) = version_id {
            query.push(("version_id", version_id.to_string()));
        }
        if let Some(tail_lines) = tail_lines {
            query.push(("tail_lines", tail_lines.to_string()));
        }
        self.get_app_resource(credential, app_id, "debug", &query)
    }

    fn get_app_resource(
        &self,
        credential: &ComposeSessionCredential,
        app_id: &str,
        resource: &str,
        query: &[(&str, String)],
    ) -> Result<Value> {
        let url = self.app_resource_url(app_id, resource, query)?;
        self.get_url(credential, url)
    }

    fn get_url(&self, credential: &ComposeSessionCredential, url: url::Url) -> Result<Value> {
        let path = request_path(&url);
        self.authorized_json_request(credential, "GET", &path, |authorization| {
            self.standard_request(self.client.get(url.clone()), authorization)
                .build()
                .with_context(|| format!("build Apps Platform GET {path} request"))
        })
    }

    fn endpoint(&self, path: &str) -> Result<url::Url> {
        auth_url(&self.base_url, path)
            .with_context(|| format!("build Apps Platform control-plane {path} URL"))
    }

    fn app_action_url(&self, app_id: &str, action: &str) -> Result<url::Url> {
        self.app_resource_url(app_id, action, &[])
    }

    fn apps_url(&self, query: &[(&str, String)]) -> Result<url::Url> {
        let mut url = self.endpoint("/v1/agent/apps")?;
        if !query.is_empty() {
            let mut pairs = url.query_pairs_mut();
            for (name, value) in query {
                pairs.append_pair(name, value);
            }
        }
        Ok(url)
    }

    fn app_url(&self, app_id: &str, query: &[(&str, String)]) -> Result<url::Url> {
        let mut url = self.apps_url(query)?;
        url.path_segments_mut()
            .map_err(|_| {
                anyhow::anyhow!("Apps Platform control-plane URL cannot contain path segments")
            })?
            .push(app_id);
        Ok(url)
    }

    fn app_resource_url(
        &self,
        app_id: &str,
        resource: &str,
        query: &[(&str, String)],
    ) -> Result<url::Url> {
        let mut url = self.app_url(app_id, query)?;
        url.path_segments_mut()
            .map_err(|_| {
                anyhow::anyhow!("Apps Platform control-plane URL cannot contain path segments")
            })?
            .push(resource);
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
        F: Fn(HeaderValue) -> Result<Request>,
    {
        let authorization = credential.authorization_header();
        let (status, body) = self.request_response(method, path, &send, authorization)?;
        if !status.is_success() {
            return Err(control_plane_http_failure(
                method, path, status, &body, credential,
            ));
        }
        let mut value = serde_json::from_str(&body)
            .with_context(|| format!("parse Apps Platform {method} {path} response"))?;
        redact_json_value(&mut value, credential)
            .with_context(|| format!("sanitize Apps Platform {method} {path} response"))?;
        Ok(value)
    }

    fn request_response<F>(
        &self,
        method: &str,
        path: &str,
        send: &F,
        authorization: HeaderValue,
    ) -> Result<(StatusCode, String)>
    where
        F: Fn(HeaderValue) -> Result<Request>,
    {
        self.style.verbose(&format!("{method} {path}"));
        let request = send(authorization)?;
        let response = self
            .execute_request(request)
            .map_err(|error| network_failure(method, path, error))?;
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

    fn execute_request(&self, request: Request) -> reqwest::Result<Response> {
        #[cfg(test)]
        if let Some(transport) = self.test_transport.as_ref() {
            return transport.execute(request);
        }
        self.client.execute(request)
    }
}

fn request_path(url: &url::Url) -> String {
    match url.query() {
        Some(query) => format!("{}?{query}", url.path()),
        None => url.path().to_string(),
    }
}

fn build_control_plane_http_client(timeout: Duration) -> Result<Client> {
    Client::builder()
        .redirect(Policy::none())
        .timeout(timeout)
        .build()
        .context("build Apps Platform control-plane HTTP client")
}

fn redact_json_value(value: &mut Value, credential: &ComposeSessionCredential) -> Result<()> {
    match value {
        Value::String(text) => *text = credential.redact(text),
        Value::Array(items) => {
            for item in items {
                redact_json_value(item, credential)?;
            }
        }
        Value::Object(object) => {
            for (key, value) in object {
                if credential.redact(key) != *key {
                    anyhow::bail!(
                        "Apps Platform response contained the session credential in an object key"
                    );
                }
                redact_json_value(value, credential)?;
            }
        }
        Value::Null | Value::Bool(_) | Value::Number(_) => {}
    }
    Ok(())
}

#[cfg(test)]
fn validate_apps_e2e_loopback_url(value: &str, name: &str) -> Result<url::Url> {
    let url = url::Url::parse(value).with_context(|| format!("parse {name}"))?;
    let loopback_ip = match url.host() {
        Some(url::Host::Ipv4(address)) => address.is_loopback(),
        Some(url::Host::Ipv6(address)) => address.is_loopback(),
        Some(url::Host::Domain(_)) | None => false,
    };
    if url.scheme() != "http"
        || !loopback_ip
        || url.port().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        anyhow::bail!(
            "{name} must be an HTTP loopback IP origin with an explicit port and no userinfo, path, query, or fragment"
        );
    }
    Ok(url)
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

fn validate_control_plane_base_url(base_url: &str) -> Result<()> {
    let contract_url = auth_url(base_url, APPS_CONTRACT_PATH)
        .context("build Apps Platform control-plane contract URL")?;
    if !is_trusted_control_plane_url(&contract_url) {
        anyhow::bail!(
            "Apps Platform control-plane URL must use HTTPS and target an approved Builderlab ingress host"
        );
    }
    Ok(())
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

fn delete_outcome_unknown() -> anyhow::Error {
    failure(
        exit_codes::NETWORK,
        "delete_outcome_unknown",
        "The delete may have succeeded, but no complete JSON success response was received.\n\
         next_action: Before retrying, verify the same APP_ID and ENVIRONMENT with \
         `bb apps get <APP_ID> --environment <ENVIRONMENT>`; a successful delete reports \
         `app.status` as `deleted`.",
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
    use std::collections::{BTreeMap, VecDeque};
    use std::process::Command as ProcessCommand;
    use std::sync::{Arc, Mutex};
    use std::thread;

    use sha2::{Digest, Sha256};
    use tiny_http::{Header, Response, Server};

    use super::*;

    const APPROVED_TEST_BASE_URL: &str = "https://compose-ctrl.test.blockstaging.build";
    const PROCESS_STDOUT_BEGIN: &str = "BB_APPS_E2E_STDOUT_BEGIN";
    const PROCESS_STDOUT_END: &str = "BB_APPS_E2E_STDOUT_END";

    #[derive(Clone)]
    struct ProcessResponse {
        status: u16,
        body: Value,
    }

    impl ProcessResponse {
        fn json(body: Value) -> Self {
            Self { status: 200, body }
        }
    }

    #[derive(Clone)]
    struct ProcessRequest {
        method: String,
        path: String,
        headers: BTreeMap<String, String>,
        body: Value,
        body_bytes: Vec<u8>,
    }

    struct ProcessServer {
        base_url: String,
        requests: Arc<Mutex<Vec<ProcessRequest>>>,
        handle: Option<thread::JoinHandle<()>>,
    }

    impl ProcessServer {
        fn start(responses: Vec<ProcessResponse>) -> Self {
            let server = Server::http("127.0.0.1:0").expect("bind Apps process test server");
            let base_url = format!("http://{}", server.server_addr());
            let requests = Arc::new(Mutex::new(Vec::new()));
            let thread_requests = Arc::clone(&requests);
            let handle = thread::spawn(move || {
                let mut responses = VecDeque::from(responses);
                while let Some(response) = responses.pop_front() {
                    let mut request = server
                        .recv_timeout(Duration::from_secs(10))
                        .expect("receive Apps process request")
                        .expect("Apps process request before timeout");
                    let headers = request
                        .headers()
                        .iter()
                        .map(|header| {
                            (
                                header.field.as_str().to_string().to_ascii_lowercase(),
                                header.value.as_str().to_string(),
                            )
                        })
                        .collect::<BTreeMap<_, _>>();
                    let mut body_bytes = Vec::new();
                    request
                        .as_reader()
                        .read_to_end(&mut body_bytes)
                        .expect("read Apps process request");
                    let body = if headers
                        .get("content-type")
                        .is_some_and(|value| value.starts_with("application/json"))
                    {
                        serde_json::from_slice(&body_bytes)
                            .expect("parse Apps process JSON request")
                    } else {
                        Value::Null
                    };
                    thread_requests
                        .lock()
                        .expect("lock Apps process requests")
                        .push(ProcessRequest {
                            method: request.method().as_str().to_string(),
                            path: request.url().to_string(),
                            headers,
                            body,
                            body_bytes,
                        });
                    request
                        .respond(
                            Response::from_string(response.body.to_string())
                                .with_status_code(response.status)
                                .with_header(
                                    Header::from_bytes("Content-Type", "application/json")
                                        .expect("build Apps process content type"),
                                ),
                        )
                        .expect("respond to Apps process request");
                }
            });
            Self {
                base_url,
                requests,
                handle: Some(handle),
            }
        }

        fn finish(mut self) -> Vec<ProcessRequest> {
            self.handle
                .take()
                .expect("Apps process server handle")
                .join()
                .expect("join Apps process server");
            self.requests
                .lock()
                .expect("lock Apps process requests")
                .clone()
        }
    }

    #[test]
    fn bb_apps_e2e_process_helper() {
        let Some(args) = std::env::var_os("BB_APPS_E2E_ARGS") else {
            return;
        };
        let args = serde_json::from_str::<Vec<String>>(
            args.to_str().expect("BB_APPS_E2E_ARGS must be UTF-8"),
        )
        .expect("parse BB_APPS_E2E_ARGS");
        let auth_url = std::env::var(APPS_E2E_AUTH_URL_ENV_VAR)
            .expect("Apps E2E helper requires an explicit auth URL");
        let auth_url = validate_apps_e2e_loopback_url(&auth_url, APPS_E2E_AUTH_URL_ENV_VAR)
            .expect("validate Apps E2E auth URL");
        let credential = std::env::var(APPS_E2E_CREDENTIAL_ENV_VAR)
            .expect("Apps E2E helper requires an explicit synthetic credential");
        assert!(
            credential.starts_with("apps-e2e-only."),
            "Apps E2E helper accepts only synthetic test credentials"
        );
        let temp = tempfile::tempdir().expect("create isolated Apps E2E home");
        let bb_home = temp.path().join("bb-home");
        let storage_path = temp.path().join("auth-sessions.json");
        fs::create_dir_all(&bb_home).expect("create isolated Apps E2E bb home");
        fs::write(bb_home.join("config.yaml"), "org: test\n")
            .expect("write isolated Apps E2E config");
        let service_url = format!("{}/api/goose", auth_url.as_str().trim_end_matches('/'));
        let mut hasher = Sha256::new();
        hasher.update(b"default");
        hasher.update([0]);
        hasher.update(service_url.as_bytes());
        let storage_key = hasher
            .finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        fs::write(
            &storage_path,
            serde_json::to_vec_pretty(&json!({
                storage_key: {
                    "sessionCredential": credential,
                    "expiresAt": "2099-01-01T00:00:00Z"
                }
            }))
            .expect("serialize isolated Apps E2E storage"),
        )
        .expect("write isolated Apps E2E storage");
        std::env::set_var("BB_HOME", &bb_home);
        std::env::set_var("BB_AUTH_STORAGE", "file");
        std::env::set_var("BB_AUTH_STORAGE_FILE", &storage_path);
        std::env::set_var("KGOOSE_BASE_URL", auth_url.as_str());
        std::env::remove_var("BB_SKILLS_PROFILE");
        std::env::remove_var("KGOOSE_PLAYPEN");
        println!("{PROCESS_STDOUT_BEGIN}");
        crate::run_bb_with_argv(args).expect("run bb Apps process command");
        println!("{PROCESS_STDOUT_END}");
    }

    fn process_auth_response() -> ProcessResponse {
        ProcessResponse::json(json!({
            "subject": "auth0|apps-user",
            "email": "apps@example.com",
            "name": "Apps User",
            "expires_at": "2099-01-01T00:00:00Z",
            "workspaces": {"active": [{"name": "Test Workspace"}]}
        }))
    }

    fn process_command(
        auth_server: &ProcessServer,
        control_plane: &ProcessServer,
        args: &[&str],
        credential: &str,
    ) -> ProcessCommand {
        assert!(credential.starts_with("apps-e2e-only."));
        let argv = std::iter::once("bb")
            .chain(args.iter().copied())
            .map(str::to_string)
            .collect::<Vec<_>>();
        let mut command = ProcessCommand::new(std::env::current_exe().expect("current test exe"));
        command
            .args([
                "--exact",
                "bb::apps::tests::bb_apps_e2e_process_helper",
                "--nocapture",
            ])
            .env("BB_APPS_E2E_ARGS", serde_json::to_string(&argv).unwrap())
            .env(APPS_E2E_CONTROL_PLANE_URL_ENV_VAR, &control_plane.base_url)
            .env(APPS_E2E_AUTH_URL_ENV_VAR, &auth_server.base_url)
            .env(APPS_E2E_CREDENTIAL_ENV_VAR, credential)
            .env_remove("BB_HOME")
            .env_remove("BB_AUTH_STORAGE")
            .env_remove("BB_AUTH_STORAGE_FILE")
            .env_remove("KGOOSE_BASE_URL")
            .env_remove("BB_SKILLS_PROFILE")
            .env_remove("KGOOSE_PLAYPEN");
        command
    }

    fn process_stdout(output: &std::process::Output) -> String {
        let stdout = String::from_utf8(output.stdout.clone()).expect("Apps process stdout UTF-8");
        let start = stdout
            .find(PROCESS_STDOUT_BEGIN)
            .expect("Apps process stdout begin marker")
            + PROCESS_STDOUT_BEGIN.len();
        let end = stdout[start..]
            .find(PROCESS_STDOUT_END)
            .map(|offset| start + offset)
            .expect("Apps process stdout end marker");
        stdout[start..end].trim().to_string()
    }

    fn assert_process_auth(request: &ProcessRequest, credential: &str) {
        assert_eq!(request.method, "GET");
        assert_eq!(request.path, "/api/goose/v1/auth/me");
        assert_eq!(
            request
                .headers
                .get("x-bb-session-credential")
                .map(String::as_str),
            Some(credential)
        );
    }

    fn assert_process_control_plane(
        request: &ProcessRequest,
        method: &str,
        path: &str,
        credential: &str,
    ) {
        assert_eq!(request.method, method);
        assert_eq!(request.path, path);
        assert_eq!(
            request.headers.get("authorization").map(String::as_str),
            Some(format!("BBIdentity {credential}").as_str())
        );
        assert_eq!(
            request
                .headers
                .get("x-hotpod-agent-client-version")
                .map(String::as_str),
            Some("0.2.0")
        );
        for forbidden in [
            "cookie",
            "x-bb-session-credential",
            "x-forwarded-user",
            "x-forwarded-workspace-id",
        ] {
            assert!(!request.headers.contains_key(forbidden));
        }
    }

    #[test]
    fn apps_e2e_destinations_require_explicit_http_loopback_ip_origins() {
        for valid in ["http://127.0.0.1:1234", "http://[::1]:4321"] {
            assert!(validate_apps_e2e_loopback_url(valid, "test URL").is_ok());
        }
        for invalid in [
            "http://192.0.2.1:1234",
            "https://127.0.0.1:1234",
            "http://localhost:1234",
            "http://user@127.0.0.1:1234",
            "http://127.0.0.1:1234/path",
            "http://127.0.0.1:1234/?query=yes",
            "http://127.0.0.1:1234/#fragment",
            "http://127.0.0.1",
        ] {
            let error = validate_apps_e2e_loopback_url(invalid, "test URL")
                .expect_err("reject unsafe Apps E2E destination");
            assert!(error.to_string().contains("HTTP loopback IP origin"));
        }
    }

    #[test]
    fn bb_apps_contract_process_covers_auth_dispatch_output_and_redaction() {
        let credential = "apps-e2e-only.contract.session+credential";
        let contract = json!({
            "ok": true,
            "contract_version": "2026-06-30",
            "reflected": credential,
            "nested": {"message": format!("prefix {credential} suffix")}
        });
        let auth_server = ProcessServer::start(vec![process_auth_response()]);
        let control_plane = ProcessServer::start(vec![ProcessResponse::json(contract)]);
        let mut command = process_command(
            &auth_server,
            &control_plane,
            &[
                "apps",
                "contract",
                "--base-url",
                APPROVED_TEST_BASE_URL,
                "--client-version",
                "0.2.0",
                "--json",
            ],
            credential,
        );

        let output = command.output().expect("run Apps contract process command");
        assert!(
            output.status.success(),
            "stderr was: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let stdout = process_stdout(&output);
        assert!(!stdout.contains(credential));
        let value = serde_json::from_str::<Value>(&stdout).expect("parse contract process output");
        assert_eq!(value["contract_version"], "2026-06-30");
        assert_eq!(value["reflected"], "[REDACTED]");
        assert_eq!(value["nested"]["message"], "prefix [REDACTED] suffix");
        let auth_requests = auth_server.finish();
        let control_requests = control_plane.finish();
        assert_process_auth(&auth_requests[0], credential);
        assert_process_control_plane(&control_requests[0], "GET", APPS_CONTRACT_PATH, credential);
    }

    #[test]
    fn bb_apps_list_process_sends_filters_and_preserves_inventory() {
        let credential = "apps-e2e-only.list.session+credential";
        let inventory = json!({
            "ok": true,
            "caller": "apps-user",
            "scope": "publisher",
            "captured_at": "2026-09-01T12:00:00Z",
            "count": 1,
            "apps": [{
                "app_id": "merchant-lookup",
                "role": "publisher",
                "status": "deleted",
                "ready": false,
                "active_version_id": "ver-123",
                "last_published_by": "apps-user"
            }]
        });
        let auth_server = ProcessServer::start(vec![process_auth_response()]);
        let control_plane = ProcessServer::start(vec![ProcessResponse::json(inventory.clone())]);
        let mut command = process_command(
            &auth_server,
            &control_plane,
            &[
                "apps",
                "list",
                "--scope",
                "publisher",
                "--include-deleted",
                "--base-url",
                APPROVED_TEST_BASE_URL,
                "--client-version",
                "0.2.0",
                "--json",
            ],
            credential,
        );

        let output = command.output().expect("run Apps list process command");
        assert!(
            output.status.success(),
            "stderr was: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(
            serde_json::from_str::<Value>(&process_stdout(&output))
                .expect("parse list process output"),
            inventory
        );
        let auth_requests = auth_server.finish();
        let requests = control_plane.finish();
        assert_process_auth(&auth_requests[0], credential);
        assert_eq!(requests.len(), 1);
        assert_process_control_plane(
            &requests[0],
            "GET",
            "/v1/agent/apps?scope=publisher&include_deleted=true",
            credential,
        );
        assert_eq!(requests[0].body, Value::Null);
    }

    #[test]
    fn bb_apps_get_process_encodes_app_id_and_preserves_versions() {
        let credential = "apps-e2e-only.get.session+credential";
        let app = json!({
            "ok": true,
            "app": {
                "app_id": "merchant/lookup app",
                "environment": "staging",
                "role": "owner",
                "ready": true,
                "route_revision": 9
            },
            "versions": [{
                "version_id": "ver-123",
                "deployment_id": "dpl-123",
                "active": true
            }]
        });
        let auth_server = ProcessServer::start(vec![process_auth_response()]);
        let control_plane = ProcessServer::start(vec![ProcessResponse::json(app.clone())]);
        let mut command = process_command(
            &auth_server,
            &control_plane,
            &[
                "apps",
                "get",
                "merchant/lookup app",
                "--environment",
                "staging",
                "--base-url",
                APPROVED_TEST_BASE_URL,
                "--client-version",
                "0.2.0",
                "--json",
            ],
            credential,
        );

        let output = command.output().expect("run Apps get process command");
        assert!(output.status.success());
        assert_eq!(
            serde_json::from_str::<Value>(&process_stdout(&output))
                .expect("parse get process output"),
            app
        );
        let auth_requests = auth_server.finish();
        let requests = control_plane.finish();
        assert_process_auth(&auth_requests[0], credential);
        assert_process_control_plane(
            &requests[0],
            "GET",
            "/v1/agent/apps/merchant%2Flookup%20app?environment=staging",
            credential,
        );
    }

    #[test]
    fn bb_apps_versions_process_preserves_rollback_candidates() {
        let credential = "apps-e2e-only.versions.session+credential";
        let versions = json!({
            "ok": true,
            "app_id": "merchant-lookup",
            "environment": "staging",
            "active_version_id": "ver-123",
            "count": 2,
            "versions": [
                {"version_id": "ver-123", "route_revision": 9, "active": true},
                {"version_id": "ver-122", "route_revision": 8, "active": false}
            ]
        });
        let auth_server = ProcessServer::start(vec![process_auth_response()]);
        let control_plane = ProcessServer::start(vec![ProcessResponse::json(versions.clone())]);
        let mut command = process_command(
            &auth_server,
            &control_plane,
            &[
                "apps",
                "versions",
                "merchant-lookup",
                "--environment",
                "staging",
                "--base-url",
                APPROVED_TEST_BASE_URL,
                "--client-version",
                "0.2.0",
                "--json",
            ],
            credential,
        );

        let output = command.output().expect("run Apps versions process command");
        assert!(output.status.success());
        assert_eq!(
            serde_json::from_str::<Value>(&process_stdout(&output))
                .expect("parse versions process output"),
            versions
        );
        let auth_requests = auth_server.finish();
        let requests = control_plane.finish();
        assert_process_auth(&auth_requests[0], credential);
        assert_process_control_plane(
            &requests[0],
            "GET",
            "/v1/agent/apps/merchant-lookup/versions?environment=staging",
            credential,
        );
    }

    #[test]
    fn bb_apps_create_process_runs_plan_and_initialize() {
        let credential = "apps-e2e-only.create.session+credential";
        let plan = json!({
            "app_id": "merchant-lookup",
            "display_name": "Merchant Lookup",
            "environment": "staging",
            "persistence": "sqlite",
            "runtime_class": "default",
            "initialize": {"required": true, "recommended": false}
        });
        let initialized = json!({
            "app_id": "merchant-lookup-2",
            "external_url": "https://merchant-lookup-2--bpsites.example/"
        });
        let auth_server = ProcessServer::start(vec![process_auth_response()]);
        let control_plane = ProcessServer::start(vec![
            ProcessResponse::json(plan.clone()),
            ProcessResponse::json(initialized.clone()),
        ]);
        let mut command = process_command(
            &auth_server,
            &control_plane,
            &[
                "apps",
                "create",
                "--app-id",
                "merchant-lookup",
                "--name",
                "Merchant Lookup",
                "--environment",
                "staging",
                "--runtime-profile",
                "fetch-js",
                "--persistence",
                "sqlite",
                "--base-url",
                APPROVED_TEST_BASE_URL,
                "--client-version",
                "0.2.0",
                "--json",
            ],
            credential,
        );

        let output = command.output().expect("run Apps create process command");
        assert!(
            output.status.success(),
            "stderr was: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let value = serde_json::from_str::<Value>(&process_stdout(&output))
            .expect("parse create process output");
        assert_eq!(value["app_id"], "merchant-lookup-2");
        assert_eq!(value["initialized"], true);
        assert_eq!(value["plan"], plan);
        assert_eq!(value["initialize"], initialized);
        let auth_requests = auth_server.finish();
        let requests = control_plane.finish();
        assert_process_auth(&auth_requests[0], credential);
        assert_eq!(requests.len(), 2);
        assert_process_control_plane(&requests[0], "POST", APPS_PLAN_PATH, credential);
        assert_eq!(
            requests[0].body,
            json!({
                "app_id": "merchant-lookup",
                "name": "Merchant Lookup",
                "environment": "staging",
                "runtime_profile": "fetch-js",
                "persistence": "sqlite",
                "client_version": "0.2.0"
            })
        );
        assert_process_control_plane(
            &requests[1],
            "POST",
            "/v1/agent/apps/merchant-lookup/initialize",
            credential,
        );
    }

    #[test]
    fn bb_apps_create_process_skips_unrequested_initialize() {
        let credential = "apps-e2e-only.existing.session+credential";
        let plan = json!({
            "app_id": "existing-app",
            "external_url": "https://existing-app--bpsites.example/",
            "initialize": {"required": false, "recommended": false}
        });
        let auth_server = ProcessServer::start(vec![process_auth_response()]);
        let control_plane = ProcessServer::start(vec![ProcessResponse::json(plan.clone())]);
        let mut command = process_command(
            &auth_server,
            &control_plane,
            &[
                "apps",
                "create",
                "--app-id",
                "existing-app",
                "--base-url",
                APPROVED_TEST_BASE_URL,
                "--client-version",
                "0.2.0",
                "--json",
            ],
            credential,
        );

        let output = command.output().expect("run Apps create process command");
        assert!(output.status.success());
        let value = serde_json::from_str::<Value>(&process_stdout(&output))
            .expect("parse create process output");
        assert_eq!(value["app_id"], "existing-app");
        assert_eq!(value["initialized"], false);
        assert_eq!(value["initialize"], Value::Null);
        let auth_requests = auth_server.finish();
        let requests = control_plane.finish();
        assert_process_auth(&auth_requests[0], credential);
        assert_eq!(requests.len(), 1);
        assert_process_control_plane(&requests[0], "POST", APPS_PLAN_PATH, credential);
    }

    #[test]
    fn bb_apps_deploy_process_uploads_multipart_artifact() {
        let credential = "apps-e2e-only.deploy.session+credential";
        let deployed = json!({
            "ok": true,
            "app_id": "merchant-lookup",
            "version_id": "ver-123",
            "deployment_id": "dpl-123"
        });
        let auth_server = ProcessServer::start(vec![process_auth_response()]);
        let control_plane = ProcessServer::start(vec![ProcessResponse::json(deployed.clone())]);
        let temp = tempfile::tempdir().expect("create deploy process temp directory");
        let artifact = temp.path().join("prepared-app.tar.gz");
        fs::write(&artifact, "test-hotpod-artifact-marker").expect("write deploy artifact");
        let artifact_text = artifact.to_str().expect("artifact path UTF-8");
        let mut command = process_command(
            &auth_server,
            &control_plane,
            &[
                "apps",
                "deploy",
                "merchant-lookup",
                artifact_text,
                "--environment",
                "production",
                "--version-id",
                "ver-123",
                "--deployment-id",
                "dpl-123",
                "--base-url",
                APPROVED_TEST_BASE_URL,
                "--client-version",
                "0.2.0",
                "--json",
            ],
            credential,
        );

        let output = command.output().expect("run Apps deploy process command");
        assert!(output.status.success());
        assert_eq!(
            serde_json::from_str::<Value>(&process_stdout(&output))
                .expect("parse deploy process output"),
            deployed
        );
        let auth_requests = auth_server.finish();
        let requests = control_plane.finish();
        assert_process_auth(&auth_requests[0], credential);
        assert_eq!(requests.len(), 1);
        assert_process_control_plane(
            &requests[0],
            "POST",
            "/v1/agent/apps/merchant-lookup/deploy",
            credential,
        );
        let body = String::from_utf8_lossy(&requests[0].body_bytes);
        for expected in [
            "test-hotpod-artifact-marker",
            "name=\"environment\"\r\n\r\nproduction",
            "name=\"version_id\"\r\n\r\nver-123",
            "name=\"deployment_id\"\r\n\r\ndpl-123",
        ] {
            assert!(body.contains(expected), "multipart omitted {expected:?}");
        }
    }

    #[test]
    fn bb_apps_rollback_process_sends_target_and_preserves_readiness() {
        let credential = "apps-e2e-only.rollback.session+credential";
        let rollback = json!({
            "ok": true,
            "app_id": "merchant/lookup app",
            "environment": "staging/west",
            "version_id": "ver/122?stable=true",
            "previous_version_id": "ver-123",
            "deployment_id": "dpl-122",
            "route_revision": 10,
            "external_url": "https://merchant-lookup--bpsites.example/",
            "readiness": {
                "control_plane_url": "/v1/agent/apps/merchant-lookup/ready?environment=staging&version_id=ver-122",
                "diagnostics_url": "/v1/agent/apps/merchant-lookup/debug?environment=staging&version_id=ver-122"
            },
            "next_api_calls": [{
                "method": "GET",
                "path": "/v1/agent/apps/merchant-lookup/ready?environment=staging&version_id=ver-122",
                "when": "poll until ready is true"
            }]
        });
        let auth_server = ProcessServer::start(vec![process_auth_response()]);
        let control_plane = ProcessServer::start(vec![ProcessResponse::json(rollback.clone())]);
        let mut command = process_command(
            &auth_server,
            &control_plane,
            &[
                "apps",
                "rollback",
                "merchant/lookup app",
                "--environment",
                "staging/west",
                "--version-id",
                "ver/122?stable=true",
                "--base-url",
                APPROVED_TEST_BASE_URL,
                "--client-version",
                "0.2.0",
                "--json",
            ],
            credential,
        );

        let output = command.output().expect("run Apps rollback process command");
        assert!(
            output.status.success(),
            "stderr was: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(
            serde_json::from_str::<Value>(&process_stdout(&output))
                .expect("parse rollback process output"),
            rollback
        );
        let auth_requests = auth_server.finish();
        let requests = control_plane.finish();
        assert_process_auth(&auth_requests[0], credential);
        assert_eq!(requests.len(), 1);
        assert_process_control_plane(
            &requests[0],
            "POST",
            "/v1/agent/apps/merchant%2Flookup%20app/rollback",
            credential,
        );
        assert_eq!(
            requests[0].body,
            json!({
                "environment": "staging/west",
                "version_id": "ver/122?stable=true"
            })
        );
    }

    #[test]
    fn bb_apps_delete_process_sends_confirmed_target_and_preserves_retention_details() {
        let credential = "apps-e2e-only.delete.session+credential";
        let deleted = json!({
            "ok": true,
            "app_id": "merchant/lookup app",
            "environment": "staging/west",
            "owner": "apps-user",
            "deleted_by": "apps-user",
            "deleted_at": "2026-09-02T20:00:00Z",
            "active_route_ref": "s3://apps/merchant-lookup/staging/active.json",
            "route_revision": 11,
            "status": "idle",
            "artifacts_retained": true,
            "stack_retained": true,
            "versions_retained": 3
        });
        let auth_server = ProcessServer::start(vec![process_auth_response()]);
        let control_plane = ProcessServer::start(vec![ProcessResponse::json(deleted.clone())]);
        let mut command = process_command(
            &auth_server,
            &control_plane,
            &[
                "apps",
                "delete",
                "merchant/lookup app",
                "--confirm-app-id",
                "merchant/lookup app",
                "--environment",
                "staging/west",
                "--confirm-environment",
                "staging/west",
                "--base-url",
                APPROVED_TEST_BASE_URL,
                "--client-version",
                "0.2.0",
                "--json",
            ],
            credential,
        );

        let output = command.output().expect("run Apps delete process command");
        assert!(
            output.status.success(),
            "stderr was: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(
            serde_json::from_str::<Value>(&process_stdout(&output))
                .expect("parse delete process output"),
            deleted
        );
        let auth_requests = auth_server.finish();
        let requests = control_plane.finish();
        assert_process_auth(&auth_requests[0], credential);
        assert_eq!(requests.len(), 1);
        assert_process_control_plane(
            &requests[0],
            "DELETE",
            "/v1/agent/apps/merchant%2Flookup%20app",
            credential,
        );
        assert_eq!(requests[0].body, json!({"environment": "staging/west"}));
    }

    #[test]
    fn bb_apps_delete_rejects_mismatched_confirmation_before_auth_or_network() {
        let credential = "apps-e2e-only.delete-mismatch.session+credential";
        let auth_server = ProcessServer::start(vec![]);
        let control_plane = ProcessServer::start(vec![]);
        let mut command = process_command(
            &auth_server,
            &control_plane,
            &[
                "apps",
                "delete",
                "merchant-lookup",
                "--confirm-app-id",
                "different-app",
                "--environment",
                "production",
                "--confirm-environment",
                "production",
                "--base-url",
                APPROVED_TEST_BASE_URL,
                "--json",
            ],
            credential,
        );

        let output = command
            .output()
            .expect("run Apps delete with mismatched confirmation");
        assert!(!output.status.success());
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(stderr.contains("--confirm-app-id to exactly match APP_ID (merchant-lookup)"));
        assert!(!stderr.contains(credential));
        assert!(auth_server.finish().is_empty());
        assert!(control_plane.finish().is_empty());
    }

    #[test]
    fn bb_apps_delete_rejects_mismatched_environment_before_auth_or_network() {
        let credential = "apps-e2e-only.delete-environment-mismatch.session+credential";
        let auth_server = ProcessServer::start(vec![]);
        let control_plane = ProcessServer::start(vec![]);
        let mut command = process_command(
            &auth_server,
            &control_plane,
            &[
                "apps",
                "delete",
                "merchant-lookup",
                "--confirm-app-id",
                "merchant-lookup",
                "--environment",
                "staging",
                "--confirm-environment",
                "production",
                "--base-url",
                APPROVED_TEST_BASE_URL,
                "--json",
            ],
            credential,
        );

        let output = command
            .output()
            .expect("run Apps delete with mismatched environment confirmation");
        assert!(!output.status.success());
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(stderr.contains("--confirm-environment to exactly match --environment (staging)"));
        assert!(!stderr.contains(credential));
        assert!(auth_server.finish().is_empty());
        assert!(control_plane.finish().is_empty());
    }

    #[test]
    fn bb_apps_ready_process_requests_exact_version_and_preserves_response() {
        let credential = "apps-e2e-only.ready.session+credential";
        let ready = json!({
            "ok": true,
            "app_id": "merchant-lookup",
            "version_id": "ver/123?route=active",
            "ready": false,
            "status": "runner_unavailable",
            "active_version_id": "ver/123?route=active",
            "route_revision": 8,
            "readiness": {
                "control_plane_url": "/v1/agent/apps/merchant-lookup/ready?version_id=ver-123",
                "diagnostics_url": "/v1/agent/apps/merchant-lookup/debug?version_id=ver-123"
            },
            "runner_readiness": {
                "http_status": 503,
                "error": {"code": "runner_readiness_unreachable"}
            },
            "next_action": "Call the diagnostics endpoint."
        });
        let auth_server = ProcessServer::start(vec![process_auth_response()]);
        let control_plane = ProcessServer::start(vec![ProcessResponse::json(ready.clone())]);
        let mut command = process_command(
            &auth_server,
            &control_plane,
            &[
                "apps",
                "ready",
                "merchant/lookup app",
                "--version-id",
                "ver/123?route=active",
                "--environment",
                "staging/west?cell=1",
                "--base-url",
                APPROVED_TEST_BASE_URL,
                "--client-version",
                "0.2.0",
                "--json",
            ],
            credential,
        );

        let output = command.output().expect("run Apps ready process command");
        assert!(
            output.status.success(),
            "stderr was: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(
            serde_json::from_str::<Value>(&process_stdout(&output))
                .expect("parse ready process output"),
            ready
        );
        let auth_requests = auth_server.finish();
        let requests = control_plane.finish();
        assert_process_auth(&auth_requests[0], credential);
        assert_eq!(requests.len(), 1);
        assert_process_control_plane(
            &requests[0],
            "GET",
            "/v1/agent/apps/merchant%2Flookup%20app/ready?environment=staging%2Fwest%3Fcell%3D1&version_id=ver%2F123%3Froute%3Dactive",
            credential,
        );
        assert_eq!(requests[0].body, Value::Null);
    }

    #[test]
    fn bb_apps_debug_process_preserves_partial_diagnostics() {
        let credential = "apps-e2e-only.debug.session+credential";
        let debug = json!({
            "ok": true,
            "complete": false,
            "status": "incomplete",
            "app_id": "merchant-lookup",
            "version_id": "ver-123",
            "route": {"active_version_id": "ver-122", "version_matches": false},
            "runner_readiness": {"http_status": 503},
            "pods": [{
                "name": "hotpod-runner-abc",
                "logs": [{"container": "hotpod-runner", "current": "useful log line"}]
            }],
            "events": [{"reason": "FailedScheduling", "message": "insufficient cpu"}],
            "issues": [{"code": "route_version_mismatch", "severity": "warning"}],
            "collection_errors": [{"source": "deployment", "message": "temporarily unavailable"}],
            "next_actions": ["Retry the debug request."]
        });
        let auth_server = ProcessServer::start(vec![process_auth_response()]);
        let control_plane = ProcessServer::start(vec![ProcessResponse::json(debug.clone())]);
        let mut command = process_command(
            &auth_server,
            &control_plane,
            &[
                "apps",
                "debug",
                "merchant-lookup",
                "--environment",
                "staging",
                "--version-id",
                "ver-123",
                "--tail-lines",
                "75",
                "--base-url",
                APPROVED_TEST_BASE_URL,
                "--client-version",
                "0.2.0",
                "--json",
            ],
            credential,
        );

        let output = command.output().expect("run Apps debug process command");
        assert!(
            output.status.success(),
            "stderr was: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(
            serde_json::from_str::<Value>(&process_stdout(&output))
                .expect("parse debug process output"),
            debug
        );
        let auth_requests = auth_server.finish();
        let requests = control_plane.finish();
        assert_process_auth(&auth_requests[0], credential);
        assert_eq!(requests.len(), 1);
        assert_process_control_plane(
            &requests[0],
            "GET",
            "/v1/agent/apps/merchant-lookup/debug?environment=staging&version_id=ver-123&tail_lines=75",
            credential,
        );
        assert_eq!(requests[0].body, Value::Null);
    }

    fn test_control_plane_client(base_url: &str, timeout: Duration) -> ControlPlaneClient {
        ControlPlaneClient::new_for_test(
            APPROVED_TEST_BASE_URL,
            "1.0.0",
            Style::new(true, false, false),
            timeout,
            Box::new(
                LoopbackTestTransport::new(base_url, timeout)
                    .expect("build loopback test transport"),
            ),
        )
        .expect("build test control-plane client")
    }

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
    fn compose_session_uses_the_exact_credential_returned_by_login() {
        let secret = "session_stored_after_browser_login_12345";
        let credential = ComposeSessionCredential::from_stored(StoredSessionCredential {
            session_credential: secret.to_string(),
            expires_at: Some("2099-01-01T00:00:00Z".to_string()),
        })
        .expect("use returned login credential");

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
        let client = test_control_plane_client(&base_url, Duration::from_secs(2));

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
        let client = test_control_plane_client(&base_url, Duration::from_secs(2));
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
        let client = test_control_plane_client(&base_url, Duration::from_secs(2));
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
        let client = test_control_plane_client(&base_url, Duration::from_secs(2));

        let error = client
            .contract(&test_credential(secret))
            .expect_err("reject failed request");
        let message = format!("{error:#}");

        assert!(!message.contains(secret));
        assert!(message.contains("[REDACTED]"));
        server_thread.join().expect("join request server");
    }

    #[test]
    fn successful_response_rejects_secret_bearing_keys_without_collisions() {
        let server = Server::http("127.0.0.1:0").expect("bind control-plane server");
        let base_url = format!("http://{}", server.server_addr());
        let secret = "reflected_key_session_credential_123456";
        let mut nested = Map::new();
        nested.insert(secret.to_string(), json!("secret-key value"));
        nested.insert("[REDACTED]".to_string(), json!("existing value"));
        let response_body = json!({"nested": Value::Object(nested)}).to_string();
        let server_thread = thread::spawn(move || {
            let request = server.recv().expect("receive request");
            request
                .respond(Response::from_string(response_body))
                .expect("send reflected key response");
        });
        let client = test_control_plane_client(&base_url, Duration::from_secs(2));

        let error = client
            .contract(&test_credential(secret))
            .expect_err("reject a successful response with the session in an object key");
        let message = format!("{error:#}");

        assert!(message.contains("object key"));
        assert!(!message.contains(secret));
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
        let client = test_control_plane_client(&base_url, Duration::from_secs(1));

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
        let client = test_control_plane_client(&base_url, Duration::from_secs(2));
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
    fn rollback_supports_previous_and_explicit_version_requests() {
        let server = Server::http("127.0.0.1:0").expect("bind control-plane server");
        let base_url = format!("http://{}", server.server_addr());
        let server_thread = thread::spawn(move || {
            for (expected_path, expected_body) in [
                ("/v1/agent/apps/app%2Fwith%20space/rollback", json!({})),
                (
                    "/v1/agent/apps/app%2Fwith%20space/rollback",
                    json!({
                        "environment": "staging/west?cell=1",
                        "version_id": "ver/123?stable=true"
                    }),
                ),
            ] {
                let mut request = server.recv().expect("receive rollback request");
                assert_eq!(request.method().as_str(), "POST");
                assert_eq!(request.url(), expected_path);
                let mut body = String::new();
                request
                    .as_reader()
                    .read_to_string(&mut body)
                    .expect("read rollback request body");
                assert_eq!(
                    serde_json::from_str::<Value>(&body).expect("parse rollback request body"),
                    expected_body
                );
                request
                    .respond(
                        Response::from_string(r#"{"ok":true}"#).with_header(
                            Header::from_bytes("Content-Type", "application/json")
                                .expect("build content type"),
                        ),
                    )
                    .expect("respond to rollback request");
            }
        });
        let client = test_control_plane_client(&base_url, Duration::from_secs(2));
        let credential = test_credential("rollback_session_credential_123456");

        for request in [
            RollbackRequest {
                environment: None,
                version_id: None,
            },
            RollbackRequest {
                environment: Some("staging/west?cell=1"),
                version_id: Some("ver/123?stable=true"),
            },
        ] {
            client
                .rollback(&credential, "app/with space", &request)
                .expect("request rollback response");
        }

        server_thread.join().expect("join control-plane server");
    }

    #[test]
    fn delete_sends_the_explicit_environment() {
        let server = Server::http("127.0.0.1:0").expect("bind control-plane server");
        let base_url = format!("http://{}", server.server_addr());
        let server_thread = thread::spawn(move || {
            let mut request = server.recv().expect("receive delete request");
            assert_eq!(request.method().as_str(), "DELETE");
            assert_eq!(request.url(), "/v1/agent/apps/app%2Fwith%20space");
            let mut body = String::new();
            request
                .as_reader()
                .read_to_string(&mut body)
                .expect("read delete request body");
            assert_eq!(
                serde_json::from_str::<Value>(&body).expect("parse delete request body"),
                json!({"environment": "staging/west?cell=1"})
            );
            request
                .respond(
                    Response::from_string(r#"{"ok":true}"#).with_header(
                        Header::from_bytes("Content-Type", "application/json")
                            .expect("build content type"),
                    ),
                )
                .expect("respond to delete request");
        });
        let client = test_control_plane_client(&base_url, Duration::from_secs(2));
        let credential = test_credential("delete_session_credential_123456");

        client
            .delete_app(
                &credential,
                "app/with space",
                &DeleteAppRequest {
                    environment: "staging/west?cell=1",
                },
            )
            .expect("request delete response");

        server_thread.join().expect("join control-plane server");
    }

    #[test]
    fn delete_confirmation_requires_exact_app_and_environment_matches() {
        validate_delete_confirmation("merchant-lookup", "staging", "merchant-lookup", "staging")
            .expect("accept exact delete target confirmation");
        for confirmation in ["different-app", "Merchant-Lookup", "merchant-lookup "] {
            let error =
                validate_delete_confirmation("merchant-lookup", "staging", confirmation, "staging")
                    .expect_err("reject mismatched app id confirmation");
            assert!(error.to_string().contains("exactly match APP_ID"));
            assert!(!error.to_string().contains(confirmation));
        }
        for confirmation in ["production", "Staging", "staging "] {
            let error = validate_delete_confirmation(
                "merchant-lookup",
                "staging",
                "merchant-lookup",
                confirmation,
            )
            .expect_err("reject mismatched environment confirmation");
            assert!(error.to_string().contains("exactly match --environment"));
            assert!(!error.to_string().contains(confirmation));
        }
    }

    #[test]
    fn delete_reports_unknown_outcome_for_an_unreadable_success_response() {
        let server = Server::http("127.0.0.1:0").expect("bind control-plane server");
        let base_url = format!("http://{}", server.server_addr());
        let server_thread = thread::spawn(move || {
            let request = server.recv().expect("receive delete request");
            assert_eq!(request.method().as_str(), "DELETE");
            request
                .respond(Response::from_string("not-json"))
                .expect("respond with unreadable success body");
        });
        let client = test_control_plane_client(&base_url, Duration::from_secs(2));
        let credential_value = "delete_unknown_session_credential_123456";
        let credential = test_credential(credential_value);

        let error = client
            .delete_app(
                &credential,
                "merchant-lookup",
                &DeleteAppRequest {
                    environment: "staging",
                },
            )
            .expect_err("reject unreadable delete success response");
        let (exit_code, payload) = failure_info(&error);
        assert_eq!(exit_code, exit_codes::NETWORK);
        assert_eq!(payload["error"]["code"], "delete_outcome_unknown");
        let message = payload["error"]["message"]
            .as_str()
            .expect("outcome error message");
        assert!(message.contains("may have succeeded"));
        assert!(message.contains("bb apps get <APP_ID> --environment <ENVIRONMENT>"));
        assert!(message.contains("app.status"));
        assert!(!message.contains(credential_value));

        server_thread.join().expect("join control-plane server");
    }

    #[test]
    fn ready_and_debug_build_each_supported_environment_query_shape() {
        let server = Server::http("127.0.0.1:0").expect("bind control-plane server");
        let base_url = format!("http://{}", server.server_addr());
        let expected_paths = [
            "/v1/agent/apps/app/ready?version_id=ver-123",
            "/v1/agent/apps/app/ready?environment=staging%2Fwest%3Fcell%3D1&version_id=ver%2F123%3Factive",
            "/v1/agent/apps/app/debug",
            "/v1/agent/apps/app/debug?environment=staging%2Fwest%3Fcell%3D1",
            "/v1/agent/apps/app/debug?version_id=ver%2F123%3Factive",
            "/v1/agent/apps/app/debug?tail_lines=25",
            "/v1/agent/apps/app/debug?environment=staging&version_id=ver-123",
            "/v1/agent/apps/app/debug?environment=staging&tail_lines=50",
            "/v1/agent/apps/app/debug?version_id=ver-123&tail_lines=75",
            "/v1/agent/apps/app/debug?environment=staging&version_id=ver-123&tail_lines=100",
        ];
        let server_thread = thread::spawn(move || {
            for (index, expected_path) in expected_paths.into_iter().enumerate() {
                let request = server.recv().expect("receive debug request");
                assert_eq!(request.method().as_str(), "GET");
                assert_eq!(request.url(), expected_path);
                request
                    .respond(
                        Response::from_string(format!(r#"{{"request":{index}}}"#)).with_header(
                            Header::from_bytes("Content-Type", "application/json")
                                .expect("build content type"),
                        ),
                    )
                    .expect("respond to debug request");
            }
        });
        let client = test_control_plane_client(&base_url, Duration::from_secs(2));
        let credential = test_credential("debug_query_session_credential_123456");

        assert_eq!(
            client
                .ready(&credential, "app", "ver-123", None)
                .expect("request default-environment ready response")["request"],
            0
        );
        assert_eq!(
            client
                .ready(
                    &credential,
                    "app",
                    "ver/123?active",
                    Some("staging/west?cell=1"),
                )
                .expect("request explicit-environment ready response")["request"],
            1
        );

        for (index, (environment, version_id, tail_lines)) in [
            (None, None, None),
            (Some("staging/west?cell=1"), None, None),
            (None, Some("ver/123?active"), None),
            (None, None, Some(25)),
            (Some("staging"), Some("ver-123"), None),
            (Some("staging"), None, Some(50)),
            (None, Some("ver-123"), Some(75)),
            (Some("staging"), Some("ver-123"), Some(100)),
        ]
        .into_iter()
        .enumerate()
        {
            let response = client
                .debug(&credential, "app", environment, version_id, tail_lines)
                .expect("request debug response");
            assert_eq!(response["request"], index + 2);
        }

        server_thread.join().expect("join control-plane server");
    }

    #[test]
    fn list_builds_each_supported_query_shape() {
        let server = Server::http("127.0.0.1:0").expect("bind control-plane server");
        let base_url = format!("http://{}", server.server_addr());
        let expected_paths = [
            "/v1/agent/apps",
            "/v1/agent/apps?scope=owned",
            "/v1/agent/apps?include_deleted=true",
            "/v1/agent/apps?scope=publisher&include_deleted=true",
        ];
        let server_thread = thread::spawn(move || {
            for (index, expected_path) in expected_paths.into_iter().enumerate() {
                let request = server.recv().expect("receive list request");
                assert_eq!(request.method().as_str(), "GET");
                assert_eq!(request.url(), expected_path);
                request
                    .respond(
                        Response::from_string(format!(r#"{{"request":{index}}}"#)).with_header(
                            Header::from_bytes("Content-Type", "application/json")
                                .expect("build content type"),
                        ),
                    )
                    .expect("respond to list request");
            }
        });
        let client = test_control_plane_client(&base_url, Duration::from_secs(2));
        let credential = test_credential("list_query_session_credential_123456");

        for (index, (scope, include_deleted)) in [
            (None, false),
            (Some("owned"), false),
            (None, true),
            (Some("publisher"), true),
        ]
        .into_iter()
        .enumerate()
        {
            let response = client
                .list_apps(&credential, scope, include_deleted)
                .expect("request list response");
            assert_eq!(response["request"], index);
        }

        server_thread.join().expect("join control-plane server");
    }

    #[test]
    fn get_and_versions_support_default_and_explicit_environments() {
        let server = Server::http("127.0.0.1:0").expect("bind control-plane server");
        let base_url = format!("http://{}", server.server_addr());
        let expected_paths = [
            "/v1/agent/apps/app",
            "/v1/agent/apps/app?environment=staging%2Fwest%3Fcell%3D1",
            "/v1/agent/apps/app/versions",
            "/v1/agent/apps/app/versions?environment=staging%2Fwest%3Fcell%3D1",
        ];
        let server_thread = thread::spawn(move || {
            for (index, expected_path) in expected_paths.into_iter().enumerate() {
                let request = server.recv().expect("receive inspection request");
                assert_eq!(request.method().as_str(), "GET");
                assert_eq!(request.url(), expected_path);
                request
                    .respond(
                        Response::from_string(format!(r#"{{"request":{index}}}"#)).with_header(
                            Header::from_bytes("Content-Type", "application/json")
                                .expect("build content type"),
                        ),
                    )
                    .expect("respond to inspection request");
            }
        });
        let client = test_control_plane_client(&base_url, Duration::from_secs(2));
        let credential = test_credential("inspection_environment_session_credential_123456");

        let responses = [
            client.get_app(&credential, "app", None),
            client.get_app(&credential, "app", Some("staging/west?cell=1")),
            client.versions(&credential, "app", None),
            client.versions(&credential, "app", Some("staging/west?cell=1")),
        ];
        for (index, response) in responses.into_iter().enumerate() {
            assert_eq!(
                response.expect("request inspection response")["request"],
                index
            );
        }

        server_thread.join().expect("join control-plane server");
    }

    #[test]
    fn debug_tail_lines_match_control_plane_bounds() {
        for invalid in ["0", "1001"] {
            let error = command()
                .try_get_matches_from([
                    "apps",
                    "debug",
                    "app",
                    "--tail-lines",
                    invalid,
                    "--base-url",
                    APPROVED_TEST_BASE_URL,
                ])
                .expect_err("reject out-of-range tail lines");
            assert_eq!(error.kind(), clap::error::ErrorKind::ValueValidation);
        }

        for valid in ["1", "1000"] {
            command()
                .try_get_matches_from([
                    "apps",
                    "debug",
                    "app",
                    "--tail-lines",
                    valid,
                    "--base-url",
                    APPROVED_TEST_BASE_URL,
                ])
                .expect("accept bounded tail lines");
        }
    }

    #[test]
    fn app_resource_urls_encode_path_segments_and_query_values() {
        let client = test_control_plane_client("http://127.0.0.1:9", Duration::from_secs(2));

        let url = client
            .app_action_url("app/../../identity", "deploy")
            .expect("build app deploy URL");

        assert_eq!(url.path(), "/v1/agent/apps/app%2F..%2F..%2Fidentity/deploy");

        let app = client
            .app_url("app/with space", &[])
            .expect("build app detail URL");
        assert_eq!(app.path(), "/v1/agent/apps/app%2Fwith%20space");

        let ready = client
            .app_resource_url(
                "app/with space",
                "ready",
                &[("version_id", "version/?&= value".to_string())],
            )
            .expect("build app ready URL");
        assert_eq!(
            request_path(&ready),
            "/v1/agent/apps/app%2Fwith%20space/ready?version_id=version%2F%3F%26%3D+value"
        );
    }
}
