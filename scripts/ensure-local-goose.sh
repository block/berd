#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: scripts/ensure-local-goose.sh [--print-bin | --check-bin]

Syncs and builds a dedicated local goose checkout for Goose Internal development.

Environment variables:
  GOOSE_DEV_MODE             auto|required (default: auto)
  GOOSE_DEV_ROOT             cache root (default: platform cache dir)
  GOOSE_DEV_REPO             managed goose checkout path
  GOOSE_DEV_STAMP_FILE       build stamp path
  GOOSE_DEV_CLONE_URL        clone URL (default: https://github.com/aaif-goose/goose.git)
  GOOSE_DEV_REMOTE           git remote to sync from (default: origin)
  GOOSE_DEV_BRANCH           preferred branch (default: main)
  GOOSE_DEV_FALLBACK_BRANCH  fallback branch (default: main)
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

mode="${GOOSE_DEV_MODE:-auto}"
clone_url="${GOOSE_DEV_CLONE_URL:-https://github.com/aaif-goose/goose.git}"
remote="${GOOSE_DEV_REMOTE:-origin}"
preferred_branch="${GOOSE_DEV_BRANCH:-main}"
fallback_branch="${GOOSE_DEV_FALLBACK_BRANCH:-main}"
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

default_goose_dev_root() {
  if [[ -n "${XDG_CACHE_HOME:-}" ]]; then
    printf '%s/goose-internal-dev\n' "$XDG_CACHE_HOME"
    return
  fi
  case "$(uname -s)" in
    Darwin) printf '%s/Library/Caches/goose-internal-dev\n' "$HOME" ;;
    *) printf '%s/.cache/goose-internal-dev\n' "$HOME" ;;
  esac
}

goose_dev_root="${GOOSE_DEV_ROOT:-$(default_goose_dev_root)}"
goose_repo="${GOOSE_DEV_REPO:-${goose_dev_root}/goose}"
stamp_file="${GOOSE_DEV_STAMP_FILE:-${goose_dev_root}/stamp.env}"
bin_path="${goose_repo}/target/debug/goose"

resolve_remote_head() {
  local branch_name="$1"
  git -C "$goose_repo" ls-remote --heads "$remote" "$branch_name" 2>/dev/null | awk 'NR == 1 { print $1 }'
}

resolve_branch() {
  local resolved_branch="$preferred_branch"
  local resolved_head
  resolved_head="$(resolve_remote_head "$resolved_branch")"
  if [[ -z "$resolved_head" && "$resolved_branch" != "$fallback_branch" ]]; then
    log "Remote branch $remote/$resolved_branch not found; falling back to $remote/$fallback_branch."
    resolved_branch="$fallback_branch"
    resolved_head="$(resolve_remote_head "$resolved_branch")"
  fi
  if [[ -z "$resolved_head" ]]; then
    if [[ "$mode" == "required" ]]; then
      echo "Could not resolve $remote/$resolved_branch for managed goose checkout at $goose_repo." >&2
      return 1
    fi
    log "Could not resolve $remote/$resolved_branch for managed goose checkout at $goose_repo."
    return 2
  fi
  RESOLVED_BRANCH="$resolved_branch"
  RESOLVED_REMOTE_HEAD="$resolved_head"
}

write_stamp() {
  local branch_name="$1"
  local commit_sha="$2"
  mkdir -p "$(dirname "$stamp_file")"
  {
    printf 'STAMP_REPO=%q\n' "$goose_repo"
    printf 'STAMP_BRANCH=%q\n' "$branch_name"
    printf 'STAMP_COMMIT=%q\n' "$commit_sha"
    printf 'STAMP_BIN=%q\n' "$bin_path"
  } >"$stamp_file"
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

if [[ "$allow_dirty" != "1" && -n "$(git -C "$goose_repo" status --porcelain)" ]]; then
  fail_or_skip "Managed goose checkout at $goose_repo is dirty. Use a dedicated checkout or set GOOSE_DEV_ALLOW_DIRTY=1."
fi

if resolve_branch; then
  branch="$RESOLVED_BRANCH"
  remote_head="$RESOLVED_REMOTE_HEAD"
else
  status=$?
  [[ $status -eq 2 ]] && exit 0
  exit "$status"
fi

if [[ "$action" == "check" ]]; then
  [[ -f "$stamp_file" ]] || fail_or_skip "No local goose build stamp found. Rerun just setup."
  # shellcheck disable=SC1090
  source "$stamp_file"
  [[ "${STAMP_REPO:-}" == "$goose_repo" ]] || fail_or_skip "Managed goose checkout changed. Rerun just setup."
  [[ "${STAMP_BRANCH:-}" == "$branch" ]] || fail_or_skip "Managed goose branch changed to $branch. Rerun just setup."
  [[ -x "${STAMP_BIN:-}" ]] || fail_or_skip "Local goose binary not found at ${STAMP_BIN:-unknown}. Rerun just setup."
  local_head="$(git -C "$goose_repo" rev-parse HEAD)"
  [[ "${STAMP_COMMIT:-}" == "$local_head" ]] || fail_or_skip "Managed goose checkout changed after last build. Rerun just setup."
  [[ "${STAMP_COMMIT:-}" == "$remote_head" ]] || fail_or_skip "Managed goose checkout is behind $remote/$branch. Rerun just setup."
  [[ "$print_bin" == "1" ]] && printf '%s\n' "$STAMP_BIN"
  exit 0
fi

git -C "$goose_repo" fetch "$remote" "$branch" >/dev/null 2>&1
remote_ref="refs/remotes/${remote}/${branch}"
if ! git -C "$goose_repo" show-ref --verify --quiet "$remote_ref"; then
  fail_or_skip "Fetched $remote/$branch, but $remote_ref is not available in $goose_repo."
fi
if git -C "$goose_repo" show-ref --verify --quiet "refs/heads/$branch"; then
  git -C "$goose_repo" checkout "$branch" >/dev/null 2>&1
else
  git -C "$goose_repo" checkout -b "$branch" --track "$remote/$branch" >/dev/null 2>&1
fi
git -C "$goose_repo" reset --hard "$remote/$branch" >/dev/null 2>&1

log "Building goose from $goose_repo on $branch."
(cd "$goose_repo" && cargo build -p goose-cli --bin goose)

if [[ -n "$(git -C "$goose_repo" status --porcelain -- Cargo.lock)" ]]; then
  git -C "$goose_repo" checkout -- Cargo.lock
fi
[[ -x "$bin_path" ]] || { echo "Expected goose binary at $bin_path, but it was not built." >&2; exit 1; }
write_stamp "$branch" "$(git -C "$goose_repo" rev-parse HEAD)"
log "Local goose binary ready at $bin_path."
[[ "$print_bin" == "1" ]] && printf '%s\n' "$bin_path"
