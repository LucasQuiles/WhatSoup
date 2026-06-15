#!/bin/bash
# Install the EXTERNAL (off-GUI) WhatSoup GUI-session monitor as an off-host
# timer on the central hub.
#
# Why off-host: the monitored bots are per-user macOS GUI LaunchAgents. When a
# bot user logs out of the GUI, the bot AND its in-GUI watchdog die together, so
# the outage is silent. This monitor must therefore run from a DIFFERENT host
# (the central hub) that stays up across the bot users' GUI sessions, reaching
# each bot host read-only over SSH.
#
# It is OS-aware so it matches whichever runtime the hub uses:
#   - Linux  hub (systemd): installs a user systemd .service + .timer pair,
#     mirroring deploy/bot-errors-collector.service / bot-errors-deadman.timer.
#   - macOS  hub (launchd): installs a LaunchAgent plist on a periodic interval,
#     mirroring deploy/scripts/install-bot-errors-health-launchd.sh.
#
# Safe to inspect: pass --dry-run to render the unit/plist to stdout WITHOUT
# writing any file or invoking systemctl/launchctl.
#
# This script does NOT mutate live bot hosts; it only schedules the read-only
# monitor on the hub it runs on.
set -euo pipefail

LABEL=${BOT_ERRORS_GUI_MONITOR_LABEL:-com.bot-errors.gui-session-monitor}
REPO_ROOT=${BOT_ERRORS_REPO_ROOT:-$HOME/LAB/WhatSoup}
PYTHON=${BOT_ERRORS_PYTHON:-/usr/bin/python3}
STATE_DIR=${BOT_ERRORS_STATE_DIR:-$HOME/.local/state/bot-errors}
ENV_FILE=${BOT_ERRORS_ENV_FILE:-$HOME/.config/whatsoup/bot-errors.env}
INTERVAL_SECONDS=${BOT_ERRORS_GUI_MONITOR_INTERVAL_SECONDS:-300}
MONITOR_SCRIPT="$REPO_ROOT/deploy/scripts/bot-errors-gui-session-monitor.py"

DRY_RUN=0
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=1
fi

if [[ ! -f "$MONITOR_SCRIPT" ]]; then
  echo "missing required monitor script: $MONITOR_SCRIPT" >&2
  exit 2
fi

render_systemd_service() {
  cat <<UNIT
[Unit]
Description=External off-GUI WhatSoup GUI-session monitor
After=network-online.target

[Service]
Type=oneshot
WorkingDirectory=$REPO_ROOT
EnvironmentFile=-$ENV_FILE
Environment=BOT_ERRORS_STATE_DIR=$STATE_DIR
ExecStart=$PYTHON $MONITOR_SCRIPT --once

[Install]
WantedBy=default.target
UNIT
}

render_systemd_timer() {
  cat <<UNIT
[Unit]
Description=Run the external WhatSoup GUI-session monitor periodically

[Timer]
OnActiveSec=2m
OnUnitActiveSec=${INTERVAL_SECONDS}s
AccuracySec=30s
Persistent=true
Unit=${LABEL}.service

[Install]
WantedBy=timers.target
UNIT
}

render_launchd_plist() {
  cat <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$PYTHON</string>
    <string>$MONITOR_SCRIPT</string>
    <string>--once</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>BOT_ERRORS_STATE_DIR</key><string>$STATE_DIR</string>
  </dict>
  <key>WorkingDirectory</key><string>$REPO_ROOT</string>
  <key>RunAtLoad</key><false/>
  <key>StartInterval</key><integer>$INTERVAL_SECONDS</integer>
  <key>StandardOutPath</key><string>$STATE_DIR/logs/gui-session-monitor.out.log</string>
  <key>StandardErrorPath</key><string>$STATE_DIR/logs/gui-session-monitor.err.log</string>
</dict>
</plist>
PLIST
}

install_systemd() {
  local unit_dir="$HOME/.config/systemd/user"
  if [[ "$DRY_RUN" == "1" ]]; then
    echo "# [dry-run] would write $unit_dir/${LABEL}.service"
    render_systemd_service
    echo "# [dry-run] would write $unit_dir/${LABEL}.timer"
    render_systemd_timer
    echo "# [dry-run] would run: systemctl --user daemon-reload && systemctl --user enable --now ${LABEL}.timer"
    return 0
  fi
  mkdir -p "$unit_dir" "$STATE_DIR/logs"
  chmod 700 "$STATE_DIR" "$STATE_DIR/logs" 2>/dev/null || true
  render_systemd_service > "$unit_dir/${LABEL}.service"
  render_systemd_timer > "$unit_dir/${LABEL}.timer"
  systemctl --user daemon-reload
  systemctl --user enable --now "${LABEL}.timer"
  echo "installed systemd timer ${LABEL}.timer interval=${INTERVAL_SECONDS}s"
}

install_launchd() {
  local launch_agents="$HOME/Library/LaunchAgents"
  local plist="$launch_agents/$LABEL.plist"
  local uid_value
  uid_value=$(id -u)
  if [[ "$DRY_RUN" == "1" ]]; then
    echo "# [dry-run] would write $plist"
    render_launchd_plist
    echo "# [dry-run] would run: launchctl bootstrap gui/$uid_value $plist && launchctl enable gui/$uid_value/$LABEL"
    return 0
  fi
  mkdir -p "$STATE_DIR/logs" "$launch_agents"
  chmod 700 "$STATE_DIR" "$STATE_DIR/logs" 2>/dev/null || true
  render_launchd_plist > "$plist"
  chmod 644 "$plist"
  plutil -lint "$plist" >/dev/null
  launchctl bootout "gui/$uid_value" "$plist" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/$uid_value" "$plist"
  launchctl enable "gui/$uid_value/$LABEL" >/dev/null 2>&1 || true
  echo "installed launchd agent $LABEL interval=${INTERVAL_SECONDS}s"
}

if command -v systemctl >/dev/null 2>&1; then
  install_systemd
elif [[ "$(uname -s)" == "Darwin" ]]; then
  install_launchd
else
  echo "no supported scheduler found (need systemd or macOS launchd)" >&2
  exit 2
fi
