#!/usr/bin/env bash
# Verify a Tauri updater archive using the same minisign-verify crate and
# base64-wrapped key/signature format as tauri-plugin-updater.

set -euo pipefail
[[ $# -eq 3 ]] || {
  echo "Usage: $0 <archive> <signature-file> <tauri-public-key>" >&2
  exit 2
}
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CARGO_TARGET_DIR="${BERD_UPDATER_VERIFY_TARGET_DIR:-${TMPDIR:-/tmp}/berd-updater-verify-target}" \
  cargo run --quiet --locked \
    --manifest-path "$REPO_ROOT/scripts/release/updater-signature-verifier/Cargo.toml" \
    -- "$1" "$2" "$3"
echo "verified Tauri updater signature: $1"
