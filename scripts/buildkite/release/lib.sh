#!/usr/bin/env bash
# Shared helpers for Berd release scripts.
#
# Source from any script: `source "$(dirname "$0")/lib.sh"`
#
# Provides:
#   - REPO_ROOT, RELEASE_DIR paths
#   - APP_NAME, APP_BUNDLE_NAME constants
#   - meta(key)         Reads a Buildkite meta-data value, falling back to the
#                       uppercased env var so scripts also run locally.
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
  if [[ -n "${!env_name:-}" ]]; then
    printf '%s' "${!env_name}"
  elif command -v buildkite-agent >/dev/null 2>&1; then
    buildkite-agent meta-data get "$key"
  else
    echo "Missing $env_name (no Buildkite meta-data available)" >&2
    exit 1
  fi
}

activate_hermit() {
  # shellcheck source=/dev/null
  . "$REPO_ROOT/bin/activate-hermit"
}

mkdir -p "$RELEASE_DIR"
