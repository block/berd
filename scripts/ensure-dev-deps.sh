#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"
force=0

if [[ "${1:-}" == "--force" ]]; then
  force=1
  shift
fi

if [[ $# -ne 0 ]]; then
  echo "Usage: scripts/ensure-dev-deps.sh [--force]" >&2
  exit 2
fi

pnpm_bin="${PNPM_BIN:-pnpm}"
dependency_stamp="$repo_root/node_modules/.berd-dev-dependency-inputs.sha256"
installed_lock="$repo_root/node_modules/.pnpm/lock.yaml"
sdk_stamp="$repo_root/sdk/dist/.berd-dev-build-inputs.sha256"

hash_files() {
  local path
  for path in "$@"; do
    if [[ -d "$path" ]]; then
      find "$path" -type f -print
    elif [[ -f "$path" ]]; then
      printf '%s\n' "$path"
    fi
  done \
    | LC_ALL=C sort -u \
    | while IFS= read -r path; do
        shasum -a 256 "$path"
      done \
    | shasum -a 256 \
    | awk '{print $1}'
}

stamp_matches() {
  local stamp="$1"
  local expected="$2"
  [[ -f "$stamp" ]] && [[ "$(<"$stamp")" == "$expected" ]]
}

write_stamp() {
  local stamp="$1"
  local value="$2"
  local temp_stamp
  mkdir -p "$(dirname "$stamp")"
  temp_stamp="$(mktemp "${stamp}.XXXXXX")"
  printf '%s\n' "$value" >"$temp_stamp"
  mv "$temp_stamp" "$stamp"
}

dependency_inputs_hash() {
  hash_files \
    "$repo_root/package.json" \
    "$repo_root/pnpm-lock.yaml" \
    "$repo_root/pnpm-workspace.yaml" \
    "$repo_root/sdk/package.json"
}

sdk_inputs_hash() {
  hash_files \
    "$repo_root/pnpm-lock.yaml" \
    "$repo_root/pnpm-workspace.yaml" \
    "$repo_root/sdk/package.json" \
    "$repo_root/sdk/tsconfig.json" \
    "$repo_root/sdk/generate-schema.ts" \
    "$repo_root/sdk/schema" \
    "$repo_root/sdk/src"
}

sdk_outputs_current() {
  local output
  for output in index.js index.d.ts resolve-binary.js resolve-binary.d.ts; do
    [[ -f "$repo_root/sdk/dist/$output" ]] || return 1
  done
}

dependency_inputs="$(dependency_inputs_hash)"

if [[ "$force" == "1" ]] \
  || ! stamp_matches "$dependency_stamp" "$dependency_inputs" \
  || [[ ! -f "$installed_lock" ]] \
  || ! cmp -s "$repo_root/pnpm-lock.yaml" "$installed_lock"; then
  echo "Preparing pnpm dependencies."
  rm -f "$dependency_stamp"
  (cd "$repo_root" && "$pnpm_bin" install)
  dependency_inputs="$(dependency_inputs_hash)"
  write_stamp "$dependency_stamp" "$dependency_inputs"
else
  echo "pnpm dependencies are current; skipping install."
fi

sdk_inputs="$(sdk_inputs_hash)"

if [[ "$force" == "1" ]] \
  || ! stamp_matches "$sdk_stamp" "$sdk_inputs" \
  || ! sdk_outputs_current; then
  echo "Building @aaif/goose-sdk."
  rm -f "$sdk_stamp"
  (cd "$repo_root/sdk" && "$pnpm_bin" build)
  # Schema generation is part of the SDK build and may update derived source
  # files, so record the inputs after the successful build.
  sdk_inputs="$(sdk_inputs_hash)"
  write_stamp "$sdk_stamp" "$sdk_inputs"
else
  echo "@aaif/goose-sdk is current; skipping build."
fi
