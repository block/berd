use std::{collections::HashMap, path::PathBuf};

use crate::services::{dir_env, shell_env};

fn push_existing_path(paths: &mut Vec<PathBuf>, path: &str) {
    paths.extend(std::env::split_paths(path).filter(|p| {
        !p.to_string_lossy().contains(".hermit") && !p.join("activate-hermit").exists()
    }));
}

pub fn build_extended_path_from_path(path: Option<&str>) -> String {
    let mut paths: Vec<PathBuf> = Vec::new();

    if let Some(path) = path {
        push_existing_path(&mut paths, path);
    } else if let Ok(system_path) = std::env::var("PATH") {
        // Login-shell capture can fail; preserve the app process PATH as a
        // fallback instead of dropping all inherited search paths.
        push_existing_path(&mut paths, &system_path);
    }

    if let Some(home) = dirs::home_dir() {
        paths.push(home.join(".amp/bin"));
        paths.push(home.join(".local/bin"));
        paths.push(home.join(".npm-global/bin"));
        // Finder-launched apps often miss shell-initialized tool-manager shims.
        paths.push(home.join(".local/share/mise/shims"));
        paths.push(home.join(".volta/bin"));
        paths.push(home.join(".asdf/shims"));
    }

    paths.push(PathBuf::from("/usr/local/bin"));

    #[cfg(target_os = "macos")]
    {
        paths.push(PathBuf::from("/opt/homebrew/bin"));
        paths.push(PathBuf::from("/opt/local/bin"));
    }

    if cfg!(windows) {
        if let Some(appdata) = dirs::data_dir() {
            paths.push(appdata.join("npm"));
        }
    }

    if let Some(home) = dirs::home_dir() {
        let nvm_dir = home.join(".nvm/versions/node");
        if nvm_dir.exists() {
            if let Ok(entries) = std::fs::read_dir(&nvm_dir) {
                let mut versions: Vec<_> = entries
                    .filter_map(|e| e.ok())
                    .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
                    .collect();
                versions.sort_by_key(|b| std::cmp::Reverse(b.file_name()));
                if let Some(latest) = versions.first() {
                    paths.push(latest.path().join("bin"));
                }
            }
        }

        let fnm_dir = home.join(".local/share/fnm/node-versions");
        if fnm_dir.exists() {
            if let Ok(entries) = std::fs::read_dir(&fnm_dir) {
                let mut versions: Vec<_> = entries
                    .filter_map(|e| e.ok())
                    .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
                    .collect();
                versions.sort_by_key(|b| std::cmp::Reverse(b.file_name()));
                if let Some(latest) = versions.first() {
                    paths.push(latest.path().join("installation/bin"));
                }
            }
        }
    }

    let mut seen = std::collections::HashSet::new();
    paths.retain(|p| seen.insert(p.clone()));

    std::env::join_paths(paths)
        .unwrap_or_default()
        .to_string_lossy()
        .to_string()
}

/// Build a deterministic environment snapshot with PATH normalized through
/// `build_extended_path_from_path`.
///
/// If home env capture failed, fall back to the current process environment so
/// callers that clear child environments still preserve essential variables.
pub fn env_vars_with_extended_path(shell_env: &HashMap<String, String>) -> Vec<(String, String)> {
    let mut env = if shell_env.is_empty() {
        std::env::vars().collect()
    } else {
        shell_env.clone()
    };
    shell_env::sanitize_shell_env(&mut env);
    let extended_path = build_extended_path_from_path(env.get("PATH").map(String::as_str));
    env.insert("PATH".to_string(), extended_path);

    let mut vars: Vec<_> = env.into_iter().collect();
    vars.sort_by(|(left, _), (right, _)| left.cmp(right));
    vars
}

pub async fn home_env_vars_with_extended_path() -> Vec<(String, String)> {
    let shell_env = dir_env::capture_home_interactive_env().await;
    env_vars_with_extended_path(&shell_env)
}

#[cfg(test)]
mod tests {
    use super::{build_extended_path_from_path, env_vars_with_extended_path};
    use std::collections::HashMap;

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
    fn env_vars_with_extended_path_sanitizes_and_normalizes_path() {
        let env = HashMap::from([
            (
                "PATH".to_string(),
                "/repo/.hermit/bin:/shell/bin".to_string(),
            ),
            ("HERMIT_ENV".to_string(), "/repo".to_string()),
            ("LANG".to_string(), "en_US.UTF-8".to_string()),
        ]);

        let vars = env_vars_with_extended_path(&env);
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
}
