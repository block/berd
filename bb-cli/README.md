# bb-cli

`bb-cli` packages Rust-powered CLI binaries for BuilderBot/kgoose workflows
inside the `goose-internal` repo:

- `agent-tools`, the `sq agent-tools` command for the kgoose
  `ToolEndpointService`.
- `bb`, the BuilderBot CLI for skills marketplace operations and `bb tools`.

The `agent-tools` CLI uses a static extension catalog for root discovery, then
loads tool metadata live once an extension is selected:

- `sq agent-tools --help` lists extensions
- `sq agent-tools <extension> --help` lists tools
- `sq agent-tools <extension> <tool> --help` lists tool arguments

The packaged `sq` binary is built into `sqbin/agent-tools.exoskeleton` for
local packaging and repo workflows. The direct `bb` development binary is built
at `target/debug/bb`.

## Local Development

From the `goose-internal` repo root, activate the Hermit-managed toolchain:

```bash
source ./bin/activate-hermit
just bb-cli-build
just bb-cli-test
just bb-cli-lint
```

From `goose-internal/bb-cli`, the original package-local recipes are still
available:

```bash
./bin/hermit install rustup just lefthook
source ./bin/activate-hermit
just setup
```

Build the packaged executable:

```bash
just build-sq
just update-extensions-catalog
./sqbin/agent-tools.exoskeleton --describe-commands
```

The repo exposes the conventional local-development targets:

```bash
just build
just test
just fmt
just lint
just setup
```

Build and run the `bb` CLI directly:

```bash
cargo build --locked --bin bb
./target/debug/bb --help
./target/debug/bb skills --help
```

When iterating against the sibling `../cash-server/builderbot-marketplace`
service on `localhost:8080`, use the checked-in local-dev profile:

```bash
./target/debug/bb --local-dev skills doctor
./target/debug/bb --local-dev skills list
```

For browser-based `bb auth`, see [BuilderBot Auth Flow](docs/bb-auth-flow.md)
and [BuilderBot Local Auth Testing](docs/bb-auth-local-testing.md).

Inspect the live CLI surface:

```bash
./target/debug/agent-tools --help
./target/debug/agent-tools utils calculate --numbers 2 3 --operation add
```

Target staging or a playpen with the direct binary by setting env vars:

```bash
KGOOSE_BASE_URL=https://kgoose.stage.sqprod.co ./target/debug/agent-tools --help
KGOOSE_BASE_URL=https://kgoose.stage.sqprod.co KGOOSE_PLAYPEN=baxen ./target/debug/agent-tools --help
```


## Runtime Behavior

Requests are sent as JSON to the three Misk gRPC-over-HTTP paths:

1. `/squareup.cash.kgoose.api.v3.ToolEndpointService/ListExtensions`
2. `/squareup.cash.kgoose.api.v3.ToolEndpointService/ListTools`
3. `/squareup.cash.kgoose.api.v3.ToolEndpointService/CallTool`

The CLI uses these environment variables when flags are not supplied:

- `KGOOSE_BASE_URL`
- `KGOOSE_PLAYPEN`
- `GOOSEMCP_PLAYPEN`
- `KGOOSE_TIMEOUT`
- `STS_ACCESS_TOKEN`

When `STS_ACCESS_TOKEN` is present, the CLI forwards it as
`x-forwarded-identity-token: $STS_ACCESS_TOKEN` on outbound requests.

Example local development command targeting staging with playpen routing:

```bash
KGOOSE_BASE_URL="https://kgoose.stage.sqprod.co" KGOOSE_PLAYPEN=smohammed GOOSEMCP_PLAYPEN=smohammed ./target/debug/agent-tools slack --help
```

`sq` caches the root `--describe-commands` output, so [`extensions.yaml`](extensions.yaml)
is checked in and compiled into the binary. Refresh it with `just update-extensions-catalog` or
`cargo run -- --write-extensions extensions.yaml`, then manually clean up the generated summaries before
shipping.

`cargo run -- --write-extensions ...` writes the raw `ListExtensions` result. When a sibling
`../g2` checkout is present, `just update-extensions-catalog` also merges the G2 connection config
and descriptions so extensions like `block-uid`, `asana`, and `todoist` still land in the static
root catalog even when they are missing from the live response.

The installed `sq agent-tools` command is intended to target `https://kgoose.sqprod.co` (prod).
For local development against staging or a playpen, use `./target/debug/agent-tools` or
`cargo run -- ...` with `KGOOSE_BASE_URL` and `KGOOSE_PLAYPEN`.

When `KGOOSE_BASE_URL` is unset in `blox`, `IS_BLOX=true` with
`BLOX_ENVIRONMENT=production` or `BLOX_ENVIRONMENT=staging` automatically routes
to `http://kgoose.cashappservices.com` or
`http://kgoose.cashappservicesstaging.com`.

## Project Layout

- `src/kgoose.rs` contains the kgoose ToolEndpoint client plus the HTTP response models.
- `extensions.yaml` is the checked-in root extension catalog used for `sq agent-tools --help` and root `--describe-commands`.
- `src/catalog.rs` loads and writes the extension catalog.
- `src/cli.rs` bootstraps global flags, then builds the clap command tree from the static extension catalog plus live tool metadata.
- `src/runtime.rs` turns `ListExtensions` and `ListTools` responses into extension, tool, and argument metadata.
- `src/proto.rs` re-exports the generated ToolEndpoint protobuf code and path constants.
- `Justfile` owns build, lint, test, and `sqbin` packaging workflows.

## Deployment Notes

For release packaging, keep the `sqbin` output shape intact so the Homebrew formula can build from `bb-cli` and install the whole directory into `prefix/"etc"`.
There is a short `sq` release checklist in `docs/RELEASING-sq.md`.
The `bb` app and archive release path is documented separately in `docs/RELEASING-bb.md`.
