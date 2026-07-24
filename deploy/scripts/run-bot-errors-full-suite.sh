#!/usr/bin/env bash
# BOT ERRORS full behavioral-suite gate (HD-06). Blanket regression net: every
# deploy/scripts/tests/*.py test runs here, not just the curated 98%-floor
# subset in run-sentinel-tests.sh. No --cov flags — this is presence-of-a-CI-
# gate, not a coverage floor; run-sentinel-tests.sh already owns the floor
# gates for the modules it covers and is untouched by this script. Directory
# collection means a newly added test_bot_errors_*.py file is swept in
# automatically with no script edit required.
set -euo pipefail
source deploy/scripts/lib/pytest-runner.sh
resolve_pytest_cmd SENTINEL_PYTEST_PYTHON /tmp/sentinel-venv/bin/python python3.12 python3
echo "== BOT ERRORS full behavioral suite (deploy/scripts/tests/) =="
"${PYTEST_CMD[@]}" deploy/scripts/tests/ --import-mode=importlib -q
echo "ALL_BOT_ERRORS_FULL_SUITE_TESTS_PASS"
