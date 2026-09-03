//! Berd's memory MCP server — minimal stdio implementation.
//!
//! Exposes the user's `~/.me/` memory files to any MCP-capable harness
//! through three tools: `list_topics`, `recall`, and `propose_memory`.
//!
//! The write path is structural, not instructed: `propose_memory` never
//! writes to a memory file itself. It appends the entry to
//! `~/.me/proposals/pending.jsonl`. The candidate is local and non-recallable
//! until the person reviews and approves it in Berd. Only approval crosses
//! the durable-memory boundary.
//!
//! Deliberately hand-rolled: MCP over stdio is newline-delimited
//! JSON-RPC, and serde_json is the only dependency. No SDK, no async
//! runtime, nothing to break.

use std::fs;
use std::io::{self, BufRead, Write};
use std::path::{Path, PathBuf};
use serde_json::{json, Value};

use berd_memory::{
    acquire_queue_lock, append_jsonl, content_is_approved, is_suppressed, jsonl_records,
    looks_like_credential, memory_root, now_epoch_seconds, same_fact, DISMISSED_FILE, PENDING_FILE,
};

const PROTOCOL_VERSION: &str = "2024-11-05";
const SERVER_NAME: &str = "berd-memory";
const SERVER_VERSION: &str = env!("CARGO_PKG_VERSION");

fn main() {
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut out = stdout.lock();

    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let Ok(message) = serde_json::from_str::<Value>(&line) else {
            continue; // Not JSON; ignore rather than die.
        };
        if let Some(response) = handle_message(&message) {
            let _ = serde_json::to_writer(&mut out, &response);
            let _ = out.write_all(b"\n");
            let _ = out.flush();
        }
    }
}

fn handle_message(message: &Value) -> Option<Value> {
    let method = message.get("method")?.as_str()?;
    let id = message.get("id").cloned();

    // Notifications (no id) get no response.
    let id = match id {
        Some(id) if !id.is_null() => id,
        _ => return None,
    };

    let result = match method {
        "initialize" => json!({
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": { "tools": {} },
            "serverInfo": { "name": SERVER_NAME, "version": SERVER_VERSION },
        }),
        "ping" => json!({}),
        "tools/list" => json!({ "tools": tool_definitions() }),
        "tools/call" => {
            let params = message.get("params").cloned().unwrap_or(json!({}));
            call_tool(&params)
        }
        _ => {
            return Some(json!({
                "jsonrpc": "2.0",
                "id": id,
                "error": { "code": -32601, "message": format!("Method not found: {method}") },
            }));
        }
    };

    Some(json!({ "jsonrpc": "2.0", "id": id, "result": result }))
}

fn tool_definitions() -> Value {
    json!([
        {
            "name": "list_topics",
            "description": "List the topics in the user's memory — named files of durable knowledge about the person (like their style, family, or work). Returns each topic's name and what it holds. Use this to find out what the user's memory covers before recalling anything.",
            "inputSchema": { "type": "object", "properties": {}, "required": [] },
        },
        {
            "name": "recall",
            "description": "Read one memory topic's contents. Only recall a topic when that part of the user's life is what you're currently helping with — don't bulk-load topics that aren't relevant to the conversation.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "topic": { "type": "string", "description": "Topic name or file name, e.g. 'style' or 'family'." }
                },
                "required": ["topic"],
            },
        },
        {
            "name": "propose_memory",
            "description": "Suggest a durable fact or preference for the user to review. A proposal is not memory and is unavailable to agents until the user edits or approves it in Berd. Only propose things the user actually said, phrased close to their own words. Never propose authentication or access data: no passwords, PINs, API keys, tokens, account/card numbers, recovery codes, or instructions that grant access. Current task, trip, or project details belong in that project. Propose at most once per conversation unless asked; if declined, never re-propose it. Never edit memory files directly.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "content": { "type": "string", "description": "The entry to remember, as a short imperative or factual line." },
                    "topic": { "type": "string", "description": "Optional topic this belongs to. Prefer one of the user's existing topics (call list_topics). Otherwise use exactly one of these broad areas: Home (household, family, pets, routines), Social (friends, neighbors, plans outside the household), Interests (music, art, sports, reading, hobbies, dining), Travel (how they travel, not one trip's details), Shopping (brands, sizes, budgets), Work (role, schedule, how their work operates), Tools (apps, gear, equipment). Never invent a narrower name like 'soccer' or 'jazz'. Omit entirely for standing rules that apply everywhere." }
                },
                "required": ["content"],
            },
        },
    ])
}

/// Memory-off is enforced here, per call, from the store's canonical
/// policy. This reaches already-running sessions and lets every conforming
/// host observe the same decision. Missing/malformed policy means enabled.
fn memory_off() -> bool {
    me_dir()
        .map(|dir| policy_disables_memory(&dir.join("policy.json")))
        .unwrap_or(false)
}

fn policy_disables_memory(path: &Path) -> bool {
    let Ok(contents) = fs::read_to_string(path) else {
        return false;
    };
    serde_json::from_str::<Value>(&contents)
        .ok()
        .and_then(|value| value.get("enabled").and_then(Value::as_bool))
        == Some(false)
}

fn call_tool(params: &Value) -> Value {
    let name = params.get("name").and_then(Value::as_str).unwrap_or("");
    let args = params.get("arguments").cloned().unwrap_or(json!({}));

    if memory_off() {
        return json!({
            "content": [{ "type": "text", "text": "Memory is off. The user turned Berd's memory off — don't offer to remember things, don't propose saving preferences, and don't read or create memory files." }],
            "isError": true,
        });
    }

    let outcome = match name {
        "list_topics" => list_topics(),
        "recall" => recall(args.get("topic").and_then(Value::as_str).unwrap_or("")),
        "propose_memory" => propose_memory(
            args.get("content").and_then(Value::as_str).unwrap_or(""),
            args.get("topic").and_then(Value::as_str),
        ),
        other => Err(format!("Unknown tool: {other}")),
    };

    match outcome {
        Ok(text) => json!({ "content": [{ "type": "text", "text": text }], "isError": false }),
        Err(text) => json!({ "content": [{ "type": "text", "text": text }], "isError": true }),
    }
}

fn me_dir() -> Result<PathBuf, String> {
    memory_root()
}

fn topic_docs() -> Result<Vec<(String, String)>, String> {
    let me = me_dir()?;
    let mut docs = Vec::new();
    for dir in [me.join("topics")] {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if !file_type.is_file() || file_type.is_symlink() {
                continue;
            }
            let Ok(canonical_dir) = dir.canonicalize() else {
                continue;
            };
            let Ok(canonical_path) = entry.path().canonicalize() else {
                continue;
            };
            if !canonical_path.starts_with(&canonical_dir) {
                continue;
            }
            let file_name = entry.file_name().to_string_lossy().to_string();
            if !file_name.ends_with(".md") || file_name == "me.md" {
                continue;
            }
            let Ok(contents) = fs::read_to_string(&canonical_path) else {
                continue;
            };
            if !content_is_approved(&me, &canonical_path, &contents) {
                continue;
            }
            docs.push((file_name, contents));
        }
    }
    Ok(docs)
}

/// Exact match only: the file stem or the display label, case-insensitive.
/// Substring matching is deliberately gone — loading the wrong personal
/// context silently is worse than asking.
fn topic_matches(stem: &str, label: &str, query: &str) -> bool {
    let q = query.trim().to_lowercase();
    stem.to_lowercase() == q || label.to_lowercase() == q
}

/// Topic label and description from a doc's `# Heading` and first italic
/// line — the same self-description convention the Berd UI parses.
fn topic_meta(contents: &str, file_name: &str) -> (String, Option<String>) {
    let mut label = None;
    let mut description = None;
    for line in contents.lines() {
        let trimmed = line.trim();
        if label.is_none() {
            if let Some(heading) = trimmed.strip_prefix("# ") {
                label = Some(heading.trim().to_string());
                continue;
            }
        }
        if description.is_none()
            && trimmed.len() > 2
            && trimmed.starts_with('*')
            && trimmed.ends_with('*')
            && !trimmed.starts_with("**")
        {
            description = Some(trimmed.trim_matches('*').trim().to_string());
        }
        if label.is_some() && description.is_some() {
            break;
        }
    }
    let fallback = file_name.trim_end_matches(".md").replace('-', " ");
    (label.unwrap_or(fallback), description)
}

fn list_topics() -> Result<String, String> {
    let mut lines = Vec::new();
    for (file_name, contents) in topic_docs()? {
        let (label, description) = topic_meta(&contents, &file_name);
        match description {
            Some(desc) => lines.push(format!("- {label} ({file_name}): {desc}")),
            None => lines.push(format!("- {label} ({file_name})")),
        }
    }
    lines.sort();

    if lines.is_empty() {
        return Ok("Offer to suggest durable facts from this conversation (schedules, people, preferences): propose_memory creates a reviewable candidate. A topic is created only if the user approves it. They have no topics yet. Don't write memory files yourself.".to_string());
    }
    Ok(format!(
        "The user's memory topics — recall one only when it's relevant to what you're helping with:\n{}",
        lines.join("\n")
    ))
}

/// Strip italic note-to-user blocks — same convention as the Berd
/// preamble: italics are for the person, agents never see them.
fn strip_notes(contents: &str) -> String {
    contents
        .split("\n\n")
        .filter(|block| {
            let t = block.trim();
            !(t.len() > 2 && t.starts_with('*') && t.ends_with('*') && !t.starts_with("**"))
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

fn recall(topic: &str) -> Result<String, String> {
    let query = topic.trim();
    if query.is_empty() {
        return Err("Which topic? Call list_topics to see what exists.".to_string());
    }

    for (file_name, contents) in topic_docs()? {
        let stem = file_name.trim_end_matches(".md");
        let (label, _) = topic_meta(&contents, &file_name);
        if topic_matches(stem, &label, query) {
            let body = strip_notes(&contents);
            return Ok(format!(
                "{body}\n\n[This is the user's own record. Honor it; what they say right now beats it. Never edit their memory files directly — use propose_memory.]"
            ));
        }
    }
    Err(format!(
        "No topic named '{topic}' — matching is exact, so call list_topics to see the exact names rather than guessing. Don't create memory files yourself. If this conversation surfaced a durable fact for '{topic}', propose_memory can create a candidate; the topic is created only if the user approves it."
    ))
}

fn propose_memory(content: &str, topic: Option<&str>) -> Result<String, String> {
    let content = content.trim();
    if content.is_empty() {
        return Err("Nothing to propose — content is required.".to_string());
    }
    if content.chars().count() > 300 {
        return Err("Memory entries must be 300 characters or fewer.".to_string());
    }
    if looks_like_credential(content) {
        return Err("Authentication and access data can't be proposed or saved to memory.".to_string());
    }
    let topic = topic.map(str::trim).filter(|t| !t.is_empty());

    let dir = me_dir()?.join("proposals");
    fs::create_dir_all(&dir).map_err(|e| format!("Couldn't queue the proposal: {e}"))?;
    let _lock = acquire_queue_lock(&dir)?;

    let pending_path = dir.join(PENDING_FILE);
    if jsonl_records(&dir.join(DISMISSED_FILE))
        .iter()
        .any(|record| is_suppressed(record, content, topic))
    {
        return Ok(
            "The user already declined remembering this — don't propose it again.".to_string(),
        );
    }
    if jsonl_records(&pending_path)
        .iter()
        .any(|record| same_fact(record, content, topic))
    {
        return Ok(
            "Already proposed and awaiting the user's review — don't propose it again.".to_string(),
        );
    }

    append_jsonl(
        &pending_path,
        &json!({
            "id": format!("p-{}", uuid::Uuid::new_v4()),
            "ts": now_epoch_seconds(),
            "content": content,
            "topic": topic,
            "agent": "MCP agent",
            "host": "berd",
        }),
    )?;

    Ok("Proposed for review. Berd has not added this to memory. The user can edit, approve, or decline it in Settings → Memory. Mention briefly that you suggested it, then move on; don't propose the same thing twice this conversation.".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_authentication_data_before_queueing() {
        assert!(looks_like_credential("API key: ghp_16CharsAtLeastHere00"));
        assert!(looks_like_credential("PIN: 1234"));
        assert!(!looks_like_credential("I use 1Password"));
    }

    #[cfg(unix)]
    #[test]
    fn topic_symlinks_are_not_listed() {
        use std::os::unix::fs::symlink;
        let temp = tempfile::tempdir().unwrap();
        let me = temp.path().join(".me");
        let topics = me.join("topics");
        fs::create_dir_all(&topics).unwrap();
        let outside = temp.path().join("private.md");
        fs::write(&outside, "# Private\n\nsecret").unwrap();
        symlink(&outside, topics.join("linked.md")).unwrap();
        let entry = fs::read_dir(&topics).unwrap().next().unwrap().unwrap();
        assert!(entry.file_type().unwrap().is_symlink());
    }

    #[test]
    fn topic_meta_parses_heading_and_italic_description() {
        let (label, desc) = topic_meta("# Style\n\n*Brands and fits.*\n\n- entry", "style.md");
        assert_eq!(label, "Style");
        assert_eq!(desc.as_deref(), Some("Brands and fits."));
    }

    #[test]
    fn topic_meta_falls_back_to_file_name() {
        let (label, desc) = topic_meta("- just entries", "kids-activities.md");
        assert_eq!(label, "kids activities");
        assert!(desc.is_none());
    }

    #[test]
    fn strip_notes_removes_italic_blocks_only() {
        let body = "# Style\n\n*A note to the user.*\n\n- Prefers vintage.\n\n**Bold** stays.";
        let stripped = strip_notes(body);
        assert!(!stripped.contains("note to the user"));
        assert!(stripped.contains("Prefers vintage"));
        assert!(stripped.contains("**Bold** stays"));
    }

    #[test]
    fn initialize_and_tools_list_respond() {
        let init = handle_message(&json!({
            "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}
        }))
        .unwrap();
        assert_eq!(init["result"]["serverInfo"]["name"], SERVER_NAME);

        let list = handle_message(&json!({
            "jsonrpc": "2.0", "id": 2, "method": "tools/list"
        }))
        .unwrap();
        let tools = list["result"]["tools"].as_array().unwrap();
        assert_eq!(tools.len(), 3);
    }

    #[test]
    fn notifications_get_no_response() {
        let none = handle_message(&json!({
            "jsonrpc": "2.0", "method": "notifications/initialized"
        }));
        assert!(none.is_none());
    }

    #[test]
    fn memory_off_follows_policy_json() {
        let dir = std::env::temp_dir().join(format!(
            "berd-memory-policy-{}-{}",
            std::process::id(),
            now_epoch_seconds()
        ));
        fs::create_dir_all(&dir).unwrap();
        let policy = dir.join("policy.json");
        assert!(!policy_disables_memory(&policy));
        fs::write(&policy, r#"{ "enabled": false }"#).unwrap();
        assert!(policy_disables_memory(&policy));
        fs::write(&policy, r#"{ "enabled": true }"#).unwrap();
        assert!(!policy_disables_memory(&policy));
        fs::write(&policy, "not json").unwrap();
        assert!(!policy_disables_memory(&policy));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn topic_matching_is_exact_not_substring() {
        assert!(topic_matches("family", "Family", "family"));
        assert!(topic_matches("family", "Family", "FAMILY"));
        assert!(topic_matches(
            "kids-activities",
            "Kids activities",
            "kids activities"
        ));
        // The failure mode exact matching exists to prevent:
        assert!(!topic_matches("family", "Family", "fam"));
        assert!(!topic_matches("work-projects", "Work projects", "work"));
    }

    #[test]
    fn shared_fact_matching_ignores_case_and_matches_topic() {
        let record = json!({"content": "Prefers vintage.", "topic": "style"});
        assert!(same_fact(&record, "prefers vintage.", Some("Style")));
        assert!(!same_fact(&record, "prefers vintage.", None));
        assert!(!same_fact(&record, "something else", Some("style")));
        let no_topic = json!({"content": "Keep it brief."});
        assert!(same_fact(&no_topic, "keep it brief.", None));
    }

    #[test]
    fn proposal_ids_are_unique() {
        let a = uuid::Uuid::new_v4();
        let b = uuid::Uuid::new_v4();
        assert_ne!(a, b);
        assert_eq!(a.get_version(), Some(uuid::Version::Random));
    }

    #[test]
    fn unknown_methods_error_politely() {
        let resp = handle_message(&json!({
            "jsonrpc": "2.0", "id": 3, "method": "bogus/method"
        }))
        .unwrap();
        assert_eq!(resp["error"]["code"], -32601);
    }
}
