#!/usr/bin/env bash
# Full encrypted runtime tests only exist for Apple Silicon macOS. Keep the
# pure helper, compile-fail and standalone absence tests on unsupported targets.
set -euo pipefail
triple="${CARGO_BUILD_TARGET:-$(rustc -vV | sed -n 's|host: ||p')}"
just _tauri-cargo-unix test -p berd-memory --target "$triple"
if [[ "$triple" == "aarch64-apple-darwin" ]]; then
  just _tauri-cargo-unix test --lib commands::memory_ --target "$triple"
fi
