mod appkit;
mod bb;
mod catalog;
mod cli;
mod kgoose;
mod proto;
mod runtime;
#[cfg(test)]
mod test_server;

pub use bb::agents_models;
pub use bb::skills_api::{AgentMarketplace, MarketplaceClient};

use std::collections::BTreeMap;

use anyhow::{Context, Result};
use clap::error::ErrorKind;
use clap::{ArgMatches, Command};
use cli::{
    bool_false_id, bool_true_id, bootstrap_args, build_tools_command, parameter_id,
    ToolCommandConfig, APPKIT_COMMAND_ABOUT, APPKIT_COMMAND_NAME, BB_TOOLS_BIN_NAME,
    EXTENSION_DESCRIBE_COMMAND_ABOUT, EXTENSION_DESCRIBE_COMMAND_NAME, ROOT_BIN_NAME,
    ROOT_COMMAND_NAME, ROOT_SUMMARY, TOOLS_COMMAND_NAME,
};
use runtime::{
    load_extension, load_extensions, LoadedExtension, ParameterKind, RuntimeTool, ScalarKind,
    ToolParameter,
};
use serde::Serialize;
use serde_json::{Map, Value};

use crate::bb::auth_storage::stored_session_credential_header_value_for_kgoose_base_url;
use crate::bb::org_routing::resolve_org_kgoose_base_url;
use crate::bb::skills_config::{
    default_bb_home, default_preferences_path, normalize_kgoose_service_path, read_optional_env,
    read_preferences_file, resolve_skills_profile_context, SkillsProfileResolveOptions,
    BB_HOME_ENV_VAR, DEFAULT_KGOOSE_SERVICE_PATH,
};
use crate::catalog::{load_extensions_catalog, write_extensions_catalog};
use crate::kgoose::{CallToolResponse, HttpKgooseClient, KgooseClient, KgooseConfig};
use crate::proto::squareup::cash::kgoose::api::v3::user_content;

const BB_COMMAND_NAME: &str = "bb";
const BB_SUMMARY: &str = "Builderbot command line tools";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ToolsCliConfig {
    command: ToolCommandConfig,
    describe_root_name: &'static str,
    version_bin_name: &'static str,
    nested_appkit_help: &'static str,
    builderbot_mode: bool,
}

fn agent_tools_config() -> ToolsCliConfig {
    ToolsCliConfig {
        command: ToolCommandConfig {
            command_name: ROOT_COMMAND_NAME,
            bin_name: ROOT_BIN_NAME,
            example: "sq agent-tools utils calculate --numbers 2 3 --operation add",
        },
        describe_root_name: ROOT_COMMAND_NAME,
        version_bin_name: ROOT_BIN_NAME,
        nested_appkit_help: "sq agent-tools appkit --help",
        builderbot_mode: false,
    }
}

fn bb_tools_config() -> ToolsCliConfig {
    ToolsCliConfig {
        command: ToolCommandConfig {
            command_name: TOOLS_COMMAND_NAME,
            bin_name: BB_TOOLS_BIN_NAME,
            example: "bb tools utils calculate --numbers 2 3 --operation add",
        },
        describe_root_name: TOOLS_COMMAND_NAME,
        version_bin_name: BB_TOOLS_BIN_NAME,
        nested_appkit_help: "bb tools appkit --help",
        builderbot_mode: true,
    }
}

pub fn agent_tools_main() {
    if let Err(err) = run_agent_tools() {
        eprintln!("error: {err:#}");
        std::process::exit(1);
    }
}

pub fn bb_main() {
    if let Err(err) = run_bb() {
        // `bb skills --json` failures already printed a structured error to
        // stderr; exit silently with the recorded code.
        if let Some(silent) = err
            .chain()
            .find_map(|cause| cause.downcast_ref::<bb::skills_api::SilentJsonExit>())
        {
            std::process::exit(silent.0);
        }
        eprintln!("error: {err:#}");
        let (exit_code, _) = bb::skills_api::failure_info(&err);
        std::process::exit(exit_code);
    }
}

fn run_agent_tools() -> Result<()> {
    let argv = std::env::args().collect::<Vec<_>>();
    let raw_args = &argv[1..];
    run_tools_cli(&argv[0], raw_args, agent_tools_config())
}

fn run_bb() -> Result<()> {
    let argv = std::env::args().collect::<Vec<_>>();
    let raw_args = &argv[1..];

    if raw_args.first().map(String::as_str) == Some(TOOLS_COMMAND_NAME) {
        return run_tools_cli(BB_TOOLS_BIN_NAME, &raw_args[1..], bb_tools_config());
    }

    // Machine-readable command tree for `sq`-style integrations, mirroring
    // `--describe-commands` on the tools path. The `bb tools` namespace is
    // dynamic and is described by `bb tools --describe-commands` instead.
    if raw_args.first().map(String::as_str) == Some("--describe-commands") {
        let description = serde_json::json!({
            "name": BB_COMMAND_NAME,
            "summary": BB_SUMMARY,
            "commands": [
                bb::skills::describe_auth_commands(),
                bb::workspace::describe_commands(),
                bb::apps::describe_commands(),
                bb::skills::describe_config_commands(),
                bb::skills::describe_commands(),
                bb::agents::describe_commands(),
                { "name": TOOLS_COMMAND_NAME, "summary": ROOT_SUMMARY },
            ],
        });
        println!(
            "{}",
            serde_json::to_string_pretty(&description)
                .context("serialize `--describe-commands` output")?
        );
        return Ok(());
    }

    let command = build_bb_command();
    let matches = clap_matches(command, argv)?;
    match matches.subcommand() {
        Some(("agents", agents_matches)) => bb::agents::run(agents_matches),
        Some(("skills", skills_matches)) => bb::skills::run(skills_matches),
        Some(("auth", auth_matches)) => bb::skills::run_auth(auth_matches),
        Some(("workspace", workspace_matches)) => bb::workspace::run(workspace_matches),
        Some(("apps", apps_matches)) => bb::apps::run(apps_matches),
        Some(("config", config_matches)) => bb::skills::run_config(config_matches),
        Some(("completions", completions_matches)) => {
            let shell = completions_matches
                .get_one::<clap_complete::Shell>("shell")
                .copied()
                .context("expected a shell")?;
            let mut command = build_bb_command();
            clap_complete::generate(shell, &mut command, BB_COMMAND_NAME, &mut std::io::stdout());
            Ok(())
        }
        Some((TOOLS_COMMAND_NAME, _)) => run_tools_cli(BB_TOOLS_BIN_NAME, &[], bb_tools_config()),
        _ => anyhow::bail!("expected a bb subcommand"),
    }
}

fn build_bb_command() -> Command {
    let command = Command::new(BB_COMMAND_NAME)
        .bin_name(BB_COMMAND_NAME)
        .version(env!("CARGO_PKG_VERSION"))
        .about(BB_SUMMARY)
        .subcommand_required(true)
        .arg_required_else_help(true)
        .disable_help_subcommand(true)
        .subcommand(bb::skills::auth_command())
        .subcommand(bb::workspace::command())
        .subcommand(bb::apps::command())
        .subcommand(bb::skills::config_command())
        .subcommand(bb::skills::skills_command())
        .subcommand(bb::agents::agents_command())
        .subcommand(
            Command::new("completions")
                .about("Generate shell completions")
                .long_about(
                    "Generate a shell completion script for bb. Example:\n  \
                     bb completions zsh > ~/.zfunc/_bb",
                )
                .arg(
                    clap::Arg::new("shell")
                        .required(true)
                        .value_parser(clap::value_parser!(clap_complete::Shell)),
                ),
        )
        .subcommand(Command::new(TOOLS_COMMAND_NAME).about(ROOT_SUMMARY));
    bb::skills::skills_global_args(command)
}

fn run_tools_cli(argv0: &str, raw_args: &[String], config: ToolsCliConfig) -> Result<()> {
    if appkit::should_run_before_bootstrap(raw_args) {
        return appkit::run(raw_args);
    }

    let bootstrap = bootstrap_args(raw_args.iter().cloned())?;

    let mut kgoose_config = KgooseConfig {
        base_url: bootstrap.base_url.clone(),
        service_path: bootstrap.service_path.clone(),
        playpen: bootstrap.playpen.clone(),
        goosemcp_playpen: bootstrap.goosemcp_playpen.clone(),
        timeout_secs: bootstrap.timeout_secs,
        session_credential: None,
    };

    let client = HttpKgooseClient;
    if let Some(path) = bootstrap.write_extensions.as_deref() {
        if bootstrap.describe_commands || bootstrap.summary_only || bootstrap.version_only {
            anyhow::bail!(
                "`--write-extensions` cannot be combined with `--describe-commands`, `--summary`, or `--version`"
            );
        }
        if !bootstrap.command_tokens.is_empty() {
            anyhow::bail!("`--write-extensions` does not accept command arguments");
        }

        apply_builderbot_mode_if_needed(&mut kgoose_config, config.builderbot_mode)?;
        let extensions = load_extensions(&client, &kgoose_config)?;
        write_extensions_catalog(path, &extensions)?;
        return Ok(());
    }

    if bootstrap.describe_commands {
        if !bootstrap.command_tokens.is_empty() {
            apply_builderbot_mode_if_needed(&mut kgoose_config, config.builderbot_mode)?;
        }
        let description =
            load_command_description(&client, &kgoose_config, &bootstrap.command_tokens, config)?;
        println!(
            "{}",
            serde_json::to_string_pretty(&description)
                .context("serialize `--describe-commands` output")?
        );
        return Ok(());
    }

    if bootstrap.summary_only {
        let summary = if bootstrap.command_tokens.is_empty() {
            ROOT_SUMMARY.to_string()
        } else {
            apply_builderbot_mode_if_needed(&mut kgoose_config, config.builderbot_mode)?;
            load_command_description(&client, &kgoose_config, &bootstrap.command_tokens, config)?
                .summary
        };
        println!("{summary}");
        return Ok(());
    }

    if bootstrap.version_only && bootstrap.command_tokens.is_empty() {
        println!("{} {}", config.version_bin_name, env!("CARGO_PKG_VERSION"));
        return Ok(());
    }

    // The Cloudflare-backed internal App Kit deploy needs direct access to the
    // local workspace so it can tar files and upload them. Keep this compatibility
    // path as a local process; root `bb apps` is the separate Apps Platform
    // control-plane client.
    if appkit::is_appkit_command(&bootstrap.command_tokens) {
        return appkit::run(raw_args);
    }

    let selected_extension_name = bootstrap
        .command_tokens
        .first()
        .filter(|token| !token.starts_with('-'))
        .cloned();

    let (extensions, loaded_extension) = if let Some(extension_name) =
        selected_extension_name.as_deref()
    {
        apply_builderbot_mode_if_needed(&mut kgoose_config, config.builderbot_mode)?;
        let known_extensions = load_extensions_catalog()?;
        let loaded = load_extension(&client, &kgoose_config, extension_name, &known_extensions)?;
        let extensions = vec![runtime::ExtensionSummary {
            name: loaded.name.clone(),
            about: loaded.about.clone(),
        }];
        (extensions, Some(loaded))
    } else {
        let extensions = load_extensions_catalog()?;
        (extensions, None)
    };

    let command = build_tools_command(config.command, &extensions, loaded_extension.as_ref());
    let command_argv = std::iter::once(argv0.to_string())
        .chain(bootstrap.command_tokens.iter().cloned())
        .collect::<Vec<_>>();
    let matches = clap_matches(command, command_argv)?;

    let (extension_name, extension_matches) = matches
        .subcommand()
        .context("expected an extension subcommand")?;
    let loaded_extension = loaded_extension
        .as_ref()
        .filter(|extension| extension.name == extension_name)
        .context("loaded extension metadata missing")?;
    // TODO: Don't reserve `describe` as a built-in extension subcommand. If an
    // extension exposes a real `describe` tool, pick a non-conflicting synthetic
    // name and use it consistently for runtime dispatch and `--describe-commands`.
    if matches!(
        extension_matches.subcommand(),
        Some((EXTENSION_DESCRIBE_COMMAND_NAME, _))
    ) {
        println!("{}", loaded_extension.description);
        return Ok(());
    }
    let (tool_cli_name, tool_matches) = extension_matches
        .subcommand()
        .context("expected a tool subcommand")?;
    let tool = loaded_extension
        .tools
        .iter()
        .find(|tool| tool.cli_name == tool_cli_name || tool.kgoose_name == tool_cli_name)
        .context("loaded tool metadata missing")?;

    let request = build_tool_request(tool, tool_matches)?;
    let response = client.call_tool(
        &kgoose_config,
        &tool.extension_name,
        &tool.kgoose_name,
        &request.arguments_json,
        &request.headers,
    )?;

    let rendered_response = render_tool_response(&response, tool_matches.get_flag("raw"))?;
    if response.is_error == Some(true) {
        anyhow::bail!("{rendered_response}");
    }

    println!("{rendered_response}");
    Ok(())
}

fn apply_builderbot_mode_if_needed(config: &mut KgooseConfig, builderbot_mode: bool) -> Result<()> {
    if !builderbot_mode {
        return Ok(());
    }
    let bb_home = read_optional_env(BB_HOME_ENV_VAR)?
        .map(std::path::PathBuf::from)
        .unwrap_or_else(default_bb_home);
    let preferences = read_preferences_file(&default_preferences_path(&bb_home))?;
    let org = preferences
        .org
        .as_deref()
        .ok_or_else(bb_org_required_error)?;
    config.base_url =
        resolve_org_kgoose_base_url(&config.base_url, Some(org), false, &config.service_path)?;
    config.session_credential =
        resolve_kgoose_session_credential(&config.base_url, &config.service_path)?;
    if config.service_path == DEFAULT_KGOOSE_SERVICE_PATH {
        config.service_path = normalize_kgoose_service_path("api")?;
    }
    Ok(())
}

fn bb_org_required_error() -> anyhow::Error {
    bb::skills_api::failure(
        bb::skills_api::exit_codes::AUTH_REQUIRED,
        "org_required",
        "bb org is not configured; run `bb auth login` or `bb config set org <org>`",
    )
}

fn resolve_kgoose_session_credential(base_url: &str, service_path: &str) -> Result<Option<String>> {
    let profile_context = resolve_skills_profile_context(SkillsProfileResolveOptions::default())?;

    stored_session_credential_header_value_for_kgoose_base_url(
        &profile_context.profile,
        base_url,
        service_path,
        profile_context.bb_home,
    )
}

fn clap_matches(command: Command, argv: Vec<String>) -> Result<ArgMatches> {
    match command.try_get_matches_from(argv) {
        Ok(matches) => Ok(matches),
        Err(err) => match err.kind() {
            ErrorKind::DisplayHelp
            | ErrorKind::DisplayVersion
            | ErrorKind::DisplayHelpOnMissingArgumentOrSubcommand => {
                err.print().context("print clap output")?;
                std::process::exit(0);
            }
            _ => err.exit(),
        },
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
struct CommandDescription {
    name: String,
    summary: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    commands: Vec<CommandDescription>,
}

fn load_command_description(
    client: &impl KgooseClient,
    config: &KgooseConfig,
    command_tokens: &[String],
    tools_cli: ToolsCliConfig,
) -> Result<CommandDescription> {
    let command_path = command_tokens
        .iter()
        .take_while(|token| !token.starts_with('-'))
        .map(String::as_str)
        .collect::<Vec<_>>();

    match command_path.as_slice() {
        [] => load_root_command_description(client, config, tools_cli.describe_root_name),
        [APPKIT_COMMAND_NAME] => Ok(appkit_command_description()),
        [APPKIT_COMMAND_NAME, ..] => {
            anyhow::bail!(
                "`--describe-commands` does not inspect nested appkit commands; run `{}`",
                tools_cli.nested_appkit_help
            )
        }
        [extension_name] => load_extension_command_description(client, config, extension_name),
        [extension_name, EXTENSION_DESCRIBE_COMMAND_NAME] => {
            load_extension_describe_command_description(client, config, extension_name)
        }
        [extension_name, tool_name] => {
            load_tool_command_description(client, config, extension_name, tool_name)
        }
        _ => anyhow::bail!(
            "`--describe-commands` only supports the root command, an extension, or a tool path"
        ),
    }
}

fn load_root_command_description(
    _client: &impl KgooseClient,
    _config: &KgooseConfig,
    root_name: &str,
) -> Result<CommandDescription> {
    let extensions = load_extensions_catalog()?;
    Ok(root_command_description(&extensions, root_name))
}

/// Loads an extension by name, using the static catalog to produce helpful error
/// messages for extensions that exist but the user hasn't connected yet.
fn load_extension_with_catalog(
    client: &impl KgooseClient,
    config: &KgooseConfig,
    extension_name: &str,
) -> Result<LoadedExtension> {
    let known_extensions = load_extensions_catalog()?;
    load_extension(client, config, extension_name, &known_extensions)
}

fn load_extension_command_description(
    client: &impl KgooseClient,
    config: &KgooseConfig,
    extension_name: &str,
) -> Result<CommandDescription> {
    let loaded = load_extension_with_catalog(client, config, extension_name)?;
    Ok(extension_command_description(&loaded))
}

fn load_tool_command_description(
    client: &impl KgooseClient,
    config: &KgooseConfig,
    extension_name: &str,
    tool_name: &str,
) -> Result<CommandDescription> {
    let loaded = load_extension_with_catalog(client, config, extension_name)?;
    let tool = loaded
        .tools
        .iter()
        .find(|tool| tool.cli_name == tool_name || tool.kgoose_name == tool_name)
        .with_context(|| format!("unknown tool `{tool_name}` for extension `{extension_name}`"))?;

    Ok(tool_command_description(tool))
}

fn load_extension_describe_command_description(
    client: &impl KgooseClient,
    config: &KgooseConfig,
    extension_name: &str,
) -> Result<CommandDescription> {
    load_extension_with_catalog(client, config, extension_name)?;
    Ok(extension_describe_command_description())
}

fn extension_command_description(extension: &LoadedExtension) -> CommandDescription {
    let mut commands = extension
        .tools
        .iter()
        .map(tool_command_description)
        .collect::<Vec<_>>();
    commands.push(extension_describe_command_description());
    // TODO: If https://github.com/squareup/sq stops alphabetizing module submenu
    // entries in its exoskeleton help path, consider pinning `describe` first here.
    commands.sort_by(|left, right| left.name.cmp(&right.name));

    CommandDescription {
        name: extension.name.clone(),
        summary: sq_command_summary(&extension.about),
        commands,
    }
}

fn root_command_description(
    extensions: &[runtime::ExtensionSummary],
    root_name: &str,
) -> CommandDescription {
    let mut commands = vec![appkit_command_description()];
    commands.extend(extensions.iter().filter_map(|extension| {
        if extension.name == APPKIT_COMMAND_NAME {
            None
        } else {
            Some(CommandDescription {
                name: extension.name.clone(),
                summary: sq_command_summary(&extension.about),
                commands: Vec::new(),
            })
        }
    }));

    CommandDescription {
        name: root_name.to_string(),
        summary: ROOT_SUMMARY.to_string(),
        commands,
    }
}

fn appkit_command_description() -> CommandDescription {
    CommandDescription {
        name: APPKIT_COMMAND_NAME.to_string(),
        summary: sq_command_summary(APPKIT_COMMAND_ABOUT),
        commands: Vec::new(),
    }
}

fn tool_command_description(tool: &RuntimeTool) -> CommandDescription {
    CommandDescription {
        name: tool.cli_name.clone(),
        summary: sq_command_summary(&tool.about),
        commands: Vec::new(),
    }
}

fn extension_describe_command_description() -> CommandDescription {
    CommandDescription {
        name: EXTENSION_DESCRIBE_COMMAND_NAME.to_string(),
        summary: sq_command_summary(EXTENSION_DESCRIBE_COMMAND_ABOUT),
        commands: Vec::new(),
    }
}

fn sq_command_summary(value: &str) -> String {
    const MAX_LEN: usize = 79;

    let summary = value.trim().trim_end_matches('.');
    let len = summary.chars().count();
    if len <= MAX_LEN {
        return summary.to_string();
    }

    let truncated = summary.chars().take(MAX_LEN).collect::<String>();
    let shortened = truncated.trim_end();
    let candidate = shortened
        .rfind(char::is_whitespace)
        .filter(|index| *index >= MAX_LEN / 2)
        .map(|index| shortened[..index].trim_end())
        .unwrap_or(shortened);

    candidate.trim_end_matches('.').to_string()
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ToolRequest {
    arguments_json: String,
    headers: BTreeMap<String, String>,
}

fn build_tool_request(tool: &RuntimeTool, matches: &ArgMatches) -> Result<ToolRequest> {
    let headers = matches
        .get_many::<String>("header")
        .into_iter()
        .flatten()
        .map(|header| parse_header(header))
        .collect::<Result<BTreeMap<_, _>>>()?;

    let arguments = if let Some(raw_json) = matches.get_one::<String>("json") {
        match serde_json::from_str::<Value>(raw_json).context("`--json` must be valid JSON")? {
            Value::Object(map) => Value::Object(map),
            _ => anyhow::bail!("`--json` must be a JSON object"),
        }
    } else {
        let mut payload = Map::new();

        for parameter in &tool.parameters {
            if let Some(value) = parameter_value_from_matches(parameter, matches)? {
                payload.insert(parameter.name.clone(), value);
            }
        }

        Value::Object(payload)
    };

    Ok(ToolRequest {
        arguments_json: serde_json::to_string(&arguments).context("serialize tool payload")?,
        headers,
    })
}

fn parameter_value_from_matches(
    parameter: &ToolParameter,
    matches: &ArgMatches,
) -> Result<Option<Value>> {
    match &parameter.kind {
        ParameterKind::Scalar(ScalarKind::Boolean) => {
            let true_id = bool_true_id(parameter);
            if matches.get_flag(&true_id) {
                return Ok(Some(Value::Bool(true)));
            }

            let false_id = bool_false_id(parameter);
            if matches.get_flag(&false_id) {
                return Ok(Some(Value::Bool(false)));
            }

            Ok(None)
        }
        ParameterKind::Scalar(kind) => {
            let id = parameter_id(parameter);
            matches
                .get_one::<String>(&id)
                .map(|value| parse_scalar_value(kind, value))
                .transpose()
        }
        ParameterKind::Array(kind) => {
            let id = parameter_id(parameter);
            let values = matches
                .get_many::<String>(&id)
                .into_iter()
                .flatten()
                .map(|value| parse_scalar_value(kind, value))
                .collect::<Result<Vec<_>>>()?;

            if values.is_empty() {
                Ok(None)
            } else {
                Ok(Some(Value::Array(values)))
            }
        }
        ParameterKind::Json => {
            let id = parameter_id(parameter);
            matches
                .get_one::<String>(&id)
                .map(|value| {
                    serde_json::from_str(value).with_context(|| {
                        format!("`--{}` expects a valid JSON value", parameter.cli_name)
                    })
                })
                .transpose()
        }
    }
}

fn parse_scalar_value(kind: &ScalarKind, value: &str) -> Result<Value> {
    let parsed = match kind {
        ScalarKind::String { enum_values, .. } => {
            let parsed = Value::String(value.to_string());
            validate_enum_value(enum_values, &parsed, value)?;
            parsed
        }
        ScalarKind::Integer { enum_values } => {
            let parsed = serde_json::from_str::<Value>(value)
                .with_context(|| format!("`{value}` is not a valid integer"))?;
            if !parsed.is_i64() && !parsed.is_u64() {
                anyhow::bail!("`{value}` is not a valid integer");
            }
            validate_enum_value(enum_values, &parsed, value)?;
            parsed
        }
        ScalarKind::Number { enum_values } => {
            let parsed = serde_json::from_str::<Value>(value)
                .with_context(|| format!("`{value}` is not a valid number"))?;
            if !parsed.is_number() {
                anyhow::bail!("`{value}` is not a valid number");
            }
            validate_enum_value(enum_values, &parsed, value)?;
            parsed
        }
        ScalarKind::Boolean => Value::Bool(parse_bool_value(value)?),
    };

    Ok(parsed)
}

fn validate_enum_value(enum_values: &[Value], parsed: &Value, raw_value: &str) -> Result<()> {
    if enum_values.is_empty() || enum_values.iter().any(|value| value == parsed) {
        return Ok(());
    }

    anyhow::bail!(
        "`{raw_value}` must be one of: {}",
        enum_values
            .iter()
            .map(enum_display)
            .collect::<Vec<_>>()
            .join(", ")
    )
}

fn parse_bool_value(value: &str) -> Result<bool> {
    match value {
        "true" | "1" | "yes" | "on" => Ok(true),
        "false" | "0" | "no" | "off" => Ok(false),
        _ => anyhow::bail!("`{value}` is not a valid boolean"),
    }
}

fn enum_display(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        _ => serde_json::to_string(value).unwrap_or_else(|_| value.to_string()),
    }
}

fn parse_header(value: &str) -> Result<(String, String)> {
    let (key, value) = value
        .split_once('=')
        .with_context(|| format!("invalid header `{value}`; expected KEY=VALUE"))?;

    if key.is_empty() {
        anyhow::bail!("header name cannot be empty");
    }

    Ok((key.to_string(), value.to_string()))
}

fn render_tool_response(response: &CallToolResponse, raw: bool) -> Result<String> {
    if raw {
        return serialize_call_tool_response(response);
    }

    if let Some(rendered) = render_structured_output(response) {
        return Ok(rendered);
    }

    if let Some(rendered) = render_text_output(response) {
        return Ok(rendered);
    }

    serialize_call_tool_response(response)
}

fn render_structured_output(response: &CallToolResponse) -> Option<String> {
    if let Some(pretty) = response
        .structured_content_json
        .as_deref()
        .and_then(parse_json_string)
        .and_then(|value| pretty_json(&value).ok())
    {
        return Some(pretty);
    }

    let values = response
        .content
        .iter()
        .filter_map(structured_content_value)
        .collect::<Vec<_>>();

    match values.len() {
        0 => None,
        1 => pretty_json(&values.into_iter().next().expect("single structured value")).ok(),
        _ => pretty_json(&Value::Array(values)).ok(),
    }
}

fn render_text_output(response: &CallToolResponse) -> Option<String> {
    let fragments = response
        .content
        .iter()
        .filter_map(renderable_text_fragment)
        .collect::<Vec<_>>();

    match fragments.len() {
        0 => None,
        1 => {
            let text = fragments.into_iter().next().expect("single text fragment");
            let trimmed = text.trim();
            if trimmed.is_empty() {
                None
            } else if let Some(value) = parse_json_string(trimmed) {
                pretty_json(&value).ok()
            } else {
                Some(text)
            }
        }
        _ => {
            let rendered = fragments.join("\n\n");
            if rendered.trim().is_empty() {
                None
            } else {
                Some(rendered)
            }
        }
    }
}

fn structured_content_value(
    content: &crate::proto::squareup::cash::kgoose::api::v3::UserContent,
) -> Option<Value> {
    match content.content.as_ref()? {
        user_content::Content::StructuredContent(structured) => structured
            .data
            .as_ref()
            .and_then(|data| serde_json::to_value(data).ok()),
        _ => None,
    }
}

fn renderable_text_fragment(
    content: &crate::proto::squareup::cash::kgoose::api::v3::UserContent,
) -> Option<String> {
    match content.content.as_ref()? {
        user_content::Content::Text(text) => text.text.clone(),
        user_content::Content::Resource(resource) => resource
            .resource
            .as_ref()
            .and_then(|resource| resource.text.clone()),
        _ => None,
    }
    .filter(|text| !text.trim().is_empty())
}

fn parse_json_string(value: &str) -> Option<Value> {
    serde_json::from_str(value).ok()
}

fn pretty_json(value: &Value) -> Result<String> {
    serde_json::to_string_pretty(value).context("serialize tool output JSON")
}

fn serialize_call_tool_response(response: &CallToolResponse) -> Result<String> {
    serde_json::to_string_pretty(response).context("serialize CallTool response")
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use clap::ArgMatches;
    use serde_json::json;

    use super::{
        agent_tools_config, appkit_command_description, bb_tools_config, build_tool_request,
        extension_command_description, load_command_description, parse_bool_value, parse_header,
        render_tool_response, root_command_description, sq_command_summary,
        tool_command_description, CommandDescription,
    };
    use crate::cli::{build_command, APPKIT_COMMAND_NAME, ROOT_SUMMARY};
    use crate::kgoose::{
        CallToolResponse, ExtensionInfo, KgooseClient, KgooseConfig, ListExtensionsResponse,
        ListToolsResponse, ToolConfig,
    };
    use crate::proto::squareup::cash::kgoose::api::v3::{
        user_content, StructuredContent, TextContent, UserContent,
    };
    use crate::runtime::{
        ExtensionSummary, LoadedExtension, ParameterKind, RuntimeTool, ScalarKind, ToolParameter,
    };

    struct TestKgooseClient;

    impl KgooseClient for TestKgooseClient {
        fn list_extensions(
            &self,
            _config: &KgooseConfig,
        ) -> anyhow::Result<ListExtensionsResponse> {
            Ok(ListExtensionsResponse {
                extensions: vec![ExtensionInfo {
                    name: Some("utils".to_string()),
                    description: Some("Utility helpers".to_string()),
                    tool_count: Some(1),
                    any_tool_requires_user_auth: Some(false),
                    auth_satisfied_for_caller: Some(true),
                    ..Default::default()
                }],
            })
        }

        fn list_tools(
            &self,
            _config: &KgooseConfig,
            extension_name: &str,
        ) -> anyhow::Result<ListToolsResponse> {
            if extension_name != "utils" {
                anyhow::bail!("unknown extension `{extension_name}`");
            }

            Ok(ListToolsResponse {
                extension_name: Some("utils".to_string()),
                extension_description: Some("Utility helpers".to_string()),
                tools: vec![ToolConfig {
                    tool: Some("calculate".to_string()),
                    description: Some("Perform math".to_string()),
                    config_json: Some(
                        r#"{"type":"object","properties":{"numbers":{"type":"array","items":{"type":"number"}},"operation":{"type":"string","enum":["add","subtract"]}},"required":["numbers","operation"]}"#
                            .to_string(),
                    ),
                    mutates_state: Some(false),
                    ..Default::default()
                }],
            })
        }

        fn call_tool(
            &self,
            _config: &KgooseConfig,
            _extension_name: &str,
            _tool_name: &str,
            _arguments_json: &str,
            _headers: &BTreeMap<String, String>,
        ) -> anyhow::Result<CallToolResponse> {
            unreachable!("call_tool is not used during command description loading")
        }
    }

    struct PanickingKgooseClient;

    impl KgooseClient for PanickingKgooseClient {
        fn list_extensions(
            &self,
            _config: &KgooseConfig,
        ) -> anyhow::Result<ListExtensionsResponse> {
            panic!("appkit metadata should not load extensions")
        }

        fn list_tools(
            &self,
            _config: &KgooseConfig,
            _extension_name: &str,
        ) -> anyhow::Result<ListToolsResponse> {
            panic!("appkit metadata should not load tools")
        }

        fn call_tool(
            &self,
            _config: &KgooseConfig,
            _extension_name: &str,
            _tool_name: &str,
            _arguments_json: &str,
            _headers: &BTreeMap<String, String>,
        ) -> anyhow::Result<CallToolResponse> {
            panic!("appkit metadata should not call tools")
        }
    }

    fn kgoose_config() -> KgooseConfig {
        KgooseConfig {
            base_url: "https://example.test".to_string(),
            service_path: crate::bb::skills_config::DEFAULT_KGOOSE_SERVICE_PATH.to_string(),
            playpen: Some("baxen".to_string()),
            goosemcp_playpen: None,
            timeout_secs: 600.0,
            session_credential: None,
        }
    }

    fn tool_catalog() -> (Vec<ExtensionSummary>, LoadedExtension) {
        let loaded = LoadedExtension {
            name: "utils".to_string(),
            about: "Utility helpers".to_string(),
            description: "Utility helpers".to_string(),
            tools: vec![RuntimeTool {
                extension_name: "utils".to_string(),
                kgoose_name: "calculate".to_string(),
                cli_name: "calculate".to_string(),
                about: "Perform math".to_string(),
                description: "Perform math".to_string(),
                parameters: vec![
                    ToolParameter {
                        name: "numbers".to_string(),
                        cli_name: "numbers".to_string(),
                        required: true,
                        description: Some("Numbers to process".to_string()),
                        kind: ParameterKind::Array(ScalarKind::Number {
                            enum_values: Vec::new(),
                        }),
                        default: None,
                    },
                    ToolParameter {
                        name: "operation".to_string(),
                        cli_name: "operation".to_string(),
                        required: true,
                        description: Some("Operation to apply".to_string()),
                        kind: ParameterKind::Scalar(ScalarKind::String {
                            enum_values: vec![json!("add"), json!("subtract")],
                            format: None,
                        }),
                        default: None,
                    },
                ],
            }],
        };

        (
            vec![ExtensionSummary {
                name: "utils".to_string(),
                about: "Utility helpers".to_string(),
            }],
            loaded,
        )
    }

    fn parse_matches(args: &[&str]) -> (LoadedExtension, ArgMatches) {
        let (extensions, loaded) = tool_catalog();
        let command = build_command(&extensions, Some(&loaded));
        let matches = command.try_get_matches_from(args).expect("parse matches");
        (loaded, matches)
    }

    #[test]
    fn build_tool_request_uses_schema_derived_flags() {
        let (loaded, matches) = parse_matches(&[
            "agent-tools",
            "utils",
            "calculate",
            "--numbers",
            "2",
            "3",
            "--operation",
            "add",
        ]);
        let (_, extension_matches) = matches.subcommand().expect("extension");
        let (_, tool_matches) = extension_matches.subcommand().expect("tool");

        let request = build_tool_request(&loaded.tools[0], tool_matches).expect("request");
        assert_eq!(
            request.arguments_json,
            r#"{"numbers":[2,3],"operation":"add"}"#
        );
    }

    #[test]
    fn build_tool_request_accepts_json_fallback() {
        let (loaded, matches) = parse_matches(&[
            "agent-tools",
            "utils",
            "calculate",
            "--json",
            r#"{"numbers":[2,3],"operation":"add"}"#,
            "--header",
            "x-debug=true",
        ]);
        let (_, extension_matches) = matches.subcommand().expect("extension");
        let (_, tool_matches) = extension_matches.subcommand().expect("tool");

        let request = build_tool_request(&loaded.tools[0], tool_matches).expect("request");
        assert_eq!(
            request.arguments_json,
            r#"{"numbers":[2,3],"operation":"add"}"#
        );
        assert_eq!(
            request.headers.get("x-debug").map(String::as_str),
            Some("true")
        );
    }

    #[test]
    fn extension_command_description_includes_tool_summaries() {
        let (_, loaded) = tool_catalog();

        assert_eq!(
            extension_command_description(&loaded),
            CommandDescription {
                name: "utils".to_string(),
                summary: "Utility helpers".to_string(),
                commands: vec![
                    CommandDescription {
                        name: "calculate".to_string(),
                        summary: "Perform math".to_string(),
                        commands: Vec::new(),
                    },
                    CommandDescription {
                        name: "describe".to_string(),
                        summary: "Print the full extension description/instructions".to_string(),
                        commands: Vec::new(),
                    },
                ],
            }
        );
    }

    #[test]
    fn root_command_description_lists_extensions_without_nested_commands() {
        let description = root_command_description(
            &[
                ExtensionSummary {
                    name: "slack".to_string(),
                    about: "Slack tools for chat.".to_string(),
                },
                ExtensionSummary {
                    name: "utils".to_string(),
                    about: "Utility helpers".to_string(),
                },
            ],
            "agent-tools",
        );

        assert_eq!(
            description,
            CommandDescription {
                name: "agent-tools".to_string(),
                summary: ROOT_SUMMARY.to_string(),
                commands: vec![
                    CommandDescription {
                        name: "appkit".to_string(),
                        summary: "Cloudflare-backed internal Block App Kit CLI (local exec)"
                            .to_string(),
                        commands: Vec::new(),
                    },
                    CommandDescription {
                        name: "slack".to_string(),
                        summary: "Slack tools for chat".to_string(),
                        commands: Vec::new(),
                    },
                    CommandDescription {
                        name: "utils".to_string(),
                        summary: "Utility helpers".to_string(),
                        commands: Vec::new(),
                    },
                ],
            }
        );
    }

    #[test]
    fn appkit_command_description_is_static() {
        assert_eq!(
            appkit_command_description(),
            CommandDescription {
                name: APPKIT_COMMAND_NAME.to_string(),
                summary: "Cloudflare-backed internal Block App Kit CLI (local exec)".to_string(),
                commands: Vec::new(),
            }
        );
    }

    #[test]
    fn appkit_description_does_not_load_extension_metadata() {
        let description = load_command_description(
            &PanickingKgooseClient,
            &kgoose_config(),
            &["appkit".to_string()],
            agent_tools_config(),
        )
        .expect("load appkit command description");

        assert_eq!(description, appkit_command_description());
    }

    #[test]
    fn nested_appkit_describe_commands_uses_appkit_specific_error() {
        let error = load_command_description(
            &PanickingKgooseClient,
            &kgoose_config(),
            &[
                "appkit".to_string(),
                "deploy".to_string(),
                "my-site".to_string(),
            ],
            agent_tools_config(),
        )
        .expect_err("nested appkit description should fail locally");

        let message = error.to_string();
        assert!(message.contains("does not inspect nested appkit commands"));
        assert!(message.contains("sq agent-tools appkit --help"));
    }

    #[test]
    fn nested_appkit_describe_commands_uses_bb_tools_error_for_bb_tools() {
        let error = load_command_description(
            &PanickingKgooseClient,
            &kgoose_config(),
            &[
                "appkit".to_string(),
                "deploy".to_string(),
                "my-site".to_string(),
            ],
            bb_tools_config(),
        )
        .expect_err("nested appkit description should fail locally");

        let message = error.to_string();
        assert!(message.contains("does not inspect nested appkit commands"));
        assert!(message.contains("bb tools appkit --help"));
    }

    #[test]
    fn load_command_description_supports_extension_describe_subcommand() {
        let description = load_command_description(
            &TestKgooseClient,
            &kgoose_config(),
            &["utils".to_string(), "describe".to_string()],
            agent_tools_config(),
        )
        .expect("load describe command description");

        assert_eq!(
            description,
            CommandDescription {
                name: "describe".to_string(),
                summary: "Print the full extension description/instructions".to_string(),
                commands: Vec::new(),
            }
        );
    }

    #[test]
    fn tool_command_description_uses_cli_name() {
        let tool = RuntimeTool {
            extension_name: "slack".to_string(),
            kgoose_name: "get_channel_messages".to_string(),
            cli_name: "get-channel-messages".to_string(),
            about: "Fetch Slack messages".to_string(),
            description: "Fetch Slack messages".to_string(),
            parameters: Vec::new(),
        };

        assert_eq!(
            tool_command_description(&tool),
            CommandDescription {
                name: "get-channel-messages".to_string(),
                summary: "Fetch Slack messages".to_string(),
                commands: Vec::new(),
            }
        );
    }

    #[test]
    fn sq_command_summary_matches_sq_menu_conventions() {
        let summary = sq_command_summary(
            "Use this tool to help the campaign manager to get the user's aggregated dashboard data.",
        );

        assert!(!summary.ends_with('.'));
        assert!(summary.chars().count() < 80);
    }

    #[test]
    fn parse_bool_value_accepts_common_spellings() {
        assert!(parse_bool_value("true").expect("bool"));
        assert!(parse_bool_value("yes").expect("bool"));
        assert!(!parse_bool_value("off").expect("bool"));
    }

    #[test]
    fn parse_header_requires_key_value_format() {
        let error = parse_header("missing-separator").expect_err("header should fail");
        assert!(error.to_string().contains("expected KEY=VALUE"));
    }

    #[test]
    fn call_tool_response_serializes_as_json() {
        let response = CallToolResponse {
            content: Vec::new(),
            is_error: Some(false),
            structured_content_json: Some("{\"ok\":true}".to_string()),
        };

        let rendered = serde_json::to_string_pretty(&response).expect("serialize response");
        assert!(rendered.contains("\"is_error\": false"));
        assert!(rendered.contains("\"structured_content_json\""));
    }

    #[test]
    fn build_tool_request_allows_optional_boolean_flags_without_panicking() {
        let loaded = LoadedExtension {
            name: "slack".to_string(),
            about: "Slack helpers".to_string(),
            description: "Slack helpers".to_string(),
            tools: vec![RuntimeTool {
                extension_name: "slack".to_string(),
                kgoose_name: "post_message".to_string(),
                cli_name: "post-message".to_string(),
                about: "Post a message".to_string(),
                description: "Post a message".to_string(),
                parameters: vec![
                    ToolParameter {
                        name: "channel_id".to_string(),
                        cli_name: "channel-id".to_string(),
                        required: true,
                        description: Some("Slack channel ID".to_string()),
                        kind: ParameterKind::Scalar(ScalarKind::String {
                            enum_values: Vec::new(),
                            format: None,
                        }),
                        default: None,
                    },
                    ToolParameter {
                        name: "dm_myself".to_string(),
                        cli_name: "dm-myself".to_string(),
                        required: false,
                        description: Some("Send the message to yourself".to_string()),
                        kind: ParameterKind::Scalar(ScalarKind::Boolean),
                        default: Some(json!(false)),
                    },
                ],
            }],
        };
        let extensions = vec![ExtensionSummary {
            name: "slack".to_string(),
            about: "Slack helpers".to_string(),
        }];
        let command = build_command(&extensions, Some(&loaded));
        let matches = command
            .try_get_matches_from([
                "agent-tools",
                "slack",
                "post-message",
                "--channel-id",
                "C123",
            ])
            .expect("parse matches");
        let (_, extension_matches) = matches.subcommand().expect("extension");
        let (_, tool_matches) = extension_matches.subcommand().expect("tool");

        let request = build_tool_request(&loaded.tools[0], tool_matches).expect("request");
        assert_eq!(request.arguments_json, r#"{"channel_id":"C123"}"#);
    }

    #[test]
    fn render_tool_response_prefers_structured_json() {
        let response = CallToolResponse {
            content: vec![
                UserContent {
                    content: Some(user_content::Content::Text(TextContent {
                        text: Some("# Messages".to_string()),
                    })),
                },
                UserContent {
                    content: Some(user_content::Content::StructuredContent(
                        StructuredContent {
                            data: Some(pbjson_types::Struct {
                                fields: std::collections::HashMap::from([(
                                    "result".to_string(),
                                    pbjson_types::Value {
                                        kind: Some(pbjson_types::value::Kind::BoolValue(true)),
                                    },
                                )]),
                            }),
                        },
                    )),
                },
            ],
            is_error: Some(false),
            structured_content_json: Some(r#"{"result":true}"#.to_string()),
        };

        let rendered = render_tool_response(&response, false).expect("render response");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&rendered).expect("parse rendered JSON"),
            json!({"result": true})
        );
    }

    #[test]
    fn render_tool_response_parses_json_text_when_no_structured_output_exists() {
        let response = CallToolResponse {
            content: vec![UserContent {
                content: Some(user_content::Content::Text(TextContent {
                    text: Some(r#"{"sum":5}"#.to_string()),
                })),
            }],
            is_error: Some(false),
            structured_content_json: None,
        };

        let rendered = render_tool_response(&response, false).expect("render response");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&rendered).expect("parse rendered JSON"),
            json!({"sum": 5})
        );
    }
}
