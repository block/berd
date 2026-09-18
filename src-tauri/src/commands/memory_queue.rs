//! Encrypted proposal queue operations. All changes share the store lock with
//! policy writes and the sidecar. Direct review remains available while off.

use crate::commands::memory_store::{
    admit_reviewed_memory_document, documents_at, memory_store_root, policy_enabled_at,
    relative_path, write_reviewed_document,
};
use berd_memory::store::MemoryStore;
use berd_memory::{
    is_suppressed, normalize_memory_proposal_text, normalize_memory_proposal_topic,
    now_epoch_seconds, same_fact, suppression_fingerprint,
};
use serde_json::{json, Value};
use std::collections::HashSet;

const PENDING: &str = "proposals/pending.jsonl";
const DISMISSED: &str = "proposals/dismissed.jsonl";
const TOPICS: [&str; 7] = [
    "Home",
    "Social",
    "Interests",
    "Travel",
    "Shopping",
    "Work",
    "Tools",
];
const ME_TEMPLATE: &str = "# Me\n\n## About me\n\n## Preferences\n\n## Boundaries\n\n## Topics\n";

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalResult {
    pub approved: bool,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryCandidateInput {
    pub content: String,
    pub topic: Option<String>,
    pub session_id: Option<String>,
}

fn reviewed_entry(content: &str, topic: Option<&str>) -> Result<(String, Option<String>), String> {
    let content = normalize_memory_proposal_text(content).map_err(|e| e.to_string())?;
    let topic = normalize_memory_proposal_topic(topic).map_err(|e| e.to_string())?;
    if content.is_empty() || content.chars().count() > 300 {
        return Err("Memory entries must contain 1 to 300 characters".into());
    }
    if topic.as_ref().is_some_and(|t| t.chars().count() > 100) {
        return Err("Memory topics must be 100 characters or fewer".into());
    }
    admit_reviewed_memory_document(&content)?;
    if let Some(topic) = &topic {
        admit_reviewed_memory_document(topic)?;
    }
    Ok((content, topic))
}

fn append_bullet(contents: &str, entry: &str) -> String {
    let bullet = format!("- {}", entry.trim());
    if contents.lines().any(|line| line.trim() == bullet) {
        return contents.to_string();
    }
    format!("{}\n{bullet}\n", contents.trim_end())
}

fn insert_preference(contents: &str, entry: &str) -> String {
    let bullet = format!("- {}", entry.trim());
    if contents.lines().any(|line| line.trim() == bullet) {
        return contents.to_string();
    }
    let mut lines: Vec<String> = contents.lines().map(str::to_string).collect();
    let Some(start) = lines
        .iter()
        .position(|line| line.trim() == "## Preferences")
    else {
        return append_bullet(contents, entry);
    };
    let end = lines
        .iter()
        .enumerate()
        .skip(start + 1)
        .find(|(_, line)| line.starts_with("## "))
        .map(|(index, _)| index)
        .unwrap_or(lines.len());
    let mut insert_at = end;
    while insert_at > start + 1 && lines[insert_at - 1].trim().is_empty() {
        insert_at -= 1;
    }
    lines.insert(insert_at, bullet);
    format!("{}\n", lines.join("\n").trim_end())
}

fn approval_target(store: &MemoryStore, topic: Option<&str>) -> Result<(String, bool), String> {
    let Some(topic) = topic else {
        return Ok(("me.md".into(), true));
    };
    for document in documents_at(store)? {
        if document.file_name == "me.md" {
            continue;
        }
        let label = document
            .contents
            .lines()
            .find_map(|line| line.trim().strip_prefix("# ").map(str::trim));
        if document
            .file_name
            .trim_end_matches(".md")
            .eq_ignore_ascii_case(topic)
            || label.is_some_and(|label| label.eq_ignore_ascii_case(topic))
        {
            return Ok((format!("topics/{}", document.file_name), false));
        }
    }
    if let Some(label) = TOPICS
        .iter()
        .find(|label| label.eq_ignore_ascii_case(topic))
    {
        return Ok((format!("topics/{}.md", label.to_lowercase()), false));
    }
    Ok(("me.md".into(), true))
}

/// Save and suppress pure deletions from the actual previous document in one
/// encrypted transaction. The renderer cannot supply a removed-entry list.
#[tauri::command]
pub fn save_reviewed_memory_document(
    path: String,
    contents: String,
    topic: Option<String>,
) -> Result<(), String> {
    let root = memory_store_root()?;
    let relative = relative_path(&path, &root, false)?;
    let store = MemoryStore::open(&root)?;
    save_reviewed_at(&store, &relative, &contents, topic.as_deref())
}

fn memory_content_lines(text: &str) -> Vec<&str> {
    text.split('\n')
        .map(str::trim)
        .filter(|line| {
            let is_note =
                line.starts_with('*') && !line.starts_with("**") && !line.starts_with("* ");
            !(line.is_empty() || line.starts_with('#') || is_note)
        })
        .collect()
}

/// Mirrors editSummary.ts: rewording/additions are not durable rejection.
fn removed_memory_entries(before: &str, after: &str) -> Vec<String> {
    let before = memory_content_lines(before);
    let after: HashSet<_> = memory_content_lines(after).into_iter().collect();
    let before_set: HashSet<_> = before.iter().copied().collect();
    if after.iter().any(|line| !before_set.contains(line)) {
        return Vec::new();
    }
    let mut removed = Vec::new();
    let mut removed_set = HashSet::new();
    for line in before {
        if after.contains(&line) {
            continue;
        }
        let stripped = match line.strip_prefix(['-', '*']) {
            Some(rest) if rest.starts_with(char::is_whitespace) => rest.trim(),
            _ => line,
        };
        if !stripped.is_empty() && removed_set.insert(stripped) {
            removed.push(stripped.to_string());
        }
    }
    removed
}

fn save_reviewed_at(
    store: &MemoryStore,
    relative: &str,
    contents: &str,
    supplied_topic: Option<&str>,
) -> Result<(), String> {
    if !super::memory_store::is_document_name(relative) {
        return Err("Invalid memory document path".into());
    }
    let contents = admit_reviewed_memory_document(contents)?;
    // Validate all IPC inputs, but derive suppression scope from persisted data
    // so omitting/changing a renderer topic cannot bypass deletion suppression.
    if let Some(topic) =
        normalize_memory_proposal_topic(supplied_topic).map_err(|e| e.to_string())?
    {
        admit_reviewed_memory_document(&topic)?;
    }
    let _lock = store.lock()?;
    let previous = store
        .read(relative)?
        .ok_or("Memory document is missing; create it explicitly instead of overwriting")?;
    let removed = removed_memory_entries(&previous, &contents);
    if removed.is_empty() {
        return store.commit_reviewed_document(relative, &contents, false, None);
    }
    let inferred_topic = if relative == "me.md" {
        None
    } else {
        Some(
            previous
                .lines()
                .find_map(|line| line.trim().strip_prefix("# ").map(str::trim))
                .unwrap_or_else(|| {
                    relative
                        .trim_start_matches("topics/")
                        .trim_end_matches(".md")
                }),
        )
    };
    let topic = normalize_memory_proposal_topic(inferred_topic).map_err(|e| e.to_string())?;
    if let Some(topic) = &topic {
        admit_reviewed_memory_document(topic)?;
    }
    let mut dismissed = store.records(DISMISSED)?;
    for content in removed {
        let content = normalize_memory_proposal_text(&content).map_err(|e| e.to_string())?;
        admit_reviewed_memory_document(&content)?;
        if content.is_empty()
            || dismissed
                .iter()
                .any(|record| is_suppressed(record, &content, topic.as_deref()))
        {
            continue;
        }
        let salt = uuid::Uuid::new_v4().simple().to_string();
        dismissed.push(json!({
            "id": uuid::Uuid::new_v4().to_string(), "ts": now_epoch_seconds(),
            "salt": salt, "fingerprint": suppression_fingerprint(&content, topic.as_deref(), &salt)
        }));
    }
    store.commit_reviewed_document(relative, &contents, false, Some(&dismissed))
}

#[tauri::command]
pub fn approve_memory_proposal(
    id: String,
    content: String,
    topic: Option<String>,
) -> Result<ApprovalResult, String> {
    let store = MemoryStore::open(&memory_store_root()?)?;
    approve_at(&store, id, content, topic)
}

fn approve_at(
    store: &MemoryStore,
    id: String,
    content: String,
    topic: Option<String>,
) -> Result<ApprovalResult, String> {
    let (content, topic) = reviewed_entry(&content, topic.as_deref())?;
    let _lock = store.lock()?;
    let records = store.records(PENDING)?;
    if !records
        .iter()
        .any(|record| record.get("id").and_then(Value::as_str) == Some(id.as_str()))
    {
        return Ok(ApprovalResult { approved: false });
    }
    let (target, spine) = approval_target(store, topic.as_deref())?;
    let existing = store.read(&target)?;
    let create_new = existing.is_none();
    let current = match existing {
        Some(current) => {
            // Approving one proposal never approves preexisting unreviewed text.
            if !store.is_approved(&target, &current)? {
                return Err(
                    "Review and save the existing memory document before adding a proposal".into(),
                );
            }
            admit_reviewed_memory_document(&current)?
        }
        None => {
            if spine {
                ME_TEMPLATE.into()
            } else {
                format!("# {}\n", topic.as_deref().unwrap_or("Topic"))
            }
        }
    };
    let next = if spine {
        insert_preference(&current, &content)
    } else {
        append_bullet(&current, &content)
    };
    write_reviewed_document(store, &target, &next, create_new)?;
    // Resolve last. A failed queue replacement leaves an approved document and
    // pending proposal; retry is idempotent, including after process restart.
    let kept: Vec<Value> = records
        .into_iter()
        .filter(|record| record.get("id").and_then(Value::as_str) != Some(id.as_str()))
        .collect();
    store.write_records(PENDING, &kept)?;
    Ok(ApprovalResult { approved: true })
}

#[tauri::command]
pub fn resolve_memory_proposal(
    id: String,
    declined_content: Option<String>,
    declined_topic: Option<String>,
) -> Result<(), String> {
    let store = MemoryStore::open(&memory_store_root()?)?;
    resolve_at(&store, id, declined_content, declined_topic)
}

fn resolve_at(
    store: &MemoryStore,
    id: String,
    declined_content: Option<String>,
    declined_topic: Option<String>,
) -> Result<(), String> {
    // A manually removed document entry can exceed the proposal limit. Its
    // normalized fingerprint must still suppress it; never retain its text.
    let declined = declined_content
        .map(|content| -> Result<_, String> {
            let content = normalize_memory_proposal_text(&content).map_err(|e| e.to_string())?;
            let topic = normalize_memory_proposal_topic(declined_topic.as_deref())
                .map_err(|e| e.to_string())?;
            admit_reviewed_memory_document(&content)?;
            if let Some(topic) = &topic {
                admit_reviewed_memory_document(topic)?;
            }
            Ok((content, topic))
        })
        .transpose()?
        .filter(|(content, _)| !content.is_empty());
    let _lock = store.lock()?;
    let records = store.records(PENDING)?;
    // User document edits use a synthetic id to suppress removed entries,
    // even when no pending proposal exists. Persist the fingerprint first.
    if let Some((content, topic)) = declined {
        let dismissed = store.records(DISMISSED)?;
        if !dismissed
            .iter()
            .any(|record| is_suppressed(record, &content, topic.as_deref()))
        {
            let salt = uuid::Uuid::new_v4().simple().to_string();
            store.append_record(DISMISSED, &json!({
                "id": uuid::Uuid::new_v4().to_string(), "ts": now_epoch_seconds(),
                "salt": salt, "fingerprint": suppression_fingerprint(&content, topic.as_deref(), &salt)
            }))?;
        }
    }
    let kept: Vec<Value> = records
        .into_iter()
        .filter(|record| record.get("id").and_then(Value::as_str) != Some(id.as_str()))
        .collect();
    store.write_records(PENDING, &kept)
}

#[tauri::command]
pub fn append_memory_proposals(candidates: Vec<MemoryCandidateInput>) -> Result<usize, String> {
    let root = memory_store_root()?;
    if candidates.is_empty() || !policy_enabled_at(&root) {
        return Ok(0);
    }
    let store = MemoryStore::open(&root)?;
    append_at(&store, candidates)
}

fn append_at(store: &MemoryStore, candidates: Vec<MemoryCandidateInput>) -> Result<usize, String> {
    if candidates.is_empty() || !policy_enabled_at(store.root()) {
        return Ok(0);
    }
    let _lock = store.lock()?;
    if !policy_enabled_at(store.root()) {
        return Ok(0);
    }
    let mut pending = store.records(PENDING)?;
    let dismissed = store.records(DISMISSED)?;
    let mut count = 0;
    for candidate in candidates {
        let Ok((content, topic)) = reviewed_entry(&candidate.content, candidate.topic.as_deref())
        else {
            continue;
        };
        // Session metadata is renderer input too; do not persist hidden text,
        // access data, or an unbounded string in the encrypted queue.
        let session_id = match candidate.session_id {
            Some(id) => match normalize_memory_proposal_text(&id) {
                Ok(id) if id.len() <= 200 && !berd_memory::looks_like_credential(&id) => Some(id),
                _ => continue,
            },
            None => None,
        };
        if pending
            .iter()
            .any(|record| same_fact(record, &content, topic.as_deref()))
            || dismissed
                .iter()
                .any(|record| is_suppressed(record, &content, topic.as_deref()))
        {
            continue;
        }
        pending.push(json!({
            "id": format!("n-{}", uuid::Uuid::new_v4()), "ts": now_epoch_seconds(),
            "content": content, "topic": topic, "agent": "noticer", "sessionId": session_id, "host": "berd",
        }));
        count += 1;
    }
    // Policy changes use this same lock. Recheck directly before committing.
    if count > 0 && policy_enabled_at(store.root()) {
        store.write_records(PENDING, &pending)?;
    } else {
        return Ok(0);
    }
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::memory_store::write_policy_at;
    use std::fs;

    fn fixture() -> (tempfile::TempDir, MemoryStore) {
        let temp = tempfile::tempdir().unwrap();
        let store = MemoryStore::with_key(&temp.path().join(".me"), [42; 32]).unwrap();
        write_policy_at(store.root(), true).unwrap();
        (temp, store)
    }

    fn candidate(content: &str) -> MemoryCandidateInput {
        MemoryCandidateInput {
            content: content.into(),
            topic: Some("Travel".into()),
            session_id: Some("s-1".into()),
        }
    }

    fn seed(store: &MemoryStore) {
        let _lock = store.lock().unwrap();
        store
            .append_record(
                PENDING,
                &json!({"id": "p-1", "content": "Prefers aisle seats.", "topic": "Travel"}),
            )
            .unwrap();
    }

    fn approve(store: &MemoryStore) -> Result<ApprovalResult, String> {
        approve_at(
            store,
            "p-1".into(),
            "Prefers aisle seats.".into(),
            Some("Travel".into()),
        )
    }

    #[test]
    fn deletion_summary_matches_frontend_conservative_semantics() {
        let before = "# Me\n\n*Private guidance.*\n\n- Keep answers brief.\n* Prefer trains.\nPlain preference\n";
        assert_eq!(
            removed_memory_entries(before, &before.replace("- Keep answers brief.\n", "")),
            vec!["Keep answers brief."]
        );
        assert_eq!(
            removed_memory_entries(before, "# Changed heading\n*Changed guidance.*\n"),
            vec!["Keep answers brief.", "Prefer trains.", "Plain preference"]
        );
        assert!(removed_memory_entries(
            before,
            &before.replace("Keep answers brief.", "Keep replies brief.")
        )
        .is_empty());
        assert!(removed_memory_entries(before, &format!("{before}- New preference.\n")).is_empty());
        assert!(removed_memory_entries(before, &before.replace("# Me", "# Person")).is_empty());
        assert_eq!(
            removed_memory_entries("- Repeat.\n- Repeat.\n", ""),
            vec!["Repeat."]
        );
    }

    #[test]
    fn reviewed_deletion_atomically_saves_approval_and_suppression_across_restart() {
        let (_temp, store) = fixture();
        let before = "# Travel\n- Prefers aisle seats.\n- Prefers trains.\n";
        let after = "# Travel\n- Prefers trains.\n";
        {
            let _lock = store.lock().unwrap();
            write_reviewed_document(&store, "topics/travel.md", before, true).unwrap();
        }
        // An IPC caller cannot change suppression scope with a supplied topic.
        save_reviewed_at(&store, "topics/travel.md", after, Some("Shopping")).unwrap();
        let reopened = MemoryStore::with_key(store.root(), [42; 32]).unwrap();
        assert_eq!(
            reopened.read("topics/travel.md").unwrap().as_deref(),
            Some(after)
        );
        assert!(reopened.is_approved("topics/travel.md", after).unwrap());
        assert!(!reopened.is_approved("topics/travel.md", before).unwrap());
        let dismissed = reopened.records(DISMISSED).unwrap();
        assert_eq!(dismissed.len(), 1);
        assert!(is_suppressed(
            &dismissed[0],
            "Prefers aisle seats.",
            Some("Travel")
        ));
        assert!(!dismissed[0].to_string().contains("aisle"));
        assert_eq!(
            append_at(&reopened, vec![candidate("Prefers aisle seats.")]).unwrap(),
            0
        );
        save_reviewed_at(&reopened, "topics/travel.md", after, None).unwrap();
        assert_eq!(reopened.records(DISMISSED).unwrap().len(), 1);
        // Explicit re-adding by the person is still allowed and recallable.
        save_reviewed_at(&reopened, "topics/travel.md", before, None).unwrap();
        assert!(reopened.is_approved("topics/travel.md", before).unwrap());
    }

    #[test]
    fn deletion_uses_current_store_content_and_mixed_edits_do_not_suppress() {
        let (_temp, store) = fixture();
        {
            let _lock = store.lock().unwrap();
            write_reviewed_document(&store, "me.md", "# Me\n- Old fact.\n", true).unwrap();
        }
        save_reviewed_at(&store, "me.md", "# Me\n- Reworded fact.\n", None).unwrap();
        assert!(store.records(DISMISSED).unwrap().is_empty());
        save_reviewed_at(&store, "me.md", "# Me\n", None).unwrap();
        let dismissed = store.records(DISMISSED).unwrap();
        assert_eq!(dismissed.len(), 1);
        assert!(is_suppressed(&dismissed[0], "Reworded fact.", None));
        assert!(!is_suppressed(&dismissed[0], "Old fact.", None));
    }

    #[test]
    fn failed_suppression_validation_leaves_document_and_approval_unchanged() {
        let (_temp, store) = fixture();
        let before = "# Travel\n- Prefers aisle seats.\n";
        {
            let _lock = store.lock().unwrap();
            write_reviewed_document(&store, "topics/travel.md", before, true).unwrap();
        }
        fs::create_dir_all(store.root().join("proposals")).unwrap();
        fs::write(store.root().join(DISMISSED), b"corrupt suppression").unwrap();
        assert!(save_reviewed_at(&store, "topics/travel.md", "# Travel\n", None).is_err());
        assert_eq!(
            store.read("topics/travel.md").unwrap().as_deref(),
            Some(before)
        );
        assert!(store.is_approved("topics/travel.md", before).unwrap());
        assert_eq!(
            fs::read(store.root().join(DISMISSED)).unwrap(),
            b"corrupt suppression"
        );
    }

    #[test]
    fn unsafe_removed_entries_are_never_fingerprinted() {
        let (_temp, store) = fixture();
        for (name, before) in [
            ("topics/access.md", "# Access\n- PIN: 1234\n"),
            ("topics/hidden.md", "# Hidden\n- Hidden\u{202e}text\n"),
        ] {
            store.write(name, before, true).unwrap();
            assert!(save_reviewed_at(&store, name, "# Clean\n", None).is_err());
            assert_eq!(store.read(name).unwrap().as_deref(), Some(before));
            assert!(store.records(DISMISSED).unwrap().is_empty());
        }
    }

    #[test]
    fn approval_lifecycle_encrypts_content_and_supports_restart() {
        let (_temp, store) = fixture();
        seed(&store);
        assert!(approve(&store).unwrap().approved);
        let text = store.read("topics/travel.md").unwrap().unwrap();
        assert_eq!(text, "# Travel\n- Prefers aisle seats.\n");
        assert!(store.is_approved("topics/travel.md", &text).unwrap());
        assert!(store.records(PENDING).unwrap().is_empty());
        for name in ["topics/travel.md", PENDING, ".approved-content.json"] {
            let bytes = fs::read(store.root().join(name)).unwrap();
            assert!(!bytes.windows(b"aisle".len()).any(|part| part == b"aisle"));
        }
        let reopened = MemoryStore::with_key(store.root(), [42; 32]).unwrap();
        assert_eq!(reopened.read("topics/travel.md").unwrap().unwrap(), text);
        assert!(!approve(&reopened).unwrap().approved);
    }

    #[test]
    fn retry_after_document_commit_does_not_duplicate() {
        let (_temp, store) = fixture();
        seed(&store);
        {
            let _lock = store.lock().unwrap();
            write_reviewed_document(
                &store,
                "topics/travel.md",
                "# Travel\n- Prefers aisle seats.\n",
                true,
            )
            .unwrap();
        }
        assert!(approve(&store).unwrap().approved);
        assert_eq!(
            store
                .read("topics/travel.md")
                .unwrap()
                .unwrap()
                .matches("Prefers aisle seats.")
                .count(),
            1
        );
    }

    #[test]
    fn approval_does_not_bless_unapproved_existing_contents() {
        let (_temp, store) = fixture();
        seed(&store);
        let unreviewed = "# Travel\nUnreviewed fact\n";
        store.write("topics/travel.md", unreviewed, true).unwrap();
        assert!(approve(&store).is_err());
        assert_eq!(store.read("topics/travel.md").unwrap().unwrap(), unreviewed);
        assert!(!store.is_approved("topics/travel.md", unreviewed).unwrap());
        assert_eq!(store.records(PENDING).unwrap().len(), 1);
    }

    #[test]
    fn corrupt_document_or_queue_never_becomes_a_new_document() {
        let (_temp, store) = fixture();
        seed(&store);
        fs::create_dir_all(store.root().join("topics")).unwrap();
        fs::write(store.root().join("topics/travel.md"), b"broken").unwrap();
        assert!(approve(&store).is_err());
        assert_eq!(
            fs::read(store.root().join("topics/travel.md")).unwrap(),
            b"broken"
        );
        assert_eq!(store.records(PENDING).unwrap().len(), 1);
        fs::write(store.root().join(PENDING), b"broken queue").unwrap();
        assert!(append_at(&store, vec![candidate("New fact")]).is_err());
        assert!(resolve_at(
            &store,
            "p-1".into(),
            Some("Prefers aisle seats.".into()),
            Some("Travel".into())
        )
        .is_err());
        assert_eq!(
            fs::read(store.root().join(PENDING)).unwrap(),
            b"broken queue"
        );
    }

    #[test]
    fn invalid_unicode_credentials_and_metadata_are_never_persisted() {
        let (_temp, store) = fixture();
        let mut bad_topic = candidate("safe text");
        bad_topic.topic = Some("PIN: 1234".into());
        let mut bad_metadata = candidate("safe metadata");
        bad_metadata.session_id = Some("ghp_16CharsAtLeastHere00".into());
        assert_eq!(
            append_at(
                &store,
                vec![
                    candidate(" cafe\u{301} preference\r\n"),
                    candidate("café preference"),
                    candidate("PIN: 1234"),
                    candidate("abc\u{202e}txt"),
                    bad_topic,
                    bad_metadata
                ]
            )
            .unwrap(),
            1
        );
        assert_eq!(
            store.records(PENDING).unwrap()[0]["content"],
            "café preference"
        );
        seed(&store);
        assert!(approve_at(&store, "p-1".into(), "PIN: 1234".into(), None).is_err());
        assert!(approve_at(
            &store,
            "p-1".into(),
            "safe".into(),
            Some("Tra\u{202e}vel".into())
        )
        .is_err());
        assert!(store.read("me.md").unwrap().is_none());
    }

    #[test]
    fn missing_malformed_or_disabled_policy_blocks_new_proposals_but_not_review() {
        let (_temp, store) = fixture();
        seed(&store);
        fs::remove_file(store.root().join("policy.json")).unwrap();
        assert_eq!(append_at(&store, vec![candidate("new fact")]).unwrap(), 0);
        fs::write(store.root().join("policy.json"), "broken").unwrap();
        assert_eq!(append_at(&store, vec![candidate("new fact")]).unwrap(), 0);
        write_policy_at(store.root(), false).unwrap();
        assert_eq!(append_at(&store, vec![candidate("new fact")]).unwrap(), 0);
        assert!(approve(&store).unwrap().approved);
        write_policy_at(store.root(), true).unwrap();
        assert_eq!(append_at(&store, vec![candidate("new fact")]).unwrap(), 1);
        write_policy_at(store.root(), false).unwrap();
        assert_eq!(append_at(&store, vec![candidate("other fact")]).unwrap(), 0);
        assert_eq!(store.records(PENDING).unwrap().len(), 1);
    }

    #[test]
    fn decline_encrypts_only_fingerprints_and_suppresses_reproposal() {
        let (_temp, store) = fixture();
        seed(&store);
        resolve_at(
            &store,
            "p-1".into(),
            Some("Prefers aisle seats.".into()),
            Some("Travel".into()),
        )
        .unwrap();
        assert!(store.records(PENDING).unwrap().is_empty());
        let records = store.records(DISMISSED).unwrap();
        assert_eq!(records.len(), 1);
        assert!(!records[0].to_string().contains("aisle"));
        assert_eq!(
            append_at(&store, vec![candidate("Prefers aisle seats.")]).unwrap(),
            0
        );
    }

    #[test]
    fn manual_deletions_without_pending_ids_are_suppressed() {
        let (_temp, store) = fixture();
        resolve_at(
            &store,
            "manual-delete-id".into(),
            Some("Prefers aisle seats.".into()),
            Some("Travel".into()),
        )
        .unwrap();
        assert_eq!(
            append_at(&store, vec![candidate("Prefers aisle seats.")]).unwrap(),
            0
        );
        assert_eq!(store.records(DISMISSED).unwrap().len(), 1);
        resolve_at(
            &store,
            "manual-delete-id".into(),
            Some("Prefers aisle seats.".into()),
            Some("Travel".into()),
        )
        .unwrap();
        assert_eq!(store.records(DISMISSED).unwrap().len(), 1);
    }

    #[test]
    fn policy_changed_while_waiting_for_lock_prevents_commit() {
        let (_temp, store) = fixture();
        let root = store.root().to_path_buf();
        let held = store.lock().unwrap();
        let worker = std::thread::spawn(move || {
            let store = MemoryStore::with_key(&root, [42; 32]).unwrap();
            append_at(&store, vec![candidate("queued while enabled")])
        });
        // Emulate a policy commit by the current lock holder. The waiting
        // appender must recheck even if it observed enabled before locking.
        fs::write(store.root().join("policy.json"), r#"{"enabled":false}"#).unwrap();
        drop(held);
        assert_eq!(worker.join().unwrap().unwrap(), 0);
        assert!(store.records(PENDING).unwrap().is_empty());
    }
}
