#!/usr/bin/env bash
# whatsoup-keychain-heal.sh — operator remediation for a macOS GUI-LaunchAgent
# WhatSoup bot that is running but model-degraded because the claude-cli OAuth
# loader could not read the login keychain.
#
# Why this exists: a plist-change repoint requires `launchctl bootout`+`bootstrap`
# over SSH, which drops the job out of the Aqua keychain *session*. The bot's
# `with-claude-oauth-keychain` wrapper then fails to unlock the login keychain even
# with the correct password, so /health reports status=degraded with
# turn_capability.model_usable=false (WhatsApp stays connected — Baileys file auth).
# `launchctl kickstart -k gui/<uid>/<label>` restarts the job WITHIN the already
# bootstrapped GUI domain, re-joining the keychain session so the wrapper's
# self-unlock-from-file succeeds and the model recovers. The acceptance signal is
# model_usable=true — NOT health HTTP 200, which is true even while degraded.
#
# This is a bounded, fail-closed operator tool. It does NOT auto-run (no timer);
# it does NOT read, write, or print any secret or keychain password; it calls only
# `curl` (>= 7.76 for --fail-with-body; ships on modern macOS), `launchctl`, and
# `python3` by name.
#
# Exit codes:
#   0  healthy / recovered  (status=healthy AND turn_capability.model_usable=true)
#   1  still degraded after exhausting kickstarts (escalate: GUI keychain unlock)
#   2  infrastructure: bad args, /health unreachable, or unparseable body
#   3  unexpected state: /health body present but missing required fields
#
# Usage:
#   whatsoup-keychain-heal.sh --label com.whatsoup.x-bot --port 9090 \
#       [--uid <uid>] [--max-kickstarts 2] [--health-timeout 6] [--settle 8]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLASSIFY_PY="${SCRIPT_DIR}/lib/classify_health.py"

LABEL=""
PORT=""
UID_="$(id -u)"
MAX_KICKSTARTS=2
HEALTH_TIMEOUT=6
SETTLE=8

usage_die() {
  echo "whatsoup-keychain-heal: $*" >&2
  echo "usage: whatsoup-keychain-heal.sh --label <launchd-label> --port <health-port>" \
       "[--uid N] [--max-kickstarts N] [--health-timeout S] [--settle S]" >&2
  exit 2
}

# Guard a value-taking option so a trailing flag with no value fails as a clean
# usage error (exit 2) rather than aborting on `shift 2` under `set -e`.
require_value() { [[ $# -ge 2 ]] || usage_die "option $1 requires a value"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --label)          require_value "$@"; LABEL="$2"; shift 2 ;;
    --port)           require_value "$@"; PORT="$2"; shift 2 ;;
    --uid)            require_value "$@"; UID_="$2"; shift 2 ;;
    --max-kickstarts) require_value "$@"; MAX_KICKSTARTS="$2"; shift 2 ;;
    --health-timeout) require_value "$@"; HEALTH_TIMEOUT="$2"; shift 2 ;;
    --settle)         require_value "$@"; SETTLE="$2"; shift 2 ;;
    -h|--help)        usage_die "help" ;;
    *)                usage_die "unknown argument: $1" ;;
  esac
done

[[ -n "$LABEL" ]] || usage_die "missing --label"
[[ -n "$PORT" ]] || usage_die "missing --port"
[[ "$PORT" =~ ^[0-9]+$ ]] || usage_die "--port must be numeric: $PORT"
[[ "$MAX_KICKSTARTS" =~ ^[0-9]+$ ]] || usage_die "--max-kickstarts must be numeric: $MAX_KICKSTARTS"
[[ "$UID_" =~ ^[0-9]+$ ]] || usage_die "--uid must be numeric: $UID_"
[[ "$HEALTH_TIMEOUT" =~ ^[0-9]+$ ]] || usage_die "--health-timeout must be numeric: $HEALTH_TIMEOUT"
[[ "$SETTLE" =~ ^[0-9]+$ ]] || usage_die "--settle must be numeric: $SETTLE"
[[ -f "$CLASSIFY_PY" ]] || usage_die "classifier not found: $CLASSIFY_PY"

# Classify the current /health. Prints exactly one verdict token:
#   ok | degraded | unreachable | parse | fields
classify_health() {
  local body
  # -sS: silent progress but still surface curl's own error (e.g. connection
  # refused / timeout) on this script's stderr so the operator can see *why* a
  # probe failed. --fail-with-body: nonzero exit on HTTP >=400 while still
  # capturing the body. `|| true` keeps `set -e` from aborting on a
  # connection-level failure; the empty-body check below classifies unreachable.
  body="$(curl -sS --fail-with-body --max-time "$HEALTH_TIMEOUT" \
            "http://127.0.0.1:${PORT}/health")" || true
  # Connection-level failure (refused/timeout/DNS) leaves no body => unreachable.
  if [[ -z "$body" ]]; then
    echo "unreachable"
    return 0
  fi
  # Classification logic lives in lib/classify_health.py (unit-tested). The
  # acceptance signal is a FRESH usable model: status=healthy AND
  # model_usable=true AND not model_usable_stale (the #1392 freshness guard).
  printf '%s' "$body" | python3 "$CLASSIFY_PY" 2>/dev/null || { echo "parse"; return 0; }
}

attempt=0
while :; do
  verdict="$(classify_health)"
  case "$verdict" in
    ok)
      if [[ "$attempt" -eq 0 ]]; then
        echo "whatsoup-keychain-heal: $LABEL already healthy (model_usable=true); no action." >&2
      else
        echo "whatsoup-keychain-heal: $LABEL recovered after $attempt kickstart(s)." >&2
      fi
      exit 0
      ;;
    degraded)
      if [[ "$attempt" -ge "$MAX_KICKSTARTS" ]]; then
        echo "whatsoup-keychain-heal: $LABEL still degraded after $attempt kickstart(s);" \
             "escalate to a GUI keychain unlock (security unlock-keychain on the host)." >&2
        exit 1
      fi
      attempt=$((attempt + 1))
      echo "whatsoup-keychain-heal: $LABEL degraded; kickstart $attempt/$MAX_KICKSTARTS gui/${UID_}/${LABEL}" >&2
      if ! launchctl kickstart -k "gui/${UID_}/${LABEL}" >&2; then
        echo "whatsoup-keychain-heal: FATAL: launchctl kickstart failed for gui/${UID_}/${LABEL}." >&2
        exit 2
      fi
      sleep "$SETTLE"
      ;;
    unreachable)
      echo "whatsoup-keychain-heal: FATAL: /health unreachable on 127.0.0.1:${PORT}" \
           "(bot down or wrong port) — not a keychain-heal case." >&2
      exit 2
      ;;
    parse)
      echo "whatsoup-keychain-heal: FATAL: /health body was not parseable JSON." >&2
      exit 2
      ;;
    fields)
      echo "whatsoup-keychain-heal: FATAL: /health body missing status or" \
           "turn_capability.model_usable." >&2
      exit 3
      ;;
    *)
      echo "whatsoup-keychain-heal: FATAL: unexpected health verdict '$verdict'." >&2
      exit 3
      ;;
  esac
done
