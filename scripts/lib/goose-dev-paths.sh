#!/usr/bin/env bash
# Shared path resolution for the managed Goose backend dev checkout.
# Sourced by ensure-local-goose.sh and regenerate-sdk-schema.sh so the two
# scripts cannot drift on cache layout (a drift would land the regen build in
# a different target dir than the binary build, forcing a full recompile or
# missing the binary entirely).
#
# Sets in the sourcing shell:
#   goose_dev_root            base cache directory
#   goose_repo                managed checkout path
#   goose_cargo_target_dir    cargo target dir scoped to the managed checkout
#   goose_stamp_file          path to the build stamp written by ensure-local-goose.sh
#
# Honours the GOOSE_DEV_ROOT / GOOSE_DEV_REPO / GOOSE_DEV_CARGO_TARGET_DIR /
# GOOSE_DEV_STAMP_FILE env overrides documented in ensure-local-goose.sh.

default_goose_dev_root() {
  if [[ -n "${XDG_CACHE_HOME:-}" ]]; then
    printf '%s/berd-dev\n' "$XDG_CACHE_HOME"
    return
  fi
  case "$(uname -s)" in
    Darwin) printf '%s/Library/Caches/berd-dev\n' "$HOME" ;;
    *) printf '%s/.cache/berd-dev\n' "$HOME" ;;
  esac
}

goose_dev_root="${GOOSE_DEV_ROOT:-$(default_goose_dev_root)}"
goose_repo="${GOOSE_DEV_REPO:-${goose_dev_root}/goose}"
goose_cargo_target_dir="${GOOSE_DEV_CARGO_TARGET_DIR:-${goose_dev_root}/cargo-target}"
goose_stamp_file="${GOOSE_DEV_STAMP_FILE:-${goose_dev_root}/stamp.env}"
