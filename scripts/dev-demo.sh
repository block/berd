#!/usr/bin/env bash
# Launch the persistent, manually populated Berd Demo development instance.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

if [[ $# -ne 0 ]]; then
  echo "usage: $0" >&2
  exit 2
fi

case "$(uname -s)" in
  Darwin) default_root="${HOME}/Library/Application Support/Berd Demo" ;;
  *) default_root="${XDG_DATA_HOME:-${HOME}/.local/share}/berd-demo" ;;
esac

demo_root="${BERD_DEMO_ROOT:-$default_root}"
if [[ "$demo_root" != /* ]]; then
  echo "dev-demo: BERD_DEMO_ROOT must be an absolute path" >&2
  exit 2
fi
mkdir -p "$demo_root/goose" "$demo_root/builderbot"
demo_root="$(cd "$demo_root" && pwd -P)"

# The identifier isolates all Tauri-managed app data. GOOSE_PATH_ROOT redirects
# Goose config, data, state, agents, and plugins; disabling its keyring prevents
# fallback reads from the normal Goose secret store. Builderbot auth is kept in
# this root as well.
export BERD_DEV_IDENTIFIER="xyz.block.berd.demo"
# Keep the normal in-window/window title; the lowercase demo badge on the icon
# distinguishes this isolated instance without adding “Berd Demo” to the chrome.
# Product name also scopes WKWebView storage on macOS. Keep it unique so the
# Home canvas cannot leak in from another Berd dev build; the window title is
# independently blank below.
export BERD_DEV_PRODUCT_NAME="Berd Demo"
export BERD_DEV_PROCESS_NAME="Berd (demo)"
# Keep native window metadata discoverable by screen-recording tools. Tauri's
# hiddenTitle setting prevents this text from appearing in the chrome.
export BERD_DEV_WINDOW_TITLE="Berd Demo"
export BERD_DEV_LABEL="demo"
export BERD_DEV_APP_FEATURES="berdctl"
# Prevent the developer login environment's managed Databricks host from
# shadowing values saved into this demo's isolated Goose configuration.
export VITE_BYO_KEY_PROVIDERS="1"
# Keep the demo runnable beside the ordinary dev instance from this worktree.
export VITE_PORT="${VITE_PORT:-48848}"
# Other worktrees normally share one Tauri target and can overwrite the dev
# executable while the demo is running. Keep this build artifact isolated too.
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$demo_root/cargo-target}"
export GOOSE_PATH_ROOT="$demo_root/goose"
export GOOSE_DISABLE_KEYRING="1"
export GOOSE_ADDITIONAL_CONFIG_FILES=""
export BB_HOME="$demo_root/builderbot"
export BB_AUTH_STORAGE="file"
export BB_AUTH_STORAGE_FILE="$demo_root/builderbot/sessions.json"

# This is an ordinary development launch, never an E2E/app-driver launch, even
# when the caller's shell has test variables set.
unset BERD_E2E_MODE BERD_E2E_RUN_ID BERD_E2E_RUN_ROOT BERD_E2E_RUNTIME_CONFIG
unset APP_TEST_DRIVER_TOKEN

printf 'Berd Demo root: %s\n' "$demo_root"
printf 'Tauri identifier: %s\n' "$BERD_DEV_IDENTIFIER"
printf 'Goose state: %s\n' "$GOOSE_PATH_ROOT"

if [[ "${BERD_DEMO_DRY_RUN:-0}" == "1" ]]; then
  exit 0
fi

exec just dev
