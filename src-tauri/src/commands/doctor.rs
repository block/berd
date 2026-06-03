//! Tauri command wrappers for the doctor health-check system.

use std::{
    collections::{BTreeSet, HashMap},
    env, fs,
    path::{Path, PathBuf},
    process::Stdio,
};

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::services::{
    distro_bundle::DistroBundleState,
    goose_config::{self, AdditionalConfigFiles},
    kgoose::{self, KgooseProbeResult},
    path_env::{build_extended_path, build_extended_path_from_path},
    shell_env,
};

use doctor::CheckStatus;
pub use doctor::FixType;

const TOOLS_CATEGORY: &str = "tools";
const TOOLS_CATEGORY_LABEL: &str = "Tools";
const AGENTS_CATEGORY: &str = "agents";
const AGENTS_CATEGORY_LABEL: &str = "Agents";
const ENVIRONMENT_HEALTH_CATEGORY: &str = "environment-health";
const ENVIRONMENT_HEALTH_CATEGORY_LABEL: &str = "Environment Health";
const GOOSE_BIN_ENV: &str = "GOOSE_BIN";
const APP_CONFIG_PASS_MESSAGE: &str =
    "Checked config YAML, additional config files, thinking settings, and Goose binary override";
const CLAUDE_THINKING_CONFIG_KEYS: &[&str] = &[
    "CLAUDE_THINKING_TYPE",
    "CLAUDE_THINKING_ENABLED",
    "CLAUDE_THINKING_BUDGET",
    "ANTHROPIC_THINKING_BUDGET",
];
const GOOSE_THINKING_EFFORT_ENV: &str = "GOOSE_THINKING_EFFORT";

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
    pub category: String,
    pub category_label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DoctorReport {
    pub checks: Vec<DoctorCheck>,
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
    let command = if cfg!(target_os = "windows") {
        "where"
    } else {
        "which"
    };
    let mut cmd = tokio::process::Command::new(command);
    cmd.arg(binary_name).env("PATH", extended_path);

    let output = cmd.output().await.ok();
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
    let output = tokio::process::Command::new(check.command)
        .args(check.args)
        .env("PATH", extended_path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await;

    let path = resolve_binary_path(check.command, extended_path).await;
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
            _ => format!("Found {} Goose config findings", self.findings.len()),
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
            "No risky thinking settings found in Goose config or the sidecar environment",
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
        "Risky thinking settings are configured; if Claude or Opus models fail or compact immediately, remove these keys and restart Goose Internal",
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
    let Ok(value) = serde_yaml::from_str::<serde_yaml::Value>(&contents) else {
        return;
    };
    let Some(mapping) = value.as_mapping() else {
        return;
    };

    for key in CLAUDE_THINKING_CONFIG_KEYS {
        if mapping.contains_key(serde_yaml::Value::String((*key).to_string())) {
            sources.insert(format!("{}: {key}", path.display()));
        }
    }

    if mapping.contains_key(serde_yaml::Value::String(
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
            "Goose config YAML is readable",
            Some(path.display().to_string()),
            None,
        ),
        ConfigFileValidation::Missing => report.push(
            "Config YAML",
            CheckStatus::Warn,
            "Goose config is missing; model setup may need to run before sessions can start",
            Some(path.display().to_string()),
            None,
        ),
        ConfigFileValidation::Invalid(error) => report.push(
            "Config YAML",
            CheckStatus::Fail,
            "Goose config YAML is invalid; Goose may fail to start",
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
            "No additional Goose config files are configured",
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
                "{} additional Goose config file(s) are readable",
                config_files.paths.len()
            ),
            Some(path),
            None,
        )
    } else {
        report.push(
            "Additional Config Files",
            CheckStatus::Fail,
            "One or more additional Goose config files are missing or invalid",
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

    match serde_yaml::from_slice::<serde_yaml::Value>(&contents) {
        Ok(_) => ConfigFileValidation::Valid,
        Err(error) => ConfigFileValidation::Invalid(format!("failed to parse YAML: {error}")),
    }
}

fn push_goose_bin_override(report: &mut AppConfigReport, value: Option<std::ffi::OsString>) {
    let Some(value) = value else {
        report.push(
            "Goose Binary Override",
            CheckStatus::Pass,
            "No GOOSE_BIN override is configured; the bundled Goose binary will be used",
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
            "GOOSE_BIN is set but empty; Goose Internal cannot resolve a Goose binary override",
            None,
            None,
        );
        return;
    }

    match validate_goose_bin_path(&path) {
        Ok(()) => report.push(
            "Goose Binary Override",
            CheckStatus::Pass,
            "GOOSE_BIN points to an executable file",
            Some(path.display().to_string()),
            None,
        ),
        Err(error) => report.push(
            "Goose Binary Override",
            CheckStatus::Fail,
            "GOOSE_BIN points to an invalid Goose binary override",
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

async fn run_kgoose_connectivity_check(distro_state: &DistroBundleState) -> DoctorCheck {
    match kgoose::probe_connectivity(distro_state).await {
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
            format!("Checked kgoose access probe; proxy authentication required ({status_label})"),
        )
    } else if probe.likely_warp_failure {
        (
            CheckStatus::Fail,
            format!("Checked kgoose access probe; WARP/access failure suspected ({status_label})"),
        )
    } else if probe.status.is_some() {
        (
            CheckStatus::Pass,
            format!("Checked kgoose access probe; {status_label} reachable"),
        )
    } else {
        (
            CheckStatus::Warn,
            "Checked kgoose access probe; request failed for an unclassified network reason"
                .to_string(),
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
        "checked: kgoose access probe\nkind: {}\nstatus: {}\nlikely_warp_failure: {}\nclassification: {}",
        probe.kind,
        kgoose_probe_status_label(probe),
        probe.likely_warp_failure,
        classify_kgoose_probe(probe)
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
) -> DoctorReport {
    let upstream = doctor::run_checks().await;
    let mut checks: Vec<DoctorCheck> = upstream.checks.into_iter().map(DoctorCheck::from).collect();
    let distro_config_path = distro_state
        .bundle()
        .and_then(|bundle| bundle.config_path.as_deref());
    checks.extend(run_local_checks(registry, distro_config_path).await);
    checks.push(run_kgoose_connectivity_check(distro_state).await);
    DoctorReport { checks }
}

/// Run all health checks and return the report.
#[tauri::command]
pub async fn run_doctor(
    distro_state: State<'_, DistroBundleState>,
) -> Result<DoctorReport, String> {
    Ok(run_doctor_impl(&LOCAL_DOCTOR_REGISTRY, distro_state.inner()).await)
}

/// Run a fix command for a doctor check, identified by check ID and fix type.
#[tauri::command]
pub async fn run_doctor_fix(check_id: String, fix_type: FixType) -> Result<(), String> {
    if let Some(fix) = find_local_fix(&LOCAL_DOCTOR_REGISTRY, &check_id, &fix_type) {
        execute_local_fix(fix.command).await
    } else {
        doctor::execute_fix(check_id, fix_type).await
    }
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
            "Goose config YAML is readable",
            Some("/tmp/config.yaml".to_string()),
            None,
        );
        report.push(
            "Goose Binary Override",
            CheckStatus::Fail,
            "GOOSE_BIN points to an invalid Goose binary override",
            Some("/tmp/goose".to_string()),
            Some("file is not executable".to_string()),
        );

        let check = report.into_check(&fixture_meta());

        assert_eq!(check.status, CheckStatus::Fail);
        assert_eq!(
            check.message,
            "GOOSE_BIN points to an invalid Goose binary override"
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
                message: "kgoose probe returned 200".to_string(),
            },
        );

        assert_eq!(check.status, CheckStatus::Pass);
        assert_eq!(
            check.message,
            "Checked kgoose access probe; HTTP 200 reachable"
        );
        let output = check.raw_output.as_deref().expect("raw output");
        assert!(output.contains("classification: reachable"));
        assert!(!output.contains("kgoose probe returned 200"));
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
