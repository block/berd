//! Shared ssh command construction.
//!
//! Uses the system `ssh` so the user's `~/.ssh/config` (keys, agent,
//! ProxyJump, jump hosts) applies unchanged. `BatchMode=yes` makes auth
//! failures fail fast with parseable stderr instead of hanging on an
//! interactive prompt a GUI app cannot answer; v1 therefore supports
//! key/agent auth only.

use std::collections::HashMap;

use tokio::process::Command;

use super::host::RemoteHostSpec;
use crate::services::process::apply_no_window_async;

pub(crate) const CONNECT_TIMEOUT_SECS: u32 = 15;

/// Options shared by every ssh invocation (exec and tunnel).
fn common_options() -> Vec<String> {
    [
        "BatchMode=yes".to_string(),
        format!("ConnectTimeout={CONNECT_TIMEOUT_SECS}"),
        "ServerAliveInterval=15".to_string(),
        "ServerAliveCountMax=3".to_string(),
    ]
    .into_iter()
    .collect()
}

/// Build `ssh <common opts> -T -x -a [-p port]` with the interactive-shell env
/// applied. The destination is appended by the caller after any
/// invocation-specific flags, always as `--` + separate argv element.
pub(crate) fn base_ssh_command(
    spec: &RemoteHostSpec,
    shell_env: &HashMap<String, String>,
) -> Command {
    let mut command = Command::new("ssh");
    // Finder/Dock launches inherit a minimal launchd env; ssh needs the
    // user's PATH and SSH_AUTH_SOCK for agent auth (same rationale as the
    // goose serve spawn in services/acp/goose_serve.rs).
    command.env_clear();
    command.envs(shell_env);
    for option in common_options() {
        command.arg("-o").arg(option);
    }
    // No PTY (a PTY would echo stdin and mangle the line protocol), no X11
    // forwarding, no agent forwarding.
    command.arg("-T").arg("-x").arg("-a");
    if let Some(port) = spec.port() {
        command.arg("-p").arg(port.to_string());
    }
    apply_no_window_async(&mut command);
    command
}

pub(crate) fn push_destination(command: &mut Command, spec: &RemoteHostSpec) {
    command.arg("--").arg(spec.destination());
}

#[cfg(test)]
pub(crate) fn argv_of(command: &Command) -> Vec<String> {
    command
        .as_std()
        .get_args()
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(input: &str) -> RemoteHostSpec {
        RemoteHostSpec::parse(input, &[]).unwrap()
    }

    #[test]
    fn base_command_pins_batch_mode_and_timeouts() {
        let command = base_ssh_command(&spec("devbox.example.com"), &HashMap::new());
        let argv = argv_of(&command);
        let joined = argv.join(" ");
        assert!(joined.contains("-o BatchMode=yes"), "argv: {joined}");
        assert!(joined.contains("-o ConnectTimeout=15"), "argv: {joined}");
        assert!(
            joined.contains("-o ServerAliveInterval=15"),
            "argv: {joined}"
        );
        assert!(
            joined.contains("-o ServerAliveCountMax=3"),
            "argv: {joined}"
        );
        assert!(joined.contains("-T"), "argv: {joined}");
        assert!(joined.contains("-x"), "argv: {joined}");
        assert!(joined.contains("-a"), "argv: {joined}");
    }

    #[test]
    fn port_travels_via_dash_p_and_destination_after_separator() {
        let spec = spec("damien@devbox:2222");
        let mut command = base_ssh_command(&spec, &HashMap::new());
        push_destination(&mut command, &spec);
        let argv = argv_of(&command);
        let p_index = argv.iter().position(|arg| arg == "-p").unwrap();
        assert_eq!(argv[p_index + 1], "2222");
        let sep_index = argv.iter().position(|arg| arg == "--").unwrap();
        assert_eq!(argv[sep_index + 1], "damien@devbox");
        assert_eq!(sep_index + 2, argv.len());
    }
}
