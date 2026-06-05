#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"
default_lock_file="$repo_root/goose-backend.lock.json"

usage() {
  cat <<'USAGE'
Usage: scripts/ensure-local-goose.sh [--print-bin | --check-bin]

Syncs and builds the pinned Goose backend checkout for Goose Internal development.
By default, the repo root goose-backend.lock.json controls the upstream repo,
ref, commit, cargo package, and binary name.

Environment variables:
  GOOSE_BACKEND_LOCK_FILE    lockfile path (default: ./goose-backend.lock.json)
  GOOSE_DEV_MODE             auto|required (default: auto)
  GOOSE_DEV_ROOT             cache root (default: platform cache dir)
  GOOSE_DEV_REPO             managed goose checkout path
  GOOSE_DEV_STAMP_FILE       build stamp path
  GOOSE_DEV_CLONE_URL        override clone URL from lockfile
  GOOSE_DEV_REMOTE           git remote to sync from (default: origin)
  GOOSE_DEV_REF              override ref from lockfile (branch, tag, or sha)
  GOOSE_DEV_BRANCH           deprecated alias for GOOSE_DEV_REF
  GOOSE_DEV_COMMIT           override pinned commit from lockfile
  GOOSE_DEV_PACKAGE          override cargo package from lockfile
  GOOSE_DEV_BIN              override built binary name from lockfile
  GOOSE_DEV_ALLOW_DIRTY      1 to allow building a dirty checkout
USAGE
}

action="build"
print_bin=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --print-bin)
      print_bin=1
      shift
      ;;
    --check-bin)
      action="check"
      print_bin=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

lock_file="${GOOSE_BACKEND_LOCK_FILE:-$default_lock_file}"

read_lock_field() {
  local field="$1"
  [[ -f "$lock_file" ]] || return 0
  python3 - "$lock_file" "$field" <<'PY'
import json
import sys
with open(sys.argv[1], encoding="utf-8") as fh:
    value = json.load(fh).get(sys.argv[2], "")
print(value if value is not None else "")
PY
}

lock_repo="$(read_lock_field repo)"
lock_ref="$(read_lock_field ref)"
lock_commit="$(read_lock_field commit)"
lock_package="$(read_lock_field package)"
lock_bin="$(read_lock_field bin)"

mode="${GOOSE_DEV_MODE:-auto}"
clone_url="${GOOSE_DEV_CLONE_URL:-${lock_repo:-https://github.com/aaif-goose/goose.git}}"
remote="${GOOSE_DEV_REMOTE:-origin}"
pinned_ref="${GOOSE_DEV_REF:-${GOOSE_DEV_BRANCH:-${lock_ref:-main}}}"
pinned_commit="${GOOSE_DEV_COMMIT:-$lock_commit}"
goose_package="${GOOSE_DEV_PACKAGE:-${lock_package:-goose-cli}}"
goose_bin="${GOOSE_DEV_BIN:-${lock_bin:-goose}}"
allow_dirty="${GOOSE_DEV_ALLOW_DIRTY:-0}"

log() { echo "[goose-internal-goose-dev] $*" >&2; }

fail_or_skip() {
  local message="$1"
  if [[ "$mode" == "required" ]]; then
    echo "$message" >&2
    exit 1
  fi
  log "$message"
  if [[ "$action" == "check" ]]; then
    exit 2
  fi
  exit 0
}

# Resolve the managed checkout / cargo target / stamp paths via the shared
# helper so regenerate-sdk-schema.sh can land its build in the same target
# dir without a parallel copy of this logic.
#
# Pinning a dedicated cargo target dir matters here: we must NOT share with
# this repo's src-tauri crate. That crate's binary is named `Goose` and
# upstream's is named `goose`, which collide on macOS APFS (case-insensitive
# by default), so whichever cargo build runs last clobbers the other. The
# original symptom: `just dev` builds the goose backend, then Tauri builds
# `Goose` over it, and at runtime `GOOSE_BIN` points at the Tauri app --
# which proceeds to relaunch itself recursively, opening new windows
# forever. A dedicated target dir under the dev cache root preserves the
# shared-cache benefit across goose-internal worktrees (they still all hit
# the same location) without ever sharing with src-tauri or any other
# workspace that honours `$HOME/.cargo/config.toml`'s `[build] target-dir`.
# shellcheck source=lib/goose-dev-paths.sh
source "$script_dir/lib/goose-dev-paths.sh"
export CARGO_TARGET_DIR="$goose_cargo_target_dir"

# bin_path is computed after the checkout exists, via `cargo metadata`, so it
# matches CARGO_TARGET_DIR exactly (and would also honour any user override).
bin_path=""

resolve_ref_to_commit() {
  local ref="$1"
  git -C "$goose_repo" ls-remote "$remote" "$ref" 2>/dev/null | awk 'NR == 1 { print $1 }'
}

# Ask cargo where it will actually write the binary. With CARGO_TARGET_DIR
# exported above, this is deterministic; we still go through `cargo metadata`
# (rather than hard-coding the path) so the script and cargo can't disagree
# if anything else ever overrides the target directory.
resolve_bin_path() {
  local target_dir
  target_dir="$(cd "$goose_repo" && cargo metadata --no-deps --format-version 1 2>/dev/null \
    | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("target_directory",""))')"
  if [[ -z "$target_dir" ]]; then
    target_dir="${goose_repo}/target"
  fi
  printf '%s/debug/%s\n' "$target_dir" "$goose_bin"
}

write_stamp() {
  local ref_name="$1"
  local commit_sha="$2"
  mkdir -p "$(dirname "$goose_stamp_file")"
  {
    printf 'STAMP_REPO=%q\n' "$goose_repo"
    printf 'STAMP_LOCK_FILE=%q\n' "$lock_file"
    printf 'STAMP_REF=%q\n' "$ref_name"
    printf 'STAMP_COMMIT=%q\n' "$commit_sha"
    printf 'STAMP_PACKAGE=%q\n' "$goose_package"
    printf 'STAMP_BIN_NAME=%q\n' "$goose_bin"
    printf 'STAMP_BIN=%q\n' "$bin_path"
  } >"$goose_stamp_file"
}

stamp_matches_current_build() {
  [[ -f "$goose_stamp_file" ]] || return 1
  # shellcheck disable=SC1090
  source "$goose_stamp_file"
  [[ "${STAMP_REPO:-}" == "$goose_repo" ]] || return 1
  [[ "${STAMP_REF:-${STAMP_BRANCH:-}}" == "$pinned_ref" ]] || return 1
  [[ "${STAMP_COMMIT:-}" == "$pinned_commit" ]] || return 1
  [[ "${STAMP_PACKAGE:-$goose_package}" == "$goose_package" ]] || return 1
  [[ "${STAMP_BIN_NAME:-$goose_bin}" == "$goose_bin" ]] || return 1
  [[ -x "${STAMP_BIN:-}" ]] || return 1
  # The recorded binary path must match where cargo writes today; otherwise
  # the user's cargo config (e.g. build.target-dir) changed and the stamp is
  # pointing at a fossil binary that no rebuild will refresh.
  [[ "${STAMP_BIN:-}" == "$bin_path" ]] || return 1
  local local_head
  local_head="$(git -C "$goose_repo" rev-parse HEAD)"
  [[ "${STAMP_COMMIT:-}" == "$local_head" ]] || return 1
}

ensure_checkout_exists() {
  if [[ -d "$goose_repo/.git" ]]; then
    return 0
  fi
  if [[ "$action" == "check" ]]; then
    fail_or_skip "Managed goose checkout not found at $goose_repo. Rerun just setup."
  fi
  log "Cloning managed goose checkout into $goose_repo."
  mkdir -p "$(dirname "$goose_repo")"
  git clone "$clone_url" "$goose_repo" >/dev/null 2>&1 || {
    fail_or_skip "Failed to clone managed goose checkout from $clone_url into $goose_repo."
  }
}

ensure_checkout_exists

bin_path="$(resolve_bin_path)"

if [[ "$allow_dirty" != "1" && -n "$(git -C "$goose_repo" status --porcelain)" ]]; then
  fail_or_skip "Managed goose checkout at $goose_repo is dirty. Use a dedicated checkout or set GOOSE_DEV_ALLOW_DIRTY=1."
fi

if [[ "$action" == "check" ]]; then
  stamp_matches_current_build || fail_or_skip "Local Goose binary is not ready for $pinned_ref at $pinned_commit. Rerun just setup."
  [[ "$print_bin" == "1" ]] && printf '%s\n' "$STAMP_BIN"
  exit 0
fi

if [[ -z "$pinned_commit" ]]; then
  pinned_commit="$(resolve_ref_to_commit "$pinned_ref")"
  [[ -n "$pinned_commit" ]] || fail_or_skip "Could not resolve Goose ref $remote/$pinned_ref for managed checkout at $goose_repo."
fi

if stamp_matches_current_build; then
  log "Local Goose binary already matches $pinned_ref at $pinned_commit."
  if [[ "$print_bin" == "1" ]]; then
    printf '%s\n' "$STAMP_BIN"
  fi
  exit 0
fi

log "Fetching pinned Goose ref $pinned_ref."
git -C "$goose_repo" fetch "$remote" "$pinned_ref" >/dev/null 2>&1 || {
  log "Direct fetch of $pinned_ref failed; fetching all remote heads and tags."
  git -C "$goose_repo" fetch "$remote" --tags '+refs/heads/*:refs/remotes/'"${remote}"'/*' >/dev/null 2>&1 || {
    fail_or_skip "Failed to fetch Goose ref $pinned_ref from $remote."
  }
}

if ! git -C "$goose_repo" cat-file -e "${pinned_commit}^{commit}" 2>/dev/null; then
  fail_or_skip "Pinned Goose commit $pinned_commit is not available after fetching $pinned_ref."
fi

git -C "$goose_repo" checkout --detach "$pinned_commit" >/dev/null 2>&1
git -C "$goose_repo" reset --hard "$pinned_commit" >/dev/null 2>&1

log "Building Goose from $goose_repo at $pinned_commit."
(cd "$goose_repo" && cargo build -p "$goose_package" --bin "$goose_bin")

if [[ -n "$(git -C "$goose_repo" status --porcelain -- Cargo.lock)" ]]; then
  git -C "$goose_repo" checkout -- Cargo.lock
fi
[[ -x "$bin_path" ]] || { echo "Expected Goose binary at $bin_path, but it was not built." >&2; exit 1; }
write_stamp "$pinned_ref" "$(git -C "$goose_repo" rev-parse HEAD)"
log "Local Goose binary ready at $bin_path."
if [[ "$print_bin" == "1" ]]; then
  printf '%s\n' "$bin_path"
fi
