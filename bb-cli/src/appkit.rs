//! Compatibility wrapper for the Cloudflare-backed internal Block App Kit CLI.
//!
//! This powers `sq agent-tools appkit` and `bb tools appkit`. It is separate
//! from the root `bb appkit` command used by the external App Kit-on-Compose
//! pilot and must remain available while the internal experience is unchanged.

use std::io;
use std::process::{Command, ExitStatus, Stdio};

use anyhow::{anyhow, Result};

use crate::cli::{global_arg_skip_count, APPKIT_COMMAND_NAME};

pub(crate) fn is_appkit_command(command_tokens: &[String]) -> bool {
    command_tokens.first().map(String::as_str) == Some(APPKIT_COMMAND_NAME)
}

pub(crate) fn should_run_before_bootstrap(raw_args: &[String]) -> bool {
    let Some(position) = appkit_command_position(raw_args) else {
        return false;
    };

    position.after_separator
        || !raw_args[position.index + 1..]
            .iter()
            .any(|arg| arg == "--describe-commands")
}

pub(crate) fn run(raw_args: &[String]) -> Result<()> {
    let args = raw_args_after_appkit(raw_args);
    exec_appkit(&args)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct AppkitCommandPosition {
    index: usize,
    after_separator: bool,
}

fn appkit_command_position(raw_args: &[String]) -> Option<AppkitCommandPosition> {
    let mut index = 0;
    while index < raw_args.len() {
        match raw_args[index].as_str() {
            APPKIT_COMMAND_NAME => {
                return Some(AppkitCommandPosition {
                    index,
                    after_separator: false,
                });
            }
            "--" => {
                return (raw_args.get(index + 1).map(String::as_str) == Some(APPKIT_COMMAND_NAME))
                    .then_some(AppkitCommandPosition {
                        index: index + 1,
                        after_separator: true,
                    });
            }
            value if is_bootstrap_metadata_prefix(value) => return None,
            value => {
                let skip_count = global_arg_skip_count(value);
                if skip_count == 0 {
                    return None;
                }
                index += skip_count;
            }
        }
    }

    None
}

fn is_bootstrap_metadata_prefix(arg: &str) -> bool {
    matches!(
        arg,
        "--describe-commands" | "--summary" | "--write-extensions"
    ) || arg.starts_with("--write-extensions=")
}

fn raw_args_after_appkit(raw_args: &[String]) -> Vec<&str> {
    let mut index = 0;
    while index < raw_args.len() {
        match raw_args[index].as_str() {
            APPKIT_COMMAND_NAME => {
                return raw_args[index + 1..].iter().map(String::as_str).collect();
            }
            "--" => {
                if raw_args.get(index + 1).map(String::as_str) == Some(APPKIT_COMMAND_NAME) {
                    return raw_args[index + 2..].iter().map(String::as_str).collect();
                }
                index += 1;
            }
            value => index += global_arg_skip_count(value).max(1),
        }
    }

    Vec::new()
}

fn exec_appkit(args: &[&str]) -> Result<()> {
    match child_status(APPKIT_COMMAND_NAME, &[], args) {
        Ok(status) => std::process::exit(child_exit_code(status)),
        Err(err) if err.kind() == io::ErrorKind::NotFound => {}
        Err(err) => return Err(command_error(APPKIT_COMMAND_NAME, err)),
    }

    match child_status(
        "uvx",
        &["--from", "mcp_block_app_kit", APPKIT_COMMAND_NAME],
        args,
    ) {
        Ok(status) => std::process::exit(child_exit_code(status)),
        Err(err) if err.kind() == io::ErrorKind::NotFound => anyhow::bail!(
            "appkit or uvx not found. Install appkit on PATH, or install uv so sq agent-tools can run mcp_block_app_kit on demand."
        ),
        Err(err) => Err(command_error("uvx", err)),
    }
}

fn child_status(binary: &str, prefix_args: &[&str], args: &[&str]) -> io::Result<ExitStatus> {
    Command::new(binary)
        .args(prefix_args)
        .args(args)
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .status()
}

fn command_error(binary: &str, err: io::Error) -> anyhow::Error {
    anyhow!("failed to execute `{binary}`: {err}")
}

#[cfg(unix)]
fn child_exit_code(status: ExitStatus) -> i32 {
    use std::os::unix::process::ExitStatusExt;

    status
        .code()
        .or_else(|| status.signal().map(|signal| 128 + signal))
        .unwrap_or(1)
}

#[cfg(not(unix))]
fn child_exit_code(status: ExitStatus) -> i32 {
    status.code().unwrap_or(1)
}

#[cfg(test)]
mod tests {
    #[cfg(unix)]
    use std::process::ExitStatus;

    #[cfg(unix)]
    use super::child_exit_code;
    use super::{is_appkit_command, raw_args_after_appkit, should_run_before_bootstrap};

    #[test]
    fn appkit_command_is_detected_before_extension_loading() {
        let tokens = vec!["appkit".to_string(), "deploy".to_string()];

        assert!(is_appkit_command(&tokens));
    }

    #[test]
    fn appkit_command_can_run_before_bootstrap() {
        let raw_args = ["appkit", "deploy", "--timeout", "not-a-number", "--summary"]
            .into_iter()
            .map(String::from)
            .collect::<Vec<_>>();

        assert!(should_run_before_bootstrap(&raw_args));
    }

    #[test]
    fn appkit_command_before_bootstrap_skips_global_flag_values() {
        let raw_args = ["--base-url", "appkit", "appkit", "deploy"]
            .into_iter()
            .map(String::from)
            .collect::<Vec<_>>();

        assert!(should_run_before_bootstrap(&raw_args));
    }

    #[test]
    fn appkit_describe_commands_stays_on_metadata_path() {
        let nested_describe = ["appkit", "deploy", "--describe-commands"]
            .into_iter()
            .map(String::from)
            .collect::<Vec<_>>();
        let root_describe = ["--describe-commands", "appkit"]
            .into_iter()
            .map(String::from)
            .collect::<Vec<_>>();

        assert!(!should_run_before_bootstrap(&nested_describe));
        assert!(!should_run_before_bootstrap(&root_describe));
    }

    #[test]
    fn raw_args_after_appkit_preserves_appkit_owned_flags() {
        let raw_args = [
            "--base-url",
            "https://kgoose.example.test",
            "appkit",
            "deploy",
            "--timeout",
            "30",
            "--version",
        ]
        .into_iter()
        .map(String::from)
        .collect::<Vec<_>>();

        assert_eq!(
            raw_args_after_appkit(&raw_args),
            vec!["deploy", "--timeout", "30", "--version"]
        );
    }

    #[test]
    fn raw_args_after_appkit_ignores_appkit_in_global_flag_values() {
        let raw_args = [
            "--base-url",
            "appkit",
            "--playpen=appkit",
            "appkit",
            "deploy",
        ]
        .into_iter()
        .map(String::from)
        .collect::<Vec<_>>();

        assert_eq!(raw_args_after_appkit(&raw_args), vec!["deploy"]);
    }

    #[cfg(unix)]
    #[test]
    fn child_exit_code_preserves_signal_status() {
        use std::os::unix::process::ExitStatusExt;

        assert_eq!(child_exit_code(ExitStatus::from_raw(2)), 130);
        assert_eq!(child_exit_code(ExitStatus::from_raw(7 << 8)), 7);
    }
}
