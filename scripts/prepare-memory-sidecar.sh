#!/usr/bin/env bash
# Stage the memory MCP server only for the aarch64-apple-darwin build target.
# Tauri resolves externalBin "binaries/berd-memory-mcp" to a file with the
# triple suffix. Unsupported targets remove any stale staged memory binaries.

set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: scripts/prepare-memory-sidecar.sh [target-triple]

Stages the memory MCP binary only for aarch64-apple-darwin. For any other
compile target, skips Cargo and removes stale staged memory binaries. The
triple defaults to the Rust host for standalone staging; Tauri builds pass
their compile target explicitly.
USAGE
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

EXPLICIT_TRIPLE="${1:-${BERD_MEMORY_TRIPLE:-}}"
TRIPLE="${EXPLICIT_TRIPLE:-$(rustc -vV | sed -n 's|host: ||p')}"
if [[ -z "$TRIPLE" ]]; then
  echo "Could not determine the Rust compile target." >&2
  exit 1
fi

OUT_DIR="src-tauri/binaries"
if [[ "$TRIPLE" != "aarch64-apple-darwin" ]]; then
  # A previous supported build in this checkout must not leak into this one.
  if [[ -d "$OUT_DIR" ]]; then
    find "$OUT_DIR" -maxdepth 1 -type f -name 'berd-memory-mcp*' -delete
  fi
  echo "Skipping unsupported memory target: $TRIPLE"
  exit 0
fi

CARGO_ARGS=(build -p berd-memory --release)
if [[ -n "$EXPLICIT_TRIPLE" ]]; then
  CARGO_ARGS+=(--target "$TRIPLE")
fi
(cd src-tauri && cargo "${CARGO_ARGS[@]}")

# Ask cargo where it actually writes the binary (it honours CARGO_TARGET_DIR
# and any cargo config override) rather than hard-coding src-tauri/target.
# `|| true` keeps a metadata/parse failure on the fallback path below instead
# of aborting the whole script under `set -euo pipefail`.
TARGET_DIR="$(cd src-tauri && cargo metadata --no-deps --format-version 1 2>/dev/null \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("target_directory",""))' 2>/dev/null \
  || true)"
if [[ -z "$TARGET_DIR" ]]; then
  TARGET_DIR="${CARGO_TARGET_DIR:-src-tauri/target}"
fi

# Cargo nests output under the triple only when --target is passed.
if [[ -n "$EXPLICIT_TRIPLE" ]]; then
  BUILT="$TARGET_DIR/$TRIPLE/release/berd-memory-mcp"
else
  BUILT="$TARGET_DIR/release/berd-memory-mcp"
fi

if [[ ! -x "$BUILT" ]]; then
  echo "Built berd-memory-mcp binary not found at: $BUILT" >&2
  exit 1
fi

OUT="$OUT_DIR/berd-memory-mcp-$TRIPLE"
mkdir -p "$OUT_DIR"
cp "$BUILT" "$OUT"
chmod +x "$OUT"
echo "Staged berd-memory-mcp sidecar: $OUT"
