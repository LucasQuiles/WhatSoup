#!/usr/bin/env bash
set -euo pipefail

S=deploy/scripts/install-bot-errors-sentinel.sh
bash -n "$S" || { echo "SENTINEL_INSTALLER_FAIL syntax"; exit 1; }

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

fakebin="$tmp/fakebin"
mkdir -p "$fakebin"
for cmd in launchctl plutil systemctl; do
  cat > "$fakebin/$cmd" <<'SH'
#!/usr/bin/env bash
echo "unexpected activation command: $0 $*" >&2
exit 99
SH
  chmod +x "$fakebin/$cmd"
done

repo="$tmp/root"
mkdir -p "$repo/deploy/scripts"
touch "$repo/deploy/scripts/bot-errors-sentinel.py"
touch "$repo/deploy/scripts/bot-errors-heartbeat-watchdog.py"
cat > "$repo/deploy/bot-errors-expected-fleet.json" <<'JSON'
{"schemaVersion":1,"hosts":[{"host":"host-a","profile":"host-a.json","instances":[]}]}
JSON
hosts="$tmp/hosts&fleet.json"
cat > "$hosts" <<'JSON'
{"schemaVersion":1,"hosts":[{"host":"host-a"}]}
JSON

common_env=(
  BOT_ERRORS_REPO_ROOT="$repo"
  BOT_ERRORS_STATE_DIR="$tmp/state"
  BOT_ERRORS_FLEET_SENTINEL_STATE_DIR="$tmp/state/fleet-sentinel"
  BOT_ERRORS_FLEET_SENTINEL_HOSTS="$hosts"
  BOT_ERRORS_FLEET_SENTINEL_ORACLE="$tmp/oracle&gateway.json"
  BOT_ERRORS_FLEET_SENTINEL_ACTION_OUTBOX_DIR="$tmp/actions&fleet"
  BOT_ERRORS_PYTHON="/usr/bin/python3"
  BOT_ERRORS_FLEET_SENTINEL_INSTALL_DRY_RUN=1
  BOT_ERRORS_FLEET_SENTINEL_INTERVAL_SECONDS=1800
  BOT_ERRORS_FLEET_SENTINEL_RANDOMIZED_DELAY_SECONDS=120
  BOT_ERRORS_FLEET_SENTINEL_WATCHDOG_INTERVAL_SECONDS=300
  BOT_ERRORS_FLEET_SENTINEL_WATCHDOG_RANDOMIZED_DELAY_SECONDS=60
  BOT_ERRORS_FLEET_SENTINEL_WATCHDOG_MAX_AGE_SECONDS=2700
  BOT_ERRORS_FLEET_SENTINEL_HEARTBEAT_MAX_AGE_SECONDS=2700
  BOT_ERRORS_FLEET_SENTINEL_HYSTERESIS_CYCLES=2
  BOT_ERRORS_FLEET_SENTINEL_CONNECTIVITY_HYSTERESIS_CYCLES=3
  BOT_ERRORS_FLEET_SENTINEL_FLAP_WINDOW_SECONDS=21600
  BOT_ERRORS_FLEET_SENTINEL_FLAP_THRESHOLD=4
  BOT_ERRORS_FLEET_SENTINEL_MAX_TIER1_HEAL_CANDIDATES=2
  BOT_ERRORS_FLEET_SENTINEL_CORRELATED_DRIFT_FREEZE_THRESHOLD=2
  BOT_ERRORS_FLEET_SENTINEL_MAX_CLOCK_SKEW_SECONDS=300
  BOT_ERRORS_FLEET_SENTINEL_ACTION_EVENT_COOLDOWN_SECONDS=21600
  BOT_ERRORS_FLEET_SENTINEL_MAX_CRITICAL_WHATSAPP_PER_DAY=8
  BOT_ERRORS_FLEET_SENTINEL_TIER2_TOKEN_TTL_SECONDS=1800
  BOT_ERRORS_FLEET_SENTINEL_Q_HOST="q-agent-host"
)

PATH="$fakebin:$PATH" env "${common_env[@]}" \
  BOT_ERRORS_FLEET_SENTINEL_PLATFORM=launchd \
  BOT_ERRORS_LAUNCH_AGENTS_DIR="$tmp/LaunchAgents" \
  bash "$S" > "$tmp/launchd.out" 2> "$tmp/launchd.err"

plist="$tmp/LaunchAgents/com.bot-errors.sentinel.plist"
watchdog_plist="$tmp/LaunchAgents/com.bot-errors.sentinel.watchdog.plist"
[[ -f "$plist" ]] || { echo "SENTINEL_INSTALLER_FAIL missing launchd plist"; cat "$tmp/launchd.err"; exit 1; }
[[ -f "$watchdog_plist" ]] || { echo "SENTINEL_INSTALLER_FAIL missing launchd watchdog plist"; cat "$tmp/launchd.err"; exit 1; }
grep -q '<key>StartInterval</key><integer>1800</integer>' "$plist" || { echo "SENTINEL_INSTALLER_FAIL launchd interval"; cat "$plist"; exit 1; }
grep -q '<key>SuccessfulExit</key><false/>' "$plist" || { echo "SENTINEL_INSTALLER_FAIL launchd restart-on-failure"; cat "$plist"; exit 1; }
# KeepAlive{SuccessfulExit:false} respawns on every non-zero exit (e.g. the
# result_requires_attention exit-1 path). Without ThrottleInterval launchd
# respawns + re-probes in a tight loop during an incident. Rate-limit it.
grep -q '<key>ThrottleInterval</key><integer>60</integer>' "$plist" || { echo "SENTINEL_INSTALLER_FAIL launchd throttle interval"; cat "$plist"; exit 1; }
grep -q '<string>--hosts</string>' "$plist" || { echo "SENTINEL_INSTALLER_FAIL launchd hosts arg missing"; cat "$plist"; exit 1; }
grep -q '<string>--state-dir</string>' "$plist" || { echo "SENTINEL_INSTALLER_FAIL launchd state arg missing"; cat "$plist"; exit 1; }
grep -q "$repo/deploy/scripts/bot-errors-sentinel.py" "$plist" || { echo "SENTINEL_INSTALLER_FAIL launchd script path"; cat "$plist"; exit 1; }
grep -q 'hosts&amp;fleet.json' "$plist" || { echo "SENTINEL_INSTALLER_FAIL launchd xml escaping"; cat "$plist"; exit 1; }
grep -q 'oracle&amp;gateway.json' "$plist" || { echo "SENTINEL_INSTALLER_FAIL launchd oracle escaping"; cat "$plist"; exit 1; }
grep -q 'actions&amp;fleet' "$plist" || { echo "SENTINEL_INSTALLER_FAIL launchd action outbox escaping"; cat "$plist"; exit 1; }
grep -q 'BOT_ERRORS_FLEET_SENTINEL_HYSTERESIS_CYCLES' "$plist" || { echo "SENTINEL_INSTALLER_FAIL launchd threshold env"; cat "$plist"; exit 1; }
grep -q 'BOT_ERRORS_FLEET_SENTINEL_CONNECTIVITY_HYSTERESIS_CYCLES' "$plist" || { echo "SENTINEL_INSTALLER_FAIL launchd connectivity threshold env"; cat "$plist"; exit 1; }
grep -q 'BOT_ERRORS_FLEET_SENTINEL_MAX_TIER1_HEAL_CANDIDATES' "$plist" || { echo "SENTINEL_INSTALLER_FAIL launchd tier1 cap env"; cat "$plist"; exit 1; }
grep -q 'BOT_ERRORS_FLEET_SENTINEL_CORRELATED_DRIFT_FREEZE_THRESHOLD' "$plist" || { echo "SENTINEL_INSTALLER_FAIL launchd correlated freeze env"; cat "$plist"; exit 1; }
grep -q 'BOT_ERRORS_FLEET_SENTINEL_MAX_CLOCK_SKEW_SECONDS' "$plist" || { echo "SENTINEL_INSTALLER_FAIL launchd clock skew env"; cat "$plist"; exit 1; }
grep -q 'BOT_ERRORS_FLEET_SENTINEL_ACTION_EVENT_COOLDOWN_SECONDS' "$plist" || { echo "SENTINEL_INSTALLER_FAIL launchd action cooldown env"; cat "$plist"; exit 1; }
grep -q 'BOT_ERRORS_FLEET_SENTINEL_MAX_CRITICAL_WHATSAPP_PER_DAY' "$plist" || { echo "SENTINEL_INSTALLER_FAIL launchd whatsapp cap env"; cat "$plist"; exit 1; }
grep -q 'BOT_ERRORS_FLEET_SENTINEL_TIER2_TOKEN_TTL_SECONDS' "$plist" || { echo "SENTINEL_INSTALLER_FAIL launchd tier2 token ttl env"; cat "$plist"; exit 1; }
grep -q 'BOT_ERRORS_FLEET_SENTINEL_Q_HOST' "$plist" || { echo "SENTINEL_INSTALLER_FAIL launchd q host env"; cat "$plist"; exit 1; }
# #2436: launchd has no EnvironmentFile equivalent, so any supported runtime
# control missing from the plist dict is unreachable on macOS. Defaults must
# match the bot-errors-sentinel.py fallbacks so installing changes nothing
# for unset variables.
grep -q '<key>BOT_ERRORS_FLEET_SENTINEL_ACTION_OUTBOX_RETENTION</key><string>500</string>' "$plist" || { echo "SENTINEL_INSTALLER_FAIL launchd action outbox retention env"; cat "$plist"; exit 1; }
grep -qF "<key>BOT_ERRORS_FLEET_SENTINEL_LOCK</key><string>$HOME/.local/state/bot-errors/fleet-sentinel/sentinel-instance.lock</string>" "$plist" || { echo "SENTINEL_INSTALLER_FAIL launchd instance lock env"; cat "$plist"; exit 1; }
grep -q '<key>BOT_ERRORS_FLEET_SENTINEL_SSH_COMMAND</key><string>ssh</string>' "$plist" || { echo "SENTINEL_INSTALLER_FAIL launchd ssh command env"; cat "$plist"; exit 1; }
grep -q '<key>BOT_ERRORS_FLEET_SENTINEL_SSH_CONNECT_TIMEOUT_SECONDS</key><string>8</string>' "$plist" || { echo "SENTINEL_INSTALLER_FAIL launchd ssh connect timeout env"; cat "$plist"; exit 1; }
grep -q '<key>BOT_ERRORS_FLEET_SENTINEL_SSH_PROBE_TIMEOUT_SECONDS</key><string>30</string>' "$plist" || { echo "SENTINEL_INSTALLER_FAIL launchd ssh probe timeout env"; cat "$plist"; exit 1; }
grep -q '<string>--max-fleet-sentinel-age</string>' "$watchdog_plist" || { echo "SENTINEL_INSTALLER_FAIL launchd watchdog max-age arg"; cat "$watchdog_plist"; exit 1; }
grep -q '<key>StartInterval</key><integer>300</integer>' "$watchdog_plist" || { echo "SENTINEL_INSTALLER_FAIL launchd watchdog interval"; cat "$watchdog_plist"; exit 1; }
grep -q '<key>BOT_ERRORS_WATCHDOG_CHECKS</key><string>fleet_sentinel,collector_roster</string>' "$watchdog_plist" || { echo "SENTINEL_INSTALLER_FAIL launchd watchdog checks env"; cat "$watchdog_plist"; exit 1; }
grep -q '<key>BOT_ERRORS_FLEET_SENTINEL_HOSTS</key>' "$watchdog_plist" || { echo "SENTINEL_INSTALLER_FAIL launchd watchdog roster hosts env"; cat "$watchdog_plist"; exit 1; }
grep -q '<key>BOT_ERRORS_FLEET_SENTINEL_HEARTBEAT</key>' "$watchdog_plist" || { echo "SENTINEL_INSTALLER_FAIL launchd watchdog heartbeat env"; cat "$watchdog_plist"; exit 1; }
grep -q 'dry_run=1' "$tmp/launchd.out" || { echo "SENTINEL_INSTALLER_FAIL launchd dry-run output"; cat "$tmp/launchd.out"; exit 1; }
[[ ! -s "$tmp/launchd.err" ]] || { echo "SENTINEL_INSTALLER_FAIL launchd invoked activation"; cat "$tmp/launchd.err"; exit 1; }

PATH="$fakebin:$PATH" env "${common_env[@]}" \
  BOT_ERRORS_FLEET_SENTINEL_PLATFORM=systemd \
  BOT_ERRORS_SYSTEMD_USER_DIR="$tmp/systemd" \
  bash "$S" > "$tmp/systemd.out" 2> "$tmp/systemd.err"

service="$tmp/systemd/bot-errors-sentinel.service"
timer="$tmp/systemd/bot-errors-sentinel.timer"
watchdog_service="$tmp/systemd/bot-errors-sentinel-watchdog.service"
watchdog_timer="$tmp/systemd/bot-errors-sentinel-watchdog.timer"
[[ -f "$service" && -f "$timer" && -f "$watchdog_service" && -f "$watchdog_timer" ]] || { echo "SENTINEL_INSTALLER_FAIL missing systemd files"; cat "$tmp/systemd.err"; exit 1; }
grep -q '^ExecStart=/usr/bin/python3 .*bot-errors-sentinel.py --hosts ' "$service" || { echo "SENTINEL_INSTALLER_FAIL systemd exec"; cat "$service"; exit 1; }
grep -q '^Restart=on-failure$' "$service" || { echo "SENTINEL_INSTALLER_FAIL systemd restart-on-failure"; cat "$service"; exit 1; }
grep -q '^Environment="BOT_ERRORS_FLEET_SENTINEL_HOSTS=' "$service" || { echo "SENTINEL_INSTALLER_FAIL systemd hosts env"; cat "$service"; exit 1; }
grep -q '^Environment="BOT_ERRORS_FLEET_SENTINEL_ORACLE=' "$service" || { echo "SENTINEL_INSTALLER_FAIL systemd oracle env"; cat "$service"; exit 1; }
grep -q '^Environment="BOT_ERRORS_FLEET_SENTINEL_ACTION_OUTBOX_DIR=' "$service" || { echo "SENTINEL_INSTALLER_FAIL systemd action outbox env"; cat "$service"; exit 1; }
grep -q '^Environment="BOT_ERRORS_FLEET_SENTINEL_CONNECTIVITY_HYSTERESIS_CYCLES=' "$service" || { echo "SENTINEL_INSTALLER_FAIL systemd connectivity threshold env"; cat "$service"; exit 1; }
grep -q '^Environment="BOT_ERRORS_FLEET_SENTINEL_MAX_TIER1_HEAL_CANDIDATES=' "$service" || { echo "SENTINEL_INSTALLER_FAIL systemd tier1 cap env"; cat "$service"; exit 1; }
grep -q '^Environment="BOT_ERRORS_FLEET_SENTINEL_CORRELATED_DRIFT_FREEZE_THRESHOLD=' "$service" || { echo "SENTINEL_INSTALLER_FAIL systemd correlated freeze env"; cat "$service"; exit 1; }
grep -q '^Environment="BOT_ERRORS_FLEET_SENTINEL_MAX_CLOCK_SKEW_SECONDS=' "$service" || { echo "SENTINEL_INSTALLER_FAIL systemd clock skew env"; cat "$service"; exit 1; }
grep -q '^Environment="BOT_ERRORS_FLEET_SENTINEL_ACTION_EVENT_COOLDOWN_SECONDS=' "$service" || { echo "SENTINEL_INSTALLER_FAIL systemd action cooldown env"; cat "$service"; exit 1; }
grep -q '^Environment="BOT_ERRORS_FLEET_SENTINEL_MAX_CRITICAL_WHATSAPP_PER_DAY=' "$service" || { echo "SENTINEL_INSTALLER_FAIL systemd whatsapp cap env"; cat "$service"; exit 1; }
grep -q '^Environment="BOT_ERRORS_FLEET_SENTINEL_TIER2_TOKEN_TTL_SECONDS=' "$service" || { echo "SENTINEL_INSTALLER_FAIL systemd tier2 token ttl env"; cat "$service"; exit 1; }
grep -q '^Environment="BOT_ERRORS_FLEET_SENTINEL_Q_HOST=' "$service" || { echo "SENTINEL_INSTALLER_FAIL systemd q host env"; cat "$service"; exit 1; }
# #2436: the five launchd-only additions must NOT be baked into the systemd
# unit — Linux hydrates them from the canonical environment file so they stay
# editable without reinstall, and that hydration line must survive.
grep -q '^EnvironmentFile=-%h/.config/whatsoup/bot-errors.env$' "$service" || { echo "SENTINEL_INSTALLER_FAIL systemd env-file hydration"; cat "$service"; exit 1; }
for key in ACTION_OUTBOX_RETENTION LOCK SSH_COMMAND SSH_CONNECT_TIMEOUT_SECONDS SSH_PROBE_TIMEOUT_SECONDS; do
  if grep -q "BOT_ERRORS_FLEET_SENTINEL_$key=" "$service"; then
    echo "SENTINEL_INSTALLER_FAIL systemd baked $key"
    cat "$service"
    exit 1
  fi
done
grep -q '^OnUnitActiveSec=1800s$' "$timer" || { echo "SENTINEL_INSTALLER_FAIL systemd interval"; cat "$timer"; exit 1; }
grep -q '^RandomizedDelaySec=120s$' "$timer" || { echo "SENTINEL_INSTALLER_FAIL systemd randomized delay"; cat "$timer"; exit 1; }
grep -q '^Persistent=true$' "$timer" || { echo "SENTINEL_INSTALLER_FAIL systemd persistent"; cat "$timer"; exit 1; }
grep -q '^ExecStart=/usr/bin/python3 .*bot-errors-heartbeat-watchdog.py --once --max-fleet-sentinel-age ' "$watchdog_service" || { echo "SENTINEL_INSTALLER_FAIL systemd watchdog exec"; cat "$watchdog_service"; exit 1; }
grep -q '^Environment="BOT_ERRORS_WATCHDOG_CHECKS=fleet_sentinel,collector_roster"$' "$watchdog_service" || { echo "SENTINEL_INSTALLER_FAIL systemd watchdog checks env"; cat "$watchdog_service"; exit 1; }
grep -q '^Environment="BOT_ERRORS_FLEET_SENTINEL_HOSTS=' "$watchdog_service" || { echo "SENTINEL_INSTALLER_FAIL systemd watchdog roster hosts env"; cat "$watchdog_service"; exit 1; }
grep -q '^Environment="BOT_ERRORS_FLEET_SENTINEL_HEARTBEAT=' "$watchdog_service" || { echo "SENTINEL_INSTALLER_FAIL systemd watchdog heartbeat env"; cat "$watchdog_service"; exit 1; }
grep -q '^OnUnitActiveSec=300s$' "$watchdog_timer" || { echo "SENTINEL_INSTALLER_FAIL systemd watchdog interval"; cat "$watchdog_timer"; exit 1; }
grep -q '^RandomizedDelaySec=60s$' "$watchdog_timer" || { echo "SENTINEL_INSTALLER_FAIL systemd watchdog randomized delay"; cat "$watchdog_timer"; exit 1; }
grep -q '^Persistent=true$' "$watchdog_timer" || { echo "SENTINEL_INSTALLER_FAIL systemd watchdog persistent"; cat "$watchdog_timer"; exit 1; }
grep -q 'dry_run=1' "$tmp/systemd.out" || { echo "SENTINEL_INSTALLER_FAIL systemd dry-run output"; cat "$tmp/systemd.out"; exit 1; }
[[ ! -s "$tmp/systemd.err" ]] || { echo "SENTINEL_INSTALLER_FAIL systemd invoked activation"; cat "$tmp/systemd.err"; exit 1; }

PATH="$fakebin:$PATH" env \
  BOT_ERRORS_REPO_ROOT="$repo" \
  BOT_ERRORS_STATE_DIR="$tmp/default-state" \
  BOT_ERRORS_FLEET_SENTINEL_STATE_DIR="$tmp/default-state/fleet-sentinel" \
  BOT_ERRORS_FLEET_SENTINEL_ORACLE="$tmp/default-oracle.json" \
  BOT_ERRORS_FLEET_SENTINEL_ACTION_OUTBOX_DIR="$tmp/default-actions" \
  BOT_ERRORS_PYTHON="/usr/bin/python3" \
  BOT_ERRORS_FLEET_SENTINEL_INSTALL_DRY_RUN=1 \
  BOT_ERRORS_FLEET_SENTINEL_PLATFORM=systemd \
  BOT_ERRORS_SYSTEMD_USER_DIR="$tmp/default-systemd" \
  bash "$S" > "$tmp/default-hosts.out" 2> "$tmp/default-hosts.err"
default_service="$tmp/default-systemd/bot-errors-sentinel.service"
[[ -f "$default_service" ]] || { echo "SENTINEL_INSTALLER_FAIL missing default-hosts systemd service"; cat "$tmp/default-hosts.err"; exit 1; }
grep -q 'bot-errors-expected-fleet.json' "$default_service" || { echo "SENTINEL_INSTALLER_FAIL expected-fleet default hosts path"; cat "$default_service"; exit 1; }
grep -q 'dry_run=1' "$tmp/default-hosts.out" || { echo "SENTINEL_INSTALLER_FAIL default-hosts dry-run output"; cat "$tmp/default-hosts.out"; exit 1; }
[[ ! -s "$tmp/default-hosts.err" ]] || { echo "SENTINEL_INSTALLER_FAIL default-hosts invoked activation"; cat "$tmp/default-hosts.err"; exit 1; }

chmodbin="$tmp/chmodbin"
mkdir -p "$chmodbin"
cat > "$chmodbin/chmod" <<'SH'
#!/usr/bin/env bash
if [ "${1:-}" = "700" ]; then
  echo "chmod denied for secure state dirs" >&2
  exit 99
fi
exec /bin/chmod "$@"
SH
chmod +x "$chmodbin/chmod"
if PATH="$chmodbin:$PATH" env "${common_env[@]}" \
  BOT_ERRORS_FLEET_SENTINEL_PLATFORM=systemd \
  BOT_ERRORS_SYSTEMD_USER_DIR="$tmp/chmod-systemd" \
  bash "$S" > "$tmp/chmod.out" 2> "$tmp/chmod.err"; then
  echo "SENTINEL_INSTALLER_FAIL continued after chmod failure"
  exit 1
fi
grep -q 'cannot secure BOT ERRORS sentinel state directories' "$tmp/chmod.err" || {
  echo "SENTINEL_INSTALLER_FAIL chmod failure reason"
  cat "$tmp/chmod.err"
  exit 1
}

activatebin="$tmp/activatebin"
mkdir -p "$activatebin"
cat > "$activatebin/plutil" <<'SH'
#!/usr/bin/env bash
exit 0
SH
cat > "$activatebin/launchctl" <<'SH'
#!/usr/bin/env bash
if [ "${1:-}" = "enable" ]; then
  echo "enable denied" >&2
  exit 42
fi
exit 0
SH
chmod +x "$activatebin/plutil" "$activatebin/launchctl"
if PATH="$activatebin:$PATH" env "${common_env[@]}" \
  BOT_ERRORS_FLEET_SENTINEL_INSTALL_DRY_RUN=0 \
  BOT_ERRORS_FLEET_SENTINEL_PLATFORM=launchd \
  BOT_ERRORS_LAUNCH_AGENTS_DIR="$tmp/enable-fail-LaunchAgents" \
  bash "$S" > "$tmp/enable-fail.out" 2> "$tmp/enable-fail.err"; then
  echo "SENTINEL_INSTALLER_FAIL continued after launchctl enable failure"
  exit 1
fi
grep -q 'cannot enable BOT ERRORS sentinel launchd job' "$tmp/enable-fail.err" || {
  echo "SENTINEL_INSTALLER_FAIL launchctl enable failure reason"
  cat "$tmp/enable-fail.err"
  exit 1
}

badroot="$tmp/bad-root"
mkdir -p "$badroot/deploy/scripts"
if env BOT_ERRORS_REPO_ROOT="$badroot" BOT_ERRORS_FLEET_SENTINEL_HOSTS="$hosts" BOT_ERRORS_FLEET_SENTINEL_PLATFORM=launchd BOT_ERRORS_FLEET_SENTINEL_INSTALL_DRY_RUN=1 bash "$S" > "$tmp/missing-script.out" 2> "$tmp/missing-script.err"; then
  echo "SENTINEL_INSTALLER_FAIL accepted missing sentinel script"
  exit 1
fi
grep -q 'NOT READY: missing required BOT ERRORS sentinel file' "$tmp/missing-script.err" || { echo "SENTINEL_INSTALLER_FAIL missing-script reason"; cat "$tmp/missing-script.err"; exit 1; }

if env "${common_env[@]}" BOT_ERRORS_FLEET_SENTINEL_HOSTS="$tmp/missing-hosts.json" BOT_ERRORS_FLEET_SENTINEL_PLATFORM=systemd bash "$S" > "$tmp/missing-hosts.out" 2> "$tmp/missing-hosts.err"; then
  echo "SENTINEL_INSTALLER_FAIL accepted missing hosts file"
  exit 1
fi
grep -q 'NOT READY: missing required BOT ERRORS sentinel hosts file' "$tmp/missing-hosts.err" || { echo "SENTINEL_INSTALLER_FAIL missing-hosts reason"; cat "$tmp/missing-hosts.err"; exit 1; }

if env "${common_env[@]}" BOT_ERRORS_FLEET_SENTINEL_INTERVAL_SECONDS=299 BOT_ERRORS_FLEET_SENTINEL_PLATFORM=systemd bash "$S" > "$tmp/interval.out" 2> "$tmp/interval.err"; then
  echo "SENTINEL_INSTALLER_FAIL accepted too-short interval"
  exit 1
fi
grep -q 'must be at least 300' "$tmp/interval.err" || { echo "SENTINEL_INSTALLER_FAIL interval reason"; cat "$tmp/interval.err"; exit 1; }

if env "${common_env[@]}" BOT_ERRORS_FLEET_SENTINEL_RANDOMIZED_DELAY_SECONDS=1801 BOT_ERRORS_FLEET_SENTINEL_PLATFORM=systemd bash "$S" > "$tmp/jitter.out" 2> "$tmp/jitter.err"; then
  echo "SENTINEL_INSTALLER_FAIL accepted randomized delay above interval"
  exit 1
fi
grep -q 'RANDOMIZED_DELAY_SECONDS must not exceed' "$tmp/jitter.err" || {
  echo "SENTINEL_INSTALLER_FAIL randomized delay reason"
  cat "$tmp/jitter.err"
  exit 1
}

if env "${common_env[@]}" BOT_ERRORS_FLEET_SENTINEL_WATCHDOG_RANDOMIZED_DELAY_SECONDS=301 BOT_ERRORS_FLEET_SENTINEL_PLATFORM=systemd bash "$S" > "$tmp/watchdog-jitter.out" 2> "$tmp/watchdog-jitter.err"; then
  echo "SENTINEL_INSTALLER_FAIL accepted watchdog randomized delay above interval"
  exit 1
fi
grep -q 'WATCHDOG_RANDOMIZED_DELAY_SECONDS must not exceed' "$tmp/watchdog-jitter.err" || {
  echo "SENTINEL_INSTALLER_FAIL watchdog randomized delay reason"
  cat "$tmp/watchdog-jitter.err"
  exit 1
}

if env "${common_env[@]}" BOT_ERRORS_PYTHON=python3 BOT_ERRORS_FLEET_SENTINEL_PLATFORM=systemd bash "$S" > "$tmp/relative-python.out" 2> "$tmp/relative-python.err"; then
  echo "SENTINEL_INSTALLER_FAIL accepted relative python path"
  exit 1
fi
grep -q 'BOT_ERRORS_PYTHON must be an absolute executable path' "$tmp/relative-python.err" || {
  echo "SENTINEL_INSTALLER_FAIL relative python reason"
  cat "$tmp/relative-python.err"
  exit 1
}

not_python="$tmp/not-python"
: > "$not_python"
if env "${common_env[@]}" BOT_ERRORS_PYTHON="$not_python" BOT_ERRORS_FLEET_SENTINEL_PLATFORM=systemd bash "$S" > "$tmp/nonexec-python.out" 2> "$tmp/nonexec-python.err"; then
  echo "SENTINEL_INSTALLER_FAIL accepted non-executable python path"
  exit 1
fi
grep -q 'BOT_ERRORS_PYTHON must be an absolute executable path' "$tmp/nonexec-python.err" || {
  echo "SENTINEL_INSTALLER_FAIL non-executable python reason"
  cat "$tmp/nonexec-python.err"
  exit 1
}

echo "SENTINEL_INSTALLER_PASS"
