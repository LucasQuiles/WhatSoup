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
    local worker_rc=0 worker_reaped=0 guard_reaped=0 guard_rc=0 rc=0 deadline_rc=0
    local status_reader_pid="" status_timer_pid=""
    local status_cleanup_failed=0
    local control_token="${RANDOM}${RANDOM}${RANDOM}"
    local control_file="${TMPDIR:-/tmp}/whatsoup-bounded-control.$$.$control_token"
    local authorization_file="${TMPDIR:-/tmp}/whatsoup-bounded-authorize.$$.$control_token"
    local timeout_file="${TMPDIR:-/tmp}/whatsoup-bounded-timeout.$$.$control_token"
    local deadline_file="${TMPDIR:-/tmp}/whatsoup-bounded-deadline.$$.$control_token"
    local cleanup_file="${TMPDIR:-/tmp}/whatsoup-bounded-cleanup.$$.$control_token"
    local outcome_file="${TMPDIR:-/tmp}/whatsoup-bounded-outcome.$$.$control_token"
    local control_directory="" control_command_pid="" control_command_group=""
    local control_watchdog_pid="" control_watchdog_group="" control_release=""
    local outcome_event=""

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
      IFS=$' \t\n' read -r parent observed_group <<< "$observed"
      [[ "$parent" =~ ^[0-9]+$ ]] && [ "$parent" = "$worker_pid" ] && [ "$observed_group" = "$group" ] && return 0
      return 2
    }

    # End every group the worker created. Each is led by a direct child of the
    # worker, so one listing finds it even when the worker's own record of it
    # is lost. The worker's group is stopped first, so it cannot create a group
    # after the listing. Without a valid record, call this before any signal
    # that can make the worker exit: its children are then reparented and no
    # listing can find them. A listing without the worker's own row fails
    # while the worker lives, as when bash cannot create the file behind <<<.
    # Limits: a group whose leader the worker already reaped is not listed, and
    # a SIGKILL sent from outside to the worker alone still leaves its groups.
    # Its reads set IFS themselves: a caller, or a trap run inside another read,
    # can leave IFS without a space.
    _bounded_kill_worker_children() {
      local listing pid parent group worker_listed=0 killed="" live count=0 observed state observed_group
      [[ "$worker_pid" =~ ^[0-9]+$ ]] && [ "$worker_pid" -gt 1 ] && [ "$worker_pid" = "$worker_group" ] || return 2
      kill -0 "$worker_pid" 2>/dev/null || return 0
      kill -STOP -- "-$worker_group" 2>/dev/null
      listing="$(/bin/ps -axo pid=,ppid=,pgid= 2>/dev/null)" || return 2
      while IFS=$' \t\n' read -r pid parent group; do
        [ "$pid" != "$worker_pid" ] || worker_listed=1
        [[ "$pid" =~ ^[0-9]+$ ]] && [ "$pid" -gt 1 ] && [ "$parent" = "$worker_pid" ] && [ "$group" = "$pid" ] || continue
        kill -9 -- "-$pid" 2>/dev/null
        killed="$killed $pid"
      done <<< "$listing"
      # A member forked while its group was signalled can miss that signal.
      # Each killed leader stays a zombie of the stopped worker, so no group id
      # is reused: list again, and end a group while ps shows a live member.
      while [ -n "$killed" ]; do
        live=0
        listing="$(/bin/ps -axo pid=,ppid=,pgid= 2>/dev/null)" || return 2
        while IFS=$' \t\n' read -r pid parent group; do
          case "$killed " in *" $group "*) ;; *) continue ;; esac
          observed="$(/bin/ps -o stat= -o pgid= -p "$pid" 2>/dev/null)" || { kill -9 -- "-$group" 2>/dev/null; live=1; continue; }
          IFS=$' \t\n' read -r state observed_group <<< "$observed"
          case "$state" in ''|Z*) continue ;; esac
          [ "$observed_group" = "$group" ] || continue
          kill -9 -- "-$group" 2>/dev/null
          live=1
        done <<< "$listing"
        [ "$live" -eq 1 ] || break
        count=$((count + 1))
        [ "$count" -lt 200 ] || return 2
        sleep 0.01
      done
      [ "$worker_listed" -eq 0 ] || return 0
      kill -0 "$worker_pid" 2>/dev/null || return 0
      return 2
    }

    _bounded_end_worker_groups() {
      local children_rc=0
      _bounded_kill_worker_children || children_rc=2
      if [[ "$worker_group" =~ ^[0-9]+$ ]] && [ "$worker_group" -gt 1 ]; then kill -9 -- "-$worker_group" 2>/dev/null; fi
      return "$children_rc"
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
      case "$?" in 0) ;; 1) return 3 ;; *) return 2 ;; esac
      _bounded_group_is_owned "$control_watchdog_pid" "$control_watchdog_group"
      case "$?" in 0) ;; 1) control_watchdog_group="" ;; *) return 2 ;; esac
    }

    _bounded_claim_outcome() {
      local event="$1" status="${2:-}" candidate=""
      case "$event" in
        result) [[ "$status" =~ ^[0-9]+$ ]] && [ "$status" -le 255 ] || return 2 ;;
        deadline-outer) [ -z "$status" ] || return 2 ;;
        *) return 2 ;;
      esac
      candidate="${outcome_file}.${event}"
      # An exclusive FIFO supplies an inode without opening an existing path.
      command -p mkfifo -m 600 "$candidate" 2>/dev/null || return 2
      # link treats the destination as one path, including when it is a directory.
      if command -p link "$candidate" "$outcome_file" 2>/dev/null; then
        [ ! -L "$outcome_file" ] && [ -p "$outcome_file" ] && [ "$candidate" -ef "$outcome_file" ] && return 0
        return 2
      fi
      if [ -e "$outcome_file" ] || [ -L "$outcome_file" ]; then return 1; fi
      return 2
    }

    _bounded_read_outcome() {
      local event candidate
      outcome_event=""
      if [ -L "$outcome_file" ] || [ ! -p "$outcome_file" ]; then
        return 2
      fi
      # Compare the exclusive claim's inode without opening a replaceable path.
      for event in result deadline-outer; do
        candidate="${outcome_file}.${event}"
        if [ ! -L "$candidate" ] && [ -p "$candidate" ] && [ "$candidate" -ef "$outcome_file" ]; then
          case "$event" in
            result) outcome_event=result ;;
            deadline-outer) outcome_event=deadline ;;
          esac
          return 0
        fi
      done
      return 2
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
      case "$authorization_state" in 0|3) return 124 ;; *) return 2 ;; esac
    }

    _bounded_reap_status_helper() {
      local helper_pid="$1" count=0
      [ -n "$helper_pid" ] || return 0
      kill -9 -- "-$helper_pid" 2>/dev/null
      wait "$helper_pid" 2>/dev/null
      # A child fork may finish after the first group signal catches its leader.
      while kill -0 -- "-$helper_pid" 2>/dev/null; do
        if ! kill -9 -- "-$helper_pid" 2>/dev/null; then
          kill -0 -- "-$helper_pid" 2>/dev/null && return 2
          break
        fi
        count=$((count + 1))
        [ "$count" -lt 200 ] || return 2
        sleep 0.01 </dev/null >/dev/null 2>&1 || return 2
      done
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
      if _bounded_reap_status_helper "$status_timer_pid"; then status_timer_pid=""; else status_cleanup_failed=1; fi
      if _bounded_reap_status_helper "$status_reader_pid"; then status_reader_pid=""; else status_cleanup_failed=1; fi
      [ "$status_cleanup_failed" -eq 0 ] || return 2
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
      if _bounded_reap_status_helper "$status_timer_pid"; then status_timer_pid=""; else status_cleanup_failed=1; fi
      if _bounded_reap_status_helper "$status_reader_pid"; then status_reader_pid=""; else status_cleanup_failed=1; fi
      # After the reap only the guard can still check the recorded groups, so
      # let its trap end them before its group is killed. The reaped worker's
      # group goes first, in case a second signal cuts the wait short.
      if [ "$worker_reaped" -eq 1 ] && [ "$guard_reaped" -eq 0 ] && [ -n "$guard_pid" ] && kill -0 "$guard_pid" 2>/dev/null; then
        [ -n "$worker_group" ] && kill -9 -- "-$worker_group" 2>/dev/null
        kill -CONT "$guard_pid" 2>/dev/null
        kill -TERM "$guard_pid" 2>/dev/null
        wait "$guard_pid" 2>/dev/null
      fi
      [ -n "$guard_group" ] && kill -9 -- "-$guard_group" 2>/dev/null
      # Only a signal or a setup failure leaves the outer before it reaps the
      # worker, and the worker's own cleanup may then never run.
      if [ "$worker_reaped" -eq 0 ] && [ -n "$worker_pid" ] && kill -0 "$worker_pid" 2>/dev/null; then
        _bounded_end_worker_groups || status_cleanup_failed=1
      else
        [ -n "$worker_group" ] && kill -9 -- "-$worker_group" 2>/dev/null
      fi
      [ -n "$worker_pid" ] && wait "$worker_pid" 2>/dev/null
      [ -n "$guard_pid" ] && wait "$guard_pid" 2>/dev/null
      if _bounded_read_beacon; then
        rm -f "$control_directory/command" "$control_directory/result" "$control_directory/watchdog" "$control_directory/tick"
        rmdir "$control_directory" 2>/dev/null
      fi
      rm -f "$authorization_file" "$control_file" "$timeout_file" "$cleanup_file" "$deadline_file" "$deadline_file.pending" "$outcome_file"
      rm -f "$outcome_file.result" "$outcome_file.deadline-outer"
    }

    trap '_bounded_outer_cleanup' EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM HUP

    (
      set +e
      set +m
      kill -STOP 0

      local directory="" cmd_pid="" cmd_group="" command_release_pid=""
      local watchdog_pid="" watchdog_group="" watchdog_release_pid="" ticker_pid=""
      local candidate observed caller_group remaining remaining_grace completed_rc completed_frame cleanup_rc=0
      local entry_timeout=0 entry_timeout_handled=0 outcome_claim_rc=0

      _bounded_worker_cleanup() {
        local group count
        set +m
        # Stop the ticker before any fork below can inherit it or fd 8.
        exec 8<&-
        [ -z "$ticker_pid" ] || { kill -9 "$ticker_pid" 2>/dev/null; wait "$ticker_pid" 2>/dev/null; }
        ticker_pid=""
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
            kill -9 -- "-$group" 2>/dev/null
            count=$((count + 1))
            [ "$count" -lt 200 ] || { cleanup_rc=2; break; }
            sleep 0.01
          done
        done
        [ -z "$directory" ] || { rm -f "$directory/command" "$directory/result" "$directory/watchdog" "$directory/tick"; rmdir "$directory" 2>/dev/null; }
        rm -f "$timeout_file"
        [ "$cleanup_rc" -ne 0 ] || rm -f "$cleanup_file"
      }

      _bounded_accept_result() {
        _bounded_claim_outcome result "$rc"
        outcome_claim_rc=$?
        case "$outcome_claim_rc" in
          0) return 0 ;;
          1)
            _bounded_read_outcome || { rc=2; return 0; }
            [ "$outcome_event" = deadline ] || { rc=2; return 0; }
            rc=124
            return 0
            ;;
          *) rc=2; return 0 ;;
        esac
      }

      # The command subshell writes one R<status> line, then exits. Accept only
      # that whole frame.
      _bounded_take_frame() {
        case "$completed_frame" in R[0-9]*) ;; *) return 1 ;; esac
        completed_rc="${completed_frame#R}"
        [[ "$completed_rc" =~ ^[0-9]+$ ]] || return 1
        [ "$completed_rc" -le 255 ] || return 1
        rc="$completed_rc"
        return 0
      }

      # Any other line is not the command's frame, so take the command's status
      # from wait. Never signal its group here: the status must be its own. A
      # USR1 trap interrupts wait, so wait again while it lives.
      _bounded_wait_written_command() {
        local frame_status=0
        wait "$cmd_pid" 2>/dev/null || frame_status=$?
        while [ "$frame_status" -gt 128 ] && kill -0 "$cmd_pid" 2>/dev/null; do
          frame_status=0
          wait "$cmd_pid" 2>/dev/null || frame_status=$?
        done
        rc="$frame_status"
      }

      # Every line written before this marker is read before it, so a frame
      # written before the leader was seen gone is found here.
      _bounded_drain_frame() {
        local marker="M$control_token"
        builtin printf '%s\n' "$marker" >&8 || return 1
        while IFS= read -r -u 8 completed_frame; do
          case "$completed_frame" in
            T) ;;
            "$marker") return 1 ;;
            *) _bounded_take_frame; return ;;
          esac
        done
        return 1
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
      mkfifo "$directory/command" "$directory/result" "$directory/watchdog" "$directory/tick" || return 2

      set -m
      (
        set +m
        IFS= read -r start < "$directory/command" || exit 2
        [ "$start" = run ] || exit 2
        trap ':' TERM
        "$@"
        rc=$?
        builtin printf 'R%s\n' "$rc" > "$directory/result"
        exit "$rc"
      ) <&0 &
      cmd_pid=$!
      set +m
      candidate="$(jobs -p %+)"
      observed="$(ps -o pgid= -p "$cmd_pid")" || return 2
      observed="${observed//[[:space:]]/}"
      if [[ ! "$candidate" =~ ^[0-9]+$ ]] || [ "$candidate" -le 1 ] || [ "$candidate" != "$observed" ] || [ "$candidate" = "$caller_group" ]; then return 2; fi
      cmd_group="$candidate"

      set -m
      (
        set +m
        IFS= read -r start < "$directory/watchdog" || exit 2
        [ "$start" = run ] || exit 2
        sleep "$budget" || exit 2
        # Publish a complete token by exclusive link, so a watchdog killed mid-write
        # never leaves a torn marker. Unlike rename, link never replaces a path.
        ( umask 077; set -C; builtin printf '%s\n' "$control_token" > "$deadline_file.pending" ) || exit 2
        command -p link "$deadline_file.pending" "$deadline_file" 2>/dev/null || exit 2
        rm -f "$deadline_file.pending"
        kill -TERM -- "-$cmd_group" 2>/dev/null
        sleep "$grace" || exit 2
        kill -9 -- "-$cmd_group" 2>/dev/null
      ) </dev/null >/dev/null 2>&1 &
      watchdog_pid=$!
      set +m
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
      # read takes TMOUT as its default timeout, and an expired read drops the
      # bytes it has taken. The command and its helpers are already forked
      # with the caller's value; this subshell's change reaches no caller.
      unset TMOUT 2>/dev/null
      # Hold one reader for the whole loop: a FIFO discards buffered data when
      # its last descriptor closes.
      exec 8<>"$directory/result" || return 2
      # The ticker wakes the untimed reads below with one whole "T" line a
      # second. Its own timed read waits on a FIFO nobody writes, so no read
      # with a timeout ever touches the result FIFO. It outlives a group TERM
      # so the worker, whose trap may wait for its read to return, still wakes.
      # The outer cleanup, and every guard exit that finds the worker alive,
      # ends with a SIGKILL of the worker's group.
      (
        trap '' INT TERM HUP
        exec 9<>"$directory/tick" || exit 2
        while :; do
          IFS= read -r -t 1 -u 9 _
          builtin printf 'T\n' >&8 || exit 2
        done
      ) </dev/null >/dev/null 2>&1 &
      ticker_pid=$!
      while [ "$remaining" -gt 0 ] || [ "$remaining_grace" -gt 0 ]; do
        if [ "$entry_timeout" -ne 0 ] && [ "$entry_timeout_handled" -eq 0 ]; then
          remaining=0
          remaining_grace="$grace"
          entry_timeout_handled=1
        fi
        completed_rc=""
        # Untimed: bash abandons a timed read's consumed bytes when it expires.
        if ! IFS= read -r -u 8 completed_frame; then
          rc=2
          _bounded_accept_result
          break
        fi
        if [ "$completed_frame" != T ]; then
          _bounded_take_frame || _bounded_wait_written_command
          _bounded_accept_result
          break
        fi
        if ! kill -0 "$cmd_pid" 2>/dev/null; then
          # The command can write, exit and be reaped after the last line was
          # read; its frame is then queued on fd 8 ahead of a fresh marker.
          if _bounded_drain_frame; then
            _bounded_accept_result
            break
          fi
          kill -9 -- "-$cmd_group" 2>/dev/null
          rc=0
          wait "$cmd_pid" 2>/dev/null || rc=$?
          _bounded_accept_result
          break
        fi
        if [ "$remaining" -gt 0 ]; then remaining=$((remaining - 1)); else remaining_grace=$((remaining_grace - 1)); fi
      done
      exec 8<&-
      kill -9 "$ticker_pid" 2>/dev/null
      wait "$ticker_pid" 2>/dev/null
      ticker_pid=""
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
      local timer_pid="" monitor_pid="" guard_status=0 command_authorized=0 watchdog_authorized=0
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
        # Derive the report from the durable claim, not the status set after
        # it, so a TERM between a won claim and that status still reports 124.
        if [ "$guard_status" -eq 0 ] && _bounded_read_outcome && [ "$outcome_event" = deadline ]; then guard_status=124; fi
        _bounded_guard_cleanup
        trap - EXIT
        exit "$guard_status"
      }
      _bounded_guard_stop_monitor() {
        # A live monitor would resume a stopped worker.
        [ -z "$monitor_pid" ] || { kill -9 "$monitor_pid" 2>/dev/null; wait "$monitor_pid" 2>/dev/null; }
        monitor_pid=""
      }
      _bounded_guard_end_worker() {
        _bounded_guard_stop_monitor
        _bounded_end_worker_groups || guard_status=2
      }
      # With a valid record, end each recorded group whose leader still lives.
      # It needs no listing, so it still works once the worker is gone.
      _bounded_guard_kill_authorized() {
        if [ "$command_authorized" -eq 1 ] && kill -0 "$control_command_pid" 2>/dev/null; then kill -9 -- "-$control_command_group" 2>/dev/null; fi
        if [ "$watchdog_authorized" -eq 1 ] && kill -0 "$control_watchdog_pid" 2>/dev/null; then kill -9 -- "-$control_watchdog_group" 2>/dev/null; fi
      }
      _bounded_guard_protocol_failure() {
        guard_status=2
        _bounded_guard_end_worker
        _bounded_guard_kill_authorized
        _bounded_guard_exit
      }
      # The outer signals the guard only after reaping the worker. A signal from
      # anywhere else can find it alive: end it, and report 2 as every other
      # guard path that ends a live worker does. Then end the recorded groups,
      # which a worker whose cleanup was cut short leaves behind.
      trap 'if kill -0 "$worker_pid" 2>/dev/null; then guard_status=2; _bounded_guard_end_worker; fi
        _bounded_guard_kill_authorized
        _bounded_guard_exit' INT TERM HUP
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
          IFS=$' \t\n' read -r state observed_group <<< "$observed"
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
      local authorization_state=1 outcome_claim_rc=0
      # Report the deadline only once it owns the outcome. A TERM before the
      # claim follows a worker that already returned its own authenticated view.
      _bounded_claim_outcome deadline-outer
      outcome_claim_rc=$?
      case "$outcome_claim_rc" in
        0) guard_status=124 ;;
        1)
          _bounded_read_outcome || _bounded_guard_protocol_failure
          case "$outcome_event" in
            result) guard_status=0 ;;
            deadline) guard_status=124 ;;
            *) _bounded_guard_protocol_failure ;;
          esac
          ;;
        *) _bounded_guard_protocol_failure ;;
      esac
      _bounded_read_authorization
      authorization_state=$?
      if [ "$authorization_state" -eq 0 ]; then
        command_authorized=1
        [ -z "$control_watchdog_group" ] || watchdog_authorized=1
        kill -TERM -- "-$control_command_group" 2>/dev/null
      elif [ "$authorization_state" -eq 2 ]; then
        # An invalid record names no group to trust. End the worker and every
        # group it created before any signal can make it exit.
        guard_status=2
        _bounded_guard_end_worker
        _bounded_guard_exit
      elif [ "$authorization_state" -ne 3 ]; then
        # With no record, end the groups the worker created while it is alive
        # and stopped, then let it run its own cleanup.
        _bounded_guard_stop_monitor
        _bounded_kill_worker_children || guard_status=2
        kill -TERM -- "-$worker_group" 2>/dev/null
        kill -CONT -- "-$worker_group" 2>/dev/null
      fi
      # A reaped command may have a worker still finishing bounded cleanup.
      [ "$authorization_state" -eq 3 ] || kill -USR1 "$worker_pid" 2>/dev/null
      if ! sleep "$grace"; then
        _bounded_guard_kill_authorized
        _bounded_guard_end_worker
        guard_status=2
        _bounded_guard_exit
      fi
      _bounded_guard_kill_authorized
      if [ "$authorization_state" -eq 0 ]; then
        sleep "$grace" &
        timer_pid=$!
        wait "$timer_pid" 2>/dev/null
        [ "$?" -eq 0 ] || { _bounded_guard_end_worker; guard_status=2; _bounded_guard_exit; }
        _bounded_guard_end_worker
        guard_status=2
        _bounded_guard_exit
      else
        if kill -0 "$worker_pid" 2>/dev/null; then guard_status=2; fi
        _bounded_guard_end_worker
      fi
      _bounded_guard_exit
    ) </dev/null >/dev/null 2>&1 &
    guard_pid=$!
    guard_group="$(jobs -p %+)"
    if [[ ! "$guard_group" =~ ^[0-9]+$ ]] || [ "$guard_group" -le 1 ] || [ "$guard_group" = "$worker_group" ]; then return 2; fi

    wait "$worker_pid" 2>/dev/null || worker_rc=$?
    worker_reaped=1
    if [ -e "$deadline_file" ] || [ -L "$deadline_file" ]; then
      _bounded_read_deadline_bounded
      deadline_rc=$?
    fi
    if kill -0 "$guard_pid" 2>/dev/null; then
      kill -CONT "$guard_pid" 2>/dev/null
      # A failed claim and a real exit 2 share worker status. If the inner
      # deadline fired without an authenticated outcome, let the guard decide.
      if [ "$worker_rc" -ne 2 ] || [ "$deadline_rc" -ne 124 ] || _bounded_read_outcome; then
        kill -TERM "$guard_pid" 2>/dev/null
      fi
    fi
    wait "$guard_pid" 2>/dev/null || guard_rc=$?
    guard_reaped=1
    if [ "$deadline_rc" -eq 2 ] || [ -e "$cleanup_file" ] || [ -L "$cleanup_file" ]; then
      rc=2
    else
      case "$guard_rc" in 124|2) rc="$guard_rc" ;; *) if [ "$deadline_rc" -eq 124 ]; then rc=124; else rc="$worker_rc"; fi ;; esac
    fi
    _bounded_outer_cleanup
    trap - EXIT
    [ "$status_cleanup_failed" -eq 0 ] || rc=2
    return "$rc"
  )
}
