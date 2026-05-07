# Goose Internal

Goose Internal is the standalone internal desktop packaging of the Goose 2 Tauri app.
It is a Tauri 2 + React 19 app that talks to Goose through the ACP WebSocket
served by a `goose serve` sidecar.

## Getting started

```bash
just setup
just dev
```

`just setup` installs pnpm dependencies, builds the vendored `@aaif/goose-sdk`,
and prepares a managed local Goose checkout in your platform cache directory.
If you already have a Goose binary you want to use, set `GOOSE_BIN=/path/to/goose`
before running `just dev`.

## Bundling

Tauri bundles Goose as an external sidecar. Before a release bundle, stage the
binary with:

```bash
GOOSE_BIN=/path/to/goose just stage-sidecar
pnpm tauri build
```

This creates `src-tauri/binaries/goose-<rust-host-triple>`, matching the
`"externalBin": ["binaries/goose"]` entry in `src-tauri/tauri.conf.json`.

## Useful commands

- `just check` — Biome/i18n/type checks
- `just test` — unit/component tests
- `just tauri-check` — Rust type check with sidecars disabled
- `just clippy` — Rust lint with warnings denied
- `just bundle` — stage `GOOSE_BIN` and run `pnpm tauri build`
