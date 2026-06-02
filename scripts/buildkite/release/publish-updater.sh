#!/usr/bin/env bash
# Re-archive the signed + notarized + stapled Goose.app, minisign the archive
# with the Tauri updater key, and publish it to Artifactory so installed
# binaries pick up the new version on their next poll.
#
# Runs in a pipeline step after the apple-codesign plugin has finished. We
# can't do this inside build-macos.sh because the plugin signs in its
# post-command hook, which runs after the step's command exits — by then the
# .app at build time was unsigned and any archive we'd have cut would embed
# an unsigned bundle.
#
# Required env:
#   GOOSE2_TAURI_SIGNING_PRIVATE_KEY           Minisign secret key (raw value)
#   GOOSE2_TAURI_SIGNING_PRIVATE_KEY_PASSWORD  Password for the key above
#   MOBUILD_ARTIFACTORY_UPLOAD_TOKEN           Write token for mdx/goose-internal/ on Artifactory

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/buildkite/release/lib.sh
source "$SCRIPT_DIR/lib.sh"

cd "$REPO_ROOT"
activate_hermit

: "${GOOSE2_TAURI_SIGNING_PRIVATE_KEY:?required}"
: "${GOOSE2_TAURI_SIGNING_PRIVATE_KEY_PASSWORD:?required}"
: "${MOBUILD_ARTIFACTORY_UPLOAD_TOKEN:?required}"

OUT_DIR="$RELEASE_DIR/macos"
mkdir -p "$OUT_DIR"

echo "+++ :buildkite: Downloading signed artifacts from build step"
# build-macos uploads release/macos/* via the apple-codesign plugin's built-in
# upload. We only need the .app.zip (it's the signed + stapled bundle
# packaged for transport).
buildkite-agent artifact download "**/release/macos/${APP_BUNDLE_NAME}.app.zip" "$REPO_ROOT/"

APP_ZIP="$OUT_DIR/${APP_BUNDLE_NAME}.app.zip"
[[ -f "$APP_ZIP" ]] || { echo "Missing $APP_ZIP" >&2; exit 1; }

echo "+++ :package: Extracting signed .app"
# ditto preserves bundle metadata that `unzip` would drop (extended attrs,
# symlinks, resource forks), which matters for the embedded code signature
# staying verifiable.
rm -rf "$OUT_DIR/${APP_BUNDLE_NAME}.app"
ditto -xk "$APP_ZIP" "$OUT_DIR"
[[ -d "$OUT_DIR/${APP_BUNDLE_NAME}.app" ]] || { echo "Extract produced no .app" >&2; exit 1; }

echo "+++ :package: Re-archiving signed .app as updater tarball"
# tauri-plugin-updater fetches a .tar.gz, decompresses it, and atomically
# replaces the running bundle with what's inside. The format is just a
# gzipped tar of the .app directory at the top level.
ARCHIVE="$OUT_DIR/${APP_BUNDLE_NAME}.app.tar.gz"
rm -f "$ARCHIVE"
( cd "$OUT_DIR" && tar -czf "${APP_BUNDLE_NAME}.app.tar.gz" "${APP_BUNDLE_NAME}.app" )

echo "+++ :closed_lock_with_key: Signing updater archive with minisign"
# tauri signer reads TAURI_SIGNING_PRIVATE_KEY + TAURI_SIGNING_PRIVATE_KEY_PASSWORD
# from env, same as `tauri build` does when createUpdaterArtifacts is on.
# goose-internal stores the key under GOOSE2_TAURI_* so it's clearly scoped
# to this app; remap inline for this one invocation instead of exporting
# globally. Use a one-shot CLI package because this step only downloads signed
# artifacts and should not depend on node_modules from the build step. Include
# the native package explicitly so pnpm dlx cannot omit the optional binding.
TAURI_CLI_VERSION="2.11.2"
case "$(uname -m)" in
  arm64|aarch64) TAURI_CLI_NATIVE_PACKAGE="@tauri-apps/cli-darwin-arm64@$TAURI_CLI_VERSION" ;;
  x86_64) TAURI_CLI_NATIVE_PACKAGE="@tauri-apps/cli-darwin-x64@$TAURI_CLI_VERSION" ;;
  *) echo "unsupported macOS architecture for Tauri CLI: $(uname -m)" >&2; exit 1 ;;
esac

TAURI_SIGNING_PRIVATE_KEY="$GOOSE2_TAURI_SIGNING_PRIVATE_KEY" \
TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$GOOSE2_TAURI_SIGNING_PRIVATE_KEY_PASSWORD" \
  pnpm --package "@tauri-apps/cli@$TAURI_CLI_VERSION" \
    --package "$TAURI_CLI_NATIVE_PACKAGE" \
    dlx tauri signer sign "$ARCHIVE"

SIGNATURE="$ARCHIVE.sig"
[[ -f "$SIGNATURE" ]] || { echo "tauri signer produced no $SIGNATURE" >&2; exit 1; }

echo "+++ :arrow_up: Publishing updater to Artifactory"
"$REPO_ROOT/scripts/publish-updater-to-artifactory.sh"

echo "+++ :white_check_mark: Auto-update payload published"
