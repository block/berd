use futures_util::{stream, StreamExt};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tokio::process::Command;
use tokio::time::timeout;
use url::Url;

use crate::services::dir_env;

const MAX_PULL_REQUESTS: usize = 12;
const GH_COMMAND_TIMEOUT: Duration = Duration::from_secs(20);
const ENV_CAPTURE_TIMEOUT: Duration = Duration::from_secs(15);
const GH_CONCURRENCY: usize = 4;

#[derive(Clone, Debug, PartialEq, Eq)]
struct PullRequestRef {
    url: String,
    repo_slug: String,
    number: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestSummary {
    url: String,
    repo_slug: String,
    number: u64,
    title: Option<String>,
    state: Option<String>,
    is_draft: Option<bool>,
    checks_status: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GhPullRequest {
    title: Option<String>,
    state: Option<String>,
    is_draft: Option<bool>,
    status_check_rollup: Option<Vec<GhStatusCheck>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GhStatusCheck {
    state: Option<String>,
    status: Option<String>,
    conclusion: Option<String>,
}

fn parse_github_pull_request_url(value: &str) -> Option<PullRequestRef> {
    let parsed = Url::parse(value).ok()?;
    if parsed.scheme() != "https" || parsed.host_str()? != "github.com" {
        return None;
    }

    let segments = parsed.path_segments()?.collect::<Vec<_>>();
    if segments.len() < 4 || segments[2] != "pull" {
        return None;
    }
    let owner = segments[0];
    let repo = segments[1];
    let number = segments[3].parse::<u64>().ok()?;
    if owner.is_empty() || repo.is_empty() || number == 0 {
        return None;
    }

    let repo_slug = format!("{owner}/{repo}");
    Some(PullRequestRef {
        url: format!("https://github.com/{repo_slug}/pull/{number}"),
        repo_slug,
        number,
    })
}

fn classify_check(check: &GhStatusCheck) -> &'static str {
    let conclusion = check.conclusion.as_deref().unwrap_or("").to_uppercase();
    let status = check.status.as_deref().unwrap_or("").to_uppercase();
    let state = check.state.as_deref().unwrap_or("").to_uppercase();

    if matches!(conclusion.as_str(), "SUCCESS" | "NEUTRAL" | "SKIPPED") {
        "SUCCESS"
    } else if matches!(
        conclusion.as_str(),
        "FAILURE" | "CANCELLED" | "TIMED_OUT" | "ACTION_REQUIRED" | "STARTUP_FAILURE" | "STALE"
    ) || matches!(state.as_str(), "FAILURE" | "ERROR")
    {
        "FAILURE"
    } else if status == "COMPLETED" || state == "SUCCESS" {
        "SUCCESS"
    } else {
        "PENDING"
    }
}

fn summarize_checks(checks: Option<&[GhStatusCheck]>) -> Option<String> {
    let checks = checks?;
    if checks.is_empty() {
        return None;
    }

    let classifications = checks.iter().map(classify_check).collect::<Vec<_>>();
    if classifications.contains(&"FAILURE") {
        Some("FAILURE".to_string())
    } else if classifications.iter().all(|state| *state == "SUCCESS") {
        Some("SUCCESS".to_string())
    } else {
        Some("PENDING".to_string())
    }
}

fn fallback_summary(reference: &PullRequestRef) -> PullRequestSummary {
    PullRequestSummary {
        url: reference.url.clone(),
        repo_slug: reference.repo_slug.clone(),
        number: reference.number,
        title: None,
        state: None,
        is_draft: None,
        checks_status: None,
    }
}

fn build_gh_command(gh: &Path, reference: &PullRequestRef, cwd: &Path) -> Command {
    let mut command = Command::new(gh);
    command
        .args([
            "pr",
            "view",
            reference.url.as_str(),
            "--json",
            "title,state,isDraft,statusCheckRollup",
        ])
        .current_dir(cwd)
        .env("GH_PROMPT_DISABLED", "1")
        .kill_on_drop(true);
    command
}

async fn fetch_summary(
    reference: PullRequestRef,
    cwd: &Path,
    env: Option<&HashMap<String, String>>,
    gh: Option<&Path>,
) -> PullRequestSummary {
    let Some(gh) = gh else {
        log::debug!("Trusted GitHub CLI executable was not found");
        return fallback_summary(&reference);
    };
    let mut command = build_gh_command(gh, &reference, cwd);
    if let Some(env) = env {
        command.env_clear().envs(env).env("GH_PROMPT_DISABLED", "1");
    }

    let output = match timeout(GH_COMMAND_TIMEOUT, command.output()).await {
        Ok(Ok(output)) if output.status.success() => output,
        Ok(Ok(output)) => {
            log::debug!(
                "gh pr view failed for {}: {}",
                reference.url,
                String::from_utf8_lossy(&output.stderr).trim()
            );
            return fallback_summary(&reference);
        }
        Ok(Err(error)) => {
            log::debug!("Could not run gh for {}: {error}", reference.url);
            return fallback_summary(&reference);
        }
        Err(_) => {
            log::debug!("gh pr view timed out for {}", reference.url);
            return fallback_summary(&reference);
        }
    };

    let response = match serde_json::from_slice::<GhPullRequest>(&output.stdout) {
        Ok(response) => response,
        Err(error) => {
            log::debug!("Could not parse gh response for {}: {error}", reference.url);
            return fallback_summary(&reference);
        }
    };

    PullRequestSummary {
        url: reference.url,
        repo_slug: reference.repo_slug,
        number: reference.number,
        title: response.title.filter(|title| !title.trim().is_empty()),
        state: response.state,
        is_draft: response.is_draft,
        checks_status: summarize_checks(response.status_check_rollup.as_deref()),
    }
}

#[tauri::command]
pub async fn get_pull_request_summaries(
    urls: Vec<String>,
    path: Option<String>,
) -> Result<Vec<PullRequestSummary>, String> {
    let mut seen = HashSet::new();
    let references = urls
        .iter()
        .filter_map(|url| parse_github_pull_request_url(url))
        .filter(|reference| seen.insert(reference.url.to_lowercase()))
        .take(MAX_PULL_REQUESTS)
        .collect::<Vec<_>>();
    if references.is_empty() {
        return Ok(Vec::new());
    }

    let cwd = path
        .map(PathBuf::from)
        .filter(|path| path.is_dir())
        .or_else(dirs::home_dir)
        .ok_or_else(|| "Could not resolve a directory for GitHub CLI".to_string())?;
    // Resolve before capturing the project environment, which can prepend the
    // repository's Hermit bin on Windows.
    let gh = dir_env::resolve_control_executable("gh");
    let env = dir_env::capture_dir_env(&cwd, ENV_CAPTURE_TIMEOUT).await;

    Ok(stream::iter(references.into_iter().map(|reference| {
        let cwd = cwd.clone();
        let env = env.clone();
        let gh = gh.clone();
        async move { fetch_summary(reference, &cwd, env.as_ref(), gh.as_deref()).await }
    }))
    .buffered(GH_CONCURRENCY)
    .collect()
    .await)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn gh_command_program_is_not_resolved_from_captured_path() {
        let reference = parse_github_pull_request_url("https://github.com/block/berd/pull/1")
            .expect("pull request");
        let trusted_gh = PathBuf::from(r"C:\Program Files\GitHub CLI\gh.exe");
        let project_bin = PathBuf::from(r"C:\repo\.hermit\bin");
        let path = std::env::join_paths([project_bin.clone(), PathBuf::from(r"C:\Windows")])
            .expect("captured PATH");
        let mut command = build_gh_command(&trusted_gh, &reference, Path::new(r"C:\repo"));
        command.env_clear().env("Path", path);

        assert_eq!(command.as_std().get_program(), trusted_gh.as_os_str());
        let command_path = command
            .as_std()
            .get_envs()
            .find_map(|(key, value)| key.eq_ignore_ascii_case("PATH").then_some(value).flatten())
            .expect("command PATH");
        assert_eq!(
            std::env::split_paths(command_path).next().as_deref(),
            Some(project_bin.as_path())
        );
    }

    fn check(conclusion: Option<&str>, status: Option<&str>, state: Option<&str>) -> GhStatusCheck {
        GhStatusCheck {
            conclusion: conclusion.map(str::to_string),
            status: status.map(str::to_string),
            state: state.map(str::to_string),
        }
    }

    #[test]
    fn parses_and_canonicalizes_github_pull_request_urls() {
        assert_eq!(
            parse_github_pull_request_url("https://github.com/squareup/berd/pull/42/files"),
            Some(PullRequestRef {
                url: "https://github.com/squareup/berd/pull/42".to_string(),
                repo_slug: "squareup/berd".to_string(),
                number: 42,
            })
        );
        assert!(parse_github_pull_request_url("http://github.com/a/b/pull/1").is_none());
        assert!(parse_github_pull_request_url("https://example.com/a/b/pull/1").is_none());
    }

    #[test]
    fn summarizes_check_rollups() {
        let passing = vec![
            check(Some("SUCCESS"), Some("COMPLETED"), None),
            check(Some("NEUTRAL"), Some("COMPLETED"), None),
        ];
        assert_eq!(
            summarize_checks(Some(&passing)),
            Some("SUCCESS".to_string())
        );

        let pending = vec![
            check(Some("SUCCESS"), Some("COMPLETED"), None),
            check(None, Some("IN_PROGRESS"), None),
        ];
        assert_eq!(
            summarize_checks(Some(&pending)),
            Some("PENDING".to_string())
        );

        let failing = vec![
            check(Some("FAILURE"), Some("COMPLETED"), None),
            check(Some("STARTUP_FAILURE"), Some("COMPLETED"), None),
            check(Some("STALE"), Some("COMPLETED"), None),
        ];
        assert_eq!(
            summarize_checks(Some(&failing)),
            Some("FAILURE".to_string())
        );
        assert_eq!(summarize_checks(Some(&[])), None);
    }
}
