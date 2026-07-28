# Chat Queue Admission Design

**Issue:** #2145

## Goal

Make ChatRuntime queue admission truthful without removing the per-chat memory
bound or adding a second replay subsystem. A capacity-rejected, journaled
inbound must receive a durable terminal disposition before the runtime reports
the rejection, and every caller must be able to distinguish admission from
processing completion.

## Scope

This change owns the ChatRuntime-to-ChatQueue admission boundary:

- observe the real `ChatQueue.enqueue()` result;
- return a bounded, content-free admission receipt;
- terminalize a linked rejected inbound with the existing `queue_full` failure
  class before returning the rejection receipt;
- expose aggregate rejection and unowned-rejection counts in ChatRuntime health;
- prove accepted and rejected behavior with the real queue and durability store.

The change does not implement access-approval replay (#2548), scheduled
agent-job occurrences (#2144/#2566), automatic retry, or queue-bound removal.

## Considered Approaches

### 1. Returned admission receipt with immediate terminalization

Extend the runtime return contract to allow a discriminated admission receipt.
ChatRuntime returns `accepted` after queue admission and returns
`rejected/queue_full` only after terminalizing a linked inbound. AgentRuntime
and PassiveRuntime may continue returning `void`.

This is the selected approach. It gives downstream consumers a bounded value,
keeps processing completion separate from admission, and reuses the existing
inbound journal and `queue_full` taxonomy.

### 2. Typed thrown rejection

Keep `Promise<void>` and throw a bounded queue-capacity error. This is smaller,
but it conflates an expected admission disposition with exceptional execution
failure and gives #2548 a less explicit receipt contract.

### 3. Durable retry owner

Persist rejected ChatRuntime work for later replay. This could avoid a user
retry, but it requires payload persistence, leasing, bounded backoff,
idempotency around provider calls and outbound sends, and restart recovery.
Those mechanisms do not exist for generic ChatRuntime work and are outside this
issue's smallest safe fix.

## Admission Contract

The shared runtime type permits:

```ts
type RuntimeAdmissionReceipt =
  | { status: 'accepted' }
  | {
      status: 'rejected';
      reason: 'queue_full';
      durableDisposition: 'failed' | 'unowned';
    };
```

`Runtime.handleMessage()` returns
`Promise<void | RuntimeAdmissionReceipt>`. Existing AgentRuntime and
PassiveRuntime implementations remain compatible and retain their current
completion semantics. ChatRuntime alone returns a receipt in this increment.

For ChatRuntime:

1. Call and await `ChatQueue.enqueue()`. This wait covers only the synchronous
   admission decision represented by its `Promise<boolean>`; it does not await
   the queued task.
2. If admitted, return `{ status: 'accepted' }`.
3. If rejected and both durability plus `inboundSeq` are present, compare and
   set the matching `processing` row by sequence, message ID, and chat JID to
   failed with `queue_full`, then return a rejected receipt whose
   `durableDisposition` is `failed`.
4. If rejected without a durable inbound identity, return a rejected receipt
   whose disposition is `unowned` and increment a bounded aggregate health
   counter. Do not fabricate a durable owner.

A missing, stale, mismatched, or already-terminal sequence changes zero rows,
increments the unowned counter, and rejects `handleMessage()`. A terminal-write
exception follows the same health path and is rethrown. Neither case returns a
false durable receipt or overwrites another terminal disposition.

The user-facing overload policy is intentionally no automatic reply. Sending a
new message outside the bounded queue would amplify load and could itself fail.
The durable failure class and health counters provide operator evidence; the
user may retry after capacity recovers.

## Health Contract

ChatRuntime health exposes only aggregate, identifier-free evidence:

- `queue.droppedCount`: cumulative real queue rejections since process start;
- `queueAdmission.rejectedTotal`: the same cumulative rejection count;
- `queueAdmission.unownedTotal`: rejected calls that could not be proven
  durably terminalized because identity was absent or invalid, the row was no
  longer processing, or the terminal write failed.

Any positive `unownedTotal` degrades runtime health because it proves a caller
left a ChatRuntime rejection without a proven durable owner. A terminalized
`queue_full` rejection does not keep runtime health degraded indefinitely; its
cumulative count remains observable.

No message, chat, sender, destination, host, process, filesystem, or exception
data appears in the receipt or health projection.

## Error and Durability Rules

- The existing `inbound_events.failure_class = 'queue_full'` vocabulary is the
  single durable classification; no migration or new taxonomy is added.
- ChatRuntime owns the capacity-rejection terminal write because it alone
  observes the queue result and already receives the DurabilityEngine.
- The receipt is returned only after exactly one matching `processing` row
  transitions.
- A zero-row transition or terminal-write exception increments unowned health,
  rejects `handleMessage()`, and is handled by the existing ingest error path;
  the runtime must not return a false durable receipt.
- Repeated rejections never enqueue work, bypass the cap, or produce replies.

## Test Strategy

Tests use a real `ChatQueue`, real SQLite-backed `Database`, and real
`DurabilityEngine`:

1. Fill a one-entry per-chat queue with a blocked task.
2. Journal a second inbound for the same chat and pass its sequence to
   ChatRuntime.
3. Assert the receipt is `rejected/queue_full/failed`, the provider is not
   called, `droppedCount` increments, and the inbound is durably `failed` with
   failure class `queue_full`.
4. Reject a message without `inboundSeq`; assert `unowned` receipt and degraded,
   identifier-free health evidence.
5. Supply a missing, stale, mismatched, or already-terminal sequence; assert no
   durable receipt is returned, no other row is overwritten, and health
   degrades.
6. Admit a message below capacity; assert an `accepted` receipt is returned
   before provider completion, then release the provider and prove reply,
   durable completion, and queue drain.
7. Retain the existing ChatQueue memory-bound and cross-chat fairness suite.

Focused verification includes ChatQueue, ChatRuntime admission, ChatRuntime
health, ingest, durability, and typechecking. The final draft PR also runs the
repository's required publication and branch gates before push.
