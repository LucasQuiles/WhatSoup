# Poisoned Direct-Send Rejection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent `sendDirectWithReceipt()` and its boolean wrapper from reporting acceptance when the selected outbound queue is already poisoned.

**Architecture:** Reuse `IOutboundQueue.isPoisoned()` as the single queue-failure authority. Check it synchronously in the existing queue path immediately before `enqueueText()` and return the existing unsuccessful outcome without enqueueing or bypassing through `Messenger`.

**Tech Stack:** TypeScript, Vitest, the existing `ChatTransportPort` and `IOutboundQueue` contracts, repository push gates.

## Global Constraints

- A known poisoned queue returns `{ accepted: false, messageId: null }`.
- Poison rejection must not call `enqueueText()` or `messenger.sendMessage()`.
- The explicit `bypassEchoGuard=true` path remains unchanged.
- A healthy queue retains asynchronous `{ accepted: true, messageId: null }` behavior.
- Do not expose message text, chat identifiers, or the raw poison error.
- Do not add a second poison registry, result envelope, retry path, or queue bypass.
- Use test-first RED/GREEN evidence and do not deploy, restart, merge, or send WhatsApp messages in this task.

---

### Task 1: Reject direct sends at the known-poison admission boundary

**Files:**
- Modify: `tests/runtimes/agent/chat-transport-send-direct.test.ts`
- Modify: `src/runtimes/agent/chat-transport.ts`

**Interfaces:**
- Consumes: `IOutboundQueue.isPoisoned(): boolean` and `IOutboundQueue.enqueueText(text: string, role?: OutboundMessageRole): void`.
- Produces: unchanged `sendDirectWithReceipt(port, chatJid, text, bypassEchoGuard?): Promise<SendDirectOutcome>` and `sendDirect(...): Promise<boolean>` signatures with fail-closed known-poison semantics.

- [ ] **Step 1: Write the failing receipt-envelope test and make healthy queue fixtures explicit**

Add `isPoisoned: () => false` to the queue objects in existing tests T4 and B3. Add this test inside the `sendDirectWithReceipt` describe block:

```ts
it('B7: a known-poisoned queue rejects without enqueue or messenger bypass', async () => {
  const enqueueText = vi.fn();
  const sendMessage = vi.fn().mockResolvedValue({ waMessageId: 'must-not-send' });
  const port = makePort({
    sendMessage,
    getQueueForChat: () => ({ enqueueText, isPoisoned: () => true }),
  });

  await expect(
    sendDirectWithReceipt(port, 'jid@s.whatsapp.net', 'text'),
  ).resolves.toEqual({ accepted: false, messageId: null });
  expect(enqueueText).not.toHaveBeenCalled();
  expect(sendMessage).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Write the failing boolean-wrapper test**

Add this test inside the `sendDirect` describe block:

```ts
it('T5: returns false without side effects for a known-poisoned queue', async () => {
  const enqueueText = vi.fn();
  const sendMessage = vi.fn().mockResolvedValue({ waMessageId: 'must-not-send' });
  const port = makePort({
    sendMessage,
    getQueueForChat: () => ({ enqueueText, isPoisoned: () => true }),
  });

  await expect(sendDirect(port, 'jid@s.whatsapp.net', 'text')).resolves.toBe(false);
  expect(enqueueText).not.toHaveBeenCalled();
  expect(sendMessage).not.toHaveBeenCalled();
});
```

- [ ] **Step 3: Run the focused test and capture RED**

Run:

```bash
npm test -- tests/runtimes/agent/chat-transport-send-direct.test.ts --pool=forks
```

Expected: exit 1; T5 receives `true`, B7 receives `{ accepted: true, messageId: null }`, and both observe `enqueueText` called once. Existing tests remain passing.

- [ ] **Step 4: Implement the minimal synchronous guard**

In `sendDirectWithReceipt()`, change only the existing queue branch:

```ts
const queue = port.getQueueForChat(chatJid);
if (queue) {
  if (queue.isPoisoned()) {
    return { accepted: false, messageId: null };
  }
  queue.enqueueText(text);
  return { accepted: true, messageId: null };
}
```

Update the adjacent comments so they state that a healthy queue accepts asynchronously and a known poisoned queue rejects synchronously. Do not add error logging because this boundary must not expose the poison error or duplicate the registry's operational telemetry.

- [ ] **Step 5: Run the focused test and capture GREEN**

Run:

```bash
npm test -- tests/runtimes/agent/chat-transport-send-direct.test.ts --pool=forks
```

Expected: exit 0; 12 tests pass, including T5 and B7.

- [ ] **Step 6: Run adjacent queue regression tests**

Run:

```bash
npm test -- \
  tests/runtimes/agent/chat-transport-send-direct.test.ts \
  tests/runtimes/agent/outbound-queue.test.ts \
  tests/runtimes/agent/outbound-queue-flush-linearization.test.ts \
  tests/runtimes/agent/outbound-queue-poison-registry.test.ts \
  --pool=forks
```

Expected: exit 0 with all selected files and tests passing and no skipped or todo tests.

- [ ] **Step 7: Run type and test-integrity gates**

Run:

```bash
npm run typecheck
npm run typecheck:all
npm run guard:test-integrity:required
```

Expected: all three commands exit 0. The required Test Integrity wrapper scans the
repository's tracked candidate files, including the changed test. Missing tooling exits 2
and is recorded as inconclusive, never as a pass.

- [ ] **Step 8: Review exact diff and commit the runtime slice**

Run:

```bash
git diff --check
git diff -- src/runtimes/agent/chat-transport.ts tests/runtimes/agent/chat-transport-send-direct.test.ts
git status --short
```

Expected: only the two task files are modified and the diff matches the approved contract. Commit with:

```bash
git add -u -- src/runtimes/agent/chat-transport.ts tests/runtimes/agent/chat-transport-send-direct.test.ts
git commit -m "fix(agent): reject direct sends on poisoned queues"
```

---

### Task 2: Revalidate the complete PR head

**Files:**
- Verify: all files in `git diff --name-only origin/main...HEAD`

**Interfaces:**
- Consumes: the exact Task 1 commit and the existing PR #3242 containment implementation.
- Produces: a push-gate receipt and current GitHub CI/review status for one exact head SHA.

- [ ] **Step 1: Confirm branch and upstream identity before push**

Run:

```bash
git status --short --branch
git rev-parse HEAD
git rev-parse origin/fix/outbound-queue-quiescence-containment
git merge-base --is-ancestor origin/main HEAD
```

Expected: clean worktree, local HEAD ahead only by the approved design/plan/runtime commits, and `origin/main` is an ancestor. A moved `origin/main` requires fetch, review, and normal merge before proceeding.

- [ ] **Step 2: Run the branch verification gate**

Run:

```bash
npm run verify:push:branch
```

Expected: every declared step exits 0. Warning-only fitness output remains disclosed as warning debt; any skipped, timed-out, or masked command is inconclusive.

- [ ] **Step 3: Push without force and verify the remote receipt**

Run:

```bash
git push origin fix/outbound-queue-quiescence-containment
git rev-parse HEAD
git rev-parse origin/fix/outbound-queue-quiescence-containment
```

Expected: normal fast-forward push succeeds and both SHAs match exactly.

- [ ] **Step 4: Inspect PR checks and review state**

Run:

```bash
gh pr view 3242 --json url,headRefOid,baseRefOid,mergeStateStatus,reviewDecision,statusCheckRollup
```

Expected: `headRefOid` equals the pushed SHA. CI may be pending, but merge readiness cannot be claimed until required checks pass and review is approved.
