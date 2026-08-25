#!/usr/bin/env bash
set -euo pipefail

if [[ -n "${BERD_TAURI_CARGO_TARGET_DIR:-}" ]]; then
  printf '%s\n' "$BERD_TAURI_CARGO_TARGET_DIR"
else
  # Cargo coordinates writers inside one target directory. Keep the default
  # checkout-local so concurrent worktrees can build without blocking.
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  printf '%s/src-tauri/target\n' "$(dirname "$script_dir")"
fi
