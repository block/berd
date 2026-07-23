//! Maps parsed ArgMatches onto the wire contract pinned by cli-surface.json
//! — `("<group>", {"action": "<verb>", ...flags})` — and extracts the global
//! flags. Field traversal is driven by the same api-surface.json specs
//! `tree::build_cli` built the args from, so the two sides cannot disagree
//! about a flag's name or type.

use std::path::PathBuf;

use clap::ArgMatches;
use serde_json::{Map, Value};

use crate::contract::Contract;

/// The top-level flags, valid at any position (clap globals).
pub struct Globals {
    pub lock_path: Option<PathBuf>,
    pub json: bool,
    pub timeout_ms: Option<u64>,
}

pub fn globals(matches: &ArgMatches) -> Globals {
    Globals {
        lock_path: matches.get_one::<PathBuf>("lock_path").cloned(),
        json: matches.get_flag("json"),
        timeout_ms: matches.get_one::<u64>("timeout_ms").copied(),
    }
}

pub enum Invocation {
    Call {
        /// The wire command (registry group), e.g. "sessions".
        group: String,
        /// `{"action": "<verb>", ...flags}`.
        body: Map<String, Value>,
    },
}

pub fn invocation(contract: &Contract, matches: &ArgMatches) -> Invocation {
    let (noun, noun_matches) = matches
        .subcommand()
        .expect("clap enforces subcommand_required");
    let spec = contract
        .surface
        .nouns
        .get(noun)
        .unwrap_or_else(|| panic!("clap only parses contract nouns, got `{noun}`"));
    let (verb, verb_matches) = noun_matches
        .subcommand()
        .expect("clap enforces subcommand_required");
    let action = &spec
        .verbs
        .get(verb)
        .unwrap_or_else(|| panic!("clap only parses contract verbs, got `{noun} {verb}`"))
        .action;

    let body = built_body(contract, &spec.group, action, verb_matches);
    Invocation::Call {
        group: spec.group.clone(),
        body,
    }
}

fn action_body(verb: &str) -> Map<String, Value> {
    let mut map = Map::new();
    map.insert("action".into(), Value::String(verb.into()));
    map
}

/// Generic flag → wire-field mapping: absent optionals are omitted entirely
/// (the registry's strict schemas reject null), and numbers stay numbers.
fn built_body(
    contract: &Contract,
    group: &str,
    action: &str,
    matches: &ArgMatches,
) -> Map<String, Value> {
    let mut map = action_body(action);
    let specs = contract
        .field_specs(group, action)
        .unwrap_or_else(|| panic!("validated: api-surface has `{group}.{action}`"));
    for field in specs {
        let value = match field.kind.as_str() {
            "string" => matches
                .get_one::<String>(&field.name)
                .map(|value| Value::String(value.clone())),
            "number" => matches
                .get_one::<u32>(&field.name)
                .map(|value| Value::from(*value)),
            "boolean" => matches
                .get_one::<bool>(&field.name)
                .copied()
                .filter(|value| *value)
                .map(Value::Bool),
            other => unreachable!("validation rejects wire kind `{other}`"),
        };
        if let Some(value) = value {
            map.insert(field.name.clone(), value);
        }
    }
    map
}
