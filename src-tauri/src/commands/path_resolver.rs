use std::path::PathBuf;

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvePathRequest {
    pub parts: Vec<String>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvePathResponse {
    pub path: String,
}

fn trim_part(part: &str) -> Option<&str> {
    let trimmed = part.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    }
}

fn expand_home_prefix(part: &str) -> Option<PathBuf> {
    let home = dirs::home_dir()?;
    match part {
        "~" => Some(home),
        _ => part
            .strip_prefix("~/")
            .or_else(|| part.strip_prefix("~\\"))
            .map(|relative| home.join(relative)),
    }
}

fn resolve_path_parts(parts: Vec<String>) -> Result<String, String> {
    let mut normalized_parts = parts.iter().filter_map(|part| trim_part(part)).peekable();

    let first = normalized_parts
        .next()
        .ok_or_else(|| "Path parts must include at least one non-empty segment".to_string())?;
    let mut path = expand_home_prefix(first).unwrap_or_else(|| PathBuf::from(first));

    for part in normalized_parts {
        path.push(part);
    }

    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn resolve_path(request: ResolvePathRequest) -> Result<ResolvePathResponse, String> {
    Ok(ResolvePathResponse {
        path: resolve_path_parts(request.parts)?,
    })
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanonicalizeAuthorizedWorkspaceDirectoryRequest {
    pub path: String,
    pub allowed_roots: Vec<String>,
}

fn canonicalize_existing_absolute_directory(path: &str) -> Result<PathBuf, String> {
    let requested = trim_part(path).ok_or_else(|| "Path must not be empty".to_string())?;
    let expanded = expand_home_prefix(requested).unwrap_or_else(|| PathBuf::from(requested));
    if !expanded.is_absolute() {
        return Err("Path must be absolute (or start with ~)".to_string());
    }
    let canonical = dunce::canonicalize(&expanded)
        .map_err(|error| format!("path does not exist or cannot be resolved ({error})"))?;
    if !canonical.is_dir() {
        return Err("Path is not a directory".to_string());
    }
    Ok(canonical)
}

fn canonicalize_authorized_workspace_directory_inner(
    path: &str,
    allowed_roots: &[String],
) -> Result<String, String> {
    let canonical = canonicalize_existing_absolute_directory(path)?;
    let authorized = allowed_roots.iter().any(|root| {
        canonicalize_existing_absolute_directory(root)
            .map(|canonical_root| canonical.starts_with(canonical_root))
            .unwrap_or(false)
    });
    if !authorized {
        return Err("Path is outside this chat's authorized workspace roots".to_string());
    }
    Ok(canonical.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn canonicalize_authorized_workspace_directory(
    request: CanonicalizeAuthorizedWorkspaceDirectoryRequest,
) -> Result<ResolvePathResponse, String> {
    tokio::task::spawn_blocking(move || {
        Ok(ResolvePathResponse {
            path: canonicalize_authorized_workspace_directory_inner(
                &request.path,
                &request.allowed_roots,
            )?,
        })
    })
    .await
    .map_err(|error| format!("Failed to resolve directory: {error}"))?
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckDirectoriesExistRequest {
    pub paths: Vec<String>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckDirectoriesExistResponse {
    pub missing: Vec<String>,
}

fn missing_directories(paths: Vec<String>) -> Vec<String> {
    paths
        .into_iter()
        .filter(|path| {
            let expanded = expand_home_prefix(path).unwrap_or_else(|| PathBuf::from(path));
            !expanded.is_dir()
        })
        .collect()
}

#[tauri::command]
pub async fn check_directories_exist(
    request: CheckDirectoriesExistRequest,
) -> Result<CheckDirectoriesExistResponse, String> {
    // `is_dir()` performs a blocking `stat()` syscall that can take seconds for
    // network shares, autofs mounts, or sleeping external drives — exactly the
    // kind of path this check exists to flag. Run it off the main thread so a
    // slow stat doesn't freeze the window.
    let missing = tokio::task::spawn_blocking(move || missing_directories(request.paths))
        .await
        .map_err(|err| format!("Failed to check directories: {err}"))?;
    Ok(CheckDirectoriesExistResponse { missing })
}

#[cfg(test)]
mod tests {
    use super::{
        canonicalize_authorized_workspace_directory_inner, missing_directories, resolve_path_parts,
    };

    #[test]
    fn joins_absolute_path_and_subpath() {
        assert_eq!(
            resolve_path_parts(vec!["/tmp/project".to_string(), "src".to_string()]),
            Ok("/tmp/project/src".to_string())
        );
    }

    #[test]
    fn ignores_empty_parts() {
        assert_eq!(
            resolve_path_parts(vec!["  ".to_string(), "/tmp/project".to_string()]),
            Ok("/tmp/project".to_string())
        );
    }

    #[test]
    fn expands_home_segments() {
        let Some(home) = dirs::home_dir() else {
            return;
        };

        assert_eq!(
            resolve_path_parts(vec!["~".to_string()]),
            Ok(home.to_string_lossy().into_owned())
        );
        assert_eq!(
            resolve_path_parts(vec!["~/Documents".to_string()]),
            Ok(home.join("Documents").to_string_lossy().into_owned())
        );
        assert_eq!(
            resolve_path_parts(vec!["~\\Documents".to_string()]),
            Ok(home.join("Documents").to_string_lossy().into_owned())
        );
    }

    #[test]
    fn errors_when_no_non_empty_parts_exist() {
        assert_eq!(
            resolve_path_parts(vec!["  ".to_string(), "".to_string()]),
            Err("Path parts must include at least one non-empty segment".to_string())
        );
    }

    #[test]
    fn rejects_existing_directory_outside_authorized_roots() {
        let temp = tempfile::tempdir().expect("temp root");
        let allowed = temp.path().join("allowed");
        let sensitive = temp.path().join("sensitive");
        std::fs::create_dir_all(&allowed).expect("allowed dir");
        std::fs::create_dir_all(&sensitive).expect("sensitive dir");

        let result = canonicalize_authorized_workspace_directory_inner(
            sensitive.to_str().expect("utf-8 sensitive path"),
            &[allowed.to_string_lossy().into_owned()],
        );

        assert_eq!(
            result,
            Err("Path is outside this chat's authorized workspace roots".to_string())
        );
    }

    #[test]
    fn rejects_existing_home_directory_when_not_authorized() {
        let temp = tempfile::tempdir().expect("temp root");
        let allowed = temp.path().join("allowed");
        std::fs::create_dir_all(&allowed).expect("allowed dir");
        let home = dirs::home_dir().expect("test environment has a home directory");

        let result = canonicalize_authorized_workspace_directory_inner(
            home.to_str().expect("utf-8 home path"),
            &[allowed.to_string_lossy().into_owned()],
        );

        assert_eq!(
            result,
            Err("Path is outside this chat's authorized workspace roots".to_string())
        );
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_escape_from_authorized_root() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().expect("temp root");
        let allowed = temp.path().join("allowed");
        let sensitive = temp.path().join("sensitive");
        std::fs::create_dir_all(&allowed).expect("allowed dir");
        std::fs::create_dir_all(&sensitive).expect("sensitive dir");
        let escape = allowed.join("escape");
        symlink(&sensitive, &escape).expect("symlink escape");

        let result = canonicalize_authorized_workspace_directory_inner(
            escape.to_str().expect("utf-8 escape path"),
            &[allowed.to_string_lossy().into_owned()],
        );

        assert_eq!(
            result,
            Err("Path is outside this chat's authorized workspace roots".to_string())
        );
    }

    #[test]
    fn authorizes_existing_directory_inside_authorized_root() {
        let temp = tempfile::tempdir().expect("temp root");
        let allowed = temp.path().join("allowed");
        let nested = allowed.join("nested");
        std::fs::create_dir_all(&nested).expect("nested dir");

        assert_eq!(
            canonicalize_authorized_workspace_directory_inner(
                nested.to_str().expect("utf-8 nested path"),
                &[allowed.to_string_lossy().into_owned()],
            ),
            Ok(dunce::canonicalize(&nested)
                .unwrap()
                .to_string_lossy()
                .into_owned())
        );
    }

    #[test]
    fn allows_an_explicitly_authorized_sibling_directory() {
        let temp = tempfile::tempdir().expect("temp root");
        let repository = temp.path().join("repository");
        let linked_worktree = temp.path().join("linked-worktree");
        std::fs::create_dir_all(&repository).expect("repository dir");
        std::fs::create_dir_all(&linked_worktree).expect("linked worktree dir");

        let allowed_roots = vec![
            repository.to_string_lossy().into_owned(),
            linked_worktree.to_string_lossy().into_owned(),
        ];
        assert_eq!(
            canonicalize_authorized_workspace_directory_inner(
                linked_worktree.to_str().expect("utf-8 worktree path"),
                &allowed_roots,
            ),
            Ok(dunce::canonicalize(&linked_worktree)
                .unwrap()
                .to_string_lossy()
                .into_owned())
        );
    }

    #[test]
    fn reports_only_missing_directories() {
        let temp = std::env::temp_dir();
        let existing = temp.to_string_lossy().into_owned();
        let missing = temp
            .join("goose-missing-dir-check")
            .to_string_lossy()
            .into_owned();

        assert_eq!(
            missing_directories(vec![existing.clone(), missing.clone()]),
            vec![missing]
        );
        assert!(missing_directories(vec![existing]).is_empty());
    }

    #[test]
    fn treats_files_as_missing_directories() {
        let mut file = std::env::temp_dir();
        file.push("goose-missing-dir-check.tmp");
        std::fs::write(&file, b"goose").expect("write temp file");
        let file_path = file.to_string_lossy().into_owned();

        assert_eq!(
            missing_directories(vec![file_path.clone()]),
            vec![file_path]
        );

        std::fs::remove_file(&file).ok();
    }

    #[test]
    fn expands_home_prefix_when_checking() {
        if dirs::home_dir().is_none() {
            return;
        }
        // The home directory itself exists, so "~" should not be reported missing.
        assert!(missing_directories(vec!["~".to_string()]).is_empty());

        // A "~" path is expanded for the existence check, but the original input
        // is echoed back in the missing list so callers see what they passed.
        assert_eq!(
            missing_directories(vec!["~/goose-missing-home-dir-check".to_string()]),
            vec!["~/goose-missing-home-dir-check".to_string()]
        );
    }
}
