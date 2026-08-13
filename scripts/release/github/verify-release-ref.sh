#!/usr/bin/env bash
# Verify a release checkout is bound to an existing immutable annotated
# v<semver> tag on the canonical remote.
set -euo pipefail
[[ $# -eq 1 ]] || { echo "Usage: $0 <v-prefixed-tag>" >&2; exit 2; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/release/lib.sh
source "$SCRIPT_DIR/../lib.sh"
TAG="$1"
validate_release_tag "$TAG" || exit 1

[[ "$(git cat-file -t "refs/tags/$TAG" 2>/dev/null)" == "tag" ]] || {
  echo "release tag must be annotated: $TAG" >&2
  exit 1
}

HEAD_SHA="$(git rev-parse 'HEAD^{commit}')"
TAG_SHA="$(git rev-parse "refs/tags/${TAG}^{commit}" 2>/dev/null)" || {
  echo "release tag is missing from checkout: $TAG" >&2
  exit 1
}
[[ "$HEAD_SHA" == "$TAG_SHA" ]] || {
  echo "HEAD $HEAD_SHA does not match $TAG commit $TAG_SHA" >&2
  exit 1
}

REMOTE_REFS="$(git ls-remote --exit-code origin "refs/tags/$TAG" "refs/tags/$TAG^{}")" || {
  echo "release tag is missing from origin: $TAG" >&2
  exit 1
}
REMOTE_SHA="$(printf '%s\n' "$REMOTE_REFS" | awk '$2 ~ /\^\{\}$/ {print $1; found=1} END {if (!found) print first} NR == 1 {first=$1}')"
[[ -n "$REMOTE_SHA" && "$REMOTE_SHA" == "$TAG_SHA" ]] || {
  echo "origin $TAG resolves to ${REMOTE_SHA:-<missing>}, expected $TAG_SHA" >&2
  exit 1
}

if [[ "${GITHUB_EVENT_NAME:-}" == "push" && "${GITHUB_REF:-}" != "refs/tags/$TAG" ]]; then
  echo "tag push release must run at refs/tags/$TAG; got ${GITHUB_REF:-<unset>}" >&2
  exit 1
fi

echo "verified refs/tags/$TAG at $HEAD_SHA"
