#!/usr/bin/env bash
# Write the tag-bound provenance receipt for one complete platform payload.
set -euo pipefail

[[ $# -ge 5 ]] || {
  echo "Usage: $0 <source-sha> <version> <platform> <output-dir> <asset-name>..." >&2
  exit 2
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/release/lib.sh
source "$SCRIPT_DIR/lib.sh"
SOURCE_SHA="$1"
VERSION="$2"
PLATFORM="$3"
OUTPUT_DIR="$4"
shift 4

validate_source_sha "$SOURCE_SHA" || exit 1
validate_release_version "$VERSION" || exit 1
validate_release_platform "$PLATFORM" || exit 1
[[ -d "$OUTPUT_DIR" ]] || {
  release_error "missing provenance asset directory: $OUTPUT_DIR"
  exit 1
}
OUTPUT_DIR="$(cd "$OUTPUT_DIR" && pwd)"

artifacts='{}'
for asset_name in "$@"; do
  [[ "$asset_name" == "$(basename "$asset_name")" && "$asset_name" != "." && "$asset_name" != ".." ]] || {
    release_error "provenance assets must be bare file names: $asset_name"
    exit 1
  }
  if jq -e --arg name "$asset_name" 'has($name)' <<< "$artifacts" >/dev/null; then
    release_error "duplicate provenance asset: $asset_name"
    exit 1
  fi
  asset="$OUTPUT_DIR/$asset_name"
  [[ -s "$asset" ]] || {
    release_error "missing or empty provenance asset: $asset_name"
    exit 1
  }
  digest="$(shasum -a 256 "$asset" | awk '{print $1}')"
  [[ "$digest" =~ ^[0-9a-f]{64}$ ]] || {
    release_error "invalid SHA-256 digest for provenance asset: $asset_name"
    exit 1
  }
  artifacts="$(jq -c --arg name "$asset_name" --arg digest "$digest" '. + {($name): $digest}' <<< "$artifacts")"
done

provenance_name="$(release_provenance_name "$VERSION" "$PLATFORM")"
jq -n \
  --arg sourceSha "$SOURCE_SHA" \
  --arg version "$VERSION" \
  --arg platform "$PLATFORM" \
  --argjson artifacts "$artifacts" \
  '{schemaVersion: 1, sourceSha: $sourceSha, version: $version, platform: $platform, artifacts: $artifacts}' \
  > "$OUTPUT_DIR/$provenance_name"
printf '%s\n' "$OUTPUT_DIR/$provenance_name"
