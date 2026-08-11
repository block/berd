#!/bin/sh
# Configure Block's trusted registry only for Buildkite workers. Public clones
# deliberately inherit pnpm/Corepack's public defaults after root .npmrc removal.
configure_buildkite_npm_registry() {
  if [ -n "${BUILDKITE:-}" ]; then
    registry="https://global.block-artifacts.com/artifactory/api/npm/square-npm/"
    export npm_config_registry="$registry"
    export COREPACK_NPM_REGISTRY="$registry"
    # Artifactory mirrors packages but not npm's Corepack signing keys.
    export COREPACK_INTEGRITY_KEYS=0
  fi
}
