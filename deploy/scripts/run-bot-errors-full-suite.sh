#!/usr/bin/env bash
# BOT ERRORS full behavioral-suite gate (HD-06). Blanket regression net: every
# deploy/scripts/tests/*.py test runs here, not just the curated 98%-floor
# subset in run-sentinel-tests.sh. No --cov flags — this is presence-of-a-CI-
# gate, not a coverage floor; run-sentinel-tests.sh already owns the floor
# gates for the modules it covers and is untouched by this script. Directory
# collection means a newly added test_bot_errors_*.py file is swept in
# automatically with no script edit required.
#
# CURATED_SENTINEL_TEST_FILES (lib/pytest-runner.sh) already runs each of
# these six -- with its own --cov floor -- in the earlier "BOT ERRORS
# sentinel coverage and deployer mutation gate" step in the same quality.yml
# job, so --ignore them here rather than collecting them a second time with
# no added signal (same class of waste quality.yml's own "Test suite +
# coverage thresholds" step comment already condemns for the JS side:
# "doubling test wall-time per matrix leg for zero added signal"). The
# curated gate stays the authoritative coverage-floor check for these six;
# this step's job is everything ELSE in the directory. Deriving the --ignore
# list from the SAME array run-sentinel-tests.sh pytest-invokes (rather than
# a second hardcoded copy here) makes drift between the two consumers
# structurally impossible.
set -euo pipefail
source deploy/scripts/lib/pytest-runner.sh
resolve_pytest_cmd SENTINEL_PYTEST_PYTHON /tmp/sentinel-venv/bin/python python3.12 python3
IGNORED_CURATED_FILES=()
for f in "${CURATED_SENTINEL_TEST_FILES[@]}"; do
  IGNORED_CURATED_FILES+=(--ignore="$f")
done
echo "== BOT ERRORS full behavioral suite (deploy/scripts/tests/) =="
"${PYTEST_CMD[@]}" deploy/scripts/tests/ "${IGNORED_CURATED_FILES[@]}" --import-mode=importlib -q
echo "ALL_BOT_ERRORS_FULL_SUITE_TESTS_PASS"
