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

  # Portable fallback. The watchdog's stdout/stderr are detached so a caller
  # using command substitution is not held open for the full budget waiting on
  # the watchdog's copy of the pipe.
  local marker
  marker="$(mktemp "${TMPDIR:-/tmp}/whatsoup-bounded.XXXXXX")" || return 2

  # `<&0` is required: bash assigns /dev/null to an asynchronous command's stdin
  # unless an explicit redirection overrides it, which would silently break
  # callers that pipe a secret in (e.g. `printf ... | whatsoup_run_bounded 5
  # secret-tool store ...`).
  "$@" <&0 &
  local cmd_pid=$!

  (
    sleep "$budget"
    if kill -0 "$cmd_pid" 2>/dev/null; then
      printf 'timeout' > "$marker"
      kill -9 "$cmd_pid" 2>/dev/null
    fi
  ) >/dev/null 2>&1 &
  local watchdog_pid=$!

  rc=0
  wait "$cmd_pid" 2>/dev/null || rc=$?

  kill -9 "$watchdog_pid" 2>/dev/null
  wait "$watchdog_pid" 2>/dev/null

  if [ -s "$marker" ]; then
    rc=124
  fi
  rm -f "$marker"
  return "$rc"
}
