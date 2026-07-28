# Chat Queue Admission Implementation Plan

> **Issue:** #2145
>
> **Design:** `docs/superpowers/specs/2026-07-28-chat-queue-admission-design.md`

## Goal

Make ChatRuntime queue admission observable and durable: accepted work returns a
bounded receipt, a capacity-rejected journaled inbound is terminalized as
`queue_full` before rejection is reported, and unowned rejections surface as
identifier-free degraded health evidence.

## Constraints

- Keep the existing per-chat queue bound and cross-chat fairness behavior.
- Do not add retry, payload persistence, a migration, or automatic overload
  replies.
- Use the real `ChatQueue`, `Database`, and `DurabilityEngine` in the admission
  regression suite.
- Preserve `Promise<void>` behavior for AgentRuntime and PassiveRuntime.
- Keep receipts and health projections free of message and routing identifiers.
- Follow red-green-refactor: observe each new behavioral test fail for the
  intended missing behavior before changing production code.

## Task 1: Establish the baseline

**Files inspected:**

- `src/runtimes/types.ts`
- `src/runtimes/chat/queue.ts`
- `src/runtimes/chat/runtime.ts`
- `src/core/health.ts`
- `src/core/ingest.ts`
- `src/core/durability.ts`
- `tests/runtimes/chat/queue.test.ts`
- `tests/runtimes/chat/runtime.test.ts`
- `tests/runtimes/chat/health-snapshot.test.ts`
- `tests/core/health.test.ts`

**Steps:**

1. Run the focused ChatQueue, ChatRuntime, health, ingest, and durability suites
   on the unmodified implementation commit.
2. Record the exact passing counts and any environmental warnings.
3. Treat any masked, skipped, or infrastructure-limited result as
   inconclusive.

## Task 2: Specify the shared admission receipt

**Files:**

- Modify: `src/runtimes/types.ts`
- Test through: `tests/runtimes/chat/runtime-admission.test.ts`
- Typecheck through: `tsconfig.test.json`

**Steps:**

1. Add a compile-time/behavioral expectation that ChatRuntime may return
   `accepted` or bounded `rejected/queue_full` receipts.
2. Run the new test or typecheck and confirm it fails because
   `Runtime.handleMessage()` only permits `Promise<void>`.
3. Add and export `RuntimeAdmissionReceipt`.
4. Change the shared return type to
   `Promise<void | RuntimeAdmissionReceipt>`.
5. Run typechecking to prove existing AgentRuntime and PassiveRuntime
   implementations remain compatible.

## Task 3: Prove real queue rejection terminalizes durability

**Files:**

- Create: `tests/runtimes/chat/runtime-admission.test.ts`
- Modify: `src/runtimes/chat/runtime.ts`

**Steps:**

1. Build a fixture with a real one-entry `ChatQueue`, a blocked first task, a
   real temporary SQLite `Database`, and a real `DurabilityEngine`.
2. Journal a second inbound and pass its sequence to ChatRuntime.
3. Assert a second same-chat call:
   - returns `rejected/queue_full/failed`;
   - does not call the provider;
   - increments the real queue's dropped count;
   - durably marks the inbound `failed` with `queue_full`.
4. Run the focused test and observe the intended failure: ChatRuntime currently
   discards the queue result and does not terminalize the inbound.
5. Add an optional `chatQueue` dependency to `ChatRuntimeOptions` for the real
   queue fixture, defaulting to the existing `new ChatQueue(3)`.
6. Await `enqueue()`. On linked rejection, await
   `durability.markInboundFailed(seq, 'queue_full')` before returning the
   rejected receipt.
7. Re-run the test to green.

## Task 4: Prove accepted admission does not await task completion

**Files:**

- Modify: `tests/runtimes/chat/runtime-admission.test.ts`
- Modify: `src/runtimes/chat/runtime.ts`

**Steps:**

1. Add a real-queue test whose provider turn is deliberately blocked.
2. Assert `handleMessage()` promptly returns `{ status: 'accepted' }` while the
   queued task remains unfinished.
3. Observe the failing receipt assertion.
4. Return the accepted receipt immediately after `enqueue()` reports `true`.
5. Release the blocked work during fixture cleanup and re-run to green.

## Task 5: Surface unowned rejection health

**Files:**

- Modify: `tests/runtimes/chat/runtime-admission.test.ts`
- Modify: `tests/runtimes/chat/health-snapshot.test.ts`
- Modify: `src/runtimes/chat/runtime.ts`

**Steps:**

1. Add a real-queue rejection without `inboundSeq`.
2. Assert the returned receipt is
   `rejected/queue_full/unowned`.
3. Assert ChatRuntime health is degraded and contains only aggregate fields:
   `queue.droppedCount`, `queueAdmission.rejectedTotal`, and
   `queueAdmission.unownedTotal`.
4. Assert a durably terminalized rejection increments the rejection count but
   does not itself leave runtime health degraded.
5. Observe the failing health assertions.
6. Add a process-local unowned-rejection counter and extend the bounded health
   details.
7. Update existing ChatQueue test doubles with `droppedCount` where required.
8. Re-run ChatRuntime admission and health tests to green.

## Task 6: Project bounded evidence through core health

**Files:**

- Modify: `tests/core/health.test.ts`
- Modify: `src/core/health.ts`

**Steps:**

1. Add a health projection test with ChatRuntime aggregate admission evidence.
2. Assert the public health payload includes only finite nonnegative rejection
   and unowned counts, without copying arbitrary runtime detail.
3. Add malformed-value cases and assert they are omitted rather than trusted.
4. Observe the intended test failure.
5. Add the narrow ChatRuntime projection beside the existing queue-depth
   projection.
6. Re-run core health tests to green.

## Task 7: Preserve existing callers and queue behavior

**Files:**

- Modify if required: `tests/runtimes/chat/runtime.test.ts`
- Verify: `tests/runtimes/chat/queue.test.ts`
- Verify: `tests/core/ingest.test.ts`

**Steps:**

1. Update the existing ChatQueue mock so `enqueue()` resolves `true` and queued
   callback-drain behavior remains explicit.
2. Run the complete ChatRuntime suite to detect any scheduling regressions from
   awaiting the admission promise.
3. Run the real ChatQueue memory-bound and cross-chat fairness suite unchanged.
4. Run ingest tests to prove current callers may ignore the optional receipt
   without changing success or thrown-error behavior.
5. Run full test typechecking.

## Task 8: Review, verify, and publish the draft

**Steps:**

1. Run independent reviews for correctness/durability, test integrity, and
   public-surface/privacy safety.
2. Resolve every substantiated finding and repeat affected tests.
3. Run formatting/diff checks, focused suites, full typechecking, publication
   guard, repository staged guard, and the required branch verification gate.
4. Commit with public-safe messages and confirm no attribution or private
   identifiers appear in the diff, commit metadata, or draft body.
5. Push the SSH branch and open one draft PR for issue #2145.
6. Confirm the issue timeline contains the automatic draft reference; add an
   explicit bounded comment if it does not.
7. Monitor checks for the exact draft head SHA. Do not use results from an
   earlier head.
8. Only after all required hosted checks are green, replace `IN PROGRESS` with
   `PATCH READY` and post an exact-head verification receipt on #2145.
