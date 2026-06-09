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
    use super::{missing_directories, resolve_path_parts};

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
