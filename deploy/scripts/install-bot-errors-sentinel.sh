#!/usr/bin/env bash
# Install the BOT ERRORS Fleet Sentinel central evaluator schedule.
#
# Exit codes:
#   0 installed or rendered successfully
#   2 configuration or platform prerequisites are missing
set -euo pipefail

LABEL=${BOT_ERRORS_FLEET_SENTINEL_LABEL:-com.bot-errors.sentinel}
UNIT=${BOT_ERRORS_FLEET_SENTINEL_UNIT:-bot-errors-sentinel}
WATCHDOG_LABEL=${BOT_ERRORS_FLEET_SENTINEL_WATCHDOG_LABEL:-$LABEL.watchdog}
WATCHDOG_UNIT=${BOT_ERRORS_FLEET_SENTINEL_WATCHDOG_UNIT:-$UNIT-watchdog}
REPO_ROOT=${BOT_ERRORS_REPO_ROOT:-$HOME/LAB/WhatSoup}
PYTHON=${BOT_ERRORS_PYTHON:-/usr/bin/python3}
STATE_DIR=${BOT_ERRORS_STATE_DIR:-$HOME/.local/state/bot-errors}
SENTINEL_STATE_DIR=${BOT_ERRORS_FLEET_SENTINEL_STATE_DIR:-$STATE_DIR/fleet-sentinel}
HOSTS_PATH=${BOT_ERRORS_FLEET_SENTINEL_HOSTS:-$REPO_ROOT/deploy/bot-errors-expected-fleet.json}
ORACLE_PATH=${BOT_ERRORS_FLEET_SENTINEL_ORACLE:-}
ACTION_OUTBOX_DIR=${BOT_ERRORS_FLEET_SENTINEL_ACTION_OUTBOX_DIR:-$SENTINEL_STATE_DIR/actions}
INTERVAL_SECONDS=${BOT_ERRORS_FLEET_SENTINEL_INTERVAL_SECONDS:-1800}
RANDOMIZED_DELAY_SECONDS=${BOT_ERRORS_FLEET_SENTINEL_RANDOMIZED_DELAY_SECONDS:-120}
WATCHDOG_INTERVAL_SECONDS=${BOT_ERRORS_FLEET_SENTINEL_WATCHDOG_INTERVAL_SECONDS:-300}
WATCHDOG_RANDOMIZED_DELAY_SECONDS=${BOT_ERRORS_FLEET_SENTINEL_WATCHDOG_RANDOMIZED_DELAY_SECONDS:-60}
WATCHDOG_MAX_AGE_SECONDS=${BOT_ERRORS_FLEET_SENTINEL_WATCHDOG_MAX_AGE_SECONDS:-2700}
PLATFORM=${BOT_ERRORS_FLEET_SENTINEL_PLATFORM:-auto}
DRY_RUN=${BOT_ERRORS_FLEET_SENTINEL_INSTALL_DRY_RUN:-0}
LAUNCH_AGENTS=${BOT_ERRORS_LAUNCH_AGENTS_DIR:-$HOME/Library/LaunchAgents}
SYSTEMD_USER_DIR=${BOT_ERRORS_SYSTEMD_USER_DIR:-$HOME/.config/systemd/user}
SENTINEL_SCRIPT="$REPO_ROOT/deploy/scripts/bot-errors-sentinel.py"
WATCHDOG_SCRIPT="$REPO_ROOT/deploy/scripts/bot-errors-heartbeat-watchdog.py"

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

require_python() {
  [[ "$PYTHON" = /* ]] || fail_config "BOT_ERRORS_PYTHON must be an absolute executable path: $PYTHON"
  [[ -x "$PYTHON" && ! -d "$PYTHON" ]] || fail_config "BOT_ERRORS_PYTHON must be an absolute executable path: $PYTHON"
}

require_min_interval() {
  local value="$1" name="$2" min="$3"
  [[ "$value" =~ ^[0-9]+$ ]] || fail_config "$name must be numeric"
  (( value >= min )) || fail_config "$name must be at least $min"
}

require_interval() {
  require_min_interval "$INTERVAL_SECONDS" "BOT_ERRORS_FLEET_SENTINEL_INTERVAL_SECONDS" 300
  require_min_interval "$RANDOMIZED_DELAY_SECONDS" "BOT_ERRORS_FLEET_SENTINEL_RANDOMIZED_DELAY_SECONDS" 0
  require_min_interval "$WATCHDOG_INTERVAL_SECONDS" "BOT_ERRORS_FLEET_SENTINEL_WATCHDOG_INTERVAL_SECONDS" 60
  require_min_interval "$WATCHDOG_RANDOMIZED_DELAY_SECONDS" "BOT_ERRORS_FLEET_SENTINEL_WATCHDOG_RANDOMIZED_DELAY_SECONDS" 0
  require_min_interval "$WATCHDOG_MAX_AGE_SECONDS" "BOT_ERRORS_FLEET_SENTINEL_WATCHDOG_MAX_AGE_SECONDS" 60
  (( RANDOMIZED_DELAY_SECONDS <= INTERVAL_SECONDS )) || fail_config "BOT_ERRORS_FLEET_SENTINEL_RANDOMIZED_DELAY_SECONDS must not exceed BOT_ERRORS_FLEET_SENTINEL_INTERVAL_SECONDS"
  (( WATCHDOG_RANDOMIZED_DELAY_SECONDS <= WATCHDOG_INTERVAL_SECONDS )) || fail_config "BOT_ERRORS_FLEET_SENTINEL_WATCHDOG_RANDOMIZED_DELAY_SECONDS must not exceed BOT_ERRORS_FLEET_SENTINEL_WATCHDOG_INTERVAL_SECONDS"
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
  local watchdog_plist="$LAUNCH_AGENTS/$WATCHDOG_LABEL.plist"
  local label_xml watchdog_label_xml repo_xml py_xml script_xml watchdog_script_xml state_xml sentinel_xml hosts_xml oracle_xml action_outbox_xml sentinel_heartbeat_xml heartbeat_xml hysteresis_xml connectivity_hysteresis_xml flap_window_xml flap_threshold_xml max_tier1_xml correlated_xml clock_skew_xml action_cooldown_xml whatsapp_cap_xml tier2_token_ttl_xml q_host_xml action_outbox_retention_xml lock_xml ssh_command_xml ssh_connect_timeout_xml ssh_probe_timeout_xml watchdog_max_age_xml stdout_xml stderr_xml watchdog_stdout_xml watchdog_stderr_xml
  label_xml=$(xml_escape "$LABEL")
  watchdog_label_xml=$(xml_escape "$WATCHDOG_LABEL")
  repo_xml=$(xml_escape "$REPO_ROOT")
  py_xml=$(xml_escape "$PYTHON")
  script_xml=$(xml_escape "$SENTINEL_SCRIPT")
  watchdog_script_xml=$(xml_escape "$WATCHDOG_SCRIPT")
  state_xml=$(xml_escape "$STATE_DIR")
  sentinel_xml=$(xml_escape "$SENTINEL_STATE_DIR")
  hosts_xml=$(xml_escape "$HOSTS_PATH")
  oracle_xml=$(xml_escape "$ORACLE_PATH")
  action_outbox_xml=$(xml_escape "$ACTION_OUTBOX_DIR")
  sentinel_heartbeat_xml=$(xml_escape "$SENTINEL_STATE_DIR/sentinel-heartbeat.json")
  heartbeat_xml=$(xml_escape "${BOT_ERRORS_FLEET_SENTINEL_HEARTBEAT_MAX_AGE_SECONDS:-2700}")
  hysteresis_xml=$(xml_escape "${BOT_ERRORS_FLEET_SENTINEL_HYSTERESIS_CYCLES:-2}")
  connectivity_hysteresis_xml=$(xml_escape "${BOT_ERRORS_FLEET_SENTINEL_CONNECTIVITY_HYSTERESIS_CYCLES:-3}")
  flap_window_xml=$(xml_escape "${BOT_ERRORS_FLEET_SENTINEL_FLAP_WINDOW_SECONDS:-21600}")
  flap_threshold_xml=$(xml_escape "${BOT_ERRORS_FLEET_SENTINEL_FLAP_THRESHOLD:-4}")
  max_tier1_xml=$(xml_escape "${BOT_ERRORS_FLEET_SENTINEL_MAX_TIER1_HEAL_CANDIDATES:-2}")
  correlated_xml=$(xml_escape "${BOT_ERRORS_FLEET_SENTINEL_CORRELATED_DRIFT_FREEZE_THRESHOLD:-2}")
  clock_skew_xml=$(xml_escape "${BOT_ERRORS_FLEET_SENTINEL_MAX_CLOCK_SKEW_SECONDS:-300}")
  action_cooldown_xml=$(xml_escape "${BOT_ERRORS_FLEET_SENTINEL_ACTION_EVENT_COOLDOWN_SECONDS:-21600}")
  whatsapp_cap_xml=$(xml_escape "${BOT_ERRORS_FLEET_SENTINEL_MAX_CRITICAL_WHATSAPP_PER_DAY:-8}")
  tier2_token_ttl_xml=$(xml_escape "${BOT_ERRORS_FLEET_SENTINEL_TIER2_TOKEN_TTL_SECONDS:-1800}")
  q_host_xml=$(xml_escape "${BOT_ERRORS_FLEET_SENTINEL_Q_HOST:-q-agent-host}")
  # launchd has no EnvironmentFile hydration, so every supported runtime key
  # must be baked here; defaults must match the bot-errors-sentinel.py fallbacks.
  action_outbox_retention_xml=$(xml_escape "${BOT_ERRORS_FLEET_SENTINEL_ACTION_OUTBOX_RETENTION:-500}")
  lock_xml=$(xml_escape "${BOT_ERRORS_FLEET_SENTINEL_LOCK:-$HOME/.local/state/bot-errors/fleet-sentinel/sentinel-instance.lock}")
  ssh_command_xml=$(xml_escape "${BOT_ERRORS_FLEET_SENTINEL_SSH_COMMAND:-ssh}")
  ssh_connect_timeout_xml=$(xml_escape "${BOT_ERRORS_FLEET_SENTINEL_SSH_CONNECT_TIMEOUT_SECONDS:-8}")
  ssh_probe_timeout_xml=$(xml_escape "${BOT_ERRORS_FLEET_SENTINEL_SSH_PROBE_TIMEOUT_SECONDS:-30}")
  watchdog_max_age_xml=$(xml_escape "$WATCHDOG_MAX_AGE_SECONDS")
  stdout_xml=$(xml_escape "$STATE_DIR/logs/sentinel.out.log")
  stderr_xml=$(xml_escape "$STATE_DIR/logs/sentinel.err.log")
  watchdog_stdout_xml=$(xml_escape "$STATE_DIR/logs/sentinel-watchdog.out.log")
  watchdog_stderr_xml=$(xml_escape "$STATE_DIR/logs/sentinel-watchdog.err.log")

  mkdir -p "$LAUNCH_AGENTS" "$STATE_DIR/logs" "$SENTINEL_STATE_DIR" "$ACTION_OUTBOX_DIR"
  chmod 700 "$STATE_DIR" "$STATE_DIR/logs" "$SENTINEL_STATE_DIR" "$ACTION_OUTBOX_DIR" \
    || fail_config "cannot secure BOT ERRORS sentinel state directories"
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
    <key>BOT_ERRORS_FLEET_SENTINEL_ACTION_OUTBOX_DIR</key><string>$action_outbox_xml</string>
    <key>BOT_ERRORS_FLEET_SENTINEL_HEARTBEAT_MAX_AGE_SECONDS</key><string>$heartbeat_xml</string>
    <key>BOT_ERRORS_FLEET_SENTINEL_HYSTERESIS_CYCLES</key><string>$hysteresis_xml</string>
    <key>BOT_ERRORS_FLEET_SENTINEL_CONNECTIVITY_HYSTERESIS_CYCLES</key><string>$connectivity_hysteresis_xml</string>
    <key>BOT_ERRORS_FLEET_SENTINEL_FLAP_WINDOW_SECONDS</key><string>$flap_window_xml</string>
    <key>BOT_ERRORS_FLEET_SENTINEL_FLAP_THRESHOLD</key><string>$flap_threshold_xml</string>
    <key>BOT_ERRORS_FLEET_SENTINEL_MAX_TIER1_HEAL_CANDIDATES</key><string>$max_tier1_xml</string>
    <key>BOT_ERRORS_FLEET_SENTINEL_CORRELATED_DRIFT_FREEZE_THRESHOLD</key><string>$correlated_xml</string>
    <key>BOT_ERRORS_FLEET_SENTINEL_MAX_CLOCK_SKEW_SECONDS</key><string>$clock_skew_xml</string>
    <key>BOT_ERRORS_FLEET_SENTINEL_ACTION_EVENT_COOLDOWN_SECONDS</key><string>$action_cooldown_xml</string>
    <key>BOT_ERRORS_FLEET_SENTINEL_MAX_CRITICAL_WHATSAPP_PER_DAY</key><string>$whatsapp_cap_xml</string>
    <key>BOT_ERRORS_FLEET_SENTINEL_TIER2_TOKEN_TTL_SECONDS</key><string>$tier2_token_ttl_xml</string>
    <key>BOT_ERRORS_FLEET_SENTINEL_Q_HOST</key><string>$q_host_xml</string>
    <key>BOT_ERRORS_FLEET_SENTINEL_ACTION_OUTBOX_RETENTION</key><string>$action_outbox_retention_xml</string>
    <key>BOT_ERRORS_FLEET_SENTINEL_LOCK</key><string>$lock_xml</string>
    <key>BOT_ERRORS_FLEET_SENTINEL_SSH_COMMAND</key><string>$ssh_command_xml</string>
    <key>BOT_ERRORS_FLEET_SENTINEL_SSH_CONNECT_TIMEOUT_SECONDS</key><string>$ssh_connect_timeout_xml</string>
    <key>BOT_ERRORS_FLEET_SENTINEL_SSH_PROBE_TIMEOUT_SECONDS</key><string>$ssh_probe_timeout_xml</string>
  </dict>
  <key>WorkingDirectory</key><string>$repo_xml</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key><false/>
  </dict>
  <!-- Rate-limit respawns. A non-zero exit (e.g. result_requires_attention -->
  <!-- returns 1) otherwise drives KeepAlive into a tight respawn+re-probe -->
  <!-- loop during an incident. The attention signal surfaces via the emitted -->
  <!-- event/heartbeat, not the process exit code, so throttling is safe. -->
  <key>ThrottleInterval</key><integer>60</integer>
  <key>StartInterval</key><integer>$INTERVAL_SECONDS</integer>
  <key>StandardOutPath</key><string>$stdout_xml</string>
  <key>StandardErrorPath</key><string>$stderr_xml</string>
</dict>
</plist>
PLIST
  cat > "$watchdog_plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$watchdog_label_xml</string>
  <key>ProgramArguments</key>
  <array>
    <string>$py_xml</string>
    <string>$watchdog_script_xml</string>
    <string>--once</string>
    <string>--max-fleet-sentinel-age</string>
    <string>$watchdog_max_age_xml</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>BOT_ERRORS_STATE_DIR</key><string>$state_xml</string>
    <key>BOT_ERRORS_WATCHDOG_CHECKS</key><string>fleet_sentinel,collector_roster</string>
    <key>BOT_ERRORS_FLEET_SENTINEL_HOSTS</key><string>$hosts_xml</string>
    <key>BOT_ERRORS_FLEET_SENTINEL_HEARTBEAT</key><string>$sentinel_heartbeat_xml</string>
    <key>BOT_ERRORS_MAX_FLEET_SENTINEL_AGE</key><string>$watchdog_max_age_xml</string>
  </dict>
  <key>WorkingDirectory</key><string>$repo_xml</string>
  <key>RunAtLoad</key><true/>
  <key>StartInterval</key><integer>$WATCHDOG_INTERVAL_SECONDS</integer>
  <key>StandardOutPath</key><string>$watchdog_stdout_xml</string>
  <key>StandardErrorPath</key><string>$watchdog_stderr_xml</string>
</dict>
</plist>
PLIST
  chmod 644 "$plist" "$watchdog_plist"
  if [[ "$DRY_RUN" != "1" ]]; then
    command -v plutil >/dev/null 2>&1 || fail_config "plutil unavailable"
    command -v launchctl >/dev/null 2>&1 || fail_config "launchctl unavailable"
    plutil -lint "$plist" >/dev/null
    plutil -lint "$watchdog_plist" >/dev/null
    local uid_value
    uid_value=$(id -u)
    launchctl bootout "gui/$uid_value" "$plist" >/dev/null 2>&1 || true
    launchctl bootout "gui/$uid_value" "$watchdog_plist" >/dev/null 2>&1 || true
    launchctl bootstrap "gui/$uid_value" "$plist"
    launchctl bootstrap "gui/$uid_value" "$watchdog_plist"
    launchctl enable "gui/$uid_value/$LABEL" >/dev/null 2>&1 \
      || fail_config "cannot enable BOT ERRORS sentinel launchd job"
    launchctl enable "gui/$uid_value/$WATCHDOG_LABEL" >/dev/null 2>&1 \
      || fail_config "cannot enable BOT ERRORS sentinel watchdog launchd job"
  fi
  echo "installed $LABEL $WATCHDOG_LABEL platform=launchd dry_run=$DRY_RUN interval=${INTERVAL_SECONDS}s watchdog_interval=${WATCHDOG_INTERVAL_SECONDS}s path=$plist watchdog_path=$watchdog_plist"
}

write_systemd() {
  local service="$SYSTEMD_USER_DIR/$UNIT.service"
  local timer="$SYSTEMD_USER_DIR/$UNIT.timer"
  local watchdog_service="$SYSTEMD_USER_DIR/$WATCHDOG_UNIT.service"
  local watchdog_timer="$SYSTEMD_USER_DIR/$WATCHDOG_UNIT.timer"
  local repo_q py_q script_q watchdog_script_q state_q sentinel_q hosts_q oracle_q action_outbox_q sentinel_heartbeat_q heartbeat_q hysteresis_q connectivity_hysteresis_q flap_window_q flap_threshold_q max_tier1_q correlated_q clock_skew_q action_cooldown_q whatsapp_cap_q tier2_token_ttl_q q_host_q watchdog_max_age_q
  repo_q=$(systemd_quote "$REPO_ROOT")
  py_q=$(systemd_quote "$PYTHON")
  script_q=$(systemd_quote "$SENTINEL_SCRIPT")
  watchdog_script_q=$(systemd_quote "$WATCHDOG_SCRIPT")
  state_q=$(systemd_quote "$STATE_DIR")
  sentinel_q=$(systemd_quote "$SENTINEL_STATE_DIR")
  hosts_q=$(systemd_quote "$HOSTS_PATH")
  oracle_q=$(systemd_quote "$ORACLE_PATH")
  action_outbox_q=$(systemd_quote "$ACTION_OUTBOX_DIR")
  sentinel_heartbeat_q=$(systemd_quote "$SENTINEL_STATE_DIR/sentinel-heartbeat.json")
  heartbeat_q=$(systemd_quote "${BOT_ERRORS_FLEET_SENTINEL_HEARTBEAT_MAX_AGE_SECONDS:-2700}")
  hysteresis_q=$(systemd_quote "${BOT_ERRORS_FLEET_SENTINEL_HYSTERESIS_CYCLES:-2}")
  connectivity_hysteresis_q=$(systemd_quote "${BOT_ERRORS_FLEET_SENTINEL_CONNECTIVITY_HYSTERESIS_CYCLES:-3}")
  flap_window_q=$(systemd_quote "${BOT_ERRORS_FLEET_SENTINEL_FLAP_WINDOW_SECONDS:-21600}")
  flap_threshold_q=$(systemd_quote "${BOT_ERRORS_FLEET_SENTINEL_FLAP_THRESHOLD:-4}")
  max_tier1_q=$(systemd_quote "${BOT_ERRORS_FLEET_SENTINEL_MAX_TIER1_HEAL_CANDIDATES:-2}")
  correlated_q=$(systemd_quote "${BOT_ERRORS_FLEET_SENTINEL_CORRELATED_DRIFT_FREEZE_THRESHOLD:-2}")
  clock_skew_q=$(systemd_quote "${BOT_ERRORS_FLEET_SENTINEL_MAX_CLOCK_SKEW_SECONDS:-300}")
  action_cooldown_q=$(systemd_quote "${BOT_ERRORS_FLEET_SENTINEL_ACTION_EVENT_COOLDOWN_SECONDS:-21600}")
  whatsapp_cap_q=$(systemd_quote "${BOT_ERRORS_FLEET_SENTINEL_MAX_CRITICAL_WHATSAPP_PER_DAY:-8}")
  tier2_token_ttl_q=$(systemd_quote "${BOT_ERRORS_FLEET_SENTINEL_TIER2_TOKEN_TTL_SECONDS:-1800}")
  q_host_q=$(systemd_quote "${BOT_ERRORS_FLEET_SENTINEL_Q_HOST:-q-agent-host}")
  watchdog_max_age_q=$(systemd_quote "$WATCHDOG_MAX_AGE_SECONDS")

  mkdir -p "$SYSTEMD_USER_DIR" "$STATE_DIR/logs" "$SENTINEL_STATE_DIR" "$ACTION_OUTBOX_DIR"
  chmod 700 "$STATE_DIR" "$STATE_DIR/logs" "$SENTINEL_STATE_DIR" "$ACTION_OUTBOX_DIR" \
    || fail_config "cannot secure BOT ERRORS sentinel state directories"
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
Environment="BOT_ERRORS_FLEET_SENTINEL_ACTION_OUTBOX_DIR=$action_outbox_q"
Environment="BOT_ERRORS_FLEET_SENTINEL_HEARTBEAT_MAX_AGE_SECONDS=$heartbeat_q"
Environment="BOT_ERRORS_FLEET_SENTINEL_HYSTERESIS_CYCLES=$hysteresis_q"
Environment="BOT_ERRORS_FLEET_SENTINEL_CONNECTIVITY_HYSTERESIS_CYCLES=$connectivity_hysteresis_q"
Environment="BOT_ERRORS_FLEET_SENTINEL_FLAP_WINDOW_SECONDS=$flap_window_q"
Environment="BOT_ERRORS_FLEET_SENTINEL_FLAP_THRESHOLD=$flap_threshold_q"
Environment="BOT_ERRORS_FLEET_SENTINEL_MAX_TIER1_HEAL_CANDIDATES=$max_tier1_q"
Environment="BOT_ERRORS_FLEET_SENTINEL_CORRELATED_DRIFT_FREEZE_THRESHOLD=$correlated_q"
Environment="BOT_ERRORS_FLEET_SENTINEL_MAX_CLOCK_SKEW_SECONDS=$clock_skew_q"
Environment="BOT_ERRORS_FLEET_SENTINEL_ACTION_EVENT_COOLDOWN_SECONDS=$action_cooldown_q"
Environment="BOT_ERRORS_FLEET_SENTINEL_MAX_CRITICAL_WHATSAPP_PER_DAY=$whatsapp_cap_q"
Environment="BOT_ERRORS_FLEET_SENTINEL_TIER2_TOKEN_TTL_SECONDS=$tier2_token_ttl_q"
Environment="BOT_ERRORS_FLEET_SENTINEL_Q_HOST=$q_host_q"
ExecStart=$py_q $script_q --hosts $hosts_q --state-dir $sentinel_q
Restart=on-failure
RestartSec=60
SyslogIdentifier=bot-errors-sentinel
SERVICE

  cat > "$timer" <<TIMER
[Unit]
Description=Run BOT ERRORS Fleet Sentinel central evaluator every 30 minutes

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
  cat > "$watchdog_service" <<SERVICE
[Unit]
Description=BOT ERRORS Fleet Sentinel central heartbeat watchdog

[Service]
Type=oneshot
WorkingDirectory=$REPO_ROOT
EnvironmentFile=-%h/.config/whatsoup/bot-errors.env
Environment="BOT_ERRORS_STATE_DIR=$state_q"
Environment="BOT_ERRORS_WATCHDOG_CHECKS=fleet_sentinel,collector_roster"
Environment="BOT_ERRORS_FLEET_SENTINEL_HOSTS=$hosts_q"
Environment="BOT_ERRORS_FLEET_SENTINEL_HEARTBEAT=$sentinel_heartbeat_q"
Environment="BOT_ERRORS_MAX_FLEET_SENTINEL_AGE=$watchdog_max_age_q"
ExecStart=$py_q $watchdog_script_q --once --max-fleet-sentinel-age $watchdog_max_age_q
SyslogIdentifier=bot-errors-sentinel-watchdog
SERVICE

  cat > "$watchdog_timer" <<TIMER
[Unit]
Description=Run BOT ERRORS Fleet Sentinel central heartbeat watchdog

[Timer]
OnActiveSec=1m
OnUnitActiveSec=${WATCHDOG_INTERVAL_SECONDS}s
RandomizedDelaySec=${WATCHDOG_RANDOMIZED_DELAY_SECONDS}s
AccuracySec=1m
Persistent=true
Unit=$WATCHDOG_UNIT.service

[Install]
WantedBy=timers.target
TIMER
  chmod 644 "$service" "$timer" "$watchdog_service" "$watchdog_timer"
  if [[ "$DRY_RUN" != "1" ]]; then
    command -v systemctl >/dev/null 2>&1 || fail_config "systemctl unavailable"
    systemctl --user daemon-reload
    systemctl --user enable --now "$UNIT.timer"
    systemctl --user enable --now "$WATCHDOG_UNIT.timer"
  fi
  echo "installed $UNIT $WATCHDOG_UNIT platform=systemd dry_run=$DRY_RUN interval=${INTERVAL_SECONDS}s watchdog_interval=${WATCHDOG_INTERVAL_SECONDS}s path=$timer watchdog_path=$watchdog_timer"
}

main() {
  require_interval
  require_python
  require_file "$SENTINEL_SCRIPT" "BOT ERRORS sentinel file"
  require_file "$WATCHDOG_SCRIPT" "BOT ERRORS heartbeat watchdog file"
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
