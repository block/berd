# Berd

Berd is an open-source desktop app for working with AI agents. It is built with
Tauri 2 and React 19 and talks to the upstream Goose backend through the ACP
WebSocket served by a `goose serve` sidecar.

The repository builds a general-purpose public distribution. Organizations can
also create enterprise distributions by supplying managed provider settings,
private resources, and release infrastructure through the repository's
distribution seams without adding private material to the public source tree.

## Getting started

```bash
just setup
just dev
```

`just setup` installs pnpm dependencies, builds the vendored `@aaif/goose-sdk`,
and prepares the Goose backend pinned by `goose-backend.lock.json` in your
platform cache directory. `just dev` reuses that stamped pinned binary and fails
if the lockfile commit no longer matches the cached build.

If you already have an upstream Goose binary you want to test, set
`GOOSE_BIN=/path/to/goose` before running `just dev`; that is an explicit local
override and bypasses the managed pinned checkout.

To bump the default Goose backend, update the lockfile in a PR:

```bash
scripts/update-goose-backend-lock.sh main # or a tag/branch/sha
just goose-sync                          # fetch/build the new pinned commit
```

## Bundling and distributions

Tauri bundles the Goose backend as an external sidecar. By default, `just bundle`
stages the pinned managed Goose binary from `goose-backend.lock.json` and then
runs `pnpm tauri build`:

```bash
just bundle
```

You can stage an explicit local binary with
`GOOSE_BIN=/path/to/goose just stage-sidecar`. Staging creates
`src-tauri/binaries/goosed-<rust-host-triple>`, matching the
`"externalBin": ["binaries/goosed"]` entry in `src-tauri/tauri.conf.json`.

The public build is self-contained and does not require private package
registries or enterprise credentials. Enterprise distributors may overlay
private agents, runtime configuration, optional companion tools, update
channels, and signing or publishing infrastructure in their own private build
orchestration.

## Optional companion CLI

Berd includes a distribution seam for bundling an optional companion CLI as an
app resource. The public app does not require a private CLI package; enterprise
distributors can provide and package their own implementation while retaining
the normal Berd build and validation flow.

## Adding an experiment

Experiments are user-local preferences for unstable UI or workflow behavior.
Untouched experiments follow the global auto-enable setting, which defaults on
in dev builds and off in production builds. Use
`.agents/skills/experimental-features/SKILL.md` for the current workflow,
registry contract, storage rules, Tauri guardrails, and test coverage.

## Preparing avatar assets

Avatar source files use this layout:

```text
/path/to/avatars/
  webm/<collection>/<avatar-id>.webm
  hevc/<collection>/<avatar-id>.mp4
```

Each avatar needs matching WebM and HEVC basenames. The basename becomes the
`app-avatar:<avatar-id>` ref and does not need a legacy prefix such as `fuzzy-*`.
Generate a local manifest without uploading:

```bash
just avatars-manifest /path/to/avatars 20260521T121530123Z
```

Publishing is distribution-owned: public or enterprise distributors should
connect the generated immutable catalog to storage and promotion infrastructure
outside this repository.

## Preparing startup artifacts

Startup-artifact source files use this layout:

```text
/path/to/assets/
  hdri/<environment>.exr
  project-images/<image>.webp
  images/<collection>/<image>.png
```

Generate a local manifest without uploading:

```bash
ASSET_ROOT=/path/to/berd-assets
just artifacts-manifest "$ASSET_ROOT/assets" 20260521T121530123Z
```

As with avatar catalogs, publication and promotion belong to the distribution
that hosts the assets rather than to the public Berd repository.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution setup and expectations.
Please also review the [Code of Conduct](CODE_OF_CONDUCT.md) and
[Security Policy](SECURITY.md).

## Useful commands

- `just check` — Biome, design-system, i18n, contract, and type checks
- `just test` — unit and component tests
- `just tauri-check` — Rust type check with sidecars disabled
- `just clippy` — Rust lint with warnings denied
- `just bundle` — stage the pinned Goose backend and run `pnpm tauri build`
