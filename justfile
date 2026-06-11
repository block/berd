# Derive a stable port from the working directory so the same checkout always
# gets the same Vite port.
vite_port := `python3 -c "import hashlib,os; h=int(hashlib.sha256(os.getcwd().encode()).hexdigest(),16); print(10000 + h % 55000)"`

# Use one shared Tauri target dir across goose-internal worktrees without
# sharing with upstream Goose, whose `goose` binary collides with this crate's
# `Goose` binary on case-insensitive macOS filesystems.
tauri_cargo_target_dir := `if [ -n "${GOOSE_INTERNAL_TAURI_CARGO_TARGET_DIR:-}" ]; then printf '%s\n' "$GOOSE_INTERNAL_TAURI_CARGO_TARGET_DIR"; elif [ -n "${XDG_CACHE_HOME:-}" ]; then printf '%s/goose-internal-tauri/cargo-target\n' "$XDG_CACHE_HOME"; elif [ "$(uname -s)" = "Darwin" ]; then printf '%s/Library/Caches/goose-internal-tauri/cargo-target\n' "$HOME"; else printf '%s/.cache/goose-internal-tauri/cargo-target\n' "$HOME"; fi`

# Default recipe
default:
    @just --list

# ── Dev Environment ──────────────────────────────────────────

# Sync and build the pinned managed local Goose checkout used for Goose Internal development.
goose-sync:
    GOOSE_DEV_MODE=required ./scripts/ensure-local-goose.sh

# Regenerate the vendored ACP schema from the pinned Goose backend and rebuild the SDK (kept out of setup; mutates tracked files).
sync-schema:
    ./scripts/regenerate-sdk-schema.sh

# Install dependencies and build workspace packages.
_setup-dev-deps:
    pnpm install
    cd sdk && pnpm build

# Install dependencies, build workspace packages, and prepare local development hooks.
_setup-no-goose: _setup-dev-deps
    lefthook install --force

# Install dependencies, build workspace packages, build managed Goose, and prepare local development hooks.
setup: _setup-dev-deps
    GOOSE_DEV_MODE=required ./scripts/ensure-local-goose.sh
    lefthook install --force

# ── Build & Check ────────────────────────────────────────────

# Run the frontend non-test checks: design-system guardrails, formatting, lint, i18n, and TypeScript.
check: design-system-check frontend-fmt-check lint i18n-check typecheck

# Format frontend and Tauri/Rust files.
fmt:
    just frontend-fmt
    just tauri-fmt

# Check frontend and Tauri/Rust formatting.
fmt-check: frontend-fmt-check tauri-fmt-check

# Format frontend files with Biome.
frontend-fmt:
    pnpm format

# Generate the design-system component manifest.
design-system-generate:
    pnpm design-system:generate

# Check generated design-system facts, token/style guardrails, and explorer coverage.
design-system-check: design-system-manifest-check design-system-tokens design-system-audit design-system-coverage

# Check that the generated design-system component manifest is up to date.
design-system-manifest-check:
    pnpm design-system:manifest-check

# Audit covered components for custom color styling and source-token drift.
design-system-audit:
    pnpm design-system:audit

# Check that app color usage follows the shadcn + Goose token contract.
design-system-tokens:
    pnpm design-system:tokens

# Check that curated explorer component pages follow the page contract.
design-system-coverage:
    pnpm design-system:coverage -- --strict

# Check frontend formatting with Biome.
frontend-fmt-check:
    pnpm exec biome format .

# Lint frontend files with Biome.
lint:
    pnpm lint

# Check frontend i18n string conventions.
i18n-check:
    pnpm check:i18n

# Type-check frontend TypeScript.
typecheck:
    pnpm typecheck

# Format Tauri/Rust files.
tauri-fmt:
    cd src-tauri && cargo fmt

# Check Tauri/Rust formatting.
tauri-fmt-check:
    cd src-tauri && cargo fmt --check

# Run Rust clippy with warnings denied.
clippy:
    cd src-tauri && CARGO_TARGET_DIR="{{ tauri_cargo_target_dir }}" TAURI_CONFIG='{"bundle":{"externalBin":[]}}' cargo clippy -- -D warnings

# Build the frontend.
build:
    pnpm build

# Check the Tauri/Rust crate with external sidecars disabled.
tauri-check:
    cd src-tauri && CARGO_TARGET_DIR="{{ tauri_cargo_target_dir }}" TAURI_CONFIG='{"bundle":{"externalBin":[]}}' cargo check

# Run the local CI gate.
ci: check tauri-fmt-check tauri-check clippy test build

# Stage the pinned Goose backend into src-tauri/binaries/goosed-<target> and build bundles.
bundle:
    ./scripts/prepare-goose-sidecar.sh
    CARGO_TARGET_DIR="{{ tauri_cargo_target_dir }}" pnpm tauri build

# Stage the pinned Goose backend and build a release bundle with WebView devtools enabled.
bundle-debug:
    #!/usr/bin/env bash
    set -euo pipefail

    ./scripts/prepare-goose-sidecar.sh

    # Use a temporary config overlay so normal release bundles keep devtools disabled.
    DEBUG_CONFIG="$(mktemp -t goose-tauri-debug.XXXXXX.json)"
    trap 'rm -f "$DEBUG_CONFIG"' EXIT
    jq '.app.windows[0].devtools = true' src-tauri/tauri.conf.json > "$DEBUG_CONFIG"

    CARGO_TARGET_DIR="{{ tauri_cargo_target_dir }}" \
      pnpm tauri build --features devtools --config "$DEBUG_CONFIG"

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

    if [[ -n "${GOOSE_BIN:-}" ]]; then
        just _setup-no-goose
    else
        just setup
    fi

    VITE_PORT={{ vite_port }}
    export VITE_PORT
    export VITE_DESIGN_SYSTEM_EXPLORER=1
    export RUST_LOG="${RUST_LOG:-perf=debug,info}"
    export CARGO_TARGET_DIR="{{ tauri_cargo_target_dir }}"
    echo "Using Tauri Cargo target dir: ${CARGO_TARGET_DIR}"

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

    ICON_DIR="${CARGO_TARGET_DIR}/dev-icons"
    mkdir -p "$ICON_DIR"
    DEV_ICON_LABEL="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
    if [[ -z "$DEV_ICON_LABEL" || "$DEV_ICON_LABEL" == "HEAD" ]]; then
        DEV_ICON_LABEL="local"
    fi
    DEV_ICON_LABEL="${DEV_ICON_LABEL##*/}"
    DEV_ICON_SLUG="$(node -e 'const label = process.argv[1] || "local"; process.stdout.write(label.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "local");' "$DEV_ICON_LABEL")"
    DEV_ICON_CACHE_KEY="$(node -e 'const { createHash } = require("node:crypto"); const { readFileSync } = require("node:fs"); const [label, ...files] = process.argv.slice(1); const hash = createHash("sha256"); hash.update(label); for (const file of files) hash.update(readFileSync(file)); process.stdout.write(hash.digest("hex").slice(0, 12));' "$DEV_ICON_LABEL" scripts/generate-dev-icon.mjs src-tauri/icons/icon.icns)"
    DEV_ICON_PNG="$ICON_DIR/icon-${DEV_ICON_SLUG}-${DEV_ICON_CACHE_KEY}.png"
    DEV_APP_ICON="$ICON_DIR/icon-${DEV_ICON_SLUG}-${DEV_ICON_CACHE_KEY}.icns"
    if node scripts/generate-dev-icon.mjs src-tauri/icons/icon.icns "$DEV_ICON_PNG" "$DEV_ICON_LABEL" && \
       node scripts/generate-dev-icon.mjs src-tauri/icons/icon.icns "$DEV_APP_ICON" "$DEV_ICON_LABEL"; then
        export GOOSE_INTERNAL_DEV_APP_NAME="Goose (${DEV_ICON_LABEL})"
        export GOOSE_INTERNAL_DEV_APP_ICON="$DEV_ICON_PNG"
        DEV_ICON_CONFIG="$(node -e 'const [label, icns, png] = process.argv.slice(1); process.stdout.write(JSON.stringify({ productName: `Goose (${label})`, bundle: { icon: [icns, png] } }));' "$DEV_ICON_LABEL" "$DEV_APP_ICON" "$DEV_ICON_PNG")"
        echo "Using blue dev icon: ${DEV_ICON_PNG} (${DEV_ICON_LABEL})"
        EXTRA_CONFIG_ARGS+=(--config "$DEV_ICON_CONFIG")
    fi

    pnpm tauri dev --features app-test-driver --config src-tauri/tauri.dev.conf.json "${EXTRA_CONFIG_ARGS[@]}"

dev-debug: dev

dev-frontend:
    pnpm dev

# Resolve a Goose ref/tag/sha, update goose-backend.lock.json, and refresh the SDK schema.
bump-goose ref="main":
    ./scripts/update-goose-backend-lock.sh "{{ ref }}"
    just sync-schema

# Generate release notes from commits since the previous release tag (formatting guidelines: scripts/release-notes-prompt.md).
release-notes from="" to="HEAD":
    FROM_REF="{{ from }}" TO_REF="{{ to }}" ./scripts/generate-release-notes.sh

# ── Utilities ────────────────────────────────────────────────

clean:
    cd src-tauri && CARGO_TARGET_DIR="{{ tauri_cargo_target_dir }}" cargo clean
    rm -rf dist node_modules sdk/node_modules sdk/dist

stage-sidecar:
    ./scripts/prepare-goose-sidecar.sh

avatars-manifest source version:
    pnpm avatars:manifest -- --source="{{ source }}" --version="{{ version }}"

avatars-publish source:
    pnpm avatars:publish -- --source="{{ source }}"

avatars-promote version:
    pnpm avatars:promote -- --version="{{ version }}"

artifacts-manifest source version:
    pnpm artifacts:manifest -- --source="{{ source }}" --version="{{ version }}"

artifacts-publish source version="":
    #!/usr/bin/env bash
    set -euo pipefail
    if [[ -n "{{ version }}" ]]; then
      pnpm artifacts:publish -- --source="{{ source }}" --version="{{ version }}"
    else
      pnpm artifacts:publish -- --source="{{ source }}"
    fi

artifacts-promote version:
    pnpm artifacts:promote -- --version="{{ version }}"

# Delete the silent migration marker(s) so the next launch re-runs the migration.
reset-migration:
    #!/usr/bin/env bash
    set -euo pipefail

    case "$(uname -s)" in
        Darwin)
            base="$HOME/Library/Application Support"
            ;;
        Linux)
            base="${XDG_DATA_HOME:-$HOME/.local/share}"
            ;;
        *)
            echo "❌ Unsupported platform: $(uname -s)" >&2
            exit 1
            ;;
    esac

    removed=0
    for ident in com.squareup.goose-internal com.squareup.goose-internal.dev; do
        marker="$base/$ident/migration.json"
        if [[ -f "$marker" ]]; then
            rm -v "$marker"
            removed=$((removed + 1))
        fi
    done

    if [[ $removed -eq 0 ]]; then
        echo "No migration marker found under $base/com.squareup.goose-internal{,.dev}/."
    fi
