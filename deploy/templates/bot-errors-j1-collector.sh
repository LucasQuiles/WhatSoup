#!/usr/bin/env bash
# bot-errors-j1-collector.sh — launchd wrapper for the hourly BOT ERRORS J1 collector.
#
# Reads host-specific values from ~/.config/whatsoup/bot-errors-j1-collector.env
# (untracked; never committed) and runs the collector read-only over ssh.
# The collector itself never publishes a checkpoint, takes a lease, or appends
# the ledger; it only writes runs/<run>/collect/ bundles under the loop root.
#
# The env file is PARSED, never executed: only `KEY=value` lines (KEY in
# [A-Z][A-Z0-9_]*), blank lines and `#` comments are accepted; values are taken
# literally (no quotes, no expansion). It must be a regular file owned by the
# running user with mode 600 or 400.
#
# Required keys:
#   BOT_ERRORS_J1_ROOT        loop root (checkpoint/, runs/)
#   BOT_ERRORS_J1_GROUP_JID   alert group chat jid
#   BOT_ERRORS_J1_COLLECTOR   absolute path of bot_errors_j1_collector.py
# Optional keys:
#   BOT_ERRORS_J1_COLLECTOR_SHA256  expected sha256 of the collector file; when set,
#                             a mismatch is a configuration error (pins what runs)
#   BOT_ERRORS_J1_SLOT_MINUTE integer 0-59, default 17; MUST equal the plist's
#                             StartCalendarInterval Minute (the collector labels
#                             its bundle by this slot; the drift guard cross-checks
#                             the plist against this file's default)
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

# launchd starts with a minimal PATH; prefer the Homebrew interpreter (the
# system python3 may be older than the collector requires), keep ssh/sqlite3.
export PATH="/opt/homebrew/bin:/usr/local/bin:${PATH:-/usr/bin:/bin}:/usr/bin:/bin:/usr/sbin:/sbin"
PYTHON="${BOT_ERRORS_J1_PYTHON:-python3}"
command -v "$PYTHON" >/dev/null 2>&1 || config_error "interpreter not found on PATH: $PYTHON"

[ -f "$ENV_FILE" ] && [ -r "$ENV_FILE" ] || config_error "missing or unreadable host config: $ENV_FILE"

# Ownership and mode via the interpreter (portable across BSD and GNU stat).
env_owner=""; env_mode=""
read -r env_owner env_mode <<EOF
$("$PYTHON" -c 'import os, stat, sys; st = os.stat(sys.argv[1]); print(st.st_uid, oct(stat.S_IMODE(st.st_mode))[2:])' "$ENV_FILE")
EOF
[ "$env_owner" = "$(id -u)" ] || config_error "host config not owned by the running user: $ENV_FILE"
case "$env_mode" in
  600|400) : ;;
  *) config_error "host config must be mode 600 or 400 (got $env_mode): $ENV_FILE" ;;
esac

# Parse, do not source: a line that is not KEY=value is a configuration error.
line_no=0
while IFS= read -r line || [ -n "$line" ]; do
  line_no=$((line_no + 1))
  case "$line" in
    ''|'#'*) continue ;;
  esac
  case "$line" in
    [A-Z]*=*)
      key="${line%%=*}"
      value="${line#*=}"
      case "$key" in
        *[!A-Z0-9_]*) config_error "invalid key at line $line_no of $ENV_FILE" ;;
      esac
      export "$key=$value" ;;
    *) config_error "unparseable line $line_no in $ENV_FILE (KEY=value lines only; no quotes, no expansion)" ;;
  esac
done < "$ENV_FILE"

[ -n "${BOT_ERRORS_J1_ROOT:-}" ] || config_error "BOT_ERRORS_J1_ROOT unset or empty in $ENV_FILE"
[ -n "${BOT_ERRORS_J1_GROUP_JID:-}" ] || config_error "BOT_ERRORS_J1_GROUP_JID unset or empty in $ENV_FILE"
[ -n "${BOT_ERRORS_J1_COLLECTOR:-}" ] || config_error "BOT_ERRORS_J1_COLLECTOR unset or empty in $ENV_FILE"
[ -f "$BOT_ERRORS_J1_COLLECTOR" ] || config_error "collector script missing: $BOT_ERRORS_J1_COLLECTOR"
[ -d "$BOT_ERRORS_J1_ROOT" ] || config_error "loop root missing: $BOT_ERRORS_J1_ROOT"

if [ -n "${BOT_ERRORS_J1_COLLECTOR_SHA256:-}" ]; then
  actual_sha="$("$PYTHON" -c 'import hashlib, sys; print(hashlib.sha256(open(sys.argv[1], "rb").read()).hexdigest())' "$BOT_ERRORS_J1_COLLECTOR")"
  [ "$actual_sha" = "$BOT_ERRORS_J1_COLLECTOR_SHA256" ] || config_error "collector sha256 mismatch for $BOT_ERRORS_J1_COLLECTOR"
fi

SLOT_MINUTE="${BOT_ERRORS_J1_SLOT_MINUTE:-17}"
case "$SLOT_MINUTE" in
  [0-9]|[1-5][0-9]) : ;;
  *) config_error "BOT_ERRORS_J1_SLOT_MINUTE must be an integer 0-59, got: $SLOT_MINUTE" ;;
esac

echo "[$(date -u +%FT%TZ)] bot-errors-j1-collector: start slot=$SLOT_MINUTE"
exec "$PYTHON" "$BOT_ERRORS_J1_COLLECTOR" --live --slot-minute "$SLOT_MINUTE"
