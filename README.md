# Goose

Goose is the standalone internal desktop packaging of the Goose 2 Tauri app.
It is a Tauri 2 + React 19 app that talks to Goose through the ACP WebSocket
served by a `goose serve` sidecar.

## Getting started

```bash
just setup
just dev
```

`just setup` installs pnpm dependencies, builds the vendored `@aaif/goose-sdk`,
and prepares the Goose backend pinned by `goose-backend.lock.json` in your
platform cache directory. `just dev` reuses that stamped pinned binary and fails
if the lockfile commit no longer matches the cached build.

If you already have a Goose binary you want to test, set `GOOSE_BIN=/path/to/goose`
before running `just dev`; that is an explicit local override and bypasses the
managed pinned checkout.

To bump the default Goose backend, update the lockfile in a PR:

```bash
scripts/update-goose-backend-lock.sh main # or a tag/branch/sha
just goose-sync                          # fetch/build the new pinned commit
```

## Bundling

Tauri bundles Goose as an external sidecar. By default `just bundle` stages the
pinned managed Goose binary from `goose-backend.lock.json` and then runs
`pnpm tauri build`:

```bash
just bundle
```

You can still stage an explicit local binary with `GOOSE_BIN=/path/to/goose just
stage-sidecar`. Staging creates `src-tauri/binaries/goosed-<rust-host-triple>`,
matching the `"externalBin": ["binaries/goosed"]` entry in
`src-tauri/tauri.conf.json`.

## Useful commands

- `just check` — Biome/i18n/type checks
- `just test` — unit/component tests
- `just tauri-check` — Rust type check with sidecars disabled
- `just clippy` — Rust lint with warnings denied
- `just bundle` — stage the pinned Goose backend and run `pnpm tauri build`
