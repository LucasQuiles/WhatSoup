# Controller Log Envelope v1

Status: implementation design for #2508 and #2509

## Problem

The dispatcher, collector, heartbeat watchdog, q-loop, and deadman write
diagnostic JSONL with incompatible fields and incompatible append-failure
semantics. The records cannot be joined by controller run or cycle, and the
same sink failure can be swallowed, terminate a daemon, turn completed domain
work into a failed cycle, or replay a deadman recovery.

The JSONL streams are diagnostic. Source inspection found no production reader
that uses them as lifecycle, delivery, retry, reconciliation, or billing state.
The durable controller state files, queue records, and outboxes remain the
authoritative domain stores.

## Selected design

Add `deploy/scripts/lib/controller_log.py` as a contract and policy layer above
the existing per-script append and atomic-state primitives.

The shared layer:

- builds and validates one v1 envelope;
- owns content-free run, cycle, and process-local sequence correlation;
- emits cycle start, completion, and failure receipts;
- requires an explicit durability class for every record;
- converts diagnostic append failures into a bounded secondary sink-health
  receipt and a coalesced, metadata-only stderr fallback; and
- never changes the success, retry, or exception result of the wrapped domain
  operation.

It does not replace JSONL append, fsync, rotation, atomic JSON, or file-trust
primitives. Those remain behind the existing caller-supplied functions and the
separate #2464 extraction boundary.

### Alternatives rejected

1. Duplicate the envelope builder in all five scripts.
   This avoids one runtime file but preserves the schema and failure-policy
   drift that #2508 and #2509 report.
2. Wait for or merge this work into #2464.
   The active #2464 slice explicitly excludes broader JSONL observability.
   Coupling record semantics to low-level file primitives would block this
   behavior fix and enlarge the shared-primitives change.
3. Make every append fatal.
   This repeats the current collector/dispatcher/deadman failure modes.
4. Swallow every append error without a secondary receipt.
   This repeats the watchdog's silent-loss behavior.

## Envelope

Every new record has the same authoritative top-level fields:

| Field | Contract |
| --- | --- |
| `schemaVersion` | Integer `1`. |
| `observedAt` | UTC ISO-8601 wall-clock observation time. It is not monotonic. |
| `component` | One of `collector`, `dispatcher`, `heartbeat_watchdog`, `q_loop`, or `deadman`. |
| `recordKind` | Component-owned, bounded snake-case name. Cycle receipts use `cycle_started`, `cycle_completed`, or `cycle_failed`. |
| `level` | One of `debug`, `info`, `warning`, or `error`. |
| `outcome` | One of `observed`, `started`, `completed`, `failed`, `suppressed`, or `recovered`. |
| `runId` | Opaque process-start identity. Restart creates a new value. |
| `cycleId` | Opaque current-cycle identity. Each decorated invocation creates a new value. |
| `sequence` | Unique, increasing process-local integer. A gap means a diagnostic record was dropped; it never triggers domain replay. |
| `durabilityClass` | `diagnostic_best_effort` for every current family. `audit_critical` is reserved and rejected by this writer until a transactional intent/outbox contract exists. |
| `details` | Bounded counters, booleans, and closed operational enums under one nested field; it cannot overwrite envelope fields. Arbitrary strings are dropped. |

For one compatibility generation, every stream also emits `time` as an alias
of `observedAt` and `type` as an alias of `recordKind`. The old q-loop/watchdog
`kind` and q-loop epoch `ts` fields are not authoritative and are not emitted
by v1.

All five controllers are single-threaded today. The context still protects
cycle and sequence mutation with a lock so tests or future in-process callers
cannot duplicate sequence values.

## Field mapping

| Current writer | Record kind source | Details |
| --- | --- | --- |
| q-loop event log | `log_event(kind, data)` | Redacted `data`. |
| q-loop activity log | Fixed `activity_observed` | Metadata-only activity projection; message body and sender value are excluded. |
| heartbeat watchdog | `append_log(kind, payload)` | Existing redacted payload. |
| collector | `payload.type` | Existing redacted payload without `type`. |
| dispatcher | `payload.type` | Redacted payload without `type`; raw exception, event/path, destination, and message fields are excluded or reduced to bounded class/count fields by the adapter. |
| deadman | `payload.type` | Existing redacted outcome without `type`; incident/problem text and destination data are not copied into the v1 details. |

Legacy retained files are not rewritten. A parser returns
`legacy_unversioned` for records without the v1 fields and never invents run,
cycle, sequence, level, or outcome values.

## Failure policy

All current controller-log families explicitly declare
`diagnostic_best_effort`. This classification is valid only because:

1. durable controller state, queue records, or outboxes own domain truth;
2. no production consumer reads JSONL as an operational authority; and
3. append failure cannot block or replay domain progress.

The shared writer receives, rather than implements, these caller-owned
functions:

- the current low-level append primitive;
- the current atomic state writer for a bounded sink-health receipt; and
- a metadata-only stderr fallback.

On append success, the writer returns `written`. After a prior failure it also
records one recovered sink-health receipt.

On append failure, the writer:

1. classifies the exception into a closed bounded class;
2. increments process-local consecutive and total dropped counters;
3. writes one fixed-shape sink-health state object;
4. writes stderr only on the first failure and power-of-two counts; and
5. returns `diagnostic_degraded` without raising.

The sink-health object is one atomically replaced record rather than a growing
list. Its serialized size is capped at 4 KiB. It contains no failed record,
path, exception prose, payload, identity, destination, or topology.

If the health-state write also fails, the same coalesced stderr fallback
reports only the component, failure class, and bounded count.

## Cycle receipts

A decorator starts a new cycle before invoking each controller entry point:

- dispatcher `run_once`;
- collector `run_once`;
- heartbeat watchdog `run_once`;
- q-loop `run_once`; and
- deadman `deadman`.

The decorator emits exactly one start receipt and then exactly one completion
or failure receipt. Both terminal receipts include monotonic `durationMs` and
bounded numeric counters. Failure also includes only a closed exception class.
Logging failure never replaces the wrapped function's return value or original
exception.

Typed cross-component event correlation remains intentionally absent from v1.
Deriving tokens from private event, incident, destination, or topology values
without a reviewed domain-separation secret would create a stable identifier
leak. A later schema version may add correlation tokens once their producer,
privacy, rotation, and consumer contracts are independently specified.

## Deadman ordering

This slice fixes only the #2509 diagnostic-ordering replay:

```text
accepted recovery side effect
→ update resolved/idempotency state
→ durably save deadman state
→ append nonessential diagnostic record
```

A diagnostic append failure after the state save cannot make the same
successful recovery eligible again. Broader accepted/rejected/ambiguous
delivery gating and stable problem-member identity remain owned by #2424 and
#2425.

## Compatibility and rollout

- Existing JSONL files remain untouched.
- No live-log migration, rotation, deletion, deployment, or service restart is
  part of this draft.
- Existing human and drill consumers can use the temporary `time` and `type`
  aliases.
- Production code search must continue to show no operational JSONL reader
  before all families are classified `diagnostic_best_effort`.
- The shared module must be included in the checked runtime manifest and both
  deployment bundle file lists. Isolated-bundle import tests must fail when it
  is absent or mismatched.

## Verification

The implementation must prove:

1. all five adapters emit the same authoritative field set;
2. identifiers, enums, record names, details size, and reserved-field
   collisions fail closed;
3. two cycles in one process have different cycle IDs and increasing sequence;
4. restart creates a different run ID;
5. a thrown cycle emits one failure receipt and no completion receipt;
6. append failure leaves domain work successful, writes bounded degraded
   sink-health state, and coalesces stderr;
7. storage repair produces one recovered sink-health receipt;
8. sustained failure never grows the health state beyond 4 KiB;
9. deadman recovery is not replayed when its diagnostic append fails;
10. collector, dispatcher, q-loop, and watchdog no longer terminate, report a
    false domain failure, or silently lose sink failure solely because their
    former writer policy differed;
11. existing low-level append semantics are unchanged;
12. legacy parsing returns `legacy_unversioned`;
13. runtime-manifest and isolated-bundle tests include the shared module; and
14. tests and public documentation use only reserved synthetic identifiers and
    contain no private environment data.
