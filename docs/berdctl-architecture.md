# berdctl architecture

berdctl is the app-bundled CLI agents use to control the Berd desktop app:

```sh
berdctl session list --json
berdctl project create --name demo
```

The implementation has three layers:

1. CLI: `src-tauri/crates/berdctl/`
   Parses flags with clap, prints help, reads the private app discovery file,
   authenticates each loopback request with its per-broker capability, and
   sends JSON calls. CLI validation is convenience only.
2. Broker: `src-tauri/plugins/berdctl/`
   Runs a localhost server inside the app, requires the current discovery-file
   capability, rejects browser-origin requests, enforces in-flight and timeout
   limits, and forwards calls to the renderer without command-specific logic.
3. Renderer registry: `src/features/berdctl/commands/`
   Strict-parses args with zod, runs guards, executes through app state, and
   returns JSON results. This remains the command-policy trust boundary; the
   broker capability limits access to processes that can read the owning
   user's private discovery file.

## Layer rules

- Broker stays transport-only: host/origin checks, discovery/version handshake,
  in-flight cap, timeouts, request correlation. No command nouns, verbs, action
  names, or command-specific policy.
- Registry owns policy: zod strict parse, bounds, command safety metadata,
  running-session guards, and app mutations.
- CLI owns agent UX: stable flag names, local parse errors, exit codes, and
  hand-authored help. Agents should be able to rely on `--help`.

## Command source of truth

Each command module owns:

- zod schema with `.strict()` and `.describe()` on every field
- inferred TypeScript input type
- guardrail bounds
- `summary`, `description`, and `helpFooter`
- safety metadata: `effect`, `visibility`, `destructive`
- `precheck` and `execute`

Descriptors must be import-pure. Static imports should stay limited to zod,
berdctl command types, and pure helpers. Stores, Tauri APIs, providers,
navigation, and caches load dynamically from `execute` or `precheck` via domain
runtime modules.

## Contract generation

`pnpm generate:berdctl-contract` reads command descriptors and writes embedded
artifacts for the Rust CLI:

- `api-surface.json`: client-neutral protocol version, groups/actions, field
  model, bounds, descriptions, and JSON Schema for args.
- `cli-surface.json`: noun/verb tree, CLI summaries, noun prose, and help
  footers.

The berdctl crate embeds these files with `include_str!` and builds its clap
tree at startup from them. `wire.rs` walks the same specs to map flags back to
wire args. `validate.rs` and crate tests catch stale artifacts, missing prose,
unbuildable flag shapes, and contract/CLI mismatches.

## CLI shape

The CLI is generated from the wire field model and intentionally stays simple:
lower_snake_case fields become `--kebab-case` flags, required wire fields become
required flags, optional fields may be omitted, and numeric bounds come from
zod. Shapes the generic CLI cannot express safely, such as explicit null, should
be modeled as explicit actions instead of Rust-side command exceptions. Example:
`session move --project-id <id>` moves into a project, while
`session clear-project` moves out of any project.

## Help

Help is product surface. Author it in the command module, not in generated
prose:

- `registry.ts` group `cli.about` for noun lines
- command `summary`, `description`, `helpFooter`
- `.describe()` on every field
- top-level help and exit-code text in `tree.rs`

Tests fail on empty/TODO prose and stale rendered-help pins. Error remediation
belongs in error messages, not generic help text.

## Safety model

v1 requires a fresh 256-bit bearer capability for every broker start. The
plugin writes it beside the port and generation in the discovery file, with
owner-only directory/file permissions on Unix, and the CLI presents it on
both `/v1/ping` and `/v1/call`. Missing, malformed, wrong, stale, symlinked,
or non-private capability records fail closed. This authenticates possession
of the app-issued session endpoint; it does not replace renderer command
policy or add interactive confirmation dialogs.

Required command properties:

- destructive work requires an explicit caller opt-in and must remain visible in the app
- no invisible non-read mutations
- mutations are visible immediately or discoverable in normal app UI
- one-way verbs are limited to visible product actions the caller explicitly
  asked for, such as creating a session or sending a prompt
- broker protects app availability with in-flight caps and timeouts

Delete, bulk, silent, invisible, or broadly destructive verbs require
reopening the auth/confirmation design before implementation. A visible command
may expose narrowly scoped destructive behavior only through an explicit flag
that names the loss and defaults to refusal; do not add interactive prompts or
piecemeal auth in a command PR.

## Versioning

The broker writes a private discovery file with `protocolVersion`, generation,
port, and a per-start capability. The CLI authenticates and verifies it via
`/v1/ping` before calls. Requiring that capability is a breaking wire reshape,
so the authenticated surface starts at protocol version 5.

Breaking wire reshapes must bump all three constants:

- `src-tauri/plugins/berdctl/src/discovery.rs`
- `src-tauri/crates/berdctl/src/discovery.rs`
- `src/features/berdctl/commands/contract.ts`

Tests only ensure the three constants are equal. They do not detect breaking
surface changes automatically; reviewers must identify reshapes and require the
bump. Adding a command or optional field is not a wire reshape.

## Enforcement

| Property | Enforced by |
|---|---|
| Contract artifacts fresh | `pnpm generate:berdctl-contract --check`, `just check` |
| Descriptor import purity | `contractImport.test.ts` under node |
| Every action strict-parses and has fixtures | `commands.test.ts` |
| Bounds live in schemas | `bounds.test.ts` plus generated contract diff |
| Help fields complete | generator + `validate.rs` |
| clap tree matches CLI surface | berdctl crate tests |
| wire mapping matches CLI surface | berdctl crate tests |
| protocol constants equal | berdctl crate + plugin crate tests |
| rendered help reviewed | inline `EXPECTED_*_HELP` pins |
| broker command-agnostic | `broker_source_stays_free_of_command_literals` |
| safety metadata complete | berdctl command tests |

Review-only rules: single renderer dispatch point, detecting breaking wire
reshapes, and product judgment for command eligibility under capability authentication.
