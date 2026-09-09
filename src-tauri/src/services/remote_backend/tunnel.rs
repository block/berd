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

use tokio::process::{Child, Command};
use tokio::task::JoinHandle;

use super::bounded_output::{read_bounded_lines, BoundedLineError, LineLimits};

use super::error::{classify_ssh_stderr, RemoteBackendError, RemoteBackendErrorKind};
use super::host::RemoteHostSpec;
use super::ssh::{base_ssh_command, push_destination};
use crate::services::log_redaction::redact_log_line;

const TUNNEL_READY_TIMEOUT: Duration = Duration::from_secs(15);
const TUNNEL_PROBE_INTERVAL: Duration = Duration::from_millis(150);
const TUNNEL_MAX_LINE_BYTES: usize = 16 * 1024;
const TUNNEL_MAX_STDERR_BYTES: usize = 1024 * 1024;
const TUNNEL_STDERR_TAIL_BYTES: usize = 8 * 1024;
const TUNNEL_MAX_LOG_LINES: usize = 8;

type StderrTask = JoinHandle<Result<(), BoundedLineError>>;

pub(crate) struct TunnelParts {
    pub child: Child,
    stderr_task: Option<StderrTask>,
}

impl TunnelParts {
    /// Wait for an established tunnel to exit. The child owner—not the stderr
    /// reader—terminates and reaps on reader failure, and the reader task is
    /// always disposed before lifecycle/reconnect state may advance.
    pub(crate) async fn wait_for_exit(&mut self) -> String {
        let Some(mut stderr_task) = self.stderr_task.take() else {
            return self
                .child
                .wait()
                .await
                .map(|status| status.to_string())
                .unwrap_or_else(|error| error.to_string());
        };

        tokio::select! {
            biased;
            reader_result = &mut stderr_task => {
                match reader_result {
                    Ok(Err(error)) => {
                        let _ = self.child.start_kill();
                        let _ = self.child.wait().await;
                        format!("ssh tunnel output rejected: {error}")
                    }
                    Ok(Ok(())) => self
                        .child
                        .wait()
                        .await
                        .map(|status| status.to_string())
                        .unwrap_or_else(|error| error.to_string()),
                    Err(error) => {
                        let _ = self.child.start_kill();
                        let _ = self.child.wait().await;
                        format!("ssh tunnel stderr reader failed: {error}")
                    }
                }
            }
            status = self.child.wait() => {
                stderr_task.abort();
                let _ = stderr_task.await;
                status.map(|status| status.to_string()).unwrap_or_else(|error| error.to_string())
            }
        }
    }
}

pub(crate) struct TunnelProcess {
    pub child: Child,
    /// Rolling tail of redacted stderr, shared with the log-reader task, used
    /// to classify unexpected exits.
    pub stderr_tail: Arc<Mutex<String>>,
    /// The reader reports output-limit violations to the child owner. It never
    /// receives a PID or process-termination authority.
    stderr_task: Option<StderrTask>,
}

impl TunnelProcess {
    async fn take_finished_stderr_result(
        &mut self,
    ) -> Option<Result<Result<(), BoundedLineError>, tokio::task::JoinError>> {
        if !self
            .stderr_task
            .as_ref()
            .is_some_and(JoinHandle::is_finished)
        {
            return None;
        }
        Some(self.stderr_task.take().expect("finished stderr task").await)
    }

    pub(crate) async fn terminate_and_reap(&mut self) {
        let _ = self.child.start_kill();
        let _ = self.child.wait().await;
        if let Some(task) = self.stderr_task.take() {
            task.abort();
            let _ = task.await;
        }
    }

    pub(crate) fn into_parts(mut self) -> TunnelParts {
        TunnelParts {
            child: self.child,
            stderr_task: self.stderr_task.take(),
        }
    }
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

fn spawn_stderr_reader(
    stderr: impl tokio::io::AsyncRead + Unpin + Send + 'static,
    tail: Arc<Mutex<String>>,
) -> StderrTask {
    tokio::spawn(async move {
        let mut logged_lines = 0_usize;
        let result = read_bounded_lines(
            stderr,
            LineLimits {
                max_line_bytes: TUNNEL_MAX_LINE_BYTES,
                max_stream_bytes: TUNNEL_MAX_STDERR_BYTES,
            },
            |line| {
                let redacted = redact_log_line(&String::from_utf8_lossy(line));
                if logged_lines < TUNNEL_MAX_LOG_LINES {
                    log::warn!("[remote-backend tunnel stderr] {redacted}");
                }
                logged_lines = logged_lines.saturating_add(1);
                if let Ok(mut tail) = tail.lock() {
                    append_to_bounded_tail(&mut tail, &redacted, TUNNEL_STDERR_TAIL_BYTES);
                }
                Ok::<_, BoundedLineError>(())
            },
        )
        .await;
        if logged_lines > TUNNEL_MAX_LOG_LINES {
            log::warn!(
                "[remote-backend tunnel stderr] suppressed {} additional lines",
                logged_lines - TUNNEL_MAX_LOG_LINES
            );
        }
        result
    })
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
    let stderr_task = child
        .stderr
        .take()
        .map(|stderr| spawn_stderr_reader(stderr, Arc::clone(&stderr_tail)));

    Ok(TunnelProcess {
        child,
        stderr_tail,
        stderr_task,
    })
}

/// Probe the forwarded port until the remote goose answers HTTP. Any HTTP
/// response (any status) proves the end-to-end path; connection errors mean
/// not-ready-yet. Fails fast when the tunnel process exits.
pub(crate) async fn wait_for_tunnel_ready(
    local_port: u16,
    tunnel: &mut TunnelProcess,
) -> Result<(), RemoteBackendError> {
    wait_for_tunnel_ready_with_timeout(local_port, tunnel, TUNNEL_READY_TIMEOUT).await
}

async fn wait_for_tunnel_ready_with_timeout(
    local_port: u16,
    tunnel: &mut TunnelProcess,
    ready_timeout: Duration,
) -> Result<(), RemoteBackendError> {
    let result = wait_for_tunnel_ready_inner(local_port, tunnel, ready_timeout).await;
    if result.is_err() {
        tunnel.terminate_and_reap().await;
    }
    result
}

async fn wait_for_tunnel_ready_inner(
    local_port: u16,
    tunnel: &mut TunnelProcess,
    ready_timeout: Duration,
) -> Result<(), RemoteBackendError> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
        .map_err(|error| RemoteBackendError::internal(format!("http client: {error}")))?;
    let url = format!("http://127.0.0.1:{local_port}/");

    let deadline = tokio::time::Instant::now() + ready_timeout;
    loop {
        if let Some(reader_result) = tunnel.take_finished_stderr_result().await {
            match reader_result {
                Ok(Err(error)) => {
                    return Err(RemoteBackendError::new(
                        RemoteBackendErrorKind::TunnelClosed,
                        format!("ssh tunnel output rejected: {error}"),
                    ));
                }
                Err(error) => {
                    return Err(RemoteBackendError::internal(format!(
                        "ssh tunnel stderr reader failed: {error}"
                    )));
                }
                Ok(Ok(())) => {}
            }
        }

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
    use crate::services::remote_backend::bounded_output::LineLimitKind;
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

    #[cfg(unix)]
    fn local_tunnel_process(script: &str) -> TunnelProcess {
        let mut command = Command::new("sh");
        command
            .arg("-c")
            .arg(script)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let mut child = command.spawn().unwrap();
        let stderr_tail = Arc::new(Mutex::new(String::new()));
        let stderr_task = child
            .stderr
            .take()
            .map(|stderr| spawn_stderr_reader(stderr, Arc::clone(&stderr_tail)));
        TunnelProcess {
            child,
            stderr_tail,
            stderr_task,
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn readiness_timeout_kills_reaps_and_joins_reader() {
        let mut tunnel = local_tunnel_process("sleep 120");
        let result =
            wait_for_tunnel_ready_with_timeout(9, &mut tunnel, Duration::from_millis(25)).await;
        assert!(matches!(
            result,
            Err(RemoteBackendError {
                kind: RemoteBackendErrorKind::ReadyTimeout,
                ..
            })
        ));

        assert!(
            tunnel.child.id().is_none(),
            "timed-out child was not reaped"
        );
        assert!(tunnel.stderr_task.is_none(), "stderr reader was not joined");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn stderr_overflow_is_reported_to_owner_for_kill_and_reap() {
        let mut tunnel = local_tunnel_process("yes overflow >&2");
        let result = wait_for_tunnel_ready(9, &mut tunnel).await;
        let error = result.unwrap_err();
        assert_eq!(error.kind, RemoteBackendErrorKind::TunnelClosed);
        assert!(error.message.contains("ssh tunnel output rejected"));
        assert!(
            tunnel.child.id().is_none(),
            "overflowing child was not reaped"
        );
        assert!(tunnel.stderr_task.is_none(), "stderr reader was not joined");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn completed_stderr_rejection_wins_over_simultaneous_child_exit() {
        let mut command = tokio::process::Command::new("sh");
        command.arg("-c").arg("exit 0").kill_on_drop(true);
        let child = command.spawn().unwrap();
        let stderr_task =
            tokio::spawn(async { Err(BoundedLineError::Limit(LineLimitKind::StreamBytes)) });
        tokio::task::yield_now().await;
        let mut tunnel = TunnelParts {
            child,
            stderr_task: Some(stderr_task),
        };

        let detail = tunnel.wait_for_exit().await;

        assert_eq!(
            detail,
            "ssh tunnel output rejected: stream byte limit exceeded"
        );
        assert!(tunnel.child.id().is_none(), "exited child was not reaped");
        assert!(tunnel.stderr_task.is_none(), "stderr reader was not joined");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn established_stderr_overflow_is_owned_killed_reaped_and_joined() {
        let tunnel = local_tunnel_process("yes overflow >&2");
        let mut tunnel = tunnel.into_parts();

        let detail = tunnel.wait_for_exit().await;

        assert!(detail.contains("ssh tunnel output rejected"));
        assert!(
            detail.contains("stream byte limit exceeded"),
            "unexpected detail: {detail}"
        );
        assert!(
            tunnel.child.id().is_none(),
            "overflowing established child was not reaped"
        );
        assert!(
            tunnel.stderr_task.is_none(),
            "established stderr reader was not joined"
        );
    }
}
