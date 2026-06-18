#!/usr/bin/env bash
set -euo pipefail

instance="${1:-}"
if [[ -z "$instance" ]]; then
  echo "usage: ensure-whatsoup-instance.sh <instance>" >&2
  exit 64
fi

home_dir="${HOME:-$(cd ~ && pwd)}"
repo="${WHATSOUP_REPO:-$home_dir/LAB/WhatSoup}"
config="$home_dir/.config/whatsoup/instances/$instance/config.json"
state_root="${WHATSOUP_WATCHDOG_STATE:-$home_dir/.local/state/whatsoup/instance-watchdog}"
log="$state_root/$instance.log"
lock="$state_root/$instance.lock"
fail_file="$state_root/$instance.health-fail-count"
node="${WHATSOUP_NODE:-$home_dir/.nvm/versions/node/v24.15.0/bin/node}"
bootstrap="$repo/src/bootstrap.ts"
pattern="$bootstrap $instance"

mkdir -p "$state_root"

if ! mkdir "$lock" 2>/dev/null; then
  echo "$(date -u +%FT%TZ) lock-held instance=$instance" >> "$log"
  exit 0
fi
trap 'rmdir "$lock" 2>/dev/null || true' EXIT

rotate_log() {
  if [[ -f "$log" ]]; then
    tail -2000 "$log" > "$log.tmp" 2>/dev/null && mv "$log.tmp" "$log" 2>/dev/null || true
  fi
}

log_line() {
  echo "$(date -u +%FT%TZ) $*" >> "$log"
}

read_health_port() {
  /usr/bin/python3 - "$config" <<'PY' 2>/dev/null || true
import json
import sys
from pathlib import Path
path = Path(sys.argv[1])
if not path.exists():
    raise SystemExit(0)
data = json.loads(path.read_text())
port = data.get("healthPort")
if isinstance(port, int):
    print(port)
PY
}

current_pids() {
  ps -axo pid=,command= |
    awk -v pat="$pattern" '$2 ~ /(^|\/)node$/ && index($0, pat) { print $1 }'
}

start_instance() {
  cd "$repo"
  export HOME="$home_dir"
  export PATH="$home_dir/.local/bin:$home_dir/.npm-global/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
  export ALLOW_M365_MUTATIONS="${ALLOW_M365_MUTATIONS:-1}"
  nohup \
    "$home_dir/.local/bin/with-pinecone-env" \
    "$home_dir/.local/bin/with-openai-env" \
    "$home_dir/.local/bin/with-health-token" \
    "$node" \
    --disable-warning=ExperimentalWarning \
    --experimental-strip-types \
    "$bootstrap" \
    "$instance" \
    >> "$home_dir/.config/whatsoup/instances/$instance/stdout.log" \
    2>> "$home_dir/.config/whatsoup/instances/$instance/stderr.log" &
  log_line "started instance=$instance pid=$!"
}

kill_instance_pids() {
  local pids=("$@")
  if [[ ${#pids[@]} -eq 0 ]]; then
    return
  fi
  log_line "terminating instance=$instance pids=${pids[*]}"
  kill -TERM "${pids[@]}" 2>/dev/null || true
  sleep 5
  for pid in "${pids[@]}"; do
    if kill -0 "$pid" 2>/dev/null; then
      log_line "killing stubborn instance=$instance pid=$pid"
      kill -KILL "$pid" 2>/dev/null || true
    fi
  done
}

health_ok() {
  local port="$1"
  [[ -n "$port" ]] || return 0
  /usr/bin/python3 - "$port" <<'PY' >/dev/null 2>&1
import json
import sys
import urllib.request

port = sys.argv[1]
with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=5) as response:
    data = json.load(response)
if data.get("status") != "healthy":
    raise SystemExit(1)
if data.get("whatsapp", {}).get("connected") is not True:
    raise SystemExit(1)
if data.get("whatsapp", {}).get("auth_bond", {}).get("status") != "present":
    raise SystemExit(1)
PY
}

rotate_log

pids=()
while IFS= read -r pid; do
  [[ -n "$pid" ]] && pids+=("$pid")
done < <(current_pids)
port="$(read_health_port)"

if [[ ${#pids[@]} -eq 0 ]]; then
  log_line "missing instance=$instance action=start port=${port:-unknown}"
  echo 0 > "$fail_file"
  start_instance
  exit 0
fi

if [[ ${#pids[@]} -gt 1 ]]; then
  log_line "duplicate instance=$instance pids=${pids[*]} action=restart-single"
  kill_instance_pids "${pids[@]}"
  echo 0 > "$fail_file"
  start_instance
  exit 0
fi

if health_ok "$port"; then
  echo 0 > "$fail_file"
  log_line "ok instance=$instance pid=${pids[0]} port=${port:-none}"
  exit 0
fi

fail_count=0
if [[ -f "$fail_file" ]]; then
  fail_count="$(tr -dc '0-9' < "$fail_file" || true)"
  fail_count="${fail_count:-0}"
fi
fail_count=$((fail_count + 1))
echo "$fail_count" > "$fail_file"
log_line "health-failed instance=$instance pid=${pids[0]} port=${port:-unknown} consecutive=$fail_count"

if [[ "$fail_count" -ge 3 ]]; then
  kill_instance_pids "${pids[@]}"
  echo 0 > "$fail_file"
  start_instance
fi
