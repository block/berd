#!/usr/bin/env bash
# Extract the notarized berd-call from a signed Berd.app.zip and archive it for
# hosts, such as Buzz, that ship the CLI without Berd.app. The binary keeps its
# Developer ID signature byte for byte and links only OS-provided libraries, so
# the archive holds that single file at its root.

set -euo pipefail

usage() {
  cat >&2 <<'USAGE'
Usage: scripts/release/package-berd-call.sh \
  --app-zip <signed-Berd.app.zip> \
  --version <semver> \
  --platform <darwin-aarch64> \
  --output-dir <directory>

Optional env:
  SKIP_MACOS_SECURITY_CHECKS=1
                           Tests only: skip codesign, entitlement, architecture,
                           linkage and launch checks. Production release jobs
                           must not set this.
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
ARCHIVE_NAME="$(release_call_archive_name "$VERSION" "$PLATFORM")" || exit 1
[[ -f "$APP_ZIP" ]] || { echo "missing signed app zip: $APP_ZIP" >&2; exit 1; }
if [[ "${SKIP_MACOS_SECURITY_CHECKS:-}" == "1" && "${CI:-}" == "true" ]]; then
  echo "SKIP_MACOS_SECURITY_CHECKS is forbidden in CI" >&2
  exit 1
fi

mkdir -p "$OUTPUT_DIR"
OUTPUT_DIR="$(cd "$OUTPUT_DIR" && pwd)"
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/berd-call-package.XXXXXX")"
trap 'rm -rf "$WORK_DIR"' EXIT

if command -v ditto >/dev/null 2>&1; then
  ditto -x -k "$APP_ZIP" "$WORK_DIR/app"
else
  unzip -q "$APP_ZIP" -d "$WORK_DIR/app"
fi
APP_PATH="$WORK_DIR/app/${APP_BUNDLE_NAME}.app"
SOURCE="$APP_PATH/Contents/MacOS/berd-call"
[[ -f "$SOURCE" && ! -L "$SOURCE" ]] || { echo "signed app has no berd-call executable" >&2; exit 1; }

STAGE="$WORK_DIR/stage"
mkdir "$STAGE"
CALL="$STAGE/berd-call"
cp "$SOURCE" "$CALL"
chmod 0755 "$CALL"

if [[ "${SKIP_MACOS_SECURITY_CHECKS:-}" != "1" ]]; then
  [[ "$(uname -s)" == "Darwin" ]] || {
    echo "macOS security checks require a macOS host" >&2
    exit 1
  }
  case "$PLATFORM" in
    darwin-aarch64) ARCH=arm64 ;;
    darwin-x86_64) ARCH=x86_64 ;;
  esac
  codesign --verify --strict --verbose=2 "$CALL"
  signature() { codesign --display --verbose=4 "$1" 2>&1; }
  CALL_SIGNATURE="$(signature "$CALL")"
  APP_TEAM="$(signature "$APP_PATH" | sed -n 's/^TeamIdentifier=//p')"
  [[ -n "$APP_TEAM" && "$APP_TEAM" != "not set" ]] || { echo "signed app has no team identifier" >&2; exit 1; }
  grep -Fxq "TeamIdentifier=$APP_TEAM" <<< "$CALL_SIGNATURE" ||
    { echo "berd-call is not signed by the app's team $APP_TEAM" >&2; exit 1; }
  grep -Fxq "Identifier=berd-call" <<< "$CALL_SIGNATURE" ||
    { echo "berd-call has an unexpected signing identifier" >&2; exit 1; }
  grep -Eq '^CodeDirectory .*flags=0x[0-9a-f]*\(.*runtime.*\)' <<< "$CALL_SIGNATURE" ||
    { echo "berd-call is not signed with the hardened runtime" >&2; exit 1; }
  "$SCRIPT_DIR/verify-macos-entitlements.sh" "$APP_PATH" berd-call
  [[ "$(lipo -archs "$CALL")" == "$ARCH" ]] ||
    { echo "berd-call must be a thin $ARCH executable" >&2; exit 1; }
  # Anything outside the OS would have to ship beside the binary; refuse it so the
  # single-file archive stays complete.
  LIBRARIES="$(otool -L "$CALL" | tail -n +2 | awk '{print $1}')"
  if grep -Ev '^(/System/Library/|/usr/lib/|@rpath/libswift_[A-Za-z]+\.dylib$)' <<< "$LIBRARIES"; then
    echo "berd-call links libraries outside the OS" >&2
    exit 1
  fi
  RPATHS="$(otool -l "$CALL" | awk '$1 == "cmd" { rpath = ($2 == "LC_RPATH") } rpath && $1 == "path" { print $2 }')"
  if grep -Fxv /usr/lib/swift <<< "$RPATHS"; then
    echo "berd-call has an rpath outside /usr/lib/swift" >&2
    exit 1
  fi
  "$CALL" --version
fi

ARCHIVE="$OUTPUT_DIR/$ARCHIVE_NAME"
rm -f "$ARCHIVE" "$ARCHIVE.sha256"
# Fixed metadata keeps rebuilds of the same signed binary byte-identical.
touch -t 200001010000 "$CALL"
COPYFILE_DISABLE=1 tar -C "$STAGE" --owner=0 --group=0 --numeric-owner -cf - berd-call |
  gzip -9n > "$ARCHIVE"
[[ "$(tar -tzf "$ARCHIVE")" == berd-call ]] || { echo "unexpected $ARCHIVE_NAME contents" >&2; exit 1; }

(cd "$OUTPUT_DIR" && shasum -a 256 "$ARCHIVE_NAME" > "$ARCHIVE_NAME.sha256")
printf 'archive=%s\ndigest=%s\n' "$ARCHIVE" "$ARCHIVE.sha256"
