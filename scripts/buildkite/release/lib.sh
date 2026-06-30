#!/usr/bin/env bash
# Shared helpers for Berd release scripts.
#
# Source from any script: `source "$(dirname "$0")/lib.sh"`
#
# Provides:
#   - REPO_ROOT, RELEASE_DIR paths
#   - APP_NAME, APP_BUNDLE_NAME constants
#   - meta(key)         Reads Buildkite meta-data in Buildkite, falling back to
#                       the uppercased env var so scripts also run locally.
#   - activate_hermit   Sources ./bin/activate-hermit so pinned node/pnpm/rust
#                       tools are on PATH.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
RELEASE_DIR="${REPO_ROOT}/release"

APP_NAME="berd"
APP_BUNDLE_NAME="Berd"

BERD_REPO="${BERD_REPO:-squareup/berd}"

meta() {
  local key="$1"
  local env_name
  env_name="$(echo "$key" | tr '[:lower:]' '[:upper:]')"
  if [[ -n "${BUILDKITE:-}" ]] && command -v buildkite-agent >/dev/null 2>&1; then
    buildkite-agent meta-data get "$key"
  elif [[ -n "${!env_name:-}" ]]; then
    printf '%s' "${!env_name}"
  else
    # Return (don't exit) so callers can supply a default with
    # `meta key 2>/dev/null || echo default` — `exit` here would terminate the
    # enclosing $(...) subshell before the `||` ran. Callers of required keys
    # (`X="$(meta version)"`) still abort under `set -e` on this non-zero status.
    echo "Missing $env_name (no Buildkite meta-data available)" >&2
    return 1
  fi
}

activate_hermit() {
  # shellcheck source=/dev/null
  . "$REPO_ROOT/bin/activate-hermit"
}

trim_whitespace() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

validate_release_version() {
  local version="$1"
  if [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z][0-9A-Za-z.-]*)?(\+[0-9A-Za-z][0-9A-Za-z.-]*)?$ ]]; then
    return 0
  fi
  echo "refusing to stamp non-semver version: $version" >&2
  return 1
}

release_input_version() {
  local version
  version="$(meta version)"
  validate_release_version "$version" || return 1
  printf '%s' "$version"
}

release_build_kind() {
  local build_kind
  build_kind="${BUILD_KIND:-}"
  build_kind="$(trim_whitespace "$build_kind")"
  if [[ -z "$build_kind" ]]; then
    build_kind="$(meta build_kind 2>/dev/null || true)"
    build_kind="$(trim_whitespace "$build_kind")"
  fi
  [[ -n "$build_kind" ]] || build_kind="official"

  case "$build_kind" in
    official|custom)
      printf '%s' "$build_kind"
      ;;
    *)
      echo "invalid build_kind '${build_kind}' (expected official or custom)" >&2
      return 1
      ;;
  esac
}

custom_build_name() {
  local custom_name
  custom_name="$(meta custom_name 2>/dev/null || true)"
  custom_name="$(trim_whitespace "$custom_name")"
  if [[ ! "$custom_name" =~ ^[a-z0-9][a-z0-9-]*$ ]]; then
    echo "custom builds require a lowercase slug custom_name (^[a-z0-9][a-z0-9-]*\$); got: '${custom_name}'" >&2
    return 1
  fi
  printf '%s' "$custom_name"
}

validate_custom_config_override() {
  local path="$1"
  local unknown_keys
  unknown_keys="$(
    jq -r '
      if type != "object" then
        "<non-object>"
      else
        (keys_unsorted - ["featureToggles", "doctor", "feedback"]) | join(", ")
      end
    ' "$path"
  )" || return 1

  if [[ -n "$unknown_keys" ]]; then
    echo "custom_config may only override featureToggles, doctor, or feedback; rejected keys: ${unknown_keys}" >&2
    return 1
  fi
}

# Resolve the version to stamp, applying the custom-build name suffix.
#
# Official builds (the default) echo `meta version` unchanged. Custom builds
# echo `<version>-<custom_name>` so the suffix flows into the .app version,
# custom artifact filenames, and any custom-only publishing path.
# `custom_name` is slug-validated so the result is always valid semver (the
# `-suffix` form build-macos.sh's regex already permits). build-macos.sh and
# release-version.sh both call this so the stamped version and externally
# reported version always agree.
resolve_release_version() {
  local version build_kind custom_name resolved
  version="$(release_input_version)"
  build_kind="$(release_build_kind)"
  if [[ "$build_kind" == "custom" ]]; then
    custom_name="$(custom_build_name)"
    resolved="${version}-${custom_name}"
  else
    resolved="$version"
  fi
  validate_release_version "$resolved" || return 1
  printf '%s' "$resolved"
}

mkdir -p "$RELEASE_DIR"
