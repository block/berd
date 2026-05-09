#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."
# shellcheck source=lib.sh
source scripts/buildkite/lib.sh

section "Rust format check"
cd src-tauri
cargo fmt --check
cd ..

install_linux_tauri_deps

cd src-tauri
section "Tauri cargo check without external sidecars"
with_tauri_sidecars_disabled cargo check

section "Tauri clippy without external sidecars"
with_tauri_sidecars_disabled cargo clippy -- -D warnings
