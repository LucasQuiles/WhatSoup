# Operational Health and Recovery Debt Design

**Status:** draft for owner review

**Date:** 2026-08-14

**Baseline:** `f38d5b83dec2f32b85bde7fa0200b55754b89054` (`origin/main`)

**Incident:** affected per-chat agent fleet instance

## Problem

The affected agent is currently connected, model-usable, responsive to direct and group canaries,
and free of current event-loop starvation or recent crashes. Its authenticated
`GET /health` response nevertheless remains `degraded` because the response
combines two different questions:

1. can the instance safely accept and complete work now; and
2. does durable state retain historical recovery or audit obligations.

The retained obligations are real and must remain visible. They are not all
evidence of current service impairment. Mixing them into one status causes the
fleet UI, health-body alerting, release gates, and operators to describe a
responsive instance as operationally degraded. It also makes recovery appear
stale: the health response is freshly recomputed from SQLite, but the state it
projects includes old retained debt and an in-process degradation latch with no
implemented clear path.

The incident exposed four concrete classification defects:

- fresh-inbound-owned completed-delivery identity quarantines degrade the whole
  runtime even though a new inbound safely replaces each quarantined checkpoint;
- open historical catch-up records and terminal exhausted/blocked recovery
  records are treated like active recovery work;
- `maybe_sent` deliveries remain ambiguous in health even when append-only
  corroboration proves a later echoed outbound for the same source turn; and
- `recentlyDegraded` can add `degradation_silence_unproven` forever because no
  success path removes an instance from that set.

## Goals

1. Make top-level `status` mean current operational safety and readiness.
2. Preserve historical, retained, and operator-owned obligations in an
   additive, content-free `recovery_debt` projection.
3. Keep active safety blockers fail-closed and degraded.
4. Compensate every known downstream consumer so debt remains observable
   without being counted as a service outage.
5. Reconcile corroborated delivery evidence across durability health and the
   recovery supervisor without replaying, deleting, or rewriting historical
   delivery evidence.
6. Give the degradation-silence latch an explicit, testable recovery proof.
7. Preserve the existing health status enum and HTTP contract.

## Non-goals

- Automatically replaying any inbound or outbound operation.
- Automatically closing operator catch-up records whose semantic answer has
  not been reviewed.
- Deleting or rewriting selected `maybe_sent` operations, terminal records,
  admission quarantines, messages, or corroboration evidence.
- Treating a successful HTTP response alone as proof of model or transport
  readiness.
- Exposing chat identifiers, message content, prompts, provider output, paths,
  or per-conversation keys in health or fleet telemetry.
- Folding the six incident-specific deployment commits into this
  change. They require their own integration history and verification.

## Selected Model

Keep the existing status enum:

```text
healthy | degraded | unhealthy
```

`status` answers whether the instance is currently safe and capable of serving
admitted work. `recovery_debt` independently answers whether retained durable
work, historical uncertainty, or operator review remains open.

This extends the precedent already shipped for continuity gaps: a line may be
`healthy` while `recovery_debt.open` is true. It does not add a fourth
`healthy_with_debt` status that older clients would reject or misclassify.

## Classification Contract

| Signal | Operational status | Recovery debt | Reason |
|---|---|---|---|
| Connected transport, usable fresh model, no current blocker | healthy | none or retained | Current work is safe. |
| Retained finalization retry or degraded finalization scope | degraded | blocking | A current turn cannot yet prove finalization. |
| Pending or live/expired-claim recovery job eligible for action | degraded | blocking | Recovery owns unfinished active work. |
| Uncorroborated stale `maybe_sent` delivery | degraded | blocking | A new send could duplicate an unproven delivery. |
| Unreadable recovery, durability, or identity evidence | degraded | blocking/unknown | Absence of readable proof is not recovery proof. |
| Corrupt recovery link, orphan transfer, or unresolved echo conflict | degraded | blocking | The safety relationship itself is inconsistent. |
| Historical operator catch-up with no active recovery owner | healthy | retained | It requires review but does not block unrelated current work. |
| Terminal exhausted or blocked-unsafe recovery record | healthy | retained | Automatic work has stopped safely; operator debt remains. |
| Completed-delivery identity quarantine owned by `fresh_inbound` | healthy | retained | Fresh inbound replaces the unprovable checkpoint safely. |
| Completed-delivery identity quarantine owned by `operator` | healthy | attention | Operator action is required, but unrelated work remains serviceable. |
| Selected `maybe_sent` operation with valid later-echo corroboration | healthy | retained/audit | The selected row stays immutable, but ambiguity is resolved for health and replay. |
| Open continuity gap | healthy | retained | Existing #2973 behavior is preserved. |
| Transport disconnected, model unusable/stale, halted shared queue, current provider pressure, or current runtime failure | degraded or unhealthy | independent | Existing operational semantics are unchanged. |

`healthy` never means “no work remains.” It means “no currently observed
condition makes new admitted work unsafe or unavailable.”

## Producer Design

### Runtime recovery classification

Replace the broad `runtimeTurnRecoveryIsDegraded` predicate with a typed
classification that returns both current blockers and retained debt. The
classification consumes the same once-per-request runtime snapshot used by
core health.

Existing public counters remain present for compatibility. Add bounded gauges
whose names encode their disposition rather than forcing consumers to infer it
from numeric type:

- `turnRecoveryBlockingOutstanding`;
- `turnRecoveryRetainedTerminal`;
- `turnRecoveryCorroboratedRetained`;
- `completedDeliveryIdentityBlocking`;
- `completedDeliveryIdentityRetained`.

The existing detailed counters remain diagnostic. Runtime `degradedReasons`
uses only current blockers. Historical counters and `fresh_inbound` admission
quarantines populate runtime debt details but no longer add a degraded reason.

### Corroborated delivery evidence

Append-only `turn_delivery_corroboration` remains the authority that a later
echoed outbound corresponds to the same source inbound, conversation, and chat.
The selected `outbound_ops.status = maybe_sent` row is not rewritten.

Durability health separates:

- stale, uncorroborated ambiguity, which remains blocking; and
- corroborated retained selections, which remain audit debt.

Recovery enumeration and supervisor counts use the same corroboration-aware
predicate. A pending job whose selected delivery is validly corroborated is not
claimable or counted as blocking outstanding work. Its retained row remains
visible through the debt projection. This prevents duplicate replay without
pretending the historical selected row was delivered directly.

The corroboration join and its uniqueness assumptions receive focused store
tests. Missing, malformed, conflicting, or unreadable corroboration fails
closed as blocking ambiguity.

### Completed-delivery identity admission

The existing health projection already declares `nextAction` as
`fresh_inbound`, `operator`, or null. Runtime status stops using
`unresolvedCount > 0` as a blanket degraded predicate.

- `fresh_inbound` rows are retained debt and do not degrade.
- `operator` rows are attention debt and do not degrade unrelated service.
- an unreadable ledger or a future action class is blocking and degrades.

No checkpoint is resumed from an unprovable identity and no quarantine is
cleared merely to make health green.

### Top-level recovery debt

Extend the existing additive top-level object without removing its continuity
fields:

```json
{
  "recovery_debt": {
    "open": true,
    "service_blocking": false,
    "attention": "routine",
    "reasons": [
      "continuity_gap_open",
      "historical_turn_catchup",
      "completed_delivery_identity_fresh_inbound",
      "corroborated_delivery_retained"
    ],
    "continuity": {
      "readable": true,
      "open": 1,
      "unresolved": 1,
      "ambiguous": 0
    },
    "turn_recovery": {
      "readable": true,
      "blocking_outstanding": 0,
      "retained_terminal": 11,
      "open_catchups": 9,
      "corroborated_retained": 11
    },
    "completed_delivery_identity": {
      "readable": true,
      "blocking": 0,
      "retained": 38,
      "next_action": "fresh_inbound"
    },
    "delivery": {
      "readable": true,
      "uncorroborated_ambiguous": 0,
      "corroborated_retained": 11,
      "oldest_uncorroborated_at": null
    }
  }
}
```

The exact implementation may add bounded counters needed to avoid lossy
aggregation, but it must preserve these invariants:

- `open` is true when any retained or blocking category is nonzero;
- `service_blocking` is true exactly when debt contributes to operational
  degradation;
- `attention` is `none`, `routine`, or `urgent` and is derived, not manually
  asserted;
- `reasons` is a stable, ordered, bounded enum array;
- every subsection has explicit readability when a storage probe can fail;
- the existing `reason` compatibility field remains until consumers migrate,
  with continuity-only behavior unchanged;
- no identifiers or content are exposed.

### Explicit recovery proof for the silence latch

The current set-only `recentlyDegraded` behavior is replaced with a small state
machine:

1. active operational reasons add the instance to the latch;
2. an otherwise-green sample clears the latch only when transport evidence,
   model evidence, runtime snapshot, schema probes, and all blocking-debt
   projections are readable and explicitly nonblocking;
3. an incomplete or unreadable sample retains
   `degradation_silence_unproven`;
4. retained nonblocking debt does not prevent clear;
5. a clear is observable in tests within the same server process, without a
   restart.

## Downstream Impact and Compensation

| Consumer / touchpoint | Current dependency | Impact | Required compensation |
|---|---|---|---|
| `src/core/health.ts` | Builds status, reasons, causes, and continuity-only debt | Producer semantics change | Build one normalized debt object; keep operational causes separate from debt reasons; prove once-per-request consistency. |
| `AgentRuntime.getHealthSnapshot()` | One broad degraded predicate | Historical counters keep runtime degraded | Emit typed blocking and retained gauges; derive runtime status only from blockers. |
| Durability health/store queries | Counts every stale `maybe_sent` | Corroborated rows look ambiguous | Add corroboration-aware aggregate and unreadable fail-closed result; preserve raw rows. |
| Turn-recovery supervisor/enumerator | Sees selected operation status but not corroboration | Corroborated job stays pending forever | Use the same corroboration predicate for claimability and blocking counts; retain audit visibility. |
| Runtime health signal taxonomy and BOT ERRORS checker | Positive registered gauges can become `runtime_agent_at_risk` | Old raw counters could reintroduce false degradation | Register new blocking gauges as current risk and retained gauges as diagnostic-only; update cross-contract and deploy bundle tests. |
| Fleet `classifyHealthSnapshot` | Maps top-level healthy/degraded to online/degraded | Debt-only line becomes online | Intended. Validate healthy-with-debt as recognized, connected, online. |
| Fleet `health_body_degraded` alert | Pages from top-level degraded after debounce | Historical debt stops paging as outage | Clear only after a fresh operationally healthy sample; do not page general health for debt-only state. |
| Fleet debt observation | No dedicated debt lifecycle | Debt could disappear from fleet attention | Add `recovery_debt_attention` as a distinct, non-outage alert/event source with open/change/clear semantics and bounded evidence. It must not alter line status or trigger heal/restart. |
| Fault taxonomy / dispatcher | Sources require registered ownership and clear rules | New source otherwise fails registry gates | Register detection owner, non-paging/operator disposition, dedupe key, clear proof, docs, and semantic tests. |
| `InstanceStatus` and lines API | Carries raw health and operational status | Raw debt exists but has no stable projection | Add a normalized debt summary alongside raw health; preserve existing fields. |
| Console shared types | Knows status and degradation causes only | Healthy debt is untyped | Add the additive debt shape and normalized summary types. |
| Console Fleet/Operator KPIs | Treat non-online as current attention | Debt-only line no longer appears in outage KPI | Keep `needAttention` operational; add a separate `recoveryDebtLines`/debt count KPI or annotation that does not change green service status. |
| Console line cards/detail | Renders `degradation_causes` warning chips even when healthy | Debt could still look like degradation | Render operational causes only under degraded status; render recovery debt in a separately labelled badge/details section. |
| Console activity feed | Emits line health transitions | Degraded-to-online recovery may hide remaining debt | Keep operational recovery event and add distinct debt opened/changed/cleared feed events; never label debt-only as health failure. |
| `classify_health.py` keychain-heal gate | Accepts only healthy + fresh usable model | Debt-only instance becomes accepted | Intended; add explicit healthy-with-debt and blocking-debt/status-mismatch tests. |
| Startup-notification release validator | Rejects non-healthy | Debt-only deployment becomes releasable | Intended when `service_blocking=false`; test that blocking debt cannot pair with healthy producer status. |
| launchd/systemd watchdog templates | Restart only unhealthy/transport failure; degraded is tolerated | Debt-only status becomes healthy | No policy change; add regression fixture proving debt never causes restart. |
| BOT ERRORS heartbeat watchdog | Marks degraded/unhealthy status | Debt-only stops current-health warning | Intended; separate debt evidence/alert remains visible through its owner. |
| Public unauthenticated `/health` | Transport-only minimal status | No debt is exposed | Preserve privacy and shape; debt remains authenticated-only. |
| `docs/public-surface.md` | States all open recovery/catch-up debt degrades | Contract becomes false | Replace with the classification matrix and additive schema semantics. |
| Runbooks/configuration/durability docs | Continuity-only healthy-with-debt precedent | Incomplete operator guidance | Document debt inspection, urgency, alert ownership, remediation, and rollback. |
| API/schema compatibility | Consumers accept the three-value status enum and unknown fields | A fourth enum would break clients | Keep enum; make all new fields additive; retain compatibility fields and raw counters. |

## Debt Alert Lifecycle

`recovery_debt_attention` is not an outage page. It is a durable operator
attention signal owned by the fleet poller.

- Open only from an authenticated, fresh, readable debt projection.
- Dedupe by instance and source.
- Emit bounded evidence: attention class, ordered reason codes, aggregate
  counts, oldest bounded age, and `service_blocking=false`.
- Do not invoke heal, restart, provider fallback, logged-out recovery, or the
  `health_body_degraded` path.
- Update only when the reason set, attention class, or a thresholded count/age
  bucket changes.
- Clear only after a fresh readable sample reports `open=false`.
- If debt becomes blocking, ordinary degraded health owns the outage signal;
  the debt record may remain as context but must not produce a duplicate page.

The initial implementation should use existing fleet polling cadence and alert
dedupe rather than add a new scheduler. Any configurable dwell or growth
threshold must be documented and included in deploy/runtime manifests.

## Compatibility and Rollout

### Adjacent live process-isolation finding

Live validation exposed one independent crash mechanism that could otherwise obscure the health
split. Two idle per-chat sessions entered graceful suspension and, three seconds later, a different
active provider session exited with code 143 while the WhatSoup service PID remained stable. The
process-tree reaper had promoted every PID in the shared service cgroup into the target session's
owned set. Because a per-chat runtime deliberately hosts multiple provider trees in one service
cgroup, membership proves co-location, not ownership.

The compensating change keeps cgroup divergence as telemetry but signals only the provider root and
its identity-checked PPID descendants. A controlled census test must prove that a cgroup-only sibling
is observed and not signaled; existing reaping, ambiguity, shutdown, idle-eviction, checkpoint, and
generation tests remain mandatory. Rollback of this compensation restores the sibling-termination
risk and is therefore not a safe standalone rollback while per-chat sessions share a cgroup.

1. Add producer fields and consumer parsing in one PR so no merged state loses
   visibility.
2. Older consumers continue to read `status`, `status_reasons`, existing
   runtime counters, and the continuity compatibility fields.
3. New consumers treat a missing `recovery_debt` as unknown/not-supported, not
   as proof of zero debt.
4. A malformed or internally contradictory debt projection fails closed:
   `service_blocking=true`, degraded status, and bounded evidence.
5. The console and fleet may be rolled back independently because the raw
   health fields are additive. Rolling back only the producer restores the old
   conservative degradation behavior.
6. No database migration is required unless implementation proves the existing
   corroboration index cannot support a bounded aggregate. Any migration must
   be justified with query-plan evidence and added to this design before merge.

## Verification Strategy

Implementation follows test-first behavior changes.

### Producer tests

- Table-driven runtime classification for every row in the classification
  contract.
- Real durability fixtures for uncorroborated and corroborated `maybe_sent`.
- Recovery enumeration proves a corroborated retained job is never claimed.
- Admission tests distinguish `fresh_inbound`, `operator`, unreadable, and
  unknown next actions.
- Core health tests prove healthy/no debt, healthy/retained debt,
  degraded/blocking debt, mixed operational failure plus debt, and unreadable
  fail-closed behavior.
- Same-process latch test proves degraded -> fully evidenced healthy recovery
  without restart and refuses to clear on missing evidence.
- Privacy tests reject identifiers and content from every new field.

### Consumer contract tests

- Fleet classifier and poller recognize healthy-with-debt as online.
- `health_body_degraded` clears only on fresh operational recovery.
- Debt alert opens, dedupes, changes on bounded bucket transitions, and clears
  independently of line status.
- Fault-taxonomy cross-contract and runtime-manifest tests cover the new source
  and signal dispositions.
- Lines API and console type/component tests render online plus debt without a
  degradation chip or outage KPI increment.
- Feed tests distinguish operational recovery from debt open/clear.
- Keychain-heal, startup-release, BOT ERRORS, and watchdog fixtures cover
  healthy retained debt and contradictory blocking debt.

### Branch and live validation

- Focused Vitest and Python suites for every touched producer and consumer.
- Console typecheck/tests and production build.
- Root TypeScript typecheck, lint, source-contract, public-surface, fault
  taxonomy, runtime-manifest, and publication hygiene gates.
- Full test suite with pinned supported Node 24. Any hang, timeout, skip, or
  masked failure remains inconclusive and is reported as such.
- Rebase/merge verification against current `origin/main`, then repeat decisive
  gates on the exact PR head.
- A reviewed deployment plan with backup and rollback before changing the
  affected fleet instance.
- Authenticated synchronized live observations must prove: connected transport,
  fresh usable model, low event-loop lag, zero current crash/recovery blockers,
  `status=healthy`, `recovery_debt.open=true`, and
  `recovery_debt.service_blocking=false` for the retained incident cohort.
- Direct-message and selected-group canaries must receive exactly one appropriate
  reply with no reasoning leak, deletion attempt, scheduled narration, or
  unsolicited extra output during the observation window.

## Rollback

Rollback restores the old conservative producer classification while leaving
all durable records untouched. It must not delete corroboration, clear
quarantines, close catch-ups, replay work, or suppress unreadable evidence.
Fleet and console consumers must tolerate both old and new shapes throughout
rollback.

## Acceptance Criteria

- Q-like retained debt is reported as healthy with open nonblocking recovery
  debt when all current operational evidence is green.
- Any active or unreadable safety blocker still produces degraded/unhealthy
  status and the existing operational alert path.
- Every known status consumer has a test or documented no-change rationale.
- Debt remains visible in authenticated health, fleet/API, console, runbooks,
  and a distinct non-outage alert lifecycle.
- Corroborated historical delivery evidence is never replayed and is not
  rewritten to manufacture a healthy result.
- The in-process degradation latch can clear only on explicit complete proof.
- The PR is based on current main, documented, self-reviewed, locally verified,
  and reviewed before merge.
