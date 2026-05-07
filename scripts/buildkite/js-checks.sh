#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."
# shellcheck source=lib.sh
source scripts/buildkite/lib.sh

pnpm_install
build_sdk

section "Biome and i18n checks"
pnpm check

section "TypeScript typecheck"
pnpm typecheck

section "Vitest suite"
pnpm test
