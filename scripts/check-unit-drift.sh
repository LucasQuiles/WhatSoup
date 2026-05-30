#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SYSTEMD_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNITS=(
  "whatsoup@.service"
  "whatsoup-fleet.service"
  "whatsoup-heal-notify@.service"
  "whatsoup-reply-guarantee.service"
  "whatsoup-reply-guarantee.timer"
  "harness-maintenance.service"
  "harness-maintenance.timer"
)

usage() {
  cat <<'USAGE'
Usage: check-unit-drift.sh [--repo-root PATH] [--systemd-dir PATH] [--unit NAME ...]

Compare checked-in deploy/*.service|*.timer files with installed systemd user
units. Exits 0 when all managed installed units match, 1 when a unit is missing
or drifted.
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --repo-root)
      REPO_ROOT="${2:?missing --repo-root value}"
      shift 2
      ;;
    --systemd-dir)
      SYSTEMD_DIR="${2:?missing --systemd-dir value}"
      shift 2
      ;;
    --unit)
      UNITS=()
      shift
      while [ "$#" -gt 0 ] && [[ "$1" != --* ]]; do
        UNITS+=("$1")
        shift
      done
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "unexpected argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [ ! -d "$SYSTEMD_DIR" ]; then
  echo "systemd unit directory not found; skipping drift check: $SYSTEMD_DIR"
  exit 0
fi

failures=0
for unit in "${UNITS[@]}"; do
  repo_unit="$REPO_ROOT/deploy/$unit"
  installed_unit="$SYSTEMD_DIR/$unit"

  if [ ! -f "$repo_unit" ]; then
    echo "missing repo unit: deploy/$unit" >&2
    failures=$((failures + 1))
    continue
  fi

  if [ ! -f "$installed_unit" ]; then
    echo "missing installed unit: $unit" >&2
    failures=$((failures + 1))
    continue
  fi

  if cmp -s "$repo_unit" "$installed_unit"; then
    echo "ok: $unit"
  else
    echo "drift: $unit" >&2
    diff -u "$repo_unit" "$installed_unit" | sed -n '1,80p' >&2 || true
    failures=$((failures + 1))
  fi
done

if [ "$failures" -gt 0 ]; then
  echo "unit drift check failed: $failures problem(s)" >&2
  exit 1
fi

echo "all managed systemd units match"
