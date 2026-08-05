# Cargo features for the full dev/CI posture of the app crate.
app_features := "berdctl,app-test-driver"

# Default recipe
default:
    @just --list

# Check or install native Windows prerequisites. Fresh Windows machines only
# need `winget install --id Casey.Just -e` before this entrypoint is available.
bootstrap-windows mode="check":
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/windows/Bootstrap-Windows.ps1 -Mode "{{ mode }}"

# Report native Windows readiness for first-milestone Berd verification.
doctor-windows:
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/windows/Doctor-Windows.ps1

# Dry-run or remove native Windows onboarding state.
cleanup-windows *ARGS:
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/windows/Cleanup-Windows.ps1 {{ ARGS }}

# Install pnpm dependencies, build the SDK, install hooks, and build pinned Goose natively on Windows.
setup-windows:
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/windows/Setup-Windows.ps1

# Launch the native Windows Tauri dev app with managed goose.exe and berdctl.exe.
dev-windows:
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/windows/Dev-Windows.ps1

# Run Windows-native Rust/Tauri checks with external sidecars disabled.
tauri-check-windows:
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/windows/Tauri-Check-Windows.ps1

# Run focused tests for Windows script path/stamp helpers.
test-windows-dev:
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/windows/Test-WindowsDev.ps1

# ── Dev Environment ──────────────────────────────────────────

# Sync and build the pinned managed local Goose checkout used for Berd development.
goose-sync:
    GOOSE_DEV_MODE=required ./scripts/ensure-local-goose.sh

# Regenerate the vendored ACP schema from the pinned Goose backend and rebuild the SDK (kept out of setup; mutates tracked files).
sync-schema:
    ./scripts/regenerate-sdk-schema.sh

# Install dependencies and build workspace packages.
_setup-dev-deps:
    pnpm install
    cd sdk && pnpm build

_install-lefthook:
    if [ -d .git ]; then lefthook install --force; else echo "Skipping lefthook install in Git worktree"; fi

# Install dependencies, build workspace packages, and prepare local development hooks.
_setup-no-goose: _setup-dev-deps
    just _install-lefthook

# Install dependencies, build workspace packages, build managed Goose, and prepare local development hooks.
setup: _setup-dev-deps
    GOOSE_DEV_MODE=required ./scripts/ensure-local-goose.sh
    just _install-lefthook

# ── Build & Check ────────────────────────────────────────────

# Run the frontend non-test checks: design-system guardrails, berdctl contract freshness, formatting, lint, i18n, and TypeScript.
check: design-system-check berdctl-contract-check frontend-fmt-check lint i18n-check typecheck

# Regenerate the berdctl CLI contract artifacts from the command registry.
berdctl-contract-generate:
    pnpm generate:berdctl-contract

# Check that the generated berdctl contract artifacts are up to date.
berdctl-contract-check:
    pnpm generate:berdctl-contract --check

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

# Check that app color usage follows the shadcn + Berd token contract.
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

# Run react-doctor static analysis as an advisory report (fully offline, no telemetry).
# Forwards extra flags, e.g. `just react-doctor --verbose` or `just react-doctor --json`.
react-doctor *ARGS:
    pnpm exec react-doctor --project berd --no-score --blocking none {{ ARGS }}

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

_tauri-cargo-unix *ARGS:
    TAURI_CARGO_TARGET_DIR="$(bash ./scripts/resolve-tauri-cargo-target-dir.sh)" && cd src-tauri && CARGO_TARGET_DIR="$TAURI_CARGO_TARGET_DIR" TAURI_CONFIG='{"bundle":{"externalBin":[]}}' cargo {{ ARGS }}

_tauri-cargo-windows *ARGS:
    #!powershell.exe -NoProfile -ExecutionPolicy Bypass
    $ErrorActionPreference = "Stop"
    Import-Module (Join-Path (Get-Location) "scripts/windows/WindowsDev.psm1") -Force -DisableNameChecking
    Assert-WindowsHost
    Update-SessionPathFromRegistry
    Assert-MsvcEnvironment
    Set-Location (Join-Path (Get-BerdRepoRoot) "src-tauri")
    $env:CARGO_TARGET_DIR = Get-TauriCargoTargetDir
    $env:TAURI_CONFIG = '{"bundle":{"externalBin":[]}}'
    cargo {{ ARGS }}
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

# Run Rust clippy with warnings denied.
clippy:
    just _clippy-{{ os_family() }}

_clippy-unix:
    just _tauri-cargo-unix clippy -- -D warnings
    just _tauri-cargo-unix clippy --features {{ app_features }} -- -D warnings
    just _tauri-cargo-unix clippy -p berdctl -- -D warnings
    just _tauri-cargo-unix clippy -p tauri-plugin-berdctl --features server -- -D warnings

_clippy-windows:
    just _tauri-cargo-windows clippy -- -D warnings
    just _tauri-cargo-windows clippy --features {{ app_features }} -- -D warnings
    just _tauri-cargo-windows clippy -p berdctl -- -D warnings
    just _tauri-cargo-windows clippy -p tauri-plugin-berdctl --features server -- -D warnings

# Build the frontend.
build:
    pnpm build

# Check the Tauri/Rust crate with external sidecars disabled.
tauri-check:
    just _tauri-check-{{ os_family() }}

_tauri-check-unix:
    just _tauri-cargo-unix check
    just _tauri-cargo-unix check --features {{ app_features }}
    just _tauri-cargo-unix check -p berdctl

_tauri-check-windows:
    just tauri-check-windows

# Run the Rust plugin tests with external sidecars disabled.
tauri-test:
    just _tauri-test-{{ os_family() }}

_tauri-test-unix:
    just _tauri-cargo-unix test -p tauri-plugin-berdctl --features server
    just _tauri-cargo-unix test -p berdctl

_tauri-test-windows:
    just _tauri-cargo-windows test -p tauri-plugin-berdctl --features server
    just _tauri-cargo-windows test -p berdctl

# Run the local CI gate.
ci: check tauri-fmt-check tauri-check tauri-test clippy test release-scripts-test build

# Run release/updater script tests.
release-scripts-test:
    pnpm test:release-scripts

# ── BuilderBot CLI ───────────────────────────────────────────

# Build the BuilderBot CLI crate.
bb-cli-build:
    cd bb-cli && cargo build --locked

# Build the sq agent-tools package output.
bb-cli-build-sq:
    cd bb-cli && just build-sq

# Check BuilderBot CLI formatting and clippy.
bb-cli-lint:
    cd bb-cli && cargo fmt --all -- --check
    cd bb-cli && cargo clippy --locked --all-targets --all-features -- -D warnings

# Run BuilderBot CLI tests.
bb-cli-test:
    cd bb-cli && cargo test --locked

# Build and run the isolated, deterministic Docker acceptance harness for bb skills.
bb-cli-docker-acceptance:
    docker build --tag bb-cli-acceptance --file bb-cli/docker/acceptance/Dockerfile .
    docker run --rm bb-cli-acceptance

# Stage the pinned Goose backend into src-tauri/binaries/goosed-<target> and build bundles.
bundle:
    #!/usr/bin/env bash
    set -euo pipefail

    TAURI_CARGO_TARGET_DIR="$(bash ./scripts/resolve-tauri-cargo-target-dir.sh)"
    ./scripts/prepare-goose-sidecar.sh
    CARGO_TARGET_DIR="$TAURI_CARGO_TARGET_DIR" ./scripts/prepare-berdctl-sidecar.sh
    ./scripts/prepare-bb-cli-resource.sh
    ./scripts/prepare-catch-sidecar.sh

    # Derive a git-based version so non-release bundles don't ship the 0.1.0
    # placeholder. Injected via a temp --config overlay to keep the tree clean.
    eval "$(./scripts/resolve-app-version.sh)"
    echo "Building Berd ${BERD_APP_VERSION} (${BERD_APP_VERSION_RICH})"
    VERSION_CONFIG="$(mktemp -t berd-tauri-version.XXXXXX.json)"
    trap 'rm -f "$VERSION_CONFIG"' EXIT
    jq -n --arg v "$BERD_APP_VERSION" '{ version: $v }' > "$VERSION_CONFIG"

    TAURI_BUILD_ARGS=(pnpm tauri build --features berdctl --config "$VERSION_CONFIG")
    if [[ "$(uname -s)" = "Darwin" ]]; then
      TAURI_BUILD_ARGS+=(--bundles app)
    fi

    CARGO_TARGET_DIR="$TAURI_CARGO_TARGET_DIR" \
      VITE_AUTH_GATE=0 \
      VITE_APP_VERSION="$BERD_APP_VERSION_RICH" \
      "${TAURI_BUILD_ARGS[@]}"

    if [[ "$(uname -s)" = "Darwin" ]]; then
      APP_PATH="$TAURI_CARGO_TARGET_DIR/release/bundle/macos/Berd.app"
      # Local Tauri builds are ad-hoc signed before resources are sealed. Re-sign
      # after app bundling so the local DMG contains a verifiable app bundle.
      codesign --force --deep --sign - "$APP_PATH"
      DMG_DIR="$TAURI_CARGO_TARGET_DIR/release/bundle/dmg"
      mkdir -p "$DMG_DIR"
      case "$(uname -m)" in
        arm64) DMG_ARCH="aarch64" ;;
        *) DMG_ARCH="$(uname -m)" ;;
      esac
      ./scripts/package-macos-dmg.sh "$APP_PATH" "$DMG_DIR/berd_${BERD_APP_VERSION}_${DMG_ARCH}.dmg"
    fi

# Build macOS app and DMG bundles.
bundle-macos:
    ./scripts/build_darwin.sh

# Build Linux deb, rpm, and AppImage bundles. Must run on Linux.
bundle-linux:
    ./scripts/build_linux.sh

# Build Linux deb, rpm, and AppImage bundles inside Docker.
bundle-linux-docker:
    ./scripts/build_linux_docker.sh

# Stage the pinned Goose backend and build a release bundle with WebView devtools enabled.
bundle-debug:
    #!/usr/bin/env bash
    set -euo pipefail

    TAURI_CARGO_TARGET_DIR="$(bash ./scripts/resolve-tauri-cargo-target-dir.sh)"
    ./scripts/prepare-goose-sidecar.sh
    CARGO_TARGET_DIR="$TAURI_CARGO_TARGET_DIR" ./scripts/prepare-berdctl-sidecar.sh
    ./scripts/prepare-bb-cli-resource.sh
    ./scripts/prepare-catch-sidecar.sh

    # Use a temporary config overlay so normal release bundles keep devtools
    # disabled, and fold in the git-derived version so the bundle doesn't ship
    # the 0.1.0 placeholder.
    eval "$(./scripts/resolve-app-version.sh)"
    echo "Building Berd ${BERD_APP_VERSION} (${BERD_APP_VERSION_RICH})"
    DEBUG_CONFIG="$(mktemp -t berd-tauri-debug.XXXXXX.json)"
    trap 'rm -f "$DEBUG_CONFIG"' EXIT
    jq --arg v "$BERD_APP_VERSION" '.version = $v | .app.windows[0].devtools = true' \
      src-tauri/tauri.conf.json > "$DEBUG_CONFIG"

    CARGO_TARGET_DIR="$TAURI_CARGO_TARGET_DIR" \
      VITE_AUTH_GATE=0 \
      VITE_APP_VERSION="$BERD_APP_VERSION_RICH" \
      pnpm tauri build --features berdctl,devtools --config "$DEBUG_CONFIG"

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

    VITE_PORT="$(python3 -c "import hashlib,os; h=int(hashlib.sha256(os.getcwd().encode()).hexdigest(),16); print(10000 + h % 55000)")"
    export VITE_PORT
    # ACP bridges install at runtime onto the Berd-managed Node runtime, the
    # same path dev and release share; set BERD_ACP_TOOLS_DIR by hand to point
    # goosed at a locally built bridge dir instead.
    export VITE_DESIGN_SYSTEM_EXPLORER=1
    export RUST_LOG="${RUST_LOG:-perf=debug,info}"
    export CARGO_TARGET_DIR="$(bash ./scripts/resolve-tauri-cargo-target-dir.sh)"
    echo "Using Tauri Cargo target dir: ${CARGO_TARGET_DIR}"

    # Derive a git-based version so dev builds don't report the 0.1.0
    # placeholder. The rich string carries the telemetry/agent-context version;
    # the numeric one is injected into Tauri's config below.
    eval "$(./scripts/resolve-app-version.sh)"
    export VITE_APP_VERSION="$BERD_APP_VERSION_RICH"
    echo "Using app version: ${BERD_APP_VERSION} (${BERD_APP_VERSION_RICH})"

    # tauri dev only builds the root package; the berdctl CLI workspace
    # member needs an explicit build, resolved at runtime via BERDCTL_BIN
    # because tauri.dev.conf.json blanks externalBin.
    (cd src-tauri && cargo build -p berdctl)
    export BERDCTL_BIN="${CARGO_TARGET_DIR}/debug/berdctl"
    echo "Using berdctl CLI: ${BERDCTL_BIN}"

    if [[ ! -x resources/bb ]]; then
        ./scripts/prepare-bb-cli-resource.sh
    fi

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

    EXTRA_CONFIG_ARGS=(--config src-tauri/tauri.dev.conf.json --config "{\"build\":{\"devUrl\":\"http://localhost:${VITE_PORT}\",\"beforeDevCommand\":{\"script\":\"exec pnpm exec vite --port ${VITE_PORT} --strictPort\",\"cwd\":\"..\",\"wait\":false}}}")
    EXTRA_CONFIG_ARGS+=(--config "{\"version\":\"${BERD_APP_VERSION}\"}")

    ICON_DIR="${CARGO_TARGET_DIR}/dev-icons"
    mkdir -p "$ICON_DIR"
    DEV_ICON_LABEL="${BERD_DEV_LABEL:-$(basename "$(git rev-parse --show-toplevel 2>/dev/null || pwd)")}"
    DEV_ICON_LABEL="$(node -e 'const raw = process.argv[1] || ""; const strip = /^(?:(?:squareup|berd)(?=$|[^a-zA-Z0-9])|[^a-zA-Z0-9]+)/i; let label = raw, prev; do { prev = label; label = label.replace(strip, ""); } while (label !== prev); process.stdout.write(label || raw);' "$DEV_ICON_LABEL")"
    if [[ -z "$DEV_ICON_LABEL" || "$DEV_ICON_LABEL" == "HEAD" ]]; then
        DEV_ICON_LABEL="local"
    fi
    DEV_ICON_SLUG="$(node -e 'const label = process.argv[1] || "local"; process.stdout.write(label.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "local");' "$DEV_ICON_LABEL")"
    DEV_ICON_CACHE_KEY="$(node -e 'const { createHash } = require("node:crypto"); const { readFileSync } = require("node:fs"); const [label, ...files] = process.argv.slice(1); const hash = createHash("sha256"); hash.update(label); for (const file of files) hash.update(readFileSync(file)); process.stdout.write(hash.digest("hex").slice(0, 12));' "$DEV_ICON_LABEL" scripts/generate-dev-icon.mjs src-tauri/icons/icon.icns)"
    DEV_ICON_PNG="$ICON_DIR/icon-${DEV_ICON_SLUG}-${DEV_ICON_CACHE_KEY}.png"
    DEV_APP_ICON="$ICON_DIR/icon-${DEV_ICON_SLUG}-${DEV_ICON_CACHE_KEY}.icns"
    if node scripts/generate-dev-icon.mjs src-tauri/icons/icon.icns "$DEV_ICON_PNG" "$DEV_ICON_LABEL" && \
       node scripts/generate-dev-icon.mjs src-tauri/icons/icon.icns "$DEV_APP_ICON" "$DEV_ICON_LABEL"; then
        export BERD_DEV_APP_NAME="Berd (${DEV_ICON_LABEL})"
        export BERD_DEV_APP_ICON="$DEV_ICON_PNG"
        DEV_ICON_CONFIG="$(node -e 'const [label, icns, png] = process.argv.slice(1); process.stdout.write(JSON.stringify({ productName: `Berd (${label})`, bundle: { icon: [icns, png] } }));' "$DEV_ICON_LABEL" "$DEV_APP_ICON" "$DEV_ICON_PNG")"
        echo "Using badged dev icon: ${DEV_ICON_PNG} (${DEV_ICON_LABEL})"
        EXTRA_CONFIG_ARGS+=(--config "$DEV_ICON_CONFIG")
    fi

    pnpm tauri dev --features {{ app_features }} "${EXTRA_CONFIG_ARGS[@]}"

dev-debug: dev

dev-frontend:
    pnpm dev

# Resolve a Goose ref/tag/sha, update goose-backend.lock.json, and refresh the SDK schema.
bump-goose ref="main":
    ./scripts/update-goose-backend-lock.sh "{{ ref }}"
    just sync-schema

# Fetch official Node.js release checksums and update node-runtime.lock.json (e.g. `just bump-node-runtime v24.12.0`).
bump-node-runtime *ARGS:
    node scripts/update-node-runtime-lock.mjs {{ ARGS }}

# Generate release notes from commits since the previous release tag (formatting guidelines: scripts/release-notes-prompt.md).
release-notes from="" to="HEAD":
    FROM_REF="{{ from }}" TO_REF="{{ to }}" ./scripts/generate-release-notes.sh

# ── Utilities ────────────────────────────────────────────────

# Scaffold a new berdctl command (see .agents/skills/berdctl-new-command/SKILL.md).
new-command noun verb:
    node scripts/new-berdctl-command.mjs {{ noun }} {{ verb }}

clean:
    just _clean-{{ os_family() }}

_clean-unix:
    just _tauri-cargo-unix clean
    rm -rf dist node_modules sdk/node_modules sdk/dist

_clean-windows:
    #!powershell.exe -NoProfile -ExecutionPolicy Bypass
    $ErrorActionPreference = "Stop"
    just _tauri-cargo-windows clean
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue dist,node_modules,sdk/node_modules,sdk/dist

stage-sidecar:
    just _stage-sidecar-{{ os_family() }}

_stage-sidecar-unix:
    TAURI_CARGO_TARGET_DIR="$(bash ./scripts/resolve-tauri-cargo-target-dir.sh)" && ./scripts/prepare-goose-sidecar.sh && CARGO_TARGET_DIR="$TAURI_CARGO_TARGET_DIR" ./scripts/prepare-berdctl-sidecar.sh && ./scripts/prepare-catch-sidecar.sh

_stage-sidecar-windows:
    #!powershell.exe -NoProfile -ExecutionPolicy Bypass
    $ErrorActionPreference = "Stop"
    Import-Module (Join-Path (Get-Location) "scripts/windows/WindowsDev.psm1") -Force -DisableNameChecking
    $bash = Get-GitBashPath
    if ([string]::IsNullOrWhiteSpace($bash)) { throw "Git Bash is required for stage-sidecar on Windows." }
    & $bash -c 'TAURI_CARGO_TARGET_DIR="$(bash ./scripts/resolve-tauri-cargo-target-dir.sh)" && ./scripts/prepare-goose-sidecar.sh && CARGO_TARGET_DIR="$TAURI_CARGO_TARGET_DIR" ./scripts/prepare-berdctl-sidecar.sh && ./scripts/prepare-catch-sidecar.sh'
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

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
    for ident in com.squareup.berd com.squareup.berd.dev; do
        marker="$base/$ident/migration.json"
        if [[ -f "$marker" ]]; then
            rm -v "$marker"
            removed=$((removed + 1))
        fi
    done

    if [[ $removed -eq 0 ]]; then
        echo "No migration marker found under $base/com.squareup.berd{,.dev}/."
    fi
