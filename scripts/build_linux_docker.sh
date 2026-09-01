#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

DOCKER="${DOCKER:-docker}"
IMAGE="${GOOSE_LINUX_BUILDER_IMAGE:-goose-internal-linux-builder:bookworm}"
OUTPUT_DIR="${GOOSE_LINUX_DOCKER_OUTPUT:-$repo_root/dist/linux-docker}"
NPM_REGISTRY="${NPM_CONFIG_REGISTRY:-${COREPACK_NPM_REGISTRY:-}}"
if [[ -z "$NPM_REGISTRY" ]] && command -v npm >/dev/null 2>&1; then
  configured_registry="$(npm config get registry 2>/dev/null || true)"
  if [[ -n "$configured_registry" && "$configured_registry" != "undefined" ]]; then
    NPM_REGISTRY="$configured_registry"
  fi
fi
DOCKER_PLATFORM="${DOCKER_PLATFORM:-}"

if [[ -z "$DOCKER_PLATFORM" && "$(uname -s)" != "Linux" ]]; then
  DOCKER_PLATFORM="linux/amd64"
fi

if ! command -v "$DOCKER" >/dev/null 2>&1; then
  echo "required tool missing: $DOCKER" >&2
  exit 1
fi

mkdir -p \
  .docker-cache/cargo \
  .docker-cache/goose-dev \
  .docker-cache/pnpm-store \
  .docker-cache/tauri-target \
  .docker-home

docker_build_args=(
  build
  -t "$IMAGE"
  -f docker/linux/Dockerfile
)

if [[ -n "${NODE_EXTRA_CA_CERTS:-}" && -r "$NODE_EXTRA_CA_CERTS" ]]; then
  docker_build_args+=(--secret "id=node_extra_ca,src=$NODE_EXTRA_CA_CERTS")
fi

if [[ -n "$DOCKER_PLATFORM" ]]; then
  docker_build_args+=(--platform "$DOCKER_PLATFORM")
fi

if [[ -n "$NPM_REGISTRY" ]]; then
  docker_build_args+=(--build-arg "NPM_REGISTRY=$NPM_REGISTRY")
fi

"$DOCKER" "${docker_build_args[@]}" docker/linux

docker_run_args=(
  run
  --rm
  -e HOME=/work/.docker-home
  -e CARGO_HOME=/work/.docker-cache/cargo
  -e RUSTUP_HOME=/usr/local/rustup
  -e PATH=/usr/local/cargo/bin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
  -e GOOSE_DEV_ROOT=/work/.docker-cache/goose-dev
  -e BERD_TAURI_CARGO_TARGET_DIR=/work/.docker-cache/tauri-target
  -v "$repo_root:/work"
  -w /work
)

vite_env_names=(
  VITE_ENVIRONMENT
  VITE_AUTH_GATE
  VITE_AGENT_TOOLS
  VITE_AUTOMATIONS
  VITE_BUILDERBOT
  VITE_FEEDBACK
  VITE_FEEDBACK_SURVEYS
  VITE_MANAGED_CONNECTIONS
  VITE_SKILL_DISCOVERY
  VITE_TELEMETRY_ENFORCED
  VITE_VOICE_DICTATION
  VITE_BYO_KEY_PROVIDERS
  VITE_SECURITY_ML
  VITE_UPDATER_ENABLED
  VITE_BETA_LINEAR_LABEL_ID
)
for name in "${vite_env_names[@]}"; do
  value="${!name:-}"
  [[ -n "$value" ]] && docker_run_args+=(-e "$name=$value")
done

if [[ -n "${DOCKER_PLATFORM:-}" ]]; then
  docker_run_args+=(--platform "$DOCKER_PLATFORM")
fi

if [[ "$(uname -s)" != "Linux" ]]; then
  docker_run_args+=(--user "$(id -u):$(id -g)")
fi

if [[ -n "${NODE_EXTRA_CA_CERTS:-}" && -r "$NODE_EXTRA_CA_CERTS" ]]; then
  cp "$NODE_EXTRA_CA_CERTS" .docker-cache/host-extra-ca.crt
  docker_run_args+=(
    -e NODE_EXTRA_CA_CERTS=/work/.docker-cache/host-extra-ca.crt
  )
fi

if [[ -n "$NPM_REGISTRY" ]]; then
  docker_run_args+=(
    -e NPM_CONFIG_REGISTRY="$NPM_REGISTRY"
    -e npm_config_registry="$NPM_REGISTRY"
  )
fi

"$DOCKER" "${docker_run_args[@]}" "$IMAGE" bash -c '
  set -euo pipefail
  if [[ -n "${NPM_CONFIG_REGISTRY:-}" ]]; then
    npm config set registry "$NPM_CONFIG_REGISTRY"
    pnpm config set registry "$NPM_CONFIG_REGISTRY"
  fi
  pnpm config set store-dir /work/.docker-cache/pnpm-store
  pnpm config set confirmModulesPurge false
  CI=true pnpm install
  cd sdk && pnpm build
  cd /work
  GOOSE_DEV_MODE=required GOOSE_BUILD_PROFILE=release ./scripts/ensure-local-goose.sh
  ./scripts/build_linux.sh
'

bundle_dir=".docker-cache/tauri-target/release/bundle"
if [[ ! -d "$bundle_dir" ]]; then
  echo "Expected Linux bundle output under $bundle_dir, but it was not found." >&2
  exit 1
fi

rm -rf "$OUTPUT_DIR"
mkdir -p "$OUTPUT_DIR"
find "$bundle_dir" -type f \( -name '*.deb' -o -name '*.AppImage' \) \
  -exec cp '{}' "$OUTPUT_DIR/" \;

echo "Linux Docker bundle artifacts:"
find "$OUTPUT_DIR" -maxdepth 1 -type f -print | sort
