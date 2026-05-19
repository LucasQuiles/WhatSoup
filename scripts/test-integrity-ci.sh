#!/usr/bin/env bash
# CI wrapper for the test-integrity plugin (refs #511).
#
# Runs the project's test-integrity baseline check, treating the baseline at
# `.claude/test-integrity/baseline.json` as the gate: any finding that is not
# in the baseline (i.e. net-new) fails CI. Pre-existing findings recorded in
# the baseline file pass through.
#
# Skips gracefully (exit 0) when the test-integrity plugin is not installed on
# a local developer machine. In CI, absence is a hard failure so the release
# gate cannot silently pass without running the baseline.

set -euo pipefail

PLUGIN_BIN="${TEST_INTEGRITY_BIN:-$HOME/.claude/plugins/test-integrity/scripts/test-integrity}"

if [[ ! -x "$PLUGIN_BIN" ]]; then
  if [[ "${WHATSOUP_REQUIRE_TEST_INTEGRITY:-0}" == "1" || "${CI:-}" == "true" || "${GITHUB_ACTIONS:-}" == "true" ]]; then
    reason="required"
    [[ "${WHATSOUP_REQUIRE_TEST_INTEGRITY:-0}" == "1" ]] && reason="WHATSOUP_REQUIRE_TEST_INTEGRITY=1"
    [[ "${CI:-}" == "true" ]] && reason="CI=true"
    [[ "${GITHUB_ACTIONS:-}" == "true" ]] && reason="GITHUB_ACTIONS=true"
    echo "test-integrity plugin not found at $PLUGIN_BIN ($reason)" >&2
    exit 2
  fi
  echo "test-integrity plugin not found at $PLUGIN_BIN; skipping (set WHATSOUP_REQUIRE_TEST_INTEGRITY=1 to fail instead)" >&2
  exit 0
fi

echo "Running test-integrity baseline --check --ci"
"$PLUGIN_BIN" baseline --check --ci
