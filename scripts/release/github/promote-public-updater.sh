#!/usr/bin/env bash
# Promote an already-staged updater payload from an immutable versioned GitHub
# release to the rolling public feed. The payload is downloaded and reverified;
# this script never rebuilds or re-signs it. latest.json is uploaded last.
set -euo pipefail
[[ $# -eq 3 ]] || {
  echo "Usage: $0 <v-prefixed-tag> <source-sha> <output-summary-path>" >&2
  exit 2
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/release/lib.sh
source "$SCRIPT_DIR/../lib.sh"
TAG="$1"
SOURCE_SHA="$2"
SUMMARY_PATH="$3"
: "${GH_TOKEN:?GH_TOKEN is required}"
: "${BERD_PUBLIC_UPDATER_PUBLIC_KEY:?BERD_PUBLIC_UPDATER_PUBLIC_KEY is required}"
validate_release_tag "$TAG" || exit 1
validate_source_sha "$SOURCE_SHA" || exit 1
VERSION="${TAG#v}"
load_public_channel "${BERD_PUBLIC_CHANNEL_CONFIG:-}"
REPOSITORY="$PUBLIC_REPOSITORY"
ROLLING_TAG="$PUBLIC_ROLLING_TAG"
PLATFORM="$PUBLIC_PLATFORM"
[[ "${GITHUB_REPOSITORY:-$REPOSITORY}" == "$REPOSITORY" ]] || {
  echo "workflow repository ${GITHUB_REPOSITORY:-<unset>} does not match configured public repository $REPOSITORY" >&2
  exit 1
}

ARCHIVE_NAME="$(release_archive_name "$VERSION" "$PLATFORM")"
WORK_DIR="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/berd-promote.XXXXXX")"
trap 'rm -rf "$WORK_DIR"' EXIT

echo "Downloading staged updater payload from $REPOSITORY release $TAG"
gh release download "$TAG" --repo "$REPOSITORY" --dir "$WORK_DIR" \
  --pattern "$ARCHIVE_NAME" \
  --pattern "$ARCHIVE_NAME.sig" \
  --pattern "$ARCHIVE_NAME.sha256"
for path in "$WORK_DIR/$ARCHIVE_NAME" "$WORK_DIR/$ARCHIVE_NAME.sig" "$WORK_DIR/$ARCHIVE_NAME.sha256"; do
  [[ -s "$path" ]] || { echo "missing or empty staged input: $path" >&2; exit 1; }
done

EXPECTED_DIGEST="$(awk 'NR == 1 {print $1}' "$WORK_DIR/$ARCHIVE_NAME.sha256")"
ACTUAL_DIGEST="$(shasum -a 256 "$WORK_DIR/$ARCHIVE_NAME" | awk '{print $1}')"
[[ "$EXPECTED_DIGEST" =~ ^[0-9a-f]{64}$ && "$ACTUAL_DIGEST" == "$EXPECTED_DIGEST" ]] || {
  echo "staged updater digest mismatch" >&2
  exit 1
}
"$REPO_ROOT/scripts/release/verify-updater-signature.sh" \
  "$WORK_DIR/$ARCHIVE_NAME" \
  "$WORK_DIR/$ARCHIVE_NAME.sig" \
  "$BERD_PUBLIC_UPDATER_PUBLIC_KEY"
ARCHIVE_LIST="$WORK_DIR/archive-contents.txt"
tar -tzf "$WORK_DIR/$ARCHIVE_NAME" > "$ARCHIVE_LIST"
grep -Fxq 'Berd.app/' "$ARCHIVE_LIST"

if ! gh release view "$ROLLING_TAG" --repo "$REPOSITORY" >/dev/null 2>&1; then
  gh release create "$ROLLING_TAG" --repo "$REPOSITORY" \
    --target "$SOURCE_SHA" \
    --prerelease \
    --latest=false \
    --title "Berd Desktop Auto-Update" \
    --notes "Rolling release for the Tauri auto-updater. Use versioned releases for manual downloads."
fi

# Version-qualified names avoid architecture collisions. A retry may replace
# only this version's bytes; latest.json remains untouched until all checks pass.
gh release upload "$ROLLING_TAG" --repo "$REPOSITORY" --clobber \
  "$WORK_DIR/$ARCHIVE_NAME" \
  "$WORK_DIR/$ARCHIVE_NAME.sig" \
  "$WORK_DIR/$ARCHIVE_NAME.sha256"

ROLLING_BASE="https://github.com/${REPOSITORY}/releases/download/${ROLLING_TAG}"
ARCHIVE_URL="$ROLLING_BASE/$ARCHIVE_NAME"
PUBLIC_COPY="$WORK_DIR/public-$ARCHIVE_NAME"
accessible=false
# Do not send GH_TOKEN here: updater clients must be able to fetch the payload
# anonymously, including after the repository moves to its public OSS home.
for attempt in 1 2 3 4 5; do
  if curl -fL --retry 2 --retry-all-errors \
    -H 'Cache-Control: no-cache' \
    -o "$PUBLIC_COPY" "${ARCHIVE_URL}?run=${GITHUB_RUN_ID:-manual}-${attempt}"; then
    PUBLIC_DIGEST="$(shasum -a 256 "$PUBLIC_COPY" | awk '{print $1}')"
    if [[ "$PUBLIC_DIGEST" == "$EXPECTED_DIGEST" ]]; then
      accessible=true
      break
    fi
  fi
  sleep "${BERD_PROMOTION_RETRY_DELAY_SECONDS:-10}"
done
[[ "$accessible" == "true" ]] || {
  echo "rolling archive was not publicly accessible with the staged digest: $ARCHIVE_URL" >&2
  exit 1
}

"$REPO_ROOT/scripts/release/generate-latest-json.sh" \
  "$VERSION" "$PLATFORM" "$WORK_DIR/$ARCHIVE_NAME.sig" "$ARCHIVE_URL" \
  "Berd v$VERSION" > "$WORK_DIR/latest.json"
jq -e \
  --arg version "$VERSION" \
  --arg platform "$PLATFORM" \
  --arg url "$ARCHIVE_URL" \
  '.version == $version and .platforms[$platform].url == $url and (.platforms[$platform].signature | length > 0)' \
  "$WORK_DIR/latest.json" >/dev/null

# This is the channel mutation. It is deliberately last so any earlier failure
# leaves installed clients on the previous known-good manifest.
gh release upload "$ROLLING_TAG" --repo "$REPOSITORY" --clobber "$WORK_DIR/latest.json"

MANIFEST_URL="$ROLLING_BASE/latest.json"
manifest_verified=false
for attempt in 1 2 3 4 5; do
  if curl -fL --retry 2 --retry-all-errors \
    -H 'Cache-Control: no-cache' \
    -o "$WORK_DIR/published-latest.json" \
    "${MANIFEST_URL}?run=${GITHUB_RUN_ID:-manual}-${attempt}" \
    && jq -e --arg version "$VERSION" --arg platform "$PLATFORM" --arg url "$ARCHIVE_URL" \
      '.version == $version and .platforms[$platform].url == $url' \
      "$WORK_DIR/published-latest.json" >/dev/null; then
    manifest_verified=true
    break
  fi
  sleep "${BERD_PROMOTION_RETRY_DELAY_SECONDS:-10}"
done
[[ "$manifest_verified" == "true" ]] || {
  echo "published latest.json could not be verified: $MANIFEST_URL" >&2
  exit 1
}

cat > "$SUMMARY_PATH" <<SUMMARY
- Promoted version: \`$VERSION\`
- Source commit: \`$SOURCE_SHA\`
- Updater SHA-256: \`$EXPECTED_DIGEST\`
- Updater URL: $ARCHIVE_URL
- Manifest URL: $MANIFEST_URL
SUMMARY
printf 'version=%s\ndigest=%s\narchive_url=%s\nmanifest_url=%s\n' \
  "$VERSION" "$EXPECTED_DIGEST" "$ARCHIVE_URL" "$MANIFEST_URL"
