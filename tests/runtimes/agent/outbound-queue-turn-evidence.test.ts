import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ControlQueue } from '../../../src/runtimes/agent/control-queue.ts';
import { OutboundQueue, TOOL_BATCH_DELAY_MS } from '../../../src/runtimes/agent/outbound-queue.ts';
import { toConversationKey } from '../../../src/core/conversation-key.ts';
import type { DurabilityEngine } from '../../../src/core/durability.ts';
import type { Messenger } from '../../../src/core/types.ts';

vi.mock('../../../src/logger.ts', () => ({
  createChildLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const CHAT_JID = 'evidence@s.whatsapp.net';

function makeMessenger(): Messenger {
  return {
    sendMessage: vi.fn(async () => ({ waMessageId: null })),
    sendMedia: vi.fn(async () => ({ waMessageId: null })),
    setTyping: vi.fn(async () => undefined),
  };
}

function makeDurability(): DurabilityEngine {
  let nextId = 0;
  return {
    createOutboundOp: vi.fn(() => ++nextId),
    markSending: vi.fn(),
    markSubmitted: vi.fn(),
    markMaybeSent: vi.fn(),
    markTerminal: vi.fn(),
  } as unknown as DurabilityEngine;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function settle<T>(promise: Promise<T>): Promise<T> {
  await vi.runAllTimersAsync();
  return promise;
}

describe('OutboundQueue turn delivery evidence', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    const leakedTimers = vi.getTimerCount();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    expect(leakedTimers, 'turn-evidence test leaked a timer').toBe(0);
  });

  it('waits for async outbound-op creation before returning evidence', async () => {
    const durability = makeDurability();
    const queue = new OutboundQueue(makeMessenger(), CHAT_JID);
    queue.setDurability(durability);
    queue.beginTurnEvidence('turn-async');

    queue.enqueueText('answer');
    expect(durability.createOutboundOp).not.toHaveBeenCalled();

    const evidence = await settle(queue.flushTurnEvidence('turn-async'));
    expect(evidence).toEqual({
      turnId: 'turn-async',
      answerOpIds: [1],
      lifecycleOpIds: [],
      statusOpIds: [],
    });
  });

  it('keeps lifecycle and built-in status narration out of answer evidence', async () => {
    const durability = makeDurability();
    const queue = new OutboundQueue(makeMessenger(), CHAT_JID);
    queue.setDurability(durability);
    queue.setProgressFloorMs(0);
    queue.beginTurnEvidence('turn-roles');

    queue.enqueueText('fallback notice', 'lifecycle');
    queue.enqueueProgressUpdate({ type: 'thinking_long', gapMs: 10_000 }, 'Soup');
    queue.enqueueToolUpdate({ category: 'running', detail: 'Checking delivery' });
    queue.enqueueText('real answer');

    const evidencePromise = queue.flushTurnEvidence('turn-roles');
    await vi.advanceTimersByTimeAsync(TOOL_BATCH_DELAY_MS);
    const evidence = await settle(evidencePromise);

    expect(evidence.answerOpIds).toEqual([3]);
    expect(evidence.lifecycleOpIds).toEqual([1]);
    expect(evidence.statusOpIds).toEqual([2, 4]);
  });

  it('classifies the status-cap notice as status evidence', async () => {
    const queue = new OutboundQueue(makeMessenger(), CHAT_JID);
    queue.setDurability(makeDurability());
    queue.setMaxStatusMessagesPerTurn(0);
    queue.beginTurnEvidence('turn-status-cap');

    queue.enqueueToolUpdate({ category: 'running', detail: 'Over budget' });

    const evidence = await settle(queue.flushTurnEvidence('turn-status-cap'));
    expect(evidence.answerOpIds).toEqual([]);
    expect(evidence.statusOpIds).toEqual([1]);
  });

  it('returns every op id from a multi-chunk answer in send order', async () => {
    const queue = new OutboundQueue(makeMessenger(), CHAT_JID);
    queue.setDurability(makeDurability());
    queue.beginTurnEvidence('turn-chunks');

    queue.enqueueText(`${'a'.repeat(4000)} ${'b'.repeat(100)}`);

    const evidence = await settle(queue.flushTurnEvidence('turn-chunks'));
    expect(evidence.answerOpIds).toEqual([1, 2]);
  });

  it('uses enqueue-time attribution when older queued work runs during a new turn', async () => {
    const firstSend = deferred<{ waMessageId: null }>();
    const messenger = makeMessenger();
    vi.mocked(messenger.sendMessage)
      .mockImplementationOnce(() => firstSend.promise)
      .mockResolvedValue({ waMessageId: null });
    const queue = new OutboundQueue(messenger, CHAT_JID);
    queue.setDurability(makeDurability());

    queue.enqueueText('chain blocker');
    await vi.advanceTimersByTimeAsync(0);
    queue.beginTurnEvidence('turn-old');
    queue.enqueueText('old queued answer');
    queue.abortTurn();
    queue.beginTurnEvidence('turn-new');
    queue.enqueueText('new answer');

    const evidencePromise = queue.flushTurnEvidence('turn-new');
    firstSend.resolve({ waMessageId: null });
    const evidence = await settle(evidencePromise);

    expect(evidence.answerOpIds).toEqual([3]);
  });

  it('does not reassign aborted queued work when the external turn id is reused', async () => {
    const firstSend = deferred<{ waMessageId: null }>();
    const messenger = makeMessenger();
    vi.mocked(messenger.sendMessage)
      .mockImplementationOnce(() => firstSend.promise)
      .mockResolvedValue({ waMessageId: null });
    const queue = new OutboundQueue(messenger, CHAT_JID);
    queue.setDurability(makeDurability());

    queue.enqueueText('chain blocker');
    await vi.advanceTimersByTimeAsync(0);
    queue.beginTurnEvidence('turn-reused');
    queue.enqueueText('aborted old answer');
    queue.abortTurn();
    queue.beginTurnEvidence('turn-reused');
    queue.enqueueText('replacement answer');

    const evidencePromise = queue.flushTurnEvidence('turn-reused');
    firstSend.resolve({ waMessageId: null });
    const evidence = await settle(evidencePromise);

    expect(evidence.answerOpIds).toEqual([3]);
  });

  it('snapshots delivery and durability identity before a delayed send executes', async () => {
    const firstSend = deferred<{ waMessageId: null }>();
    const messenger = makeMessenger();
    vi.mocked(messenger.sendMessage)
      .mockImplementationOnce(() => firstSend.promise)
      .mockResolvedValue({ waMessageId: null });
    const durability = makeDurability();
    const queue = new OutboundQueue(messenger, CHAT_JID);
    queue.setDurability(durability);

    queue.enqueueText('chain blocker');
    await vi.advanceTimersByTimeAsync(0);
    queue.beginTurnEvidence('turn-identity');
    queue.setInboundSeq(41);
    queue.enqueueText('old identity');

    const newJid = 'evidence-new@s.whatsapp.net';
    queue.updateDeliveryJid(newJid);
    queue.setInboundSeq(99);
    queue.enqueueText('new identity');

    const evidencePromise = queue.flushTurnEvidence('turn-identity');
    firstSend.resolve({ waMessageId: null });
    const evidence = await settle(evidencePromise);

    expect(evidence.answerOpIds).toEqual([2, 3]);
    expect(durability.createOutboundOp).toHaveBeenNthCalledWith(2, expect.objectContaining({
      chatJid: CHAT_JID,
      conversationKey: toConversationKey(CHAT_JID),
      sourceInboundSeq: 41,
    }));
    expect(durability.createOutboundOp).toHaveBeenNthCalledWith(3, expect.objectContaining({
      chatJid: newJid,
      conversationKey: toConversationKey(newJid),
      sourceInboundSeq: 99,
    }));
    expect(vi.mocked(messenger.sendMessage).mock.calls.map(([jid, text]) => [jid, text])).toEqual([
      [CHAT_JID, 'chain blocker'],
      [CHAT_JID, 'old identity'],
      [newJid, 'new identity'],
    ]);
  });

  it('retains evidence across an ordinary flush', async () => {
    const queue = new OutboundQueue(makeMessenger(), CHAT_JID);
    queue.setDurability(makeDurability());
    queue.beginTurnEvidence('turn-ordinary-flush');
    queue.enqueueText('answer before poll');

    await settle(queue.flush());
    const evidence = await queue.flushTurnEvidence('turn-ordinary-flush');

    expect(evidence.answerOpIds).toEqual([1]);
  });

  it('fails closed on overlapping and mismatched turn ids while remaining idempotent', async () => {
    const queue = new OutboundQueue(makeMessenger(), CHAT_JID);

    expect(() => queue.beginTurnEvidence('turn-a')).not.toThrow();
    expect(() => queue.beginTurnEvidence('turn-a')).not.toThrow();
    expect(() => queue.beginTurnEvidence('turn-b')).toThrow(/turn-a.*turn-b|turn-b.*turn-a/);
    await expect(queue.flushTurnEvidence('turn-b')).rejects.toThrow(/turn-a.*turn-b|turn-b.*turn-a/);

    const first = await queue.flushTurnEvidence('turn-a');
    const repeated = await queue.flushTurnEvidence('turn-a');
    expect(repeated).toEqual(first);
    expect(repeated).not.toBe(first);

    expect(() => queue.beginTurnEvidence('turn-b')).not.toThrow();
    await expect(queue.flushTurnEvidence('turn-b')).resolves.toMatchObject({ turnId: 'turn-b' });
  });

  it('shares one completion across concurrent same-turn flushes', async () => {
    const queue = new OutboundQueue(makeMessenger(), CHAT_JID);
    queue.setDurability(makeDurability());
    queue.beginTurnEvidence('turn-concurrent');
    queue.enqueueText('answer');

    const joined = Promise.all([
      queue.flushTurnEvidence('turn-concurrent'),
      queue.flushTurnEvidence('turn-concurrent'),
    ]).then(
      (evidence) => evidence,
      (error: unknown) => error,
    );
    await expect(queue.flushTurnEvidence('wrong-turn')).rejects.toThrow(/turn-concurrent.*wrong-turn/);
    await vi.runAllTimersAsync();
    const outcome = await joined;

    expect(outcome).toEqual([
      { turnId: 'turn-concurrent', answerOpIds: [1], lifecycleOpIds: [], statusOpIds: [] },
      { turnId: 'turn-concurrent', answerOpIds: [1], lifecycleOpIds: [], statusOpIds: [] },
    ]);
    if (Array.isArray(outcome)) {
      expect(outcome[0]).not.toBe(outcome[1]);
    }
  });

  it('returns frozen copies and empty lists when durability is unavailable', async () => {
    const queue = new OutboundQueue(makeMessenger(), CHAT_JID);
    queue.beginTurnEvidence('turn-no-durability');
    queue.enqueueText('sent without durability');

    const evidence = await settle(queue.flushTurnEvidence('turn-no-durability'));

    expect(evidence).toEqual({
      turnId: 'turn-no-durability',
      answerOpIds: [],
      lifecycleOpIds: [],
      statusOpIds: [],
    });
    expect(Object.isFrozen(evidence)).toBe(true);
    expect(Object.isFrozen(evidence.answerOpIds)).toBe(true);
    expect(() => (evidence.answerOpIds as number[]).push(99)).toThrow();
  });

  it('makes a first-op durability failure observable to ordinary flush', async () => {
    const failure = Object.assign(new Error('disk I/O error'), { code: 'SQLITE_IOERR' });
    const messenger = makeMessenger();
    const durability = makeDurability();
    vi.mocked(durability.createOutboundOp).mockImplementation(() => {
      throw failure;
    });
    const queue = new OutboundQueue(messenger, CHAT_JID);
    queue.setDurability(durability);
    queue.beginTurnEvidence('turn-first-op-flush');
    queue.enqueueText('must remain blocked');

    const outcome = queue.flush().then(
      () => 'resolved' as const,
      (error: unknown) => error,
    );
    await vi.runAllTimersAsync();
    expect(await outcome).toBe(failure);

    expect(queue.hasPendingWork()).toBe(true);
    expect(messenger.sendMessage).not.toHaveBeenCalled();
  });

  it('does not consume empty evidence after first-op durability failure', async () => {
    const failure = Object.assign(new Error('disk I/O error'), { code: 'SQLITE_IOERR' });
    const durability = makeDurability();
    vi.mocked(durability.createOutboundOp).mockImplementation(() => {
      throw failure;
    });
    const queue = new OutboundQueue(makeMessenger(), CHAT_JID);
    queue.setDurability(durability);
    queue.beginTurnEvidence('turn-first-op-evidence');
    queue.enqueueText('no false empty receipt');

    const outcome = queue.flushTurnEvidence('turn-first-op-evidence').then(
      () => 'resolved' as const,
      (error: unknown) => error,
    );
    await vi.runAllTimersAsync();
    expect(await outcome).toBe(failure);

    expect(() => queue.beginTurnEvidence('replacement')).toThrow(/turn-first-op-evidence.*replacement/);
  });

  it('keeps partial evidence and queued remainder poisoned after a mid-batch durability failure', async () => {
    const failure = Object.assign(new Error('disk I/O error'), { code: 'SQLITE_IOERR' });
    const messenger = makeMessenger();
    const durability = makeDurability();
    let createCalls = 0;
    vi.mocked(durability.createOutboundOp).mockImplementation(() => {
      createCalls += 1;
      if (createCalls === 2) throw failure;
      return createCalls;
    });
    const queue = new OutboundQueue(messenger, CHAT_JID);
    queue.setDurability(durability);
    queue.beginTurnEvidence('turn-partial');
    queue.enqueueText(`${'a'.repeat(4000)} ${'b'.repeat(4000)} ${'c'.repeat(100)}`);

    const outcome = queue.flushTurnEvidence('turn-partial').then(
      () => 'resolved' as const,
      (error: unknown) => error,
    );
    await vi.runAllTimersAsync();
    expect(await outcome).toBe(failure);

    expect(createCalls).toBe(2);
    expect(messenger.sendMessage).toHaveBeenCalledTimes(1);
    expect(queue.hasPendingWork()).toBe(true);
    expect(() => queue.beginTurnEvidence('replacement')).toThrow(/turn-partial.*replacement/);

    queue.abortTurn();
    queue.beginTurnEvidence('replacement');
    queue.enqueueText('must not retry or inherit failed work');

    await expect(queue.flushTurnEvidence('replacement')).rejects.toBe(failure);
    expect(createCalls).toBe(2);
    expect(messenger.sendMessage).toHaveBeenCalledTimes(1);
    expect(queue.hasPendingWork()).toBe(true);
  });

  it('clears abandoned and shutdown evidence without reassigning it', async () => {
    const queue = new OutboundQueue(makeMessenger(), CHAT_JID);
    queue.setDurability(makeDurability());
    queue.beginTurnEvidence('turn-aborted');
    queue.abortTurn();

    await expect(queue.flushTurnEvidence('turn-aborted')).rejects.toThrow(/turn-aborted/);

    queue.beginTurnEvidence('turn-shutdown');
    await queue.shutdown();
    await expect(queue.flushTurnEvidence('turn-shutdown')).rejects.toThrow(/turn-shutdown/);
  });

  it('cancels crash presentation state without destroying the active delivery-evidence epoch', async () => {
    const queue = new OutboundQueue(makeMessenger(), CHAT_JID);
    queue.setDurability(makeDurability());
    queue.beginTurnEvidence('turn-crash-preserved');
    queue.enqueueText('answer accepted before the child crashed');

    queue.abortTurn({ preserveEvidence: true });

    await expect(queue.flushTurnEvidence('turn-crash-preserved')).resolves.toEqual({
      turnId: 'turn-crash-preserved',
      answerOpIds: [1],
      lifecycleOpIds: [],
      statusOpIds: [],
    });
  });
});

describe('ControlQueue turn delivery evidence', () => {
  it('returns deterministic empty immutable evidence without sending', async () => {
    const messenger = makeMessenger();
    const queue = new ControlQueue(CHAT_JID, messenger);

    queue.beginTurnEvidence('control-turn');
    queue.enqueueText('buffered only');
    const evidence = await queue.flushTurnEvidence('control-turn');

    expect(evidence).toEqual({
      turnId: 'control-turn',
      answerOpIds: [],
      lifecycleOpIds: [],
      statusOpIds: [],
    });
    expect(Object.isFrozen(evidence)).toBe(true);
    expect(messenger.sendMessage).not.toHaveBeenCalled();
  });
});
