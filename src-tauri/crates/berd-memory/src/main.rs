//! Berd's memory MCP server — minimal stdio implementation.
//!
//! Exposes the user's `~/.me/` memory files to any MCP-capable harness
//! through three tools: `list_topics`, `recall`, and `propose_memory`.
//!
//! Consent is structural, not instructed: `propose_memory` never writes
//! to a memory file. It appends the proposal to `~/.me/proposals/
//! pending.jsonl`, where Berd surfaces it for the user's approve/edit/
//! reject. Only Berd — after a yes — writes memory.
//!
//! Deliberately hand-rolled: MCP over stdio is newline-delimited
//! JSON-RPC, and serde_json is the only dependency. No SDK, no async
//! runtime, nothing to break.

use std::fs;
use std::io::{self, BufRead, Write};
use std::path::PathBuf;

use serde_json::{json, Value};

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
            "description": "Propose remembering a durable fact or preference about the user. Nothing is saved by this call: the user reviews every proposal in Berd and decides. Only propose things the user actually said or clearly demonstrated, phrased close to their own words. Memory is for lasting facts about the person — anything about a current task, trip, or project belongs in that project instead. Propose at most once per conversation unless the user asks; if they decline, don't re-propose it.",
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

/// Memory-off is enforced here, per call, not just at registration time:
/// Berd points `BERD_MEMORY_OFF_FLAG` at the Settings toggle's flag file,
/// and we check its existence on every tools/call — so flipping memory
/// off reaches sessions that are already running.
fn memory_off_at(flag_path: Option<&str>) -> bool {
    flag_path
        .map(|path| !path.is_empty() && PathBuf::from(path).exists())
        .unwrap_or(false)
}

fn memory_off() -> bool {
    let flag = std::env::var("BERD_MEMORY_OFF_FLAG").ok();
    memory_off_at(flag.as_deref())
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
    let home = std::env::var("HOME").map_err(|_| "No home directory".to_string())?;
    Ok(PathBuf::from(home).join(".me"))
}

/// Topic docs live under `~/.me/topics/` (namespaced so future protocol
/// files in `~/.me/` don't accidentally become memory topics). The `.me`
/// root is still read for topics created before the namespacing.
fn topic_dirs() -> Result<Vec<PathBuf>, String> {
    let me = me_dir()?;
    Ok(vec![me.join("topics"), me])
}

/// Every readable topic doc across the topic dirs, deduped by file name
/// (namespaced location wins over a same-named legacy root file).
fn topic_docs() -> Result<Vec<(String, String)>, String> {
    let mut seen = Vec::new();
    let mut docs = Vec::new();
    for dir in topic_dirs()? {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let file_name = entry.file_name().to_string_lossy().to_string();
            if !file_name.ends_with(".md") || file_name == "me.md" {
                continue;
            }
            if seen.contains(&file_name) {
                continue;
            }
            let Ok(contents) = fs::read_to_string(entry.path()) else {
                continue;
            };
            seen.push(file_name.clone());
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
        return Ok("Offer to remember durable facts from this conversation (schedules, people, preferences): propose_memory with a topic name creates the topic on the user's approval. They have no topics yet — you checking means this conversation probably touches a part of their life worth remembering. Don't write memory files yourself.".to_string());
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
        "No topic named '{topic}' — matching is exact, so call list_topics to see the exact names rather than guessing. Don't create memory files yourself. If this conversation surfaced durable facts that belong in a '{topic}' topic, offer to remember them: propose_memory with that topic name creates it on approval."
    ))
}

/// Case-insensitive equality on content + topic, used to dedupe proposals
/// against the pending queue and the dismissal tombstones.
fn same_proposal(record: &Value, content: &str, topic: Option<&str>) -> bool {
    let rec_content = record.get("content").and_then(Value::as_str).unwrap_or("");
    let rec_topic = record.get("topic").and_then(Value::as_str);
    rec_content.trim().to_lowercase() == content.to_lowercase()
        && rec_topic.map(|t| t.trim().to_lowercase()) == topic.map(|t| t.to_lowercase())
}

/// Does any line of `path` match this content+topic?
fn jsonl_contains(path: &PathBuf, content: &str, topic: Option<&str>) -> bool {
    let Ok(existing) = fs::read_to_string(path) else {
        return false;
    };
    existing
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .any(|record| same_proposal(&record, content, topic))
}

fn propose_memory(content: &str, topic: Option<&str>) -> Result<String, String> {
    let content = content.trim();
    if content.is_empty() {
        return Err("Nothing to propose — content is required.".to_string());
    }
    let topic = topic.map(str::trim).filter(|t| !t.is_empty());

    let dir = me_dir()?.join("proposals");
    fs::create_dir_all(&dir).map_err(|e| format!("Couldn't queue the proposal: {e}"))?;

    // Dismissals are durable: a tombstoned proposal doesn't come back,
    // and an already-pending one isn't queued twice.
    if jsonl_contains(&dir.join("dismissed.jsonl"), content, topic) {
        return Ok(
            "The user already declined remembering this — don't propose it again.".to_string(),
        );
    }
    if jsonl_contains(&dir.join("pending.jsonl"), content, topic) {
        return Ok(
            "Already proposed and awaiting the user's review — don't propose it again.".to_string(),
        );
    }

    let record = json!({
        "id": new_proposal_id(),
        "ts": now_epoch_seconds(),
        "content": content,
        "topic": topic,
        "agent": std::env::var("BERD_AGENT_NAME").ok().filter(|a| !a.is_empty()),
        "host": "berd",
    });
    let path = dir.join("pending.jsonl");
    let mut line = record.to_string();
    line.push('\n');
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("Couldn't queue the proposal: {e}"))?;
    file.write_all(line.as_bytes())
        .map_err(|e| format!("Couldn't queue the proposal: {e}"))?;

    Ok("Recorded. Berd adds this to the user's memory and shows them what it added, so they can delete it if they don't want it. Mention briefly that you'll remember it, then move on; don't record the same thing twice this conversation.".to_string())
}

/// Unique-enough proposal id without a uuid dependency: epoch nanos plus
/// the pid. Approval/dismissal operate on this id, never on timestamp+text.
fn new_proposal_id() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("p-{nanos:x}-{}", std::process::id())
}

fn now_epoch_seconds() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn memory_off_flag_checks_existence() {
        assert!(!memory_off_at(None));
        assert!(!memory_off_at(Some("")));
        assert!(!memory_off_at(Some("/definitely/not/a/real/flag/path")));
        let dir = std::env::temp_dir().join(format!("berd-mem-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let flag = dir.join("off-flag");
        fs::write(&flag, b"off").unwrap();
        assert!(memory_off_at(flag.to_str()));
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
    fn same_proposal_ignores_case_and_matches_topic() {
        let record = json!({"content": "Prefers vintage.", "topic": "style"});
        assert!(same_proposal(&record, "prefers vintage.", Some("Style")));
        assert!(!same_proposal(&record, "prefers vintage.", None));
        assert!(!same_proposal(&record, "something else", Some("style")));
        let no_topic = json!({"content": "Keep it brief."});
        assert!(same_proposal(&no_topic, "keep it brief.", None));
    }

    #[test]
    fn proposal_ids_are_unique() {
        let a = new_proposal_id();
        let b = new_proposal_id();
        assert_ne!(a, b);
        assert!(a.starts_with("p-"));
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
