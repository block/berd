#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "scripts/build_darwin.sh must run on macOS." >&2
  exit 1
fi

require() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "required tool missing: $1" >&2
    exit 1
  fi
}

require just
require pnpm
require cargo
require rustc
require jq

can_compile_cxx_stdlib() {
  local cxx="${CXX:-c++}"
  printf '#include <cstdlib>\nint main(){return 0;}\n' \
    | "$cxx" -x c++ -c -o /tmp/goose-internal-cstdlib-test.o - >/dev/null 2>&1
}

if ! can_compile_cxx_stdlib; then
  if [[ -x /opt/homebrew/opt/llvm/bin/clang++ ]]; then
    export CC="${CC:-/opt/homebrew/opt/llvm/bin/clang}"
    export CXX="${CXX:-/opt/homebrew/opt/llvm/bin/clang++}"
    echo "Using Homebrew LLVM because the active macOS developer tools cannot compile libc++ headers." >&2
  else
    echo "The active macOS developer tools cannot compile C++ standard library headers." >&2
    echo "Install/fix Xcode Command Line Tools or install Homebrew llvm." >&2
    exit 1
  fi
fi

export MACOSX_DEPLOYMENT_TARGET="${MACOSX_DEPLOYMENT_TARGET:-14.0}"

exec just bundle
