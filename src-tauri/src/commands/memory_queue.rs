//! Backend-owned proposal queue operations.

use berd_memory::{
    acquire_queue_lock, append_jsonl, is_suppressed, jsonl_records, memory_root, now_epoch_seconds,
    same_fact, suppression_fingerprint, write_jsonl, DISMISSED_FILE, PENDING_FILE,
};
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};

use crate::commands::memory_store::{
    memory_store_root, record_approved_content_at, write_from_store_handle_at,
};

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
    pub refresh_projection: bool,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryCandidateInput {
    pub content: String,
    pub topic: Option<String>,
    pub session_id: Option<String>,
}

fn slug(name: &str) -> String {
    let mut result = String::new();
    for character in name.trim().to_lowercase().chars() {
        if character.is_ascii_alphanumeric() {
            result.push(character);
        } else if !result.ends_with('-') && !result.is_empty() {
            result.push('-');
        }
    }
    result.trim_matches('-').to_string()
}

fn topic_label(contents: &str, file_name: &str) -> String {
    contents
        .lines()
        .find_map(|line| line.trim().strip_prefix("# ").map(str::trim))
        .filter(|label| !label.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| file_name.trim_end_matches(".md").replace('-', " "))
}

fn matching_topic(root: &Path, query: &str) -> Option<PathBuf> {
    let directory = root.join("topics");
    let entries = fs::read_dir(directory).ok()?;
    let wanted = query.trim().to_lowercase();
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if !file_type.is_file() || file_type.is_symlink() {
            continue;
        }
        let path = entry.path();
        let Some(file_name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if !file_name.ends_with(".md") {
            continue;
        }
        let contents = fs::read_to_string(&path).ok()?;
        let stem = file_name.trim_end_matches(".md").to_lowercase();
        if stem == wanted || topic_label(&contents, file_name).to_lowercase() == wanted {
            return Some(path);
        }
    }
    None
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

fn approval_target(root: &Path, topic: Option<&str>) -> Result<(PathBuf, bool), String> {
    let Some(topic) = topic.map(str::trim).filter(|topic| !topic.is_empty()) else {
        return Ok((root.join("me.md"), true));
    };
    if let Some(path) = matching_topic(root, topic) {
        return Ok((path, false));
    }
    if let Some(label) = TOPICS
        .iter()
        .find(|label| label.eq_ignore_ascii_case(topic))
    {
        return Ok((
            root.join("topics").join(format!("{}.md", slug(label))),
            false,
        ));
    }
    Ok((root.join("me.md"), true))
}

/// Approve one pending proposal under the queue lock. The proposal is removed
/// last, so retrying after any partial failure repairs the same entry without
/// creating a duplicate.
#[tauri::command]
pub fn approve_memory_proposal(
    id: String,
    content: String,
    topic: Option<String>,
) -> Result<ApprovalResult, String> {
    approve_memory_proposal_at(&memory_store_root()?, id, content, topic)
}

fn approve_memory_proposal_at(
    root: &Path,
    id: String,
    content: String,
    topic: Option<String>,
) -> Result<ApprovalResult, String> {
    let content = content.trim();
    if content.is_empty() {
        return Err("Memory content is required".to_string());
    }
    if content.chars().count() > 300 {
        return Err("Memory entries must be 300 characters or fewer".to_string());
    }
    if berd_memory::looks_like_credential(content) {
        return Err("Authentication and access data can't be saved to memory".to_string());
    }

    let dir = root.join("proposals");
    let _lock = acquire_queue_lock(&dir)?;
    let pending_path = dir.join(PENDING_FILE);
    let records = jsonl_records(&pending_path);
    if !records
        .iter()
        .any(|record| record.get("id").and_then(Value::as_str) == Some(id.as_str()))
    {
        return Ok(ApprovalResult {
            approved: false,
            refresh_projection: false,
        });
    }

    let (target, spine) = approval_target(root, topic.as_deref())?;
    let current = fs::read_to_string(&target).unwrap_or_else(|_| {
        if spine {
            ME_TEMPLATE.to_string()
        } else {
            format!("# {}\n", topic.as_deref().unwrap_or("Topic").trim())
        }
    });
    let next = if spine {
        insert_preference(&current, content)
    } else {
        append_bullet(&current, content)
    };
    write_from_store_handle_at(&target, root, next.clone(), false)?;
    record_approved_content_at(&target, root, &next)?;

    let kept: Vec<Value> = records
        .into_iter()
        .filter(|record| record.get("id").and_then(Value::as_str) != Some(id.as_str()))
        .collect();
    write_jsonl(&pending_path, &kept)?;
    Ok(ApprovalResult {
        approved: true,
        refresh_projection: true,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seed(root: &Path, id: &str, content: &str, topic: Option<&str>) {
        let proposals = root.join("proposals");
        fs::create_dir_all(&proposals).unwrap();
        append_jsonl(
            &proposals.join(PENDING_FILE),
            &json!({ "id": id, "content": content, "topic": topic }),
        )
        .unwrap();
    }

    #[test]
    fn approval_writes_memory_then_removes_proposal() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join(".me");
        seed(&root, "p-1", "Prefers aisle seats.", Some("Travel"));

        let result = approve_memory_proposal_at(
            &root,
            "p-1".into(),
            "Prefers aisle seats.".into(),
            Some("Travel".into()),
        )
        .unwrap();

        assert!(result.approved);
        assert!(fs::read_to_string(root.join("topics/travel.md"))
            .unwrap()
            .contains("- Prefers aisle seats."));
        assert!(jsonl_records(&root.join("proposals/pending.jsonl")).is_empty());
    }

    #[test]
    fn retry_does_not_duplicate_an_already_written_entry() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join(".me");
        seed(&root, "p-1", "Prefers aisle seats.", Some("Travel"));
        fs::create_dir_all(root.join("topics")).unwrap();
        fs::write(
            root.join("topics/travel.md"),
            "# Travel\n- Prefers aisle seats.\n",
        )
        .unwrap();

        approve_memory_proposal_at(
            &root,
            "p-1".into(),
            "Prefers aisle seats.".into(),
            Some("Travel".into()),
        )
        .unwrap();

        let contents = fs::read_to_string(root.join("topics/travel.md")).unwrap();
        assert_eq!(contents.matches("Prefers aisle seats.").count(), 1);
    }

    #[test]
    fn credentials_are_rejected_without_resolving_proposal() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join(".me");
        seed(&root, "p-1", "placeholder", None);

        assert!(
            approve_memory_proposal_at(&root, "p-1".into(), "PIN: 1234".into(), None,).is_err()
        );
        assert_eq!(
            jsonl_records(&root.join("proposals/pending.jsonl")).len(),
            1
        );
        assert!(!root.join("me.md").exists());
    }
}

/// Decline a proposal or resolve an already-completed approval. Suppression is
/// persisted before the pending record is removed, so a failed decline never
/// loses the proposal.
#[tauri::command]
pub fn resolve_memory_proposal(
    id: String,
    declined_content: Option<String>,
    declined_topic: Option<String>,
) -> Result<(), String> {
    let dir = memory_root()?.join("proposals");
    let _lock = acquire_queue_lock(&dir)?;
    let path = dir.join(PENDING_FILE);
    let records = jsonl_records(&path);

    if let Some(content) = declined_content.filter(|content| !content.trim().is_empty()) {
        let salt = uuid::Uuid::new_v4().simple().to_string();
        append_jsonl(
            &dir.join(DISMISSED_FILE),
            &json!({
                "id": id,
                "ts": now_epoch_seconds(),
                "salt": salt,
                "fingerprint": suppression_fingerprint(
                    &content,
                    declined_topic.as_deref(),
                    &salt,
                ),
            }),
        )?;
    }

    let kept: Vec<Value> = records
        .into_iter()
        .filter(|record| record.get("id").and_then(Value::as_str) != Some(id.as_str()))
        .collect();
    write_jsonl(&path, &kept)
}

/// Append noticer candidates under the same lock used by the MCP sidecar.
#[tauri::command]
pub fn append_memory_proposals(candidates: Vec<MemoryCandidateInput>) -> Result<usize, String> {
    if candidates.is_empty() {
        return Ok(0);
    }
    let dir = memory_root()?.join("proposals");
    let _lock = acquire_queue_lock(&dir)?;
    let pending_path = dir.join(PENDING_FILE);
    let mut pending = jsonl_records(&pending_path);
    let dismissed = jsonl_records(&dir.join(DISMISSED_FILE));
    let mut count = 0;

    for candidate in candidates {
        let content = candidate.content.trim();
        if content.is_empty()
            || content.chars().count() > 300
            || berd_memory::looks_like_credential(content)
            || pending
                .iter()
                .any(|record| same_fact(record, content, candidate.topic.as_deref()))
            || dismissed
                .iter()
                .any(|record| is_suppressed(record, content, candidate.topic.as_deref()))
        {
            continue;
        }
        let record = json!({
            "id": format!("n-{}", uuid::Uuid::new_v4()),
            "ts": now_epoch_seconds(),
            "content": content,
            "topic": candidate.topic,
            "agent": "noticer",
            "sessionId": candidate.session_id,
            "host": "berd",
        });
        append_jsonl(&pending_path, &record)?;
        pending.push(record);
        count += 1;
    }
    Ok(count)
}
