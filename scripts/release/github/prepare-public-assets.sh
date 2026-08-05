#!/usr/bin/env bash
# Validate signed outputs from the GitHub OIDC signing action and prepare the
# complete immutable public-release asset set.
set -euo pipefail
[[ $# -eq 6 ]] || {
  echo "Usage: $0 <signed-app.zip> <signed.dmg> <version> <platform> <output-dir> <github-env>" >&2
  exit 2
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/release/lib.sh
source "$SCRIPT_DIR/../lib.sh"
APP_ZIP="$1"
SIGNED_DMG="$2"
VERSION="$3"
PLATFORM="$4"
OUTPUT_DIR="$5"
GITHUB_ENV_FILE="$6"

validate_release_version "$VERSION" || exit 1
validate_release_platform "$PLATFORM" || exit 1
[[ -f "$APP_ZIP" ]] || { echo "missing signed app zip: $APP_ZIP" >&2; exit 1; }
[[ -f "$SIGNED_DMG" ]] || { echo "missing signed DMG: $SIGNED_DMG" >&2; exit 1; }
[[ "$(uname -s)" == "Darwin" ]] || { echo "signed release validation requires macOS" >&2; exit 1; }

mkdir -p "$OUTPUT_DIR"
OUTPUT_DIR="$(cd "$OUTPUT_DIR" && pwd)"
APP_ZIP_NAME="${APP_BUNDLE_NAME}_${VERSION}_${PLATFORM}.app.zip"
DMG_NAME="${APP_BUNDLE_NAME}_${VERSION}_${PLATFORM}.dmg"
cp "$APP_ZIP" "$OUTPUT_DIR/$APP_ZIP_NAME"
cp "$SIGNED_DMG" "$OUTPUT_DIR/$DMG_NAME"
hdiutil verify "$OUTPUT_DIR/$DMG_NAME"

"$REPO_ROOT/scripts/release/package-signed-updater.sh" \
  --app-zip "$APP_ZIP" \
  --version "$VERSION" \
  --platform "$PLATFORM" \
  --output-dir "$OUTPUT_DIR"

printf 'asset_dir=%s\napp_zip_name=%s\ndmg_name=%s\n' \
  "$OUTPUT_DIR" "$APP_ZIP_NAME" "$DMG_NAME" >> "$GITHUB_ENV_FILE"
