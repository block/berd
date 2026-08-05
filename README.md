# Berd

Berd is the standalone internal desktop app for agent work. It is a Tauri 2 +
React 19 app that talks to the upstream Goose backend through the ACP WebSocket
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

If you already have an upstream Goose binary you want to test, set `GOOSE_BIN=/path/to/goose`
before running `just dev`; that is an explicit local override and bypasses the
managed pinned checkout.

To preview the ready-to-restart update indicator in the top bar during local
development, run:

```bash
VITE_PREVIEW_READY_UPDATE=true just dev
```

Bring-your-own-key model providers (OpenAI/Anthropic/Google Gemini) are on by
default: a normal `just dev` shows their API-key entry rows alongside the
managed `databricks_v2` provider. A restricted build opts out with
`VITE_BYO_KEY_PROVIDERS=0` (the official internal release build does this
explicitly in `scripts/release/build-macos.sh`).

To also simulate the external-build Databricks posture in dev — no injected
`DATABRICKS_HOST`, so the Databricks row shows an editable host field instead
of the managed read-only URL — set the env var explicitly:

```bash
VITE_BYO_KEY_PROVIDERS=1 just dev
```

(In debug builds, `VITE_BYO_KEY_PROVIDERS=1` additionally strips the default
Databricks host from the bundled runtime config; release builds achieve the
same via the build script's runtime-config rewrite.)

To bump the default Goose backend, update the lockfile in a PR:

```bash
scripts/update-goose-backend-lock.sh main # or a tag/branch/sha
just goose-sync                          # fetch/build the new pinned commit
```

## Bundling

Tauri bundles the Goose backend as an external sidecar. By default `just bundle`
stages the pinned managed Goose binary from `goose-backend.lock.json` and then runs
`pnpm tauri build`:

```bash
just bundle
```

You can still stage an explicit local binary with `GOOSE_BIN=/path/to/goose just
stage-sidecar`. Staging creates `src-tauri/binaries/goosed-<rust-host-triple>`,
matching the `"externalBin": ["binaries/goosed"]` entry in
`src-tauri/tauri.conf.json`.

## BuilderBot CLI

The BuilderBot and `sq agent-tools` CLI package lives in `bb-cli`. It remains an
independent Rust crate with its own package-local release scripts, while root
recipes delegate to it for local checks:

```bash
just bb-cli-build
just bb-cli-test
just bb-cli-lint
just bb-cli-build-sq
```

The `sq` package artifact is still built at
`bb-cli/sqbin/agent-tools.exoskeleton`, and `bb` archive packaging still writes
under `bb-cli/dist/`.

## Adding an experiment

Experiments are user-local preferences for unstable UI or workflow behavior.
Untouched experiments follow the global auto-enable setting, which defaults on
in dev builds and off in production builds. Use
`.agents/skills/experimental-features/SKILL.md` for the current workflow,
registry contract, storage rules, Tauri guardrails, and test coverage.

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
ASSET_ROOT=/path/to/berd-assets
just artifacts-publish "$ASSET_ROOT/assets"
```

Publish prints the generated timestamp version and does not update
`latest.json`. Promote that version explicitly:

```bash
just artifacts-promote 20260521T121530123Z
```

To generate a local manifest without uploading:

```bash
ASSET_ROOT=/path/to/berd-assets
just artifacts-manifest "$ASSET_ROOT/assets" 20260521T121530123Z
```

## Useful commands

- `just check` — Biome/i18n/type checks
- `just test` — unit/component tests
- `just tauri-check` — Rust type check with sidecars disabled
- `just clippy` — Rust lint with warnings denied
- `just bundle` — stage the pinned Goose backend and run `pnpm tauri build`
