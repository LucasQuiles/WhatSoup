#!/bin/bash
# Install BOT ERRORS dispatcher, deadman, and health launchd agents on macOS.
set -euo pipefail

LABEL_PREFIX=${BOT_ERRORS_LABEL_PREFIX:-com.bot-errors}
REPO_ROOT=${BOT_ERRORS_REPO_ROOT:-$HOME/LAB/WhatSoup}
PYTHON=${BOT_ERRORS_PYTHON:-/usr/bin/python3}
STATE_DIR=${BOT_ERRORS_STATE_DIR:-$HOME/.local/state/bot-errors}
HEALTH_PROFILE=${BOT_ERRORS_HEALTH_PROFILE:-}
LAUNCH_AGENTS=$HOME/Library/LaunchAgents
UID_VALUE=$(id -u)
DISPATCHER_SCRIPT="$REPO_ROOT/deploy/scripts/bot-errors-dispatcher.py"
HEALTH_SCRIPT="$REPO_ROOT/deploy/scripts/bot-errors-health-check.py"
RUNNER_SCRIPT="$REPO_ROOT/deploy/scripts/bot-errors-runner.py"

if [[ -z "$HEALTH_PROFILE" ]]; then
  host_profile=$(hostname -s | tr '[:upper:]' '[:lower:]')
  if [[ -f "$REPO_ROOT/deploy/health-profiles/$host_profile.json" ]]; then
    HEALTH_PROFILE="$REPO_ROOT/deploy/health-profiles/$host_profile.json"
  fi
fi

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

dispatcher_plist="$LAUNCH_AGENTS/$dispatcher_label.plist"
deadman_plist="$LAUNCH_AGENTS/$deadman_label.plist"
health_plist="$LAUNCH_AGENTS/$health_label.plist"

write_plist "$dispatcher_label" "$dispatcher_plist" "$(cat <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$dispatcher_label</string>
  <key>ProgramArguments</key>
  <array>
    <string>$PYTHON</string>
    <string>$DISPATCHER_SCRIPT</string>
    <string>--daemon</string>
    <string>--interval</string>
    <string>30</string>
    <string>--max-events</string>
    <string>25</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>BOT_ERRORS_STATE_DIR</key><string>$STATE_DIR</string>
  </dict>
  <key>WorkingDirectory</key><string>$REPO_ROOT</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$STATE_DIR/logs/dispatcher.out.log</string>
  <key>StandardErrorPath</key><string>$STATE_DIR/logs/dispatcher.err.log</string>
</dict>
</plist>
PLIST
)"

write_plist "$deadman_label" "$deadman_plist" "$(cat <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$deadman_label</string>
  <key>ProgramArguments</key>
  <array>
    <string>$PYTHON</string>
    <string>$HEALTH_SCRIPT</string>
    <string>--deadman</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>BOT_ERRORS_STATE_DIR</key><string>$STATE_DIR</string>
    <key>BOT_ERRORS_DISPATCHER_SERVICE</key><string>$dispatcher_label</string>
    <key>BOT_ERRORS_HEALTH_PROFILE</key><string>$HEALTH_PROFILE</string>
  </dict>
  <key>WorkingDirectory</key><string>$REPO_ROOT</string>
  <key>RunAtLoad</key><true/>
  <key>StartInterval</key><integer>300</integer>
  <key>StandardOutPath</key><string>$STATE_DIR/logs/deadman.out.log</string>
  <key>StandardErrorPath</key><string>$STATE_DIR/logs/deadman.err.log</string>
</dict>
</plist>
PLIST
)"

write_plist "$health_label" "$health_plist" "$(cat <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$health_label</string>
  <key>ProgramArguments</key>
  <array>
    <string>$PYTHON</string>
    <string>$RUNNER_SCRIPT</string>
    <string>--instance</string>
    <string>bot-errors-health</string>
    <string>--source</string>
    <string>service-exit</string>
    <string>--summary</string>
    <string>BOT ERRORS daily health command failed</string>
    <string>--log-hint</string>
    <string>$STATE_DIR/logs/health.err.log</string>
    <string>--diagnostic</string>
    <string>launchd_label=$health_label</string>
    <string>--</string>
    <string>$PYTHON</string>
    <string>$HEALTH_SCRIPT</string>
    <string>--daily</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>BOT_ERRORS_STATE_DIR</key><string>$STATE_DIR</string>
    <key>BOT_ERRORS_DISPATCHER_SERVICE</key><string>$dispatcher_label</string>
    <key>BOT_ERRORS_HEALTH_PROFILE</key><string>$HEALTH_PROFILE</string>
  </dict>
  <key>WorkingDirectory</key><string>$REPO_ROOT</string>
  <key>RunAtLoad</key><false/>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key><integer>7</integer>
    <key>Minute</key><integer>20</integer>
  </dict>
  <key>StandardOutPath</key><string>$STATE_DIR/logs/health.out.log</string>
  <key>StandardErrorPath</key><string>$STATE_DIR/logs/health.err.log</string>
</dict>
</plist>
PLIST
)"

launchctl kickstart -k "gui/$UID_VALUE/$dispatcher_label" >/dev/null 2>&1 || true
launchctl kickstart -k "gui/$UID_VALUE/$deadman_label" >/dev/null 2>&1 || true

echo "installed $dispatcher_label $deadman_label $health_label"
