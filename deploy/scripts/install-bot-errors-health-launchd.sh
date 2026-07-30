#!/usr/bin/env bash
# Install only the BOT ERRORS daily health launchd agent on macOS relay/bot hosts.
set -euo pipefail

LABEL=${BOT_ERRORS_HEALTH_LABEL:-com.bot-errors.health}
REPO_ROOT=${BOT_ERRORS_REPO_ROOT:-$HOME/LAB/WhatSoup}
PYTHON=${BOT_ERRORS_PYTHON:-/usr/bin/python3}
STATE_DIR=${BOT_ERRORS_STATE_DIR:-$HOME/.local/state/bot-errors}
HEALTH_PROFILE=${BOT_ERRORS_HEALTH_PROFILE:-}
ENV_FILE=${BOT_ERRORS_ENV_FILE:-$HOME/.config/whatsoup/bot-errors.env}
HEALTH_HOUR=${BOT_ERRORS_HEALTH_HOUR:-7}
HEALTH_MINUTE=${BOT_ERRORS_HEALTH_MINUTE:-20}
LAUNCH_AGENTS=$HOME/Library/LaunchAgents
UID_VALUE=$(id -u)
RUNNER_SCRIPT="$REPO_ROOT/deploy/scripts/bot-errors-runner.py"
HEALTH_SCRIPT="$REPO_ROOT/deploy/scripts/bot-errors-health-check.py"

read_env_value(){
  local key="$1"
  [[ -f "$ENV_FILE" ]] || return 0
  awk -v key="$key" '
    /^[[:space:]]*#/ { next }
    index($0, key "=") == 1 { value=substr($0, length(key) + 2); found=1 }
    END { if (found) printf "%s", value }
  ' "$ENV_FILE"
}

env_or_default(){
  local key="$1" fallback="$2" current file_value
  current="${!key:-}"
  if [[ -n "$current" ]]; then
    printf "%s" "$current"
    return 0
  fi
  file_value="$(read_env_value "$key")"
  if [[ -n "$file_value" ]]; then
    printf "%s" "$file_value"
  else
    printf "%s" "$fallback"
  fi
}

xml_escape(){
  local value="$1"
  value=${value//&/\&amp;}
  value=${value//</\&lt;}
  value=${value//>/\&gt;}
  value=${value//\"/\&quot;}
  value=${value//"'"/\&apos;}
  printf "%s" "$value"
}

validate_calendar_integer(){
  local name="$1" value="$2" min="$3" max="$4"
  if [[ ! "$value" =~ ^[0-9]+$ ]]; then
    echo "invalid $name; expected integer $min..$max" >&2
    exit 2
  fi
  local numeric=$((10#$value))
  if (( numeric < min || numeric > max )); then
    echo "invalid $name; expected integer $min..$max" >&2
    exit 2
  fi
}

validate_label(){
  local name="$1" value="$2"
  if [[ ! "$value" =~ ^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?$ ]]; then
    echo "invalid $name: label must match ^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?\\$  (no '/', '..', whitespace or shell metacharacters)" >&2
    exit 2
  fi
}

if [[ -z "$HEALTH_PROFILE" ]]; then
  host_profile=$(hostname -s | tr '[:upper:]' '[:lower:]')
  if [[ -f "$REPO_ROOT/deploy/health-profiles/$host_profile.json" ]]; then
    HEALTH_PROFILE="$REPO_ROOT/deploy/health-profiles/$host_profile.json"
  fi
fi
HEALTH_PROFILE="$(env_or_default BOT_ERRORS_HEALTH_PROFILE "$HEALTH_PROFILE")"
BOT_ERRORS_JID_VALUE="$(env_or_default BOT_ERRORS_JID "")"
BOT_ERRORS_EXPECTED_JID_VALUE="$(env_or_default BOT_ERRORS_EXPECTED_JID "$BOT_ERRORS_JID_VALUE")"
BOT_ERRORS_SOCKET_PATH_VALUE="$(env_or_default BOT_ERRORS_SOCKET_PATH "")"
BOT_ERRORS_SOCKET_VALUE="$(env_or_default BOT_ERRORS_SOCKET "")"
if [[ -z "$BOT_ERRORS_SOCKET_PATH_VALUE" && -n "$BOT_ERRORS_SOCKET_VALUE" ]]; then
  BOT_ERRORS_SOCKET_PATH_VALUE="$BOT_ERRORS_SOCKET_VALUE"
elif [[ -z "$BOT_ERRORS_SOCKET_VALUE" && -n "$BOT_ERRORS_SOCKET_PATH_VALUE" ]]; then
  BOT_ERRORS_SOCKET_VALUE="$BOT_ERRORS_SOCKET_PATH_VALUE"
fi
BOT_ERRORS_DB_VALUE="$(env_or_default BOT_ERRORS_DB "")"
validate_label BOT_ERRORS_HEALTH_LABEL "$LABEL"
validate_calendar_integer BOT_ERRORS_HEALTH_HOUR "$HEALTH_HOUR" 0 23
validate_calendar_integer BOT_ERRORS_HEALTH_MINUTE "$HEALTH_MINUTE" 0 59
LABEL_XML="$(xml_escape "$LABEL")"
REPO_ROOT_XML="$(xml_escape "$REPO_ROOT")"
PYTHON_XML="$(xml_escape "$PYTHON")"
STATE_DIR_XML="$(xml_escape "$STATE_DIR")"
HEALTH_PROFILE_XML="$(xml_escape "$HEALTH_PROFILE")"
RUNNER_SCRIPT_XML="$(xml_escape "$RUNNER_SCRIPT")"
HEALTH_SCRIPT_XML="$(xml_escape "$HEALTH_SCRIPT")"
BOT_ERRORS_JID_XML="$(xml_escape "$BOT_ERRORS_JID_VALUE")"
BOT_ERRORS_EXPECTED_JID_XML="$(xml_escape "$BOT_ERRORS_EXPECTED_JID_VALUE")"
BOT_ERRORS_SOCKET_PATH_XML="$(xml_escape "$BOT_ERRORS_SOCKET_PATH_VALUE")"
BOT_ERRORS_SOCKET_XML="$(xml_escape "$BOT_ERRORS_SOCKET_VALUE")"
BOT_ERRORS_DB_XML="$(xml_escape "$BOT_ERRORS_DB_VALUE")"

if [[ -z "$HEALTH_PROFILE" || ! -f "$HEALTH_PROFILE" || ! -r "$HEALTH_PROFILE" ]]; then
  echo "missing BOT_ERRORS_HEALTH_PROFILE; expected readable profile path" >&2
  exit 2
fi

for required in "$RUNNER_SCRIPT" "$HEALTH_SCRIPT"; do
  if [[ ! -f "$required" ]]; then
    echo "missing required BOT ERRORS script: $required" >&2
    exit 2
  fi
done

mkdir -p "$STATE_DIR/logs" "$LAUNCH_AGENTS"
chmod 700 "$STATE_DIR" "$STATE_DIR/logs" 2>/dev/null || true

plist="$LAUNCH_AGENTS/$LABEL.plist"
cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL_XML</string>
  <key>ProgramArguments</key>
  <array>
    <string>$PYTHON_XML</string>
    <string>$RUNNER_SCRIPT_XML</string>
    <string>--instance</string>
    <string>bot-errors-health</string>
    <string>--source</string>
    <string>service-exit</string>
    <string>--summary</string>
    <string>BOT ERRORS daily health command failed</string>
    <string>--log-hint</string>
    <string>$STATE_DIR_XML/logs/health.err.log</string>
    <string>--diagnostic</string>
    <string>launchd_label=$LABEL_XML</string>
    <string>--</string>
    <string>$PYTHON_XML</string>
    <string>$HEALTH_SCRIPT_XML</string>
    <string>--daily</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>BOT_ERRORS_STATE_DIR</key><string>$STATE_DIR_XML</string>
    <key>BOT_ERRORS_JID</key><string>$BOT_ERRORS_JID_XML</string>
    <key>BOT_ERRORS_EXPECTED_JID</key><string>$BOT_ERRORS_EXPECTED_JID_XML</string>
    <key>BOT_ERRORS_SOCKET_PATH</key><string>$BOT_ERRORS_SOCKET_PATH_XML</string>
    <key>BOT_ERRORS_SOCKET</key><string>$BOT_ERRORS_SOCKET_XML</string>
    <key>BOT_ERRORS_DB</key><string>$BOT_ERRORS_DB_XML</string>
    <key>BOT_ERRORS_HEALTH_PROFILE</key><string>$HEALTH_PROFILE_XML</string>
  </dict>
  <key>WorkingDirectory</key><string>$REPO_ROOT_XML</string>
  <key>RunAtLoad</key><false/>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key><integer>$HEALTH_HOUR</integer>
    <key>Minute</key><integer>$HEALTH_MINUTE</integer>
  </dict>
  <key>StandardOutPath</key><string>$STATE_DIR_XML/logs/health.out.log</string>
  <key>StandardErrorPath</key><string>$STATE_DIR_XML/logs/health.err.log</string>
</dict>
</plist>
PLIST

chmod 644 "$plist"
plutil -lint "$plist" >/dev/null
launchctl bootout "gui/$UID_VALUE" "$plist" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$UID_VALUE" "$plist"
launchctl enable "gui/$UID_VALUE/$LABEL" >/dev/null 2>&1 || true

echo "installed $LABEL profile=$HEALTH_PROFILE schedule=${HEALTH_HOUR}:${HEALTH_MINUTE}"
