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

## Public Agent Skills

Berd publishes portable Agent Skills under [`skills/`](skills/README.md). These
can be installed independently of the Berd app and are separate from the
contributor workflows under `.agents/skills/` and the starter skills bundled
under `distro/skills/`.

The first published skill, [`buzz-handoff`](skills/buzz-handoff/SKILL.md), brings
Buzz channel or thread context into a private agent conversation and can send an
explicitly approved reply through the public Buzz CLI.

## Adding an experiment

Experiments are user-local preferences for unstable UI or workflow behavior.
Untouched experiments follow the global auto-enable setting, which defaults on
in dev builds and off in production builds. Use
`.agents/skills/experimental-features/SKILL.md` for the current workflow,
registry contract, storage rules, Tauri guardrails, and test coverage.

## Participating

Berd is built by a small team at Block, in the open. You can read the source,
build it, and fork it freely — but **we don't accept pull requests from outside
authorized repository collaborators**, and outside PRs are closed automatically.

The way to participate is to **open a well-formed issue**. A bug report we can
reproduce is worth more to us than a patch, because it's the part we can't do
ourselves. [CONTRIBUTING.md](CONTRIBUTING.md) spells out exactly what each kind
of issue needs; the [issue forms](https://github.com/block/berd/issues/new/choose)
require it.

Filing one? Hand this to your coding agent:

```
Read https://raw.githubusercontent.com/block/berd/main/CONTRIBUTING.md
and help me file a Berd issue. Interview me for anything the guide
requires that I haven't given you, and tell me if what I'm reporting
is actually two separate issues.
```

Please also review the [Code of Conduct](CODE_OF_CONDUCT.md) and
[Security Policy](SECURITY.md). Never report a security vulnerability as a
public issue.

## Useful commands

- `just check` — Biome, design-system, i18n, contract, and type checks
- `just test` — unit and component tests
- `just tauri-check` — Rust type check with sidecars disabled
- `just clippy` — Rust lint with warnings denied
- `just bundle` — stage the pinned Goose backend and run `pnpm tauri build`
