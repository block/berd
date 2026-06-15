#!/usr/bin/env bash
# Build the Goose macOS Tauri bundle for release. Leaves an unsigned
# .app at release/macos/ for the squareup/apple-codesign plugin to sign,
# notarize, staple, and package in its post-command hook.
#
# Inputs (Buildkite meta-data, or uppercase env var override for local runs):
#   - version: semver for the release (e.g. 0.2.0)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/buildkite/release/lib.sh
source "$SCRIPT_DIR/lib.sh"

cd "$REPO_ROOT"
activate_hermit

RELEASE_VERSION="$(meta version)"
[[ "$RELEASE_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-+].+)?$ ]] || {
  echo "refusing to stamp non-semver version: $RELEASE_VERSION" >&2; exit 1;
}

echo "+++ :package: Stamping version -> $RELEASE_VERSION"
tmp="$(mktemp)"
jq --arg v "$RELEASE_VERSION" '.version = $v' package.json > "$tmp" && mv "$tmp" package.json
jq --arg v "$RELEASE_VERSION" '.version = $v' src-tauri/tauri.conf.json > "$tmp" && mv "$tmp" src-tauri/tauri.conf.json
# Only rewrite the version line inside [package]. Dependency versions live in
# [dependencies] / [dev-dependencies] and must stay untouched.
awk -v v="$RELEASE_VERSION" '
  /^\[package\]/ { in_pkg = 1; print; next }
  /^\[/          { in_pkg = 0; print; next }
  in_pkg && /^version[[:space:]]*=/ { print "version = \"" v "\""; next }
                 { print }
' src-tauri/Cargo.toml > "$tmp" && mv "$tmp" src-tauri/Cargo.toml

# just setup: pnpm install, build @aaif/goose-sdk, build the pinned goose
# backend binary via scripts/ensure-local-goose.sh.
echo "+++ :hammer: just setup"
just setup

# Generate release config with updater endpoint and public key baked into the
# binary. The apple-codesign plugin handles signing, and publish-updater.sh
# creates updater artifacts after notarization.
echo "+++ :key: Generating tauri.release.conf.json"
: "${GOOSE2_UPDATER_PUBLIC_KEY:?GOOSE2_UPDATER_PUBLIC_KEY is required}"
: "${GOOSE2_UPDATER_ENDPOINT:?GOOSE2_UPDATER_ENDPOINT is required}"
pnpm run tauri:release:config

echo "+++ :hammer: Patching release config for signing flow"
# Defensive strip: if a future base tauri.conf.json ever pins a signingIdentity,
# Tauri would merge it back in at build time and try to sign against a cert that
# isn't in the agent keychain. The apple-codesign plugin owns signing
# post-build, so we want the build itself unsigned.
# createUpdaterArtifacts is intentionally NOT set by the release config either —
# we re-tar + minisign in the publish-updater step after the plugin has signed
# and stapled the .app.
tmp="$(mktemp)"
jq 'del(.bundle.macOS.signingIdentity)' src-tauri/tauri.conf.json > "$tmp" \
  && mv "$tmp" src-tauri/tauri.conf.json
jq 'del(.bundle.macOS.signingIdentity) | del(.bundle.createUpdaterArtifacts)' \
  src-tauri/tauri.release.conf.json > "$tmp" \
  && mv "$tmp" src-tauri/tauri.release.conf.json

# Stage the goose backend as the Tauri sidecar, then build for an explicit
# aarch64 target so output paths are stable regardless of agent architecture.
# Production telemetry is an explicit release opt-in; generic builds default to
# development. No TAURI_SIGNING_PRIVATE_KEY needed — signing happens in
# publish-updater.sh.
echo "+++ :hammer: pnpm tauri build (unsigned)"
./scripts/prepare-goose-sidecar.sh
VITE_ENVIRONMENT=production \
VITE_UPDATER_ENABLED=true \
  pnpm tauri build --no-sign --target aarch64-apple-darwin \
    --config src-tauri/tauri.release.conf.json

UNSIGNED_APP="src-tauri/target/aarch64-apple-darwin/release/bundle/macos/${APP_BUNDLE_NAME}.app"
[[ -d "$UNSIGNED_APP" ]] || { echo "Missing $UNSIGNED_APP" >&2; exit 1; }

echo "+++ :package: Staging unsigned .app for apple-codesign"
mkdir -p release/macos
rm -rf "release/macos/${APP_BUNDLE_NAME}.app"
# ditto preserves bundle metadata and extended attributes cp would drop.
ditto "$UNSIGNED_APP" "release/macos/${APP_BUNDLE_NAME}.app"

ls -lh release/macos
