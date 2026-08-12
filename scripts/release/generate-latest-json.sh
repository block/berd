#!/usr/bin/env bash
# Generate a Tauri static latest.json for one or more updater platforms.
set -euo pipefail
usage() {
  echo "Usage: $0 <version> <notes> <platform> <signature-file> <archive-url> [<platform> <signature-file> <archive-url> ...]" >&2
  exit 2
}
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/release/lib.sh
source "$SCRIPT_DIR/lib.sh"
if [[ $# -lt 5 || $((($# - 2) % 3)) -ne 0 ]]; then
  usage
fi
VERSION="$1"
NOTES="$2"
shift 2
validate_release_version "$VERSION" || exit 1

validate_archive_url() {
  local archive_url="$1"
  local archive_name="$2"
  node - "$archive_url" "$archive_name" <<'NODE'
const [value, archiveName] = process.argv.slice(2);
if (/\s/.test(value)) process.exit(1);
let url;
try {
  url = new URL(value);
} catch {
  process.exit(1);
}
const pathParts = url.pathname.split("/");
if (
  url.protocol !== "https:" ||
  !url.hostname ||
  url.username ||
  url.password ||
  url.search ||
  url.hash ||
  pathParts.at(-1) !== archiveName
) {
  process.exit(1);
}
NODE
}

PLATFORMS_JSON='{}'
DIGESTS_JSON="${BERD_ARTIFACT_SHA256_BY_PLATFORM:-}"
COMPATIBILITY_SIGNATURES_JSON="${BERD_COMPATIBILITY_SIGNATURES_BY_PLATFORM:-}"
[[ -n "$DIGESTS_JSON" ]] || DIGESTS_JSON='{}'
[[ -n "$COMPATIBILITY_SIGNATURES_JSON" ]] || COMPATIBILITY_SIGNATURES_JSON='{}'
SEEN_PLATFORMS='|'
while [[ $# -gt 0 ]]; do
  PLATFORM="$1"
  SIGNATURE_FILE="$2"
  ARCHIVE_URL="$3"
  shift 3
  validate_release_platform "$PLATFORM" || exit 1
  if [[ "$SEEN_PLATFORMS" == *"|$PLATFORM|"* ]]; then
    release_error "duplicate updater platform: $PLATFORM"
    exit 1
  fi
  SEEN_PLATFORMS="${SEEN_PLATFORMS}${PLATFORM}|"

  if [[ ! -s "$SIGNATURE_FILE" ]]; then
    release_error "missing or empty signature: $SIGNATURE_FILE"
    exit 1
  fi
  SIGNATURE="$(tr -d '\r\n' < "$SIGNATURE_FILE")"
  if [[ -z "$SIGNATURE" ]]; then
    release_error "signature is empty"
    exit 1
  fi

  ARCHIVE_NAME="$(release_archive_name "$VERSION" "$PLATFORM")"
  if ! validate_archive_url "$ARCHIVE_URL" "$ARCHIVE_NAME"; then
    release_error "archive URL must be canonical HTTPS and end in $ARCHIVE_NAME"
    exit 1
  fi

  PLATFORMS_JSON="$(
    jq -c \
      --arg platform "$PLATFORM" \
      --arg signature "$SIGNATURE" \
      --arg url "$ARCHIVE_URL" \
      '. + {($platform): {signature: $signature, url: $url}}' \
      <<< "$PLATFORMS_JSON"
  )"
done

CHANNEL_ID="${BERD_RELEASE_CHANNEL_ID:-}"
STORE_CONTRACT="${BERD_STORE_CONTRACT_VERSION:-null}"
WRITES_EPOCH="${BERD_WRITES_DATA_EPOCH:-null}"
MIN_EPOCH="${BERD_MIN_READABLE_DATA_EPOCH:-null}"
MAX_EPOCH="${BERD_MAX_READABLE_DATA_EPOCH:-null}"
if [[ -n "$CHANNEL_ID" || "$STORE_CONTRACT" != null || "$WRITES_EPOCH" != null || "$MIN_EPOCH" != null || "$MAX_EPOCH" != null ]]; then
  : "${BERD_RELEASE_CHANNEL_ID:?BERD_RELEASE_CHANNEL_ID is required with compatibility metadata}"
  if [[ "$DIGESTS_JSON" == '{}' ]]; then
    : "${BERD_ARTIFACT_SHA256:?BERD_ARTIFACT_SHA256 is required}"
    : "${BERD_COMPATIBILITY_SIGNATURE:?BERD_COMPATIBILITY_SIGNATURE is required}"
  else
    if ! jq -e \
      --argjson platforms "$PLATFORMS_JSON" \
      'keys == ($platforms | keys) and all(.[]; test("^[0-9a-fA-F]{64}$"))' \
      <<< "$DIGESTS_JSON" \
      >/dev/null; then
      release_error "platform artifact digests must match updater platforms"
      exit 1
    fi
    if ! jq -e \
      --argjson platforms "$PLATFORMS_JSON" \
      'keys == ($platforms | keys) and all(.[]; type == "string" and length > 0)' \
      <<< "$COMPATIBILITY_SIGNATURES_JSON" \
      >/dev/null; then
      release_error "platform compatibility signatures must match updater platforms"
      exit 1
    fi
  fi
  : "${BERD_STORE_CONTRACT_VERSION:?BERD_STORE_CONTRACT_VERSION is required}"
  : "${BERD_WRITES_DATA_EPOCH:?BERD_WRITES_DATA_EPOCH is required}"
  : "${BERD_MIN_READABLE_DATA_EPOCH:?BERD_MIN_READABLE_DATA_EPOCH is required}"
  : "${BERD_MAX_READABLE_DATA_EPOCH:?BERD_MAX_READABLE_DATA_EPOCH is required}"
  if [[ ! "$CHANNEL_ID" =~ ^[a-z][a-z0-9-]{0,31}$ ]]; then
    release_error "BERD_RELEASE_CHANNEL_ID must be a valid catalog channel ID"
    exit 1
  fi
  if [[ "$DIGESTS_JSON" == '{}' && ! "$BERD_ARTIFACT_SHA256" =~ ^[0-9a-fA-F]{64}$ ]]; then
    release_error "BERD_ARTIFACT_SHA256 must be a SHA-256 hex digest"
    exit 1
  fi
  for epoch in BERD_STORE_CONTRACT_VERSION BERD_WRITES_DATA_EPOCH BERD_MIN_READABLE_DATA_EPOCH BERD_MAX_READABLE_DATA_EPOCH; do
    if [[ ! "${!epoch}" =~ ^[0-9]+$ ]]; then
      release_error "$epoch must be a non-negative integer"
      exit 1
    fi
  done
  if (( BERD_MIN_READABLE_DATA_EPOCH > BERD_WRITES_DATA_EPOCH || BERD_WRITES_DATA_EPOCH > BERD_MAX_READABLE_DATA_EPOCH )); then
    release_error "write epoch must be inside the readable range"
    exit 1
  fi
fi

jq -n \
  --arg version "$VERSION" \
  --arg notes "$NOTES" \
  --arg pub_date "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --argjson platforms "$PLATFORMS_JSON" \
  --arg channel_id "$CHANNEL_ID" \
  --arg artifact_sha256 "${BERD_ARTIFACT_SHA256:-}" \
  --arg compatibility_signature "${BERD_COMPATIBILITY_SIGNATURE:-}" \
  --argjson store_contract "$STORE_CONTRACT" \
  --argjson writes_epoch "$WRITES_EPOCH" \
  --argjson min_epoch "$MIN_EPOCH" \
  --argjson max_epoch "$MAX_EPOCH" \
  --argjson digests "$DIGESTS_JSON" \
  --argjson compatibility_signatures "$COMPATIBILITY_SIGNATURES_JSON" \
  '
    {
      version: $version,
      notes: $notes,
      pub_date: $pub_date,
      platforms: $platforms
    }
    + if ($digests | length) > 0 then
        {
          signedCompatibilityPlatforms: (
            $digests
            | with_entries(
                .value = {
                  schemaVersion: 1,
                  channelId: $channel_id,
                  version: $version,
                  artifactSha256: (.value | ascii_downcase),
                  compatibility: {
                    storeContractVersion: $store_contract,
                    writesDataEpoch: $writes_epoch,
                    minReadableDataEpoch: $min_epoch,
                    maxReadableDataEpoch: $max_epoch
                  },
                  signature: $compatibility_signatures[.key]
                }
              )
          )
        }
        + if $digests["darwin-aarch64"] then
            {
              signedCompatibility: {
                schemaVersion: 1,
                channelId: $channel_id,
                version: $version,
                artifactSha256: ($digests["darwin-aarch64"] | ascii_downcase),
                compatibility: {
                  storeContractVersion: $store_contract,
                  writesDataEpoch: $writes_epoch,
                  minReadableDataEpoch: $min_epoch,
                  maxReadableDataEpoch: $max_epoch
                },
                signature: $compatibility_signatures["darwin-aarch64"]
              }
            }
          else
            {}
          end
      elif $channel_id != "" then
        {
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
        }
      else
        {}
      end
  '
