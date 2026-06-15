#!/usr/bin/env bash
# Plan-1 (pin foundation) test gate. Run from repo root.
set -u
PY=${SENTINEL_PYTEST_PYTHON:-/tmp/sentinel-venv/bin/python}
echo "== pin lib coverage gate =="
"$PY" -m pytest deploy/scripts/tests/test_sentinel_pin.py --cov=sentinel_pin --cov-branch --cov-fail-under=98 --import-mode=importlib -q || exit 1
echo "== deployer pin mode =="
bash deploy/scripts/tests/test_deployer_pin_mode.sh | tee /tmp/pin_mode.out | grep -q PIN_TEST_PASS || { echo "pin mode FAIL"; cat /tmp/pin_mode.out; exit 1; }
echo "== deployer static guard =="
bash deploy/scripts/tests/test_deployer_static.sh | grep -q STATIC_PASS || { echo "static FAIL"; exit 1; }
echo "ALL_SENTINEL_PLAN1_TESTS_PASS"
