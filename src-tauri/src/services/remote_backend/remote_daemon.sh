#!/usr/bin/env bash
# Berd remote backend bootstrap. Delivered over ssh stdin as `bash -s -- <nonce> <mode> [<b64arg>]`
# so no script text, secret, or user path ever appears in remote argv.
#
# Line protocol: every protocol line starts with the per-invocation nonce so
# shell rc noise on stdout is ignored by the caller. Values that may contain
# arbitrary bytes travel base64-encoded.
#
# Modes:
#   ensure   [b64 extra `goose serve` args]  -> READY <pid> <port> <secret> <reused> <b64version> <started>
#   shutdown                                  -> STOPPED
#   check                                     -> TOOL <binary> <0|1> <b64version|-> ... CHECK-DONE
#   listdir  <b64 absolute-or-~ path>         -> DIR <b64resolved>, E <D|F> <b64name> ..., LIST-DONE
#
# Typed exit codes: 41 goose-not-found, 43 port-bind-failed, 44 bad-path, 45 no-such-dir.
set -u

NONCE="${1:?nonce required}"
MODE="${2:?mode required}"
ARG="${3:--}"

STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/berd/remote"
RECORD="$STATE_DIR/daemon.record"
LOG="$STATE_DIR/goose-serve.log"

emit() { printf '%s %s\n' "$NONCE" "$*"; }

b64() { printf %s "$1" | base64 | tr -d '\n'; }
unb64() { printf %s "$1" | base64 --decode; }

port_listening() {
  (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null
}

read_record() {
  # shellcheck disable=SC2034
  IFS=' ' read -r rec_pid rec_port rec_secret rec_b64version rec_started <"$RECORD" 2>/dev/null || return 1
  [ -n "${rec_pid:-}" ] && [ -n "${rec_port:-}" ] && [ -n "${rec_secret:-}" ]
}

ensure_daemon() {
  umask 077
  mkdir -p "$STATE_DIR" || {
    emit "ERR state-dir"
    exit 46
  }

  if [ -f "$RECORD" ] && read_record; then
    if kill -0 "$rec_pid" 2>/dev/null && port_listening "$rec_port"; then
      emit "READY $rec_pid $rec_port $rec_secret 1 $rec_b64version $rec_started"
      return 0
    fi
    rm -f "$RECORD"
  fi

  command -v goose >/dev/null 2>&1 || {
    emit "ERR goose-not-found"
    exit 41
  }
  version="$(goose --version 2>/dev/null | head -n 1)"
  [ -n "$version" ] || version="unknown"
  secret="berd-remote-$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')"

  extra_args=""
  if [ "$ARG" != "-" ]; then
    extra_args="$(unb64 "$ARG")"
  fi

  attempt=0
  while [ "$attempt" -lt 5 ]; do
    attempt=$((attempt + 1))
    port=$(((RANDOM % 40000) + 20000))
    if port_listening "$port"; then
      continue
    fi
    # Detached: nohup + fully redirected stdio survives the ssh session ending
    # (no PTY is allocated, and non-interactive bash does not forward SIGHUP).
    # shellcheck disable=SC2086
    GOOSE_SERVER__SECRET_KEY="$secret" nohup goose serve --host 127.0.0.1 --port "$port" $extra_args >>"$LOG" 2>&1 </dev/null &
    pid=$!
    i=0
    while [ "$i" -lt 150 ]; do
      if ! kill -0 "$pid" 2>/dev/null; then
        break
      fi
      if port_listening "$port"; then
        started="$(date +%s)"
        printf '%s %s %s %s %s\n' "$pid" "$port" "$secret" "$(b64 "$version")" "$started" >"$RECORD"
        emit "READY $pid $port $secret 0 $(b64 "$version") $started"
        return 0
      fi
      sleep 0.1
      i=$((i + 1))
    done
    kill "$pid" 2>/dev/null || true
  done
  emit "ERR port-bind-failed"
  exit 43
}

shutdown_daemon() {
  if [ -f "$RECORD" ] && read_record; then
    if kill -0 "$rec_pid" 2>/dev/null; then
      kill -TERM "$rec_pid" 2>/dev/null || true
      i=0
      while [ "$i" -lt 30 ] && kill -0 "$rec_pid" 2>/dev/null; do
        sleep 0.1
        i=$((i + 1))
      done
      if kill -0 "$rec_pid" 2>/dev/null; then
        kill -KILL "$rec_pid" 2>/dev/null || true
      fi
    fi
  fi
  rm -f "$RECORD"
  emit "STOPPED"
}

check_host() {
  if command -v goose >/dev/null 2>&1; then
    emit "TOOL goose 1 $(b64 "$(goose --version 2>/dev/null | head -n 1)")"
  else
    emit "TOOL goose 0 -"
  fi
  for tool in claude-agent-acp codex-acp; do
    if command -v "$tool" >/dev/null 2>&1; then
      emit "TOOL $tool 1 -"
    else
      emit "TOOL $tool 0 -"
    fi
  done
  emit "CHECK-DONE"
}

list_dir() {
  if [ "$ARG" = "-" ]; then
    emit "ERR bad-path"
    exit 44
  fi
  target="$(unb64 "$ARG")"
  case "$target" in
  "~") target="$HOME" ;;
  "~/"*) target="$HOME/${target#\~/}" ;;
  esac
  case "$target" in
  /*) ;;
  *)
    emit "ERR bad-path"
    exit 44
    ;;
  esac
  cd -- "$target" 2>/dev/null || {
    emit "ERR no-such-dir"
    exit 45
  }
  emit "DIR $(b64 "$(pwd)")"
  count=0
  for entry in * .*; do
    { [ "$entry" = "." ] || [ "$entry" = ".." ]; } && continue
    [ -e "$entry" ] || continue
    if [ -d "$entry" ]; then
      emit "E D $(b64 "$entry")"
    else
      emit "E F $(b64 "$entry")"
    fi
    count=$((count + 1))
    if [ "$count" -ge 2000 ]; then
      break
    fi
  done
  emit "LIST-DONE"
}

case "$MODE" in
ensure) ensure_daemon ;;
shutdown) shutdown_daemon ;;
check) check_host ;;
listdir) list_dir ;;
*)
  emit "ERR bad-mode"
  exit 40
  ;;
esac
