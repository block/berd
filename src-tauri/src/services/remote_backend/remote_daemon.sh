#!/usr/bin/env bash
# Berd remote backend bootstrap. Delivered over ssh stdin as
# `bash -s -- <nonce> <mode> [<b64arg>] [<b64goosepath>]` so no script text,
# secret, or user path ever appears in remote argv.
#
# Positional args:
#   $1 nonce          per-invocation protocol prefix
#   $2 mode           ensure | shutdown | check | listdir
#   $3 b64arg         mode-specific, "-" when absent: extra `goose serve` args
#                     for `ensure`, the target path for `listdir`
#   $4 b64goosepath   optional goose binary override ("-" when absent), used by
#                     `ensure` and `check`; absolute or `~/`-prefixed
#
# Line protocol: every protocol line starts with the per-invocation nonce so
# shell rc noise on stdout is ignored by the caller. Values that may contain
# arbitrary bytes travel base64-encoded.
#
# Modes:
#   ensure   [b64 serve args] [b64 goose]  -> READY <pid> <port> <secret> <reused> <b64version> <started>
#   shutdown                               -> STOPPED
#   check    [-] [b64 goose]               -> TOOL <binary> <0|1> <b64version|-> <b64path|-> ... CHECK-DONE
#   listdir  <b64 absolute-or-~ path>      -> DIR <b64resolved>, E <D|F> <b64name> ..., LIST-DONE
#
# Daemon record (single line, space separated, field order pinned):
#   v2 <pid> <port> <secret> <b64version> <started> <b64binary>
# A record without the leading `v2` marker is a pre-override (v1) record: it
# still parses for shutdown, but is never reusable because the binary that
# started it is unknown.
#
# Typed exit codes: 41 goose-not-found, 43 port-bind-failed, 44 bad-path, 45 no-such-dir.
set -u

NONCE="${1:?nonce required}"
MODE="${2:?mode required}"
ARG="${3:--}"
GOOSE_ARG="${4:--}"

STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/berd/remote"
RECORD="$STATE_DIR/daemon.record"
LOG="$STATE_DIR/goose-serve.log"
RECORD_FORMAT="v2"

emit() { printf '%s %s\n' "$NONCE" "$*"; }

b64() { printf %s "$1" | base64 | tr -d '\n'; }
unb64() { printf %s "$1" | base64 --decode; }

port_listening() {
  (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null
}

expand_home() {
  case "$1" in
  "~") printf %s "$HOME" ;;
  "~/"*) printf %s "$HOME/${1#\~/}" ;;
  *) printf %s "$1" ;;
  esac
}

# Resolves the goose command into $goose_bin: the $4 override when given,
# otherwise the ssh login PATH lookup. Exits 41 when neither answers.
resolve_goose_bin() {
  if [ "$GOOSE_ARG" != "-" ]; then
    goose_bin="$(expand_home "$(unb64 "$GOOSE_ARG")")"
    if [ -z "$goose_bin" ] || [ ! -f "$goose_bin" ] || [ ! -x "$goose_bin" ]; then
      emit "ERR goose-not-found"
      exit 41
    fi
    return 0
  fi
  goose_bin="$(command -v goose 2>/dev/null || true)"
  if [ -z "$goose_bin" ]; then
    emit "ERR goose-not-found"
    exit 41
  fi
}

# Fills rec_* from $RECORD. rec_b64binary is empty for a legacy (v1) record,
# which callers must treat as not reusable.
read_record() {
  # shellcheck disable=SC2034
  IFS=' ' read -r f1 f2 f3 f4 f5 f6 f7 <"$RECORD" 2>/dev/null || return 1
  if [ "${f1:-}" = "$RECORD_FORMAT" ]; then
    rec_pid="${f2:-}"
    rec_port="${f3:-}"
    rec_secret="${f4:-}"
    rec_b64version="${f5:--}"
    rec_started="${f6:-0}"
    rec_b64binary="${f7:-}"
  else
    # Pre-override record: no recorded binary, so it can only be shut down.
    rec_pid="${f1:-}"
    rec_port="${f2:-}"
    rec_secret="${f3:-}"
    rec_b64version="${f4:--}"
    rec_started="${f5:-0}"
    rec_b64binary=""
  fi
  case "$rec_pid" in
  '' | *[!0-9]*) return 1 ;;
  esac
  case "$rec_port" in
  '' | *[!0-9]*) return 1 ;;
  esac
  [ -n "$rec_secret" ]
}

# Terminates the pid from the last read_record, TERM then KILL.
stop_recorded_daemon() {
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
}

ensure_daemon() {
  umask 077
  mkdir -p "$STATE_DIR" || {
    emit "ERR state-dir"
    exit 46
  }

  resolve_goose_bin
  b64binary="$(b64 "$goose_bin")"

  if [ -f "$RECORD" ] && read_record; then
    if kill -0 "$rec_pid" 2>/dev/null && port_listening "$rec_port"; then
      if [ -n "$rec_b64binary" ] && [ "$rec_b64binary" = "$b64binary" ]; then
        emit "READY $rec_pid $rec_port $rec_secret 1 $rec_b64version $rec_started"
        return 0
      fi
      # A different (or unknown) goose binary is serving: stop it so the
      # requested build is the one that answers.
      stop_recorded_daemon
    fi
    rm -f "$RECORD"
  fi

  version="$("$goose_bin" --version 2>/dev/null | head -n 1)"
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
    GOOSE_SERVER__SECRET_KEY="$secret" nohup "$goose_bin" serve --host 127.0.0.1 --port "$port" $extra_args >>"$LOG" 2>&1 </dev/null &
    pid=$!
    i=0
    while [ "$i" -lt 150 ]; do
      if ! kill -0 "$pid" 2>/dev/null; then
        break
      fi
      if port_listening "$port"; then
        started="$(date +%s)"
        printf '%s %s %s %s %s %s %s\n' "$RECORD_FORMAT" "$pid" "$port" "$secret" \
          "$(b64 "$version")" "$started" "$b64binary" >"$RECORD"
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
    stop_recorded_daemon
  fi
  rm -f "$RECORD"
  emit "STOPPED"
}

check_host() {
  if [ "$GOOSE_ARG" != "-" ]; then
    probe="$(expand_home "$(unb64 "$GOOSE_ARG")")"
    if [ -n "$probe" ] && [ -f "$probe" ] && [ -x "$probe" ]; then
      emit "TOOL goose 1 $(b64 "$("$probe" --version 2>/dev/null | head -n 1)") $(b64 "$probe")"
    else
      emit "TOOL goose 0 - $(b64 "$probe")"
    fi
  elif probe="$(command -v goose 2>/dev/null)" && [ -n "$probe" ]; then
    emit "TOOL goose 1 $(b64 "$("$probe" --version 2>/dev/null | head -n 1)") $(b64 "$probe")"
  else
    emit "TOOL goose 0 - -"
  fi
  for tool in claude-agent-acp codex-acp; do
    if tool_path="$(command -v "$tool" 2>/dev/null)" && [ -n "$tool_path" ]; then
      emit "TOOL $tool 1 - $(b64 "$tool_path")"
    else
      emit "TOOL $tool 0 - -"
    fi
  done
  emit "CHECK-DONE"
}

list_dir() {
  if [ "$ARG" = "-" ]; then
    emit "ERR bad-path"
    exit 44
  fi
  target="$(expand_home "$(unb64 "$ARG")")"
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
