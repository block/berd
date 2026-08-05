use std::env;

use anyhow::{Context, Result};
use clap::builder::{PossibleValuesParser, ValueHint};
use clap::{Arg, ArgAction, ArgGroup, Command};
use serde_json::Value;

use crate::bb::skills_config::{
    normalize_kgoose_service_path, DEFAULT_KGOOSE_SERVICE_PATH, KGOOSE_SERVICE_PATH_ENV_VAR,
};
use crate::kgoose::{DEFAULT_KGOOSE_BASE_URL, DEFAULT_KGOOSE_TIMEOUT_SECS};
use crate::runtime::{LoadedExtension, ParameterKind, RuntimeTool, ScalarKind, ToolParameter};

pub const ROOT_COMMAND_NAME: &str = "agent-tools";
pub const ROOT_BIN_NAME: &str = "sq agent-tools";
pub const ROOT_SUMMARY: &str = "Discover auth-backed tool extensions exposed through kGoose";
pub const TOOLS_COMMAND_NAME: &str = "tools";
pub const BB_TOOLS_BIN_NAME: &str = "bb tools";
pub const APPKIT_COMMAND_NAME: &str = "appkit";
pub const APPKIT_COMMAND_ABOUT: &str = "Cloudflare-backed internal Block App Kit CLI (local exec)";
pub const APPKIT_COMMAND_LONG_ABOUT: &str =
    "Proxies to the Cloudflare-backed internal appkit CLI. This is separate from the external \
 Builderlab Compose control plane exposed at root `bb appkit`.\n\
 Requires appkit on PATH, or uvx to run mcp_block_app_kit on demand.";
pub const EXTENSION_DESCRIBE_COMMAND_NAME: &str = "describe";
pub const EXTENSION_DESCRIBE_COMMAND_ABOUT: &str =
    "Print the full extension description/instructions.";
const IS_BLOX_ENV_VAR: &str = "IS_BLOX";
const BLOX_ENVIRONMENT_ENV_VAR: &str = "BLOX_ENVIRONMENT";
const BLOX_ENVIRONMENT_STAGING: &str = "staging";
const BLOX_ENVIRONMENT_PRODUCTION: &str = "production";
const BLOX_STAGING_BASE_URL: &str = "http://kgoose.cashappservicesstaging.com";
const BLOX_PRODUCTION_BASE_URL: &str = "http://kgoose.cashappservices.com";

#[derive(Debug, Clone, PartialEq)]
pub struct BootstrapArgs {
    pub base_url: String,
    pub service_path: String,
    pub playpen: Option<String>,
    pub goosemcp_playpen: Option<String>,
    pub timeout_secs: f64,
    pub command_tokens: Vec<String>,
    pub write_extensions: Option<String>,
    pub describe_commands: bool,
    pub summary_only: bool,
    pub version_only: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum GlobalValueFlag {
    BaseUrl,
    ServicePath,
    Playpen,
    GoosemcpPlaypen,
    Timeout,
    WriteExtensions,
}

impl GlobalValueFlag {
    fn from_name(name: &str) -> Option<Self> {
        match name {
            "--base-url" => Some(Self::BaseUrl),
            "--kgoose-service-path" => Some(Self::ServicePath),
            "--playpen" => Some(Self::Playpen),
            "--goosemcp-playpen" => Some(Self::GoosemcpPlaypen),
            "--timeout" => Some(Self::Timeout),
            "--write-extensions" => Some(Self::WriteExtensions),
            _ => None,
        }
    }

    fn name(self) -> &'static str {
        match self {
            Self::BaseUrl => "--base-url",
            Self::ServicePath => "--kgoose-service-path",
            Self::Playpen => "--playpen",
            Self::GoosemcpPlaypen => "--goosemcp-playpen",
            Self::Timeout => "--timeout",
            Self::WriteExtensions => "--write-extensions",
        }
    }
}

pub fn global_arg_skip_count(arg: &str) -> usize {
    if GlobalValueFlag::from_name(arg).is_some() {
        2
    } else if split_global_value_assignment(arg).is_some() || is_global_switch_flag(arg) {
        1
    } else {
        0
    }
}

fn split_global_value_assignment(arg: &str) -> Option<(GlobalValueFlag, &str)> {
    let (name, value) = arg.split_once('=')?;
    GlobalValueFlag::from_name(name).map(|flag| (flag, value))
}

fn is_global_switch_flag(arg: &str) -> bool {
    matches!(
        arg,
        "--describe-commands" | "--summary" | "--version" | "-V"
    )
}

pub fn bootstrap_args<I, S>(args: I) -> Result<BootstrapArgs>
where
    I: IntoIterator<Item = S>,
    S: Into<String>,
{
    let env_base_url = read_optional_env("KGOOSE_BASE_URL")?;
    let mut values = BootstrapValueState::from_env()?;

    let mut command_tokens = Vec::new();
    let mut describe_commands = false;
    let mut summary_only = false;
    let mut version_only = false;
    let mut args = args.into_iter().map(Into::into).peekable();

    while let Some(arg) = args.next() {
        if let Some(flag) = GlobalValueFlag::from_name(arg.as_str()) {
            let value = args
                .next()
                .with_context(|| format!("missing value for {}", flag.name()))?;
            apply_global_value_flag(flag, value, &mut values)?;
            continue;
        }

        if let Some((flag, value)) = split_global_value_assignment(&arg) {
            apply_global_value_flag(flag, value.to_string(), &mut values)?;
            continue;
        }

        match arg.as_str() {
            "--describe-commands" => describe_commands = true,
            "--summary" => summary_only = true,
            "--version" | "-V" => version_only = true,
            "--" => {
                command_tokens.extend(args);
                break;
            }
            _ => command_tokens.push(arg),
        }
    }

    Ok(BootstrapArgs {
        base_url: resolve_base_url(
            env_base_url.as_deref(),
            values.cli_base_url.as_deref(),
            read_optional_env(IS_BLOX_ENV_VAR)?.as_deref(),
            read_optional_env(BLOX_ENVIRONMENT_ENV_VAR)?.as_deref(),
        ),
        service_path: values.service_path,
        playpen: values.playpen,
        goosemcp_playpen: values.goosemcp_playpen,
        timeout_secs: values.timeout_secs,
        command_tokens,
        write_extensions: values.write_extensions,
        describe_commands,
        summary_only,
        version_only,
    })
}

fn read_optional_env(name: &str) -> Result<Option<String>> {
    match env::var(name) {
        Ok(value) => Ok(Some(value)),
        Err(env::VarError::NotPresent) => Ok(None),
        Err(err) => anyhow::bail!("failed to read {name}: {err}"),
    }
}

#[derive(Debug)]
struct BootstrapValueState {
    cli_base_url: Option<String>,
    service_path: String,
    playpen: Option<String>,
    goosemcp_playpen: Option<String>,
    timeout_secs: f64,
    write_extensions: Option<String>,
}

impl BootstrapValueState {
    fn from_env() -> Result<Self> {
        let service_path = read_optional_env(KGOOSE_SERVICE_PATH_ENV_VAR)?
            .map(|value| normalize_kgoose_service_path(&value))
            .transpose()?
            .unwrap_or_else(|| DEFAULT_KGOOSE_SERVICE_PATH.to_string());
        let playpen = match env::var("KGOOSE_PLAYPEN") {
            Ok(value) => Some(value),
            Err(env::VarError::NotPresent) => None,
            Err(err) => anyhow::bail!("failed to read KGOOSE_PLAYPEN: {err}"),
        };
        let goosemcp_playpen = match env::var("GOOSEMCP_PLAYPEN") {
            Ok(value) => Some(value),
            Err(env::VarError::NotPresent) => None,
            Err(err) => anyhow::bail!("failed to read GOOSEMCP_PLAYPEN: {err}"),
        };
        let timeout_secs = match env::var("KGOOSE_TIMEOUT") {
            Ok(value) => parse_timeout(&value).context("parse KGOOSE_TIMEOUT")?,
            Err(env::VarError::NotPresent) => DEFAULT_KGOOSE_TIMEOUT_SECS,
            Err(err) => anyhow::bail!("failed to read KGOOSE_TIMEOUT: {err}"),
        };

        Ok(Self {
            cli_base_url: None,
            service_path,
            playpen,
            goosemcp_playpen,
            timeout_secs,
            write_extensions: None,
        })
    }
}

fn apply_global_value_flag(
    flag: GlobalValueFlag,
    value: String,
    values: &mut BootstrapValueState,
) -> Result<()> {
    match flag {
        GlobalValueFlag::BaseUrl => values.cli_base_url = Some(value),
        GlobalValueFlag::ServicePath => {
            values.service_path = normalize_kgoose_service_path(&value)?
        }
        GlobalValueFlag::Playpen => values.playpen = Some(value),
        GlobalValueFlag::GoosemcpPlaypen => values.goosemcp_playpen = Some(value),
        GlobalValueFlag::Timeout => values.timeout_secs = parse_timeout(&value)?,
        GlobalValueFlag::WriteExtensions => values.write_extensions = Some(value),
    }

    Ok(())
}

fn resolve_base_url(
    kgoose_base_url: Option<&str>,
    cli_base_url: Option<&str>,
    is_blox: Option<&str>,
    blox_environment: Option<&str>,
) -> String {
    if let Some(base_url) = kgoose_base_url {
        return base_url.to_string();
    }

    if let Some(base_url) = cli_base_url {
        return base_url.to_string();
    }

    if is_blox == Some("true") {
        match blox_environment {
            Some(BLOX_ENVIRONMENT_STAGING) => return BLOX_STAGING_BASE_URL.to_string(),
            Some(BLOX_ENVIRONMENT_PRODUCTION) => return BLOX_PRODUCTION_BASE_URL.to_string(),
            _ => {}
        }
    }

    DEFAULT_KGOOSE_BASE_URL.to_string()
}

#[cfg(test)]
pub fn build_command(
    extensions: &[crate::runtime::ExtensionSummary],
    loaded_extension: Option<&LoadedExtension>,
) -> Command {
    build_tools_command(
        ToolCommandConfig {
            command_name: ROOT_COMMAND_NAME,
            bin_name: ROOT_BIN_NAME,
            example: "sq agent-tools utils calculate --numbers 2 3 --operation add",
        },
        extensions,
        loaded_extension,
    )
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ToolCommandConfig {
    pub command_name: &'static str,
    pub bin_name: &'static str,
    pub example: &'static str,
}

pub fn build_tools_command(
    config: ToolCommandConfig,
    extensions: &[crate::runtime::ExtensionSummary],
    loaded_extension: Option<&LoadedExtension>,
) -> Command {
    let mut command = Command::new(config.command_name)
        .bin_name(config.bin_name)
        .version(env!("CARGO_PKG_VERSION"))
        .about(ROOT_SUMMARY)
        .subcommand_required(true)
        .arg_required_else_help(true)
        .disable_help_subcommand(true)
        .subcommand_help_heading("Extensions")
        .after_help(leak_str(format!("Examples:\n  {}", config.example)))
        .after_long_help(
            "Environment:\n  KGOOSE_BASE_URL\n  KGOOSE_SERVICE_PATH\n  KGOOSE_PLAYPEN\n  GOOSEMCP_PLAYPEN\n  KGOOSE_TIMEOUT\n  STS_ACCESS_TOKEN",
        );

    for arg in global_args() {
        command = command.arg(arg);
    }

    command = command.subcommand(appkit_command());

    for extension in extensions
        .iter()
        .filter(|extension| extension.name != APPKIT_COMMAND_NAME)
    {
        let mut subcommand = Command::new(leak_str(extension.name.clone()))
            .about(leak_str(extension.about.clone()))
            .arg_required_else_help(true)
            .disable_help_subcommand(true)
            .subcommand_help_heading("Commands");

        if let Some(loaded) = loaded_extension.filter(|loaded| loaded.name == extension.name) {
            subcommand = subcommand
                .long_about(leak_str(extension_help_preview(&loaded.description)))
                .subcommand(extension_describe_command());
            for tool in &loaded.tools {
                subcommand = subcommand.subcommand(build_tool_command(tool));
            }
        }

        command = command.subcommand(subcommand);
    }

    command
}

fn appkit_command() -> Command {
    Command::new(APPKIT_COMMAND_NAME)
        .about(APPKIT_COMMAND_ABOUT)
        .long_about(APPKIT_COMMAND_LONG_ABOUT)
        .arg_required_else_help(true)
        .disable_help_subcommand(true)
}

fn extension_describe_command() -> Command {
    Command::new(EXTENSION_DESCRIBE_COMMAND_NAME).about(EXTENSION_DESCRIBE_COMMAND_ABOUT)
}

fn global_args() -> Vec<Arg> {
    vec![
        Arg::new("base-url")
            .long("base-url")
            .global(true)
            // Hidden because `sq` help/discovery cannot honor dynamic target selection.
            .hide(true)
            .env("KGOOSE_BASE_URL")
            .value_name("URL")
            .help("Base URL for the kgoose service. [default: prod, use https://kgoose.stage.sqprod.co for staging]")
            .value_hint(ValueHint::Url),
        Arg::new("playpen")
            .long("playpen")
            .global(true)
            // Hidden because `sq` help/discovery cannot honor dynamic target selection.
            .hide(true)
            .env("KGOOSE_PLAYPEN")
            .value_name("NAME")
            .help("Route the kgoose service with `Baggage: kgoose-playpen=<name>`."),
        Arg::new("kgoose-service-path")
            .long("kgoose-service-path")
            .global(true)
            .hide(true)
            .env(KGOOSE_SERVICE_PATH_ENV_VAR)
            .value_name("PATH")
            .help("Path prefix for kgoose endpoints. [default: /cash-app/goose]"),
        Arg::new("goosemcp-playpen")
            .long("goosemcp-playpen")
            .global(true)
            // Hidden because `sq` help/discovery cannot honor dynamic target selection.
            .hide(true)
            .env("GOOSEMCP_PLAYPEN")
            .value_name("NAME")
            .help(
                "Route the downstream goosemcp Envoy with `Baggage: envoy-route--goosemcp=playpen-<name>`. Only set when a matching playpen pod exists.",
            ),
        Arg::new("timeout")
            .long("timeout")
            .global(true)
            .env("KGOOSE_TIMEOUT")
            .value_name("SECONDS")
            .value_parser(parse_timeout)
            .help("HTTP request timeout in seconds."),
    ]
}

fn build_tool_command(tool: &RuntimeTool) -> Command {
    let mut command = Command::new(leak_str(tool.cli_name.clone()))
        .about(leak_str(tool.about.clone()))
        .long_about(leak_str(tool.description.clone()))
        .disable_help_subcommand(true)
        .after_help("Use `--json '{...}'` for nested object or array payloads.");

    if tool.kgoose_name != tool.cli_name {
        command = command.alias(leak_str(tool.kgoose_name.clone()));
    }

    let mut json_arg = Arg::new("json")
        .long("json")
        .value_name("JSON")
        .help("Provide the entire tool payload as a JSON object.")
        .help_heading("Command options")
        .allow_hyphen_values(true);

    command = command.arg(
        Arg::new("raw")
            .long("raw")
            .action(ArgAction::SetTrue)
            .help("Print the full CallToolResponse envelope as JSON.")
            .help_heading("Command options"),
    );

    command = command.arg(
        Arg::new("header")
            .long("header")
            .action(ArgAction::Append)
            .num_args(1)
            .value_name("KEY=VALUE")
            .help("Forward a header to CallToolRequest.headers. Repeatable.")
            .help_heading("Command options")
            .allow_hyphen_values(true),
    );

    let mut groups = Vec::new();

    for parameter in &tool.parameters {
        for arg in build_parameter_args(parameter) {
            let arg_id = leak_str(arg.get_id().to_string());
            json_arg = json_arg.conflicts_with(arg_id);
            command = command.arg(arg);
        }

        if let Some(group) = build_parameter_group(parameter) {
            groups.push(group);
        }
    }

    command = command.arg(json_arg);
    for group in groups {
        command = command.group(group);
    }

    command
}

fn build_parameter_args(parameter: &ToolParameter) -> Vec<Arg> {
    match &parameter.kind {
        ParameterKind::Scalar(ScalarKind::Boolean) => build_boolean_args(parameter),
        ParameterKind::Scalar(kind) => vec![apply_enum_values(
            configure_value_parsing(
                base_value_arg(parameter, scalar_value_name(kind)).required(parameter.required),
                parameter,
            ),
            kind,
        )],
        ParameterKind::Array(kind) => vec![apply_enum_values(
            configure_value_parsing(
                base_value_arg(parameter, scalar_value_name(kind))
                    .required(parameter.required)
                    .action(ArgAction::Append)
                    .num_args(1..),
                parameter,
            ),
            kind,
        )],
        ParameterKind::Json => vec![base_value_arg(parameter, "JSON")
            .required(parameter.required)
            .allow_hyphen_values(true)],
    }
}

fn build_boolean_args(parameter: &ToolParameter) -> Vec<Arg> {
    let default_true = parameter.default.as_ref().and_then(Value::as_bool) == Some(true);
    vec![
        bool_arg(parameter, true, default_true),
        bool_arg(parameter, false, default_true),
    ]
}

fn build_parameter_group(parameter: &ToolParameter) -> Option<ArgGroup> {
    if matches!(parameter.kind, ParameterKind::Scalar(ScalarKind::Boolean)) && parameter.required {
        Some(
            ArgGroup::new(leak_str(bool_group_id(parameter)))
                .args([
                    leak_str(bool_true_id(parameter)),
                    leak_str(bool_false_id(parameter)),
                ])
                .required(true),
        )
    } else {
        None
    }
}

fn base_value_arg(parameter: &ToolParameter, value_name: &'static str) -> Arg {
    Arg::new(leak_str(parameter_id(parameter)))
        .long(leak_str(parameter.cli_name.clone()))
        .value_name(value_name)
        .help(leak_str(parameter_help(parameter)))
        .help_heading("Tool options")
        .allow_hyphen_values(allow_hyphen_values(parameter))
}

fn bool_arg(parameter: &ToolParameter, positive: bool, default_true: bool) -> Arg {
    let (id, long, help) = if positive {
        (
            bool_true_id(parameter),
            parameter.cli_name.clone(),
            boolean_help(parameter, default_true, true),
        )
    } else {
        (
            bool_false_id(parameter),
            format!("no-{}", parameter.cli_name),
            boolean_help(parameter, default_true, false),
        )
    };

    let mut arg = Arg::new(leak_str(id))
        .long(leak_str(long))
        .action(ArgAction::SetTrue)
        .help(leak_str(help))
        .help_heading("Tool options")
        .conflicts_with("json");

    arg = arg.conflicts_with(leak_str(if positive {
        bool_false_id(parameter)
    } else {
        bool_true_id(parameter)
    }));

    arg
}

fn boolean_help(parameter: &ToolParameter, default_true: bool, positive: bool) -> String {
    let mut parts = Vec::new();
    if parameter.required {
        parts.push("Required.".to_string());
    } else if default_true {
        parts.push("Default: true.".to_string());
    }

    if let Some(description) = parameter.description.as_deref() {
        let summary = crate::runtime::compact_text(description);
        if !summary.is_empty() {
            parts.push(if positive {
                summary
            } else {
                format!("Disable: {summary}")
            });
        }
    } else if !positive {
        parts.push(format!("Disable `{}`.", parameter.cli_name));
    }

    parts.join(" ")
}

fn parameter_help(parameter: &ToolParameter) -> String {
    let mut parts = Vec::new();
    if parameter.required {
        parts.push("Required.".to_string());
    }
    if let Some(default) = parameter.default.as_ref() {
        parts.push(format!("Default: {}.", json_preview(default)));
    }
    if let Some(description) = parameter.description.as_deref() {
        let summary = crate::runtime::compact_text(description);
        if !summary.is_empty() {
            parts.push(summary);
        }
    }
    parts.join(" ")
}

fn allow_hyphen_values(parameter: &ToolParameter) -> bool {
    matches!(parameter.kind, ParameterKind::Json)
}

fn configure_value_parsing(arg: Arg, parameter: &ToolParameter) -> Arg {
    match parameter.kind {
        ParameterKind::Scalar(ScalarKind::Integer { .. })
        | ParameterKind::Scalar(ScalarKind::Number { .. })
        | ParameterKind::Array(ScalarKind::Integer { .. })
        | ParameterKind::Array(ScalarKind::Number { .. }) => arg.allow_negative_numbers(true),
        _ => arg,
    }
}

fn apply_enum_values(arg: Arg, kind: &ScalarKind) -> Arg {
    let values = match kind {
        ScalarKind::String { enum_values, .. }
        | ScalarKind::Integer { enum_values }
        | ScalarKind::Number { enum_values } => enum_values
            .iter()
            .map(json_preview)
            .map(leak_str)
            .collect::<Vec<_>>(),
        ScalarKind::Boolean => return arg,
    };

    if values.is_empty() {
        arg
    } else {
        arg.value_parser(PossibleValuesParser::new(values))
    }
}

fn scalar_value_name(kind: &ScalarKind) -> &'static str {
    match kind {
        ScalarKind::String { .. } => "TEXT",
        ScalarKind::Integer { .. } => "INTEGER",
        ScalarKind::Number { .. } => "NUMBER",
        ScalarKind::Boolean => "BOOL",
    }
}

pub fn parameter_id(parameter: &ToolParameter) -> String {
    format!("param:{}", parameter.name)
}

pub fn bool_true_id(parameter: &ToolParameter) -> String {
    format!("param:{}:true", parameter.name)
}

pub fn bool_false_id(parameter: &ToolParameter) -> String {
    format!("param:{}:false", parameter.name)
}

fn bool_group_id(parameter: &ToolParameter) -> String {
    format!("param:{}:choice", parameter.name)
}

pub fn parse_timeout(value: &str) -> Result<f64> {
    let timeout_secs = value
        .parse::<f64>()
        .with_context(|| format!("invalid timeout `{value}`"))?;

    if timeout_secs <= 0.0 {
        anyhow::bail!("timeout must be greater than 0 seconds");
    }

    Ok(timeout_secs)
}

fn json_preview(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::String(text) => text.clone(),
        _ => serde_json::to_string(value).unwrap_or_else(|_| value.to_string()),
    }
}

fn extension_help_preview(description: &str) -> String {
    let preview = crate::runtime::compact_text_with_limit(description, 120);

    format!("{preview}\n\nUse `describe` to print the full extension description.")
}

fn leak_str(value: String) -> &'static str {
    Box::leak(value.into_boxed_str())
}

#[cfg(test)]
mod tests {
    use super::{
        bootstrap_args, build_command, extension_help_preview, resolve_base_url,
        BLOX_ENVIRONMENT_PRODUCTION, BLOX_ENVIRONMENT_STAGING, BLOX_PRODUCTION_BASE_URL,
        BLOX_STAGING_BASE_URL, EXTENSION_DESCRIBE_COMMAND_ABOUT, EXTENSION_DESCRIBE_COMMAND_NAME,
    };
    use crate::bb::skills_config::DEFAULT_KGOOSE_SERVICE_PATH;
    use crate::kgoose::DEFAULT_KGOOSE_BASE_URL;
    use crate::runtime::{
        ExtensionSummary, LoadedExtension, ParameterKind, RuntimeTool, ScalarKind, ToolParameter,
    };

    #[test]
    fn bootstrap_args_collects_kgoose_flags_without_consuming_command_tokens() {
        let parsed = bootstrap_args([
            "--base-url",
            "http://127.0.0.1:8080",
            "utils",
            "--playpen",
            "baxen",
            "calculate",
            "--numbers",
            "2",
            "3",
            "--timeout=12.5",
        ])
        .expect("bootstrap args");

        assert_eq!(parsed.base_url, "http://127.0.0.1:8080");
        assert_eq!(parsed.service_path, DEFAULT_KGOOSE_SERVICE_PATH);
        assert_eq!(parsed.playpen.as_deref(), Some("baxen"));
        assert_eq!(parsed.timeout_secs, 12.5);
        assert!(!parsed.describe_commands);
        assert!(!parsed.summary_only);
        assert_eq!(parsed.write_extensions, None);
        assert_eq!(
            parsed.command_tokens,
            vec!["utils", "calculate", "--numbers", "2", "3",]
        );
    }

    #[test]
    fn bootstrap_args_parses_write_extensions_flag() {
        let parsed =
            bootstrap_args(["--write-extensions", "extensions.yaml"]).expect("bootstrap args");

        assert_eq!(parsed.write_extensions.as_deref(), Some("extensions.yaml"));
        assert!(parsed.command_tokens.is_empty());
    }

    #[test]
    fn bootstrap_args_recognizes_sq_exoskeleton_flags() {
        let parsed =
            bootstrap_args(["utils", "--describe-commands", "--summary"]).expect("bootstrap args");

        assert_eq!(parsed.base_url, DEFAULT_KGOOSE_BASE_URL);
        assert_eq!(parsed.service_path, DEFAULT_KGOOSE_SERVICE_PATH);
        assert!(parsed.describe_commands);
        assert!(parsed.summary_only);
        assert_eq!(parsed.command_tokens, vec!["utils"]);
    }

    #[test]
    fn bootstrap_args_defaults_to_prod_base_url() {
        let parsed = bootstrap_args(["utils", "calculate"]).expect("bootstrap args");

        assert_eq!(parsed.base_url, DEFAULT_KGOOSE_BASE_URL);
        assert_eq!(parsed.service_path, DEFAULT_KGOOSE_SERVICE_PATH);
        assert_eq!(parsed.command_tokens, vec!["utils", "calculate"]);
    }

    #[test]
    fn bootstrap_args_accepts_base_url_override() {
        let parsed = bootstrap_args(["--base-url", "http://127.0.0.1:8080", "utils", "calculate"])
            .expect("bootstrap args");

        assert_eq!(parsed.base_url, "http://127.0.0.1:8080");
        assert_eq!(parsed.command_tokens, vec!["utils", "calculate"]);
    }

    #[test]
    fn bootstrap_args_accepts_service_path_override() {
        let parsed = bootstrap_args([
            "--kgoose-service-path",
            "cash-app/goose-square/",
            "utils",
            "calculate",
        ])
        .expect("bootstrap args");

        assert_eq!(parsed.service_path, "/cash-app/goose-square");
        assert_eq!(parsed.command_tokens, vec!["utils", "calculate"]);
    }

    #[test]
    fn bootstrap_args_accepts_playpen_with_custom_base_url() {
        let parsed = bootstrap_args([
            "--base-url",
            "https://kgoose.sqprod.co",
            "--playpen",
            "baxen",
            "utils",
        ])
        .expect("bootstrap args");

        assert_eq!(parsed.base_url, "https://kgoose.sqprod.co");
        assert_eq!(parsed.playpen.as_deref(), Some("baxen"));
        assert_eq!(parsed.command_tokens, vec!["utils"]);
    }

    #[test]
    fn resolve_base_url_prefers_explicit_kgoose_base_url() {
        let resolved = resolve_base_url(
            Some("https://explicit.example.test"),
            Some("https://ignored.example.test"),
            Some("true"),
            Some(BLOX_ENVIRONMENT_PRODUCTION),
        );

        assert_eq!(resolved, "https://explicit.example.test");
    }

    #[test]
    fn resolve_base_url_uses_blox_staging_host() {
        let resolved = resolve_base_url(None, None, Some("true"), Some(BLOX_ENVIRONMENT_STAGING));

        assert_eq!(resolved, BLOX_STAGING_BASE_URL);
    }

    #[test]
    fn resolve_base_url_uses_blox_production_host() {
        let resolved =
            resolve_base_url(None, None, Some("true"), Some(BLOX_ENVIRONMENT_PRODUCTION));

        assert_eq!(resolved, BLOX_PRODUCTION_BASE_URL);
    }

    #[test]
    fn resolve_base_url_defaults_when_not_in_blox() {
        let resolved = resolve_base_url(None, None, Some("false"), Some(BLOX_ENVIRONMENT_STAGING));

        assert_eq!(resolved, DEFAULT_KGOOSE_BASE_URL);
    }

    #[test]
    fn resolve_base_url_uses_cli_override_when_env_is_absent() {
        let resolved = resolve_base_url(
            None,
            Some("https://cli.example.test"),
            Some("true"),
            Some(BLOX_ENVIRONMENT_STAGING),
        );

        assert_eq!(resolved, "https://cli.example.test");
    }

    #[test]
    fn build_command_lists_extensions_and_tools() {
        let mut command = build_command(
            &[ExtensionSummary {
                name: "utils".to_string(),
                about: "Utility helpers".to_string(),
            }],
            Some(&LoadedExtension {
                name: "utils".to_string(),
                about: "Utility helpers".to_string(),
                description: "Utility helpers".to_string(),
                tools: vec![RuntimeTool {
                    extension_name: "utils".to_string(),
                    kgoose_name: "calculate".to_string(),
                    cli_name: "calculate".to_string(),
                    about: "Perform math".to_string(),
                    description: "Perform math".to_string(),
                    parameters: vec![ToolParameter {
                        name: "numbers".to_string(),
                        cli_name: "numbers".to_string(),
                        required: true,
                        description: Some("Numbers to add".to_string()),
                        kind: ParameterKind::Array(ScalarKind::Number {
                            enum_values: Vec::new(),
                        }),
                        default: None,
                    }],
                }],
            }),
        );

        let help = command.render_long_help().to_string();
        assert!(help.contains("appkit"));
        assert!(help.contains("Block App Kit CLI (local exec)"));
        assert!(help.contains("utils"));
        assert!(help.contains("Extensions"));
        assert!(help.contains("--timeout"));
        assert!(!help.contains("--base-url"));
        assert!(!help.contains("--playpen"));
    }

    #[test]
    fn extension_help_preview_truncates_and_mentions_describe() {
        let description = format!(
            "{} {}\n\n{}",
            "Slack tools for chat.",
            "Use this extension to search channels, read threads, and post messages.".repeat(20),
            "This second paragraph should only appear in --describe output."
        );

        let preview = extension_help_preview(&description);

        assert!(preview.contains("Use `describe` to print the full extension description."));
        assert!(preview.contains("Slack tools for chat."));
        assert!(preview.contains("..."));
        assert!(!preview.contains("This second paragraph should only appear in --describe output."));
        assert!(preview.ends_with("Use `describe` to print the full extension description."));
    }

    #[test]
    fn build_command_uses_preview_and_describe_for_extension_help() {
        let command = build_command(
            &[ExtensionSummary {
                name: "slack".to_string(),
                about: "Slack tools for chat".to_string(),
            }],
            Some(&LoadedExtension {
                name: "slack".to_string(),
                about: "Slack tools for chat".to_string(),
                description: format!(
                    "{} {}\n\n{}",
                    "Slack tools for chat.",
                    "Use this extension to search channels, read threads, and post messages."
                        .repeat(20),
                    "This second paragraph should only appear in --describe output."
                ),
                tools: vec![RuntimeTool {
                    extension_name: "slack".to_string(),
                    kgoose_name: "search_messages".to_string(),
                    cli_name: "search-messages".to_string(),
                    about: "Search Slack messages".to_string(),
                    description: "Search Slack messages".to_string(),
                    parameters: Vec::new(),
                }],
            }),
        );

        let mut slack = command
            .get_subcommands()
            .find(|subcommand| subcommand.get_name() == "slack")
            .cloned()
            .expect("slack subcommand");
        let help = slack.render_long_help().to_string();

        assert!(help.contains("Slack tools for chat"));
        assert!(help.contains("Commands:"));
        assert!(help.contains(EXTENSION_DESCRIBE_COMMAND_NAME));
        assert!(help.contains(EXTENSION_DESCRIBE_COMMAND_ABOUT));
        assert!(help.contains("search-messages"));
        assert!(help.contains("..."));
        assert!(!help.contains("This second paragraph should only appear in --describe output."));
        assert!(!help.contains("--describe"));
    }

    #[test]
    fn build_command_accepts_extension_describe_subcommand() {
        let command = build_command(
            &[ExtensionSummary {
                name: "slack".to_string(),
                about: "Slack tools for chat".to_string(),
            }],
            Some(&LoadedExtension {
                name: "slack".to_string(),
                about: "Slack tools for chat".to_string(),
                description: "Slack tools for chat".to_string(),
                tools: vec![RuntimeTool {
                    extension_name: "slack".to_string(),
                    kgoose_name: "search_messages".to_string(),
                    cli_name: "search-messages".to_string(),
                    about: "Search Slack messages".to_string(),
                    description: "Search Slack messages".to_string(),
                    parameters: Vec::new(),
                }],
            }),
        );

        let matches = command
            .try_get_matches_from(["agent-tools", "slack", EXTENSION_DESCRIBE_COMMAND_NAME])
            .expect("parse matches");
        let (_, extension_matches) = matches.subcommand().expect("extension");
        let (subcommand_name, _) = extension_matches.subcommand().expect("describe subcommand");

        assert_eq!(subcommand_name, EXTENSION_DESCRIBE_COMMAND_NAME);
    }
}
