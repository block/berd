#!/usr/bin/env bash
# Download signed+notarized build artifacts from the build step, stamp the
# release version into their filenames, and publish them as a GitHub release
# on squareup/goose-internal tagged v<version>.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/buildkite/release/lib.sh
source "$SCRIPT_DIR/lib.sh"

RELEASE_VERSION="$(meta version)"
TAG="v${RELEASE_VERSION}"
TITLE="Goose v${RELEASE_VERSION}"
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
buildkite-agent artifact download "**/release/macos/*" "$REPO_ROOT/"

STAGED="$RELEASE_DIR/macos"
APP_ZIP_SRC="$STAGED/${APP_BUNDLE_NAME}.app.zip"
DMG_SRC="$STAGED/${APP_BUNDLE_NAME}.dmg"
[[ -f "$APP_ZIP_SRC" ]] || { echo "Missing $APP_ZIP_SRC" >&2; exit 1; }
[[ -f "$DMG_SRC"     ]] || { echo "Missing $DMG_SRC"     >&2; exit 1; }

# Stamp the version into the asset filenames so downloads carry it. Switch to
# space-free names here for friendlier download URLs.
APP_ZIP="$STAGED/Goose_${RELEASE_VERSION}.app.zip"
DMG="$STAGED/Goose_${RELEASE_VERSION}_aarch64.dmg"
mv "$APP_ZIP_SRC" "$APP_ZIP"
mv "$DMG_SRC"     "$DMG"

echo "+++ :github: Creating release $TAG on $GOOSE_INTERNAL_REPO"
if gh release view "$TAG" --repo "$GOOSE_INTERNAL_REPO" >/dev/null 2>&1; then
  echo "Release $TAG already exists; re-uploading assets with --clobber"
  gh release edit "$TAG" \
    --repo "$GOOSE_INTERNAL_REPO" \
    --target "${BUILDKITE_COMMIT:-main}" \
    --title "$TITLE" \
    --notes "$NOTES"
  gh release upload "$TAG" --repo "$GOOSE_INTERNAL_REPO" --clobber "$APP_ZIP" "$DMG"
else
  gh release create "$TAG" \
    --repo "$GOOSE_INTERNAL_REPO" \
    --target "${BUILDKITE_COMMIT:-main}" \
    --title "$TITLE" \
    --notes "$NOTES" \
    "$APP_ZIP" "$DMG"
fi

echo "+++ :white_check_mark: Published $TAG to $GOOSE_INTERNAL_REPO"
