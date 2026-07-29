# Runtime Health Signal Dispositions Implementation Plan

> Execute in the isolated branch
> `fix/runtime-health-signal-dispositions-2541-2544-20260728`.

**Status:** active

**Goal:** Remove sticky runtime-health warnings caused by historical/audit
counters while preserving genuine current-risk signals and adding bounded
current auto-compaction evidence.

**Architecture:** Extend the existing fault-taxonomy registry to schema v3 with
an ordered runtime-agent signal contract. TypeScript validates and exposes the
contract for drift tests; the bundled Python health checker loads the same JSON
and derives severity only from declared dispositions. `AutoCompactController`
publishes an aggregate, identity-free current backoff snapshot which
`AgentRuntime` uses for both status and health details.

**Constraints:** No deployment, restart, live-state mutation, migration, or
operational-data access. Preserve existing public field names and historical
counters. Shared evidence may contain only bounded enums, counts, timestamps,
ages, and tiers. Production Python must remain self-contained except for
explicitly bundled and integrity-pinned data files.

---

## Task 1: Make the registry an enforced runtime-signal contract

**Files:**

- Modify: `src/lib/fault-taxonomy-registry.json`
- Modify: `src/lib/fault-classifier.ts`
- Modify: `tests/core/failure-taxonomy-cross-contract.test.ts`
- Modify: `deploy/scripts/tests/test_bot_errors_fault_taxonomy_registry.py`

1. Add failing TypeScript and Python tests for schema v3, the complete ordered
   numeric checker field inventory, allowed signal kinds/effects, unique
   fields/labels, owner/test references, and exact owner-domain parity.
2. Run:
   `npm test -- tests/core/failure-taxonomy-cross-contract.test.ts --pool=forks --fileParallelism=false --retry=0`
   and
   `python3 -m unittest deploy/scripts/tests/test_bot_errors_fault_taxonomy_registry.py`.
   Confirm both fail because v2 has no runtime signal registry.
3. Add typed `RuntimeAgentHealthSignal` declarations and validated/frozen
   exports. Advance the JSON schema to v3 and register each numeric checker
   field as current risk or diagnostic according to the producer contract.
4. Re-run both focused suites and confirm they pass.

## Task 2: Add identity-free current auto-compaction state

**Files:**

- Modify: `src/runtimes/agent/auto-compact-controller.ts`
- Modify: `tests/runtimes/agent/auto-compact-controller.test.ts`
- Modify: `src/runtimes/agent/runtime.ts`
- Modify: `tests/runtimes/agent/health-snapshot.test.ts`
- Modify: `tests/runtimes/agent/runtime-turn-recovery-health.test.ts`

1. Add fake-clock tests for idle state, active backoff, multiple-scope
   aggregation, tier saturation, expiry, cleanup, shutdown, and preservation of
   lifetime totals. Add runtime tests proving active backoff alone degrades and
   later expiry/cleanup recovers without resetting totals.
2. Run the focused tests and confirm they fail because no aggregate health
   snapshot exists.
3. Add `AutoCompactHealthSnapshot` and a pure `healthSnapshot(now)` projection.
   A scope is active only when its rapid-rearm count is positive and its
   cooldown deadline is in the future. Return only state, active-scope count,
   and a capped worst tier.
4. Project the fields from both runtime health branches and add
   `auto_compact_backoff` to runtime `degradedReasons` only while the active
   count is positive.
5. Re-run the focused tests and confirm they pass.

## Task 3: Replace numeric severity inference in the Python checker

**Files:**

- Modify: `deploy/scripts/bot-errors-health-check.py`
- Modify: `tests/scripts/bot-errors-health-check.test.ts`

1. Add behavior tests using healthy synthetic bodies for:
   historical auto-compaction totals, blocked-unsafe receipts, poll-persistence
   totals, active auto-compaction backoff, genuine recovery obligations, and a
   missing/malformed registry.
2. Confirm the historical/audit cases fail because the current generic loop
   produces `runtime_agent_at_risk`.
3. Implement a bounded registry loader that validates schema, fields, labels,
   kinds, effects, and duplicates. Render registered evidence in order; add risk
   only for positive `positive_is_risk` entries. Render `autoCompactState`
   through an allowlisted enum.
4. On missing or malformed registry data, emit
   `runtime_agent_health_signal_registry_invalid`, include only a bounded error
   class, and make the probe WARN without inferring field severity.
5. Re-run the focused checker suite and confirm all matrix cases pass.

## Task 4: Pin the new runtime dependency and enforce deploy parity

**Files:**

- Modify: `scripts/check-bot-errors-runtime-manifest.ts`
- Modify: `deploy/scripts/whatsoup-bot-errors-deploy.sh`
- Modify: `deploy/bot-errors-runtime-manifest.json`
- Modify: `tests/scripts/check-bot-errors-runtime-manifest.test.ts`
- Modify: `tests/scripts/deployer-static-parity.test.ts`
- Modify: deployer Python/shell tests only where their exact managed-file
  fixtures require the new path

1. Add failing manifest/deployer tests that require
   `src/lib/fault-taxonomy-registry.json` in both the explicit required runtime
   set and the deployer's literal managed-file set.
2. Add the registry path to both production sets, update fixture expectations,
   and pin exact final hashes/markers in the runtime manifest.
3. Run:
   `npm run guard:bot-errors-runtime-manifest`,
   `npm run guard:deployer-static`,
   the runtime-manifest/deployer Vitest suites, the Python deploy tests, and
   `deploy/scripts/tests/test_deployer_mutation.sh`.

## Task 5: Cross-consumer verification and documentation

**Files:**

- Modify: `docs/runbook.md` or the existing BOT ERRORS health runbook section
- Modify: relevant contract tests if parity gaps remain

1. Document that cumulative totals, historical maxima, and terminal audit
   counts are evidence only; current registered conditions determine risk.
2. Add a compact cross-consumer matrix proving the same synthetic states agree
   across controller/runtime/core/checker where those consumers apply.
3. Run focused runtime, core-health, checker, taxonomy, manifest, deployer, and
   privacy/publication tests. Run typechecks and source lint.
4. Run `npm run verify:push:branch`. Any masked, skipped, or interrupted failure
   is inconclusive and must be reported and rerun or explicitly disclosed.

## Task 6: Review, publish the draft, and update issues

1. Self-review the complete diff, inspect history, and compare against current
   open PRs for overlap.
2. Obtain independent OpenCode implementation review, then verify every material
   finding against source and tests.
3. Commit only public-safe scoped changes. Push over the SSH origin.
4. Open one grouped draft PR referencing and closing #2541 and #2544 while
   referencing #2447 as the broader follow-up boundary.
5. Confirm GitHub's automatic issue references on #2541 and #2544. If a draft
   reference is absent, add one concise issue comment with the draft PR URL and
   exact tested head.
6. Wait for exact-head draft CI. When required checks are green, replace
   `IN PROGRESS` with `PATCH READY` on #2541 and #2544 and post the final
   verification receipt. Leave #2447 open and unchanged.
