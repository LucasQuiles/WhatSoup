#!/bin/bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
HELPER="$ROOT/deploy/scripts/lib/pytest-runner.sh"
GATE="$ROOT/deploy/scripts/run-sentinel-tests.sh"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

fail() {
  echo "PYTEST_RUNNER_FAIL: $*"
  exit 1
}

fake_python() {
  local path="$1" import_status="$2"
  cat > "$path" <<SH
#!/bin/bash
if [ "\${1:-}" = "-c" ] && [ "\${2:-}" = "import pytest" ]; then
  exit $import_status
fi
if [ "\${1:-}" = "-m" ] && [ "\${2:-}" = "pytest" ]; then
  exit 0
fi
exit 97
SH
  chmod +x "$path"
}

fake_pytest() {
  local path="$1"
  cat > "$path" <<'SH'
#!/bin/bash
exit 0
SH
  chmod +x "$path"
}

assert_cmd() {
  local expected="$1"
  shift
  local actual="$*"
  [ "$actual" = "$expected" ] || fail "expected [$expected], got [$actual]"
}

source "$HELPER"

case_explicit_env_wins() {
  local bin="$tmp/explicit"
  mkdir -p "$bin"
  fake_python "$bin/python-explicit" 0
  PATH="$bin" SENTINEL_PYTEST_PYTHON="$bin/python-explicit" \
    resolve_pytest_cmd SENTINEL_PYTEST_PYTHON /tmp/missing-sentinel-python python3.12 python3
  assert_cmd "$bin/python-explicit -m pytest" "${PYTEST_CMD[@]}"
}

case_explicit_env_fails_closed() {
  local bin="$tmp/explicit-bad"
  mkdir -p "$bin"
  fake_python "$bin/python-explicit" 1
  set +e
  PATH="$bin" SENTINEL_PYTEST_PYTHON="$bin/python-explicit" \
    resolve_pytest_cmd SENTINEL_PYTEST_PYTHON /tmp/missing-sentinel-python python3.12 python3 \
    > "$tmp/explicit-bad.out" 2> "$tmp/explicit-bad.err"
  local rc=$?
  set -e
  [ "$rc" -eq 2 ] || fail "bad explicit env should exit 2, got $rc"
  grep -q "does not have pytest" "$tmp/explicit-bad.err" || fail "bad explicit env did not explain pytest absence"
}

case_venv_wins_before_path() {
  local bin="$tmp/venv-path"
  local venv="$tmp/sentinel-venv/bin"
  mkdir -p "$bin" "$venv"
  fake_python "$venv/python" 0
  fake_python "$bin/python3.12" 0
  PATH="$bin" resolve_pytest_cmd SENTINEL_PYTEST_PYTHON "$venv/python" python3.12 python3
  assert_cmd "$venv/python -m pytest" "${PYTEST_CMD[@]}"
}

case_python312_wins_over_python3() {
  local bin="$tmp/path-order"
  mkdir -p "$bin"
  fake_python "$bin/python3.12" 0
  fake_python "$bin/python3" 0
  PATH="$bin" resolve_pytest_cmd SENTINEL_PYTEST_PYTHON /tmp/missing-sentinel-python python3.12 python3
  assert_cmd "python3.12 -m pytest" "${PYTEST_CMD[@]}"
}

case_pytest_fallback() {
  local bin="$tmp/fallback"
  mkdir -p "$bin"
  fake_python "$bin/python3.12" 1
  fake_python "$bin/python3" 1
  fake_pytest "$bin/pytest"
  PATH="$bin" resolve_pytest_cmd SENTINEL_PYTEST_PYTHON /tmp/missing-sentinel-python python3.12 python3
  assert_cmd "pytest" "${PYTEST_CMD[@]}"
}

case_no_runner_fails_closed() {
  local bin="$tmp/no-runner"
  mkdir -p "$bin"
  fake_python "$bin/python3.12" 1
  fake_python "$bin/python3" 1
  set +e
  PATH="$bin" resolve_pytest_cmd SENTINEL_PYTEST_PYTHON /tmp/missing-sentinel-python python3.12 python3 \
    > "$tmp/no-runner.out" 2> "$tmp/no-runner.err"
  local rc=$?
  set -e
  [ "$rc" -eq 2 ] || fail "no runner should exit 2, got $rc"
  grep -q "pytest is required" "$tmp/no-runner.err" || fail "no runner error message missing"
}

case_gate_uses_resolver() {
  grep -q "resolve_pytest_cmd" "$GATE" || fail "sentinel gate does not call resolver"
  grep -Fq '"${PYTEST_CMD[@]}"' "$GATE" || fail "sentinel gate does not execute resolved pytest command"
}

case_explicit_env_wins
case_explicit_env_fails_closed
case_venv_wins_before_path
case_python312_wins_over_python3
case_pytest_fallback
case_no_runner_fails_closed
case_gate_uses_resolver

echo "PYTEST_RUNNER_TEST_PASS"
