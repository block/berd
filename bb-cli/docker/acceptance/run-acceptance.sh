#!/bin/sh
set -eu

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

assert_isolated_path() {
  case "$1" in
    "$HOME"|"$HOME"/*) ;;
    *) fail "acceptance path escapes isolated HOME: $1" ;;
  esac
}

[ "$(id -u)" -ne 0 ] || fail "acceptance runner must not execute as root"

RUN_ROOT="$(mktemp -d /tmp/bb-acceptance.XXXXXX)"
trap 'rm -rf "$RUN_ROOT"' EXIT HUP INT TERM
export HOME="$RUN_ROOT/home"
export BB_HOME="$HOME/.bb"
export BB_SKILLS_HOME="$BB_HOME/skills"
export BB_SKILLS_PACKAGES_DIR="$HOME/.agents/skills"
export BB_SKILLS_CONFIG="$BB_HOME/skills.yaml"
export BB_AUTH_STORAGE=file
export BB_AUTH_STORAGE_FILE="$BB_HOME/auth-sessions.json"
PROFILE=docker-acceptance
BB_COMMAND="${BB_ACCEPTANCE_BB_PATH:-bb}"
MOCK_MARKETPLACE="${BB_ACCEPTANCE_MOCK_MARKETPLACE:-/opt/bb-acceptance/mock-marketplace.py}"
MOCK_PORT="${BB_ACCEPTANCE_MOCK_PORT:-18080}"

for path in "$HOME" "$BB_HOME" "$BB_SKILLS_HOME" "$BB_SKILLS_PACKAGES_DIR" "$BB_SKILLS_CONFIG" "$BB_AUTH_STORAGE_FILE"; do
  assert_isolated_path "$path"
done
mkdir -p "$BB_HOME" "$BB_SKILLS_HOME" "$BB_SKILLS_PACKAGES_DIR/unmanaged"
printf '%s\n' 'unmanaged files must survive' > "$BB_SKILLS_PACKAGES_DIR/unmanaged/sentinel.txt"
printf '%s\n' "current_profile: $PROFILE" 'profiles:' "  $PROFILE: {}" > "$HOME/bb-local-dev-config.yaml"
cd "$HOME"

write_runtime_credential() {
  PROFILE="$PROFILE" python3 - "$BB_AUTH_STORAGE_FILE" "$1" <<'PY'
import hashlib
import json
import os
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
server_url = sys.argv[2].rstrip("/")
key = hashlib.sha256(os.environ["PROFILE"].encode() + b"\0" + server_url.encode()).hexdigest()
path.write_text(json.dumps({key: {"sessionCredential": os.environ["BB_SESSION_CREDENTIAL"]}}))
PY
  unset BB_SESSION_CREDENTIAL
}

write_report() {
  if [ -z "${BB_ACCEPTANCE_REPORT_PATH:-}" ]; then
    return 0
  fi
  python3 - "$BB_ACCEPTANCE_REPORT_PATH" "$HOME" "$BB_HOME" "$BB_SKILLS_HOME" "$BB_SKILLS_PACKAGES_DIR" "$BB_AUTH_STORAGE_FILE" "${BB_ACCEPTANCE_MODE:-mock}" <<'PY'
import json
import os
import pathlib
import sys

pathlib.Path(sys.argv[1]).write_text(json.dumps({
    "home": sys.argv[2],
    "bb_home": sys.argv[3],
    "skills_home": sys.argv[4],
    "packages_dir": sys.argv[5],
    "auth_storage_file": sys.argv[6],
    "mode": sys.argv[7],
    "uid": os.getuid(),
}))
PY
}

assert_mock_result() {
  package="$BB_SKILLS_PACKAGES_DIR/docker-harness"
  test -f "$package/SKILL.md" || fail "mock install did not create the skills-only package"
  test -f "$package/.bb-skills-meta.json" || fail "mock install did not create BB metadata"
  grep -q 'bb-skills-install/v1' "$package/.bb-skills-meta.json" || fail "mock metadata has unexpected schema"
  grep -q 'bundle:default' "$package/.bb-skills-meta.json" || fail "mock metadata lacks bundle provenance"
  test -f "$BB_SKILLS_PACKAGES_DIR/unmanaged/sentinel.txt" || fail "mock install removed unmanaged sentinel"
  assert_idempotent_result "$RUN_ROOT/repeat-install.json" "repeat install"
  assert_idempotent_result "$RUN_ROOT/update.json" "update"
}

assert_idempotent_result() {
  python3 - "$1" "$2" <<'PY'
import json
import pathlib
import sys

result = json.loads(pathlib.Path(sys.argv[1]).read_text())
operation = sys.argv[2]
if result.get("installed") != []:
    raise SystemExit(f"{operation} reinstalled marketplace content")
if "docker-harness" not in result.get("up_to_date", []):
    raise SystemExit(f"{operation} did not report docker-harness as up to date")
PY
}

run_mock() {
  export KGOOSE_BASE_URL="http://127.0.0.1:$MOCK_PORT"
  export KGOOSE_SERVICE_PATH=/api/goose
  unset BB_KGOOSE_PLAYPEN KGOOSE_PLAYPEN
  python3 "$MOCK_MARKETPLACE" --port "$MOCK_PORT" --expect-bundle default >"$RUN_ROOT/mock.log" 2>&1 &
  mock_pid=$!
  trap 'kill "$mock_pid" 2>/dev/null || true; rm -rf "$RUN_ROOT"' EXIT HUP INT TERM
  startup_attempts="${BB_ACCEPTANCE_MOCK_START_ATTEMPTS:-30}"
  attempt=1
  while ! python3 -c "import socket; socket.create_connection(('127.0.0.1', $MOCK_PORT), 1).close()" 2>/dev/null; do
    if ! kill -0 "$mock_pid" 2>/dev/null; then
      cat "$RUN_ROOT/mock.log" >&2
      fail "mock marketplace exited before becoming ready"
    fi
    if [ "$attempt" -ge "$startup_attempts" ]; then
      cat "$RUN_ROOT/mock.log" >&2
      fail "mock marketplace did not become ready after $startup_attempts attempts"
    fi
    attempt=$((attempt + 1))
    sleep 1
  done
  "$BB_COMMAND" --local-dev skills install --bundle default --yes --json >"$RUN_ROOT/first-install.json"
  "$BB_COMMAND" --local-dev skills install --bundle default --yes --json >"$RUN_ROOT/repeat-install.json"
  "$BB_COMMAND" --local-dev skills update --yes --json >"$RUN_ROOT/update.json"
  assert_mock_result
  write_report
  printf '%s\n' 'Docker mock acceptance passed.'
}

run_live() {
  [ -n "${BB_MARKETPLACE_BASE_URL:-}" ] || fail 'live mode requires BB_MARKETPLACE_BASE_URL at docker run time'
  [ -n "${BB_SESSION_CREDENTIAL:-}" ] || fail 'live mode requires BB_SESSION_CREDENTIAL at docker run time'
  export KGOOSE_BASE_URL="$BB_MARKETPLACE_BASE_URL"
  credential_service_path="${KGOOSE_SERVICE_PATH:-/cash-app/goose}"
  case "$credential_service_path" in
    /*) ;;
    *) credential_service_path="/$credential_service_path" ;;
  esac
  if [ -n "${KGOOSE_PLAYPEN:-}" ]; then
    export BB_KGOOSE_PLAYPEN="$KGOOSE_PLAYPEN"
  fi
  write_runtime_credential "${KGOOSE_BASE_URL%/}$credential_service_path"
  "$BB_COMMAND" --local-dev skills install --bundle "${BB_ACCEPTANCE_BUNDLE:-default}" --yes --json
  "$BB_COMMAND" --local-dev skills update --yes --json
  write_report
}

case "${BB_ACCEPTANCE_MODE:-mock}" in
  mock) run_mock ;;
  live) run_live ;;
  *) fail 'BB_ACCEPTANCE_MODE must be mock or live' ;;
esac
