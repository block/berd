# Release and Auto-Update

## Overview

Berd uses [Tauri's updater plugin](https://v2.tauri.app/plugin/updater/) to deliver in-app updates. The official release flow:

1. The Buildkite release pipeline builds a signed `.app` and the `squareup/apple-codesign` plugin signs, notarizes, and staples it.
2. A separate pipeline step downloads the Apple-codesigned `.app.zip`, re-archives it as `.app.tar.gz`, signs it with an Ed25519 key, and publishes the updater feed (`latest.json` + versioned archive) to Artifactory.
3. Signed release builds check `latest.json` on startup and every 6 hours. When a newer version is found, Berd downloads and installs it in the background, then shows “restart to apply”. Restart stays user-controlled.

The updater feed is hosted on Artifactory rather than GitHub Releases because Artifactory supports unauthenticated reads — critical for a private repo where GitHub Releases URLs return 404 for unauthenticated clients. Artifactory also provides versioned archive history and a `publish_latest` gate for safe rollout (test builds can upload versioned archives without overwriting `latest.json`).

Custom releases use a separate Buildkite pipeline. They build, sign, notarize, staple, and upload the macOS `.app.zip` and `.dmg` artifacts to a named Artifactory path, but they never publish updater artifacts, never update `latest.json`, never create go/mr records, and never create GitHub releases or tags.

## URLs

| Resource | Location |
|----------|----------|
| Version tags | `v<X.Y.Z>` on `squareup/berd` |
| Updater endpoint | `https://global.block-artifacts.com/artifactory/mdx/goose-internal/latest.json` |
| Versioned archive | `https://global.block-artifacts.com/artifactory/mdx/goose-internal/v<VERSION>/Berd.app.tar.gz` |
| DMG / zip downloads | Available on versioned (`v<X.Y.Z>`) GitHub releases |
| Custom DMG / zip downloads | `https://global.block-artifacts.com/artifactory/mdx/berd-custom/<custom_name>/v<VERSION>/` |

## One-time Setup

### Generate Ed25519 key pair

```bash
pnpm exec tauri signer generate -- --write-keys ~/.tauri/berd-release.key
```

This creates `~/.tauri/berd-release.key` (private) and `~/.tauri/berd-release.key.pub` (public).

### Required Buildkite secrets

| Secret | Description |
|--------|-------------|
| `GOOSE2_UPDATER_PUBLIC_KEY` | Ed25519 public key (contents of `~/.tauri/berd-release.key.pub`) |
| `GOOSE2_TAURI_SIGNING_PRIVATE_KEY` | Ed25519 private key (contents of `~/.tauri/berd-release.key`) |
| `GOOSE2_TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Password for the private key (set during `signer generate`) |
| `MOBUILD_ARTIFACTORY_UPLOAD_TOKEN` | Write access to `mdx/` on Artifactory via the `mobuild` service account |
| `ARTIFACTORY_USER` | Optional Artifactory user override; defaults to `mobuild` |

## Official Release Flow

1. **Trigger** — Open the official Buildkite release pipeline (`.buildkite/release.yml`) and enter a semver version (e.g. `0.2.0`). Optionally set `publish_latest` to control whether the updater feed is updated.
2. **Build & sign macOS** (`build-macos.sh`):
   - Stamps the version into `package.json`, `tauri.conf.json`, and `Cargo.toml`.
   - Generates `tauri.release.conf.json` with the Artifactory updater endpoint and public key (no `createUpdaterArtifacts` — updater artifacts are created in the publish step instead).
   - Builds with `VITE_UPDATER_ENABLED=true`, producing the `.app` bundle.
   - The `squareup/apple-codesign` plugin signs, notarizes, and staples the `.app`, then packages `.app.zip` and `.dmg`.
3. **Publish updater feed** (`publish-updater.sh`):
   - Downloads the Apple-codesigned `.app.zip` artifact.
   - Extracts the signed `.app` and archives it as `.app.tar.gz`.
   - Signs the archive with `pnpm tauri signer sign` (Ed25519).
   - Delegates to `publish-updater-to-artifactory.sh`, which uploads the versioned archive, signature, and (if `publish_latest` is set) `latest.json` to Artifactory.
4. **Publish GitHub release** (`publish-release.sh`):
   - Creates a versioned `v<X.Y.Z>` GitHub release with `.app.zip` and `.dmg` attached.

Steps 3 and 4 run in parallel after the build step completes.

The `publish_latest` gate allows test builds to upload versioned archives to Artifactory without overwriting `latest.json`, so existing users don't get prompted to update until the release is validated.

## Distribution Inputs

A distribution that packages Berd against its own gateway may supply two narrow, validated provider values to `build-macos.sh`. Both are optional and independent, and each is read from Buildkite meta-data or, for an orchestrator driving the build directly, from the uppercased env var:

| Input | Env var | Injected as | Effect |
|-------|---------|-------------|--------|
| `databricks_host` | `DATABRICKS_HOST` | `goose.modelProviders[databricks_v2].endpointEnv.DATABRICKS_HOST` | Packages the distribution's workspace host instead of leaving the provider host editable |
| `fast_model_id` | `FAST_MODEL_ID` | `goose.modelProviders[databricks_v2].fastModelId` | Exported to `goose serve` as `GOOSE_FAST_MODEL`, so Goose's lightweight tasks (session naming, compaction, tool-call titles) route to that endpoint instead of reusing the main model |

The `fast_model_id` input is deliberately *not* named `GOOSE_FAST_MODEL`: an input sharing the runtime env name Goose consumes would let an ambient value on the build agent silently become the bundled value.

`scripts/set-runtime-config-distribution.ts` applies whichever values are supplied — normalizing the host to a canonical HTTPS origin and the fast model to a served endpoint id — and re-parses the config against the shared schema; `validate-runtime-config.ts --strict-toggles` then runs once over the result. With neither input set, the injector never runs and the committed `runtime-config.json` ships as-is: no fast model, so Goose reuses the main model for fast tasks.

A custom build with `VITE_BYO_KEY_PROVIDERS=1` strips both fields back out before building, so a BYO-key bundle never carries a distribution's host or fast model.

## Custom Release Flow

1. **Trigger** — Open the custom Buildkite release pipeline (`.buildkite/custom-release.yml`) at the target commit and enter:
   - `version`: semver base version (e.g. `0.2.0`)
   - `custom_name`: lowercase slug (e.g. `acme-demo`)
   - `custom_config`: optional JSON overrides for `featureToggles`, `doctor`, and `feedback`
   - `disable_bb_cli`: optional toggle to omit the bb CLI PATH install
2. **Build & sign macOS** (`build-macos.sh`):
   - Stamps the app as `<version>-<custom_name>`.
   - Disables the updater in the renderer and Tauri config.
   - Deep-merges the optional `custom_config` onto `src-tauri/resources/runtime-config.json`, validates it, and derives build-time feature gates.
   - Builds the unsigned `.app`; the `squareup/apple-codesign` plugin signs, notarizes, staples, packages, and uploads `.app.zip` / `.dmg` artifacts.
3. **Upload custom artifacts** (`publish-custom-artifacts.sh`):
   - Downloads the signed `.app.zip` and `.dmg` artifacts from the build step.
   - Renames them with the custom app version, e.g. `Berd_0.2.0-acme-demo.app.zip` and `Berd_0.2.0-acme-demo_aarch64.dmg`.
   - Uploads them to `mdx/berd-custom/<custom_name>/v<version>/`.

Custom pipelines intentionally stop there. They do not upload updater archives, do not update `latest.json`, do not create go/mr records, and do not create GitHub releases or tags.

When both official and custom builds are needed for the same code, run both Buildkite pipelines at the same commit. The official pipeline owns the update channel and GitHub release; the custom pipeline owns only its named Artifactory artifact path.

## How the Updater Works

The updater provider (`src/features/updates/hooks/UpdaterProvider.tsx`) is mounted in `src/main.tsx` and exposes `useUpdaterContext()` through `src/features/updates/hooks/useUpdater.ts` to the settings page and top bar:

1. **Gating** — The hook only activates when all three conditions are met:
   - `VITE_UPDATER_ENABLED=true` (set at build time, only in release builds)
   - Not in Vite dev mode (`import.meta.env.DEV` is false)
   - Running inside Tauri (`window.__TAURI_INTERNALS__` exists)

2. **Polling** — An immediate quiet check runs on mount, then every 6 hours via `setInterval`.

3. **Check** — Calls `check()` from `@tauri-apps/plugin-updater`, which fetches `latest.json` from the configured Artifactory endpoint and compares the remote version against the running version. A 15-second timeout prevents hangs.

4. **Install** — If a newer version is found, Berd stores the Tauri `Update` object and calls `update.downloadAndInstall()` in the background. The Ed25519 signature is verified against the public key baked into the release config.

5. **Ready** — Once installation finishes, the provider moves to `ready`, shows a toast, and surfaces a compact top-bar restart indicator.

6. **Relaunch** — `relaunch()` from `@tauri-apps/plugin-process` only runs after the user clicks restart.

On the Rust side, `tauri-plugin-updater` is registered conditionally in `lib.rs` — only when the merged Tauri config contains a non-empty `plugins.updater.pubkey` (i.e. when `tauri.release.conf.json` is present). Dev builds skip the plugin entirely.

## Local Verification

### Generate the release config

```bash
GOOSE2_UPDATER_PUBLIC_KEY="<your-pubkey>" \
GOOSE2_UPDATER_ENDPOINT="https://global.block-artifacts.com/artifactory/mdx/goose-internal/latest.json" \
  pnpm run tauri:release:config
```

This writes `src-tauri/tauri.release.conf.json` (gitignored).

### Build with the release config

```bash
VITE_UPDATER_ENABLED=true \
  pnpm tauri build --no-sign --target aarch64-apple-darwin \
    --config src-tauri/tauri.release.conf.json
```

The build will produce the `.app` bundle in `src-tauri/target/aarch64-apple-darwin/release/bundle/macos/`.

## Key Files

| File | Role |
|------|------|
| `src/features/updates/hooks/UpdaterProvider.tsx` | Provider implementation: checks, downloads, installs, exposes restart |
| `src/features/updates/hooks/useUpdater.ts` | Public updater hook exports |
| `src/features/updates/ui/UpdatesSettings.tsx` | Settings surface for manual checks and restart |
| `src/features/updates/ui/UpdateIndicator.tsx` | Compact top-bar restart/update indicator |
| `src/main.tsx` | Mounts `UpdaterProvider` inside app providers |
| `src-tauri/src/lib.rs` | Conditionally registers `tauri-plugin-updater` based on pubkey presence |
| `src-tauri/Cargo.toml` | Rust dependencies for `tauri-plugin-updater` and `tauri-plugin-process` |
| `src-tauri/capabilities/default.json` | Grants `updater:default` and `process:allow-restart` permissions |
| `scripts/build-tauri-release-config.mjs` | Generates `tauri.release.conf.json` from env vars |
| `scripts/publish-updater-to-artifactory.sh` | Uploads updater archive, signature, and `latest.json` to Artifactory |
| `scripts/buildkite/release/build-macos.sh` | Release build: stamps version, generates release config, builds app |
| `scripts/set-runtime-config-distribution.ts` | Injects the optional distribution-owned Databricks host and fast model into the bundled runtime config |
| `scripts/buildkite/release/publish-custom-artifacts.sh` | Uploads custom signed `.app.zip` and `.dmg` artifacts to Artifactory |
| `scripts/buildkite/release/publish-updater.sh` | Post-codesign: re-archives `.app`, signs with Ed25519, delegates to Artifactory publish script |
| `.buildkite/release.yml` | Official pipeline with static build, publish-updater, and publish steps |
| `.buildkite/custom-release.yml` | Custom pipeline with build/sign and custom Artifactory upload steps |
| `.gitignore` | Excludes generated `src-tauri/tauri.release.conf.json` |
