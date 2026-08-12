#!/usr/bin/env bash
# Sign the canonical compatibility payload used to authorize a release switch.
set -euo pipefail
[[ $# -eq 3 ]] || {
  echo "Usage: $0 <version> <channel-id> <artifact-sha256>" >&2
  exit 2
}
VERSION="$1"
CHANNEL_ID="$2"
ARTIFACT_SHA256="$3"
: "${TAURI_SIGNING_PRIVATE_KEY:?TAURI_SIGNING_PRIVATE_KEY is required}"
if [[ -z "${TAURI_SIGNING_PRIVATE_KEY_PASSWORD+x}" ]]; then
  echo "TAURI_SIGNING_PRIVATE_KEY_PASSWORD must be set" >&2
  exit 1
fi
: "${BERD_STORE_CONTRACT_VERSION:?BERD_STORE_CONTRACT_VERSION is required}"
: "${BERD_WRITES_DATA_EPOCH:?BERD_WRITES_DATA_EPOCH is required}"
: "${BERD_MIN_READABLE_DATA_EPOCH:?BERD_MIN_READABLE_DATA_EPOCH is required}"
: "${BERD_MAX_READABLE_DATA_EPOCH:?BERD_MAX_READABLE_DATA_EPOCH is required}"
[[ "$CHANNEL_ID" =~ ^[a-z][a-z0-9-]{0,31}$ ]] || { echo "invalid channel ID" >&2; exit 1; }
[[ "$ARTIFACT_SHA256" =~ ^[0-9a-fA-F]{64}$ ]] || { echo "invalid artifact SHA-256" >&2; exit 1; }
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/berd-compatibility.XXXXXX")"
trap 'rm -rf "$WORK_DIR"' EXIT
PAYLOAD="$WORK_DIR/compatibility.json"
jq -cn \
  --arg channelId "$CHANNEL_ID" \
  --arg version "$VERSION" \
  --arg artifactSha256 "$(printf '%s' "$ARTIFACT_SHA256" | tr '[:upper:]' '[:lower:]')" \
  --argjson storeContractVersion "$BERD_STORE_CONTRACT_VERSION" \
  --argjson writesDataEpoch "$BERD_WRITES_DATA_EPOCH" \
  --argjson minReadableDataEpoch "$BERD_MIN_READABLE_DATA_EPOCH" \
  --argjson maxReadableDataEpoch "$BERD_MAX_READABLE_DATA_EPOCH" \
  '{schemaVersion:1,channelId:$channelId,version:$version,artifactSha256:$artifactSha256,compatibility:{storeContractVersion:$storeContractVersion,writesDataEpoch:$writesDataEpoch,minReadableDataEpoch:$minReadableDataEpoch,maxReadableDataEpoch:$maxReadableDataEpoch}}' > "$PAYLOAD"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
(
  cd "$REPO_ROOT"
  pnpm exec tauri signer sign "$PAYLOAD" >/dev/null
)
tr -d '\r\n' < "$PAYLOAD.sig"
