use std::collections::HashMap;
use tokio::sync::OnceCell;

static SHELL_ENV: OnceCell<HashMap<String, String>> = OnceCell::const_new();

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
            let env = tokio::task::spawn_blocking(capture_shell_env_blocking)
                .await
                .unwrap_or_default();
            cacheable_shell_env(env)
        })
        .await
    {
        Ok(env) => env.clone(),
        Err(env) => env,
    }
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

fn capture_shell_env_blocking() -> HashMap<String, String> {
    let shell = match std::env::var("SHELL") {
        Ok(s) if !s.is_empty() => s,
        _ => return HashMap::new(),
    };

    let output = std::process::Command::new(&shell)
        .args(["-l", "-c", "env -0"])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .output();

    let output = match output {
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

    let stdout = String::from_utf8_lossy(&output.stdout);
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

    log::info!("Captured {} env vars from login shell", env.len());
    env
}

#[cfg(test)]
mod tests {
    use super::cacheable_shell_env;
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
}
