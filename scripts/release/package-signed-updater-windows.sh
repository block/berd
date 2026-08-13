#!/usr/bin/env bash
# Package the Windows NSIS installer as a Tauri updater artifact and sign that
# artifact with the Tauri updater (minisign) key.
#
# tauri-plugin-updater on Windows downloads a zip whose single entry is the
# NSIS -setup.exe installer, verifies the minisign signature against the
# embedded pubkey, then runs the installer. The installer is currently not
# Authenticode-signed; the minisign signature authenticates the downloaded zip.
# Republish the zip under the canonical platform-qualified
# name so promotion matches the darwin scheme.
#
# CI-neutral: caller supplies the installer path and updater-signing secrets.
#
# Required env:
#   TAURI_SIGNING_PRIVATE_KEY
#   TAURI_SIGNING_PRIVATE_KEY_PASSWORD
#   BERD_UPDATER_PUBLIC_KEY  Public key embedded in the release build.
set -euo pipefail

usage() {
  cat >&2 <<'USAGE'
Usage: scripts/release/package-signed-updater-windows.sh \
  --installer <Berd_..._-setup.exe> \
  --version <semver> \
  --output-dir <directory>

Produces, under <output-dir>:
  Berd_<version>_windows-x86_64-setup.nsis.zip        Updater archive
  Berd_<version>_windows-x86_64-setup.nsis.zip.sig    Minisign signature
  Berd_<version>_windows-x86_64-setup.nsis.zip.sha256 Digest
USAGE
  exit 2
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/release/lib.sh
source "$SCRIPT_DIR/lib.sh"

INSTALLER=""
VERSION=""
OUTPUT_DIR=""
PLATFORM="windows-x86_64"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --installer)
      INSTALLER="${2:-}"
      shift 2
      ;;
    --version)
      VERSION="${2:-}"
      shift 2
      ;;
    --output-dir)
      OUTPUT_DIR="${2:-}"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      ;;
  esac
done

if [[ -z "$INSTALLER" || -z "$VERSION" || -z "$OUTPUT_DIR" ]]; then
  usage
fi
validate_release_version "$VERSION" || exit 1
if [[ ! -f "$INSTALLER" ]]; then
  release_error "missing installer: $INSTALLER"
  exit 1
fi
command -v 7z >/dev/null 2>&1 || {
  echo "7-Zip is required on the Windows release runner" >&2
  exit 1
}
: "${TAURI_SIGNING_PRIVATE_KEY:?TAURI_SIGNING_PRIVATE_KEY is required}"
: "${BERD_UPDATER_PUBLIC_KEY:?BERD_UPDATER_PUBLIC_KEY is required}"
if [[ -z "${TAURI_SIGNING_PRIVATE_KEY_PASSWORD+x}" ]]; then
  echo "TAURI_SIGNING_PRIVATE_KEY_PASSWORD must be set" >&2
  exit 1
fi

mkdir -p "$OUTPUT_DIR"
OUTPUT_DIR="$(cd "$OUTPUT_DIR" && pwd)"
INSTALLER="$(cd "$(dirname "$INSTALLER")" && pwd)/$(basename "$INSTALLER")"

ARCHIVE_NAME="$(release_archive_name "$VERSION" "$PLATFORM")"
INSTALLER_NAME="$(release_installer_name "$VERSION" "$PLATFORM")"
ARCHIVE="$OUTPUT_DIR/$ARCHIVE_NAME"
rm -f "$ARCHIVE" "$ARCHIVE.sig" "$ARCHIVE.sha256"

# Stage the installer under its canonical name so the zip entry matches what the
# updater expects, then zip that single file at the archive root.
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/berd-win-updater.XXXXXX")"
trap 'rm -rf "$WORK_DIR"' EXIT
cp "$INSTALLER" "$WORK_DIR/$INSTALLER_NAME"
( cd "$WORK_DIR" && 7z a -tzip -mx=9 "$ARCHIVE" "$INSTALLER_NAME" >/dev/null )

# Confirm the archive contains exactly the installer at its root.
ARCHIVE_LIST="$WORK_DIR/archive-contents.txt"
7z l -slt "$ARCHIVE" | sed -n 's/^Path = //p' | tail -n +2 > "$ARCHIVE_LIST"
[[ "$(wc -l < "$ARCHIVE_LIST" | tr -d ' ')" -eq 1 ]]
grep -Fxq "$INSTALLER_NAME" "$ARCHIVE_LIST"

# `just setup-windows` and `Bundle-Windows.ps1` install the repository's
# frozen lockfile before this secret-bearing step. Never resolve executable
# packages from the registry while the updater private key is present.
(
  cd "$REPO_ROOT"
  pnpm exec tauri signer sign "$ARCHIVE"
)

SIGNATURE="$ARCHIVE.sig"
if [[ ! -s "$SIGNATURE" ]]; then
  release_error "tauri signer produced no $SIGNATURE"
  exit 1
fi
"$REPO_ROOT/scripts/release/verify-updater-signature.sh" \
  "$ARCHIVE" "$SIGNATURE" "$BERD_UPDATER_PUBLIC_KEY"
unset TAURI_SIGNING_PRIVATE_KEY TAURI_SIGNING_PRIVATE_KEY_PASSWORD

(
  cd "$OUTPUT_DIR"
  node - "$ARCHIVE_NAME" > "$ARCHIVE_NAME.sha256" <<'NODE'
const fs = require("fs");
const crypto = require("crypto");

const name = process.argv[2];
const digest = crypto.createHash("sha256").update(fs.readFileSync(name)).digest("hex");
process.stdout.write(`${digest}  ${name}\n`);
NODE
)
printf 'archive=%s\nsignature=%s\ndigest=%s\n' \
  "$ARCHIVE" "$SIGNATURE" "$ARCHIVE.sha256"
