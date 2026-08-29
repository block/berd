//! berdctl — thin CLI client for the Berd desktop app's control broker.
//!
//! All command semantics (validation, defaults, side effects) live app-side
//! in the berdctl command registry; this binary only maps flags onto
//! the wire shape `{"command": "<group>", "args": {"action": "<verb>", ...}}`
//! and HTTP outcomes onto exit codes. The clap tree is built at startup
//! (`tree.rs`) from the embedded contract artifacts `api-surface.json` (the
//! client-neutral wire surface) + `cli-surface.json` (the CLI projection) —
//! generated from the renderer's command modules
//! (`pnpm generate:berdctl-contract`), which also author all help prose
//! (summary/description/helpFooter and per-field `.describe()`);
//! `validate.rs` gates the artifacts' consistency through this crate's
//! tests. Authored in Rust: the top-level identity/guide and globals
//! (`tree.rs`), exit-code mapping, and the wire client.

mod client;
mod contract;
mod discovery;
mod tree;
mod validate;
mod wire;

use std::io::Write;
use std::process::ExitCode;

use serde_json::{Map, Value};

use client::Failure;

fn main() -> ExitCode {
    let contract = contract::Contract::load();
    let matches = match tree::build_cli(&contract).try_get_matches() {
        Ok(matches) => matches,
        Err(err) => {
            // A usage error is a command error (exit 1), keeping exit 2
            // strictly transport; --help/--version exit 0.
            let exit = if err.use_stderr() { 1 } else { 0 };
            let _ = err.print();
            return ExitCode::from(exit);
        }
    };
    let globals = wire::globals(&matches);
    match wire::invocation(&contract, &matches) {
        wire::Invocation::Call { group, body } => match run(&group, body, &globals) {
            Ok(()) => ExitCode::SUCCESS,
            Err(failure) => {
                // eprintln! panics if stderr is a closed pipe; the exit code
                // already carries the failure class, so a lost message is fine.
                let _ = writeln!(std::io::stderr(), "{}", failure.message);
                ExitCode::from(failure.exit)
            }
        },
    }
}

fn run(command: &str, args: Map<String, Value>, globals: &wire::Globals) -> Result<(), Failure> {
    let lock_path = discovery::resolve_lock_path(globals.lock_path.clone())?;
    let endpoint = client::handshake(&lock_path)?;
    let result = client::call(&endpoint, command, args, globals.timeout_ms)?;
    let rendered = if globals.json {
        serde_json::to_string(&result)
    } else {
        serde_json::to_string_pretty(&result)
    }
    .map_err(|err| Failure::transport(format!("could not render the result ({err})")))?;
    write_result(&rendered)
}

/// `println!` panics on write failure, but a consumer closing the pipe early
/// (`berdctl … --json | head`) is routine CLI usage: a broken pipe counts
/// as success, and any other stdout failure is a transport fault, keeping
/// exits inside the documented 0/1/2/3 contract.
fn write_result(rendered: &str) -> Result<(), Failure> {
    let mut stdout = std::io::stdout().lock();
    match stdout
        .write_all(rendered.as_bytes())
        .and_then(|()| stdout.write_all(b"\n"))
        .and_then(|()| stdout.flush())
    {
        Err(err) if err.kind() != std::io::ErrorKind::BrokenPipe => Err(Failure::transport(
            format!("the result could not be written to stdout ({err})"),
        )),
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use clap::ArgMatches;

    use super::*;
    use crate::contract::Contract;

    const API_SURFACE: &str = contract::API_SURFACE;
    const CLI_SURFACE: &str = contract::CLI_SURFACE;

    fn cli() -> clap::Command {
        tree::build_cli(&Contract::load())
    }

    fn try_parse(argv: &[&str]) -> Result<ArgMatches, clap::Error> {
        cli().try_get_matches_from(argv)
    }

    fn wire_of(argv: &[&str]) -> (String, Map<String, Value>) {
        let matches =
            try_parse(argv).unwrap_or_else(|err| panic!("`{argv:?}` should parse: {err}"));
        match wire::invocation(&Contract::load(), &matches) {
            wire::Invocation::Call { group, body } => (group, body),
        }
    }

    /// The contract gate: every cross-artifact inconsistency (missing or
    /// TODO help, orphaned entries, surface ⇄ fields drift, unbuildable flag
    /// shapes) fails here with the full actionable list.
    #[test]
    fn contract_validates_cleanly() {
        let errors = validate::contract_errors(&Contract::load());
        assert!(
            errors.is_empty(),
            "\nthe CLI contract is inconsistent:\n\n  - {}\n\n\
             Fix: write the real help prose in the command module \
             (summary/description/helpFooter and every field's .describe()), \
             then regenerate with `pnpm generate:berdctl-contract` \
             (see .agents/skills/berdctl-new-command/SKILL.md).\n",
            errors.join("\n  - ")
        );
    }

    /// Runs clap's own self-checks (conflicting ids, malformed groups, …)
    /// directly.
    #[test]
    fn cli_passes_clap_debug_assert() {
        cli().debug_assert();
    }

    #[test]
    fn doctor_is_a_normal_unknown_subcommand() {
        let err = try_parse(&["berdctl", "doctor"]).expect_err("doctor is not a command");
        assert!(err.use_stderr());
    }

    // Raw-Value views of the contract files, kept independent of
    // contract.rs's typed parse.
    fn surface_nouns() -> serde_json::Map<String, Value> {
        let surface: Value = serde_json::from_str(CLI_SURFACE).expect("cli-surface.json parses");
        surface
            .get("nouns")
            .and_then(Value::as_object)
            .expect("cli-surface.json has a nouns object")
            .clone()
    }

    fn api_groups() -> serde_json::Map<String, Value> {
        let api: Value = serde_json::from_str(API_SURFACE).expect("api-surface.json parses");
        api.get("groups")
            .and_then(Value::as_object)
            .expect("api-surface.json has a groups object")
            .clone()
    }

    fn api_fields(group: &str, action: &str) -> Vec<Value> {
        api_groups()
            .get(group)
            .and_then(|spec| spec.get("actions"))
            .and_then(|actions| actions.get(action))
            .and_then(|spec| spec.get("fields"))
            .and_then(Value::as_array)
            .unwrap_or_else(|| panic!("api-surface has `{group}.{action}` fields"))
            .clone()
    }

    /// api-surface.json's protocolVersion mirrors `PROTOCOL_VERSION` in
    /// discovery.rs (and the broker plugin's copy); bump all copies together.
    #[test]
    fn api_surface_protocol_version_matches_the_cli() {
        assert_eq!(
            Contract::load().api.protocol_version,
            discovery::PROTOCOL_VERSION,
            "bump protocolVersion in contract.ts and both discovery.rs copies together"
        );
    }

    /// `cli-surface.json` is the pinned contract between this binary and the
    /// renderer registry (vitest asserts the other side). The noun/verb tree
    /// is built from the file at runtime, so this asserts the builder covers
    /// it in both directions.
    #[test]
    fn clap_tree_matches_cli_surface_contract() {
        let nouns = surface_nouns();
        let cmd = cli();

        for (noun, spec) in &nouns {
            let noun_cmd = cmd
                .find_subcommand(noun)
                .unwrap_or_else(|| panic!("cli-surface noun `{noun}` is missing from clap"));
            let verbs = spec
                .get("verbs")
                .and_then(Value::as_object)
                .unwrap_or_else(|| panic!("cli-surface noun `{noun}` has no verbs object"));
            for verb in verbs.keys() {
                assert!(
                    noun_cmd.find_subcommand(verb).is_some(),
                    "cli-surface verb `{noun} {verb}` is missing from clap"
                );
            }
            for sub in noun_cmd.get_subcommands() {
                let name = sub.get_name();
                if name == "help" {
                    continue;
                }
                assert!(
                    verbs.contains_key(name),
                    "clap subcommand `{noun} {name}` is missing from cli-surface.json"
                );
            }
        }

        for sub in cmd.get_subcommands() {
            let name = sub.get_name();
            if name == "help" {
                continue;
            }
            assert!(
                nouns.contains_key(name),
                "clap noun `{name}` is missing from cli-surface.json"
            );
        }
    }

    /// Walks every built command's flags against the contract: each wire
    /// field has a flag with matching requiredness.
    #[test]
    fn built_flags_match_contract_requiredness() {
        let cmd = cli();
        for (noun, spec) in &surface_nouns() {
            let group = spec.get("group").and_then(Value::as_str).unwrap();
            for (verb, verb_spec) in spec.get("verbs").and_then(Value::as_object).unwrap() {
                let action = verb_spec.get("action").and_then(Value::as_str).unwrap();
                let fields = api_fields(group, action);
                let sub = cmd
                    .find_subcommand(noun)
                    .and_then(|noun_cmd| noun_cmd.find_subcommand(verb))
                    .unwrap_or_else(|| panic!("clap has `berdctl {noun} {verb}`"));
                for field in &fields {
                    let name = field["name"].as_str().unwrap();
                    let required = field["required"].as_bool().unwrap();
                    let long = name.replace('_', "-");
                    let arg = sub
                        .get_arguments()
                        .find(|arg| arg.get_long() == Some(long.as_str()))
                        .unwrap_or_else(|| {
                            panic!("--{long} is missing on `berdctl {noun} {verb}`")
                        });
                    assert_eq!(
                        arg.is_required_set(),
                        required,
                        "--{long} requiredness on `berdctl {noun} {verb}` diverges from \
                         api-surface.json `{group}.{action}.{name}`"
                    );
                }
            }
        }
    }

    /// Minimal valid invocation per verb, used to exercise the wire mapping.
    /// A new verb in cli-surface.json fails here until an entry is added.
    fn minimal_invocation(noun: &str, verb: &str) -> Option<Vec<&'static str>> {
        Some(match (noun, verb) {
            ("session", "create") => vec!["--prompt", "hi"],
            ("session", "send") => vec!["--session-id", "s", "--prompt", "hi"],
            ("session", "open") => vec!["--session-id", "s"],
            ("session", "list") => vec![],
            ("session", "get") => vec!["--session-id", "s"],
            ("session", "rename") => vec!["--session-id", "s", "--title", "t"],
            ("session", "move") => vec!["--session-id", "s", "--project-id", "p"],
            ("session", "move-to-group") => vec!["--session-id", "s", "--group-id", "g"],
            ("session", "clear-project") => vec!["--session-id", "s"],
            ("folder", "attach") | ("folder", "detach") | ("folder", "set-cwd") => {
                vec!["--session-id", "s", "--path", "/w"]
            }
            ("folder", "list") => vec!["--session-id", "s"],
            ("folder", "replace") => vec![
                "--session-id",
                "s",
                "--old-path",
                "/old",
                "--new-path",
                "/new",
            ],
            ("session", "fork") => vec!["--session-id", "s"],
            ("session", "archive") => vec!["--session-id", "s"],
            ("project", "create") => vec!["--name", "n"],
            ("project", "list") => vec![],
            ("project", "get") => vec!["--project-id", "p"],
            ("project", "set-startup-mode") => {
                vec!["--project-id", "p", "--mode", "worktree"]
            }
            ("project", "archive") => vec!["--project-id", "p"],
            ("agent", "create") => vec!["--name", "n", "--system-prompt", "sp"],
            ("agent", "list") => vec![],
            ("skill", "create") => {
                vec!["--name", "n", "--description", "d", "--content", "c"]
            }
            ("skill", "list") => vec![],
            ("skill", "get") => vec!["--skill-id", "k"],
            ("feedback", "open") | ("feedback", "submit") => {
                vec!["--title", "t", "--description", "d"]
            }
            ("info", "harnesses") => vec![],
            ("info", "models") => vec![],
            ("info", "context") => vec![],
            _ => return None,
        })
    }

    /// The clap tree matching the contract is not enough — the wire mapping
    /// must also emit the contract's group/action strings on the wire.
    #[test]
    fn wire_mapping_matches_cli_surface_contract() {
        for (noun, spec) in &surface_nouns() {
            let group = spec.get("group").and_then(Value::as_str).unwrap();
            for (verb, verb_spec) in spec.get("verbs").and_then(Value::as_object).unwrap() {
                let extra = minimal_invocation(noun, verb).unwrap_or_else(|| {
                    panic!("add a minimal invocation for `berdctl {noun} {verb}`")
                });
                let argv: Vec<&str> = [vec!["berdctl", noun, verb], extra].concat();
                let (command, args) = wire_of(&argv);
                assert_eq!(command, *group, "wire group for `{noun} {verb}`");
                assert_eq!(
                    args.get("action").and_then(Value::as_str),
                    verb_spec.get("action").and_then(Value::as_str),
                    "wire action for `{noun} {verb}`"
                );
            }
        }
    }

    /// Agents reach for plural nouns (`berdctl projects list`); the hidden
    /// aliases must forgive that by parsing to the same command as the
    /// singular spelling.
    #[test]
    fn plural_noun_aliases_parse_to_the_singular_commands() {
        for (plural, singular) in [
            ("sessions", "session"),
            ("projects", "project"),
            ("agents", "agent"),
            ("skills", "skill"),
        ] {
            assert_eq!(
                wire_of(&["berdctl", plural, "list"]),
                wire_of(&["berdctl", singular, "list"]),
                "`{plural}` must hit the same wire command as `{singular}`"
            );
        }
    }

    #[test]
    fn optional_flags_are_omitted_from_the_wire() {
        let (_, args) = wire_of(&["berdctl", "session", "create", "--prompt", "hi"]);
        assert_eq!(
            Value::Object(args),
            serde_json::json!({"action": "create", "prompt": "hi"}),
            "absent optionals must not be sent (strict schemas reject null)"
        );
    }

    /// Field-for-field pin of the contract-driven wire path on its richest
    /// command: every provided flag lands under its wire name.
    #[test]
    fn session_create_maps_every_flag_onto_the_wire() {
        let (command, args) = wire_of(&[
            "berdctl",
            "session",
            "create",
            "--prompt",
            "hi",
            "--harness-id",
            "h",
            "--model-id",
            "m",
            "--agent-id",
            "a",
            "--project-id",
            "p",
        ]);
        assert_eq!(command, "sessions");
        assert_eq!(
            Value::Object(args),
            serde_json::json!({
                "action": "create",
                "prompt": "hi",
                "harness_id": "h",
                "model_id": "m",
                "agent_id": "a",
                "project_id": "p",
            })
        );
    }

    #[test]
    fn project_create_collects_repeated_working_dirs() {
        let (command, args) = wire_of(&[
            "berdctl",
            "project",
            "create",
            "--name",
            "Buzz",
            "--working-dir",
            "/src/buzz",
            "--working-dir",
            "/src/buzz-moderation",
        ]);
        assert_eq!(command, "projects");
        assert_eq!(
            Value::Object(args),
            serde_json::json!({
                "action": "create",
                "name": "Buzz",
                "working_dir": ["/src/buzz", "/src/buzz-moderation"],
            })
        );
    }

    #[test]
    fn session_send_maps_every_flag_onto_the_wire() {
        let (command, args) = wire_of(&[
            "berdctl",
            "session",
            "send",
            "--session-id",
            "s",
            "--prompt",
            "hi",
            "--if-running",
            "queue",
        ]);
        assert_eq!(command, "sessions");
        assert_eq!(
            Value::Object(args),
            serde_json::json!({
                "action": "send",
                "session_id": "s",
                "prompt": "hi",
                "if_running": "queue",
            })
        );
    }

    /// Second pin of the contract-driven wire path, covering numeric flags:
    /// --messages must reach the wire as a JSON number, not a string.
    #[test]
    fn session_get_maps_every_flag_onto_the_wire() {
        let (command, args) = wire_of(&[
            "berdctl",
            "session",
            "get",
            "--session-id",
            "s",
            "--messages",
            "5",
        ]);
        assert_eq!(command, "sessions");
        assert_eq!(
            Value::Object(args),
            serde_json::json!({"action": "get", "session_id": "s", "messages": 5})
        );
    }

    #[test]
    fn session_archive_maps_boolean_flags_onto_the_wire() {
        let (command, args) = wire_of(&[
            "berdctl",
            "session",
            "archive",
            "--session-id",
            "s",
            "--discard-changes",
        ]);
        assert_eq!(command, "sessions");
        assert_eq!(
            Value::Object(args),
            serde_json::json!({
                "action": "archive",
                "session_id": "s",
                "discard_changes": true,
            })
        );

        let (_, args_without_flag) =
            wire_of(&["berdctl", "session", "archive", "--session-id", "s"]);
        assert_eq!(
            Value::Object(args_without_flag),
            serde_json::json!({"action": "archive", "session_id": "s"})
        );
    }

    #[test]
    fn move_to_group_maps_to_its_explicit_action() {
        let (command, args) = wire_of(&[
            "berdctl",
            "session",
            "move-to-group",
            "--session-id",
            "s",
            "--group-id",
            "g",
        ]);
        assert_eq!(command, "sessions");
        assert_eq!(
            Value::Object(args),
            serde_json::json!({"action": "move_to_group", "session_id": "s", "group_id": "g"})
        );
    }

    #[test]
    fn clear_project_maps_to_its_explicit_action() {
        let (command, args) =
            wire_of(&["berdctl", "session", "clear-project", "--session-id", "s"]);
        assert_eq!(command, "sessions");
        assert_eq!(
            Value::Object(args),
            serde_json::json!({"action": "clear_project", "session_id": "s"})
        );
    }

    /// The --timeout-ms help promises 1000-900000; out-of-range values must
    /// be usage errors here, not silent broker-side clamps.
    #[test]
    fn timeout_ms_is_range_checked_client_side() {
        for out_of_range in ["999", "900001", "0"] {
            assert!(
                try_parse(&["berdctl", "session", "list", "--timeout-ms", out_of_range]).is_err(),
                "--timeout-ms {out_of_range} must be rejected"
            );
        }
        let matches = try_parse(&["berdctl", "session", "list", "--timeout-ms", "1000"])
            .expect("in-range timeout parses");
        assert_eq!(wire::globals(&matches).timeout_ms, Some(1000));
    }

    /// Range parsers must survive the tree builder: the bounds in
    /// api-surface.json become clap value_parser ranges on the built args.
    #[test]
    fn numeric_bounds_are_enforced_client_side() {
        for out_of_range in ["0", "101"] {
            assert!(
                try_parse(&["berdctl", "session", "list", "--limit", out_of_range]).is_err(),
                "--limit {out_of_range} must be rejected"
            );
        }
        assert!(
            try_parse(&[
                "berdctl",
                "session",
                "get",
                "--session-id",
                "s",
                "--messages",
                "51"
            ])
            .is_err(),
            "--messages 51 must be rejected"
        );
    }

    #[test]
    fn enum_values_are_enforced_client_side() {
        assert!(
            try_parse(&[
                "berdctl",
                "session",
                "send",
                "--session-id",
                "s",
                "--prompt",
                "hi",
                "--if-running",
                "later",
            ])
            .is_err(),
            "--if-running later must be rejected"
        );
        assert!(
            try_parse(&[
                "berdctl",
                "session",
                "send",
                "--session-id",
                "s",
                "--prompt",
                "hi",
                "--if-running",
                "steer",
            ])
            .is_ok(),
            "--if-running steer must parse"
        );
    }

    fn rendered_long_help(path: &[&str]) -> String {
        let mut cmd = cli();
        cmd.build();
        let mut target = &mut cmd;
        let mut bin_name = String::from("berdctl");
        for name in path {
            target = target
                .find_subcommand_mut(name)
                .unwrap_or_else(|| panic!("subcommand `{name}` exists"));
            bin_name.push(' ');
            bin_name.push_str(name);
        }
        // Replicate what parsing does so the usage line shows the full
        // `berdctl …` invocation path instead of the bare leaf name.
        target.set_bin_name(bin_name);
        target.render_long_help().to_string()
    }

    /// Byte pins of the rendered help (tree.rs composed with the contract's
    /// authored prose). Refresh via `dump_rendered_help_for_pin_update`
    /// after an intentional help change.
    const EXPECTED_SESSION_CREATE_HELP: &str = r#"Create a new chat session on any installed agent harness and send the prompt in
it. Fire-and-forget: returns the session id immediately and the session runs in
the background without changing what the user sees; the user can open it
themselves. Use --from to give the delegating session or tool a concise visible
label on the initial message. Only check on it later (action "get") if the user
asks.

Usage: berdctl session create [OPTIONS] --prompt <PROMPT>

Options:
      --prompt <PROMPT>
          The message to send in the new session (1-50000 chars).

      --harness-id <HARNESS_ID>
          Agent harness to run the session on (from `berdctl info harnesses`,
          e.g. "goose", "claude-acp", "codex-acp"). Defaults to the app default.

      --model-id <MODEL_ID>
          Id of the model to use (from `berdctl info models`).

      --agent-id <AGENT_ID>
          Id of the agent (persona) to use (from `berdctl agent list`).

      --project-id <PROJECT_ID>
          Id of the project to create the session in.

      --startup-name <STARTUP_NAME>
          Branch/worktree name when the project's startup mode is branch or
          worktree; required for those modes.

      --from <FROM>
          Optional visible sender label for the initial message (1-120 chars).

      --json
          Print the raw JSON result on a single line (default: pretty-printed
          JSON)

      --timeout-ms <MS>
          Give the app this long (in ms, 1000-900000) to run the command before
          it reports timed out; defaults to the app's per-command timeout

  -h, --help
          Print help (see a summary with '-h')

Examples:
  berdctl session create --prompt "Triage the failing nightly build" \
    --harness-id claude-acp --from "the release orchestrator" --json
  berdctl session create --prompt "Implement the fix" \
    --project-id <project-id> --startup-name my-feature

Result:
  {"session_id": "...", "title": "...", "harness_id": "...",
   "send_status": "dispatched"}
  The session runs in the background; the user's view does not change. Check
  progress later with `berdctl session get --session-id <session_id>`.
"#;

    const EXPECTED_SESSION_MOVE_HELP: &str = r#"Move a chat session into a project; the session list in the app regroups
immediately.

Usage: berdctl session move [OPTIONS] --session-id <SESSION_ID> --project-id <PROJECT_ID>

Options:
      --session-id <SESSION_ID>
          Id of the session to move.

      --project-id <PROJECT_ID>
          Id of the destination project.

      --json
          Print the raw JSON result on a single line (default: pretty-printed
          JSON)

      --timeout-ms <MS>
          Give the app this long (in ms, 1000-900000) to run the command before
          it reports timed out; defaults to the app's per-command timeout

  -h, --help
          Print help (see a summary with '-h')

Example:
  berdctl session move --session-id <session-id> --project-id <project-id>

Result:
  {"ok": true} — the app's session list regroups immediately.
"#;

    const EXPECTED_SESSION_CLEAR_PROJECT_HELP: &str = r#"Move a chat session out of any project; the session list in the app regroups
immediately.

Usage: berdctl session clear-project [OPTIONS] --session-id <SESSION_ID>

Options:
      --session-id <SESSION_ID>
          Id of the session to move out of its project.

      --json
          Print the raw JSON result on a single line (default: pretty-printed
          JSON)

      --timeout-ms <MS>
          Give the app this long (in ms, 1000-900000) to run the command before
          it reports timed out; defaults to the app's per-command timeout

  -h, --help
          Print help (see a summary with '-h')

Example:
  berdctl session clear-project --session-id <session-id>

Result:
  {"ok": true} — the app's session list regroups immediately.
"#;

    /// Maintenance helper, not a gate: after an intentional help change, run
    /// `cargo test -p berdctl dump_rendered_help -- --ignored`, review the
    /// /tmp/help-*.txt output, and paste it into the EXPECTED_*_HELP pins.
    #[test]
    #[ignore = "writes /tmp/help-*.txt for updating the EXPECTED_*_HELP pins"]
    fn dump_rendered_help_for_pin_update() {
        std::fs::write("/tmp/help-top.txt", rendered_long_help(&[])).unwrap();
        std::fs::write(
            "/tmp/help-create.txt",
            rendered_long_help(&["session", "create"]),
        )
        .unwrap();
        std::fs::write(
            "/tmp/help-move.txt",
            rendered_long_help(&["session", "move"]),
        )
        .unwrap();
        std::fs::write(
            "/tmp/help-clear-project.txt",
            rendered_long_help(&["session", "clear-project"]),
        )
        .unwrap();
    }

    #[test]
    fn top_level_long_help_matches_expected() {
        let rendered = rendered_long_help(&[]);
        assert_eq!(
            rendered.contains("feedback"),
            cfg!(feature = "block-feedback")
        );
        for command in ["session", "folder", "project", "agent", "skill", "info"] {
            assert!(
                rendered
                    .lines()
                    .any(|line| line.trim_start().starts_with(command)),
                "top-level help is missing `{command}`"
            );
        }
    }

    #[test]
    fn session_create_long_help_matches_expected() {
        assert_eq!(
            rendered_long_help(&["session", "create"]),
            EXPECTED_SESSION_CREATE_HELP
        );
    }

    #[test]
    fn session_move_long_help_matches_expected() {
        assert_eq!(
            rendered_long_help(&["session", "move"]),
            EXPECTED_SESSION_MOVE_HELP
        );
    }

    #[test]
    fn session_clear_project_long_help_matches_expected() {
        assert_eq!(
            rendered_long_help(&["session", "clear-project"]),
            EXPECTED_SESSION_CLEAR_PROJECT_HELP
        );
    }
}
