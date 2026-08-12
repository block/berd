//! Platform-aware environment-key operations.
//!
//! Windows environment names are case-insensitive while Unix names are not.
//! Keep that rule at environment construction boundaries so a later
//! `Command::env` application cannot collapse two differently-cased entries in
//! an order that lets a stale value win.

use std::collections::HashMap;

#[cfg(windows)]
pub fn matches(left: &str, right: &str) -> bool {
    left.eq_ignore_ascii_case(right)
}

#[cfg(not(windows))]
pub fn matches(left: &str, right: &str) -> bool {
    left == right
}

pub fn get<'a>(env: &'a HashMap<String, String>, key: &str) -> Option<&'a str> {
    env.iter()
        .find(|(existing, _)| matches(existing, key))
        .map(|(_, value)| value.as_str())
}

/// Insert an environment value while retaining at most one logical key.
///
/// The first matching entry keeps its spelling and position. This preserves a
/// captured Windows environment's conventional `Path` casing while ensuring
/// that later command application sees only the replacement value.
pub fn upsert_map(env: &mut HashMap<String, String>, key: &str, value: String) {
    let existing_key = env.keys().find(|existing| matches(existing, key)).cloned();
    env.retain(|existing, _| {
        existing_key
            .as_ref()
            .is_none_or(|kept| existing == kept || !matches(existing, key))
    });
    env.insert(existing_key.unwrap_or_else(|| key.to_string()), value);
}

/// Overlay one environment pair onto a command-style vector while retaining
/// at most one logical key.
pub fn upsert_vec(vars: &mut Vec<(String, String)>, key: &str, value: String) {
    if let Some(first) = vars.iter().position(|(existing, _)| matches(existing, key)) {
        vars[first].1 = value;
        let kept_key = vars[first].0.clone();
        let mut seen_kept = false;
        vars.retain(|(existing, _)| {
            if existing == &kept_key && !seen_kept {
                seen_kept = true;
                true
            } else {
                !matches(existing, key)
            }
        });
    } else {
        vars.push((key.to_string(), value));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exact_platform_key_is_replaced() {
        let mut env = HashMap::from([("PATH".to_string(), "old".to_string())]);
        upsert_map(&mut env, "PATH", "new".to_string());
        assert_eq!(get(&env, "PATH"), Some("new"));
        assert_eq!(env.len(), 1);
    }

    #[cfg(windows)]
    #[test]
    fn windows_map_upsert_collapses_mixed_case_duplicates() {
        let mut env = HashMap::from([
            ("Path".to_string(), "old".to_string()),
            ("PATH".to_string(), "stale".to_string()),
        ]);

        upsert_map(&mut env, "PATH", "extended".to_string());

        assert_eq!(get(&env, "path"), Some("extended"));
        assert_eq!(
            env.keys()
                .filter(|existing| existing.eq_ignore_ascii_case("PATH"))
                .count(),
            1
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_vec_upsert_collapses_mixed_case_duplicates() {
        let mut vars = vec![
            ("Path".to_string(), "old".to_string()),
            ("PATH".to_string(), "stale".to_string()),
        ];

        upsert_vec(&mut vars, "PATH", "extended".to_string());

        assert_eq!(vars, vec![("Path".to_string(), "extended".to_string())]);
    }

    #[cfg(not(windows))]
    #[test]
    fn unix_keys_remain_case_sensitive() {
        let mut vars = vec![("Path".to_string(), "captured".to_string())];
        upsert_vec(&mut vars, "PATH", "extended".to_string());

        assert_eq!(vars.len(), 2);
        assert_eq!(vars[0], ("Path".to_string(), "captured".to_string()));
        assert_eq!(vars[1], ("PATH".to_string(), "extended".to_string()));
    }
}
