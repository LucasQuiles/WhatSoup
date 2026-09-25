#!/usr/bin/env bash
# Size-bounded rotation for the release-drift launchd log sink (#2458).
#
# Rotates a single log file with mv+gzip (content preserved, never truncated
# in place):  log -> log.1.gz, log.(N-1).gz -> log.N.gz, oldest beyond --keep
# is deleted. Fails visibly (nonzero exit + release-drift-log-rotation-failed
# marker on stderr) and never deletes unrotated evidence on a partial failure.
set -uo pipefail

log=""
max_bytes=""
keep=""

usage() {
  cat >&2 <<'USAGE'
Usage: deploy/scripts/rotate-release-drift-logs.sh --log <path> --max-bytes <n> --keep <n>

Rotates the log only when it exceeds --max-bytes. Keeps at most --keep
gzipped generations (plus the active log). Read-only when under the cap.
USAGE
}

fail() {
  echo "release-drift-log-rotation-failed: $1" >&2
  exit "${2:-3}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --log) log="${2:-}"; shift 2 ;;
    --max-bytes) max_bytes="${2:-}"; shift 2 ;;
    --keep) keep="${2:-}"; shift 2 ;;
    --help) usage; exit 0 ;;
    *) fail "unknown argument: $1" ;;
  esac
done

[[ -n "$log" ]] || fail "missing --log"
[[ "$log" == /* ]] || fail "--log must be absolute: $log"
[[ "$max_bytes" =~ ^[0-9]+$ && "$max_bytes" -gt 0 ]] || fail "unsafe --max-bytes (positive integer required)"
[[ "$keep" =~ ^[0-9]+$ && "$keep" -gt 0 ]] || fail "unsafe --keep (positive integer required)"

[[ -f "$log" ]] || exit 0

size="$(wc -c < "$log" 2>/dev/null | tr -d '[:space:]')"
[[ "$size" =~ ^[0-9]+$ ]] || fail "cannot stat log: $log"

[[ "$size" -le "$max_bytes" ]] && exit 0

rotate() {
  local i="$keep"
  # Every step must succeed before the next touches anything: a partial
  # rotation must abort with the evidence file still in place.
  if [[ -f "$log.$i.gz" ]] && ! rm -f -- "$log.$i.gz"; then return 1; fi
  i=$((i - 1))
  while [[ "$i" -ge 1 ]]; do
    if [[ -f "$log.$i.gz" ]] && ! mv -f -- "$log.$i.gz" "$log.$((i + 1)).gz"; then return 1; fi
    i=$((i - 1))
  done
  if ! mv -f -- "$log" "$log.1"; then return 1; fi
  if ! gzip -- "$log.1"; then
    # Archive failed after the move: restore the log so evidence is not lost.
    mv -f -- "$log.1" "$log" || true
    return 1
  fi
  if ! : > "$log" 2>/dev/null; then
    # Evidence now lives in log.1.gz; the next run recreates the active log.
    return 1
  fi
  return 0
}

rotate || fail "rotation failed for $(basename "$log"); unrotated evidence preserved"
