#!/usr/bin/env bash
# Schedule wrapper for the release-drift launchd observer (#2458).
#
# Rotation runs BEFORE the observer, is fail-visible (stderr marker) but does
# not block the observation itself: an unrotated log is evidence preserved,
# a skipped observation is evidence lost. The observer runs under the repo's
# pinned Node runtime; all non-rotation arguments pass through verbatim.
set -uo pipefail

repo_root="${WHATSOUP_REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)}"
max_log_bytes="5242880"
keep_rotated_logs="5"
observer_args=()

usage() {
  cat >&2 <<'USAGE'
Usage: deploy/scripts/run-release-drift-schedule.sh [--max-log-bytes <n>] \
  [--keep-rotated-logs <n>] [observer arguments passed to live-release-observers.ts]

Rotation bounds default to 5 MiB and 5 gzipped generations per log file.
USAGE
}

fail() {
  echo "$1" >&2
  exit "${2:-2}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --max-log-bytes)
      [[ -n "${2:-}" ]] || fail "--max-log-bytes requires a value"
      max_log_bytes="$2"; shift 2 ;;
    --keep-rotated-logs)
      [[ -n "${2:-}" ]] || fail "--keep-rotated-logs requires a value"
      keep_rotated_logs="$2"; shift 2 ;;
    --help) usage; exit 0 ;;
    *)
      observer_args+=("$1"); shift ;;
  esac
done

[[ "$max_log_bytes" =~ ^[0-9]+$ && "$max_log_bytes" -gt 0 ]] || fail "unsafe --max-log-bytes"
[[ "$keep_rotated_logs" =~ ^[0-9]+$ && "$keep_rotated_logs" -gt 0 ]] || fail "unsafe --keep-rotated-logs"

log_dir="${WHATSOUP_RELEASE_DRIFT_LOG_DIR:-$HOME/Library/Logs/whatsoup}"
rotate_script="$repo_root/deploy/scripts/rotate-release-drift-logs.sh"
mkdir -p -- "$log_dir" 2>/dev/null \
  || echo "release-drift-log-rotation-failed: cannot create log dir; continuing observer" >&2

for log_name in release-drift-check.log release-drift-check.err.log; do
  # Fail-visible, non-blocking: keep observing even when rotation cannot run.
  bash "$rotate_script" \
    --log "$log_dir/$log_name" \
    --max-bytes "$max_log_bytes" \
    --keep "$keep_rotated_logs" \
    || echo "release-drift-log-rotation-failed: $log_name (continuing observer; unrotated evidence preserved)" >&2
done

exec bash "$repo_root/scripts/run-with-pinned-node.sh" \
  "$repo_root/scripts/live-release-observers.ts" \
  "${observer_args[@]+"${observer_args[@]}"}"
