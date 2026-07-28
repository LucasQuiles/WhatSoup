# Runtime Health Signal Dispositions Design

**Status:** active
**Issues:** #2541, #2544
**Related boundary:** #2447 remains the broader cross-contract owner

## Problem

The agent runtime publishes heterogeneous health values in one untyped details
object. The scheduled BOT ERRORS checker then applies one generic rule to a
hard-coded list: every positive numeric value except session counts becomes
`runtime_agent_at_risk`.

That rule contradicts existing producer contracts:

- auto-compaction `ineffective` and `nextTurnOverThreshold` are lifetime totals;
- `consecutiveRapidRearmsMax` is a historical maximum;
- `turnRecoveryBlockedUnsafe` is retained terminal audit/operator-action
  evidence and does not independently degrade runtime health;
- active recovery obligations and degraded finalization scopes are current
  conditions and must continue to affect health.

The root defect is not two wrong list entries. It is the absence of a canonical
signal-kind and per-consumer disposition contract.

## Goals

1. Make numeric signal semantics explicit and machine-readable.
2. Preserve cumulative auto-compaction telemetry without treating it as current
   risk.
3. Expose bounded, aggregate current auto-compaction backoff state so an active
   episode can still degrade health.
4. Keep blocked-unsafe recovery receipts visible without classifying them as an
   outage.
5. Make runtime, core health, scheduled-checker, and fleet behavior agree for
   the same snapshot.
6. Fail visibly if the runtime signal registry is missing, malformed, or gains
   an unsupported disposition.
7. Keep health evidence metadata-only: enums, counts, ages, timestamps, and
   bounded tiers only.

## Non-goals

- Completing every namespace and projection required by umbrella issue #2447.
- Changing blocked-recovery admission or operator disposition workflows owned
  by #2155.
- Redesigning cause-aware paging and incident identity owned by #2409 and
  adjacent alert-lifecycle issues.
- Persisting scope keys, conversation identifiers, raw provider output, paths,
  process identifiers, or topology in health evidence.
- Deploying, restarting, or mutating any live runtime.

## Considered Approaches

### A. Extend the existing canonical registry and consume it at runtime

Add a `runtimeAgentHealthSignals` section to
`src/lib/fault-taxonomy-registry.json`, expose a typed TypeScript view, and make
the Python health checker load the same bundled JSON.

This is the selected approach. It creates one source of truth, aligns with
#2447, and removes the generic numeric-severity inference from production.

### B. Add a separate runtime-health registry

This would reduce the immediate diff in the fault registry, but it would create
a second taxonomy artifact precisely where #2447 requires a canonical
cross-contract. Rejected as avoidable SSOT drift.

### C. Replace the generic loop with hard-coded allow/deny sets

This would fix the two reported examples, but future fields could silently
reintroduce the same bug. Rejected because it treats symptoms and cannot enforce
cross-consumer parity.

## Canonical Signal Contract

The registry schema advances to v3 and adds an ordered
`runtimeAgentHealthSignals` list. Each entry declares:

- `field`: the unique public runtime health field name;
- `label`: bounded evidence label used by the Python checker;
- `kind`: `current_gauge`, `active_episode_count`, `terminal_audit_count`,
  `cumulative_total`, or `historical_maximum`;
- `currentHealthEffect`: `positive_is_risk` or `diagnostic_only`;
- `owner`: producer source reference;
- `test`: behavior-test reference.

The checker renders every registered value as evidence when present. It adds
`runtime_agent_at_risk` only for `positive_is_risk` entries. Numeric type alone
has no severity meaning.

The initial list covers every numeric field the scheduled checker currently
projects, including the separately rendered finalization/recovery diagnostics.
Diagnostic-only entries include:

- `activeSessions` and `sessionCount`;
- `pollPersistenceErrors`;
- `autoCompactIneffective`;
- `autoCompactConsecutiveRapidRearmsMax`;
- `autoCompactNextTurnOverThreshold`;
- `turnRecoveryBlockedUnsafe`;
- recovery sub-counts whose current-health effect is already represented by
  `turnRecoveryOutstanding` or another registered obligation;
- retained retry-attempt/recovery totals.

Current-risk entries preserve existing producer semantics:

- recent crashes;
- finalization degraded scopes;
- retained finalization retries, which core health already treats as current
  finalization debt;
- `turnRecoveryOutstanding`;
- exhausted recovery work, open recoveries, corrupt links, and echo conflicts;
- the new `autoCompactActiveBackoffScopes` current gauge.

Registry validation rejects unknown signal kinds, unknown health effects,
missing fields or labels, duplicate fields or labels, missing owner/test
references, and a schema version other than v3.

## Current Auto-Compact State

`AutoCompactController` adds a pure aggregate health projection:

```ts
interface AutoCompactHealthSnapshot {
  readonly state: 'idle' | 'backoff';
  readonly activeBackoffScopes: number;
  readonly worstCurrentBackoffTier: number;
}
```

The projection uses existing controller state:

- a scope is active when it has a positive consecutive rapid-rearm count and a
  cooldown deadline later than the observation time;
- the worst tier is the maximum active consecutive count, capped to the
  configured backoff-tier range;
- no scope key or per-scope value leaves the controller;
- expired cooldowns, explicit scope cleanup, and controller shutdown stop
  contributing to the current gauge;
- lifetime totals and historical maxima are unchanged.

`AgentRuntime.getHealthSnapshot()` emits:

- `autoCompactState`;
- `autoCompactActiveBackoffScopes`;
- `autoCompactWorstCurrentBackoffTier`;
- the existing three historical counters.

The runtime adds `auto_compact_backoff` to `degradedReasons` only while the
active scope count is positive. This gives runtime/core/checker/fleet one
current-state predicate. Restarted controllers begin with no active in-memory
backoff; historical-counter reset is never consumed as recovery evidence.
Cause-specific durable incident lifecycle remains outside this slice.

## Python Checker

`bot-errors-health-check.py` loads the bundled registry from the repository
root. The loader returns either a validated ordered signal definition or a
bounded error class.

When the registry is valid:

1. Iterate registered signals in registry order.
2. Render present values with their registered labels.
3. Add current risk only for a positive registered `positive_is_risk` signal.
4. Render `autoCompactState` as a bounded enum separately.

When the registry is missing or invalid:

- add `runtime_agent_health_signal_registry_invalid`;
- include only a bounded registry error class;
- render the health probe as `WARN`;
- do not infer individual field severity.

The registry JSON is added to the BOT ERRORS runtime manifest and deploy bundle
so production behavior does not depend on an undeployed source file.

## Cross-Consumer Invariants

Behavior tests use the same reserved synthetic snapshots across consumers:

1. Healthy + positive lifetime counters + blocked-unsafe audit count remains
   healthy/OK while retaining the evidence fields.
2. Active auto-compact backoff degrades the runtime and renders WARN.
3. Backoff expiry or scope cleanup clears the current gauge while preserving
   lifetime totals.
4. Blocked-unsafe plus a distinct outstanding/open/corrupt obligation remains
   degraded for the declared obligation, not the audit count.
5. Removing a registry entry or changing its disposition makes the contract
   tests fail.
6. Missing or malformed registry data yields a visible warning, never a false
   green.
7. Aggregate health output contains no scope identifiers or other forbidden
   payload classes.

## Deployment and Compatibility

- Existing health fields remain present with unchanged names and values.
- New fields are additive.
- The checker output retains existing evidence labels.
- The registry becomes a pinned runtime dependency.
- No database migration, live-state rewrite, deployment, restart, or data
  deletion is required.

## Verification

The implementation must run:

- focused `AutoCompactController` and agent health snapshot tests;
- runtime recovery-health tests;
- TypeScript fault-taxonomy cross-contract tests;
- Python fault-taxonomy registry tests;
- BOT ERRORS health-check behavior tests;
- runtime-manifest and deployer parity tests;
- TypeScript typechecks, source lint, publication/hygiene guards, and the branch
  push gate;
- exact-head draft CI before changing issue labels to `PATCH READY`.
