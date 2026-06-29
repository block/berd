//! Tauri command wrappers for the doctor health-check system.

use std::{
    collections::{BTreeSet, HashMap},
    env, fs,
    future::Future,
    path::{Path, PathBuf},
    process::{Output, Stdio},
    time::Duration,
};

use serde::{Deserialize, Serialize};
use tauri::State;
use tokio::time::timeout;

use crate::services::{
    distro_bundle::DistroBundleState,
    goose_config::{self, AdditionalConfigFiles},
    kgoose::{KgooseContext, KgooseProbeResult},
    path_env::{build_extended_path, build_extended_path_from_path},
    shell_env,
};

use crate::commands::runtime_config::{RuntimeConfig, RuntimeConfigState, RuntimeDoctorConfig};

use doctor::types::{AuthStatus, InstallSource};
use doctor::CheckStatus;
pub use doctor::FixType;

const TOOLS_CATEGORY: &str = "tools";
const TOOLS_CATEGORY_LABEL: &str = "Tools";
const AGENTS_CATEGORY: &str = "agents";
const AGENTS_CATEGORY_LABEL: &str = "Agents";
const ENVIRONMENT_HEALTH_CATEGORY: &str = "environment-health";
const ENVIRONMENT_HEALTH_CATEGORY_LABEL: &str = "Environment Health";
const GOOSE_BIN_ENV: &str = "GOOSE_BIN";
// App-side safety net while the upstream doctor crate adds per-command
// timeouts. Keep these centralized so future tuning is a one-line change.
const DOCTOR_REPORT_TIMEOUT: Duration = Duration::from_secs(60);
const DOCTOR_FRESH_REPORT_TIMEOUT: Duration = Duration::from_secs(45);
const LOCAL_DOCTOR_COMMAND_TIMEOUT: Duration = Duration::from_secs(10);
const DOCTOR_TIMEOUT_CHECK_ID: &str = "doctor-timeout";
const APP_CONFIG_PASS_MESSAGE: &str =
    "Checked goose config YAML, additional config files, thinking settings, and goose binary override";
const CLAUDE_THINKING_CONFIG_KEYS: &[&str] = &[
    "CLAUDE_THINKING_TYPE",
    "CLAUDE_THINKING_ENABLED",
    "CLAUDE_THINKING_BUDGET",
    "ANTHROPIC_THINKING_BUDGET",
];
const GOOSE_THINKING_EFFORT_ENV: &str = "GOOSE_THINKING_EFFORT";

/// Local mirror of the crate's `AgentVersionInfo`, carried so the per-binary
/// (main CLI vs ACP bridge) version/install-source readout survives the
/// serialization boundary into the frontend. Field names and serde rename
/// match the crate exactly so the TS `AgentVersionInfo` deserializes correctly.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentVersionInfo {
    pub install_source: Option<InstallSource>,
    pub installed_version: Option<String>,
    pub latest_version: Option<String>,
    pub update_available: Option<bool>,
    pub self_updating: Option<bool>,
    /// Source-aware update command derived per readout from
    /// `(install_source, package_id)`. `Some` only when an update is both
    /// computable and actionable. Paired with `update_fix_type`.
    pub update_command: Option<String>,
    /// `FixType::UpdateMain` or `FixType::UpdateBridge`, matching the slot this
    /// readout occupies. Always paired with `update_command`.
    pub update_fix_type: Option<FixType>,
}

impl From<doctor::types::AgentVersionInfo> for AgentVersionInfo {
    fn from(info: doctor::types::AgentVersionInfo) -> Self {
        Self {
            install_source: info.install_source,
            installed_version: info.installed_version,
            latest_version: info.latest_version,
            update_available: info.update_available,
            self_updating: info.self_updating,
            update_command: info.update_command,
            update_fix_type: info.update_fix_type,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DoctorCheck {
    pub id: String,
    pub label: String,
    pub status: CheckStatus,
    pub message: String,
    pub fix_url: Option<String>,
    pub fix_command: Option<String>,
    pub fix_type: Option<FixType>,
    pub path: Option<String>,
    pub bridge_path: Option<String>,
    pub raw_output: Option<String>,
    pub auth_status: Option<AuthStatus>,
    pub installed_version: Option<String>,
    pub latest_version: Option<String>,
    pub update_available: Option<bool>,
    pub install_source: Option<InstallSource>,
    pub self_updating: Option<bool>,
    pub main: Option<AgentVersionInfo>,
    pub bridge: Option<AgentVersionInfo>,
    pub category: String,
    pub category_label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DoctorReport {
    pub checks: Vec<DoctorCheck>,
}

impl DoctorReport {
    /// Render the report as human-readable diagnostic text for attaching to a
    /// feedback report. Checks are grouped by category in first-seen order. The
    /// values surfaced here are already vetted by the checks themselves
    /// (sensitive settings are reported as keys only, never values), so the
    /// output is safe to include verbatim.
    pub fn to_diagnostic_text(&self) -> String {
        let mut out = String::from("Berd doctor report\n");

        let mut category_order: Vec<&str> = Vec::new();
        for check in &self.checks {
            if !category_order.contains(&check.category.as_str()) {
                category_order.push(check.category.as_str());
            }
        }

        for category in category_order {
            let label = self
                .checks
                .iter()
                .find(|check| check.category == category)
                .map(|check| check.category_label.as_str())
                .unwrap_or(category);
            out.push_str(&format!("\n== {label} ==\n"));

            for check in self
                .checks
                .iter()
                .filter(|check| check.category == category)
            {
                out.push_str(&format!(
                    "[{}] {} ({})\n",
                    status_name(&check.status),
                    check.label,
                    check.id
                ));
                out.push_str(&format!("  message: {}\n", check.message));
                if let Some(path) = &check.path {
                    out.push_str(&format!("  path: {path}\n"));
                }
                if let Some(raw) = &check.raw_output {
                    out.push_str("  details:\n");
                    for line in raw.lines() {
                        out.push_str(&format!("    {line}\n"));
                    }
                }
            }
        }

        out
    }
}

#[derive(Clone)]
struct LocalDoctorFix {
    fix_type: FixType,
    command: &'static str,
}

struct LocalCheckMeta {
    id: &'static str,
    label: &'static str,
    category: &'static str,
    category_label: &'static str,
    fix: Option<LocalDoctorFix>,
    fix_url: Option<&'static str>,
    debug_output: Option<&'static str>,
}

struct LocalPathCheck {
    meta: LocalCheckMeta,
    binary_name: &'static str,
    pass_message: &'static str,
    fail_message: &'static str,
}

struct LocalCommandCheck {
    meta: LocalCheckMeta,
    command: &'static str,
    args: &'static [&'static str],
    pass_message_suffix: Option<&'static str>,
    fail_message: &'static str,
}

struct LocalCustomCheck {
    meta: LocalCheckMeta,
    run: fn(&LocalCheckMeta, &HashMap<String, String>, Option<&Path>) -> DoctorCheck,
}

struct LocalDoctorRegistry<'a> {
    path_checks: &'a [LocalPathCheck],
    command_checks: &'a [LocalCommandCheck],
    custom_checks: &'a [LocalCustomCheck],
}

const LOCAL_COMMAND_CHECKS: &[LocalCommandCheck] = &[LocalCommandCheck {
    meta: LocalCheckMeta {
        id: "sq-agent-tools",
        label: "Square Agent Tools",
        category: ENVIRONMENT_HEALTH_CATEGORY,
        category_label: ENVIRONMENT_HEALTH_CATEGORY_LABEL,
        fix: None,
        fix_url: None,
        debug_output: None,
    },
    command: "sq",
    args: &["agent-tools", "--version"],
    pass_message_suffix: Some(
        "authenticated access to remote systems with centralized auth and observability",
    ),
    fail_message: "sq agent-tools is not available; internal workflow integrations may be limited",
}];

const LOCAL_CUSTOM_CHECKS: &[LocalCustomCheck] = &[LocalCustomCheck {
    meta: LocalCheckMeta {
        id: "goose-config",
        label: "Goose Configuration",
        category: ENVIRONMENT_HEALTH_CATEGORY,
        category_label: ENVIRONMENT_HEALTH_CATEGORY_LABEL,
        fix: None,
        fix_url: None,
        debug_output: None,
    },
    run: run_goose_config_check,
}];

const KGOOSE_CONNECTIVITY_CHECK: LocalCheckMeta = LocalCheckMeta {
    id: "internal-service-connectivity",
    label: "Internal Service Access",
    category: ENVIRONMENT_HEALTH_CATEGORY,
    category_label: ENVIRONMENT_HEALTH_CATEGORY_LABEL,
    fix: None,
    fix_url: None,
    debug_output: None,
};

const LOCAL_DOCTOR_REGISTRY: LocalDoctorRegistry<'static> = LocalDoctorRegistry {
    path_checks: &[],
    command_checks: LOCAL_COMMAND_CHECKS,
    custom_checks: LOCAL_CUSTOM_CHECKS,
};

impl From<doctor::DoctorCheck> for DoctorCheck {
    fn from(check: doctor::DoctorCheck) -> Self {
        let (category, category_label) = upstream_category(&check.id);
        Self {
            id: check.id,
            label: check.label,
            status: check.status,
            message: check.message,
            fix_url: check.fix_url,
            fix_command: check.fix_command,
            fix_type: check.fix_type,
            path: check.path,
            bridge_path: check.bridge_path,
            raw_output: check.raw_output,
            auth_status: check.auth_status,
            installed_version: check.installed_version,
            latest_version: check.latest_version,
            update_available: check.update_available,
            install_source: check.install_source,
            self_updating: check.self_updating,
            main: check.main.map(AgentVersionInfo::from),
            bridge: check.bridge.map(AgentVersionInfo::from),
            category: category.to_string(),
            category_label: category_label.to_string(),
        }
    }
}

fn upstream_category(check_id: &str) -> (&'static str, &'static str) {
    if check_id.starts_with("ai-agent-") {
        (AGENTS_CATEGORY, AGENTS_CATEGORY_LABEL)
    } else {
        (TOOLS_CATEGORY, TOOLS_CATEGORY_LABEL)
    }
}

async fn run_local_checks(
    registry: &LocalDoctorRegistry<'_>,
    distro_config_path: Option<&Path>,
) -> Vec<DoctorCheck> {
    let check_count =
        registry.path_checks.len() + registry.command_checks.len() + registry.custom_checks.len();
    if check_count == 0 {
        return Vec::new();
    }

    let captured_shell_env = shell_env::capture_shell_env().await;
    let extended_path =
        build_extended_path_from_path(captured_shell_env.get("PATH").map(String::as_str));
    let mut results = Vec::with_capacity(check_count);

    for check in registry.path_checks {
        results.push(run_local_path_check(check, &extended_path).await);
    }
    for check in registry.command_checks {
        results.push(run_local_command_check(check, &extended_path).await);
    }
    for check in registry.custom_checks {
        results.push((check.run)(
            &check.meta,
            &captured_shell_env,
            distro_config_path,
        ));
    }

    results
}

async fn run_local_path_check(check: &LocalPathCheck, extended_path: &str) -> DoctorCheck {
    let path = resolve_binary_path(check.binary_name, extended_path).await;
    let (status, message) = if path.is_some() {
        (CheckStatus::Pass, check.pass_message)
    } else {
        (CheckStatus::Fail, check.fail_message)
    };

    build_local_result(&check.meta, status, message, path, None)
}

async fn resolve_binary_path(binary_name: &str, extended_path: &str) -> Option<String> {
    resolve_binary_path_with_timeout(binary_name, extended_path, LOCAL_DOCTOR_COMMAND_TIMEOUT).await
}

async fn resolve_binary_path_with_timeout(
    binary_name: &str,
    extended_path: &str,
    command_timeout: Duration,
) -> Option<String> {
    let command = if cfg!(target_os = "windows") {
        "where"
    } else {
        "which"
    };
    let mut cmd = tokio::process::Command::new(command);
    cmd.arg(binary_name).env("PATH", extended_path);

    let output = run_timed_command(cmd, &format!("{command} {binary_name}"), command_timeout)
        .await
        .ok();
    output
        .as_ref()
        .filter(|output| output.status.success())
        .and_then(|output| {
            let stdout = String::from_utf8_lossy(&output.stdout);
            stdout
                .lines()
                .next()
                .map(str::trim)
                .filter(|p| !p.is_empty())
                .map(String::from)
        })
}

async fn run_local_command_check(check: &LocalCommandCheck, extended_path: &str) -> DoctorCheck {
    run_local_command_check_with_timeout(check, extended_path, LOCAL_DOCTOR_COMMAND_TIMEOUT).await
}

async fn run_local_command_check_with_timeout(
    check: &LocalCommandCheck,
    extended_path: &str,
    command_timeout: Duration,
) -> DoctorCheck {
    let mut command = tokio::process::Command::new(check.command);
    command
        .args(check.args)
        .env("PATH", extended_path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let output = run_timed_command(
        command,
        &format!("{} {}", check.command, check.args.join(" ")),
        command_timeout,
    )
    .await;

    let path =
        resolve_binary_path_with_timeout(check.command, extended_path, command_timeout).await;
    let (status, message, raw_output) = match output {
        Ok(output) if output.status.success() => {
            let version = String::from_utf8_lossy(&output.stdout)
                .lines()
                .rev()
                .map(str::trim)
                .find(|line| !line.is_empty())
                .unwrap_or(check.meta.label)
                .to_string();
            let message = match check.pass_message_suffix {
                Some(suffix) => format!("{version} - {suffix}"),
                None => version,
            };
            (
                CheckStatus::Pass,
                message,
                Some(format_command_output(&output)),
            )
        }
        Ok(output) => (
            CheckStatus::Fail,
            check.fail_message.to_string(),
            Some(format_command_output(&output)),
        ),
        Err(error) => (
            CheckStatus::Fail,
            check.fail_message.to_string(),
            Some(format!("failed to run command: {error}")),
        ),
    };

    build_local_result(&check.meta, status, &message, path, raw_output)
}

async fn run_timed_command(
    mut command: tokio::process::Command,
    command_label: &str,
    command_timeout: Duration,
) -> Result<Output, String> {
    command.kill_on_drop(true);
    command.stdin(Stdio::null());
    timeout(command_timeout, command.output())
        .await
        .map_err(|_| {
            format!(
                "{command_label} timed out after {} seconds",
                command_timeout.as_secs()
            )
        })?
        .map_err(|error| format!("failed to run command: {error}"))
}

fn format_command_output(output: &std::process::Output) -> String {
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    format!(
        "exit status: {}\nstdout:\n{}\nstderr:\n{}",
        output.status, stdout, stderr
    )
}

fn build_local_result(
    check: &LocalCheckMeta,
    status: CheckStatus,
    message: &str,
    path: Option<String>,
    raw_output: Option<String>,
) -> DoctorCheck {
    DoctorCheck {
        id: check.id.to_string(),
        label: check.label.to_string(),
        status,
        message: message.to_string(),
        fix_url: check.fix_url.map(String::from),
        fix_command: check.fix.as_ref().map(|fix| fix.command.to_string()),
        fix_type: check.fix.as_ref().map(|fix| fix.fix_type.clone()),
        path,
        bridge_path: None,
        raw_output: raw_output.or_else(|| check.debug_output.map(String::from)),
        auth_status: None,
        installed_version: None,
        latest_version: None,
        update_available: None,
        install_source: None,
        // Local sq-agent-tools checks are not AI agents, so they carry no
        // per-binary main/bridge readout and aren't self-updating.
        self_updating: None,
        main: None,
        bridge: None,
        category: check.category.to_string(),
        category_label: check.category_label.to_string(),
    }
}

#[derive(Default)]
struct AppConfigReport {
    lines: Vec<String>,
    findings: Vec<String>,
    has_failure: bool,
    has_warning: bool,
}

impl AppConfigReport {
    fn new() -> Self {
        Self {
            lines: vec!["checked:".to_string()],
            ..Self::default()
        }
    }

    fn push(
        &mut self,
        label: &str,
        status: CheckStatus,
        message: impl Into<String>,
        path: Option<String>,
        detail: Option<String>,
    ) {
        let message = message.into();
        self.lines
            .push(format!("- {label} [{}]: {message}", status_name(&status)));
        if let Some(path) = path {
            self.lines.push(format!("  path: {path}"));
        }
        if let Some(detail) = detail {
            self.lines
                .extend(detail.lines().map(|line| format!("  {line}")));
        }

        match &status {
            CheckStatus::Fail => {
                self.has_failure = true;
                self.findings.push(message);
            }
            CheckStatus::Warn => {
                self.has_warning = true;
                self.findings.push(message);
            }
            CheckStatus::Pass => {}
        }
    }

    fn into_check(self, check: &LocalCheckMeta) -> DoctorCheck {
        let status = if self.has_failure {
            CheckStatus::Fail
        } else if self.has_warning {
            CheckStatus::Warn
        } else {
            CheckStatus::Pass
        };
        let message = match self.findings.as_slice() {
            [] => APP_CONFIG_PASS_MESSAGE.to_string(),
            [finding] => finding.clone(),
            _ => format!("Found {} goose config findings", self.findings.len()),
        };

        build_local_result(check, status, &message, None, Some(self.lines.join("\n")))
    }
}

fn run_goose_config_check(
    check: &LocalCheckMeta,
    shell_env: &HashMap<String, String>,
    distro_config_path: Option<&Path>,
) -> DoctorCheck {
    let mut report = AppConfigReport::new();
    let mut config_paths = Vec::new();

    match goose_config::config_path() {
        Ok(path) => {
            config_paths.push(path.clone());
            push_goose_config_file(&mut report, &path);
        }
        Err(error) => report.push(
            "Config YAML",
            CheckStatus::Fail,
            error.clone(),
            None,
            Some(error),
        ),
    }

    let additional_config_files = additional_config_files_from_env(shell_env, distro_config_path);
    config_paths.extend(additional_config_files.paths.iter().cloned());
    push_additional_config_files(&mut report, &additional_config_files);
    push_thinking_settings(&mut report, shell_env, &config_paths);
    push_goose_bin_override(&mut report, env::var_os(GOOSE_BIN_ENV));

    report.into_check(check)
}

fn status_name(status: &CheckStatus) -> &'static str {
    match status {
        CheckStatus::Pass => "pass",
        CheckStatus::Warn => "warn",
        CheckStatus::Fail => "fail",
    }
}

fn additional_config_files_from_env(
    shell_env: &HashMap<String, String>,
    distro_config_path: Option<&Path>,
) -> AdditionalConfigFiles {
    let process_value = env::var_os(goose_config::ADDITIONAL_CONFIG_FILES_ENV);
    goose_config::additional_config_files_from_values(
        process_value.as_deref(),
        shell_env
            .get(goose_config::ADDITIONAL_CONFIG_FILES_ENV)
            .map(std::ffi::OsStr::new),
        distro_config_path,
    )
}

fn push_thinking_settings(
    report: &mut AppConfigReport,
    shell_env: &HashMap<String, String>,
    config_paths: &[PathBuf],
) {
    let mut sources = BTreeSet::new();
    collect_thinking_settings_from_env(shell_env, &mut sources);
    for path in config_paths {
        collect_thinking_settings_from_yaml(path, &mut sources);
    }

    if sources.is_empty() {
        report.push(
            "Thinking Settings",
            CheckStatus::Pass,
            "No risky thinking settings found in goose config or the sidecar environment",
            None,
            None,
        );
        return;
    }

    let detail = sources
        .iter()
        .map(|source| format!("- {source}"))
        .collect::<Vec<_>>()
        .join("\n");
    report.push(
        "Thinking Settings",
        CheckStatus::Warn,
        "Risky thinking settings are configured; if Claude or Opus models fail or compact immediately, remove these keys and restart the goose backend",
        None,
        Some(format!("found keys with values hidden:\n{detail}")),
    );
}

fn collect_thinking_settings_from_env(
    shell_env: &HashMap<String, String>,
    sources: &mut BTreeSet<String>,
) {
    for key in CLAUDE_THINKING_CONFIG_KEYS {
        if shell_env.contains_key(*key) {
            sources.insert(format!("login shell environment: {key}"));
        } else if env::var_os(key).is_some() {
            sources.insert(format!("process environment: {key}"));
        }
    }

    if shell_env.contains_key(GOOSE_THINKING_EFFORT_ENV) {
        sources.insert(format!(
            "login shell environment: {GOOSE_THINKING_EFFORT_ENV}"
        ));
    } else if env::var_os(GOOSE_THINKING_EFFORT_ENV).is_some() {
        sources.insert(format!("process environment: {GOOSE_THINKING_EFFORT_ENV}"));
    }
}

fn collect_thinking_settings_from_yaml(path: &Path, sources: &mut BTreeSet<String>) {
    let Ok(contents) = fs::read_to_string(path) else {
        return;
    };
    let Ok(value) = yaml_serde::from_str::<yaml_serde::Value>(&contents) else {
        return;
    };
    let Some(mapping) = value.as_mapping() else {
        return;
    };

    for key in CLAUDE_THINKING_CONFIG_KEYS {
        if mapping.contains_key(yaml_serde::Value::String((*key).to_string())) {
            sources.insert(format!("{}: {key}", path.display()));
        }
    }

    if mapping.contains_key(yaml_serde::Value::String(
        GOOSE_THINKING_EFFORT_ENV.to_string(),
    )) {
        sources.insert(format!("{}: {GOOSE_THINKING_EFFORT_ENV}", path.display()));
    }
}

fn push_goose_config_file(report: &mut AppConfigReport, path: &Path) {
    match validate_yaml_file(path) {
        ConfigFileValidation::Valid => report.push(
            "Config YAML",
            CheckStatus::Pass,
            "goose config YAML is readable",
            Some(path.display().to_string()),
            None,
        ),
        ConfigFileValidation::Missing => report.push(
            "Config YAML",
            CheckStatus::Warn,
            "goose config is missing; model setup may need to run before sessions can start",
            Some(path.display().to_string()),
            None,
        ),
        ConfigFileValidation::Invalid(error) => report.push(
            "Config YAML",
            CheckStatus::Fail,
            "goose config YAML is invalid; the goose backend may fail to start",
            Some(path.display().to_string()),
            Some(error),
        ),
    }
}

fn push_additional_config_files(
    report: &mut AppConfigReport,
    config_files: &AdditionalConfigFiles,
) {
    if !config_files.configured {
        report.push(
            "Additional Config Files",
            CheckStatus::Pass,
            "No additional goose config files are configured",
            None,
            None,
        );
        return;
    }

    if config_files.paths.is_empty() {
        report.push(
            "Additional Config Files",
            CheckStatus::Warn,
            "GOOSE_ADDITIONAL_CONFIG_FILES is set but does not contain any paths",
            None,
            Some(format!(
                "{} is empty",
                goose_config::ADDITIONAL_CONFIG_FILES_ENV
            )),
        );
        return;
    }

    let errors: Vec<String> = config_files
        .paths
        .iter()
        .filter_map(|path| match validate_yaml_file(path) {
            ConfigFileValidation::Valid => None,
            ConfigFileValidation::Missing => {
                Some(format!("{}: file does not exist", path.display()))
            }
            ConfigFileValidation::Invalid(error) => Some(format!("{}: {error}", path.display())),
        })
        .collect();

    let path = config_files
        .paths
        .iter()
        .map(|path| path.display().to_string())
        .collect::<Vec<_>>()
        .join(if cfg!(windows) { ";" } else { ":" });

    if errors.is_empty() {
        report.push(
            "Additional Config Files",
            CheckStatus::Pass,
            format!(
                "{} additional goose config file(s) are readable",
                config_files.paths.len()
            ),
            Some(path),
            None,
        )
    } else {
        report.push(
            "Additional Config Files",
            CheckStatus::Fail,
            "One or more additional goose config files are missing or invalid",
            Some(path),
            Some(errors.join("\n")),
        )
    }
}

enum ConfigFileValidation {
    Valid,
    Missing,
    Invalid(String),
}

fn validate_yaml_file(path: &Path) -> ConfigFileValidation {
    let metadata = match fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return ConfigFileValidation::Missing;
        }
        Err(error) => {
            return ConfigFileValidation::Invalid(format!("failed to inspect file: {error}"));
        }
    };

    if !metadata.is_file() {
        return ConfigFileValidation::Invalid("path is not a file".to_string());
    }

    let contents = match fs::read(path) {
        Ok(contents) => contents,
        Err(error) => {
            return ConfigFileValidation::Invalid(format!("failed to read file: {error}"));
        }
    };

    match yaml_serde::from_slice::<yaml_serde::Value>(&contents) {
        Ok(_) => ConfigFileValidation::Valid,
        Err(error) => ConfigFileValidation::Invalid(format!("failed to parse YAML: {error}")),
    }
}

fn push_goose_bin_override(report: &mut AppConfigReport, value: Option<std::ffi::OsString>) {
    let Some(value) = value else {
        report.push(
            "Goose Binary Override",
            CheckStatus::Pass,
            "No GOOSE_BIN override is configured; the bundled goose backend binary will be used",
            None,
            None,
        );
        return;
    };

    let path = PathBuf::from(value);
    if path.as_os_str().is_empty() {
        report.push(
            "Goose Binary Override",
            CheckStatus::Fail,
            "GOOSE_BIN is set but empty; Goose cannot resolve a goose backend binary override",
            None,
            None,
        );
        return;
    }

    match validate_goose_bin_path(&path) {
        Ok(()) => report.push(
            "Goose Binary Override",
            CheckStatus::Pass,
            "GOOSE_BIN points to an executable goose backend binary",
            Some(path.display().to_string()),
            None,
        ),
        Err(error) => report.push(
            "Goose Binary Override",
            CheckStatus::Fail,
            "GOOSE_BIN points to an invalid goose backend binary override",
            Some(path.display().to_string()),
            Some(error),
        ),
    }
}

fn validate_goose_bin_path(path: &Path) -> Result<(), String> {
    let metadata =
        fs::metadata(path).map_err(|error| format!("failed to inspect file: {error}"))?;
    if !metadata.is_file() {
        return Err("path is not a file".to_string());
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o111 == 0 {
            return Err("file is not executable".to_string());
        }
    }

    Ok(())
}

async fn run_kgoose_connectivity_check(
    distro_state: &DistroBundleState,
    runtime_config: &RuntimeConfig,
) -> DoctorCheck {
    let kgoose = KgooseContext::new(distro_state, runtime_config);
    match kgoose.probe_connectivity().await {
        Ok(probe) => build_kgoose_connectivity_check(&KGOOSE_CONNECTIVITY_CHECK, probe),
        Err(error) => build_kgoose_connectivity_error(&KGOOSE_CONNECTIVITY_CHECK, error.as_str()),
    }
}

fn build_kgoose_connectivity_check(
    check: &LocalCheckMeta,
    probe: KgooseProbeResult,
) -> DoctorCheck {
    let status_label = kgoose_probe_status_label(&probe);
    let (status, message) = if probe.status == Some(407) {
        (
            CheckStatus::Fail,
            format!(
                "Checked kgoose access probe at {}; proxy authentication required ({status_label})",
                probe.url
            ),
        )
    } else if probe.likely_warp_failure {
        (
            CheckStatus::Fail,
            format!(
                "Checked kgoose access probe at {}; WARP/access failure suspected ({status_label})",
                probe.url
            ),
        )
    } else if probe.status.is_some() {
        (
            CheckStatus::Pass,
            format!(
                "Checked kgoose access probe at {}; {status_label} reachable",
                probe.url
            ),
        )
    } else {
        (
            CheckStatus::Warn,
            format!(
                "Checked kgoose access probe at {}; request failed for an unclassified network reason",
                probe.url
            ),
        )
    };

    build_local_result(
        check,
        status,
        &message,
        None,
        Some(format_kgoose_probe_details(&probe)),
    )
}

fn build_kgoose_connectivity_error(check: &LocalCheckMeta, error: &str) -> DoctorCheck {
    build_local_result(
        check,
        CheckStatus::Fail,
        "Internal service probe could not run",
        None,
        Some(format!("error: {error}")),
    )
}

fn format_kgoose_probe_details(probe: &KgooseProbeResult) -> String {
    format!(
        "checked: kgoose access probe\nurl: {}\nkind: {}\nstatus: {}\nlikely_warp_failure: {}\nclassification: {}\nmessage: {}",
        probe.url,
        probe.kind,
        kgoose_probe_status_label(probe),
        probe.likely_warp_failure,
        classify_kgoose_probe(probe),
        probe.message
    )
}

fn kgoose_probe_status_label(probe: &KgooseProbeResult) -> String {
    probe
        .status
        .map(|status| format!("HTTP {status}"))
        .unwrap_or_else(|| "no HTTP status".to_string())
}

fn classify_kgoose_probe(probe: &KgooseProbeResult) -> &'static str {
    if probe.status == Some(407) {
        "proxy_auth_required"
    } else if probe.likely_warp_failure {
        "likely_warp_or_access_failure"
    } else if probe.status.is_some() {
        "reachable"
    } else {
        "unclassified_request_failure"
    }
}

fn find_local_fix<'a>(
    registry: &'a LocalDoctorRegistry<'_>,
    check_id: &str,
    fix_type: &FixType,
) -> Option<&'a LocalDoctorFix> {
    registry
        .path_checks
        .iter()
        .map(|check| &check.meta)
        .chain(registry.command_checks.iter().map(|check| &check.meta))
        .chain(registry.custom_checks.iter().map(|check| &check.meta))
        .find(|check| check.id == check_id)
        .and_then(|check| check.fix.as_ref())
        .filter(|fix| &fix.fix_type == fix_type)
}

async fn execute_local_fix(command: &'static str) -> Result<(), String> {
    let extended_path = build_extended_path().await;
    let (shell, flag) = if cfg!(target_os = "windows") {
        ("cmd", "/C")
    } else {
        ("sh", "-c")
    };

    let output = tokio::process::Command::new(shell)
        .arg(flag)
        .arg(command)
        .env("PATH", extended_path)
        .output()
        .await
        .map_err(|error| format!("Failed to run command: {error}"))?;

    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(if stderr.is_empty() {
            format!("Command failed with exit code {}", output.status)
        } else {
            stderr
        })
    }
}

async fn run_doctor_impl(
    registry: &LocalDoctorRegistry<'_>,
    distro_state: &DistroBundleState,
    runtime_config: &RuntimeConfig,
    check_freshness: bool,
) -> DoctorReport {
    if !doctor_enabled(runtime_config) {
        return DoctorReport { checks: Vec::new() };
    }

    let upstream = doctor::run_checks_with_options(doctor::RunChecksOptions {
        npm_registry: Some(crate::commands::agent_setup::BLOCK_NPM_REGISTRY_URL.to_string()),
        check_freshness,
        // Freshness, when enabled, runs against the network (and the crate's
        // 1-hour disk cache); `offline` would suppress the registry lookups we
        // want here.
        offline: false,
    })
    .await;
    let mut checks: Vec<DoctorCheck> = upstream.checks.into_iter().map(DoctorCheck::from).collect();
    let distro_config_path = distro_state
        .bundle()
        .and_then(|bundle| bundle.config_path.as_deref());
    if doctor_internal_tooling_checks_enabled(runtime_config) {
        checks.extend(run_local_checks(registry, distro_config_path).await);
    }
    if doctor_kgoose_connectivity_enabled(runtime_config) {
        checks.push(run_kgoose_connectivity_check(distro_state, runtime_config).await);
    }
    DoctorReport { checks }
}

fn doctor_config(runtime_config: &RuntimeConfig) -> Option<&RuntimeDoctorConfig> {
    runtime_config.doctor.as_ref()
}

fn doctor_enabled(runtime_config: &RuntimeConfig) -> bool {
    doctor_config(runtime_config)
        .and_then(|doctor| doctor.enabled)
        .unwrap_or(true)
}

fn doctor_internal_tooling_checks_enabled(runtime_config: &RuntimeConfig) -> bool {
    doctor_config(runtime_config)
        .and_then(|doctor| doctor.internal_tooling_checks)
        .unwrap_or(true)
}

fn doctor_kgoose_connectivity_enabled(runtime_config: &RuntimeConfig) -> bool {
    doctor_config(runtime_config)
        .and_then(|doctor| doctor.kgoose_connectivity)
        .unwrap_or(true)
}

async fn run_doctor_or_timeout<F>(future: F, timeout_duration: Duration) -> DoctorReport
where
    F: Future<Output = DoctorReport>,
{
    match timeout(timeout_duration, future).await {
        Ok(report) => report,
        Err(_) => doctor_timeout_report(timeout_duration),
    }
}

async fn run_doctor_fresh_or_timeout<F>(
    future: F,
    timeout_duration: Duration,
) -> Result<DoctorReport, String>
where
    F: Future<Output = DoctorReport>,
{
    timeout(timeout_duration, future).await.map_err(|_| {
        format!(
            "Doctor freshness checks timed out after {} seconds",
            timeout_duration.as_secs()
        )
    })
}

fn doctor_timeout_report(timeout_duration: Duration) -> DoctorReport {
    DoctorReport {
        checks: vec![DoctorCheck {
            id: DOCTOR_TIMEOUT_CHECK_ID.to_string(),
            label: "Doctor Checks".to_string(),
            status: CheckStatus::Warn,
            message: format!(
                "Doctor timed out after {} seconds; a tool probe may be hanging",
                timeout_duration.as_secs()
            ),
            fix_url: None,
            fix_command: None,
            fix_type: None,
            path: None,
            bridge_path: None,
            raw_output: Some(format!(
                "checked: app-side doctor timeout\ntimeout_seconds: {}\nmessage: Berd stopped waiting for Doctor checks so the page could render. The upstream doctor crate may still have an unbounded subprocess running.",
                timeout_duration.as_secs()
            )),
            auth_status: None,
            installed_version: None,
            latest_version: None,
            update_available: None,
            install_source: None,
            self_updating: None,
            main: None,
            bridge: None,
            category: ENVIRONMENT_HEALTH_CATEGORY.to_string(),
            category_label: ENVIRONMENT_HEALTH_CATEGORY_LABEL.to_string(),
        }],
    }
}

/// Run all health checks and return the report.
///
/// This is the fast, offline status read that paints the settings screen: it
/// skips the freshness pass (`check_freshness: false`), so no binary
/// version-probing or registry lookups happen on the synchronous path.
#[tauri::command]
pub async fn run_doctor(
    distro_state: State<'_, DistroBundleState>,
    runtime_config_state: State<'_, RuntimeConfigState>,
) -> Result<DoctorReport, String> {
    let runtime_config = runtime_config_state
        .ready_config(distro_state.inner())
        .await?;
    Ok(run_doctor_or_timeout(
        run_doctor_impl(
            &LOCAL_DOCTOR_REGISTRY,
            distro_state.inner(),
            &runtime_config,
            false,
        ),
        DOCTOR_REPORT_TIMEOUT,
    )
    .await)
}

/// Run all health checks *with the freshness pass enabled*.
///
/// This is the slower, network-touching variant: it populates
/// installed/latest version and update-available fields by probing binaries
/// and the relevant registries. The frontend runs this off the synchronous
/// path (in the background once Settings opens) and seeds the result into the
/// shared report cache, so version/update badges fill in progressively without
/// regressing first-paint latency. The crate's 1-hour disk cache at
/// `<cache_dir>/doctor/freshness.json` keeps repeated calls cheap.
#[tauri::command]
pub async fn run_doctor_fresh(
    distro_state: State<'_, DistroBundleState>,
    runtime_config_state: State<'_, RuntimeConfigState>,
) -> Result<DoctorReport, String> {
    let runtime_config = runtime_config_state
        .ready_config(distro_state.inner())
        .await?;
    run_doctor_fresh_or_timeout(
        run_doctor_impl(
            &LOCAL_DOCTOR_REGISTRY,
            distro_state.inner(),
            &runtime_config,
            true,
        ),
        DOCTOR_FRESH_REPORT_TIMEOUT,
    )
    .await
}

/// Run a fix command for a doctor check, identified by check ID and fix type.
///
/// `command_override` lets the frontend pass a verbatim shell command (used by
/// the per-readout Update affordances, whose source-aware commands aren't in
/// the crate's static lookup table); `None` falls back to the crate's
/// `lookup_fix_command`. The npm registry override is still applied either way.
#[tauri::command]
pub async fn run_doctor_fix(
    check_id: String,
    fix_type: FixType,
    command_override: Option<String>,
) -> Result<(), String> {
    if command_override.is_none() {
        if let Some(fix) = find_local_fix(&LOCAL_DOCTOR_REGISTRY, &check_id, &fix_type) {
            return execute_local_fix(fix.command).await;
        }
    }
    doctor::execute_fix_with_options(
        check_id,
        fix_type,
        command_override,
        Some(crate::commands::agent_setup::BLOCK_NPM_REGISTRY_URL),
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn upstream_check(id: &str) -> doctor::DoctorCheck {
        doctor::DoctorCheck {
            id: id.to_string(),
            label: "Check".to_string(),
            status: CheckStatus::Pass,
            message: "ok".to_string(),
            fix_url: None,
            fix_command: None,
            fix_type: None,
            path: None,
            bridge_path: None,
            raw_output: None,
            auth_status: None,
            installed_version: None,
            latest_version: None,
            update_available: None,
            install_source: None,
            self_updating: None,
            main: None,
            bridge: None,
        }
    }

    fn fixture_meta() -> LocalCheckMeta {
        LocalCheckMeta {
            id: "fixture-check",
            label: "Fixture Check",
            category: "environment",
            category_label: "Environment",
            fix: None,
            fix_url: None,
            debug_output: None,
        }
    }

    fn custom_fixture_check(
        check: &LocalCheckMeta,
        _shell_env: &HashMap<String, String>,
        _distro_config_path: Option<&Path>,
    ) -> DoctorCheck {
        build_local_result(
            check,
            CheckStatus::Warn,
            "fixture warning",
            Some("/tmp/fixture".to_string()),
            Some("fixture debug".to_string()),
        )
    }

    fn runtime_config_with_doctor(doctor: Option<RuntimeDoctorConfig>) -> RuntimeConfig {
        RuntimeConfig {
            schema_version: 2,
            customer: None,
            workspace: None,
            goose: super::super::runtime_config::default_goose_config(),
            feature_toggles: None,
            doctor,
            feedback: None,
            kgoose: None,
        }
    }

    #[test]
    fn doctor_timeout_report_builds_synthetic_warning() {
        let report = doctor_timeout_report(DOCTOR_REPORT_TIMEOUT);
        let check = report.checks.first().expect("timeout check");

        assert_eq!(check.id, DOCTOR_TIMEOUT_CHECK_ID);
        assert_eq!(check.status, CheckStatus::Warn);
        assert_eq!(check.category, ENVIRONMENT_HEALTH_CATEGORY);
        assert_eq!(check.category_label, ENVIRONMENT_HEALTH_CATEGORY_LABEL);
        assert!(check.message.contains("60 seconds"));
        assert!(check
            .raw_output
            .as_deref()
            .is_some_and(|raw| raw.contains("app-side doctor timeout")));
    }

    #[test]
    fn doctor_policy_comes_from_runtime_config() {
        let disabled = runtime_config_with_doctor(Some(RuntimeDoctorConfig {
            enabled: Some(false),
            kgoose_connectivity: Some(false),
            internal_tooling_checks: Some(false),
        }));
        assert!(!doctor_enabled(&disabled));
        assert!(!doctor_kgoose_connectivity_enabled(&disabled));
        assert!(!doctor_internal_tooling_checks_enabled(&disabled));

        let defaulted = runtime_config_with_doctor(None);
        assert!(doctor_enabled(&defaulted));
        assert!(doctor_kgoose_connectivity_enabled(&defaulted));
        assert!(doctor_internal_tooling_checks_enabled(&defaulted));
    }

    #[tokio::test]
    async fn doctor_fresh_timeout_helper_returns_error() {
        let error = run_doctor_fresh_or_timeout(std::future::pending(), Duration::from_millis(1))
            .await
            .expect_err("freshness timeout should be an error");

        assert!(error.contains("Doctor freshness checks timed out"));
    }

    #[test]
    fn doctor_report_renders_diagnostic_text_grouped_by_category() {
        let report = DoctorReport {
            checks: vec![
                DoctorCheck {
                    category: "tools".to_string(),
                    category_label: "Tools".to_string(),
                    raw_output: Some("exit status: 0\nstdout:\nv1.2.3".to_string()),
                    path: Some("/usr/bin/git".to_string()),
                    ..DoctorCheck::from(upstream_check("git"))
                },
                DoctorCheck {
                    category: "environment-health".to_string(),
                    category_label: "Environment Health".to_string(),
                    ..DoctorCheck::from(upstream_check("internal-service-connectivity"))
                },
            ],
        };

        let text = report.to_diagnostic_text();

        assert!(text.contains("== Tools =="));
        assert!(text.contains("== Environment Health =="));
        assert!(text.contains("[pass] Check (git)"));
        assert!(text.contains("  path: /usr/bin/git"));
        assert!(text.contains("  details:\n    exit status: 0"));
        // Category headers appear before the checks that belong to them.
        assert!(text.find("== Tools ==").unwrap() < text.find("(git)").unwrap());
    }

    #[test]
    fn converts_upstream_tools_category() {
        let check = DoctorCheck::from(upstream_check("git"));

        assert_eq!(check.category, "tools");
        assert_eq!(check.category_label, "Tools");
    }

    #[test]
    fn converts_upstream_agents_category() {
        let check = DoctorCheck::from(upstream_check("ai-agent-codex-acp"));

        assert_eq!(check.category, "agents");
        assert_eq!(check.category_label, "Agents");
    }

    #[test]
    fn local_registry_includes_sq_agent_tools_check() {
        let check = LOCAL_DOCTOR_REGISTRY
            .command_checks
            .iter()
            .find(|check| check.meta.id == "sq-agent-tools")
            .expect("sq agent-tools check");

        assert_eq!(check.command, "sq");
        assert_eq!(check.args, &["agent-tools", "--version"]);
        assert!(check
            .pass_message_suffix
            .is_some_and(|suffix| suffix.contains("centralized auth")));
        assert_eq!(check.meta.category, "environment-health");
        assert_eq!(check.meta.category_label, "Environment Health");
        assert!(check.meta.fix.is_none());
    }

    #[test]
    fn app_config_report_collapses_findings_and_keeps_details() {
        let mut report = AppConfigReport::new();
        report.push(
            "Config YAML",
            CheckStatus::Pass,
            "goose config YAML is readable",
            Some("/tmp/config.yaml".to_string()),
            None,
        );
        report.push(
            "Goose Binary Override",
            CheckStatus::Fail,
            "GOOSE_BIN points to an invalid goose backend binary override",
            Some("/tmp/goose".to_string()),
            Some("file is not executable".to_string()),
        );

        let check = report.into_check(&fixture_meta());

        assert_eq!(check.status, CheckStatus::Fail);
        assert_eq!(
            check.message,
            "GOOSE_BIN points to an invalid goose backend binary override"
        );
        let output = check.raw_output.as_deref().expect("raw output");
        assert!(output.contains("Config YAML [pass]"));
        assert!(output.contains("Goose Binary Override [fail]"));
        assert!(output.contains("path: /tmp/goose"));
        assert!(output.contains("file is not executable"));
    }

    #[test]
    fn thinking_settings_warn_on_key_presence_without_values() {
        let dir = tempfile::tempdir().unwrap();
        let config_path = dir.path().join("config.yaml");
        fs::write(
            &config_path,
            "CLAUDE_THINKING_TYPE: enabled\nGOOSE_THINKING_EFFORT: high\n",
        )
        .unwrap();
        let shell_env =
            HashMap::from([("CLAUDE_THINKING_BUDGET".to_string(), "200000".to_string())]);
        let mut report = AppConfigReport::new();

        push_thinking_settings(&mut report, &shell_env, &[config_path.clone()]);
        let check = report.into_check(&fixture_meta());

        assert_eq!(check.status, CheckStatus::Warn);
        let output = check.raw_output.as_deref().expect("raw output");
        assert!(output.contains("login shell environment: CLAUDE_THINKING_BUDGET"));
        assert!(output.contains(&format!("{}: CLAUDE_THINKING_TYPE", config_path.display())));
        assert!(output.contains(&format!("{}: GOOSE_THINKING_EFFORT", config_path.display())));
        assert!(!output.contains("enabled"));
        assert!(!output.contains("200000"));
        assert!(!output.contains("high"));
    }

    #[test]
    fn kgoose_connectivity_check_passes_for_reachable_probe() {
        let check = build_kgoose_connectivity_check(
            &KGOOSE_CONNECTIVITY_CHECK,
            KgooseProbeResult {
                likely_warp_failure: false,
                status: Some(200),
                kind: "http_status",
                url: "https://kgoose.example.test/cash-app/goose/list-oauth-extensions".to_string(),
                message: "kgoose probe returned 200".to_string(),
            },
        );

        assert_eq!(check.status, CheckStatus::Pass);
        assert_eq!(
            check.message,
            "Checked kgoose access probe at https://kgoose.example.test/cash-app/goose/list-oauth-extensions; HTTP 200 reachable"
        );
        let output = check.raw_output.as_deref().expect("raw output");
        assert!(output
            .contains("url: https://kgoose.example.test/cash-app/goose/list-oauth-extensions"));
        assert!(output.contains("classification: reachable"));
        assert!(output.contains("message: kgoose probe returned 200"));
    }

    #[tokio::test]
    async fn runs_local_registry_custom_checks() {
        let checks = [LocalCustomCheck {
            meta: fixture_meta(),
            run: custom_fixture_check,
        }];
        let registry = LocalDoctorRegistry {
            path_checks: &[],
            command_checks: &[],
            custom_checks: &checks,
        };

        let results = run_local_checks(&registry, None).await;

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].id, "fixture-check");
        assert_eq!(results[0].category, "environment");
        assert_eq!(results[0].category_label, "Environment");
        assert_eq!(results[0].status, CheckStatus::Warn);
        assert_eq!(results[0].path.as_deref(), Some("/tmp/fixture"));
        assert_eq!(results[0].raw_output.as_deref(), Some("fixture debug"));
    }

    #[tokio::test]
    async fn runs_local_registry_command_checks() {
        let (command, args): (&str, &[&str]) = if cfg!(target_os = "windows") {
            ("cmd", &["/C", "echo command-output"])
        } else {
            ("sh", &["-c", "printf command-output"])
        };
        let checks = [LocalCommandCheck {
            meta: fixture_meta(),
            command,
            args,
            pass_message_suffix: None,
            fail_message: "command failed",
        }];
        let registry = LocalDoctorRegistry {
            path_checks: &[],
            command_checks: &checks,
            custom_checks: &[],
        };

        let results = run_local_checks(&registry, None).await;

        assert_eq!(results[0].status, CheckStatus::Pass);
        assert_eq!(results[0].message.trim(), "command-output");
        assert!(results[0]
            .raw_output
            .as_deref()
            .is_some_and(|output| output.contains("command-output")));
    }

    #[tokio::test]
    async fn local_command_check_reports_timeout() {
        let (command, args): (&str, &[&str]) = if cfg!(target_os = "windows") {
            ("cmd", &["/C", "for /L %i in (0,0,1) do @rem"])
        } else {
            ("sh", &["-c", "while true; do :; done"])
        };
        let check = LocalCommandCheck {
            meta: fixture_meta(),
            command,
            args,
            pass_message_suffix: None,
            fail_message: "command failed",
        };

        let path = std::env::var("PATH").unwrap_or_default();
        let result =
            run_local_command_check_with_timeout(&check, &path, Duration::from_millis(10)).await;

        assert_eq!(result.status, CheckStatus::Fail);
        assert_eq!(result.message, "command failed");
        assert!(result
            .raw_output
            .as_deref()
            .is_some_and(|output| output.contains("timed out")));
    }

    #[tokio::test]
    async fn runs_local_registry_path_checks() {
        let binary_name = if cfg!(target_os = "windows") {
            "cmd"
        } else {
            "sh"
        };
        let checks = [LocalPathCheck {
            meta: fixture_meta(),
            binary_name,
            pass_message: "path found",
            fail_message: "path missing",
        }];
        let registry = LocalDoctorRegistry {
            path_checks: &checks,
            command_checks: &[],
            custom_checks: &[],
        };

        let results = run_local_checks(&registry, None).await;

        assert_eq!(results[0].status, CheckStatus::Pass);
        assert_eq!(results[0].message, "path found");
        assert!(results[0].path.is_some());
    }

    #[test]
    fn local_fix_lookup_precedes_upstream_fallback() {
        let checks = [LocalCustomCheck {
            meta: LocalCheckMeta {
                fix: Some(LocalDoctorFix {
                    fix_type: FixType::Command,
                    command: "true",
                }),
                ..fixture_meta()
            },
            run: custom_fixture_check,
        }];
        let registry = LocalDoctorRegistry {
            path_checks: &[],
            command_checks: &[],
            custom_checks: &checks,
        };

        let local_fix = find_local_fix(&registry, "fixture-check", &FixType::Command);
        assert_eq!(local_fix.map(|fix| fix.command), Some("true"));
        assert!(find_local_fix(&registry, "git", &FixType::Command).is_none());
    }
}
