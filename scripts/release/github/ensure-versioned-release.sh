#!/usr/bin/env bash
# Create the immutable versioned GitHub release when absent and verify that its
# tag still resolves to the expected source commit.
set -euo pipefail

[[ $# -eq 4 ]] || {
  echo "Usage: $0 <repository> <v-prefixed-tag> <version> <source-sha>" >&2
  exit 2
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/release/lib.sh
source "$SCRIPT_DIR/../lib.sh"
REPOSITORY="$1"
TAG="$2"
VERSION="$3"
SOURCE_SHA="$4"

: "${GH_TOKEN:?GH_TOKEN is required}"
validate_repository "$REPOSITORY" || exit 1
validate_release_tag "$TAG" || exit 1
validate_release_version "$VERSION" || exit 1
validate_source_sha "$SOURCE_SHA" || exit 1
[[ "$TAG" == "v$VERSION" ]] || {
  release_error "tag/version mismatch: $TAG vs $VERSION"
  exit 1
}

if gh release view "$TAG" --repo "$REPOSITORY" >/dev/null 2>&1; then
  existing_release="$(gh release view "$TAG" --repo "$REPOSITORY" --json tagName,isDraft)"
  existing_tag="$(jq -r .tagName <<< "$existing_release")"
  is_draft="$(jq -r .isDraft <<< "$existing_release")"
  [[ "$existing_tag" == "$TAG" ]] || {
    release_error "existing release tag mismatch: $existing_tag"
    exit 1
  }
  [[ "$is_draft" == false ]] || {
    release_error "existing versioned release must not be a draft: $TAG"
    exit 1
  }
  echo "Using existing versioned release $TAG"
else
  prerelease=()
  if [[ "$VERSION" == *-* ]]; then
    prerelease=(--prerelease --latest=false)
  fi
  notes="$(printf 'Berd v%s\n\nSource commit: `%s`\n\nThe Windows NSIS installer and Linux packages lack platform-native code signatures; their updater archives remain minisign-authenticated.\n' "$VERSION" "$SOURCE_SHA")"
  gh release create "$TAG" \
    --repo "$REPOSITORY" \
    --verify-tag \
    --target "$SOURCE_SHA" \
    --title "Berd v$VERSION" \
    --notes "$notes" \
    "${prerelease[@]+"${prerelease[@]}"}"
fi

release_tag_ref="$(gh api "repos/$REPOSITORY/git/ref/tags/$TAG" --jq .object.sha)"
release_tag_type="$(gh api "repos/$REPOSITORY/git/ref/tags/$TAG" --jq .object.type)"
if [[ "$release_tag_type" == "tag" ]]; then
  release_tag_ref="$(gh api "repos/$REPOSITORY/git/tags/$release_tag_ref" --jq .object.sha)"
fi
[[ "$release_tag_ref" == "$SOURCE_SHA" ]] || {
  release_error "versioned release $TAG resolves to $release_tag_ref, expected $SOURCE_SHA"
  exit 1
}
