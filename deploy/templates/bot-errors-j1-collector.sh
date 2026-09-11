#!/usr/bin/env bash
# bot-errors-j1-collector.sh — launchd wrapper for the hourly BOT ERRORS J1 collector.
#
# Reads host-specific values from ~/.config/whatsoup/bot-errors-j1-collector.env
# (untracked; never committed) and runs the collector read-only over ssh.
# The collector itself never publishes a checkpoint, takes a lease, or appends
# the ledger; it only writes runs/<run>/collect/ bundles under the loop root.
#
# Required in the env file (plain KEY=value lines; it is SOURCED as shell, so it
# must be owned by the running user and not group/world writable):
#   BOT_ERRORS_J1_ROOT        loop root (checkpoint/, runs/)
#   BOT_ERRORS_J1_GROUP_JID   alert group chat jid
#   BOT_ERRORS_J1_COLLECTOR   absolute path of bot_errors_j1_collector.py
# Optional:
#   BOT_ERRORS_J1_SLOT_MINUTE integer 0-59, default 17; MUST equal the plist's
#                             StartCalendarInterval Minute (the collector labels
#                             its bundle by this slot)
#   BOT_ERRORS_J1_PYTHON      interpreter (default: python3 on PATH, Homebrew first)
#   BOT_ERRORS_J1_ALERT_HOST, BOT_ERRORS_J1_CANARY_HOST, BOT_ERRORS_J1_CANARY_INSTANCE
#                             (collector defaults apply when unset)
#
# Exit codes: 78 (EX_CONFIG) for every configuration problem detected here;
# otherwise the collector's own exit status (the collector is exec'd).
#
# Install to: ~/.local/bin/bot-errors-j1-collector
# chmod +x after writing. The drift guard compares the installed copy
# byte-for-byte with this template.
set -u

ENV_FILE="$HOME/.config/whatsoup/bot-errors-j1-collector.env"

config_error() {
  echo "[$(date -u +%FT%TZ)] bot-errors-j1-collector: $1" >&2
  exit 78
}

[ -f "$ENV_FILE" ] && [ -r "$ENV_FILE" ] || config_error "missing or unreadable host config: $ENV_FILE"

# The env file is executed, not parsed: refuse one another user could have written.
case "$(uname -s)" in
  Darwin) env_owner="$(stat -f %u "$ENV_FILE")"; env_mode="$(stat -f %Lp "$ENV_FILE")" ;;
  *)      env_owner="$(stat -c %u "$ENV_FILE")"; env_mode="$(stat -c %a "$ENV_FILE")" ;;
esac
[ "$env_owner" = "$(id -u)" ] || config_error "host config not owned by the running user: $ENV_FILE"
case "$env_mode" in
  *[2367][0-9]|*[0-9][2367]) config_error "host config is group- or world-writable (mode $env_mode): $ENV_FILE" ;;
esac

set -a
# shellcheck disable=SC1090
. "$ENV_FILE" || config_error "host config failed to load: $ENV_FILE"
set +a

[ -n "${BOT_ERRORS_J1_ROOT:-}" ] || config_error "BOT_ERRORS_J1_ROOT unset or empty in $ENV_FILE"
[ -n "${BOT_ERRORS_J1_GROUP_JID:-}" ] || config_error "BOT_ERRORS_J1_GROUP_JID unset or empty in $ENV_FILE"
[ -n "${BOT_ERRORS_J1_COLLECTOR:-}" ] || config_error "BOT_ERRORS_J1_COLLECTOR unset or empty in $ENV_FILE"
[ -f "$BOT_ERRORS_J1_COLLECTOR" ] || config_error "collector script missing: $BOT_ERRORS_J1_COLLECTOR"
[ -d "$BOT_ERRORS_J1_ROOT" ] || config_error "loop root missing: $BOT_ERRORS_J1_ROOT"

SLOT_MINUTE="${BOT_ERRORS_J1_SLOT_MINUTE:-17}"
case "$SLOT_MINUTE" in
  [0-9]|[1-5][0-9]) : ;;
  *) config_error "BOT_ERRORS_J1_SLOT_MINUTE must be an integer 0-59, got: $SLOT_MINUTE" ;;
esac

# launchd starts with a minimal PATH; prefer the Homebrew interpreter (the
# system python3 may be older than the collector requires), keep ssh/sqlite3.
export PATH="/opt/homebrew/bin:/usr/local/bin:${PATH:-/usr/bin:/bin}:/usr/bin:/bin:/usr/sbin:/sbin"
PYTHON="${BOT_ERRORS_J1_PYTHON:-python3}"
command -v "$PYTHON" >/dev/null 2>&1 || config_error "interpreter not found on PATH: $PYTHON"

echo "[$(date -u +%FT%TZ)] bot-errors-j1-collector: start slot=$SLOT_MINUTE"
exec "$PYTHON" "$BOT_ERRORS_J1_COLLECTOR" --live --slot-minute "$SLOT_MINUTE"
