#!/usr/bin/env bash
# ============================================================================
# whatsoup-release-drift-linux.sh
# Linux (systemd) parity for macOS com.whatsoup.release-drift-check.plist.
# ----------------------------------------------------------------------------
# The macOS plist derives the CURRENTLY-DEPLOYED release from the launchd job's
# ProgramArguments (--launchd-plist). The Linux analog is to derive it from the
# live service launcher symlink each run, so the check always tracks whatever
# whatsoup@<instance> is actually running — surviving cutovers without edits.
#
# Emits release-integrity (drift) + release-currency (behind origin/main) alerts
# through the existing BOT ERRORS outbox pipeline (deploy/scripts/bot-errors-emit.py),
# and clears them on a clean run (--clear-on-ok). Fail-closed exit codes:
#   0 clean · 1 drifted/behind-target (alert emitted) · 2 inconclusive
# (fails the systemd unit; see deploy/whatsoup-release-drift.service).
# ============================================================================
set -uo pipefail

LAUNCHER="${WHATSOUP_LAUNCHER:-$HOME/.local/bin/whatsoup}"
TARGET_URL="${WHATSOUP_RELEASE_TARGET_URL:-git@github.com:LucasQuiles/WhatSoup.git}"
TARGET_REF="${WHATSOUP_RELEASE_TARGET_REF:-refs/heads/main}"
INSTANCE="${WHATSOUP_INSTANCE:-}"
export WHATSOUP_RELEASE_DRIFT_LOG_DIR="${WHATSOUP_RELEASE_DRIFT_LOG_DIR:-$HOME/.local/state/whatsoup/logs}"

fail(){ echo "whatsoup-release-drift-linux: $1" >&2; exit "${2:-2}"; }

[ -n "$INSTANCE" ] || fail "WHATSOUP_INSTANCE is not set"

# Resolve deployed release root from the launcher symlink:
#   <root>/deploy/whatsoup  ->  strip trailing /deploy/whatsoup
# Portable symlink resolution (GNU-only canonicalising flags are avoided): follow each link hop,
# then canonicalise the final directory with `pwd -P`.
resolve_path() {
  local path="$1" link hops=0
  while [ -L "$path" ]; do
    [ "$hops" -lt 40 ] || return 1
    link="$(readlink -- "$path")" || return 1
    case "$link" in
      /*) path="$link" ;;
      *) path="$(dirname -- "$path")/$link" ;;
    esac
    hops=$((hops + 1))
  done
  [ -e "$path" ] || return 1
  printf '%s/%s\n' "$(cd -P -- "$(dirname -- "$path")" && pwd -P)" "$(basename -- "$path")"
}

target="$(resolve_path "$LAUNCHER")" || fail "cannot resolve launcher $LAUNCHER"
case "$target" in
  */deploy/whatsoup) RELEASE_ROOT="${target%/deploy/whatsoup}" ;;
  *) fail "launcher target has unexpected shape: $target" ;;
esac
[ -d "$RELEASE_ROOT" ] || fail "resolved release root does not exist: $RELEASE_ROOT"
[ -f "$RELEASE_ROOT/scripts/live-release-observers.ts" ] && \
  [ -f "$RELEASE_ROOT/deploy/scripts/run-release-drift-schedule.sh" ] || \
  fail "release root missing observer entrypoints: $RELEASE_ROOT"

exec bash "$RELEASE_ROOT/deploy/scripts/run-release-drift-schedule.sh" \
  --release "$RELEASE_ROOT" \
  --repo-root "$RELEASE_ROOT" \
  --target-url "$TARGET_URL" \
  --target-ref "$TARGET_REF" \
  --instance "$INSTANCE" \
  --clear-on-ok
