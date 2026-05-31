#!/bin/bash
# Install only the BOT ERRORS daily health launchd agent on macOS relay/bot hosts.
set -euo pipefail

LABEL=${BOT_ERRORS_HEALTH_LABEL:-com.bot-errors.health}
REPO_ROOT=${BOT_ERRORS_REPO_ROOT:-$HOME/LAB/WhatSoup}
PYTHON=${BOT_ERRORS_PYTHON:-/usr/bin/python3}
STATE_DIR=${BOT_ERRORS_STATE_DIR:-$HOME/.local/state/bot-errors}
HEALTH_PROFILE=${BOT_ERRORS_HEALTH_PROFILE:-}
HEALTH_HOUR=${BOT_ERRORS_HEALTH_HOUR:-7}
HEALTH_MINUTE=${BOT_ERRORS_HEALTH_MINUTE:-20}
LAUNCH_AGENTS=$HOME/Library/LaunchAgents
UID_VALUE=$(id -u)

if [[ -z "$HEALTH_PROFILE" ]]; then
  host_profile=$(hostname -s | tr '[:upper:]' '[:lower:]')
  if [[ -f "$REPO_ROOT/deploy/health-profiles/$host_profile.json" ]]; then
    HEALTH_PROFILE="$REPO_ROOT/deploy/health-profiles/$host_profile.json"
  fi
fi

if [[ -z "$HEALTH_PROFILE" || ! -f "$HEALTH_PROFILE" ]]; then
  echo "missing BOT_ERRORS_HEALTH_PROFILE; expected readable profile path" >&2
  exit 2
fi

mkdir -p "$STATE_DIR/logs" "$LAUNCH_AGENTS"
chmod 700 "$STATE_DIR" "$STATE_DIR/logs" 2>/dev/null || true

plist="$LAUNCH_AGENTS/$LABEL.plist"
cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$PYTHON</string>
    <string>$REPO_ROOT/deploy/scripts/bot-errors-runner.py</string>
    <string>--instance</string>
    <string>bot-errors-health</string>
    <string>--source</string>
    <string>service-exit</string>
    <string>--summary</string>
    <string>BOT ERRORS daily health command failed</string>
    <string>--log-hint</string>
    <string>$STATE_DIR/logs/health.err.log</string>
    <string>--diagnostic</string>
    <string>launchd_label=$LABEL</string>
    <string>--</string>
    <string>$PYTHON</string>
    <string>$REPO_ROOT/deploy/scripts/bot-errors-health-check.py</string>
    <string>--daily</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>BOT_ERRORS_STATE_DIR</key><string>$STATE_DIR</string>
    <key>BOT_ERRORS_HEALTH_PROFILE</key><string>$HEALTH_PROFILE</string>
  </dict>
  <key>WorkingDirectory</key><string>$REPO_ROOT</string>
  <key>RunAtLoad</key><false/>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key><integer>$HEALTH_HOUR</integer>
    <key>Minute</key><integer>$HEALTH_MINUTE</integer>
  </dict>
  <key>StandardOutPath</key><string>$STATE_DIR/logs/health.out.log</string>
  <key>StandardErrorPath</key><string>$STATE_DIR/logs/health.err.log</string>
</dict>
</plist>
PLIST

chmod 644 "$plist"
plutil -lint "$plist" >/dev/null
launchctl bootout "gui/$UID_VALUE" "$plist" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$UID_VALUE" "$plist"
launchctl enable "gui/$UID_VALUE/$LABEL" >/dev/null 2>&1 || true

echo "installed $LABEL profile=$HEALTH_PROFILE schedule=${HEALTH_HOUR}:${HEALTH_MINUTE}"
