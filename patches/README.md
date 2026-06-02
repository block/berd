# Goose Backend Patches

This directory contains security patches applied to the upstream
`aaif-goose/goose` checkout during `scripts/ensure-local-goose.sh` builds.

Patches are applied in lexicographic order after the pinned commit is checked
out and before `cargo build` runs. After building, the tree is restored to the
pinned commit so subsequent script invocations pass the dirty-checkout guard.

A patch that fails `git apply --check` is skipped with a log message — this
allows patches to remain in-tree harmlessly after the fix lands upstream.

## Current patches

| Patch | Purpose | Remove when |
|-------|---------|-------------|
| `0001-acp-auth-enforce-token-on-websocket.patch` | Enforce `GOOSE_SERVER__SECRET_KEY` auth on the ACP WebSocket route and validate Origin headers | Upstream merges equivalent auth enforcement on `/acp` (track PR aaif-goose/goose#8637 or successor) and `goose-backend.lock.json` is updated past that commit |
