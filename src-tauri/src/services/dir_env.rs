use std::{
    collections::HashMap,
    io,
    path::{Path, PathBuf},
    process::Stdio,
    sync::Mutex,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::{io::AsyncWriteExt, process::Command, sync::watch, time::timeout};

use crate::services::shell_env;

/// Per-directory environment cache entry.
enum CacheEntry {
    Ready {
        env: HashMap<String, String>,
        captured_at: Instant,
    },
    InFlight(watch::Receiver<Option<Result<HashMap<String, String>, String>>>),
}

/// Cache of per-directory shell environments.
///
/// Unlike the global `shell_env` capture, this runs an interactive login shell
/// *in the target directory* so that directory-scoped tool managers (Hermit,
/// direnv, mise, etc.) activate and inject their paths. Entries are cached with
/// a TTL to avoid spawning a shell on every git command while still picking up
/// changes when the user modifies their toolchain.
static DIR_ENV_CACHE: Mutex<Option<HashMap<PathBuf, CacheEntry>>> = Mutex::new(None);

/// Match Staged's default so shell startup cost is amortized across a session
/// while still refreshing user shell changes without manual invalidation.
const DIR_ENV_CACHE_TTL: Duration = Duration::from_secs(60 * 60);
const HOME_ENV_CAPTURE_TIMEOUT: Duration = Duration::from_secs(10);

struct InFlightGuard {
    key: PathBuf,
    promoted: bool,
}

impl Drop for InFlightGuard {
    fn drop(&mut self) {
        if self.promoted {
            return;
        }

        let Ok(mut guard) = DIR_ENV_CACHE.lock() else {
            return;
        };
        let Some(cache) = guard.as_mut() else {
            return;
        };
        if matches!(cache.get(&self.key), Some(CacheEntry::InFlight(_))) {
            cache.remove(&self.key);
        }
    }
}

/// Capture the shell environment for a specific directory.
///
/// Runs `$SHELL -i -l -s` with `cwd` set to the target directory so that shell
/// hooks (hermit, direnv, etc.) activate. The shell receives a small stdin
/// script that writes `env -0` to a temp file, while stdout and stderr are
/// discarded so shell banners cannot corrupt parsing.
///
/// Returns `None` if the capture fails. Failed captures are not cached.
pub async fn capture_dir_env(
    dir: &Path,
    timeout_duration: Duration,
) -> Option<HashMap<String, String>> {
    let key = dir.to_path_buf();

    loop {
        enum Action {
            Return(HashMap<String, String>),
            Wait(watch::Receiver<Option<Result<HashMap<String, String>, String>>>),
            Capture(watch::Sender<Option<Result<HashMap<String, String>, String>>>),
        }

        let action = {
            let mut guard = DIR_ENV_CACHE.lock().ok()?;
            let cache = guard.get_or_insert_with(HashMap::new);
            match cache.get(&key) {
                Some(CacheEntry::Ready { env, captured_at })
                    if captured_at.elapsed() < DIR_ENV_CACHE_TTL =>
                {
                    Action::Return(env.clone())
                }
                Some(CacheEntry::InFlight(rx)) => Action::Wait(rx.clone()),
                _ => {
                    let (tx, rx) = watch::channel(None);
                    cache.insert(key.clone(), CacheEntry::InFlight(rx));
                    Action::Capture(tx)
                }
            }
        };

        match action {
            Action::Return(env) => return Some(env),
            Action::Wait(mut rx) => {
                let wait_result = timeout(timeout_duration, async {
                    while rx.borrow().is_none() {
                        if rx.changed().await.is_err() {
                            break;
                        }
                    }

                    rx.borrow().clone()
                })
                .await;

                let result = match wait_result {
                    Ok(result) => result,
                    Err(_) => {
                        log::warn!(
                            "Timed out waiting {:?} for dir env capture in {}",
                            timeout_duration,
                            key.display()
                        );
                        return None;
                    }
                };

                match result {
                    Some(Ok(env)) => return Some(env),
                    Some(Err(_)) => return None,
                    None => continue,
                }
            }
            Action::Capture(tx) => {
                let mut guard = InFlightGuard {
                    key: key.clone(),
                    promoted: false,
                };
                let env = capture_dir_env_uncached(&key, timeout_duration).await;
                if env.is_empty() {
                    let _ = tx.send(Some(Err(
                        "Directory env capture returned no variables".into()
                    )));
                    return None;
                }

                put_cached(key.clone(), env.clone());
                guard.promoted = true;
                let _ = tx.send(Some(Ok(env.clone())));
                return Some(env);
            }
        }
    }
}

/// Capture the user's home/global interactive login environment.
///
/// This reuses the per-directory interactive-login cache with `$HOME` as the
/// directory, then sanitizes only the returned clone. The cached per-directory
/// environment remains raw so project/git callers still receive tool-manager
/// variables such as Hermit or direnv state for their exact directory.
pub async fn capture_home_interactive_env() -> HashMap<String, String> {
    capture_home_interactive_env_with_timeout(HOME_ENV_CAPTURE_TIMEOUT).await
}

pub async fn capture_home_interactive_env_with_timeout(
    timeout_duration: Duration,
) -> HashMap<String, String> {
    let Some(home) = home_dir_from_env() else {
        return HashMap::new();
    };
    capture_home_interactive_env_for_dir(&home, timeout_duration).await
}

fn home_dir_from_env() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .filter(|home| !home.is_empty())
        .map(PathBuf::from)
        .or_else(dirs::home_dir)
}

async fn capture_home_interactive_env_for_dir(
    home: &Path,
    timeout_duration: Duration,
) -> HashMap<String, String> {
    let mut env = capture_dir_env(home, timeout_duration)
        .await
        .unwrap_or_default();
    shell_env::sanitize_shell_env(&mut env);
    env
}

#[cfg(test)]
fn get_cached(key: &Path) -> Option<HashMap<String, String>> {
    let guard = DIR_ENV_CACHE.lock().ok()?;
    let cache = guard.as_ref()?;
    let entry = cache.get(key)?;
    match entry {
        CacheEntry::Ready { env, captured_at } if captured_at.elapsed() < DIR_ENV_CACHE_TTL => {
            Some(env.clone())
        }
        _ => None,
    }
}

fn put_cached(key: PathBuf, env: HashMap<String, String>) {
    let mut guard = match DIR_ENV_CACHE.lock() {
        Ok(g) => g,
        Err(_) => return,
    };
    let cache = guard.get_or_insert_with(HashMap::new);
    cache.insert(
        key,
        CacheEntry::Ready {
            env,
            captured_at: Instant::now(),
        },
    );
}

async fn capture_dir_env_uncached(
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

async fn capture_dir_env_with_shell(
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

fn parse_env_output(stdout: &[u8]) -> HashMap<String, String> {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_env_output_handles_null_delimited() {
        let env = parse_env_output(b"PATH=/usr/bin:/bin\0HOME=/Users/test\0\0");
        assert_eq!(env.get("PATH"), Some(&"/usr/bin:/bin".to_string()));
        assert_eq!(env.get("HOME"), Some(&"/Users/test".to_string()));
    }

    #[test]
    fn parse_env_output_skips_empty_keys() {
        let env = parse_env_output(b"=empty_key\0VALID=yes\0");
        assert!(!env.contains_key(""));
        assert_eq!(env.get("VALID"), Some(&"yes".to_string()));
    }

    #[test]
    fn parse_env_output_preserves_hermit_path_entries() {
        let path = "/repo/.hermit/bin:/repo/bin:/usr/bin";
        let env = parse_env_output(format!("PATH={path}\0").as_bytes());

        assert_eq!(env.get("PATH"), Some(&path.to_string()));
    }

    #[tokio::test]
    async fn home_interactive_env_sanitizes_clone_but_keeps_raw_cache() {
        let home = PathBuf::from("/tmp/test-home-env");
        let mut raw = HashMap::new();
        raw.insert("PATH".to_string(), "/repo/.hermit/bin:/usr/bin".to_string());
        raw.insert("HERMIT_ENV".to_string(), "/repo".to_string());
        raw.insert("LANG".to_string(), "en_US.UTF-8".to_string());

        put_cached(home.clone(), raw);

        let sanitized = capture_home_interactive_env_for_dir(&home, Duration::from_secs(1)).await;

        assert_eq!(sanitized.get("LANG"), Some(&"en_US.UTF-8".to_string()));
        assert!(!sanitized.contains_key("HERMIT_ENV"));
        assert_eq!(
            sanitized.get("PATH"),
            Some(&"/repo/.hermit/bin:/usr/bin".to_string())
        );

        let cached = get_cached(&home).expect("raw cached home env");
        assert!(cached.contains_key("HERMIT_ENV"));
        assert_eq!(
            cached.get("PATH"),
            Some(&"/repo/.hermit/bin:/usr/bin".to_string())
        );
    }

    #[test]
    fn cache_ttl_is_respected() {
        let key = PathBuf::from("/tmp/test-dir");
        let mut env = HashMap::new();
        env.insert("PATH".to_string(), "/test/bin".to_string());

        put_cached(key.clone(), env.clone());
        assert!(get_cached(&key).is_some());

        // Manually expire the entry.
        {
            let mut guard = DIR_ENV_CACHE.lock().unwrap();
            if let Some(cache) = guard.as_mut() {
                if let Some(CacheEntry::Ready { captured_at, .. }) = cache.get_mut(&key) {
                    *captured_at = Instant::now() - DIR_ENV_CACHE_TTL - Duration::from_secs(1);
                }
            }
        }
        assert!(get_cached(&key).is_none());
    }

    #[tokio::test]
    async fn capture_dir_env_uses_exact_cache_key() {
        let temp = tempfile::tempdir().expect("temp dir");
        let exact_key = temp.path().join("..").join(
            temp.path()
                .file_name()
                .expect("temp dir should have a final component"),
        );
        let canonical_key = exact_key.canonicalize().expect("canonical temp dir");
        let path = "/repo/.hermit/bin:/repo/bin:/usr/bin";
        let mut env = HashMap::new();
        env.insert("PATH".to_string(), path.to_string());

        put_cached(exact_key.clone(), env);

        assert!(get_cached(&canonical_key).is_none());

        let env = capture_dir_env(&exact_key, Duration::from_secs(1))
            .await
            .expect("cached env");
        assert_eq!(env.get("PATH"), Some(&path.to_string()));
    }

    #[cfg(unix)]
    fn write_fake_shell(dir: &Path, contents: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;

        let shell = dir.join("fake-shell");
        std::fs::write(&shell, contents).expect("write fake shell");
        let mut permissions = std::fs::metadata(&shell)
            .expect("fake shell metadata")
            .permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&shell, permissions).expect("chmod fake shell");
        shell
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn noisy_shell_stdout_does_not_corrupt_captured_env() {
        let temp = tempfile::tempdir().expect("temp dir");
        let shell = write_fake_shell(
            temp.path(),
            "#!/bin/sh\nprintf 'STDOUT_ONLY=bad\\n'\nPATH='/repo/.hermit/bin:/usr/bin' CUSTOM_VAR='present' /bin/sh -s\n",
        );

        let env =
            capture_dir_env_with_shell(temp.path(), &shell, temp.path(), Duration::from_secs(1))
                .await
                .expect("capture dir env");

        assert_eq!(env.get("CUSTOM_VAR"), Some(&"present".to_string()));
        assert_eq!(
            env.get("PATH"),
            Some(&"/repo/.hermit/bin:/usr/bin".to_string())
        );
        assert!(!env.contains_key("STDOUT_ONLY"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn hanging_shell_capture_times_out() {
        let temp = tempfile::tempdir().expect("temp dir");
        let shell = write_fake_shell(temp.path(), "#!/bin/sh\nexec sleep 5\n");
        let started = Instant::now();

        let error =
            capture_dir_env_with_shell(temp.path(), &shell, temp.path(), Duration::from_millis(50))
                .await
                .expect_err("hanging shell should time out");

        assert_eq!(error.kind(), io::ErrorKind::TimedOut);
        assert!(started.elapsed() < Duration::from_secs(2));
    }
}
