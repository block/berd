#!/usr/bin/env bash
# Upload a custom Berd build's signed + notarized zip/dmg artifacts to
# Artifactory. This is intentionally separate from the updater publisher:
# custom builds do not create updater archives, latest.json, go/mr records, or
# GitHub releases.
#
# Uploads:
#   mdx/berd-custom/<custom_name>/v<version>/Berd_<version>-<custom_name>.app.zip
#   mdx/berd-custom/<custom_name>/v<version>/Berd_<version>-<custom_name>_aarch64.dmg
#
# Required env:
#   MOBUILD_ARTIFACTORY_UPLOAD_TOKEN   Artifactory write auth (mobuild token)
#   BUILD_KIND=custom                  Set by .buildkite/custom-release.yml
#   version + custom_name              via Buildkite meta-data or env override

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/release/lib.sh
source "$SCRIPT_DIR/release-inputs.sh"
load_buildkite_release_inputs version custom_name
# shellcheck source=scripts/release/lib.sh
source "$SCRIPT_DIR/../../release/lib.sh"

BUILD_KIND="$(release_build_kind)"
if [[ "$BUILD_KIND" != "custom" ]]; then
  echo "publish-custom-artifacts.sh requires BUILD_KIND=custom" >&2
  exit 1
fi

BASE_VERSION="$(release_input_version)"
CUSTOM_NAME="$(custom_build_name)"
RESOLVED_VERSION="$(resolve_release_version)"
: "${MOBUILD_ARTIFACTORY_UPLOAD_TOKEN:?MOBUILD_ARTIFACTORY_UPLOAD_TOKEN is required}"

ARTIFACTORY_BASE="${ARTIFACTORY_BASE:-https://global.block-artifacts.com/artifactory/mdx/berd-custom}"
ARTIFACTORY_USER="${ARTIFACTORY_USER:-mobuild}"

OUT_DIR="$RELEASE_DIR/macos"
mkdir -p "$OUT_DIR"

APP_ZIP_SRC="$OUT_DIR/${APP_BUNDLE_NAME}.app.zip"
DMG_SRC="$OUT_DIR/${APP_BUNDLE_NAME}.dmg"

download_signed_artifacts() {
  echo "+++ :buildkite: Downloading signed custom artifacts"
  buildkite-agent artifact download "release/macos/${APP_BUNDLE_NAME}.app.zip" "$REPO_ROOT/"
  buildkite-agent artifact download "release/macos/${APP_BUNDLE_NAME}.dmg" "$REPO_ROOT/"
}

if [[ -n "${BUILDKITE:-}" ]]; then
  rm -f "$APP_ZIP_SRC" "$DMG_SRC"
  download_signed_artifacts
elif [[ ! -f "$APP_ZIP_SRC" || ! -f "$DMG_SRC" ]]; then
  download_signed_artifacts
fi

[[ -f "$APP_ZIP_SRC" ]] || { echo "Missing $APP_ZIP_SRC" >&2; exit 1; }
[[ -f "$DMG_SRC" ]] || { echo "Missing $DMG_SRC" >&2; exit 1; }

VERSION_PATH="v$BASE_VERSION"
APP_ZIP_UPLOAD="$OUT_DIR/${APP_BUNDLE_NAME}_${RESOLVED_VERSION}.app.zip"
DMG_UPLOAD="$OUT_DIR/${APP_BUNDLE_NAME}_${RESOLVED_VERSION}_aarch64.dmg"
cp "$APP_ZIP_SRC" "$APP_ZIP_UPLOAD"
cp "$DMG_SRC" "$DMG_UPLOAD"

DESTINATION_BASE="$ARTIFACTORY_BASE/$CUSTOM_NAME/$VERSION_PATH"
APP_ZIP_URL="$DESTINATION_BASE/$(basename "$APP_ZIP_UPLOAD")"
DMG_URL="$DESTINATION_BASE/$(basename "$DMG_UPLOAD")"

upload() {
  local src="$1"
  local url="$2"
  echo "Uploading $(basename "$src") -> $url"
  curl -fSs \
    -u "$ARTIFACTORY_USER:$MOBUILD_ARTIFACTORY_UPLOAD_TOKEN" \
    -T "$src" \
    "$url"
  echo
}

upload "$APP_ZIP_UPLOAD" "$APP_ZIP_URL"
upload "$DMG_UPLOAD" "$DMG_URL"

echo "+++ :white_check_mark: Published custom artifacts to $DESTINATION_BASE"
