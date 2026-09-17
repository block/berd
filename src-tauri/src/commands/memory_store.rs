//! Filesystem boundary for the user-owned memory store.
//!
//! Renderer IPC is not a trust boundary. Memory UI code knows which paths it
//! intends to touch, but accepting an arbitrary absolute path in a Tauri
//! command turns a compromised renderer into an unrestricted file writer.
//! Every memory mutation resolves against the canonical `~/.me` root here,
//! follows symlinks for existing ancestors, and rejects anything that escapes.

use berd_memory::{content_is_approved, mark_content_approved, normalize_memory_document_text};
use cap_std::ambient_authority;
use cap_std::fs::Dir;
use std::fs;
use std::path::{Component, Path, PathBuf};

/// The canonical memory-store root for this machine.
pub fn memory_store_root() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "Could not determine home directory".to_string())?;
    Ok(home.join(".me"))
}

/// Resolve a renderer-supplied path and prove it stays inside `~/.me`.
///
/// Existing paths are canonicalized directly. For a path that does not exist
/// yet, the nearest existing ancestor is canonicalized and the remaining
/// normal components are appended. That catches symlink escapes without
/// requiring the target file or its immediate parent to exist first.
pub fn validate_memory_path(path: &str) -> Result<PathBuf, String> {
    validate_memory_path_against_root(path, &memory_store_root()?)
}

fn validate_memory_path_against_root(path: &str, root: &Path) -> Result<PathBuf, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("Memory path cannot be empty".to_string());
    }
    let supplied = PathBuf::from(trimmed);
    if !supplied.is_absolute() {
        return Err("Memory path must be absolute".to_string());
    }
    if supplied
        .components()
        .any(|component| matches!(component, Component::ParentDir | Component::CurDir))
    {
        return Err("Memory path cannot contain traversal components".to_string());
    }

    let canonical_home = root
        .parent()
        .ok_or_else(|| "Memory root has no parent".to_string())?
        .canonicalize()
        .map_err(|error| format!("Could not resolve home directory: {error}"))?;
    let canonical_root = canonical_home.join(".me");

    let resolved = canonicalize_with_missing_tail(&supplied)?;
    if resolved != canonical_root && !resolved.starts_with(&canonical_root) {
        return Err(format!(
            "Path is outside the memory store: {}",
            supplied.display()
        ));
    }
    Ok(resolved)
}

fn canonicalize_with_missing_tail(path: &Path) -> Result<PathBuf, String> {
    let mut ancestor = path;
    let mut tail = Vec::new();
    while !ancestor.exists() {
        let name = ancestor
            .file_name()
            .ok_or_else(|| format!("Could not resolve path: {}", path.display()))?;
        tail.push(name.to_os_string());
        ancestor = ancestor
            .parent()
            .ok_or_else(|| format!("Could not resolve path: {}", path.display()))?;
    }
    let mut resolved = ancestor
        .canonicalize()
        .map_err(|error| format!("Could not resolve '{}': {error}", ancestor.display()))?;
    for component in tail.iter().rev() {
        resolved.push(component);
    }
    Ok(resolved)
}

fn store_relative_path(target: &Path, root: &Path) -> Result<PathBuf, String> {
    target
        .strip_prefix(root)
        .map(Path::to_path_buf)
        .map_err(|_| "Memory path escaped the store".to_string())
}

pub(crate) fn write_from_store_handle(
    target: &Path,
    contents: &str,
    create_new: bool,
) -> Result<(), String> {
    write_from_store_handle_at(target, &memory_store_root()?, contents, create_new)
}

pub(crate) fn write_from_store_handle_at(
    target: &Path,
    root: &Path,
    contents: &str,
    create_new: bool,
) -> Result<(), String> {
    fs::create_dir_all(root).map_err(|error| format!("Failed to create memory store: {error}"))?;
    let relative = store_relative_path(target, root)?;
    let parent = relative
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let file_name = relative
        .file_name()
        .ok_or_else(|| "Memory path must name a file".to_string())?;
    let root_dir = Dir::open_ambient_dir(root, ambient_authority())
        .map_err(|error| format!("Failed to open memory store: {error}"))?;
    root_dir
        .create_dir_all(parent)
        .map_err(|error| format!("Failed to create memory directory: {error}"))?;
    // Opening each directory relative to an already-open store capability
    // prevents a validated absolute pathname from being redirected by a
    // symlink swap before the write.
    let parent_dir = root_dir
        .open_dir(parent)
        .map_err(|error| format!("Failed to open memory directory: {error}"))?;
    let mut options = cap_std::fs::OpenOptions::new();
    options
        .write(true)
        .truncate(!create_new)
        .create(!create_new)
        .create_new(create_new);
    let mut file = parent_dir
        .open_with(file_name, &options)
        .map_err(|error| format!("Failed to open memory file: {error}"))?;
    use std::io::Write;
    file.write_all(contents.as_bytes())
        .map_err(|error| format!("Failed to write memory file: {error}"))
}

fn admit_reviewed_memory_document(contents: String) -> Result<String, String> {
    let normalized =
        normalize_memory_document_text(&contents).map_err(|error| error.to_string())?;
    if berd_memory::looks_like_credential(&normalized) {
        return Err("Authentication and access data can't be saved to memory".to_string());
    }
    Ok(normalized)
}

pub(crate) fn record_approved_content(target: &Path, contents: &str) -> Result<(), String> {
    record_approved_content_at(target, &memory_store_root()?, contents)
}

pub(crate) fn record_approved_content_at(
    target: &Path,
    root: &Path,
    contents: &str,
) -> Result<(), String> {
    mark_content_approved(root, target, contents)
}

pub fn is_approved_memory_content(target: &Path, contents: &str) -> bool {
    memory_store_root()
        .map(|root| content_is_approved(&root, target, contents))
        .unwrap_or(false)
}

#[tauri::command]
pub fn is_memory_content_approved(path: String, contents: String) -> Result<bool, String> {
    let target = validate_memory_path(&path)?;
    let contents = normalize_memory_document_text(&contents).map_err(|error| error.to_string())?;
    Ok(is_approved_memory_content(&target, &contents))
}

/// Create a UTF-8 memory file without overwriting existing content.
#[tauri::command]
pub fn create_memory_text_file(path: String, contents: String) -> Result<(), String> {
    let target = validate_memory_path(&path)?;
    let contents = admit_reviewed_memory_document(contents)?;
    write_from_store_handle(&target, &contents, true)?;
    record_approved_content(&target, &contents)
}

/// Overwrite a UTF-8 memory file, creating parent directories as needed.
#[tauri::command]
pub fn write_memory_text_file(path: String, contents: String) -> Result<(), String> {
    let target = validate_memory_path(&path)?;
    let contents = admit_reviewed_memory_document(contents)?;
    write_from_store_handle(&target, &contents, false)?;
    record_approved_content(&target, &contents)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn validate(root: &Path, path: &Path) -> Result<PathBuf, String> {
        validate_memory_path_against_root(path.to_str().unwrap(), root)
    }

    #[test]
    fn accepts_files_under_the_store() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join(".me");
        let path = root.join("topics/travel.md");
        let resolved = validate(&root, &path).unwrap();
        assert!(resolved.ends_with(".me/topics/travel.md"));
    }

    #[test]
    fn rejects_paths_outside_the_store() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join(".me");
        let path = temp.path().join("Documents/notes.md");
        assert!(validate(&root, &path).is_err());
    }

    #[test]
    fn rejects_traversal() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join(".me");
        let path = root.join("../secrets.md");
        assert!(validate(&root, &path).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_a_symlink_escape() {
        use std::os::unix::fs::symlink;
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join(".me");
        let outside = temp.path().join("outside");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&outside).unwrap();
        symlink(&outside, root.join("escaped")).unwrap();
        assert!(validate(&root, &root.join("escaped/secret.md")).is_err());
    }
    #[test]
    fn memory_document_writes_persist_the_exact_normalized_approved_text() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join(".me");
        fs::create_dir_all(&root).unwrap();
        let target = root.join("me.md");
        let reviewed = "# Cafe\u{301}\r\n\n- Prefers São Paulo.\n";
        let normalized = "# Café\n\n- Prefers São Paulo.\n";

        let contents = admit_reviewed_memory_document(reviewed.into()).unwrap();
        write_from_store_handle_at(&target, &root, &contents, false).unwrap();
        record_approved_content_at(&target, &root, &contents).unwrap();

        assert_eq!(fs::read_to_string(&target).unwrap(), normalized);
        assert!(content_is_approved(&root, &target, normalized));
        assert!(!content_is_approved(&root, &target, reviewed));
    }

    #[test]
    fn memory_document_writes_reject_unsafe_text_and_credentials() {
        assert!(admit_reviewed_memory_document("# Me\nabc\u{202e}txt\n".into()).is_err());
        assert!(admit_reviewed_memory_document("# Me\nPIN: 1234\n".into()).is_err());
    }
}
