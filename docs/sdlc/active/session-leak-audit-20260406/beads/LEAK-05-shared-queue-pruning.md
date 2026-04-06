# Bead: LEAK-05 — Shared-Mode Outbound Queue Pruning

**BeadID:** LEAK-05

**Status:** pending
**Type:** implement
**Runner:** —
**Dependencies:** none
**Scope:** `src/runtimes/agent/runtime.ts`, `src/runtimes/agent/outbound-queue.ts`
**Input:** Audit finding: `outboundQueues` (shared mode) grows unbounded
**Output:** LRU/idle eviction for shared-mode outbound queues
**Cynefin domain:** clear
**Security sensitive:** false
**Profile:** REPAIR
**Deterministic checks:** `npm run typecheck`, `npx vitest run`
**Turbulence:** L0: 0, L1: 0, L2: 0
**Loop depth:** L0 + L1
**Status:** pending → running → submitted → verified → proven → hardened → reliability-proven → merged
**Current loop:** —
**Bridge sync:** false

## Root Cause

In `shared` mode, `outboundQueues` (L504) accumulates one `OutboundQueue` per unique chat JID that has ever sent a message:

```typescript
private outboundQueues: Map<string, IOutboundQueue> = new Map();
```

Created in `ensureOutboundQueue()` and during startup resume. Never deleted except in `shutdown()` (`.clear()`). For an `open_dm` bot receiving messages from many distinct users, this Map grows monotonically.

Each `OutboundQueue` holds: timer handles (cleared by `abortTurn()`), send queue (drains to empty), tool/stream buffers (flushed per turn). The per-instance memory is small (~500 bytes idle), but at scale (thousands of unique senders over days/weeks) it accumulates.

## Implementation Spec

### 1. Add `lastActivity` to `OutboundQueue`

In `outbound-queue.ts`, add a public field:

```typescript
public lastActivity: number = Date.now();
```

Update it in `enqueue()` (or `enqueueSend()`) and `flush()` — the two operations that indicate the queue is actively being used:

```typescript
// In enqueue/enqueueSend:
this.lastActivity = Date.now();

// In flush (tool buffer or stream buffer):
this.lastActivity = Date.now();
```

### 2. Add `shutdown()` to `OutboundQueue` interface

If `IOutboundQueue` doesn't already have a `shutdown()` method, add one that calls `abortTurn()` to clear timers. Check existing interface — if it already exists, use it.

### 3. Add periodic sweep in `AgentRuntime`

Only for shared mode:

```typescript
private static readonly QUEUE_IDLE_MS = 60 * 60 * 1000; // 1 hour
private static readonly QUEUE_SWEEP_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
private queueSweepTimer: ReturnType<typeof setInterval> | null = null;
```

In `start()`, when `sessionScope === 'shared'`:

```typescript
this.queueSweepTimer = setInterval(
  () => this.sweepIdleQueues(),
  AgentRuntime.QUEUE_SWEEP_INTERVAL_MS
);
this.queueSweepTimer.unref();
```

Sweep method:

```typescript
private sweepIdleQueues(): void {
  const now = Date.now();
  for (const [jid, queue] of this.outboundQueues) {
    if (now - queue.lastActivity > AgentRuntime.QUEUE_IDLE_MS) {
      log.debug({ chatJid: jid, idleMs: now - queue.lastActivity }, 'evicting idle outbound queue');
      queue.shutdown();
      this.outboundQueues.delete(jid);
    }
  }
}
```

### 4. Clear sweep timer in shutdown

```typescript
if (this.queueSweepTimer) {
  clearInterval(this.queueSweepTimer);
  this.queueSweepTimer = null;
}
```

### 5. Re-creation on demand

`ensureOutboundQueue()` already creates a new queue if one doesn't exist for the JID. Evicted queues are transparently re-created on the next message.

## Design Decisions

- **1-hour idle timeout**: Shared mode queues are lightweight. A longer timeout avoids unnecessary churn for users who take breaks between messages.
- **No LRU cap**: A time-based eviction is simpler and more predictable than an LRU cap. If a bot talks to 1000 users in an hour, all 1000 queues stay alive (they're cheap). They'll be pruned in the next hour if inactive.

## Maybe I'm Wrong

### Assumption: Shared-mode outbound queues are the unbounded growth vector
**Validation needed:** Is `outboundQueues` only used in shared mode?
- Declaration at L504: `private outboundQueues: Map<string, IOutboundQueue>`. Used in `ensureOutboundQueue()` which is called from `handleMessage` when `sessionScope === 'shared'`.
- Also used in `handleJidAliasChanged` (LID re-keying) and startup resume for shared mode.
- **Verdict: Confirmed — shared mode only.**

### Assumption: Queues are cheap enough that 1-hour timeout is sufficient
**Validation needed:** What does an idle `OutboundQueue` hold?
- All timers cleared by `abortTurn()` at turn end. An idle queue has: `chatJid: string`, `messenger: Messenger`, empty `sendQueue: string[]`, empty `toolBuffer`, null timers. ~200-500 bytes per instance.
- At 1000 idle queues: ~500KB. At 10,000: ~5MB. Not catastrophic but wasteful.
- **Verdict: 1-hour timeout is generous. Could be 30 minutes but 1 hour is safe for users who step away.**

### Assumption: `IOutboundQueue` interface supports `lastActivity`
**Validation needed:** Is `IOutboundQueue` an interface or a concrete class?
- Need to check if adding `lastActivity` requires interface changes.
- If `IOutboundQueue` is an interface, we need to add the field to it. If it's a concrete class, we can add directly.
- **Action:** Read the `IOutboundQueue` interface definition before implementation.
- **Verdict: Must verify interface shape.**

### Risk: Evicting a queue that has pending sends
**Assessment:** An idle queue (lastActivity > 1 hour) should have no pending sends — all sends complete in seconds. But what if a network error caused retries that took very long?
- `enqueueSend` adds to `sendQueue` and starts a drain chain. The drain resolves each promise. If the messenger is hung, sends could be pending.
- Adding a check: only evict if `sendQueue.length === 0` (or expose `hasPendingWork()`).
- **Verdict: Add a guard — don't evict queues with pending sends.** Update the sweep to check `queue.hasPendingWork?.() !== true`.

## Required Tests

### Test 1: Idle queue is evicted after timeout
```
GIVEN outboundQueues has entry for JID J with lastActivity = now - 61 minutes
AND the queue has no pending work
WHEN sweepIdleQueues() runs
THEN outboundQueues.has(J) === false
AND queue.shutdown() was called
```
**Durable:** Map state check — no timing dependency.
**Repeatable:** Mock `Date.now()`, set `lastActivity` directly.
**Observable:** `.has()` and mock verification.
**Provable:** Boolean assertions.

### Test 2: Active queue is not evicted
```
GIVEN outboundQueues has entry for JID J with lastActivity = now - 5 minutes
WHEN sweepIdleQueues() runs
THEN outboundQueues.has(J) === true
```

### Test 3: Evicted queue is re-created on next message
```
GIVEN outboundQueues does NOT have entry for JID J
WHEN ensureOutboundQueue(J) is called
THEN outboundQueues.has(J) === true (new queue created)
```

### Test 4: Queue with pending work is not evicted even if idle
```
GIVEN outboundQueues has entry for JID J with lastActivity = now - 2 hours
AND the queue has pending sends (sendQueue.length > 0)
WHEN sweepIdleQueues() runs
THEN outboundQueues.has(J) === true (not evicted)
```

## Verification

1. `npm run typecheck` — zero errors
2. `npx vitest run` — all tests pass
3. 4 new unit tests as specified above

## Acceptance Criteria

- [ ] `OutboundQueue` has `lastActivity` field, updated on enqueue/flush
- [ ] `IOutboundQueue` interface updated if needed
- [ ] Periodic sweep evicts queues idle >1 hour with no pending work
- [ ] Sweep timer is `.unref()`'d and cleared in shutdown
- [ ] Evicted queues are re-created on demand
- [ ] 4 new unit tests pass
- [ ] Typecheck passes
- [ ] All existing tests pass

## Loop Protocol

### L0 — Implementation
- Worker implements the spec in an isolated clone
- Must produce `bead-output.md` with `<!-- BEAD_OUTPUT_COMPLETE -->` sentinel
- Must pass: `npm run typecheck && npx vitest run`
- Bridge advances: `running` → `submitted`

### L1 — Sentinel Review  
- Different-model agent reviews the implementation
- Validates: code matches spec, tests are durable/repeatable/observable/provable, no regressions
- Bridge advances: `submitted` → `verified`

### L2 — Oracle Consensus
- Third-model agent validates architectural correctness
- Confirms: no unintended side effects, integration safety, edge cases covered
- Bridge advances: `verified` → `proven`

### Output Requirements
- `bead-output.md` must exist in clone root
- Must contain `<!-- BEAD_OUTPUT_COMPLETE -->` sentinel
- Must be >100 bytes
- Must include: commit hash, test results, files changed
