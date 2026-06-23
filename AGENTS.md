# AGENTS.md

Guidelines for agents working on Goose.

Goose is a standalone Tauri 2 + React 19 desktop. ACP is the main interface
we use for the actual agent loop - creating and running sessions, finding available
models, and setting configuration. When available, we work over ACP methods, but the
UI can handle operations that are not yet in ACP or are client specific.

## Layout

- `src/` — React UI/features/shared code
- `src-tauri/` — Tauri shell that starts or resolves `goose serve`
- `sdk/` — vendored `@aaif/goose-sdk` package and generated ACP types
- `distro/` — bundled app defaults and packaged distribution assets
- `goose-backend.lock.json` — pinned upstream Goose backend used by dev and bundles
- `scripts/ensure-local-goose.sh` — managed local Goose checkout for dev
- `scripts/prepare-goose-sidecar.sh` — stages the pinned or explicit Goose binary for Tauri bundling
- `scripts/update-goose-backend-lock.sh` — resolves and records a new Goose backend pin
- `src/features/goosectl/` — goosectl command registry
- `src-tauri/plugins/goosectl/` — goosectl broker
- `src-tauri/crates/goosectl/` — bundled goosectl CLI
- `distro/skills/goosectl/` — seeded skill agents use to discover goosectl

## Startup assets

Startup artifact media is resolved by the Tauri backend and returned as local
cache paths. Renderer code should use `getArtifacts()` or
`selectProjectPreviewArtifacts()` from `src/shared/api/artifacts.ts`, then pass
paths through `convertFileSrc(..., "asset")` before rendering media. Do not
vendor startup media, fetch catalogs in the renderer, or construct Artifactory
URLs in UI code.

## Experimental features

Experiments are opt-in, user-local switches for in-progress UI or workflow
behavior. Use `.agents/skills/experimental-features/SKILL.md` before adding,
reviewing, graduating, or removing an experiment.

Do not create one-off localStorage keys, distro flags, Tauri commands, or
capabilities for per-user experiments unless the skill says the use case
requires it.

## Common commands

- `just setup` — install pnpm deps, build SDK, build managed local Goose
- `just dev` — run the Tauri app in dev mode
- `just fmt` — format frontend and Tauri/Rust files
- `just fmt-check` — check frontend and Tauri/Rust formatting
- `just lint` — Biome lint checks
- `just typecheck` — TypeScript type checks
- `just check` — frontend formatting/lint/i18n/type checks
- `just test` — Vitest suite
- `just tauri-check` — Rust check with external sidecars disabled
- `just clippy` — Rust clippy with warnings denied
- `just ci` — local validation gate: frontend checks, Tauri/Rust checks, clippy, tests, build
- `just bundle` — stage the pinned Goose backend and run `pnpm tauri build`

## When to validate

- Frontend changes: `just check`
- Vitest-covered behavior: `just test`
- `src-tauri/`, Tauri config, sidecars, or Rust: `just tauri-check`
- goosectl commands: `pnpm generate:goosectl-contract`, `pnpm vitest run
  src/features/goosectl`, and `cargo test -p goosectl` (from `src-tauri/`)
- Broad/release/packaging changes: `just ci`

## goosectl

goosectl lets agents control the app: CLI → broker → renderer registry.
Design and reasoning: `docs/goosectl-architecture.md`. To add or change a
command, use `.agents/skills/goosectl-new-command/SKILL.md`
(`just new-command <noun> <verb>`).

Invariants (1, 3, 4 are gated by test failures; 2, 5, 6 are review rules —
the doc has the whys and the enforcement map):

1. No command-specific knowledge below the renderer registry — the broker
   stays transport-only (single reviewed exception: the create-cap's
   `action == "create"` peek).
2. Single dispatch point in the renderer.
3. Bounds live in zod; clap only mirrors them.
4. Help is hand-authored in the command module (summary, description,
   helpFooter, `.describe()` per field); `cargo test -p goosectl` fails on
   empty/TODO prose.
5. UI-visible verbs only; prefer reversible mutations, but one-way visible
   product actions like creating a session or sending a prompt are allowed.
   Delete, bulk, silent, or invisible work reopens the auth decision as a
   design review, not a PR.
6. Reviewers identify breaking wire reshapes and bump `protocolVersion` in
   both discovery.rs copies and the contract.ts mirror; tests pin only that
   the constants are equal.

The CLI is built from the contract at startup: command modules (zod schemas
+ help prose) → `pnpm generate:goosectl-contract` → `api-surface.json` (the
client-neutral wire surface, with JSON Schema per action) +
`cli-surface.json` (the CLI projection) → embedded by the goosectl crate,
whose `tree.rs` builds the clap tree at runtime (`validate.rs` gates
consistency via the crate's tests). Never hand-edit the contract JSONs.

## Linear

For repo work, default Linear issues to project `Goose [Internal]`
(`babe53a5-3fba-4ae3-97e5-3bc49f20ab51`) on team `BOT`.
Write issue descriptions around the user need/story; avoid prescribing the implementation unless asked.

## Sidecar rule

Release builds should use the Goose backend pinned in `goose-backend.lock.json`:

```bash
just setup
just bundle
```

The Tauri config uses `"externalBin": ["binaries/goosed"]`; the staging script
copies to `src-tauri/binaries/goosed-$(rustc -vV | sed -n 's|host: ||p')`, which
is the filename Tauri expects. Use `GOOSE_BIN=/path/to/goose` only as an explicit
local override.

## Conventions

- Use `@/` imports for frontend code.
- Use `cn()` from `@/shared/lib/cn` for Tailwind class merging.
- All `<button>` elements need `type="button"` unless intentionally submitting.
- Do not hand-edit generated SDK files unless this repo intentionally freezes a
  generated snapshot; prefer updating `sdk/schema/*` and regenerating.
- Do not push without explicit approval.
