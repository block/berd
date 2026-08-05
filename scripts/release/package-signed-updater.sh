#!/usr/bin/env bash
# Extract and verify a signed/notarized/stapled Berd.app.zip, archive the signed
# app with an architecture-qualified updater filename, and sign that archive
# with the Tauri updater key. CI-neutral: callers provide paths and secrets.

set -euo pipefail

usage() {
  cat >&2 <<'USAGE'
Usage: scripts/release/package-signed-updater.sh \
  --app-zip <signed-Berd.app.zip> \
  --version <semver> \
  --platform <darwin-aarch64> \
  --output-dir <directory>

The output version must be canonical SemVer without build metadata.

Required env:
  TAURI_SIGNING_PRIVATE_KEY
  TAURI_SIGNING_PRIVATE_KEY_PASSWORD
  BERD_UPDATER_PUBLIC_KEY  Public key embedded in the release build.

Optional env:
  TAURI_CLI_VERSION        Defaults to the package.json @tauri-apps/cli version.
  SKIP_MACOS_SECURITY_CHECKS=1
                           Tests only: skip codesign/Gatekeeper/stapler/entitlement
                           checks. Production release jobs must not set this.
USAGE
  exit 2
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/release/lib.sh
source "$SCRIPT_DIR/lib.sh"
APP_ZIP=""
VERSION=""
PLATFORM=""
OUTPUT_DIR=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --app-zip) APP_ZIP="${2:-}"; shift 2 ;;
    --version) VERSION="${2:-}"; shift 2 ;;
    --platform) PLATFORM="${2:-}"; shift 2 ;;
    --output-dir) OUTPUT_DIR="${2:-}"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; usage ;;
  esac
done

[[ -n "$APP_ZIP" && -n "$VERSION" && -n "$PLATFORM" && -n "$OUTPUT_DIR" ]] || usage
validate_release_version "$VERSION" || exit 1
validate_release_platform "$PLATFORM" || exit 1
[[ -f "$APP_ZIP" ]] || { echo "missing signed app zip: $APP_ZIP" >&2; exit 1; }
: "${TAURI_SIGNING_PRIVATE_KEY:?TAURI_SIGNING_PRIVATE_KEY is required}"
: "${BERD_UPDATER_PUBLIC_KEY:?BERD_UPDATER_PUBLIC_KEY is required}"
if [[ -z "${TAURI_SIGNING_PRIVATE_KEY_PASSWORD+x}" ]]; then
  echo "TAURI_SIGNING_PRIVATE_KEY_PASSWORD must be set" >&2
  exit 1
fi

if [[ "${SKIP_MACOS_SECURITY_CHECKS:-}" == "1" && "${CI:-}" == "true" ]]; then
  echo "SKIP_MACOS_SECURITY_CHECKS is forbidden in CI" >&2
  exit 1
fi

mkdir -p "$OUTPUT_DIR"
OUTPUT_DIR="$(cd "$OUTPUT_DIR" && pwd)"
APP_ZIP="$(cd "$(dirname "$APP_ZIP")" && pwd)/$(basename "$APP_ZIP")"
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/berd-updater.XXXXXX")"
trap 'rm -rf "$WORK_DIR"' EXIT

if command -v ditto >/dev/null 2>&1; then
  ditto -x -k "$APP_ZIP" "$WORK_DIR"
else
  unzip -q "$APP_ZIP" -d "$WORK_DIR"
fi

APP_PATH="$WORK_DIR/${APP_BUNDLE_NAME}.app"
[[ -d "$APP_PATH" ]] || { echo "archive did not contain ${APP_BUNDLE_NAME}.app at its root" >&2; exit 1; }

if [[ "${SKIP_MACOS_SECURITY_CHECKS:-}" != "1" ]]; then
  [[ "$(uname -s)" == "Darwin" ]] || {
    echo "macOS security checks require a macOS host" >&2
    exit 1
  }
  codesign --verify --deep --strict --verbose=2 "$APP_PATH"
  spctl --assess --type execute --verbose=4 "$APP_PATH"
  xcrun stapler validate "$APP_PATH"
  "$REPO_ROOT/scripts/release/verify-macos-entitlements.sh" "$APP_PATH"
fi

ARCHIVE_NAME="$(release_archive_name "$VERSION" "$PLATFORM")"
ARCHIVE="$OUTPUT_DIR/$ARCHIVE_NAME"
rm -f "$ARCHIVE" "$ARCHIVE.sig" "$ARCHIVE.sha256"
# Keep Berd.app at the archive root; that is the bundle shape tauri-plugin-updater
# atomically installs on macOS.
tar -C "$WORK_DIR" -czf "$ARCHIVE" "${APP_BUNDLE_NAME}.app"
ARCHIVE_LIST="$WORK_DIR/archive-contents.txt"
tar -tzf "$ARCHIVE" > "$ARCHIVE_LIST"
grep -Fxq "${APP_BUNDLE_NAME}.app/" "$ARCHIVE_LIST"

TAURI_CLI_VERSION="${TAURI_CLI_VERSION:-$(node -p "JSON.parse(require('fs').readFileSync('$REPO_ROOT/package.json', 'utf8')).devDependencies['@tauri-apps/cli'].replace(/^[^0-9]*/, '')")}"
case "$(uname -m)" in
  arm64|aarch64) TAURI_CLI_NATIVE_PACKAGE="@tauri-apps/cli-darwin-arm64@$TAURI_CLI_VERSION" ;;
  x86_64) TAURI_CLI_NATIVE_PACKAGE="@tauri-apps/cli-darwin-x64@$TAURI_CLI_VERSION" ;;
  *) echo "unsupported host architecture for Tauri CLI: $(uname -m)" >&2; exit 1 ;;
esac

pnpm --package "@tauri-apps/cli@$TAURI_CLI_VERSION" \
  --package "$TAURI_CLI_NATIVE_PACKAGE" \
  dlx tauri signer sign "$ARCHIVE"

SIGNATURE="$ARCHIVE.sig"
[[ -s "$SIGNATURE" ]] || { echo "tauri signer produced no $SIGNATURE" >&2; exit 1; }
"$REPO_ROOT/scripts/release/verify-updater-signature.sh" \
  "$ARCHIVE" "$SIGNATURE" "$BERD_UPDATER_PUBLIC_KEY"
unset TAURI_SIGNING_PRIVATE_KEY TAURI_SIGNING_PRIVATE_KEY_PASSWORD

(cd "$OUTPUT_DIR" && shasum -a 256 "$ARCHIVE_NAME" > "$ARCHIVE_NAME.sha256")
printf 'archive=%s\nsignature=%s\ndigest=%s\n' \
  "$ARCHIVE" "$SIGNATURE" "$ARCHIVE.sha256"
