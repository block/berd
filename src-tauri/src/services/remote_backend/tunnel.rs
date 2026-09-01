//! SSH local port-forward to a remote goose daemon.
//!
//! The tunnel is a plain `ssh -N -L` and deliberately owns nothing else: the
//! daemon it points at survives the tunnel, the app, and the network. Tunnel
//! readiness is probed over HTTP *through* the forward — a raw TCP connect is
//! meaningless because ssh's local listener accepts immediately and only then
//! dials the remote target.

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};

use super::error::{classify_ssh_stderr, RemoteBackendError, RemoteBackendErrorKind};
use super::host::RemoteHostSpec;
use super::ssh::{base_ssh_command, push_destination};
use crate::services::log_redaction::redact_log_line;

const TUNNEL_READY_TIMEOUT: Duration = Duration::from_secs(15);
const TUNNEL_PROBE_INTERVAL: Duration = Duration::from_millis(150);

pub(crate) struct TunnelProcess {
    pub child: Child,
    /// Rolling tail of redacted stderr, shared with the log-reader task, used
    /// to classify unexpected exits.
    pub stderr_tail: Arc<Mutex<String>>,
}

fn append_to_bounded_tail(tail: &mut String, line: &str, max_bytes: usize) {
    tail.push_str(line);
    tail.push('\n');
    if tail.len() <= max_bytes {
        return;
    }

    let excess = tail.len() - max_bytes;
    let drain_end = tail
        .char_indices()
        .map(|(index, _)| index)
        .find(|index| *index >= excess)
        .unwrap_or(tail.len());
    tail.drain(..drain_end);
}

pub(crate) fn build_tunnel_command(
    spec: &RemoteHostSpec,
    shell_env: &HashMap<String, String>,
    local_port: u16,
    remote_port: u16,
) -> Command {
    let mut command = base_ssh_command(spec, shell_env);
    command.arg("-o").arg("ExitOnForwardFailure=yes");
    command.arg("-N");
    command
        .arg("-L")
        .arg(format!("127.0.0.1:{local_port}:127.0.0.1:{remote_port}"));
    push_destination(&mut command, spec);
    command
}

pub(crate) fn spawn_tunnel(
    spec: &RemoteHostSpec,
    shell_env: &HashMap<String, String>,
    local_port: u16,
    remote_port: u16,
) -> Result<TunnelProcess, RemoteBackendError> {
    let mut command = build_tunnel_command(spec, shell_env, local_port, remote_port);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let mut child = command.spawn().map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            RemoteBackendError::new(
                RemoteBackendErrorKind::SshNotFound,
                "ssh was not found on this machine",
            )
        } else {
            RemoteBackendError::internal(format!("failed to spawn ssh tunnel: {error}"))
        }
    })?;

    let stderr_tail = Arc::new(Mutex::new(String::new()));
    if let Some(stderr) = child.stderr.take() {
        let tail = Arc::clone(&stderr_tail);
        tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let redacted = redact_log_line(&line);
                log::warn!("[remote-backend tunnel stderr] {redacted}");
                if let Ok(mut tail) = tail.lock() {
                    append_to_bounded_tail(&mut tail, &redacted, 8 * 1024);
                }
            }
        });
    }

    Ok(TunnelProcess { child, stderr_tail })
}

/// Probe the forwarded port until the remote goose answers HTTP. Any HTTP
/// response (any status) proves the end-to-end path; connection errors mean
/// not-ready-yet. Fails fast when the tunnel process exits.
pub(crate) async fn wait_for_tunnel_ready(
    local_port: u16,
    tunnel: &mut TunnelProcess,
) -> Result<(), RemoteBackendError> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
        .map_err(|error| RemoteBackendError::internal(format!("http client: {error}")))?;
    let url = format!("http://127.0.0.1:{local_port}/");

    let deadline = tokio::time::Instant::now() + TUNNEL_READY_TIMEOUT;
    loop {
        if let Some(status) = tunnel
            .child
            .try_wait()
            .map_err(|error| RemoteBackendError::internal(format!("tunnel wait: {error}")))?
        {
            let stderr = tunnel
                .stderr_tail
                .lock()
                .map(|tail| tail.clone())
                .unwrap_or_default();
            let kind = match classify_ssh_stderr(&stderr) {
                RemoteBackendErrorKind::Internal => RemoteBackendErrorKind::TunnelClosed,
                kind => kind,
            };
            return Err(RemoteBackendError::new(
                kind,
                format!(
                    "ssh tunnel exited ({status}) before the remote backend answered: {}",
                    stderr.lines().last().unwrap_or_default()
                ),
            ));
        }

        if client.get(&url).send().await.is_ok() {
            return Ok(());
        }

        if tokio::time::Instant::now() >= deadline {
            return Err(RemoteBackendError::new(
                RemoteBackendErrorKind::ReadyTimeout,
                "the remote backend did not answer through the tunnel in time",
            ));
        }
        tokio::time::sleep(TUNNEL_PROBE_INTERVAL).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::remote_backend::ssh::argv_of;

    #[test]
    fn tunnel_argv_binds_loopback_forward_and_no_command() {
        let spec = RemoteHostSpec::parse("damien@devbox:2222", &[]).unwrap();
        let command = build_tunnel_command(&spec, &HashMap::new(), 5123, 23456);
        let argv = argv_of(&command);
        let joined = argv.join(" ");
        assert!(
            joined.contains("-o ExitOnForwardFailure=yes"),
            "argv: {joined}"
        );
        assert!(joined.contains("-N"), "argv: {joined}");
        let l_index = argv.iter().position(|arg| arg == "-L").unwrap();
        assert_eq!(argv[l_index + 1], "127.0.0.1:5123:127.0.0.1:23456");
        // Destination is last, after `--`, with no trailing remote command.
        assert_eq!(argv.last().unwrap(), "damien@devbox");
        assert_eq!(argv[argv.len() - 2], "--");
    }

    #[test]
    fn stderr_tail_truncation_respects_utf8_boundaries() {
        let mut tail = String::new();
        append_to_bounded_tail(&mut tail, &format!("é{}", "a".repeat(8_190)), 8 * 1024);

        assert!(tail.len() <= 8 * 1024);
        assert_eq!(tail, format!("{}\n", "a".repeat(8_190)));
    }
}
