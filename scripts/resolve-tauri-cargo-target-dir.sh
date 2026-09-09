#!/usr/bin/env bash
set -euo pipefail

scope="${1:-development}"
case "$scope" in
  development|bundle) ;;
  *)
    printf 'Usage: %s [development|bundle]\n' "$0" >&2
    exit 2
    ;;
esac

if [[ -n "${BERD_TAURI_CARGO_TARGET_DIR:-}" ]]; then
  printf '%s\n' "$BERD_TAURI_CARGO_TARGET_DIR"
elif [[ "$scope" == "bundle" && -n "${XDG_CACHE_HOME:-}" ]]; then
  printf '%s/berd-tauri/cargo-target\n' "$XDG_CACHE_HOME"
elif [[ "$scope" == "bundle" && "$(uname -s)" = "Darwin" ]]; then
  printf '%s/Library/Caches/berd-tauri/cargo-target\n' "$HOME"
elif [[ "$scope" == "bundle" ]]; then
  printf '%s/.cache/berd-tauri/cargo-target\n' "$HOME"
else
  # Cargo coordinates writers inside one target directory. Keep the default
  # checkout-local so concurrent worktrees can build without blocking.
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  printf '%s/src-tauri/target\n' "$(dirname "$script_dir")"
fi
