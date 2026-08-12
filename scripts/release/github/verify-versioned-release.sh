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
if [[ "$TAG" != "v$VERSION" ]]; then
  release_error "tag/version mismatch: $TAG vs $VERSION"
  exit 1
fi

WORK_DIR="$(mktemp -d)"
RELEASE_JSON="$WORK_DIR/release.json"
trap 'rm -rf "$WORK_DIR"' EXIT
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
if [[ "$REMOTE_TAG_SHA" != "$SOURCE_SHA" ]]; then
  release_error "remote tag $TAG resolves to $REMOTE_TAG_SHA, expected $SOURCE_SHA"
  exit 1
fi

ARCHIVE_NAME="$(release_archive_name "$VERSION" "$PLATFORM")"
PROVENANCE_NAME="$(release_provenance_name "$VERSION" "$PLATFORM")"
case "$PLATFORM" in
  darwin-*)
    EXPECTED_ASSETS=(
      "Berd_${VERSION}_${PLATFORM}.app.zip"
      "Berd_${VERSION}_${PLATFORM}.dmg"
    )
    ;;
  windows-*)
    EXPECTED_ASSETS=("$(release_installer_name "$VERSION" "$PLATFORM")")
    ;;
  linux-*)
    EXPECTED_ASSETS=(
      "Berd_${VERSION}_${PLATFORM}.AppImage"
      "Berd_${VERSION}_${PLATFORM}.deb"
      "Berd_${VERSION}_${PLATFORM}.rpm"
    )
    ;;
  *)
    echo "no versioned release asset set for platform: $PLATFORM" >&2
    exit 1
    ;;
esac
EXPECTED_ASSETS+=("$ARCHIVE_NAME" "$ARCHIVE_NAME.sig" "$ARCHIVE_NAME.sha256" "$PROVENANCE_NAME")
for name in "${EXPECTED_ASSETS[@]}"; do
  count="$(jq --arg name "$name" '[.assets[] | select(.name == $name)] | length' "$RELEASE_JSON")"
  if [[ "$count" != "1" ]]; then
    release_error "versioned release must contain exactly one non-empty asset named $name"
    exit 1
  fi
  size="$(jq -r --arg name "$name" '.assets[] | select(.name == $name) | .size' "$RELEASE_JSON")"
  if [[ ! "$size" =~ ^[1-9][0-9]*$ ]]; then
    release_error "versioned release asset is empty: $name"
    exit 1
  fi
  local_asset="$WORK_DIR/$name"
  gh release download "$TAG" --repo "$REPOSITORY" --pattern "$name" --output "$local_asset"
  if [[ ! -s "$local_asset" ]]; then
    release_error "downloaded versioned release asset is empty: $name"
    exit 1
  fi
done

PROVENANCE="$WORK_DIR/$PROVENANCE_NAME"
if ! jq -e \
  --arg source_sha "$SOURCE_SHA" \
  --arg version "$VERSION" \
  --arg platform "$PLATFORM" \
  '.schemaVersion == 1 and .sourceSha == $source_sha and .version == $version and .platform == $platform and (.artifacts | type == "object")' \
  "$PROVENANCE" >/dev/null; then
  release_error "invalid tag-bound provenance receipt: $PROVENANCE_NAME"
  exit 1
fi
for name in "${EXPECTED_ASSETS[@]}"; do
  [[ "$name" == "$PROVENANCE_NAME" ]] && continue
  expected_digest="$(jq -er --arg name "$name" '.artifacts[$name]' "$PROVENANCE")" || {
    release_error "provenance receipt omits release asset: $name"
    exit 1
  }
  actual_digest="$(shasum -a 256 "$WORK_DIR/$name" | awk '{print $1}')"
  if [[ ! "$expected_digest" =~ ^[0-9a-f]{64}$ || "$actual_digest" != "$expected_digest" ]]; then
    release_error "provenance digest mismatch: $name"
    exit 1
  fi
done
gh attestation verify "$PROVENANCE" \
  --repo "$REPOSITORY" \
  --signer-workflow "$REPOSITORY/.github/workflows/release.yml" \
  --source-digest "$SOURCE_SHA" \
  --source-ref "refs/tags/$TAG" \
  --deny-self-hosted-runners >/dev/null || {
    release_error "release provenance is not bound to the requested source tag"
    exit 1
  }

echo "verified versioned release $TAG at $SOURCE_SHA"
