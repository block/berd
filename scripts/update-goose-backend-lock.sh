#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"
lock_file="${GOOSE_BACKEND_LOCK_FILE:-$repo_root/goose-backend.lock.json}"

usage() {
  cat <<'USAGE'
Usage: scripts/update-goose-backend-lock.sh <ref-or-sha>

Resolves a Goose upstream ref/tag/commit and updates goose-backend.lock.json.
The lockfile controls the default backend used by just setup/dev/bundle.

Environment variables:
  GOOSE_BACKEND_LOCK_FILE    lockfile path (default: ./goose-backend.lock.json)
  GOOSE_DEV_CLONE_URL        override repo URL from lockfile
  GOOSE_DEV_REMOTE           git remote name for managed checkout (default: origin)
USAGE
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" || $# -ne 1 ]]; then
  usage
  [[ $# -eq 1 ]] && exit 0 || exit 1
fi

requested_ref="$1"

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

repo="${GOOSE_DEV_CLONE_URL:-$(read_lock_field repo)}"
remote="${GOOSE_DEV_REMOTE:-origin}"
package="$(read_lock_field package)"
bin="$(read_lock_field bin)"

if [[ -z "$repo" ]]; then
  echo "Lockfile $lock_file does not contain a repo URL." >&2
  exit 1
fi

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

git -C "$tmp_dir" init -q
git -C "$tmp_dir" remote add "$remote" "$repo"

echo "Resolving Goose ref $requested_ref from $repo..." >&2
fetch_succeeded=0
if git -C "$tmp_dir" fetch -q --tags "$remote" "$requested_ref"; then
  fetch_succeeded=1
else
  git -C "$tmp_dir" fetch -q --tags "$remote" '+refs/heads/*:refs/remotes/'"${remote}"'/*'
fi

if [[ "$fetch_succeeded" == "1" ]] && git -C "$tmp_dir" rev-parse --verify --quiet FETCH_HEAD^{commit} >/dev/null; then
  commit="$(git -C "$tmp_dir" rev-parse FETCH_HEAD^{commit})"
elif git -C "$tmp_dir" rev-parse --verify --quiet "$requested_ref^{commit}" >/dev/null; then
  commit="$(git -C "$tmp_dir" rev-parse "$requested_ref^{commit}")"
elif git -C "$tmp_dir" rev-parse --verify --quiet "$remote/$requested_ref^{commit}" >/dev/null; then
  commit="$(git -C "$tmp_dir" rev-parse "$remote/$requested_ref^{commit}")"
else
  echo "Could not resolve Goose ref or commit: $requested_ref" >&2
  exit 1
fi

python3 - "$lock_file" "$repo" "$requested_ref" "$commit" "$package" "$bin" <<'PY'
import json
import sys
from pathlib import Path
path = Path(sys.argv[1])
data = {
    "repo": sys.argv[2],
    "ref": sys.argv[3],
    "commit": sys.argv[4],
    "package": sys.argv[5] or "goose-cli",
    "bin": sys.argv[6] or "goose",
}
path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
PY

echo "Pinned Goose backend to $commit ($requested_ref)." >&2
