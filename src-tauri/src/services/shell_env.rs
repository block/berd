use std::collections::HashMap;

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

    if upper_key == "PATH" {
        return false;
    }

    value.contains("/.hermit/") || value.ends_with("/.hermit")
}

#[cfg(test)]
mod tests {
    use super::sanitize_shell_env;
    use std::collections::HashMap;

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
            (
                "PATH".to_string(),
                "/Users/morganm/Development/repo/.hermit/bin:/usr/bin".to_string(),
            ),
        ]);

        sanitize_shell_env(&mut env);

        assert_eq!(env.get("HOME"), Some(&"/Users/morganm".to_string()));
        assert_eq!(
            env.get("PATH"),
            Some(&"/Users/morganm/Development/repo/.hermit/bin:/usr/bin".to_string())
        );
        assert!(!env.contains_key("HERMIT_ENV"));
        assert!(!env.contains_key("NPM_CONFIG_PREFIX"));
        assert!(!env.contains_key("COREPACK_HOME"));
    }
}
