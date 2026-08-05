#!/usr/bin/env bash
# Generate and validate a Tauri static latest.json for one updater platform.

set -euo pipefail
usage() {
  echo "Usage: $0 <version> <platform> <signature-file> <archive-url> [notes]" >&2
  exit 2
}
[[ $# -ge 4 && $# -le 5 ]] || usage
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/release/lib.sh
source "$SCRIPT_DIR/lib.sh"
VERSION="$1"
PLATFORM="$2"
SIGNATURE_FILE="$3"
ARCHIVE_URL="$4"
NOTES="${5:-Berd v$VERSION}"

validate_release_version "$VERSION" || exit 1
validate_release_platform "$PLATFORM" || exit 1
[[ -s "$SIGNATURE_FILE" ]] || { echo "missing or empty signature: $SIGNATURE_FILE" >&2; exit 1; }
SIGNATURE="$(tr -d '\r\n' < "$SIGNATURE_FILE")"
[[ -n "$SIGNATURE" ]] || { echo "signature is empty" >&2; exit 1; }
[[ "$ARCHIVE_URL" =~ ^https://[^[:space:]#?]+/Berd_${VERSION}_${PLATFORM}\.app\.tar\.gz$ ]] || {
  echo "archive URL must be HTTPS and end in the version/platform-qualified asset name" >&2
  exit 1
}

jq -n \
  --arg version "$VERSION" \
  --arg notes "$NOTES" \
  --arg pub_date "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg platform "$PLATFORM" \
  --arg signature "$SIGNATURE" \
  --arg url "$ARCHIVE_URL" \
  '{
    version: $version,
    notes: $notes,
    pub_date: $pub_date,
    platforms: {
      ($platform): {
        signature: $signature,
        url: $url
      }
    }
  }'
