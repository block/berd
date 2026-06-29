//! Cross-artifact contract validation: every inconsistency between
//! api-surface.json and cli-surface.json — and every TODO left in authored
//! help prose — becomes an actionable error here.
//!
//! Enforced by `contract_validates_cleanly` in main.rs (`cargo test -p
//! berdctl`) and by a debug assertion in `tree::build_cli`. The artifacts
//! are embedded at compile time, so a binary whose tests pass cannot hit
//! these errors at runtime.

use crate::contract::{Contract, Field};

/// Every contract inconsistency, in stable order. Empty means the CLI can be
/// built faithfully from the artifacts.
pub fn contract_errors(contract: &Contract) -> Vec<String> {
    let mut errors = Vec::new();
    let nouns = &contract.surface.nouns;

    // api-surface.json's protocolVersion mirrors PROTOCOL_VERSION in
    // discovery.rs (and the broker plugin's copy); bump all copies together.
    if contract.api.protocol_version != crate::discovery::PROTOCOL_VERSION {
        errors.push(format!(
            "api-surface.json protocolVersion {} does not match the CLI's \
             PROTOCOL_VERSION {}; bump WIRE_PROTOCOL_VERSION in contract.ts \
             and both discovery.rs copies together",
            contract.api.protocol_version,
            crate::discovery::PROTOCOL_VERSION
        ));
    }

    // The reverse direction of the api ⇄ cli join: every api action must be
    // reachable from the CLI surface (the forward direction — every verb has
    // an api action — is checked per verb below).
    for (group, group_spec) in &contract.api.groups {
        check_prose(
            &format!("the `{group}` group's `description` (registry.ts)"),
            &group_spec.description,
            &mut errors,
        );
        for action in group_spec.actions.keys() {
            let reachable = nouns.values().any(|spec| {
                &spec.group == group && spec.verbs.values().any(|verb| &verb.action == action)
            });
            if !reachable {
                errors.push(format!(
                    "api-surface.json `{group}.{action}` is not reachable from cli-surface.json"
                ));
            }
        }
    }

    for (noun, spec) in nouns {
        check_prose(
            &format!("the `{noun}` group's cli.about (registry.ts)"),
            &spec.about,
            &mut errors,
        );

        for (verb, verb_spec) in &spec.verbs {
            let action = &verb_spec.action;

            // Authored help prose, from the command module
            // (summary/description/helpFooter). "TODO" is the scaffold
            // stub's marker.
            let module = format!("`berdctl {noun} {verb}`'s command module");
            check_prose(
                &format!("{module} `summary`"),
                &verb_spec.about,
                &mut errors,
            );
            check_prose(
                &format!("{module} `helpFooter`"),
                &verb_spec.after_help,
                &mut errors,
            );

            let Some(action_spec) = contract.action(&spec.group, action) else {
                errors.push(format!(
                    "api-surface.json is missing `{}.{action}` (for `berdctl {noun} {verb}`)",
                    spec.group
                ));
                continue;
            };
            check_prose(
                &format!("{module} `description`"),
                &action_spec.description,
                &mut errors,
            );
            for field in &action_spec.fields {
                check_prose(
                    &format!("`{}.{action}.{}`'s .describe()", spec.group, field.name),
                    &field.description,
                    &mut errors,
                );
                validate_field(&spec.group, action, field, &mut errors);
            }
        }
    }

    errors
}

/// Rejects empty or TODO help prose ("TODO" is the scaffold stub's marker).
fn check_prose(what: &str, text: &str, errors: &mut Vec<String>) {
    if text.trim().is_empty() {
        errors.push(format!("{what} is empty; write the real help prose"));
    } else if text.contains("TODO") {
        errors.push(format!(
            "{what} still contains TODO; write the real help prose"
        ));
    }
}

/// Per-flag gates: the field's shape must be one the generated CLI can
/// express faithfully.
fn validate_field(group: &str, action: &str, field: &Field, errors: &mut Vec<String>) {
    let name = &field.name;
    if !is_snake_ident(name) {
        // Wire names become `--kebab-case` flags and ArgMatches ids; anything
        // but lower_snake_case breaks the CLI's uniform flag naming.
        errors.push(format!(
            "`{group}.{action}.{name}` is not lower_snake_case; rename the zod key \
             (wire field names become --kebab-case flags)"
        ));
    }
    if field.nullable {
        // A plain flag cannot express the legal explicit-null wire value.
        errors.push(format!(
            "`{group}.{action}.{name}` is nullable on the wire, which a built \
             flag cannot express; split the null case into an explicit action \
             or teach the generated CLI a typed nullable shape"
        ));
    }
    let min = field.min.as_ref().map(serde_json::Number::as_i64);
    let max = field.max.as_ref().map(serde_json::Number::as_i64);
    let non_integer = matches!(min, Some(None)) || matches!(max, Some(None));
    let negative = matches!(min, Some(Some(n)) if n < 0) || matches!(max, Some(Some(n)) if n < 0);
    if non_integer || negative {
        errors.push(format!(
            "`{group}.{action}.{name}` declares bounds a clap u32 range cannot \
             carry (non-integer or negative); adjust the zod bounds"
        ));
    }
    if let Some(values) = &field.values {
        if field.kind != "string" {
            errors.push(format!(
                "`{group}.{action}.{name}` declares enum values but has wire kind `{}`, \
                 which cannot be represented as string possible values",
                field.kind
            ));
        }
        if values.is_empty() {
            errors.push(format!(
                "`{group}.{action}.{name}` declares an empty enum values list"
            ));
        }
        let mut seen = std::collections::HashSet::new();
        for value in values {
            if value.is_empty() {
                errors.push(format!(
                    "`{group}.{action}.{name}` declares an empty enum value"
                ));
            } else if !seen.insert(value) {
                errors.push(format!(
                    "`{group}.{action}.{name}` declares duplicate enum value `{value}`"
                ));
            }
        }
    }
    if !matches!(field.kind.as_str(), "string" | "number") {
        errors.push(format!(
            "`{group}.{action}.{name}` has wire kind `{}`, which the generated \
             CLI cannot express yet",
            field.kind
        ));
    }
}

/// Lower_snake_case starting with a letter: the shape that yields uniform
/// `--kebab-case` flags.
fn is_snake_ident(name: &str) -> bool {
    let mut chars = name.chars();
    matches!(chars.next(), Some('a'..='z'))
        && chars.all(|c| matches!(c, 'a'..='z' | '0'..='9' | '_'))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contract::Contract;

    const MINIMAL_API: &str = r#"{
        "protocolVersion": 1,
        "groups": {
            "sessions": {
                "description": "Manage the user's chat sessions.",
                "actions": {
                    "list": {
                        "description": "List the user's chat sessions.",
                        "fields": [
                            {"name": "query", "required": false, "kind": "string",
                             "description": "Title substring to match"}
                        ]
                    }
                }
            }
        }
    }"#;
    const MINIMAL_SURFACE: &str = r#"{
        "nouns": {
            "session": {
                "group": "sessions",
                "about": "Manage chat sessions",
                "verbs": {
                    "list": {
                        "action": "list",
                        "about": "List sessions",
                        "afterHelp": "Example: berdctl session list"
                    }
                }
            }
        }
    }"#;

    fn errors_for(api: &str, surface: &str) -> Vec<String> {
        let contract = Contract::parse(api, surface).expect("fixture parses");
        contract_errors(&contract)
    }

    fn assert_one_error_containing(errors: &[String], needle: &str) {
        assert_eq!(
            errors.len(),
            1,
            "expected exactly one error, got: {errors:#?}"
        );
        assert!(
            errors[0].contains(needle),
            "expected error containing {needle:?}, got: {}",
            errors[0]
        );
    }

    #[test]
    fn a_consistent_contract_has_no_errors() {
        assert_eq!(
            errors_for(MINIMAL_API, MINIMAL_SURFACE),
            Vec::<String>::new()
        );
    }

    #[test]
    fn the_embedded_contract_parses() {
        // Validity of the embedded contract is asserted in main.rs's tests;
        // this pins that load() itself cannot panic.
        Contract::load();
    }

    #[test]
    fn missing_api_action_is_reported() {
        let api = MINIMAL_API.replace("\"list\":", "\"other\":");
        let errors = errors_for(&api, MINIMAL_SURFACE);
        // The renamed action also becomes unreachable from the CLI surface.
        assert!(
            errors
                .iter()
                .any(|error| error.contains("api-surface.json is missing `sessions.list`")),
            "got: {errors:#?}"
        );
    }

    #[test]
    fn unreachable_api_action_is_reported() {
        let api = MINIMAL_API.replace(
            r#""actions": {"#,
            r#""actions": {
                "purge": {"description": "Purge.", "fields": []},"#,
        );
        let errors = errors_for(&api, MINIMAL_SURFACE);
        assert_one_error_containing(&errors, "`sessions.purge` is not reachable");
    }

    #[test]
    fn todo_prose_is_reported() {
        let surface = MINIMAL_SURFACE.replace("List sessions", "TODO");
        let errors = errors_for(MINIMAL_API, &surface);
        assert_one_error_containing(&errors, "`summary` still contains TODO");
    }

    #[test]
    fn empty_prose_is_reported() {
        let surface = MINIMAL_SURFACE.replace("Manage chat sessions", "  ");
        let errors = errors_for(MINIMAL_API, &surface);
        assert_one_error_containing(&errors, "cli.about (registry.ts) is empty");
    }

    #[test]
    fn todo_field_description_is_reported() {
        let api = MINIMAL_API.replace("Title substring to match", "TODO");
        let errors = errors_for(&api, MINIMAL_SURFACE);
        assert_one_error_containing(&errors, "`sessions.list.query`'s .describe()");
    }

    #[test]
    fn nullable_fields_are_reported() {
        let api = MINIMAL_API.replace(
            r#""kind": "string","#,
            r#""kind": "string", "nullable": true,"#,
        );
        let errors = errors_for(&api, MINIMAL_SURFACE);
        assert_one_error_containing(&errors, "nullable on the wire");
    }

    #[test]
    fn unbuildable_kinds_and_bounds_are_reported() {
        let api = MINIMAL_API.replace(
            r#"{"name": "query", "required": false, "kind": "string",
                             "description": "Title substring to match"}"#,
            r#"{"name": "query", "required": false, "kind": "boolean",
                             "description": "Title substring to match", "min": -1}"#,
        );
        let errors = errors_for(&api, MINIMAL_SURFACE);
        assert!(
            errors
                .iter()
                .any(|error| error.contains("wire kind `boolean`")),
            "got: {errors:#?}"
        );
        assert!(
            errors
                .iter()
                .any(|error| error.contains("non-integer or negative")),
            "got: {errors:#?}"
        );
    }

    #[test]
    fn invalid_enum_field_shapes_are_reported() {
        let api = MINIMAL_API.replace(
            r#"{"name": "query", "required": false, "kind": "string",
                             "description": "Title substring to match"}"#,
            r#"{"name": "query", "required": false, "kind": "number",
                             "values": ["refuse", "refuse", ""],
                             "description": "Title substring to match"}"#,
        );
        let errors = errors_for(&api, MINIMAL_SURFACE);
        assert!(
            errors
                .iter()
                .any(|error| error.contains("declares enum values but has wire kind `number`")),
            "got: {errors:#?}"
        );
        assert!(
            errors
                .iter()
                .any(|error| error.contains("duplicate enum value `refuse`")),
            "got: {errors:#?}"
        );
        assert!(
            errors
                .iter()
                .any(|error| error.contains("declares an empty enum value")),
            "got: {errors:#?}"
        );
    }

    #[test]
    fn non_snake_case_wire_names_are_reported() {
        let api = MINIMAL_API.replace("\"query\"", "\"queryText\"");
        let errors = errors_for(&api, MINIMAL_SURFACE);
        assert_one_error_containing(&errors, "is not lower_snake_case");
    }

    #[test]
    fn mismatched_protocol_version_is_reported() {
        let api = MINIMAL_API.replace("\"protocolVersion\": 1", "\"protocolVersion\": 999");
        let errors = errors_for(&api, MINIMAL_SURFACE);
        assert_one_error_containing(&errors, "protocolVersion 999 does not match");
    }
}
