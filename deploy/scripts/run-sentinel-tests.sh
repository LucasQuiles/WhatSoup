#!/usr/bin/env bash
# Plan-1 (pin foundation) test gate. Run from repo root.
set -euo pipefail
PY=${SENTINEL_PYTEST_PYTHON:-}
if [[ -z "$PY" ]]; then
  if [[ -x /tmp/sentinel-venv/bin/python ]]; then PY=/tmp/sentinel-venv/bin/python; else PY=python3; fi
fi
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
echo "== pin lib coverage gate =="
"$PY" -m pytest deploy/scripts/tests/test_sentinel_pin.py --cov=sentinel_pin --cov-branch --cov-fail-under=98 --import-mode=importlib -q
echo "== host selfcheck coverage gate =="
"$PY" -m pytest deploy/scripts/tests/test_bot_errors_selfcheck.py --cov=bot_errors_selfcheck --cov-branch --cov-fail-under=98 --import-mode=importlib -q
echo "== deployer pin mode =="
bash deploy/scripts/tests/test_deployer_pin_mode.sh | tee "$tmp/pin_mode.out" | grep -q PIN_TEST_PASS || { echo "pin mode FAIL"; cat "$tmp/pin_mode.out"; exit 1; }
echo "== deployer static guard =="
bash deploy/scripts/tests/test_deployer_static.sh | tee "$tmp/static.out" | grep -q STATIC_PASS || { echo "static FAIL"; cat "$tmp/static.out"; exit 1; }
echo "ALL_SENTINEL_PLAN1_PLAN2_TESTS_PASS"
