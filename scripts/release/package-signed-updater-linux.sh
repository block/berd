#!/usr/bin/env bash
# Package a Linux AppImage as the Tauri updater archive and sign it with the
# repository-locked Tauri CLI.
set -euo pipefail

usage() {
  cat >&2 <<'USAGE'
Usage: scripts/release/package-signed-updater-linux.sh \
  --appimage <Berd_..._.AppImage> \
  --version <semver> \
  --output-dir <directory>

Produces the canonical linux-x86_64 AppImage and its signed updater archive.
USAGE
  exit 2
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/release/lib.sh
source "$SCRIPT_DIR/lib.sh"

APPIMAGE=""
VERSION=""
OUTPUT_DIR=""
PLATFORM="linux-x86_64"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --appimage) APPIMAGE="${2:-}"; shift 2 ;;
    --version) VERSION="${2:-}"; shift 2 ;;
    --output-dir) OUTPUT_DIR="${2:-}"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; usage ;;
  esac
done

[[ -n "$APPIMAGE" && -n "$VERSION" && -n "$OUTPUT_DIR" ]] || usage
validate_release_version "$VERSION" || exit 1
[[ -f "$APPIMAGE" ]] || { release_error "missing AppImage: $APPIMAGE"; exit 1; }
: "${TAURI_SIGNING_PRIVATE_KEY:?TAURI_SIGNING_PRIVATE_KEY is required}"
: "${BERD_UPDATER_PUBLIC_KEY:?BERD_UPDATER_PUBLIC_KEY is required}"
if [[ -z "${TAURI_SIGNING_PRIVATE_KEY_PASSWORD+x}" ]]; then
  release_error "TAURI_SIGNING_PRIVATE_KEY_PASSWORD must be set"
  exit 1
fi

mkdir -p "$OUTPUT_DIR"
OUTPUT_DIR="$(cd "$OUTPUT_DIR" && pwd)"
APPIMAGE_NAME="$(release_installer_name "$VERSION" "$PLATFORM")"
ARCHIVE_NAME="$(release_archive_name "$VERSION" "$PLATFORM")"
cp "$APPIMAGE" "$OUTPUT_DIR/$APPIMAGE_NAME"
chmod +x "$OUTPUT_DIR/$APPIMAGE_NAME"
tar -C "$OUTPUT_DIR" -czf "$OUTPUT_DIR/$ARCHIVE_NAME" "$APPIMAGE_NAME"
[[ "$(tar -tzf "$OUTPUT_DIR/$ARCHIVE_NAME" | wc -l | tr -d ' ')" -eq 1 ]]
tar -tzf "$OUTPUT_DIR/$ARCHIVE_NAME" | grep -Fxq "$APPIMAGE_NAME"

(
  cd "$REPO_ROOT"
  pnpm exec tauri signer sign "$OUTPUT_DIR/$ARCHIVE_NAME"
)
SIGNATURE="$OUTPUT_DIR/$ARCHIVE_NAME.sig"
[[ -s "$SIGNATURE" ]] || { release_error "tauri signer produced no $SIGNATURE"; exit 1; }
"$REPO_ROOT/scripts/release/verify-updater-signature.sh" \
  "$OUTPUT_DIR/$ARCHIVE_NAME" "$SIGNATURE" "$BERD_UPDATER_PUBLIC_KEY"
unset TAURI_SIGNING_PRIVATE_KEY TAURI_SIGNING_PRIVATE_KEY_PASSWORD
(
  cd "$OUTPUT_DIR"
  shasum -a 256 "$ARCHIVE_NAME" > "$ARCHIVE_NAME.sha256"
)
printf 'appimage=%s\narchive=%s\nsignature=%s\ndigest=%s\n' \
  "$OUTPUT_DIR/$APPIMAGE_NAME" "$OUTPUT_DIR/$ARCHIVE_NAME" "$SIGNATURE" "$OUTPUT_DIR/$ARCHIVE_NAME.sha256"
