/**
 * Focused invariants for exact system-turn ownership, FIFO classification,
 * dispatch barriers, LID rekeys, and fail-closed wall deadlines.
 */
import { afterEach, describe, it, expect, vi } from 'vitest';
import { PendingSystemResultTracker } from '../../../src/runtimes/agent/pending-system-result-tracker.ts';

describe('PendingSystemResultTracker', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('holds an expired lease until its exact teardown succeeds after a rekey', async () => {
    vi.useFakeTimers();
    const tracker = new PendingSystemResultTracker();
    const owner = { managerId: 'manager-a', generation: 1, toolScopeKey: 'lid#1' };
    let finishTeardown: ((succeeded: boolean) => void) | undefined;
    const onTimeout = vi.fn(() => new Promise<boolean>((resolve) => {
      finishTeardown = resolve;
    }));
    const lease = tracker.mark({
      scopeKey: '15550000001@lid',
      purpose: 'fresh_session_context',
      owner,
      timeoutMs: 1_000,
      onTimeout,
    });

    await vi.advanceTimersByTimeAsync(600);
    tracker.rekeyScope('15550000001@lid', '15550000001@s.whatsapp.net');
    expect(tracker.peek('15550000001@s.whatsapp.net')?.lease.id).toBe(lease.id);

    await vi.advanceTimersByTimeAsync(399);
    expect(onTimeout).toHaveBeenCalledTimes(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(onTimeout).toHaveBeenCalledExactlyOnceWith(lease);
    expect(tracker.count('15550000001@s.whatsapp.net')).toBe(1);
    expect(tracker.blockingCount('15550000001@s.whatsapp.net')).toBe(1);

    finishTeardown?.(true);
    await vi.runAllTimersAsync();

    expect(tracker.count('15550000001@s.whatsapp.net')).toBe(0);
    expect(tracker.blockingCount('15550000001@s.whatsapp.net')).toBe(0);
  });

  it('does not spend a deferred deadline while queued before provider admission', async () => {
    vi.useFakeTimers();
    const tracker = new PendingSystemResultTracker();
    const onTimeout = vi.fn(async () => true);
    const lease = tracker.mark({
      scopeKey: 'queued-chat',
      purpose: 'respawn_context',
      owner: { managerId: 'manager-a', generation: 1, toolScopeKey: 'queued-chat#1' },
      timeoutMs: 1_000,
      onTimeout,
      deferDeadlineUntilActivated: true,
    });

    await vi.advanceTimersByTimeAsync(60_000);
    expect(onTimeout).not.toHaveBeenCalled();
    expect(tracker.count('queued-chat')).toBe(1);

    expect(tracker.activateDeadline(lease)).toBe(true);
    await vi.advanceTimersByTimeAsync(999);
    expect(onTimeout).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onTimeout).toHaveBeenCalledExactlyOnceWith(lease);
  });

  it('keeps an expired lease classified and blocking when teardown is not proven', async () => {
    vi.useFakeTimers();
    const tracker = new PendingSystemResultTracker();
    const owner = { managerId: 'manager-a', generation: 1, toolScopeKey: 'chat-a#1' };
    const lease = tracker.mark({
      scopeKey: 'chat-a',
      purpose: 'respawn_context',
      owner,
      timeoutMs: 25,
      onTimeout: async () => false,
    });

    await vi.advanceTimersByTimeAsync(25);

    expect(tracker.peek('chat-a')?.lease.id).toBe(lease.id);
    expect(tracker.count('chat-a')).toBe(1);
    expect(tracker.blockingCount('chat-a')).toBe(1);
  });

  it('keeps an expired lease classified and blocking when teardown rejects', async () => {
    vi.useFakeTimers();
    const tracker = new PendingSystemResultTracker();
    const owner = { managerId: 'manager-a', generation: 1, toolScopeKey: 'chat-a#1' };
    const lease = tracker.mark({
      scopeKey: 'chat-a',
      purpose: 'respawn_context',
      owner,
      timeoutMs: 25,
      onTimeout: async () => { throw new Error('shutdown failed'); },
    });

    await vi.advanceTimersByTimeAsync(25);

    expect(tracker.peek('chat-a')?.lease.id).toBe(lease.id);
    expect(tracker.count('chat-a')).toBe(1);
    expect(tracker.blockingCount('chat-a')).toBe(1);
  });

  it('re-arms one retry window on a retry verdict and completes without teardown when the result lands in it', async () => {
    vi.useFakeTimers();
    const tracker = new PendingSystemResultTracker();
    const owner = { managerId: 'manager-a', generation: 1, toolScopeKey: 'chat-a#1' };
    const onTimeout = vi.fn(async (): Promise<boolean | 'retry'> => 'retry');
    const lease = tracker.mark({
      scopeKey: 'chat-a',
      purpose: 'fresh_session_context',
      owner,
      timeoutMs: 1_000,
      onTimeout,
    });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(onTimeout).toHaveBeenCalledExactlyOnceWith(lease);
    expect(tracker.count('chat-a')).toBe(1);
    expect(tracker.blockingCount('chat-a')).toBe(1);

    // The slow provider result arrives inside the retry window.
    await vi.advanceTimersByTimeAsync(500);
    expect(tracker.consumeResult(lease)?.lease.id).toBe(lease.id);
    expect(tracker.count('chat-a')).toBe(0);

    // Consumption cleared the re-armed slot — the deadline never fires again.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it('fires the deadline again after a granted retry window and cancels only on proven teardown', async () => {
    vi.useFakeTimers();
    const tracker = new PendingSystemResultTracker();
    const owner = { managerId: 'manager-a', generation: 1, toolScopeKey: 'chat-a#1' };
    const onTimeout = vi.fn<(lease: unknown) => Promise<boolean | 'retry'>>()
      .mockResolvedValueOnce('retry')
      .mockResolvedValue(true);
    const lease = tracker.mark({
      scopeKey: 'chat-a',
      purpose: 'fresh_session_context',
      owner,
      timeoutMs: 1_000,
      onTimeout,
    });

    await vi.advanceTimersByTimeAsync(999);
    expect(onTimeout).toHaveBeenCalledTimes(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(tracker.blockingCount('chat-a')).toBe(1);

    // The second window runs the full timeout again, then tears down.
    await vi.advanceTimersByTimeAsync(999);
    expect(onTimeout).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(onTimeout).toHaveBeenCalledTimes(2);
    expect(onTimeout).toHaveBeenNthCalledWith(2, lease);
    expect(tracker.count('chat-a')).toBe(0);
    expect(tracker.blockingCount('chat-a')).toBe(0);

    // Bounded: no third window exists after teardown cancelled the lease.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onTimeout).toHaveBeenCalledTimes(2);
  });

  it('does not re-arm a retry window for a lease that died while the verdict was pending', async () => {
    vi.useFakeTimers();
    const tracker = new PendingSystemResultTracker();
    const owner = { managerId: 'manager-a', generation: 1, toolScopeKey: 'chat-a#1' };
    let finishVerdict: ((verdict: boolean | 'retry') => void) | undefined;
    const onTimeout = vi.fn(() => new Promise<boolean | 'retry'>((resolve) => {
      finishVerdict = resolve;
    }));
    const lease = tracker.mark({
      scopeKey: 'chat-a',
      purpose: 'fresh_session_context',
      owner,
      timeoutMs: 1_000,
      onTimeout,
    });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(onTimeout).toHaveBeenCalledTimes(1);

    tracker.cancel(lease);
    finishVerdict?.('retry');
    await vi.runAllTimersAsync();

    expect(tracker.count('chat-a')).toBe(0);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it('clears exact deadline timers on result, cancellation, scope clear, and full clear', async () => {
    vi.useFakeTimers();
    const tracker = new PendingSystemResultTracker();
    const owner = { managerId: 'manager-a', generation: 1, toolScopeKey: 'chat#1' };
    const onTimeout = vi.fn(async () => true);
    const consumed = tracker.mark({
      scopeKey: 'consumed', purpose: 'fresh_session_context', owner,
      timeoutMs: 50, onTimeout,
    });
    const cancelled = tracker.mark({
      scopeKey: 'cancelled', purpose: 'fresh_session_context', owner,
      timeoutMs: 50, onTimeout,
    });
    tracker.mark({
      scopeKey: 'scope-cleared', purpose: 'fresh_session_context', owner,
      timeoutMs: 50, onTimeout,
    });
    tracker.mark({
      scopeKey: 'all-cleared', purpose: 'fresh_session_context', owner,
      timeoutMs: 50, onTimeout,
    });

    expect(tracker.consumeResult(consumed)?.lease.id).toBe(consumed.id);
    expect(tracker.cancel(cancelled)).toBe(true);
    tracker.clearScope('scope-cleared');
    tracker.clear();
    await vi.advanceTimersByTimeAsync(50);

    expect(onTimeout).toHaveBeenCalledTimes(0);
    expect(tracker.counts.size).toBe(0);
  });

  it('publishes an immutable exact owner and route with each production lease', () => {
    const tracker = new PendingSystemResultTracker();
    const owner = { managerId: 'manager-a', generation: 3, toolScopeKey: 'chat-a#3' };
    const lease = tracker.mark({
      scopeKey: 'chat-a',
      purpose: 'fresh_session_context',
      owner,
      routeChatJid: '15550000001@s.whatsapp.net',
    });
    owner.generation = 9;

    expect(tracker.peek('chat-a')).toEqual({
      lease,
      purpose: 'fresh_session_context',
      owner: { managerId: 'manager-a', generation: 3, toolScopeKey: 'chat-a#3' },
      routeChatJid: '15550000001@s.whatsapp.net',
      blocking: true,
    });
  });

  it('does not consume a non-head lease or mutate FIFO order', () => {
    const tracker = new PendingSystemResultTracker();
    const owner = { managerId: 'manager-a', generation: 1, toolScopeKey: 'chat-a#1' };
    const first = tracker.mark({
      scopeKey: 'chat-a', purpose: 'fresh_session_context', owner,
    });
    const second = tracker.mark({
      scopeKey: 'chat-a', purpose: 'poll_answer_continuation', owner,
    });

    expect(tracker.consumeResult(second)).toBeNull();
    expect(tracker.count('chat-a')).toBe(2);
    expect(tracker.peek('chat-a')?.lease).toEqual(first);
    expect(tracker.consumeResult(first)?.purpose).toBe('fresh_session_context');
    expect(tracker.peek('chat-a')?.lease).toEqual(second);
  });

  it('lets an exact system lease wait for prior blockers but not for itself', async () => {
    const tracker = new PendingSystemResultTracker();
    const owner = { managerId: 'manager-a', generation: 1, toolScopeKey: 'chat-a#1' };
    const first = tracker.mark({
      scopeKey: 'chat-a', purpose: 'fresh_session_context', owner,
    });
    const second = tracker.mark({
      scopeKey: 'chat-a', purpose: 'poll_answer_continuation', owner,
    });
    let dispatched = false;
    const waiting = tracker.waitUntilDispatchable('chat-a', second).then(() => {
      dispatched = true;
    });
    await Promise.resolve();
    expect(dispatched).toBe(false);

    expect(tracker.consumeResult(first)?.lease).toEqual(first);
    await waiting;
    expect(dispatched).toBe(true);
    expect(tracker.blockingCount('chat-a')).toBe(1);
    expect(tracker.peek('chat-a')?.lease).toEqual(second);
  });

  it('rekeys a live FIFO without invalidating exact tokens held by senders', async () => {
    const tracker = new PendingSystemResultTracker();
    const owner = { managerId: 'manager-a', generation: 1, toolScopeKey: 'lid#1' };
    const first = tracker.mark({
      scopeKey: '15550000001@lid', purpose: 'fresh_session_context', owner,
    });
    const second = tracker.mark({
      scopeKey: '15550000001@lid', purpose: 'poll_answer_continuation', owner,
    });

    tracker.rekeyScope('15550000001@lid', '15550000001@s.whatsapp.net');

    expect(tracker.count('15550000001@lid')).toBe(0);
    expect(tracker.count('15550000001@s.whatsapp.net')).toBe(2);
    expect(tracker.consumeResult(first)?.purpose).toBe('fresh_session_context');
    expect(tracker.cancel(second)).toBe(true);
    expect(tracker.count('15550000001@s.whatsapp.net')).toBe(0);
    await expect(tracker.waitForDrain('15550000001@s.whatsapp.net')).resolves.toBeUndefined();
  });

  it('retains and consumes typed system-turn purposes in FIFO order', () => {
    const tracker = new PendingSystemResultTracker();

    tracker.mark('typed', 'fresh_session_context');
    tracker.mark('typed', 'respawn_continuation');

    expect(tracker.peekPurpose('typed')).toBe('fresh_session_context');
    expect(tracker.consumePurposeIfPending('typed')).toBe('fresh_session_context');
    expect(tracker.peekPurpose('typed')).toBe('respawn_continuation');
    expect(tracker.consumePurposeIfPending('typed')).toBe('respawn_continuation');
    expect(tracker.peekPurpose('typed')).toBeNull();
  });

  it('retains an expired purpose ahead of a newer lease until teardown succeeds', async () => {
    vi.useFakeTimers();
    const tracker = new PendingSystemResultTracker();
    const owner = { managerId: 'manager-a', generation: 1, toolScopeKey: 'typed#1' };
    let finishTeardown: ((succeeded: boolean) => void) | undefined;
    tracker.mark({
      scopeKey: 'typed-timeout',
      purpose: 'auto_compact_silent',
      owner,
      timeoutMs: 10,
      onTimeout: () => new Promise<boolean>((resolve) => { finishTeardown = resolve; }),
    });
    tracker.mark({
      scopeKey: 'typed-timeout', purpose: 'poll_answer_continuation', owner,
    });

    await vi.advanceTimersByTimeAsync(10);

    expect(tracker.peekPurpose('typed-timeout')).toBe('auto_compact_silent');
    expect(tracker.count('typed-timeout')).toBe(2);
    expect(tracker.blockingCount('typed-timeout')).toBe(2);

    finishTeardown?.(true);
    await vi.runAllTimersAsync();

    expect(tracker.count('typed-timeout')).toBe(1);
    expect(tracker.peekPurpose('typed-timeout')).toBe('poll_answer_continuation');
    expect(tracker.consumePurposeIfPending('typed-timeout')).toBe('poll_answer_continuation');
    expect(tracker.count('typed-timeout')).toBe(0);
  });

  it('failed-send reversal removes the newest purpose without erasing an older lease', () => {
    const tracker = new PendingSystemResultTracker();
    tracker.mark('typed-unmark', 'fresh_session_context');
    const failed = tracker.mark('typed-unmark', 'respawn_continuation')!;

    expect(tracker.cancel(failed)).toBe(true);

    expect(tracker.count('typed-unmark')).toBe(1);
    expect(tracker.blockingCount('typed-unmark')).toBe(1);
    expect(tracker.peekPurpose('typed-unmark')).toBe('fresh_session_context');
  });

  it('does not infer a typed owner from direct compatibility-counter mutation', () => {
    const tracker = new PendingSystemResultTracker();
    tracker.counts.set('legacy-only', 1);

    expect(tracker.peekPurpose('legacy-only')).toBeNull();
    expect(tracker.consumePurposeIfPending('legacy-only')).toBeNull();
    expect(tracker.count('legacy-only')).toBe(1);
  });

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

  // ─── cancel ────────────────────────────────────────────────────────────────

  it('cancel(undefined) is a no-op and leaves counts empty', () => {
    const tracker = new PendingSystemResultTracker();

    expect(tracker.cancel(undefined)).toBe(false);

    expect(tracker.counts.size).toBe(0);
    expect(tracker.counts.has('a')).toBe(false);
    expect(tracker.count('a')).toBe(0);
  });

  it('cancelling an already consumed token is idempotent', () => {
    const tracker = new PendingSystemResultTracker();
    const lease = tracker.mark('consumed')!;
    tracker.consumeIfPending('consumed');

    expect(tracker.cancel(lease)).toBe(false);

    expect(tracker.count('consumed')).toBe(0);
  });

  it('cancels an exact live token without removing its sibling', () => {
    const tracker = new PendingSystemResultTracker();
    const first = tracker.mark('a', 'fresh_session_context')!;
    tracker.mark('a', 'respawn_continuation');

    expect(tracker.cancel(first)).toBe(true);

    expect(tracker.counts.get('a')).toBe(1);
    expect(tracker.count('a')).toBe(1);
    expect(tracker.peekPurpose('a')).toBe('respawn_continuation');
  });

  it('cancels a token once and never decrements below zero', () => {
    const tracker = new PendingSystemResultTracker();
    const lease = tracker.mark('a')!;

    expect(tracker.cancel(lease)).toBe(true);
    expect(tracker.count('a')).toBe(0);

    expect(tracker.cancel(lease)).toBe(false);
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
    const lease = tracker.mark('chat-b')!;

    const waiting = tracker.waitForDrain('chat-b');
    tracker.cancel(lease);

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

  it('releases a waiter only after successful deadline teardown removes classification', async () => {
    vi.useFakeTimers();
    const tracker = new PendingSystemResultTracker();
    const owner = { managerId: 'manager-a', generation: 1, toolScopeKey: 'chat-timeout#1' };
    let finishTeardown: ((succeeded: boolean) => void) | undefined;
    tracker.mark({
      scopeKey: 'chat-timeout',
      purpose: 'fresh_session_context',
      owner,
      timeoutMs: 10,
      onTimeout: () => new Promise<boolean>((resolve) => { finishTeardown = resolve; }),
    });

    let released = false;
    const waiting = tracker.waitForDrain('chat-timeout').then(() => { released = true; });
    await vi.advanceTimersByTimeAsync(10);
    expect(released).toBe(false);
    expect(tracker.count('chat-timeout')).toBe(1);

    finishTeardown?.(true);
    await vi.runAllTimersAsync();
    await waiting;

    expect(released).toBe(true);
    expect(tracker.blockingCount('chat-timeout')).toBe(0);
    expect(tracker.count('chat-timeout')).toBe(0);
  });

  it('waits for exact FIFO emptiness when a live lease is rekeyed', async () => {
    const tracker = new PendingSystemResultTracker();
    const lease = tracker.mark('15550000001@lid')!;

    let empty = false;
    const waiting = tracker.waitUntilEmpty('15550000001@lid').then(() => { empty = true; });
    await Promise.resolve();
    expect(empty).toBe(false);

    tracker.rekeyScope('15550000001@lid', '15550000001@s.whatsapp.net');
    expect(tracker.cancel(lease)).toBe(true);

    await waiting;
    expect(empty).toBe(true);
    expect(tracker.count('15550000001@s.whatsapp.net')).toBe(0);
  });

  it('consumes one FIFO result without releasing a later blocking system turn', async () => {
    const tracker = new PendingSystemResultTracker();
    tracker.mark('chat-fifo');
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

  it('cancels one exact send without unblocking a newer system turn', async () => {
    const tracker = new PendingSystemResultTracker();
    const releasedLease = tracker.mark('chat-timeout-reject')!;
    tracker.mark('chat-timeout-reject');

    expect(tracker.cancel(releasedLease)).toBe(true);
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
