#!/usr/bin/env bash

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
