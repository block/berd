//! Invisible change history for the user's me.md.
//!
//! Provenance for the personal file is kept in a plain local git repository
//! inside `~/.me/.git` — one trail for the spine and every topic doc.
//! Design rules:
//!
//! - Git is the implementation, never the interface: no remotes, no branches,
//!   no git vocabulary in the UI. The user experiences a timeline.
//! - History is best-effort, the file is sacred: callers record history
//!   *after* a successful write, and a history failure must never surface as
//!   a write failure. A deleted `.git` folder means history starts over.
//! - Only memory docs are ever staged (the spine and `topics/*.md`). Other
//!   tools may keep their own files in the same folder; we never touch them.

use git2::{Repository, Signature};
use std::path::{Path, PathBuf};

/// Attribution for a recorded change. Sources map to commit authors:
/// the person's own hand ranks highest, and anything we can't attribute
/// stays honestly neutral.
fn signature_for(source: &str) -> Result<Signature<'static>, String> {
    let (name, email) = match source {
        "created" => ("Berd (starter template)", "berd@local"),
        "user" => ("You (edited in Berd)", "you@local"),
        "delete" => ("You (deleted in Berd)", "you@local"),
        "policy" => ("You (changed the switch)", "you@local"),
        "external" => ("Edited outside Berd", "outside@local"),
        other => {
            if let Some(agent) = other.strip_prefix("agent:") {
                if !agent.trim().is_empty() {
                    // "recorded", not "approved": memory is written when an
                    // agent notices it, and the person removes what they
                    // don't want. Saying approved would claim a consent step
                    // that no longer happens.
                    return Signature::now(
                        &format!("{} (recorded in chat)", agent.trim()),
                        "agent@local",
                    )
                    .map_err(|error| error.to_string());
                }
            }
            // Direct agent edits made with the user's go-ahead in
            // conversation — distinct from queue approvals so the paper
            // trail says which door the change came through.
            if let Some(agent) = other.strip_prefix("agent-edit:") {
                if !agent.trim().is_empty() {
                    return Signature::now(&format!("{} (in chat)", agent.trim()), "agent@local")
                        .map_err(|error| error.to_string());
                }
            }
            return Err(format!("Unknown history source: {other}"));
        }
    };
    Signature::now(name, email).map_err(|error| error.to_string())
}

/// The commit subject: what happened, and to what.
///
/// `summary` is the entry text when the caller knows it — an added or removed
/// bullet — so the log answers "what changed?" without reading a diff. Adds
/// and removes must read differently: the most important question a person
/// asks of this trail is whether something they deleted came back.
fn message_for(source: &str, summary: Option<&str>, is_first: bool) -> String {
    if is_first {
        return "Begin history".to_string();
    }
    let detail = summary
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(shorten);
    match source {
        "created" => "Create me.md with starter template".to_string(),
        "user" => "Edit".to_string(),
        "external" => "Edit outside Berd".to_string(),
        "delete" => match detail {
            Some(text) => format!("Remove: {text}"),
            None => "Remove entry".to_string(),
        },
        "policy" => match detail {
            Some(text) => text,
            None => "Change the memory switch".to_string(),
        },
        s if s.starts_with("agent-edit:") => "Edit in chat".to_string(),
        _ => match detail {
            Some(text) => format!("Add: {text}"),
            None => "Add entry".to_string(),
        },
    }
}

/// Commit subjects stay one line. Memory entries are short by design, but a
/// hand-written rule can run long.
fn shorten(text: &str) -> String {
    let single_line = text.replace('\n', " ");
    let trimmed = single_line.trim();
    if trimmed.chars().count() <= 72 {
        return trimmed.to_string();
    }
    let head: String = trimmed.chars().take(69).collect();
    format!("{}...", head.trim_end())
}

/// Resolve the history home for a memory file, plus the file's path relative
/// to it.
///
/// Memory spans two levels — the spine at `~/.me/me.md` and topic docs at
/// `~/.me/topics/<name>.md` — but there is one advertised provenance trail:
/// `git log` inside `~/.me/`. Using each file's own parent folder would give
/// topics a nested `~/.me/topics/.git`, splitting history across stores and
/// hiding topic approvals from the documented inspection path. So when the
/// file sits under a `.me` directory, that directory is the repo root.
fn history_root(file: &Path) -> Option<(&Path, PathBuf)> {
    let parent = file.parent()?;
    let mut root = parent;
    loop {
        if root.file_name().map(|name| name == ".me").unwrap_or(false) {
            let relative = file.strip_prefix(root).ok()?.to_path_buf();
            return Some((root, relative));
        }
        root = root.parent()?;
    }
}

/// Record the current state of `file_path` in the memory history, attributed
/// to `source` ("created" | "user" | "delete" | "external" | "agent:<name>" |
/// "agent-edit:<name>"). `summary` is the affected entry when the caller knows
/// it, so the commit subject can say what changed rather than only who changed
/// it. Initializes the history on first use. Returns `true` when a change was
/// recorded, `false` when the file is unchanged since the last record. Cheap
/// when unchanged, so callers may invoke it opportunistically (e.g. on every
/// load) to sweep up edits made outside Berd.
#[tauri::command]
pub fn record_me_history(
    file_path: String,
    source: String,
    summary: Option<String>,
) -> Result<bool, String> {
    let file = Path::new(file_path.trim());
    if !file.is_file() {
        return Err(format!("Not a file: {}", file.display()));
    }
    // Prefer the `.me` root so the spine and every topic share one trail;
    // fall back to the file's own folder for paths outside a `.me` tree.
    let (dir, relative) = match history_root(file) {
        Some(resolved) => resolved,
        None => {
            let parent = file
                .parent()
                .ok_or_else(|| "File has no parent folder".to_string())?;
            let name = file
                .file_name()
                .ok_or_else(|| "File has no name".to_string())?;
            (parent, PathBuf::from(name))
        }
    };

    // Open exactly this folder as the history home (never a parent repo the
    // user might keep, e.g. dotfiles under $HOME); init on first use.
    let repo = Repository::open(dir)
        .or_else(|_| Repository::init(dir))
        .map_err(|error| format!("Couldn't open history: {error}"))?;

    let mut index = repo.index().map_err(|error| error.to_string())?;
    index
        .add_path(&relative)
        .map_err(|error| error.to_string())?;
    index.write().map_err(|error| error.to_string())?;
    let tree_id = index.write_tree().map_err(|error| error.to_string())?;

    let parent = repo.head().ok().and_then(|head| head.peel_to_commit().ok());
    if let Some(parent_commit) = &parent {
        if parent_commit.tree_id() == tree_id {
            return Ok(false);
        }
    }

    let tree = repo.find_tree(tree_id).map_err(|error| error.to_string())?;
    let signature = signature_for(&source)?;
    let message = message_for(&source, summary.as_deref(), parent.is_none());
    let parents: Vec<&git2::Commit> = parent.iter().collect();
    repo.commit(
        Some("HEAD"),
        &signature,
        &signature,
        &message,
        &tree,
        &parents,
    )
    .map_err(|error| format!("Couldn't record history: {error}"))?;
    Ok(true)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeHistoryEntry {
    pub timestamp_ms: i64,
    pub author: String,
    pub message: String,
}

/// The recorded timeline for `file_path`, newest first (capped at 200).
/// An absent history is an empty timeline, not an error.
#[tauri::command]
pub fn list_me_history(file_path: String) -> Result<Vec<MeHistoryEntry>, String> {
    let file = Path::new(file_path.trim());
    // Same root resolution as recording, so a topic doc reads the shared
    // `~/.me/.git` trail rather than looking for a repo beside itself.
    let dir = match history_root(file) {
        Some((root, _)) => root,
        None => match file.parent() {
            Some(dir) => dir,
            None => return Ok(Vec::new()),
        },
    };
    let repo = match Repository::open(dir) {
        Ok(repo) => repo,
        Err(_) => return Ok(Vec::new()),
    };
    let mut walk = match repo.revwalk() {
        Ok(walk) => walk,
        Err(_) => return Ok(Vec::new()),
    };
    if walk.push_head().is_err() {
        return Ok(Vec::new());
    }

    let mut entries = Vec::new();
    for oid in walk.take(200).flatten() {
        if let Ok(commit) = repo.find_commit(oid) {
            entries.push(MeHistoryEntry {
                timestamp_ms: commit.time().seconds() * 1000,
                author: commit.author().name().unwrap_or("Unknown").to_string(),
                message: commit.summary().unwrap_or("").to_string(),
            });
        }
    }
    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn setup() -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().expect("tempdir");
        let file = dir.path().join("me.md");
        fs::write(&file, "# Me\n").expect("write");
        (dir, file)
    }

    /// A `.me` tree with the spine and a namespaced topic doc, mirroring the
    /// real layout so root resolution is exercised.
    fn setup_me_tree() -> (tempfile::TempDir, std::path::PathBuf, std::path::PathBuf) {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path().join(".me");
        fs::create_dir_all(root.join("topics")).expect("mkdir");
        let spine = root.join("me.md");
        fs::write(&spine, "# Me\n").expect("write");
        let topic = root.join("topics").join("home.md");
        fs::write(&topic, "# Home\n").expect("write");
        (dir, spine, topic)
    }

    #[test]
    fn topic_docs_share_the_me_root_history() {
        let (_dir, spine, topic) = setup_me_tree();
        assert!(
            record_me_history(spine.to_string_lossy().into_owned(), "created".into(), None)
                .expect("record spine")
        );
        assert!(
            record_me_history(topic.to_string_lossy().into_owned(), "user".into(), None)
                .expect("record topic")
        );

        // One advertised trail: `git log` in ~/.me/, no nested repo beside topics.
        let root = spine.parent().expect("root");
        assert!(root.join(".git").is_dir());
        assert!(!root.join("topics").join(".git").exists());

        // Both files appear in that trail, newest first.
        let entries = list_me_history(topic.to_string_lossy().into_owned()).expect("list");
        assert_eq!(entries.len(), 2);
        assert!(entries[0].author.contains("You"));
    }

    #[test]
    fn topic_history_is_readable_from_the_spine_path() {
        let (_dir, spine, topic) = setup_me_tree();
        record_me_history(
            topic.to_string_lossy().into_owned(),
            "agent:Berdy".into(),
            None,
        )
        .expect("record topic");
        let entries = list_me_history(spine.to_string_lossy().into_owned()).expect("list");
        assert_eq!(entries.len(), 1);
        assert!(entries[0].author.contains("Berdy"));
    }

    #[test]
    fn first_record_initializes_history() {
        let (_dir, file) = setup();
        let recorded =
            record_me_history(file.to_string_lossy().into_owned(), "created".into(), None)
                .expect("record");
        assert!(recorded);
        let entries = list_me_history(file.to_string_lossy().into_owned()).expect("list");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].message, "Begin history");
    }

    #[test]
    fn unchanged_file_records_nothing() {
        let (_dir, file) = setup();
        let path = file.to_string_lossy().into_owned();
        assert!(record_me_history(path.clone(), "created".into(), None).expect("first"));
        assert!(!record_me_history(path.clone(), "external".into(), None).expect("second"));
        assert_eq!(list_me_history(path).expect("list").len(), 1);
    }

    #[test]
    fn adds_and_removes_read_differently() {
        // The most important question this trail answers is whether something
        // the person deleted came back, so the two operations must not share
        // a subject line.
        let (_dir, file) = setup();
        record_me_history(file.to_string_lossy().into_owned(), "created".into(), None)
            .expect("seed");
        fs::write(&file, "# Me\n- Prefers aisle seats.\n").expect("add");
        record_me_history(
            file.to_string_lossy().into_owned(),
            "agent:noticer".into(),
            Some("Prefers aisle seats.".into()),
        )
        .expect("record add");
        fs::write(&file, "# Me\n").expect("remove");
        record_me_history(
            file.to_string_lossy().into_owned(),
            "delete".into(),
            Some("Prefers aisle seats.".into()),
        )
        .expect("record remove");

        let entries = list_me_history(file.to_string_lossy().into_owned()).expect("history");
        assert_eq!(entries[0].message, "Remove: Prefers aisle seats.");
        assert_eq!(entries[0].author, "You (deleted in Berd)");
        assert_eq!(entries[1].message, "Add: Prefers aisle seats.");
        assert_eq!(entries[1].author, "noticer (recorded in chat)");
    }

    #[test]
    fn long_entries_stay_one_line() {
        let long = "a".repeat(200);
        let message = message_for("delete", Some(&long), false);
        assert!(message.starts_with("Remove: "));
        assert!(message.lines().count() == 1);
        assert!(
            message.len() < 100,
            "subject should be shortened: {message}"
        );
    }

    #[test]
    fn missing_summaries_fall_back_to_the_operation() {
        // External sweeps and hand edits don't know an entry, and a subject
        // that invents one would be worse than a general description.
        assert_eq!(message_for("agent:noticer", None, false), "Add entry");
        assert_eq!(message_for("delete", None, false), "Remove entry");
        assert_eq!(message_for("user", Some("ignored"), false), "Edit");
    }

    #[test]
    fn changes_are_attributed_to_their_source() {
        let (_dir, file) = setup();
        let path = file.to_string_lossy().into_owned();
        record_me_history(path.clone(), "created".into(), None).expect("first");

        fs::write(&file, "# Me\n\n- Keep answers brief.\n").expect("edit");
        record_me_history(path.clone(), "user".into(), None).expect("user edit");

        fs::write(
            &file,
            "# Me\n\n- Keep answers brief.\n- Ask before deleting.\n",
        )
        .expect("edit 2");
        record_me_history(path.clone(), "agent:Berdy".into(), None).expect("agent edit");

        let entries = list_me_history(path).expect("list");
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0].author, "Berdy (recorded in chat)");
        assert_eq!(entries[0].message, "Add entry");
        assert_eq!(entries[1].author, "You (edited in Berd)");
        assert_eq!(entries[1].message, "Edit");
    }

    #[test]
    fn unknown_source_is_rejected() {
        let (_dir, file) = setup();
        let result = record_me_history(file.to_string_lossy().into_owned(), "mystery".into(), None);
        assert!(result.is_err());
    }

    #[test]
    fn missing_history_lists_empty() {
        let (_dir, file) = setup();
        let entries = list_me_history(file.to_string_lossy().into_owned()).expect("list");
        assert!(entries.is_empty());
    }

    #[test]
    fn only_the_target_file_is_staged() {
        let (dir, file) = setup();
        fs::write(dir.path().join("other-tool.txt"), "not ours").expect("other");
        let path = file.to_string_lossy().into_owned();
        record_me_history(path.clone(), "created".into(), None).expect("record");

        let repo = Repository::open(dir.path()).expect("open");
        let head = repo.head().expect("head").peel_to_tree().expect("tree");
        assert_eq!(head.len(), 1);
        assert!(head.get_name("me.md").is_some());
    }
}
