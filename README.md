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

To preview the ready-to-restart update indicator in the top bar during local
development, run:

```bash
VITE_PREVIEW_READY_UPDATE=true just dev
```

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

## Publishing avatar assets

Avatar media publishes as immutable catalog releases. Source files must be:

```text
/path/to/avatars/
  webm/<collection>/<avatar-id>.webm
  hevc/<collection>/<avatar-id>.mp4
```

Each avatar needs matching WebM and HEVC basenames. The basename becomes the
`app-avatar:<avatar-id>` ref and does not need a legacy prefix such as `fuzzy-*`.

```bash
export ARTIFACTORY_IDENTITY_TOKEN=...
just avatars-publish /path/to/avatars
```

Publish prints the generated timestamp version and does not update
`latest.json`. Promote that version explicitly:

```bash
just avatars-promote 20260521T121530123Z
```

To generate a local manifest without uploading:

```bash
just avatars-manifest /path/to/avatars 20260521T121530123Z
```

## Publishing startup artifacts

Startup artifacts publish as versioned create-only catalog releases. Source files must be:

```text
/path/to/assets/
  hdri/<environment>.exr
  project-images/<image>.webp
  images/<collection>/<image>.png
```

```bash
export ARTIFACTORY_IDENTITY_TOKEN=...
ASSET_ROOT=/path/to/goose-internal-assets
just artifacts-publish "$ASSET_ROOT/assets"
```

Publish prints the generated timestamp version and does not update
`latest.json`. Promote that version explicitly:

```bash
just artifacts-promote 20260521T121530123Z
```

To generate a local manifest without uploading:

```bash
ASSET_ROOT=/path/to/goose-internal-assets
just artifacts-manifest "$ASSET_ROOT/assets" 20260521T121530123Z
```

## Useful commands

- `just check` — Biome/i18n/type checks
- `just test` — unit/component tests
- `just tauri-check` — Rust type check with sidecars disabled
- `just clippy` — Rust lint with warnings denied
- `just bundle` — stage the pinned Goose backend and run `pnpm tauri build`
