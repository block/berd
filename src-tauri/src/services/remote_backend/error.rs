//! Typed errors for the remote SSH backend, shaped for actionable rendering.
//!
//! The renderer switches copy on `kind`; `message` carries the redacted
//! diagnostic detail. Classification is heuristic (OpenSSH reports most
//! failures as exit 255 plus a stderr line), so unknown shapes fall back to
//! broader kinds rather than guessing.

use serde::Serialize;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteDaemonInstance {
    pub pid: u32,
    pub started_at: String,
    pub goose_version: String,
    pub binary: Option<String>,
    /// Opaque generation token required for a conflict takeover. It prevents
    /// a delayed confirmation from stopping a replacement daemon.
    pub instance_token: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum RemoteBackendErrorKind {
    InvalidHost,
    SshNotFound,
    AuthFailed,
    HostKeyUnverified,
    HostUnreachable,
    GooseNotInstalled,
    DaemonConflict,
    DaemonChanged,
    RemotePortBindFailed,
    LocalPortBindFailed,
    TunnelClosed,
    ReadyTimeout,
    RemoteScriptFailed,
    Internal,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteBackendError {
    pub kind: RemoteBackendErrorKind,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub daemon_instance: Option<Box<RemoteDaemonInstance>>,
}

impl RemoteBackendError {
    pub fn new(kind: RemoteBackendErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
            daemon_instance: None,
        }
    }

    pub fn with_daemon_instance(mut self, daemon_instance: RemoteDaemonInstance) -> Self {
        self.daemon_instance = Some(Box::new(daemon_instance));
        self
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(RemoteBackendErrorKind::Internal, message)
    }
}

impl std::fmt::Display for RemoteBackendError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}: {}", self.kind, self.message)
    }
}

impl std::error::Error for RemoteBackendError {}

/// Map an ssh stderr transcript to the most specific error kind we can defend.
/// Order matters: the first matching classification wins, and later entries are
/// deliberately broader.
pub(crate) fn classify_ssh_stderr(stderr: &str) -> RemoteBackendErrorKind {
    const CLASSIFICATIONS: &[(&str, RemoteBackendErrorKind)] = &[
        ("Permission denied", RemoteBackendErrorKind::AuthFailed),
        (
            "Too many authentication failures",
            RemoteBackendErrorKind::AuthFailed,
        ),
        (
            "Host key verification failed",
            RemoteBackendErrorKind::HostKeyUnverified,
        ),
        (
            "REMOTE HOST IDENTIFICATION HAS CHANGED",
            RemoteBackendErrorKind::HostKeyUnverified,
        ),
        (
            "Could not resolve hostname",
            RemoteBackendErrorKind::HostUnreachable,
        ),
        (
            "Connection timed out",
            RemoteBackendErrorKind::HostUnreachable,
        ),
        (
            "Operation timed out",
            RemoteBackendErrorKind::HostUnreachable,
        ),
        (
            "Connection refused",
            RemoteBackendErrorKind::HostUnreachable,
        ),
        ("No route to host", RemoteBackendErrorKind::HostUnreachable),
        (
            "Network is unreachable",
            RemoteBackendErrorKind::HostUnreachable,
        ),
        (
            "Address already in use",
            RemoteBackendErrorKind::LocalPortBindFailed,
        ),
        (
            "cannot listen to port",
            RemoteBackendErrorKind::LocalPortBindFailed,
        ),
    ];

    for (needle, kind) in CLASSIFICATIONS {
        if stderr.contains(needle) {
            return *kind;
        }
    }
    RemoteBackendErrorKind::Internal
}

/// Exit codes the bootstrap script uses to report typed failures.
pub(crate) const EXIT_GOOSE_NOT_FOUND: i32 = 41;
pub(crate) const EXIT_REMOTE_PORT_BIND_FAILED: i32 = 43;
pub(crate) const EXIT_DAEMON_CONFLICT: i32 = 47;
pub(crate) const EXIT_DAEMON_CHANGED: i32 = 48;

pub(crate) fn classify_script_exit(code: i32) -> Option<RemoteBackendErrorKind> {
    match code {
        EXIT_GOOSE_NOT_FOUND => Some(RemoteBackendErrorKind::GooseNotInstalled),
        EXIT_REMOTE_PORT_BIND_FAILED => Some(RemoteBackendErrorKind::RemotePortBindFailed),
        EXIT_DAEMON_CONFLICT => Some(RemoteBackendErrorKind::DaemonConflict),
        EXIT_DAEMON_CHANGED => Some(RemoteBackendErrorKind::DaemonChanged),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_auth_failures() {
        assert_eq!(
            classify_ssh_stderr("user@host: Permission denied (publickey)."),
            RemoteBackendErrorKind::AuthFailed
        );
    }

    #[test]
    fn classifies_host_key_failures() {
        assert_eq!(
            classify_ssh_stderr("Host key verification failed."),
            RemoteBackendErrorKind::HostKeyUnverified
        );
    }

    #[test]
    fn classifies_unreachable_hosts() {
        for line in [
            "ssh: Could not resolve hostname nope: nodename nor servname provided",
            "ssh: connect to host 10.0.0.9 port 22: Connection timed out",
            "ssh: connect to host devbox port 22: Connection refused",
            "ssh: connect to host devbox port 22: No route to host",
        ] {
            assert_eq!(
                classify_ssh_stderr(line),
                RemoteBackendErrorKind::HostUnreachable,
                "line: {line}"
            );
        }
    }

    #[test]
    fn classifies_local_forward_bind_failures() {
        assert_eq!(
            classify_ssh_stderr("bind [127.0.0.1]:5123: Address already in use"),
            RemoteBackendErrorKind::LocalPortBindFailed
        );
    }

    #[test]
    fn unknown_stderr_falls_back_to_internal() {
        assert_eq!(
            classify_ssh_stderr("something new and exciting"),
            RemoteBackendErrorKind::Internal
        );
    }

    #[test]
    fn classifies_script_exit_codes() {
        assert_eq!(
            classify_script_exit(EXIT_GOOSE_NOT_FOUND),
            Some(RemoteBackendErrorKind::GooseNotInstalled)
        );
        assert_eq!(
            classify_script_exit(EXIT_REMOTE_PORT_BIND_FAILED),
            Some(RemoteBackendErrorKind::RemotePortBindFailed)
        );
        assert_eq!(
            classify_script_exit(EXIT_DAEMON_CONFLICT),
            Some(RemoteBackendErrorKind::DaemonConflict)
        );
        assert_eq!(
            classify_script_exit(EXIT_DAEMON_CHANGED),
            Some(RemoteBackendErrorKind::DaemonChanged)
        );
        assert_eq!(classify_script_exit(1), None);
    }
}
