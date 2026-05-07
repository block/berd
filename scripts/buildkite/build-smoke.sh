#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."
# shellcheck source=lib.sh
source scripts/buildkite/lib.sh

pnpm_install
build_sdk

section "Frontend production build"
pnpm build
