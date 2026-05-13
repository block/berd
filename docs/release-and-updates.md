# Release and Auto-Update

## Overview

Goose uses [Tauri's updater plugin](https://v2.tauri.app/plugin/updater/) to deliver in-app updates. The flow:

1. The Buildkite release pipeline builds a signed `.app` and the `squareup/apple-codesign` plugin signs, notarizes, and staples it.
2. A separate pipeline step downloads the Apple-codesigned `.app.zip`, re-archives it as `.app.tar.gz`, signs it with an Ed25519 key, and publishes the updater feed (`latest.json` + versioned archive) to Artifactory.
3. Signed release builds check `latest.json` on startup and every 6 hours. When a newer version is found, Goose downloads and installs it in the background, then shows “restart to apply”. Restart stays user-controlled.

The updater feed is hosted on Artifactory rather than GitHub Releases because Artifactory supports unauthenticated reads — critical for a private repo where GitHub Releases URLs return 404 for unauthenticated clients. Artifactory also provides versioned archive history and a `publish_latest` gate for safe rollout (test builds can upload versioned archives without overwriting `latest.json`).

## URLs

| Resource | Location |
|----------|----------|
| Version tags | `v<X.Y.Z>` on `squareup/goose-internal` |
| Updater endpoint | `https://global.block-artifacts.com/artifactory/mdx/goose-internal/latest.json` |
| Versioned archive | `https://global.block-artifacts.com/artifactory/mdx/goose-internal/v<VERSION>/Goose.app.tar.gz` |
| DMG / zip downloads | Available on versioned (`v<X.Y.Z>`) GitHub releases |

## One-time Setup

### Generate Ed25519 key pair

```bash
pnpm exec tauri signer generate -- --write-keys ~/.tauri/goose-release.key
```

This creates `~/.tauri/goose-release.key` (private) and `~/.tauri/goose-release.key.pub` (public).

### Required Buildkite secrets

| Secret | Description |
|--------|-------------|
| `GOOSE2_UPDATER_PUBLIC_KEY` | Ed25519 public key (contents of `~/.tauri/goose-release.key.pub`) |
| `GOOSE2_TAURI_SIGNING_PRIVATE_KEY` | Ed25519 private key (contents of `~/.tauri/goose-release.key`) |
| `GOOSE2_TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Password for the private key (set during `signer generate`) |
| `MOBUILD_ARTIFACTORY_UPLOAD_TOKEN` | Write access to `mdx/` on Artifactory via the `mobuild` service account |
| `ARTIFACTORY_USER` | Optional Artifactory user override; defaults to `mobuild` |

## Release Flow

1. **Trigger** — Open the Buildkite release pipeline and enter a semver version (e.g. `0.2.0`). Optionally set `publish_latest` to control whether the updater feed is updated.
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

## How the Updater Works

The updater provider (`src/features/updates/hooks/UpdaterProvider.tsx`) is mounted in `src/main.tsx` and exposes `useUpdaterContext()` through `src/features/updates/hooks/useUpdater.ts` to the settings page and top bar:

1. **Gating** — The hook only activates when all three conditions are met:
   - `VITE_UPDATER_ENABLED=true` (set at build time, only in release builds)
   - Not in Vite dev mode (`import.meta.env.DEV` is false)
   - Running inside Tauri (`window.__TAURI_INTERNALS__` exists)

2. **Polling** — An immediate quiet check runs on mount, then every 6 hours via `setInterval`.

3. **Check** — Calls `check()` from `@tauri-apps/plugin-updater`, which fetches `latest.json` from the configured Artifactory endpoint and compares the remote version against the running version. A 15-second timeout prevents hangs.

4. **Install** — If a newer version is found, Goose stores the Tauri `Update` object and calls `update.downloadAndInstall()` in the background. The Ed25519 signature is verified against the public key baked into the release config.

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
| `scripts/buildkite/release/publish-updater.sh` | Post-codesign: re-archives `.app`, signs with Ed25519, delegates to Artifactory publish script |
| `.buildkite/release.yml` | Pipeline definition with build, publish-updater, and publish steps |
| `.gitignore` | Excludes generated `src-tauri/tauri.release.conf.json` |
