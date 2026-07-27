#!/usr/bin/env bash
# Plan-1 (pin foundation) test gate. Run from repo root.
set -euo pipefail
source deploy/scripts/lib/pytest-runner.sh
resolve_pytest_cmd SENTINEL_PYTEST_PYTHON /tmp/sentinel-venv/bin/python python3.12 python3
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
echo "== pytest runner guard =="
bash deploy/scripts/tests/test_pytest_runner.sh
echo "== pin lib coverage gate =="
"${PYTEST_CMD[@]}" "${CURATED_SENTINEL_TEST_FILES[0]}" --cov=sentinel_pin --cov-branch --cov-fail-under=98 --import-mode=importlib -q
echo "== host selfcheck coverage gate =="
"${PYTEST_CMD[@]}" "${CURATED_SENTINEL_TEST_FILES[1]}" --cov=bot_errors_selfcheck --cov-branch --cov-fail-under=98 --import-mode=importlib -q
echo "== fleet sentinel coverage gate =="
"${PYTEST_CMD[@]}" "${CURATED_SENTINEL_TEST_FILES[2]}" --cov=bot_errors_sentinel --cov-branch --cov-fail-under=98 --import-mode=importlib -q
echo "== heartbeat watchdog central-liveness gate =="
"${PYTEST_CMD[@]}" "${CURATED_SENTINEL_TEST_FILES[3]}" --import-mode=importlib -q
echo "== redaction parity gate (BEAD-052) =="
"${PYTEST_CMD[@]}" "${CURATED_SENTINEL_TEST_FILES[4]}" --import-mode=importlib -q
echo "== gui-session-monitor coverage gate =="
"${PYTEST_CMD[@]}" "${CURATED_SENTINEL_TEST_FILES[5]}" --cov=bot_errors_gui_session_monitor --cov-branch --cov-fail-under=98 --import-mode=importlib -q
echo "== deployer pin mode =="
bash deploy/scripts/tests/test_deployer_pin_mode.sh | tee "$tmp/pin_mode.out" | grep -q PIN_TEST_PASS || { echo "pin mode FAIL"; cat "$tmp/pin_mode.out"; exit 1; }
echo "== deployer static guard =="
bash deploy/scripts/tests/test_deployer_static.sh | tee "$tmp/static.out" | grep -q STATIC_PASS || { echo "static FAIL"; cat "$tmp/static.out"; exit 1; }
echo "== deployer mutation guard =="
bash deploy/scripts/tests/test_deployer_mutation.sh | tee "$tmp/deployer_mutation.out" | grep -q DEPLOYER_MUTATION_PASS || { echo "deployer mutation FAIL"; cat "$tmp/deployer_mutation.out"; exit 1; }
echo "== selfcheck installer static guard =="
bash deploy/scripts/tests/test_selfcheck_installer.sh | tee "$tmp/selfcheck_installer.out" | grep -q SELFCHECK_INSTALLER_PASS || { echo "selfcheck installer FAIL"; cat "$tmp/selfcheck_installer.out"; exit 1; }
echo "== sentinel installer static guard =="
bash deploy/scripts/tests/test_sentinel_installer.sh | tee "$tmp/sentinel_installer.out" | grep -q SENTINEL_INSTALLER_PASS || { echo "sentinel installer FAIL"; cat "$tmp/sentinel_installer.out"; exit 1; }
echo "== runtime-receipt capture producer gate (#1867) =="
"${PYTEST_CMD[@]}" deploy/scripts/receipts/tests/test_capture_runtime_receipt.py --import-mode=importlib -q
echo "ALL_SENTINEL_PLAN1_PLAN2_TESTS_PASS"
