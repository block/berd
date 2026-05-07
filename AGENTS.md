# AGENTS.md

Guidelines for agents working on Bloose.

Bloose is a standalone Tauri 2 + React 19 desktop app copied from Goose 2. The
frontend remains a thin client: UI code talks to Goose through `@aaif/goose-sdk`
and the ACP WebSocket served by `goose serve`. Do not add new Tauri commands or
renderer-side business logic for data/secrets/providers/sessions; those belong
in Goose core and should be exposed through typed ACP methods.

## Layout

- `src/` — React UI/features/shared code
- `src-tauri/` — Tauri shell that starts or resolves `goose serve`
- `sdk/` — vendored `@aaif/goose-sdk` package and generated ACP types
- `distro/` — packaged distribution config/resources
- `scripts/ensure-local-goose.sh` — managed local Goose checkout for dev
- `scripts/prepare-goose-sidecar.sh` — stages a Goose binary for Tauri bundling

## Common commands

- `just setup` — install pnpm deps, build SDK, build managed local Goose
- `just dev` — run the Tauri app in dev mode
- `just check` — Biome/i18n/type checks
- `just test` — Vitest suite
- `just tauri-check` — Rust check with external sidecars disabled
- `just clippy` — Rust clippy with warnings denied
- `just bundle` — stage `GOOSE_BIN` and run `pnpm tauri build`

## Sidecar rule

Release builds should stage Goose as a Tauri external binary:

```bash
GOOSE_BIN=/path/to/goose ./scripts/prepare-goose-sidecar.sh
```

The Tauri config uses `"externalBin": ["binaries/goose"]`; the script copies to
`src-tauri/binaries/goose-$(rustc -vV | sed -n 's|host: ||p')`, which is the
filename Tauri expects.

## Conventions

- Use `@/` imports for frontend code.
- Use `cn()` from `@/shared/lib/cn` for Tailwind class merging.
- All `<button>` elements need `type="button"` unless intentionally submitting.
- Do not hand-edit generated SDK files unless this repo intentionally freezes a
  generated snapshot; prefer updating `sdk/schema/*` and regenerating.
- Do not push without explicit approval.
