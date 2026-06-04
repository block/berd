use std::{collections::HashMap, process::Stdio, time::Duration};
use tokio::{process::Command, sync::OnceCell, time::timeout};

static SHELL_ENV: OnceCell<HashMap<String, String>> = OnceCell::const_new();
const SHELL_ENV_CAPTURE_TIMEOUT: Duration = Duration::from_secs(10);

/// Capture environment variables from the user's login shell.
///
/// When the app is launched from Finder/Dock/Spotlight on macOS, it inherits a
/// minimal launchd environment that is missing variables the goosed sidecar
/// needs (PATH with Homebrew/Hermit paths, LANG, etc.). This function runs
/// `$SHELL -l -c 'env -0'` to obtain the user's full login-shell environment
/// using null-delimited output to correctly handle values containing newlines.
///
/// The blocking shell invocation is offloaded to a blocking thread so it does
/// not stall the async runtime while the login shell initializes.
///
/// Returns an empty map on failure so callers can fall back to the inherited env.
pub async fn capture_shell_env() -> HashMap<String, String> {
    match SHELL_ENV
        .get_or_try_init(|| async {
            let env = capture_shell_env_uncached().await;
            cacheable_shell_env(env)
        })
        .await
    {
        Ok(env) => env.clone(),
        Err(env) => env,
    }
}

async fn capture_shell_env_uncached() -> HashMap<String, String> {
    let shell = match std::env::var("SHELL") {
        Ok(s) if !s.is_empty() => s,
        _ => return HashMap::new(),
    };

    let mut command = Command::new(&shell);
    command
        .args(["-l", "-c", "env -0"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());

    for (key, value) in std::env::vars() {
        if should_remove_shell_env_var(&key, &value) {
            command.env_remove(key);
        }
    }

    capture_shell_env_from_command(&shell, command, SHELL_ENV_CAPTURE_TIMEOUT).await
}

fn cacheable_shell_env(
    env: HashMap<String, String>,
) -> Result<HashMap<String, String>, HashMap<String, String>> {
    if env.is_empty() {
        Err(env)
    } else {
        Ok(env)
    }
}

async fn capture_shell_env_from_command(
    shell: &str,
    mut command: Command,
    timeout_duration: Duration,
) -> HashMap<String, String> {
    command.kill_on_drop(true);

    let output_result = match timeout(timeout_duration, command.output()).await {
        Ok(result) => result,
        Err(_) => {
            log::warn!(
                "Shell env capture ({shell} -l -c 'env -0') timed out after {} seconds",
                timeout_duration.as_secs()
            );
            return HashMap::new();
        }
    };

    let output = match output_result {
        Ok(o) if o.status.success() => o,
        Ok(o) => {
            log::warn!(
                "Shell env capture ({shell} -l -c 'env -0') exited with {}",
                o.status
            );
            return HashMap::new();
        }
        Err(e) => {
            log::warn!("Failed to run {shell} -l -c 'env -0': {e}");
            return HashMap::new();
        }
    };

    let mut env = parse_shell_env_output(&output.stdout);
    sanitize_shell_env(&mut env);

    log::info!("Captured {} env vars from login shell", env.len());
    env
}

fn parse_shell_env_output(stdout: &[u8]) -> HashMap<String, String> {
    let stdout = String::from_utf8_lossy(stdout);
    let mut env = HashMap::new();
    for entry in stdout.split('\0') {
        if entry.is_empty() {
            continue;
        }
        if let Some((key, value)) = entry.split_once('=') {
            // Skip entries with empty keys.
            if key.is_empty() {
                continue;
            }
            env.insert(key.to_string(), value.to_string());
        }
    }
    env
}

pub fn sanitize_shell_env(env: &mut HashMap<String, String>) {
    env.retain(|key, value| !should_remove_shell_env_var(key, value));
}

fn should_remove_shell_env_var(key: &str, value: &str) -> bool {
    let upper_key = key.to_ascii_uppercase();

    if upper_key.starts_with("HERMIT_") {
        return true;
    }

    if matches!(
        upper_key.as_str(),
        "NPM_CONFIG_PREFIX" | "NPM_CONFIG_CACHE" | "COREPACK_HOME"
    ) {
        return true;
    }

    value.contains("/.hermit/") || value.ends_with("/.hermit")
}

#[cfg(test)]
mod tests {
    use super::{cacheable_shell_env, parse_shell_env_output, sanitize_shell_env};
    use std::collections::HashMap;

    #[test]
    fn empty_shell_env_capture_is_not_cacheable() {
        assert!(cacheable_shell_env(HashMap::new()).is_err());
    }

    #[test]
    fn non_empty_shell_env_capture_is_cacheable() {
        let mut env = HashMap::new();
        env.insert("PATH".to_string(), "/shell/bin".to_string());

        assert_eq!(
            cacheable_shell_env(env).unwrap().get("PATH"),
            Some(&"/shell/bin".to_string())
        );
    }

    #[test]
    fn parse_shell_env_output_reads_null_delimited_entries() {
        let env = parse_shell_env_output(b"PATH=/bin\0LANG=en_US.UTF-8\0\0");

        assert_eq!(env.get("PATH"), Some(&"/bin".to_string()));
        assert_eq!(env.get("LANG"), Some(&"en_US.UTF-8".to_string()));
    }

    #[test]
    fn sanitize_shell_env_removes_repo_tool_manager_state() {
        let mut env = HashMap::from([
            ("HOME".to_string(), "/Users/morganm".to_string()),
            (
                "HERMIT_ENV".to_string(),
                "/Users/morganm/Development/repo".to_string(),
            ),
            (
                "NPM_CONFIG_PREFIX".to_string(),
                "/Users/morganm/Development/repo/.hermit/node".to_string(),
            ),
            (
                "COREPACK_HOME".to_string(),
                "/Users/morganm/Development/repo/.hermit/node".to_string(),
            ),
        ]);

        sanitize_shell_env(&mut env);

        assert_eq!(env.get("HOME"), Some(&"/Users/morganm".to_string()));
        assert!(!env.contains_key("HERMIT_ENV"));
        assert!(!env.contains_key("NPM_CONFIG_PREFIX"));
        assert!(!env.contains_key("COREPACK_HOME"));
    }
}
