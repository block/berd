# Derive a stable port from the working directory so the same checkout always
# gets the same Vite port.
vite_port := `python3 -c "import hashlib,os; h=int(hashlib.sha256(os.getcwd().encode()).hexdigest(),16); print(10000 + h % 55000)"`

# Default recipe
default:
    @just --list

# ── Dev Environment ──────────────────────────────────────────

# Sync and build the managed local goose checkout used for Goose Internal development.
goose-sync:
    GOOSE_DEV_MODE=required ./scripts/ensure-local-goose.sh

# Install dependencies and build workspace packages.
setup:
    pnpm install
    cd sdk && pnpm build
    GOOSE_DEV_MODE=required ./scripts/ensure-local-goose.sh

# ── Build & Check ────────────────────────────────────────────

check:
    pnpm check
    pnpm typecheck

fmt:
    pnpm format
    cd src-tauri && cargo fmt

fmt-check:
    pnpm exec biome format .
    cd src-tauri && cargo fmt --check

clippy:
    cd src-tauri && TAURI_CONFIG='{"bundle":{"externalBin":[]}}' cargo clippy -- -D warnings

build:
    pnpm build

tauri-fmt-check:
    cd src-tauri && cargo fmt --check

tauri-check:
    cd src-tauri && TAURI_CONFIG='{"bundle":{"externalBin":[]}}' cargo check

ci: check clippy test build tauri-check

# Stage GOOSE_BIN into src-tauri/binaries/goose-<target> and build bundles.
bundle:
    ./scripts/prepare-goose-sidecar.sh
    pnpm tauri build

# ── Test ─────────────────────────────────────────────────────

test:
    pnpm test

test-watch:
    pnpm test:watch

test-coverage:
    pnpm test:coverage

test-e2e:
    pnpm test:e2e:smoke

test-e2e-all:
    pnpm test:e2e

# ── Run ──────────────────────────────────────────────────────

dev:
    #!/usr/bin/env bash
    set -euo pipefail

    VITE_PORT={{ vite_port }}
    export VITE_PORT
    export RUST_LOG="${RUST_LOG:-perf=debug,info}"

    if [[ -n "${GOOSE_BIN:-}" ]]; then
        echo "Using explicitly set GOOSE_BIN: ${GOOSE_BIN}"
    else
        LOCAL_GOOSE_BIN="$(./scripts/ensure-local-goose.sh --check-bin)" || {
            rc=$?
            if [[ $rc -eq 2 ]]; then
                echo "❌ Local goose binary is not ready. Run 'just setup' first." >&2
                exit 1
            fi
            exit $rc
        }
        export GOOSE_BIN="$LOCAL_GOOSE_BIN"
        echo "Using local goose binary: ${GOOSE_BIN}"
    fi

    DISTRO_DIR="$(pwd)/distro"
    if [[ -z "${GOOSE_DISTRO_DIR:-}" && -d "$DISTRO_DIR" ]]; then
        export GOOSE_DISTRO_DIR="$DISTRO_DIR"
        echo "Using distro dir: ${GOOSE_DISTRO_DIR}"
    fi

    EXTRA_CONFIG_ARGS=(--config "{\"build\":{\"devUrl\":\"http://localhost:${VITE_PORT}\",\"beforeDevCommand\":{\"script\":\"exec pnpm exec vite --port ${VITE_PORT} --strictPort\",\"cwd\":\"..\",\"wait\":false}}}")

    if git rev-parse --is-inside-work-tree &>/dev/null; then
        GIT_DIR=$(git rev-parse --git-dir)
        if [[ "$GIT_DIR" == *".git/worktrees/"* ]]; then
            BRANCH_NAME=$(git rev-parse --abbrev-ref HEAD)
            WORKTREE_LABEL="${BRANCH_NAME##*/}"
            ICON_DIR="$(pwd)/src-tauri/target/dev-icons"
            mkdir -p "$ICON_DIR"
            DEV_ICON="$ICON_DIR/icon.icns"
            if swift scripts/generate-dev-icon.swift src-tauri/icons/icon.icns "$DEV_ICON" "$WORKTREE_LABEL"; then
                echo "🌳 Worktree: ${WORKTREE_LABEL}"
                EXTRA_CONFIG_ARGS+=(--config "{\"bundle\":{\"icon\":[\"$DEV_ICON\"]}}")
            fi
        fi
    fi

    pnpm tauri dev --features app-test-driver --config src-tauri/tauri.dev.conf.json "${EXTRA_CONFIG_ARGS[@]}"

dev-debug: dev

dev-frontend:
    pnpm dev

# ── Utilities ────────────────────────────────────────────────

clean:
    cd src-tauri && cargo clean
    rm -rf dist node_modules sdk/node_modules sdk/dist

stage-sidecar:
    ./scripts/prepare-goose-sidecar.sh
