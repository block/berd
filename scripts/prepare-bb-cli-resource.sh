#!/usr/bin/env bash
# Build and stage the BuilderBot bb CLI as an app resource.
#
# The packaged path is:
#   Goose.app/Contents/Resources/bb
#
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"
bb_root="$repo_root/bb-cli"
out="$repo_root/resources/bb"
target_triple="${1:-}"

if [[ ! -d "$bb_root" ]]; then
  echo "bb-cli checkout not found at $bb_root" >&2
  exit 1
fi

(
  cd "$bb_root"
  if [[ -f ./bin/activate-hermit ]]; then
    # shellcheck source=/dev/null
    source ./bin/activate-hermit
  fi

  cargo_args=(build --locked --release --bin bb)
  if [[ -n "$target_triple" ]]; then
    cargo_args+=(--target "$target_triple")
  fi
  cargo "${cargo_args[@]}"
)

target_dir="$bb_root/target/release"
if [[ -n "$target_triple" ]]; then
  target_dir="$bb_root/target/$target_triple/release"
fi

binary_name="bb"
if [[ "$target_triple" == *windows* ]] || [[ "$(uname -s)" =~ ^(MINGW|MSYS|CYGWIN) ]]; then
  binary_name="bb.exe"
fi
built="$target_dir/$binary_name"

if [[ ! -x "$built" ]]; then
  echo "Built bb binary not found at: $built" >&2
  exit 1
fi

cp "$built" "$out"
chmod +x "$out"

if [[ "$(uname -s)" == "Darwin" ]]; then
  codesign -f -s - "$out" >/dev/null 2>&1 || true
fi

echo "Staged bb CLI resource: $out"
