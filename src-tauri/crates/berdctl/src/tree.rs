//! Builds the berdctl clap Command tree at startup from the embedded
//! contract: nouns/verbs and CLI prose from cli-surface.json, action
//! descriptions and flags from api-surface.json. What stays authored here:
//! the top-level identity and agent guide, and the global args.
//!
//! `wire.rs` walks the same contract to map ArgMatches back onto the wire,
//! so the two sides cannot disagree about a flag's name or type.

use clap::{builder::PossibleValue, builder::PossibleValuesParser, Arg, ArgAction, Command};

use crate::contract::{Contract, Field, Noun, Verb};

/// Fixed help width: authored prose carries no manual line breaks (it comes
/// from single-line TS strings), so clap wraps it — at a pinned width, never
/// the terminal's, keeping `--help` byte-stable everywhere (including the
/// EXPECTED_*_HELP test pins).
const HELP_WIDTH: usize = 80;

const TOP_LEVEL_LONG_ABOUT: &str = "\
Control the Berd desktop app from the command line.

berdctl talks to the running Berd desktop app and acts on what the user
sees there:

  session   chat sessions        create, open, list, get, rename, move,
                                  move-to-group, send, clear-project,
                                  fork, archive
  project   projects             create, list, get, attach-folder,
                                  detach-folder, set-startup-mode, archive
  agent     agents (personas)    create, list
  skill     skills (SKILL.md)    create, list, get
  info      read-only lookups    harnesses, models, context

Results are JSON on stdout (pretty-printed; pass --json for raw single-line
JSON). Errors are `code: message` lines on stderr; transport errors tell you
which app-control condition to check.";

const TOP_LEVEL_EXAMPLES: &str = "\
Examples:
  # Find a chat session by title, then read its latest messages
  berdctl session list --query \"standup\" --json
  berdctl session get --session-id <session-id> --messages 5 --json

  # Start a background session on a specific agent harness
  berdctl info harnesses --json
  berdctl session create --prompt \"Summarize open code reviews\" \\
    --harness-id claude-acp

  # Send a follow-up into an existing session without opening it
  berdctl session send --session-id <session-id> \\
    --prompt \"Check the latest CI failure\" --if-running queue

Exit codes:
  0  success — the JSON result is on stdout
  1  the app refused the command — stderr carries `code: message`
  2  transport failure between berdctl and the app — confirm Berd is running,
     app control is enabled, and this is a Berd-started agent session
  3  not running inside a Berd desktop app session, the app is not running,
     or this berdctl no longer matches the app — stderr explains which";

pub fn build_cli(contract: &Contract) -> Command {
    debug_assert!(
        crate::validate::contract_errors(contract).is_empty(),
        "the embedded contract is inconsistent; run `cargo test -p berdctl` \
         for the full error list"
    );

    let mut cmd = Command::new("berdctl")
        .bin_name("berdctl")
        .term_width(HELP_WIDTH)
        .about("Control the Berd desktop app (sessions, projects, agents, skills) from the command line")
        .long_about(TOP_LEVEL_LONG_ABOUT)
        .after_long_help(TOP_LEVEL_EXAMPLES)
        .subcommand_required(true)
        .arg_required_else_help(true)
        .disable_version_flag(true)
        .arg(
            Arg::new("lock_path")
                .long("lock-path")
                .global(true)
                .env("BERDCTL_LOCK")
                .hide(true)
                .value_parser(clap::value_parser!(std::path::PathBuf))
                .help(
                    "Path to the app's control discovery file (internal plumbing; \
                     the app sets BERDCTL_LOCK in every agent session it spawns)",
                ),
        )
        // display_order pushes the propagated globals below each
        // subcommand's own flags in help output.
        .arg(
            Arg::new("json")
                .long("json")
                .global(true)
                .action(ArgAction::SetTrue)
                .display_order(900)
                .help("Print the raw JSON result on a single line (default: pretty-printed JSON)"),
        )
        .arg(
            Arg::new("timeout_ms")
                .long("timeout-ms")
                .global(true)
                .value_name("MS")
                .value_parser(clap::value_parser!(u64).range(1000..=900_000))
                .display_order(901)
                .help(
                    "Give the app this long (in ms, 1000-900000) to run the command \
                     before it reports timed out; defaults to the app's per-command timeout",
                ),
        );

    for (noun, spec) in &contract.surface.nouns {
        cmd = cmd.subcommand(noun_command(contract, noun, spec));
    }

    cmd
}

fn noun_command(contract: &Contract, noun: &str, spec: &Noun) -> Command {
    let mut cmd = Command::new(noun.to_string())
        .about(spec.about.clone())
        .subcommand_required(true);
    // Hidden plural aliases forgive `berdctl sessions list` etc. without
    // widening the documented surface: help and cli-surface.json stay
    // singular, and the plural registry group name is exactly the alias.
    if spec.group != *noun {
        cmd = cmd.alias(spec.group.clone());
    }
    for (verb, verb_spec) in &spec.verbs {
        cmd = cmd.subcommand(verb_command(contract, &spec.group, verb, verb_spec));
    }
    cmd
}

fn verb_command(contract: &Contract, group: &str, verb: &str, spec: &Verb) -> Command {
    let action = contract
        .action(group, &spec.action)
        .unwrap_or_else(|| panic!("validated: api-surface has `{group}.{}`", spec.action));
    let cmd = Command::new(verb.to_string())
        .about(spec.about.clone())
        .long_about(action.description.clone())
        .after_long_help(spec.after_help.clone());

    let mut cmd = cmd;
    for field in &action.fields {
        cmd = cmd.arg(built_arg(field));
    }
    cmd
}

fn built_arg(field: &Field) -> Arg {
    let mut arg = Arg::new(field.name.clone())
        .long(field.name.replace('_', "-"))
        // clap's default value name would be the lowercase id; help renders
        // placeholders SCREAMING_SNAKE (`--session-id <SESSION_ID>`).
        .value_name(field.name.to_uppercase())
        .required(field.required)
        .help(field.description.clone());
    if field.kind == "boolean" {
        arg = arg.action(ArgAction::SetTrue).value_name(None::<&str>);
    } else if field.kind == "string_array" {
        arg = arg.action(ArgAction::Append);
    } else if field.kind == "number" {
        // Bounds come from the zod schema via api-surface.json; clap only
        // mirrors them for fast local errors.
        let mut parser = clap::value_parser!(u32);
        if field.min.is_some() || field.max.is_some() {
            let min = bound(&field.min).unwrap_or(0);
            parser = match bound(&field.max) {
                Some(max) => parser.range(min..=max),
                None => parser.range(min..),
            };
        }
        arg = arg.value_parser(parser);
    } else if let Some(values) = &field.values {
        arg = arg.value_parser(PossibleValuesParser::new(
            values.iter().cloned().map(PossibleValue::new),
        ));
    }
    arg
}

fn bound(value: &Option<serde_json::Number>) -> Option<i64> {
    value.as_ref().map(|number| {
        number
            .as_i64()
            .expect("validated: bounds are non-negative integers")
    })
}
