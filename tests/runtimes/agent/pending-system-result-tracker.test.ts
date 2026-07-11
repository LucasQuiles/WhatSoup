/**
 * Branch-coverage tests for src/runtimes/agent/pending-system-result-tracker.ts.
 *
 * The class is exercised at the happy-path level by tests/runtimes/agent/
 * runtime.test.ts (system-result suppression, GLOBAL-scope shared-mode path,
 * unmark-on-send-failure, cleanup). This file targets every branch in the
 * tracker in isolation so the per-file coverage for
 * pending-system-result-tracker.ts reads 100%.
 *
 * Branches covered (16 total):
 *
 *   mark(scopeKey)
 *     - `scopeKey === undefined` early-return (TRUE)              ← leaf line 21
 *     - `scopeKey === undefined` falls through (FALSE)             ← leaf line 21
 *     - `counts.get(scopeKey) ?? 0` falsy branch (first mark)      ← leaf line 21
 *     - `counts.get(scopeKey) ?? 0` truthy branch (second mark)    ← leaf line 21
 *
 *   unmark(scopeKey)
 *     - `scopeKey === undefined` early-return (TRUE)              ← leaf line 22
 *     - `scopeKey === undefined` falls through (FALSE)             ← leaf line 22
 *     - `counts.get(scopeKey) ?? 0` falsy branch (unknown scope)   ← leaf line 22
 *     - `pending > 0` TRUE (decrements)                           ← leaf line 22
 *     - `pending > 0` FALSE (floor at 0; stays 0)                 ← leaf line 22
 *
 *   count(scopeKey)
 *     - existing key returns stored value (truthy branch)         ← leaf line 23
 *     - absent key returns 0 (falsy branch)                       ← leaf line 23
 *
 *   consumeIfPending(scopeKey)
 *     - `counts.get(scopeKey) ?? 0` falsy branch (absent)         ← leaf line 24
 *     - `pending > 0` TRUE (consumes one, returns true)           ← leaf line 24
 *     - `pending > 0` FALSE (count 0 or drained, returns false)   ← leaf line 24
 *
 * The tracker has no I/O, no timers, no side effects outside its own
 * `counts` map — every assertion is made against the public readonly
 * `counts` map (`.get`, `.has`, `.size`) or the method's concrete return
 * value, per the test-integrity rules (no `.toBeUndefined()` / `.toBeNull()`
 * / `.toBeTruthy()` / `.not.toThrow()` as the lone terminal assertion).
 */
import { describe, it, expect } from 'vitest';
import { PendingSystemResultTracker } from '../../../src/runtimes/agent/pending-system-result-tracker.ts';

describe('PendingSystemResultTracker', () => {
  // ─── mark ──────────────────────────────────────────────────────────────────

  it('mark(undefined) is a no-op: the undefined early-return fires and counts stays empty', () => {
    const tracker = new PendingSystemResultTracker();

    tracker.mark(undefined);

    // The early-return path fired — no entry was created.
    expect(tracker.counts.size).toBe(0);
    expect(tracker.counts.has('a')).toBe(false);
    expect(tracker.count('a')).toBe(0);
  });

  it("mark('a') on an absent key seeds the counter at 1 (?? 0 falsy branch)", () => {
    const tracker = new PendingSystemResultTracker();

    tracker.mark('a');

    // counts.get('a') returned undefined, ?? 0 supplied 0, +1 → 1.
    expect(tracker.counts.has('a')).toBe(true);
    expect(tracker.counts.get('a')).toBe(1);
    expect(tracker.count('a')).toBe(1);
  });

  it("mark('a') on an already-counted key increments to 2 (?? 0 truthy branch)", () => {
    const tracker = new PendingSystemResultTracker();
    tracker.mark('a'); // seed: count → 1

    tracker.mark('a'); // second call: counts.get('a') === 1 (truthy), +1 → 2.

    expect(tracker.counts.get('a')).toBe(2);
    expect(tracker.count('a')).toBe(2);
    // Map size is unchanged after a re-mark of an existing scope.
    expect(tracker.counts.size).toBe(1);
  });

  it('mark tracks independent scopes side-by-side', () => {
    const tracker = new PendingSystemResultTracker();
    tracker.mark('scope-a');
    tracker.mark('chat-1');
    tracker.mark('chat-1');

    expect(tracker.counts.size).toBe(2);
    expect(tracker.count('scope-a')).toBe(1);
    expect(tracker.count('chat-1')).toBe(2);
  });

  // ─── unmark ────────────────────────────────────────────────────────────────

  it('unmark(undefined) is a no-op: the undefined early-return fires and counts stays empty', () => {
    const tracker = new PendingSystemResultTracker();

    tracker.unmark(undefined);

    expect(tracker.counts.size).toBe(0);
    expect(tracker.counts.has('a')).toBe(false);
    expect(tracker.count('a')).toBe(0);
  });

  it("unmark('a') on a never-marked scope stays 0 (?? 0 falsy + pending > 0 FALSE)", () => {
    const tracker = new PendingSystemResultTracker();

    tracker.unmark('never-marked');

    // The key was absent (?? 0 → pending = 0), so pending > 0 is FALSE and
    // no entry is created.
    expect(tracker.counts.has('never-marked')).toBe(false);
    expect(tracker.counts.size).toBe(0);
    expect(tracker.count('never-marked')).toBe(0);
  });

  it("unmark('a') with a live count decrements to 0 (pending > 0 TRUE)", () => {
    const tracker = new PendingSystemResultTracker();
    tracker.mark('a'); // count → 1
    tracker.mark('a'); // count → 2

    tracker.unmark('a'); // pending = 2 > 0 → set to 1.

    expect(tracker.counts.get('a')).toBe(1);
    expect(tracker.count('a')).toBe(1);
  });

  it("unmark('a') from 1 down to 0 then unmark again stays at 0 (pending > 0 FALSE → floor)", () => {
    const tracker = new PendingSystemResultTracker();
    tracker.mark('a'); // count → 1

    tracker.unmark('a'); // pending = 1 > 0 → set to 0.
    expect(tracker.count('a')).toBe(0);

    tracker.unmark('a'); // pending = 0, NOT > 0 → no decrement (floor).
    // The key remains (set during the first unmark) but its value is 0.
    expect(tracker.counts.get('a')).toBe(0);
    expect(tracker.count('a')).toBe(0);
  });

  // ─── count (peek) ──────────────────────────────────────────────────────────

  it("count('a') on an absent key returns 0 (?? 0 falsy branch)", () => {
    const tracker = new PendingSystemResultTracker();

    expect(tracker.count('never-seen')).toBe(0);
    // count must not mutate the map.
    expect(tracker.counts.has('never-seen')).toBe(false);
    expect(tracker.counts.size).toBe(0);
  });

  it("count('a') on an existing key returns the stored value (?? 0 truthy branch)", () => {
    const tracker = new PendingSystemResultTracker();
    tracker.mark('a');
    tracker.mark('a');
    tracker.mark('a');

    expect(tracker.count('a')).toBe(3);
    // count must not consume — repeating the call returns the same value.
    expect(tracker.count('a')).toBe(3);
    expect(tracker.counts.get('a')).toBe(3);
  });

  // ─── consumeIfPending ──────────────────────────────────────────────────────

  it("consumeIfPending on an absent scope returns false (?? 0 falsy + pending > 0 FALSE)", () => {
    const tracker = new PendingSystemResultTracker();

    const consumed = tracker.consumeIfPending('never-marked');

    expect(consumed).toBe(false);
    // No side effects: no entry created, size unchanged.
    expect(tracker.counts.has('never-marked')).toBe(false);
    expect(tracker.counts.size).toBe(0);
  });

  it("consumeIfPending with one outstanding system turn returns true and decrements to 0 (pending > 0 TRUE)", () => {
    const tracker = new PendingSystemResultTracker();
    tracker.mark('a'); // count → 1

    const consumed = tracker.consumeIfPending('a');

    expect(consumed).toBe(true);
    expect(tracker.counts.get('a')).toBe(0);
    expect(tracker.count('a')).toBe(0);
  });

  it("consumeIfPending with two outstanding returns true once, then false on the next call (drains to 0)", () => {
    const tracker = new PendingSystemResultTracker();
    tracker.mark('a'); // count → 1
    tracker.mark('a'); // count → 2

    expect(tracker.consumeIfPending('a')).toBe(true);
    expect(tracker.count('a')).toBe(1);

    // Second consume: pending = 1 > 0 → consumes the last one.
    expect(tracker.consumeIfPending('a')).toBe(true);
    expect(tracker.count('a')).toBe(0);

    // Third consume: pending = 0, not > 0 → returns false without decrementing.
    expect(tracker.consumeIfPending('a')).toBe(false);
    expect(tracker.count('a')).toBe(0);
  });

  it("consumeIfPending returns false on a scope whose count has already drained to 0 (pending > 0 FALSE)", () => {
    const tracker = new PendingSystemResultTracker();
    tracker.mark('a'); // count → 1
    tracker.consumeIfPending('a'); // drains to 0.

    const consumed = tracker.consumeIfPending('a');

    expect(consumed).toBe(false);
    // No further decrement.
    expect(tracker.count('a')).toBe(0);
  });

  it('waits for every marked system result before releasing a following user turn', async () => {
    const tracker = new PendingSystemResultTracker();
    tracker.mark('chat-a');
    tracker.mark('chat-a');

    let released = false;
    const waiting = tracker.waitForDrain('chat-a').then(() => { released = true; });
    tracker.consumeIfPending('chat-a');
    await Promise.resolve();
    expect(released).toBe(false);

    tracker.consumeIfPending('chat-a');
    await waiting;
    expect(released).toBe(true);
    expect(tracker.count('chat-a')).toBe(0);
  });

  it('releases a system-result waiter when the send fails and its mark is reversed', async () => {
    const tracker = new PendingSystemResultTracker();
    tracker.mark('chat-b');

    const waiting = tracker.waitForDrain('chat-b');
    tracker.unmark('chat-b');

    await expect(waiting).resolves.toBeUndefined();
    expect(tracker.count('chat-b')).toBe(0);
  });

  it('lets a marked system sender wait only for earlier system results', async () => {
    const tracker = new PendingSystemResultTracker();
    tracker.mark('chat-c');
    tracker.mark('chat-c');

    let released = false;
    const waiting = tracker.waitForCountAtMost('chat-c', 1).then(() => { released = true; });
    await Promise.resolve();
    expect(released).toBe(false);

    tracker.consumeIfPending('chat-c');
    await waiting;
    expect(released).toBe(true);
    expect(tracker.count('chat-c')).toBe(1);
  });

  it('releases dispatch blocking while retaining a timed-out result for classification', async () => {
    const tracker = new PendingSystemResultTracker();
    tracker.mark('chat-timeout');

    let released = false;
    const waiting = tracker.waitForDrain('chat-timeout').then(() => { released = true; });
    tracker.releaseBlockingMark('chat-timeout');
    await waiting;

    expect(released).toBe(true);
    expect(tracker.blockingCount('chat-timeout')).toBe(0);
    expect(tracker.count('chat-timeout')).toBe(1);
    expect(tracker.consumeIfPending('chat-timeout')).toBe(true);
    expect(tracker.count('chat-timeout')).toBe(0);
  });

  it('consumes a released FIFO result without releasing a later blocking system turn', async () => {
    const tracker = new PendingSystemResultTracker();
    tracker.mark('chat-fifo');
    tracker.releaseBlockingMark('chat-fifo');
    tracker.mark('chat-fifo');

    let released = false;
    const waiting = tracker.waitForDrain('chat-fifo').then(() => { released = true; });
    expect(tracker.consumeIfPending('chat-fifo')).toBe(true);
    await Promise.resolve();

    expect(released).toBe(false);
    expect(tracker.blockingCount('chat-fifo')).toBe(1);
    expect(tracker.count('chat-fifo')).toBe(1);

    expect(tracker.consumeIfPending('chat-fifo')).toBe(true);
    await waiting;
    expect(released).toBe(true);
  });

  it('cancels a released send without unblocking a newer system turn', async () => {
    const tracker = new PendingSystemResultTracker();
    tracker.mark('chat-timeout-reject');
    tracker.releaseBlockingMark('chat-timeout-reject');
    tracker.mark('chat-timeout-reject');

    expect(tracker.unmarkReleased('chat-timeout-reject')).toBe(true);
    expect(tracker.count('chat-timeout-reject')).toBe(1);
    expect(tracker.blockingCount('chat-timeout-reject')).toBe(1);

    let released = false;
    const waiting = tracker.waitForDrain('chat-timeout-reject').then(() => { released = true; });
    await Promise.resolve();
    expect(released).toBe(false);
    tracker.consumeIfPending('chat-timeout-reject');
    await waiting;
    expect(released).toBe(true);
  });
});
