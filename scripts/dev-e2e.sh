#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

if [[ $# -gt 1 ]]; then
  echo "usage: $0 [absolute-run-root]" >&2
  exit 2
fi

run_root="${1:-${BERD_E2E_RUN_ROOT:-}}"
if [[ -z "$run_root" ]]; then
  run_root="$(mktemp -d "${TMPDIR:-/tmp}/berd-e2e-XXXXXX")"
fi
if [[ "$run_root" != /* ]]; then
  echo "dev-e2e: run root must be absolute" >&2
  exit 2
fi
mkdir -p "$run_root"
run_root="$(cd "$run_root" && pwd -P)"

contract_args=(--run-root "$run_root")
[[ -n "${BERD_E2E_RUN_ID:-}" ]] && contract_args+=(--run-id "$BERD_E2E_RUN_ID")
[[ -n "${APP_TEST_DRIVER_TOKEN:-}" ]] && contract_args+=(--driver-token "$APP_TEST_DRIVER_TOKEN")
[[ -n "${BERD_E2E_PROVIDER_ID:-}" ]] && contract_args+=(--provider-id "$BERD_E2E_PROVIDER_ID")
[[ -n "${BERD_E2E_MODEL_ID:-}" ]] && contract_args+=(--model-id "$BERD_E2E_MODEL_ID")
[[ -n "${BERD_E2E_PROVIDER_KEY_ENV:-}" ]] && contract_args+=(--provider-key-env "$BERD_E2E_PROVIDER_KEY_ENV")
[[ -n "${BERD_E2E_RUNTIME_CONFIG:-}" ]] && contract_args+=(--runtime-config "$BERD_E2E_RUNTIME_CONFIG")
contract_json="$(node scripts/e2e-run-contract.mjs "${contract_args[@]}")"
if [[ -n "${BERD_E2E_PROVIDER_KEY_ENV:-}" ]]; then
  unset "$BERD_E2E_PROVIDER_KEY_ENV"
fi
eval "$(node -e '
const contract = JSON.parse(process.argv[1]);
for (const [name, value] of Object.entries(contract)) {
  process.stdout.write(`export ${name}=${JSON.stringify(value)}\n`);
}
' "$contract_json")"

if [[ -n "${GOOSE_BIN:-}" ]]; then
  just _setup-no-goose
else
  GOOSE_BUILD_PROFILE=debug just setup
fi

export VITE_PORT="$(python3 -c "import hashlib,os; h=int(hashlib.sha256(os.getcwd().encode()).hexdigest(),16); print(10000 + h % 55000)")"
export VITE_DESIGN_SYSTEM_EXPLORER=1
export RUST_LOG="${RUST_LOG:-perf=debug,info}"
export CARGO_TARGET_DIR="$(bash ./scripts/resolve-tauri-cargo-target-dir.sh)"
eval "$(./scripts/resolve-app-version.sh)"
export VITE_APP_VERSION="$BERD_APP_VERSION_RICH"

BERDCTL_FEATURES=()
[[ "${VITE_FEEDBACK:-0}" == "1" ]] && BERDCTL_FEATURES+=(--features block-feedback)
[[ "${VITE_AUTOMATIONS:-0}" == "1" ]] && BERDCTL_FEATURES+=(--features block-automations)
# ${arr[@]+...} guards the empty-array expansion, which bash 3.2 (stock
# macOS) treats as an unbound variable under `set -u`.
(cd src-tauri && cargo build -p berdctl ${BERDCTL_FEATURES[@]+"${BERDCTL_FEATURES[@]}"})
export BERDCTL_BIN="${CARGO_TARGET_DIR}/debug/berdctl"
if [[ "${VITE_AGENT_TOOLS:-0}" == "1" ]]; then
  ./scripts/prepare-bb-cli-resource.sh
fi
if [[ -z "${GOOSE_BIN:-}" ]]; then
  export GOOSE_BIN="$(GOOSE_BUILD_PROFILE=debug ./scripts/ensure-local-goose.sh --check-bin)"
fi
if [[ -z "${GOOSE_DISTRO_DIR:-}" && -d "$REPO_ROOT/distro" ]]; then
  export GOOSE_DISTRO_DIR="$REPO_ROOT/distro"
fi

printf 'Isolated E2E run root: %s\n' "$BERD_E2E_RUN_ROOT"
printf 'Driver readiness: %s\n' "$APP_TEST_DRIVER_READY_FILE"
printf 'Client environment (contains the driver token): %s/client.env\n' "$BERD_E2E_RUN_ROOT"
printf 'BERD_E2E_RUN_ROOT=%q\nAPP_TEST_DRIVER_TOKEN=%q\n' \
  "$BERD_E2E_RUN_ROOT" "$APP_TEST_DRIVER_TOKEN" > "$BERD_E2E_RUN_ROOT/client.env"
chmod 600 "$BERD_E2E_RUN_ROOT/client.env"

CARGO_FEATURES="$(./scripts/block-feature-gates.sh "berdctl,app-test-driver")"
VITE_AUTH_GATE="${VITE_BUILDERBOT:-0}" pnpm tauri dev \
  --features "$CARGO_FEATURES" \
  --config src-tauri/tauri.dev.conf.json \
  --config "$TAURI_E2E_CONFIG" \
  --config "{\"version\":\"${BERD_APP_VERSION}\",\"build\":{\"devUrl\":\"http://localhost:${VITE_PORT}\",\"beforeDevCommand\":{\"script\":\"exec pnpm exec vite --port ${VITE_PORT} --strictPort\",\"cwd\":\"..\",\"wait\":false}}}" &
tauri_pid=$!

terminate_tree() {
  local parent_pid="$1"
  local child_pid
  while read -r child_pid; do
    [[ -n "$child_pid" ]] && terminate_tree "$child_pid"
  done < <(pgrep -P "$parent_pid" 2>/dev/null || true)
  kill -TERM "$parent_pid" 2>/dev/null || true
}

shutdown() {
  trap - INT TERM
  terminate_tree "$tauri_pid"
  wait "$tauri_pid" 2>/dev/null || true
  rm -f "$APP_TEST_DRIVER_READY_FILE"
  find "$BERD_E2E_RUN_ROOT/processes" -type f -delete 2>/dev/null || true
}
trap shutdown INT TERM

set +e
wait "$tauri_pid"
status=$?
set -e
trap - INT TERM
exit "$status"
