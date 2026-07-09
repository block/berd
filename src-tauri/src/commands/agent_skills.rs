use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use serde::Deserialize;

const SKILL_FILE_NAME: &str = "SKILL.md";
const MAX_SKILL_FILE_BYTES: u64 = 262_144;

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListAgentSkillsRequest {
    pub provider_id: Option<String>,
    pub workspace_paths: Vec<String>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSkillEntry {
    pub name: String,
    pub description: String,
    pub content: String,
    pub path: String,
    pub file_location: String,
    pub source_kind: String,
    pub source_label: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListAgentSkillsResponse {
    pub skills: Vec<AgentSkillEntry>,
}

#[derive(Deserialize)]
struct SkillFrontmatter {
    name: Option<String>,
    description: Option<String>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum SkillRootScope {
    User,
    Workspace,
}

struct SkillRoot {
    path: PathBuf,
    source_label: String,
    scope: SkillRootScope,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum SkillProviderFamily {
    Claude,
    Codex,
    Gemini,
    Standard,
}

fn provider_family(provider_id: Option<&str>) -> SkillProviderFamily {
    let normalized = provider_id.unwrap_or_default().to_ascii_lowercase();
    if normalized.contains("claude") {
        SkillProviderFamily::Claude
    } else if normalized.contains("codex") {
        SkillProviderFamily::Codex
    } else if normalized.contains("gemini") {
        SkillProviderFamily::Gemini
    } else {
        SkillProviderFamily::Standard
    }
}

fn expand_home_prefix(path: &str) -> PathBuf {
    match dirs::home_dir() {
        Some(home) if path == "~" => home,
        Some(home) => path
            .strip_prefix("~/")
            .or_else(|| path.strip_prefix("~\\"))
            .map_or_else(|| PathBuf::from(path), |relative| home.join(relative)),
        None => PathBuf::from(path),
    }
}

fn provider_skill_dirs(provider_id: Option<&str>) -> Vec<&'static str> {
    match provider_family(provider_id) {
        SkillProviderFamily::Claude => vec![".agents/skills", ".claude/skills"],
        SkillProviderFamily::Codex => vec![".agents/skills", ".codex/skills"],
        SkillProviderFamily::Gemini => vec![".gemini/skills", ".agents/skills"],
        SkillProviderFamily::Standard => vec![".agents/skills"],
    }
}

fn find_git_root(start_dir: &Path) -> Option<PathBuf> {
    let mut check_dir = start_dir;

    loop {
        if check_dir.join(".git").exists() {
            return Some(check_dir.to_path_buf());
        }
        if let Some(parent) = check_dir.parent() {
            check_dir = parent;
        } else {
            return None;
        }
    }
}

fn workspace_search_dirs(workspace_path: &Path) -> Vec<PathBuf> {
    let root = find_git_root(workspace_path).unwrap_or_else(|| workspace_path.to_path_buf());
    let mut dirs: Vec<PathBuf> = workspace_path
        .ancestors()
        .take_while(|dir| dir.starts_with(&root))
        .map(Path::to_path_buf)
        .collect();
    dirs.reverse();
    dirs
}

fn display_name_for_path(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| path.to_string_lossy().into_owned())
}

fn skill_frontmatter(contents: &str) -> Option<(&str, &str)> {
    let contents = contents.strip_prefix("---\n")?;
    let end = contents.find("\n---")?;
    let frontmatter = &contents[..end];
    let body_start = end + "\n---".len();
    let body = contents[body_start..]
        .strip_prefix("\r\n")
        .or_else(|| contents[body_start..].strip_prefix('\n'))
        .unwrap_or(&contents[body_start..]);
    Some((frontmatter, body))
}

fn read_skill(skill_dir: &Path, root: &SkillRoot) -> Option<AgentSkillEntry> {
    let skill_file = skill_dir.join(SKILL_FILE_NAME);
    let metadata = match root.scope {
        SkillRootScope::User => std::fs::metadata(&skill_file).ok()?,
        SkillRootScope::Workspace => std::fs::symlink_metadata(&skill_file).ok()?,
    };
    if !metadata.file_type().is_file() || metadata.len() > MAX_SKILL_FILE_BYTES {
        return None;
    }

    let content = std::fs::read_to_string(&skill_file).ok()?;
    let (frontmatter, _body) = skill_frontmatter(&content)?;
    let parsed = yaml_serde::from_str::<SkillFrontmatter>(frontmatter).ok()?;
    let name = parsed.name?.trim().to_string();
    let description = parsed.description?.trim().to_string();
    if name.is_empty() || description.is_empty() {
        return None;
    }

    let canonical_skill_dir = skill_dir.canonicalize().ok()?;
    let canonical_skill_file = skill_file.canonicalize().ok()?;

    Some(AgentSkillEntry {
        name,
        description,
        content,
        path: canonical_skill_dir.to_string_lossy().into_owned(),
        file_location: canonical_skill_file.to_string_lossy().into_owned(),
        source_kind: match root.scope {
            SkillRootScope::User => "global",
            SkillRootScope::Workspace => "project",
        }
        .to_string(),
        source_label: root.source_label.clone(),
    })
}

fn add_skill_root(
    roots: &mut Vec<SkillRoot>,
    seen_roots: &mut HashSet<PathBuf>,
    root_path: PathBuf,
    scope: SkillRootScope,
    source_label: String,
    workspace_root: Option<&Path>,
) {
    let metadata = match scope {
        SkillRootScope::User => std::fs::metadata(&root_path),
        SkillRootScope::Workspace => std::fs::symlink_metadata(&root_path),
    };
    let Ok(metadata) = metadata else {
        return;
    };
    if !metadata.file_type().is_dir() {
        return;
    }
    let Ok(canonical_root) = root_path.canonicalize() else {
        return;
    };
    if matches!(scope, SkillRootScope::Workspace)
        && !workspace_root
            .map(|root| canonical_root.starts_with(root))
            .unwrap_or(false)
    {
        return;
    }
    if !seen_roots.insert(canonical_root.clone()) {
        return;
    }
    roots.push(SkillRoot {
        path: canonical_root,
        source_label,
        scope,
    });
}

fn collect_skill_roots(provider_id: Option<&str>, workspace_paths: Vec<String>) -> Vec<SkillRoot> {
    let provider_dirs = provider_skill_dirs(provider_id);
    let mut roots = Vec::new();
    let mut seen_roots = HashSet::new();

    if let Some(home) = dirs::home_dir() {
        for relative_dir in &provider_dirs {
            add_skill_root(
                &mut roots,
                &mut seen_roots,
                home.join(relative_dir),
                SkillRootScope::User,
                "Personal".to_string(),
                None,
            );
        }
    }
    if provider_family(provider_id) == SkillProviderFamily::Codex {
        add_skill_root(
            &mut roots,
            &mut seen_roots,
            PathBuf::from("/etc/codex/skills"),
            SkillRootScope::User,
            "Admin".to_string(),
            None,
        );
    }

    let mut seen_workspaces = HashSet::new();
    for raw_workspace_path in workspace_paths {
        let trimmed = raw_workspace_path.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(workspace_path) = expand_home_prefix(trimmed).canonicalize() else {
            continue;
        };
        if !workspace_path.is_dir() || !seen_workspaces.insert(workspace_path.clone()) {
            continue;
        }

        for search_dir in workspace_search_dirs(&workspace_path) {
            let label = display_name_for_path(&search_dir);
            for relative_dir in &provider_dirs {
                add_skill_root(
                    &mut roots,
                    &mut seen_roots,
                    search_dir.join(relative_dir),
                    SkillRootScope::Workspace,
                    label.clone(),
                    Some(&search_dir),
                );
            }
        }
    }

    roots
}

fn collect_agent_skills(
    provider_id: Option<String>,
    workspace_paths: Vec<String>,
) -> Vec<AgentSkillEntry> {
    let roots = collect_skill_roots(provider_id.as_deref(), workspace_paths);
    let mut seen_skill_paths = HashSet::new();
    let mut skills = Vec::new();

    for root in roots {
        let mut candidate_dirs = Vec::new();
        if root.path.join(SKILL_FILE_NAME).is_file() {
            candidate_dirs.push(root.path.clone());
        }
        if let Ok(entries) = std::fs::read_dir(&root.path) {
            for entry in entries.flatten() {
                let path = entry.path();
                let metadata = match root.scope {
                    SkillRootScope::User => std::fs::metadata(&path),
                    SkillRootScope::Workspace => std::fs::symlink_metadata(&path),
                };
                let Ok(metadata) = metadata else {
                    continue;
                };
                if !metadata.file_type().is_dir() {
                    continue;
                }
                if path.join(SKILL_FILE_NAME).is_file() {
                    candidate_dirs.push(path);
                }
            }
        }

        for candidate_dir in candidate_dirs {
            let Ok(canonical_candidate_dir) = candidate_dir.canonicalize() else {
                continue;
            };
            if !seen_skill_paths.insert(canonical_candidate_dir.clone()) {
                continue;
            }
            if let Some(skill) = read_skill(&canonical_candidate_dir, &root) {
                skills.push(skill);
            }
        }
    }

    if provider_family(provider_id.as_deref()) == SkillProviderFamily::Gemini {
        let mut order = Vec::new();
        let mut skills_by_name = HashMap::new();
        for skill in skills {
            let key = skill.name.to_ascii_lowercase();
            if !skills_by_name.contains_key(&key) {
                order.push(key.clone());
            }
            skills_by_name.insert(key, skill);
        }
        skills = order
            .into_iter()
            .filter_map(|key| skills_by_name.remove(&key))
            .collect();
    }

    skills.sort_by(|a, b| {
        a.name
            .to_ascii_lowercase()
            .cmp(&b.name.to_ascii_lowercase())
            .then_with(|| a.file_location.cmp(&b.file_location))
    });
    skills
}

#[tauri::command]
pub async fn list_agent_skills(
    request: ListAgentSkillsRequest,
) -> Result<ListAgentSkillsResponse, String> {
    let skills = tokio::task::spawn_blocking(move || {
        collect_agent_skills(request.provider_id, request.workspace_paths)
    })
    .await
    .map_err(|err| format!("Failed to list agent skills: {err}"))?;
    Ok(ListAgentSkillsResponse { skills })
}

#[cfg(test)]
mod tests {
    use super::collect_agent_skills;
    use std::fs;
    use tempfile::TempDir;

    fn write_skill(root: &std::path::Path, name: &str, description: &str) {
        let skill_dir = root.join(name);
        fs::create_dir_all(&skill_dir).unwrap();
        fs::write(
            skill_dir.join("SKILL.md"),
            format!("---\nname: {name}\ndescription: {description}\n---\n\nUse it."),
        )
        .unwrap();
    }

    #[test]
    fn lists_agents_skills_from_git_root_to_workspace() {
        let tmp = TempDir::new().unwrap();
        let repo = tmp.path().join("repo");
        let package = repo.join("packages").join("builderbot");
        fs::create_dir_all(package.join(".agents").join("skills")).unwrap();
        fs::create_dir(repo.join(".git")).unwrap();
        fs::create_dir_all(repo.join(".agents").join("skills")).unwrap();
        write_skill(
            &repo.join(".agents").join("skills"),
            "repo-skill",
            "Repo skill",
        );
        write_skill(
            &package.join(".agents").join("skills"),
            "package-skill",
            "Package skill",
        );

        let skills = collect_agent_skills(
            Some("codex-acp".to_string()),
            vec![package.to_string_lossy().into_owned()],
        );

        let names: Vec<&str> = skills.iter().map(|skill| skill.name.as_str()).collect();
        assert!(names.contains(&"package-skill"));
        assert!(names.contains(&"repo-skill"));
    }

    #[test]
    fn includes_provider_specific_skill_directories() {
        let tmp = TempDir::new().unwrap();
        let repo = tmp.path().join("repo");
        fs::create_dir_all(repo.join(".claude").join("skills")).unwrap();
        write_skill(
            &repo.join(".claude").join("skills"),
            "claude-review",
            "Claude review",
        );

        let skills = collect_agent_skills(
            Some("claude-acp".to_string()),
            vec![repo.to_string_lossy().into_owned()],
        );

        assert!(skills
            .iter()
            .any(|skill| skill.name == "claude-review" && skill.description == "Claude review"));
    }

    #[test]
    fn gemini_prefers_agents_alias_over_gemini_dir_for_duplicate_names() {
        let tmp = TempDir::new().unwrap();
        let repo = tmp.path().join("repo");
        fs::create_dir_all(repo.join(".gemini").join("skills")).unwrap();
        fs::create_dir_all(repo.join(".agents").join("skills")).unwrap();
        write_skill(
            &repo.join(".gemini").join("skills"),
            "shared-skill",
            "Gemini skill",
        );
        write_skill(
            &repo.join(".agents").join("skills"),
            "shared-skill",
            "Agents alias skill",
        );

        let skills = collect_agent_skills(
            Some("gemini-acp".to_string()),
            vec![repo.to_string_lossy().into_owned()],
        );

        let matching_skills: Vec<&super::AgentSkillEntry> = skills
            .iter()
            .filter(|skill| skill.name == "shared-skill")
            .collect();
        assert_eq!(matching_skills.len(), 1);
        assert_eq!(matching_skills[0].description, "Agents alias skill");
    }

    #[cfg(unix)]
    #[test]
    fn ignores_workspace_skill_files_that_are_symlinks() {
        let tmp = TempDir::new().unwrap();
        let repo = tmp.path().join("repo");
        let skill_dir = repo.join(".agents").join("skills").join("leaked");
        fs::create_dir_all(&skill_dir).unwrap();
        fs::create_dir(repo.join(".git")).unwrap();
        let outside = tmp.path().join("outside-skill.md");
        fs::write(
            &outside,
            "---\nname: leaked\ndescription: Leaked skill\n---\n\nSecret.",
        )
        .unwrap();
        std::os::unix::fs::symlink(&outside, skill_dir.join("SKILL.md")).unwrap();

        let skills = collect_agent_skills(
            Some("codex-acp".to_string()),
            vec![repo.to_string_lossy().into_owned()],
        );

        assert!(skills.iter().all(|skill| skill.name != "leaked"));
    }

    #[cfg(unix)]
    #[test]
    fn ignores_workspace_skill_roots_that_are_symlinks() {
        let tmp = TempDir::new().unwrap();
        let repo = tmp.path().join("repo");
        let outside_root = tmp.path().join("outside-skills");
        fs::create_dir_all(&outside_root).unwrap();
        fs::create_dir_all(repo.join(".agents")).unwrap();
        fs::create_dir(repo.join(".git")).unwrap();
        write_skill(&outside_root, "outside", "Outside skill");
        std::os::unix::fs::symlink(&outside_root, repo.join(".agents").join("skills")).unwrap();

        let skills = collect_agent_skills(
            Some("codex-acp".to_string()),
            vec![repo.to_string_lossy().into_owned()],
        );

        assert!(skills.iter().all(|skill| skill.name != "outside"));
    }

    #[cfg(unix)]
    #[test]
    fn ignores_workspace_skill_roots_that_escape_through_intermediate_symlinks() {
        let tmp = TempDir::new().unwrap();
        let repo = tmp.path().join("repo");
        let outside_agents = tmp.path().join("outside-agents");
        let outside_skills = outside_agents.join("skills");
        fs::create_dir_all(&outside_skills).unwrap();
        fs::create_dir_all(&repo).unwrap();
        fs::create_dir(repo.join(".git")).unwrap();
        write_skill(&outside_skills, "outside", "Outside skill");
        std::os::unix::fs::symlink(&outside_agents, repo.join(".agents")).unwrap();

        let skills = collect_agent_skills(
            Some("codex-acp".to_string()),
            vec![repo.to_string_lossy().into_owned()],
        );

        assert!(skills.iter().all(|skill| skill.name != "outside"));
    }
}
