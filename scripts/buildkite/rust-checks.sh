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

APP_FEATURES="berdctl,app-test-driver"

cd src-tauri
# The bare runs prove the feature-off posture (berdctl off, plugin stub)
# still compiles; the feature-full clippy mirrors the justfile gates so the
# broker and feature-gated app code compile and lint on CI too.
section "Tauri cargo check without external sidecars"
with_tauri_sidecars_disabled cargo check

section "Tauri clippy without external sidecars"
with_tauri_sidecars_disabled cargo clippy -- -D warnings

section "Tauri clippy with berdctl features"
with_tauri_sidecars_disabled cargo clippy --features "$APP_FEATURES" -- -D warnings

# berdctl is a workspace member but not a root-package dependency, so the
# root-package invocations above never touch it.
section "berdctl clippy"
with_tauri_sidecars_disabled cargo clippy -p berdctl -- -D warnings

# The broker plugin builds as a root-package dependency above, but clippy
# only denies warnings for the primary package; lint the plugin's server
# code as the primary crate so broker warnings fail CI too.
section "berdctl plugin clippy"
with_tauri_sidecars_disabled cargo clippy -p tauri-plugin-berdctl --features server -- -D warnings

section "berdctl plugin tests"
with_tauri_sidecars_disabled cargo test -p tauri-plugin-berdctl --features server

section "berdctl tests"
with_tauri_sidecars_disabled cargo test -p berdctl
