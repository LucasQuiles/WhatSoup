#!/usr/bin/env bash
# CI wrapper for the test-integrity plugin (refs #511).
#
# Runs the project's test-integrity baseline check, treating the baseline at
# `.claude/test-integrity/baseline.json` as the gate: any finding that is not
# in the baseline (i.e. net-new) fails CI. Pre-existing findings recorded in
# the baseline file pass through.
#
# Skips gracefully (exit 0) when the test-integrity plugin is not installed on
# the runner. This lets the gate add value in dev environments and local
# pre-push paths today without breaking CI on runners that do not yet have the
# plugin provisioned. Once the plugin is installed in CI, set
# WHATSOUP_REQUIRE_TEST_INTEGRITY=1 to make absence fail instead of skip.

set -euo pipefail

PLUGIN_BIN="${TEST_INTEGRITY_BIN:-$HOME/.claude/plugins/test-integrity/scripts/test-integrity}"

if [[ ! -x "$PLUGIN_BIN" ]]; then
  if [[ "${WHATSOUP_REQUIRE_TEST_INTEGRITY:-0}" == "1" ]]; then
    echo "test-integrity plugin not found at $PLUGIN_BIN (WHATSOUP_REQUIRE_TEST_INTEGRITY=1)" >&2
    exit 2
  fi
  echo "test-integrity plugin not found at $PLUGIN_BIN; skipping (set WHATSOUP_REQUIRE_TEST_INTEGRITY=1 to fail instead)" >&2
  exit 0
fi

echo "Running test-integrity baseline --check --ci"
"$PLUGIN_BIN" baseline --check --ci
