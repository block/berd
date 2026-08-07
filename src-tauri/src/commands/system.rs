use base64::Engine;
use nucleo_matcher::pattern::{Atom, AtomKind, CaseMatching, Normalization};
use nucleo_matcher::{Config, Matcher, Utf32Str};
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
/// IPC guard: the renderer caps mention queries at 256 chars; reject
/// anything materially larger before scanning the index.
const MAX_FILE_MENTION_QUERY_BYTES: usize = 1024;
const MAX_IMAGE_ATTACHMENT_BYTES: u64 = 20 * 1024 * 1024;
/// Cap for in-app text/markdown viewing. Larger files fall back to
/// "open externally" in the renderer rather than being read into memory.
const MAX_TEXT_FILE_BYTES: u64 = 2 * 1024 * 1024;
/// Number of leading bytes inspected for a NUL byte to classify a file as
/// binary (and therefore not safe to render as text).
const TEXT_FILE_BINARY_SNIFF_BYTES: usize = 8192;

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

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum FileMentionHighlightTarget {
    Filename,
    Path,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileMentionMatchHighlight {
    /// Which rendered string the indices apply to.
    pub target: FileMentionHighlightTarget,
    /// Char indices (not bytes) of matched characters in the target string.
    pub indices: Vec<u32>,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileMentionPathEntry {
    pub resolved_path: String,
    pub display_path: String,
    pub filename: String,
    pub kind: String,
    pub source: String,
    /// Match tier assigned by the native matcher (lower is better).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub match_rank: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub match_highlight: Option<FileMentionMatchHighlight>,
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
    /// Nucleo fuzzy score; higher is better, 0 for non-fuzzy ranks.
    fuzzy_score: u16,
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
    match_kind: FileMentionMatchKind,
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
    let mut command = std::process::Command::new("cmd");
    command.args(["/C", "start", "", "chrome", url]);
    crate::services::process::apply_no_window(&mut command);
    command.spawn().is_ok()
}

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
fn try_launch_chrome(_url: &str) -> bool {
    false
}

#[tauri::command]
pub async fn save_exported_agent_file(
    window: Window,
    default_filename: String,
    contents: String,
) -> Result<Option<String>, String> {
    let desktop =
        dirs::desktop_dir().unwrap_or_else(|| dirs::home_dir().unwrap_or_default().join("Desktop"));

    let mut dialog = window
        .dialog()
        .file()
        .set_title("Export Agent")
        .set_file_name(default_filename)
        .set_directory(desktop)
        .add_filter("Markdown", &["md"]);

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

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TextFilePayload {
    pub contents: String,
    pub byte_size: u64,
    pub truncated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
}

fn looks_binary(bytes: &[u8]) -> bool {
    bytes
        .iter()
        .take(TEXT_FILE_BINARY_SNIFF_BYTES)
        .any(|&byte| byte == 0)
}

/// Read a UTF-8 text file for in-app viewing. Rejects directories, binary
/// files, and files that exceed `MAX_TEXT_FILE_BYTES` so the renderer can
/// fall back to opening them externally.
#[tauri::command]
pub fn read_text_file(path: String) -> Result<TextFilePayload, String> {
    let target = Path::new(&path);
    if !target.exists() {
        return Err(format!("File does not exist: {}", target.display()));
    }

    let metadata = fs::metadata(target)
        .map_err(|error| format!("Failed to inspect '{}': {}", target.display(), error))?;
    if metadata.is_dir() {
        return Err(format!("Path is a directory: {}", target.display()));
    }

    let byte_size = metadata.len();
    if byte_size > MAX_TEXT_FILE_BYTES {
        return Err(format!(
            "File '{}' exceeds the {} byte text-viewing limit",
            target.display(),
            MAX_TEXT_FILE_BYTES
        ));
    }

    let bytes = fs::read(target)
        .map_err(|error| format!("Failed to read '{}': {}", target.display(), error))?;

    if looks_binary(&bytes) {
        return Err(format!("File appears to be binary: {}", target.display()));
    }

    let contents = String::from_utf8(bytes)
        .map_err(|_| format!("File is not valid UTF-8 text: {}", target.display()))?;

    let mime_type = mime_guess::from_path(target)
        .first_raw()
        .map(std::borrow::ToOwned::to_owned);

    Ok(TextFilePayload {
        contents,
        byte_size,
        truncated: false,
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
        match_rank: None,
        match_highlight: None,
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
        match_rank: None,
        match_highlight: None,
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
    let mut command = Command::new("git");
    command.arg("-C").arg(root_path).args([
        "ls-files",
        "-z",
        "--cached",
        "--others",
        "--exclude-standard",
        "--",
        ".",
    ]);
    crate::services::process::apply_no_window(&mut command);
    let output = command.output().ok()?;

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

/// Reusable nucleo matcher state for one query across all index entries.
struct FileMentionQueryMatcher {
    matcher: Matcher,
    haystack_buf: Vec<char>,
    /// Present only when the query qualifies for fuzzy matching.
    fuzzy_atom: Option<Atom>,
}

fn file_mention_atom(query: &str, kind: AtomKind) -> Atom {
    Atom::new(
        query,
        CaseMatching::Ignore,
        Normalization::Smart,
        kind,
        false,
    )
}

impl FileMentionQueryMatcher {
    fn new(normalized_query: &str) -> Self {
        let mut config = Config::DEFAULT.match_paths();
        config.prefer_prefix = true;
        let fuzzy_enabled = !normalized_query.contains('/')
            && normalized_query.chars().count() >= MIN_FILE_MENTION_FUZZY_QUERY_CHARS;
        Self {
            matcher: Matcher::new(config),
            haystack_buf: Vec::new(),
            fuzzy_atom: fuzzy_enabled.then(|| file_mention_atom(normalized_query, AtomKind::Fuzzy)),
        }
    }

    fn fuzzy_score(&mut self, haystack: &str) -> Option<u16> {
        let atom = self.fuzzy_atom.as_ref()?;
        let haystack = Utf32Str::new(haystack, &mut self.haystack_buf);
        atom.score(haystack, &mut self.matcher)
    }

    /// Char indices of the matched characters in `haystack`, for UI highlighting.
    ///
    /// Restricted to ASCII haystacks: nucleo's index space only equals
    /// codepoint indices for pure-ASCII strings — for others it can be UTF-8
    /// byte offsets (NFD text) or grapheme positions (emoji), which would
    /// highlight the wrong characters. Non-ASCII names still match and rank;
    /// they just render without the cosmetic highlight.
    fn match_indices(&mut self, haystack: &str, query: &str, kind: AtomKind) -> Option<Vec<u32>> {
        if !haystack.is_ascii() {
            return None;
        }
        let rebuilt;
        let atom = match (kind, &self.fuzzy_atom) {
            (AtomKind::Fuzzy, Some(fuzzy_atom)) => fuzzy_atom,
            _ => {
                rebuilt = file_mention_atom(query, kind);
                &rebuilt
            }
        };
        let haystack = Utf32Str::new(haystack, &mut self.haystack_buf);
        let mut indices = Vec::new();
        atom.indices(haystack, &mut self.matcher, &mut indices)?;
        indices.sort_unstable();
        indices.dedup();
        Some(indices)
    }
}

/// How an entry matched: which rendered string to highlight and with what
/// nucleo atom. Produced by scoring so highlighting never re-derives it.
#[derive(Clone, Copy)]
struct FileMentionMatchKind {
    target: FileMentionHighlightTarget,
    atom_kind: AtomKind,
}

const MATCH_FILENAME_PREFIX: FileMentionMatchKind = FileMentionMatchKind {
    target: FileMentionHighlightTarget::Filename,
    atom_kind: AtomKind::Prefix,
};
const MATCH_FILENAME_FUZZY: FileMentionMatchKind = FileMentionMatchKind {
    target: FileMentionHighlightTarget::Filename,
    atom_kind: AtomKind::Fuzzy,
};
const MATCH_PATH_SUBSTRING: FileMentionMatchKind = FileMentionMatchKind {
    target: FileMentionHighlightTarget::Path,
    atom_kind: AtomKind::Substring,
};
const MATCH_PATH_FUZZY: FileMentionMatchKind = FileMentionMatchKind {
    target: FileMentionHighlightTarget::Path,
    atom_kind: AtomKind::Fuzzy,
};

/// The root-relative portion of a project entry's display path
/// (`display_path` is `<root name>/<relative path>`).
fn relative_display_path(entry: &FileMentionPathEntry) -> &str {
    entry
        .display_path
        .split_once('/')
        .map_or(entry.display_path.as_str(), |(_, relative)| relative)
}

fn score_file_mention_entry(
    entry: &IndexedFileMentionEntry,
    normalized_query: &str,
    query_matcher: &mut FileMentionQueryMatcher,
) -> Option<(FileMentionScore, FileMentionMatchKind)> {
    if normalized_query.contains('/') {
        if entry.normalized_relative_path == normalized_query {
            return Some((file_mention_score(entry, 0, 0, 0), MATCH_PATH_SUBSTRING));
        }
        if entry.normalized_relative_path.starts_with(normalized_query) {
            return Some((file_mention_score(entry, 1, 0, 0), MATCH_PATH_SUBSTRING));
        }
        let match_position = entry.normalized_relative_path.find(normalized_query)?;
        return Some((
            file_mention_score(entry, 3, match_position, 0),
            MATCH_PATH_SUBSTRING,
        ));
    }

    if entry.normalized_filename == normalized_query {
        return Some((file_mention_score(entry, 0, 0, 0), MATCH_FILENAME_PREFIX));
    }
    if entry.normalized_filename.starts_with(normalized_query) {
        return Some((file_mention_score(entry, 1, 0, 0), MATCH_FILENAME_PREFIX));
    }
    if let Some(match_position) =
        find_file_mention_segment_prefix(&entry.normalized_relative_path, normalized_query)
    {
        return Some((
            file_mention_score(entry, 2, match_position, 0),
            MATCH_PATH_SUBSTRING,
        ));
    }
    if let Some(match_position) = entry.normalized_relative_path.find(normalized_query) {
        return Some((
            file_mention_score(entry, 3, match_position, 0),
            MATCH_PATH_SUBSTRING,
        ));
    }

    // Fuzzy tiers score against original-case strings so nucleo's
    // word-boundary bonuses see camelCase humps.
    if let Some(score) = query_matcher.fuzzy_score(&entry.entry.filename) {
        return Some((file_mention_score(entry, 4, 0, score), MATCH_FILENAME_FUZZY));
    }
    if let Some(score) = query_matcher.fuzzy_score(relative_display_path(&entry.entry)) {
        return Some((file_mention_score(entry, 5, 0, score), MATCH_PATH_FUZZY));
    }

    None
}

/// Compute where the match landed in the rendered string, for dropdown
/// highlighting. Path matches are located in the root-relative portion —
/// the same string scoring matched, so the root name can't shadow the real
/// match — then offset to indices into the rendered `display_path`.
fn file_mention_match_highlight(
    query_matcher: &mut FileMentionQueryMatcher,
    entry: &FileMentionPathEntry,
    kind: FileMentionMatchKind,
    normalized_query: &str,
) -> Option<FileMentionMatchHighlight> {
    let (haystack, char_offset) = match kind.target {
        FileMentionHighlightTarget::Filename => (entry.filename.as_str(), 0),
        FileMentionHighlightTarget::Path => {
            let relative = relative_display_path(entry);
            let prefix = &entry.display_path[..entry.display_path.len() - relative.len()];
            (relative, prefix.chars().count() as u32)
        }
    };
    let mut indices = query_matcher.match_indices(haystack, normalized_query, kind.atom_kind)?;
    if char_offset > 0 {
        for index in &mut indices {
            *index += char_offset;
        }
    }
    Some(FileMentionMatchHighlight {
        target: kind.target,
        indices,
    })
}

fn file_mention_score(
    entry: &IndexedFileMentionEntry,
    rank: u8,
    match_position: usize,
    fuzzy_score: u16,
) -> FileMentionScore {
    FileMentionScore {
        rank,
        match_position,
        fuzzy_score,
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
        .then_with(|| right.fuzzy_score.cmp(&left.fuzzy_score))
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
    if max_results == 0 {
        return Vec::new();
    }
    if normalized_query.is_empty() {
        let mut matches = Vec::new();
        for entry in index.entries.iter().filter(|entry| {
            entry.depth == 1 && !has_hidden_path_segment(&entry.normalized_relative_path)
        }) {
            let mut path_entry = entry.entry.clone();
            path_entry.match_rank = Some(0);
            path_entry.match_highlight = None;
            let candidate = FileMentionCandidate {
                normalized_resolved_path: normalized_path_key(Path::new(&path_entry.resolved_path)),
                normalized_relative_path: entry.normalized_relative_path.clone(),
                entry: path_entry,
                score: file_mention_score(entry, 0, 0, 0),
            };
            insert_ranked_file_mention_candidate(&mut matches, candidate, max_results);
        }
        return matches;
    }

    let mut query_matcher = FileMentionQueryMatcher::new(&normalized_query);

    let mut matches: Vec<IndexedFileMentionCandidate<'_>> = Vec::new();
    for entry in &index.entries {
        let Some((score, match_kind)) =
            score_file_mention_entry(entry, &normalized_query, &mut query_matcher)
        else {
            continue;
        };
        let candidate = IndexedFileMentionCandidate {
            entry,
            score,
            match_kind,
        };
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
        .map(|candidate| {
            let mut entry = candidate.entry.entry.clone();
            entry.match_rank = Some(candidate.score.rank);
            entry.match_highlight = file_mention_match_highlight(
                &mut query_matcher,
                &entry,
                candidate.match_kind,
                &normalized_query,
            );
            FileMentionCandidate {
                normalized_resolved_path: normalized_path_key(Path::new(&entry.resolved_path)),
                normalized_relative_path: candidate.entry.normalized_relative_path.clone(),
                entry,
                score: candidate.score,
            }
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
    if let Some(existing_index) = matches.iter().position(|existing| {
        existing.normalized_resolved_path == candidate.normalized_resolved_path
    }) {
        // The same path can match under multiple roots (e.g. nested roots)
        // with different scores; keep whichever scored better.
        if compare_file_mention_candidates(&candidate, &matches[existing_index]).is_lt() {
            matches.remove(existing_index);
        } else {
            return;
        }
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
        fuzzy_score: 0,
        directory_penalty: if is_directory { 0 } else { 1 },
        depth: path.components().count(),
        // Use the parent directory's length so entries from the same listing
        // tie here and fall through to the lexicographic comparison —
        // directory listings should read alphabetically, not shortest-first.
        path_len: path.parent().map_or(0, |dir| dir.to_string_lossy().len()),
    })
}

/// Filesystem-mode matches are exact/prefix/substring on the filename, so the
/// highlight is the contiguous run the scorer already located — no second
/// matching pass needed. ASCII-only for the same reason as `match_indices`:
/// `match_position` is a byte offset into the lowercased name, which only
/// equals a char index in the original-case name when both are ASCII.
fn filesystem_file_mention_highlight(
    name: &str,
    partial: &str,
    score: FileMentionScore,
) -> Option<FileMentionMatchHighlight> {
    if partial.is_empty() || !name.is_ascii() || !partial.is_ascii() {
        return None;
    }
    let start = match score.rank {
        0 | 1 => 0,
        3 => score.match_position,
        _ => return None,
    } as u32;
    let len = partial.chars().count() as u32;
    Some(FileMentionMatchHighlight {
        target: FileMentionHighlightTarget::Filename,
        indices: (start..start + len).collect(),
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

    for candidate in &mut matches {
        candidate.entry.match_rank = Some(candidate.score.rank);
        candidate.entry.match_highlight =
            filesystem_file_mention_highlight(&candidate.entry.filename, &partial, candidate.score);
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
    if query.is_empty() || query.len() > MAX_FILE_MENTION_QUERY_BYTES {
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

    if is_filesystem_query && matches.is_empty() {
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
        read_directory_entries, read_image_attachment, read_text_file,
        search_file_mentions_blocking, validate_external_url, FileMentionIndexCache,
        MAX_IMAGE_ATTACHMENT_BYTES, MAX_TEXT_FILE_BYTES,
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
    fn falls_back_to_filesystem_for_absolute_hidden_paths_under_project_root() {
        let dir = git_tempdir();
        let root = dir.path();
        let hidden = root.join(".visible.ts");

        fs::write(&hidden, "").expect("hidden file");

        let entries = search_file_mentions_blocking(
            vec![root.to_string_lossy().to_string()],
            format!("{}/.vis", root.to_string_lossy()),
            Some(10),
        );

        assert!(
            entries.iter().any(|entry| {
                entry.resolved_path == hidden.to_string_lossy()
                    && entry.filename == ".visible.ts"
                    && entry.kind == "file"
                    && entry.source == "filesystem"
            }),
            "absolute hidden path should fall back to filesystem results: {entries:?}"
        );
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
    fn ranks_camel_case_boundary_fuzzy_matches_first() {
        let dir = git_tempdir();
        let root = dir.path();

        fs::write(root.join("useChatSession.ts"), "").expect("camel file");
        fs::write(root.join("music-store.ts"), "").expect("kebab file");

        let entries = search_mentions(root, "ucs", 10);
        assert_eq!(
            entries.first().map(|entry| entry.filename.as_str()),
            Some("useChatSession.ts"),
            "camelCase boundary match should outrank mid-word match: {entries:?}"
        );
    }

    #[test]
    fn fuzzy_matches_normalize_unicode_accents() {
        let dir = git_tempdir();
        let root = dir.path();

        fs::write(root.join("café.md"), "").expect("accented file");

        let entries = search_mentions(root, "cafe", 10);
        let entry = entries
            .iter()
            .find(|entry| entry.filename == "café.md")
            .expect("expected unaccented query to match accented filename");
        // nucleo's indices are not codepoint-aligned for non-ASCII strings,
        // so non-ASCII names match but don't get a highlight.
        assert!(entry.match_highlight.is_none());
    }

    #[test]
    fn rejects_oversized_queries() {
        let dir = git_tempdir();
        let root = dir.path();
        fs::write(root.join("main.ts"), "").expect("source file");

        let oversized = "a".repeat(super::MAX_FILE_MENTION_QUERY_BYTES + 1);
        let entries = search_file_mentions_blocking(
            vec![root.to_string_lossy().to_string()],
            oversized,
            Some(10),
        );
        assert!(entries.is_empty());
    }

    #[test]
    fn path_highlights_skip_query_matches_in_the_root_name() {
        let dir = git_tempdir();
        let search_root = dir.path().join("api-root");
        let nested = search_root.join("src").join("api");

        fs::create_dir_all(&nested).expect("nested dirs");
        fs::write(nested.join("client.ts"), "").expect("client file");

        let entries = search_mentions(&search_root, "api", 50);
        let entry = entries
            .iter()
            .find(|entry| entry.filename == "client.ts")
            .expect("client entry");
        let highlight = entry.match_highlight.as_ref().expect("highlight");
        assert_eq!(highlight.target, super::FileMentionHighlightTarget::Path);
        // display_path is "api-root/src/api/client.ts"; the highlight must
        // land on the real path match, not the "api" inside the root name.
        let chars: Vec<char> = entry.display_path.chars().collect();
        let matched: String = highlight
            .indices
            .iter()
            .map(|&index| chars[index as usize])
            .collect();
        assert_eq!(matched, "api");
        assert!(
            highlight.indices.iter().all(|&index| index >= 9),
            "indices should be past the root-name prefix: {highlight:?}"
        );
    }

    #[test]
    fn keeps_better_scored_duplicate_across_nested_roots() {
        let dir = git_tempdir();
        let root = dir.path();
        let sub = root.join("sub");

        fs::create_dir_all(sub.join("components")).expect("sub components dir");
        fs::create_dir_all(root.join("components")).expect("root components dir");
        fs::write(root.join("components").join("button.tsx"), "").expect("outer file");
        fs::write(sub.join("components").join("button.ts"), "").expect("inner file");

        // The inner file matches exactly under the `sub` root (rank 0) but
        // only as a substring under the outer root; the exact rank must win
        // regardless of root order.
        for roots in [
            vec![
                root.to_string_lossy().to_string(),
                sub.to_string_lossy().to_string(),
            ],
            vec![
                sub.to_string_lossy().to_string(),
                root.to_string_lossy().to_string(),
            ],
        ] {
            let entries =
                search_file_mentions_blocking(roots, "components/button.ts".to_string(), Some(10));
            let entry = entries
                .iter()
                .find(|entry| entry.filename == "button.ts")
                .expect("inner file present");
            assert_eq!(
                entry.match_rank,
                Some(0),
                "exact match rank should survive dedup: {entries:?}"
            );
        }
    }

    #[test]
    fn lists_filesystem_directories_alphabetically() {
        let dir = tempdir().expect("tempdir");
        let root = dir.path();

        for name in ["zebra", "alpha", "mango"] {
            fs::create_dir_all(root.join(name)).expect("dir");
        }
        fs::write(root.join("b-file"), "").expect("file");

        let entries =
            search_file_mentions_blocking(vec![], format!("{}/", root.to_string_lossy()), Some(10));
        let names: Vec<&str> = entries
            .iter()
            .map(|entry| entry.filename.as_str())
            .collect();
        assert_eq!(
            names,
            vec!["alpha", "mango", "zebra", "b-file"],
            "directories first, alphabetical within each group"
        );
    }

    #[test]
    fn lists_project_root_children_for_root_path_query() {
        let dir = git_tempdir();
        let root = dir.path();

        for name in ["zebra", "alpha", "mango"] {
            fs::create_dir_all(root.join(name)).expect("dir");
        }
        fs::write(root.join("b-file"), "").expect("file");

        for query in [
            root.to_string_lossy().to_string(),
            format!("{}/", root.to_string_lossy()),
        ] {
            let entries = search_file_mentions_blocking(
                vec![root.to_string_lossy().to_string()],
                query,
                Some(10),
            );
            let names: Vec<&str> = entries
                .iter()
                .map(|entry| entry.filename.as_str())
                .collect();
            assert_eq!(names, vec!["alpha", "mango", "zebra", "b-file"]);
            assert!(
                entries.iter().all(|entry| entry.source == "project"),
                "root path query should return project entries: {entries:?}"
            );
        }
    }

    #[test]
    fn returns_filename_highlight_indices_for_prefix_matches() {
        let dir = git_tempdir();
        let root = dir.path();

        fs::write(root.join("main.ts"), "").expect("source file");

        let entries = search_mentions(root, "mai", 10);
        let entry = entries
            .iter()
            .find(|entry| entry.filename == "main.ts")
            .expect("main entry");
        let highlight = entry.match_highlight.as_ref().expect("highlight");
        assert_eq!(
            highlight.target,
            super::FileMentionHighlightTarget::Filename
        );
        assert_eq!(highlight.indices, vec![0, 1, 2]);
    }

    #[test]
    fn returns_fuzzy_highlight_indices_for_scattered_matches() {
        let dir = git_tempdir();
        let root = dir.path();

        fs::write(root.join("readme.md"), "").expect("readme file");

        let entries = search_mentions(root, "rdme", 10);
        let entry = entries
            .iter()
            .find(|entry| entry.filename == "readme.md")
            .expect("readme entry");
        let highlight = entry.match_highlight.as_ref().expect("highlight");
        assert_eq!(
            highlight.target,
            super::FileMentionHighlightTarget::Filename
        );
        assert_eq!(highlight.indices, vec![0, 3, 4, 5]);
    }

    #[test]
    fn returns_path_highlight_for_slash_queries() {
        let dir = git_tempdir();
        let root = dir.path();
        let api = root.join("Src").join("API");

        fs::create_dir_all(&api).expect("api dir");
        fs::write(api.join("Client.ts"), "").expect("client file");

        let entries = search_mentions(root, "src/api", 50);
        let entry = entries
            .iter()
            .find(|entry| entry.filename == "Client.ts")
            .expect("client entry");
        let highlight = entry.match_highlight.as_ref().expect("highlight");
        assert_eq!(highlight.target, super::FileMentionHighlightTarget::Path);
        let chars: Vec<char> = entry.display_path.chars().collect();
        let matched: String = highlight
            .indices
            .iter()
            .map(|&index| chars[index as usize])
            .collect();
        assert_eq!(matched.to_lowercase(), "src/api");
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
    fn read_text_file_returns_utf8_contents() {
        let dir = tempdir().expect("tempdir");
        let path = dir.path().join("notes.md");
        fs::write(&path, "# Title\n\nhello").expect("write");

        let payload = read_text_file(path.to_string_lossy().into_owned()).expect("read text file");
        assert_eq!(payload.contents, "# Title\n\nhello");
        assert!(!payload.truncated);
        assert_eq!(payload.byte_size, "# Title\n\nhello".len() as u64);
    }

    #[test]
    fn read_text_file_rejects_binary_files() {
        let dir = tempdir().expect("tempdir");
        let path = dir.path().join("blob.md");
        fs::write(&path, [b'o', b'k', 0u8, b'!']).expect("write");

        let error =
            read_text_file(path.to_string_lossy().into_owned()).expect_err("binary should error");
        assert!(error.contains("binary"), "unexpected error: {error}");
    }

    #[test]
    fn read_text_file_rejects_directories() {
        let dir = tempdir().expect("tempdir");
        let error = read_text_file(dir.path().to_string_lossy().into_owned())
            .expect_err("directory should error");
        assert!(error.contains("directory"), "unexpected error: {error}");
    }

    #[test]
    fn read_text_file_rejects_files_over_limit() {
        let dir = tempdir().expect("tempdir");
        let path = dir.path().join("big.md");
        fs::write(&path, vec![b'a'; (MAX_TEXT_FILE_BYTES as usize) + 1]).expect("write");

        let error = read_text_file(path.to_string_lossy().into_owned())
            .expect_err("oversized should error");
        assert!(error.contains("limit"), "unexpected error: {error}");
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
