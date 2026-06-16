# goosectl architecture

goosectl is the app-bundled CLI agents use to control the Goose desktop app:

```sh
goosectl session list --json
goosectl project create --name demo
```

The implementation has three layers:

1. CLI: `src-tauri/crates/goosectl/`
   Parses flags with clap, prints help, reads the app discovery file, and sends
   JSON calls. CLI validation is convenience only.
2. Broker: `src-tauri/plugins/goosectl/`
   Runs a localhost server inside the app, rejects browser-origin requests,
   enforces in-flight and timeout limits, and forwards calls to the renderer
   without command-specific logic.
3. Renderer registry: `src/features/goosectl/commands/`
   Strict-parses args with zod, runs guards, executes through app state, and
   returns JSON results. This is the trust boundary because any same-user
   process can bypass the CLI and POST to the broker directly.

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
goosectl command types, and pure helpers. Stores, Tauri APIs, providers,
navigation, and caches load dynamically from `execute` or `precheck` via domain
runtime modules.

## Contract generation

`pnpm generate:goosectl-contract` reads command descriptors and writes embedded
artifacts for the Rust CLI:

- `api-surface.json`: client-neutral protocol version, groups/actions, field
  model, bounds, descriptions, and JSON Schema for args.
- `cli-surface.json`: noun/verb tree, CLI summaries, noun prose, and help
  footers.

The goosectl crate embeds these files with `include_str!` and builds its clap
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

v1 has no auth tokens and no confirmation dialogs. That remains acceptable only
while commands are reversible and visible in the UI.

Required command properties:

- no destructive commands
- no invisible non-read mutations
- mutations are visible immediately or discoverable in normal app UI
- broker protects app availability with in-flight caps and timeouts

The first delete, bulk, silent, or otherwise irreversible/invisible verb requires
reopening the auth/confirmation design before implementation. Do not add
piecemeal auth in a command PR.

## Versioning

The broker writes a discovery file with `protocolVersion`, generation, and port.
The CLI verifies it via `/v1/ping` before calls.

Breaking wire reshapes must bump all three constants:

- `src-tauri/plugins/goosectl/src/discovery.rs`
- `src-tauri/crates/goosectl/src/discovery.rs`
- `src/features/goosectl/commands/contract.ts`

Tests only ensure the three constants are equal. They do not detect breaking
surface changes automatically; reviewers must identify reshapes and require the
bump. Adding a command or optional field is not a wire reshape.

## Enforcement

| Property | Enforced by |
|---|---|
| Contract artifacts fresh | `pnpm generate:goosectl-contract --check`, `just check` |
| Descriptor import purity | `contractImport.test.ts` under node |
| Every action strict-parses and has fixtures | `commands.test.ts` |
| Bounds live in schemas | `bounds.test.ts` plus generated contract diff |
| Help fields complete | generator + `validate.rs` |
| clap tree matches CLI surface | goosectl crate tests |
| wire mapping matches CLI surface | goosectl crate tests |
| protocol constants equal | goosectl crate + plugin crate tests |
| rendered help reviewed | inline `EXPECTED_*_HELP` pins |
| broker command-agnostic | `broker_source_stays_free_of_command_literals` |
| safety metadata complete | goosectl command tests |

Review-only rules: single renderer dispatch point, detecting breaking wire
reshapes, and product judgment for no-auth command eligibility.
