//! Encrypted memory commands. Only explicit initialization may create a key.
//! Generic filesystem commands must never be used to read active memory.

use berd_memory::normalize_memory_document_text;
use berd_memory::store::{is_uninitialized, read_import_text, MemoryStore};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use tauri::Window;
use tauri_plugin_dialog::DialogExt;

pub(crate) const MAX_DOCUMENT_BYTES: usize = 1024 * 1024;

pub fn memory_store_root() -> Result<PathBuf, String> {
    berd_memory::memory_root()
}

/// Only logical document names are exposed to renderer writers. Resolution and
/// no-symlink filesystem access are additionally enforced by MemoryStore.
pub(crate) fn relative_path(
    path: &str,
    root: &Path,
    allow_pending: bool,
) -> Result<String, String> {
    let supplied = Path::new(path);
    #[cfg(windows)]
    let supplied = dunce::simplified(supplied);
    #[cfg(windows)]
    let root = dunce::simplified(root);
    if !supplied.is_absolute()
        || path
            .split(std::path::is_separator)
            .any(|part| part == "." || part == "..")
        || supplied
            .components()
            .any(|c| matches!(c, Component::ParentDir | Component::CurDir))
    {
        return Err("Memory path must be an absolute path without traversal".into());
    }
    let relative = supplied
        .strip_prefix(root)
        .map_err(|_| "Path is outside the memory store".to_string())?;
    let name = relative
        .components()
        .map(|component| match component {
            Component::Normal(part) => part.to_str().ok_or("Memory path must be UTF-8"),
            _ => Err("Memory path must not contain traversal"),
        })
        .collect::<Result<Vec<_>, _>>()?
        .join("/");
    if is_document_name(&name) || (allow_pending && name == "proposals/pending.jsonl") {
        // Filenames are public metadata, so do not allow them to carry hidden
        // characters or access material either. Never rename a path implicitly.
        let normalized = admit_reviewed_memory_document(&name)?;
        if normalized != name {
            return Err("Memory filenames must use normalized Unicode".into());
        }
        Ok(name)
    } else {
        Err("Only me.md and topics/*.md are editable memory documents".into())
    }
}

pub(crate) fn is_document_name(name: &str) -> bool {
    if name == "me.md" {
        return true;
    }
    let Some(file) = name.strip_prefix("topics/") else {
        return false;
    };
    !file.is_empty()
        && !file.starts_with('.')
        && file.ends_with(".md")
        && !file.contains(['/', '\\'])
        && file.len() > 3
}

pub(crate) fn admit_reviewed_memory_document(contents: &str) -> Result<String, String> {
    if contents.len() > MAX_DOCUMENT_BYTES {
        return Err("Memory documents must be 1 MiB or smaller".into());
    }
    let normalized = normalize_memory_document_text(contents).map_err(|e| e.to_string())?;
    if normalized.len() > MAX_DOCUMENT_BYTES {
        return Err("Memory documents must be 1 MiB or smaller".into());
    }
    if berd_memory::looks_like_credential(&normalized) {
        return Err("Authentication and access data can't be saved to memory".into());
    }
    Ok(normalized)
}

/// The caller holds the store lock. The encrypted journal commits the exact
/// reviewed document and approval together, and is replayed after interruption.
pub(crate) fn write_reviewed_document(
    store: &MemoryStore,
    relative: &str,
    contents: &str,
    create_new: bool,
) -> Result<(), String> {
    if !is_document_name(relative) {
        return Err("Invalid memory document path".into());
    }
    let contents = admit_reviewed_memory_document(contents)?;
    store.commit_reviewed_document(relative, &contents, create_new, None)
}

/// IPC document paths use '/' on every platform. Never validate or expose a
/// lossy conversion, which could conflate distinct filesystem names.
fn portable_path(path: &Path) -> Result<String, String> {
    #[cfg(windows)]
    let path = dunce::simplified(path);
    let path = path.to_str().ok_or("Memory path must be UTF-8")?;
    #[cfg(windows)]
    let path = path.replace('\\', "/");
    Ok(path.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryTextPayload {
    pub path: String,
    pub contents: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryDocument {
    pub path: String,
    pub file_name: String,
    pub contents: String,
}

/// Missing directories are empty; every other listing/decryption failure is
/// reported. Never silently replace an unreadable document with a template.
pub(crate) fn documents_at(store: &MemoryStore) -> Result<Vec<MemoryDocument>, String> {
    let names = store.document_paths()?;
    let mut documents = Vec::new();
    for name in names {
        let contents = store
            .read(&name)?
            .ok_or("Memory document disappeared while listing; try again")?;
        documents.push(MemoryDocument {
            path: portable_path(&store.root().join(&name))?,
            file_name: name.rsplit('/').next().unwrap_or(&name).to_string(),
            contents,
        });
    }
    Ok(documents)
}

#[tauri::command]
pub fn initialize_memory_store() -> Result<(), String> {
    MemoryStore::initialize(&memory_store_root()?).map(|_| ())
}

#[tauri::command]
pub fn read_memory_text_file(path: String) -> Result<MemoryTextPayload, String> {
    let root = memory_store_root()?;
    let relative = relative_path(&path, &root, true)?;
    let store = MemoryStore::open(&root)?;
    let _lock = store.lock()?;
    if relative == "proposals/pending.jsonl" {
        // Authentication alone does not establish that queue JSON is valid.
        // Do not let renderer parsing silently discard malformed records.
        store.records(&relative)?;
    }
    let contents = store
        .read(&relative)?
        .ok_or_else(|| "Memory file does not exist".to_string())?;
    Ok(MemoryTextPayload {
        path: portable_path(&root.join(relative))?,
        contents,
    })
}

#[tauri::command]
pub fn list_memory_documents() -> Result<Vec<MemoryDocument>, String> {
    let root = memory_store_root()?;
    if is_uninitialized(&root)? {
        return Ok(Vec::new());
    }
    let store = MemoryStore::open(&root)?;
    let _lock = store.lock()?;
    documents_at(&store)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryRecallSnapshot {
    pub documents: Vec<MemoryDocument>,
}

/// Recall is a separate capability from the Settings reader: policy is checked
/// before requesting a key, and again under the same lock used by policy writes.
#[tauri::command]
pub fn read_memory_recall_snapshot() -> Result<Option<MemoryRecallSnapshot>, String> {
    recall_snapshot_with(&memory_store_root()?, MemoryStore::open)
}

fn recall_snapshot_with(
    root: &Path,
    open: impl FnOnce(&Path) -> Result<MemoryStore, String>,
) -> Result<Option<MemoryRecallSnapshot>, String> {
    if !policy_enabled_at(root) {
        return Ok(None);
    }
    if is_uninitialized(root)? {
        let _lock = berd_memory::store::acquire_store_lock(root)?;
        if !policy_enabled_at(root) {
            return Ok(None);
        }
        // A concurrent initialization can only make this empty snapshot stale;
        // it cannot disclose content. Freshness inspection takes its own lock.
        return Ok(Some(MemoryRecallSnapshot {
            documents: Vec::new(),
        }));
    }
    let store = open(root)?;
    recall_snapshot_at(&store)
}

fn recall_snapshot_at(store: &MemoryStore) -> Result<Option<MemoryRecallSnapshot>, String> {
    let _lock = store.lock()?;
    if !policy_enabled_at(store.root()) {
        return Ok(None);
    }
    let mut documents = Vec::new();
    for document in documents_at(store)? {
        let relative = relative_path(&document.path, store.root(), false)?;
        // Never silently normalize an approved document at recall time: exact
        // bytes must match both the content contract and the approval digest.
        if admit_reviewed_memory_document(&document.contents).as_deref()
            != Ok(document.contents.as_str())
        {
            continue;
        }
        if store.is_approved(&relative, &document.contents)? {
            documents.push(document);
        }
    }
    if !policy_enabled_at(store.root()) {
        return Ok(None);
    }
    Ok(Some(MemoryRecallSnapshot { documents }))
}

#[tauri::command]
pub fn is_memory_content_approved(path: String, contents: String) -> Result<bool, String> {
    let root = memory_store_root()?;
    let relative = relative_path(&path, &root, false)?;
    let contents = admit_reviewed_memory_document(&contents)?;
    let store = MemoryStore::open(&root)?;
    let _lock = store.lock()?;
    // Authenticate the current document as well; stale renderer text is not an approval.
    if store.read(&relative)?.as_deref() != Some(contents.as_str()) {
        return Ok(false);
    }
    store.is_approved(&relative, &contents)
}

fn save_document(path: String, contents: String, create_new: bool) -> Result<(), String> {
    let root = memory_store_root()?;
    let relative = relative_path(&path, &root, false)?;
    let store = MemoryStore::open(&root)?;
    let _lock = store.lock()?;
    write_reviewed_document(&store, &relative, &contents, create_new)
}

#[tauri::command]
pub fn create_memory_text_file(path: String, contents: String) -> Result<(), String> {
    save_document(path, contents, true)
}

#[tauri::command]
pub fn write_memory_text_file(path: String, contents: String) -> Result<(), String> {
    super::memory_queue::save_reviewed_memory_document(path, contents, None)
}

#[derive(Serialize, Deserialize, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct MemoryPolicy {
    pub enabled: bool,
}

pub(crate) fn read_policy_at(root: &Path) -> Result<Option<MemoryPolicy>, String> {
    berd_memory::store::read_policy(root)
        .map(|enabled| enabled.map(|enabled| MemoryPolicy { enabled }))
}

pub(crate) fn policy_enabled_at(root: &Path) -> bool {
    matches!(
        read_policy_at(root),
        Ok(Some(MemoryPolicy { enabled: true }))
    )
}

#[tauri::command]
pub fn read_memory_policy() -> Result<Option<MemoryPolicy>, String> {
    read_policy_at(&memory_store_root()?)
}

#[tauri::command]
pub fn write_memory_policy(enabled: bool) -> Result<(), String> {
    write_policy_at(&memory_store_root()?, enabled)
}

pub(crate) fn write_policy_at(root: &Path, enabled: bool) -> Result<(), String> {
    berd_memory::store::write_policy(root, enabled)
}

fn import_text_at(path: &Path) -> Result<String, String> {
    let text = read_import_text(path, MAX_DOCUMENT_BYTES)?;
    admit_reviewed_memory_document(&text)
}

#[tauri::command]
pub async fn import_memory_markdown(window: Window) -> Result<Option<String>, String> {
    let mut dialog = window
        .dialog()
        .file()
        .set_title("Import Markdown for review")
        .add_filter("Markdown", &["md"]);
    #[cfg(desktop)]
    {
        dialog = dialog.set_parent(&window);
    }
    let Some(path) = dialog.blocking_pick_file() else {
        return Ok(None);
    };
    let path = path
        .into_path()
        .map_err(|_| "Selected Markdown path is not available")?;
    import_text_at(&path).map(Some)
}

fn export_target(path: &Path, root: &Path) -> Result<PathBuf, String> {
    if !path.is_absolute()
        || path
            .components()
            .any(|c| matches!(c, Component::ParentDir | Component::CurDir))
    {
        return Err("Invalid Markdown export path".into());
    }
    let parent = path
        .parent()
        .ok_or("Export path must name a file")?
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let target = parent.join(path.file_name().ok_or("Export path must name a file")?);
    let root = root.canonicalize().map_err(|e| e.to_string())?;
    if target.starts_with(&root) {
        return Err("Export Markdown outside the active memory store".into());
    }
    match fs::symlink_metadata(&target) {
        Ok(meta) if meta.file_type().is_symlink() || !meta.is_file() => {
            return Err("Export target must be a regular file, not a symlink".into())
        }
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e.to_string()),
        _ => {}
    }
    Ok(target)
}

#[tauri::command]
pub async fn export_memory_markdown(
    window: Window,
    path: String,
) -> Result<Option<String>, String> {
    let root = memory_store_root()?;
    let relative = relative_path(&path, &root, false)?;
    let contents = {
        let store = MemoryStore::open(&root)?;
        let _lock = store.lock()?;
        store
            .read(&relative)?
            .ok_or("Memory document does not exist")?
    };
    let contents = admit_reviewed_memory_document(&contents)?;
    let mut dialog = window
        .dialog()
        .file()
        .set_title("Export plaintext Markdown")
        .set_file_name(Path::new(&relative).file_name().unwrap().to_string_lossy())
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
        .map_err(|_| "Selected save path is not available")?;
    let target = export_target(&path, &root)?;
    // Atomic replacement also prevents an existing hard link from overwriting
    // the active store inode, and creates owner-only plaintext on Unix.
    let mut temporary =
        tempfile::NamedTempFile::new_in(target.parent().unwrap()).map_err(|e| e.to_string())?;
    temporary
        .write_all(contents.as_bytes())
        .and_then(|_| temporary.as_file().sync_all())
        .map_err(|e| e.to_string())?;
    temporary.persist(&target).map_err(|e| e.to_string())?;
    Ok(Some(portable_path(&target)?))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (tempfile::TempDir, MemoryStore) {
        let temp = tempfile::tempdir().unwrap();
        let store = MemoryStore::with_key(&temp.path().join(".me"), [37; 32]).unwrap();
        (temp, store)
    }

    #[test]
    fn only_genuinely_empty_or_policy_only_roots_list_without_a_key() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join(".me");
        assert!(is_uninitialized(&root).unwrap());
        assert!(!root.exists());
        write_policy_at(&root, false).unwrap();
        assert!(is_uninitialized(&root).unwrap());
        fs::write(root.join("me.md"), "legacy plaintext").unwrap();
        assert!(is_uninitialized(&root).is_err());
        fs::remove_file(root.join("me.md")).unwrap();
        let store = MemoryStore::with_key(&root, [38; 32]).unwrap();
        assert!(!is_uninitialized(store.root()).unwrap());
    }

    #[test]
    fn restricts_renderer_paths_to_documents_and_pending_reads() {
        let (temp, store) = fixture();
        for name in ["me.md", "topics/travel.md"] {
            assert_eq!(
                relative_path(
                    store.root().join(name).to_str().unwrap(),
                    store.root(),
                    false
                )
                .unwrap(),
                name
            );
        }
        for name in [
            "policy.json",
            ".approved-content.json",
            "proposals/dismissed.jsonl",
            "topics/../me.md",
            "topics/./travel.md",
            "topics/sub/travel.md",
        ] {
            assert!(
                relative_path(
                    store.root().join(name).to_str().unwrap(),
                    store.root(),
                    true
                )
                .is_err(),
                "{name}"
            );
        }
        assert!(relative_path(
            temp.path().join("outside.md").to_str().unwrap(),
            store.root(),
            false
        )
        .is_err());
        let pending = store.root().join("proposals/pending.jsonl");
        assert!(relative_path(pending.to_str().unwrap(), store.root(), true).is_ok());
        assert!(relative_path(pending.to_str().unwrap(), store.root(), false).is_err());
    }

    #[test]
    fn encrypted_document_lifecycle_uses_exact_normalized_approval() {
        let (_temp, store) = fixture();
        let raw = "# Cafe\u{301}\r\n\n- Prefers São Paulo.\n";
        let normalized = "# Café\n\n- Prefers São Paulo.\n";
        let _lock = store.lock().unwrap();
        write_reviewed_document(&store, "me.md", raw, true).unwrap();
        assert_eq!(store.read("me.md").unwrap().as_deref(), Some(normalized));
        assert!(store.is_approved("me.md", normalized).unwrap());
        assert!(!store.is_approved("me.md", raw).unwrap());
        assert!(write_reviewed_document(&store, "me.md", "replacement", true).is_err());
        assert_eq!(store.read("me.md").unwrap().as_deref(), Some(normalized));
        let ciphertext = fs::read(store.root().join("me.md")).unwrap();
        assert!(!ciphertext
            .windows("Prefers".len())
            .any(|part| part == b"Prefers"));
        write_reviewed_document(&store, "me.md", "# Me\nUpdated preference\n", false).unwrap();
        assert!(store
            .is_approved("me.md", "# Me\nUpdated preference\n")
            .unwrap());
        assert!(!store.is_approved("me.md", normalized).unwrap());
    }

    #[test]
    fn missing_document_is_not_silently_recreated_by_an_edit() {
        let (_temp, store) = fixture();
        let _lock = store.lock().unwrap();
        assert!(write_reviewed_document(&store, "me.md", "# Me\n", false).is_err());
        assert!(store.read("me.md").unwrap().is_none());
        assert!(store.read(".approved-content.json").unwrap().is_none());
    }

    #[test]
    fn corrupt_documents_and_manifests_are_not_overwritten() {
        let (_temp, store) = fixture();
        let _lock = store.lock().unwrap();
        write_reviewed_document(&store, "me.md", "# Me\n", true).unwrap();
        fs::write(store.root().join("me.md"), b"corrupted ciphertext").unwrap();
        assert!(write_reviewed_document(&store, "me.md", "# Me\nUpdated\n", false).is_err());
        assert_eq!(
            fs::read(store.root().join("me.md")).unwrap(),
            b"corrupted ciphertext"
        );
        fs::write(
            store.root().join(".approved-content.json"),
            b"corrupted manifest",
        )
        .unwrap();
        assert!(write_reviewed_document(&store, "topics/travel.md", "# Travel\n", true).is_err());
        assert!(store.read("topics/travel.md").unwrap().is_none());
    }

    #[test]
    fn recall_policy_gates_key_access_and_distinguishes_empty_from_off() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join(".me");
        assert!(
            recall_snapshot_with(&root, |_| panic!("must not request a key"))
                .unwrap()
                .is_none()
        );
        write_policy_at(&root, false).unwrap();
        assert!(
            recall_snapshot_with(&root, |_| panic!("must not request a key"))
                .unwrap()
                .is_none()
        );
        fs::write(root.join("policy.json"), r#"{"enabled":true,"extra":true}"#).unwrap();
        assert!(
            recall_snapshot_with(&root, |_| panic!("must not request a key"))
                .unwrap()
                .is_none()
        );
        write_policy_at(&root, true).unwrap();
        assert!(
            recall_snapshot_with(&root, |_| panic!("fresh store needs no key"))
                .unwrap()
                .unwrap()
                .documents
                .is_empty()
        );
        let store = MemoryStore::with_key(&root, [37; 32]).unwrap();
        assert!(recall_snapshot_with(&root, |_| Err("locked keychain".into())).is_err());
        assert!(recall_snapshot_at(&store)
            .unwrap()
            .unwrap()
            .documents
            .is_empty());
    }

    #[test]
    fn recall_contains_only_exact_approved_safe_documents_and_portable_paths() {
        let (_temp, store) = fixture();
        write_policy_at(store.root(), true).unwrap();
        {
            let _lock = store.lock().unwrap();
            write_reviewed_document(&store, "me.md", "# Me\n- Brief replies.\n", true).unwrap();
            store
                .write(
                    "topics/unreviewed.md",
                    "# Unreviewed\n- Private fact.\n",
                    true,
                )
                .unwrap();
            // Even authenticated approval metadata cannot make credentials safe.
            store
                .write("topics/unsafe.md", "# Unsafe\nPIN: 1234\n", true)
                .unwrap();
            store
                .mark_approved("topics/unsafe.md", "# Unsafe\nPIN: 1234\n")
                .unwrap();
        }
        let snapshot = recall_snapshot_at(&store).unwrap().unwrap();
        assert_eq!(snapshot.documents.len(), 1);
        assert_eq!(snapshot.documents[0].file_name, "me.md");
        assert_eq!(
            snapshot.documents[0].path,
            portable_path(&store.root().join("me.md")).unwrap()
        );
        assert_eq!(
            relative_path(&snapshot.documents[0].path, store.root(), false).unwrap(),
            "me.md"
        );
        write_policy_at(store.root(), false).unwrap();
        assert!(recall_snapshot_at(&store).unwrap().is_none());
    }

    #[test]
    fn recall_rechecks_policy_after_open_and_does_not_hide_corrupt_documents() {
        let (_temp, store) = fixture();
        write_policy_at(store.root(), true).unwrap();
        let result = recall_snapshot_with(store.root(), |root| {
            write_policy_at(root, false)?;
            MemoryStore::with_key(root, [37; 32])
        })
        .unwrap();
        assert!(result.is_none());
        write_policy_at(store.root(), true).unwrap();
        fs::write(store.root().join("me.md"), b"corrupt ciphertext").unwrap();
        assert!(recall_snapshot_at(&store).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn windows_paths_round_trip_with_slash_logical_names() {
        let root = Path::new(r"C:\Users\Person\.me");
        for input in [
            r"C:\Users\Person\.me\topics\travel.md",
            "C:/Users/Person/.me/topics/travel.md",
        ] {
            assert_eq!(
                relative_path(input, root, false).unwrap(),
                "topics/travel.md"
            );
        }
        assert_eq!(
            portable_path(&root.join("topics/travel.md")).unwrap(),
            "C:/Users/Person/.me/topics/travel.md"
        );
        assert!(relative_path(r"C:\Users\Person\.me\topics\..\me.md", root, false).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn paths_never_use_lossy_utf8_and_policy_never_follows_symlinks() {
        use std::os::unix::{ffi::OsStringExt, fs::symlink};
        let invalid = PathBuf::from(std::ffi::OsString::from_vec(vec![b'/', 0xff]));
        assert!(portable_path(&invalid).is_err());
        let temp = tempfile::tempdir().unwrap();
        let outside = temp.path().join("outside");
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join("policy.json"), r#"{"enabled":true}"#).unwrap();
        let root = temp.path().join(".me");
        symlink(&outside, &root).unwrap();
        assert!(read_policy_at(&root).is_err());
        assert!(!policy_enabled_at(&root));
        assert!(write_policy_at(&root, false).is_err());
        assert_eq!(
            fs::read_to_string(outside.join("policy.json")).unwrap(),
            r#"{"enabled":true}"#
        );
        fs::remove_file(&root).unwrap();
        fs::create_dir(&root).unwrap();
        symlink(outside.join("policy.json"), root.join("policy.json")).unwrap();
        assert!(read_policy_at(&root).is_err());
        // A write may replace the link itself or reject it; it must never write
        // through it or change the outside inode.
        let _ = write_policy_at(&root, false);
        assert_eq!(
            fs::read_to_string(outside.join("policy.json")).unwrap(),
            r#"{"enabled":true}"#
        );
    }

    #[test]
    fn import_returns_validated_normalized_text_without_persisting() {
        let (temp, store) = fixture();
        let import = temp.path().join("import.md");
        fs::write(&import, "# Cafe\u{301}\r\nA preference\n").unwrap();
        assert_eq!(import_text_at(&import).unwrap(), "# Café\nA preference\n");
        assert!(store.read("me.md").unwrap().is_none());
        for unsafe_text in [
            "# Me\nPIN: 1234\n",
            "abc\u{202e}txt",
            "ghp_16Chars\u{200b}AtLeastHere00",
        ] {
            fs::write(&import, unsafe_text).unwrap();
            assert!(import_text_at(&import).is_err());
            assert!(admit_reviewed_memory_document(unsafe_text).is_err());
        }
        fs::write(&import, "x".repeat(MAX_DOCUMENT_BYTES + 1)).unwrap();
        assert!(import_text_at(&import).is_err());
    }

    #[test]
    fn import_rejects_missing_directory_and_invalid_utf8() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("import.md");
        assert!(import_text_at(&path).is_err());
        assert!(import_text_at(temp.path()).is_err());
        fs::write(&path, [0xff]).unwrap();
        assert!(import_text_at(&path).is_err());
    }

    #[test]
    fn import_accepts_byte_limit_and_rejects_one_byte_over() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("import.md");
        for size in [
            0,
            MAX_DOCUMENT_BYTES - 1,
            MAX_DOCUMENT_BYTES,
            MAX_DOCUMENT_BYTES + 1,
        ] {
            let text = "x".repeat(size);
            fs::write(&path, &text).unwrap();
            if size <= MAX_DOCUMENT_BYTES {
                assert_eq!(import_text_at(&path).unwrap(), text);
            } else {
                assert!(import_text_at(&path).is_err());
            }
        }
    }

    #[cfg(unix)]
    #[test]
    fn import_rejects_symlink_leaves() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join("regular.md"), "safe").unwrap();
        for (name, target) in [("link.md", "regular.md"), ("dangling.md", "missing.md")] {
            let path = temp.path().join(name);
            std::os::unix::fs::symlink(target, &path).unwrap();
            assert!(import_text_at(&path).is_err());
        }
    }

    #[test]
    fn policy_is_narrow_and_fails_closed_without_a_key() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join(".me");
        assert!(!policy_enabled_at(&root));
        assert!(read_policy_at(&root).unwrap().is_none());
        write_policy_at(&root, false).unwrap();
        assert!(!policy_enabled_at(&root));
        write_policy_at(&root, true).unwrap();
        assert!(policy_enabled_at(&root));
        for bad in [
            "not json",
            "{}",
            r#"{"enabled":"true"}"#,
            r#"{"enabled":true,"content":"private"}"#,
        ] {
            fs::write(root.join("policy.json"), bad).unwrap();
            assert!(!policy_enabled_at(&root));
            assert!(read_policy_at(&root).is_err());
        }
        write_policy_at(&root, false).unwrap();
        assert_eq!(
            read_policy_at(&root).unwrap(),
            Some(MemoryPolicy { enabled: false })
        );
    }

    #[test]
    fn exports_reject_active_store_targets() {
        let (temp, store) = fixture();
        for name in ["me.md", "policy.json", ".approved-content.json", "key"] {
            assert!(export_target(&store.root().join(name), store.root()).is_err());
        }
        assert!(export_target(&temp.path().join("export.md"), store.root()).is_ok());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(store.root(), temp.path().join("alias")).unwrap();
            assert!(export_target(&temp.path().join("alias/me.md"), store.root()).is_err());
            std::os::unix::fs::symlink(
                store.root().join("policy.json"),
                temp.path().join("link.md"),
            )
            .unwrap();
            assert!(export_target(&temp.path().join("link.md"), store.root()).is_err());
        }
    }
}
