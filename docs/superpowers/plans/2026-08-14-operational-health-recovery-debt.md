# Operational Health and Recovery Debt Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Separate current operational readiness from retained recovery debt while preserving fail-closed blockers and compensating every status consumer.

**Architecture:** Agent and durability producers emit explicit blocking and retained gauges. Core health normalizes those gauges plus continuity and delivery evidence into one additive `recovery_debt` contract while deriving status only from operational blockers. Fleet, alerting, console, release gates, and documentation consume the split explicitly so debt stays visible without becoming an outage.

**Tech Stack:** TypeScript, SQLite/better-sqlite3, Vitest, React, Python unittest/pytest-compatible scripts, Bash deployment templates, JSON fault taxonomy.

**Execution status:** Tasks 1-8 are implemented through two independent-review remediation passes.
Final exact-head verification, PR publication, and controlled live rollout remain.

## Global Constraints

- Keep `healthy | degraded | unhealthy`; do not add a fourth status enum.
- Preserve existing public counters and continuity compatibility fields.
- New health fields are additive, aggregate-only, bounded, and authenticated-only.
- Missing, malformed, conflicting, or unreadable blocking evidence fails closed.
- Never replay, delete, close, or rewrite durable history to make health green.
- Corroborated selected `maybe_sent` rows remain unchanged and unclaimable.
- A debt-only state must not invoke restart, heal, provider fallback, or general health paging.
- Use pinned Node `24.15.0` through repository scripts or its exact binary.
- Use test-first changes and commit each independently reviewable deliverable.
- Record each classification experiment in `/private/tmp/whatsoup-health-debt-experiments-20260814.md` with baseline, variant, result, and keep/discard verdict.

---

## File Map

- Create `src/runtimes/agent/runtime-recovery-health.ts`: pure runtime blocker/debt classifier.
- Modify `src/runtimes/agent/runtime-turn-supervisor.ts`: delegate the legacy degraded predicate to the pure classifier or remove it after callers migrate.
- Modify `src/runtimes/agent/runtime.ts`: publish blocking/retained gauges and derive runtime status from the classifier.
- Create `tests/runtimes/agent/runtime-recovery-health.test.ts`: table-driven classification contract.
- Modify `tests/runtimes/agent/runtime-turn-recovery-health.test.ts`: real AgentRuntime disposition tests.
- Modify `src/core/durability.ts`: corroboration-aware delivery-health aggregates.
- Modify `src/core/turn-recovery-store.ts`: make claimability/counts use the same corroboration predicate.
- Modify `tests/core/durability-recovery.test.ts`, `tests/core/turn-recovery-jobs.test.ts`, and `tests/core/durability-recovery-evidence.test.ts`: store and supervisor proof.
- Create `src/core/recovery-debt.ts`: normalized top-level schema, parser helpers, ordering, and contradiction validation.
- Create `tests/core/recovery-debt.test.ts`: pure aggregate contract.
- Modify `src/core/health.ts`: compute status and debt from one sampled evidence set and repair the degraded-silence latch.
- Modify `tests/core/health.test.ts` and `tests/core/health-silence-proof-2280.test.ts`: HTTP and same-process recovery behavior.
- Modify `src/lib/fault-taxonomy-registry.json`, `src/lib/fault-classifier.ts`, `tests/core/failure-taxonomy-cross-contract.test.ts`, and deploy registry tests: signal/source ownership.
- Modify `deploy/bot-errors-runtime-manifest.json` only through the repository's manifest update workflow if its guard requires a checksum/file entry change.
- Modify `src/fleet/health-poller.ts`: normalize debt, own its independent alert lifecycle, and keep status online for debt-only health.
- Modify `tests/fleet/health-poller.test.ts` and `tests/fleet/health-poller-branches.test.ts`: online/debt alert/clear behavior.
- Modify `src/fleet/routes/lines.ts`, `src/fleet/routes/feed.ts`, and their tests: project a stable summary and emit distinct debt history events.
- Modify `console/src/types.ts`, `console/src/lib/compute-kpis.ts`, `console/src/components/fleet/FleetKpis.tsx`, `console/src/pages/LineDetail.tsx`, `console/src/pages/Operator.tsx`, and console tests: separate operational and debt UI.
- Modify `deploy/scripts/lib/classify_health.py`, `scripts/validate-startup-notification-release.ts`, deployment/watchdog tests, and BOT ERRORS tests: explicitly accept healthy nonblocking debt and reject contradictions.
- Modify `docs/public-surface.md`, `docs/runbook.md`, `docs/configuration.md`, and `docs/durability.md`: published contract and operations.
- Update `docs/publication-audit.md` through `npm run guard:publication:write` for any new internal artifact.

### Task 1: Establish the measurable classification baseline

**Files:**
- Create: `/private/tmp/whatsoup-health-debt-experiments-20260814.md`
- Create: `src/runtimes/agent/runtime-recovery-health.ts`
- Test: `tests/runtimes/agent/runtime-recovery-health.test.ts`

**Interfaces:**
- Consumes: `RuntimeTurnSupervisorHealth`, `TurnRecoveryHealthDetails`, and completed-delivery admission health.
- Produces:

```ts
export interface RuntimeRecoveryHealthInput {
  finalization: RuntimeTurnSupervisorHealth;
  recovery: TurnRecoveryHealthDetails;
  completedDeliveryIdentity: {
    unresolvedCount: number;
    nextAction: 'fresh_inbound' | 'operator' | null;
  };
}

export interface RuntimeRecoveryHealthClassification {
  blocking: boolean;
  blockingReasons: readonly string[];
  retainedReasons: readonly string[];
  blockingOutstanding: number;
  retainedTerminal: number;
  corroboratedRetained: number;
  completedDeliveryIdentityBlocking: number;
  completedDeliveryIdentityRetained: number;
}

export function classifyRuntimeRecoveryHealth(
  input: RuntimeRecoveryHealthInput,
): RuntimeRecoveryHealthClassification;
```

- [x] **Step 1: Write the table-driven failing test**

Use one fixture per design row and assert both `blocking` and ordered reasons:

```ts
it.each([
  ['none', input(), false, [], []],
  ['retained finalization', input({ retainedRetries: 1 }), true, ['turn_finalization_active'], []],
  ['pending recovery', input({ pending: 1, outstanding: 1 }), true, ['turn_recovery_actionable'], []],
  ['blocked unsafe', input({ blockedUnsafe: 1 }), false, [], ['turn_recovery_terminal']],
  ['exhausted', input({ exhausted: 1 }), false, [], ['turn_recovery_terminal']],
  ['operator catchup', input({ openRecoveries: 1 }), false, [], ['historical_turn_catchup']],
  ['corrupt link', input({ corruptLinks: 1 }), true, ['turn_recovery_integrity'], []],
  ['echo conflict', input({ echoConflicts: 1 }), true, ['turn_recovery_integrity'], []],
  ['fresh inbound identity', input({}, { unresolvedCount: 3, nextAction: 'fresh_inbound' }), false, [], ['completed_delivery_identity_fresh_inbound']],
  ['operator identity', input({}, { unresolvedCount: 2, nextAction: 'operator' }), false, [], ['completed_delivery_identity_operator']],
])('%s', (_label, value, blocking, blockingReasons, retainedReasons) => {
  expect(classifyRuntimeRecoveryHealth(value)).toMatchObject({
    blocking,
    blockingReasons,
    retainedReasons,
  });
});
```

- [x] **Step 2: Run the new test against baseline behavior**

Run:

```bash
npm test -- tests/runtimes/agent/runtime-recovery-health.test.ts --pool=forks --fileParallelism=false --retry=0
```

Expected: FAIL because the module does not exist. Record the baseline as `0/10 contract rows executable` in the experiment log.

- [x] **Step 3: Implement the pure classifier**

Use explicit predicates; never infer severity from arbitrary positive numbers:

```ts
const blockingReasons = orderedUnique([
  finalization.retainedRetries > 0 || finalization.degradedScopes > 0
    ? 'turn_finalization_active'
    : null,
  recovery.turnRecoveryPending > 0
    || recovery.turnRecoveryLiveClaimed > 0
    || recovery.turnRecoveryExpiredClaimed > 0
    ? 'turn_recovery_actionable'
    : null,
  recovery.turnRecoveryCorruptLinks > 0
    || recovery.turnRecoveryOrphanTransfers > 0
    || recovery.turnRecoveryEchoConflicts > 0
    ? 'turn_recovery_integrity'
    : null,
]);
```

Classify `blockedUnsafe`, `exhausted`, `openRecoveries`, corroborated retained,
and recognized identity admission actions as retained. Treat an unknown action
with unresolved rows as blocking.

- [x] **Step 4: Re-run and measure the contract**

Expected: PASS with `10/10` rows. Record `baseline=0/10`, `variant=10/10`, `verdict=keep`.

- [x] **Step 5: Commit the classifier**

```bash
git add src/runtimes/agent/runtime-recovery-health.ts tests/runtimes/agent/runtime-recovery-health.test.ts
git commit -m "refactor(health): classify blocking and retained recovery"
```

### Task 2: Make durability and recovery supervision corroboration-aware

**Files:**
- Modify: `src/core/durability.ts`
- Modify: `src/core/turn-recovery-store.ts`
- Test: `tests/core/durability-recovery.test.ts`
- Test: `tests/core/turn-recovery-jobs.test.ts`
- Test: `tests/core/durability-recovery-evidence.test.ts`

**Interfaces:**
- Consumes: append-only `turn_delivery_corroboration` joined through `turn_terminal_records.delivery_op_id`.
- Produces additions to durability health:

```ts
interface DeliveryAmbiguityHealth {
  readable: boolean;
  uncorroboratedAmbiguous: number;
  corroboratedRetained: number;
  oldestUncorroboratedAt: string | null;
}
```

- Produces additions to `TurnRecoveryHealthDetails`:

```ts
turnRecoveryBlockingOutstanding: number;
turnRecoveryRetainedTerminal: number;
turnRecoveryCorroboratedRetained: number;
```

- [x] **Step 1: Write failing store tests with real rows**

Create two otherwise identical stale `maybe_sent` fixtures. Add valid
`same_source_later_echoed_op` corroboration to one. Assert:

```ts
expect(engine.getHealthStats().deliveryAmbiguity).toEqual({
  readable: true,
  uncorroboratedAmbiguous: 1,
  corroboratedRetained: 1,
  oldestUncorroboratedAt: expect.any(String),
});
```

Create a pending recovery job bound to the corroborated selected operation and
assert it is absent from due/claimable enumeration, counted as
`turnRecoveryCorroboratedRetained=1`, and remains unchanged in SQLite.

- [x] **Step 2: Run focused tests to verify the semantic failures**

```bash
npm test -- tests/core/durability-recovery.test.ts tests/core/turn-recovery-jobs.test.ts tests/core/durability-recovery-evidence.test.ts --pool=forks --fileParallelism=false --retry=0
```

Expected: FAIL on missing aggregate fields and the still-claimable corroborated job. Record the failing assertion count.

- [x] **Step 3: Add one shared SQL predicate**

Use the existing proof relationship:

```sql
NOT EXISTS (
  SELECT 1
  FROM turn_terminal_records AS terminal
  JOIN turn_delivery_corroboration AS corroboration
    ON corroboration.terminal_record_id = terminal.id
  WHERE terminal.delivery_op_id = outbound.id
)
```

Apply the positive and negative forms consistently to ambiguity aggregates,
recovery due enumeration, and supervisor counts. Do not update the selected
operation or job row.

- [x] **Step 4: Re-run and compare**

Expected: all focused tests PASS; direct SQL assertions prove the selected op,
terminal, job state, and corroboration record are byte-for-byte unchanged.
Record `verdict=keep` only if both behavior and immutability pass.

- [x] **Step 5: Inspect the query plan**

Run `EXPLAIN QUERY PLAN` for the new aggregate and due-job query against the
test schema. Expected: indexed primary/foreign-key lookups and no unbounded
content scan beyond the bounded status cohort. If not, add only the minimal
migration/index justified by the plan output and extend migration tests.

- [x] **Step 6: Commit**

```bash
git add src/core/durability.ts src/core/*turn-recovery* tests/core/durability-recovery.test.ts tests/core/turn-recovery-jobs.test.ts tests/core/durability-recovery-evidence.test.ts
git commit -m "fix(durability): recognize corroborated retained delivery debt"
```

### Task 3: Wire runtime status to blocking evidence

**Files:**
- Modify: `src/runtimes/agent/runtime.ts`
- Modify: `src/runtimes/agent/runtime-turn-supervisor.ts`
- Modify: `src/runtimes/agent/turn-recovery-dispatch.ts`
- Test: `tests/runtimes/agent/runtime-turn-recovery-health.test.ts`
- Test: `tests/runtimes/agent/health-snapshot.test.ts`

**Interfaces:**
- Consumes: `classifyRuntimeRecoveryHealth` and new recovery counters.
- Produces: existing runtime fields plus the five explicit blocking/retained gauges from Task 1.

- [x] **Step 1: Change existing expectations to the approved matrix**

Add or update tests so blocked-unsafe, exhausted, open catch-up, and
fresh-inbound admission rows remain healthy; pending/claimed, finalization,
corrupt-link, echo-conflict, and unknown identity-action rows remain degraded.

Assert retained reasons stay in `details.recoveryDebtReasons`, not
`details.degradedReasons`.

- [x] **Step 2: Run tests and preserve the RED evidence**

```bash
npm test -- tests/runtimes/agent/runtime-turn-recovery-health.test.ts tests/runtimes/agent/health-snapshot.test.ts --pool=forks --fileParallelism=false --retry=0
```

Expected: the historical-debt cases fail because current runtime status is degraded.

- [x] **Step 3: Replace the broad predicate at the call site**

```ts
const recoveryClassification = classifyRuntimeRecoveryHealth({
  finalization: finalizationHealth,
  recovery: recoveryHealth,
  completedDeliveryIdentity: completedDeliveryIdentityAdmissions,
});

if (recoveryClassification.blocking) {
  degradedReasons.push(...recoveryClassification.blockingReasons);
}
```

Publish ordered retained reasons and explicit gauges in both per-chat and
single-session health branches. Keep non-recovery degradation unchanged.

- [x] **Step 4: Re-run tests**

Expected: PASS. Record classification-row accuracy before/after and keep only
if all blocker cases remain degraded and all retained-only cases recover.

- [x] **Step 5: Commit**

```bash
git add src/runtimes/agent/runtime.ts src/runtimes/agent/runtime-turn-supervisor.ts src/runtimes/agent/turn-recovery-dispatch.ts tests/runtimes/agent/runtime-turn-recovery-health.test.ts tests/runtimes/agent/health-snapshot.test.ts
git commit -m "fix(agent): derive runtime health from active recovery blockers"
```

### Task 4: Normalize top-level recovery debt and repair the health latch

**Files:**
- Create: `src/core/recovery-debt.ts`
- Create: `tests/core/recovery-debt.test.ts`
- Modify: `src/core/health.ts`
- Modify: `tests/core/health.test.ts`
- Modify: `tests/core/health-silence-proof-2280.test.ts`

**Interfaces:**
- Produces:

```ts
export type RecoveryDebtAttention = 'none' | 'routine' | 'urgent';
export interface RecoveryDebtSnapshot {
  open: boolean;
  service_blocking: boolean;
  attention: RecoveryDebtAttention;
  reason: 'continuity_gap_open' | 'continuity_gap_unreadable' | null;
  reasons: readonly string[];
  continuity: ContinuityGapHealth;
  turn_recovery: { readable: boolean; blocking_outstanding: number; retained_terminal: number; open_catchups: number; corroborated_retained: number };
  completed_delivery_identity: { readable: boolean; blocking: number; retained: number; next_action: 'fresh_inbound' | 'operator' | null };
  delivery: { readable: boolean; blocking_ambiguous: number; uncorroborated_ambiguous: number; corroborated_retained: number; oldest_uncorroborated_at: string | null };
}
```

- Produces `evaluateRecoveryProof(...)` that distinguishes `clear`, `retain`, and `degrade`.

- [x] **Step 1: Write pure aggregate and contradiction tests**

Cover no debt, retained only, blocking only, mixed, unreadable, unknown reason,
negative/noninteger count, `service_blocking=false` with a blocker, and stable
reason ordering. Malformed inputs must produce a blocking unreadable result.

- [x] **Step 2: Write the same-process latch regression**

Exercise one server instance through:

```text
degraded(active blocker) -> healthy(retained debt only) -> healthy(no debt)
```

Assert the second and third samples are healthy after complete readable proof.
Add a separate sequence where one required probe is unreadable and assert
`degradation_silence_unproven` remains.

- [x] **Step 3: Run RED tests**

```bash
npm test -- tests/core/recovery-debt.test.ts tests/core/health.test.ts tests/core/health-silence-proof-2280.test.ts --pool=forks --fileParallelism=false --retry=0
```

Expected: missing module/fields and latch recovery failure.

- [x] **Step 4: Implement one normalized snapshot per request**

Build `recoveryDebt` after the once-sampled runtime and durability evidence.
Use `recoveryDebt.service_blocking` as the only debt contribution to
`statusReasons`. Keep the existing singular `reason` for continuity
compatibility and add ordered `reasons`.

- [x] **Step 5: Implement explicit latch clearing**

Replace unconditional set-only behavior with:

```ts
const proof = evaluateRecoveryProof(currentEvidence);
if (statusReasons.length > 0) recentlyDegraded.add(instanceName);
else if (proof === 'clear') recentlyDegraded.delete(instanceName);
else if (recentlyDegraded.has(instanceName)) statusReasons.push('degradation_silence_unproven');
```

The proof must include connected transport, current model evidence, sampled
runtime, schema/pending-poll readability, and readable nonblocking debt.

- [x] **Step 6: Re-run and measure**

Expected: all focused tests PASS and the same-process recovery sequence changes
from `0/1 recovered` to `1/1 recovered` without weakening unreadable behavior.

- [x] **Step 7: Commit**

```bash
git add src/core/recovery-debt.ts src/core/health.ts tests/core/recovery-debt.test.ts tests/core/health.test.ts tests/core/health-silence-proof-2280.test.ts
git commit -m "fix(health): separate operational status from recovery debt"
```

### Task 5: Add fleet debt observation without outage classification

**Files:**
- Modify: `src/lib/fault-taxonomy-registry.json`
- Modify: `src/lib/fault-classifier.ts`
- Modify: `src/fleet/health-poller.ts`
- Modify: `tests/core/failure-taxonomy-cross-contract.test.ts`
- Modify: `tests/fleet/health-poller.test.ts`
- Modify: `tests/fleet/health-poller-branches.test.ts`
- Modify: `deploy/scripts/tests/test_bot_errors_fault_taxonomy_registry.py`

**Interfaces:**
- Adds alert source `recovery_debt_attention`.
- Adds to `InstanceStatus`:

```ts
recoveryDebt: {
  open: boolean;
  serviceBlocking: boolean;
  attention: 'none' | 'routine' | 'urgent';
  reasons: string[];
  gaugeTotal: number;
} | null;
```

- [x] **Step 1: Write poller lifecycle tests**

Assert a connected `status=healthy`, `recovery_debt.open=true`,
`service_blocking=false` response is `online`, does not emit
`health_body_degraded`, emits one checked `recovery_debt_attention`, dedupes on
identical samples, updates only on a reason/count bucket change, and clears on
a fresh readable `open=false` sample.

Assert malformed debt becomes degraded and cannot clear either alert.

- [x] **Step 2: Run RED tests**

Expected: healthy debt is online but no debt summary/alert exists; malformed
debt currently slips through as online.

- [x] **Step 3: Add a strict debt parser and lifecycle owner**

Parse only bounded arrays, enums, nonnegative safe integers, and timestamps.
Evidence contains reason codes and aggregate buckets only. Reuse poll cadence
and checked alert/clear functions. Do not call heal or status-change listeners
for debt-only changes.

- [x] **Step 4: Register source and signal dispositions**

Add `recovery_debt_attention` with disposition
`non_paging_operator_recovery_debt` and owner `src/fleet/health-poller.ts`.
Register blocking gauges as `positive_is_risk` and retained gauges as
`diagnostic_only`. Update the deployed registry manifest through its canonical
guard workflow.

- [x] **Step 5: Re-run TypeScript and Python contract tests**

```bash
npm test -- tests/core/failure-taxonomy-cross-contract.test.ts tests/fleet/health-poller.test.ts tests/fleet/health-poller-branches.test.ts --pool=forks --fileParallelism=false --retry=0
python3 -m unittest deploy.scripts.tests.test_bot_errors_fault_taxonomy_registry
```

Expected: PASS. Record alert counts for identical debt samples before/after;
keep only if exactly one open and one clear are emitted.

- [x] **Step 6: Commit**

```bash
git add src/lib/fault-taxonomy-registry.json src/lib/fault-classifier.ts src/fleet/health-poller.ts tests/core/failure-taxonomy-cross-contract.test.ts tests/fleet/health-poller.test.ts tests/fleet/health-poller-branches.test.ts deploy/scripts/tests/test_bot_errors_fault_taxonomy_registry.py deploy/bot-errors-runtime-manifest.json
git commit -m "feat(fleet): observe recovery debt independently of health status"
```

### Task 6: Compensate API, feed, and console consumers

**Files:**
- Modify: `src/fleet/routes/lines.ts`
- Modify: `src/fleet/routes/feed.ts`
- Modify: `tests/fleet/routes/lines.test.ts`
- Modify: `tests/fleet/routes/feed.test.ts`
- Modify: `console/src/types.ts`
- Modify: `console/src/lib/compute-kpis.ts`
- Modify: `console/src/components/fleet/FleetKpis.tsx`
- Modify: `console/src/pages/LineDetail.tsx`
- Modify: `console/src/pages/Operator.tsx`
- Test: `tests/console/compute-kpis.test.ts`
- Test: `tests/console/operator-page.test.tsx`
- Create: `tests/console/line-detail-recovery-debt.test.tsx`

**Interfaces:**
- Lines API keeps raw `health` and adds `recoveryDebt` from poller normalization.
- `computeKpis` adds `recoveryDebtLines: number` without changing `needAttention`.
- Feed adds `detail.type='recovery_debt'` with `state='opened'|'changed'|'cleared'`.

- [x] **Step 1: Write failing API and KPI tests**

For an online line with nonblocking debt, assert:

```ts
expect(kpis).toMatchObject({ needAttention: 0, recoveryDebtLines: 1 });
```

Assert the lines API contains the normalized summary, line detail renders a
separate “Recovery debt” section, and no `degradation_causes` warning chip is
shown solely for retained debt.

- [x] **Step 2: Write feed transition tests**

Assert debt open/change/clear emits independently from operational status and
that an online transition plus retained debt is represented as operational
recovery followed by debt context, not as degraded health.

- [x] **Step 3: Run RED tests**

```bash
npm test -- tests/fleet/routes/lines.test.ts tests/fleet/routes/feed.test.ts tests/console/compute-kpis.test.ts tests/console/operator-page.test.tsx --pool=forks --fileParallelism=false --retry=0
```

Expected: missing summary/KPI/feed/UI assertions fail.

- [x] **Step 4: Implement additive projections and UI**

Keep `needAttention` status-derived. Add debt count to fleet metadata and show
“all services healthy · N with recovery debt” rather than “N unhealthy”. On
line detail, render operational causes only when status is not online and debt
reasons under their own labelled details element.

- [x] **Step 5: Re-run tests and console build**

```bash
npm test -- tests/fleet/routes/lines.test.ts tests/fleet/routes/feed.test.ts tests/console/compute-kpis.test.ts tests/console/operator-page.test.tsx --pool=forks --fileParallelism=false --retry=0
npm --prefix console run typecheck
npm --prefix console run build
```

Expected: PASS. Compare KPI vectors before/after; `needAttention` must stay zero
for debt-only and one for operational degradation.

- [x] **Step 6: Commit**

```bash
git add src/fleet/routes/lines.ts src/fleet/routes/feed.ts tests/fleet/routes/lines.test.ts tests/fleet/routes/feed.test.ts console/src/types.ts console/src/lib/compute-kpis.ts console/src/components/fleet/FleetKpis.tsx console/src/pages/LineDetail.tsx console/src/pages/Operator.tsx tests/console
git commit -m "feat(console): distinguish service health from recovery debt"
```

### Task 7: Verify release, heal, watchdog, and BOT ERRORS behavior

**Files:**
- Modify: `deploy/scripts/lib/classify_health.py`
- Modify: `scripts/validate-startup-notification-release.ts`
- Test: `deploy/scripts/tests/test_classify_health.py`
- Test: `tests/scripts/startup-notification-release-validator.test.ts`
- Test: `tests/scripts/bot-errors-heartbeat-watchdog.test.ts`
- Test: `tests/scripts/bot-errors-health-check.test.ts`
- Test: `deploy/scripts/tests/test_watchdog_restart_policy.py`

**Interfaces:**
- `status=healthy` plus readable `service_blocking=false` remains accepted.
- `status=healthy` plus `service_blocking=true`, malformed debt, or unreadable blocking evidence is rejected as contradictory.

- [x] **Step 1: Add consumer matrix fixtures**

Each consumer receives four bodies: healthy/no debt, healthy/retained debt,
degraded/blocking debt, and contradictory healthy/blocking debt. Assert release
and heal acceptance only for the first two, no watchdog restart for the first
two, and no general degraded alert for retained debt.

- [x] **Step 2: Run RED tests**

Expected: retained debt is already accepted where status alone is used;
contradictory debt is not yet rejected. Record this partial baseline rather
than calling it green.

- [x] **Step 3: Add shared validation semantics at each language boundary**

Python and TypeScript consumers validate the three debt fields they require:
`open`, `service_blocking`, and `attention`. They do not reimplement producer
category arithmetic. A missing debt object remains compatible; a present
malformed or contradictory object fails closed.

- [x] **Step 4: Re-run all consumer fixtures**

Run the focused Vitest suites plus the exact Python unittest modules found in
Step 1. Expected: all four-body matrices pass for every consumer.

- [x] **Step 5: Commit**

```bash
git add deploy/scripts/lib/classify_health.py scripts/validate-startup-notification-release.ts deploy/scripts/tests tests/scripts
git commit -m "fix(ops): validate health and recovery debt consistently"
```

### Task 8: Update contracts and operator documentation

**Files:**
- Modify: `docs/public-surface.md`
- Modify: `docs/runbook.md`
- Modify: `docs/configuration.md`
- Modify: `docs/durability.md`
- Modify: `docs/publication-audit.md`

**Interfaces:**
- Documents the exact JSON fields, classification table, alert ownership, and rollback.

- [x] **Step 1: Update public surface and durability contracts**

Replace claims that all open recovery/catch-up debt degrades health. Document
the additive object, compatibility `reason`, ordered `reasons`, blocking
invariants, corroboration immutability, and authenticated-only exposure.

- [x] **Step 2: Update runbook and configuration**

Document how to distinguish outage from debt, inspect aggregate categories,
respond to routine versus urgent debt, interpret the dedicated fleet alert,
and prove a latch clear. Add any new environment variable only if Task 5
demonstrates the existing cadence/dedupe is insufficient.

- [x] **Step 3: Regenerate publication classification and run doc gates**

```bash
npm run guard:publication:write
npm run guard:publication:all
npm run guard:public-surface-drift
npm run guard:doc-drift
```

Expected: PASS with no unclassified files or stale public-surface claims.

- [x] **Step 4: Commit**

```bash
git add docs/public-surface.md docs/runbook.md docs/configuration.md docs/durability.md docs/publication-audit.md
git commit -m "docs(health): document operational status and recovery debt"
```

### Task 9: Cross-contract verification and exact-head comparison

**Files:**
- Modify only tests or implementation needed to correct verified cross-contract failures.
- Update: `/private/tmp/whatsoup-health-debt-experiments-20260814.md`

**Interfaces:**
- Consumes all prior task outputs.
- Produces exact-head verification evidence for review and PR publication.

- [ ] **Step 1: Run focused aggregate suites**

```bash
npm test -- tests/runtimes/agent/runtime-recovery-health.test.ts tests/runtimes/agent/runtime-turn-recovery-health.test.ts tests/runtimes/agent/health-snapshot.test.ts tests/core/durability-recovery.test.ts tests/core/turn-recovery-jobs.test.ts tests/core/durability-recovery-evidence.test.ts tests/core/recovery-debt.test.ts tests/core/health.test.ts tests/core/health-silence-proof-2280.test.ts tests/core/failure-taxonomy-cross-contract.test.ts tests/fleet/health-poller.test.ts tests/fleet/health-poller-branches.test.ts tests/fleet/routes/lines.test.ts tests/fleet/routes/feed.test.ts tests/console/compute-kpis.test.ts tests/console/operator-page.test.tsx tests/scripts/bot-errors-heartbeat-watchdog.test.ts tests/scripts/bot-errors-health-check.test.ts --pool=forks --fileParallelism=false --retry=0
```

Expected: PASS with no retries, skips, or masked failures.

- [ ] **Step 2: Run static and deployment gates**

```bash
npm run typecheck
npm run typecheck:all
npm run typecheck:scripts
npm --prefix console run typecheck
npm --prefix console run build
npm run guard:lint:src
npm run guard:fault-taxonomy-coverage
npm run guard:bot-errors-runtime-manifest
npm run guard:deployer-static
npm run guard:repo:branch-diff
npm run guard:publication:all
npm run guard:public-surface-drift
```

Expected: PASS. Any timeout, unavailable dependency, warning that bypasses an
assertion, or skipped required suite is inconclusive and must be recorded.

- [ ] **Step 3: Run the full suite under the supported runtime**

```bash
loadgate --label health-debt-full-suite --max-wait 300 -- bash scripts/run-with-pinned-node.sh node_modules/vitest/vitest.mjs run --pool=forks --fileParallelism=false --retry=0
```

Expected: process exits 0. A non-exiting worker is not a pass; capture its PID,
test file, and last output, terminate only the owned test process, and report
the full-suite gate as inconclusive.

- [ ] **Step 4: Fetch and compare with current main**

```bash
git fetch origin main
git log --oneline --left-right --cherry-pick origin/main...HEAD
git diff --check origin/main...HEAD
git range-diff f38d5b83dec2f32b85bde7fa0200b55754b89054...origin/main f38d5b83dec2f32b85bde7fa0200b55754b89054...HEAD
```

Expected: no unintended overlap or dropped change. Rebase only if needed, then
repeat all decisive gates on the new exact head.

- [ ] **Step 5: Review the experiment ledger**

Every experiment must contain one metric, baseline, variant, result, and
keep/discard decision. Confirm the final classification matrix has 100% exact
matches and that no retained-only case increments operational outage metrics.

- [ ] **Step 6: Commit any verification-only corrections**

```bash
git status --short
git diff --check
```

If fixes were required, commit them by subsystem. If none were required, do
not create an empty verification commit.

### Task 10: Review, PR, and controlled live validation

**Files:**
- No source changes unless review finds a verified defect.

**Interfaces:**
- Produces a reviewed PR and, only after merge/deployment authorization, live validation evidence.

- [ ] **Step 1: Run the requesting-code-review workflow**

Review the exact `origin/main...HEAD` diff for spec coverage, status/debt
contradictions, privacy, alert duplication, stale-snapshot behavior, and
consumer compensation. Resolve verified findings and repeat affected gates.

- [ ] **Step 2: Run verification-before-completion**

Capture exact commit, working-tree status, decisive command outputs, skipped or
inconclusive checks, and rollback path. Do not claim success from earlier-head
results.

- [ ] **Step 3: Push the SSH-backed branch and create a documented draft PR**

```bash
git remote get-url origin
git push -u origin fix/operational-health-recovery-debt-20260814
gh pr create --draft --base main --head fix/operational-health-recovery-debt-20260814 --title "fix: separate operational health from recovery debt" --body-file /private/tmp/whatsoup-health-debt-pr-body.md
```

The PR body includes incident-safe motivation, design link, impact matrix,
behavior comparison, exact tests, full-suite status, rollback, and remaining
live-deployment gate. It contains no private host/chat labels, model names,
attribution trailers, or personal email.

- [ ] **Step 4: Validate PR checks and current-main relationship**

Wait for required checks, inspect failures from primary evidence, and update
only for verified defects. Repeat `git fetch`, `git range-diff`, and exact-head
local gates after any update.

- [ ] **Step 5: Prepare controlled deployment validation**

Do not merge or deploy merely because the PR is green. Before a live change,
confirm the explicit authorization, database backup/integrity, exact deploy
commit, service rollback target, and persistent monitor ownership.

- [ ] **Step 6: Compare live behavior after authorized deployment**

Measure the same synchronized fields as baseline. The required effect is:

```text
transport connected=true
model usable and fresh=true
operational blockers=0
status=healthy
recovery_debt.open=true
recovery_debt.service_blocking=false
```

Run exact-response direct and selected-group canaries and observe for reasoning
leaks, message deletion attempts, scheduled narration, duplicate output,
crashes, lag, and alert misclassification. Keep the deployment only if all
effects match; otherwise execute the documented rollback and preserve evidence.
