use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, Instant},
};
use tokio::{sync::watch, time::timeout};

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

/// Capture the environment used to launch an interactive terminal.
///
/// Unix shells activate directory-scoped tools during startup, so they begin
/// with the sanitized home environment. Windows has no equivalent startup
/// activation; its platform capture reconstructs validated project-local tool
/// state for the requested working directory.
pub async fn capture_terminal_env(dir: &Path) -> HashMap<String, String> {
    platform::capture_terminal_env(dir, HOME_ENV_CAPTURE_TIMEOUT).await
}

/// Resolve a control executable before any repository-local PATH is applied.
/// Windows returns a canonical absolute path; other platforms preserve the
/// existing PATH lookup behavior.
pub(crate) fn resolve_control_executable(name: &str) -> Option<PathBuf> {
    platform::resolve_control_executable(name)
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

#[cfg(any(windows, test))]
fn find_project_hermit_bin_within(start: &Path, repo_root: &Path) -> Option<PathBuf> {
    let canonical_repo = repo_root.canonicalize().ok()?;
    let canonical_start = start.canonicalize().ok()?;
    if !canonical_start.starts_with(&canonical_repo) {
        return None;
    }

    for project_dir in canonical_start.ancestors() {
        let hermit_dir = project_dir.join(".hermit");
        let bin = hermit_dir.join("bin");
        if bin.is_dir() {
            let canonical_hermit = hermit_dir.canonicalize().ok()?;
            let canonical_bin = bin.canonicalize().ok()?;
            if canonical_hermit.starts_with(&canonical_repo)
                && canonical_bin.starts_with(&canonical_hermit)
            {
                return Some(canonical_bin);
            }
        }
        if project_dir == canonical_repo {
            break;
        }
    }
    None
}

#[cfg(windows)]
#[path = "dir_env/windows.rs"]
mod platform;
#[cfg(not(windows))]
#[path = "dir_env/unix.rs"]
mod platform;

async fn capture_dir_env_uncached(
    dir: &Path,
    timeout_duration: Duration,
) -> HashMap<String, String> {
    platform::capture_dir_env_uncached(dir, timeout_duration).await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(windows)]
    use crate::services::env_key;

    #[test]
    #[cfg(not(windows))]
    fn parse_env_output_handles_null_delimited() {
        let env = platform::parse_env_output(b"PATH=/usr/bin:/bin\0HOME=/Users/test\0\0");
        assert_eq!(env.get("PATH"), Some(&"/usr/bin:/bin".to_string()));
        assert_eq!(env.get("HOME"), Some(&"/Users/test".to_string()));
    }

    #[test]
    #[cfg(not(windows))]
    fn parse_env_output_skips_empty_keys() {
        let env = platform::parse_env_output(b"=empty_key\0VALID=yes\0");
        assert!(!env.contains_key(""));
        assert_eq!(env.get("VALID"), Some(&"yes".to_string()));
    }

    #[test]
    #[cfg(not(windows))]
    fn parse_env_output_preserves_hermit_path_entries() {
        let path = "/repo/.hermit/bin:/repo/bin:/usr/bin";
        let env = platform::parse_env_output(format!("PATH={path}\0").as_bytes());

        assert_eq!(env.get("PATH"), Some(&path.to_string()));
    }

    #[test]
    #[cfg(windows)]
    fn windows_dedupe_env_keeps_first_seen_case_and_drops_duplicates() {
        let env = platform::dedupe_env_case_insensitive([
            ("Path".to_string(), "C:\\first".to_string()),
            ("PATH".to_string(), "C:\\second".to_string()),
            ("SystemRoot".to_string(), "C:\\Windows".to_string()),
        ]);

        assert_eq!(env.get("Path"), Some(&"C:\\first".to_string()));
        assert!(!env.contains_key("PATH"));
        assert_eq!(env.get("SystemRoot"), Some(&"C:\\Windows".to_string()));
        // Exactly one entry survives for the case-insensitive `path` name.
        assert_eq!(
            env.keys()
                .filter(|k| k.eq_ignore_ascii_case("path"))
                .count(),
            1
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_capture_drops_unvalidated_inherited_hermit_state() {
        let inherited = std::env::join_paths([
            PathBuf::from("C:\\unrelated\\.HERMIT\\bin"),
            PathBuf::from("C:\\Windows\\System32"),
        ])
        .expect("join inherited path")
        .to_string_lossy()
        .into_owned();
        let mut env = HashMap::from([
            ("Path".to_string(), inherited),
            ("Hermit_Env".to_string(), "C:\\unrelated".to_string()),
            (
                "npm_config_prefix".to_string(),
                "C:\\unrelated\\npm".to_string(),
            ),
            (
                "Npm_Config_Cache".to_string(),
                "C:\\unrelated\\cache".to_string(),
            ),
            (
                "corepack_home".to_string(),
                "C:\\unrelated\\corepack".to_string(),
            ),
            (
                "CUSTOM_TOOL_HOME".to_string(),
                "C:\\unrelated\\.HeRmIt\\tool".to_string(),
            ),
        ]);

        platform::strip_untrusted_windows_tool_state(&mut env);

        for key in [
            "HERMIT_ENV",
            "NPM_CONFIG_PREFIX",
            "NPM_CONFIG_CACHE",
            "COREPACK_HOME",
            "CUSTOM_TOOL_HOME",
        ] {
            assert!(!env
                .keys()
                .any(|existing| existing.eq_ignore_ascii_case(key)));
        }
        let paths: Vec<_> =
            std::env::split_paths(env_key::get(&env, "PATH").expect("PATH")).collect();
        assert_eq!(paths, vec![PathBuf::from("C:\\Windows\\System32")]);
    }

    #[cfg(windows)]
    #[test]
    fn windows_git_discovery_uses_sanitized_path() {
        let temp = tempfile::tempdir().expect("temp dir");
        let untrusted_hermit_bin = temp.path().join("repo").join(".hermit").join("bin");
        let trusted_bin = temp.path().join("trusted").join("bin");
        std::fs::create_dir_all(&untrusted_hermit_bin).expect("untrusted Hermit bin");
        std::fs::create_dir_all(&trusted_bin).expect("trusted bin");
        std::fs::write(untrusted_hermit_bin.join("git.exe"), b"untrusted")
            .expect("untrusted git fixture");
        std::fs::write(trusted_bin.join("git.exe"), b"trusted").expect("trusted git fixture");
        let path = std::env::join_paths([untrusted_hermit_bin, trusted_bin.clone()])
            .expect("fixture PATH")
            .to_string_lossy()
            .into_owned();
        let mut env = HashMap::from([("Path".to_string(), path)]);

        platform::strip_untrusted_windows_tool_state(&mut env);
        let git = platform::find_file_on_windows_path("git.exe", env_key::get(&env, "PATH"))
            .expect("trusted git");

        assert_eq!(
            git,
            trusted_bin
                .join("git.exe")
                .canonicalize()
                .expect("canonical trusted Git")
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_control_executables_ignore_repository_hermit_bins() {
        let temp = tempfile::tempdir().expect("temp dir");
        let repository_bin = temp.path().join("repo").join(".hermit").join("bin");
        let trusted_bin = temp.path().join("trusted").join("bin");
        std::fs::create_dir_all(&repository_bin).expect("repository Hermit bin");
        std::fs::create_dir_all(&trusted_bin).expect("trusted bin");
        for executable in ["git.exe", "gh.exe"] {
            std::fs::write(repository_bin.join(executable), b"sentinel")
                .expect("repository sentinel");
            std::fs::write(trusted_bin.join(executable), b"trusted").expect("trusted executable");
        }
        let path = std::env::join_paths([repository_bin.clone(), trusted_bin.clone()])
            .expect("fixture PATH")
            .to_string_lossy()
            .into_owned();
        let env = HashMap::from([("Path".to_string(), path)]);

        for executable in ["git", "gh"] {
            assert_eq!(
                platform::resolve_control_executable_in_env(executable, env.clone()),
                Some(
                    trusted_bin
                        .join(format!("{executable}.exe"))
                        .canonicalize()
                        .expect("canonical trusted executable")
                )
            );
        }
    }

    #[test]
    #[cfg(windows)]
    fn windows_process_env_preserves_critical_variables() {
        // The process already inherited the Windows session environment; the
        // capture must surface the variables child processes cannot run without.
        let env = platform::windows_process_env_for_dir(
            dirs::home_dir()
                .as_deref()
                .unwrap_or_else(|| Path::new("C:\\")),
        );

        for key in ["SystemRoot", "ComSpec", "PATHEXT"] {
            if std::env::var_os(key).is_some() {
                assert!(
                    env.keys().any(|k| k.eq_ignore_ascii_case(key)),
                    "expected captured Windows env to preserve {key}"
                );
            }
        }
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
    fn project_hermit_discovery_is_scoped_to_the_git_repository() {
        let temp = tempfile::tempdir().expect("temp dir");
        let repo = temp.path().join("Project With Spaces");
        let target = repo.join("nested").join("worktree");
        let hermit_bin = repo.join(".hermit").join("bin");
        std::fs::create_dir_all(&target).expect("target");
        std::fs::create_dir_all(&hermit_bin).expect("hermit bin");

        assert_eq!(
            find_project_hermit_bin_within(&target, &repo),
            Some(hermit_bin.canonicalize().expect("canonical Hermit bin"))
        );
    }

    #[test]
    fn project_hermit_discovery_stops_at_the_repository_boundary() {
        let temp = tempfile::tempdir().expect("temp dir");
        let repo = temp.path().join("project");
        let target = repo.join("nested");
        std::fs::create_dir_all(&target).expect("target");
        std::fs::create_dir_all(temp.path().join(".hermit").join("bin"))
            .expect("ancestor Hermit bin");

        assert_eq!(find_project_hermit_bin_within(&target, &repo), None);
    }

    #[cfg(windows)]
    #[test]
    fn project_hermit_discovery_rejects_non_repository_ancestor() {
        let temp = tempfile::tempdir().expect("temp dir");
        let target = temp.path().join("project").join("nested");
        std::fs::create_dir_all(&target).expect("target");
        std::fs::create_dir_all(temp.path().join(".hermit").join("bin"))
            .expect("untrusted Hermit bin");

        assert_eq!(platform::find_project_hermit_bin(&target), None);
    }

    #[cfg(windows)]
    #[test]
    fn project_hermit_discovery_rejects_fake_git_marker_file() {
        let temp = tempfile::tempdir().expect("temp dir");
        let repo = temp.path().join("repo");
        let hermit_bin = repo.join(".hermit").join("bin");
        std::fs::create_dir_all(&hermit_bin).expect("Hermit bin");
        std::fs::write(repo.join(".git"), "not a Git worktree marker").expect("fake Git marker");

        assert_eq!(platform::find_project_hermit_bin(&repo), None);
    }

    #[cfg(windows)]
    #[test]
    fn project_hermit_discovery_rejects_fake_git_directory() {
        let temp = tempfile::tempdir().expect("temp dir");
        let repo = temp.path().join("repo");
        std::fs::create_dir_all(repo.join(".hermit").join("bin")).expect("Hermit bin");
        std::fs::create_dir_all(repo.join(".git")).expect("fake Git directory");

        assert_eq!(platform::find_project_hermit_bin(&repo), None);
    }

    #[cfg(windows)]
    #[test]
    fn project_hermit_discovery_rejects_missing_worktree_git_dir() {
        let temp = tempfile::tempdir().expect("temp dir");
        let repo = temp.path().join("repo");
        std::fs::create_dir_all(repo.join(".hermit").join("bin")).expect("Hermit bin");
        std::fs::write(repo.join(".git"), "gitdir: ../missing-worktree\n")
            .expect("stale worktree marker");

        assert_eq!(platform::find_project_hermit_bin(&repo), None);
    }

    #[cfg(unix)]
    #[test]
    fn project_hermit_discovery_rejects_escaping_symlink() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().expect("temp dir");
        let repo = temp.path().join("repo");
        let outside = temp.path().join("outside");
        std::fs::create_dir_all(&repo).expect("repo");
        std::fs::create_dir_all(outside.join("bin")).expect("outside bin");
        std::fs::create_dir_all(repo.join(".git")).expect("git marker");
        std::fs::write(repo.join(".git").join("HEAD"), "ref: refs/heads/main\n").expect("Git HEAD");
        symlink(&outside, repo.join(".hermit")).expect("escaping symlink");

        assert_eq!(find_project_hermit_bin_within(&repo, &repo), None);
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

        let env = platform::capture_dir_env_with_shell(
            temp.path(),
            &shell,
            temp.path(),
            Duration::from_secs(1),
        )
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

        let error = platform::capture_dir_env_with_shell(
            temp.path(),
            &shell,
            temp.path(),
            Duration::from_millis(50),
        )
        .await
        .expect_err("hanging shell should time out");

        assert_eq!(error.kind(), std::io::ErrorKind::TimedOut);
        assert!(started.elapsed() < Duration::from_secs(2));
    }
}
