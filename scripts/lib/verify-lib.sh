#!/usr/bin/env bash
# Three-outcome verification helpers for ad-hoc checks.
#
# WHY THIS EXISTS. Four self-inflicted measurement errors in one session, all the same
# shape: an ABSENT measurement silently produced the reassuring answer.
#
#   1. `grep -A28 ... | grep datetime` found nothing -> wrote "REFUTED: no clock dependency".
#      The dependency was 7 lines past a window I chose arbitrarily. A bounded search
#      answers "not in my window", never "not present".
#   2. `grep -c "severity: 'block'"` counted 18 -> "a new block rule is unbacked!". One was
#      my own JSDoc NAMING the pattern. Structured data must be parsed, not grepped.
#   3. A Bash call bundling an edit + a test run was rejected by a hook. The EDIT never
#      happened either. A denied call runs nothing; the only signal was a test count that
#      failed to move.
#   4. A verifier compared two variables that were both empty and reported "MATCHES" for
#      all three PRs. `[ "" = "" ]` is true.
#
# The shipped guards all encode a three-outcome discipline (0 pass / 1 fail / 2 could not
# determine). These helpers apply the same rule to throwaway shell, where the cost of a
# false green is a wrong conclusion reported as fact.
#
# Usage:  source scripts/lib/verify-lib.sh
#
# Self-test: scripts/verify-lib-selftest.sh — feeds every known failure shape through the
# checker and asserts the expected verdict. It exits 2 by design (it exercises the
# INCONCLUSIVE branches), so `npm run verify:selftest` asserts EXACTLY 2, not 0.
set -uo pipefail

VERIFY_PASS=0
VERIFY_FAIL=1
VERIFY_INCONCLUSIVE=2

_v_rc=0
_v_note() { printf '%s\n' "$*" >&2; }

# assert_eq NAME EXPECTED ACTUAL
# Empty on EITHER side is INCONCLUSIVE, never a pass. This is error #4 directly.
assert_eq() {
  local name="$1" want="$2" got="$3"
  if [ -z "$want" ] || [ -z "$got" ]; then
    _v_note "INCONCLUSIVE  $name — expected='$want' actual='$got'; an empty side is an ABSENT measurement, not a match"
    _v_rc=$VERIFY_INCONCLUSIVE; return $VERIFY_INCONCLUSIVE
  fi
  if [ "$want" = "$got" ]; then
    _v_note "PASS          $name ($got)"; return $VERIFY_PASS
  fi
  _v_note "FAIL          $name — expected '$want', got '$got'"
  [ "$_v_rc" -eq $VERIFY_INCONCLUSIVE ] || _v_rc=$VERIFY_FAIL
  return $VERIFY_FAIL
}

# assert_count NAME EXPECTED_N COMMAND...
# Requires the command to exit 0 STRICTLY. Any non-zero exit is INCONCLUSIVE: "the command
# errored" is not "the command found nothing" (error #1).
#
# The first version of this function accepted exit 1 as well, because grep uses 1 for
# "no matches". That is a GREP convention, not a universal one — and blanket-applying it
# made `ls /nonexistent` (exit 1) report a clean count of 0. Caught by this file's own
# self-test: the helper written to prevent error #1 reproduced error #1. Grep-style
# commands now use assert_grep_count, which opts into that convention explicitly.
assert_count() {
  local name="$1" want="$2"; shift 2
  local out rc
  out=$("$@" 2>/dev/null); rc=$?
  if [ $rc -ne 0 ]; then
    _v_note "INCONCLUSIVE  $name — command exited $rc; cannot distinguish 'none found' from 'could not look'"
    _v_rc=$VERIFY_INCONCLUSIVE; return $VERIFY_INCONCLUSIVE
  fi
  local got; got=$(printf '%s' "$out" | grep -c . || true)
  assert_eq "$name" "$want" "$got"
}

# assert_grep_count NAME EXPECTED_N COMMAND...
# For grep/rg only, where exit 1 genuinely means "ran fine, matched nothing". Anything
# else (2 = file unreadable / bad pattern) stays INCONCLUSIVE. Opt in deliberately — do
# not reach for this just because a command happened to exit 1.
assert_grep_count() {
  local name="$1" want="$2"; shift 2
  local out rc
  out=$("$@" 2>/dev/null); rc=$?
  if [ $rc -gt 1 ]; then
    _v_note "INCONCLUSIVE  $name — grep exited $rc (unreadable file or bad pattern), not a zero-match result"
    _v_rc=$VERIFY_INCONCLUSIVE; return $VERIFY_INCONCLUSIVE
  fi
  local got; got=$(printf '%s' "$out" | grep -c . || true)
  assert_eq "$name" "$want" "$got"
}

# assert_nonvacuous NAME MIN_N COMMAND...
# The scan must have examined something. A search over an empty set trivially finds no
# violations — the false-green shape the empty-scope guards exist for.
assert_nonvacuous() {
  local name="$1" min="$2"; shift 2
  local out rc got
  out=$("$@" 2>/dev/null); rc=$?
  if [ $rc -ne 0 ] && [ $rc -ne 1 ]; then
    _v_note "INCONCLUSIVE  $name — command exited $rc"
    _v_rc=$VERIFY_INCONCLUSIVE; return $VERIFY_INCONCLUSIVE
  fi
  got=$(printf '%s' "$out" | grep -c . || true)
  if [ "$got" -lt "$min" ]; then
    _v_note "INCONCLUSIVE  $name — examined only $got item(s), expected >= $min; refusing to certify a scan that saw almost nothing"
    _v_rc=$VERIFY_INCONCLUSIVE; return $VERIFY_INCONCLUSIVE
  fi
  _v_note "PASS          $name (examined $got)"
}

# assert_absent NAME PATTERN FILE...
# Whole-file search, never a window. Answers "not present in these files", and says so.
# Error #1 was a windowed search reported as a global absence.
assert_absent() {
  local name="$1" pat="$2"; shift 2
  if [ "$#" -eq 0 ]; then
    _v_note "INCONCLUSIVE  $name — no files given to search"
    _v_rc=$VERIFY_INCONCLUSIVE; return $VERIFY_INCONCLUSIVE
  fi
  local f missing=0
  for f in "$@"; do [ -r "$f" ] || missing=$((missing+1)); done
  if [ "$missing" -gt 0 ]; then
    _v_note "INCONCLUSIVE  $name — $missing of $# file(s) unreadable; absence cannot be established over files that were not read"
    _v_rc=$VERIFY_INCONCLUSIVE; return $VERIFY_INCONCLUSIVE
  fi
  local hits; hits=$(grep -n "$pat" "$@" 2>/dev/null | grep -c . || true)
  if [ "$hits" -eq 0 ]; then
    _v_note "PASS          $name (pattern absent across $# file(s), read in full)"; return $VERIFY_PASS
  fi
  _v_note "FAIL          $name — $hits occurrence(s):"
  grep -n "$pat" "$@" 2>/dev/null | head -5 >&2
  [ "$_v_rc" -eq $VERIFY_INCONCLUSIVE ] || _v_rc=$VERIFY_FAIL
  return $VERIFY_FAIL
}

# verify_exit — final status. 2 beats 1 beats 0: an inconclusive run is never reported as
# a clean one just because nothing outright failed.
verify_exit() {
  case $_v_rc in
    0) _v_note "== VERIFIED ==" ;;
    1) _v_note "== FAILED ==" ;;
    2) _v_note "== INCONCLUSIVE — do NOT report this as verified ==" ;;
  esac
  return $_v_rc
}
