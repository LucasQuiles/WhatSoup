# Turn-Recovery Safety and Liveness Design

**Status:** active
**Date:** 2026-07-28
**Issues:** #2148, #2150, #2151
**Pinned baseline:** `a079b5bc63168c22e9fae012f15590cdf8c04c22`

## Purpose

Harden the durable per-chat turn-recovery consumer introduced by merged PR
#2123 without creating a second replay path or broadening recovery to cold,
shared, or singleton sessions.

The three issues form one safety boundary:

- the consumer must publish truthful success-based liveness to an independent
  cadence owner;
- a replay claim must bind to the intended active session generation; and
- a transient claim-renewal failure must not let the same replay continue past
  lease expiry and overlap a successor owner.

PR #2071 remains the owner of safe inbound replay. Issues #2169 and #2170 remain
the owners of cold-session provisioning and shared/singleton recovery scope.

## Existing Contract and Failure Modes

The current supervisor has the correct durable state-machine foundation:
bounded enumeration, replay-safety gates, epoch-fenced claims, lease renewal,
ordinary runtime dispatch, completion proof, and bounded requeue/exhaustion.
This change preserves those owners.

Three residual gaps remain:

1. `lastScanAt` records scan entry, so repeated enumeration failures can look
   healthy. The exported heartbeat predicate has no production cadence owner.
2. production admission checks map membership, not active ownership state, and
   does not carry the admitted generation to the provider boundary.
3. the first renewal exception permanently stops renewal, even when the store
   failure is transient. Completion fencing prevents an invalid final write but
   cannot stop an already-running provider request from overlapping a successor.

## Invariants

### Scan liveness

- A scan attempt and a successful scan are distinct events.
- Successful liveness requires stale-claim recovery, enumeration, and the
  bounded page's processing to complete without a recorded store error.
- A failed attempt never advances the success watermark.
- Failure diagnostics are a bounded enum plus counters; no exception text,
  record identifier, conversation identifier, or content enters health or
  alert evidence.
- An independent timer owns alert and clear decisions. The watched supervisor
  timer never pages on its own behalf.

### Replay admission

- Production admission resolves one immutable dispatch permit before claiming.
- A permit names the current map key, manager identity, ownership generation,
  and exact in-memory session reference.
- Resolution succeeds only when the mapped session is active, the ownership
  registry is current, and its state is `active`.
- The same permit is revalidated at the exact provider boundary. A lifecycle
  change before that boundary prevents the provider write.
- Missing, inactive, starting, resetting, respawning, recoverable-dead,
  exhausted, closing, replaced, or generation-mismatched targets fail closed.
- A pre-claim failure remains an unclaimed transient skip and consumes no
  attempt or backoff.

### Lease continuity

- The store exposes a typed ownership-loss error only for semantic fence loss:
  missing/reassigned ownership, stale token or epoch, non-claimed state, or
  expired lease.
- Store availability failures remain ordinary retryable exceptions.
- A successful renewal advances the locally tracked exact expiry returned by
  the store.
- A transient failure schedules bounded retry inside the remaining lease
  margin; it does not stop all future renewal.
- A confirmed ownership loss aborts the exact replay and forbids completion or
  requeue by the stale owner.
- Repeated transient failures trigger the same cooperative abort before the
  safety deadline. After a proven abort, the owner may requeue only through the
  original claim fence while it is still valid.
- An abort is proven only when either the replay never crossed the provider
  boundary or the exact provider generation has been terminated.
- If provider termination cannot be proven, health records a fail-closed abort
  failure and no success claim is made. This is an explicit critical
  operational fault, not evidence that overlap was prevented.

## Components

### Supervisor health snapshot

`TurnRecoverySupervisorHealth` gains:

- `lastScanAttemptAt`;
- `lastSuccessfulScanAt`;
- `consecutiveScanFailures`;
- `lastScanFailureReason`;
- retryable renewal failure, confirmed ownership-loss, fail-closed abort, and
  abort-failure counters.

The legacy `lastScanAt` field is removed from the heartbeat decision. The pure
evaluator reports:

- `never_succeeded`;
- `stale_success`;
- `repeated_failures`; or
- `ok`.

### Independent deadman

A focused `TurnRecoveryDeadman` owns its own unreferenced timer. It is started
only for an enabled per-chat supervisor and stopped before runtime teardown.
It applies startup grace, invokes the pure evaluator, emits one checked
`turn_recovery_supervisor_unavailable` alert per unhealthy episode, and emits
one matching checked clear only after a fresh successful scan.

The stable alert summary prevents reason changes from creating new incidents.
Evidence is restricted to reason, bounded failure class, success age, attempt
count, and consecutive-failure count.

### Dispatch permit and cooperative abort

The supervisor replaces the boolean production admission callback with a
permit resolver. The permit is threaded through claim, dispatch, exact-boundary
validation, and abort.

Each dispatch receives a cooperative abort control:

- its signal participates in every pre-dispatch wait and exact-boundary check;
- the dispatcher registers one abort handler before awaiting runtime work;
- before the provider boundary, abort is proven by preventing the write;
- after the boundary, the handler rejects the exact completion, preserves
  durable turn evidence, starts ordinary crash finalization, and terminates the
  exact session generation before reporting proof.

No raw provider send, SQL transition, or parallel replay implementation is
added.

### Renewal scheduler

The current fixed interval becomes a single unreferenced timeout that is
rescheduled from the latest store-returned expiry.

- normal renewals target half of the remaining lease;
- transient retries use a bounded short delay;
- the abort deadline reserves a termination margin before expiry;
- every timer is cleared when dispatch settles or abort takes ownership; and
- only one renewal or abort action can be in flight for a replay.

## Alert Ownership

`turn_recovery_supervisor_unavailable` is registered in the fault-taxonomy
source disposition registry with:

- detection owner: the independent runtime deadman;
- incident disposition: recovery consumer unavailable until a successful scan;
- semantic test: the real cadence test covering alert, dedupe, and clear.

The BOT ERRORS ownership index records the runtime deadman cadence and leaves
incident dedupe and delivery with the existing dispatcher.

## Test Strategy

Tests are deterministic and content-free.

- Supervisor tests use fake time to prove failed enumeration and stale-claim
  recovery do not advance success.
- Deadman tests exercise the real timer owner through startup grace, repeated
  unhealthy checks, alert dedupe, and one successful clear.
- Store tests prove typed semantic fence loss while ordinary database
  exceptions remain retryable.
- Supervisor lease tests prove transient failure then recovery, confirmed stale
  ownership abort, repeated-failure abort before expiry, and no successor
  dispatch while the original provider generation remains live.
- Runtime wiring tests prove absent, inactive, non-active ownership state, and
  generation replacement are rejected, while a matching active generation can
  dispatch.
- Exact-boundary tests change generation after admission and prove no provider
  write occurs.
- Existing recovery, claim-fence, completion, requeue, shutdown, and
  exactly-once suites remain green.

## Non-Goals

- Cold-session creation or user-less session spawning.
- Shared or singleton recovery dispatch.
- Longer leases as a substitute for renewal correctness.
- Provider selection or fallback-policy changes.
- A new replay, completion, or recovery-record publication path.
- Public diagnostics containing record, chat, message, session, process, or
  environment identifiers.

## Rollback

The change is one cohort but remains mechanically separable:

1. disable and remove the deadman owner while retaining success-based health;
2. restore the prior optional test-only dispatch callback while retaining the
   production permit resolver; or
3. restore the prior renewal scheduler only if the typed fence and abort tests
   demonstrate an incompatibility.

Rollback must never retain a call site that assumes a typed ownership-loss
classification while restoring the untyped store error.
