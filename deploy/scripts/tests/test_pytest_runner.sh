#!/usr/bin/env bash
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
#!/usr/bin/env bash
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
#!/usr/bin/env bash
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
# Resolver cases own their environment; the operator's interpreter selection
# remains intact in the parent gate and must not override a fixture's premise.
unset SENTINEL_PYTEST_PYTHON

case_explicit_env_wins() {
  local bin="$tmp/explicit"
  mkdir -p "$bin"
  fake_python "$bin/python-explicit" 0
  PATH="$bin:$PATH" SENTINEL_PYTEST_PYTHON="$bin/python-explicit" \
    resolve_pytest_cmd SENTINEL_PYTEST_PYTHON /tmp/missing-sentinel-python python3.12 python3
  assert_cmd "$bin/python-explicit -m pytest" "${PYTEST_CMD[@]}"
}

case_explicit_env_fails_closed() {
  local bin="$tmp/explicit-bad"
  mkdir -p "$bin"
  fake_python "$bin/python-explicit" 1
  set +e
  PATH="$bin:$PATH" SENTINEL_PYTEST_PYTHON="$bin/python-explicit" \
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
  PATH="$bin:$PATH" resolve_pytest_cmd SENTINEL_PYTEST_PYTHON "$venv/python" python3.12 python3
  assert_cmd "$venv/python -m pytest" "${PYTEST_CMD[@]}"
}

case_python312_wins_over_python3() {
  local bin="$tmp/path-order"
  mkdir -p "$bin"
  fake_python "$bin/python3.12" 0
  fake_python "$bin/python3" 0
  PATH="$bin:$PATH" resolve_pytest_cmd SENTINEL_PYTEST_PYTHON /tmp/missing-sentinel-python python3.12 python3
  assert_cmd "python3.12 -m pytest" "${PYTEST_CMD[@]}"
}

case_pytest_fallback() {
  local bin="$tmp/fallback"
  mkdir -p "$bin"
  fake_python "$bin/python3.12" 1
  fake_python "$bin/python3" 1
  fake_pytest "$bin/pytest"
  PATH="$bin:$PATH" resolve_pytest_cmd SENTINEL_PYTEST_PYTHON /tmp/missing-sentinel-python python3.12 python3
  assert_cmd "pytest" "${PYTEST_CMD[@]}"
}

case_no_runner_fails_closed() {
  local bin="$tmp/no-runner"
  mkdir -p "$bin"
  fake_python "$bin/python3.12" 1
  fake_python "$bin/python3" 1
  set +e
  PATH="$bin:/usr/bin:/bin" resolve_pytest_cmd SENTINEL_PYTEST_PYTHON /tmp/missing-sentinel-python python3.12 python3 \
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

case_coverage_verdicts_gate_the_real_runner() {
  local bin="$tmp/coverage-gate"
  mkdir -p "$bin"
  # Replace only external test commands. The real gate and resolver still run;
  # the shell-test stub avoids recursively entering this guard from that gate.
  cat > "$bin/bash" <<'SH'
#!/bin/bash
case "$1" in
  deploy/scripts/tests/test_pytest_runner.sh) echo PYTEST_RUNNER_TEST_PASS ;;
  deploy/scripts/tests/test_runtime_path_prepend.sh) echo RUNTIME_PATH_PREPEND_TEST_OK ;;
  deploy/scripts/tests/test_deployer_pin_mode.sh) echo PIN_TEST_PASS ;;
  deploy/scripts/tests/test_deployer_static.sh) echo STATIC_PASS ;;
  deploy/scripts/tests/test_deployer_mutation.sh) echo DEPLOYER_MUTATION_PASS ;;
  deploy/scripts/tests/test_selfcheck_installer.sh) echo SELFCHECK_INSTALLER_PASS ;;
  deploy/scripts/tests/test_sentinel_installer.sh) echo SENTINEL_INSTALLER_PASS ;;
  *) exit 96 ;;
esac
SH
  cat > "$bin/cat" <<'SH'
#!/bin/bash
if [ "$#" -eq 1 ] && /usr/bin/grep -q '^PYTEST_GUARD_READBACK_FAILURE$' "$1"; then
  echo 'fixture log readback failed' >&2
  exit 9
fi
exec /bin/cat "$@"
SH
  cat > "$bin/python" <<'SH'
#!/bin/bash
set -euo pipefail
if [ "${1:-}" = -c ] && [ "${2:-}" = 'import pytest' ]; then exit 0; fi
if [ "${1:-}" != -m ] || [ "${2:-}" != pytest ]; then exit 97; fi
echo "$3" >> "$PYTEST_GATE_TRACE"
if [[ " $* " != *' --cov='* ]]; then echo '1 passed'; exit 0; fi
if [ "$3" = "$PYTEST_GATE_TARGET" ]; then
  case "$PYTEST_GATE_SCENARIO" in
    masked) echo 'FAIL Required test coverage of 98% not reached. Total coverage: 97.78%'; exit 0 ;;
    boundary) echo 'FAIL Required test coverage of 98% not reached. Total coverage: 98.00%'; exit 0 ;;
    stderr) echo 'FAIL Required test coverage of 98% not reached. Total coverage: 97.78%' >&2; exit 0 ;;
    missing) echo '1 passed'; exit 0 ;;
    malformed) echo 'Required test coverage of 98% reached. Total coverage: NaN%'; exit 0 ;;
    inconsistent) echo 'Required test coverage of 98% reached. Total coverage: 97.78%'; exit 0 ;;
    other-floor) echo 'Required test coverage of 0% reached. Total coverage: 99.61%'; exit 0 ;;
    mixed-malformed)
      echo 'Required test coverage of 98% reached. Total coverage: 99.61%'
      echo 'Required test coverage of 98% reached. Total coverage: NaN%'
      exit 0 ;;
    mixed-inconsistent)
      echo 'Required test coverage of 98% reached. Total coverage: 99.61%'
      echo 'Required test coverage of 98% reached. Total coverage: 97.78%'
      exit 0 ;;
    mixed-other-floor)
      echo 'Required test coverage of 98% reached. Total coverage: 99.61%'
      echo 'Required test coverage of 0% reached. Total coverage: 99.61%'
      exit 0 ;;
    duplicate)
      echo 'Required test coverage of 98% reached. Total coverage: 99.61%'
      echo 'Required test coverage of 98% reached. Total coverage: 99.61%'
      exit 0 ;;
    contradictory)
      echo 'Required test coverage of 98% reached. Total coverage: 99.61%'
      echo 'FAIL Required test coverage of 98% not reached. Total coverage: 97.78%'
      exit 0 ;;
    no-tests) echo 'no tests ran'; exit 5 ;;
    tool-error) echo 'pytest configuration error' >&2; exit 2 ;;
    readback-failure) echo PYTEST_GUARD_READBACK_FAILURE; echo 'no tests ran'; exit 5 ;;
    readback-success)
      echo PYTEST_GUARD_READBACK_FAILURE
      echo 'Required test coverage of 98% reached. Total coverage: 99.61%'
      exit 0 ;;
    exact-floor) echo 'Required test coverage of 98% reached. Total coverage: 98.00%'; exit 0 ;;
  esac
fi
echo 'Required test coverage of 98% reached. Total coverage: 99.61%'
echo '1 passed'
SH
  chmod +x "$bin/bash" "$bin/python" "$bin/cat"

  local scenario index rc expected_rc expected_calls
  local trace="$bin/trace" output="$bin/output"
  # Each coverage call site must protect the whole gate, not only the first.
  for index in 0 1 2 5; do
    for scenario in masked boundary stderr missing malformed inconsistent other-floor mixed-malformed mixed-inconsistent mixed-other-floor duplicate contradictory no-tests tool-error readback-failure readback-success; do
      : > "$trace"
      rc=0
      (
        cd "$ROOT"
        PATH="$bin:$PATH" SENTINEL_PYTEST_PYTHON="$bin/python" \
          PYTEST_GATE_TRACE="$trace" PYTEST_GATE_TARGET="${CURATED_SENTINEL_TEST_FILES[$index]}" \
          PYTEST_GATE_SCENARIO="$scenario" /bin/bash "$GATE"
      ) > "$output" 2>&1 || rc=$?
      expected_rc=1
      if [ "$scenario" = no-tests ] || [ "$scenario" = readback-failure ]; then expected_rc=5; fi
      if [ "$scenario" = tool-error ] || [ "$scenario" = readback-success ]; then expected_rc=2; fi
      [ "$rc" -eq "$expected_rc" ] || fail "coverage site $index/$scenario: expected exit $expected_rc, got $rc"
      if grep -q ALL_SENTINEL_PLAN1_PLAN2_TESTS_PASS "$output"; then
        fail "coverage site $index/$scenario emitted the final success marker"
      fi
      expected_calls=$((index + 1))
      [ "$(wc -l < "$trace" | tr -d ' ')" -eq "$expected_calls" ] || fail "coverage site $index/$scenario did not stop at the offending suite"
      grep -Fxq "${CURATED_SENTINEL_TEST_FILES[$index]}" "$trace" || fail "coverage site $index/$scenario was not reached"
      if [ "$scenario" = masked ] || [ "$scenario" = stderr ]; then
        grep -q 'FAIL Required test coverage.*97.78%' "$output" || fail "coverage failure output was lost"
      fi
    done
  done

  # Valid behavior still reaches the real final marker and all seven Python
  # suites, including the receipt test outside the curated array.
  for scenario in valid exact-floor; do
    : > "$trace"
    rc=0
    (
      cd "$ROOT"
      PATH="$bin:$PATH" SENTINEL_PYTEST_PYTHON="$bin/python" \
        PYTEST_GATE_TRACE="$trace" PYTEST_GATE_TARGET="${CURATED_SENTINEL_TEST_FILES[2]}" \
        PYTEST_GATE_SCENARIO="$scenario" /bin/bash "$GATE"
    ) > "$output" 2>&1 || rc=$?
    [ "$rc" -eq 0 ] || fail "valid coverage $scenario failed with exit $rc"
    grep -q '^ALL_SENTINEL_PLAN1_PLAN2_TESTS_PASS$' "$output" || fail "valid coverage $scenario did not complete the gate"
    [ "$(wc -l < "$trace" | tr -d ' ')" -eq 7 ] || fail "valid coverage $scenario skipped a Python suite"
  done
}

case_explicit_env_wins
case_explicit_env_fails_closed
case_venv_wins_before_path
case_python312_wins_over_python3
case_pytest_fallback
case_no_runner_fails_closed
case_gate_uses_resolver
case_coverage_verdicts_gate_the_real_runner

echo "PYTEST_RUNNER_TEST_PASS"
