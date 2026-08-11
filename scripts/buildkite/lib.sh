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

# shellcheck source=scripts/npm-registry.sh
source "$(dirname "${BASH_SOURCE[0]}")/../npm-registry.sh"

pnpm_install() {
  section "Install pnpm dependencies"
  # This must precede ensure_pnpm: Corepack can download pnpm during bootstrap.
  configure_buildkite_npm_registry
  ensure_pnpm
  pnpm install --frozen-lockfile
}

build_sdk() {
  section "Build vendored @aaif/goose-sdk"
  pnpm --filter @aaif/goose-sdk build
}

install_linux_tauri_deps() {
  if [[ "$(uname -s)" != "Linux" ]]; then
    return
  fi

  if command -v pkg-config >/dev/null 2>&1 \
    && pkg-config --exists gobject-2.0 glib-2.0 gtk+-3.0 webkit2gtk-4.1; then
    return
  fi

  if ! command -v apt-get >/dev/null 2>&1; then
    echo "Linux Tauri checks require pkg-config and WebKitGTK development packages." >&2
    echo "Install pkg-config and libwebkit2gtk-4.1-dev, or add support for this distro to scripts/buildkite/lib.sh." >&2
    exit 1
  fi

  local -a sudo_cmd=()
  if [[ "${EUID}" -ne 0 ]]; then
    sudo_cmd=(sudo)
  fi

  section "Install Linux Tauri native dependencies"
  "${sudo_cmd[@]}" apt-get update
  "${sudo_cmd[@]}" apt-get install -y --no-install-recommends \
    pkg-config \
    libwebkit2gtk-4.1-dev \
    libgtk-3-dev \
    libayatana-appindicator3-dev \
    librsvg2-dev
}

with_tauri_sidecars_disabled() {
  TAURI_CONFIG='{"bundle":{"externalBin":[]}}' "$@"
}
