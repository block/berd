#!/usr/bin/env bash
# Re-archive the signed + notarized + stapled Berd.app, minisign the archive
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
#   GOOSE2_TAURI_SIGNING_PRIVATE_KEY           Internal Tauri updater secret key
#   GOOSE2_TAURI_SIGNING_PRIVATE_KEY_PASSWORD  Password for the key above
#   GOOSE2_UPDATER_PUBLIC_KEY                  Matching internal public key
#   MOBUILD_ARTIFACTORY_UPLOAD_TOKEN           Write token for mdx/goose-internal/ on Artifactory

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/release/lib.sh
source "$SCRIPT_DIR/release-inputs.sh"
load_buildkite_release_inputs version publish_latest
# shellcheck source=scripts/release/lib.sh
source "$SCRIPT_DIR/../../release/lib.sh"

cd "$REPO_ROOT"
activate_hermit

: "${GOOSE2_TAURI_SIGNING_PRIVATE_KEY:?required}"
: "${GOOSE2_TAURI_SIGNING_PRIVATE_KEY_PASSWORD:?required}"
: "${GOOSE2_UPDATER_PUBLIC_KEY:?required}"
: "${MOBUILD_ARTIFACTORY_UPLOAD_TOKEN:?required}"

OUT_DIR="$RELEASE_DIR/macos"
mkdir -p "$OUT_DIR"

echo "+++ :buildkite: Downloading signed artifacts from build step"
# build-macos uploads release/macos/* via the apple-codesign plugin's built-in
# upload. We only need the .app.zip (it's the signed + stapled bundle
# packaged for transport).
buildkite-agent artifact download "release/macos/${APP_BUNDLE_NAME}.app.zip" "$REPO_ROOT/"

APP_ZIP="$OUT_DIR/${APP_BUNDLE_NAME}.app.zip"
[[ -f "$APP_ZIP" ]] || { echo "Missing $APP_ZIP" >&2; exit 1; }

echo "+++ :package: Packaging and signing the verified updater archive"
TAURI_SIGNING_PRIVATE_KEY="$GOOSE2_TAURI_SIGNING_PRIVATE_KEY" \
TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$GOOSE2_TAURI_SIGNING_PRIVATE_KEY_PASSWORD" \
BERD_UPDATER_PUBLIC_KEY="$GOOSE2_UPDATER_PUBLIC_KEY" \
  "$REPO_ROOT/scripts/release/package-signed-updater.sh" \
    --app-zip "$APP_ZIP" \
    --version "$(release_input_version)" \
    --platform darwin-aarch64 \
    --output-dir "$OUT_DIR"

echo "+++ :arrow_up: Publishing updater to Artifactory"
"$SCRIPT_DIR/publish-updater-to-artifactory.sh"

echo "+++ :white_check_mark: Auto-update payload published"
