#!/usr/bin/env bash

# The curated 98%-branch-coverage-floor suite: every deploy/scripts/tests/
# file that run-sentinel-tests.sh gives its own dedicated pytest invocation
# (with or without a --cov floor). Single source of truth, sourced by both
# run-sentinel-tests.sh (which pytest-invokes each of these individually) and
# run-bot-errors-full-suite.sh (which --ignore's every one of these, so the
# curated coverage-floor gate stays the sole authority for them and they
# never run twice per matrix leg). Edit this array to add/remove/rename a
# curated file; both scripts pick up the change with no separate edit and no
# sync-guard test is needed -- drift between the two consumers becomes
# structurally impossible.
CURATED_SENTINEL_TEST_FILES=(
  deploy/scripts/tests/test_sentinel_pin.py
  deploy/scripts/tests/test_bot_errors_selfcheck.py
  deploy/scripts/tests/test_bot_errors_sentinel.py
  deploy/scripts/tests/test_bot_errors_heartbeat_watchdog_auth.py
  deploy/scripts/tests/test_bot_errors_redaction_parity.py
  deploy/scripts/tests/test_bot_errors_gui_session_monitor.py
)

# Resolve a pytest-capable command into PYTEST_CMD.
#
# Usage:
#   resolve_pytest_cmd SENTINEL_PYTEST_PYTHON /tmp/sentinel-venv/bin/python python3.12 python3
#
# Exit codes:
#   0 = PYTEST_CMD is set
#   2 = no pytest-capable runner found
resolve_pytest_cmd() {
  local env_name="$1"
  local venv_python="$2"
  shift 2

  PYTEST_CMD=()

  local explicit="${!env_name:-}"
  if [ -n "$explicit" ]; then
    if [ -x "$explicit" ] && "$explicit" -c 'import pytest' >/dev/null 2>&1; then
      PYTEST_CMD=("$explicit" -m pytest)
      return 0
    fi
    echo "$env_name=$explicit does not have pytest; cannot run sentinel Python tests" >&2
    return 2
  fi

  if [ -x "$venv_python" ] && "$venv_python" -c 'import pytest' >/dev/null 2>&1; then
    PYTEST_CMD=("$venv_python" -m pytest)
    return 0
  fi

  local python_bin
  for python_bin in "$@"; do
    if command -v "$python_bin" >/dev/null 2>&1 && "$python_bin" -c 'import pytest' >/dev/null 2>&1; then
      PYTEST_CMD=("$python_bin" -m pytest)
      return 0
    fi
  done

  if command -v pytest >/dev/null 2>&1; then
    PYTEST_CMD=(pytest)
    return 0
  fi

  echo "pytest is required to run sentinel Python tests" >&2
  return 2
}
