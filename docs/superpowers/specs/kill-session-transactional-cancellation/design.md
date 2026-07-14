# Transactional `/kill-session` Cancellation Design

> **Status:** active
> **Baseline:** `origin/main@56e232223132d33c347cd2d2521620f911d4f4b6`
> **Selected approach:** fenced target transaction over existing lifecycle owners

## Context

The current command runs inside the same `turnChain` that can be blocked by the
turn it is supposed to stop. In per-chat mode it aborts presentation, attempts a
partial queue teardown, deletes session/queue/runtime maps even when durable
finalization fails, and then reports success. Published contexts are skipped,
pending turns are finalized with the active scope reference, alias movement can
make deletion target a stale key, and the existing recovery waiter can remain
unresolved after retry exhaustion. Shared and singleton cancellation does not
terminalize their active or queued turns at all.

The result is an ownership inversion: process cleanup destroys the in-memory
owners needed to complete durable turn accounting. The selected design reverses
that order. It captures an exact target, freezes admission and replay, begins turn
terminalization and targeted child stop, and releases state only after independent
terminal/recovery, process-stop, and queue-idle proofs agree.

## Design Decisions

#### DES-001: Admit `/kill-session` through a dedicated local control lane
- **Traces-from:** REQ-001, CON-003
- **Rationale:** Add a narrow text-only preflight in `handleMessageInner` before
  imperative extraction, session creation, and the ordinary `turnChain`. It
  recognizes only the existing classified `kill-session` local command, performs
  the existing admin/index checks, captures the selected target immediately, and
  appends the operation to a dedicated `killSessionControlChain`. All other input
  continues through the current path. Because capture precedes serialization, two
  concurrent `/kill-session 1` messages both point to the same session object;
  the second can report already-closing or already-released but cannot select the
  next map entry after the first deletion.
- **Alternatives considered:**
  - Keep the command inside `turnChain`: rejected because a blocked singleton or
    shared provider turn prevents the command from running.
  - Give every local command a parallel lane: rejected because `/new`, routing,
    and other commands have different active-turn safety contracts.
  - Change the public command from numeric index to a new identifier in this PR:
    rejected because immutable capture fixes in-operation drift without expanding
    the operator interface.

#### DES-002: Capture an exact target and install ownership fences before awaits
- **Traces-from:** REQ-001, REQ-004
- **Rationale:** A `SessionCancellationTarget` is an immutable snapshot of scope,
  selected session object, manager ID, generation, queue object, active turn,
  pending-turn identities, outbound queue, and (for per-chat mode) the mutable
  `PerChatRuntimeScopeRef`. Before the first await, cancellation clears the exact
  respawn timer, transitions per-chat ownership to `closing`, installs a
  cancellation fence, and closes admissions. Global callbacks capture the session
  object plus manager ID/generation and check they remain current; per-chat
  callbacks additionally resolve the current scope ref and registry owner. Stale
  callbacks are content-free drops. Every delete or reopen uses object identity
  plus the final scope key, never a key-only lookup.
- **Alternatives considered:**
  - Re-resolve the numeric index during execution: rejected because deletions and
    respawns can shift the list.
  - Fence only by chat key: rejected because LID rekey and replacement sessions
    legitimately reuse or move keys.
  - Rely on child shutdown to stop late callbacks: rejected because buffered
    events and promise continuations can run after process exit.

#### DES-003: Split queue close, preflight, drain, and guarded reopen
- **Traces-from:** REQ-002, CON-002
- **Rationale:** Extend `TurnQueue` with an opaque admission-fence epoch:
  `closeAdmissions()` returns a fence without removing entries;
  `snapshotForCancellation(fence)` provides the active/pending identities for
  validation; `takePending(fence)` drains only after every journaled entry proves
  an immutable context; and `reopenAdmissions(fence)` succeeds only for the same
  epoch when the queue is empty, idle, and non-halted. Late enqueues are rejected
  through the existing `onReject` hook. A per-chat queue is deleted by object
  identity after proof so the next user turn creates a fresh queue. The global
  queue is not replaced because the runtime coordinator already captures the
  original instance; shared/single cancellation reopens that same instance.
- **Alternatives considered:**
  - Reuse `closeAndTakePendingTurns()` as-is: rejected because it destructively
    splices entries before missing-context validation and has no safe reopen.
  - Delete and recreate the shared queue: rejected because coordinator callbacks
    and host references retain the original object.
  - Skip malformed entries and continue cleanup: rejected because a journaled row
    without immutable ownership is precisely the case that must remain visible.

#### DES-004: Terminalize by publication state with replay safety latched false
- **Traces-from:** REQ-002, REQ-003, CON-002
- **Rationale:** The cancellation coordinator classifies captured turns before
  dispatch can advance:

  | Captured state | Attempt outcome | FIFO scope | Evidence handling |
  |---|---|---|---|
  | published active | `failed/operator_cancelled` | exact mutable scope | `abortTurn({ preserveEvidence: true })`, then normal finalizer |
  | active unpublished | `failed/operator_cancelled` | none | cancellation latch prevents provider dispatch |
  | pending at close | `admission_rejected` | none | never entered runtime FIFO |
  | late admission after close | `admission_rejected` | none | existing queue rejection owner finalizes |
  | missing immutable context | no invented terminal | none | stop child, retain closed lane and owners |

  For every context, `makeRuntimeTurnReplayUnsafe` (or the equivalent immutable
  replacement) runs before terminalization and can never be reversed. Published
  turns use `finalizeRuntimeTurnContext`; unpublished turns use an outcome-aware
  replacement for the crash-specific undispatched cancellation helper. Pending,
  submitted, or maybe-sent evidence therefore follows the existing
  `transferred_to_recovery_owner` path and creates a replay-unsafe recovery job,
  while no-evidence cancellation records a failed terminal.
- **Alternatives considered:**
  - Mark every target `admission_rejected`: rejected because published or active
    work was admitted and may already have effects.
  - Reuse `crash` as the failure class: rejected because operator intent is known
    and operational policy must distinguish it from an unexpected process crash.
  - Clear outbound evidence on abort: rejected because it can convert uncertain
    delivery into a false no-output terminal and unsafe replay.

#### DES-005: Coordinate terminalization and targeted child stop with a proof barrier
- **Traces-from:** REQ-002, REQ-003, REQ-004, CON-003
- **Rationale:** A `RuntimeSessionCancellationCoordinator` owns an in-memory
  operation record and runs turn finalization and `targetSession.shutdown(false)`
  concurrently after admissions and callbacks are fenced. Starting the targeted
  shutdown promptly preempts provider execution; final release waits for both
  tracks. The state machine is:

  ```text
  captured
     -> fenced
     -> admissions_closed
     -> terminalizing + child_stopping
     -> release_pending
     -> released

  terminal/proof failure
     -> retained_degraded
     -> terminalizing (existing supervisor retry or duplicate captured operation)
     -> release_pending
     -> released
  ```

  `release_pending` requires all captured turns to have exact terminal proof or a
  durable recovery transfer, the exact process tree to be stopped, and the
  captured queue to be idle. After-terminal actions only mark per-turn proof and
  schedule release outside the callback; they never await `queue.idle()` from
  inside post-effects, where completion settlement has not yet occurred. Immediate
  undispatched terminals invoke the same after-terminal hook as recovered ones.
  A dual-sink or retained terminal failure stops the child but preserves every
  owner and returns a bounded degraded result; it does not await an exhausted
  recovery waiter. A later successful supervisor retry runs the same idempotent
  release barrier exactly once.
- **Alternatives considered:**
  - Delete maps after child shutdown and trust startup recovery: rejected because
    it loses the runtime owner and recreates the DGX deadlock.
  - Await `waitForRecovery()` without a deadline: rejected because exhausted live
    retries leave that promise unresolved until full supervisor shutdown.
  - Release after a durably queued finalization incident but before terminal
    retry: rejected because the incident proves degradation, not the requested
    operator-cancelled terminal.

#### DES-006: Add `operator_cancelled` in code only
- **Traces-from:** REQ-003, CON-001, CON-002
- **Rationale:** Extend `AttemptOutcome`, `InboundFailureClass`, their bounded
  sets/coercers, `toInboundMutation`, and core terminal validation with the exact
  `operator_cancelled` value. Persist it in the existing TEXT columns while
  preserving the established `inbound_events.terminal_reason='error'` matcher
  contract. Migration 36 intentionally created
  `inbound_events.failure_class` as nullable CHECK-free TEXT; migrations 37-43
  likewise leave `turn_terminal_records.attempt_failure_class` as TEXT and bound
  the vocabulary in TypeScript. The change therefore adds no table, column,
  trigger, index, schema version, backfill, or migration file. Schema tests should
  assert that this rationale remains true; a migration would be drift, not safety.
- **Alternatives considered:**
  - Add a new cancellation table: rejected because terminal and recovery ownership
    already exist and a parallel journal would create conflicting truth.
  - Add a database CHECK for the new enum: rejected because it would contradict
    the intentionally code-bounded, migration-free taxonomy contract.
  - Store cancellation as generic `unknown`: rejected because it hides operator
    causality and defeats diagnostics.

#### DES-007: Keep command durability and stale-callback rejection separate
- **Traces-from:** REQ-001, CON-003
- **Rationale:** The command's inbound sequence is completed exactly once as
  `local_command_handled` in a `finally` owned by the control operation, regardless
  of target success, retained degradation, invalid selection, or duplicate
  status. Target user turns retain their own finalizer/recovery owner and never
  borrow the command sequence. Session factory callbacks route through exact
  ownership guards before `handleEvent`, `handleEventPerChat`, crash recovery,
  resume, or completion. Logs report bounded operation state, scope, manager/
  generation correlation, counts, and outcome codes only.
- **Alternatives considered:**
  - Complete the command only after every target retry: rejected because command
    handling and target durability are distinct obligations.
  - Let stale callbacks reach event handlers and rely on missing queues: rejected
    because replacement queues may exist by then.
  - Include output previews in cancellation logs: rejected because identity and
    disposition evidence are sufficient.

#### DES-008: Preserve per-chat isolation and focused change boundaries
- **Traces-from:** REQ-004, CON-002
- **Rationale:** A per-chat target captures one queue/session/owner graph; every
  mutation is guarded by that graph's object identity and final scope ref. Other
  chat maps and queues are not enumerated for cleanup and continue concurrently.
  Shared/single cancellation is necessarily global to that one shared/single
  session, but it still does not stop the service or other per-chat children. This
  PR does not modify provider event parsing, post-result gates, quarantine,
  tombstones, whole-service shutdown, fleet deployment, installers, or schema
  history.
- **Alternatives considered:**
  - Restart the service to recover a targeted lane: rejected because it interrupts
    unrelated sessions and was the production limitation this protocol removes.
  - Fold provider-event lifecycle into cancellation: rejected because the two
    changes have different state machines, persistence needs, and rollback units.
  - Generalize all shutdown behavior now: rejected because service shutdown has a
    broader queue set and different availability semantics.

#### DES-009: Deliver as twelve fixture-driven RED cases and focused slices
- **Traces-from:** CON-004
- **Rationale:** Write the complete cancellation conformance suite first with real
  SQLite durability and the real `TurnQueue`, observe the intended failures on the
  baseline, then implement taxonomy, per-chat cancellation, shared/single control,
  and retained recovery as separate commits. The twelve cases are independently
  marked and reviewed. The prior eleven-count is preserved in requirements as an
  explicit reconciliation rather than silently changing scope.
- **Alternatives considered:**
  - Extend only the idle queue test in `runtime.test.ts`: rejected because that
    test passed while the production ownership failure remained.
  - Mock durability and finalization: rejected because the defect crosses the
    SQLite terminal transaction, recovery owner, queue, and runtime maps.
  - Implement before recording RED: rejected because several current branches can
    pass shallow assertions for the wrong reason.

## Cancellation Target Model

The coordinator uses an immutable target object plus the existing mutable alias
reference:

```ts
interface SessionCancellationTarget {
  readonly operationId: string;
  readonly scope: 'per_chat' | 'shared' | 'singleton';
  readonly session: SessionManager;
  readonly managerId: string;
  readonly generation: number;
  readonly runtimeQueue: TurnQueue | null;
  readonly outboundQueues: readonly IOutboundQueue[];
  readonly capturedTurns: readonly RuntimeTurnContext[];
  readonly scopeRef?: PerChatRuntimeScopeRef; // value may change after capture
}
```

This is a coordination model, not a new persisted row. Durable truth remains the
turn terminal/recovery rows and the existing session lifecycle/checkpoint state.
On process restart, normal durability recovery owns any nonterminal admitted turn;
the cancelled child cannot be reconstructed from this in-memory operation object.

## Per-Scope Protocol

| Phase | Per-chat | Shared | Singleton |
|---|---|---|---|
| capture | session + registry generation + queue + scope ref | one session + manager + global queue + all captured cross-chat turns | one session + manager + pending/current context |
| freeze | owner `closing`, respawn timer cleared, queue admission fence | global queue admission fence | undispatched/current cancellation latch |
| active turn | published/unpublished classification by exact context identity | same classification for global active turn | pending/current classification around `sendTurnToSession` |
| pending turns | drain after context preflight; `admission_rejected` | drain all chats after context preflight | none outside ordinary chain |
| process stop | captured child `shutdown(false)` | captured child `shutdown(false)` | captured child `shutdown(false)` |
| success release | delete per-chat maps by object + final scope key after idle | reopen captured global queue with same fence epoch | clear exact session/global presentation after completion |
| failure | retain closed target graph; unrelated chats continue | retain global queue closed/degraded | retain exact global context/degraded owner |

## Release Invariants

Release is one idempotent compare-and-release operation. It may mutate a map only
when the map still contains the captured object. It may delete a per-chat key only
after resolving `scopeRef.value` at release time. It may reopen a queue only with
the fence epoch created by this cancellation and only when no active or pending
turn remains. It may settle a completion only through the normal finalizer's
post-effects. It may never change `replaySafe` from false to true.

A retained-degraded response must say that the process was stopped but durable
turn finalization remains retained and the lane is closed. It must not include the
clean `Session killed` acknowledgement. A duplicate control operation that
already captured the same owner may join the existing operation or request its
supervisor retry; it cannot target a different session through the old numeric
selection. A new command never reconstructs an inactive retained target from a
stale index.

## Planned Implementation Surface

- Add `src/runtimes/agent/runtime-session-cancellation.ts` for the focused
  coordinator, target/state types, proof barrier, and scope-specific release.
- Modify `src/runtimes/agent/runtime.ts` only for early command interception,
  target capture/host wiring, exact callback guards, and bounded operator replies.
- Modify `src/runtimes/agent/runtime-turn-coordinator.ts` for outcome-aware
  undispatched cancellation, immediate/recovered after-terminal symmetry, and
  proof callbacks; remove the unsafe `terminalizePerChatTurnQueueForKill` helper.
- Modify `src/runtimes/agent/turn-queue.ts` for admission-fence epochs, non-
  destructive preflight, guarded pending drain, and guarded reopen.
- Modify `src/runtimes/agent/turn-terminal.ts`,
  `src/core/inbound-failure-class.ts`, and
  `src/core/turn-finalization-contract.ts` for code-bounded
  `operator_cancelled` semantics.
- Add `tests/runtimes/agent/kill-session-transactional-cancellation.test.ts` and
  `tests/runtimes/agent/lib/kill-session-cancellation-harness.ts`; extend focused
  terminal/schema tests only where their canonical contract lives.

## Failure Semantics

| Failure | Target process | Target admission | Ownership/evidence | Operator result |
|---|---|---|---|---|
| exact terminal succeeds | stopped | per-chat recreated later; global guarded reopen | released after idle | clean killed |
| delivery uncertainty | stopped | closed until recovery transfer proof, then release | durable blocked-unsafe recovery owner | clean killed only after transfer proof |
| terminal sink/alert sink fails | targeted stop still attempted | closed | retained degraded; retry owner preserved | degraded, not clean killed |
| journaled turn lacks context | targeted stop still attempted | closed | graph retained for repair | degraded invariant failure |
| target loses identity fence | never mutate replacement | replacement unchanged | captured graph retained/logged | stale-target/degraded |
| target stop cannot be proved | no service restart fallback | closed | graph retained | degraded process-stop failure |

## Explicit Non-Goals

- Provider frame correlation, suppression, quarantine, tombstoning, or replay.
- Automatic reconstruction of provider content or background continuations.
- Whole-service shutdown, Q-fleet restart, or deployment orchestration.
- New tables, migrations, schema versions, or backfills.
- Raw installation or replacement of existing settings/state artifacts.
- A new operator UI or a new public session identifier format.
