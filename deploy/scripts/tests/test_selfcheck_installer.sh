#!/usr/bin/env bash
set -euo pipefail

S=deploy/scripts/install-bot-errors-selfcheck.sh
bash -n "$S" || { echo "SELFCHECK_INSTALLER_FAIL syntax"; exit 1; }

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
touch "$repo/deploy/scripts/bot-errors-selfcheck.py"
touch "$repo/deploy/scripts/whatsoup-bot-errors-deploy.sh"

common_env=(
  BOT_ERRORS_REPO_ROOT="$repo"
  BOT_ERRORS_STATE_DIR="$tmp/state"
  BOT_ERRORS_SENTINEL_STATE_DIR="$tmp/state/sentinel"
  BOT_ERRORS_PYTHON="/usr/bin/python3"
  BOT_ERRORS_SELFCHECK_INSTALL_DRY_RUN=1
  BOT_ERRORS_SELFCHECK_INTERVAL_SECONDS=1800
  BOT_ERRORS_SELFCHECK_RANDOMIZED_DELAY_SECONDS=120
  BOT_ERRORS_SELFCHECK_UNITS="com.bot-errors.health=loaded"
  BOT_ERRORS_SELFCHECK_FRESHNESS_JSON='[{"name":"daily-health","path":"/tmp/last&run","maxAgeSeconds":3600}]'
  BOT_ERRORS_SELFCHECK_HEARTBEAT_URL="http://central.invalid/heartbeat?x=1&y=2"
  BOT_ERRORS_SELFCHECK_CENTRAL_ACK="$tmp/state/fleet-sentinel/central-ack.json"
  BOT_ERRORS_SELFCHECK_CENTRAL_DOWN_ALERT="$tmp/state/sentinel/actions/central-down&alert.json"
  BOT_ERRORS_SELFCHECK_CENTRAL_DOWN_MAX_AGE_SECONDS=7200
  BOT_ERRORS_SELFCHECK_HEAL_MIN_FREE_BYTES=67108864
)

PATH="$fakebin:$PATH" env "${common_env[@]}" \
  BOT_ERRORS_SELFCHECK_PLATFORM=launchd \
  BOT_ERRORS_LAUNCH_AGENTS_DIR="$tmp/LaunchAgents" \
  bash "$S" > "$tmp/launchd.out" 2> "$tmp/launchd.err"

plist="$tmp/LaunchAgents/com.bot-errors.selfcheck.plist"
[[ -f "$plist" ]] || { echo "SELFCHECK_INSTALLER_FAIL missing launchd plist"; cat "$tmp/launchd.err"; exit 1; }
grep -q '<key>StartInterval</key><integer>1800</integer>' "$plist" || { echo "SELFCHECK_INSTALLER_FAIL launchd interval"; cat "$plist"; exit 1; }
grep -q '<key>RunAtLoad</key><true/>' "$plist" || { echo "SELFCHECK_INSTALLER_FAIL launchd run-at-load"; cat "$plist"; exit 1; }
grep -q '<string>--root</string>' "$plist" || { echo "SELFCHECK_INSTALLER_FAIL launchd root arg missing"; cat "$plist"; exit 1; }
grep -q "$repo/deploy/scripts/bot-errors-selfcheck.py" "$plist" || { echo "SELFCHECK_INSTALLER_FAIL launchd script path"; cat "$plist"; exit 1; }
grep -q '/tmp/last&amp;run' "$plist" || { echo "SELFCHECK_INSTALLER_FAIL launchd xml escaping"; cat "$plist"; exit 1; }
grep -q 'central-down&amp;alert.json' "$plist" || { echo "SELFCHECK_INSTALLER_FAIL launchd central alert escaping"; cat "$plist"; exit 1; }
grep -q '<key>BOT_ERRORS_SELFCHECK_CENTRAL_DOWN_MAX_AGE_SECONDS</key><string>7200</string>' "$plist" || { echo "SELFCHECK_INSTALLER_FAIL launchd central down threshold"; cat "$plist"; exit 1; }
grep -q '<key>BOT_ERRORS_SELFCHECK_HEAL_MIN_FREE_BYTES</key><string>67108864</string>' "$plist" || { echo "SELFCHECK_INSTALLER_FAIL launchd heal disk reserve"; cat "$plist"; exit 1; }
grep -q 'dry_run=1' "$tmp/launchd.out" || { echo "SELFCHECK_INSTALLER_FAIL launchd dry-run output"; cat "$tmp/launchd.out"; exit 1; }
[[ ! -s "$tmp/launchd.err" ]] || { echo "SELFCHECK_INSTALLER_FAIL launchd invoked activation"; cat "$tmp/launchd.err"; exit 1; }

PATH="$fakebin:$PATH" env "${common_env[@]}" \
  BOT_ERRORS_SELFCHECK_PLATFORM=systemd \
  BOT_ERRORS_SYSTEMD_USER_DIR="$tmp/systemd" \
  bash "$S" > "$tmp/systemd.out" 2> "$tmp/systemd.err"

service="$tmp/systemd/bot-errors-selfcheck.service"
timer="$tmp/systemd/bot-errors-selfcheck.timer"
[[ -f "$service" && -f "$timer" ]] || { echo "SELFCHECK_INSTALLER_FAIL missing systemd files"; cat "$tmp/systemd.err"; exit 1; }
grep -q '^ExecStart=/usr/bin/python3 .*bot-errors-selfcheck.py --root ' "$service" || { echo "SELFCHECK_INSTALLER_FAIL systemd exec"; cat "$service"; exit 1; }
grep -q '^Environment="BOT_ERRORS_STATE_DIR=' "$service" || { echo "SELFCHECK_INSTALLER_FAIL systemd state env"; cat "$service"; exit 1; }
grep -q '^Environment="BOT_ERRORS_SELFCHECK_CENTRAL_DOWN_ALERT=.*central-down&alert.json"' "$service" || { echo "SELFCHECK_INSTALLER_FAIL systemd central alert env"; cat "$service"; exit 1; }
grep -q '^Environment="BOT_ERRORS_SELFCHECK_CENTRAL_DOWN_MAX_AGE_SECONDS=7200"' "$service" || { echo "SELFCHECK_INSTALLER_FAIL systemd central down threshold"; cat "$service"; exit 1; }
grep -q '^Environment="BOT_ERRORS_SELFCHECK_HEAL_MIN_FREE_BYTES=67108864"' "$service" || { echo "SELFCHECK_INSTALLER_FAIL systemd heal disk reserve"; cat "$service"; exit 1; }
grep -q '^OnUnitActiveSec=1800s$' "$timer" || { echo "SELFCHECK_INSTALLER_FAIL systemd interval"; cat "$timer"; exit 1; }
grep -q '^RandomizedDelaySec=120s$' "$timer" || { echo "SELFCHECK_INSTALLER_FAIL systemd randomized delay"; cat "$timer"; exit 1; }
grep -q '^Persistent=true$' "$timer" || { echo "SELFCHECK_INSTALLER_FAIL systemd persistent"; cat "$timer"; exit 1; }
grep -q 'dry_run=1' "$tmp/systemd.out" || { echo "SELFCHECK_INSTALLER_FAIL systemd dry-run output"; cat "$tmp/systemd.out"; exit 1; }
[[ ! -s "$tmp/systemd.err" ]] || { echo "SELFCHECK_INSTALLER_FAIL systemd invoked activation"; cat "$tmp/systemd.err"; exit 1; }

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
  BOT_ERRORS_SELFCHECK_PLATFORM=systemd \
  BOT_ERRORS_SYSTEMD_USER_DIR="$tmp/chmod-systemd" \
  bash "$S" > "$tmp/chmod.out" 2> "$tmp/chmod.err"; then
  echo "SELFCHECK_INSTALLER_FAIL continued after chmod failure"
  exit 1
fi
grep -q 'cannot secure BOT ERRORS selfcheck state directories' "$tmp/chmod.err" || {
  echo "SELFCHECK_INSTALLER_FAIL chmod failure reason"
  cat "$tmp/chmod.err"
  exit 1
}

badroot="$tmp/bad-root"
mkdir -p "$badroot/deploy/scripts"
touch "$badroot/deploy/scripts/whatsoup-bot-errors-deploy.sh"
if env BOT_ERRORS_REPO_ROOT="$badroot" BOT_ERRORS_SELFCHECK_PLATFORM=launchd BOT_ERRORS_SELFCHECK_INSTALL_DRY_RUN=1 bash "$S" > "$tmp/missing.out" 2> "$tmp/missing.err"; then
  echo "SELFCHECK_INSTALLER_FAIL accepted missing selfcheck script"
  exit 1
fi
grep -q 'NOT READY: missing required BOT ERRORS selfcheck file' "$tmp/missing.err" || { echo "SELFCHECK_INSTALLER_FAIL missing-file reason"; cat "$tmp/missing.err"; exit 1; }

if env "${common_env[@]}" BOT_ERRORS_SELFCHECK_INTERVAL_SECONDS=299 BOT_ERRORS_SELFCHECK_PLATFORM=systemd bash "$S" > "$tmp/interval.out" 2> "$tmp/interval.err"; then
  echo "SELFCHECK_INSTALLER_FAIL accepted too-short interval"
  exit 1
fi
grep -q 'must be at least 300' "$tmp/interval.err" || { echo "SELFCHECK_INSTALLER_FAIL interval reason"; cat "$tmp/interval.err"; exit 1; }

if env "${common_env[@]}" BOT_ERRORS_SELFCHECK_RANDOMIZED_DELAY_SECONDS=1801 BOT_ERRORS_SELFCHECK_PLATFORM=systemd bash "$S" > "$tmp/jitter.out" 2> "$tmp/jitter.err"; then
  echo "SELFCHECK_INSTALLER_FAIL accepted randomized delay above interval"
  exit 1
fi
grep -q 'RANDOMIZED_DELAY_SECONDS must not exceed' "$tmp/jitter.err" || {
  echo "SELFCHECK_INSTALLER_FAIL randomized delay reason"
  cat "$tmp/jitter.err"
  exit 1
}

if env "${common_env[@]}" BOT_ERRORS_PYTHON=python3 BOT_ERRORS_SELFCHECK_PLATFORM=systemd bash "$S" > "$tmp/relative-python.out" 2> "$tmp/relative-python.err"; then
  echo "SELFCHECK_INSTALLER_FAIL accepted relative python path"
  exit 1
fi
grep -q 'BOT_ERRORS_PYTHON must be an absolute executable path' "$tmp/relative-python.err" || {
  echo "SELFCHECK_INSTALLER_FAIL relative python reason"
  cat "$tmp/relative-python.err"
  exit 1
}

not_python="$tmp/not-python"
: > "$not_python"
if env "${common_env[@]}" BOT_ERRORS_PYTHON="$not_python" BOT_ERRORS_SELFCHECK_PLATFORM=systemd bash "$S" > "$tmp/nonexec-python.out" 2> "$tmp/nonexec-python.err"; then
  echo "SELFCHECK_INSTALLER_FAIL accepted non-executable python path"
  exit 1
fi
grep -q 'BOT_ERRORS_PYTHON must be an absolute executable path' "$tmp/nonexec-python.err" || {
  echo "SELFCHECK_INSTALLER_FAIL non-executable python reason"
  cat "$tmp/nonexec-python.err"
  exit 1
}

echo "SELFCHECK_INSTALLER_PASS"
