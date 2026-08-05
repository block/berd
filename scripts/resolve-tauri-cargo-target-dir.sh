#!/usr/bin/env bash
set -euo pipefail

if [[ -n "${BERD_TAURI_CARGO_TARGET_DIR:-}" ]]; then
  printf '%s\n' "$BERD_TAURI_CARGO_TARGET_DIR"
elif [[ -n "${XDG_CACHE_HOME:-}" ]]; then
  printf '%s/berd-tauri/cargo-target\n' "$XDG_CACHE_HOME"
elif [[ "$(uname -s)" = "Darwin" ]]; then
  printf '%s/Library/Caches/berd-tauri/cargo-target\n' "$HOME"
else
  printf '%s/.cache/berd-tauri/cargo-target\n' "$HOME"
fi
