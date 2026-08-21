#!/usr/bin/env bash
set -euo pipefail

if [ ! -d .git ]; then
  echo "Skipping lefthook install in Git worktree"
  exit 0
fi

if [ -x ./bin/lefthook ]; then
  ./bin/lefthook install --force
elif command -v lefthook >/dev/null 2>&1; then
  lefthook install --force
else
  echo "lefthook not found. Activate Hermit (source ./bin/activate-hermit) or install lefthook." >&2
  exit 1
fi
