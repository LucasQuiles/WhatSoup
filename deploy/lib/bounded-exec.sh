#!/usr/bin/env bash

# Bounded command execution for credential-store probes.
#
# Stock macOS ships no timeout(1). Use the same shell supervisor everywhere so
# command statuses and descendant cleanup do not depend on installed utilities.
#
# Exit status: 124 when the budget was exhausted (matching GNU timeout), the
# command's own status otherwise.

whatsoup_run_bounded() {
  if [ "$#" -lt 2 ]; then
    echo "FATAL: whatsoup_run_bounded requires a budget and a command" >&2
    return 2
  fi
  local budget="$1"
  shift
  case "$budget" in ''|*[!0-9]*) return 2 ;; esac
  while [ "${budget#0}" != "$budget" ]; do budget="${budget#0}"; done
  budget="${budget:-0}"
  [ "$budget" -ge 0 ] 2>/dev/null || return 2
  [ "$budget" -ne 0 ] || return 124

  local grace
  grace=$((budget / 10))
  [ "$grace" -lt 2 ] && grace=2
  [ "$grace" -gt 30 ] && grace=30

  (
    set +e
    set -m
    local worker_pid="" worker_group="" guard_pid="" guard_group=""
    local worker_rc=0 guard_rc=0 rc=0 deadline_rc=0
    local status_reader_pid="" status_timer_pid=""
    local control_token="${RANDOM}${RANDOM}${RANDOM}"
    local control_file="${TMPDIR:-/tmp}/whatsoup-bounded-control.$$.$control_token"
    local authorization_file="${TMPDIR:-/tmp}/whatsoup-bounded-authorize.$$.$control_token"
    local timeout_file="${TMPDIR:-/tmp}/whatsoup-bounded-timeout.$$.$control_token"
    local deadline_file="${TMPDIR:-/tmp}/whatsoup-bounded-deadline.$$.$control_token"
    local cleanup_file="${TMPDIR:-/tmp}/whatsoup-bounded-cleanup.$$.$control_token"
    local control_directory="" control_command_pid="" control_command_group=""
    local control_watchdog_pid="" control_watchdog_group="" control_release=""

    _bounded_read_beacon() {
      local key value token_seen=0 directory_seen=0
      control_directory=""
      [ -r "$control_file" ] || return 1
      while IFS='=' read -r key value; do
        case "$key" in
          token) [ "$token_seen" -eq 0 ] && [ "$value" = "$control_token" ] || return 2; token_seen=1 ;;
          directory) [ "$directory_seen" -eq 0 ] || return 2; control_directory="$value"; directory_seen=1 ;;
          *) return 2 ;;
        esac
      done < "$control_file"
      [ "$token_seen" -eq 1 ] && [ "$directory_seen" -eq 1 ] || return 2
      case "$control_directory" in "${TMPDIR:-/tmp}"/whatsoup-bounded.*) return 0 ;; *) return 2 ;; esac
    }

    _bounded_group_is_owned() {
      local pid="$1" group="$2" observed parent observed_group
      [[ "$pid" =~ ^[0-9]+$ ]] && [[ "$group" =~ ^[0-9]+$ ]] || return 2
      [ "$pid" -gt 1 ] && [ "$group" -gt 1 ] && [ "$pid" = "$group" ] || return 2
      [ "$group" != "$worker_group" ] && [ "$group" != "$guard_group" ] || return 2
      kill -0 "$pid" 2>/dev/null || return 1
      if ! observed="$(/bin/ps -o ppid= -o pgid= -p "$pid" 2>/dev/null)"; then
        kill -0 "$pid" 2>/dev/null || return 1
        return 2
      fi
      read -r parent observed_group <<< "$observed"
      [[ "$parent" =~ ^[0-9]+$ ]] && [ "$parent" = "$worker_pid" ] && [ "$observed_group" = "$group" ] && return 0
      return 2
    }

    _bounded_read_authorization() {
      local key value token_seen=0 directory_seen=0 command_pid_seen=0 command_group_seen=0
      local watchdog_pid_seen=0 watchdog_group_seen=0 release_seen=0
      control_directory="" control_command_pid="" control_command_group=""
      control_watchdog_pid="" control_watchdog_group="" control_release=""
      [ -r "$authorization_file" ] || return 1
      while IFS='=' read -r key value; do
        case "$key" in
          token) [ "$token_seen" -eq 0 ] && [ "$value" = "$control_token" ] || return 2; token_seen=1 ;;
          directory) [ "$directory_seen" -eq 0 ] || return 2; control_directory="$value"; directory_seen=1 ;;
          command_pid) [ "$command_pid_seen" -eq 0 ] || return 2; control_command_pid="$value"; command_pid_seen=1 ;;
          command_group) [ "$command_group_seen" -eq 0 ] || return 2; control_command_group="$value"; command_group_seen=1 ;;
          watchdog_pid) [ "$watchdog_pid_seen" -eq 0 ] || return 2; control_watchdog_pid="$value"; watchdog_pid_seen=1 ;;
          watchdog_group) [ "$watchdog_group_seen" -eq 0 ] || return 2; control_watchdog_group="$value"; watchdog_group_seen=1 ;;
          release) [ "$release_seen" -eq 0 ] || return 2; control_release="$value"; release_seen=1 ;;
          *) return 2 ;;
        esac
      done < "$authorization_file"
      [ "$token_seen" -eq 1 ] && [ "$directory_seen" -eq 1 ] && [ "$command_pid_seen" -eq 1 ] || return 2
      [ "$command_group_seen" -eq 1 ] && [ "$watchdog_pid_seen" -eq 1 ] && [ "$watchdog_group_seen" -eq 1 ] && [ "$release_seen" -eq 1 ] || return 2
      [ "$control_release" = 1 ] || return 2
      case "$control_directory" in "${TMPDIR:-/tmp}"/whatsoup-bounded.*) ;; *) return 2 ;; esac
      [ "$control_command_group" != "$control_watchdog_group" ] || return 2
      _bounded_group_is_owned "$control_command_pid" "$control_command_group"
      case "$?" in 0) ;; 1) return 1 ;; *) return 2 ;; esac
      _bounded_group_is_owned "$control_watchdog_pid" "$control_watchdog_group"
      case "$?" in 0) ;; 1) control_watchdog_group="" ;; *) return 2 ;; esac
    }

    _bounded_read_deadline() {
      local deadline_token="" deadline_seen=0 deadline_valid=1 authorization_state
      if [ -L "$deadline_file" ] || [ ! -f "$deadline_file" ] || [ ! -r "$deadline_file" ]; then
        return 2
      fi
      while IFS= read -r deadline_token; do
        [ "$deadline_seen" -eq 0 ] && [ "$deadline_token" = "$control_token" ] || deadline_valid=0
        deadline_seen=$((deadline_seen + 1))
      done < "$deadline_file"
      [ "$deadline_valid" -eq 1 ] && [ "$deadline_seen" -eq 1 ] || return 2
      if [ -L "$authorization_file" ] || [ ! -f "$authorization_file" ] || [ ! -r "$authorization_file" ]; then
        return 2
      fi
      _bounded_read_authorization
      authorization_state=$?
      case "$authorization_state" in 0|1) return 124 ;; *) return 2 ;; esac
    }

    _bounded_read_deadline_bounded() {
      local reader_rc=0
      (
        set +m
        _bounded_read_deadline
      ) &
      status_reader_pid=$!
      (
        set +m
        local timer_sleep_pid="" timer_rc=0
        _bounded_status_timer_cleanup() {
          [ -z "$timer_sleep_pid" ] || kill -9 "$timer_sleep_pid" 2>/dev/null
          [ -z "$timer_sleep_pid" ] || wait "$timer_sleep_pid" 2>/dev/null
        }
        trap '_bounded_status_timer_cleanup' EXIT
        trap 'exit 2' INT TERM HUP
        sleep "$grace" &
        timer_sleep_pid=$!
        wait "$timer_sleep_pid" 2>/dev/null || timer_rc=$?
        [ "$timer_rc" -ne 0 ] || kill -9 -- "-$status_reader_pid" 2>/dev/null
        exit "$timer_rc"
      ) &
      status_timer_pid=$!
      wait "$status_reader_pid" 2>/dev/null || reader_rc=$?
      kill -9 -- "-$status_timer_pid" 2>/dev/null
      wait "$status_timer_pid" 2>/dev/null
      status_reader_pid="" status_timer_pid=""
      case "$reader_rc" in 124) return 124 ;; *) return 2 ;; esac
    }

    _bounded_reserve_timeout_marker() {
      local saved_umask marker_rc
      saved_umask="$(umask)"
      umask 077
      set -C
      : > "$timeout_file"
      marker_rc=$?
      set +C
      umask "$saved_umask"
      return "$marker_rc"
    }

    _bounded_reserve_cleanup_marker() {
      local saved_umask marker_rc
      saved_umask="$(umask)"
      umask 077
      set -C
      builtin printf 'token=%s\ncleanup=running\n' "$control_token" > "$cleanup_file"
      marker_rc=$?
      set +C
      umask "$saved_umask"
      return "$marker_rc"
    }

    _bounded_outer_cleanup() {
      local group
      [ -n "$status_timer_pid" ] && kill -9 -- "-$status_timer_pid" 2>/dev/null
      [ -n "$status_reader_pid" ] && kill -9 -- "-$status_reader_pid" 2>/dev/null
      [ -n "$status_timer_pid" ] && wait "$status_timer_pid" 2>/dev/null
      [ -n "$status_reader_pid" ] && wait "$status_reader_pid" 2>/dev/null
      for group in "$guard_group" "$worker_group"; do
        [ -n "$group" ] && kill -9 -- "-$group" 2>/dev/null
      done
      [ -n "$worker_pid" ] && wait "$worker_pid" 2>/dev/null
      [ -n "$guard_pid" ] && wait "$guard_pid" 2>/dev/null
      if _bounded_read_beacon; then
        rm -f "$control_directory/command" "$control_directory/result" "$control_directory/watchdog"
        rmdir "$control_directory" 2>/dev/null
      fi
      rm -f "$authorization_file" "$control_file" "$timeout_file" "$cleanup_file" "$deadline_file"
    }

    trap '_bounded_outer_cleanup' EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM HUP

    (
      set +e
      set +m
      kill -STOP 0

      local directory="" cmd_pid="" cmd_group="" command_release_pid=""
      local watchdog_pid="" watchdog_group="" watchdog_release_pid=""
      local candidate observed caller_group remaining remaining_grace completed_rc cleanup_rc=0
      local entry_timeout=0 entry_timeout_handled=0

      _bounded_worker_cleanup() {
        local group count
        _bounded_reserve_cleanup_marker || cleanup_rc=2
        if [ -n "$cmd_pid" ] && [ -z "$cmd_group" ]; then kill -9 "$cmd_pid" 2>/dev/null; fi
        if [ -n "$watchdog_pid" ] && [ -z "$watchdog_group" ]; then kill -9 "$watchdog_pid" 2>/dev/null; fi
        [ -n "$command_release_pid" ] && kill -9 "$command_release_pid" 2>/dev/null
        [ -n "$watchdog_release_pid" ] && kill -9 "$watchdog_release_pid" 2>/dev/null
        for group in "$cmd_group" "$watchdog_group"; do
          [ -n "$group" ] && kill -9 -- "-$group" 2>/dev/null
        done
        [ -n "$cmd_pid" ] && wait "$cmd_pid" 2>/dev/null
        [ -n "$command_release_pid" ] && wait "$command_release_pid" 2>/dev/null
        [ -n "$watchdog_pid" ] && wait "$watchdog_pid" 2>/dev/null
        [ -n "$watchdog_release_pid" ] && wait "$watchdog_release_pid" 2>/dev/null
        for group in "$cmd_group" "$watchdog_group"; do
          [ -n "$group" ] || continue
          count=0
          while kill -0 -- "-$group" 2>/dev/null; do
            count=$((count + 1))
            [ "$count" -lt 200 ] || { cleanup_rc=2; break; }
            sleep 0.01
          done
        done
        [ -z "$directory" ] || { rm -f "$directory/command" "$directory/result" "$directory/watchdog"; rmdir "$directory" 2>/dev/null; }
        rm -f "$timeout_file"
        [ "$cleanup_rc" -ne 0 ] || rm -f "$cleanup_file"
      }

      trap '_bounded_worker_cleanup' EXIT
      trap 'exit 130' INT
      trap 'exit 143' TERM HUP
      trap 'entry_timeout=1
        [ -z "$cmd_group" ] || kill -TERM -- "-$cmd_group" 2>/dev/null' USR1

      caller_group="$(ps -o pgid= -p "$$")" || return 2
      caller_group="${caller_group//[[:space:]]/}"
      [[ "$caller_group" =~ ^[0-9]+$ ]] || return 2
      directory="$(mktemp -d "${TMPDIR:-/tmp}/whatsoup-bounded.XXXXXX")" || return 2
      ( umask 077; set -C; builtin printf 'token=%s\ndirectory=%s\n' "$control_token" "$directory" > "$control_file" ) || return 2
      mkfifo "$directory/command" "$directory/result" "$directory/watchdog" || return 2

      set -m
      (
        set +m
        IFS= read -r start < "$directory/command" || exit 2
        [ "$start" = run ] || exit 2
        trap ':' TERM
        "$@"
        rc=$?
        builtin printf '%s\n' "$rc" > "$directory/result"
        exit "$rc"
      ) <&0 &
      cmd_pid=$!
      candidate="$(jobs -p %+)"
      observed="$(ps -o pgid= -p "$cmd_pid")" || return 2
      observed="${observed//[[:space:]]/}"
      if [[ ! "$candidate" =~ ^[0-9]+$ ]] || [ "$candidate" -le 1 ] || [ "$candidate" != "$observed" ] || [ "$candidate" = "$caller_group" ]; then return 2; fi
      cmd_group="$candidate"

      (
        set +m
        IFS= read -r start < "$directory/watchdog" || exit 2
        [ "$start" = run ] || exit 2
        sleep "$budget" || exit 2
        ( umask 077; set -C; builtin printf '%s\n' "$control_token" > "$deadline_file" ) || exit 2
        kill -TERM -- "-$cmd_group" 2>/dev/null
        sleep "$grace" || exit 2
        kill -9 -- "-$cmd_group" 2>/dev/null
      ) </dev/null >/dev/null 2>&1 &
      watchdog_pid=$!
      candidate="$(jobs -p %+)"
      observed="$(ps -o pgid= -p "$watchdog_pid")" || return 2
      observed="${observed//[[:space:]]/}"
      if [[ ! "$candidate" =~ ^[0-9]+$ ]] || [ "$candidate" -le 1 ] || [ "$candidate" != "$observed" ] || [ "$candidate" = "$caller_group" ] || [ "$candidate" = "$cmd_group" ]; then return 2; fi
      watchdog_group="$candidate"

      _bounded_reserve_timeout_marker || return 2
      ( umask 077; set -C; builtin printf 'token=%s\ndirectory=%s\ncommand_pid=%s\ncommand_group=%s\nwatchdog_pid=%s\nwatchdog_group=%s\nrelease=1\n' "$control_token" "$directory" "$cmd_pid" "$cmd_group" "$watchdog_pid" "$watchdog_group" > "$authorization_file" ) || return 2
      builtin printf 'run\n' > "$directory/watchdog" &
      watchdog_release_pid=$!
      builtin printf 'run\n' > "$directory/command" &
      command_release_pid=$!
      remaining="$budget" remaining_grace="$grace" rc=124
      while [ "$remaining" -gt 0 ] || [ "$remaining_grace" -gt 0 ]; do
        if [ "$entry_timeout" -ne 0 ] && [ "$entry_timeout_handled" -eq 0 ]; then
          remaining=0
          remaining_grace="$grace"
          entry_timeout_handled=1
        fi
        completed_rc=""
        if IFS= read -r -t 1 completed_rc <> "$directory/result"; then
          if [[ "$completed_rc" =~ ^[0-9]+$ ]] && [ "$completed_rc" -le 255 ]; then rc="$completed_rc"; else rc=2; fi
          break
        fi
        if ! kill -0 "$cmd_pid" 2>/dev/null; then
          kill -9 -- "-$cmd_group" 2>/dev/null
          rc=0
          wait "$cmd_pid" 2>/dev/null || rc=$?
          break
        fi
        if [ "$remaining" -gt 0 ]; then remaining=$((remaining - 1)); else remaining_grace=$((remaining_grace - 1)); fi
      done
      [ -z "$watchdog_group" ] || kill -9 -- "-$watchdog_group" 2>/dev/null
      [ -z "$watchdog_pid" ] || wait "$watchdog_pid" 2>/dev/null
      _bounded_worker_cleanup
      trap - EXIT
      if [ "$cleanup_rc" -ne 0 ]; then
        rc=2
      fi
      return "$rc"
    ) <&0 &
    worker_pid=$!
    worker_group="$(jobs -p %+)"
    if [[ ! "$worker_group" =~ ^[0-9]+$ ]] || [ "$worker_group" -le 1 ]; then return 2; fi

    (
      set +m
      local timer_pid="" monitor_pid="" guard_status=0
      _bounded_wait_for_budget() {
        local remaining="$budget" chunk
        while [ "$remaining" -gt 0 ]; do
          if [ "$remaining" -gt 60 ]; then chunk=60; else chunk="$remaining"; fi
          sleep "$chunk" || return 2
          remaining=$((remaining - chunk))
        done
      }
      _bounded_guard_cleanup() {
        [ -z "$timer_pid" ] || kill -9 "$timer_pid" 2>/dev/null
        [ -z "$monitor_pid" ] || kill -9 "$monitor_pid" 2>/dev/null
        [ -z "$timer_pid" ] || wait "$timer_pid" 2>/dev/null
        [ -z "$monitor_pid" ] || wait "$monitor_pid" 2>/dev/null
      }
      _bounded_guard_exit() {
        _bounded_guard_cleanup
        trap - EXIT
        exit "$guard_status"
      }
      _bounded_guard_protocol_failure() {
        guard_status=2
        kill -TERM -- "-$worker_group" 2>/dev/null
        kill -USR1 "$worker_pid" 2>/dev/null
        if ! sleep "$grace"; then kill -9 -- "-$worker_group" 2>/dev/null; _bounded_guard_exit; fi
        kill -9 -- "-$worker_group" 2>/dev/null
        _bounded_guard_exit
      }
      trap '_bounded_guard_exit' INT TERM HUP
      trap '_bounded_guard_protocol_failure' USR2
      _bounded_wait_for_budget &
      timer_pid=$!
      (
        local observed state observed_group
        while :; do
          if ! observed="$(/bin/ps -o stat= -o pgid= -p "$worker_pid" 2>/dev/null)"; then
            kill -0 "$worker_pid" 2>/dev/null || exit 0
            kill -USR2 0 2>/dev/null
            exit 2
          fi
          read -r state observed_group <<< "$observed"
          if [[ ! "$observed_group" =~ ^[0-9]+$ ]] || [ "$observed_group" != "$worker_group" ]; then
            kill -USR2 0 2>/dev/null
            exit 2
          fi
          case "$state" in
            *T*)
              kill -CONT "$worker_pid" 2>/dev/null || kill -USR2 0 2>/dev/null
              exit
              ;;
          esac
          sleep 0.01 || { kill -USR2 0 2>/dev/null; exit 2; }
        done
      ) &
      monitor_pid=$!
      wait "$timer_pid" 2>/dev/null
      if [ "$?" -ne 0 ]; then
        _bounded_guard_protocol_failure
      fi
      local protocol_failure=0 authorization_state=1 command_authorized=0 watchdog_authorized=0
      guard_status=124
      _bounded_read_authorization
      authorization_state=$?
      if [ "$authorization_state" -eq 0 ]; then
        command_authorized=1
        [ -z "$control_watchdog_group" ] || watchdog_authorized=1
        kill -TERM -- "-$control_command_group" 2>/dev/null
      elif [ "$authorization_state" -eq 2 ]; then
        protocol_failure=1
        guard_status=2
        kill -TERM -- "-$worker_group" 2>/dev/null
      else
        kill -TERM -- "-$worker_group" 2>/dev/null
      fi
      kill -USR1 "$worker_pid" 2>/dev/null
      if ! sleep "$grace"; then
        if [ "$command_authorized" -eq 1 ] && kill -0 "$control_command_pid" 2>/dev/null; then kill -9 -- "-$control_command_group" 2>/dev/null; fi
        if [ "$watchdog_authorized" -eq 1 ] && kill -0 "$control_watchdog_pid" 2>/dev/null; then kill -9 -- "-$control_watchdog_group" 2>/dev/null; fi
        kill -9 -- "-$worker_group" 2>/dev/null
        guard_status=2
        _bounded_guard_exit
      fi
      if [ "$command_authorized" -eq 1 ] && kill -0 "$control_command_pid" 2>/dev/null; then kill -9 -- "-$control_command_group" 2>/dev/null; fi
      if [ "$watchdog_authorized" -eq 1 ] && kill -0 "$control_watchdog_pid" 2>/dev/null; then kill -9 -- "-$control_watchdog_group" 2>/dev/null; fi
      if [ "$authorization_state" -eq 0 ]; then
        sleep "$grace" &
        timer_pid=$!
        wait "$timer_pid" 2>/dev/null
        [ "$?" -eq 0 ] || { kill -9 "$worker_pid" 2>/dev/null; kill -9 -- "-$worker_group" 2>/dev/null; guard_status=2; _bounded_guard_exit; }
        kill -9 "$worker_pid" 2>/dev/null
        kill -9 -- "-$worker_group" 2>/dev/null
        guard_status=2
        _bounded_guard_exit
      else
        if kill -0 "$worker_pid" 2>/dev/null; then guard_status=2; fi
        kill -9 -- "-$worker_group" 2>/dev/null
      fi
      [ "$protocol_failure" -eq 0 ] || guard_status=2
      _bounded_guard_exit
    ) </dev/null >/dev/null 2>&1 &
    guard_pid=$!
    guard_group="$(jobs -p %+)"
    if [[ ! "$guard_group" =~ ^[0-9]+$ ]] || [ "$guard_group" -le 1 ] || [ "$guard_group" = "$worker_group" ]; then return 2; fi

    wait "$worker_pid" 2>/dev/null || worker_rc=$?
    if [ -e "$deadline_file" ] || [ -L "$deadline_file" ]; then
      _bounded_read_deadline_bounded
      deadline_rc=$?
    fi
    if kill -0 "$guard_pid" 2>/dev/null; then
      kill -CONT "$guard_pid" 2>/dev/null
      kill -TERM "$guard_pid" 2>/dev/null
    fi
    wait "$guard_pid" 2>/dev/null || guard_rc=$?
    if [ "$deadline_rc" -eq 2 ] || [ -e "$cleanup_file" ] || [ -L "$cleanup_file" ]; then
      rc=2
    else
      case "$guard_rc" in 124|2) rc="$guard_rc" ;; *) if [ "$deadline_rc" -eq 124 ]; then rc=124; else rc="$worker_rc"; fi ;; esac
    fi
    _bounded_outer_cleanup
    trap - EXIT
    return "$rc"
  )
}
