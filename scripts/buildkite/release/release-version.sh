#!/usr/bin/env bash
# Print the release version for the upload-mobile-release plugin to attach to
# the go/mr artifact record. Forwards the `version` Buildkite meta-data value
# (same one set by the pipeline's input step).
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/buildkite/release/lib.sh
source "$SCRIPT_DIR/lib.sh"
meta version
