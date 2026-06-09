#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."
# shellcheck source=lib.sh
source scripts/buildkite/lib.sh

pnpm_install
build_sdk

section "Install Playwright browser"
pnpm exec playwright install --with-deps chromium

section "Transcript virtualization real-renderer validation"
pnpm test:transcript-virtualization:ci
