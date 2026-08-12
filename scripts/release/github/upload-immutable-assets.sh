#!/usr/bin/env bash
# Upload missing versioned release assets without ever replacing different
# bytes. Recovery is idempotent for assets already present on the release.
set -euo pipefail
[[ $# -ge 3 ]] || {
  echo "Usage: $0 <repository> <tag> <asset>..." >&2
  exit 2
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/release/lib.sh
source "$SCRIPT_DIR/../lib.sh"
REPOSITORY="$1"
TAG="$2"
shift 2
validate_repository "$REPOSITORY"
validate_release_tag "$TAG"

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/berd-immutable-assets.XXXXXX")"
trap 'rm -rf "$WORK_DIR"' EXIT
for asset in "$@"; do
  [[ -f "$asset" ]] || { echo "missing release asset: $asset" >&2; exit 1; }
  name="$(basename "$asset")"
  existing="$WORK_DIR/$name"
  # `$existing` is intentionally absent. `gh release download --output` refuses
  # to overwrite even an empty mktemp-created file.
  if gh release download "$TAG" --repo "$REPOSITORY" --pattern "$name" --output "$existing" 2>/dev/null; then
    cmp --silent "$asset" "$existing" || {
      echo "refusing to replace immutable release asset with different bytes: $name" >&2
      exit 1
    }
    echo "verified existing immutable asset: $name"
  else
    [[ ! -e "$existing" ]] || {
      echo "release download failed after creating an incomplete asset: $name" >&2
      exit 1
    }
    RELEASE_ASSETS="$(gh api "repos/$REPOSITORY/releases/tags/$TAG" --jq '.assets[].name')" || {
      echo "failed to inspect immutable release assets before upload: $name" >&2
      exit 1
    }
    if grep -Fxq "$name" <<< "$RELEASE_ASSETS"; then
      echo "failed to download existing immutable release asset: $name" >&2
      exit 1
    fi
    gh release upload "$TAG" --repo "$REPOSITORY" "$asset"
    echo "uploaded immutable asset: $name"
  fi
  rm -f "$existing"
done
