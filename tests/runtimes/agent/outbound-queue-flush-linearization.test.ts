import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MIN_SEND_GAP_MS,
  OutboundQueue,
  TOOL_BATCH_MAX_AGE_MS,
} from '../../../src/runtimes/agent/outbound-queue.ts';
import type { DurabilityEngine } from '../../../src/core/durability.ts';
import type { Messenger } from '../../../src/core/types.ts';

const mockLog = vi.hoisted(() => ({} as Record<string, ReturnType<typeof vi.fn>>));

vi.mock('../../../src/logger.ts', async () => {
  const { hoistedLoggerMock } = await import('../../helpers/logger-mock.ts');
  const { createChildLogger } = hoistedLoggerMock(mockLog);
  return { createChildLogger };
});

const CHAT_JID = 'linearization@s.whatsapp.net';

function makeDurabilityStub(): DurabilityEngine {
  let nextId = 0;
  return {
    createOutboundOp: vi.fn(() => ++nextId),
    markSending: vi.fn(),
    markSubmitted: vi.fn(),
    markMaybeSent: vi.fn(),
    markFailedPermanent: vi.fn(),
    markDeferred: vi.fn(),
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

function makeBlockingQueue(): {
  queue: OutboundQueue;
  sent: string[];
  typing: boolean[];
  firstSend: ReturnType<typeof deferred<{ waMessageId: string | null }>>;
} {
  const sent: string[] = [];
  const typing: boolean[] = [];
  const firstSend = deferred<{ waMessageId: string | null }>();
  let sendCount = 0;
  const messenger: Messenger = {
    sendMessage: vi.fn(async (_jid: string, text: string) => {
      sent.push(text);
      sendCount += 1;
      return sendCount === 1 ? firstSend.promise : { waMessageId: null };
    }),
    sendMedia: vi.fn(async () => ({ waMessageId: null })),
    setTyping: vi.fn(async (_jid: string, active: boolean) => {
      typing.push(active);
    }),
  };
  return {
    queue: new OutboundQueue(messenger, CHAT_JID),
    sent,
    typing,
    firstSend,
  };
}

function currentChain(queue: OutboundQueue): Promise<void> {
  return (queue as unknown as { chain: Promise<void> }).chain;
}

describe('OutboundQueue stable completion boundary', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('drains a late text enqueue exactly once instead of synthesizing poison', async () => {
    const { queue, sent, firstSend } = makeBlockingQueue();
    queue.enqueueText('CHUNK-ONE');
    const lateEnqueue = currentChain(queue).then(() => queue.enqueueText('CHUNK-TWO'));
    const completion = queue.flush().then(
      () => ({ kind: 'resolved' as const }),
      (error: unknown) => ({ kind: 'rejected' as const, error }),
    );

    firstSend.resolve({ waMessageId: null });
    await lateEnqueue;
    await vi.advanceTimersByTimeAsync(MIN_SEND_GAP_MS);

    expect(await completion).toEqual({ kind: 'resolved' });
    expect(sent).toEqual(['CHUNK-ONE', 'CHUNK-TWO']);
    expect(queue.isPoisoned()).toBe(false);
    await expect(queue.flush()).resolves.toBeUndefined();
  });

  it('orders one poll after a late text enqueue without poisoning the queue', async () => {
    const { queue, sent, firstSend } = makeBlockingQueue();
    queue.enqueueText('CHUNK-ONE');
    const lateEnqueue = currentChain(queue).then(() => queue.enqueueText('CHUNK-TWO'));
    const sendPoll = vi.fn(async () => undefined);
    const completion = queue.enqueuePoll(sendPoll).then(
      () => ({ kind: 'resolved' as const }),
      (error: unknown) => ({ kind: 'rejected' as const, error }),
    );

    firstSend.resolve({ waMessageId: null });
    await lateEnqueue;
    await vi.advanceTimersByTimeAsync(MIN_SEND_GAP_MS);

    expect(await completion).toEqual({ kind: 'resolved' });
    expect(sent).toEqual(['CHUNK-ONE', 'CHUNK-TWO']);
    expect(sendPoll).toHaveBeenCalledTimes(1);
    expect(queue.isPoisoned()).toBe(false);
  });

  it('freezes complete turn evidence at the same boundary as a late text drain', async () => {
    const { queue, sent, firstSend } = makeBlockingQueue();
    queue.setDurability(makeDurabilityStub());
    queue.beginTurnEvidence('turn-linear');
    queue.enqueueText('CHUNK-ONE');
    const lateEnqueue = currentChain(queue).then(() => queue.enqueueText('CHUNK-TWO'));
    const completion = queue.flushTurnEvidence('turn-linear').then(
      (evidence) => ({ kind: 'resolved' as const, evidence }),
      (error: unknown) => ({ kind: 'rejected' as const, error }),
    );

    firstSend.resolve({ waMessageId: null });
    await lateEnqueue;
    await vi.advanceTimersByTimeAsync(MIN_SEND_GAP_MS);

    expect(await completion).toMatchObject({
      kind: 'resolved',
      evidence: { turnId: 'turn-linear', answerOpIds: [1, 2] },
    });
    expect(sent).toEqual(['CHUNK-ONE', 'CHUNK-TWO']);
    expect(queue.isPoisoned()).toBe(false);
  });

  it('absorbs a late streaming buffer before normal flush completion', async () => {
    const { queue, sent, firstSend } = makeBlockingQueue();
    queue.enqueueText('CHUNK-ONE');
    const lateEnqueue = currentChain(queue).then(() => queue.enqueueStreamingText('late stream'));
    const completion = queue.flush();

    firstSend.resolve({ waMessageId: null });
    await lateEnqueue;
    await vi.advanceTimersByTimeAsync(MIN_SEND_GAP_MS);

    await expect(completion).resolves.toBeUndefined();
    expect(sent).toEqual(['CHUNK-ONE', 'late stream']);
    expect(queue.hasPendingWork()).toBe(false);
  });

  it('absorbs a late tool buffer before normal flush completion', async () => {
    const { queue, sent, firstSend } = makeBlockingQueue();
    queue.enqueueText('CHUNK-ONE');
    const lateEnqueue = currentChain(queue).then(() => {
      queue.enqueueToolUpdate({ category: 'running', detail: 'late status' });
    });
    const completion = queue.flush();

    firstSend.resolve({ waMessageId: null });
    await lateEnqueue;
    await vi.advanceTimersByTimeAsync(MIN_SEND_GAP_MS);

    await expect(completion).resolves.toBeUndefined();
    expect(sent).toEqual(['CHUNK-ONE', '🔧 Running:\n  • late status']);
    expect(queue.hasPendingWork()).toBe(false);
  });

  it('waits for an accepted redirected tool-status send at the stable boundary', async () => {
    const redirectSend = deferred<{ waMessageId: string | null }>();
    const messenger: Messenger = {
      sendMessage: vi.fn(() => redirectSend.promise),
      sendMedia: vi.fn(async () => ({ waMessageId: null })),
      setTyping: vi.fn(async () => undefined),
    };
    const queue = new OutboundQueue(messenger, CHAT_JID);
    queue.setToolUpdateRedirectJid('status@s.whatsapp.net');
    queue.enqueueToolUpdate({ category: 'running', detail: 'redirected status' });
    let settled = false;
    const completion = queue.flush().finally(() => { settled = true; });

    await vi.advanceTimersByTimeAsync(0);
    expect(messenger.sendMessage).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);

    redirectSend.resolve({ waMessageId: null });
    await expect(completion).resolves.toBeUndefined();
    expect(queue.hasPendingWork()).toBe(false);
  });

  it('rejects every content producer after shutdown begins and emits one bounded warning', async () => {
    const { queue, sent, typing, firstSend } = makeBlockingQueue();
    queue.enqueueText('accepted before shutdown');
    const shutdown = queue.shutdown();

    queue.enqueueText('rejected text');
    queue.enqueueStreamingText('rejected stream');
    queue.enqueueResultText('rejected result');
    queue.enqueueToolUpdate({ category: 'running', detail: 'rejected tool' });
    queue.enqueueProgressUpdate({ type: 'thinking_long', gapMs: 10_000 }, 'Worker');
    queue.indicateTyping();

    firstSend.resolve({ waMessageId: null });
    await vi.advanceTimersByTimeAsync(TOOL_BATCH_MAX_AGE_MS + (10 * MIN_SEND_GAP_MS));
    await shutdown;
    await vi.advanceTimersByTimeAsync(TOOL_BATCH_MAX_AGE_MS);

    expect(sent).toEqual(['accepted before shutdown']);
    expect(queue.hasPendingWork()).toBe(false);
    expect(typing).toEqual([]);
    expect(mockLog.warn).toHaveBeenCalledTimes(1);
    expect(mockLog.warn).toHaveBeenCalledWith(
      { queueState: expect.stringMatching(/closing|closed/) },
      'outbound enqueue rejected after queue closure',
    );
  });

  it('rejects polls with a typed error after shutdown and never calls the poll sender', async () => {
    const messenger: Messenger = {
      sendMessage: vi.fn(async () => ({ waMessageId: null })),
      sendMedia: vi.fn(async () => ({ waMessageId: null })),
      setTyping: vi.fn(async () => undefined),
    };
    const queue = new OutboundQueue(messenger, CHAT_JID);
    await queue.shutdown();
    const sendPoll = vi.fn(async () => undefined);

    await expect(queue.enqueuePoll(sendPoll)).rejects.toMatchObject({
      name: 'OutboundQueueClosedError',
      code: 'OUTBOUND_QUEUE_CLOSED',
    });
    expect(sendPoll).not.toHaveBeenCalled();
  });

  it('retains the same genuine drain failure as sticky poison', async () => {
    const messenger: Messenger = {
      sendMessage: vi.fn(async () => ({ waMessageId: null })),
      sendMedia: vi.fn(async () => ({ waMessageId: null })),
      setTyping: vi.fn(async () => undefined),
    };
    const queue = new OutboundQueue(messenger, CHAT_JID);
    const realError = new Error('durability write failed');
    (queue as unknown as { sendWithPacing: (chunk: unknown) => Promise<void> }).sendWithPacing =
      vi.fn(async () => { throw realError; });

    queue.enqueueText('queued answer');

    await expect(queue.flush()).rejects.toBe(realError);
    expect(queue.isPoisoned()).toBe(true);
    await expect(queue.flush()).rejects.toBe(realError);
  });
});
