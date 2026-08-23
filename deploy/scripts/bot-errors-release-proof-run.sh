#!/usr/bin/env bash
# BOT ERRORS release-proof scheduler runner (central pilot).
#
# Invokes exactly ONE monitor component from the versioned bundle under a
# shared non-blocking lock. Contains no detector logic and no service
# commands. Reads the mode file as data — never sources it as shell.
#
# Usage: bot-errors-release-proof-run.sh tree|runtime-staleness
#
# Exit codes:
#   0   valid observation (detector completed a clean/warning/critical or
#       stale/fresh observation)
#   1   detector event-write failure (propagated)
#   2   usage error, invalid/missing mode, missing dependency or detector
#   75  lock contention: cycle skipped, recorded on stderr
#
# Early environment failures (e.g. an unwritable state dir at mkdir -p) also
# surface as a nonzero exit before the lock is ever taken. Detector exit
# codes propagate unchanged through the final exec: exit 2 (probe/inspection
# error) passes through exactly like exit 1.
set -euo pipefail

usage() {
  echo "usage: bot-errors-release-proof-run.sh tree|runtime-staleness" >&2
}

if [ "$#" -ne 1 ]; then
  usage
  exit 2
fi
COMPONENT="$1"
case "$COMPONENT" in
  tree|runtime-staleness) ;;
  *)
    usage
    exit 2
    ;;
esac

MODE_FILE="${BOT_ERRORS_RELEASE_PROOF_ENV:-$HOME/.config/whatsoup/bot-errors-release-proof.env}"
if [ ! -f "$MODE_FILE" ]; then
  echo "release-proof: missing mode file: $MODE_FILE" >&2
  exit 2
fi
# Read the mode without sourcing the file as shell (spec 6.3).
MODE="$(sed -n 's/^BOT_ERRORS_RELEASE_PROOF_MODE=//p' "$MODE_FILE" | tail -n 1 | tr -d '[:space:]')"
case "$MODE" in
  observe|emit) ;;
  *)
    echo "release-proof: invalid BOT_ERRORS_RELEASE_PROOF_MODE: '$MODE' (expected observe|emit)" >&2
    exit 2
    ;;
esac

command -v flock >/dev/null 2>&1 || { echo "release-proof: missing dependency: flock" >&2; exit 2; }
command -v python3 >/dev/null 2>&1 || { echo "release-proof: missing dependency: python3" >&2; exit 2; }

BUNDLE_ROOT="${BOT_ERRORS_RELEASE_PROOF_BUNDLE:-$HOME/.local/lib/whatsoup/release-proof/current}"
STATE_DIR="${BOT_ERRORS_STATE_DIR:-$HOME/.local/state/bot-errors}"
LOCK_FILE="$STATE_DIR/release-proof.lock"
APP_REPO="${BOT_ERRORS_RELEASE_PROOF_APP_REPO:-$HOME/LAB/WhatSoup}"
mkdir -p "$STATE_DIR"

case "$COMPONENT" in
  tree)
    DETECTOR="$BUNDLE_ROOT/deploy/scripts/bot-errors-tree-provenance.py"
    if [ "$MODE" = "observe" ]; then
      ARGS=(--reporter --print --repo "$APP_REPO")
    else
      ARGS=(--reporter --once --repo "$APP_REPO")
    fi
    ;;
  runtime-staleness)
    DETECTOR="$BUNDLE_ROOT/deploy/scripts/bot-errors-runtime-staleness.py"
    if [ "$MODE" = "observe" ]; then
      ARGS=(--dry-run --once)
    else
      ARGS=(--once)
    fi
    ;;
esac

if [ ! -f "$DETECTOR" ]; then
  echo "release-proof: missing detector: $DETECTOR" >&2
  exit 2
fi

# Shared non-blocking lock: fd 9 survives the exec below, so the lock is
# held for the detector's whole lifetime and prevents cross-detector overlap.
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "release-proof: lock held; skipping cycle ($COMPONENT)" >&2
  exit 75
fi

exec python3 "$DETECTOR" "${ARGS[@]}"
