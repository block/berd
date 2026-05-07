#!/usr/bin/env bash
set -euo pipefail

repo_root() {
  git rev-parse --show-toplevel 2>/dev/null || pwd
}

section() {
  local title="$1"
  if [[ -n "${BUILDKITE:-}" ]]; then
    echo "--- ${title}"
  else
    echo
    echo "==> ${title}"
  fi
}

ensure_pnpm() {
  if command -v pnpm >/dev/null 2>&1; then
    return
  fi

  if command -v corepack >/dev/null 2>&1; then
    corepack enable
    corepack prepare pnpm@10.33.0 --activate
    return
  fi

  echo "pnpm is required but was not found, and corepack is unavailable." >&2
  exit 1
}

pnpm_install() {
  section "Install pnpm dependencies"
  ensure_pnpm
  pnpm install --frozen-lockfile
}

build_sdk() {
  section "Build vendored @aaif/goose-sdk"
  pnpm --filter @aaif/goose-sdk build
}

with_tauri_sidecars_disabled() {
  TAURI_CONFIG='{"bundle":{"externalBin":[]}}' "$@"
}
