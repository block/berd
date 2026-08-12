# AGENTS.md / CLAUDE.md

Instructions for agents working in the `berd/bb-cli` package.

## Workflow

- Never use `--no-verify` unless the user explicitly asks for it.
- Activate the Hermit environment before running repo commands that depend on managed tooling:

```bash
source ./bin/activate-hermit
```

- Install git hooks when setting up the repo locally:

```bash
lefthook install
```

## Common Commands

- Build the Rust binary:

```bash
just build
```

- Run tests:

```bash
just test
```

- Run linting (rustfmt + clippy):

```bash
just lint
```

- Run the main verification suite:

```bash
just check
```

- Build the `sq` package artifact:

```bash
just build-sq
```

- Inspect the CLI surface directly:

```bash
./target/debug/agent-tools --help
./target/debug/agent-tools utils calculate --numbers 2 3 --operation add
```

- Smoke-test the packaged `sq` module and confirm `sq` is using the local `sqbin/` output:

```bash
just package-smoke
sq which agent-tools
sq agent-tools linear --help
./sqbin/agent-tools.exoskeleton linear --help
```

`sq which agent-tools` should point at the package-local `sqbin/agent-tools.exoskeleton`. If `sq agent-tools <extension> ...` prints synthesized submenu help instead of the exoskeleton output, compare against `./sqbin/agent-tools.exoskeleton <extension> ...` to distinguish outer `sq` wrapper behavior from `bb-cli` behavior.

## Project Layout

- `src/kgoose.rs` defines the kgoose ToolEndpoint client and re-exports the generated proto request/response types used by the CLI.
- `src/cli.rs` bootstraps global flags and builds the dynamic clap command tree. Parsing is two-phase: a hand-rolled bootstrap parser strips infrastructure flags and extracts `command_tokens` first, then only the named extension is loaded from the API before building the clap tree. This avoids loading all extensions upfront.
- `src/runtime.rs` loads extension/tool metadata from the live kgoose API and derives CLI parameters from tool schemas.
- `src/catalog.rs` manages the static extensions catalog (`extensions.yaml`), embedded at compile time.
- `src/main.rs` wires help/version output and live ToolEndpoint execution.
- `src/proto.rs` re-exports the generated prost modules and includes the `pbjson-build` serde impls used for JSON-over-HTTP decoding of proto-backed request/metadata types.
- `sqbin/agent-tools.exoskeleton` is the packaged executable built by `just build-sq`.
- `docs/sq-overview.md` covers the repo and packaged CLI at a high level.
- `docs/sq-integration.md` covers how `sq` discovers and integrates the packaged module.
- `docs/RELEASING-sq.md` covers the Homebrew-backed `sq` command-pack release path.
- `docs/RELEASING-bb.md` covers building the `bb` CLI binary consumed by Berd.app.

External docs: https://clig.dev/llms.txt -> guide you can consult to write better command-line programs, taking traditional UNIX principles and updating them for the modern day.


## Integration Notes

- This repo is packaged as a single `sq` module named `agent-tools.exoskeleton`.
- Homebrew packaging should install the entire `sqbin/` directory into `prefix/"etc"` so `sq` can discover the pack.
- `sq` picks up the repo-local package when `sq which agent-tools` resolves to `sqbin/agent-tools.exoskeleton`.
- `sq` synthesizes extension submenu help from `--describe-commands` metadata. In practice, extension-level flags such as `sq agent-tools <extension> --help` and `sq agent-tools <extension> --describe` can be intercepted by the outer `sq` wrapper instead of reaching the exoskeleton.
- To verify exoskeleton-specific extension behavior, prefer `./sqbin/agent-tools.exoskeleton <extension> --help` and `./sqbin/agent-tools.exoskeleton <extension> --describe`, then compare with `sq agent-tools <extension> ...` to identify wrapper behavior.
- The current CLI talks directly to the kgoose ToolEndpoint JSON-over-HTTP routes and expects `KGOOSE_BASE_URL`, `KGOOSE_PLAYPEN`, or explicit flags when needed. `GOOSEMCP_PLAYPEN` is an independent opt-in that adds an `envoy-route--goosemcp=playpen-<name>` entry to the outbound `Baggage` header for routing the downstream goosemcp Envoy; only set it when a matching playpen pod is running, otherwise extension calls fail with an opaque 5xx.
- Prefer generated proto types over handwritten mirrors. `tonic_prost_build` generates the prost messages, `extern_path` maps the `google.protobuf` JSON value types to `pbjson_types`, and `pbjson-build` adds serde support for the JSON-over-HTTP endpoints so the Rust types stay aligned with the service protos.
- `CallToolResponse` is now proto-backed too. `src/main.rs` pretty-prints the typed response envelope directly.
- The CLI is dynamic at three levels: ListExtensions determines which top-level extensions exist, ListTools determines which tool subcommands exist under each extension, and each tool's schema determines its flags/options.
- We take a hybrid static/dynamic approach:
    - **Top-level extensions are static.** `extensions.yaml` is generated from two sources (kGoose ListExtensionsGrpcAction + G2 web app OAuth config for late-init extensions like notion, asana), then manually curated. Run `just update-extensions-catalog` to regenerate. This lets all known extensions appear in `--help` even if the user hasn't connected them yet.
    - **Extension subcommands are fully dynamic.** ListTools and CallTool hit the live kgoose API. If the user hasn't connected an extension, `--help` for that extension will fail with a "not connected" error pointing to G2 Connections. The static catalog is used only to produce helpful error messages (distinguishing "unknown extension" from "known but not connected").
    - **`--describe-commands` leaf node is the extension subcommand.** We don't return nested tool commands under an extension, so `sq` forwards args to the extension subcommand directly.
