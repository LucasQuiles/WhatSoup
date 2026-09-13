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
# authenticated, matching-instance model_usable=true with explicit fresh evidence.
#
# This is a bounded, fail-closed operator tool. It does NOT auto-run (no timer);
# it reads the canonical private health token, never a keychain password or
# provider credential. It requires the complete release's shared token reader,
# compatible Node and installed dependencies, plus curl, python3 and launchctl.
#
# Exit codes:
#   0  healthy / recovered  (status=healthy AND turn_capability.model_usable=true)
#   1  still degraded after exhausting kickstarts (escalate: GUI keychain unlock)
#   2  bad args/runtime/token, failed/timed-out kickstart, unobserved health,
#      transport/HTTP auth failure, or non-model degradation
#   3  authenticated health missing identity, required fields or valid freshness
#
# Usage:
#   whatsoup-keychain-heal.sh --label com.whatsoup.x-bot --port 9090 \
#       [--uid <uid>] [--max-kickstarts 2] [--health-timeout 6] [--settle 8]

# Also disables tracing when invoked with bash -x, before reading any token.
set +x
set -euo pipefail
# Remove an inherited export before introducing the private local below.
unset health_token

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLASSIFY_PY="${SCRIPT_DIR}/lib/classify_health.py"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
DEPLOY_LIB="$REPO_ROOT/deploy/lib"

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
[[ "$LABEL" == com.whatsoup.* ]] || usage_die "--label must be com.whatsoup.<instance>"
INSTANCE="${LABEL#com.whatsoup.}"
[[ "$INSTANCE" =~ ^[a-z][a-z0-9-]*$ && ${#INSTANCE} -le 30 ]] || usage_die "invalid canonical instance label"
[[ "$UID_" == "$(id -u)" ]] || usage_die "--uid must match the current user and token owner"
[[ "$HEALTH_TIMEOUT" =~ ^[1-9][0-9]*$ ]] || usage_die "--health-timeout must be a positive integer"
for helper in "$DEPLOY_LIB/bounded-exec.sh" "$DEPLOY_LIB/resolve-node.sh" \
              "$DEPLOY_LIB/read-private-health-token.mjs" "$SCRIPT_DIR/lib/health_reader.py"; do
  [[ -f "$helper" ]] || usage_die "required release helper missing"
done
# shellcheck source=../lib/bounded-exec.sh
. "$DEPLOY_LIB/bounded-exec.sh"
# Positional parameters are expanded only by the bounded child shell.
# shellcheck disable=SC2016
if ! NODE="$(whatsoup_run_bounded "$HEALTH_TIMEOUT" bash -c \
    '. "$1"; whatsoup_resolve_node "$2"' _ "$DEPLOY_LIB/resolve-node.sh" "$REPO_ROOT" 2>/dev/null)"; then
  usage_die "compatible Node resolution failed or timed out"
fi
TOKEN_FILE="${XDG_CONFIG_HOME:-$HOME/.config}/whatsoup/instances/$INSTANCE/tokens.env"

# Classify the current /health. Prints exactly one verdict token:
#   ok | degraded | non_model | unreachable | parse | fields | token | unobserved | identity
classify_health() {
  local health_token response http_status body
  # A local can inherit an ambient variable's export attribute in Bash.
  export -n health_token response http_status body
  if ! health_token="$(printf '%s\0' "$TOKEN_FILE" | whatsoup_run_bounded "$HEALTH_TIMEOUT" \
      "$NODE" --experimental-strip-types "$DEPLOY_LIB/read-private-health-token.mjs" 2>/dev/null)"; then
    health_token=""
    echo "token"
    return 0
  fi
  # The strict reader permits only canonical hex, so it cannot inject config.
  # Ignore curlrc and proxies; credentials travel only on stdin to loopback.
  # Preserve transport failure separately from an authenticated HTTP 503 body.
  if ! response="$(printf 'header = "Authorization: Bearer %s"\n' "$health_token" | \
      curl -q --config - --noproxy '*' --silent --show-error --max-time "$HEALTH_TIMEOUT" \
        --write-out '\n%{http_code}' "http://127.0.0.1:${PORT}/health" 2>/dev/null)"; then
    health_token=""
    echo "unreachable"
    return 0
  fi
  health_token=""
  http_status="${response##*$'\n'}"
  body="${response%$'\n'*}"
  case "$http_status" in
    200|503) ;;
    *) echo "unobserved"; return 0 ;;
  esac
  # Reuse the shared projection and freshness rules after checking identity.
  # The diagnostic body stays on stdin and only a verdict reaches our logs.
  printf '%s' "$body" | python3 -B -c '
import json, sys
sys.path.insert(0, sys.argv[1])
from classify_health import classify
from health_reader import classify_projection
try:
    payload = json.load(sys.stdin)
except (ValueError, TypeError):
    print("parse")
    raise SystemExit(0)
if classify_projection(payload, token_sent=True) != "diagnostic":
    print("unobserved")
elif not isinstance(payload.get("instance"), dict) or payload["instance"].get("name") != sys.argv[2]:
    print("identity")
else:
    print(classify(payload))
' "$SCRIPT_DIR/lib" "$INSTANCE" 2>/dev/null || { echo "parse"; return 0; }
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
      if ! whatsoup_run_bounded "$HEALTH_TIMEOUT" launchctl kickstart -k "gui/${UID_}/${LABEL}" >&2; then
        echo "whatsoup-keychain-heal: FATAL: launchctl kickstart failed or timed out for gui/${UID_}/${LABEL}." >&2
        exit 2
      fi
      sleep "$SETTLE"
      ;;
    non_model)
      echo "whatsoup-keychain-heal: authenticated health reports a fresh usable model;" \
           "non-model degradation is not a keychain-heal case; no action." >&2
      exit 2
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
    token|unobserved)
      echo "whatsoup-keychain-heal: FATAL: private token unavailable or /health authentication/diagnostic evidence unobserved; no action." >&2
      exit 2
      ;;
    identity)
      echo "whatsoup-keychain-heal: FATAL: authenticated /health instance.name does not match the launchd label; no action." >&2
      exit 3
      ;;
    fields)
      echo "whatsoup-keychain-heal: FATAL: /health body missing status or" \
           "turn_capability.model_usable, or missing/invalid" \
           "turn_capability.model_usable_stale (boolean required)." >&2
      exit 3
      ;;
    *)
      echo "whatsoup-keychain-heal: FATAL: unexpected health verdict '$verdict'." >&2
      exit 3
      ;;
  esac
done
