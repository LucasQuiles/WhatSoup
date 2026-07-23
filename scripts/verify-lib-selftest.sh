#!/usr/bin/env bash
source "$(dirname "$0")/lib/verify-lib.sh"
echo "### Each case reproduces one real error from this session ###"
echo
echo "-- Error 4: empty == empty must NOT be a pass --"
assert_eq "two empty values" "" ""; echo "   rc=$?  (want 2)"
echo
echo "-- control: a genuine match still passes --"
assert_eq "real match" "abc123" "abc123"; echo "   rc=$?  (want 0)"
echo
echo "-- control: a genuine mismatch still fails --"
assert_eq "real mismatch" "abc" "xyz"; echo "   rc=$?  (want 1)"
echo
echo "-- Error 1: a search that ERRORED must not read as 'found nothing' --"
assert_count "errored search" 0 ls /definitely/not/here; echo "   rc=$?  (want 2)"
echo
echo "-- control: assert_count on a command that genuinely exits 0 --"
assert_count "real count" 2 printf 'a\nb\n'; echo "   rc=$?  (want 0)"
echo
echo "-- assert_grep_count: exit 1 IS a valid zero-match for grep --"
assert_grep_count "grep no match" 0 grep "zzz-nope" /etc/hosts; echo "   rc=$?  (want 0)"
echo
echo "-- assert_grep_count: exit 2 (unreadable) is still INCONCLUSIVE --"
assert_grep_count "grep unreadable" 0 grep "x" /definitely/not/here; echo "   rc=$?  (want 2)"
echo
echo "-- Error: a scan over almost nothing must not certify --"
assert_nonvacuous "vacuous scan" 100 echo "one-line"; echo "   rc=$?  (want 2)"
echo
echo "-- absence over an unreadable file must be INCONCLUSIVE, not 'absent' --"
assert_absent "unreadable file" "needle" /definitely/not/here; echo "   rc=$?  (want 2)"
echo
echo "-- absence over a real file with no match is a genuine PASS --"
printf 'alpha\nbeta\n' > /tmp/vl-fixture.txt
assert_absent "real absence" "needle" /tmp/vl-fixture.txt; echo "   rc=$?  (want 0)"
echo
echo "-- and a real hit still FAILS --"
printf 'alpha\nneedle here\n' > /tmp/vl-fixture2.txt
assert_absent "real hit" "needle" /tmp/vl-fixture2.txt; echo "   rc=$?  (want 1)"
rm -f /tmp/vl-fixture.txt /tmp/vl-fixture2.txt
echo
verify_exit; rc=$?
echo "FINAL rc=$rc  (want 2 — inconclusive outranks fail and pass)"
# exit with the REAL status, not the echo's. A trailing command after the thing under test
# masks its exit code — failure class #10 — and this file reproduced it on first write:
# the script printed "FINAL rc=2" while exiting 0, so a caller checking $? saw a clean run.
exit "$rc"
