#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "scripts/build_linux.sh must run on Linux." >&2
  exit 1
fi

require() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "required tool missing: $1" >&2
    exit 1
  fi
}

require just
require pnpm
require cargo
require rustc
require jq

# Tauri reads src-tauri/tauri.conf.json and emits the configured Linux bundles:
# deb and AppImage. System packages such as webkitgtk, librsvg, and appimage
# tooling still need to be provided by the Linux builder image.
exec just bundle
