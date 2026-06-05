use base64::Engine;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Window};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

use std::cmp::Ordering;
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

const DEFAULT_FILE_MENTION_LIMIT: usize = 12;
const MAX_FILE_MENTION_LIMIT: usize = 32;
const MAX_SCAN_DEPTH: usize = 8;
const MAX_FILE_MENTION_INDEX_ENTRIES: usize = 100_000;
const MAX_FILESYSTEM_PATH_LOOKUP_ENTRIES: usize = 5000;
const FILE_MENTION_INDEX_CACHE_LIMIT: usize = 8;
const FILE_MENTION_INDEX_CACHE_TTL: Duration = Duration::from_secs(60);
const MIN_FILE_MENTION_FUZZY_QUERY_CHARS: usize = 3;
const MAX_IMAGE_ATTACHMENT_BYTES: u64 = 20 * 1024 * 1024;

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileTreeEntry {
    pub name: String,
    pub path: String,
    pub kind: String,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentPathInfo {
    pub name: String,
    pub path: String,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileMentionPathEntry {
    pub resolved_path: String,
    pub display_path: String,
    pub filename: String,
    pub kind: String,
    pub source: String,
}

#[derive(Clone, Debug)]
struct IndexedFileMentionEntry {
    entry: FileMentionPathEntry,
    normalized_filename: String,
    normalized_relative_path: String,
    is_directory: bool,
    depth: usize,
}

#[derive(Clone, Debug)]
struct FileMentionIndex {
    canonical_root: PathBuf,
    entries: Vec<IndexedFileMentionEntry>,
}

#[derive(Clone)]
struct CachedFileMentionIndex {
    built_at: Instant,
    index: Arc<FileMentionIndex>,
}

#[derive(Default)]
struct FileMentionBuildSignal {
    completed: Mutex<bool>,
    ready: Condvar,
}

impl FileMentionBuildSignal {
    fn wait(&self) {
        let mut completed = self.completed.lock().expect("file mention build lock");
        while !*completed {
            completed = self.ready.wait(completed).expect("file mention build wait");
        }
    }

    fn finish(&self) {
        {
            let mut completed = self.completed.lock().expect("file mention build lock");
            *completed = true;
        }
        self.ready.notify_all();
    }
}

#[derive(Default)]
struct FileMentionIndexCache {
    order: VecDeque<String>,
    entries: HashMap<String, CachedFileMentionIndex>,
    building: HashMap<String, Arc<FileMentionBuildSignal>>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct FileMentionScore {
    rank: u8,
    match_position: usize,
    boundary_penalty: u8,
    fuzzy_span: usize,
    fuzzy_gaps: usize,
    directory_penalty: u8,
    depth: usize,
    path_len: usize,
}

#[derive(Clone)]
struct FileMentionCandidate {
    entry: FileMentionPathEntry,
    normalized_resolved_path: String,
    normalized_relative_path: String,
    score: FileMentionScore,
}

#[derive(Clone, Copy)]
struct IndexedFileMentionCandidate<'a> {
    entry: &'a IndexedFileMentionEntry,
    score: FileMentionScore,
}

static FILE_MENTION_INDEX_CACHE: OnceLock<Mutex<FileMentionIndexCache>> = OnceLock::new();

fn file_mention_index_cache() -> &'static Mutex<FileMentionIndexCache> {
    FILE_MENTION_INDEX_CACHE.get_or_init(|| Mutex::new(FileMentionIndexCache::default()))
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ImageAttachmentPayload {
    pub base64: String,
    pub mime_type: String,
}

#[tauri::command]
pub fn get_home_dir() -> Result<String, String> {
    let home_dir = dirs::home_dir().ok_or("Could not determine home directory")?;
    Ok(home_dir.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn open_in_chrome(app: AppHandle, url: String) -> Result<(), String> {
    validate_external_url(&url)?;

    if try_launch_chrome(&url) {
        return Ok(());
    }

    log::warn!("Could not launch Google Chrome; falling back to default browser for {url}");
    app.opener()
        .open_url(&url, None::<&str>)
        .map_err(|error| format!("Failed to open URL '{url}' in fallback browser: {error}"))
}

fn validate_external_url(url: &str) -> Result<(), String> {
    let parsed =
        reqwest::Url::parse(url).map_err(|error| format!("Invalid URL '{url}': {error}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(format!(
            "Refusing to open URL with non-http(s) scheme '{}'",
            parsed.scheme()
        ));
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn try_launch_chrome(url: &str) -> bool {
    std::process::Command::new("open")
        .args(["-a", "Google Chrome", url])
        .spawn()
        .is_ok()
}

#[cfg(target_os = "linux")]
fn try_launch_chrome(url: &str) -> bool {
    for binary in ["google-chrome", "google-chrome-stable", "chromium"] {
        if std::process::Command::new(binary).arg(url).spawn().is_ok() {
            return true;
        }
    }
    false
}

#[cfg(target_os = "windows")]
fn try_launch_chrome(url: &str) -> bool {
    // `start` is a shell builtin; the empty "" is the window title argument
    // that `start` requires when the first argument is quoted.
    std::process::Command::new("cmd")
        .args(["/C", "start", "", "chrome", url])
        .spawn()
        .is_ok()
}

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
fn try_launch_chrome(_url: &str) -> bool {
    false
}

#[tauri::command]
pub async fn save_exported_session_file(
    window: Window,
    default_filename: String,
    contents: String,
) -> Result<Option<String>, String> {
    let desktop =
        dirs::desktop_dir().unwrap_or_else(|| dirs::home_dir().unwrap_or_default().join("Desktop"));

    let mut dialog = window
        .dialog()
        .file()
        .set_title("Export Session")
        .set_file_name(default_filename)
        .set_directory(desktop)
        .add_filter("JSON", &["json"]);

    #[cfg(desktop)]
    {
        dialog = dialog.set_parent(&window);
    }

    let Some(path) = dialog.blocking_save_file() else {
        return Ok(None);
    };

    let path = path
        .into_path()
        .map_err(|_| "Selected save path is not available".to_string())?;
    std::fs::write(&path, contents)
        .map_err(|e| format!("Failed to write file '{}': {}", path.display(), e))?;

    Ok(Some(path.to_string_lossy().into_owned()))
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SessionExportItem {
    pub filename: String,
    pub contents: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SessionExportBatchResult {
    pub folder: String,
    pub files: Vec<String>,
}

#[tauri::command]
pub async fn save_exported_session_files(
    window: Window,
    items: Vec<SessionExportItem>,
) -> Result<Option<SessionExportBatchResult>, String> {
    if items.is_empty() {
        return Ok(None);
    }

    let desktop =
        dirs::desktop_dir().unwrap_or_else(|| dirs::home_dir().unwrap_or_default().join("Desktop"));

    let mut dialog = window
        .dialog()
        .file()
        .set_title("Export chats")
        .set_directory(desktop);

    #[cfg(desktop)]
    {
        dialog = dialog.set_parent(&window);
    }

    let Some(folder) = dialog.blocking_pick_folder() else {
        return Ok(None);
    };

    let folder_path = folder
        .into_path()
        .map_err(|_| "Selected folder path is not available".to_string())?;

    let mut used: HashSet<String> = HashSet::new();
    let mut written: Vec<String> = Vec::with_capacity(items.len());

    for item in items {
        let resolved = resolve_export_filename(&folder_path, &item.filename, &used);
        let path = folder_path.join(&resolved);
        std::fs::write(&path, &item.contents)
            .map_err(|e| format!("Failed to write file '{}': {}", path.display(), e))?;
        used.insert(resolved.clone());
        written.push(resolved);
    }

    Ok(Some(SessionExportBatchResult {
        folder: folder_path.to_string_lossy().into_owned(),
        files: written,
    }))
}

fn resolve_export_filename(folder: &Path, filename: &str, used: &HashSet<String>) -> String {
    if !folder.join(filename).exists() && !used.contains(filename) {
        return filename.to_string();
    }

    let (stem, ext) = match filename.rsplit_once('.') {
        Some((s, e)) => (s.to_string(), format!(".{}", e)),
        None => (filename.to_string(), String::new()),
    };

    for n in 2..=9999 {
        let candidate = format!("{}-{}{}", stem, n, ext);
        if !folder.join(&candidate).exists() && !used.contains(&candidate) {
            return candidate;
        }
    }

    format!("{}-{}{}", stem, 9999, ext)
}

#[tauri::command]
#[allow(dead_code)]
pub fn path_exists(path: String) -> bool {
    std::path::Path::new(&path).exists()
}

fn ensure_directory_path(path: &Path) -> Result<(), String> {
    if path.as_os_str().is_empty() {
        return Err("Directory path cannot be empty".to_string());
    }

    fs::create_dir_all(path)
        .map_err(|error| format!("Failed to create directory '{}': {}", path.display(), error))?;

    let metadata = fs::metadata(path).map_err(|error| {
        format!(
            "Failed to inspect directory '{}': {}",
            path.display(),
            error
        )
    })?;
    if !metadata.is_dir() {
        return Err(format!("Path is not a directory: {}", path.display()));
    }

    Ok(())
}

#[tauri::command]
pub fn ensure_directory(path: String) -> Result<(), String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("Directory path cannot be empty".to_string());
    }

    ensure_directory_path(Path::new(trimmed))
}

fn read_directory_entries(path: &Path) -> Result<Vec<FileTreeEntry>, String> {
    if !path.exists() {
        return Err(format!("Directory does not exist: {}", path.display()));
    }

    let metadata = fs::metadata(path)
        .map_err(|error| format!("Failed to inspect '{}': {}", path.display(), error))?;
    if !metadata.is_dir() {
        return Err(format!("Path is not a directory: {}", path.display()));
    }

    let mut entries = Vec::new();
    let reader = fs::read_dir(path)
        .map_err(|error| format!("Failed to read directory '{}': {}", path.display(), error))?;

    for entry in reader {
        let Ok(entry) = entry else {
            continue;
        };
        let name = entry.file_name().to_string_lossy().into_owned();
        if name == ".git" {
            continue;
        }
        let Some(file_tree_entry) = build_file_tree_entry(entry.path(), name) else {
            continue;
        };

        entries.push(file_tree_entry);
    }

    entries.sort_by(|a, b| {
        let a_rank = if a.kind == "directory" { 0 } else { 1 };
        let b_rank = if b.kind == "directory" { 0 } else { 1 };
        a_rank
            .cmp(&b_rank)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            .then_with(|| a.name.cmp(&b.name))
    });

    Ok(entries)
}

fn build_file_tree_entry(path: PathBuf, name: String) -> Option<FileTreeEntry> {
    let metadata = fs::symlink_metadata(&path).ok()?;
    let file_type = metadata.file_type();

    Some(FileTreeEntry {
        name,
        path: path.to_string_lossy().into_owned(),
        kind: if file_type.is_dir() {
            "directory".to_string()
        } else {
            "file".to_string()
        },
    })
}

#[tauri::command]
pub fn list_directory_entries(path: String) -> Result<Vec<FileTreeEntry>, String> {
    read_directory_entries(Path::new(&path))
}

fn inspect_attachment_path(path: &Path) -> Result<AttachmentPathInfo, String> {
    if !path.exists() {
        return Err(format!(
            "Attachment path does not exist: {}",
            path.display()
        ));
    }

    let metadata = fs::metadata(path)
        .map_err(|error| format!("Failed to inspect '{}': {}", path.display(), error))?;
    let name = path
        .file_name()
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string_lossy().into_owned());

    Ok(AttachmentPathInfo {
        name,
        path: path.to_string_lossy().into_owned(),
        kind: if metadata.is_dir() {
            "directory".to_string()
        } else {
            "file".to_string()
        },
        mime_type: if metadata.is_file() {
            mime_guess::from_path(path)
                .first_raw()
                .map(std::borrow::ToOwned::to_owned)
        } else {
            None
        },
    })
}

fn normalized_path_key(path: &Path) -> String {
    if let Ok(canonical) = path.canonicalize() {
        return canonical.to_string_lossy().into_owned();
    }

    let raw = path.to_string_lossy().into_owned();
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        raw.to_lowercase()
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        raw
    }
}

fn normalize_attachment_paths(paths: Vec<String>) -> Vec<PathBuf> {
    let mut seen = HashSet::new();
    let mut normalized = Vec::new();

    for raw_path in paths {
        let trimmed = raw_path.trim();
        if trimmed.is_empty() {
            continue;
        }

        let path = PathBuf::from(trimmed);
        let key = normalized_path_key(&path);
        if seen.insert(key) {
            normalized.push(path);
        }
    }

    normalized
}

#[tauri::command]
pub fn inspect_attachment_paths(paths: Vec<String>) -> Result<Vec<AttachmentPathInfo>, String> {
    let mut attachments = Vec::new();

    for path in normalize_attachment_paths(paths) {
        if let Ok(attachment) = inspect_attachment_path(&path) {
            attachments.push(attachment);
        }
    }

    Ok(attachments)
}

#[tauri::command]
pub fn read_image_attachment(path: String) -> Result<ImageAttachmentPayload, String> {
    let attachment = inspect_attachment_path(Path::new(&path))?;
    let mime_type = attachment
        .mime_type
        .ok_or_else(|| format!("Unable to determine image type for '{}'", attachment.path))?;

    if !mime_type.starts_with("image/") {
        return Err(format!("Attachment is not an image: {}", attachment.path));
    }

    let metadata = fs::metadata(&attachment.path)
        .map_err(|error| format!("Failed to inspect image '{}': {}", attachment.path, error))?;
    if metadata.len() > MAX_IMAGE_ATTACHMENT_BYTES {
        return Err(format!(
            "Image attachment '{}' exceeds the {} byte limit",
            attachment.path, MAX_IMAGE_ATTACHMENT_BYTES
        ));
    }

    let bytes = fs::read(&attachment.path)
        .map_err(|error| format!("Failed to read image '{}': {}", attachment.path, error))?;

    Ok(ImageAttachmentPayload {
        base64: base64::engine::general_purpose::STANDARD.encode(bytes),
        mime_type,
    })
}

fn normalize_roots(roots: Vec<String>) -> Vec<PathBuf> {
    let mut dedup = HashSet::new();
    let mut normalized = Vec::new();
    for root in roots {
        let trimmed = root.trim();
        if trimmed.is_empty() {
            continue;
        }
        let path = PathBuf::from(trimmed);
        let key = normalized_path_key(&path);
        if dedup.insert(key) {
            normalized.push(path);
        }
    }
    normalized
}

fn file_name_for_path(path: &Path) -> String {
    path.file_name()
        .and_then(|name| name.to_str())
        .map(str::to_owned)
        .unwrap_or_else(|| path.to_string_lossy().into_owned())
}

fn display_path_for_mention(path: &Path, root: &Path) -> String {
    let root_name = file_name_for_path(root);
    match path.strip_prefix(root) {
        Ok(relative) if relative.as_os_str().is_empty() => root_name,
        Ok(relative) => format!("{}/{}", root_name, relative.to_string_lossy()),
        Err(_) => path.to_string_lossy().into_owned(),
    }
}

fn normalize_relative_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn has_hidden_path_segment(path: &str) -> bool {
    path.split('/')
        .any(|segment| segment.starts_with('.') && segment != "." && segment != "..")
}

fn relative_depth(relative_path: &str) -> usize {
    relative_path
        .split('/')
        .filter(|segment| !segment.is_empty())
        .count()
}

fn is_safe_relative_file_mention_path(path: &str) -> bool {
    Path::new(path)
        .components()
        .all(|component| matches!(component, Component::Normal(_)))
}

fn build_file_mention_entry(path: &Path, root: &Path, is_directory: bool) -> FileMentionPathEntry {
    FileMentionPathEntry {
        resolved_path: path.to_string_lossy().into_owned(),
        display_path: display_path_for_mention(path, root),
        filename: file_name_for_path(path),
        kind: if is_directory { "folder" } else { "file" }.to_owned(),
        source: "project".to_owned(),
    }
}

fn filesystem_display_path_for_query(query: &str, path: &Path) -> String {
    if query.starts_with("~/") || query.starts_with("~\\") {
        if let Some(home) = dirs::home_dir() {
            if let Ok(relative_path) = path.strip_prefix(home) {
                if relative_path.as_os_str().is_empty() {
                    return "~".to_string();
                }
                return format!("~/{}", normalize_relative_path(relative_path));
            }
        }
    }

    path.to_string_lossy().into_owned()
}

fn build_filesystem_file_mention_entry(
    path: &Path,
    display_path: String,
    is_directory: bool,
) -> FileMentionPathEntry {
    FileMentionPathEntry {
        resolved_path: path.to_string_lossy().into_owned(),
        display_path,
        filename: file_name_for_path(path),
        kind: if is_directory { "folder" } else { "file" }.to_owned(),
        source: "filesystem".to_owned(),
    }
}

fn insert_file_mention_index_entry(
    entries: &mut Vec<IndexedFileMentionEntry>,
    seen: &mut HashSet<String>,
    root_path: &Path,
    relative_path: &str,
) {
    let normalized_relative_path = relative_path.trim_matches('/').replace('\\', "/");
    let depth = relative_depth(&normalized_relative_path);
    if entries.len() >= MAX_FILE_MENTION_INDEX_ENTRIES
        || depth == 0
        || depth > MAX_SCAN_DEPTH
        || !is_safe_relative_file_mention_path(&normalized_relative_path)
        || has_hidden_path_segment(&normalized_relative_path)
        || !seen.insert(normalized_relative_path.clone())
    {
        return;
    }

    let path = root_path.join(Path::new(&normalized_relative_path));
    let Ok(metadata) = fs::symlink_metadata(&path) else {
        return;
    };
    let file_type = metadata.file_type();
    if file_type.is_symlink() || (!file_type.is_dir() && !file_type.is_file()) {
        return;
    }

    let actual_is_directory = file_type.is_dir();
    let entry = build_file_mention_entry(&path, root_path, actual_is_directory);
    entries.push(IndexedFileMentionEntry {
        normalized_filename: entry.filename.to_lowercase(),
        normalized_relative_path: normalized_relative_path.to_lowercase(),
        entry,
        is_directory: actual_is_directory,
        depth,
    });
}

fn insert_parent_file_mention_directories(
    entries: &mut Vec<IndexedFileMentionEntry>,
    seen: &mut HashSet<String>,
    root_path: &Path,
    relative_path: &str,
) {
    let mut current = Path::new(relative_path).parent();
    while let Some(parent) = current {
        if entries.len() >= MAX_FILE_MENTION_INDEX_ENTRIES {
            break;
        }
        if parent.as_os_str().is_empty() {
            break;
        }
        let normalized_parent = normalize_relative_path(parent);
        insert_file_mention_index_entry(entries, seen, root_path, &normalized_parent);
        current = parent.parent();
    }
}

fn load_git_file_mention_paths(root_path: &Path) -> Option<Vec<String>> {
    let output = Command::new("git")
        .arg("-C")
        .arg(root_path)
        .args([
            "ls-files",
            "-z",
            "--cached",
            "--others",
            "--exclude-standard",
            "--",
            ".",
        ])
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let mut paths = Vec::new();
    for entry in output.stdout.split(|byte| *byte == 0) {
        if entry.is_empty() {
            continue;
        }
        let value = String::from_utf8_lossy(entry).trim().to_string();
        if !value.is_empty() {
            paths.push(value);
        }
    }

    Some(paths)
}

fn insert_walk_file_mention_directories(
    entries: &mut Vec<IndexedFileMentionEntry>,
    seen: &mut HashSet<String>,
    root_path: &Path,
) {
    let mut builder = ignore::WalkBuilder::new(root_path);
    builder
        .max_depth(Some(MAX_SCAN_DEPTH))
        .follow_links(false)
        .hidden(true)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true);

    for result in builder.build() {
        if entries.len() >= MAX_FILE_MENTION_INDEX_ENTRIES {
            break;
        }

        let Ok(entry) = result else {
            continue;
        };
        let path = entry.path();
        if path == root_path {
            continue;
        }
        let Some(file_type) = entry.file_type() else {
            continue;
        };
        if !file_type.is_dir() {
            continue;
        }
        let Ok(relative_path) = path.strip_prefix(root_path) else {
            continue;
        };
        let normalized_relative_path = normalize_relative_path(relative_path);
        insert_file_mention_index_entry(entries, seen, root_path, &normalized_relative_path);
    }
}

fn build_git_file_mention_index(root_path: &Path) -> Option<Vec<IndexedFileMentionEntry>> {
    let git_paths = load_git_file_mention_paths(root_path)?;
    let mut entries = Vec::new();
    let mut seen = HashSet::new();

    for relative_path in git_paths {
        if entries.len() >= MAX_FILE_MENTION_INDEX_ENTRIES {
            break;
        }

        insert_file_mention_index_entry(&mut entries, &mut seen, root_path, &relative_path);
        if entries.len() >= MAX_FILE_MENTION_INDEX_ENTRIES {
            break;
        }
        insert_parent_file_mention_directories(&mut entries, &mut seen, root_path, &relative_path);
    }

    if entries.len() < MAX_FILE_MENTION_INDEX_ENTRIES {
        insert_walk_file_mention_directories(&mut entries, &mut seen, root_path);
    }

    Some(entries)
}

fn build_walk_file_mention_index(root_path: &Path) -> Vec<IndexedFileMentionEntry> {
    let mut builder = ignore::WalkBuilder::new(root_path);
    builder
        .max_depth(Some(MAX_SCAN_DEPTH))
        .follow_links(false)
        .hidden(true)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true);

    let mut entries = Vec::new();
    let mut seen = HashSet::new();

    for result in builder.build() {
        if entries.len() >= MAX_FILE_MENTION_INDEX_ENTRIES {
            break;
        }

        let Ok(entry) = result else {
            continue;
        };
        let path = entry.path();
        if path == root_path {
            continue;
        }
        let Some(file_type) = entry.file_type() else {
            continue;
        };
        if !file_type.is_dir() && !file_type.is_file() {
            continue;
        }
        let Ok(relative_path) = path.strip_prefix(root_path) else {
            continue;
        };
        let normalized_relative_path = normalize_relative_path(relative_path);
        insert_file_mention_index_entry(
            &mut entries,
            &mut seen,
            root_path,
            &normalized_relative_path,
        );
    }

    entries
}

fn build_file_mention_index(root_path: &Path) -> Result<FileMentionIndex, String> {
    let canonical_root = root_path.canonicalize().map_err(|error| {
        format!(
            "Failed to resolve root '{}': {}",
            root_path.display(),
            error
        )
    })?;
    if !canonical_root.is_dir() {
        return Err(format!("Root is not a directory: {}", root_path.display()));
    }

    let entries = build_git_file_mention_index(&canonical_root)
        .unwrap_or_else(|| build_walk_file_mention_index(&canonical_root));

    Ok(FileMentionIndex {
        canonical_root,
        entries,
    })
}

fn touch_file_mention_cache_key(order: &mut VecDeque<String>, key: &str) {
    if let Some(index) = order.iter().position(|entry| entry == key) {
        order.remove(index);
    }
    order.push_back(key.to_string());
}

fn remove_file_mention_cache_key(cache: &mut FileMentionIndexCache, key: &str) {
    cache.entries.remove(key);
    if let Some(index) = cache.order.iter().position(|entry| entry == key) {
        cache.order.remove(index);
    }
}

enum FileMentionBuildSlot {
    Wait(Arc<FileMentionBuildSignal>),
    Leader(Arc<FileMentionBuildSignal>),
}

struct FileMentionBuildGuard<'a> {
    cache: &'a Mutex<FileMentionIndexCache>,
    cache_key: String,
    signal: Arc<FileMentionBuildSignal>,
}

impl Drop for FileMentionBuildGuard<'_> {
    fn drop(&mut self) {
        if let Ok(mut cache) = self.cache.lock() {
            if cache
                .building
                .get(&self.cache_key)
                .is_some_and(|signal| Arc::ptr_eq(signal, &self.signal))
            {
                cache.building.remove(&self.cache_key);
            }
        }
        self.signal.finish();
    }
}

fn get_or_build_file_mention_index(root_path: &Path) -> Result<Arc<FileMentionIndex>, String> {
    get_or_build_file_mention_index_from_cache(
        file_mention_index_cache(),
        root_path,
        build_file_mention_index,
    )
}

fn get_or_build_file_mention_index_from_cache<F>(
    cache: &Mutex<FileMentionIndexCache>,
    root_path: &Path,
    build_file_mention_index: F,
) -> Result<Arc<FileMentionIndex>, String>
where
    F: Fn(&Path) -> Result<FileMentionIndex, String>,
{
    let canonical_root = root_path.canonicalize().map_err(|error| {
        format!(
            "Failed to resolve root '{}': {}",
            root_path.display(),
            error
        )
    })?;
    if !canonical_root.is_dir() {
        return Err(format!("Root is not a directory: {}", root_path.display()));
    }
    let cache_key = normalized_path_key(&canonical_root);

    let build_signal = loop {
        let build_slot = {
            let mut cache = cache.lock().expect("file mention cache lock");
            let cached_index = cache.entries.get(&cache_key).and_then(|cached| {
                (cached.built_at.elapsed() <= FILE_MENTION_INDEX_CACHE_TTL)
                    .then(|| Arc::clone(&cached.index))
            });
            if let Some(index) = cached_index {
                touch_file_mention_cache_key(&mut cache.order, &cache_key);
                return Ok(index);
            }

            remove_file_mention_cache_key(&mut cache, &cache_key);
            if let Some(signal) = cache.building.get(&cache_key) {
                FileMentionBuildSlot::Wait(Arc::clone(signal))
            } else {
                let signal = Arc::new(FileMentionBuildSignal::default());
                cache
                    .building
                    .insert(cache_key.clone(), Arc::clone(&signal));
                FileMentionBuildSlot::Leader(signal)
            }
        };

        match build_slot {
            FileMentionBuildSlot::Wait(signal) => signal.wait(),
            FileMentionBuildSlot::Leader(signal) => break signal,
        }
    };

    let _build_guard = FileMentionBuildGuard {
        cache,
        cache_key: cache_key.clone(),
        signal: Arc::clone(&build_signal),
    };
    let index = build_file_mention_index(&canonical_root).map(Arc::new);
    {
        let mut cache = cache.lock().expect("file mention cache lock");
        if let Ok(index) = &index {
            cache.entries.insert(
                cache_key.clone(),
                CachedFileMentionIndex {
                    built_at: Instant::now(),
                    index: Arc::clone(index),
                },
            );
            touch_file_mention_cache_key(&mut cache.order, &cache_key);
            while cache.order.len() > FILE_MENTION_INDEX_CACHE_LIMIT {
                if let Some(oldest_key) = cache.order.pop_front() {
                    cache.entries.remove(&oldest_key);
                }
            }
        }
    }

    index
}

fn find_file_mention_segment_prefix(path: &str, query: &str) -> Option<usize> {
    for (index, segment) in path.split('/').enumerate() {
        if segment.starts_with(query) {
            return Some(index);
        }
    }
    None
}

#[derive(Clone, Copy)]
struct FuzzyFileMentionScore {
    match_position: usize,
    boundary_penalty: u8,
    span: usize,
    gaps: usize,
}

fn is_file_mention_fuzzy_boundary(previous: Option<char>) -> bool {
    match previous {
        None => true,
        Some(character) => {
            !character.is_alphanumeric() || matches!(character, '/' | '-' | '_' | '.')
        }
    }
}

fn find_file_mention_fuzzy_match(haystack: &str, query: &str) -> Option<FuzzyFileMentionScore> {
    let mut query_chars = query.chars();
    let mut next_query_char = query_chars.next()?;
    let mut matched_chars = 0usize;
    let mut first_match_position = None;
    let mut boundary_penalty = 1u8;
    let mut previous = None;

    for (position, character) in haystack.chars().enumerate() {
        if character != next_query_char {
            previous = Some(character);
            continue;
        }

        if first_match_position.is_none() {
            first_match_position = Some(position);
            boundary_penalty = u8::from(!is_file_mention_fuzzy_boundary(previous));
        }

        matched_chars += 1;
        if let Some(query_character) = query_chars.next() {
            next_query_char = query_character;
            previous = Some(character);
            continue;
        }

        let first_match_position = first_match_position?;
        let span = position.saturating_sub(first_match_position);
        let gaps = span.saturating_sub(matched_chars.saturating_sub(1));
        return Some(FuzzyFileMentionScore {
            match_position: first_match_position,
            boundary_penalty,
            span,
            gaps,
        });
    }

    None
}

fn can_use_file_mention_fuzzy_search(query: &str) -> bool {
    !query.contains('/') && query.chars().count() >= MIN_FILE_MENTION_FUZZY_QUERY_CHARS
}

fn score_file_mention_entry(
    entry: &IndexedFileMentionEntry,
    normalized_query: &str,
) -> Option<FileMentionScore> {
    if normalized_query.contains('/') {
        if entry.normalized_relative_path == normalized_query {
            return Some(file_mention_score(entry, 0, 0, 0, 0, 0));
        }
        if entry.normalized_relative_path.starts_with(normalized_query) {
            return Some(file_mention_score(entry, 1, 0, 0, 0, 0));
        }
        let match_position = entry.normalized_relative_path.find(normalized_query)?;
        return Some(file_mention_score(entry, 3, match_position, 0, 0, 0));
    }

    if entry.normalized_filename == normalized_query {
        return Some(file_mention_score(entry, 0, 0, 0, 0, 0));
    }
    if entry.normalized_filename.starts_with(normalized_query) {
        return Some(file_mention_score(entry, 1, 0, 0, 0, 0));
    }
    if let Some(match_position) =
        find_file_mention_segment_prefix(&entry.normalized_relative_path, normalized_query)
    {
        return Some(file_mention_score(entry, 2, match_position, 0, 0, 0));
    }
    if let Some(match_position) = entry.normalized_relative_path.find(normalized_query) {
        return Some(file_mention_score(entry, 3, match_position, 0, 0, 0));
    }

    if can_use_file_mention_fuzzy_search(normalized_query) {
        if let Some(fuzzy_match) =
            find_file_mention_fuzzy_match(&entry.normalized_filename, normalized_query)
        {
            return Some(file_mention_score(
                entry,
                4,
                fuzzy_match.match_position,
                fuzzy_match.boundary_penalty,
                fuzzy_match.span,
                fuzzy_match.gaps,
            ));
        }
        if let Some(fuzzy_match) =
            find_file_mention_fuzzy_match(&entry.normalized_relative_path, normalized_query)
        {
            return Some(file_mention_score(
                entry,
                5,
                fuzzy_match.match_position,
                fuzzy_match.boundary_penalty,
                fuzzy_match.span,
                fuzzy_match.gaps,
            ));
        }
    }

    None
}

fn file_mention_score(
    entry: &IndexedFileMentionEntry,
    rank: u8,
    match_position: usize,
    boundary_penalty: u8,
    fuzzy_span: usize,
    fuzzy_gaps: usize,
) -> FileMentionScore {
    FileMentionScore {
        rank,
        match_position,
        boundary_penalty,
        fuzzy_span,
        fuzzy_gaps,
        directory_penalty: if entry.is_directory { 0 } else { 1 },
        depth: entry.depth,
        path_len: entry.normalized_relative_path.len(),
    }
}

fn compare_indexed_file_mention_candidates(
    left: IndexedFileMentionCandidate<'_>,
    right: IndexedFileMentionCandidate<'_>,
) -> Ordering {
    compare_file_mention_scores(left.score, right.score).then_with(|| {
        left.entry
            .normalized_relative_path
            .cmp(&right.entry.normalized_relative_path)
    })
}

fn compare_file_mention_candidates(
    left: &FileMentionCandidate,
    right: &FileMentionCandidate,
) -> Ordering {
    compare_file_mention_scores(left.score, right.score).then_with(|| {
        left.normalized_relative_path
            .cmp(&right.normalized_relative_path)
    })
}

fn compare_file_mention_scores(left: FileMentionScore, right: FileMentionScore) -> Ordering {
    left.rank
        .cmp(&right.rank)
        .then_with(|| left.match_position.cmp(&right.match_position))
        .then_with(|| left.boundary_penalty.cmp(&right.boundary_penalty))
        .then_with(|| left.fuzzy_span.cmp(&right.fuzzy_span))
        .then_with(|| left.fuzzy_gaps.cmp(&right.fuzzy_gaps))
        .then_with(|| left.directory_penalty.cmp(&right.directory_penalty))
        .then_with(|| left.depth.cmp(&right.depth))
        .then_with(|| left.path_len.cmp(&right.path_len))
}

fn canonicalize_existing_path_prefix(path: &Path) -> Option<PathBuf> {
    let mut existing = path.to_path_buf();
    let mut missing_segments = Vec::new();

    while !existing.exists() {
        let name = existing.file_name()?.to_os_string();
        missing_segments.push(name);
        existing = existing.parent()?.to_path_buf();
    }

    let mut canonical = existing.canonicalize().ok()?;
    for segment in missing_segments.iter().rev() {
        canonical.push(segment);
    }
    Some(canonical)
}

fn expand_file_mention_query_path(query: &str) -> PathBuf {
    if let Some(rest) = query
        .strip_prefix("~/")
        .or_else(|| query.strip_prefix("~\\"))
    {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest);
        }
    }

    PathBuf::from(query)
}

fn normalize_file_mention_query_for_root(root_path: &Path, query: &str) -> Option<String> {
    let normalized_query = query.trim().replace('\\', "/");
    if normalized_query.is_empty() {
        return Some(String::new());
    }

    let expanded_query = expand_file_mention_query_path(&normalized_query);
    if expanded_query.is_absolute() {
        let canonical_query = canonicalize_existing_path_prefix(&expanded_query)?;
        let query_path = canonical_query.to_string_lossy().replace('\\', "/");
        let root = root_path.to_string_lossy().replace('\\', "/");
        let normalized_query_path = query_path.to_lowercase();
        let normalized_root = root.trim_end_matches('/').to_lowercase();
        let root_with_slash = format!("{}/", normalized_root);
        if normalized_query_path == normalized_root {
            return Some(String::new());
        }
        if normalized_query_path.starts_with(&root_with_slash) {
            return Some(normalized_query_path[root_with_slash.len()..].to_string());
        }
        return None;
    }

    let root = root_path.to_string_lossy().replace('\\', "/");
    let root_with_slash = format!("{}/", root.trim_end_matches('/'));
    if normalized_query == root {
        return Some(String::new());
    }
    if normalized_query.starts_with(&root_with_slash) {
        return Some(normalized_query[root_with_slash.len()..].to_lowercase());
    }

    Some(normalized_query.trim_start_matches('/').to_lowercase())
}

fn search_file_mention_index(
    index: &FileMentionIndex,
    query: &str,
    max_results: usize,
) -> Vec<FileMentionCandidate> {
    let Some(normalized_query) =
        normalize_file_mention_query_for_root(&index.canonical_root, query)
    else {
        return Vec::new();
    };
    if normalized_query.is_empty() || max_results == 0 {
        return Vec::new();
    }

    let mut matches: Vec<IndexedFileMentionCandidate<'_>> = Vec::new();
    for entry in &index.entries {
        let Some(score) = score_file_mention_entry(entry, &normalized_query) else {
            continue;
        };
        let candidate = IndexedFileMentionCandidate { entry, score };
        let insert_at = matches
            .iter()
            .position(|existing| {
                compare_indexed_file_mention_candidates(candidate, *existing).is_lt()
            })
            .unwrap_or(matches.len());
        if insert_at >= max_results {
            continue;
        }
        matches.insert(insert_at, candidate);
        if matches.len() > max_results {
            matches.pop();
        }
    }

    matches
        .into_iter()
        .map(|candidate| FileMentionCandidate {
            entry: candidate.entry.entry.clone(),
            normalized_resolved_path: normalized_path_key(Path::new(
                &candidate.entry.entry.resolved_path,
            )),
            normalized_relative_path: candidate.entry.normalized_relative_path.clone(),
            score: candidate.score,
        })
        .collect()
}

fn should_search_file_mention_root(
    root_path: &Path,
    query: &str,
    is_filesystem_query: bool,
) -> bool {
    if !is_filesystem_query {
        return true;
    }

    let Ok(canonical_root) = root_path.canonicalize() else {
        return false;
    };

    normalize_file_mention_query_for_root(&canonical_root, query).is_some()
}

fn insert_ranked_file_mention_candidate(
    matches: &mut Vec<FileMentionCandidate>,
    candidate: FileMentionCandidate,
    max_results: usize,
) {
    if matches
        .iter()
        .any(|existing| existing.normalized_resolved_path == candidate.normalized_resolved_path)
    {
        return;
    }

    let insert_at = matches
        .iter()
        .position(|existing| compare_file_mention_candidates(&candidate, existing).is_lt())
        .unwrap_or(matches.len());
    if insert_at >= max_results {
        return;
    }
    matches.insert(insert_at, candidate);
    if matches.len() > max_results {
        matches.pop();
    }
}

fn is_filesystem_file_mention_query(query: &str) -> bool {
    let trimmed = query.trim();
    trimmed.starts_with("~/") || trimmed.starts_with("~\\") || Path::new(trimmed).is_absolute()
}

fn expand_filesystem_file_mention_query(query: &str) -> Option<PathBuf> {
    let trimmed = query.trim();
    if let Some(rest) = trimmed
        .strip_prefix("~/")
        .or_else(|| trimmed.strip_prefix("~\\"))
    {
        return dirs::home_dir().map(|home| home.join(rest));
    }

    let path = PathBuf::from(trimmed);
    path.is_absolute().then_some(path)
}

fn filesystem_file_mention_lookup(query: &str) -> Option<(PathBuf, String)> {
    let expanded = expand_filesystem_file_mention_query(query)?;
    let parent = expanded.parent()?.to_path_buf();

    if query.ends_with('/') || query.ends_with('\\') {
        return Some((expanded, String::new()));
    }

    let partial = expanded
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default()
        .to_string();
    Some((parent, partial))
}

fn filesystem_file_mention_candidate_score(
    path: &Path,
    name: &str,
    partial: &str,
    is_directory: bool,
) -> Option<FileMentionScore> {
    let normalized_name = name.to_lowercase();
    let normalized_partial = partial.to_lowercase();
    let (rank, match_position) = if normalized_partial.is_empty() {
        (2, 0)
    } else if normalized_name == normalized_partial {
        (0, 0)
    } else if normalized_name.starts_with(&normalized_partial) {
        (1, 0)
    } else if normalized_partial.len() >= 2 {
        let position = normalized_name.find(&normalized_partial)?;
        (3, position)
    } else {
        return None;
    };

    Some(FileMentionScore {
        rank,
        match_position,
        boundary_penalty: 0,
        fuzzy_span: 0,
        fuzzy_gaps: 0,
        directory_penalty: if is_directory { 0 } else { 1 },
        depth: path.components().count(),
        path_len: path.to_string_lossy().len(),
    })
}

fn search_filesystem_path_mentions(query: &str, max_results: usize) -> Vec<FileMentionCandidate> {
    if max_results == 0 {
        return Vec::new();
    }

    let Some((lookup_dir, partial)) = filesystem_file_mention_lookup(query) else {
        return Vec::new();
    };
    if lookup_dir
        .canonicalize()
        .map_or(true, |path| !path.is_dir())
    {
        return Vec::new();
    }

    let Ok(entries) = fs::read_dir(&lookup_dir) else {
        return Vec::new();
    };

    let mut matches = Vec::new();
    for result in entries.take(MAX_FILESYSTEM_PATH_LOOKUP_ENTRIES) {
        let Ok(entry) = result else {
            continue;
        };
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.is_empty() || (name.starts_with('.') && !partial.starts_with('.')) {
            continue;
        }

        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_symlink() || (!file_type.is_dir() && !file_type.is_file()) {
            continue;
        }

        let path = lookup_dir.join(&name);
        let Some(score) =
            filesystem_file_mention_candidate_score(&path, &name, &partial, file_type.is_dir())
        else {
            continue;
        };
        let normalized_resolved_path = normalized_path_key(&path);
        let candidate = FileMentionCandidate {
            entry: build_filesystem_file_mention_entry(
                &path,
                filesystem_display_path_for_query(query, &path),
                file_type.is_dir(),
            ),
            normalized_relative_path: normalized_resolved_path.clone(),
            normalized_resolved_path,
            score,
        };
        insert_ranked_file_mention_candidate(&mut matches, candidate, max_results);
    }

    matches
}

fn search_file_mentions_blocking(
    roots: Vec<String>,
    query: String,
    max_results: Option<usize>,
) -> Vec<FileMentionPathEntry> {
    let roots = normalize_roots(roots);
    let query = query.trim();
    if query.is_empty() {
        return Vec::new();
    }

    let limit = max_results
        .unwrap_or(DEFAULT_FILE_MENTION_LIMIT)
        .clamp(1, MAX_FILE_MENTION_LIMIT);
    let is_filesystem_query = is_filesystem_file_mention_query(query);

    if roots.is_empty() && !is_filesystem_query {
        return Vec::new();
    }

    let mut matches = Vec::new();
    for root in roots {
        if !should_search_file_mention_root(&root, query, is_filesystem_query) {
            continue;
        }
        let Ok(index) = get_or_build_file_mention_index(&root) else {
            continue;
        };
        for candidate in search_file_mention_index(&index, query, limit) {
            insert_ranked_file_mention_candidate(&mut matches, candidate, limit);
        }
    }

    if is_filesystem_query {
        for candidate in search_filesystem_path_mentions(query, limit) {
            insert_ranked_file_mention_candidate(&mut matches, candidate, limit);
        }
    }

    matches
        .into_iter()
        .map(|candidate| candidate.entry)
        .collect()
}

#[tauri::command]
pub async fn search_file_mentions(
    roots: Vec<String>,
    query: String,
    max_results: Option<usize>,
) -> Result<Vec<FileMentionPathEntry>, String> {
    tokio::task::spawn_blocking(move || search_file_mentions_blocking(roots, query, max_results))
        .await
        .map_err(|error| format!("Failed to search files for mentions: {}", error))
}

#[cfg(test)]
mod tests {
    use super::{
        build_file_mention_index, build_file_tree_entry, ensure_directory_path,
        get_or_build_file_mention_index_from_cache, inspect_attachment_path,
        inspect_attachment_paths, normalize_attachment_paths, normalize_roots,
        read_directory_entries, read_image_attachment, search_file_mentions_blocking,
        validate_external_url, FileMentionIndexCache, MAX_IMAGE_ATTACHMENT_BYTES,
    };
    use base64::Engine;
    use std::fs;
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;
    use std::panic::{self, AssertUnwindSafe};
    use std::path::{Path, PathBuf};
    use std::process::Command;
    use std::sync::{
        atomic::{AtomicUsize, Ordering as AtomicOrdering},
        Arc, Barrier, Mutex,
    };
    use std::thread;
    use std::time::Duration;
    use tempfile::tempdir;

    /// Create a temp dir with `git init` so the ignore crate picks up `.gitignore`.
    fn git_tempdir() -> tempfile::TempDir {
        let dir = tempdir().expect("tempdir");
        Command::new("git")
            .args(["init", "--quiet"])
            .current_dir(dir.path())
            .output()
            .expect("git init");
        dir
    }

    fn mention_paths_joined(entries: &[super::FileMentionPathEntry]) -> String {
        entries
            .iter()
            .map(|entry| entry.resolved_path.as_str())
            .collect::<Vec<_>>()
            .join("\n")
    }

    fn search_mentions(
        root: &Path,
        query: &str,
        max_results: usize,
    ) -> Vec<super::FileMentionPathEntry> {
        search_file_mentions_blocking(
            vec![root.to_string_lossy().to_string()],
            query.to_string(),
            Some(max_results),
        )
    }

    #[test]
    fn respects_gitignore() {
        let dir = git_tempdir();
        let root = dir.path();
        let src = root.join("src");
        let ignored = root.join("node_modules").join("pkg");

        fs::create_dir_all(&src).expect("src dir");
        fs::create_dir_all(&ignored).expect("ignored dir");
        fs::write(src.join("main.ts"), "export {}").expect("source file");
        fs::write(ignored.join("main.ts"), "module.exports = {}").expect("ignored file");
        fs::write(root.join(".gitignore"), "node_modules/\n").expect(".gitignore");

        let files = search_mentions(root, "main", 50);

        let joined = mention_paths_joined(&files);
        assert!(joined.contains("main.ts"), "should include source files");
        assert!(
            !joined.contains("node_modules"),
            "should respect .gitignore"
        );
    }

    #[test]
    fn skips_hidden_files() {
        let dir = git_tempdir();
        let root = dir.path();

        fs::write(root.join("visible.ts"), "").expect("visible file");
        fs::write(root.join(".visible.ts"), "").expect("hidden file");

        let files = search_mentions(root, "visible", 50);

        let joined = mention_paths_joined(&files);
        assert!(joined.contains("visible.ts"));
        assert!(!joined.contains(".visible.ts"));
    }

    #[test]
    fn matches_project_paths_case_insensitively() {
        let dir = git_tempdir();
        let root = dir.path();
        let api = root.join("Src").join("API");

        fs::create_dir_all(&api).expect("api dir");
        fs::write(api.join("Client.ts"), "").expect("client file");

        let entries = search_mentions(root, "src/api", 50);

        assert!(
            entries.iter().any(|entry| {
                entry.display_path.ends_with("/Src/API/Client.ts") && entry.filename == "Client.ts"
            }),
            "expected mixed-case path to match lowercase query: {entries:?}"
        );
    }

    #[test]
    fn returns_structured_folder_and_file_entries() {
        let dir = git_tempdir();
        let root = dir.path();
        let src = root.join("src");

        fs::create_dir_all(&src).expect("src dir");
        fs::write(src.join("main.ts"), "").expect("source file");

        let entries = search_mentions(root, "src", 50);
        let canonical_src = src.canonicalize().expect("canonical src");
        let canonical_main = src.join("main.ts").canonicalize().expect("canonical main");

        assert!(entries.iter().any(|entry| {
            entry.resolved_path == canonical_src.to_string_lossy()
                && entry.display_path.ends_with("/src")
                && entry.filename == "src"
                && entry.kind == "folder"
        }));
        assert!(entries.iter().any(|entry| {
            entry.resolved_path == canonical_main.to_string_lossy()
                && entry.display_path.ends_with("/src/main.ts")
                && entry.filename == "main.ts"
                && entry.kind == "file"
        }));
    }

    #[test]
    fn honors_max_depth_and_max_results() {
        let dir = tempdir().expect("tempdir");
        let root = dir.path();
        let shallow = root.join("src");
        let too_deep = root
            .join("a")
            .join("b")
            .join("c")
            .join("d")
            .join("e")
            .join("f")
            .join("g")
            .join("h");

        fs::create_dir_all(&shallow).expect("shallow dir");
        fs::create_dir_all(&too_deep).expect("deep dir");
        fs::write(shallow.join("main.ts"), "").expect("shallow file");
        fs::write(too_deep.join("deep.ts"), "").expect("deep file");
        for index in 0..5 {
            fs::write(root.join(format!("file-{index}.ts")), "").expect("file");
        }

        let capped = search_mentions(root, "file", 2);
        assert_eq!(capped.len(), 2);

        let entries = search_mentions(root, "main", 50);
        let joined = mention_paths_joined(&entries);
        assert!(joined.contains("main.ts"));

        let entries = search_mentions(root, "deep", 50);
        let joined = mention_paths_joined(&entries);
        assert!(!joined.contains("deep.ts"));
    }

    #[test]
    fn git_index_skips_files_beyond_max_depth() {
        let dir = git_tempdir();
        let root = dir.path();
        let too_deep = root
            .join("a")
            .join("b")
            .join("c")
            .join("d")
            .join("e")
            .join("f")
            .join("g")
            .join("h")
            .join("i");

        fs::create_dir_all(&too_deep).expect("deep dir");
        fs::write(too_deep.join("deep-target.ts"), "").expect("deep file");

        let entries = search_mentions(root, "deep-target", 50);
        let joined = mention_paths_joined(&entries);

        assert!(!joined.contains("deep-target.ts"));
    }

    #[test]
    fn git_index_includes_empty_folders() {
        let dir = git_tempdir();
        let root = dir.path();
        let empty_folder = root.join("empty-folder");

        fs::create_dir_all(&empty_folder).expect("empty folder");
        fs::write(root.join("main.ts"), "").expect("source file");

        let entries = search_mentions(root, "empty-folder", 50);
        let canonical_empty_folder = empty_folder.canonicalize().expect("canonical empty folder");

        assert!(
            entries.iter().any(|entry| {
                entry.resolved_path == canonical_empty_folder.to_string_lossy()
                    && entry.filename == "empty-folder"
                    && entry.kind == "folder"
            }),
            "expected empty folder entry: {entries:?}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_escapes() {
        let dir = git_tempdir();
        let root = dir.path();
        let external = tempdir().expect("external tempdir");
        let external_file = external.path().join("secret.txt");

        fs::write(&external_file, "secret").expect("external file");
        std::os::unix::fs::symlink(&external_file, root.join("secret-link.txt")).expect("symlink");

        let entries = search_mentions(root, "secret", 50);
        let joined = mention_paths_joined(&entries);

        assert!(!joined.contains("secret-link.txt"));
        assert!(!joined.contains("secret.txt"));
    }

    #[cfg(unix)]
    #[test]
    fn rejects_tracked_symlink_entries() {
        let dir = git_tempdir();
        let root = dir.path();
        let external = tempdir().expect("external tempdir");
        let external_file = external.path().join("secret.txt");
        let symlink = root.join("tracked-secret.txt");

        fs::write(&external_file, "secret").expect("external file");
        std::os::unix::fs::symlink(&external_file, &symlink).expect("symlink");
        Command::new("git")
            .args(["add", "tracked-secret.txt"])
            .current_dir(root)
            .output()
            .expect("git add");

        let entries = search_mentions(root, "tracked-secret", 50);
        let joined = mention_paths_joined(&entries);

        assert!(!joined.contains("tracked-secret.txt"));
    }

    #[cfg(unix)]
    #[test]
    fn strips_symlinked_project_root_from_absolute_queries() {
        let real_dir = git_tempdir();
        let real_root = real_dir.path();
        let link_parent = tempdir().expect("link parent");
        let symlink_root = link_parent.path().join("workspace-link");
        let src = real_root.join("src");
        let file = src.join("client.ts");

        fs::create_dir_all(&src).expect("src dir");
        fs::write(&file, "").expect("client file");
        std::os::unix::fs::symlink(real_root, &symlink_root).expect("root symlink");

        let entries = search_file_mentions_blocking(
            vec![symlink_root.to_string_lossy().into_owned()],
            format!("{}/src/client", symlink_root.to_string_lossy()),
            Some(50),
        );
        let canonical_file = file.canonicalize().expect("canonical file");

        assert!(
            entries.iter().any(|entry| {
                entry.resolved_path == canonical_file.to_string_lossy()
                    && entry.display_path.ends_with("/src/client.ts")
                    && entry.filename == "client.ts"
                    && entry.source == "project"
            }),
            "expected symlink-root absolute query to match indexed project file: {entries:?}"
        );
    }

    #[test]
    fn ranks_exact_basename_prefix_segment_and_fuzzy_matches() {
        let dir = git_tempdir();
        let root = dir.path();

        fs::create_dir_all(root.join("docs")).expect("docs dir");
        fs::create_dir_all(root.join("src/render")).expect("src dir");
        fs::write(root.join("readme.md"), "").expect("readme file");
        fs::write(root.join("reader.md"), "").expect("reader file");
        fs::write(root.join("docs").join("my-readme.md"), "").expect("docs file");
        fs::write(root.join("src/render").join("app.ts"), "").expect("app file");

        let entries = search_mentions(root, "readme", 10);
        assert_eq!(
            entries.first().map(|entry| entry.filename.as_str()),
            Some("readme.md")
        );

        let entries = search_mentions(root, "render", 10);
        assert_eq!(
            entries.first().map(|entry| entry.filename.as_str()),
            Some("render")
        );

        let entries = search_mentions(root, "rdme", 10);
        assert!(
            entries.iter().any(|entry| entry.filename == "readme.md"),
            "expected fuzzy basename match"
        );
    }

    #[test]
    fn walks_absolute_path_prefixes_without_project_roots() {
        let dir = tempdir().expect("tempdir");
        let root = dir.path();
        let child = root.join("zsh-fzf-tab-kalvin");
        let file = child.join("test");

        fs::create_dir_all(&child).expect("child dir");
        fs::write(&file, "").expect("child file");

        let entries = search_file_mentions_blocking(
            vec![],
            format!("{}/zs", root.to_string_lossy()),
            Some(10),
        );
        assert!(entries.iter().any(|entry| {
            entry.resolved_path == child.to_string_lossy()
                && entry.filename == "zsh-fzf-tab-kalvin"
                && entry.kind == "folder"
                && entry.source == "filesystem"
        }));

        let entries = search_file_mentions_blocking(
            vec![],
            format!("{}/te", child.to_string_lossy()),
            Some(10),
        );
        assert!(entries.iter().any(|entry| {
            entry.resolved_path == file.to_string_lossy()
                && entry.filename == "test"
                && entry.kind == "file"
                && entry.source == "filesystem"
        }));
    }

    #[test]
    fn coalesces_concurrent_file_mention_index_builds() {
        let dir = tempdir().expect("tempdir");
        let root = dir.path().to_path_buf();
        fs::write(root.join("main.ts"), "").expect("source file");

        let cache = Arc::new(Mutex::new(FileMentionIndexCache::default()));
        let build_count = Arc::new(AtomicUsize::new(0));
        let barrier = Arc::new(Barrier::new(6));
        let mut handles = Vec::new();

        for _ in 0..6 {
            let cache = Arc::clone(&cache);
            let build_count = Arc::clone(&build_count);
            let barrier = Arc::clone(&barrier);
            let root = root.clone();
            handles.push(thread::spawn(move || {
                barrier.wait();
                get_or_build_file_mention_index_from_cache(&cache, &root, |path| {
                    build_count.fetch_add(1, AtomicOrdering::SeqCst);
                    thread::sleep(Duration::from_millis(25));
                    build_file_mention_index(path)
                })
                .expect("index")
            }));
        }

        let indexes = handles
            .into_iter()
            .map(|handle| handle.join().expect("worker"))
            .collect::<Vec<_>>();

        assert_eq!(build_count.load(AtomicOrdering::SeqCst), 1);
        assert!(indexes.iter().all(|index| Arc::ptr_eq(index, &indexes[0])));
    }

    #[test]
    fn clears_file_mention_build_slot_after_builder_panic() {
        let dir = tempdir().expect("tempdir");
        let root = dir.path().to_path_buf();
        fs::write(root.join("main.ts"), "").expect("source file");

        let cache = Mutex::new(FileMentionIndexCache::default());
        let panic_result = panic::catch_unwind(AssertUnwindSafe(|| {
            let _ = get_or_build_file_mention_index_from_cache(&cache, &root, |_| {
                panic!("index builder panic")
            });
        }));

        assert!(panic_result.is_err());

        let index =
            get_or_build_file_mention_index_from_cache(&cache, &root, build_file_mention_index)
                .expect("index");
        assert!(index
            .entries
            .iter()
            .any(|entry| entry.entry.filename == "main.ts"));
    }

    #[test]
    fn lists_directory_entries_with_expected_sorting_and_visibility() {
        let dir = tempdir().expect("tempdir");
        let root = dir.path();

        fs::create_dir_all(root.join(".git")).expect(".git dir");
        fs::create_dir_all(root.join(".github")).expect(".github dir");
        fs::create_dir_all(root.join("node_modules")).expect("node_modules dir");
        fs::create_dir_all(root.join("src")).expect("src dir");
        fs::write(root.join(".env"), "").expect(".env");
        fs::write(root.join(".gitignore"), "node_modules/\n").expect(".gitignore");
        fs::write(root.join("README.md"), "").expect("README");
        fs::write(root.join("alpha.ts"), "").expect("alpha");

        let entries = read_directory_entries(root).expect("entries");

        assert_eq!(
            entries,
            vec![
                super::FileTreeEntry {
                    name: ".github".into(),
                    path: root.join(".github").to_string_lossy().into_owned(),
                    kind: "directory".into(),
                },
                super::FileTreeEntry {
                    name: "node_modules".into(),
                    path: root.join("node_modules").to_string_lossy().into_owned(),
                    kind: "directory".into(),
                },
                super::FileTreeEntry {
                    name: "src".into(),
                    path: root.join("src").to_string_lossy().into_owned(),
                    kind: "directory".into(),
                },
                super::FileTreeEntry {
                    name: ".env".into(),
                    path: root.join(".env").to_string_lossy().into_owned(),
                    kind: "file".into(),
                },
                super::FileTreeEntry {
                    name: ".gitignore".into(),
                    path: root.join(".gitignore").to_string_lossy().into_owned(),
                    kind: "file".into(),
                },
                super::FileTreeEntry {
                    name: "alpha.ts".into(),
                    path: root.join("alpha.ts").to_string_lossy().into_owned(),
                    kind: "file".into(),
                },
                super::FileTreeEntry {
                    name: "README.md".into(),
                    path: root.join("README.md").to_string_lossy().into_owned(),
                    kind: "file".into(),
                },
            ]
        );
    }

    #[test]
    fn list_directory_entries_errors_for_missing_paths() {
        let dir = tempdir().expect("tempdir");
        let missing = dir.path().join("missing");

        let error = read_directory_entries(&missing).expect_err("missing dir should error");
        assert!(error.contains("Directory does not exist"));
    }

    #[test]
    fn build_file_tree_entry_skips_missing_children() {
        let dir = tempdir().expect("tempdir");
        let missing = dir.path().join("missing.ts");

        let entry = build_file_tree_entry(missing, "missing.ts".into());

        assert_eq!(entry, None);
    }

    #[test]
    #[cfg(unix)]
    fn list_directory_entries_errors_for_unreadable_directories() {
        let dir = tempdir().expect("tempdir");
        let blocked = dir.path().join("blocked");
        fs::create_dir(&blocked).expect("blocked dir");

        let original_permissions = fs::metadata(&blocked).expect("metadata").permissions();
        let mut unreadable_permissions = original_permissions.clone();
        unreadable_permissions.set_mode(0o000);
        fs::set_permissions(&blocked, unreadable_permissions).expect("set unreadable");

        let error = read_directory_entries(&blocked).expect_err("unreadable dir should error");

        let mut restored_permissions = original_permissions;
        restored_permissions.set_mode(0o700);
        fs::set_permissions(&blocked, restored_permissions).expect("restore permissions");

        assert!(error.contains("Failed to read directory"));
    }

    #[test]
    fn inspects_file_and_directory_attachments() {
        let dir = tempdir().expect("tempdir");
        let root = dir.path();
        let folder = root.join("screenshots");
        let file = root.join("report.txt");

        fs::create_dir_all(&folder).expect("folder");
        fs::write(&file, "hello").expect("file");

        let inspected_dir = inspect_attachment_path(&folder).expect("directory");
        let inspected_file = inspect_attachment_path(&file).expect("file");

        assert_eq!(inspected_dir.kind, "directory");
        assert_eq!(inspected_dir.name, "screenshots");
        assert_eq!(inspected_dir.mime_type, None);

        assert_eq!(inspected_file.kind, "file");
        assert_eq!(inspected_file.name, "report.txt");
        assert_eq!(inspected_file.mime_type.as_deref(), Some("text/plain"));
    }

    #[test]
    fn reads_image_attachment_payloads() {
        let dir = tempdir().expect("tempdir");
        let image = dir.path().join("pixel.png");
        let png_bytes = base64::engine::general_purpose::STANDARD
            .decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9sU4nS0AAAAASUVORK5CYII=")
            .expect("decode png");

        fs::write(&image, png_bytes).expect("png file");

        let payload = read_image_attachment(image.to_string_lossy().into_owned()).expect("payload");

        assert_eq!(payload.mime_type, "image/png");
        assert!(!payload.base64.is_empty());
    }

    #[test]
    fn dedupes_attachment_paths_using_platform_path_rules() {
        let normalized = normalize_attachment_paths(vec![
            "/tmp/Readme.md".into(),
            "/tmp/README.md".into(),
            "/tmp/Readme.md".into(),
        ]);

        if cfg!(any(target_os = "macos", target_os = "windows")) {
            assert_eq!(normalized, vec![PathBuf::from("/tmp/Readme.md")]);
        } else {
            assert_eq!(
                normalized,
                vec![
                    PathBuf::from("/tmp/Readme.md"),
                    PathBuf::from("/tmp/README.md")
                ]
            );
        }
    }

    #[test]
    fn ensure_directory_creates_nested_folders() {
        let dir = tempdir().expect("tempdir");
        let nested = dir.path().join("goose artifacts").join("chat-1234");

        ensure_directory_path(&nested).expect("directory should be created");

        assert!(nested.is_dir());
    }

    #[test]
    fn skips_invalid_attachment_paths_without_dropping_valid_ones() {
        let dir = tempdir().expect("tempdir");
        let valid = dir.path().join("report.txt");
        let missing = dir.path().join("missing.txt");
        fs::write(&valid, "hello").expect("file");

        let attachments = inspect_attachment_paths(vec![
            valid.to_string_lossy().into_owned(),
            missing.to_string_lossy().into_owned(),
        ])
        .expect("attachments");

        assert_eq!(attachments.len(), 1);
        assert_eq!(attachments[0].name, "report.txt");
        assert_eq!(attachments[0].kind, "file");
    }

    #[test]
    fn dedupes_mention_roots_using_platform_path_rules() {
        let normalized = normalize_roots(vec![
            "/tmp/Workspace".into(),
            "/tmp/workspace".into(),
            "/tmp/Workspace".into(),
        ]);

        if cfg!(any(target_os = "macos", target_os = "windows")) {
            assert_eq!(normalized, vec![PathBuf::from("/tmp/Workspace")]);
        } else {
            assert_eq!(
                normalized,
                vec![
                    PathBuf::from("/tmp/Workspace"),
                    PathBuf::from("/tmp/workspace")
                ]
            );
        }
    }

    #[test]
    fn rejects_oversized_image_attachment_payloads() {
        let dir = tempdir().expect("tempdir");
        let image = dir.path().join("huge.png");
        fs::write(
            &image,
            vec![0_u8; (MAX_IMAGE_ATTACHMENT_BYTES as usize) + 1],
        )
        .expect("oversized image file");

        let error =
            read_image_attachment(image.to_string_lossy().into_owned()).expect_err("size limit");

        assert!(error.contains(&format!(
            "exceeds the {} byte limit",
            MAX_IMAGE_ATTACHMENT_BYTES
        )));
    }

    #[test]
    fn rejects_non_http_external_urls() {
        assert!(validate_external_url("https://example.com").is_ok());
        assert!(validate_external_url("http://example.com").is_ok());
        assert!(validate_external_url("javascript:alert(1)").is_err());
        assert!(validate_external_url("file:///etc/passwd").is_err());
        assert!(validate_external_url("not a url").is_err());
    }
}
