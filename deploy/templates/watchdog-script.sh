#!/bin/zsh
# watchdog-script.sh — template for com.whatsoup.BOT_NAME-watchdog
#
# Replace before installing:
#   BOT_NAME      — e.g. rb-bot, ml-bot, ew-bot
#   USERNAME      — macOS user account (the bot operator account)
#   BOT_HEALTH    — health endpoint URL for THIS bot (check port map in
#                   docs/runbooks/macos-host-setup.md before assuming 9099)
#   FLEET_HEALTH  — fleet console URL for THIS host (standard 9099; except
#                   some hosts run the fleet API on a non-default port — see the host port map)
#   NODE_BIN      — absolute path to pinned node binary, e.g.
#                   __HOME__/.nvm/versions/node/v24.15.0/bin/node
#
# Install to: ~/.local/bin/BOT_NAME-watchdog
# chmod +x that file after writing.
#
# Derived from a hardened production watchdog (2026-06-11).
# That version fixed a set -u bug where `local job_label` was referenced
# before assignment — the ensure_loaded function below avoids that by
# accepting both args on a single line.

set -u

HOME_DIR="__HOME__"
LOG_DIR="$HOME_DIR/Library/Logs/whatsoup"
LOG="$LOG_DIR/BOT_NAME-watchdog.log"
LOCK="/tmp/com.whatsoup.BOT_NAME-watchdog.lock"

BOT_LABEL="com.whatsoup.BOT_NAME"
FLEET_LABEL="com.whatsoup.whatsoup-fleet"
BOT_PLIST="$HOME_DIR/Library/LaunchAgents/$BOT_LABEL.plist"
FLEET_PLIST="$HOME_DIR/Library/LaunchAgents/$FLEET_LABEL.plist"

BOT_HEALTH="http://127.0.0.1:BOT_PORT/health"
FLEET_HEALTH="http://127.0.0.1:FLEET_PORT/"

# Use the pinned node binary — never /usr/bin/env node (see macOS-host-setup runbook).
NODE_BIN="__HOME__/.nvm/versions/node/v24.15.0/bin/node"

PATH="$HOME_DIR/.local/bin:$(dirname "$NODE_BIN"):/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export HOME="$HOME_DIR" PATH

mkdir -p "$LOG_DIR"

# Single-instance lock: if another watchdog invocation is still running, exit.
if ! mkdir "$LOCK" 2>/dev/null; then
  exit 0
fi
trap 'rmdir "$LOCK" 2>/dev/null || true' EXIT

# Rotate log if it exceeds 1 MB.
if [ -f "$LOG" ]; then
  size=$(wc -c < "$LOG" 2>/dev/null || echo 0)
  if [ "${size:-0}" -gt 1048576 ]; then
    tail -n 500 "$LOG" > "$LOG.tmp" 2>/dev/null && mv "$LOG.tmp" "$LOG"
  fi
fi

ts() { date -u +"%Y-%m-%dT%H:%M:%SZ"; }
log() { print -- "$(ts) $*" >> "$LOG"; }

domain="gui/$(id -u)"

# Ensure a launchd job is loaded; bootstrap from its plist if not.
ensure_loaded() {
  local job_label="$1" plist="$2"
  if ! launchctl print "$domain/$job_label" >/dev/null 2>&1; then
    log "$job_label not loaded; bootstrapping"
    launchctl bootstrap "$domain" "$plist" >> "$LOG" 2>&1 || true
  fi
}

# Restart a job with a 5-minute cooldown to avoid restart storms.
restart_label() {
  local job_label="$1" reason="$2"
  local stamp="$LOG_DIR/$job_label.last-restart"
  local now last
  now=$(date +%s)
  last=0
  [ -r "$stamp" ] && last=$(cat "$stamp" 2>/dev/null || echo 0)
  if [ $((now - last)) -lt 300 ]; then
    log "$job_label unhealthy but restart suppressed by cooldown: $reason"
    return 0
  fi
  print -- "$now" > "$stamp"
  log "restarting $job_label: $reason"
  launchctl kickstart -k "$domain/$job_label" >> "$LOG" 2>&1 || true
}

ensure_loaded "$BOT_LABEL" "$BOT_PLIST"
ensure_loaded "$FLEET_LABEL" "$FLEET_PLIST"

# --- Bot health check ---
bot_json="$(curl --fail --silent --show-error --max-time 8 "$BOT_HEALTH" 2>>"$LOG" || true)"
if [ -z "$bot_json" ]; then
  restart_label "$BOT_LABEL" "health endpoint unreachable"
else
  BOT_JSON="$bot_json" python3 - <<'PY' || restart_label "$BOT_LABEL" "unhealthy JSON response"
import datetime as dt
import json
import os
import sys

data = json.loads(os.environ["BOT_JSON"])
status = data.get("status")
whatsapp = data.get("whatsapp") or {}
conn = whatsapp.get("connection") or {}
connected = whatsapp.get("connected") is True
state = conn.get("state")
last_pong = conn.get("last_pong_at")

reasons = []
if status != "healthy":
    reasons.append(f"status={status!r}")
if not connected:
    reasons.append("whatsapp.connected=false")
if state != "connected":
    reasons.append(f"state={state!r}")
if last_pong:
    parsed = dt.datetime.fromisoformat(last_pong.replace("Z", "+00:00"))
    age = (dt.datetime.now(dt.timezone.utc) - parsed).total_seconds()
    if age > 360:
        reasons.append(f"last_pong_age={age:.0f}s")

if reasons:
    print("; ".join(reasons), file=sys.stderr)
    sys.exit(1)
PY
fi

# --- Fleet console health check ---
if ! curl --fail --silent --show-error --max-time 8 "$FLEET_HEALTH" >/dev/null 2>>"$LOG"; then
  restart_label "$FLEET_LABEL" "fleet console unreachable"
fi

log "ok"
