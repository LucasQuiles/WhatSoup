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

run_plugin() {
  if [[ "${#scan_paths[@]}" -eq 0 ]]; then
    "$PLUGIN_BIN" baseline --check --ci
  else
    "$PLUGIN_BIN" baseline --check --ci "${scan_paths[@]}"
  fi
}

echo "Running test-integrity baseline --check --ci (${#scan_paths[@]} candidate file(s))"

# The plugin's tree-sitter pass intermittently faults on CI runners and then
# reports parse errors on files the diff never touched (observed on PRs #3171,
# #3174, #3175 — roving victims across .sh/.py/.mjs, never reproducible
# locally on the identical tree). When the ONLY net-new findings are that
# class, one retry discriminates: a runner fault clears, a genuinely
# unparseable file reproduces and still fails. Any other net-new finding
# fails immediately — this retry never masks a real integrity regression.
set +e
first_output="$(run_plugin 2>&1)"
first_rc=$?
set -e
printf '%s\n' "$first_output"
if [[ "$first_rc" -eq 0 ]]; then
  exit 0
fi

new_lines="$(printf '%s\n' "$first_output" | grep '^NEW ' || true)"
if [[ -z "$new_lines" ]]; then
  exit "$first_rc"
fi
non_parse_new="$(printf '%s\n' "$new_lines" | grep -cv '^NEW test-file-tree-sitter-parse-error ' || true)"
if [[ "$non_parse_new" != "0" ]]; then
  exit "$first_rc"
fi

echo "test-integrity: all net-new findings are tree-sitter parse errors — retrying once to discriminate a runner fault from a real parse regression" >&2
set +e
second_output="$(run_plugin 2>&1)"
second_rc=$?
set -e
printf '%s\n' "$second_output"
exit "$second_rc"
