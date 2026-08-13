#!/usr/bin/env bash
# Shared helpers for Berd release scripts.
#
# Source from any script: `source "$(dirname "$0")/lib.sh"`
#
# Provides:
#   - REPO_ROOT, RELEASE_DIR paths
#   - APP_NAME, APP_BUNDLE_NAME constants
#   - release_input(key) Reads an uppercased environment input.
#   - activate_hermit    Sources ./bin/activate-hermit so pinned node/pnpm/rust
#                        tools are on PATH.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RELEASE_DIR="${REPO_ROOT}/release"

APP_NAME="berd"
APP_BUNDLE_NAME="Berd"

BERD_REPO="${BERD_REPO:-${GITHUB_REPOSITORY:-}}"
if [[ -z "$BERD_REPO" && -f "$REPO_ROOT/scripts/release/release-channel.json" ]]; then
  BERD_REPO="$(jq -er .repository "$REPO_ROOT/scripts/release/release-channel.json")"
fi
if [[ -z "$BERD_REPO" ]]; then
  echo "BERD_REPO must be configured for release publishing" >&2
  return 1 2>/dev/null || exit 1
fi

release_input() {
  local key="$1"
  local env_name
  env_name="$(echo "$key" | tr '[:lower:]' '[:upper:]')"
  if [[ -n "${!env_name:-}" ]]; then
    printf '%s' "${!env_name}"
  else
    echo "Missing $env_name" >&2
    return 1
  fi
}

activate_hermit() {
  # shellcheck source=/dev/null
  . "$REPO_ROOT/bin/activate-hermit"
}

RELEASE_PLATFORM_PATTERN='^(darwin-(aarch64|x86_64)|windows-x86_64|linux-x86_64)$'
REPOSITORY_PATTERN='^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'
ROLLING_TAG_PATTERN='^[A-Za-z0-9_.-]+$'
SOURCE_SHA_PATTERN='^[0-9a-f]{40}$'

release_error() {
  echo "$*" >&2
  return 1
}

trim_whitespace() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

validate_release_version() {
  local version="$1"
  node "$REPO_ROOT/scripts/release/version.mjs" validate "$version" >/dev/null ||
    release_error "refusing to use non-canonical semver without build metadata: $version"
}

validate_release_channel() {
  local channel="$1"
  case "$channel" in
    public|internal|disabled) ;;
    *) release_error "release channel must be public, internal, or disabled: $channel" ;;
  esac
}

validate_release_tag() {
  local tag="$1"
  if [[ "$tag" != v* ]]; then
    release_error "invalid release tag: $tag"
    return 1
  fi
  validate_release_version "${tag#v}" || {
    release_error "invalid release tag: $tag"
    return 1
  }
}

validate_release_platform() {
  local platform="$1"
  [[ "$platform" =~ $RELEASE_PLATFORM_PATTERN ]] ||
    release_error "unsupported updater platform: $platform"
}

validate_repository() {
  local repository="$1"
  [[ "$repository" =~ $REPOSITORY_PATTERN ]] ||
    release_error "invalid release repository: $repository"
}

validate_rolling_tag() {
  local tag="$1"
  [[ "$tag" =~ $ROLLING_TAG_PATTERN ]] ||
    release_error "invalid rolling release tag: $tag"
}

validate_source_sha() {
  local source_sha="$1"
  [[ "$source_sha" =~ $SOURCE_SHA_PATTERN ]] ||
    release_error "invalid source SHA: $source_sha"
}

release_archive_name() {
  local version="$1"
  local platform="$2"
  validate_release_version "$version" || return 1
  validate_release_platform "$platform" || return 1
  case "$platform" in
    darwin-*)
      printf '%s_%s_%s.app.tar.gz' "$APP_BUNDLE_NAME" "$version" "$platform"
      ;;
    windows-*)
      printf '%s_%s_%s-setup.nsis.zip' "$APP_BUNDLE_NAME" "$version" "$platform"
      ;;
    linux-*)
      printf '%s_%s_%s.AppImage.tar.gz' "$APP_BUNDLE_NAME" "$version" "$platform"
      ;;
    *)
      release_error "no updater archive naming for platform: $platform"
      ;;
  esac
}

release_provenance_name() {
  local version="$1"
  local platform="$2"
  validate_release_version "$version" || return 1
  validate_release_platform "$platform" || return 1
  printf '%s_%s_%s.provenance.json' "$APP_BUNDLE_NAME" "$version" "$platform"
}

release_installer_name() {
  local version="$1"
  local platform="$2"
  validate_release_version "$version" || return 1
  validate_release_platform "$platform" || return 1
  case "$platform" in
    windows-*)
      printf '%s_%s_%s-setup.exe' "$APP_BUNDLE_NAME" "$version" "$platform"
      ;;
    linux-*)
      printf '%s_%s_%s.AppImage' "$APP_BUNDLE_NAME" "$version" "$platform"
      ;;
    *)
      release_error "no installer naming for platform: $platform"
      ;;
  esac
}

load_release_channel() {
  local config="${1:-}"
  if [[ -z "$config" ]]; then
    config="$REPO_ROOT/scripts/release/release-channel.json"
  fi
  RELEASE_REPOSITORY="$(jq -er '.repository' "$config")"
  RELEASE_ROLLING_TAG="$(jq -er '.rollingTag' "$config")"
  RELEASE_MINIMUM_PUBLIC_VERSION="$(jq -er '.minimumPublicVersion' "$config")"
  RELEASE_PLATFORMS=()
  while IFS= read -r platform; do
    [[ -n "$platform" ]] && RELEASE_PLATFORMS+=("$platform")
  done < <(
    jq -er \
      '
        .platforms
        | if type == "array" and length > 0 then
            .[]
          else
            error("platforms must be a non-empty array")
          end
      ' \
      "$config"
  )
  validate_repository "$RELEASE_REPOSITORY"
  validate_rolling_tag "$RELEASE_ROLLING_TAG"
  validate_release_version "$RELEASE_MINIMUM_PUBLIC_VERSION"
  local platform seen_platforms='|'
  for platform in "${RELEASE_PLATFORMS[@]}"; do
    validate_release_platform "$platform" || return 1
    [[ "$seen_platforms" != *"|$platform|"* ]] || {
      release_error "duplicate release platform: $platform"
      return 1
    }
    seen_platforms="${seen_platforms}${platform}|"
  done
}

validate_minimum_public_version() {
  local version="$1"
  local config="${2:-}"
  load_release_channel "$config"
  node "$REPO_ROOT/scripts/release/version.mjs" at-least \
    "$version" "$RELEASE_MINIMUM_PUBLIC_VERSION"
}

release_input_version() {
  local version
  version="$(release_input version)"
  validate_release_version "$version" || return 1
  printf '%s' "$version"
}

release_build_kind() {
  local build_kind
  build_kind="${BUILD_KIND:-}"
  build_kind="$(trim_whitespace "$build_kind")"
  if [[ -z "$build_kind" ]]; then
    build_kind="$(release_input build_kind 2>/dev/null || true)"
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

default_bundled_agents() {
  local build_kind="${1:-}"
  [[ -n "$build_kind" ]] || build_kind="$(release_build_kind)"

  case "$build_kind" in
    official|custom)
      # Berdy already lives under distro/agents and is bundled on every
      # platform. Release-only agents must be selected explicitly.
      return 0
      ;;
    *)
      echo "invalid build_kind '${build_kind}' (expected official or custom)" >&2
      return 1
      ;;
  esac
}

custom_build_name() {
  local custom_name
  custom_name="$(release_input custom_name 2>/dev/null || true)"
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
# Official builds (the default) echo `VERSION` unchanged. Custom builds
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
