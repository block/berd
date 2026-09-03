#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
build_dir="$(mktemp -d "${TMPDIR:-/tmp}/berd-siri-stream-regression.XXXXXX")"
test_binary="$build_dir/siri-tts-stream-regression"

trap 'rm -rf "$build_dir"' EXIT

clang \
  -fobjc-arc \
  -fblocks \
  -Wno-nullability-completeness \
  -framework Foundation \
  -framework AVFoundation \
  -framework AudioToolbox \
  -framework CoreAudio \
  "$repo_root/src-tauri/crates/berd-voice/native/tests/siri_tts_stream_regression.m" \
  -o "$test_binary"

"$test_binary"
