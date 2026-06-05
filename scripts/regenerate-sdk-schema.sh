#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"

usage() {
  cat <<'USAGE'
Usage: scripts/regenerate-sdk-schema.sh

Regenerates sdk/schema/{acp-schema,acp-meta}.json from the pinned Goose
backend (per goose-backend.lock.json), then rebuilds the layer-2 SDK
artifacts (sdk/src/generated/*.ts).

Composes with scripts/ensure-local-goose.sh and honours the same
GOOSE_DEV_* environment overrides.
USAGE
}

case "${1:-}" in
  -h|--help)
    usage
    exit 0
    ;;
  "")
    ;;
  *)
    echo "Unknown argument: $1" >&2
    usage >&2
    exit 1
    ;;
esac

log() { echo "[regenerate-sdk-schema] $*" >&2; }

# Step 1: ensure the managed checkout exists at the pinned commit. Run in
# `required` mode so offline/lockfile failures abort here instead of
# silently regenerating from a stale checkout.
log "Syncing managed Goose checkout to the pinned commit."
GOOSE_DEV_MODE=required "$script_dir/ensure-local-goose.sh" >/dev/null

# Re-derive the managed checkout path and cargo target dir via the same
# shared helper ensure-local-goose.sh used, so cargo reuses the existing
# target dir and we don't recompile from scratch.
# shellcheck source=lib/goose-dev-paths.sh
source "$script_dir/lib/goose-dev-paths.sh"

if [[ ! -d "$goose_repo/.git" ]]; then
  echo "Managed Goose checkout not found at $goose_repo after ensure-local-goose.sh." >&2
  exit 1
fi

# Step 2: build the schema-generator binary. The generator lives in the
# `goose` crate (not `goose-cli`, which is what the lockfile pins for the
# runtime binary). We use `cargo build` rather than `cargo run` so that
# step 3 can override CARGO_MANIFEST_DIR — cargo run always sets it
# itself and would write the JSON files into the managed checkout,
# dirtying it.
log "Building generate-acp-schema."
(
  cd "$goose_repo"
  CARGO_TARGET_DIR="$goose_cargo_target_dir" \
    cargo build -p goose --bin generate-acp-schema
)

generator_bin="$goose_cargo_target_dir/debug/generate-acp-schema"
if [[ ! -x "$generator_bin" ]]; then
  echo "Expected generator binary at $generator_bin, but it was not built." >&2
  exit 1
fi

# Step 3: run the generator with CARGO_MANIFEST_DIR pointed at a tempdir.
# The binary writes acp-{schema,meta}.json into $CARGO_MANIFEST_DIR; this
# keeps the managed checkout clean.
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

pinned_commit="$(git -C "$goose_repo" rev-parse HEAD)"
log "Running generator at $pinned_commit."
CARGO_MANIFEST_DIR="$tmp_dir" "$generator_bin" >/dev/null

for f in acp-schema.json acp-meta.json; do
  if [[ ! -f "$tmp_dir/$f" ]]; then
    echo "Generator at $pinned_commit did not produce $f." >&2
    exit 1
  fi
done

# Step 4: normalize formatting inside the tempdir before installing into
# the tree, so a biome failure leaves the previous sdk/schema/*.json
# untouched instead of stranding unformatted output in the working tree.
# We pass absolute paths so biome picks up the repo-root config regardless
# of where the files live on disk.
log "Formatting generated JSON."
(
  cd "$repo_root"
  pnpm exec biome format --write "$tmp_dir/acp-schema.json" "$tmp_dir/acp-meta.json" >/dev/null
)

# Step 5: install formatted outputs into sdk/schema/.
mkdir -p "$repo_root/sdk/schema"
mv "$tmp_dir/acp-schema.json" "$repo_root/sdk/schema/acp-schema.json"
mv "$tmp_dir/acp-meta.json" "$repo_root/sdk/schema/acp-meta.json"

# Step 6: regenerate layer 2 (sdk/src/generated/*.ts) from the fresh JSON.
log "Rebuilding SDK (layer 2)."
(
  cd "$repo_root/sdk"
  pnpm build
)

log "SDK schema regenerated from $pinned_commit."
