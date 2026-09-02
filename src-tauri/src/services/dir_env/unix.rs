use std::{
    collections::HashMap,
    io,
    path::{Path, PathBuf},
    process::Stdio,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{io::AsyncWriteExt, process::Command, time::timeout};

pub(crate) fn resolve_control_executable(name: &str) -> Option<PathBuf> {
    Some(PathBuf::from(name))
}

pub(super) async fn capture_dir_env_uncached(
    dir: &Path,
    timeout_duration: Duration,
) -> HashMap<String, String> {
    let shell = resolve_shell();

    match capture_dir_env_with_shell(dir, &shell, &std::env::temp_dir(), timeout_duration).await {
        Ok(env) => env,
        Err(error) => {
            log::warn!("Failed to capture dir env for {}: {error}", dir.display());
            HashMap::new()
        }
    }
}

fn resolve_shell() -> PathBuf {
    std::env::var_os("SHELL")
        .filter(|shell| !shell.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/bin/bash"))
}

fn dump_path(temp_root: &Path) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    temp_root.join(format!("goose-dir-env-{}-{nanos}", std::process::id()))
}

fn single_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn dump_script(dump_path: &Path) -> String {
    format!(
        "env -0 > {} 2>/dev/null\nexit\n",
        single_quote(&dump_path.to_string_lossy())
    )
}

pub(crate) async fn capture_dir_env_with_shell(
    dir: &Path,
    shell: &Path,
    temp_root: &Path,
    timeout_duration: Duration,
) -> io::Result<HashMap<String, String>> {
    let dump_path = dump_path(temp_root);
    let script = dump_script(&dump_path);

    let mut command = Command::new(shell);
    command
        .current_dir(dir)
        .env_clear()
        .env("HOME", std::env::var("HOME").unwrap_or_default())
        .env("USER", std::env::var("USER").unwrap_or_default())
        .env("SHELL", shell)
        .arg("-i")
        .arg("-l")
        .arg("-s")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);

    #[cfg(unix)]
    unsafe {
        // SAFETY: `setsid()` is async-signal-safe.
        command.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }

    let mut child = command.spawn()?;
    if let Err(error) = async {
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| io::Error::other("Failed to open shell stdin for dir env capture"))?;
        stdin.write_all(script.as_bytes()).await?;
        stdin.flush().await
    }
    .await
    {
        let _ = child.kill().await;
        let _ = tokio::fs::remove_file(&dump_path).await;
        return Err(error);
    }

    let status = match timeout(timeout_duration, child.wait()).await {
        Ok(Ok(status)) => status,
        Ok(Err(error)) => {
            let _ = tokio::fs::remove_file(&dump_path).await;
            return Err(error);
        }
        Err(_) => {
            let _ = child.kill().await;
            let _ = tokio::fs::remove_file(&dump_path).await;
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                format!("Dir env capture timed out after {:?}", timeout_duration),
            ));
        }
    };
    if !status.success() {
        let _ = tokio::fs::remove_file(&dump_path).await;
        return Err(io::Error::other(format!(
            "Dir env capture exited with {status}"
        )));
    }

    let bytes = match tokio::fs::read(&dump_path).await {
        Ok(bytes) => bytes,
        Err(error) => {
            let _ = tokio::fs::remove_file(&dump_path).await;
            return Err(error);
        }
    };
    let _ = tokio::fs::remove_file(&dump_path).await;

    Ok(parse_env_output(&bytes))
}

pub(crate) fn parse_env_output(stdout: &[u8]) -> HashMap<String, String> {
    let mut env = HashMap::new();
    for entry in stdout.split(|byte| *byte == 0) {
        if entry.is_empty() {
            continue;
        }
        let Ok(entry) = std::str::from_utf8(entry) else {
            continue;
        };
        if let Some((key, value)) = entry.split_once('=') {
            if !key.is_empty() {
                env.insert(key.to_string(), value.to_string());
            }
        }
    }
    env
}

pub(super) async fn capture_terminal_env(
    _dir: &Path,
    timeout_duration: Duration,
) -> HashMap<String, String> {
    super::capture_home_interactive_env_with_timeout(timeout_duration).await
}
