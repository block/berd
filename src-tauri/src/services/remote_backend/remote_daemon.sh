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
#   v4 <pid> <port> <secret> <b64version> <started> <b64binary> <b64launchspec> <b64identity>
# The launch spec covers the binary, serve args, and bootstrap protocol. The
# identity is an OS process-start token captured after readiness. Older records
# still parse for safe migration, but are never reused.
#
# Typed exit codes: 41 goose-not-found, 43 port-bind-failed, 44 bad-path,
# 45 no-such-dir, 47 daemon-conflict, 48 daemon-changed.
set -u

NONCE="${1:?nonce required}"
MODE="${2:?mode required}"
ARG="${3:--}"
GOOSE_ARG="${4:--}"

STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/berd/remote"
RECORD="$STATE_DIR/daemon.record"
LOG="$STATE_DIR/goose-serve.log"
LOCK_ROOT="$STATE_DIR/daemon.locks"
LEGACY_LOCK_DIR="$STATE_DIR/daemon.lock"
LEGACY_LOCK_OWNER="$LEGACY_LOCK_DIR/owner"
RECORD_FORMAT="v4"
LOG_MAX_BYTES=$((4 * 1024 * 1024))
LOG_RETAIN_BYTES=$((2 * 1024 * 1024))
LOG_SEGMENT_BYTES=$((LOG_RETAIN_BYTES - 64 * 1024))

emit() { printf '%s %s\n' "$NONCE" "$*"; }

b64() { printf %s "$1" | base64 | tr -d '\n'; }
# `-d` is supported by both GNU coreutils and macOS/BSD base64; GNU's
# `--decode` long option is not available on macOS remotes.
unb64() { printf %s "$1" | base64 -d; }

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

# Returns an OS-provided process identity that remains stable for the lifetime
# of a PID. Linux exposes an exact boot-relative start tick; BSD/macOS ps
# exposes the process start timestamp and command. The value is persisted and
# must match before Berd ever signals the recorded PID.
process_identity() {
  identity_pid="$1"
  if [ -r "/proc/$identity_pid/stat" ]; then
    # After removing pid + parenthesized comm, process start time is field 20
    # of the remainder (field 22 in proc_pid_stat(5)).
    identity_start="$(sed 's/^.*) //' "/proc/$identity_pid/stat" 2>/dev/null | awk '{print $20}')"
    [ -n "$identity_start" ] || return 1
    printf 'proc:%s' "$identity_start"
    return 0
  fi

  identity_ps="$(ps -p "$identity_pid" -o lstart= -o command= 2>/dev/null)" || return 1
  [ -n "$identity_ps" ] || return 1
  printf 'ps:%s' "$identity_ps"
}

lock_owner_is_current() {
  owner_path="$1"
  IFS=' ' read -r lock_pid lock_b64identity lock_extra <"$owner_path" 2>/dev/null || return 1
  case "$lock_pid" in
  '' | *[!0-9]*) return 1 ;;
  esac
  [ -n "$lock_b64identity" ] || return 1
  [ -z "${lock_extra:-}" ] || return 1
  kill -0 "$lock_pid" 2>/dev/null || return 1
  lock_identity="$(process_identity "$lock_pid")" || return 1
  [ "$(b64 "$lock_identity")" = "$lock_b64identity" ]
}

release_daemon_lock() {
  if [ "${compat_lock_held:-0}" = "1" ] &&
    IFS= read -r current_compat_owner <"$LEGACY_LOCK_OWNER" 2>/dev/null &&
    [ "$current_compat_owner" = "$our_lock_owner" ]; then
    rm -f "$LEGACY_LOCK_OWNER"
    rmdir "$LEGACY_LOCK_DIR" 2>/dev/null || true
  fi
  compat_lock_held=0
  if IFS= read -r current_lock_owner <"$our_ticket/owner" 2>/dev/null &&
    [ "$current_lock_owner" = "$our_lock_owner" ]; then
    rm -rf -- "$our_ticket"
  fi
  [ -z "${pending_ticket:-}" ] || rm -rf -- "$pending_ticket"
  lock_held=0
}

terminate_uncommitted_daemon() {
  case "${uncommitted_pid:-}" in
  '' | *[!0-9]*) ;;
  *)
    cleanup_pid="$uncommitted_pid"
    if kill -0 "$cleanup_pid" 2>/dev/null; then
      kill -TERM "$cleanup_pid" 2>/dev/null || true
      cleanup_i=0
      while [ "$cleanup_i" -lt 10 ] && kill -0 "$cleanup_pid" 2>/dev/null; do
        sleep 0.1
        cleanup_i=$((cleanup_i + 1))
      done
      if kill -0 "$cleanup_pid" 2>/dev/null; then
        kill -KILL "$cleanup_pid" 2>/dev/null || true
      fi
    fi
    wait "$cleanup_pid" 2>/dev/null || true
    ;;
  esac
  uncommitted_pid=""
  if [ -n "${uncommitted_logger_pid:-}" ]; then
    kill -TERM "$uncommitted_logger_pid" 2>/dev/null || true
    wait "$uncommitted_logger_pid" 2>/dev/null || true
    uncommitted_logger_pid=""
  fi
  if [ -n "${uncommitted_log_pipe:-}" ]; then
    rm -f "$uncommitted_log_pipe"
    uncommitted_log_pipe=""
  fi
}

cleanup_daemon_mutation() {
  terminate_uncommitted_daemon
  release_daemon_lock
}

# Ticket clients also hold daemon.lock for the full mutation. Older Berd
# clients know only this path, so retaining it as a compatibility gate makes
# mixed-version rollouts mutually exclusive in both acquisition orders. The
# ticket remains the generation-safe ordering protocol for current clients.
acquire_legacy_compat_lock() {
  compat_attempt=0
  stale_observations=0
  while [ "$compat_attempt" -lt 1200 ]; do
    compat_attempt=$((compat_attempt + 1))
    if mkdir "$LEGACY_LOCK_DIR" 2>/dev/null; then
      compat_owner_tmp="$LEGACY_LOCK_DIR/.owner.$$"
      if ! printf '%s\n' "$our_lock_owner" >"$compat_owner_tmp" ||
        ! mv -f "$compat_owner_tmp" "$LEGACY_LOCK_OWNER"; then
        rm -f "$compat_owner_tmp"
        rmdir "$LEGACY_LOCK_DIR" 2>/dev/null || true
        stale_observations=0
        sleep 0.01
        continue
      fi
      # Let an observer that saw the directory before owner publication finish
      # its claim, then prove this exact generation still occupies the path.
      sleep 0.01
      if ! IFS= read -r current_compat_owner <"$LEGACY_LOCK_OWNER" 2>/dev/null ||
        [ "$current_compat_owner" != "$our_lock_owner" ]; then
        stale_observations=0
        sleep 0.01
        continue
      fi
      compat_lock_held=1
      return 0
    fi

    if lock_owner_is_current "$LEGACY_LOCK_OWNER"; then
      stale_observations=0
    else
      stale_observations=$((stale_observations + 1))
      # A mkdir winner publishes its owner immediately. Repeated observations
      # distinguish that window from a process that died before publication.
      if [ "$stale_observations" -ge 20 ]; then
        # Pin the directory generation before acting on it. Older clients
        # release with rmdir, so this guard prevents the observed directory
        # from disappearing and a live successor reusing the shared pathname.
        # If replacement won before the guard, the owner recheck detects it.
        legacy_guard="$LEGACY_LOCK_DIR/.berd-reclaim.$NONCE.$$.$compat_attempt"
        if mkdir "$legacy_guard" 2>/dev/null; then
          if lock_owner_is_current "$LEGACY_LOCK_OWNER"; then
            rmdir "$legacy_guard" 2>/dev/null || true
          else
            legacy_claim="$STATE_DIR/.daemon.lock.legacy.$NONCE.$$.$compat_attempt"
            if mv "$LEGACY_LOCK_DIR" "$legacy_claim" 2>/dev/null; then
              rm -rf -- "$legacy_claim"
            else
              rmdir "$legacy_guard" 2>/dev/null || true
            fi
          fi
        fi
        stale_observations=0
      fi
    fi
    sleep 0.1
  done
  emit "ERR state-dir"
  exit 46
}

# Each invocation owns a path that is never reused (`NONCE` is a UUID). Stale
# cleanup therefore removes the exact generation whose owner was inspected,
# never a successor at a shared pathname. A Lamport bakery ticket orders
# simultaneous contenders without introducing another reclaimable mutex: a
# process first publishes `choosing`, then a number, and may enter only after
# every live lower `(number, ticket-id)` pair has departed.
acquire_daemon_lock() {
  umask 077
  mkdir -p "$STATE_DIR" "$LOCK_ROOT" || {
    emit "ERR state-dir"
    exit 46
  }

  lock_held=0
  compat_lock_held=0
  our_ticket=""
  pending_ticket=""
  uncommitted_pid=""
  uncommitted_logger_pid=""
  uncommitted_log_pipe=""
  trap cleanup_daemon_mutation EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
  case "$NONCE" in
  '' | *[!A-Za-z0-9._-]*)
    emit "ERR state-dir"
    exit 46
    ;;
  esac
  our_identity="$(process_identity "$$")" || {
    emit "ERR state-dir"
    exit 46
  }
  our_lock_owner="$$ $(b64 "$our_identity")"

  our_ticket_id="$NONCE.$$"
  pending_ticket="$LOCK_ROOT/.pending.$our_ticket_id"
  our_ticket="$LOCK_ROOT/ticket.$our_ticket_id"
  rm -rf -- "$pending_ticket"
  if ! mkdir "$pending_ticket" 2>/dev/null ||
    ! printf '%s\n' "$our_lock_owner" >"$pending_ticket/owner" ||
    ! : >"$pending_ticket/choosing" ||
    ! mv "$pending_ticket" "$our_ticket" 2>/dev/null; then
    rm -rf -- "$pending_ticket"
    emit "ERR state-dir"
    exit 46
  fi

  max_ticket_number=0
  for observed_ticket in "$LOCK_ROOT"/ticket.*; do
    [ -d "$observed_ticket" ] || continue
    if ! lock_owner_is_current "$observed_ticket/owner"; then
      rm -rf -- "$observed_ticket"
      continue
    fi
    if IFS= read -r observed_number <"$observed_ticket/number" 2>/dev/null; then
      case "$observed_number" in
      '' | *[!0-9]*) ;;
      *)
        if [ "$observed_number" -gt "$max_ticket_number" ]; then
          max_ticket_number="$observed_number"
        fi
        ;;
      esac
    fi
  done
  our_ticket_number=$((max_ticket_number + 1))
  if ! printf '%s\n' "$our_ticket_number" >"$our_ticket/.number.$$" ||
    ! mv "$our_ticket/.number.$$" "$our_ticket/number" 2>/dev/null ||
    ! rm -f "$our_ticket/choosing"; then
    rm -rf -- "$our_ticket"
    emit "ERR state-dir"
    exit 46
  fi

  lock_attempt=0
  # A lock holder can spend about 80 seconds across five readiness attempts
  # and bounded cleanup. Wait longer than that critical section so a healthy
  # concurrent ensure cannot be mistaken for a wedged state-dir operation.
  while [ "$lock_attempt" -lt 1200 ]; do
    lock_attempt=$((lock_attempt + 1))
    ticket_blocked=0
    for observed_ticket in "$LOCK_ROOT"/ticket.*; do
      [ -d "$observed_ticket" ] || continue
      [ "$observed_ticket" != "$our_ticket" ] || continue
      if ! lock_owner_is_current "$observed_ticket/owner"; then
        rm -rf -- "$observed_ticket"
        continue
      fi
      if [ -e "$observed_ticket/choosing" ]; then
        ticket_blocked=1
        continue
      fi
      if ! IFS= read -r observed_number <"$observed_ticket/number" 2>/dev/null; then
        ticket_blocked=1
        continue
      fi
      case "$observed_number" in
      '' | *[!0-9]*)
        ticket_blocked=1
        continue
        ;;
      esac
      observed_id="${observed_ticket##*/ticket.}"
      if [ "$observed_number" -lt "$our_ticket_number" ] ||
        { [ "$observed_number" -eq "$our_ticket_number" ] && [[ "$observed_id" < "$our_ticket_id" ]]; }; then
        ticket_blocked=1
      fi
    done
    if [ "$ticket_blocked" = "0" ]; then
      acquire_legacy_compat_lock
      lock_held=1
      return 0
    fi
    sleep 0.1
  done

  rm -rf -- "$our_ticket"
  emit "ERR state-dir"
  exit 46
}

# Fills rec_* from $RECORD. v3 records retain a process identity so Berd can
# stop them during migration, but only v4 records carry a reusable launch spec.
# Older records cannot authorize reuse or termination.
read_record() {
  # shellcheck disable=SC2034
  IFS=' ' read -r f1 f2 f3 f4 f5 f6 f7 f8 f9 <"$RECORD" 2>/dev/null || return 1
  if [ "${f1:-}" = "$RECORD_FORMAT" ]; then
    rec_pid="${f2:-}"
    rec_port="${f3:-}"
    rec_secret="${f4:-}"
    rec_b64version="${f5:--}"
    rec_started="${f6:-0}"
    rec_b64binary="${f7:-}"
    rec_b64launchspec="${f8:-}"
    rec_b64identity="${f9:-}"
  elif [ "${f1:-}" = "v3" ]; then
    rec_pid="${f2:-}"
    rec_port="${f3:-}"
    rec_secret="${f4:-}"
    rec_b64version="${f5:--}"
    rec_started="${f6:-0}"
    rec_b64binary="${f7:-}"
    rec_b64launchspec=""
    rec_b64identity="${f8:-}"
  elif [ "${f1:-}" = "v2" ]; then
    rec_pid="${f2:-}"
    rec_port="${f3:-}"
    rec_secret="${f4:-}"
    rec_b64version="${f5:--}"
    rec_started="${f6:-0}"
    rec_b64binary="${f7:-}"
    rec_b64launchspec=""
    rec_b64identity=""
  else
    # Pre-override record: no recorded binary or process identity.
    rec_pid="${f1:-}"
    rec_port="${f2:-}"
    rec_secret="${f3:-}"
    rec_b64version="${f4:--}"
    rec_started="${f5:-0}"
    rec_b64binary=""
    rec_b64launchspec=""
    rec_b64identity=""
  fi
  case "$rec_pid" in
  '' | *[!0-9]*) return 1 ;;
  esac
  case "$rec_port" in
  '' | *[!0-9]*) return 1 ;;
  esac
  [ -n "$rec_secret" ]
}

trim_log_if_needed() {
  log_path="$1"
  [ -f "$log_path" ] || return 0
  log_bytes="$(wc -c <"$log_path" 2>/dev/null | tr -d ' ')"
  case "$log_bytes" in
  '' | *[!0-9]*) return 0 ;;
  esac
  [ "$log_bytes" -le "$LOG_MAX_BYTES" ] && return 0
  log_tmp="$STATE_DIR/.goose-serve.log.$$"
  if tail -c "$LOG_RETAIN_BYTES" "$log_path" >"$log_tmp" 2>/dev/null; then
    mv -f "$log_tmp" "$log_path"
  else
    rm -f "$log_tmp"
  fi
}

# `tee` writes every partial pipe read to its named output (the visible log)
# before stdout. `head` closes that stdout counter after a roughly 2 MiB
# segment, ending this tee only after the same bytes are visible. The 64 KiB reserve
# covers the final in-flight pipe read, so a segment starting from the retained
# 2 MiB tail cannot exceed the 4 MiB cap. Rotation happens per segment rather
# than per small FIFO read.
bounded_log_writer() {
  writer_log="$1"
  writer_tmp="$STATE_DIR/.goose-serve.log.rotate.$$"
  writer_head_pid=""
  # Preserve the Goose FIFO before backgrounding each counter pipeline;
  # non-interactive Bash otherwise redirects an asynchronous stdin to null.
  exec 3<&0
  trap 'kill -TERM "$writer_head_pid" 2>/dev/null || true; wait "$writer_head_pid" 2>/dev/null || true; rm -f "$writer_tmp"; exit 143' TERM
  trap 'kill -TERM "$writer_head_pid" 2>/dev/null || true; wait "$writer_head_pid" 2>/dev/null || true; rm -f "$writer_tmp"; exit 129' HUP
  trap 'kill -TERM "$writer_head_pid" 2>/dev/null || true; wait "$writer_head_pid" 2>/dev/null || true; rm -f "$writer_tmp"; exit 130' INT

  while :; do
    writer_bytes="$(wc -c <"$writer_log" 2>/dev/null | tr -d ' ')"
    case "$writer_bytes" in
    '' | *[!0-9]*) writer_bytes=0 ;;
    esac
    if [ "$writer_bytes" -gt "$LOG_RETAIN_BYTES" ]; then
      if ! tail -c "$LOG_RETAIN_BYTES" "$writer_log" >"$writer_tmp" 2>/dev/null; then
        rm -f "$writer_tmp"
        break
      fi
      if ! mv -f "$writer_tmp" "$writer_log"; then
        rm -f "$writer_tmp"
        break
      fi
      writer_bytes="$LOG_RETAIN_BYTES"
    fi

    tee -a "$writer_log" <&3 2>/dev/null | head -c "$LOG_SEGMENT_BYTES" >/dev/null 2>&1 &
    writer_head_pid=$!
    wait "$writer_head_pid" 2>/dev/null || true
    writer_head_pid=""
    writer_after="$(wc -c <"$writer_log" 2>/dev/null | tr -d ' ')"
    case "$writer_after" in
    '' | *[!0-9]*) writer_after="$writer_bytes" ;;
    esac
    [ "$writer_after" -gt "$writer_bytes" ] || break
  done
  trim_log_if_needed "$writer_log"
  rm -f "$writer_tmp"
}

# Confirms the PID is still the exact process that wrote this record. `kill -0`
# alone is insufficient because a stale PID can be reused by another process.
recorded_process_is_current() {
  [ -n "$rec_b64identity" ] || return 1
  kill -0 "$rec_pid" 2>/dev/null || return 1
  current_identity="$(process_identity "$rec_pid")" || return 1
  [ "$(b64 "$current_identity")" = "$rec_b64identity" ]
}

record_instance_token() {
  b64 "$rec_pid $rec_b64identity"
}

# Terminates the pid from the last read_record, TERM then KILL, while rechecking
# ownership so a PID recycled during shutdown is never signaled.
stop_recorded_daemon() {
  if recorded_process_is_current; then
    kill -TERM "$rec_pid" 2>/dev/null || true
    i=0
    while [ "$i" -lt 30 ] && recorded_process_is_current; do
      sleep 0.1
      i=$((i + 1))
    done
    if recorded_process_is_current; then
      kill -KILL "$rec_pid" 2>/dev/null || true
    fi
  fi
}

ensure_daemon() {
  resolve_goose_bin
  b64binary="$(b64 "$goose_bin")"

  extra_args=""
  if [ "$ARG" != "-" ]; then
    extra_args="$(unb64 "$ARG")"
  fi
  version="$("$goose_bin" --version 2>/dev/null | head -n 1)"
  [ -n "$version" ] || version="unknown"
  launch_spec="$(printf 'remote-daemon-v1\n%s\n%s\n%s' "$goose_bin" "$version" "$extra_args")"
  b64launchspec="$(b64 "$launch_spec")"

  if [ -f "$RECORD" ] && read_record; then
    if recorded_process_is_current; then
      if port_listening "$rec_port"; then
        if [ -n "$rec_b64launchspec" ] &&
          [ "$rec_b64launchspec" != "$b64launchspec" ]; then
          emit "CONFLICT $rec_pid $rec_started $rec_b64version $rec_b64binary $(record_instance_token)"
          emit "ERR daemon-conflict"
          exit 47
        fi
        if [ "$rec_b64launchspec" = "$b64launchspec" ]; then
          emit "READY $rec_pid $rec_port $rec_secret 1 $rec_b64version $rec_started"
          return 0
        fi
      fi
      # A known daemon is unhealthy, or predates launch-spec identity. Stop it
      # so a v4 record can be committed. Unverifiable old records are only
      # discarded; their PIDs are never signaled.
      stop_recorded_daemon
    fi
    rm -f "$RECORD"
  fi

  secret="berd-remote-$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')"

  attempt=0
  while [ "$attempt" -lt 5 ]; do
    attempt=$((attempt + 1))
    port=$(((RANDOM % 40000) + 20000))
    if port_listening "$port"; then
      continue
    fi
    trim_log_if_needed "$LOG"
    log_pipe="$STATE_DIR/.goose-serve.log.pipe.$$"
    rm -f "$log_pipe"
    if ! mkfifo "$log_pipe"; then
      emit "ERR state-dir"
      exit 46
    fi
    uncommitted_log_pipe="$log_pipe"
    bounded_log_writer "$LOG" <"$log_pipe" >/dev/null 2>&1 &
    logger_pid=$!
    uncommitted_logger_pid="$logger_pid"
    # Detached: nohup writes into a FIFO consumed by the bounded logger. The
    # logger has no protocol-stream descriptors and exits when Goose closes.
    # shellcheck disable=SC2086
    GOOSE_SERVER__SECRET_KEY="$secret" nohup "$goose_bin" serve --host 127.0.0.1 --port "$port" $extra_args >"$log_pipe" 2>&1 </dev/null &
    pid=$!
    uncommitted_pid="$pid"
    i=0
    while [ "$i" -lt 150 ]; do
      if ! kill -0 "$pid" 2>/dev/null; then
        break
      fi
      if port_listening "$port"; then
        started="$(date +%s)"
        identity="$(process_identity "$pid")"
        if [ -z "$identity" ]; then
          terminate_uncommitted_daemon
          break
        fi
        record_tmp="$STATE_DIR/.daemon.record.$$"
        if ! printf '%s %s %s %s %s %s %s %s %s\n' "$RECORD_FORMAT" "$pid" "$port" "$secret" \
          "$(b64 "$version")" "$started" "$b64binary" "$b64launchspec" "$(b64 "$identity")" >"$record_tmp" ||
          ! mv -f "$record_tmp" "$RECORD"; then
          rm -f "$record_tmp"
          terminate_uncommitted_daemon
          emit "ERR state-dir"
          exit 46
        fi
        rm -f "$log_pipe"
        uncommitted_pid=""
        uncommitted_logger_pid=""
        uncommitted_log_pipe=""
        emit "READY $pid $port $secret 0 $(b64 "$version") $started"
        return 0
      fi
      sleep 0.1
      i=$((i + 1))
    done
    terminate_uncommitted_daemon
  done
  emit "ERR port-bind-failed"
  exit 43
}

shutdown_daemon() {
  if [ -f "$RECORD" ] && read_record; then
    if [ "$ARG" != "-" ]; then
      expected_instance_token="$(unb64 "$ARG")" || {
        emit "ERR daemon-changed"
        exit 48
      }
      if [ "$expected_instance_token" != "$(record_instance_token)" ]; then
        emit "ERR daemon-changed"
        exit 48
      fi
    fi
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
ensure)
  acquire_daemon_lock
  ensure_daemon
  ;;
shutdown)
  acquire_daemon_lock
  shutdown_daemon
  ;;
check) check_host ;;
listdir) list_dir ;;
*)
  emit "ERR bad-mode"
  exit 40
  ;;
esac
