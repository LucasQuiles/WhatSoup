# Turn-Recovery Safety Implementation Plan

**Status:** active

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development or superpowers:executing-plans.
> Every behavior change follows test-first red-green-refactor.

**Goal:** Make turn-recovery liveness truthful, bind replay claims to an active
session generation, and prevent renewal failures from opening a concurrent
replay window.

**Architecture:** Preserve the existing durable recovery state machine and
ordinary per-chat dispatch path. Add a separate deadman timer, thread one
generation-bound permit to the exact provider boundary, classify semantic
claim-fence loss with a typed store error, and use cooperative abort proof
before a lease can expire.

**Tech Stack:** TypeScript 5.9, Node.js 24, Vitest 4, SQLite, checked BOT ERRORS
outbox alerts.

## Constraints

- Work from pinned main `a079b5bc63168c22e9fae012f15590cdf8c04c22`.
- Group only issues #2148, #2150, and #2151 in this draft pull request.
- Do not implement cold-session spawning or shared/singleton recovery.
- Do not add a raw provider-send or direct SQL transition.
- Keep all diagnostics aggregate and content-free.
- Treat masked, partial, stale-head, or environment-invalid checks as
  inconclusive.
- Keep the issues `IN PROGRESS` until the exact draft head passes required CI.

## Task 1: Publish the reviewed contract

- [x] Add the design and this plan.
- [x] Classify both documents in `docs/publication-audit.md`.
- [x] Regenerate `docs/work-index.json` and `docs/work-index.md`.
- [x] Run publication, tally, and work-index guards.

## Task 2: Make scan health success-based

**Files:**

- Modify: `src/runtimes/agent/turn-recovery-supervisor.ts`
- Modify: `tests/runtimes/agent/turn-recovery-supervisor.test.ts`

- [x] RED: prove an enumeration exception leaves the success watermark
  unchanged and records a bounded failure reason.
- [x] RED: prove a stale-claim sweep exception cannot report a successful scan.
- [x] RED: prove a later fully successful scan advances success and clears the
  consecutive failure state.
- [x] Implement separate attempt/success timestamps and bounded failure state.
- [x] Update the pure heartbeat evaluator for never-successful, stale-success,
  and repeated-failure verdicts.
- [x] Run the focused supervisor suite.

## Task 3: Wire the independent deadman

**Files:**

- Create: `src/runtimes/agent/turn-recovery-deadman.ts`
- Create: `tests/runtimes/agent/turn-recovery-deadman.test.ts`
- Modify: `src/runtimes/agent/runtime.ts`
- Modify: `src/lib/fault-taxonomy-registry.json`
- Modify: `deploy/scripts/README-bot-errors.md`
- Modify: `deploy/scripts/tests/test_bot_errors_fault_taxonomy_registry.py`

- [x] RED: advance the real cadence past startup grace and assert one checked
  alert for a never-successful enabled supervisor.
- [x] RED: repeat unhealthy checks and assert no alert storm.
- [x] RED: record a successful scan and assert exactly one matching clear.
- [x] RED: prove disabled scope remains quiet.
- [x] Implement the timer owner with injected clock, alert, and clear ports.
- [x] Start it with enabled per-chat durability and stop it before supervisor
  teardown.
- [x] Register source owner, disposition, cadence, and semantic test.
- [x] Run deadman, registry, and runtime shutdown tests.

## Task 4: Type semantic claim-fence loss

**Files:**

- Modify: `src/core/turn-recovery-store.ts`
- Modify: `tests/core/turn-recovery-jobs.test.ts`

- [x] RED: stale token, stale epoch, expired claim, and reassigned owner throw
  the exported typed ownership-loss error from renewal.
- [x] RED: an injected database exception remains an ordinary retryable error.
- [x] Add the narrow error class without reclassifying validation or database
  availability failures.
- [x] Run the focused store suite.

## Task 5: Bind admission to one active generation

**Files:**

- Modify: `src/runtimes/agent/turn-recovery-supervisor.ts`
- Modify: `src/runtimes/agent/turn-recovery-dispatch.ts`
- Modify: `src/runtimes/agent/runtime-turn-coordinator.ts`
- Modify: `src/runtimes/agent/runtime.ts`
- Modify: `tests/runtimes/agent/turn-recovery-live-wiring.test.ts`
- Modify: `tests/runtimes/agent/turn-recovery-supervisor.test.ts`

- [x] RED: mapped inactive and non-active ownership states remain unclaimed
  with no attempt consumed.
- [x] RED: a replaced generation between admission and provider boundary
  produces no provider write.
- [x] RED: the matching active generation dispatches on the next scan.
- [x] Replace production boolean admission with an immutable dispatch permit.
- [x] Thread its validation through every wait to the exact provider callback.
- [x] Preserve optional test construction without weakening production wiring.
- [x] Run live-wiring, supervisor, runtime-coordinator, and provider-boundary
  tests.

## Task 6: Retry renewal and abort before expiry

**Files:**

- Modify: `src/runtimes/agent/turn-recovery-supervisor.ts`
- Modify: `src/runtimes/agent/turn-recovery-dispatch.ts`
- Modify: `src/runtimes/agent/runtime.ts`
- Modify: `tests/runtimes/agent/turn-recovery-supervisor.test.ts`
- Modify: `tests/runtimes/agent/turn-recovery-live-wiring.test.ts`

- [x] RED: one transient renewal exception is followed by a successful renewal
  while dispatch remains pending.
- [x] RED: confirmed ownership loss aborts the exact replay and prevents stale
  completion or requeue.
- [x] RED: repeated transient errors invoke abort before expiry, prove the
  provider generation stopped, and prevent successor overlap.
- [x] RED: abort failure increments a distinct visible counter and is never
  reported as proven safe.
- [x] Implement the cooperative abort control and one-shot renewal scheduler.
- [x] Requeue after a transient fail-closed abort only through the original
  still-valid fence.
- [x] Run supervisor, live-wiring, store, shutdown, and exactly-once suites.

## Task 7: Review blast radius and regressions

- [x] Search all supervisor constructors, dispatcher call sites, health
  snapshots, alert-source registries, and session lifecycle transitions.
- [x] Compare the branch with merged PR #2123 and safe replay PR #2071.
- [x] Confirm #2169 and #2170 behavior is unchanged.
- [x] Run duplication, architecture fitness, and public-surface scans.
- [x] Obtain an independent implementation review and verify every accepted
  finding against source and tests.

## Task 8: Verify and publish the draft

- [ ] Run formatting, lint, typecheck, focused tests, full test suite, build,
  publication guards, and repository push gate under Node.js 24.
- [ ] Inspect the complete diff for identifiers, paths, credentials, content,
  and attribution prohibited on public surfaces.
- [ ] Commit with public-safe authorship and push through the SSH remote.
- [ ] Open one grouped draft pull request referencing #2148, #2150, and #2151
  without closing them.
- [ ] Add a draft reference and reproducible verification summary to every
  issue, confirming whether GitHub created an automatic backlink.
- [ ] Read the draft's exact head SHA and wait for all required checks on that
  exact head.
- [ ] After exact-head CI is green, replace `IN PROGRESS` with `PATCH READY`
  and add one exact-head verification receipt to every issue.
