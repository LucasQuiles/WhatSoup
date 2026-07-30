#!/usr/bin/env bash
# Install BOT ERRORS dispatcher, deadman, and health launchd agents on macOS.
set -euo pipefail

LABEL_PREFIX=${BOT_ERRORS_LABEL_PREFIX:-com.bot-errors}
REPO_ROOT=${BOT_ERRORS_REPO_ROOT:-$HOME/LAB/WhatSoup}
PYTHON=${BOT_ERRORS_PYTHON:-/usr/bin/python3}
STATE_DIR=${BOT_ERRORS_STATE_DIR:-$HOME/.local/state/bot-errors}
HEALTH_PROFILE=${BOT_ERRORS_HEALTH_PROFILE:-}
ENV_FILE=${BOT_ERRORS_ENV_FILE:-$HOME/.config/whatsoup/bot-errors.env}
LAUNCH_AGENTS=$HOME/Library/LaunchAgents
UID_VALUE=$(id -u)
DISPATCHER_SCRIPT="$REPO_ROOT/deploy/scripts/bot-errors-dispatcher.py"
HEALTH_SCRIPT="$REPO_ROOT/deploy/scripts/bot-errors-health-check.py"
RUNNER_SCRIPT="$REPO_ROOT/deploy/scripts/bot-errors-runner.py"

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

if [[ -z "$HEALTH_PROFILE" || ! -f "$HEALTH_PROFILE" || ! -r "$HEALTH_PROFILE" ]]; then
  echo "missing BOT_ERRORS_HEALTH_PROFILE; expected readable profile path" >&2
  exit 2
fi

validate_label BOT_ERRORS_LABEL_PREFIX "$LABEL_PREFIX"
LABEL_PREFIX_XML="$(xml_escape "$LABEL_PREFIX")"
REPO_ROOT_XML="$(xml_escape "$REPO_ROOT")"
PYTHON_XML="$(xml_escape "$PYTHON")"
STATE_DIR_XML="$(xml_escape "$STATE_DIR")"
HEALTH_PROFILE_XML="$(xml_escape "$HEALTH_PROFILE")"
DISPATCHER_SCRIPT_XML="$(xml_escape "$DISPATCHER_SCRIPT")"
HEALTH_SCRIPT_XML="$(xml_escape "$HEALTH_SCRIPT")"
RUNNER_SCRIPT_XML="$(xml_escape "$RUNNER_SCRIPT")"
BOT_ERRORS_JID_XML="$(xml_escape "$BOT_ERRORS_JID_VALUE")"
BOT_ERRORS_EXPECTED_JID_XML="$(xml_escape "$BOT_ERRORS_EXPECTED_JID_VALUE")"
BOT_ERRORS_SOCKET_PATH_XML="$(xml_escape "$BOT_ERRORS_SOCKET_PATH_VALUE")"
BOT_ERRORS_SOCKET_XML="$(xml_escape "$BOT_ERRORS_SOCKET_VALUE")"
BOT_ERRORS_DB_XML="$(xml_escape "$BOT_ERRORS_DB_VALUE")"

mkdir -p "$STATE_DIR/logs" "$LAUNCH_AGENTS"
chmod 700 "$STATE_DIR" "$STATE_DIR/logs" 2>/dev/null || true

for required in "$DISPATCHER_SCRIPT" "$HEALTH_SCRIPT" "$RUNNER_SCRIPT"; do
  if [[ ! -f "$required" ]]; then
    echo "missing required BOT ERRORS script: $required" >&2
    exit 2
  fi
done

write_plist(){
  local label="$1" path="$2" body="$3"
  printf "%s\n" "$body" > "$path"
  chmod 644 "$path"
  plutil -lint "$path" >/dev/null
  launchctl bootout "gui/$UID_VALUE" "$path" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/$UID_VALUE" "$path"
  launchctl enable "gui/$UID_VALUE/$label" >/dev/null 2>&1 || true
}

dispatcher_label="$LABEL_PREFIX.dispatcher"
deadman_label="$LABEL_PREFIX.deadman"
health_label="$LABEL_PREFIX.health"
dispatcher_label_xml="$LABEL_PREFIX_XML.dispatcher"
deadman_label_xml="$LABEL_PREFIX_XML.deadman"
health_label_xml="$LABEL_PREFIX_XML.health"

dispatcher_plist="$LAUNCH_AGENTS/$dispatcher_label.plist"
deadman_plist="$LAUNCH_AGENTS/$deadman_label.plist"
health_plist="$LAUNCH_AGENTS/$health_label.plist"

write_plist "$dispatcher_label" "$dispatcher_plist" "$(cat <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$dispatcher_label_xml</string>
  <key>ProgramArguments</key>
  <array>
    <string>$PYTHON_XML</string>
    <string>$DISPATCHER_SCRIPT_XML</string>
    <string>--daemon</string>
    <string>--interval</string>
    <string>30</string>
    <string>--max-events</string>
    <string>25</string>
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
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$STATE_DIR_XML/logs/dispatcher.out.log</string>
  <key>StandardErrorPath</key><string>$STATE_DIR_XML/logs/dispatcher.err.log</string>
</dict>
</plist>
PLIST
)"

write_plist "$deadman_label" "$deadman_plist" "$(cat <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$deadman_label_xml</string>
  <key>ProgramArguments</key>
  <array>
    <string>$PYTHON_XML</string>
    <string>$HEALTH_SCRIPT_XML</string>
    <string>--deadman</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>BOT_ERRORS_STATE_DIR</key><string>$STATE_DIR_XML</string>
    <key>BOT_ERRORS_JID</key><string>$BOT_ERRORS_JID_XML</string>
    <key>BOT_ERRORS_EXPECTED_JID</key><string>$BOT_ERRORS_EXPECTED_JID_XML</string>
    <key>BOT_ERRORS_SOCKET_PATH</key><string>$BOT_ERRORS_SOCKET_PATH_XML</string>
    <key>BOT_ERRORS_SOCKET</key><string>$BOT_ERRORS_SOCKET_XML</string>
    <key>BOT_ERRORS_DB</key><string>$BOT_ERRORS_DB_XML</string>
    <key>BOT_ERRORS_DISPATCHER_SERVICE</key><string>$dispatcher_label_xml</string>
    <key>BOT_ERRORS_HEALTH_PROFILE</key><string>$HEALTH_PROFILE_XML</string>
  </dict>
  <key>WorkingDirectory</key><string>$REPO_ROOT_XML</string>
  <key>RunAtLoad</key><true/>
  <key>StartInterval</key><integer>300</integer>
  <key>StandardOutPath</key><string>$STATE_DIR_XML/logs/deadman.out.log</string>
  <key>StandardErrorPath</key><string>$STATE_DIR_XML/logs/deadman.err.log</string>
</dict>
</plist>
PLIST
)"

write_plist "$health_label" "$health_plist" "$(cat <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$health_label_xml</string>
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
    <string>launchd_label=$health_label_xml</string>
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
    <key>BOT_ERRORS_DISPATCHER_SERVICE</key><string>$dispatcher_label_xml</string>
    <key>BOT_ERRORS_HEALTH_PROFILE</key><string>$HEALTH_PROFILE_XML</string>
  </dict>
  <key>WorkingDirectory</key><string>$REPO_ROOT_XML</string>
  <key>RunAtLoad</key><false/>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key><integer>7</integer>
    <key>Minute</key><integer>20</integer>
  </dict>
  <key>StandardOutPath</key><string>$STATE_DIR_XML/logs/health.out.log</string>
  <key>StandardErrorPath</key><string>$STATE_DIR_XML/logs/health.err.log</string>
</dict>
</plist>
PLIST
)"

launchctl kickstart -k "gui/$UID_VALUE/$dispatcher_label" >/dev/null 2>&1 || true
launchctl kickstart -k "gui/$UID_VALUE/$deadman_label" >/dev/null 2>&1 || true

echo "installed $dispatcher_label $deadman_label $health_label"
