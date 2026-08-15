# Outbound Queue Quiescence and Poison Containment Design

Date: 2026-08-14

**Status:** Active — approved and implemented on the review branch; integration remains pending.

## Problem

`OutboundQueue.flush()` and `enqueuePoll()` currently flush their synchronous buffers,
await one snapshot of the send promise chain, and then require the entire queue to be
empty. A legitimate enqueue can start another drain after the awaited snapshot settles
but before that empty assertion executes. The assertion then creates the synthetic error
`Outbound queue flush completed with pending send work` and stores it as a permanent
`drainFailure`.

The error is sticky even though no transport or durability operation failed. When it
happens during the inactive-session pre-dispatch flush, no runtime turn context has been
published yet. The turn is terminalized as `admission_rejected/pre_dispatch_error`, but
the owning outbound queue remains poisoned and later turns can enter the same path.

The current health model exposes turn-queue halt state, but it does not expose outbound
queue poison. A successful terminal write also lets the turn queue continue, so repeated
pre-dispatch failures do not activate the existing halt latch.

## Goals

1. Give outbound flushes a linearizable, race-safe quiescence contract.
2. Preserve sticky, fail-closed behavior for genuine transport or durability failures.
3. Prevent later turns from entering an outbound scope that cannot deliver.
4. Surface active poison as operational capability failure, separately from historical
   recovery debt.
5. Preserve healthy-chat processing in `per_chat` mode.
6. Close already-admitted pending turns with a durable typed disposition instead of
   leaving them stranded.
7. Cover `flush`, poll ordering, turn-evidence completion, and shutdown behavior with
   deterministic red/green tests.

## Non-goals

- Automatically replaying previously rejected prompts.
- Sending backlog responses or changing immutable terminal records.
- Reworking the historical recovery-debt contract.
- Changing fleet aggregation, watchdog restart policy, or deployment tooling.
- Automatically restarting a production instance.
- Treating all historical continuity debt as current operational degradation.

Those concerns require separate reviewable changes because their safety and ownership
contracts differ from queue correctness.

## Considered approaches

### A. Remove the post-await empty assertion

This prevents the false poison with the smallest diff. It does not guarantee that work
accepted while the flush is pending is drained before turn-evidence completion or
shutdown. It also leaves genuine poison invisible to admission and health.

Decision: rejected as incomplete.

### B. Loop across successive promise-chain snapshots only

This is the approach in the current head of PR #3233. It drains late text sends and
preserves genuine `drainFailure`. However, its quiescence predicate only checks the send
chain, `sending`, and `sendQueue`. A late tool or stream-buffer enqueue can remain behind
an armed timer, and the existing shutdown test demonstrates that buffered tool output can
be sent after shutdown returns. Its round-count bound can also take an unbounded amount of
wall-clock time because one round may contain a bounded but long send/retry sequence.

Decision: reuse its deterministic race fixture and sticky-failure tests, but strengthen
the production algorithm and add missing buffer, shutdown, runtime, and health coverage.

### C. Full quiescence boundary plus runtime poison containment

Drain every accepted buffer and send-chain generation until a synchronous stable point,
then complete the caller-specific action at that same boundary. Expose genuine poison to
the runtime, stop admission for the affected scope, close already-admitted pending work,
and project a content-free operational-health signal.

Decision: selected. This is the smallest boundary that closes the observed failure chain
without mixing historical debt or fleet policy into the queue repair.

## Queue contract

### Stable boundary

Add one private queue primitive that owns the complete flush lifecycle. On every round it:

1. synchronously flushes the stream and tool buffers, clearing their timers;
2. throws an existing genuine `drainFailure` unchanged;
3. captures the installed send-chain identity;
4. awaits that chain;
5. throws a genuine `drainFailure` created by the drain;
6. repeats if the chain identity advanced, a send is active, the send queue is non-empty,
   a stream/tool buffer is non-empty, or a related buffer timer remains armed;
7. otherwise executes the caller's completion callback synchronously before resolving.

The final callback is important. A turn-evidence snapshot, normal flush cleanup, or
shutdown closure must be committed at the same linearization point as the stable-state
check. Work accepted after that point belongs to a later queue epoch and cannot be
silently attributed to the completed turn.

No ordinary late enqueue creates `drainFailure`. Only an actual send/durability exception
or an explicit invariant failure may poison the queue.

### Continuous producers

The stable-boundary loop must not use a raw generation count as a claim of bounded elapsed
time. Send attempts already have transport deadlines and bounded retry policy. If a
separate quiescence budget is introduced, it must use the monotonic clock, report a typed
`flush_never_quiesced` invariant failure, and have tests proving whether it is sticky.
The initial implementation should avoid a new timeout unless a deterministic continuous-
producer test proves the existing send deadlines are insufficient.

### Caller semantics

- `flush()` drains to a stable boundary, then stops typing and clears per-flush
  presentation state.
- `enqueuePoll()` drains to a stable boundary before invoking the poll send function.
  The poll function runs once and is never retried by the queue.
- `flushTurnEvidence(turnId)` freezes and consumes the active evidence inside the stable
  boundary. Enqueues after that boundary cannot inherit the completed evidence epoch.
- `shutdown()` first marks the queue closing, cancels or absorbs delayed buffer timers,
  drains work accepted before closure, and marks the queue closed at the stable boundary.
  An enqueue after closing must not schedule a send. Void text/stream/tool enqueue methods
  discard the rejected post-closure item and emit one bounded warning per queue without
  including content; `enqueuePoll()` rejects with a typed `OutboundQueueClosedError`.
  This is deliberate ownership transfer: output from a retired session cannot be allowed
  to leak into its replacement queue epoch.

### Public poison observation

Add `isPoisoned(): boolean` to `IOutboundQueue` and `OutboundQueue`. It reports only sticky
`drainFailure`, not ordinary pending work, typing, or buffer timers. All structural test
mocks implementing `IOutboundQueue` must be updated or inherit a shared test helper.

No raw error, chat identifier, or message text is returned by health.

## Runtime containment

### Poison registry

The runtime records poisoned outbound ownership by canonical runtime scope key, not raw
delivery JID. The registry exposes only:

- whether a scope is blocked;
- the number of blocked scopes;
- whether any active admission lane is blocked.

The first error object may remain process-local for diagnostic logging, but health exposes
only bounded reason codes and counts.

### Observation points

Every runtime path that awaits an outbound flush must pass through a helper that:

1. rethrows the original error;
2. checks `queue.isPoisoned()`;
3. records the owning scope as poisoned before processor-error terminalization proceeds.

The inactive-session pre-dispatch flush is the critical integration point. The same helper
also covers post-dispatch turn evidence, poll flush, crash/shutdown flush, and other runtime
flush callers so callers do not reimplement the policy.

### Admission and already-owned turns

- In `per_chat` mode, only the affected scope is blocked. Other per-chat queues continue.
- In `shared` mode, a poison that cannot be proven chat-isolated blocks the shared lane.
- In `single` mode, poison blocks the sole lane.
- A new journaled turn rejected because of the registry uses the existing
  `scope_blocked_recovery` admission class.
- A per-chat queue that already contains admitted pending turns is closed and drained of
  pending ownership. Each removed turn is terminalized through the existing rejected-turn
  finalizer with `scope_blocked_recovery`; it is not left in memory and is not replayed.
- The active failed turn retains its actual `pre_dispatch_error` or processor failure
  classification. Containment must not rewrite it as a later queue-capacity event.

The poison registry owns the exact outbound failure cause; the existing
`TurnQueueHaltLatch` owns the admission consequence for per-chat turn queues. This
separation is intentional: one says delivery is poisoned, the other says turn admission
has stopped. The design must not add another unavailable-scope map inside every per-chat
`TurnQueue`; that would duplicate admission ownership and still would not cover runtime
health or pre-existing pending turns.

### Clearing poison

No generic public `clearScope()` operation is added in this repair. Process restart clears
process-local poison by constructing a new queue. Any future in-process recovery must prove
all of the following before it clears the registry:

- the old queue is retired and cannot send;
- ambiguous/maybe-sent durability evidence is reconciled;
- a new queue owns the canonical scope;
- the new queue starts with no pending work and no poison;
- pending turn ownership has an explicit disposition.

This keeps recovery fail-closed instead of making a convenient administrative clear look
like delivery proof.

## Health contract

Extend agent runtime details with:

- `outboundQueuePoisoned: boolean`;
- `outboundQueuePoisonedScopes: number`.

Add `outbound_queue_poisoned` to `degradedReasons` when the count is positive. Core health
then emits the existing normalized status reason `runtime.outbound_queue_poisoned`.

Status aggregation:

- `per_chat`: degraded/HTTP 200 when one or more scopes are poisoned but other scopes may
  remain usable;
- `shared` or `single`: unhealthy/HTTP 503 when the active lane is poisoned;
- historical recovery debt remains independently represented and cannot clear or create
  this operational signal.

The payload exposes counts only. It must not expose scope keys, JIDs, prompts, error text,
or provider output.

## Durable terminal and recovery behavior

This repair does not invent automatic replay. A pre-dispatch failure has no answer
delivery operation, so its durable terminal record remains a failed immutable audit row.
The active failure and any already-owned pending turns must receive typed failure classes
and the existing admission-rejection alert with `automatic_replay=false`.

The separate backlog effort will classify terminal/no-delivery/still-armed rows into
owner-authorized replay, operator catch-up, intentional no-reply, expiry, or proven
duplicate. Nothing in this PR may blindly resend them or relabel them delivered.

## Test design

### Queue unit tests

1. A late text enqueue starts a new drain while `flush()` awaits the old chain; both sends
   occur exactly once, in order, and both the first and second flush resolve.
2. The same race through `enqueuePoll()` drains text before one poll invocation.
3. The same race through `flushTurnEvidence()` returns complete, immutable evidence for
   the owning epoch without reassigning later-epoch work.
4. Late tool and stream-buffer enqueues are absorbed before a normal flush boundary.
5. Shutdown cancels/absorbs late buffer timers and produces no send after it resolves.
6. A genuine durability or pacing exception remains sticky; repeated flushes throw the
   same error and `isPoisoned()` remains true.
7. No test asserts private implementation alone when the behavior can be observed through
   messenger calls, evidence, rejection, and health.

### Runtime integration tests

1. Inject a genuinely poisoned queue at the inactive-session pre-dispatch flush.
2. Assert the active turn terminalizes once with `pre_dispatch_error` and no delivery.
3. Assert the scope registry and turn-queue halt state activate before the next admission.
4. Submit a second turn to the same scope and assert typed
   `scope_blocked_recovery` rejection without invoking provider dispatch or queue flush.
5. Submit a turn to a different per-chat scope and assert it remains processable.
6. Seed an already-admitted pending turn and assert containment terminalizes it rather than
   leaving it stranded.
7. Assert one poison event does not duplicate terminal records or outbound submissions.

### Health tests

1. A poisoned per-chat scope produces degraded status, the exact normalized reason, and a
   count of one.
2. Two poisoned scopes produce count two without exposing identifiers.
3. Shared/single poison produces unhealthy status.
4. Historical recovery debt without active poison does not produce the poison reason.
5. Clearing historical debt does not clear active poison.

### Compatibility and regression tests

- Structural `IOutboundQueue` mocks compile with `isPoisoned()`.
- Existing genuine-failure, retry, evidence, shutdown, queue-halt, health, and failure-
  taxonomy suites remain green.
- The public-surface and durability documentation is updated in the same change.
- Test Integrity scans every new or changed test file.

## Existing candidate work and reuse decision

PR #3233 contains a deterministic reproduction, useful helper fixtures, and the correct
principle that genuine drain failure remains sticky. Those tests and the small
`isPoisoned()` predicate should be reused after review.

The follow-on local primitive commit adds an unavailable-scope map to `TurnQueue` but has
no runtime wiring. It should not be applied unchanged because:

- per-chat queues already have one canonical scope, making the nested map duplicate state;
- it does not close already-admitted pending turns;
- it does not project health;
- its clear operation lacks recovery proof;
- it keys on delivery JID rather than canonical runtime ownership;
- the queue-only quiescence loop omits late stream/tool buffers and shutdown closure.

The implementation plan will use `git range-diff` to compare the final branch with these
candidate commits and will preserve any proven tests or code rather than recreating them.

## Documentation and release impact

Update:

- `docs/durability.md` for the stable-boundary, poison, terminal, and no-auto-replay
  contracts;
- `docs/public-surface.md` for new aggregate runtime health fields and status behavior;
- `docs/runbook.md` for diagnosis and restart limitations;
- generated or declared health fixtures that enumerate runtime fields.

No database migration or configuration migration is required. Deployment remains a
separate, attested operation after merge. A deploy candidate must include the protected
release lineage and pass the normal migration, Keychain, manifest, and rollback gates.

## Acceptance criteria

The change is acceptable only when all of the following are proven on the exact PR head:

- the production race fixture is red on its baseline and green with the repair;
- flush, poll, evidence, buffer, and shutdown cases pass without synthetic poison;
- real drain failure stays sticky and fail-closed;
- same-scope repeat admission is blocked before provider dispatch;
- a healthy per-chat scope continues processing;
- already-admitted pending ownership is durably terminalized;
- poison state appears in health with no identifiers or raw errors;
- historical debt and current poison remain independent;
- targeted tests, full affected suites, typecheck, repository guards, Test Integrity, and
  `verify:release` pass without masked failures;
- current-main range comparison shows no dropped upstream behavior;
- no deployment, restart, or backlog send occurs as part of the PR.

## Assumptions and falsifiers

| Assumption | Evidence | Falsifier |
|---|---|---|
| The false poison is caused by a stale chain snapshot. | Deterministic late-enqueue fixture reproduces the exact signature on the baseline. | The fixture still fails after replacing the snapshot boundary, or traces show `drainFailure` originated from a real send exception. |
| A real poison is scope-local in `per_chat` mode. | Each per-chat runtime owns separate session, turn queue, and outbound queue maps. | An integration test shows shared mutable outbound ownership across two canonical per-chat scope keys. |
| Existing turn-queue halt and rejection machinery can own containment. | Current runtime already exposes halt counts and typed admission classes. | Pending turns cannot be removed/finalized without a second ownership mechanism, or halt state cannot be projected without identifier leakage. |
| Restart reconstructs process-local queue poison. | `drainFailure` is held only on the queue object. | Startup restores poison from durable state or reuses the old queue object. Restart delivery safety remains separately unproven. |
| Automatic backlog replay is unsafe in this PR. | Admission rejection records contain no answer op and may represent already-applied external effects. | A separate replay contract proves effect dedupe, ordering, owner reassignment, and echoed completion for every eligible row. |

## Rollback

Before deployment, rollback is ordinary commit reversion. After deployment, rollback must
use the attested prior release and its documented schema-compatible path. Because this
design adds no migration, rollback does not require database transformation. Runtime
operators must still inspect maybe-sent and terminal obligations before restarting or
resending; rollback is not delivery proof.
