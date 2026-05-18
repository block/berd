//! Tauri command wrappers for the doctor health-check system.

use std::process::Stdio;

use serde::{Deserialize, Serialize};

use crate::services::path_env::build_extended_path;

use doctor::CheckStatus;
pub use doctor::FixType;

const TOOLS_CATEGORY: &str = "tools";
const TOOLS_CATEGORY_LABEL: &str = "Tools";
const AGENTS_CATEGORY: &str = "agents";
const AGENTS_CATEGORY_LABEL: &str = "Agents";
const INTERNAL_TOOLS_CATEGORY: &str = "internal-tools";
const INTERNAL_TOOLS_CATEGORY_LABEL: &str = "Internal Tools";

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
    run: fn(&LocalCheckMeta) -> DoctorCheck,
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
        category: INTERNAL_TOOLS_CATEGORY,
        category_label: INTERNAL_TOOLS_CATEGORY_LABEL,
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

const LOCAL_DOCTOR_REGISTRY: LocalDoctorRegistry<'static> = LocalDoctorRegistry {
    path_checks: &[],
    command_checks: LOCAL_COMMAND_CHECKS,
    custom_checks: &[],
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

async fn run_local_checks(registry: &LocalDoctorRegistry<'_>) -> Vec<DoctorCheck> {
    let check_count =
        registry.path_checks.len() + registry.command_checks.len() + registry.custom_checks.len();
    if check_count == 0 {
        return Vec::new();
    }

    let extended_path = build_extended_path().await;
    let mut results = Vec::with_capacity(check_count);

    for check in registry.path_checks {
        results.push(run_local_path_check(check, &extended_path).await);
    }
    for check in registry.command_checks {
        results.push(run_local_command_check(check, &extended_path).await);
    }
    for check in registry.custom_checks {
        results.push((check.run)(&check.meta));
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

async fn run_doctor_impl(registry: &LocalDoctorRegistry<'_>) -> DoctorReport {
    let upstream = doctor::run_checks().await;
    let mut checks: Vec<DoctorCheck> = upstream.checks.into_iter().map(DoctorCheck::from).collect();
    checks.extend(run_local_checks(registry).await);
    DoctorReport { checks }
}

/// Run all health checks and return the report.
#[tauri::command]
pub async fn run_doctor() -> DoctorReport {
    run_doctor_impl(&LOCAL_DOCTOR_REGISTRY).await
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

    fn custom_fixture_check(check: &LocalCheckMeta) -> DoctorCheck {
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
        assert_eq!(check.meta.category, "internal-tools");
        assert_eq!(check.meta.category_label, "Internal Tools");
        assert!(check.meta.fix.is_none());
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

        let results = run_local_checks(&registry).await;

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

        let results = run_local_checks(&registry).await;

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

        let results = run_local_checks(&registry).await;

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
