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

APP_FEATURES="goosectl,app-test-driver"

cd src-tauri
# The bare runs prove the feature-off posture (goosectl off, plugin stub)
# still compiles; the feature-full clippy mirrors the justfile gates so the
# broker and feature-gated app code compile and lint on CI too.
section "Tauri cargo check without external sidecars"
with_tauri_sidecars_disabled cargo check

section "Tauri clippy without external sidecars"
with_tauri_sidecars_disabled cargo clippy -- -D warnings

section "Tauri clippy with goosectl features"
with_tauri_sidecars_disabled cargo clippy --features "$APP_FEATURES" -- -D warnings

# goosectl is a workspace member but not a root-package dependency, so the
# root-package invocations above never touch it.
section "goosectl clippy"
with_tauri_sidecars_disabled cargo clippy -p goosectl -- -D warnings

# The broker plugin builds as a root-package dependency above, but clippy
# only denies warnings for the primary package; lint the plugin's server
# code as the primary crate so broker warnings fail CI too.
section "goosectl plugin clippy"
with_tauri_sidecars_disabled cargo clippy -p tauri-plugin-goosectl --features server -- -D warnings

section "goosectl plugin tests"
with_tauri_sidecars_disabled cargo test -p tauri-plugin-goosectl --features server

section "goosectl tests"
with_tauri_sidecars_disabled cargo test -p goosectl
