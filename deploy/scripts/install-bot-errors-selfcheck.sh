#!/usr/bin/env bash
# Install the BOT ERRORS Fleet Sentinel host selfcheck schedule.
#
# Exit codes:
#   0 installed or rendered successfully
#   2 configuration or platform prerequisites are missing
set -euo pipefail

LABEL=${BOT_ERRORS_SELFCHECK_LABEL:-com.bot-errors.selfcheck}
UNIT=${BOT_ERRORS_SELFCHECK_UNIT:-bot-errors-selfcheck}
REPO_ROOT=${BOT_ERRORS_REPO_ROOT:-$HOME/LAB/WhatSoup}
PYTHON=${BOT_ERRORS_PYTHON:-/usr/bin/python3}
STATE_DIR=${BOT_ERRORS_STATE_DIR:-$HOME/.local/state/bot-errors}
SENTINEL_STATE_DIR=${BOT_ERRORS_SENTINEL_STATE_DIR:-$STATE_DIR/sentinel}
INTERVAL_SECONDS=${BOT_ERRORS_SELFCHECK_INTERVAL_SECONDS:-1800}
RANDOMIZED_DELAY_SECONDS=${BOT_ERRORS_SELFCHECK_RANDOMIZED_DELAY_SECONDS:-120}
PLATFORM=${BOT_ERRORS_SELFCHECK_PLATFORM:-auto}
DRY_RUN=${BOT_ERRORS_SELFCHECK_INSTALL_DRY_RUN:-0}
LAUNCH_AGENTS=${BOT_ERRORS_LAUNCH_AGENTS_DIR:-$HOME/Library/LaunchAgents}
SYSTEMD_USER_DIR=${BOT_ERRORS_SYSTEMD_USER_DIR:-$HOME/.config/systemd/user}
SELFCHECK_SCRIPT="$REPO_ROOT/deploy/scripts/bot-errors-selfcheck.py"
DEPLOYER_SCRIPT="$REPO_ROOT/deploy/scripts/whatsoup-bot-errors-deploy.sh"

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
  local path="$1"
  [[ -f "$path" ]] || fail_config "missing required BOT ERRORS selfcheck file: $path"
}

require_python() {
  [[ "$PYTHON" = /* ]] || fail_config "BOT_ERRORS_PYTHON must be an absolute executable path: $PYTHON"
  [[ -x "$PYTHON" && ! -d "$PYTHON" ]] || fail_config "BOT_ERRORS_PYTHON must be an absolute executable path: $PYTHON"
}

require_interval() {
  [[ "$INTERVAL_SECONDS" =~ ^[0-9]+$ ]] || fail_config "BOT_ERRORS_SELFCHECK_INTERVAL_SECONDS must be numeric"
  [[ "$RANDOMIZED_DELAY_SECONDS" =~ ^[0-9]+$ ]] || fail_config "BOT_ERRORS_SELFCHECK_RANDOMIZED_DELAY_SECONDS must be numeric"
  (( INTERVAL_SECONDS >= 300 )) || fail_config "BOT_ERRORS_SELFCHECK_INTERVAL_SECONDS must be at least 300"
  (( RANDOMIZED_DELAY_SECONDS <= INTERVAL_SECONDS )) || fail_config "BOT_ERRORS_SELFCHECK_RANDOMIZED_DELAY_SECONDS must not exceed BOT_ERRORS_SELFCHECK_INTERVAL_SECONDS"
}

resolve_platform() {
  if [[ "$PLATFORM" != "auto" ]]; then
    printf '%s\n' "$PLATFORM"
    return
  fi
  case "$(uname -s)" in
    Darwin) printf '%s\n' "launchd" ;;
    Linux) printf '%s\n' "systemd" ;;
    *) fail_config "unsupported platform for auto selfcheck installer: $(uname -s)" ;;
  esac
}

write_launchd() {
  local plist="$LAUNCH_AGENTS/$LABEL.plist"
  local label_xml repo_xml py_xml script_xml state_xml sentinel_xml units_xml fresh_xml heartbeat_xml ack_xml central_alert_xml central_down_max_xml heal_min_free_xml stdout_xml stderr_xml
  label_xml=$(xml_escape "$LABEL")
  repo_xml=$(xml_escape "$REPO_ROOT")
  py_xml=$(xml_escape "$PYTHON")
  script_xml=$(xml_escape "$SELFCHECK_SCRIPT")
  state_xml=$(xml_escape "$STATE_DIR")
  sentinel_xml=$(xml_escape "$SENTINEL_STATE_DIR")
  units_xml=$(xml_escape "${BOT_ERRORS_SELFCHECK_UNITS:-}")
  fresh_xml=$(xml_escape "${BOT_ERRORS_SELFCHECK_FRESHNESS_JSON:-}")
  heartbeat_xml=$(xml_escape "${BOT_ERRORS_SELFCHECK_HEARTBEAT_URL:-}")
  ack_xml=$(xml_escape "${BOT_ERRORS_SELFCHECK_CENTRAL_ACK:-}")
  central_alert_xml=$(xml_escape "${BOT_ERRORS_SELFCHECK_CENTRAL_DOWN_ALERT:-}")
  central_down_max_xml=$(xml_escape "${BOT_ERRORS_SELFCHECK_CENTRAL_DOWN_MAX_AGE_SECONDS:-}")
  heal_min_free_xml=$(xml_escape "${BOT_ERRORS_SELFCHECK_HEAL_MIN_FREE_BYTES:-}")
  stdout_xml=$(xml_escape "$STATE_DIR/logs/selfcheck.out.log")
  stderr_xml=$(xml_escape "$STATE_DIR/logs/selfcheck.err.log")

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
    <string>--root</string>
    <string>$repo_xml</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>BOT_ERRORS_STATE_DIR</key><string>$state_xml</string>
    <key>BOT_ERRORS_SENTINEL_STATE_DIR</key><string>$sentinel_xml</string>
    <key>BOT_ERRORS_SELFCHECK_UNITS</key><string>$units_xml</string>
    <key>BOT_ERRORS_SELFCHECK_FRESHNESS_JSON</key><string>$fresh_xml</string>
    <key>BOT_ERRORS_SELFCHECK_HEARTBEAT_URL</key><string>$heartbeat_xml</string>
    <key>BOT_ERRORS_SELFCHECK_CENTRAL_ACK</key><string>$ack_xml</string>
    <key>BOT_ERRORS_SELFCHECK_CENTRAL_DOWN_ALERT</key><string>$central_alert_xml</string>
    <key>BOT_ERRORS_SELFCHECK_CENTRAL_DOWN_MAX_AGE_SECONDS</key><string>$central_down_max_xml</string>
    <key>BOT_ERRORS_SELFCHECK_HEAL_MIN_FREE_BYTES</key><string>$heal_min_free_xml</string>
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
  local repo_q py_q script_q state_q sentinel_q units_q fresh_q heartbeat_q ack_q central_alert_q central_down_max_q heal_min_free_q
  repo_q=$(systemd_quote "$REPO_ROOT")
  py_q=$(systemd_quote "$PYTHON")
  script_q=$(systemd_quote "$SELFCHECK_SCRIPT")
  state_q=$(systemd_quote "$STATE_DIR")
  sentinel_q=$(systemd_quote "$SENTINEL_STATE_DIR")
  units_q=$(systemd_quote "${BOT_ERRORS_SELFCHECK_UNITS:-}")
  fresh_q=$(systemd_quote "${BOT_ERRORS_SELFCHECK_FRESHNESS_JSON:-}")
  heartbeat_q=$(systemd_quote "${BOT_ERRORS_SELFCHECK_HEARTBEAT_URL:-}")
  ack_q=$(systemd_quote "${BOT_ERRORS_SELFCHECK_CENTRAL_ACK:-}")
  central_alert_q=$(systemd_quote "${BOT_ERRORS_SELFCHECK_CENTRAL_DOWN_ALERT:-}")
  central_down_max_q=$(systemd_quote "${BOT_ERRORS_SELFCHECK_CENTRAL_DOWN_MAX_AGE_SECONDS:-}")
  heal_min_free_q=$(systemd_quote "${BOT_ERRORS_SELFCHECK_HEAL_MIN_FREE_BYTES:-}")

  mkdir -p "$SYSTEMD_USER_DIR" "$STATE_DIR/logs" "$SENTINEL_STATE_DIR"
  chmod 700 "$STATE_DIR" "$STATE_DIR/logs" "$SENTINEL_STATE_DIR" 2>/dev/null || true
  cat > "$service" <<SERVICE
[Unit]
Description=BOT ERRORS Fleet Sentinel host selfcheck

[Service]
Type=oneshot
WorkingDirectory=$REPO_ROOT
EnvironmentFile=-%h/.config/whatsoup/bot-errors.env
Environment="BOT_ERRORS_STATE_DIR=$state_q"
Environment="BOT_ERRORS_SENTINEL_STATE_DIR=$sentinel_q"
Environment="BOT_ERRORS_SELFCHECK_UNITS=$units_q"
Environment="BOT_ERRORS_SELFCHECK_FRESHNESS_JSON=$fresh_q"
Environment="BOT_ERRORS_SELFCHECK_HEARTBEAT_URL=$heartbeat_q"
Environment="BOT_ERRORS_SELFCHECK_CENTRAL_ACK=$ack_q"
Environment="BOT_ERRORS_SELFCHECK_CENTRAL_DOWN_ALERT=$central_alert_q"
Environment="BOT_ERRORS_SELFCHECK_CENTRAL_DOWN_MAX_AGE_SECONDS=$central_down_max_q"
Environment="BOT_ERRORS_SELFCHECK_HEAL_MIN_FREE_BYTES=$heal_min_free_q"
ExecStart=$py_q $script_q --root $repo_q
SyslogIdentifier=bot-errors-selfcheck
SERVICE

  cat > "$timer" <<TIMER
[Unit]
Description=Run BOT ERRORS Fleet Sentinel host selfcheck every 30 minutes

[Timer]
OnActiveSec=2m
OnUnitActiveSec=${INTERVAL_SECONDS}s
RandomizedDelaySec=${RANDOMIZED_DELAY_SECONDS}s
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
  require_python
  require_file "$SELFCHECK_SCRIPT"
  require_file "$DEPLOYER_SCRIPT"
  local platform
  platform=$(resolve_platform)
  case "$platform" in
    launchd) write_launchd ;;
    systemd) write_systemd ;;
    *) fail_config "BOT_ERRORS_SELFCHECK_PLATFORM must be launchd, systemd, or auto" ;;
  esac
}

main "$@"
