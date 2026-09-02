//! Drive the remote bootstrap script (`remote_daemon.sh`) over ssh.
//!
//! The script travels over stdin
//! (`bash -s -- <nonce> <mode> [<b64arg>] [<b64goosepath>]`) so no script text,
//! secret, or user path appears in remote argv. Only stdout lines prefixed with
//! the per-invocation nonce are parsed; anything else is shell rc noise and
//! ignored.

use std::collections::HashMap;
use std::process::Stdio;
use std::time::Duration;

use base64::Engine as _;
use serde::Serialize;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

use super::error::{
    classify_script_exit, classify_ssh_stderr, RemoteBackendError, RemoteBackendErrorKind,
    RemoteDaemonInstance,
};
use super::host::RemoteHostSpec;
use super::ssh::{base_ssh_command, push_destination};
use crate::services::log_redaction::redact_log_line;

const BOOTSTRAP_SCRIPT: &str = include_str!("remote_daemon.sh");
// The remote script can wait 120s for another account-level mutation and spend
// roughly 80s on five readiness attempts plus cleanup. Keep the outer timeout
// above their combined bounded lifetime so cancellation cannot strand an
// unrecorded PID.
const SCRIPT_TIMEOUT: Duration = Duration::from_secs(300);
const MAX_STDERR_BYTES: usize = 16 * 1024;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteDaemonInfo {
    pub pid: u32,
    pub port: u16,
    #[serde(skip_serializing)]
    pub secret: String,
    pub goose_version: String,
    pub started_at: String,
    pub reused: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteToolProbe {
    pub binary: String,
    pub found: bool,
    pub version: Option<String>,
    /// Resolved path that answered the probe, so the UI can show which build
    /// replied (an override, or whatever the login PATH resolved to).
    pub path: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteDirEntry {
    pub name: String,
    pub is_dir: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteDirListing {
    pub resolved_path: String,
    pub entries: Vec<RemoteDirEntry>,
}

pub(crate) struct ScriptOutput {
    /// Protocol lines with the nonce prefix stripped.
    pub lines: Vec<String>,
    pub stderr: String,
    pub exit_code: Option<i32>,
}

/// Validate and normalize a user-supplied goose binary override before it is
/// ever encoded into the bootstrap argv. Absolute or `~/`-prefixed only: bare
/// relative paths are ambiguous on the remote side, and newline/NUL bytes are
/// rejected so nothing can smuggle extra protocol or argv content.
pub(crate) fn normalize_goose_path(path: &str) -> Result<String, RemoteBackendError> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err(RemoteBackendError::new(
            RemoteBackendErrorKind::InvalidHost,
            "the goose binary path is empty",
        ));
    }
    if trimmed.contains(['\n', '\r', '\0']) {
        return Err(RemoteBackendError::new(
            RemoteBackendErrorKind::InvalidHost,
            "the goose binary path contains unsupported characters",
        ));
    }
    if trimmed != "~" && !trimmed.starts_with('/') && !trimmed.starts_with("~/") {
        return Err(RemoteBackendError::new(
            RemoteBackendErrorKind::InvalidHost,
            "the goose binary path must be absolute or start with ~/",
        ));
    }
    if trimmed == "~" || trimmed.ends_with('/') {
        return Err(RemoteBackendError::new(
            RemoteBackendErrorKind::InvalidHost,
            "the goose binary path must point at a file, not a directory",
        ));
    }
    Ok(trimmed.to_string())
}

/// Base64 the (already validated) override so it never travels raw in argv.
fn encode_goose_path(goose_path: Option<&str>) -> Option<String> {
    goose_path.map(|path| base64::engine::general_purpose::STANDARD.encode(path))
}

pub(crate) async fn ensure_daemon(
    spec: &RemoteHostSpec,
    shell_env: &HashMap<String, String>,
    extra_serve_args: &[String],
    goose_path: Option<&str>,
) -> Result<RemoteDaemonInfo, RemoteBackendError> {
    let arg = if extra_serve_args.is_empty() {
        None
    } else {
        Some(base64::engine::general_purpose::STANDARD.encode(extra_serve_args.join(" ")))
    };
    let goose_arg = encode_goose_path(goose_path);
    let output = run_remote_script(
        spec,
        shell_env,
        "ensure",
        arg.as_deref(),
        goose_arg.as_deref(),
    )
    .await?;
    require_success(&output)?;
    let ready = output
        .lines
        .iter()
        .find_map(|line| line.strip_prefix("READY "))
        .ok_or_else(|| {
            script_protocol_error("remote bootstrap finished without a READY line", &output)
        })?;
    parse_ready_line(ready)
        .ok_or_else(|| script_protocol_error("remote bootstrap READY line was malformed", &output))
}

pub(crate) async fn shutdown_daemon(
    spec: &RemoteHostSpec,
    shell_env: &HashMap<String, String>,
    expected_instance_token: Option<&str>,
) -> Result<(), RemoteBackendError> {
    let expected_instance_arg = expected_instance_token
        .map(|token| base64::engine::general_purpose::STANDARD.encode(token));
    let output = run_remote_script(
        spec,
        shell_env,
        "shutdown",
        expected_instance_arg.as_deref(),
        None,
    )
    .await?;
    require_success(&output)?;
    if output.lines.iter().any(|line| line == "STOPPED") {
        Ok(())
    } else {
        Err(script_protocol_error(
            "remote shutdown finished without confirmation",
            &output,
        ))
    }
}

pub(crate) async fn check_host(
    spec: &RemoteHostSpec,
    shell_env: &HashMap<String, String>,
    goose_path: Option<&str>,
) -> Result<Vec<RemoteToolProbe>, RemoteBackendError> {
    let goose_arg = encode_goose_path(goose_path);
    let output = run_remote_script(spec, shell_env, "check", None, goose_arg.as_deref()).await?;
    require_success(&output)?;
    let probes = parse_tool_probes(&output.lines);
    if probes.is_empty() {
        return Err(script_protocol_error(
            "remote check produced no tool reports",
            &output,
        ));
    }
    Ok(probes)
}

pub(crate) async fn list_remote_dir(
    spec: &RemoteHostSpec,
    shell_env: &HashMap<String, String>,
    path: &str,
) -> Result<RemoteDirListing, RemoteBackendError> {
    if path.contains(['\n', '\r', '\0']) {
        return Err(RemoteBackendError::new(
            RemoteBackendErrorKind::RemoteScriptFailed,
            "path contains unsupported characters",
        ));
    }
    let arg = base64::engine::general_purpose::STANDARD.encode(path);
    let output = run_remote_script(spec, shell_env, "listdir", Some(&arg), None).await?;
    match output.exit_code {
        Some(44) => {
            return Err(RemoteBackendError::new(
                RemoteBackendErrorKind::RemoteScriptFailed,
                "path must be absolute or start with ~",
            ))
        }
        Some(45) => {
            return Err(RemoteBackendError::new(
                RemoteBackendErrorKind::RemoteScriptFailed,
                format!("no such directory on remote host: {path}"),
            ))
        }
        _ => require_success(&output)?,
    }
    parse_dir_listing(&output.lines)
        .ok_or_else(|| script_protocol_error("remote listing was malformed", &output))
}

/// Assemble the remote command string. Positional args are fixed
/// (`<nonce> <mode> <b64arg> <b64goosepath>`), so a goose override without a
/// mode arg still has to send the `-` placeholder in slot 3.
fn remote_command_line(
    nonce: &str,
    mode: &str,
    arg: Option<&str>,
    goose_arg: Option<&str>,
) -> String {
    let mut line = format!("bash -s -- {nonce} {mode}");
    if arg.is_some() || goose_arg.is_some() {
        line.push(' ');
        line.push_str(arg.unwrap_or("-"));
    }
    if let Some(goose_arg) = goose_arg {
        line.push(' ');
        line.push_str(goose_arg);
    }
    line
}

pub(crate) async fn run_remote_script(
    spec: &RemoteHostSpec,
    shell_env: &HashMap<String, String>,
    mode: &str,
    arg: Option<&str>,
    goose_arg: Option<&str>,
) -> Result<ScriptOutput, RemoteBackendError> {
    let nonce = format!("berd-{}", uuid::Uuid::new_v4());

    let mut command = base_ssh_command(spec, shell_env);
    push_destination(&mut command, spec);
    // The remote command string: constant except the nonce/mode/args, all of
    // which are restricted charsets (uuid, keyword, base64).
    let remote_command = remote_command_line(&nonce, mode, arg, goose_arg);
    command.arg(remote_command);
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let mut child = command.spawn().map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            RemoteBackendError::new(
                RemoteBackendErrorKind::SshNotFound,
                "ssh was not found on this machine",
            )
        } else {
            RemoteBackendError::internal(format!("failed to spawn ssh: {error}"))
        }
    })?;

    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| RemoteBackendError::internal("ssh stdin unavailable"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| RemoteBackendError::internal("ssh stdout unavailable"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| RemoteBackendError::internal("ssh stderr unavailable"))?;

    let run = async {
        stdin
            .write_all(BOOTSTRAP_SCRIPT.as_bytes())
            .await
            .map_err(|error| {
                RemoteBackendError::internal(format!("failed to send bootstrap script: {error}"))
            })?;
        drop(stdin);

        let nonce_prefix = format!("{nonce} ");
        let stdout_task = async {
            let mut lines = Vec::new();
            let mut reader = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                if let Some(protocol) = line.strip_prefix(&nonce_prefix) {
                    lines.push(protocol.to_string());
                } else if !line.trim().is_empty() {
                    log::debug!("[remote-backend noise] {}", redact_log_line(&line));
                }
            }
            lines
        };
        let stderr_task = async {
            let mut collected = String::new();
            let mut reader = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                let redacted = redact_log_line(&line);
                log::warn!("[remote-backend ssh stderr] {redacted}");
                if collected.len() < MAX_STDERR_BYTES {
                    collected.push_str(&redacted);
                    collected.push('\n');
                }
            }
            collected
        };

        let (lines, stderr_text) = tokio::join!(stdout_task, stderr_task);
        let status = child.wait().await.map_err(|error| {
            RemoteBackendError::internal(format!("failed to await ssh: {error}"))
        })?;
        Ok::<ScriptOutput, RemoteBackendError>(ScriptOutput {
            lines,
            stderr: stderr_text,
            exit_code: status.code(),
        })
    };

    match tokio::time::timeout(SCRIPT_TIMEOUT, run).await {
        Ok(result) => result,
        Err(_) => Err(RemoteBackendError::new(
            RemoteBackendErrorKind::ReadyTimeout,
            format!(
                "ssh to {} timed out after {}s",
                spec.destination(),
                SCRIPT_TIMEOUT.as_secs()
            ),
        )),
    }
}

pub(crate) fn require_success(output: &ScriptOutput) -> Result<(), RemoteBackendError> {
    match output.exit_code {
        Some(0) => Ok(()),
        code => {
            let kind = code
                .and_then(classify_script_exit)
                .unwrap_or_else(|| classify_ssh_stderr(&output.stderr));
            let err_word = output
                .lines
                .iter()
                .find_map(|line| line.strip_prefix("ERR "))
                .unwrap_or("");
            let stderr_tail: String = output
                .stderr
                .lines()
                .rev()
                .take(3)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect::<Vec<_>>()
                .join(" | ");
            let message = match kind {
                RemoteBackendErrorKind::GooseNotInstalled => {
                    "goose is not installed on the remote host's PATH for ssh sessions".to_string()
                }
                RemoteBackendErrorKind::RemotePortBindFailed => {
                    "the remote host could not bind a port for goose serve".to_string()
                }
                RemoteBackendErrorKind::DaemonConflict => {
                    "another Berd client is using this remote account with an incompatible Goose launch configuration"
                        .to_string()
                }
                RemoteBackendErrorKind::DaemonChanged => {
                    "the remote daemon changed after confirmation; inspect it and try again"
                        .to_string()
                }
                RemoteBackendErrorKind::AuthFailed => {
                    "ssh authentication failed; make sure key or agent auth works (try `ssh <host>` in a terminal)"
                        .to_string()
                }
                RemoteBackendErrorKind::HostKeyUnverified => {
                    "the host key is not trusted yet; connect once with `ssh <host>` in a terminal"
                        .to_string()
                }
                _ => format!(
                    "remote command failed (exit {:?}{}) {}",
                    code,
                    if err_word.is_empty() {
                        String::new()
                    } else {
                        format!(", {err_word}")
                    },
                    stderr_tail
                ),
            };
            let error = RemoteBackendError::new(kind, message);
            if kind == RemoteBackendErrorKind::DaemonConflict {
                if let Some(instance) = parse_conflict_instance(&output.lines) {
                    return Err(error.with_daemon_instance(instance));
                }
            }
            Err(error)
        }
    }
}

fn parse_conflict_instance(lines: &[String]) -> Option<RemoteDaemonInstance> {
    let rest = lines
        .iter()
        .find_map(|line| line.strip_prefix("CONFLICT "))?;
    let mut fields = rest.split_whitespace();
    let pid = fields.next()?.parse().ok()?;
    let started_at = fields.next()?.to_string();
    let goose_version = decode_b64_field(fields.next()?).unwrap_or_else(|| "unknown".to_string());
    let binary = decode_b64_field(fields.next()?);
    let instance_token = fields.next()?.to_string();
    if fields.next().is_some() {
        return None;
    }
    Some(RemoteDaemonInstance {
        pid,
        started_at,
        goose_version,
        binary,
        instance_token,
    })
}

fn script_protocol_error(context: &str, output: &ScriptOutput) -> RemoteBackendError {
    let stderr_tail: String = output
        .stderr
        .lines()
        .rev()
        .take(3)
        .collect::<Vec<_>>()
        .join(" | ");
    RemoteBackendError::new(
        RemoteBackendErrorKind::RemoteScriptFailed,
        format!("{context}. {stderr_tail}"),
    )
}

fn decode_b64_field(field: &str) -> Option<String> {
    if field == "-" {
        return None;
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(field)
        .ok()?;
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

fn parse_ready_line(rest: &str) -> Option<RemoteDaemonInfo> {
    let mut fields = rest.split_whitespace();
    let pid: u32 = fields.next()?.parse().ok()?;
    let port: u16 = fields.next()?.parse().ok()?;
    let secret = fields.next()?.to_string();
    let reused = match fields.next()? {
        "1" => true,
        "0" => false,
        _ => return None,
    };
    let goose_version = decode_b64_field(fields.next()?).unwrap_or_else(|| "unknown".to_string());
    let started_at = fields.next()?.to_string();
    Some(RemoteDaemonInfo {
        pid,
        port,
        secret,
        goose_version,
        started_at,
        reused,
    })
}

fn parse_tool_probes(lines: &[String]) -> Vec<RemoteToolProbe> {
    lines
        .iter()
        .filter_map(|line| {
            let rest = line.strip_prefix("TOOL ")?;
            let mut fields = rest.split_whitespace();
            let binary = fields.next()?.to_string();
            let found = fields.next()? == "1";
            let version = fields.next().and_then(decode_b64_field);
            // `path` is optional so a daemon script from an older client still
            // parses (pre-override hosts emit only three fields).
            let path = fields.next().and_then(decode_b64_field);
            Some(RemoteToolProbe {
                binary,
                found,
                version,
                path,
            })
        })
        .collect()
}

fn parse_dir_listing(lines: &[String]) -> Option<RemoteDirListing> {
    let resolved_path = lines
        .iter()
        .find_map(|line| line.strip_prefix("DIR "))
        .and_then(decode_b64_field)?;
    let entries = lines
        .iter()
        .filter_map(|line| {
            let rest = line.strip_prefix("E ")?;
            let (kind, name) = rest.split_once(' ')?;
            let name = decode_b64_field(name)?;
            Some(RemoteDirEntry {
                name,
                is_dir: kind == "D",
            })
        })
        .collect();
    Some(RemoteDirListing {
        resolved_path,
        entries,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn output(lines: &[&str], exit_code: Option<i32>, stderr: &str) -> ScriptOutput {
        ScriptOutput {
            lines: lines.iter().map(|s| s.to_string()).collect(),
            stderr: stderr.to_string(),
            exit_code,
        }
    }

    fn b64(value: &str) -> String {
        base64::engine::general_purpose::STANDARD.encode(value)
    }

    #[test]
    fn parses_ready_line() {
        let line = format!(
            "4242 23456 berd-remote-abc123 0 {} 1756300000",
            b64("goose 1.2.3")
        );
        let info = parse_ready_line(&line).unwrap();
        assert_eq!(info.pid, 4242);
        assert_eq!(info.port, 23456);
        assert_eq!(info.secret, "berd-remote-abc123");
        assert!(!info.reused);
        assert_eq!(info.goose_version, "goose 1.2.3");
        assert_eq!(info.started_at, "1756300000");
    }

    #[test]
    fn rejects_malformed_ready_lines() {
        assert!(parse_ready_line("not numbers here at all -").is_none());
        assert!(parse_ready_line("1 2 secret 7 dmVyc2lvbg== 3").is_none());
        assert!(parse_ready_line("").is_none());
    }

    #[test]
    fn parses_tool_probes() {
        let lines = vec![
            format!(
                "TOOL goose 1 {} {}",
                b64("goose 9.9"),
                b64("/opt/goose/bin/goose")
            ),
            "TOOL claude-agent-acp 0 - -".to_string(),
            "CHECK-DONE".to_string(),
        ];
        let probes = parse_tool_probes(&lines);
        assert_eq!(probes.len(), 2);
        assert!(probes[0].found);
        assert_eq!(probes[0].version.as_deref(), Some("goose 9.9"));
        assert_eq!(probes[0].path.as_deref(), Some("/opt/goose/bin/goose"));
        assert!(!probes[1].found);
        assert_eq!(probes[1].version, None);
        assert_eq!(probes[1].path, None);
    }

    /// A host still running a pre-override bootstrap emits only three fields.
    #[test]
    fn parses_tool_probes_without_a_path_field() {
        let lines = vec![format!("TOOL goose 1 {}", b64("goose 9.9"))];
        let probes = parse_tool_probes(&lines);
        assert_eq!(probes.len(), 1);
        assert_eq!(probes[0].version.as_deref(), Some("goose 9.9"));
        assert_eq!(probes[0].path, None);
    }

    #[test]
    fn normalize_goose_path_accepts_absolute_and_tilde_paths() {
        assert_eq!(
            normalize_goose_path("  /opt/goose/bin/goose  ").unwrap(),
            "/opt/goose/bin/goose"
        );
        assert_eq!(
            normalize_goose_path("~/src/goose/target/release/goose").unwrap(),
            "~/src/goose/target/release/goose"
        );
    }

    #[test]
    fn normalize_goose_path_rejects_unusable_paths() {
        for candidate in [
            "",
            "   ",
            "goose",
            "./goose",
            "../goose",
            "~goose",
            "~",
            "/opt/goose/",
            "/opt/goose\nrm -rf /",
            "/opt/goose\rgoose",
            "/opt/goose\0goose",
        ] {
            let error = normalize_goose_path(candidate)
                .expect_err(&format!("expected {candidate:?} to be rejected"));
            assert_eq!(error.kind, RemoteBackendErrorKind::InvalidHost);
        }
    }

    #[test]
    fn remote_command_line_keeps_positional_slots_stable() {
        assert_eq!(
            remote_command_line("N", "shutdown", None, None),
            "bash -s -- N shutdown"
        );
        assert_eq!(
            remote_command_line("N", "listdir", Some("cGF0aA=="), None),
            "bash -s -- N listdir cGF0aA=="
        );
        assert_eq!(
            remote_command_line("N", "ensure", Some("YXJncw=="), Some("Ymlu")),
            "bash -s -- N ensure YXJncw== Ymlu"
        );
        // No mode arg but an override: slot 3 has to carry the placeholder so
        // the binary path still lands in slot 4.
        assert_eq!(
            remote_command_line("N", "check", None, Some("Ymlu")),
            "bash -s -- N check - Ymlu"
        );
    }

    #[test]
    fn goose_path_travels_base64_encoded() {
        let encoded = encode_goose_path(Some("~/src/goose/target/release/goose")).unwrap();
        assert!(!encoded.contains("goose"), "raw path leaked: {encoded}");
        assert!(!encoded.contains('~'), "raw path leaked: {encoded}");
        assert_eq!(
            decode_b64_field(&encoded).as_deref(),
            Some("~/src/goose/target/release/goose")
        );
        assert_eq!(encode_goose_path(None), None);
    }

    #[test]
    fn parses_dir_listing() {
        let lines = vec![
            format!("DIR {}", b64("/home/damien/src")),
            format!("E D {}", b64("berd")),
            format!("E F {}", b64("notes with spaces.md")),
            "LIST-DONE".to_string(),
        ];
        let listing = parse_dir_listing(&lines).unwrap();
        assert_eq!(listing.resolved_path, "/home/damien/src");
        assert_eq!(listing.entries.len(), 2);
        assert!(listing.entries[0].is_dir);
        assert_eq!(listing.entries[1].name, "notes with spaces.md");
    }

    #[test]
    fn require_success_maps_script_exit_codes() {
        let err = require_success(&output(&["ERR goose-not-found"], Some(41), "")).unwrap_err();
        assert_eq!(err.kind, RemoteBackendErrorKind::GooseNotInstalled);

        let err = require_success(&output(&["ERR port-bind-failed"], Some(43), "")).unwrap_err();
        assert_eq!(err.kind, RemoteBackendErrorKind::RemotePortBindFailed);

        let err = require_success(&output(&["ERR daemon-conflict"], Some(47), "")).unwrap_err();
        assert_eq!(err.kind, RemoteBackendErrorKind::DaemonConflict);

        let err = require_success(&output(&["ERR daemon-changed"], Some(48), "")).unwrap_err();
        assert_eq!(err.kind, RemoteBackendErrorKind::DaemonChanged);
    }

    #[test]
    fn daemon_conflict_carries_exact_instance_metadata() {
        let line = format!(
            "CONFLICT 4242 1756700000 {} {} opaque-token",
            b64("goose 2.0"),
            b64("/opt/goose")
        );
        let err =
            require_success(&output(&[&line, "ERR daemon-conflict"], Some(47), "")).unwrap_err();
        let instance = err.daemon_instance.expect("conflict instance");
        assert_eq!(instance.pid, 4242);
        assert_eq!(instance.started_at, "1756700000");
        assert_eq!(instance.goose_version, "goose 2.0");
        assert_eq!(instance.binary.as_deref(), Some("/opt/goose"));
        assert_eq!(instance.instance_token, "opaque-token");
    }

    #[test]
    fn require_success_classifies_ssh_stderr() {
        let err = require_success(&output(
            &[],
            Some(255),
            "user@host: Permission denied (publickey).",
        ))
        .unwrap_err();
        assert_eq!(err.kind, RemoteBackendErrorKind::AuthFailed);
    }

    #[test]
    fn require_success_passes_on_zero() {
        assert!(require_success(&output(&["READY"], Some(0), "")).is_ok());
    }

    #[test]
    fn secret_is_not_serialized() {
        let info = RemoteDaemonInfo {
            pid: 1,
            port: 2,
            secret: "hush".to_string(),
            goose_version: "v".to_string(),
            started_at: "0".to_string(),
            reused: false,
        };
        let json = serde_json::to_string(&info).unwrap();
        assert!(!json.contains("hush"));
    }

    /// Pin the on-the-wire protocol against the actual script under local bash
    /// (failure paths only; starting a real server is out of scope for unit
    /// tests).
    #[cfg(unix)]
    mod script_contract {
        use super::*;
        use std::process::Command as StdCommand;

        fn run_script(
            args: &[&str],
            path_override: Option<&str>,
            home: &std::path::Path,
        ) -> (Vec<String>, Option<i32>) {
            collect_script(spawn_script(args, path_override, home))
        }

        fn spawn_script(
            args: &[&str],
            path_override: Option<&str>,
            home: &std::path::Path,
        ) -> std::process::Child {
            spawn_script_source(args, path_override, home, BOOTSTRAP_SCRIPT)
        }

        fn spawn_script_source(
            args: &[&str],
            path_override: Option<&str>,
            home: &std::path::Path,
            script: &str,
        ) -> std::process::Child {
            let nonce = "berd-test-nonce";
            let mut command = StdCommand::new("bash");
            command
                .arg("-s")
                .arg("--")
                .arg(nonce)
                .args(args)
                .env("HOME", home)
                .env("XDG_STATE_HOME", home.join(".state"))
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped());
            if let Some(path) = path_override {
                command.env("PATH", path);
            }
            let mut child = command.spawn().expect("spawn bash");
            use std::io::Write as _;
            child
                .stdin
                .take()
                .unwrap()
                .write_all(script.as_bytes())
                .unwrap();
            child
        }

        fn collect_script(child: std::process::Child) -> (Vec<String>, Option<i32>) {
            let nonce = "berd-test-nonce";
            let out = child.wait_with_output().expect("script output");
            let prefix = format!("{nonce} ");
            let lines = String::from_utf8_lossy(&out.stdout)
                .lines()
                .filter_map(|line| line.strip_prefix(&prefix).map(str::to_string))
                .collect();
            (lines, out.status.code())
        }

        fn legacy_lock_holder_script(marker: &str, release: &str) -> String {
            format!(
                r#"#!/usr/bin/env bash
set -u
STATE_DIR="${{XDG_STATE_HOME:-$HOME/.local/state}}/berd/remote"
LOCK_DIR="$STATE_DIR/daemon.lock"
LOCK_OWNER="$LOCK_DIR/owner"
b64() {{ printf %s "$1" | base64 | tr -d '\n'; }}
process_identity() {{
  if [ -r "/proc/$$/stat" ]; then
    start="$(sed 's/^.*) //' "/proc/$$/stat" | awk '{{print $20}}')"
    printf 'proc:%s' "$start"
  else
    ps -p "$$" -o lstart= -o command= | sed 's/^/ps:/'
  fi
}}
mkdir -p "$STATE_DIR"
while ! mkdir "$LOCK_DIR" 2>/dev/null; do sleep 0.01; done
owner="$$ $(b64 "$(process_identity)")"
printf '%s\n' "$owner" >"$LOCK_OWNER"
: >"$STATE_DIR/{marker}"
while [ ! -f "$STATE_DIR/{release}" ]; do sleep 0.01; done
if [ "$(cat "$LOCK_OWNER" 2>/dev/null)" = "$owner" ]; then
  rm -f "$LOCK_OWNER"
  rmdir "$LOCK_DIR" 2>/dev/null || true
fi
"#
            )
        }

        fn wait_for_path(path: &std::path::Path, message: &str) {
            for _ in 0..500 {
                if path.exists() {
                    return;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            panic!("{message}");
        }

        fn b64_arg(value: &str) -> String {
            base64::engine::general_purpose::STANDARD.encode(value)
        }

        /// Fake `goose` that reports a version and, for `serve`, actually binds
        /// the requested port so the script's readiness probe succeeds.
        fn write_goose_shim(
            dir: &std::path::Path,
            name: &str,
            version: &str,
        ) -> std::path::PathBuf {
            let path = dir.join(name);
            std::fs::write(
                &path,
                format!(
                    r#"#!/usr/bin/env bash
if [ "$1" = "--version" ]; then echo "{version}"; exit 0; fi
if [ "$1" = "serve" ]; then
  port=""
  while [ $# -gt 0 ]; do [ "$1" = "--port" ] && port="$2"; shift; done
  exec python3 -c 'import socket,sys,time
s=socket.socket(); s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)
s.bind(("127.0.0.1",int(sys.argv[1]))); s.listen(5); time.sleep(120)' "$port"
fi
"#
                ),
            )
            .unwrap();
            use std::os::unix::fs::PermissionsExt as _;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
            path
        }

        fn write_stalling_goose_shim(dir: &std::path::Path) -> std::path::PathBuf {
            let path = dir.join("goose-stalling");
            std::fs::write(
                &path,
                r#"#!/usr/bin/env bash
if [ "$1" = "--version" ]; then echo "goose stalling"; exit 0; fi
if [ "$1" = "serve" ]; then
  echo $$ > "$HOME/uncommitted-goose.pid"
  exec sleep 120
fi
"#,
            )
            .unwrap();
            use std::os::unix::fs::PermissionsExt as _;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
            path
        }

        fn write_noisy_goose_shim(dir: &std::path::Path) -> std::path::PathBuf {
            let path = dir.join("goose-noisy");
            std::fs::write(
                &path,
                r#"#!/usr/bin/env bash
if [ "$1" = "--version" ]; then echo "goose noisy"; exit 0; fi
if [ "$1" = "serve" ]; then
  port=""
  while [ $# -gt 0 ]; do [ "$1" = "--port" ] && port="$2"; shift; done
  exec python3 -c 'import socket,sys,time
for start in range(0, 80000, 1000):
 sys.stderr.write("".join(f"{i:08d} " + "x" * 54 + "\n" for i in range(start, start + 1000)))
sys.stderr.flush()
s=socket.socket(); s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)
s.bind(("127.0.0.1",int(sys.argv[1]))); s.listen(5); time.sleep(120)' "$port"
fi
"#,
            )
            .unwrap();
            use std::os::unix::fs::PermissionsExt as _;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
            path
        }

        fn write_no_newline_goose_shim(dir: &std::path::Path) -> std::path::PathBuf {
            let path = dir.join("goose-no-newline");
            std::fs::write(
                &path,
                r#"#!/usr/bin/env bash
if [ "$1" = "--version" ]; then echo "goose no-newline"; exit 0; fi
if [ "$1" = "serve" ]; then
  port=""
  while [ $# -gt 0 ]; do [ "$1" = "--port" ] && port="$2"; shift; done
  exec python3 -c 'import os,socket,sys,time
s=socket.socket(); s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)
s.bind(("127.0.0.1",int(sys.argv[1]))); s.listen(5)
for _ in range(80):
 sys.stderr.write("z" * 65536); sys.stderr.flush(); time.sleep(0.005)
open(os.path.join(os.environ["HOME"],"no-newline-complete"),"w").close()
time.sleep(120)' "$port"
fi
"#,
            )
            .unwrap();
            use std::os::unix::fs::PermissionsExt as _;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
            path
        }

        fn write_diagnostic_goose_shim(dir: &std::path::Path) -> std::path::PathBuf {
            let path = dir.join("goose-diagnostic");
            std::fs::write(
                &path,
                r#"#!/usr/bin/env bash
if [ "$1" = "--version" ]; then echo "goose diagnostic"; exit 0; fi
if [ "$1" = "serve" ]; then
  port=""
  while [ $# -gt 0 ]; do [ "$1" = "--port" ] && port="$2"; shift; done
  exec python3 -c 'import socket,sys,time
sys.stderr.write("IMPORTANT-STARTUP-DIAGNOSTIC\n"); sys.stderr.flush()
s=socket.socket(); s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)
s.bind(("127.0.0.1",int(sys.argv[1]))); s.listen(5); time.sleep(120)' "$port"
fi
"#,
            )
            .unwrap();
            use std::os::unix::fs::PermissionsExt as _;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
            path
        }

        fn read_record_fields(home: &std::path::Path) -> Vec<String> {
            let record = std::fs::read_to_string(
                home.join(".state")
                    .join("berd")
                    .join("remote")
                    .join("daemon.record"),
            )
            .expect("daemon record");
            record
                .trim()
                .split_whitespace()
                .map(str::to_string)
                .collect()
        }

        /// Safety net so a restarted-away shim never outlives the test run.
        fn kill_recorded_pid(fields: &[String]) {
            let _ = StdCommand::new("kill")
                .arg("-9")
                .arg(&fields[1])
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status();
        }

        fn python3_available() -> bool {
            StdCommand::new("python3")
                .arg("--version")
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
                .map(|status| status.success())
                .unwrap_or(false)
        }

        #[test]
        fn ensure_reports_goose_not_found() {
            let home = tempfile::tempdir().unwrap();
            // PATH with core utilities but no goose.
            let (lines, code) = run_script(&["ensure"], Some("/usr/bin:/bin"), home.path());
            assert_eq!(code, Some(41), "lines: {lines:?}");
            assert!(lines.iter().any(|l| l == "ERR goose-not-found"));
        }

        /// An override that does not resolve must fail with the same typed
        /// error as a missing PATH goose, even when PATH does have one.
        #[test]
        fn ensure_reports_goose_not_found_for_a_missing_override() {
            let home = tempfile::tempdir().unwrap();
            let bin = tempfile::tempdir().unwrap();
            write_goose_shim(bin.path(), "goose", "goose 1.0.0");
            let path = format!("{}:/usr/bin:/bin", bin.path().to_string_lossy());
            let missing = b64_arg(&bin.path().join("goose-patched").to_string_lossy());

            let (lines, code) = run_script(&["ensure", "-", &missing], Some(&path), home.path());

            assert_eq!(code, Some(41), "lines: {lines:?}");
            assert!(lines.iter().any(|l| l == "ERR goose-not-found"));
        }

        /// A directory (or any non-executable) override is not a goose binary.
        #[test]
        fn ensure_rejects_a_non_executable_override() {
            let home = tempfile::tempdir().unwrap();
            let bin = tempfile::tempdir().unwrap();
            std::fs::write(bin.path().join("notes.txt"), "not a binary").unwrap();
            let arg = b64_arg(&bin.path().join("notes.txt").to_string_lossy());

            let (lines, code) =
                run_script(&["ensure", "-", &arg], Some("/usr/bin:/bin"), home.path());

            assert_eq!(code, Some(41), "lines: {lines:?}");
            assert!(lines.iter().any(|l| l == "ERR goose-not-found"));
        }

        #[test]
        fn check_probes_the_override_instead_of_path_goose() {
            let home = tempfile::tempdir().unwrap();
            let bin = tempfile::tempdir().unwrap();
            write_goose_shim(bin.path(), "goose", "goose 1.0.0-stock");
            let patched = write_goose_shim(bin.path(), "goose-patched", "goose 2.0.0-patched");
            let path = format!("{}:/usr/bin:/bin", bin.path().to_string_lossy());
            let arg = b64_arg(&patched.to_string_lossy());

            let (lines, code) = run_script(&["check", "-", &arg], Some(&path), home.path());

            assert_eq!(code, Some(0), "lines: {lines:?}");
            let probes = parse_tool_probes(&lines);
            let goose = probes.iter().find(|p| p.binary == "goose").unwrap();
            assert!(goose.found);
            assert_eq!(goose.version.as_deref(), Some("goose 2.0.0-patched"));
            assert_eq!(
                goose.path.as_deref(),
                Some(patched.to_string_lossy().as_ref())
            );
        }

        #[test]
        fn check_reports_the_resolved_path_goose_when_no_override_is_given() {
            let home = tempfile::tempdir().unwrap();
            let bin = tempfile::tempdir().unwrap();
            let stock = write_goose_shim(bin.path(), "goose", "goose 1.0.0-stock");
            let path = format!("{}:/usr/bin:/bin", bin.path().to_string_lossy());

            let (lines, code) = run_script(&["check"], Some(&path), home.path());

            assert_eq!(code, Some(0), "lines: {lines:?}");
            let goose = parse_tool_probes(&lines)
                .into_iter()
                .find(|p| p.binary == "goose")
                .unwrap();
            assert_eq!(goose.version.as_deref(), Some("goose 1.0.0-stock"));
            assert_eq!(
                goose.path.as_deref(),
                Some(stock.to_string_lossy().as_ref())
            );
        }

        /// A daemon is reused only for the exact launch contract. Other Berd
        /// clients get a conflict instead of evicting each other's daemon.
        #[test]
        fn ensure_reuses_only_an_identical_launch_spec() {
            if !python3_available() {
                eprintln!("skipping: python3 unavailable for the goose serve shim");
                return;
            }
            let home = tempfile::tempdir().unwrap();
            let bin = tempfile::tempdir().unwrap();
            let stock = write_goose_shim(bin.path(), "goose", "goose 1.0.0-stock");
            let patched = write_goose_shim(bin.path(), "goose-patched", "goose 2.0.0-patched");
            let stock_arg = b64_arg(&stock.to_string_lossy());
            let patched_arg = b64_arg(&patched.to_string_lossy());

            let (lines, code) = run_script(&["ensure", "-", &stock_arg], None, home.path());
            assert_eq!(code, Some(0), "lines: {lines:?}");
            let first = parse_ready_line(
                lines
                    .iter()
                    .find_map(|l| l.strip_prefix("READY "))
                    .expect("READY"),
            )
            .unwrap();
            assert!(!first.reused);
            let first_fields = read_record_fields(home.path());
            assert_eq!(first_fields[0], "v4", "record fields: {first_fields:?}");
            assert_eq!(first_fields[6], b64_arg(&stock.to_string_lossy()));
            assert!(!first_fields[7].is_empty());
            assert!(!first_fields[8].is_empty());

            // Same binary: the healthy daemon is handed back untouched.
            let (lines, code) = run_script(&["ensure", "-", &stock_arg], None, home.path());
            assert_eq!(code, Some(0), "lines: {lines:?}");
            let reused = parse_ready_line(
                lines
                    .iter()
                    .find_map(|l| l.strip_prefix("READY "))
                    .expect("READY"),
            )
            .unwrap();
            assert!(reused.reused);
            assert_eq!(reused.pid, first.pid);
            assert_eq!(reused.port, first.port);

            // A different allowed-origin contract cannot silently inherit the
            // first daemon, even when it uses the same Goose binary.
            let windows_origins = b64_arg("--allowed-origins http://tauri.localhost");
            let (lines, code) =
                run_script(&["ensure", &windows_origins, &stock_arg], None, home.path());
            assert_eq!(code, Some(47), "lines: {lines:?}");
            assert!(lines.iter().any(|line| line == "ERR daemon-conflict"));

            // A different binary is also an ownership conflict, not a daemon
            // eviction loop between clients.
            let (lines, code) = run_script(&["ensure", "-", &patched_arg], None, home.path());
            assert_eq!(code, Some(47), "lines: {lines:?}");
            assert!(lines.iter().any(|line| line == "ERR daemon-conflict"));
            assert_eq!(read_record_fields(home.path()), first_fields);

            let (lines, code) = run_script(&["shutdown"], None, home.path());
            assert_eq!(code, Some(0), "lines: {lines:?}");
        }

        #[test]
        fn concurrent_ensure_calls_share_one_recorded_daemon() {
            if !python3_available() {
                eprintln!("skipping: python3 unavailable for the goose serve shim");
                return;
            }
            let home = tempfile::tempdir().unwrap();
            let bin = tempfile::tempdir().unwrap();
            let goose = write_goose_shim(bin.path(), "goose", "goose 1.0.0");
            let goose_arg = b64_arg(&goose.to_string_lossy());

            let first = spawn_script(&["ensure", "-", &goose_arg], None, home.path());
            let second = spawn_script(&["ensure", "-", &goose_arg], None, home.path());
            let (first_lines, first_code) = collect_script(first);
            let (second_lines, second_code) = collect_script(second);

            assert_eq!(first_code, Some(0), "lines: {first_lines:?}");
            assert_eq!(second_code, Some(0), "lines: {second_lines:?}");
            let first_ready = parse_ready_line(
                first_lines
                    .iter()
                    .find_map(|line| line.strip_prefix("READY "))
                    .expect("first READY"),
            )
            .unwrap();
            let second_ready = parse_ready_line(
                second_lines
                    .iter()
                    .find_map(|line| line.strip_prefix("READY "))
                    .expect("second READY"),
            )
            .unwrap();
            assert_eq!(first_ready.pid, second_ready.pid);
            assert_eq!(first_ready.port, second_ready.port);
            assert_ne!(first_ready.reused, second_ready.reused);

            let state_dir = home.path().join(".state").join("berd").join("remote");
            let entries = std::fs::read_dir(&state_dir)
                .unwrap()
                .map(|entry| entry.unwrap().file_name())
                .collect::<Vec<_>>();
            assert!(
                entries
                    .iter()
                    .all(|name| !name.to_string_lossy().starts_with(".daemon.record.")),
                "atomic record temp was left behind: {entries:?}"
            );

            let (_, code) = run_script(&["shutdown"], None, home.path());
            assert_eq!(code, Some(0));
        }

        #[test]
        fn recovers_a_crash_during_lock_owner_publication() {
            let home = tempfile::tempdir().unwrap();
            let lock_dir = home.path().join(".state/berd/remote/daemon.lock");
            std::fs::create_dir_all(&lock_dir).unwrap();
            std::fs::write(lock_dir.join(".owner.99999"), "partial owner").unwrap();

            let (lines, code) = run_script(&["shutdown"], None, home.path());

            assert_eq!(code, Some(0), "lines: {lines:?}");
            assert!(lines.iter().any(|line| line == "STOPPED"));
            assert!(!lock_dir.exists(), "partial lock generation survived");
        }

        #[test]
        fn a_crashed_legacy_reclaimer_does_not_block_future_daemon_operations() {
            let home = tempfile::tempdir().unwrap();
            let state_dir = home.path().join(".state/berd/remote");
            let lock_dir = state_dir.join("daemon.lock");
            std::fs::create_dir_all(&lock_dir).unwrap();
            std::fs::write(lock_dir.join("owner"), "999999 invalid-identity").unwrap();

            let paused_marker = state_dir.join("reclaim-paused");
            let paused_script = BOOTSTRAP_SCRIPT.replace(
                "  if mv \"$LEGACY_LOCK_DIR\" \"$legacy_claim\" 2>/dev/null; then",
                "  : > \"$STATE_DIR/reclaim-paused\"\n  while [ ! -f \"$STATE_DIR/reclaim-continue\" ]; do sleep 0.01; done\n  if mv \"$LEGACY_LOCK_DIR\" \"$legacy_claim\" 2>/dev/null; then",
            );
            assert_ne!(paused_script, BOOTSTRAP_SCRIPT);
            let mut reclaimer =
                spawn_script_source(&["shutdown"], None, home.path(), &paused_script);
            for _ in 0..500 {
                if paused_marker.exists() {
                    break;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            assert!(
                paused_marker.exists(),
                "reclaimer never reached the stale legacy generation"
            );
            assert!(StdCommand::new("kill")
                .arg("-KILL")
                .arg(reclaimer.id().to_string())
                .status()
                .unwrap()
                .success());
            assert_eq!(reclaimer.wait().unwrap().code(), None);

            // Neither the stale legacy lock nor the ownerless reclaim mutex
            // used by the previous implementation participates in the unique
            // ticket protocol.
            std::fs::create_dir(state_dir.join("daemon.lock.reclaim")).unwrap();
            let (lines, code) = run_script(&["shutdown"], None, home.path());
            assert_eq!(code, Some(0), "lines: {lines:?}");
            assert!(lines.iter().any(|line| line == "STOPPED"));
        }

        #[test]
        fn legacy_reclaimer_does_not_claim_a_live_successor_generation() {
            let home = tempfile::tempdir().unwrap();
            let state_dir = home.path().join(".state/berd/remote");
            let lock_dir = state_dir.join("daemon.lock");
            std::fs::create_dir_all(&lock_dir).unwrap();
            std::fs::write(lock_dir.join("owner"), "999999 invalid-identity").unwrap();

            let paused_script = BOOTSTRAP_SCRIPT.replace(
                "        legacy_guard=\"$LEGACY_LOCK_DIR/.berd-reclaim.$NONCE.$$.$compat_attempt\"",
                "        : > \"$STATE_DIR/reclaim-paused\"\n        while [ ! -f \"$STATE_DIR/reclaim-continue\" ]; do sleep 0.01; done\n        legacy_guard=\"$LEGACY_LOCK_DIR/.berd-reclaim.$NONCE.$$.$compat_attempt\"",
            );
            assert_ne!(paused_script, BOOTSTRAP_SCRIPT);
            let reclaimer = spawn_script_source(&["shutdown"], None, home.path(), &paused_script);
            wait_for_path(
                &state_dir.join("reclaim-paused"),
                "reclaimer never paused before generation claim",
            );

            std::fs::remove_file(lock_dir.join("owner")).unwrap();
            std::fs::remove_dir(&lock_dir).unwrap();
            let successor_source = legacy_lock_holder_script("successor-held", "successor-release");
            let successor =
                spawn_script_source(&["shutdown"], None, home.path(), &successor_source);
            wait_for_path(
                &state_dir.join("successor-held"),
                "live successor never acquired legacy lock",
            );

            std::fs::write(state_dir.join("reclaim-continue"), "").unwrap();
            std::thread::sleep(Duration::from_millis(250));
            assert!(
                lock_dir.join("owner").exists(),
                "successor owner was reclaimed"
            );

            std::fs::write(state_dir.join("successor-release"), "").unwrap();
            assert_eq!(successor.wait_with_output().unwrap().status.code(), Some(0));
            let (lines, code) = collect_script(reclaimer);
            assert_eq!(code, Some(0), "lines: {lines:?}");
            assert!(lines.iter().any(|line| line == "STOPPED"));
        }

        #[test]
        fn legacy_holder_blocks_ticket_client_until_release() {
            let home = tempfile::tempdir().unwrap();
            let state_dir = home.path().join(".state/berd/remote");
            let legacy_source = legacy_lock_holder_script("legacy-held", "legacy-release");
            let legacy = spawn_script_source(&["shutdown"], None, home.path(), &legacy_source);
            wait_for_path(
                &state_dir.join("legacy-held"),
                "legacy client never acquired",
            );

            let ticket_source = BOOTSTRAP_SCRIPT.replace(
                "      lock_held=1\n      return 0",
                "      lock_held=1\n      : > \"$STATE_DIR/ticket-held\"\n      while [ ! -f \"$STATE_DIR/ticket-release\" ]; do sleep 0.01; done\n      return 0",
            );
            assert_ne!(ticket_source, BOOTSTRAP_SCRIPT);
            let ticket = spawn_script_source(&["shutdown"], None, home.path(), &ticket_source);
            std::thread::sleep(Duration::from_millis(250));
            assert!(
                !state_dir.join("ticket-held").exists(),
                "ticket client overlapped a live legacy holder"
            );
            std::fs::write(state_dir.join("legacy-release"), "").unwrap();
            assert_eq!(legacy.wait_with_output().unwrap().status.code(), Some(0));
            wait_for_path(
                &state_dir.join("ticket-held"),
                "ticket client never acquired",
            );
            std::fs::write(state_dir.join("ticket-release"), "").unwrap();
            let (lines, code) = collect_script(ticket);
            assert_eq!(code, Some(0), "lines: {lines:?}");
        }

        #[test]
        fn ticket_holder_blocks_legacy_client_until_release() {
            let home = tempfile::tempdir().unwrap();
            let state_dir = home.path().join(".state/berd/remote");
            let ticket_source = BOOTSTRAP_SCRIPT.replace(
                "      lock_held=1\n      return 0",
                "      lock_held=1\n      : > \"$STATE_DIR/ticket-held\"\n      while [ ! -f \"$STATE_DIR/ticket-release\" ]; do sleep 0.01; done\n      return 0",
            );
            assert_ne!(ticket_source, BOOTSTRAP_SCRIPT);
            let ticket = spawn_script_source(&["shutdown"], None, home.path(), &ticket_source);
            wait_for_path(
                &state_dir.join("ticket-held"),
                "ticket client never acquired",
            );

            let legacy_source = legacy_lock_holder_script("legacy-held", "legacy-release");
            let legacy = spawn_script_source(&["shutdown"], None, home.path(), &legacy_source);
            std::thread::sleep(Duration::from_millis(250));
            assert!(
                !state_dir.join("legacy-held").exists(),
                "legacy client overlapped a live ticket holder"
            );

            std::fs::write(state_dir.join("ticket-release"), "").unwrap();
            let (lines, code) = collect_script(ticket);
            assert_eq!(code, Some(0), "lines: {lines:?}");
            wait_for_path(
                &state_dir.join("legacy-held"),
                "legacy client never acquired",
            );
            std::fs::write(state_dir.join("legacy-release"), "").unwrap();
            assert_eq!(legacy.wait_with_output().unwrap().status.code(), Some(0));
        }

        #[test]
        fn synchronized_ticket_holders_serialize_daemon_mutations() {
            let home = tempfile::tempdir().unwrap();
            let state_dir = home.path().join(".state/berd/remote");

            let holders = (0..6)
                .map(|_| spawn_script(&["shutdown"], None, home.path()))
                .collect::<Vec<_>>();
            for child in holders {
                let (lines, code) = collect_script(child);
                assert_eq!(code, Some(0), "lines: {lines:?}");
            }

            let leftovers = std::fs::read_dir(state_dir.join("daemon.locks"))
                .unwrap()
                .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
                .collect::<Vec<_>>();
            assert!(
                leftovers.is_empty(),
                "lock artifacts remained: {leftovers:?}"
            );
        }

        #[test]
        fn terminating_bootstrap_cleans_up_an_uncommitted_daemon() {
            let home = tempfile::tempdir().unwrap();
            let bin = tempfile::tempdir().unwrap();
            let goose = write_stalling_goose_shim(bin.path());
            let goose_arg = b64_arg(&goose.to_string_lossy());
            let bootstrap = spawn_script(&["ensure", "-", &goose_arg], None, home.path());
            let pid_path = home.path().join("uncommitted-goose.pid");

            for _ in 0..100 {
                if pid_path.exists() {
                    break;
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            let daemon_pid = std::fs::read_to_string(&pid_path)
                .expect("stalling goose should publish its pid")
                .trim()
                .to_string();
            assert!(StdCommand::new("kill")
                .arg("-TERM")
                .arg(bootstrap.id().to_string())
                .status()
                .unwrap()
                .success());
            let (_, code) = collect_script(bootstrap);
            assert_eq!(code, Some(143));
            assert!(
                !StdCommand::new("kill")
                    .arg("-0")
                    .arg(&daemon_pid)
                    .status()
                    .unwrap()
                    .success(),
                "uncommitted daemon {daemon_pid} survived bootstrap termination"
            );
            assert!(!home
                .path()
                .join(".state/berd/remote/daemon.record")
                .exists());
        }

        #[test]
        fn daemon_log_retains_a_bounded_tail() {
            if !python3_available() {
                eprintln!("skipping: python3 unavailable for the goose serve shim");
                return;
            }
            let home = tempfile::tempdir().unwrap();
            let bin = tempfile::tempdir().unwrap();
            let goose = write_noisy_goose_shim(bin.path());
            let goose_arg = b64_arg(&goose.to_string_lossy());
            let state_dir = home.path().join(".state/berd/remote");
            let log_path = state_dir.join("goose-serve.log");
            std::fs::create_dir_all(log_path.parent().unwrap()).unwrap();
            std::fs::write(&log_path, b"!").unwrap();

            let instrumented_script = BOOTSTRAP_SCRIPT.replace(
                "      if ! tail -c \"$LOG_RETAIN_BYTES\" \"$writer_log\" >\"$writer_tmp\" 2>/dev/null; then",
                "      printf x >>\"$STATE_DIR/log-rotations\"\n      if ! tail -c \"$LOG_RETAIN_BYTES\" \"$writer_log\" >\"$writer_tmp\" 2>/dev/null; then",
            );
            assert_ne!(instrumented_script, BOOTSTRAP_SCRIPT);
            let (lines, code) = collect_script(spawn_script_source(
                &["ensure", "-", &goose_arg],
                None,
                home.path(),
                &instrumented_script,
            ));
            assert_eq!(code, Some(0), "lines: {lines:?}");
            let mut log_len = 0;
            let mut retained_ids = Vec::new();
            for _ in 0..100 {
                let contents = std::fs::read(&log_path).unwrap_or_default();
                log_len = contents.len() as u64;
                assert!(
                    log_len <= 4 * 1024 * 1024,
                    "log transiently grew to {log_len} bytes"
                );
                retained_ids = contents
                    .split(|byte| *byte == b'\n')
                    .filter(|line| line.len() == 63 && line[8] == b' ')
                    .filter_map(|line| std::str::from_utf8(&line[..8]).ok()?.parse::<u32>().ok())
                    .collect();
                if retained_ids.last() == Some(&79_999) {
                    break;
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            assert!(log_len > 0);
            assert!(log_len <= 4 * 1024 * 1024, "log grew to {log_len} bytes");
            assert!(
                retained_ids.len() > 1,
                "bounded writer did not retain complete sequence records"
            );
            assert_eq!(retained_ids.last(), Some(&79_999));
            let first_gap = retained_ids
                .windows(2)
                .find(|pair| pair[1] != pair[0] + 1)
                .map(|pair| (pair[0], pair[1]));
            assert!(
                first_gap.is_none(),
                "bounded writer dropped a sequence record at {first_gap:?}"
            );
            let rotations = std::fs::read(state_dir.join("log-rotations"))
                .map(|bytes| bytes.len())
                .unwrap_or(0);
            assert!(
                rotations <= 2,
                "5 MiB of output triggered {rotations} full-tail rewrites"
            );

            let (_, code) = run_script(&["shutdown"], None, home.path());
            assert_eq!(code, Some(0));
        }

        #[test]
        fn daemon_log_stays_bounded_while_no_newline_producer_is_open() {
            if !python3_available() {
                eprintln!("skipping: python3 unavailable for the goose serve shim");
                return;
            }
            let home = tempfile::tempdir().unwrap();
            let bin = tempfile::tempdir().unwrap();
            let goose = write_no_newline_goose_shim(bin.path());
            let goose_arg = b64_arg(&goose.to_string_lossy());

            let (lines, code) = run_script(&["ensure", "-", &goose_arg], None, home.path());
            assert_eq!(code, Some(0), "lines: {lines:?}");
            let log_path = home.path().join(".state/berd/remote/goose-serve.log");
            let complete = home.path().join("no-newline-complete");
            for _ in 0..1500 {
                let log_len = std::fs::metadata(&log_path)
                    .map(|metadata| metadata.len())
                    .unwrap_or(0);
                assert!(
                    log_len <= 4 * 1024 * 1024,
                    "no-newline log transiently grew to {log_len} bytes"
                );
                if complete.exists() {
                    break;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            assert!(
                complete.exists(),
                "producer did not finish its no-newline burst"
            );
            assert!(std::fs::metadata(&log_path).unwrap().len() <= 4 * 1024 * 1024);

            let (_, code) = run_script(&["shutdown"], None, home.path());
            assert_eq!(code, Some(0));
        }

        #[test]
        fn daemon_log_publishes_a_short_diagnostic_while_producer_is_alive() {
            if !python3_available() {
                eprintln!("skipping: python3 unavailable for the goose serve shim");
                return;
            }
            let home = tempfile::tempdir().unwrap();
            let bin = tempfile::tempdir().unwrap();
            let goose = write_diagnostic_goose_shim(bin.path());
            let goose_arg = b64_arg(&goose.to_string_lossy());

            let (lines, code) = run_script(&["ensure", "-", &goose_arg], None, home.path());
            assert_eq!(code, Some(0), "lines: {lines:?}");
            let log_path = home.path().join(".state/berd/remote/goose-serve.log");
            let mut visible = false;
            for _ in 0..100 {
                let contents = std::fs::read_to_string(&log_path).unwrap_or_default();
                if contents.contains("IMPORTANT-STARTUP-DIAGNOSTIC") {
                    visible = true;
                    break;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            assert!(
                visible,
                "live producer's startup diagnostic stayed buffered"
            );

            let (_, code) = run_script(&["shutdown"], None, home.path());
            assert_eq!(code, Some(0));
        }

        #[test]
        fn shutdown_refuses_a_changed_daemon_generation() {
            if !python3_available() {
                eprintln!("skipping: python3 unavailable for the goose serve shim");
                return;
            }
            let home = tempfile::tempdir().unwrap();
            let bin = tempfile::tempdir().unwrap();
            let goose = write_goose_shim(bin.path(), "goose", "goose 1.0.0");
            let goose_arg = b64_arg(&goose.to_string_lossy());
            let (_, code) = run_script(&["ensure", "-", &goose_arg], None, home.path());
            assert_eq!(code, Some(0));
            let fields = read_record_fields(home.path());
            let expected_token = b64_arg(&format!("{} {}", fields[1], fields[8]));

            let wrong_token_arg = b64_arg("wrong-token");
            let (lines, code) = run_script(&["shutdown", &wrong_token_arg], None, home.path());
            assert_eq!(code, Some(48), "lines: {lines:?}");
            assert!(lines.iter().any(|line| line == "ERR daemon-changed"));
            assert_eq!(read_record_fields(home.path()), fields);

            let expected_token_arg = b64_arg(&expected_token);
            let (lines, code) = run_script(&["shutdown", &expected_token_arg], None, home.path());
            assert_eq!(code, Some(0), "lines: {lines:?}");
        }

        /// A record written before process identities existed cannot prove PID
        /// ownership, so it is discarded without signaling and a fresh daemon
        /// is started.
        #[test]
        fn ensure_treats_a_legacy_record_as_not_reusable() {
            if !python3_available() {
                eprintln!("skipping: python3 unavailable for the goose serve shim");
                return;
            }
            let home = tempfile::tempdir().unwrap();
            let bin = tempfile::tempdir().unwrap();
            let stock = write_goose_shim(bin.path(), "goose", "goose 1.0.0-stock");
            let stock_arg = b64_arg(&stock.to_string_lossy());

            let (_, code) = run_script(&["ensure", "-", &stock_arg], None, home.path());
            assert_eq!(code, Some(0));
            let fields = read_record_fields(home.path());
            let record_path = home
                .path()
                .join(".state")
                .join("berd")
                .join("remote")
                .join("daemon.record");
            // Rewrite as the pre-override (v1) shape: no marker, no binary.
            std::fs::write(
                &record_path,
                format!(
                    "{} {} {} {} {}\n",
                    fields[1], fields[2], fields[3], fields[4], fields[5]
                ),
            )
            .unwrap();

            let (lines, code) = run_script(&["ensure", "-", &stock_arg], None, home.path());
            assert_eq!(code, Some(0), "lines: {lines:?}");
            let info = parse_ready_line(
                lines
                    .iter()
                    .find_map(|l| l.strip_prefix("READY "))
                    .expect("READY"),
            )
            .unwrap();
            assert!(!info.reused, "legacy record must not be reused");
            assert_ne!(info.pid.to_string(), fields[1]);
            assert!(
                StdCommand::new("kill")
                    .arg("-0")
                    .arg(&fields[1])
                    .status()
                    .unwrap()
                    .success(),
                "an unverifiable legacy PID must not be signaled"
            );

            let (_, code) = run_script(&["shutdown"], None, home.path());
            assert_eq!(code, Some(0));
            kill_recorded_pid(&fields);
        }

        #[test]
        fn shutdown_does_not_signal_a_pid_with_the_wrong_identity() {
            let home = tempfile::tempdir().unwrap();
            let state_dir = home.path().join(".state").join("berd").join("remote");
            std::fs::create_dir_all(&state_dir).unwrap();
            let mut unrelated = StdCommand::new("sleep").arg("120").spawn().unwrap();
            std::fs::write(
                state_dir.join("daemon.record"),
                format!(
                    "v3 {} 54321 secret - 0 - {}\n",
                    unrelated.id(),
                    b64_arg("not-the-recorded-process")
                ),
            )
            .unwrap();

            let (lines, code) = run_script(&["shutdown"], None, home.path());

            assert_eq!(code, Some(0), "lines: {lines:?}");
            assert!(lines.iter().any(|line| line == "STOPPED"));
            assert!(
                unrelated.try_wait().unwrap().is_none(),
                "shutdown must leave a mismatched PID alive"
            );
            unrelated.kill().unwrap();
            unrelated.wait().unwrap();
        }

        #[test]
        fn shutdown_without_record_still_confirms() {
            let home = tempfile::tempdir().unwrap();
            let (lines, code) = run_script(&["shutdown"], None, home.path());
            assert_eq!(code, Some(0), "lines: {lines:?}");
            assert!(lines.iter().any(|l| l == "STOPPED"));
        }

        #[test]
        fn check_reports_tools() {
            let home = tempfile::tempdir().unwrap();
            let (lines, code) = run_script(&["check"], Some("/usr/bin:/bin"), home.path());
            assert_eq!(code, Some(0), "lines: {lines:?}");
            let probes = parse_tool_probes(&lines);
            assert_eq!(probes.len(), 3);
            assert!(probes.iter().all(|p| !p.found));
            assert!(lines.iter().any(|l| l == "CHECK-DONE"));
        }

        #[test]
        fn listdir_lists_real_directories() {
            let home = tempfile::tempdir().unwrap();
            std::fs::create_dir(home.path().join("proj")).unwrap();
            std::fs::write(home.path().join("file with spaces.txt"), "x").unwrap();
            let arg = base64::engine::general_purpose::STANDARD
                .encode(home.path().to_string_lossy().as_bytes());
            let (lines, code) = run_script(&["listdir", &arg], None, home.path());
            assert_eq!(code, Some(0), "lines: {lines:?}");
            let listing = parse_dir_listing(&lines).unwrap();
            assert!(listing.entries.iter().any(|e| e.name == "proj" && e.is_dir));
            assert!(listing
                .entries
                .iter()
                .any(|e| e.name == "file with spaces.txt" && !e.is_dir));
        }

        #[test]
        fn listdir_rejects_relative_paths() {
            let home = tempfile::tempdir().unwrap();
            let arg = base64::engine::general_purpose::STANDARD.encode("relative/path");
            let (lines, code) = run_script(&["listdir", &arg], None, home.path());
            assert_eq!(code, Some(44), "lines: {lines:?}");
        }

        #[test]
        fn listdir_reports_missing_directories() {
            let home = tempfile::tempdir().unwrap();
            let arg = base64::engine::general_purpose::STANDARD.encode("/definitely/not/here");
            let (lines, code) = run_script(&["listdir", &arg], None, home.path());
            assert_eq!(code, Some(45), "lines: {lines:?}");
        }

        #[test]
        fn noise_before_protocol_lines_is_ignored_by_prefix_filter() {
            // Simulates shell rc noise: caller filtering only keeps nonce lines.
            let home = tempfile::tempdir().unwrap();
            let (lines, _) = run_script(&["shutdown"], None, home.path());
            assert!(lines.iter().all(|l| !l.contains("motd")));
        }
    }
}
