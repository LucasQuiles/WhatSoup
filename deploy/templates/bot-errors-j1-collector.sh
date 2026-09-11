#!/usr/bin/env bash
# bot-errors-j1-collector.sh — launchd wrapper for the hourly BOT ERRORS J1 collector.
#
# Reads host-specific values from ~/.config/whatsoup/bot-errors-j1-collector.env
# (untracked; never committed) and runs the collector read-only over ssh.
# The collector itself never publishes a checkpoint, takes a lease, or appends
# the ledger; it only writes runs/<run>/collect/ bundles under the loop root.
#
# Required in the env file:
#   BOT_ERRORS_J1_ROOT        loop root (checkpoint/, runs/)
#   BOT_ERRORS_J1_GROUP_JID   alert group chat jid
#   BOT_ERRORS_J1_COLLECTOR   absolute path of bot_errors_j1_collector.py
# Optional:
#   BOT_ERRORS_J1_SLOT_MINUTE (default 17; must match the plist's StartCalendarInterval)
#   BOT_ERRORS_J1_PYTHON      (default: python3 on PATH)
#   BOT_ERRORS_J1_ALERT_HOST, BOT_ERRORS_J1_CANARY_HOST, BOT_ERRORS_J1_CANARY_INSTANCE
#                             (collector defaults apply when unset)
#
# Install to: ~/.local/bin/bot-errors-j1-collector
# chmod +x after writing.
set -eu

ENV_FILE="$HOME/.config/whatsoup/bot-errors-j1-collector.env"
if [ ! -r "$ENV_FILE" ]; then
  echo "[$(date -u +%FT%TZ)] bot-errors-j1-collector: missing host config: $ENV_FILE" >&2
  exit 78
fi
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

: "${BOT_ERRORS_J1_ROOT:?BOT_ERRORS_J1_ROOT unset in $ENV_FILE}"
: "${BOT_ERRORS_J1_GROUP_JID:?BOT_ERRORS_J1_GROUP_JID unset in $ENV_FILE}"
: "${BOT_ERRORS_J1_COLLECTOR:?BOT_ERRORS_J1_COLLECTOR unset in $ENV_FILE}"
SLOT_MINUTE="${BOT_ERRORS_J1_SLOT_MINUTE:-17}"
PYTHON="${BOT_ERRORS_J1_PYTHON:-python3}"

# launchd starts with a minimal PATH; ssh, sqlite3 and python3 must resolve.
export PATH="${PATH:-/usr/bin:/bin}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

if [ ! -f "$BOT_ERRORS_J1_COLLECTOR" ]; then
  echo "[$(date -u +%FT%TZ)] bot-errors-j1-collector: collector script missing: $BOT_ERRORS_J1_COLLECTOR" >&2
  exit 78
fi

echo "[$(date -u +%FT%TZ)] bot-errors-j1-collector: start slot=$SLOT_MINUTE"
rc=0
"$PYTHON" "$BOT_ERRORS_J1_COLLECTOR" --live --slot-minute "$SLOT_MINUTE" || rc=$?
echo "[$(date -u +%FT%TZ)] bot-errors-j1-collector: done rc=$rc"
exit "$rc"
