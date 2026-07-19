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

# Left unscoped, the plugin's own file-discovery defaults to a recursive
# walk from "." with a generic vendor-path denylist that has no notion of
# this repo's per-agent worktree checkouts under .claude/worktrees/ (it only
# knows a top-level ".worktrees" convention). Each nested checkout is a
# separate, unrelated git worktree, not part of the tree being pushed, so
# scanning it floods the gate with hundreds of findings for files nobody is
# committing.
#
# Scope the scan explicitly to this repo's own candidate files instead: the
# tracked index (--cached) plus untracked-but-not-ignored files
# (--others --exclude-standard), with worktree checkouts excluded via git
# pathspec magic so the exclusion holds even on a clone that has no local
# .git/info/exclude entry for .claude/worktrees/ (this machine happens to
# have one; CI and other clones cannot be assumed to). Passing files
# individually (rather than directories) also means the plugin's own
# is_test_surface() gate still applies to every path exactly as before —
# nothing under a real repo path loses coverage.
scan_paths=()
while IFS= read -r candidate; do
  scan_paths+=("$candidate")
done < <(git ls-files --cached --others --exclude-standard -- . ':!.claude/worktrees/**')

echo "Running test-integrity baseline --check --ci (${#scan_paths[@]} candidate file(s))"
if [[ "${#scan_paths[@]}" -eq 0 ]]; then
  "$PLUGIN_BIN" baseline --check --ci
else
  "$PLUGIN_BIN" baseline --check --ci "${scan_paths[@]}"
fi
