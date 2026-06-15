#!/usr/bin/env bash
# Install the BOT ERRORS Fleet Sentinel central evaluator schedule.
#
# Exit codes:
#   0 installed or rendered successfully
#   2 configuration or platform prerequisites are missing
set -euo pipefail

LABEL=${BOT_ERRORS_FLEET_SENTINEL_LABEL:-com.bot-errors.sentinel}
UNIT=${BOT_ERRORS_FLEET_SENTINEL_UNIT:-bot-errors-sentinel}
REPO_ROOT=${BOT_ERRORS_REPO_ROOT:-$HOME/LAB/WhatSoup}
PYTHON=${BOT_ERRORS_PYTHON:-/usr/bin/python3}
STATE_DIR=${BOT_ERRORS_STATE_DIR:-$HOME/.local/state/bot-errors}
SENTINEL_STATE_DIR=${BOT_ERRORS_FLEET_SENTINEL_STATE_DIR:-$STATE_DIR/fleet-sentinel}
HOSTS_PATH=${BOT_ERRORS_FLEET_SENTINEL_HOSTS:-$SENTINEL_STATE_DIR/hosts.json}
ORACLE_PATH=${BOT_ERRORS_FLEET_SENTINEL_ORACLE:-}
INTERVAL_SECONDS=${BOT_ERRORS_FLEET_SENTINEL_INTERVAL_SECONDS:-1800}
PLATFORM=${BOT_ERRORS_FLEET_SENTINEL_PLATFORM:-auto}
DRY_RUN=${BOT_ERRORS_FLEET_SENTINEL_INSTALL_DRY_RUN:-0}
LAUNCH_AGENTS=${BOT_ERRORS_LAUNCH_AGENTS_DIR:-$HOME/Library/LaunchAgents}
SYSTEMD_USER_DIR=${BOT_ERRORS_SYSTEMD_USER_DIR:-$HOME/.config/systemd/user}
SENTINEL_SCRIPT="$REPO_ROOT/deploy/scripts/bot-errors-sentinel.py"

fail_config() {
  echo "NOT READY: $*" >&2
  exit 2
}

xml_escape() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' -e 's/"/\&quot;/g'
}

systemd_quote() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

require_file() {
  local path="$1" label="$2"
  [[ -f "$path" ]] || fail_config "missing required $label: $path"
}

require_interval() {
  [[ "$INTERVAL_SECONDS" =~ ^[0-9]+$ ]] || fail_config "BOT_ERRORS_FLEET_SENTINEL_INTERVAL_SECONDS must be numeric"
  (( INTERVAL_SECONDS >= 300 )) || fail_config "BOT_ERRORS_FLEET_SENTINEL_INTERVAL_SECONDS must be at least 300"
}

resolve_platform() {
  if [[ "$PLATFORM" != "auto" ]]; then
    printf '%s\n' "$PLATFORM"
    return
  fi
  case "$(uname -s)" in
    Darwin) printf '%s\n' "launchd" ;;
    Linux) printf '%s\n' "systemd" ;;
    *) fail_config "unsupported platform for auto sentinel installer: $(uname -s)" ;;
  esac
}

write_launchd() {
  local plist="$LAUNCH_AGENTS/$LABEL.plist"
  local label_xml repo_xml py_xml script_xml state_xml sentinel_xml hosts_xml oracle_xml heartbeat_xml hysteresis_xml flap_window_xml flap_threshold_xml max_tier1_xml correlated_xml stdout_xml stderr_xml
  label_xml=$(xml_escape "$LABEL")
  repo_xml=$(xml_escape "$REPO_ROOT")
  py_xml=$(xml_escape "$PYTHON")
  script_xml=$(xml_escape "$SENTINEL_SCRIPT")
  state_xml=$(xml_escape "$STATE_DIR")
  sentinel_xml=$(xml_escape "$SENTINEL_STATE_DIR")
  hosts_xml=$(xml_escape "$HOSTS_PATH")
  oracle_xml=$(xml_escape "$ORACLE_PATH")
  heartbeat_xml=$(xml_escape "${BOT_ERRORS_FLEET_SENTINEL_HEARTBEAT_MAX_AGE_SECONDS:-2700}")
  hysteresis_xml=$(xml_escape "${BOT_ERRORS_FLEET_SENTINEL_HYSTERESIS_CYCLES:-2}")
  flap_window_xml=$(xml_escape "${BOT_ERRORS_FLEET_SENTINEL_FLAP_WINDOW_SECONDS:-21600}")
  flap_threshold_xml=$(xml_escape "${BOT_ERRORS_FLEET_SENTINEL_FLAP_THRESHOLD:-4}")
  max_tier1_xml=$(xml_escape "${BOT_ERRORS_FLEET_SENTINEL_MAX_TIER1_HEAL_CANDIDATES:-2}")
  correlated_xml=$(xml_escape "${BOT_ERRORS_FLEET_SENTINEL_CORRELATED_DRIFT_FREEZE_THRESHOLD:-2}")
  stdout_xml=$(xml_escape "$STATE_DIR/logs/sentinel.out.log")
  stderr_xml=$(xml_escape "$STATE_DIR/logs/sentinel.err.log")

  mkdir -p "$LAUNCH_AGENTS" "$STATE_DIR/logs" "$SENTINEL_STATE_DIR"
  chmod 700 "$STATE_DIR" "$STATE_DIR/logs" "$SENTINEL_STATE_DIR" 2>/dev/null || true
  cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label_xml</string>
  <key>ProgramArguments</key>
  <array>
    <string>$py_xml</string>
    <string>$script_xml</string>
    <string>--hosts</string>
    <string>$hosts_xml</string>
    <string>--state-dir</string>
    <string>$sentinel_xml</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>BOT_ERRORS_STATE_DIR</key><string>$state_xml</string>
    <key>BOT_ERRORS_FLEET_SENTINEL_STATE_DIR</key><string>$sentinel_xml</string>
    <key>BOT_ERRORS_FLEET_SENTINEL_HOSTS</key><string>$hosts_xml</string>
    <key>BOT_ERRORS_FLEET_SENTINEL_ORACLE</key><string>$oracle_xml</string>
    <key>BOT_ERRORS_FLEET_SENTINEL_HEARTBEAT_MAX_AGE_SECONDS</key><string>$heartbeat_xml</string>
    <key>BOT_ERRORS_FLEET_SENTINEL_HYSTERESIS_CYCLES</key><string>$hysteresis_xml</string>
    <key>BOT_ERRORS_FLEET_SENTINEL_FLAP_WINDOW_SECONDS</key><string>$flap_window_xml</string>
    <key>BOT_ERRORS_FLEET_SENTINEL_FLAP_THRESHOLD</key><string>$flap_threshold_xml</string>
    <key>BOT_ERRORS_FLEET_SENTINEL_MAX_TIER1_HEAL_CANDIDATES</key><string>$max_tier1_xml</string>
    <key>BOT_ERRORS_FLEET_SENTINEL_CORRELATED_DRIFT_FREEZE_THRESHOLD</key><string>$correlated_xml</string>
  </dict>
  <key>WorkingDirectory</key><string>$repo_xml</string>
  <key>RunAtLoad</key><true/>
  <key>StartInterval</key><integer>$INTERVAL_SECONDS</integer>
  <key>StandardOutPath</key><string>$stdout_xml</string>
  <key>StandardErrorPath</key><string>$stderr_xml</string>
</dict>
</plist>
PLIST
  chmod 644 "$plist"
  if [[ "$DRY_RUN" != "1" ]]; then
    command -v plutil >/dev/null 2>&1 || fail_config "plutil unavailable"
    command -v launchctl >/dev/null 2>&1 || fail_config "launchctl unavailable"
    plutil -lint "$plist" >/dev/null
    local uid_value
    uid_value=$(id -u)
    launchctl bootout "gui/$uid_value" "$plist" >/dev/null 2>&1 || true
    launchctl bootstrap "gui/$uid_value" "$plist"
    launchctl enable "gui/$uid_value/$LABEL" >/dev/null 2>&1 || true
  fi
  echo "installed $LABEL platform=launchd dry_run=$DRY_RUN interval=${INTERVAL_SECONDS}s path=$plist"
}

write_systemd() {
  local service="$SYSTEMD_USER_DIR/$UNIT.service"
  local timer="$SYSTEMD_USER_DIR/$UNIT.timer"
  local repo_q py_q script_q state_q sentinel_q hosts_q oracle_q heartbeat_q hysteresis_q flap_window_q flap_threshold_q max_tier1_q correlated_q
  repo_q=$(systemd_quote "$REPO_ROOT")
  py_q=$(systemd_quote "$PYTHON")
  script_q=$(systemd_quote "$SENTINEL_SCRIPT")
  state_q=$(systemd_quote "$STATE_DIR")
  sentinel_q=$(systemd_quote "$SENTINEL_STATE_DIR")
  hosts_q=$(systemd_quote "$HOSTS_PATH")
  oracle_q=$(systemd_quote "$ORACLE_PATH")
  heartbeat_q=$(systemd_quote "${BOT_ERRORS_FLEET_SENTINEL_HEARTBEAT_MAX_AGE_SECONDS:-2700}")
  hysteresis_q=$(systemd_quote "${BOT_ERRORS_FLEET_SENTINEL_HYSTERESIS_CYCLES:-2}")
  flap_window_q=$(systemd_quote "${BOT_ERRORS_FLEET_SENTINEL_FLAP_WINDOW_SECONDS:-21600}")
  flap_threshold_q=$(systemd_quote "${BOT_ERRORS_FLEET_SENTINEL_FLAP_THRESHOLD:-4}")
  max_tier1_q=$(systemd_quote "${BOT_ERRORS_FLEET_SENTINEL_MAX_TIER1_HEAL_CANDIDATES:-2}")
  correlated_q=$(systemd_quote "${BOT_ERRORS_FLEET_SENTINEL_CORRELATED_DRIFT_FREEZE_THRESHOLD:-2}")

  mkdir -p "$SYSTEMD_USER_DIR" "$STATE_DIR/logs" "$SENTINEL_STATE_DIR"
  chmod 700 "$STATE_DIR" "$STATE_DIR/logs" "$SENTINEL_STATE_DIR" 2>/dev/null || true
  cat > "$service" <<SERVICE
[Unit]
Description=BOT ERRORS Fleet Sentinel central evaluator

[Service]
Type=oneshot
WorkingDirectory=$REPO_ROOT
EnvironmentFile=-%h/.config/whatsoup/bot-errors.env
Environment="BOT_ERRORS_STATE_DIR=$state_q"
Environment="BOT_ERRORS_FLEET_SENTINEL_STATE_DIR=$sentinel_q"
Environment="BOT_ERRORS_FLEET_SENTINEL_HOSTS=$hosts_q"
Environment="BOT_ERRORS_FLEET_SENTINEL_ORACLE=$oracle_q"
Environment="BOT_ERRORS_FLEET_SENTINEL_HEARTBEAT_MAX_AGE_SECONDS=$heartbeat_q"
Environment="BOT_ERRORS_FLEET_SENTINEL_HYSTERESIS_CYCLES=$hysteresis_q"
Environment="BOT_ERRORS_FLEET_SENTINEL_FLAP_WINDOW_SECONDS=$flap_window_q"
Environment="BOT_ERRORS_FLEET_SENTINEL_FLAP_THRESHOLD=$flap_threshold_q"
Environment="BOT_ERRORS_FLEET_SENTINEL_MAX_TIER1_HEAL_CANDIDATES=$max_tier1_q"
Environment="BOT_ERRORS_FLEET_SENTINEL_CORRELATED_DRIFT_FREEZE_THRESHOLD=$correlated_q"
ExecStart=$py_q $script_q --hosts $hosts_q --state-dir $sentinel_q
SyslogIdentifier=bot-errors-sentinel
SERVICE

  cat > "$timer" <<TIMER
[Unit]
Description=Run BOT ERRORS Fleet Sentinel central evaluator every 30 minutes

[Timer]
OnActiveSec=2m
OnUnitActiveSec=${INTERVAL_SECONDS}s
AccuracySec=2m
Persistent=true
Unit=$UNIT.service

[Install]
WantedBy=timers.target
TIMER
  chmod 644 "$service" "$timer"
  if [[ "$DRY_RUN" != "1" ]]; then
    command -v systemctl >/dev/null 2>&1 || fail_config "systemctl unavailable"
    systemctl --user daemon-reload
    systemctl --user enable --now "$UNIT.timer"
  fi
  echo "installed $UNIT platform=systemd dry_run=$DRY_RUN interval=${INTERVAL_SECONDS}s path=$timer"
}

main() {
  require_interval
  require_file "$SENTINEL_SCRIPT" "BOT ERRORS sentinel file"
  require_file "$HOSTS_PATH" "BOT ERRORS sentinel hosts file"
  local platform
  platform=$(resolve_platform)
  case "$platform" in
    launchd) write_launchd ;;
    systemd) write_systemd ;;
    *) fail_config "BOT_ERRORS_FLEET_SENTINEL_PLATFORM must be launchd, systemd, or auto" ;;
  esac
}

main "$@"
