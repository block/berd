use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

const AGENTS_FILENAME: &str = "AGENTS.md";
const MAX_CONTEXT_FILE_BYTES: u64 = 131_072;

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadWorkspaceContextRequest {
    pub workspace_paths: Vec<String>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceInstructionFile {
    pub path: String,
    pub workspace_paths: Vec<String>,
    pub content: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadWorkspaceContextResponse {
    pub instruction_files: Vec<WorkspaceInstructionFile>,
}

#[derive(Clone)]
struct InstructionFileAccumulator {
    path: PathBuf,
    workspace_paths: Vec<String>,
    content: String,
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

fn instruction_search_dirs(workspace_path: &Path) -> Vec<PathBuf> {
    let root = find_git_root(workspace_path).unwrap_or_else(|| workspace_path.to_path_buf());
    let mut dirs: Vec<PathBuf> = workspace_path
        .ancestors()
        .take_while(|dir| dir.starts_with(&root))
        .map(Path::to_path_buf)
        .collect();
    dirs.reverse();
    dirs
}

fn read_instruction_file(path: &Path) -> Option<String> {
    let metadata = std::fs::symlink_metadata(path).ok()?;
    if !metadata.file_type().is_file() || metadata.len() > MAX_CONTEXT_FILE_BYTES {
        return None;
    }
    std::fs::read_to_string(path).ok()
}

fn collect_workspace_instruction_files(
    workspace_paths: Vec<String>,
) -> Vec<WorkspaceInstructionFile> {
    let mut seen_workspaces = HashSet::new();
    let mut files_by_path: HashMap<PathBuf, InstructionFileAccumulator> = HashMap::new();
    let mut ordered_paths: Vec<PathBuf> = Vec::new();

    for raw_workspace_path in workspace_paths {
        let trimmed = raw_workspace_path.trim();
        if trimmed.is_empty() {
            continue;
        }

        let workspace_path = expand_home_prefix(trimmed);
        let Ok(canonical_workspace_path) = workspace_path.canonicalize() else {
            continue;
        };
        if !canonical_workspace_path.is_dir() {
            continue;
        }

        let workspace_label = canonical_workspace_path.to_string_lossy().into_owned();
        if !seen_workspaces.insert(workspace_label.clone()) {
            continue;
        }

        for dir in instruction_search_dirs(&canonical_workspace_path) {
            let instruction_path = dir.join(AGENTS_FILENAME);
            let Some(content) = read_instruction_file(&instruction_path) else {
                continue;
            };
            let Ok(canonical_instruction_path) = instruction_path.canonicalize() else {
                continue;
            };

            match files_by_path.get_mut(&canonical_instruction_path) {
                Some(existing) => existing.workspace_paths.push(workspace_label.clone()),
                None => {
                    ordered_paths.push(canonical_instruction_path.clone());
                    files_by_path.insert(
                        canonical_instruction_path.clone(),
                        InstructionFileAccumulator {
                            path: canonical_instruction_path,
                            workspace_paths: vec![workspace_label.clone()],
                            content,
                        },
                    );
                }
            }
        }
    }

    ordered_paths
        .into_iter()
        .filter_map(|path| files_by_path.remove(&path))
        .map(|file| WorkspaceInstructionFile {
            path: file.path.to_string_lossy().into_owned(),
            workspace_paths: file.workspace_paths,
            content: file.content,
        })
        .collect()
}

#[tauri::command]
pub async fn load_workspace_context(
    request: LoadWorkspaceContextRequest,
) -> Result<LoadWorkspaceContextResponse, String> {
    let instruction_files = tokio::task::spawn_blocking(move || {
        collect_workspace_instruction_files(request.workspace_paths)
    })
    .await
    .map_err(|err| format!("Failed to load workspace context: {err}"))?;
    Ok(LoadWorkspaceContextResponse { instruction_files })
}

#[cfg(test)]
mod tests {
    use super::collect_workspace_instruction_files;
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn loads_agents_files_from_git_root_to_workspace() {
        let tmp = TempDir::new().unwrap();
        let repo = tmp.path().join("repo");
        let package = repo.join("packages").join("builderbot");
        fs::create_dir_all(&package).unwrap();
        fs::create_dir(repo.join(".git")).unwrap();
        fs::write(repo.join("AGENTS.md"), "repo instructions").unwrap();
        fs::write(
            repo.join("packages").join("AGENTS.md"),
            "package instructions",
        )
        .unwrap();
        fs::write(package.join("AGENTS.md"), "builderbot instructions").unwrap();

        let files =
            collect_workspace_instruction_files(vec![package.to_string_lossy().into_owned()]);

        let contents: Vec<&str> = files.iter().map(|file| file.content.as_str()).collect();
        assert_eq!(
            contents,
            vec![
                "repo instructions",
                "package instructions",
                "builderbot instructions"
            ]
        );
    }

    #[test]
    fn dedupes_shared_parent_agents_files() {
        let tmp = TempDir::new().unwrap();
        let repo = tmp.path().join("repo");
        let alpha = repo.join("alpha");
        let beta = repo.join("beta");
        fs::create_dir_all(&alpha).unwrap();
        fs::create_dir_all(&beta).unwrap();
        fs::create_dir(repo.join(".git")).unwrap();
        fs::write(repo.join("AGENTS.md"), "repo instructions").unwrap();
        fs::write(alpha.join("AGENTS.md"), "alpha instructions").unwrap();
        fs::write(beta.join("AGENTS.md"), "beta instructions").unwrap();

        let files = collect_workspace_instruction_files(vec![
            alpha.to_string_lossy().into_owned(),
            beta.to_string_lossy().into_owned(),
        ]);

        assert_eq!(files.len(), 3);
        assert_eq!(files[0].content, "repo instructions");
        assert_eq!(files[0].workspace_paths.len(), 2);
    }

    #[test]
    fn loads_only_selected_directory_when_no_git_root_exists() {
        let tmp = TempDir::new().unwrap();
        let parent = tmp.path().join("parent");
        let child = parent.join("child");
        fs::create_dir_all(&child).unwrap();
        fs::write(parent.join("AGENTS.md"), "parent instructions").unwrap();
        fs::write(child.join("AGENTS.md"), "child instructions").unwrap();

        let files = collect_workspace_instruction_files(vec![child.to_string_lossy().into_owned()]);

        assert_eq!(files.len(), 1);
        assert_eq!(files[0].content, "child instructions");
    }

    #[cfg(unix)]
    #[test]
    fn ignores_symlinked_agents_files() {
        let tmp = TempDir::new().unwrap();
        let repo = tmp.path().join("repo");
        fs::create_dir_all(&repo).unwrap();
        fs::create_dir(repo.join(".git")).unwrap();
        let outside = tmp.path().join("outside-secret.md");
        fs::write(&outside, "do not load").unwrap();
        std::os::unix::fs::symlink(&outside, repo.join("AGENTS.md")).unwrap();

        let files = collect_workspace_instruction_files(vec![repo.to_string_lossy().into_owned()]);

        assert!(files.is_empty());
    }
}
