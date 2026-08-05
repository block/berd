#!/usr/bin/env bash
# Buildkite adapter: expose selected pipeline metadata as environment variables
# before invoking the CI-neutral release scripts.
set -euo pipefail

load_buildkite_release_inputs() {
  local key env_name value
  for key in "$@"; do
    env_name="$(printf '%s' "$key" | tr '[:lower:]' '[:upper:]')"
    if [[ -n "${!env_name:-}" ]]; then
      continue
    fi
    value="$(buildkite-agent meta-data get "$key")"
    printf -v "$env_name" '%s' "$value"
    export "$env_name"
  done
}

load_optional_buildkite_release_inputs() {
  local key env_name value
  for key in "$@"; do
    env_name="$(printf '%s' "$key" | tr '[:lower:]' '[:upper:]')"
    if [[ -n "${!env_name:-}" ]]; then
      continue
    fi
    if value="$(buildkite-agent meta-data get "$key" 2>/dev/null)"; then
      printf -v "$env_name" '%s' "$value"
      export "$env_name"
    fi
  done
}
