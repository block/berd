#!/usr/bin/env bash
# Stage a Goose binary for Tauri's externalBin bundling.
#
# Tauri expects external binaries to be present at build time with the host
# target triple appended to the configured stem. For config
#   "externalBin": ["binaries/goosed"]
# this script creates:
#   src-tauri/binaries/goosed-$(rustc -vV | sed -n 's|host: ||p')

set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: scripts/prepare-goose-sidecar.sh [path/to/goose]

If no path is passed, GOOSE_BIN is used. If GOOSE_BIN is unset, the script
builds (or reuses) the pinned managed Goose binary through
scripts/ensure-local-goose.sh. That shared path validates and applies the
ordered patches in patches/goose before returning a binary, so development and
release bundles stage the same backend source. The binary is copied into
src-tauri/binaries with the host target triple suffix required by Tauri.
USAGE
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

GOOSE_SOURCE="${1:-${GOOSE_BIN:-}}"
if [[ -z "$GOOSE_SOURCE" ]]; then
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  GOOSE_SOURCE="$(GOOSE_DEV_MODE=required "$script_dir/ensure-local-goose.sh" --print-bin)"
fi

if [[ ! -x "$GOOSE_SOURCE" ]]; then
  echo "Goose binary is not executable: $GOOSE_SOURCE" >&2
  exit 1
fi

TARGET="$(rustc -vV | sed -n 's|host: ||p')"
if [[ -z "$TARGET" ]]; then
  echo "Could not determine rust host target." >&2
  exit 1
fi

OUT_DIR="src-tauri/binaries"
OUT="$OUT_DIR/goosed-$TARGET"
mkdir -p "$OUT_DIR"
cp "$GOOSE_SOURCE" "$OUT"
chmod +x "$OUT"
echo "Staged Goose sidecar: $OUT"
