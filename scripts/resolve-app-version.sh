#!/usr/bin/env bash
# Resolve the app version for a build and print shell assignments to stdout:
#
#   BERD_APP_VERSION       plain numeric x.y.z — safe to feed Tauri's `version`
#                           (CFBundleShortVersionString garbles pre-release/+build
#                           suffixes, so this stays strictly numeric).
#   BERD_APP_VERSION_RICH  the most descriptive version string available, for
#                           telemetry and agent context; may carry a
#                           `-dev.<commits>+g<sha>` suffix on non-release builds.
#
# Consume with:  eval "$(scripts/resolve-app-version.sh)"
#
# Precedence:
#   1. Explicit override — first arg, else $BERD_APP_VERSION_OVERRIDE. The
#      release pipeline owns the version, so it can pass the operator-entered
#      value straight through.
#   2. git describe --tags — the latest vX.Y.Z tag. When the build is ahead of
#      or dirty against that tag, patch-bump (Z+1) and append the dev suffix so a
#      locally built bundle reads as NEWER than the last release. This is what
#      makes the installer-media upgrade prompt testable from a local build.
#   3. package.json version — shallow/no-git checkouts and source tarballs, where
#      `git describe` has nothing to work with.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

emit() {
  printf "BERD_APP_VERSION='%s'\n" "$1"
  printf "BERD_APP_VERSION_RICH='%s'\n" "$2"
}

# 1. Explicit override (release path passes the operator-entered version).
override="${1:-${BERD_APP_VERSION_OVERRIDE:-}}"
if [[ -n "$override" ]]; then
  emit "${override%%[-+]*}" "$override"
  exit 0
fi

# 2. git describe. --long forces the `<tag>-<commits>-g<sha>` form even on a tag.
# --match locks onto release tags so a stray non-semver or prerelease tag (e.g.
# `nightly-…` or `v0.4.13-rc1`) can't become the nearest tag and silently drop
# resolution to the package.json baseline.
describe="$(git -C "$REPO_ROOT" describe --tags --long --dirty --match 'v[0-9]*.[0-9]*.[0-9]*' 2>/dev/null || true)"
if [[ "$describe" =~ ^v?([0-9]+)\.([0-9]+)\.([0-9]+)-([0-9]+)-g([0-9a-f]+)(-dirty)?$ ]]; then
  major="${BASH_REMATCH[1]}"
  minor="${BASH_REMATCH[2]}"
  patch="${BASH_REMATCH[3]}"
  commits="${BASH_REMATCH[4]}"
  sha="${BASH_REMATCH[5]}"
  dirty="${BASH_REMATCH[6]}"

  if [[ "$commits" == "0" && -z "$dirty" ]]; then
    # Exactly on a release tag — report it verbatim.
    numeric="${major}.${minor}.${patch}"
    emit "$numeric" "$numeric"
    exit 0
  fi

  # Ahead of / dirty against the tag: patch-bump so the build reads as newer.
  numeric="${major}.${minor}.$((patch + 1))"
  rich="${numeric}-dev.${commits}+g${sha}"
  [[ -n "$dirty" ]] && rich="${rich}.dirty"
  emit "$numeric" "$rich"
  exit 0
fi

# 3. package.json fallback.
pkg_version="$(jq -r '.version' "$REPO_ROOT/package.json")"
emit "$pkg_version" "$pkg_version"
