# Shared Node wrapper generation for ACP bridge tools staged from npm.
# Sourced by ensure-acp-tools.sh and prepare-acp-tools-resource.sh so the
# wrapper staged into the dev cache and the wrapper bundled into app
# resources cannot drift (a drift would make dev and bundled installs fail
# differently on the same missing/old Node runtime).
#
# acp_required_node_major <node-engine>
#   Prints the minimum Node.js major version implied by a ">=N..." engine
#   range, defaulting to 22 when the range is not in that form. Shared by
#   the wrapper shim below and the node-runtime.json manifest consumed by
#   the app's Node.js runtime doctor check, so the version the wrapper
#   enforces at spawn time and the version the doctor reports at setup
#   time cannot disagree.
acp_required_node_major() {
  local node_engine="$1"
  local major
  major="$(printf '%s\n' "$node_engine" | sed -n 's/^>=\([0-9][0-9]*\).*$/\1/p')"
  if [[ -z "$major" ]]; then
    major=22
  fi
  printf '%s\n' "$major"
}

# write_node_wrapper <wrapper> <entrypoint> [node-engine]
#   Writes an executable bash shim at <wrapper> that verifies a Node.js
#   runtime satisfying <node-engine> (default ">=22") is on PATH, then
#   execs node on <entrypoint>. An absolute <entrypoint> is embedded
#   verbatim; a relative one is resolved against the wrapper's directory
#   at run time.

write_node_wrapper() {
  local wrapper="$1"
  local entrypoint="$2"
  local node_engine="${3:->=22}"
  local required_node_major
  required_node_major="$(acp_required_node_major "$node_engine")"

  mkdir -p "$(dirname "$wrapper")"
  {
    printf '#!/usr/bin/env bash\n'
    printf 'set -euo pipefail\n'
    printf 'if ! command -v node >/dev/null 2>&1; then\n'
    printf '  echo "%s requires Node.js %s on PATH." >&2\n' "$(basename "$wrapper")" "$node_engine"
    printf '  exit 127\n'
    printf 'fi\n'
    printf 'required_node_major=%q\n' "$required_node_major"
    printf 'node_major="$(node -p '\''process.versions.node.split(".")[0]'\'' 2>/dev/null || true)"\n'
    printf 'if [[ -z "$node_major" || "$node_major" -lt "$required_node_major" ]]; then\n'
    printf '  echo "%s requires Node.js %s on PATH." >&2\n' "$(basename "$wrapper")" "$node_engine"
    printf '  exit 1\n'
    printf 'fi\n'
    if [[ "$entrypoint" == /* ]]; then
      printf 'entrypoint=%q\n' "$entrypoint"
    else
      printf 'wrapper_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"\n'
      printf 'entrypoint="$wrapper_dir"/%q\n' "$entrypoint"
    fi
    printf 'exec node "$entrypoint" "$@"\n'
  } > "$wrapper"
  chmod +x "$wrapper"
}
