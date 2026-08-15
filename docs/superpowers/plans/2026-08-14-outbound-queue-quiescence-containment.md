# Outbound Queue Quiescence and Poison Containment Implementation Plan

**Status:** Active — core and adjacent integration are complete; final staged verification and independent review remain pending.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Every production task also requires superpowers:test-driven-development, superpowers:test-integrity, and superpowers:verification-before-completion.

**Goal:** Make outbound queue completion linearizable, preserve sticky failure for genuine delivery faults, stop poisoned runtime scopes from admitting more turns, and expose active poison as a bounded current-health signal without replaying historical work.

**Architecture:** Replace one-snapshot queue drains with one private stable-boundary primitive whose synchronous completion callback owns flush, poll, evidence, and shutdown linearization. Keep the real failure on the queue, record its canonical runtime scope in a coordinator-owned poison registry, close and terminalize already-admitted pending turns through the existing rejection finalizer, and project only counts and bounded reason codes through runtime/core health.

**Tech Stack:** TypeScript, Vitest, Pino logging, existing runtime turn finalization and health-taxonomy contracts, repository publication and release guards.

## Global Constraints

- Begin execution from a clean isolated worktree and rebase the plan/spec commits onto the then-current `origin/main`; never overwrite another worktree or use destructive Git cleanup.
- Preserve the original transport/durability error object. A legitimate late enqueue must never synthesize poison.
- Use one stable-boundary owner in `OutboundQueue`; do not copy drain loops into `flush()`, `enqueuePoll()`, evidence, or shutdown.
- Use canonical runtime scope keys. Never expose scope keys, JIDs, prompts, message content, provider output, or raw errors in public health.
- `per_chat` poison blocks only that scope. `shared` and `single` poison block their only admission lane.
- The active failed turn keeps its actual `pre_dispatch_error` or processor failure classification. Only later/newly removed pending turns use `scope_blocked_recovery`.
- Do not add an unavailable-scope map to `TurnQueue`, a generic poison-clear operation, automatic replay, backlog sends, restart, deployment, migration, or watchdog-policy change.
- A caught, skipped, timed-out, filtered, masked, or environment-failed test is inconclusive, not passing evidence.
- Use the SSH remote `git@github.com:LucasQuiles/WhatSoup.git`; public commits and PR text must contain no private host labels, local absolute user paths, model/vendor attribution, personal work email, or co-author trailers.

---

### Task 0: Reconfirm lineage, candidate reuse, and the red baseline

**Files:**
- Read: `docs/superpowers/specs/2026-08-14-outbound-queue-quiescence-containment-design.md`
- Read: `src/runtimes/agent/outbound-queue.ts`
- Read: `src/runtimes/agent/runtime-turn-coordinator.ts`
- Read: `src/runtimes/agent/runtime.ts`
- Read from candidate commit: `89202825e`
- Read from candidate commit: `655c22d38`

**Interfaces:**
- Baseline: exact current `origin/main`
- Reuse source: deterministic late-enqueue and genuine-failure fixtures from `89202825e`
- Rejected source shape: nested `TurnQueue` unavailable-scope state and unproven clear operation from `655c22d38`

- [ ] **Step 1: Verify the worktree and remote before mutation**

Run:

```bash
git status --short --branch
git remote get-url origin
git fetch origin --prune
git rev-parse HEAD origin/main
git rev-list --left-right --count HEAD...origin/main
```

Expected: the worktree is clean, `origin` is the SSH remote, and any upstream advance is visible rather than silently ignored.

- [ ] **Step 2: Rebase the documentation commits if main advanced**

If `origin/main` is ahead, run `git rebase origin/main`, resolve only overlaps in the approved spec/plan, then rerun Step 1. If the worktree is not clean, stop and preserve the exact status; do not stash work that is not owned by this branch.

- [ ] **Step 3: Capture candidate lineage without applying it**

Run:

```bash
git show --stat --oneline 89202825e
git show --stat --oneline 655c22d38
git cherry -v origin/main 89202825e
git cherry -v origin/main 655c22d38
```

Expected: F-01 is one queue/test commit; F-02 is its child. Do not cherry-pick either commit because their production boundaries are incomplete.

- [ ] **Step 4: Re-run the unchanged owning baseline suites**

Run:

```bash
bash scripts/run-with-pinned-npm.sh test -- \
  tests/runtimes/agent/outbound-queue.test.ts \
  tests/runtimes/agent/outbound-queue-turn-evidence.test.ts \
  tests/runtimes/agent/runtime-terminal-coordinator-integration.test.ts \
  tests/runtimes/agent/health-snapshot.test.ts \
  tests/core/health.test.ts \
  tests/core/failure-taxonomy-cross-contract.test.ts \
  --pool=forks --fileParallelism=false --retry=0
```

Expected: unchanged baseline suites pass. A native-addon/toolchain failure is recorded as inconclusive and repaired as an environment issue before production edits.

### Task 1: Implement one stable outbound completion boundary and closed-queue behavior

**Files:**
- Create: `tests/runtimes/agent/outbound-queue-flush-linearization.test.ts`
- Modify: `tests/runtimes/agent/outbound-queue.test.ts`
- Modify: `tests/runtimes/agent/outbound-queue-turn-evidence.test.ts`
- Modify: `tests/runtimes/agent/control-queue.test.ts`
- Modify: `src/runtimes/agent/outbound-queue.ts`
- Modify: `src/runtimes/agent/control-queue.ts`
- Modify compile-enforced queue mocks: `tests/runtimes/agent/lib/runtime-mock-scaffold.ts`, `tests/runtimes/agent/lib/runtime-terminal-coordinator-harness.ts`, `tests/runtimes/agent/runtime.test.ts`, `tests/runtimes/agent/model-pin.test.ts`, `tests/runtimes/agent/control-timeout.test.ts`, `tests/mcp/tools/heal.test.ts`, `tests/runtimes/agent/zombie-sessions.test.ts`, `tests/runtimes/agent/idle-session-eviction.test.ts`, `tests/runtimes/agent/runtime-reset-teardown.test.ts`

**Interfaces:**
- Add: `IOutboundQueue.isPoisoned(): boolean`
- Add: `OutboundQueueClosedError` with stable code `OUTBOUND_QUEUE_CLOSED`
- Add private: `OutboundQueue.atStableBoundary<T>(complete: () => T): Promise<T>`
- Preserve: `flush(): Promise<void>`, `enqueuePoll(sendFn): Promise<void>`, `flushTurnEvidence(turnId)`, `shutdown(): Promise<void>`

- [ ] **Step 1: Port and strengthen the deterministic race tests**

Use `git show 89202825e:tests/runtimes/agent/outbound-queue-flush-linearization.test.ts` as the reviewed source for the deferred-chain fixture, but add it with `apply_patch`. Keep observable assertions and add buffer/shutdown coverage. The central fixture must retain this ordering:

```ts
queue.enqueueText('CHUNK-ONE');
const firstChain = (queue as unknown as { chain: Promise<void> }).chain;
const lateEnqueue = firstChain.then(() => queue.enqueueText('CHUNK-TWO'));
const completion = queue.flush();

firstSend.resolve({ waMessageId: null });
await lateEnqueue;
await vi.advanceTimersByTimeAsync(MIN_SEND_GAP_MS);

await expect(completion).resolves.toBeUndefined();
expect(sent).toEqual(['CHUNK-ONE', 'CHUNK-TWO']);
expect(queue.isPoisoned()).toBe(false);
```

Add equivalent behavior tests for:

```ts
await queue.enqueuePoll(sendPoll);               // text before one poll invocation
await queue.flushTurnEvidence('turn-linear');    // immutable evidence at the boundary
queue.enqueueStreamingText('late stream');       // accepted before completion and drained
queue.enqueueToolUpdate({ category: 'running', detail: 'late status' });
```

Replace the existing shutdown test that currently permits the max-age timer to send after shutdown. The new assertion is:

```ts
const shutdown = queue.shutdown();
queue.enqueueToolUpdate({ category: 'running', detail: 'rejected after close began' });
await shutdown;
await vi.advanceTimersByTimeAsync(TOOL_BATCH_MAX_AGE_MS);
expect(messenger.sendMessage).toHaveBeenCalledTimes(1);
expect(queue.hasPendingWork?.()).toBe(false);
```

Also assert post-closure text/stream/tool/progress producers send nothing, `indicateTyping()` does not restart presence, only one content-free rejection warning is emitted, and `enqueuePoll()` rejects as follows:

```ts
await expect(queue.enqueuePoll(sendPoll)).rejects.toMatchObject({
  name: 'OutboundQueueClosedError',
  code: 'OUTBOUND_QUEUE_CLOSED',
});
expect(sendPoll).not.toHaveBeenCalled();
```

- [ ] **Step 2: Run the new tests and prove RED for the intended reasons**

Run:

```bash
bash scripts/run-with-pinned-npm.sh test -- \
  tests/runtimes/agent/outbound-queue-flush-linearization.test.ts \
  tests/runtimes/agent/outbound-queue.test.ts \
  tests/runtimes/agent/outbound-queue-turn-evidence.test.ts \
  --pool=forks --fileParallelism=false --retry=0
```

Expected: current main fails the late-chain cases with the synthetic pending-work poison, fails late buffer/shutdown containment, and has no typed closed-queue behavior. Save the exact failing assertion names in the implementation receipt.

- [ ] **Step 3: Add the public poison and closure contracts**

Implement the public surface in `outbound-queue.ts`:

```ts
export class OutboundQueueClosedError extends Error {
  readonly code = 'OUTBOUND_QUEUE_CLOSED';

  constructor() {
    super('Outbound queue is closed');
    this.name = 'OutboundQueueClosedError';
  }
}

export interface IOutboundQueue {
  // existing methods...
  isPoisoned(): boolean;
}
```

Track `open | closing | closed`, one shutdown promise, and one warning latch. Guard every public content/presence producer before it mutates buffers or timers. The warning must be structurally bounded and content-free:

```ts
private rejectPostClosureEnqueue(): boolean {
  if (this.lifecycle === 'open') return false;
  if (!this.postClosureWarningEmitted) {
    this.postClosureWarningEmitted = true;
    log.warn({ queueState: this.lifecycle }, 'outbound enqueue rejected after queue closure');
  }
  return true;
}
```

`ControlQueue.isPoisoned()` returns `false`. Every compile-enforced mock returns `false` by default; poison-specific tests override it explicitly.

- [ ] **Step 4: Replace snapshot assertions with the single stable-boundary primitive**

Implement the private primitive once:

```ts
private async atStableBoundary<T>(complete: () => T): Promise<T> {
  for (;;) {
    this.flushStreamBuffer();
    this.flushToolBuffer();
    this.throwDrainFailure();
    const observedChain = this.chain;
    await observedChain;
    this.throwDrainFailure();

    if (
      observedChain !== this.chain
      || this.sending
      || this.sendQueue.length > 0
      || this.streamBufferParts.length > 0
      || this.toolBuffer.length > 0
      || this.streamTimer !== null
      || this.toolTimer !== null
      || this.toolMaxAgeTimer !== null
    ) continue;

    return complete();
  }
}
```

Do not retain `assertDrainComplete()` as a normal late-enqueue poison source. Keep `throwDrainFailure()` and the real error object stored by `drainQueue()`.

Wire callers so their ownership action is invoked synchronously at the stable point:

```ts
async flush(): Promise<void> {
  this.lastActivity = Date.now();
  await this.atStableBoundary(() => this.completeFlushPresentation());
}

async enqueuePoll(sendFn: () => Promise<void>): Promise<void> {
  if (this.lifecycle !== 'open') throw new OutboundQueueClosedError();
  await this.atStableBoundary(() => sendFn());
}

private async completeTurnEvidence(active: MutableTurnDeliveryEvidence) {
  return this.atStableBoundary(() => this.freezeActiveTurnEvidence(active));
}

shutdown(): Promise<void> {
  if (this.shutdownPromise) return this.shutdownPromise;
  this.lifecycle = 'closing';
  this.shutdownPromise = this.atStableBoundary(() => {
    this.lifecycle = 'closed';
    this.clearShutdownPresentationAndEvidence();
  });
  return this.shutdownPromise;
}

isPoisoned(): boolean {
  return this.drainFailure !== undefined;
}
```

`freezeActiveTurnEvidence` must validate the active evidence identity and freeze/copy op-id arrays inside the callback. Enqueues after the callback may not append to the consumed epoch.

- [ ] **Step 5: Run focused queue suites and type compensation**

Run:

```bash
bash scripts/run-with-pinned-npm.sh test -- \
  tests/runtimes/agent/outbound-queue-flush-linearization.test.ts \
  tests/runtimes/agent/outbound-queue.test.ts \
  tests/runtimes/agent/outbound-queue-turn-evidence.test.ts \
  tests/runtimes/agent/outbound-queue-idempotency.test.ts \
  tests/runtimes/agent/control-queue.test.ts \
  --pool=forks --fileParallelism=false --retry=0
bash scripts/run-with-pinned-npm.sh run typecheck:all
```

Expected: all selected tests pass; real send/durability failure is the same sticky object on repeated flush; the typecheck reports no missing `isPoisoned()` implementation.

- [ ] **Step 6: Commit the queue boundary**

```bash
git add src/runtimes/agent/outbound-queue.ts src/runtimes/agent/control-queue.ts \
  tests/runtimes/agent/outbound-queue-flush-linearization.test.ts \
  tests/runtimes/agent/outbound-queue.test.ts \
  tests/runtimes/agent/outbound-queue-turn-evidence.test.ts \
  tests/runtimes/agent/control-queue.test.ts \
  tests/runtimes/agent/lib/runtime-mock-scaffold.ts \
  tests/runtimes/agent/lib/runtime-terminal-coordinator-harness.ts \
  tests/runtimes/agent/runtime.test.ts tests/runtimes/agent/model-pin.test.ts \
  tests/runtimes/agent/control-timeout.test.ts tests/mcp/tools/heal.test.ts \
  tests/runtimes/agent/zombie-sessions.test.ts \
  tests/runtimes/agent/idle-session-eviction.test.ts \
  tests/runtimes/agent/runtime-reset-teardown.test.ts
git commit -m "fix(outbound): linearize queue completion boundaries"
```

### Task 2: Add canonical poison ownership and durable admission containment

**Files:**
- Create: `src/runtimes/agent/outbound-queue-poison-registry.ts`
- Create: `tests/runtimes/agent/outbound-queue-poison-registry.test.ts`
- Modify: `src/runtimes/agent/turn-queue.ts`
- Modify: `src/runtimes/agent/runtime-turn-coordinator.ts`
- Modify: `tests/runtimes/agent/runtime-terminal-coordinator-integration.test.ts`
- Modify: `tests/runtimes/agent/lib/runtime-terminal-coordinator-harness.ts`

**Interfaces:**
- Add: `OutboundQueuePoisonRegistry.record/has/rekey/snapshot`
- Extend: `TurnRejectReason` with `scope_blocked_recovery`
- Add coordinator methods: `observeOutboundQueueOperation`, `outboundQueuePoisonHealth`, `rekeyPerChatOutboundQueuePoisonScope`, and guarded global/per-chat admission

- [ ] **Step 1: Write registry and containment tests first**

Registry unit tests must prove first-error retention, idempotent counting, alias rekey, collision merge, no clear method, and aggregate-only snapshots. Coordinator integration tests must use real `TurnQueue` ownership and prove:

```ts
await expect(coordinator.observeOutboundQueueOperation(
  poisonedScope,
  poisonedQueue,
  async () => { throw poisonError; },
)).rejects.toBe(poisonError);

expect(coordinator.enqueuePerChatRuntimeTurn(poisonedScope, nextTurn)).toBe(false);
expect(coordinator.enqueuePerChatRuntimeTurn(healthyScope, healthyTurn)).toBe(true);
await coordinator.awaitRejectedRuntimeTurnFinalizations();
```

Seed two turns before releasing the active turn. After poison observation, assert the active turn retains `pre_dispatch_error`, the already-admitted pending turn and the next turn each finalize once as `scope_blocked_recovery`, the provider is not called for either rejected turn, and the poisoned queue is not flushed again.

- [ ] **Step 2: Run the new cases and prove RED**

Run:

```bash
bash scripts/run-with-pinned-npm.sh test -- \
  tests/runtimes/agent/outbound-queue-poison-registry.test.ts \
  tests/runtimes/agent/runtime-terminal-coordinator-integration.test.ts \
  -t "outbound queue poison" \
  --pool=forks --fileParallelism=false --retry=0
```

Expected: the registry module/methods are absent and existing admission continues or uses the wrong rejection class.

- [ ] **Step 3: Implement the registry as the sole poison owner**

Use the same alias semantics as `TurnQueueHaltLatch`, but retain exact causes only process-locally:

```ts
export interface OutboundQueuePoisonHealth {
  outboundQueuePoisoned: boolean;
  outboundQueuePoisonedScopes: number;
  activeAdmissionLaneBlocked: boolean;
}

export class OutboundQueuePoisonRegistry {
  private readonly causes = new Map<string, unknown>();
  private readonly aliases = new Map<string, string>();

  record(scopeKey: string, error: unknown): boolean {
    const canonical = this.resolve(scopeKey);
    if (this.causes.has(canonical)) return false;
    this.causes.set(canonical, error);
    return true;
  }

  has(scopeKey: string): boolean {
    return this.causes.has(this.resolve(scopeKey));
  }

  snapshot(): OutboundQueuePoisonHealth {
    const count = this.causes.size;
    return {
      outboundQueuePoisoned: count > 0,
      outboundQueuePoisonedScopes: count,
      activeAdmissionLaneBlocked: count > 0,
    };
  }

  rekey(fromScopeKey: string, toScopeKey: string): void {
    // resolve both keys, retain the destination's first cause on collision,
    // migrate the source cause otherwise, and update alias traversal.
  }

  private resolve(scopeKey: string): string {
    // cycle-safe alias traversal matching TurnQueueHaltLatch.
  }
}
```

Do not add `clear`, `delete`, error serialization, or a second unavailable-scope map.

- [ ] **Step 4: Contain poison before processor-error finalization**

Add `sessionScope` to `RuntimeTurnCoordinatorPort`. Implement the observation boundary so containment failure is logged but never replaces the original delivery error:

```ts
async observeOutboundQueueOperation<T>(
  scopeKey: string,
  queue: IOutboundQueue,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (queue.isPoisoned()) {
      try {
        this.containOutboundQueuePoison(scopeKey, error);
      } catch (containmentError) {
        log.error({ err: containmentError }, 'outbound queue poison containment failed');
      }
    }
    throw error;
  }
}
```

`containOutboundQueuePoison` must record before any async work, halt the per-chat admission latch, synchronously `closeAndTakePendingTurns()` from the affected per-chat queue or shared global queue, and invoke the existing rejected-turn finalizer for each removed turn:

```ts
if (!this.outboundQueuePoisons.record(scopeKey, error)) return;
if (this.host.sessionScope === 'per_chat') this.turnQueueHalts.halt(scopeKey);
const turnQueue = this.host.sessionScope === 'per_chat'
  ? this.host.perChatTurnQueues.get(scopeKey)
  : this.host.sessionScope === 'shared'
    ? this.host.turnQueue
    : null;
for (const pending of turnQueue?.closeAndTakePendingTurns() ?? []) {
  this.finalizeRejectedRuntimeTurn(pending, 'scope_blocked_recovery');
}
```

Check poison before the halt latch in per-chat admission so the durable class is `scope_blocked_recovery`, not `queue_halted`. Add the same guarded admission method for shared turns. Keep the active turn out of `closeAndTakePendingTurns()` so its processor error remains authoritative.

- [ ] **Step 5: Run containment regressions**

Run:

```bash
bash scripts/run-with-pinned-npm.sh test -- \
  tests/runtimes/agent/outbound-queue-poison-registry.test.ts \
  tests/runtimes/agent/turn-queue.test.ts \
  tests/runtimes/agent/runtime-terminal-coordinator-integration.test.ts \
  tests/runtimes/agent/admission-reject-failure-class.test.ts \
  tests/runtimes/agent/terminal-transaction-matrix.test.ts \
  --pool=forks --fileParallelism=false --retry=0
bash scripts/run-with-pinned-npm.sh run typecheck:all
```

Expected: exact one-time terminal ownership, same-scope blocking, healthy-scope progress, and no type drift.

- [ ] **Step 6: Commit containment**

```bash
git add src/runtimes/agent/outbound-queue-poison-registry.ts \
  src/runtimes/agent/turn-queue.ts \
  src/runtimes/agent/runtime-turn-coordinator.ts \
  tests/runtimes/agent/outbound-queue-poison-registry.test.ts \
  tests/runtimes/agent/runtime-terminal-coordinator-integration.test.ts \
  tests/runtimes/agent/lib/runtime-terminal-coordinator-harness.ts
git commit -m "fix(agent): contain poisoned outbound scopes"
```

### Task 3: Wire every runtime completion caller through poison observation

**Files:**
- Modify: `src/runtimes/agent/runtime-turn-finalization.ts`
- Modify: `src/runtimes/agent/runtime-turn-coordinator.ts`
- Modify: `src/runtimes/agent/runtime-poll-bridge.ts`
- Modify: `src/runtimes/agent/runtime.ts`
- Modify: `tests/runtimes/agent/runtime-secondhalf-branches.test.ts`
- Modify: `tests/runtimes/agent/runtime-terminal-coordinator-integration.test.ts`
- Modify: `tests/runtimes/agent/runtime-shutdown-outbound-persistence.test.ts`
- Modify relevant poll cases in: `tests/runtimes/agent/runtime.test.ts`

**Interfaces:**
- Extend: `collectRuntimeTurnAnswerEvidence(queue, turnId, onFlushError?)`
- Extend: `RuntimePollBridgePort.observeOutboundQueueOperation(...)`
- Preserve original runtime operation results and thrown errors

- [ ] **Step 1: Write inactive-session, evidence, poll, crash, and shutdown observation tests**

The critical inactive-session test must configure a real or faithful queue whose `flush()` throws a real sticky error and whose `isPoisoned()` is true. It must prove this order:

```text
inactive-session flush fails
→ registry records canonical scope
→ pending ownership closes
→ active turn terminalizes once as pre_dispatch_error
→ next same-scope turn terminalizes as scope_blocked_recovery
→ no spawnSession/sendTurn/second flush
```

Add a different-scope per-chat turn and prove it reaches provider dispatch. Add tests that a `flushTurnEvidence()` error still reaches the observation callback even though answer-evidence collection returns `{ kind: 'failed' }`. Add a poll-details failure case that does not send the poll after a poisoned details flush.

- [ ] **Step 2: Run the selected integration cases and prove RED**

Run:

```bash
bash scripts/run-with-pinned-npm.sh test -- \
  tests/runtimes/agent/runtime-secondhalf-branches.test.ts \
  tests/runtimes/agent/runtime-terminal-coordinator-integration.test.ts \
  tests/runtimes/agent/runtime-shutdown-outbound-persistence.test.ts \
  tests/runtimes/agent/runtime.test.ts \
  -t "outbound queue poison|poll details" \
  --pool=forks --fileParallelism=false --retry=0
```

Expected: current callers either bypass observation, swallow evidence failure, continue a poll, or admit the next turn.

- [ ] **Step 3: Expose swallowed evidence failure to the coordinator**

Change the collector without changing its durable failed-evidence result:

```ts
export async function collectRuntimeTurnAnswerEvidence(
  queue: RuntimeTurnEvidenceQueue,
  turnId: string,
  onFlushError?: (error: unknown) => void,
): Promise<RuntimeAnswerEvidence> {
  try {
    const evidence = await queue.flushTurnEvidence(turnId);
    return { kind: 'ready', opIds: evidence.answerOpIds };
  } catch (error) {
    onFlushError?.(error);
    return { kind: 'failed' };
  }
}
```

In both initial and retained-retry evidence collection, pass a callback through the same private observed-failure function used by `observeOutboundQueueOperation`. That function must check `queue.isPoisoned()` before recording, using the context's current `scopeRef.value` or the global scope. Do not turn failed evidence into a thrown finalization error.

- [ ] **Step 4: Add one runtime delegate and replace every direct completion call**

Add one runtime delegate:

```ts
private observeOutboundQueueOperation<T>(
  scopeKey: string,
  queue: IOutboundQueue,
  operation: () => Promise<T>,
): Promise<T> {
  return this.runtimeTurnCoordinator.observeOutboundQueueOperation(scopeKey, queue, operation);
}
```

Use the canonical per-chat map key only in `per_chat`; use `GLOBAL_TOOL_SCOPE_KEY` for `shared` and `single`. Replace all direct runtime completion sites identified by:

```bash
rg -n "queue\.(flush|flushTurnEvidence|enqueuePoll|shutdown)\(" src/runtimes/agent --glob '*.ts'
```

The compensated list must include:

- inactive-session pre-dispatch flush in `sendTurnToSession`;
- pending-poll clarification flush in `runtime.ts`;
- poll detail flush and outer `enqueuePoll` in `runtime-poll-bridge.ts`;
- unowned result flush in `runtime-turn-coordinator.ts`;
- finalization evidence and retained evidence refresh;
- crash-notice flush;
- idle-queue shutdown;
- per-chat, shared, and singleton runtime shutdown.

The poll bridge catch must rethrow after logging so it cannot send a poll after poisoned detail ordering failed:

```ts
try {
  await this.host.observeOutboundQueueOperation(mapKey, queue, () => queue.flush());
  detailFlushedQuestionIndexes.add(index);
} catch (error) {
  log.warn({ err: error }, 'failed to flush poll details before poll send');
  throw error;
}
```

Guard shared admission through the coordinator instead of direct `turnQueue.enqueue`. In singleton dispatch, construct the immutable runtime context first, then reject it through `finalizeRejectedRuntimeTurn(..., 'scope_blocked_recovery')` before evidence activation, spawn, or provider send if the global scope is poisoned.

- [ ] **Step 5: Re-run all runtime completion owners**

Run:

```bash
bash scripts/run-with-pinned-npm.sh test -- \
  tests/runtimes/agent/runtime-secondhalf-branches.test.ts \
  tests/runtimes/agent/runtime-terminal-coordinator-integration.test.ts \
  tests/runtimes/agent/runtime-turn-result-handler.test.ts \
  tests/runtimes/agent/runtime-turn-result-handler-escape-alert.test.ts \
  tests/runtimes/agent/runtime-turn-recovery-health.test.ts \
  tests/runtimes/agent/runtime-shutdown-outbound-persistence.test.ts \
  tests/runtimes/agent/runtime-reset-teardown.test.ts \
  tests/runtimes/agent/runtime.test.ts \
  --pool=forks --fileParallelism=false --retry=0
bash scripts/run-with-pinned-npm.sh run typecheck:all
```

Expected: all completion sites preserve their prior success behavior; poison is observed before failure terminalization; poll and shutdown do not create post-boundary sends.

- [ ] **Step 6: Prove there are no naive direct callers left**

Run the `rg` inventory again. Every remaining direct call must be either inside `OutboundQueue`/`ControlQueue`, inside the central observation callback expression, or explicitly documented by file and reason. An unexplained direct runtime call blocks this task.

- [ ] **Step 7: Commit runtime wiring**

```bash
git add src/runtimes/agent/runtime-turn-finalization.ts \
  src/runtimes/agent/runtime-turn-coordinator.ts \
  src/runtimes/agent/runtime-poll-bridge.ts src/runtimes/agent/runtime.ts \
  tests/runtimes/agent/runtime-secondhalf-branches.test.ts \
  tests/runtimes/agent/runtime-terminal-coordinator-integration.test.ts \
  tests/runtimes/agent/runtime-shutdown-outbound-persistence.test.ts \
  tests/runtimes/agent/runtime.test.ts
git commit -m "fix(agent): observe outbound poison at runtime boundaries"
```

### Task 4: Project current poison separately through runtime and core health

**Files:**
- Modify: `src/runtimes/agent/runtime.ts`
- Modify: `src/core/health.ts`
- Modify: `src/lib/fault-taxonomy-registry.json`
- Modify: `tests/runtimes/agent/health-snapshot.test.ts`
- Modify: `tests/core/health.test.ts`
- Modify: `tests/core/failure-taxonomy-cross-contract.test.ts` only if an explicit fixture requires adjustment; the registry lockstep assertion itself must remain intact

**Interfaces:**
- Runtime details: `outboundQueuePoisoned: boolean`, `outboundQueuePoisonedScopes: number`
- Runtime degraded reason: `outbound_queue_poisoned`
- Core normalized status reason: `runtime.outbound_queue_poisoned`
- Core bounded degradation cause: `agent_outbound_queue_poisoned`

- [ ] **Step 1: Write health tests before projection code**

Add runtime snapshot tests for one and two poisoned per-chat scopes, a poisoned shared lane, and a poisoned singleton lane. Assert:

```ts
expect(snapshot).toMatchObject({
  status: 'degraded',
  details: {
    outboundQueuePoisoned: true,
    outboundQueuePoisonedScopes: 1,
    degradedReasons: expect.arrayContaining(['outbound_queue_poisoned']),
  },
});
```

For shared/single, expect `status: 'unhealthy'`. Serialize details and assert the poison error message, test scope keys, and JID-shaped fixture strings are absent.

Core tests must prove both degraded and unhealthy agent runtime snapshots include `runtime.outbound_queue_poisoned`, and `degradation_causes` includes `agent_outbound_queue_poisoned`. Add two independence matrices:

```text
historical recovery debt=true, poison=false  → no poison reason
historical recovery debt=false, poison=true  → poison reason remains
```

- [ ] **Step 2: Run the health cases and prove RED**

Run:

```bash
bash scripts/run-with-pinned-npm.sh test -- \
  tests/runtimes/agent/health-snapshot.test.ts \
  tests/core/health.test.ts \
  tests/core/failure-taxonomy-cross-contract.test.ts \
  -t "outbound queue poison|fault taxonomy" \
  --pool=forks --fileParallelism=false --retry=0
```

Expected: the aggregate fields and bounded causes are absent; unhealthy core status does not yet retain the runtime-specific reason.

- [ ] **Step 3: Add runtime status projection**

Compute the poison snapshot once beside `turnQueueHealth`, spread only the two public aggregate fields into shared details, and do not spread `activeAdmissionLaneBlocked`:

```ts
const poisonHealth = this.runtimeTurnCoordinator.outboundQueuePoisonHealth();
const publicPoisonHealth = {
  outboundQueuePoisoned: poisonHealth.outboundQueuePoisoned,
  outboundQueuePoisonedScopes: poisonHealth.outboundQueuePoisonedScopes,
};
```

Append `outbound_queue_poisoned` whenever the count is positive. For `per_chat`, any non-empty reason vector remains `degraded`. For `shared`/`single`, compute unhealthy as:

```ts
const healthStatus: RuntimeHealth['status'] =
  turnQueueHealth.turnQueueHalted || poisonHealth.activeAdmissionLaneBlocked
    ? 'unhealthy'
    : degradedReasons.length > 0
      ? 'degraded'
      : 'healthy';
```

- [ ] **Step 4: Preserve the specific reason through core unhealthy aggregation**

When `agentRuntimeStatus === 'unhealthy'`, retain `agent_runtime_unhealthy` and add only the newly required normalized poison reason. Do not broaden the unhealthy projection of unrelated runtime reasons in this repair:

```ts
const poisonRuntimeReason = runtimeDegradedReasons(runtimeSnapshot?.details ?? null)
  .includes('outbound_queue_poisoned')
    ? ['runtime.outbound_queue_poisoned']
    : [];

// unhealthy branch
statusReasons = ['agent_runtime_unhealthy', ...poisonRuntimeReason];
```

Add `agent_outbound_queue_poisoned` to `HealthDegradationCause`, its presence map, and `fault-taxonomy-registry.json`. Emit it only when the aggregate boolean is true or the validated count is positive. Do not derive it from historical recovery counters.

- [ ] **Step 5: Run health, taxonomy, and privacy regressions**

Run:

```bash
bash scripts/run-with-pinned-npm.sh test -- \
  tests/runtimes/agent/health-snapshot.test.ts \
  tests/core/health.test.ts \
  tests/core/failure-taxonomy-cross-contract.test.ts \
  tests/fleet/health-poller.test.ts \
  --pool=forks --fileParallelism=false --retry=0
bash scripts/run-with-pinned-npm.sh run typecheck:all
```

Expected: per-chat poison remains HTTP-compatible degraded state, shared/single poison maps to unhealthy/503 through the existing core status contract, exact reason/cause is present, and no identity/error material is serialized.

- [ ] **Step 6: Commit health projection**

```bash
git add src/runtimes/agent/runtime.ts src/core/health.ts \
  src/lib/fault-taxonomy-registry.json \
  tests/runtimes/agent/health-snapshot.test.ts tests/core/health.test.ts \
  tests/core/failure-taxonomy-cross-contract.test.ts
git commit -m "fix(health): report active outbound queue poison"
```

### Task 5: Compensate adjacent health, lifecycle, and operator consumers

**Files:**
- Create: `src/runtimes/agent/scope-alias-map.ts`
- Modify: `src/runtimes/agent/turn-queue-halt-latch.ts`
- Modify: `src/runtimes/agent/outbound-queue-poison-registry.ts`
- Modify: `src/lib/fault-taxonomy-registry.json`
- Modify: `tests/core/failure-taxonomy-cross-contract.test.ts`
- Modify: `tests/scripts/bot-errors-health-check.test.ts`
- Modify: `deploy/scripts/tests/test_bot_errors_fault_taxonomy_registry.py`
- Modify: `deploy/bot-errors-runtime-manifest.json`
- Modify: `tests/runtimes/agent/lib/runtime-terminal-coordinator-harness.ts`
- Modify: `tests/runtimes/agent/runtime-terminal-coordinator-integration.test.ts`
- Modify: `tests/fleet/routes/lines.test.ts`
- Modify: `tests/console/line-detail-tabs.test.tsx`
- Modify: `docs/durability.md`
- Modify: `docs/public-surface.md`
- Modify: `docs/runbook.md`
- Regenerate: `docs/work-index.json`
- Regenerate: `docs/work-index.md`

**Interfaces:**
- Reuse: `runtimeAgentHealthSignals` as the sole numeric agent-health registry
- Reuse: BOT ERRORS `positive_is_risk` classification and bounded evidence labels
- Reuse: one internal scope-alias resolver for halt and poison registries
- Preserve: process-local poison across every in-process queue/session replacement
- Preserve: active teardown ownership without replacing the original outbound failure

- [ ] **Step 1: Prove the missing operational-health registration RED**

Add `outboundQueuePoisonedScopes` to the exact expected-field inventories in the
TypeScript and Python taxonomy tests. Add a BOT ERRORS health-check case asserting that
`outboundQueuePoisonedScopes: 1` produces `runtime_agent_at_risk` and bounded evidence
`runtime_agent_outbound_queue_poisoned_scopes=1`.

Run:

```bash
bash scripts/run-with-pinned-npm.sh test -- \
  tests/core/failure-taxonomy-cross-contract.test.ts \
  tests/scripts/bot-errors-health-check.test.ts \
  --pool=forks --fileParallelism=false --retry=0
python3 -m unittest deploy/scripts/tests/test_bot_errors_fault_taxonomy_registry.py
```

Expected: the exact inventories and BOT ERRORS evidence test fail because the canonical
registry does not yet include the emitted runtime field. A Python runner mismatch is
inconclusive rather than a passing result; use the repository's owning Python test command
if `run-tokenomics-pytests.sh` does not accept a file argument.

- [ ] **Step 2: Register the existing field instead of adding a parallel checker**

Add one `runtimeAgentHealthSignals` entry:

```json
{
  "field": "outboundQueuePoisonedScopes",
  "label": "runtime_agent_outbound_queue_poisoned_scopes",
  "kind": "active_episode_count",
  "currentHealthEffect": "positive_is_risk",
  "owner": "src/runtimes/agent/runtime.ts",
  "test": "tests/runtimes/agent/health-snapshot.test.ts"
}
```

Do not create another health registry, parser, severity branch, or alert source. The
existing BOT ERRORS loop must discover and classify the field dynamically from this
entry.

- [ ] **Step 3: Prove queue replacement, restart, rekey, and teardown semantics**

Add focused coordinator integration cases proving:

- a healthy replacement queue does not clear a poisoned canonical scope;
- `/new`, provider fallback, and ordinary queue replacement are therefore not recovery
  proof and same-scope admission remains `scope_blocked_recovery`;
- a newly constructed coordinator after process restart begins with an empty registry;
- LID-to-canonical rekey keeps both aliases blocked and retains one aggregate scope;
- poison observed while a `TurnQueue` teardown receipt owns pending turns rethrows the
  original outbound error, keeps poison health active, and leaves the receipt's ownership
  unchanged for exactly-once terminalization.

Use the existing coordinator, registry, `TurnQueue.beginTeardown()`, and rejected-turn
finalizer. Do not add a clear method, replacement callback, or another ownership map.

- [ ] **Step 4: Correct the operator contract**

State consistently that only process restart constructs a fresh poison registry. An
in-process queue or session replacement does not clear it. Restart remains neither
delivery proof nor replay authorization, and the operator must reconcile durable evidence
before an approved restart.

- [ ] **Step 5: Remove duplicate alias resolution without combining domain ownership**

Extract the identical cycle-safe scope resolution and canonical rekey bookkeeping from
`TurnQueueHaltLatch` and `OutboundQueuePoisonRegistry` into one small internal helper.
Keep the halted-scope set and poison-cause map in their existing owners, retain both
public APIs, and preserve first-cause and destination-collision behavior. Verify the two
owning unit suites and coordinator integration, then run the strict multi-signal clone
pipeline over `src/runtimes/agent` with no skipped or failed detectors.

- [ ] **Step 6: Repin and run the existing operational guards**

Update only the changed `src/lib/fault-taxonomy-registry.json` SHA-256 entry in
`deploy/bot-errors-runtime-manifest.json`, then run:

```bash
bash scripts/run-with-pinned-npm.sh run guard:fault-taxonomy-coverage
bash scripts/run-with-pinned-npm.sh run guard:bot-errors-runtime-manifest
bash scripts/run-with-pinned-npm.sh run guard:source-runtime-drift
bash scripts/run-with-pinned-npm.sh test -- \
  tests/core/failure-taxonomy-cross-contract.test.ts \
  tests/scripts/bot-errors-health-check.test.ts \
  tests/scripts/check-bot-errors-runtime-manifest.test.ts \
  tests/fleet/routes/lines.test.ts \
  tests/console/line-detail-tabs.test.tsx \
  --pool=forks --fileParallelism=false --retry=0
python3 -m unittest deploy/scripts/tests/test_bot_errors_fault_taxonomy_registry.py
```

Expected: the registry/checker/manifest agree, fleet and console retain the bounded cause
through their existing generic contracts, and no raw scope or error text reaches those
consumers. If the exact console suite name has drifted, inventory the current owning test
instead of creating a one-off test runner.

- [ ] **Step 7: Commit the integration compensation**

```bash
git add src/lib/fault-taxonomy-registry.json \
  src/runtimes/agent/scope-alias-map.ts \
  src/runtimes/agent/turn-queue-halt-latch.ts \
  src/runtimes/agent/outbound-queue-poison-registry.ts \
  tests/core/failure-taxonomy-cross-contract.test.ts \
  tests/scripts/bot-errors-health-check.test.ts \
  deploy/scripts/tests/test_bot_errors_fault_taxonomy_registry.py \
  deploy/bot-errors-runtime-manifest.json \
  tests/runtimes/agent/lib/runtime-terminal-coordinator-harness.ts \
  tests/runtimes/agent/runtime-terminal-coordinator-integration.test.ts \
  tests/fleet/routes/lines.test.ts tests/console/line-detail-tabs.test.tsx \
  docs/durability.md docs/public-surface.md docs/runbook.md \
  docs/work-index.json docs/work-index.md \
  docs/superpowers/plans/2026-08-14-outbound-queue-quiescence-containment.md
git commit -m "fix(health): integrate outbound poison operations"
```

### Task 6: Document contracts, prove branch completeness, and open the reviewed PR

**Files:**
- Modify: `docs/durability.md`
- Modify: `docs/public-surface.md`
- Modify: `docs/runbook.md`
- Modify generated classification: `docs/publication-audit.md`
- Modify only if verification finds an owned defect: files already named in Tasks 1-4

**Interfaces:**
- Durability: stable boundary, genuine poison, terminal classifications, no automatic replay
- Public health: aggregate fields, per-chat degraded versus shared/single unhealthy
- Runbook: diagnosis, restart limitation, no generic clear, no resend inference

- [ ] **Step 1: Update operator and public contracts**

Document all of the following exactly:

- `flush`, poll, turn-evidence, and shutdown share one stable boundary;
- post-closure content is rejected and cannot leak into a replacement queue epoch;
- genuine poison is process-local, survives in-process queue/session replacement, and
  clears only when process restart constructs a fresh registry;
- active turn versus pending/new turn failure classes differ intentionally;
- `outboundQueuePoisoned` and `outboundQueuePoisonedScopes` expose aggregates only;
- per-chat poison is degraded while shared/single poison is unhealthy;
- recovery debt neither creates nor clears poison;
- restart is not delivery proof and this change does not replay or resend backlog.

- [ ] **Step 2: Regenerate publication classification and validate docs**

Run:

```bash
bash scripts/run-with-pinned-npm.sh run guard:publication:write
git add docs/durability.md docs/public-surface.md docs/runbook.md docs/publication-audit.md
bash scripts/run-with-pinned-npm.sh run guard:publication:staged
git diff --cached --check
```

Expected: the publication audit is canonical and the staged documentation passes.

- [ ] **Step 3: Run Test Integrity on every changed test**

Run:

```bash
bash scripts/run-with-pinned-npm.sh run guard:test-integrity:required
```

Expected: exit 0 with every changed test scanned. Missing tooling, partial scanning, or a skipped required lane remains inconclusive.

- [ ] **Step 4: Run the complete affected suite**

Run:

```bash
bash scripts/run-with-pinned-npm.sh test -- \
  tests/runtimes/agent/outbound-queue-flush-linearization.test.ts \
  tests/runtimes/agent/outbound-queue.test.ts \
  tests/runtimes/agent/outbound-queue-turn-evidence.test.ts \
  tests/runtimes/agent/outbound-queue-idempotency.test.ts \
  tests/runtimes/agent/control-queue.test.ts \
  tests/runtimes/agent/outbound-queue-poison-registry.test.ts \
  tests/runtimes/agent/turn-queue.test.ts \
  tests/runtimes/agent/admission-reject-failure-class.test.ts \
  tests/runtimes/agent/runtime-terminal-coordinator-integration.test.ts \
  tests/runtimes/agent/terminal-transaction-matrix.test.ts \
  tests/runtimes/agent/runtime-secondhalf-branches.test.ts \
  tests/runtimes/agent/runtime-turn-result-handler.test.ts \
  tests/runtimes/agent/runtime-turn-result-handler-escape-alert.test.ts \
  tests/runtimes/agent/runtime-turn-recovery-health.test.ts \
  tests/runtimes/agent/runtime-shutdown-outbound-persistence.test.ts \
  tests/runtimes/agent/runtime-reset-teardown.test.ts \
  tests/runtimes/agent/health-snapshot.test.ts \
  tests/runtimes/agent/runtime.test.ts \
  tests/core/health.test.ts \
  tests/core/failure-taxonomy-cross-contract.test.ts \
  tests/fleet/health-poller.test.ts \
  --pool=forks --fileParallelism=false --retry=0
```

Expected: all selected suites pass with no retry masking.

- [ ] **Step 5: Run static, repository, publication, and release gates**

Run each command separately and preserve its exit status:

```bash
bash scripts/run-with-pinned-npm.sh run typecheck
bash scripts/run-with-pinned-npm.sh run typecheck:all
bash scripts/run-with-pinned-npm.sh run typecheck:scripts
bash scripts/run-with-pinned-npm.sh run guard:repo:branch-diff
bash scripts/run-with-pinned-npm.sh run guard:publication:release
bash scripts/run-with-pinned-npm.sh run verify:release
git diff --check
```

Expected: every command exits 0. Do not collapse a failure into a combined shell command or call a masked result clean.

- [ ] **Step 6: Compare final behavior with both candidate branches**

Run:

```bash
git range-diff 8518983e...89202825e origin/main...HEAD
git range-diff 8518983e...655c22d38 origin/main...HEAD
git cherry -v origin/main 89202825e
git cherry -v origin/main 655c22d38
git diff --stat origin/main...HEAD
git log --oneline origin/main..HEAD
```

Review requirements:

- F-01 race and sticky-failure behavior is present or deliberately superseded by stronger evidence.
- F-02 same-scope isolation intent is present without its duplicate per-queue map or unsafe clear.
- No candidate branch is deleted in this task.
- No upstream `main` behavior is dropped.

- [ ] **Step 7: Commit documentation and final reviewed corrections**

```bash
git add docs/durability.md docs/public-surface.md docs/runbook.md docs/publication-audit.md
git commit -m "docs: explain outbound queue poison containment"
```

If verification required code/test corrections, commit each correction with its focused red/green proof before this documentation commit; do not fold unrelated fixes together.

- [ ] **Step 8: Perform exact-head review before publication**

Inspect:

```bash
git status --short --branch
git diff --check origin/main...HEAD
git diff --name-status origin/main...HEAD
git log --format='%h %an <%ae> %s' origin/main..HEAD
git diff --no-ext-diff --unified=0 origin/main...HEAD
```

Expected: clean worktree, only scoped files, approved public author identity, and zero private or forbidden publication content under the repository guard and direct diff review. Review the actual diff for queue liveness, terminal ownership, privacy, and health classification—not only the test summary.

- [ ] **Step 9: Push the SSH branch and open the documented PR**

Run:

```bash
git push -u origin fix/outbound-queue-quiescence-containment
gh pr create --base main --head fix/outbound-queue-quiescence-containment \
  --title "fix: contain poisoned outbound queue scopes" \
  --body "## Summary
- linearize outbound flush, poll, evidence, and shutdown completion
- block and terminalize work owned by genuinely poisoned scopes
- expose aggregate current poison health without identity or error leakage

## Validation
- deterministic RED/GREEN late-enqueue reproduction
- focused queue, runtime, terminal, health, taxonomy, and fleet suites
- typecheck, Test Integrity, publication/repository guards, and verify:release

## Safety
- no automatic replay, backlog send, migration, restart, deployment, or generic poison clear
- per-chat isolation preserved; shared/single poison fails the active lane closed"
```

This external write is limited to the owner-requested PR. Do not merge, deploy, restart, resend, comment, or delete candidate branches.

- [ ] **Step 10: Verify the remote PR head and checks**

Run read-only verification:

```bash
git rev-parse HEAD
git ls-remote origin refs/heads/fix/outbound-queue-quiescence-containment
gh pr view --json number,url,headRefOid,baseRefName,mergeStateStatus,statusCheckRollup
gh pr checks --watch --interval 20
```

Expected: local HEAD, remote branch SHA, and PR `headRefOid` match; every required check reaches success. A cancelled, skipped, neutral, timed-out, stale-SHA, or missing required check is not approval. Report the PR URL, exact SHA, local gate results, remote check state, unresolved review findings, and explicitly that no deployment or backlog action occurred.
