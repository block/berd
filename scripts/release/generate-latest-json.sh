#!/usr/bin/env bash
# Generate and validate a Tauri static latest.json for one updater platform.
# Compatibility fields are display/check hints only; runtime authorization is
# bound to the build-bundled channel contract and release compatibility gate.

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

CHANNEL_ID="${BERD_RELEASE_CHANNEL_ID:-}"
STORE_CONTRACT="${BERD_STORE_CONTRACT_VERSION:-null}"
WRITES_EPOCH="${BERD_WRITES_DATA_EPOCH:-null}"
MIN_EPOCH="${BERD_MIN_READABLE_DATA_EPOCH:-null}"
MAX_EPOCH="${BERD_MAX_READABLE_DATA_EPOCH:-null}"
if [[ -n "$CHANNEL_ID" || "$STORE_CONTRACT" != "null" || "$WRITES_EPOCH" != "null" || "$MIN_EPOCH" != "null" || "$MAX_EPOCH" != "null" ]]; then
  : "${BERD_RELEASE_CHANNEL_ID:?BERD_RELEASE_CHANNEL_ID is required with compatibility metadata}"
  : "${BERD_ARTIFACT_SHA256:?BERD_ARTIFACT_SHA256 is required}"
  : "${BERD_COMPATIBILITY_SIGNATURE:?BERD_COMPATIBILITY_SIGNATURE is required}"
  : "${BERD_STORE_CONTRACT_VERSION:?BERD_STORE_CONTRACT_VERSION is required}"
  : "${BERD_WRITES_DATA_EPOCH:?BERD_WRITES_DATA_EPOCH is required}"
  : "${BERD_MIN_READABLE_DATA_EPOCH:?BERD_MIN_READABLE_DATA_EPOCH is required}"
  : "${BERD_MAX_READABLE_DATA_EPOCH:?BERD_MAX_READABLE_DATA_EPOCH is required}"
  [[ "$CHANNEL_ID" =~ ^[a-z][a-z0-9-]{0,31}$ ]] || {
    echo "BERD_RELEASE_CHANNEL_ID must be a valid catalog channel ID" >&2
    exit 1
  }
  [[ "$BERD_ARTIFACT_SHA256" =~ ^[0-9a-fA-F]{64}$ ]] || {
    echo "BERD_ARTIFACT_SHA256 must be a SHA-256 hex digest" >&2
    exit 1
  }
  [[ -n "$BERD_COMPATIBILITY_SIGNATURE" ]] || {
    echo "BERD_COMPATIBILITY_SIGNATURE must not be empty" >&2
    exit 1
  }
  for epoch in BERD_STORE_CONTRACT_VERSION BERD_WRITES_DATA_EPOCH BERD_MIN_READABLE_DATA_EPOCH BERD_MAX_READABLE_DATA_EPOCH; do
    [[ "${!epoch}" =~ ^[0-9]+$ ]] || { echo "$epoch must be a non-negative integer" >&2; exit 1; }
  done
  (( BERD_MIN_READABLE_DATA_EPOCH <= BERD_WRITES_DATA_EPOCH )) || {
    echo "write epoch must not be below the readable range" >&2
    exit 1
  }
  (( BERD_WRITES_DATA_EPOCH <= BERD_MAX_READABLE_DATA_EPOCH )) || {
    echo "write epoch must not exceed the readable range" >&2
    exit 1
  }
fi

jq -n \
  --arg version "$VERSION" \
  --arg notes "$NOTES" \
  --arg pub_date "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg platform "$PLATFORM" \
  --arg signature "$SIGNATURE" \
  --arg url "$ARCHIVE_URL" \
  --arg channel_id "$CHANNEL_ID" \
  --arg artifact_sha256 "${BERD_ARTIFACT_SHA256:-}" \
  --arg compatibility_signature "${BERD_COMPATIBILITY_SIGNATURE:-}" \
  --argjson store_contract "$STORE_CONTRACT" \
  --argjson writes_epoch "$WRITES_EPOCH" \
  --argjson min_epoch "$MIN_EPOCH" \
  --argjson max_epoch "$MAX_EPOCH" \
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
  }
  + (if $channel_id != "" then {
      signedCompatibility: {
        schemaVersion: 1,
        channelId: $channel_id,
        version: $version,
        artifactSha256: ($artifact_sha256 | ascii_downcase),
        compatibility: {
          storeContractVersion: $store_contract,
          writesDataEpoch: $writes_epoch,
          minReadableDataEpoch: $min_epoch,
          maxReadableDataEpoch: $max_epoch
        },
        signature: $compatibility_signature
      }
    } else {} end)'
