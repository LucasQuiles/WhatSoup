#!/usr/bin/env bash

# Bounded command execution for credential-store probes.
#
# Why this exists: `security` (macOS Keychain) and `secret-tool` (libsecret) both
# block indefinitely when the credential daemon needs interactive authorization.
# On a headless or auto-login host nobody can answer that prompt, so an unbounded
# lookup wedges the caller forever — that is how ph-bot on mini11 stayed down for
# ~45h while its watchdog reported `ok`.
#
# Why it is not just `timeout 3s`: stock macOS ships no `timeout(1)`. GNU
# coreutils installs it as `gtimeout`, and Homebrew's `coreutils` is not a
# deployment prerequisite. A `timeout 3s security ...` line is therefore a
# no-op-that-fails-closed on Linux and a `command not found` on Darwin. The
# pure-shell watchdog below is the only branch guaranteed to exist on both.
#
# Exit status: 124 when the budget was exhausted (matching GNU timeout), the
# command's own status otherwise.

# whatsoup_run_bounded <seconds> <command> [args...]
whatsoup_run_bounded() {
  if [ "$#" -lt 2 ]; then
    echo "FATAL: whatsoup_run_bounded requires a budget and a command" >&2
    return 2
  fi

  local budget="$1"
  shift

  # SIGKILL grace (seconds) after SIGTERM, for the timeout/gtimeout branches only.
  # Bare GNU `timeout` sends SIGTERM at the budget and then WAITS for the child to
  # exit, so a child that ignores or survives SIGTERM lets the wrapper wait with it
  # forever: `timeout 2s bash -c 'trap "" TERM; sleep 20'` returns 124 only after
  # the child has already run the full 20s (measured). `-k` follows SIGTERM with
  # SIGKILL after this grace, so the wall clock is actually bounded, not merely
  # reported as timed-out.
  #
  # The grace scales with the budget: a short credential probe (3-5s) must fail
  # fast, while a long package install (300-600s) needs a real window after SIGTERM
  # to release a dpkg lock or flush a mirror transfer before SIGKILL — SIGKILLing a
  # package manager mid-`dpkg` can leave a broken install worse than the hang this
  # helper exists to stop. Floor 2s, ceiling 30s.
  local rc grace
  grace=$(( budget / 10 ))
  [ "$grace" -lt 2 ] && grace=2
  [ "$grace" -gt 30 ] && grace=30

  if command -v timeout >/dev/null 2>&1; then
    timeout -k "${grace}s" "${budget}s" "$@"
    rc=$?
    # `timeout` exits 137 (128+SIGKILL) when it had to escalate past SIGTERM to
    # SIGKILL; fold that back into the documented 124 budget-exhausted exit so
    # callers distinguish "timed out" from "failed", never which signal ended it.
    [ "$rc" -eq 137 ] && rc=124
    return "$rc"
  fi
  if command -v gtimeout >/dev/null 2>&1; then
    gtimeout -k "${grace}s" "${budget}s" "$@"
    rc=$?
    [ "$rc" -eq 137 ] && rc=124
    return "$rc"
  fi

  # Job control is local to this subshell. Each gated job gets an owned group;
  # disabling monitor mode inside it keeps ordinary descendants in that group.
  (
    set +e
    set -m
    local directory cmd_pid="" cmd_group="" watchdog_pid="" watchdog_group=""
    local candidate observed caller_group cleanup_rc=0
    directory="$(mktemp -d "${TMPDIR:-/tmp}/whatsoup-bounded.XXXXXX")" || return 2

    _whatsoup_bounded_cleanup() {
      local group count
      # Unverified jobs are still blocked opening their launch FIFO and have
      # not executed the requested command or created timer descendants.
      if [ -n "$cmd_pid" ] && [ -z "$cmd_group" ]; then kill -9 "$cmd_pid" 2>/dev/null; fi
      if [ -n "$watchdog_pid" ] && [ -z "$watchdog_group" ]; then kill -9 "$watchdog_pid" 2>/dev/null; fi
      for group in "$watchdog_group" "$cmd_group"; do
        [ -n "$group" ] && kill -9 -- "-$group" 2>/dev/null
      done
      [ -n "$cmd_pid" ] && wait "$cmd_pid" 2>/dev/null
      [ -n "$watchdog_pid" ] && wait "$watchdog_pid" 2>/dev/null
      # Grandchildren are reaped by their parent or the OS. Do not report
      # completion while a signalled member still exists in an owned group.
      for group in "$watchdog_group" "$cmd_group"; do
        [ -n "$group" ] || continue
        count=0
        while kill -0 -- "-$group" 2>/dev/null; do
          count=$((count + 1))
          if [ "$count" -ge 200 ]; then cleanup_rc=2; break; fi
          sleep 0.01
        done
      done
      rm -f "$directory/command" "$directory/watchdog" "$directory/timeout"
      rmdir "$directory"
    }
    trap '_whatsoup_bounded_cleanup' EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM HUP

    if ! mkfifo "$directory/command" "$directory/watchdog"; then return 2; fi
    caller_group="$(ps -o pgid= -p "$$")" || return 2
    caller_group="${caller_group//[[:space:]]/}"
    [[ "$caller_group" =~ ^[0-9]+$ ]] || return 2

    # The read redirects only its own stdin; the wrapped command retains fd0.
    (
      set +m
      IFS= read -r start < "$directory/command" || exit 2
      [ "$start" = run ] || exit 2
      "$@"
    ) <&0 &
    cmd_pid=$!
    candidate="$(jobs -p %+)"
    observed="$(ps -o pgid= -p "$cmd_pid")" || return 2
    observed="${observed//[[:space:]]/}"
    if [[ ! "$candidate" =~ ^[0-9]+$ ]] || [ "$candidate" -le 1 ] \
        || [ "$candidate" != "$observed" ] || [ "$candidate" = "$caller_group" ]; then
      return 2
    fi
    cmd_group="$candidate"

    (
      set +m
      IFS= read -r start < "$directory/watchdog" || exit 2
      [ "$start" = run ] || exit 2
      sleep "$budget"
      printf timeout > "$directory/timeout"
      kill -9 -- "-$cmd_group" 2>/dev/null
    ) >/dev/null 2>&1 &
    watchdog_pid=$!
    candidate="$(jobs -p %+)"
    observed="$(ps -o pgid= -p "$watchdog_pid")" || return 2
    observed="${observed//[[:space:]]/}"
    if [[ ! "$candidate" =~ ^[0-9]+$ ]] || [ "$candidate" -le 1 ] \
        || [ "$candidate" != "$observed" ] || [ "$candidate" = "$caller_group" ] \
        || [ "$candidate" = "$cmd_group" ]; then
      return 2
    fi
    watchdog_group="$candidate"

    printf 'run\n' > "$directory/command"
    printf 'run\n' > "$directory/watchdog"
    rc=0
    wait "$cmd_pid" 2>/dev/null || rc=$?
    [ -s "$directory/timeout" ] && rc=124
    _whatsoup_bounded_cleanup
    trap - EXIT
    [ "$cleanup_rc" -eq 0 ] || rc=2
    return "$rc"
  )
}
