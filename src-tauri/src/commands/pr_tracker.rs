use futures_util::{stream, StreamExt};
use serde::{Deserialize, Serialize};
use std::process::Stdio;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri_plugin_opener::OpenerExt;
use tokio::process::Command as TokioCommand;
use tokio::time::timeout;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestIdentity {
    id: String,
    url: String,
    repository: String,
    head_repository: Option<String>,
    head_ref_name: String,
}

type ProjectGitIdentity = (String, Option<(String, String)>);

#[derive(Serialize)]
struct PullRequestUrlMatch {
    url: String,
}

const COMMAND_TIMEOUT: Duration = Duration::from_secs(30);
const PROJECT_RESOLUTION_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_PULL_REQUESTS: usize = 250;
const MAX_WORKSPACE_CANDIDATES: usize = 25;
const MAX_MESSAGE_CANDIDATES: i64 = 2_000;
const MAX_ID_LENGTH: usize = 256;
const MAX_REPOSITORY_LENGTH: usize = 256;
const MAX_BRANCH_LENGTH: usize = 512;
const GIT_PROBE_CONCURRENCY: usize = 4;
const WORKSPACE_CANDIDATES_QUERY: &str = r#"
WITH session_activity AS (
  SELECT s.id,
         s.working_dir,
         s.project_id,
         COALESCE(
           MAX(
             CASE
               WHEN m.created_timestamp > 10000000000
                 THEN m.created_timestamp / 1000
               ELSE m.created_timestamp
             END
           ),
           CASE
             WHEN unixepoch(s.updated_at) >= unixepoch(s.created_at)
               THEN unixepoch(s.updated_at)
             ELSE COALESCE(unixepoch(s.created_at), unixepoch(s.updated_at))
           END
         ) AS activity_at
  FROM sessions s
  LEFT JOIN messages m ON m.session_id = s.id
  WHERE s.archived_at IS NULL
    AND COALESCE(s.session_type, 'user') IN ('user', 'acp')
    AND s.project_id IS NOT NULL
    AND TRIM(s.project_id) != ''
    AND s.working_dir IS NOT NULL
    AND TRIM(s.working_dir) != ''
  GROUP BY s.id, s.working_dir, s.project_id, s.created_at, s.updated_at
), ranked_workspaces AS (
  SELECT id,
         working_dir,
         project_id,
         activity_at,
         ROW_NUMBER() OVER (
           PARTITION BY working_dir
           ORDER BY activity_at DESC, id DESC
         ) AS workspace_rank
  FROM session_activity
)
SELECT id, working_dir, project_id, activity_at
FROM ranked_workspaces
WHERE workspace_rank = 1
ORDER BY activity_at DESC, id DESC
LIMIT ?
"#;
static PROJECT_BY_PR_URL_CACHE: OnceLock<Mutex<std::collections::HashMap<String, String>>> =
    OnceLock::new();

fn project_by_pr_url_cache() -> &'static Mutex<std::collections::HashMap<String, String>> {
    PROJECT_BY_PR_URL_CACHE.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
}

const PULL_REQUEST_QUERY: &str = r#"
query($q:String!,$after:String){search(query:$q,type:ISSUE,first:50,after:$after){
  pageInfo{hasNextPage endCursor}
  nodes{... on PullRequest{
    id number title url isDraft updatedAt mergeable mergeStateStatus reviewDecision headRefName
    repository{nameWithOwner}
    headRepository{nameWithOwner}
    commits(last:1){nodes{commit{statusCheckRollup{state}}}}
  }}
}}
"#;

#[tauri::command]
pub async fn list_pr_tracker_pull_requests() -> Result<String, String> {
    timeout(COMMAND_TIMEOUT, list_pr_tracker_pull_requests_inner())
        .await
        .map_err(|_| "GitHub CLI timed out".to_string())?
}

async fn list_pr_tracker_pull_requests_inner() -> Result<String, String> {
    let shell_env = crate::services::dir_env::capture_home_interactive_env().await;
    let executable = find_executable("gh", shell_env.get("PATH").map(String::as_str))
        .ok_or_else(|| "GitHub CLI was not found".to_string())?;
    let mut after: Option<String> = None;
    let mut nodes = Vec::new();
    let mut is_truncated = false;

    loop {
        let mut command = TokioCommand::new(&executable);
        command.args([
            "api",
            "graphql",
            "-f",
            &format!("query={PULL_REQUEST_QUERY}"),
            "-f",
            "q=is:pr is:open author:@me",
        ]);
        if let Some(cursor) = after.as_deref() {
            command.args(["-f", &format!("after={cursor}")]);
        }
        command.kill_on_drop(true);
        command.stdin(Stdio::null());
        command.stdout(Stdio::piped());
        command.stderr(Stdio::piped());
        if let Some(path) = shell_env.get("PATH") {
            command.env("PATH", path);
        }

        let output = command
            .output()
            .await
            .map_err(|error| format!("Failed to run GitHub CLI: {error}"))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            return Err(if stderr.is_empty() {
                format!("GitHub CLI exited with status {}", output.status)
            } else {
                stderr
            });
        }

        let page: serde_json::Value = serde_json::from_slice(&output.stdout)
            .map_err(|error| format!("Invalid GitHub response: {error}"))?;
        let search = &page["data"]["search"];
        let page_nodes = search["nodes"]
            .as_array()
            .ok_or_else(|| "GitHub response did not include pull requests".to_string())?;
        nodes.extend(
            page_nodes
                .iter()
                .take(MAX_PULL_REQUESTS.saturating_sub(nodes.len()))
                .cloned(),
        );
        let has_next_page = search["pageInfo"]["hasNextPage"].as_bool() == Some(true);
        if nodes.len() >= MAX_PULL_REQUESTS {
            is_truncated = has_next_page || page_nodes.len() > MAX_PULL_REQUESTS;
            break;
        }
        if !has_next_page {
            break;
        }
        after = search["pageInfo"]["endCursor"].as_str().map(str::to_string);
        if after.is_none() {
            return Err("GitHub response omitted the next page cursor".to_string());
        }
    }

    serde_json::to_string(&serde_json::json!({
        "data": { "search": { "nodes": nodes } },
        "isTruncated": is_truncated,
    }))
    .map_err(|error| format!("Failed to encode GitHub response: {error}"))
}

#[tauri::command]
pub async fn resolve_pr_tracker_projects(
    pull_requests: Vec<PullRequestIdentity>,
) -> Result<std::collections::HashMap<String, Option<String>>, String> {
    let pull_requests = validate_pull_requests(pull_requests)?;
    let fallback = pull_requests
        .iter()
        .map(|pr| (pr.id.clone(), None))
        .collect::<std::collections::HashMap<_, _>>();
    match timeout(
        PROJECT_RESOLUTION_TIMEOUT,
        resolve_pr_tracker_projects_inner(pull_requests),
    )
    .await
    {
        Ok(Ok(resolved)) => Ok(resolved),
        Ok(Err(error)) => Err(error),
        Err(_) => Ok(fallback),
    }
}

async fn resolve_pr_tracker_projects_inner(
    pull_requests: Vec<PullRequestIdentity>,
) -> Result<std::collections::HashMap<String, Option<String>>, String> {
    let canonical_db_path = crate::services::goose_config::state_dir()?
        .join("sessions")
        .join("sessions.db");
    let legacy_db_path = dirs::home_dir()
        .map(|home| {
            home.join(".local")
                .join("share")
                .join("goose")
                .join("sessions")
                .join("sessions.db")
        })
        .filter(|path| path.exists());
    let db_path = if canonical_db_path.exists() {
        canonical_db_path
    } else if std::env::var_os("GOOSE_PATH_ROOT").is_some() {
        return Ok(pull_requests.into_iter().map(|pr| (pr.id, None)).collect());
    } else if let Some(legacy_db_path) = legacy_db_path {
        legacy_db_path
    } else {
        return Ok(pull_requests.into_iter().map(|pr| (pr.id, None)).collect());
    };

    let db_url = format!("sqlite:{}?mode=ro", db_path.to_string_lossy());
    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect(&db_url)
        .await
        .map_err(|error| format!("Failed to open Berd chat database: {error}"))?;
    let rows = sqlx::query(WORKSPACE_CANDIDATES_QUERY)
        .bind(MAX_WORKSPACE_CANDIDATES as i64)
        .fetch_all(&pool)
        .await
        .map_err(|error| format!("Failed to read Berd chat projects: {error}"))?;

    let mut session_workspaces = Vec::with_capacity(rows.len());
    let mut seen_working_dirs = std::collections::HashSet::new();
    for row in rows {
        use sqlx::Row;
        let working_dir: Option<String> = row.try_get("working_dir").map_err(to_string)?;
        let Some(working_dir) = working_dir else {
            continue;
        };
        if !seen_working_dirs.insert(working_dir.clone()) {
            continue;
        }
        let project_id: String = row.try_get("project_id").map_err(to_string)?;
        session_workspaces.push((project_id, working_dir));
    }

    let mut project_by_url = project_by_pr_url_cache()
        .lock()
        .map_err(|_| "PR project cache is unavailable".to_string())?
        .clone();
    let requested_urls = pull_requests
        .iter()
        .filter(|pr| !project_by_url.contains_key(&pr.url))
        .map(|pr| PullRequestUrlMatch {
            url: pr.url.clone(),
        })
        .collect::<Vec<_>>();
    if !requested_urls.is_empty() {
        let requested_urls_json = serde_json::to_string(&requested_urls)
            .map_err(|error| format!("Failed to encode pull request URLs: {error}"))?;
        let message_matches = sqlx::query(
            r#"
            WITH requested_urls AS (
              SELECT json_extract(value, '$.url') AS url
              FROM json_each(?)
            ), recent_messages AS (
              SELECT id, session_id, content_json
              FROM messages
              WHERE role = 'assistant'
              ORDER BY id DESC
              LIMIT ?
            ), candidate_messages AS (
              SELECT requested_urls.url,
                     recent_messages.id AS message_id,
                     recent_messages.session_id,
                     recent_messages.content_json
              FROM requested_urls
              JOIN recent_messages
                ON INSTR(recent_messages.content_json, requested_urls.url) > 0
            ), text_matches AS (
              SELECT candidate_messages.url,
                     candidate_messages.message_id,
                     s.project_id
              FROM candidate_messages
              JOIN sessions s ON s.id = candidate_messages.session_id
              JOIN json_each(candidate_messages.content_json) AS content
              WHERE s.project_id IS NOT NULL
                AND TRIM(s.project_id) != ''
                AND json_extract(content.value, '$.type') = 'text'
                AND INSTR(json_extract(content.value, '$.text'), candidate_messages.url) > 0
                AND SUBSTR(
                      json_extract(content.value, '$.text'),
                      INSTR(json_extract(content.value, '$.text'), candidate_messages.url)
                        + LENGTH(candidate_messages.url),
                      1
                    ) NOT GLOB '[0-9]'
            )
            SELECT url, project_id
            FROM text_matches
            WHERE message_id = (
              SELECT MIN(first_match.message_id)
              FROM text_matches AS first_match
              WHERE first_match.url = text_matches.url
            )
            "#,
        )
        .bind(requested_urls_json)
        .bind(MAX_MESSAGE_CANDIDATES)
        .fetch_all(&pool)
        .await
        .map_err(|error| format!("Failed to match pull requests to Berd chats: {error}"))?;
        let mut cache = project_by_pr_url_cache()
            .lock()
            .map_err(|_| "PR project cache is unavailable".to_string())?;
        for row in message_matches {
            use sqlx::Row;
            let url: String = row.try_get("url").map_err(to_string)?;
            let project_id: String = row.try_get("project_id").map_err(to_string)?;
            project_by_url.insert(url.clone(), project_id.clone());
            cache.insert(url, project_id);
        }
    }

    let mut git_identities: Option<Vec<ProjectGitIdentity>> = None;
    let mut resolved = std::collections::HashMap::with_capacity(pull_requests.len());
    for pr in pull_requests {
        let repository =
            normalize_github_repository(pr.head_repository.as_deref().unwrap_or(&pr.repository));
        let project_id = if let Some(project_id) = project_by_url.get(&pr.url) {
            Some(project_id.clone())
        } else {
            if git_identities.is_none() {
                let mut identities = stream::iter(session_workspaces.iter().cloned().enumerate())
                    .map(|(index, (project_id, working_dir))| async move {
                        (
                            index,
                            project_id,
                            git_repository_and_branch(&working_dir).await,
                        )
                    })
                    .buffer_unordered(GIT_PROBE_CONCURRENCY)
                    .collect::<Vec<_>>()
                    .await;
                identities.sort_by_key(|(index, _, _)| *index);
                git_identities = Some(
                    identities
                        .into_iter()
                        .map(|(_, project_id, git_identity)| (project_id, git_identity))
                        .collect(),
                );
            }
            git_identities.as_ref().and_then(|sessions| {
                sessions.iter().find_map(|(project_id, git_identity)| {
                    let (session_repository, session_branch) = git_identity.as_ref()?;
                    (session_repository == &repository && session_branch == &pr.head_ref_name)
                        .then(|| project_id.clone())
                })
            })
        };
        resolved.insert(pr.id, project_id);
    }
    Ok(resolved)
}

#[tauri::command]
pub fn open_pr_tracker_url<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    url: String,
) -> Result<(), String> {
    validate_github_url(&url)?;
    app.opener()
        .open_url(&url, None::<&str>)
        .map_err(|error| format!("Failed to open URL: {error}"))
}

async fn git_repository_and_branch(working_dir: &str) -> Option<(String, String)> {
    let branch = git_output(working_dir, &["branch", "--show-current"]).await?;
    if branch.is_empty() {
        return None;
    }
    let remote = git_output(working_dir, &["remote", "get-url", "origin"]).await?;
    Some((normalize_github_repository(&remote), branch))
}

async fn git_output(working_dir: &str, args: &[&str]) -> Option<String> {
    let mut command = TokioCommand::new("git");
    command
        .args(["-C", working_dir])
        .args(args)
        .kill_on_drop(true)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let output = timeout(Duration::from_secs(5), command.output())
        .await
        .ok()?
        .ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn normalize_github_repository(value: &str) -> String {
    let value = value.trim().trim_end_matches(".git");
    let path = value
        .strip_prefix("git@github.com:")
        .or_else(|| value.strip_prefix("ssh://git@github.com/"))
        .or_else(|| value.strip_prefix("https://github.com/"))
        .or_else(|| value.strip_prefix("http://github.com/"))
        .unwrap_or(value);
    path.trim_matches('/').to_ascii_lowercase()
}

fn validate_pull_requests(
    pull_requests: Vec<PullRequestIdentity>,
) -> Result<Vec<PullRequestIdentity>, String> {
    if pull_requests.len() > MAX_PULL_REQUESTS {
        return Err(format!(
            "PR tracker accepts at most {MAX_PULL_REQUESTS} pull requests"
        ));
    }

    let mut seen_ids = std::collections::HashSet::with_capacity(pull_requests.len());
    for pull_request in &pull_requests {
        if pull_request.id.trim().is_empty() || pull_request.id.len() > MAX_ID_LENGTH {
            return Err("Pull request id is missing or too long".to_string());
        }
        if !seen_ids.insert(pull_request.id.as_str()) {
            return Err("Pull request ids must be unique".to_string());
        }
        if pull_request.repository.len() > MAX_REPOSITORY_LENGTH
            || pull_request
                .head_repository
                .as_ref()
                .is_some_and(|repository| repository.len() > MAX_REPOSITORY_LENGTH)
            || pull_request.head_ref_name.trim().is_empty()
            || pull_request.head_ref_name.len() > MAX_BRANCH_LENGTH
        {
            return Err("Pull request repository or branch is invalid".to_string());
        }
        let parsed = reqwest::Url::parse(&pull_request.url)
            .map_err(|error| format!("Invalid pull request URL: {error}"))?;
        if parsed.scheme() != "https" || parsed.host_str() != Some("github.com") {
            return Err("Pull request URLs must use https://github.com".to_string());
        }
        let segments = parsed
            .path_segments()
            .map(|segments| segments.collect::<Vec<_>>())
            .unwrap_or_default();
        if segments.len() != 4
            || segments[2] != "pull"
            || segments[3].parse::<u64>().is_err()
            || !format!("{}/{}", segments[0], segments[1])
                .eq_ignore_ascii_case(&pull_request.repository)
        {
            return Err("Pull request URL does not match its repository".to_string());
        }
    }
    Ok(pull_requests)
}

fn validate_github_url(url: &str) -> Result<(), String> {
    let parsed = reqwest::Url::parse(url).map_err(|error| format!("Invalid URL: {error}"))?;
    if parsed.scheme() != "https" {
        return Err("Only https URLs can be opened from PR tracker".to_string());
    }
    let host = parsed.host_str().unwrap_or_default();
    if host != "github.com" && !host.ends_with(".github.com") {
        return Err("Only GitHub URLs can be opened from PR tracker".to_string());
    }
    Ok(())
}

fn find_executable(name: &str, shell_path: Option<&str>) -> Option<std::path::PathBuf> {
    let executable_name = if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    };
    let mut directories = shell_path
        .map(std::env::split_paths)
        .into_iter()
        .flatten()
        .collect::<Vec<_>>();
    if let Some(path) = std::env::var_os("PATH") {
        directories.extend(std::env::split_paths(&path));
    }
    directories
        .into_iter()
        .map(|directory| directory.join(&executable_name))
        .find(|path| path.is_file())
}

fn to_string(error: impl std::fmt::Display) -> String {
    error.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pull_request(id: &str, url: &str, repository: &str) -> PullRequestIdentity {
        PullRequestIdentity {
            id: id.to_string(),
            url: url.to_string(),
            repository: repository.to_string(),
            head_repository: None,
            head_ref_name: "feature/test".to_string(),
        }
    }

    #[test]
    fn validates_pull_request_payload_bounds() {
        assert!(validate_pull_requests(vec![pull_request(
            "pr-1",
            "https://github.com/squareup/berd/pull/1",
            "squareup/berd",
        )])
        .is_ok());

        let duplicate = pull_request(
            "pr-1",
            "https://github.com/squareup/berd/pull/2",
            "squareup/berd",
        );
        assert!(validate_pull_requests(vec![
            pull_request(
                "pr-1",
                "https://github.com/squareup/berd/pull/1",
                "squareup/berd",
            ),
            duplicate,
        ])
        .is_err());
        assert!(validate_pull_requests(vec![pull_request(
            "pr-1",
            "https://github.com/squareup/other/pull/1",
            "squareup/berd",
        )])
        .is_err());
        assert!(validate_pull_requests(vec![pull_request(
            "pr-1",
            "https://example.com/squareup/berd/pull/1",
            "squareup/berd",
        )])
        .is_err());
    }

    #[tokio::test]
    async fn workspace_candidates_rank_by_latest_real_activity_before_limiting() {
        use sqlx::Row;

        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::query(
            r#"
            CREATE TABLE sessions (
              id TEXT PRIMARY KEY,
              working_dir TEXT,
              project_id TEXT,
              created_at TEXT,
              updated_at TEXT,
              archived_at TEXT,
              session_type TEXT
            );
            CREATE TABLE messages (
              id INTEGER PRIMARY KEY,
              session_id TEXT NOT NULL,
              created_timestamp INTEGER NOT NULL
            )
            "#,
        )
        .execute(&pool)
        .await
        .unwrap();

        for index in 0..MAX_WORKSPACE_CANDIDATES {
            sqlx::query("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, NULL, 'acp')")
                .bind(format!("candidate-{index}"))
                .bind(format!("/workspace/{index}"))
                .bind(format!("project-{index}"))
                .bind(format!("2026-08-{:02}T00:00:00Z", index + 1))
                .bind(format!("2026-08-{:02}T00:00:00Z", index + 1))
                .execute(&pool)
                .await
                .unwrap();
        }
        sqlx::query("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, NULL, 'acp')")
            .bind("skewed-old")
            .bind("/workspace/skewed")
            .bind("project-old")
            .bind("2026-07-01T00:00:00Z")
            .bind("2026-07-01T00:00:00Z")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, NULL, 'acp')")
            .bind("skewed-new")
            .bind("/workspace/skewed")
            .bind("project-new")
            .bind("2026-09-01T00:00:00Z")
            .bind("2026-01-01T00:00:00Z")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO messages VALUES (?, ?, ?)")
            .bind(1)
            .bind("skewed-new")
            .bind(1_790_812_800_000_i64)
            .execute(&pool)
            .await
            .unwrap();

        let rows = sqlx::query(WORKSPACE_CANDIDATES_QUERY)
            .bind(MAX_WORKSPACE_CANDIDATES as i64)
            .fetch_all(&pool)
            .await
            .unwrap();

        assert_eq!(rows.len(), MAX_WORKSPACE_CANDIDATES);
        assert_eq!(rows[0].get::<String, _>("id"), "skewed-new");
        assert_eq!(rows[0].get::<String, _>("project_id"), "project-new");
        assert_eq!(rows[0].get::<i64, _>("activity_at"), 1_790_812_800);
        assert!(!rows
            .iter()
            .any(|row| row.get::<String, _>("id") == "skewed-old"));
    }

    #[test]
    fn validates_only_github_https_urls() {
        assert!(validate_github_url("https://github.com/block/berd/pull/1").is_ok());
        assert!(validate_github_url("http://github.com/block/berd/pull/1").is_err());
        assert!(validate_github_url("https://example.com/block/berd/pull/1").is_err());
    }
}
