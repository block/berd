#!/usr/bin/env bash
# Download signed+notarized build artifacts from the build step, stamp the
# release version into their filenames, and publish them as a GitHub release
# on squareup/berd tagged v<version>.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/release/lib.sh
source "$SCRIPT_DIR/release-inputs.sh"
load_buildkite_release_inputs version
# shellcheck source=scripts/release/lib.sh
source "$SCRIPT_DIR/../../release/lib.sh"

RELEASE_VERSION="$(release_input_version)"
TAG="v${RELEASE_VERSION}"
TITLE="Berd v${RELEASE_VERSION}"
APP_COMMIT="${BUILDKITE_COMMIT:-$(git rev-parse HEAD)}"
GOOSE_BACKEND_COMMIT="$(jq -r '.commit' "$REPO_ROOT/goose-backend.lock.json")"
if [[ -n "${BUILDKITE_BUILD_URL:-}" ]]; then
  BUILD_REF="$BUILDKITE_BUILD_URL"
else
  BUILD_REF="Buildkite build #${BUILDKITE_BUILD_NUMBER:-local}"
fi
NOTES="$(cat <<EOF
Buildkite build: ${BUILD_REF}
App commit: \`${APP_COMMIT}\`
Pinned Goose backend commit: \`${GOOSE_BACKEND_COMMIT}\`
EOF
)"

rm -rf "$RELEASE_DIR"
mkdir -p "$RELEASE_DIR/macos"

echo "+++ :buildkite: Downloading signed artifacts"
buildkite-agent artifact download "release/macos/*" "$REPO_ROOT/"

STAGED="$RELEASE_DIR/macos"
APP_ZIP_SRC="$STAGED/${APP_BUNDLE_NAME}.app.zip"
DMG_SRC="$STAGED/${APP_BUNDLE_NAME}.dmg"
[[ -f "$APP_ZIP_SRC" ]] || { echo "Missing $APP_ZIP_SRC" >&2; exit 1; }
[[ -f "$DMG_SRC"     ]] || { echo "Missing $DMG_SRC"     >&2; exit 1; }

# Stamp the version into the asset filenames so downloads carry it. Switch to
# space-free names here for friendlier download URLs.
APP_ZIP="$STAGED/${APP_BUNDLE_NAME}_${RELEASE_VERSION}.app.zip"
DMG="$STAGED/${APP_BUNDLE_NAME}_${RELEASE_VERSION}_aarch64.dmg"
mv "$APP_ZIP_SRC" "$APP_ZIP"
mv "$DMG_SRC"     "$DMG"

echo "+++ :github: Creating release $TAG on $BERD_REPO"
if gh release view "$TAG" --repo "$BERD_REPO" >/dev/null 2>&1; then
  echo "Release $TAG already exists; re-uploading assets with --clobber"
  gh release edit "$TAG" \
    --repo "$BERD_REPO" \
    --target "${BUILDKITE_COMMIT:-main}" \
    --title "$TITLE" \
    --notes "$NOTES"
  gh release upload "$TAG" --repo "$BERD_REPO" --clobber "$APP_ZIP" "$DMG"
else
  gh release create "$TAG" \
    --repo "$BERD_REPO" \
    --target "${BUILDKITE_COMMIT:-main}" \
    --title "$TITLE" \
    --notes "$NOTES" \
    "$APP_ZIP" "$DMG"
fi

echo "+++ :white_check_mark: Published $TAG to $BERD_REPO"
