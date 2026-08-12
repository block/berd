use std::{collections::HashMap, path::PathBuf};

use crate::services::{dir_env, env_key, shell_env};

fn push_existing_path(paths: &mut Vec<PathBuf>, path: &str, preserve_hermit: bool) {
    paths.extend(std::env::split_paths(path).filter(|path| {
        preserve_hermit
            || (!path.to_string_lossy().contains(".hermit")
                && !path.join("activate-hermit").exists())
    }));
}

pub fn build_extended_path_with_prepended_dirs(
    path: Option<&str>,
    prepend_dirs: &[PathBuf],
) -> String {
    build_extended_path(path, prepend_dirs, false)
}

fn build_extended_path(
    path: Option<&str>,
    prepend_dirs: &[PathBuf],
    preserve_hermit: bool,
) -> String {
    let mut paths: Vec<PathBuf> = prepend_dirs.to_vec();

    if let Some(path) = path {
        push_existing_path(&mut paths, path, preserve_hermit);
    } else if let Ok(system_path) = std::env::var("PATH") {
        // Login-shell capture can fail; preserve the app process PATH as a
        // fallback instead of dropping all inherited search paths.
        push_existing_path(&mut paths, &system_path, preserve_hermit);
    }

    push_tool_manager_dirs(&mut paths);

    dedupe_paths(&mut paths);

    match std::env::join_paths(&paths) {
        Ok(joined) => joined.to_string_lossy().to_string(),
        Err(_) => {
            // A single dir embedding the separator (legal in macOS paths)
            // makes join_paths reject the whole list; drop such dirs so one
            // bad entry cannot empty the sidecar PATH.
            paths.retain(|path| {
                let joinable = std::env::join_paths(std::iter::once(path)).is_ok();
                if !joinable {
                    log::warn!("Dropping un-joinable PATH entry: {}", path.display());
                }
                joinable
            });
            std::env::join_paths(paths)
                .unwrap_or_default()
                .to_string_lossy()
                .to_string()
        }
    }
}

#[cfg(windows)]
#[path = "path_env/windows.rs"]
mod platform;
#[cfg(not(windows))]
#[path = "path_env/unix.rs"]
mod platform;

fn push_tool_manager_dirs(paths: &mut Vec<PathBuf>) {
    platform::push_tool_manager_dirs(paths);
}

fn dedupe_paths(paths: &mut Vec<PathBuf>) {
    platform::dedupe_paths(paths);
}

#[cfg_attr(not(test), allow(dead_code))]
pub fn build_extended_path_from_path(path: Option<&str>) -> String {
    build_extended_path_with_prepended_dirs(path, &[])
}

/// Build the terminal PATH according to the platform activation contract.
/// Windows preserves its validated project Hermit entry; Unix removes inherited
/// Hermit state because the interactive shell activates the requested cwd.
pub fn build_terminal_path(path: Option<&str>) -> String {
    platform::build_terminal_path(path)
}

/// Build a deterministic environment snapshot with PATH normalized through
/// `build_extended_path_from_path`.
///
/// If home env capture failed, fall back to the current process environment so
/// callers that clear child environments still preserve essential variables.
pub fn env_vars_with_extended_path_and_prepended_dirs(
    shell_env: &HashMap<String, String>,
    prepend_dirs: &[PathBuf],
) -> Vec<(String, String)> {
    let mut env = if shell_env.is_empty() {
        std::env::vars().collect()
    } else {
        shell_env.clone()
    };
    shell_env::sanitize_shell_env(&mut env);
    let extended_path =
        build_extended_path_with_prepended_dirs(env_key::get(&env, "PATH"), prepend_dirs);
    env_key::upsert_map(&mut env, "PATH", extended_path);

    let mut vars: Vec<_> = env.into_iter().collect();
    vars.sort_by(|(left, _), (right, _)| left.cmp(right));
    vars
}

pub async fn home_env_vars_with_extended_path_and_prepended_dirs(
    prepend_dirs: &[PathBuf],
) -> Vec<(String, String)> {
    let shell_env = dir_env::capture_home_interactive_env().await;
    env_vars_with_extended_path_and_prepended_dirs(&shell_env, prepend_dirs)
}

#[cfg(test)]
mod tests {
    #[cfg(windows)]
    use super::platform::{latest_semver_bin, push_windows_fnm_bin, windows_fnm_root};
    use super::{
        build_extended_path_from_path, build_extended_path_with_prepended_dirs,
        env_vars_with_extended_path_and_prepended_dirs,
    };
    use std::collections::HashMap;
    #[cfg(windows)]
    use std::path::Path;
    use std::path::PathBuf;

    #[test]
    fn extended_path_starts_with_login_shell_path_and_tool_manager_shims() {
        let path = build_extended_path_from_path(Some("/shell/bin:/another/bin:/shell/bin"));
        let paths: Vec<_> = std::env::split_paths(&path).collect();

        assert_eq!(
            paths.first().map(|p| p.as_path()),
            Some(std::path::Path::new("/shell/bin"))
        );
        assert_eq!(
            paths.get(1).map(|p| p.as_path()),
            Some(std::path::Path::new("/another/bin"))
        );
        assert_eq!(
            paths
                .iter()
                .filter(|p| p.as_path() == std::path::Path::new("/shell/bin"))
                .count(),
            1
        );
        assert!(paths.iter().any(|p| p.ends_with(".local/share/mise/shims")));
        assert!(paths.iter().any(|p| p.ends_with(".amp/bin")));
        assert!(paths.iter().any(|p| p.ends_with(".volta/bin")));
        assert!(paths.iter().any(|p| p.ends_with(".asdf/shims")));
    }

    #[test]
    fn terminal_path_applies_platform_hermit_activation_contract() {
        let input = std::env::join_paths([
            PathBuf::from("project/.hermit/bin"),
            PathBuf::from("system/bin"),
        ])
        .expect("join input path")
        .to_string_lossy()
        .into_owned();

        let path = super::build_terminal_path(Some(&input));
        let paths: Vec<_> = std::env::split_paths(&path).collect();

        assert_eq!(
            paths.iter().any(|path| path.ends_with(".hermit/bin")),
            cfg!(windows),
            "Windows preserves validated Hermit activation; Unix shells reactivate cwd"
        );
    }

    #[test]
    fn extended_path_filters_hermit_paths() {
        let path = build_extended_path_from_path(Some("/shell/bin:/repo/.hermit/bin:/another/bin"));
        let paths: Vec<_> = std::env::split_paths(&path).collect();

        assert!(paths
            .iter()
            .any(|p| p == std::path::Path::new("/shell/bin")));
        assert!(paths
            .iter()
            .any(|p| p == std::path::Path::new("/another/bin")));
        assert!(!paths
            .iter()
            .any(|p| p == std::path::Path::new("/repo/.hermit/bin")));
    }

    #[test]
    fn extended_path_falls_back_to_process_path_when_shell_path_is_missing() {
        let path = build_extended_path_from_path(None);
        let paths: Vec<_> = std::env::split_paths(&path).collect();

        assert!(!paths.is_empty());
    }

    #[test]
    fn extended_path_keeps_prepended_dirs_in_front() {
        let path = build_extended_path_with_prepended_dirs(
            Some("/shell/bin:/acp/bin"),
            &[PathBuf::from("/acp/bin"), PathBuf::from("/distro/bin")],
        );
        let paths: Vec<_> = std::env::split_paths(&path).collect();

        assert_eq!(
            paths.first().map(|p| p.as_path()),
            Some(std::path::Path::new("/acp/bin"))
        );
        assert_eq!(
            paths.get(1).map(|p| p.as_path()),
            Some(std::path::Path::new("/distro/bin"))
        );
        assert_eq!(
            paths
                .iter()
                .filter(|p| p.as_path() == std::path::Path::new("/acp/bin"))
                .count(),
            1
        );
    }

    #[test]
    #[cfg(unix)]
    fn extended_path_drops_unjoinable_prepended_dirs_instead_of_emptying_path() {
        let path = build_extended_path_with_prepended_dirs(
            Some("/shell/bin"),
            &[PathBuf::from("/weird:dir/bin"), PathBuf::from("/acp/bin")],
        );
        let paths: Vec<_> = std::env::split_paths(&path).collect();

        assert_eq!(
            paths.first().map(|p| p.as_path()),
            Some(std::path::Path::new("/acp/bin"))
        );
        assert!(paths
            .iter()
            .any(|p| p == std::path::Path::new("/shell/bin")));
        assert!(!paths.iter().any(|p| p.to_string_lossy().contains("weird")));
    }

    #[test]
    fn env_vars_with_extended_path_sanitizes_and_normalizes_path() {
        let env = HashMap::from([
            (
                "PATH".to_string(),
                "/repo/.hermit/bin:/shell/bin".to_string(),
            ),
            ("HERMIT_ENV".to_string(), "/repo".to_string()),
            ("LANG".to_string(), "en_US.UTF-8".to_string()),
        ]);

        let vars = env_vars_with_extended_path_and_prepended_dirs(&env, &[]);
        let map: HashMap<_, _> = vars.into_iter().collect();
        let path = map.get("PATH").expect("PATH");
        let paths: Vec<_> = std::env::split_paths(path).collect();

        assert_eq!(map.get("LANG"), Some(&"en_US.UTF-8".to_string()));
        assert!(!map.contains_key("HERMIT_ENV"));
        assert!(paths
            .iter()
            .any(|p| p == std::path::Path::new("/shell/bin")));
        assert!(!paths
            .iter()
            .any(|p| p == std::path::Path::new("/repo/.hermit/bin")));
        assert!(paths.iter().any(|p| p.ends_with(".asdf/shims")));
    }

    #[cfg(windows)]
    #[test]
    fn windows_env_vars_extend_inherited_path_without_a_logical_duplicate() {
        let inherited = std::env::join_paths([PathBuf::from("C:\\Windows\\System32")])
            .expect("join inherited path")
            .to_string_lossy()
            .into_owned();
        let prepended = PathBuf::from("C:\\Program Files\\Berd Tools");
        let env = HashMap::from([("Path".to_string(), inherited)]);

        let vars =
            env_vars_with_extended_path_and_prepended_dirs(&env, std::slice::from_ref(&prepended));
        let mut command = std::process::Command::new("cmd.exe");
        command.env_clear();
        for (key, value) in &vars {
            command.env(key, value);
        }
        let applied_paths = command
            .get_envs()
            .filter_map(|(key, value)| (key.eq_ignore_ascii_case("PATH")).then_some(value?))
            .collect::<Vec<_>>();
        let paths = applied_paths
            .first()
            .map(|value| std::env::split_paths(value).collect::<Vec<_>>())
            .expect("extended path");

        assert_eq!(
            vars.iter()
                .filter(|(key, _)| key.eq_ignore_ascii_case("PATH"))
                .count(),
            1,
            "environment construction must retain one logical PATH"
        );
        assert_eq!(
            applied_paths.len(),
            1,
            "command-style application must see one logical PATH"
        );
        assert_eq!(paths.first(), Some(&prepended));
        assert!(paths.iter().any(|path| path.ends_with("Windows\\System32")));
    }

    #[test]
    fn env_vars_with_extended_path_prepends_dirs() {
        let env = HashMap::from([
            ("PATH".to_string(), "/shell/bin".to_string()),
            ("LANG".to_string(), "en_US.UTF-8".to_string()),
        ]);

        let vars = env_vars_with_extended_path_and_prepended_dirs(
            &env,
            &[PathBuf::from("/resources/acp/bin")],
        );
        let map: HashMap<_, _> = vars.into_iter().collect();
        let path = map.get("PATH").expect("PATH");
        let paths: Vec<_> = std::env::split_paths(path).collect();

        assert_eq!(
            paths.first().map(|p| p.as_path()),
            Some(std::path::Path::new("/resources/acp/bin"))
        );
        assert!(paths
            .iter()
            .any(|p| p == std::path::Path::new("/shell/bin")));
    }

    #[cfg(windows)]
    fn write_fnm_install(root: &Path, version: &str) -> PathBuf {
        let installation = root
            .join("node-versions")
            .join(version)
            .join("installation");
        std::fs::create_dir_all(&installation).expect("fnm installation");
        std::fs::write(installation.join("node.exe"), b"fixture").expect("node fixture");
        installation
    }

    #[cfg(windows)]
    #[test]
    fn windows_fnm_root_honors_case_insensitive_non_empty_override() {
        let appdata = PathBuf::from("C:\\Users\\dev\\AppData\\Roaming");
        let custom = PathBuf::from("D:\\Toolchains\\fnm");
        let env = [("fnm_dir".into(), custom.clone().into_os_string())];

        assert_eq!(windows_fnm_root(env, Some(&appdata)), Some(custom));
    }

    #[cfg(windows)]
    #[test]
    fn windows_fnm_root_ignores_empty_override_and_uses_appdata_default() {
        let appdata = PathBuf::from("C:\\Users\\dev\\AppData\\Roaming");
        let env = [("FnM_DiR".into(), "  ".into())];

        assert_eq!(
            windows_fnm_root(env, Some(&appdata)),
            Some(appdata.join("fnm"))
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_fnm_root_rejects_inherited_hermit_override() {
        let appdata = PathBuf::from("C:\\Users\\dev\\AppData\\Roaming");
        let env = [("FNM_DIR".into(), "C:\\repo\\.HeRmIt\\fnm".into())];

        assert_eq!(
            windows_fnm_root(env, Some(&appdata)),
            Some(appdata.join("fnm"))
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_fnm_semver_fallback_compares_numeric_major_versions() {
        let temp = tempfile::tempdir().expect("temp dir");
        let root = temp.path().join("fnm");
        write_fnm_install(&root, "v9");
        let v22 = write_fnm_install(&root, "v22");

        let selected = latest_semver_bin(&root.join("node-versions"), "installation")
            .expect("selected fnm version");

        assert_eq!(selected, v22);
    }

    #[cfg(windows)]
    #[test]
    fn windows_fnm_semver_fallback_compares_numeric_minor_versions() {
        let temp = tempfile::tempdir().expect("temp dir");
        let root = temp.path().join("fnm");
        write_fnm_install(&root, "v20.9");
        let v20_10 = write_fnm_install(&root, "v20.10");

        let selected = latest_semver_bin(&root.join("node-versions"), "installation")
            .expect("selected fnm version");

        assert_eq!(selected, v20_10);
    }

    #[cfg(windows)]
    fn create_directory_link(target: &Path, link: &Path) {
        use std::os::windows::fs::symlink_dir;

        if symlink_dir(target, link).is_ok() {
            return;
        }

        let output = std::process::Command::new("cmd.exe")
            .args(["/d", "/c", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .output()
            .expect("create default directory junction");
        assert!(
            output.status.success(),
            "failed to create default directory link: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_fnm_prefers_valid_default_alias_over_latest() {
        let temp = tempfile::tempdir().expect("temp dir");
        let root = temp.path().join("fnm");
        let default = write_fnm_install(&root, "v20.9.0");
        write_fnm_install(&root, "v22.1.0");
        std::fs::create_dir_all(root.join("aliases")).expect("aliases");
        create_directory_link(&default, &root.join("aliases").join("default"));
        let mut paths = Vec::new();

        push_windows_fnm_bin(&mut paths, &root);

        assert_eq!(
            paths,
            vec![default.canonicalize().expect("canonical default")]
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_fnm_rejects_default_alias_outside_installations() {
        let temp = tempfile::tempdir().expect("temp dir");
        let root = temp.path().join("fnm");
        let latest = write_fnm_install(&root, "v22.1.0");
        let invalid_default = root.join("aliases").join("default");
        std::fs::create_dir_all(&invalid_default).expect("invalid default alias");
        std::fs::write(invalid_default.join("node.exe"), b"fixture").expect("node fixture");
        let mut paths = Vec::new();

        push_windows_fnm_bin(&mut paths, &root);

        assert_eq!(paths, vec![latest]);
    }

    #[test]
    #[cfg(windows)]
    fn windows_extended_path_adds_native_tool_dirs_and_no_unix_dirs() {
        let input = std::env::join_paths([PathBuf::from("C:\\shell\\bin")])
            .expect("join input path")
            .to_string_lossy()
            .to_string();
        let path = build_extended_path_from_path(Some(&input));
        let paths: Vec<_> = std::env::split_paths(&path).collect();

        // Native npm/Volta locations are appended.
        assert!(paths.iter().any(|p| p.ends_with("npm")));
        assert!(paths.iter().any(|p| p.ends_with("Volta\\bin")));

        // Impossible-on-Windows Unix locations must never be appended.
        for unix_dir in [
            ".local/bin",
            ".local/share/mise/shims",
            ".asdf/shims",
            "/usr/local/bin",
        ] {
            assert!(
                !paths.iter().any(|p| p.to_string_lossy().contains(unix_dir)),
                "unexpected Unix dir {unix_dir} on Windows PATH"
            );
        }
    }

    #[test]
    #[cfg(windows)]
    fn windows_extended_path_dedupes_case_insensitively() {
        let input = std::env::join_paths([
            PathBuf::from("C:\\Tools\\Bin"),
            PathBuf::from("c:\\tools\\bin"),
        ])
        .expect("join input path")
        .to_string_lossy()
        .to_string();
        let path = build_extended_path_from_path(Some(&input));
        let paths: Vec<_> = std::env::split_paths(&path).collect();

        assert_eq!(
            paths
                .iter()
                .filter(|p| p.to_string_lossy().eq_ignore_ascii_case("c:\\tools\\bin"))
                .count(),
            1,
            "case-insensitive duplicate PATH entries must collapse on Windows"
        );
    }

    #[test]
    #[cfg(windows)]
    fn windows_extended_path_preserves_directories_with_spaces() {
        let spaced = PathBuf::from("C:\\Program Files\\nodejs");
        let input = std::env::join_paths([spaced.clone()])
            .expect("join input path")
            .to_string_lossy()
            .to_string();
        let path = build_extended_path_from_path(Some(&input));
        let paths: Vec<_> = std::env::split_paths(&path).collect();

        assert!(
            paths.iter().any(|p| p == spaced.as_path()),
            "directories containing spaces must survive PATH round-trip"
        );
    }
}
