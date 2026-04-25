#!/usr/bin/env bash
# check-baseline-test-drift.sh — Compare current vitest failures against a frozen baseline.
# Usage: bash scripts/check-baseline-test-drift.sh [options]
#
# Options:
#   --baseline <path>        Baseline file (default: docs/superpowers/specs/2026-04-25-baseline-test-failures.md)
#   --vitest-output <path>   Read pre-captured vitest output from file instead of running tests
#   --cmd <shell-cmd>        Override the test command (default: npm test -- --pool=forks --reporter=verbose)
#   --repo-root <path>       Repo root (default: git rev-parse --show-toplevel)
#   --help                   Print this help message

set -euo pipefail

# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------
DEFAULT_BASELINE="docs/superpowers/specs/2026-04-25-baseline-test-failures.md"
DEFAULT_CMD="npm test -- --pool=forks --reporter=verbose"
BASELINE=""
VITEST_OUTPUT=""
CMD=""
REPO_ROOT=""

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------
print_usage() {
  # Print header comment block up to (not including) the first blank comment line after the options block
  awk '/^#!/{next} /^#/{print substr($0, 3)} /^[^#]/{exit}' "$0"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --help)
      print_usage
      exit 0
      ;;
    --baseline)
      if [ $# -lt 2 ]; then
        echo "ERROR: --baseline requires an argument" >&2
        exit 2
      fi
      BASELINE="$2"
      shift 2
      ;;
    --vitest-output)
      if [ $# -lt 2 ]; then
        echo "ERROR: --vitest-output requires an argument" >&2
        exit 2
      fi
      VITEST_OUTPUT="$2"
      shift 2
      ;;
    --cmd)
      if [ $# -lt 2 ]; then
        echo "ERROR: --cmd requires an argument" >&2
        exit 2
      fi
      CMD="$2"
      shift 2
      ;;
    --repo-root)
      if [ $# -lt 2 ]; then
        echo "ERROR: --repo-root requires an argument" >&2
        exit 2
      fi
      REPO_ROOT="$2"
      shift 2
      ;;
    *)
      echo "ERROR: Unknown argument: $1" >&2
      print_usage >&2
      exit 2
      ;;
  esac
done

# ---------------------------------------------------------------------------
# Resolve repo root
# ---------------------------------------------------------------------------
if [ -z "$REPO_ROOT" ]; then
  REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || {
    echo "ERROR: Could not determine repo root (not in a git repo?). Use --repo-root." >&2
    exit 2
  }
fi

# ---------------------------------------------------------------------------
# Resolve baseline path (relative to repo root if not absolute)
# ---------------------------------------------------------------------------
if [ -z "$BASELINE" ]; then
  BASELINE="${REPO_ROOT}/${DEFAULT_BASELINE}"
else
  case "$BASELINE" in
    /*) : ;;  # already absolute
    *)  BASELINE="${REPO_ROOT}/${BASELINE}" ;;
  esac
fi

if [ ! -f "$BASELINE" ]; then
  echo "ERROR: Baseline file not found: $BASELINE" >&2
  exit 2
fi

# ---------------------------------------------------------------------------
# Resolve test command
# ---------------------------------------------------------------------------
if [ -z "$CMD" ]; then
  CMD="$DEFAULT_CMD"
fi

# ---------------------------------------------------------------------------
# Capture vitest output
# ---------------------------------------------------------------------------
ACTUAL_SOURCE=""
VITEST_TEXT=""

if [ -n "$VITEST_OUTPUT" ]; then
  # Read from pre-captured file (or process substitution fd)
  if [ ! -r "$VITEST_OUTPUT" ] && [ "$VITEST_OUTPUT" != "/dev/stdin" ]; then
    # Try reading anyway — handles /dev/fd/* from process substitutions
    :
  fi
  VITEST_TEXT="$(cat "$VITEST_OUTPUT")" || {
    echo "ERROR: Cannot read vitest output from: $VITEST_OUTPUT" >&2
    exit 2
  }
  ACTUAL_SOURCE="$VITEST_OUTPUT"
else
  ACTUAL_SOURCE="<live run: ${CMD}>"
  cd "$REPO_ROOT"
  VITEST_TEXT="$(eval "$CMD" 2>&1)" || true  # vitest exits non-zero on failures; we capture anyway
fi

# ---------------------------------------------------------------------------
# Parse EXPECTED from baseline (fenced ```baseline-failures block)
# ---------------------------------------------------------------------------
# Extract lines between ```baseline-failures and the closing ```
# Uses awk — POSIX compatible, no mapfile required.
EXPECTED_BLOCK="$(awk '/^```baseline-failures$/{found=1; next} found && /^```$/{exit} found{print}' "$BASELINE")"

if [ -z "$EXPECTED_BLOCK" ]; then
  echo "ERROR: No 'baseline-failures' fenced block found in: $BASELINE" >&2
  exit 2
fi

# Parse EXPECTED collection failures from baseline (fenced ```collection-failures block)
COLLECTION_EXPECTED_BLOCK="$(awk '/^```collection-failures$/{found=1; next} found && /^```$/{exit} found{print}' "$BASELINE")"

# Build sorted temp files of expected failures (trim whitespace, skip blank lines)
EXPECTED_TMP="$(mktemp)"
ACTUAL_TMP="$(mktemp)"
COLLECTION_EXPECTED_TMP="$(mktemp)"
COLLECTION_ACTUAL_TMP="$(mktemp)"
# shellcheck disable=SC2064
trap "rm -f '$EXPECTED_TMP' '$ACTUAL_TMP' '$COLLECTION_EXPECTED_TMP' '$COLLECTION_ACTUAL_TMP'" EXIT

printf '%s\n' "$EXPECTED_BLOCK" | while IFS= read -r line; do
  # Trim leading/trailing whitespace
  trimmed="$(printf '%s' "$line" | sed 's/^[[:space:]]*//' | sed 's/[[:space:]]*$//')"
  if [ -n "$trimmed" ]; then
    printf '%s\n' "$trimmed"
  fi
done | sort > "$EXPECTED_TMP"

EXPECTED_COUNT="$(wc -l < "$EXPECTED_TMP" | tr -d ' ')"

printf '%s\n' "$COLLECTION_EXPECTED_BLOCK" | while IFS= read -r line; do
  trimmed="$(printf '%s' "$line" | sed 's/^[[:space:]]*//' | sed 's/[[:space:]]*$//')"
  if [ -n "$trimmed" ]; then
    printf '%s\n' "$trimmed"
  fi
done | sort > "$COLLECTION_EXPECTED_TMP"

COLLECTION_EXPECTED_COUNT="$(wc -l < "$COLLECTION_EXPECTED_TMP" | tr -d ' ')"

# ---------------------------------------------------------------------------
# Parse ACTUAL from vitest output
#
# Named-test failures look like:
#   " FAIL  <file> > <suite> > <test>"
#
# A line must:
#   - Start with exactly one space + "FAIL  " (one space, FAIL, two spaces)
#   - Contain at least one " > " separator
#
# File-level collection failures look like:
#   " FAIL  tests/foo.test.ts [ tests/foo.test.ts ]"
# These have NO " > " separator. Extract just the file path (second token).
# ---------------------------------------------------------------------------
printf '%s\n' "$VITEST_TEXT" | while IFS= read -r line; do
  case "$line" in
    " FAIL  "*)
      case "$line" in
        *" > "*)
          # Named test failure — extract file::description
          rest="${line# FAIL  }"
          file_part="${rest%% > *}"
          desc_part="${rest#* > }"
          file_part="$(printf '%s' "$file_part" | sed 's/^[[:space:]]*//' | sed 's/[[:space:]]*$//')"
          desc_part="$(printf '%s' "$desc_part" | sed 's/^[[:space:]]*//' | sed 's/[[:space:]]*$//')"
          if [ -n "$file_part" ] && [ -n "$desc_part" ]; then
            printf '%s::%s\n' "$file_part" "$desc_part"
          fi
          ;;
      esac
      ;;
  esac
done | sort > "$ACTUAL_TMP"

ACTUAL_COUNT="$(wc -l < "$ACTUAL_TMP" | tr -d ' ')"

printf '%s\n' "$VITEST_TEXT" | while IFS= read -r line; do
  case "$line" in
    " FAIL  "*)
      case "$line" in
        *" > "*)
          # Named test failure — skip here, handled above
          ;;
        *)
          # Collection failure — extract file path (second whitespace-separated token)
          rest="${line# FAIL  }"
          # The file path is everything up to the first space (or the whole string if no space)
          file_path="${rest%% *}"
          file_path="$(printf '%s' "$file_path" | sed 's/^[[:space:]]*//' | sed 's/[[:space:]]*$//')"
          if [ -n "$file_path" ]; then
            printf '%s\n' "$file_path"
          fi
          ;;
      esac
      ;;
  esac
done | sort > "$COLLECTION_ACTUAL_TMP"

COLLECTION_ACTUAL_COUNT="$(wc -l < "$COLLECTION_ACTUAL_TMP" | tr -d ' ')"

# ---------------------------------------------------------------------------
# Sanity check: a real vitest run always emits "Test Files" and "Tests" summary lines.
# An empty/truncated capture would show 0 FAILs without those summary lines.
# ---------------------------------------------------------------------------
if [ "$ACTUAL_COUNT" -eq 0 ] && [ "$COLLECTION_ACTUAL_COUNT" -eq 0 ]; then
  if ! printf '%s' "$VITEST_TEXT" | grep -qE '^(Test Files|Tests) '; then
    echo "ERROR: vitest output appears truncated or empty (no FAIL lines and no Test Files/Tests summary): $ACTUAL_SOURCE" >&2
    echo "       This is treated as a parser error (exit 2), NOT 'all baseline failures resolved'." >&2
    exit 2
  fi
fi

# ---------------------------------------------------------------------------
# Compute drift
# ---------------------------------------------------------------------------
# drift_new = actual - expected  (in actual but NOT in expected)
# drift_resolved = expected - actual  (in expected but NOT in actual)

DRIFT_NEW_TMP="$(mktemp)"
DRIFT_RESOLVED_TMP="$(mktemp)"
COLLECTION_DRIFT_NEW_TMP="$(mktemp)"
COLLECTION_DRIFT_RESOLVED_TMP="$(mktemp)"
# shellcheck disable=SC2064
trap "rm -f '$EXPECTED_TMP' '$ACTUAL_TMP' '$COLLECTION_EXPECTED_TMP' '$COLLECTION_ACTUAL_TMP' '$DRIFT_NEW_TMP' '$DRIFT_RESOLVED_TMP' '$COLLECTION_DRIFT_NEW_TMP' '$COLLECTION_DRIFT_RESOLVED_TMP'" EXIT

comm -23 "$ACTUAL_TMP" "$EXPECTED_TMP" > "$DRIFT_NEW_TMP"
comm -23 "$EXPECTED_TMP" "$ACTUAL_TMP" > "$DRIFT_RESOLVED_TMP"
comm -23 "$COLLECTION_ACTUAL_TMP" "$COLLECTION_EXPECTED_TMP" > "$COLLECTION_DRIFT_NEW_TMP"
comm -23 "$COLLECTION_EXPECTED_TMP" "$COLLECTION_ACTUAL_TMP" > "$COLLECTION_DRIFT_RESOLVED_TMP"

DRIFT_NEW_COUNT="$(wc -l < "$DRIFT_NEW_TMP" | tr -d ' ')"
DRIFT_RESOLVED_COUNT="$(wc -l < "$DRIFT_RESOLVED_TMP" | tr -d ' ')"
COLLECTION_DRIFT_NEW_COUNT="$(wc -l < "$COLLECTION_DRIFT_NEW_TMP" | tr -d ' ')"
COLLECTION_DRIFT_RESOLVED_COUNT="$(wc -l < "$COLLECTION_DRIFT_RESOLVED_TMP" | tr -d ' ')"

# ---------------------------------------------------------------------------
# Print report
# ---------------------------------------------------------------------------
echo "== Baseline drift check =="
echo "Baseline: ${BASELINE}  (named expected: ${EXPECTED_COUNT}, collection expected: ${COLLECTION_EXPECTED_COUNT})"
echo "Actual: ${ACTUAL_SOURCE}  (named actual: ${ACTUAL_COUNT}, collection actual: ${COLLECTION_ACTUAL_COUNT})"
echo ""
echo "DRIFT-NEW (count: ${DRIFT_NEW_COUNT})"
if [ "$DRIFT_NEW_COUNT" -gt 0 ]; then
  cat "$DRIFT_NEW_TMP"
fi
echo ""
echo "DRIFT-RESOLVED (count: ${DRIFT_RESOLVED_COUNT})"
if [ "$DRIFT_RESOLVED_COUNT" -gt 0 ]; then
  cat "$DRIFT_RESOLVED_TMP"
fi
echo ""
echo "DRIFT-NEW (collection) (count: ${COLLECTION_DRIFT_NEW_COUNT})"
if [ "$COLLECTION_DRIFT_NEW_COUNT" -gt 0 ]; then
  cat "$COLLECTION_DRIFT_NEW_TMP"
fi
echo ""
echo "DRIFT-RESOLVED (collection) (count: ${COLLECTION_DRIFT_RESOLVED_COUNT})"
if [ "$COLLECTION_DRIFT_RESOLVED_COUNT" -gt 0 ]; then
  cat "$COLLECTION_DRIFT_RESOLVED_TMP"
fi
echo ""
echo "== Summary =="

if [ "$DRIFT_NEW_COUNT" -eq 0 ] && [ "$DRIFT_RESOLVED_COUNT" -eq 0 ] && \
   [ "$COLLECTION_DRIFT_NEW_COUNT" -eq 0 ] && [ "$COLLECTION_DRIFT_RESOLVED_COUNT" -eq 0 ]; then
  echo "PASS"
  exit 0
else
  echo "DRIFT"
  exit 1
fi
