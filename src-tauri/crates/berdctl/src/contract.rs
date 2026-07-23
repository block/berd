//! The embedded contract artifacts, parsed once at startup:
//!
//! - `api-surface.json` — the client-neutral wire surface of the app's
//!   control API (groups → actions → description + fields + JSON Schema,
//!   plus the wire `protocolVersion`). Any client of `POST /v1/call` can
//!   consume it; this CLI consumes the flat field model.
//! - `cli-surface.json` — the CLI projection: the noun/verb tree mapping
//!   onto groups/actions and the CLI-only prose (noun abouts, verb
//!   summaries, after-help footers).
//!
//! Both are generated from the renderer's command modules
//! (`pnpm generate:berdctl-contract`); zod schemas and the command-module
//! prose stay the single authored source. Cross-artifact consistency is
//! checked by [`crate::validate::contract_errors`] and enforced by this
//! crate's tests — the artifacts are embedded at compile time, so a binary
//! whose tests pass cannot disagree with them at runtime.

use indexmap::IndexMap;
use serde::Deserialize;

/// `api-surface.json`: the client-neutral wire surface.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Api {
    /// Wire protocol version of the broker envelope; pinned equal to
    /// `discovery::PROTOCOL_VERSION` by validation. Bump all copies together.
    pub protocol_version: u32,
    pub groups: IndexMap<String, Group>,
}

#[derive(Debug, Deserialize)]
pub struct Group {
    pub description: String,
    /// Action → spec; entry order is the authored order (help output must
    /// stay byte-stable under regeneration, hence IndexMap).
    pub actions: IndexMap<String, Action>,
}

#[derive(Debug, Deserialize)]
pub struct Action {
    /// The command's honest side-effect statement; rendered as the `--help`
    /// body.
    pub description: String,
    /// Flat wire field model (the artifact also carries a JSON Schema per
    /// action for standard tooling; this CLI does not consume it).
    pub fields: Vec<Field>,
}

#[derive(Debug, Deserialize)]
pub struct Field {
    /// snake_case wire name; the flag is its kebab-case spelling.
    pub name: String,
    pub required: bool,
    /// "string" | "number" | "boolean"; anything else fails validation
    /// until the generated CLI learns that shape.
    pub kind: String,
    /// Allowed values for enum-backed string fields.
    pub values: Option<Vec<String>>,
    /// Field documentation (the zod `.describe()`); rendered as the flag's
    /// --help text.
    pub description: String,
    /// The wire accepts an explicit null. A plain flag cannot express null,
    /// so nullable fields are rejected by contract validation.
    #[serde(default)]
    pub nullable: bool,
    /// Kept as raw JSON numbers so validation (not deserialization) can
    /// reject bounds a clap u32 range cannot carry.
    pub min: Option<serde_json::Number>,
    pub max: Option<serde_json::Number>,
}

/// `cli-surface.json`: the CLI projection.
#[derive(Debug, Deserialize)]
pub struct Surface {
    /// Noun → spec; entry order is the CLI's noun order.
    pub nouns: IndexMap<String, Noun>,
}

#[derive(Debug, Deserialize)]
pub struct Noun {
    /// The wire command (registry group), e.g. noun `session` → `sessions`.
    pub group: String,
    /// One-line entry in `berdctl --help`'s command list.
    pub about: String,
    /// Verb → spec; entry order is the noun's verb order.
    pub verbs: IndexMap<String, Verb>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Verb {
    /// The wire action this CLI verb maps onto.
    pub action: String,
    /// One-line entry in `berdctl <noun> --help`'s verb list.
    pub about: String,
    /// Example + result shape rendered after the options.
    pub after_help: String,
}

pub struct Contract {
    pub api: Api,
    pub surface: Surface,
}

const API_SURFACE: &str = include_str!("../api-surface.json");
const CLI_SURFACE: &str = include_str!("../cli-surface.json");

impl Contract {
    /// The artifacts are embedded at compile time, so a parse failure is a
    /// programmer error caught by `cargo test -p berdctl`, never a runtime
    /// condition worth handling.
    pub fn load() -> Self {
        Self::parse(API_SURFACE, CLI_SURFACE)
            .expect("the embedded contract artifacts parse (gated by this crate's tests)")
    }

    pub fn parse(api: &str, surface: &str) -> Result<Self, String> {
        Ok(Self {
            api: serde_json::from_str(api).map_err(|err| format!("api-surface.json: {err}"))?,
            surface: serde_json::from_str(surface)
                .map_err(|err| format!("cli-surface.json: {err}"))?,
        })
    }

    pub fn action(&self, group: &str, action: &str) -> Option<&Action> {
        self.api.groups.get(group)?.actions.get(action)
    }

    pub fn field_specs(&self, group: &str, action: &str) -> Option<&[Field]> {
        Some(self.action(group, action)?.fields.as_slice())
    }
}
