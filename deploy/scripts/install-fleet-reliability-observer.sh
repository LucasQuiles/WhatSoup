#!/usr/bin/env bash
# Render or explicitly activate the portable fleet observer and deadman jobs.
# Rendering does not touch launchd/systemd, the private config, or monitor state.
set -euo pipefail
umask 077

MODE="${1:-}"
if (($#)); then shift; fi
PLATFORM=""
RELEASE_ROOT=""
CONFIG=""
STATE_DIR=""
OUTPUT_DIR=""
INSTALL_DIR=""
ACTIVATE=0
INTERVAL_SECONDS=900

usage() {
  echo "usage: $0 render|install --platform systemd|launchd --release-root ABS --config ABS --state-dir ABS --output-dir ABS [--install-dir ABS --activate] [--interval-seconds N]" >&2
  exit 2
}

require_absolute_file() {
  local value="$1" name="$2"
  [[ "$value" = /* ]] || { echo "$name must be absolute" >&2; exit 2; }
  [[ -f "$value" && ! -L "$value" ]] || { echo "$name must name an existing regular file" >&2; exit 2; }
}

require_absolute_dir() {
  local value="$1" name="$2"
  [[ "$value" = /* ]] || { echo "$name must be absolute" >&2; exit 2; }
  [[ "$value" =~ ^/[A-Za-z0-9_./@-]+$ && "/$value/" != */../* ]] || {
    echo "$name must use a path without whitespace, parent traversal or service-manager metacharacters" >&2; exit 2;
  }
}

while (($#)); do
  case "$1" in
    --platform) PLATFORM="${2:-}"; shift 2 ;;
    --release-root) RELEASE_ROOT="${2:-}"; shift 2 ;;
    --config) CONFIG="${2:-}"; shift 2 ;;
    --state-dir) STATE_DIR="${2:-}"; shift 2 ;;
    --output-dir) OUTPUT_DIR="${2:-}"; shift 2 ;;
    --install-dir) INSTALL_DIR="${2:-}"; shift 2 ;;
    --activate) ACTIVATE=1; shift ;;
    --interval-seconds) INTERVAL_SECONDS="${2:-}"; shift 2 ;;
    *) usage ;;
  esac
done

[[ "$MODE" == "render" || "$MODE" == "install" ]] || usage
[[ "$PLATFORM" == "systemd" || "$PLATFORM" == "launchd" ]] || usage
[[ "$INTERVAL_SECONDS" =~ ^[1-9][0-9]*$ ]] || usage
require_absolute_dir "$RELEASE_ROOT" "--release-root"
require_absolute_file "$CONFIG" "--config"
require_absolute_dir "$CONFIG" "--config"
require_absolute_dir "$STATE_DIR" "--state-dir"
require_absolute_dir "$OUTPUT_DIR" "--output-dir"
[[ -f "$RELEASE_ROOT/deploy/scripts/fleet/fleet_reliability_observer.py" ]] || { echo "release root does not contain fleet observer" >&2; exit 2; }
[[ -f "$RELEASE_ROOT/deploy/scripts/fleet/reliability_supervisor.py" ]] || { echo "release root does not contain fleet supervisor" >&2; exit 2; }

PYTHON="${PYTHON:-python3}"
PYTHON="$(command -v "$PYTHON")" || { echo "cannot resolve Python interpreter" >&2; exit 2; }
require_absolute_dir "$PYTHON" "PYTHON"
[[ -f "$PYTHON" && -x "$PYTHON" ]] || { echo "PYTHON is not executable" >&2; exit 2; }
OBSERVER="$RELEASE_ROOT/deploy/scripts/fleet/fleet_reliability_observer.py"
OBSERVER_LABEL="com.whatsoup.fleet-observer"
DEADMAN_LABEL="com.whatsoup.fleet-deadman"
LABELS=("$OBSERVER_LABEL" "$DEADMAN_LABEL" "com.agent365.fleet-observer" "com.agent365.fleet-observer-deadman")

inspect_jobs() {
  local label suffix result rc
  for label in "${LABELS[@]}"; do
    for suffix in plist service timer; do
      [[ ! -e "$INSTALL_DIR/$label.$suffix" && ! -L "$INSTALL_DIR/$label.$suffix" ]] || {
        echo "refusing existing job: $INSTALL_DIR/$label.$suffix" >&2; exit 3;
      }
    done
  done
  if [[ "$PLATFORM" == "launchd" ]]; then
    uid_value="$(id -u)"
    launchctl print "gui/$uid_value" >/dev/null 2>&1 || { echo "cannot inspect launchd domain" >&2; exit 3; }
    for label in "${LABELS[@]}"; do
      if launchctl print "gui/$uid_value/$label" >/dev/null 2>&1; then
        echo "refusing existing job: $label" >&2; exit 3
      else
        rc=$?
        [[ $rc -eq 113 ]] || { echo "cannot inspect launchd job: $label" >&2; exit 3; }
      fi
    done
  else
    for label in "${LABELS[@]}"; do
      for suffix in service timer; do
        rc=0
        result="$(systemctl --user show --property=LoadState --value "$label.$suffix" 2>/dev/null)" || rc=$?
        if [[ "$result" != "not-found" || ( $rc -ne 0 && $rc -ne 4 ) ]]; then
          if [[ $rc -eq 0 && -n "$result" ]]; then
            echo "refusing existing job: $label.$suffix" >&2
          else
            echo "cannot inspect systemd job: $label.$suffix" >&2
          fi
          exit 3
        fi
      done
    done
  fi
}

if [[ "$MODE" == "install" ]]; then
  [[ $ACTIVATE -eq 1 ]] || { echo "install refuses without --activate; render first and review the jobs" >&2; exit 2; }
  require_absolute_dir "$INSTALL_DIR" "--install-dir"
  inspect_jobs
fi
[[ ! -e "$OUTPUT_DIR" && ! -L "$OUTPUT_DIR" ]] || { echo "refusing existing output directory" >&2; exit 3; }
validate_config() {
  "$PYTHON" "$OBSERVER" --config "$CONFIG" --state-dir "$STATE_DIR" --check-config || {
    echo "fleet configuration validation failed" >&2; exit 2;
  }
}
validate_config
mkdir "$OUTPUT_DIR"

render_systemd() {
  local label="$1" flag="$2"
  local service="$OUTPUT_DIR/$label.service" timer="$OUTPUT_DIR/$label.timer"
  cat > "$service" <<EOF
[Unit]
Description=WhatSoup fleet ${label##*.}

[Service]
Type=oneshot
UMask=0077
ExecStart=$PYTHON $OBSERVER --config $CONFIG --state-dir $STATE_DIR $flag
EOF
  cat > "$timer" <<EOF
[Unit]
Description=WhatSoup fleet ${label##*.} schedule

[Timer]
OnBootSec=60
OnUnitActiveSec=$INTERVAL_SECONDS
Persistent=true
Unit=$label.service

[Install]
WantedBy=timers.target
EOF
}

xml_escape() {
  local value="$1"
  value="${value//&/&amp;}"
  value="${value//</&lt;}"
  value="${value//>/&gt;}"
  printf '%s' "$value"
}

render_launchd() {
  local label="$1" flag="$2"
  local plist="$OUTPUT_DIR/$label.plist"
  cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>$label</string>
<key>ProgramArguments</key><array>
<string>$(xml_escape "$PYTHON")</string><string>$(xml_escape "$OBSERVER")</string><string>--config</string><string>$(xml_escape "$CONFIG")</string><string>--state-dir</string><string>$(xml_escape "$STATE_DIR")</string>$flag
</array>
<key>StartInterval</key><integer>$INTERVAL_SECONDS</integer>
<key>RunAtLoad</key><true/>
<key>ProcessType</key><string>Background</string>
<key>StandardOutPath</key><string>$(xml_escape "$STATE_DIR/$label.out.log")</string>
<key>StandardErrorPath</key><string>$(xml_escape "$STATE_DIR/$label.err.log")</string>
</dict></plist>
EOF
}

if [[ "$PLATFORM" == "systemd" ]]; then
  render_systemd "$OBSERVER_LABEL" ""
  render_systemd "$DEADMAN_LABEL" "--watchdog"
else
  render_launchd "$OBSERVER_LABEL" ""
  render_launchd "$DEADMAN_LABEL" "<string>--watchdog</string>"
fi

if [[ "$MODE" == "render" ]]; then
  echo "rendered fleet observer jobs platform=$PLATFORM output=$OUTPUT_DIR"
  exit 0
fi

mkdir -p "$INSTALL_DIR" "$STATE_DIR"
validate_config

activation_failed() {
  echo "fleet activation failed; stopping the new jobs; retain definitions and state for inspection" >&2
  if [[ "$PLATFORM" == "launchd" ]]; then
    if [[ -n "$activated" ]]; then
      launchctl bootout "gui/$uid_value/$activated" || echo "rollback stop failed: $activated" >&2
    fi
  else
    systemctl --user disable --now "$OBSERVER_LABEL.timer" "$DEADMAN_LABEL.timer" || echo "rollback timer stop failed" >&2
    systemctl --user stop "$OBSERVER_LABEL.service" "$DEADMAN_LABEL.service" || echo "rollback service stop failed" >&2
  fi
  exit 1
}
activated=""

if [[ "$PLATFORM" == "systemd" ]]; then
  for name in "$OBSERVER_LABEL.service" "$OBSERVER_LABEL.timer" "$DEADMAN_LABEL.service" "$DEADMAN_LABEL.timer"; do
    [[ ! -e "$INSTALL_DIR/$name" ]] || { echo "refusing existing job: $INSTALL_DIR/$name" >&2; exit 3; }
  done
  cp "$OUTPUT_DIR/$OBSERVER_LABEL.service" "$OUTPUT_DIR/$OBSERVER_LABEL.timer" "$OUTPUT_DIR/$DEADMAN_LABEL.service" "$OUTPUT_DIR/$DEADMAN_LABEL.timer" "$INSTALL_DIR/"
  systemctl --user link "$INSTALL_DIR/$OBSERVER_LABEL.service" "$INSTALL_DIR/$OBSERVER_LABEL.timer" "$INSTALL_DIR/$DEADMAN_LABEL.service" "$INSTALL_DIR/$DEADMAN_LABEL.timer" || activation_failed
  systemctl --user daemon-reload || activation_failed
  systemctl --user enable --now "$OBSERVER_LABEL.timer" "$DEADMAN_LABEL.timer" || activation_failed
else
  for name in "$OBSERVER_LABEL.plist" "$DEADMAN_LABEL.plist"; do
    [[ ! -e "$INSTALL_DIR/$name" ]] || { echo "refusing existing job: $INSTALL_DIR/$name" >&2; exit 3; }
  done
  cp "$OUTPUT_DIR/$OBSERVER_LABEL.plist" "$OUTPUT_DIR/$DEADMAN_LABEL.plist" "$INSTALL_DIR/"
  launchctl bootstrap "gui/$uid_value" "$INSTALL_DIR/$OBSERVER_LABEL.plist" || activation_failed
  activated="$OBSERVER_LABEL"
  launchctl bootstrap "gui/$uid_value" "$INSTALL_DIR/$DEADMAN_LABEL.plist" || activation_failed
fi
echo "activated fleet observer jobs platform=$PLATFORM install_dir=$INSTALL_DIR"
