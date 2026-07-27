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

  if command -v timeout >/dev/null 2>&1; then
    timeout "${budget}s" "$@"
    return $?
  fi
  if command -v gtimeout >/dev/null 2>&1; then
    gtimeout "${budget}s" "$@"
    return $?
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

  local rc=0
  wait "$cmd_pid" 2>/dev/null || rc=$?

  kill -9 "$watchdog_pid" 2>/dev/null
  wait "$watchdog_pid" 2>/dev/null

  if [ -s "$marker" ]; then
    rc=124
  fi
  rm -f "$marker"
  return "$rc"
}
