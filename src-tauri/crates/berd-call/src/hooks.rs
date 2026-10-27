//! The Claude Code plugin: the skill for using a call, and the hooks that hold
//! the agent that started one to answering it.

use std::io::Read;
use std::path::{Path, PathBuf};
#[cfg(any(target_os = "macos", test))]
use std::sync::atomic::AtomicBool;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[cfg(any(target_os = "macos", test))]
use berd_call::protocol::{PendingUtterance, UtteranceOrigin};

use crate::host_control::{self, ControlRequest};

const NAME: &str = "berd-call";
const SKILL: &str = include_str!("../claude-code/SKILL.md");
const HOOKS: &str = include_str!("../claude-code/hooks/hooks.json");
const MAX_PAYLOAD_BYTES: u64 = 1024 * 1024;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum HookEvent {
    PromptSubmit,
    PreTool,
    PostTool,
    Stop,
    PermissionRequest,
}

/// The session of the agent harness running this command, if it names one.
#[cfg(any(target_os = "macos", test))]
pub(crate) fn environment_session() -> Option<String> {
    std::env::var("CLAUDE_CODE_SESSION_ID")
        .ok()
        .filter(|id| !id.is_empty())
}

/// The agent session a call's hooks hold, and whether it has used tools since
/// it last spoke.
#[cfg(any(target_os = "macos", test))]
pub(crate) struct HookBinding {
    pub(crate) session_id: Option<String>,
    pub(crate) port: u16,
    pub(crate) worked: AtomicBool,
}

#[cfg(any(target_os = "macos", test))]
impl HookBinding {
    pub(crate) fn new(session_id: Option<String>, port: u16) -> Self {
        Self {
            session_id,
            port,
            worked: AtomicBool::new(false),
        }
    }

    pub(crate) fn holds(&self, session_id: &str, subagent: bool) -> bool {
        !subagent && self.session_id.as_deref() == Some(session_id)
    }
}

/// How the agent answers the user on this call.
#[cfg(any(target_os = "macos", test))]
pub(crate) struct Reply {
    pub(crate) relays: bool,
    pub(crate) port: u16,
}

#[cfg(any(target_os = "macos", test))]
impl Reply {
    fn command(&self, cursor: u64, handoffs: &[String]) -> String {
        let mut command = String::from("berd-call ");
        command += if self.relays {
            "message-spokesperson"
        } else {
            "speak"
        };
        if self.port != 5222 {
            command += &format!(" --port {}", self.port);
        }
        command += &format!(" --re {cursor}");
        for id in handoffs {
            command += &format!(" --resolves {id}");
        }
        command + " 'REPLY'"
    }

    /// Why the agent must answer before going on, given `catch-up`'s result.
    pub(crate) fn unanswered(&self, poll: &Value) -> Option<String> {
        let utterances: Vec<PendingUtterance> =
            serde_json::from_value(poll["utterances"].clone()).ok()?;
        let heard = utterances
            .iter()
            .filter(|item| item.origin != Some(UtteranceOrigin::Spokesperson))
            .map(|item| match item.origin {
                Some(UtteranceOrigin::Handoff) => format!("[{}] handoff: {}", item.token, item.text),
                _ => format!("[{}] {}", item.token, item.text),
            })
            .collect::<Vec<_>>();
        if heard.is_empty() {
            return None;
        }
        let handoffs: Vec<String> =
            serde_json::from_value(poll["unresolvedHandoffIds"].clone()).unwrap_or_default();
        Some(format!(
            "The user said this on the call and hasn't had an answer:\n{}\nAnswer before going on: {}",
            heard.join("\n"),
            self.command(poll["cursor"].as_u64()?, &handoffs)
        ))
    }

    pub(crate) fn unspoken(&self) -> String {
        format!(
            "You used tools since you last spoke on the call. Tell the user what you did with `berd-call {}` before ending your turn.",
            if self.relays { "message-spokesperson" } else { "speak" }
        )
    }
}

#[cfg(any(target_os = "macos", test))]
pub(crate) const UNHEARD: &str = "A Berd Call is active and nothing delivers its transcript to you, so ending your turn would leave the user unheard. Wait for them with `berd-call wait-for-input`, or end the call with `berd-call stop` if they asked.";

/// Runs one Claude Code hook: forwards it to the call on `port` and prints what
/// the call decides. With no call running, the hook does nothing.
pub(crate) fn run(event: HookEvent, port: u16) -> Value {
    let mut input = Vec::new();
    let _ = std::io::stdin()
        .take(MAX_PAYLOAD_BYTES)
        .read_to_end(&mut input);
    let payload: Value = serde_json::from_slice(&input).unwrap_or_default();
    let Some(session_id) = payload["session_id"].as_str() else {
        return json!({});
    };
    let request = ControlRequest::Hook {
        event,
        session_id: session_id.into(),
        subagent: payload.get("agent_id").is_some(),
        call: runs_call(&payload),
    };
    match host_control::request(port, request) {
        Ok(value) => output(event, value["block"].as_str()),
        Err(_) => json!({}),
    }
}

fn output(event: HookEvent, block: Option<&str>) -> Value {
    match (event, block) {
        (HookEvent::PreTool, Some(reason)) => json!({"hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": reason,
        }}),
        (HookEvent::Stop, Some(reason)) => json!({"decision": "block", "reason": reason}),
        _ => json!({}),
    }
}

/// Whether a tool call works the call itself, which never counts as work and
/// is never refused.
fn runs_call(payload: &Value) -> bool {
    payload["tool_name"]
        .as_str()
        .is_some_and(|name| name.contains("berd_call"))
        || payload["tool_input"]["command"]
            .as_str()
            .is_some_and(|command| {
                command
                    .split(|c: char| c.is_whitespace() || ";&|()`'\"".contains(c))
                    .any(|word| word.rsplit('/').next() == Some(NAME))
            })
}

fn directory() -> Result<PathBuf, String> {
    let config = match std::env::var_os("CLAUDE_CONFIG_DIR") {
        Some(directory) => PathBuf::from(directory),
        None => PathBuf::from(std::env::var_os("HOME").ok_or("HOME is not set")?).join(".claude"),
    };
    Ok(config.join("skills").join(NAME))
}

fn files() -> [(&'static str, String); 3] {
    let manifest = json!({
        "name": NAME,
        "version": env!("CARGO_PKG_VERSION"),
        "description": "Voice calls with Berd Call, holding the agent that starts one to answering it.",
        "author": {"name": "Block"},
        "skills": ["./"],
    });
    [
        (
            ".claude-plugin/plugin.json",
            format!("{manifest:#}\n"),
        ),
        ("hooks/hooks.json", HOOKS.into()),
        ("SKILL.md", SKILL.into()),
    ]
}

/// Whether `directory` holds this plugin rather than something else of its name.
fn ours(directory: &Path) -> bool {
    std::fs::read(directory.join(".claude-plugin/plugin.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .is_some_and(|manifest| manifest["name"] == NAME)
        && !directory.is_symlink()
}

fn write(directory: &Path) -> Result<bool, String> {
    let mut changed = false;
    for (path, contents) in files() {
        let path = directory.join(path);
        if std::fs::read(&path).ok().as_deref() == Some(contents.as_bytes()) {
            continue;
        }
        std::fs::create_dir_all(path.parent().expect("plugin files are in directories"))
            .and_then(|()| std::fs::write(&path, contents))
            .map_err(|error| format!("could not write {}: {error}", path.display()))?;
        changed = true;
    }
    Ok(changed)
}

pub(crate) fn install() -> Result<String, String> {
    install_at(&directory()?)
}

fn install_at(directory: &Path) -> Result<String, String> {
    if directory.symlink_metadata().is_ok() && !ours(directory) {
        return Err(format!(
            "{} already exists and isn't this plugin; remove it, then install again",
            directory.display()
        ));
    }
    write(directory)?;
    Ok(format!(
        "Installed the Berd Call plugin for Claude Code at {}. It loads in new sessions.",
        directory.display()
    ))
}

pub(crate) fn uninstall() -> Result<String, String> {
    uninstall_at(&directory()?)
}

fn uninstall_at(directory: &Path) -> Result<String, String> {
    if directory.symlink_metadata().is_err() {
        return Ok("The Berd Call plugin for Claude Code isn't installed.".into());
    }
    if !ours(directory) {
        return Err(format!(
            "{} isn't this plugin; leaving it alone",
            directory.display()
        ));
    }
    std::fs::remove_dir_all(directory)
        .map_err(|error| format!("could not remove {}: {error}", directory.display()))?;
    Ok(format!("Removed {}.", directory.display()))
}

/// Brings an installed plugin up to this version; never installs one.
pub(crate) fn refresh() -> Result<(), String> {
    let directory = directory()?;
    if ours(&directory) {
        write(&directory)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temporary(name: &str) -> PathBuf {
        let directory = std::env::temp_dir().join(format!(
            "berd-call-plugin-{name}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&directory);
        directory
    }

    #[test]
    fn hooks_hold_only_the_bound_main_session() {
        let binding = HookBinding::new(Some("main".into()), 5222);
        assert!(binding.holds("main", false));
        assert!(!binding.holds("main", true));
        assert!(!binding.holds("other", false));
        assert!(!HookBinding::new(None, 5222).holds("main", false));
    }

    #[test]
    fn call_commands_are_recognized_wherever_they_appear() {
        for command in [
            "berd-call speak --re 3 'hi'",
            "/Applications/Berd.app/Contents/MacOS/berd-call wait-for-input",
            "cd /tmp && berd-call status",
            "(berd-call catch-up)",
        ] {
            assert!(
                runs_call(&json!({"tool_name": "Bash", "tool_input": {"command": command}})),
                "{command}"
            );
        }
        for command in ["cargo test -p berd-call-extra", "echo berd-calling", "ls"] {
            assert!(
                !runs_call(&json!({"tool_name": "Bash", "tool_input": {"command": command}})),
                "{command}"
            );
        }
        assert!(runs_call(&json!({"tool_name": "mcp__buzz__berd_call_status"})));
        assert!(!runs_call(&json!({"tool_name": "Read", "tool_input": {"file_path": "berd-call"}})));
    }

    #[test]
    fn unanswered_input_names_the_reply_that_answers_it() {
        let reply = Reply {
            relays: false,
            port: 5222,
        };
        let poll = json!({
            "utterances": [
                {"token": 4, "text": "check the build"},
                {"token": 5, "text": "on it", "origin": "spokesperson"},
            ],
            "cursor": 5,
            "unresolvedHandoffIds": [],
        });
        assert_eq!(
            reply.unanswered(&poll).unwrap(),
            "The user said this on the call and hasn't had an answer:\n[4] check the build\nAnswer before going on: berd-call speak --re 5 'REPLY'"
        );
        let relayed = Reply {
            relays: true,
            port: 6000,
        }
        .unanswered(&json!({
            "utterances": [{"token": 9, "text": "look into it", "origin": "handoff"}],
            "cursor": 9,
            "unresolvedHandoffIds": ["h1"],
        }))
        .unwrap();
        assert!(relayed.contains("[9] handoff: look into it"));
        assert!(relayed.ends_with(
            "berd-call message-spokesperson --port 6000 --re 9 --resolves h1 'REPLY'"
        ));
    }

    #[test]
    fn only_the_spokespersons_own_words_need_no_answer() {
        let reply = Reply {
            relays: true,
            port: 5222,
        };
        assert_eq!(
            reply.unanswered(&json!({
                "utterances": [{"token": 2, "text": "hello", "origin": "spokesperson"}],
                "cursor": 2,
                "unresolvedHandoffIds": [],
            })),
            None
        );
        assert_eq!(
            reply.unanswered(&json!({"utterances": [], "cursor": 2})),
            None
        );
    }

    #[test]
    fn claude_code_receives_refusals_in_each_events_own_form() {
        assert_eq!(
            output(HookEvent::PreTool, Some("answer")),
            json!({"hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "deny",
                "permissionDecisionReason": "answer",
            }})
        );
        assert_eq!(
            output(HookEvent::Stop, Some("answer")),
            json!({"decision": "block", "reason": "answer"})
        );
        assert_eq!(output(HookEvent::Stop, None), json!({}));
        assert_eq!(output(HookEvent::PostTool, Some("ignored")), json!({}));
    }

    #[test]
    fn install_writes_the_plugin_and_refreshes_only_what_changed() {
        let directory = temporary("install");
        install_at(&directory).unwrap();
        assert!(ours(&directory));
        let hooks: Value =
            serde_json::from_slice(&std::fs::read(directory.join("hooks/hooks.json")).unwrap())
                .unwrap();
        assert!(hooks["hooks"]["Stop"][0]["hooks"][0]["command"]
            .as_str()
            .unwrap()
            .starts_with("berd-call hook stop"));
        assert!(std::fs::read_to_string(directory.join("SKILL.md"))
            .unwrap()
            .starts_with("---\nname: berd-call\n"));
        assert!(!write(&directory).unwrap());
        std::fs::write(directory.join("hooks/hooks.json"), "{}").unwrap();
        assert!(write(&directory).unwrap());
        uninstall_at(&directory).unwrap();
        assert!(!directory.exists());
        assert!(uninstall_at(&directory).is_ok());
    }

    #[test]
    fn install_and_uninstall_leave_other_directories_alone() {
        let directory = temporary("foreign");
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(directory.join("SKILL.md"), "mine").unwrap();
        assert!(install_at(&directory).is_err());
        assert!(uninstall_at(&directory).is_err());
        assert_eq!(
            std::fs::read_to_string(directory.join("SKILL.md")).unwrap(),
            "mine"
        );
        std::fs::remove_dir_all(&directory).unwrap();
    }
}
