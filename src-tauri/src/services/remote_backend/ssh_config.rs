//! Minimal `~/.ssh/config` reader: concrete `Host` aliases only.
//!
//! This is deliberately not a full ssh_config parser. We only need the list of
//! names a user could type as a destination, so we collect `Host` aliases,
//! skip wildcard/negated patterns, and follow non-glob `Include` directives a
//! few levels deep. Everything else in the file is ignored.

use std::path::{Path, PathBuf};

const MAX_INCLUDE_DEPTH: u8 = 3;

pub fn load_ssh_config_hosts() -> Vec<String> {
    let Some(home) = dirs::home_dir() else {
        return Vec::new();
    };
    let config_path = home.join(".ssh").join("config");
    let mut hosts = Vec::new();
    collect_hosts_from_file(&config_path, &home.join(".ssh"), 0, &mut hosts);
    hosts
}

fn collect_hosts_from_file(path: &Path, include_base: &Path, depth: u8, hosts: &mut Vec<String>) {
    let Ok(contents) = std::fs::read_to_string(path) else {
        return;
    };
    collect_hosts(&contents, include_base, depth, hosts);
}

fn collect_hosts(contents: &str, include_base: &Path, depth: u8, hosts: &mut Vec<String>) {
    for line in contents.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((keyword, value)) = split_directive(line) else {
            continue;
        };
        if keyword.eq_ignore_ascii_case("host") {
            for alias in value.split_whitespace() {
                if alias.contains(['*', '?']) || alias.starts_with('!') {
                    continue;
                }
                if !hosts.iter().any(|existing| existing == alias) {
                    hosts.push(alias.to_string());
                }
            }
        } else if keyword.eq_ignore_ascii_case("include") && depth < MAX_INCLUDE_DEPTH {
            for target in value.split_whitespace() {
                if target.contains(['*', '?']) {
                    continue;
                }
                let target_path = resolve_include_path(target, include_base);
                collect_hosts_from_file(&target_path, include_base, depth + 1, hosts);
            }
        }
    }
}

/// ssh_config accepts `Keyword value`, `Keyword=value`, and `Keyword = value`.
fn split_directive(line: &str) -> Option<(&str, &str)> {
    let (keyword, value) = match line.split_once('=') {
        Some((keyword, value)) if !keyword.trim().contains(char::is_whitespace) => {
            (keyword.trim(), value.trim())
        }
        _ => {
            let mut parts = line.splitn(2, char::is_whitespace);
            (parts.next()?.trim(), parts.next()?.trim())
        }
    };
    if keyword.is_empty() || value.is_empty() {
        return None;
    }
    Some((keyword, value))
}

fn resolve_include_path(target: &str, include_base: &Path) -> PathBuf {
    let expanded = if let Some(rest) = target.strip_prefix("~/") {
        dirs::home_dir()
            .map(|home| home.join(rest))
            .unwrap_or_else(|| PathBuf::from(target))
    } else {
        PathBuf::from(target)
    };
    if expanded.is_absolute() {
        expanded
    } else {
        include_base.join(expanded)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hosts_of(contents: &str) -> Vec<String> {
        let mut hosts = Vec::new();
        collect_hosts(contents, Path::new("/nonexistent"), 0, &mut hosts);
        hosts
    }

    #[test]
    fn collects_concrete_aliases() {
        let hosts = hosts_of("Host devbox\n  HostName dev.example.com\nHost other\n");
        assert_eq!(hosts, vec!["devbox", "other"]);
    }

    #[test]
    fn skips_wildcards_and_negations() {
        let hosts = hosts_of("Host *\nHost dev-*\nHost !prod\nHost real\n");
        assert_eq!(hosts, vec!["real"]);
    }

    #[test]
    fn handles_multiple_aliases_per_line_and_equals_form() {
        let hosts = hosts_of("Host devbox staging\nHost=prod-jump\n");
        assert_eq!(hosts, vec!["devbox", "staging", "prod-jump"]);
    }

    #[test]
    fn dedupes_preserving_order() {
        let hosts = hosts_of("Host a\nHost b a\n");
        assert_eq!(hosts, vec!["a", "b"]);
    }

    #[test]
    fn ignores_comments_and_unrelated_directives() {
        let hosts = hosts_of("# Host commented\nUser damien\nHost real\n  Port 22\n");
        assert_eq!(hosts, vec!["real"]);
    }

    #[test]
    fn keyword_matching_is_case_insensitive() {
        let hosts = hosts_of("HOST upper\nhost lower\n");
        assert_eq!(hosts, vec!["upper", "lower"]);
    }

    #[test]
    fn include_of_missing_file_is_ignored() {
        let hosts = hosts_of("Include /definitely/not/a/file\nHost real\n");
        assert_eq!(hosts, vec!["real"]);
    }

    #[test]
    fn includes_resolve_relative_paths_and_cap_depth() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("extra"), "Host included\nInclude loop\n").unwrap();
        std::fs::write(dir.path().join("loop"), "Include loop\nHost looped\n").unwrap();

        let mut hosts = Vec::new();
        collect_hosts("Include extra\nHost main\n", dir.path(), 0, &mut hosts);
        assert!(hosts.contains(&"included".to_string()));
        assert!(hosts.contains(&"main".to_string()));
        // Depth cap terminates the self-including file without recursion blowup.
        assert!(hosts.contains(&"looped".to_string()));
    }
}
