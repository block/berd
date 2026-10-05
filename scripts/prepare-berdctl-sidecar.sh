#!/usr/bin/env bash
# Build and stage Berd's CLIs for Tauri externalBin bundling.
#
# Tauri expects external binaries to be present at build time with the target
# triple appended to the configured stem. For config
#   "externalBin": ["binaries/berdctl"]
# this script creates:
#   src-tauri/binaries/berdctl-<triple>

set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: scripts/prepare-berdctl-sidecar.sh [target-triple]

Builds the berdctl and berd-monitor workspace crates in release mode, plus
berd-call for macOS targets, and copies their binaries with the triple suffix
required by Tauri.

The triple defaults to the rustc host. Pass it explicitly (or set
BERDCTL_TRIPLE) when the Tauri build itself uses an explicit --target, so
the staged name matches the triple Tauri resolves (e.g. aarch64-apple-darwin
in release CI).

Set BERD_CALL_BUNDLE=0 only for the dev profile, which has no externalBin,
to skip linking the standalone berd-call binary during routine app startup.
USAGE
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

EXPLICIT_TRIPLE="${1:-${BERDCTL_TRIPLE:-}}"
CARGO_ARGS=(build -p berdctl -p berd-monitor --release)
if [[ "${VITE_FEEDBACK:-0}" == "1" ]]; then
  CARGO_ARGS+=(--features berdctl/block-feedback)
fi
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
BUNDLE_BERD_CALL=0
if [[ "$TRIPLE" == *apple-darwin && "${BERD_CALL_BUNDLE:-1}" == "1" ]]; then
  BUNDLE_BERD_CALL=1
  CARGO_ARGS+=(-p berd-call)
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

OUT_DIR="src-tauri/binaries"
mkdir -p "$OUT_DIR"

stage_cli() {
  local name="$1" built out
  # Cargo nests output under the triple only when --target is passed.
  if [[ -n "$EXPLICIT_TRIPLE" ]]; then
    built="$TARGET_DIR/$TRIPLE/release/$name"
  else
    built="$TARGET_DIR/release/$name"
  fi
  if [[ ! -x "$built" ]]; then
    echo "Built $name binary not found at: $built" >&2
    exit 1
  fi
  out="$OUT_DIR/$name-$TRIPLE"
  cp "$built" "$out"
  chmod +x "$out"
  echo "Staged $name sidecar: $out"
}

stage_cli berdctl
if [[ "$BUNDLE_BERD_CALL" == "1" ]]; then
  stage_cli berd-call
fi
stage_cli berd-monitor
