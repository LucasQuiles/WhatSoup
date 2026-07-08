#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SYSTEMD_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
BIN_DIR="$HOME/.local/bin"
ALLOW_MISSING_SYSTEMD_DIR=0
UNITS=(
  "whatsoup@.service"
  "whatsoup-fleet.service"
  "whatsoup-heal-notify@.service"
  "whatsoup-reply-guarantee.service"
  "whatsoup-reply-guarantee.timer"
  "harness-maintenance.service"
  "harness-maintenance.timer"
)
WRAPPERS=(
  "whatsoup-ensure-node:deploy/scripts/ensure-node-installed.sh"
)

usage() {
  cat <<'USAGE'
Usage: check-unit-drift.sh [--repo-root PATH] [--systemd-dir PATH] [--unit NAME ...]
                           [--bin-dir PATH] [--wrapper NAME:REL_PATH ...]
                           [--allow-missing-systemd-dir]

Compare checked-in deploy/*.service|*.timer files with installed systemd user
units, and verify installed systemd helper wrappers that units execute. Exits 0
when all managed installed units match and wrappers satisfy their restart-safety
contracts, 1 when a unit/wrapper is missing or drifted, 3 when the systemd
directory is absent (unless --allow-missing-systemd-dir is passed, in which
case exits 0 with a skip message).
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
    --bin-dir)
      BIN_DIR="${2:?missing --bin-dir value}"
      shift 2
      ;;
    --allow-missing-systemd-dir)
      ALLOW_MISSING_SYSTEMD_DIR=1
      shift
      ;;
    --unit)
      UNITS=()
      shift
      while [ "$#" -gt 0 ] && [[ "$1" != --* ]]; do
        UNITS+=("$1")
        shift
      done
      ;;
    --wrapper)
      WRAPPERS=()
      shift
      while [ "$#" -gt 0 ] && [[ "$1" != --* ]]; do
        WRAPPERS+=("$1")
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

wrapper_has_ensure_node_fast_path() {
  local file="$1"
  grep -qF 'LOCAL_NODE=' "$file" \
    && grep -qF 'already present' "$file" \
    && grep -qF 'skipping nvm install' "$file"
}

if [ ! -d "$SYSTEMD_DIR" ]; then
  if [ "$ALLOW_MISSING_SYSTEMD_DIR" -eq 1 ]; then
    echo "SKIP: systemd unit directory not found; skipping drift check: $SYSTEMD_DIR"
    exit 0
  fi
  echo "SKIP: systemd unit directory not found; skipping drift check: $SYSTEMD_DIR"
  exit 3
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

for entry in "${WRAPPERS[@]}"; do
  name="${entry%%:*}"
  rel="${entry#*:}"
  repo_wrapper="$REPO_ROOT/$rel"
  installed_wrapper="$BIN_DIR/$name"

  if [ "$entry" = "$rel" ] || [ -z "$name" ] || [ -z "$rel" ]; then
    echo "invalid wrapper spec: $entry" >&2
    failures=$((failures + 1))
    continue
  fi

  if [ ! -f "$repo_wrapper" ]; then
    echo "missing repo wrapper: $rel" >&2
    failures=$((failures + 1))
    continue
  fi

  if [ ! -x "$installed_wrapper" ]; then
    echo "missing or non-executable installed wrapper: $installed_wrapper" >&2
    failures=$((failures + 1))
    continue
  fi

  case "$name" in
    whatsoup-ensure-node)
      if ! wrapper_has_ensure_node_fast_path "$repo_wrapper"; then
        echo "repo wrapper lacks local-Node fast path: $rel" >&2
        failures=$((failures + 1))
        continue
      fi
      if ! wrapper_has_ensure_node_fast_path "$installed_wrapper"; then
        echo "installed wrapper lacks local-Node fast path: $installed_wrapper" >&2
        failures=$((failures + 1))
        continue
      fi
      echo "ok: $name local-Node fast path present"
      ;;
    *)
      if cmp -s "$repo_wrapper" "$installed_wrapper"; then
        echo "ok: $name"
      else
        echo "drift: $name" >&2
        diff -u "$repo_wrapper" "$installed_wrapper" | sed -n '1,80p' >&2 || true
        failures=$((failures + 1))
      fi
      ;;
  esac
done

if [ "$failures" -gt 0 ]; then
  echo "unit drift check failed: $failures problem(s)" >&2
  exit 1
fi

echo "all managed systemd units match"
