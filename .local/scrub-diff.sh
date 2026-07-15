#!/usr/bin/env bash
# scrub-diff.sh — fail-closed hygiene gate for PR-bound diffs.
#
# Rejects any diff content that could leak local environment details, personal
# data, or RE provenance into an upstream PR. Zero matches = PASS; any match =
# FAIL with the offending line printed. Run against a diff or list of files
# before every commit/push.
#
# Usage:
#   ./scrub-diff.sh                    # scrub staged + unstaged tracked changes
#   ./scrub-diff.sh <file>...          # scrub specific files
#   git diff origin/main...HEAD | ./scrub-diff.sh -   # scrub a piped diff
#
# Exit codes: 0 = clean, 1 = leak detected, 2 = usage error.

set -euo pipefail

# --- forbidden token table -------------------------------------------------
# Each entry: "pattern|why". Patterns are fixed strings (case-insensitive
# where noted) chosen for low false-positive rate. Anchored concept, not regex,
# so we catch real leaks without flagging unrelated English.
FORBIDDEN=(
  # Local filesystem paths
  '/home/q|local user home path'
  '/Users/|macOS user home path'
  '/tmp/node24|local node toolchain path'
  '/tmp/opencode|local opencode temp path'
  # Hostnames / tailnet
  'pi5|local hostname'
  'q-pi|tailnet hostname'
  'tail64ad01|tailnet name'
  '100.105.4.97|tailnet IP'
  'maclab|director hostname'
  # Personal identifiers
  'LucasQuiles|personal handle'
  'quiles|personal name'
  'mfdog|personal handle'
  'proton.me|personal email domain'
  'lab@quiles|personal email'
  # RE provenance — never name the source systems
  'openclaw|RE source system'
  'OpenClaw|RE source system'
  'OPENCLAW|RE source system'
  'claude code|RE source system'
  'Claude Code|RE source system'
  'claude-code|RE source system'
  'cc-re|RE worktree'
  'oc-re|RE worktree'
)

# --- input selection -------------------------------------------------------
declare -a INPUTS=()
if [ "$#" -eq 0 ]; then
  # Default: staged + unstaged tracked changes (no untracked — handle those
  # explicitly by passing filenames).
  if ! DIFF=$(git diff HEAD -- . 2>/dev/null); then
    DIFF=""
  fi
  if [ -n "$DIFF" ]; then
    INPUTS+=("$DIFF")
  fi
elif [ "$1" = "-" ]; then
  # Piped diff on stdin.
  INPUTS+=("$(cat)")
else
  # Explicit file list — read each.
  for f in "$@"; do
    if [ ! -r "$f" ]; then
      echo "scrub-diff: cannot read '$f'" >&2
      exit 2
    fi
    INPUTS+=("$(cat -- "$f")")
  done
fi

if [ "${#INPUTS[@]}" -eq 0 ]; then
  echo "scrub-diff: no input (no staged/unstaged diff and no files given)" >&2
  exit 2
fi

# --- scan ------------------------------------------------------------------
LEAKS=0
COMBINED=$(printf '%s\n' "${INPUTS[@]}")

for entry in "${FORBIDDEN[@]}"; do
  pattern="${entry%%|*}"
  why="${entry##*|}"
  # case-insensitive fixed-string search; -n line numbers, -I skip binary
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    # Strip the git-diff "+"/"-" prefix so column math stays meaningful but
    # keep the marker for context.
    echo "LEAK [$why]: $line" >&2
    LEAKS=$((LEAKS + 1))
  done < <(printf '%s\n' "$COMBINED" | grep -niIe "$pattern" || true)
done

# --- verdict ---------------------------------------------------------------
if [ "$LEAKS" -gt 0 ]; then
  echo "scrub-diff: FAIL — $LEAKS leak(s) detected above. Remove before commit." >&2
  exit 1
fi

echo "scrub-diff: PASS — 0 leaks across ${#FORBIDDEN[@]} patterns."
exit 0
