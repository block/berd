#!/bin/bash
# Install a signed standalone release. Run with curl ... | bash -s -- [options].
set -euo pipefail

fail() { echo "berd-call: $*" >&2; exit 1; }
fetch() {
  if [[ "$channel" == internal ]]; then
    gh release download "$tag" --repo squareup/berd-internal --pattern "$1" --dir "$work"
  else
    curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
      --connect-timeout 10 --max-time 120 --max-filesize 104857600 \
      "https://github.com/block/berd/releases/download/$tag/$1" -o "$work/$1"
  fi
}
valid_version() { [[ "$1" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]; }
newer() {
  local a b i
  IFS=. read -r -a a <<< "$1"
  IFS=. read -r -a b <<< "$2"
  for i in 0 1 2; do
    (( 10#${a[i]} > 10#${b[i]} )) && return 0
    (( 10#${a[i]} < 10#${b[i]} )) && return 1
  done
  return 1
}
commit_install() {
  local work="$1"
  [[ ! -L "$bin_dir/berd-call" && ! -d "$bin_dir/berd-call" ]] || fail 'installation target changed'
  # The staging directory is on this filesystem, so replacement is atomic.
  # All native starts share this lock, including calls from other installs.
  mv -f "$work/berd-call" "$bin_dir/berd-call"
  mv -f "$work/metadata" "$root/installed"
}
update() {
  local requested="${1:-}" tag version current='' digest archive expected actual listing
  if [[ -n "$requested" ]]; then
    tag="v${requested#v}"
  elif [[ "$channel" == internal ]]; then
    tag="$(gh release view --repo squareup/berd-internal --json tagName --jq .tagName)"
  else
    tag="$(curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
      --connect-timeout 10 --max-time 30 -o /dev/null -w '%{url_effective}' \
      https://github.com/block/berd/releases/latest)"
    tag="${tag##*/}"
  fi
  [[ "$tag" == v* ]] && valid_version "${tag#v}" || fail "invalid stable release tag: $tag"
  version="${tag#v}"
  if [[ -f "$root/installed" ]]; then
    read -r current < "$root/installed"
    valid_version "$current" || fail 'invalid installation metadata'
    if [[ -z "$requested" ]] && ! newer "$version" "$current"; then return 0; fi
  fi
  work="$(mktemp -d "$root/.download.XXXXXXXX")"
  trap 'rm -rf "$work"' EXIT
  archive="berd-call_${version}_darwin-aarch64.tar.gz"
  fetch "$archive"
  fetch "$archive.sha256"
  read -r expected listing < "$work/$archive.sha256"
  [[ "$expected" =~ ^[0-9a-f]{64}$ && "$listing" == "$archive" ]] || fail 'invalid release checksum'
  actual="$(shasum -a 256 "$work/$archive")"
  [[ "${actual%% *}" == "$expected" ]] || fail 'release checksum mismatch'
  [[ "$(tar -tzf "$work/$archive")" == berd-call ]] || fail 'unexpected archive contents'
  listing="$(tar -tvzf "$work/$archive")"
  [[ "$listing" == -* ]] || fail 'archive must contain one regular executable'
  tar -xzf "$work/$archive" -C "$work" berd-call
  [[ -f "$work/berd-call" && ! -L "$work/berd-call" ]] || fail 'missing release executable'
  # Pin Block's Developer ID team, so a checksum alone cannot vouch for other signers.
  codesign --verify --strict -R='anchor apple generic and certificate leaf[subject.OU] = EYF346PHUG' "$work/berd-call"
  codesign --display --verbose=4 "$work/berd-call" 2>&1 | /usr/bin/grep -Fx 'Identifier=berd-call' >/dev/null || fail 'wrong executable signing identifier'
  chmod 755 "$work/berd-call"
  printf '%s\n' "$version" > "$work/metadata"
  # Wait after downloading. The lock covers only the final replacement.
  mkdir -p "$HOME/Library/Caches/Berd"
  /usr/bin/lockf -k "$HOME/Library/Caches/Berd/berd-call-app-update.lock" \
    /bin/bash "$root/update" --commit "$work"
  echo "Installed Berd Call $version ($channel) in $bin_dir"
}

channel=public
bin_dir="$HOME/.local/bin"
requested=''
while [[ $# -gt 0 ]]; do
  case "$1" in
    --channel) channel="${2:?missing channel}"; shift 2 ;;
    --bin-dir) bin_dir="${2:?missing bin directory}"; shift 2 ;;
    --version) requested="${2:?missing version}"; shift 2 ;;
    -h|--help) echo 'Usage: install-berd-call.sh [--channel public|internal] [--bin-dir DIR] [--version X.Y.Z]'; exit 0 ;;
    *) fail "unknown option: $1" ;;
  esac
done
[[ "$channel" == public || "$channel" == internal ]] || fail 'channel must be public or internal'
[[ "$(uname -s)" == Darwin && "$(uname -m)" == arm64 ]] || fail 'standalone releases currently support Apple Silicon macOS only'
[[ -z "$requested" ]] || valid_version "${requested#v}" || fail 'version must be stable X.Y.Z'
[[ "$channel" != internal ]] || command -v gh >/dev/null || fail 'internal downloads require an authenticated GitHub CLI (gh)'
mkdir -p "$bin_dir"
bin_dir="$(cd "$bin_dir" && pwd -P)"
case "$bin_dir/" in *.app/*) fail 'cannot install into an application bundle' ;; esac
root="$bin_dir/.berd-call"
[[ ! -L "$root" && ! -L "$bin_dir/berd-call" ]] || fail 'refusing to replace a symlink; use a separate --bin-dir'
[[ ! -e "$bin_dir/berd-call" || -f "$root/installed" ]] || fail 'refusing to replace an unmanaged executable'
if [[ -f "$root/channel" ]]; then
  [[ "$(cat "$root/channel")" == "$channel" ]] || fail 'use a separate --bin-dir for a different channel'
fi
mkdir -p "$root"
chmod 700 "$root"
printf '%s\n' "$channel" > "$root/channel"
helper="$(mktemp "$root/.update.XXXXXXXX")"
trap 'rm -f "$helper"' EXIT
{
  echo '#!/bin/bash'
  echo 'set -euo pipefail'
  printf 'channel=%q\nbin_dir=%q\nroot=%q\n' "$channel" "$bin_dir" "$root"
  declare -f fail fetch valid_version newer commit_install update
  cat <<'HELPER'
case "${1:-}" in
  --commit) commit_install "${2:?missing staging directory}" ;;
  --run) update "${2:-}" ;;
  *)
    if ! /usr/bin/lockf -kst 0 "$root/check.lock" /bin/bash "$root/update" --run 2>&1 | /usr/bin/logger -t berd-call-update; then
      /usr/bin/logger -t berd-call-update 'Update failed; rerun the installer for diagnostics'
    fi
    ;;
esac
HELPER
} > "$helper"
chmod 700 "$helper"
mv -f "$helper" "$root/update"
/usr/bin/lockf -k "$root/check.lock" /bin/bash "$root/update" --run "$requested"
case ":$PATH:" in *":$bin_dir:"*) ;; *) echo "Add $bin_dir to PATH to run berd-call." ;; esac
