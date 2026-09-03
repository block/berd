#!/usr/bin/env bash
# Build and stage the berd-memory MCP server for Tauri's externalBin bundling.
#
# Tauri expects external binaries to be present at build time with the target
# triple appended to the configured stem. For config
#   "externalBin": ["binaries/berd-memory-mcp"]
# this script creates:
#   src-tauri/binaries/berd-memory-mcp-<triple>

set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: scripts/prepare-memory-sidecar.sh [target-triple]

Builds the berd-memory workspace crate in release mode and copies the binary
into src-tauri/binaries with the target triple suffix required by Tauri.

The triple defaults to the rustc host. Pass it explicitly (or set
BERD_MEMORY_TRIPLE) when the Tauri build itself uses an explicit --target, so
the staged name matches the triple Tauri resolves (e.g. aarch64-apple-darwin
in release CI).
USAGE
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

EXPLICIT_TRIPLE="${1:-${BERD_MEMORY_TRIPLE:-}}"
CARGO_ARGS=(build -p berd-memory --release)
if [[ -n "$EXPLICIT_TRIPLE" ]]; then
  TRIPLE="$EXPLICIT_TRIPLE"
  CARGO_ARGS+=(--target "$TRIPLE")
else
  TRIPLE="$(rustc -vV | sed -n 's|host: ||p')"
  if [[ -z "$TRIPLE" ]]; then
    echo "Could not determine rust host target." >&2
    exit 1
  fi
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

OUT_DIR="src-tauri/binaries"
OUT="$OUT_DIR/berd-memory-mcp-$TRIPLE"
mkdir -p "$OUT_DIR"
cp "$BUILT" "$OUT"
chmod +x "$OUT"
echo "Staged berd-memory-mcp sidecar: $OUT"
