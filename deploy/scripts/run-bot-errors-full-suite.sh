#!/usr/bin/env bash
# BOT ERRORS full behavioral-suite gate (HD-06). Blanket regression net: every
# deploy/scripts/tests/*.py test runs here, not just the curated 98%-floor
# subset in run-sentinel-tests.sh. No --cov flags — this is presence-of-a-CI-
# gate, not a coverage floor; run-sentinel-tests.sh already owns the floor
# gates for the modules it covers and is untouched by this script. Directory
# collection means a newly added test_bot_errors_*.py file is swept in
# automatically with no script edit required.
#
# The six files below already run (with their own --cov floor) in the
# earlier "BOT ERRORS sentinel coverage and deployer mutation gate" step in
# the same quality.yml job, so --ignore them here rather than collecting
# them a second time with no added signal (same class of waste quality.yml's
# own "Test suite + coverage thresholds" step comment already condemns for
# the JS side: "doubling test wall-time per matrix leg for zero added
# signal"). The curated gate stays the authoritative coverage-floor check
# for these six; this step's job is everything ELSE in the directory.
set -euo pipefail
IGNORED_CURATED_FILES=(
  --ignore=deploy/scripts/tests/test_sentinel_pin.py
  --ignore=deploy/scripts/tests/test_bot_errors_selfcheck.py
  --ignore=deploy/scripts/tests/test_bot_errors_sentinel.py
  --ignore=deploy/scripts/tests/test_bot_errors_heartbeat_watchdog_auth.py
  --ignore=deploy/scripts/tests/test_bot_errors_redaction_parity.py
  --ignore=deploy/scripts/tests/test_bot_errors_gui_session_monitor.py
)
source deploy/scripts/lib/pytest-runner.sh
resolve_pytest_cmd SENTINEL_PYTEST_PYTHON /tmp/sentinel-venv/bin/python python3.12 python3
echo "== BOT ERRORS full behavioral suite (deploy/scripts/tests/) =="
"${PYTEST_CMD[@]}" deploy/scripts/tests/ "${IGNORED_CURATED_FILES[@]}" --import-mode=importlib -q
echo "ALL_BOT_ERRORS_FULL_SUITE_TESTS_PASS"
