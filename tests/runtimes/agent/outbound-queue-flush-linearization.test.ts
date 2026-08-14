import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { OutboundQueue, MIN_SEND_GAP_MS } from '../../../src/runtimes/agent/outbound-queue.ts';
import type { Messenger } from '../../../src/core/types.ts';
import type { DurabilityEngine } from '../../../src/core/durability.ts';

function makeDurabilityStub(): DurabilityEngine {
  let nextId = 0;
  return {
    createOutboundOp: vi.fn(() => { nextId += 1; return nextId; }),
    markSending: vi.fn(),
    markSubmitted: vi.fn(),
    markMaybeSent: vi.fn(),
    markFailedPermanent: vi.fn(),
    markDeferred: vi.fn(),
    markTerminal: vi.fn(),
  } as unknown as DurabilityEngine;
}

// F-01 regression (outbound-flush linearization race): OutboundQueue.flush() /
// enqueuePoll() await a single snapshot of `this.chain` then call
// assertDrainComplete(). A late enqueue that lands in the window after the
// awaited drain set `sending=false` (and after the snapshot resolved) starts a
// NEW legitimate drain; the stale assert misreads that new send as the
// impossible "Outbound queue flush completed with pending send work" condition
// and PERMANENTLY poisons the queue. The production error signature has no
// current-main regression test — this is it.

const CHAT_JID = 'test@s.whatsapp.net';

function makeMessenger(): { messenger: Messenger; calls: string[] } {
  const calls: string[] = [];
  const messenger = {
    sendMessage: vi.fn(),
    sendMedia: vi.fn(async () => ({ waMessageId: null })),
    setTyping: vi.fn(async () => {}),
  } as unknown as Messenger;
  return { messenger, calls };
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

describe('OutboundQueue flush linearization (F-01)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('does not falsely poison when a late enqueue starts a new drain while flush awaits the prior chain', async () => {
    const { messenger, calls } = makeMessenger();
    const d1 = deferred<{ waMessageId: string | null }>();
    let n = 0;
    vi.mocked(messenger.sendMessage).mockImplementation(((_jid: string, text: string) => {
      calls.push(text);
      n += 1;
      // First send is held so flush suspends on the in-flight chain; the second
      // (the late enqueue) resolves normally after its pacing gap.
      return n === 1 ? d1.promise : Promise.resolve({ waMessageId: null });
    }) as unknown as Messenger['sendMessage']);

    const queue = new OutboundQueue(messenger, CHAT_JID);

    queue.enqueueText('CHUNK-ONE');                 // drain C1 begins, held on d1
    // Capture the in-flight chain and register the late enqueue as a reaction on
    // it BEFORE flush registers its own `await this.chain` — so on C1 resolution
    // (drain1 has set sending=false) the late enqueue runs first and starts C2,
    // exactly reproducing the race window the stale assert misreads.
    const c1 = (queue as unknown as { chain: Promise<void> }).chain;
    const late = c1.then(() => { queue.enqueueText('CHUNK-TWO'); });

    let flushErr: unknown;
    const flushP = queue.flush().then(() => 'ok', (e) => { flushErr = e; return 'err'; });

    d1.resolve({ waMessageId: null });              // send #1 done → C1 resolves → late enqueue → C2 starts
    await late;
    await vi.advanceTimersByTimeAsync(MIN_SEND_GAP_MS);  // clear chunk2 pacing + let it send

    const outcome = await flushP;

    expect(flushErr, 'flush must NOT poison on a legitimate late enqueue (F-01)').toBeUndefined();
    expect(outcome).toBe('ok');
    expect(calls).toEqual(['CHUNK-ONE', 'CHUNK-TWO']);        // both delivered exactly once, in order
    await expect(queue.flush()).resolves.toBeUndefined();     // second flush inherits no synthetic poison
  });

  it('enqueuePoll obeys the same quiescence contract — a late enqueue does not block the poll send', async () => {
    const { messenger, calls } = makeMessenger();
    const d1 = deferred<{ waMessageId: string | null }>();
    let n = 0;
    vi.mocked(messenger.sendMessage).mockImplementation(((_jid: string, text: string) => {
      calls.push(text);
      n += 1;
      return n === 1 ? d1.promise : Promise.resolve({ waMessageId: null });
    }) as unknown as Messenger['sendMessage']);

    const queue = new OutboundQueue(messenger, CHAT_JID);
    queue.enqueueText('CHUNK-ONE');
    const c1 = (queue as unknown as { chain: Promise<void> }).chain;
    const late = c1.then(() => { queue.enqueueText('CHUNK-TWO'); });

    const poll = vi.fn(async () => {});
    let pollErr: unknown;
    const pollP = queue.enqueuePoll(poll).then(() => 'ok', (e) => { pollErr = e; return 'err'; });

    d1.resolve({ waMessageId: null });
    await late;
    await vi.advanceTimersByTimeAsync(MIN_SEND_GAP_MS);
    const outcome = await pollP;

    expect(pollErr, 'enqueuePoll must NOT poison on a legitimate late enqueue (F-01)').toBeUndefined();
    expect(outcome).toBe('ok');
    expect(poll).toHaveBeenCalledTimes(1);                    // the poll send still ran
    expect(calls).toEqual(['CHUNK-ONE', 'CHUNK-TWO']);
  });

  it('turn-evidence flush obeys the same contract — a late enqueue does not poison the evidence', async () => {
    const { messenger, calls } = makeMessenger();
    const d1 = deferred<{ waMessageId: string | null }>();
    let n = 0;
    vi.mocked(messenger.sendMessage).mockImplementation(((_jid: string, text: string) => {
      calls.push(text);
      n += 1;
      return n === 1 ? d1.promise : Promise.resolve({ waMessageId: null });
    }) as unknown as Messenger['sendMessage']);

    const queue = new OutboundQueue(messenger, CHAT_JID);
    queue.setDurability(makeDurabilityStub());
    queue.beginTurnEvidence('turn-f01');

    queue.enqueueText('CHUNK-ONE');
    const c1 = (queue as unknown as { chain: Promise<void> }).chain;
    const late = c1.then(() => { queue.enqueueText('CHUNK-TWO'); });

    let evErr: unknown;
    const evP = queue.flushTurnEvidence('turn-f01').then((e) => e, (e) => { evErr = e; return null; });

    d1.resolve({ waMessageId: null });
    await late;
    await vi.advanceTimersByTimeAsync(MIN_SEND_GAP_MS);
    const evidence = await evP;

    expect(evErr, 'turn-evidence flush must NOT poison on a legitimate late enqueue (F-01)').toBeUndefined();
    expect(evidence).not.toBeNull();
    expect(calls).toEqual(['CHUNK-ONE', 'CHUNK-TWO']);
  });

  it('still surfaces a REAL drain failure (not the synthetic poison) and keeps it sticky / fail-closed', async () => {
    const { messenger } = makeMessenger();
    const queue = new OutboundQueue(messenger, CHAT_JID);
    const internals = queue as unknown as { sendWithPacing: (c: unknown) => Promise<void> };
    const realError = new Error('durability write exploded');
    internals.sendWithPacing = vi.fn(async () => { throw realError; });

    queue.enqueueText('X');
    // flush must reject with the REAL error — proving the fix did not mask genuine
    // failures behind the removed synthetic "pending send work" assertion.
    const err1 = await queue.flush().then(() => null, (e) => e);
    expect(err1).toBe(realError);
    expect((err1 as Error).message).not.toContain('pending send work');
    // sticky + fail-closed: a poisoned queue re-throws the same real error.
    const err2 = await queue.flush().then(() => null, (e) => e);
    expect(err2).toBe(realError);
  });
});
