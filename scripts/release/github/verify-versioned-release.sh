#!/usr/bin/env bash
# Verify that an existing versioned GitHub release still identifies the expected
# immutable source tag/commit and exposes exactly the staged release asset set.
set -euo pipefail
[[ $# -eq 2 ]] || {
  echo "Usage: $0 <v-prefixed-tag> <expected-source-sha>" >&2
  exit 2
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/release/lib.sh
source "$SCRIPT_DIR/../lib.sh"
TAG="$1"
SOURCE_SHA="$2"
: "${GH_TOKEN:?GH_TOKEN is required}"
: "${REPOSITORY:?REPOSITORY is required}"
: "${VERSION:?VERSION is required}"
: "${PLATFORM:?PLATFORM is required}"
validate_release_tag "$TAG" || exit 1
validate_release_version "$VERSION" || exit 1
validate_release_platform "$PLATFORM" || exit 1
validate_repository "$REPOSITORY" || exit 1
validate_source_sha "$SOURCE_SHA" || exit 1
[[ "$TAG" == "v$VERSION" ]] || { echo "tag/version mismatch: $TAG vs $VERSION" >&2; exit 1; }

RELEASE_JSON="$(mktemp)"
trap 'rm -f "$RELEASE_JSON"' EXIT
gh release view "$TAG" --repo "$REPOSITORY" \
  --json tagName,isDraft,assets > "$RELEASE_JSON"

jq -e --arg tag "$TAG" '
  .tagName == $tag and
  .isDraft == false and
  (([.assets[].name] | length) == ([.assets[].name] | unique | length))
' "$RELEASE_JSON" >/dev/null || {
  echo "versioned release is draft, has the wrong tag, or has duplicate asset names: $TAG" >&2
  exit 1
}

REMOTE_TAG_SHA="$(gh api "repos/$REPOSITORY/git/ref/tags/$TAG" --jq .object.sha)"
REMOTE_TAG_TYPE="$(gh api "repos/$REPOSITORY/git/ref/tags/$TAG" --jq .object.type)"
if [[ "$REMOTE_TAG_TYPE" == "tag" ]]; then
  REMOTE_TAG_SHA="$(gh api "repos/$REPOSITORY/git/tags/$REMOTE_TAG_SHA" --jq .object.sha)"
fi
[[ "$REMOTE_TAG_SHA" == "$SOURCE_SHA" ]] || {
  echo "remote tag $TAG resolves to $REMOTE_TAG_SHA, expected $SOURCE_SHA" >&2
  exit 1
}

ARCHIVE_NAME="$(release_archive_name "$VERSION" "$PLATFORM")"
for name in \
  "Berd_${VERSION}_${PLATFORM}.app.zip" \
  "Berd_${VERSION}_${PLATFORM}.dmg" \
  "$ARCHIVE_NAME" \
  "$ARCHIVE_NAME.sig" \
  "$ARCHIVE_NAME.sha256"; do
  count="$(jq --arg name "$name" '[.assets[] | select(.name == $name)] | length' "$RELEASE_JSON")"
  [[ "$count" == "1" ]] || {
    echo "versioned release must contain exactly one non-empty asset named $name" >&2
    exit 1
  }
  size="$(jq -r --arg name "$name" '.assets[] | select(.name == $name) | .size' "$RELEASE_JSON")"
  [[ "$size" =~ ^[1-9][0-9]*$ ]] || {
    echo "versioned release asset is empty: $name" >&2
    exit 1
  }
done

echo "verified versioned release $TAG at $SOURCE_SHA"
