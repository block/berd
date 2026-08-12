#!/usr/bin/env bash
# Report complete staged platform payloads and remove every asset in a partial
# platform payload so recovery always starts that platform from a clean slate.
set -euo pipefail

[[ $# -eq 4 ]] || {
  echo "Usage: $0 <repository> <v-prefixed-tag> <version> <output-file>" >&2
  exit 2
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/release/lib.sh
source "$SCRIPT_DIR/../lib.sh"
REPOSITORY="$1"
TAG="$2"
VERSION="$3"
OUTPUT_FILE="$4"

: "${GH_TOKEN:?GH_TOKEN is required}"
validate_repository "$REPOSITORY" || exit 1
validate_release_tag "$TAG" || exit 1
validate_release_version "$VERSION" || exit 1
[[ "$TAG" == "v$VERSION" ]] || {
  release_error "tag/version mismatch: $TAG vs $VERSION"
  exit 1
}
[[ -n "$OUTPUT_FILE" ]] || {
  release_error "output file must not be empty"
  exit 1
}

release_assets="$(gh release view "$TAG" --repo "$REPOSITORY" --json assets --jq '.assets[].name')"

platform_assets() {
  local platform="$1"
  local archive provenance
  validate_release_platform "$platform" || return 1
  archive="$(release_archive_name "$VERSION" "$platform")"
  provenance="$(release_provenance_name "$VERSION" "$platform")"
  case "$platform" in
    darwin-*)
      printf '%s\n' \
        "Berd_${VERSION}_${platform}.app.zip" \
        "Berd_${VERSION}_${platform}.dmg"
      ;;
    windows-*)
      release_installer_name "$VERSION" "$platform"
      ;;
    linux-*)
      printf '%s\n' \
        "Berd_${VERSION}_${platform}.AppImage" \
        "Berd_${VERSION}_${platform}.deb" \
        "Berd_${VERSION}_${platform}.rpm"
      ;;
  esac
  printf '%s\n' "$archive" "$archive.sig" "$archive.sha256" "$provenance"
}

check_platform() {
  local output="$1"
  local platform="$2"
  local ready=true present=0 name
  local -a expected_assets=() present_assets=()
  while IFS= read -r name; do
    [[ -n "$name" ]] && expected_assets+=("$name")
  done < <(platform_assets "$platform")

  for name in "${expected_assets[@]}"; do
    if grep -Fxq "$name" <<< "$release_assets"; then
      present=$((present + 1))
      present_assets+=("$name")
    else
      ready=false
    fi
  done
  if [[ "$ready" != true && "$present" -gt 0 ]]; then
    echo "Removing incomplete $platform payload before a clean recovery rebuild"
    for name in "${present_assets[@]}"; do
      gh release delete-asset "$TAG" "$name" --repo "$REPOSITORY" --yes
    done
  fi
  printf '%s=%s\n' "$output" "$ready" >> "$OUTPUT_FILE"
}

check_platform macos_ready darwin-aarch64
check_platform windows_ready windows-x86_64
check_platform linux_ready linux-x86_64
