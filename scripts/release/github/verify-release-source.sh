#!/usr/bin/env bash
# Verify the immutable, annotated, main-reachable source before creating a release.
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
validate_repository "$REPOSITORY"
validate_release_tag "$TAG"
validate_release_version "$VERSION"
validate_source_sha "$SOURCE_SHA"
[[ "$TAG" == "v$VERSION" ]] || release_error "tag/version mismatch: $TAG vs $VERSION"
validate_minimum_public_version "$VERSION" "${BERD_RELEASE_CHANNEL_CONFIG:-}"
[[ "$REPOSITORY" == "$RELEASE_REPOSITORY" ]] ||
  release_error "release repository mismatch: $REPOSITORY vs $RELEASE_REPOSITORY"

[[ "$(git rev-parse 'HEAD^{commit}')" == "$SOURCE_SHA" ]] ||
  release_error "HEAD does not match release source $SOURCE_SHA"
[[ "$(git cat-file -t "refs/tags/$TAG")" == "tag" ]] ||
  release_error "release tag must be annotated: $TAG"
LOCAL_TAG_OBJECT="$(git rev-parse "refs/tags/$TAG")"
[[ "$(git rev-parse "refs/tags/$TAG^{commit}")" == "$SOURCE_SHA" ]] ||
  release_error "release tag does not target $SOURCE_SHA"
git merge-base --is-ancestor "$SOURCE_SHA" refs/remotes/origin/main ||
  release_error "release source is not reachable from origin/main"

REMOTE_REF="$(gh api "repos/$REPOSITORY/git/ref/tags/$TAG")"
REMOTE_TYPE="$(jq -r '.object.type' <<< "$REMOTE_REF")"
REMOTE_TAG_OBJECT="$(jq -r '.object.sha' <<< "$REMOTE_REF")"
[[ "$REMOTE_TYPE" == "tag" ]] ||
  release_error "GitHub release tag must be annotated: $TAG"
[[ "$REMOTE_TAG_OBJECT" == "$LOCAL_TAG_OBJECT" ]] ||
  release_error "local and GitHub tag objects disagree for $TAG"

TAG_OBJECT="$(gh api "repos/$REPOSITORY/git/tags/$REMOTE_TAG_OBJECT")"
[[ "$(jq -r '.object.type' <<< "$TAG_OBJECT")" == "commit" ]] ||
  release_error "release tag must target a commit"
[[ "$(jq -r '.object.sha' <<< "$TAG_OBJECT")" == "$SOURCE_SHA" ]] ||
  release_error "GitHub release tag does not target $SOURCE_SHA"
echo "verified annotated $TAG at $SOURCE_SHA on origin/main"
