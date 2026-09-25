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

# Cargo nests output under the triple only when --target is passed.
if [[ -n "$EXPLICIT_TRIPLE" ]]; then
  BUILT="$TARGET_DIR/$TRIPLE/release/berdctl"
else
  BUILT="$TARGET_DIR/release/berdctl"
fi

if [[ ! -x "$BUILT" ]]; then
  echo "Built berdctl binary not found at: $BUILT" >&2
  exit 1
fi

OUT_DIR="src-tauri/binaries"
OUT="$OUT_DIR/berdctl-$TRIPLE"
mkdir -p "$OUT_DIR"
cp "$BUILT" "$OUT"
chmod +x "$OUT"
echo "Staged berdctl sidecar: $OUT"

if [[ "$BUNDLE_BERD_CALL" == "1" ]]; then
  if [[ -n "$EXPLICIT_TRIPLE" ]]; then
    CALL_BUILT="$TARGET_DIR/$TRIPLE/release/berd-call"
  else
    CALL_BUILT="$TARGET_DIR/release/berd-call"
  fi
  if [[ ! -x "$CALL_BUILT" ]]; then
    echo "Built berd-call binary not found at: $CALL_BUILT" >&2
    exit 1
  fi
  CALL_OUT="$OUT_DIR/berd-call-$TRIPLE"
  cp "$CALL_BUILT" "$CALL_OUT"
  chmod +x "$CALL_OUT"
  echo "Staged berd-call sidecar: $CALL_OUT"
fi

if [[ -n "$EXPLICIT_TRIPLE" ]]; then
  MONITOR_BUILT="$TARGET_DIR/$TRIPLE/release/berd-monitor"
else
  MONITOR_BUILT="$TARGET_DIR/release/berd-monitor"
fi

if [[ ! -x "$MONITOR_BUILT" ]]; then
  echo "Built berd-monitor binary not found at: $MONITOR_BUILT" >&2
  exit 1
fi

MONITOR_OUT="$OUT_DIR/berd-monitor-$TRIPLE"
cp "$MONITOR_BUILT" "$MONITOR_OUT"
chmod +x "$MONITOR_OUT"
echo "Staged berd-monitor sidecar: $MONITOR_OUT"
