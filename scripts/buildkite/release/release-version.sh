#!/usr/bin/env bash
# Print the resolved release version. For official builds this is the `version`
# Buildkite meta-data value (same one set by the pipeline's input step); for
# custom builds it carries the `-<custom_name>` suffix build-macos.sh stamps.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/buildkite/release/lib.sh
source "$SCRIPT_DIR/lib.sh"
resolve_release_version
