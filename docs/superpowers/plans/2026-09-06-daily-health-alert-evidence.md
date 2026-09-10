# Daily-health Alert Evidence Implementation Plan

> **For agentic workers:** Use executing-plans for the coupled renderer/test change; use an independent reviewer before integration. Checkboxes record execution, not assumed success.

**Goal:** Keep daily-health failures actionable after bounded backend rendering without changing stored evidence or incident semantics.

**Status:** active

**Architecture:** Reuse the existing daily-health module for the producer's exact line predicates. Apply display ordering and whole-message budgeting only to the dispatcher's exact `daily-health` source. Keep other sources, redaction, requested-action precedence, incident classification and delivery policy unchanged.

**Tech Stack:** Existing Python dispatcher and health producer, pytest, shell failure drills, runtime manifest and release gate.

## Global Constraints

- Keep the 1,800-character evidence and 5,500-character default message limits.
- Do not change producer evidence order, classification, severity, correlation, recovery or suppression.
- Failure and warning membership can overlap; preserve both producer memberships.
- Redact the complete evidence before splitting lines, preserving multiline-secret confinement. Render complete transformed lines, ordered failure / warning-only / context, stable within each group. Count transformed line occurrences, not incidents or assets.
- Reserve omission disclosure before selecting evidence. Omitted failure lines explicitly mean incomplete finding coverage, including potentially the structured asset's finding.
- Keep identity, structured failure, delivery freshness/uncertainty, existing requested action and evidence ahead of optional diagnostics. Never apply a second prefix truncation to the selected result.
- If the core cannot fit, return a bounded, explicitly incomplete fallback. If even that fallback cannot fit, raise a configuration error; do not claim delivery succeeded.
- Keep backend redaction separate from authored-chat fidelity. Do not deploy or publish before the existing gates.
- Work in the existing feature worktree. Keep operational receipts in the existing private lane ledger; this plan is not another backlog.

## Task 1: Regression and renderer repair

**Files:**

- Add `deploy/scripts/tests/test_bot_errors_daily_health_rendering.py` using `support/dispatcher_fixtures.py`.
- Modify `deploy/scripts/lib/bot_errors_daily_health.py`: exact `daily_health_line_is_failure(line: str) -> bool` and `daily_health_line_is_warning(line: str) -> bool` predicates.
- Modify `deploy/scripts/bot-errors-health-check.py`: consume those predicates without changing list order or overlapping membership.
- Modify `deploy/scripts/bot-errors-dispatcher.py`: `format_daily_health_event(core: list[str], evidence: str, details: list[str]) -> str`; reuse `event_text`, `redact` and `requested_action_text` at their existing boundaries.
- Refresh hashes in `deploy/bot-errors-runtime-manifest.json` only for changed runtime files.

**Interfaces:** `format_event(event)` remains the public formatter. The daily renderer receives already-rendered core/detail fields and confined evidence text. It never mutates the event or calls the producer classifier.

- [x] Write the failing regression before production code. The decisive case is:

```python
def test_routine_prefix_cannot_hide_complete_failure(dispatcher):
    finding = "FAIL credential target-file.env: mode=0644 is not private"
    event = daily_event("\n".join(["OK routine " + "x" * 80] * 35 + [finding]))
    text = dispatcher.format_event(event)
    assert finding in text
    assert "requested_action:" in text
    assert "evidence_omitted:" in text
    assert len(text) <= dispatcher.MAX_MESSAGE_CHARS
```

- [x] Run the new file with the existing captured, load-admitted Python command. Require an assertion failure because the full filename is absent, not an import error.
- [x] Add cases for overlapping markers, embedded markers, invalid-JSON config lines, duplicates, multiple failures, long metadata, overlong findings, warning-only events, redaction expansion, Unicode, small caps, malformed evidence, unchanged event/identity and non-allowlisted sources.
- [x] Extract the two existing predicates verbatim. Partition display lines without changing the producer list or adding category-specific classifiers.
- [x] Budget core plus evidence omission metadata first. Pack complete transformed evidence lines within the smaller of the remaining message budget and 1,800 characters. Append complete optional fields only while they and their omission notice fit. Return the composed daily message without the legacy final truncator.
- [x] Run the new file and the complete existing daily-health saliency, legacy-content and requested-action files. Require all tests to pass and inspect stdout/stderr.
- [x] Refresh and check runtime hashes. Review the actual diff and Test Integrity output; do not change the baseline or assertions to hide failure.

## Task 2: Production-path proof and integration

- [x] Run `bash tests/drills/bot-errors-failure-drills.sh` through capture and strict load admission. Keep D22c assertions unchanged. The new pytest file absorbs the existing observer's 0644/0666/0600 cases and retains producer/dispatcher stdout, stderr, queued events and delivered records; this replaces reliance on a private observer for acceptance.
- [x] Run `bash deploy/scripts/run-bot-errors-full-suite.sh`; verify actual discovered/passed counts and retained failures.
- [ ] Run `bash scripts/run-with-pinned-npm.sh run verify:release` under the existing bounded release runner. Use the full-job 60-minute outer allowance already established in the Quality workflow; retain the inner 1,800,000 ms battery limit and all 44 steps. The first outer 30-minute attempt was inconclusive: 40 steps completed, coverage step 41 unfinished, and steps 42–44 unrun. A timeout, skipped required suite or masked failure is not a pass.
- [x] Obtain independent production and final test reviews; update the release note with verified results and remaining limitations.
- [x] Commit only reviewed scoped backend files after verification (`2a67a386`).
- [ ] Re-read remote canonical and PR state, integrate changed canonical if needed and revalidate. Push only the intended branch when pre-push gates pass; satisfy review/protection requirements before merge.
- [ ] Perform a staged live canary only after deployment readiness and rollback checks. Record requested versus observed revision and delivered behavior; then reconcile the owned branches and the existing estate ledger.

## Decision evidence

The retained D22c stage replay proves that the producer detects permissive credential files while the old evidence-prefix renderer cuts the filename. Existing per-instance saliency fixes address different correlation/notification behavior and remain intact. Producer-only reordering, larger caps, a second classifier and a new hook framework do not protect this display invariant.

The [Google SRE monitoring guidance](https://sre.google/sre-book/monitoring-distributed-systems/) favors simple, actionable alerts and preserving the distinction between symptoms and causes. Here that implies a small rendering repair, not a broader alert-classification rewrite.
