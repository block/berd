#!/usr/bin/env bash
# Print the resolved release version. For official builds this is the `version`
# Buildkite input value exported by the pipeline adapter; for
# custom builds it carries the `-<custom_name>` suffix build-macos.sh stamps.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/release/lib.sh
source "$SCRIPT_DIR/release-inputs.sh"
load_buildkite_release_inputs version
# shellcheck source=scripts/release/lib.sh
source "$SCRIPT_DIR/../../release/lib.sh"
resolve_release_version
