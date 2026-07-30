#!/usr/bin/env bash
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

systemd_escape(){
  local value="$1"
  value=${value//\\/\\\\}
  value=${value//\"/\\\"}
  printf "%s" "$value"
}

systemd_env_line(){
  local key="$1" value="$2"
  [[ -n "$value" ]] || return 0
  printf 'Environment="%s=%s"\n' "$key" "$(systemd_escape "$value")"
}

launchd_env_entry(){
  local key="$1" value="$2"
  [[ -n "$value" ]] || return 0
  printf '    <key>%s</key><string>%s</string>\n' "$(xml_escape "$key")" "$(xml_escape "$value")"
}

validate_label(){
  local name="$1" value="$2"
  if [[ ! "$value" =~ ^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?$ ]]; then
    echo "invalid $name: label must match ^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?\\$  (no '/', '..', whitespace or shell metacharacters)" >&2
    exit 2
  fi
}

validate_label BOT_ERRORS_GUI_MONITOR_LABEL "$LABEL"

EXPECTED_FLEET_VALUE="$(env_or_default BOT_ERRORS_EXPECTED_FLEET "")"
GUI_MONITOR_USERS_VALUE="$(env_or_default BOT_ERRORS_GUI_MONITOR_USERS "")"
SSH_TIMEOUT_VALUE="$(env_or_default BOT_ERRORS_GUI_MONITOR_SSH_TIMEOUT_SECONDS "")"
FAILURE_THRESHOLD_VALUE="$(env_or_default BOT_ERRORS_GUI_MONITOR_FAILURE_THRESHOLD "")"
GUI_MONITOR_STATE_VALUE="$(env_or_default BOT_ERRORS_GUI_MONITOR_STATE "")"

LABEL_XML="$(xml_escape "$LABEL")"
REPO_ROOT_XML="$(xml_escape "$REPO_ROOT")"
PYTHON_XML="$(xml_escape "$PYTHON")"
STATE_DIR_XML="$(xml_escape "$STATE_DIR")"
MONITOR_SCRIPT_XML="$(xml_escape "$MONITOR_SCRIPT")"

if [[ ! -f "$MONITOR_SCRIPT" ]]; then
  echo "missing required monitor script: $MONITOR_SCRIPT" >&2
  exit 2
fi

run_config_check(){
  local env_args=(
    "BOT_ERRORS_STATE_DIR=$STATE_DIR"
  )
  if [[ -n "$EXPECTED_FLEET_VALUE" ]]; then
    env_args+=("BOT_ERRORS_EXPECTED_FLEET=$EXPECTED_FLEET_VALUE")
  fi
  if [[ -n "$GUI_MONITOR_USERS_VALUE" ]]; then
    env_args+=("BOT_ERRORS_GUI_MONITOR_USERS=$GUI_MONITOR_USERS_VALUE")
  fi
  if [[ -n "$SSH_TIMEOUT_VALUE" ]]; then
    env_args+=("BOT_ERRORS_GUI_MONITOR_SSH_TIMEOUT_SECONDS=$SSH_TIMEOUT_VALUE")
  fi
  if [[ -n "$FAILURE_THRESHOLD_VALUE" ]]; then
    env_args+=("BOT_ERRORS_GUI_MONITOR_FAILURE_THRESHOLD=$FAILURE_THRESHOLD_VALUE")
  fi
  if [[ -n "$GUI_MONITOR_STATE_VALUE" ]]; then
    env_args+=("BOT_ERRORS_GUI_MONITOR_STATE=$GUI_MONITOR_STATE_VALUE")
  fi
  env "${env_args[@]}" "$PYTHON" "$MONITOR_SCRIPT" --config-check
}

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
$(systemd_env_line BOT_ERRORS_EXPECTED_FLEET "$EXPECTED_FLEET_VALUE")
$(systemd_env_line BOT_ERRORS_GUI_MONITOR_USERS "$GUI_MONITOR_USERS_VALUE")
$(systemd_env_line BOT_ERRORS_GUI_MONITOR_SSH_TIMEOUT_SECONDS "$SSH_TIMEOUT_VALUE")
$(systemd_env_line BOT_ERRORS_GUI_MONITOR_FAILURE_THRESHOLD "$FAILURE_THRESHOLD_VALUE")
$(systemd_env_line BOT_ERRORS_GUI_MONITOR_STATE "$GUI_MONITOR_STATE_VALUE")
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
  <key>Label</key><string>$LABEL_XML</string>
  <key>ProgramArguments</key>
  <array>
    <string>$PYTHON_XML</string>
    <string>$MONITOR_SCRIPT_XML</string>
    <string>--once</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>BOT_ERRORS_STATE_DIR</key><string>$STATE_DIR_XML</string>
$(launchd_env_entry BOT_ERRORS_EXPECTED_FLEET "$EXPECTED_FLEET_VALUE")
$(launchd_env_entry BOT_ERRORS_GUI_MONITOR_USERS "$GUI_MONITOR_USERS_VALUE")
$(launchd_env_entry BOT_ERRORS_GUI_MONITOR_SSH_TIMEOUT_SECONDS "$SSH_TIMEOUT_VALUE")
$(launchd_env_entry BOT_ERRORS_GUI_MONITOR_FAILURE_THRESHOLD "$FAILURE_THRESHOLD_VALUE")
$(launchd_env_entry BOT_ERRORS_GUI_MONITOR_STATE "$GUI_MONITOR_STATE_VALUE")
  </dict>
  <key>WorkingDirectory</key><string>$REPO_ROOT_XML</string>
  <key>RunAtLoad</key><false/>
  <key>StartInterval</key><integer>$INTERVAL_SECONDS</integer>
  <key>StandardOutPath</key><string>$STATE_DIR_XML/logs/gui-session-monitor.out.log</string>
  <key>StandardErrorPath</key><string>$STATE_DIR_XML/logs/gui-session-monitor.err.log</string>
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
  if [[ "$DRY_RUN" != "1" ]]; then
    run_config_check
  fi
  install_systemd
elif [[ "$(uname -s)" == "Darwin" ]]; then
  if [[ "$DRY_RUN" != "1" ]]; then
    run_config_check
  fi
  install_launchd
else
  echo "no supported scheduler found (need systemd or macOS launchd)" >&2
  exit 2
fi
