import { AsyncLocalStorage } from 'node:async_hooks';
import { describe, it, expect, vi } from 'vitest';
import {
  TurnQueue,
  type QueuedTurn,
  type TurnRejectReason,
} from '../../../src/runtimes/agent/turn-queue.ts';
import {
  FinalTransportAuthorityGate,
  getTransportInboundContext,
  registerTrustedInbound,
} from '../../../src/transport/operations-authority-gate.ts';
import type { TransportAdmissionInput } from '../../../src/transport/operations-authority-client.ts';

vi.mock('../../../src/logger.ts', async () => (await import('../../helpers/logger-mock.ts')).loggerMock());

function makeTurn(overrides: Partial<QueuedTurn> = {}): QueuedTurn {
  return {
    sourceMessageId: 'wamid-test',
    receivedAtUnixSeconds: 1_780_000_000,
    conversationKey: 'chat',
    chatJid: 'chat@s.whatsapp.net',
    senderJid: 'sender@s.whatsapp.net',
    senderName: 'Test User',
    text: 'hello',
    isGroup: false,
    contentType: 'text',
    ...overrides,
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('TurnQueue', () => {
  it('settles a turn only after its processor and error finalizer finish', async () => {
    // Break caught: protected inbound leases close at queue admission or before
    // an error path has reached its terminal finalizer.
    const processorRelease = deferred();
    const finalizerRelease = deferred();
    const settled = vi.fn();
    const finalizer = vi.fn(async () => finalizerRelease.promise);
    const queue = new TurnQueue({ onProcessorError: finalizer });
    queue.setProcessor(async () => {
      await processorRelease.promise;
      throw new Error('provider failed');
    });
    queue.enqueue(makeTurn({ onSettled: settled }));

    await vi.waitFor(() => expect(queue.isProcessing).toBe(true));
    expect(settled).not.toHaveBeenCalled();
    processorRelease.resolve();
    await vi.waitFor(() => expect(finalizer).toHaveBeenCalledTimes(1));
    expect(settled).not.toHaveBeenCalled();
    finalizerRelease.resolve();
    await queue.idle();
    expect(settled).toHaveBeenCalledTimes(1);
  });

  it('settles an admission rejection immediately', () => {
    // Break caught: a queue-full/cancelled turn retains an authority lease even
    // though it can no longer produce a provider reply.
    const settled = vi.fn();
    const queue = new TurnQueue({ maxDepth: 0 });
    expect(queue.enqueue(makeTurn({ onSettled: settled }))).toBe(false);
    expect(settled).toHaveBeenCalledTimes(1);
  });

  it('settles a throwing rejection and releases the turn for a fresh trusted admission', async () => {
    const rejectionError = new Error('rejection callback failed');
    const settled = vi.fn();
    const turn = makeTurn({ text: 'reused-after-reject', chatJid: 'reused@s.whatsapp.net', onSettled: settled });
    const rejectedQueue = new TurnQueue({
      maxDepth: 0,
      onReject: () => {
        throw rejectionError;
      },
    });

    await expect(registerTrustedInbound({
      registerInbound: vi.fn(async () => ({ kind: 'inbound' as const, automationOperations: [], automationHolds: [] })),
      closeInbound: vi.fn(async () => undefined),
    }, {
      eventId: 'A',
      sender: 'a@s.whatsapp.net',
      conversation: 'reused@s.whatsapp.net',
      receivedAt: '2026-11-03T00:00:00.000Z',
      content: 'rejected',
    }, () => rejectedQueue.enqueue(turn))).rejects.toThrow(rejectionError);
    expect(settled).toHaveBeenCalledTimes(1);

    const admitted = vi.fn<(input: TransportAdmissionInput) => Promise<{ attemptId: string; payloadDigest: string }>>(
      async () => ({ attemptId: 'attempt', payloadDigest: 'sha256:payload' }),
    );
    const replacementQueue = new TurnQueue();
    const gate = new FinalTransportAuthorityGate({
      admit: admitted,
      recordReceipt: vi.fn(async () => undefined),
    });
    await registerTrustedInbound({
      registerInbound: vi.fn(async () => ({ kind: 'inbound' as const, automationOperations: [], automationHolds: [] })),
      closeInbound: vi.fn(async () => undefined),
    }, {
      eventId: 'B',
      sender: 'b@s.whatsapp.net',
      conversation: 'reused@s.whatsapp.net',
      receivedAt: '2026-11-03T00:00:00.000Z',
      content: 'fresh',
    }, () => {
      expect(replacementQueue.enqueue(turn)).toBe(true);
    });
    replacementQueue.setProcessor(async (queued) => {
      await gate.admit({ recipient: queued.chatJid, content: { text: queued.text } });
    });
    await replacementQueue.idle();

    expect(admitted).toHaveBeenCalledWith(expect.objectContaining({
      recipient: 'reused@s.whatsapp.net', context: { inbound_event_id: 'B' },
    }));
    expect(settled).toHaveBeenCalledTimes(2);
  });

  it('keeps each queued trusted inbound context through admission, finalization, and settlement', async () => {
    const firstStarted = deferred();
    const firstRelease = deferred();
    const admitted = vi.fn<(input: TransportAdmissionInput) => Promise<{ attemptId: string; payloadDigest: string }>>(
      async () => ({ attemptId: 'attempt', payloadDigest: 'sha256:payload' }),
    );
    const finalizerContexts: Array<string | undefined> = [];
    const settledContexts: Array<string | undefined> = [];
    const queue = new TurnQueue({
      onProcessorError: async () => {
        finalizerContexts.push(getTransportInboundContext()?.inbound_event_id);
      },
    });
    const gate = new FinalTransportAuthorityGate({
      admit: admitted,
      recordReceipt: vi.fn(async () => undefined),
    });
    queue.setProcessor(async (turn) => {
      if (turn.text === 'A') {
        firstStarted.resolve();
        await firstRelease.promise;
      }
      await gate.admit({ recipient: turn.chatJid, content: { text: turn.text } });
      if (turn.text === 'B') throw new Error('B finalization');
    });

    const inbound = {
      registerInbound: vi.fn(async () => ({ kind: 'inbound' as const, automationOperations: [], automationHolds: [] })),
      closeInbound: vi.fn(async () => undefined),
    };
    const enqueueTrusted = async (eventId: string, recipient: string): Promise<void> => {
      await registerTrustedInbound(inbound, {
        eventId,
        sender: `${eventId}@s.whatsapp.net`,
        conversation: recipient,
        receivedAt: '2026-11-03T00:00:00.000Z',
        content: eventId,
      }, () => {
        expect(queue.enqueue(makeTurn({
          text: eventId,
          chatJid: recipient,
          senderJid: `${eventId}@s.whatsapp.net`,
          onSettled: () => settledContexts.push(getTransportInboundContext()?.inbound_event_id),
        }))).toBe(true);
      });
    };

    await enqueueTrusted('A', 'a@s.whatsapp.net');
    await firstStarted.promise;
    expect(inbound.closeInbound).toHaveBeenCalledWith({ eventId: 'A' });
    await enqueueTrusted('B', 'b@s.whatsapp.net');
    expect(inbound.closeInbound).toHaveBeenCalledWith({ eventId: 'B' });
    firstRelease.resolve();
    await queue.idle();

    expect(admitted).toHaveBeenNthCalledWith(1, expect.objectContaining({
      recipient: 'a@s.whatsapp.net', context: { inbound_event_id: 'A' },
    }));
    expect(admitted).toHaveBeenNthCalledWith(2, expect.objectContaining({
      recipient: 'b@s.whatsapp.net', context: { inbound_event_id: 'B' },
    }));
    expect(finalizerContexts).toEqual(['B']);
    expect(settledContexts).toEqual(['A', 'B']);
  });

  it('clears trusted inbound context for a queued synthetic turn', async () => {
    const firstStarted = deferred();
    const firstRelease = deferred();
    const admitted = vi.fn<(input: TransportAdmissionInput) => Promise<{ attemptId: string; payloadDigest: string }>>(
      async () => ({ attemptId: 'attempt', payloadDigest: 'sha256:payload' }),
    );
    const queue = new TurnQueue();
    const gate = new FinalTransportAuthorityGate({
      admit: admitted,
      recordReceipt: vi.fn(async () => undefined),
    });
    queue.setProcessor(async (turn) => {
      if (turn.text === 'trusted') {
        firstStarted.resolve();
        await firstRelease.promise;
      }
      await gate.admit({ recipient: turn.chatJid, content: { text: turn.text } });
    });

    await registerTrustedInbound({
      registerInbound: vi.fn(async () => ({ kind: 'inbound' as const, automationOperations: [], automationHolds: [] })),
      closeInbound: vi.fn(async () => undefined),
    }, {
      eventId: 'trusted',
      sender: 'trusted@s.whatsapp.net',
      conversation: 'trusted@s.whatsapp.net',
      receivedAt: '2026-11-03T00:00:00.000Z',
      content: 'trusted',
    }, () => {
      expect(queue.enqueue(makeTurn({ text: 'trusted', chatJid: 'trusted@s.whatsapp.net' }))).toBe(true);
    });
    await firstStarted.promise;
    expect(queue.enqueue(makeTurn({ text: 'synthetic', chatJid: 'synthetic@s.whatsapp.net' }))).toBe(true);
    firstRelease.resolve();
    await queue.idle();

    expect(admitted).toHaveBeenNthCalledWith(2, expect.objectContaining({
      recipient: 'synthetic@s.whatsapp.net',
    }));
    expect(admitted.mock.calls[1]?.[0]).not.toHaveProperty('context');
  });

  it('preserves a trusted context when a deferred queue starts after teardown rollback', async () => {
    const admitted = vi.fn<(input: TransportAdmissionInput) => Promise<{ attemptId: string; payloadDigest: string }>>(
      async () => ({ attemptId: 'attempt', payloadDigest: 'sha256:payload' }),
    );
    const queue = new TurnQueue();
    const turn = makeTurn({ text: 'requeued', chatJid: 'requeued@s.whatsapp.net' });

    await registerTrustedInbound({
      registerInbound: vi.fn(async () => ({ kind: 'inbound' as const, automationOperations: [], automationHolds: [] })),
      closeInbound: vi.fn(async () => undefined),
    }, {
      eventId: 'requeued',
      sender: 'requeued@s.whatsapp.net',
      conversation: 'requeued@s.whatsapp.net',
      receivedAt: '2026-11-03T00:00:00.000Z',
      content: 'requeued',
    }, () => {
      expect(queue.enqueue(turn)).toBe(true);
    });
    const teardown = queue.beginTeardown();
    expect(queue.rollbackFailedTeardown(teardown, [turn])).toBe(true);

    const gate = new FinalTransportAuthorityGate({
      admit: admitted,
      recordReceipt: vi.fn(async () => undefined),
    });
    queue.setProcessor(async (queued) => {
      await gate.admit({ recipient: queued.chatJid, content: { text: queued.text } });
    });
    await queue.idle();

    expect(admitted).toHaveBeenCalledWith(expect.objectContaining({
      recipient: 'requeued@s.whatsapp.net', context: { inbound_event_id: 'requeued' },
    }));
  });

  it('ignores a caller-supplied stale snapshot and captures the context at admission', async () => {
    const admitted = vi.fn<(input: TransportAdmissionInput) => Promise<{ attemptId: string; payloadDigest: string }>>(
      async () => ({ attemptId: 'attempt', payloadDigest: 'sha256:payload' }),
    );
    const queue = new TurnQueue();
    let staleSnapshot!: ReturnType<typeof AsyncLocalStorage.snapshot>;
    await registerTrustedInbound({
      registerInbound: vi.fn(async () => ({ kind: 'inbound' as const, automationOperations: [], automationHolds: [] })),
      closeInbound: vi.fn(async () => undefined),
    }, {
      eventId: 'A',
      sender: 'a@s.whatsapp.net',
      conversation: 'a@s.whatsapp.net',
      receivedAt: '2026-11-03T00:00:00.000Z',
      content: 'A',
    }, () => {
      staleSnapshot = AsyncLocalStorage.snapshot();
    });
    const copiedTurn = Object.assign(
      makeTurn({ text: 'B', chatJid: 'b@s.whatsapp.net' }),
      { queuedAsyncContext: staleSnapshot },
    );
    await registerTrustedInbound({
      registerInbound: vi.fn(async () => ({ kind: 'inbound' as const, automationOperations: [], automationHolds: [] })),
      closeInbound: vi.fn(async () => undefined),
    }, {
      eventId: 'B',
      sender: 'b@s.whatsapp.net',
      conversation: 'b@s.whatsapp.net',
      receivedAt: '2026-11-03T00:00:00.000Z',
      content: 'B',
    }, () => {
      expect(queue.enqueue(copiedTurn)).toBe(true);
    });
    const gate = new FinalTransportAuthorityGate({
      admit: admitted,
      recordReceipt: vi.fn(async () => undefined),
    });
    queue.setProcessor(async (turn) => {
      await gate.admit({ recipient: turn.chatJid, content: { text: turn.text } });
    });
    await queue.idle();

    expect(admitted).toHaveBeenCalledWith(expect.objectContaining({
      recipient: 'b@s.whatsapp.net', context: { inbound_event_id: 'B' },
    }));
  });

  it('captures a new context when a settled turn object is admitted again', async () => {
    const admitted = vi.fn<(input: TransportAdmissionInput) => Promise<{ attemptId: string; payloadDigest: string }>>(
      async () => ({ attemptId: 'attempt', payloadDigest: 'sha256:payload' }),
    );
    const queue = new TurnQueue();
    const gate = new FinalTransportAuthorityGate({
      admit: admitted,
      recordReceipt: vi.fn(async () => undefined),
    });
    queue.setProcessor(async (turn) => {
      await gate.admit({ recipient: turn.chatJid, content: { text: turn.text } });
    });
    const turn = makeTurn({ text: 'reused', chatJid: 'reused@s.whatsapp.net' });
    const enqueueTrusted = async (eventId: string): Promise<void> => {
      await registerTrustedInbound({
        registerInbound: vi.fn(async () => ({ kind: 'inbound' as const, automationOperations: [], automationHolds: [] })),
        closeInbound: vi.fn(async () => undefined),
      }, {
        eventId,
        sender: `${eventId}@s.whatsapp.net`,
        conversation: 'reused@s.whatsapp.net',
        receivedAt: '2026-11-03T00:00:00.000Z',
        content: eventId,
      }, () => {
        expect(queue.enqueue(turn)).toBe(true);
      });
      await queue.idle();
    };

    await enqueueTrusted('A');
    await enqueueTrusted('B');

    expect(admitted).toHaveBeenNthCalledWith(1, expect.objectContaining({
      context: { inbound_event_id: 'A' },
    }));
    expect(admitted).toHaveBeenNthCalledWith(2, expect.objectContaining({
      context: { inbound_event_id: 'B' },
    }));
  });

  it('rejects duplicate active or pending turn objects without settling the original admission', async () => {
    const admitted = vi.fn<(input: TransportAdmissionInput) => Promise<{ attemptId: string; payloadDigest: string }>>(
      async () => ({ attemptId: 'attempt', payloadDigest: 'sha256:payload' }),
    );
    const firstQueue = new TurnQueue();
    const secondQueue = new TurnQueue();
    const gate = new FinalTransportAuthorityGate({
      admit: admitted,
      recordReceipt: vi.fn(async () => undefined),
    });
    const turn = makeTurn({ text: 'original', chatJid: 'original@s.whatsapp.net' });

    await registerTrustedInbound({
      registerInbound: vi.fn(async () => ({ kind: 'inbound' as const, automationOperations: [], automationHolds: [] })),
      closeInbound: vi.fn(async () => undefined),
    }, {
      eventId: 'A',
      sender: 'a@s.whatsapp.net',
      conversation: 'original@s.whatsapp.net',
      receivedAt: '2026-11-03T00:00:00.000Z',
      content: 'original',
    }, () => {
      expect(firstQueue.enqueue(turn)).toBe(true);
    });
    await registerTrustedInbound({
      registerInbound: vi.fn(async () => ({ kind: 'inbound' as const, automationOperations: [], automationHolds: [] })),
      closeInbound: vi.fn(async () => undefined),
    }, {
      eventId: 'B',
      sender: 'b@s.whatsapp.net',
      conversation: 'other@s.whatsapp.net',
      receivedAt: '2026-11-03T00:00:00.000Z',
      content: 'copy',
    }, () => {
      expect(secondQueue.enqueue(turn)).toBe(false);
    });
    firstQueue.setProcessor(async (queued) => {
      await gate.admit({ recipient: queued.chatJid, content: { text: queued.text } });
    });
    await firstQueue.idle();

    expect(admitted).toHaveBeenCalledTimes(1);
    expect(admitted).toHaveBeenCalledWith(expect.objectContaining({
      recipient: 'original@s.whatsapp.net', context: { inbound_event_id: 'A' },
    }));
  });

  it('releases terminalized partial-teardown turns for a fresh admission', async () => {
    const admitted = vi.fn<(input: TransportAdmissionInput) => Promise<{ attemptId: string; payloadDigest: string }>>(
      async () => ({ attemptId: 'attempt', payloadDigest: 'sha256:payload' }),
    );
    const queue = new TurnQueue();
    const resolved = makeTurn({ text: 'resolved', chatJid: 'resolved@s.whatsapp.net' });
    const unresolved = makeTurn({ text: 'unresolved', chatJid: 'unresolved@s.whatsapp.net' });
    const enqueueTrusted = async (eventId: string, turn: QueuedTurn): Promise<void> => {
      await registerTrustedInbound({
        registerInbound: vi.fn(async () => ({ kind: 'inbound' as const, automationOperations: [], automationHolds: [] })),
        closeInbound: vi.fn(async () => undefined),
      }, {
        eventId,
        sender: `${eventId}@s.whatsapp.net`,
        conversation: turn.chatJid,
        receivedAt: '2026-11-03T00:00:00.000Z',
        content: eventId,
      }, () => {
        expect(queue.enqueue(turn)).toBe(true);
      });
    };

    await enqueueTrusted('A', resolved);
    await enqueueTrusted('B', unresolved);
    const teardown = queue.beginTeardown();
    expect(queue.rollbackFailedTeardown(teardown, [unresolved])).toBe(true);
    await enqueueTrusted('C', resolved);

    const gate = new FinalTransportAuthorityGate({
      admit: admitted,
      recordReceipt: vi.fn(async () => undefined),
    });
    queue.setProcessor(async (turn) => {
      await gate.admit({ recipient: turn.chatJid, content: { text: turn.text } });
    });
    await queue.idle();

    expect(admitted).toHaveBeenNthCalledWith(2, expect.objectContaining({
      recipient: 'resolved@s.whatsapp.net', context: { inbound_event_id: 'C' },
    }));
  });

  // @check CHK-062
// @traces REQ-012.AC-01
  it('processes turns one at a time (FIFO)', async () => {
    const queue = new TurnQueue();
    const order: string[] = [];
    const releases = [deferred(), deferred(), deferred()];

    queue.setProcessor(async (turn) => {
      order.push(turn.text);
      await releases[order.length - 1]!.promise;
    });

    queue.enqueue(makeTurn({ text: 'first' }));
    queue.enqueue(makeTurn({ text: 'second' }));
    queue.enqueue(makeTurn({ text: 'third' }));

    await vi.waitFor(() => expect(order).toEqual(['first']));
    releases[0]!.resolve();
    await vi.waitFor(() => expect(order).toEqual(['first', 'second']));
    releases[1]!.resolve();
    await vi.waitFor(() => expect(order).toEqual(['first', 'second', 'third']));
    releases[2]!.resolve();
    await queue.idle();

    expect(order).toEqual(['first', 'second', 'third']);
  });

  // @check CHK-062
// @traces REQ-012.AC-01
  it('second turn waits for first to complete before processing', async () => {
    const queue = new TurnQueue();
    let firstDone = false;
    let secondStartedBeforeFirst = false;
    const firstRelease = deferred();

    queue.setProcessor(async (turn) => {
      if (turn.text === 'second' && !firstDone) {
        secondStartedBeforeFirst = true;
      }
      if (turn.text === 'first') {
        await firstRelease.promise;
        firstDone = true;
      }
    });

    queue.enqueue(makeTurn({ text: 'first' }));
    queue.enqueue(makeTurn({ text: 'second' }));

    await vi.waitFor(() => expect(queue.isProcessing).toBe(true));
    firstRelease.resolve();
    await queue.idle();

    expect(secondStartedBeforeFirst).toBe(false);
    expect(firstDone).toBe(true);
  });

  it('queue drains automatically after enqueue', async () => {
    const queue = new TurnQueue();
    const processed: string[] = [];

    queue.setProcessor(async (turn) => {
      processed.push(turn.text);
    });

    queue.enqueue(makeTurn({ text: 'a' }));
    queue.enqueue(makeTurn({ text: 'b' }));

    await queue.idle();

    expect(processed).toEqual(['a', 'b']);
  });

  it('pending count is accurate', async () => {
    const queue = new TurnQueue();

    // No processor set — turns stay queued
    queue.enqueue(makeTurn({ text: 'one' }));
    queue.enqueue(makeTurn({ text: 'two' }));
    queue.enqueue(makeTurn({ text: 'three' }));

    expect(queue.pending).toBe(3);
  });

  it('pending count is accurate before processor is set', async () => {
    const queue = new TurnQueue();

    // No processor — items stay queued (drain exits early if no processor)
    queue.enqueue(makeTurn({ text: 'a' }));
    queue.enqueue(makeTurn({ text: 'b' }));
    queue.enqueue(makeTurn({ text: 'c' }));
    expect(queue.pending).toBe(3);
  });

  it('closes admissions while atomically detaching pending turns for shutdown ownership', async () => {
    const rejected: QueuedTurn[] = [];
    const processed: QueuedTurn[] = [];
    const queue = new TurnQueue({
      onReject: (turn) => rejected.push(turn),
    });
    const release = deferred();
    const active = makeTurn({ text: 'active', inboundSeq: 1 });
    const pending = makeTurn({ text: 'pending', inboundSeq: 2 });
    const late = makeTurn({ text: 'late', inboundSeq: 3 });

    queue.setProcessor(async (turn) => {
      processed.push(turn);
      if (turn === active) await release.promise;
    });
    queue.enqueue(active);
    queue.enqueue(pending);
    await vi.waitFor(() => expect(queue.activeTurn).toBe(active));

    expect(queue.closeAndTakePendingTurns()).toEqual([pending]);
    expect(queue.activeTurn).toBe(active);
    expect(queue.pending).toBe(0);
    expect(queue.enqueue(late)).toBe(false);
    expect(rejected).toEqual([late]);

    release.resolve();
    await queue.idle();

    expect(processed).toEqual([active]);
    expect(rejected).toEqual([late]);
  });

  it('does not reopen a pre-closed queue after teardown rollback', () => {
    const rejected: Array<{ turn: QueuedTurn; reason: string }> = [];
    const queue = new TurnQueue({
      onReject: (turn, reason) => rejected.push({ turn, reason }),
    });
    const first = makeTurn({ text: 'first', inboundSeq: 1 });
    const second = makeTurn({ text: 'second', inboundSeq: 2 });
    const late = makeTurn({ text: 'late', inboundSeq: 3 });
    queue.enqueue(first);
    queue.enqueue(second);

    const legitimatelyClosed = queue.closeAndTakePendingTurns();
    expect(legitimatelyClosed).toEqual([first, second]);
    const teardown = queue.beginTeardown();
    expect(teardown.pending).toEqual([]);
    queue.rollbackFailedTeardown(teardown, []);

    expect(queue.enqueue(late)).toBe(false);
    expect(rejected).toEqual([{ turn: late, reason: 'queue_closed' }]);
    expect(legitimatelyClosed).toEqual([first, second]);
  });

  it('rejects stale rollback after the teardown owner commits and a later close supersedes it', () => {
    const rejected: QueuedTurn[] = [];
    const queue = new TurnQueue({
      onReject: (turn) => rejected.push(turn),
    });
    const pending = makeTurn({ text: 'pending', inboundSeq: 1 });
    const late = makeTurn({ text: 'late', inboundSeq: 2 });
    queue.enqueue(pending);

    const teardown = queue.beginTeardown();
    expect(teardown.pending).toEqual([pending]);
    queue.commitTeardown(teardown);
    expect(queue.closeAndTakePendingTurns()).toEqual([]);
    expect(() => queue.rollbackFailedTeardown(teardown, [pending])).toThrow(/stale|consumed/i);

    expect(queue.enqueue(late)).toBe(false);
    expect(rejected).toEqual([late]);
    expect(queue.closeAndTakePendingTurns()).toEqual([]);
    expect(teardown.pending).toEqual([pending]);
  });

  it('restores a partial unresolved subset in original FIFO order', () => {
    const queue = new TurnQueue();
    const first = makeTurn({ text: 'first', inboundSeq: 1 });
    const owned = makeTurn({ text: 'owned', inboundSeq: 2 });
    const third = makeTurn({ text: 'third', inboundSeq: 3 });
    queue.enqueue(first);
    queue.enqueue(owned);
    queue.enqueue(third);

    const teardown = queue.beginTeardown();
    expect(queue.rollbackFailedTeardown(teardown, [third, first])).toBe(true);

    expect(queue.closeAndTakePendingTurns()).toEqual([first, third]);
  });

  it('rejects duplicate and foreign rollback turns without consuming the valid receipt', () => {
    const queue = new TurnQueue();
    const otherQueue = new TurnQueue();
    const pending = makeTurn({ text: 'pending', inboundSeq: 1 });
    queue.enqueue(pending);
    const teardown = queue.beginTeardown();

    expect(
      () => otherQueue.rollbackFailedTeardown(teardown, [pending]),
    ).toThrow(/stale|consumed/i);
    expect(
      () => queue.rollbackFailedTeardown(teardown, [pending, pending]),
    ).toThrow(/outside its receipt/i);
    expect(queue.rollbackFailedTeardown(teardown, [pending])).toBe(true);
    expect(queue.closeAndTakePendingTurns()).toEqual([pending]);
  });

  it('resumes a restored pending turn after the active processor drains during teardown', async () => {
    const queue = new TurnQueue();
    const processed: QueuedTurn[] = [];
    const release = deferred();
    const active = makeTurn({ text: 'active', inboundSeq: 1 });
    const pending = makeTurn({ text: 'pending', inboundSeq: 2 });

    queue.setProcessor(async (turn) => {
      processed.push(turn);
      if (turn === active) await release.promise;
    });
    queue.enqueue(active);
    queue.enqueue(pending);
    await vi.waitFor(() => expect(queue.activeTurn).toBe(active));
    const teardown = queue.beginTeardown();
    expect(teardown.pending).toEqual([pending]);
    expect(() => queue.closeAndTakePendingTurns()).toThrow(/teardown.*active/i);

    release.resolve();
    await queue.idle();
    queue.rollbackFailedTeardown(teardown, [pending]);
    const later = makeTurn({ text: 'later', inboundSeq: 3 });
    expect(queue.enqueue(later)).toBe(true);
    await queue.idle();

    expect(processed).toEqual([active, pending, later]);
  });

  it('keeps a halted queue fail-closed after teardown rollback', async () => {
    const reasons: TurnRejectReason[] = [];
    const failure = new Error('terminal sink unavailable');
    const queue = new TurnQueue({
      onReject: (_turn, reason) => reasons.push(reason),
      onProcessorError: async () => {
        throw failure;
      },
    });
    const blocked = makeTurn({ text: 'blocked', inboundSeq: 2 });
    queue.setProcessor(async (turn) => {
      if (turn.text === 'bad') throw new Error('processor exploded');
    });
    queue.enqueue(makeTurn({ text: 'bad', inboundSeq: 1 }));
    queue.enqueue(blocked);
    await expect(queue.idle()).rejects.toBe(failure);

    const teardown = queue.beginTeardown();
    expect(teardown.pending).toEqual([blocked]);
    expect(queue.rollbackFailedTeardown(teardown, [blocked])).toBe(true);
    expect(queue.enqueue(makeTurn({ text: 'late', inboundSeq: 3 }))).toBe(false);

    expect(queue.haltedError).toBe(failure);
    expect(queue.pending).toBe(1);
    expect(reasons).toEqual(['queue_halted']);
  });

  it('latches an external halt before an active teardown can roll back and drain', async () => {
    const failure = new Error('outbound queue poisoned during teardown');
    const processed: QueuedTurn[] = [];
    const queue = new TurnQueue();
    const blocked = makeTurn({ text: 'blocked', inboundSeq: 4 });
    expect(queue.enqueue(blocked)).toBe(true);
    const teardown = queue.beginTeardown();

    expect(() => queue.haltAndTakePendingTurns(failure)).toThrow(/teardown.*active/i);
    expect(queue.isHalted).toBe(true);
    expect(queue.rollbackFailedTeardown(teardown, [blocked])).toBe(true);

    queue.setProcessor(async (turn) => { processed.push(turn); });
    await expect(queue.idle()).rejects.toBe(failure);
    expect(processed).toEqual([]);
    expect(queue.pending).toBe(1);
  });

  it('pending goes to 0 after all turns processed', async () => {
    const queue = new TurnQueue();

    queue.setProcessor(async () => {});

    queue.enqueue(makeTurn({ text: 'a' }));
    queue.enqueue(makeTurn({ text: 'b' }));
    queue.enqueue(makeTurn({ text: 'c' }));

    await queue.idle();

    expect(queue.pending).toBe(0);
    expect(queue.isProcessing).toBe(false);
  });

  it('isProcessing reflects active state', async () => {
    const queue = new TurnQueue();
    let processingDuringTurn = false;
    const release = deferred();

    queue.setProcessor(async () => {
      processingDuringTurn = queue.isProcessing;
      await release.promise;
    });

    queue.enqueue(makeTurn({ text: 'check' }));

    await vi.waitFor(() => expect(processingDuringTurn).toBe(true));
    expect(queue.isProcessing).toBe(true);
    release.resolve();
    await queue.idle();

    expect(processingDuringTurn).toBe(true);
    expect(queue.isProcessing).toBe(false);
  });

  it('exposes the exact active turn only while its processor owns the FIFO head', async () => {
    const queue = new TurnQueue();
    const release = deferred();
    const active = makeTurn({ text: 'active-turn', inboundSeq: 41 });

    queue.setProcessor(async () => {
      await release.promise;
    });
    queue.enqueue(active);

    await vi.waitFor(() => expect(queue.isProcessing).toBe(true));
    expect(queue.activeTurn).toBe(active);
    expect(queue.pending).toBe(0);

    release.resolve();
    await queue.idle();

    expect(queue.activeTurn).toBeNull();
    expect(queue.pending).toBe(0);
    expect(queue.isProcessing).toBe(false);
  });

  it('halts instead of swallowing a processor error when no finalizer is installed', async () => {
    const queue = new TurnQueue();
    const processed: string[] = [];
    const processorError = new Error('intentional error');

    queue.setProcessor(async (turn) => {
      if (turn.text === 'bad') {
        throw processorError;
      }
      processed.push(turn.text);
    });

    queue.enqueue(makeTurn({ text: 'good-before' }));
    queue.enqueue(makeTurn({ text: 'bad' }));
    queue.enqueue(makeTurn({ text: 'good-after' }));

    await expect(queue.idle()).rejects.toBe(processorError);

    expect(processed).toEqual(['good-before']);
    expect(queue.pending).toBe(1);
    expect(queue.haltedError).toBe(processorError);
  });

  it('exposes content-free lifetime halt state and signals the transition exactly once', async () => {
    const haltTransitions: string[] = [];
    const queue = new TurnQueue({
      onHalt: () => haltTransitions.push('halted'),
    });
    const processorError = new Error('private terminal failure');

    expect(queue.isHalted).toBe(false);

    queue.setProcessor(async () => {
      throw processorError;
    });
    queue.enqueue(makeTurn({ text: 'fails' }));

    await expect(queue.idle()).rejects.toBe(processorError);
    expect(queue.isHalted).toBe(true);
    expect(haltTransitions).toEqual(['halted']);

    expect(queue.enqueue(makeTurn({ text: 'rejected-after-halt' }))).toBe(false);
    expect(queue.isHalted).toBe(true);
    expect(haltTransitions).toEqual(['halted']);
    expect(new TurnQueue().isHalted).toBe(false);
  });

  it('awaits processor-error finalization before advancing the FIFO', async () => {
    const errorFinalized = deferred();
    const order: string[] = [];
    const queue = new TurnQueue({
      onProcessorError: async (turn, err) => {
        order.push(`error:${turn.text}:${(err as Error).message}`);
        await errorFinalized.promise;
        order.push(`finalized:${turn.text}`);
      },
    });

    queue.setProcessor(async (turn) => {
      order.push(`process:${turn.text}`);
      if (turn.text === 'bad') throw new Error('processor exploded');
    });

    queue.enqueue(makeTurn({ text: 'bad' }));
    queue.enqueue(makeTurn({ text: 'next' }));

    await vi.waitFor(() => {
      expect(order).toEqual([
        'process:bad',
        'error:bad:processor exploded',
      ]);
    });
    errorFinalized.resolve();
    await queue.idle();

    expect(order).toEqual([
      'process:bad',
      'error:bad:processor exploded',
      'finalized:bad',
      'process:next',
    ]);
  });

  it('halts without advancing when processor-error finalization rejects', async () => {
    const finalizationFailure = new Error('terminal sink unavailable');
    const processed: string[] = [];
    const queue = new TurnQueue({
      onProcessorError: async () => {
        throw finalizationFailure;
      },
    });

    queue.setProcessor(async (turn) => {
      processed.push(turn.text);
      if (turn.text === 'bad') throw new Error('processor exploded');
    });

    queue.enqueue(makeTurn({ text: 'bad' }));
    queue.enqueue(makeTurn({ text: 'must-stay-queued' }));

    await expect(queue.idle()).rejects.toBe(finalizationFailure);
    expect(processed).toEqual(['bad']);
    expect(queue.pending).toBe(1);
    expect(queue.isProcessing).toBe(false);
    expect(queue.haltedError).toBe(finalizationFailure);
    expect(queue.enqueue(makeTurn({ text: 'rejected-after-halt' }))).toBe(false);
    expect(queue.pending).toBe(1);
  });

  it('turns from different chats are queued in arrival order', async () => {
    const queue = new TurnQueue();
    const order: string[] = [];

    queue.setProcessor(async (turn) => {
      order.push(`${turn.chatJid}:${turn.text}`);
    });

    queue.enqueue(makeTurn({ chatJid: 'chat-a@s.whatsapp.net', text: 'msg1' }));
    queue.enqueue(makeTurn({ chatJid: 'chat-b@s.whatsapp.net', text: 'msg2' }));
    queue.enqueue(makeTurn({ chatJid: 'chat-a@s.whatsapp.net', text: 'msg3' }));

    await queue.idle();

    expect(order).toEqual([
      'chat-a@s.whatsapp.net:msg1',
      'chat-b@s.whatsapp.net:msg2',
      'chat-a@s.whatsapp.net:msg3',
    ]);
  });

  describe('turn-queue.ts uncovered-branch coverage', () => {
    it('rejects enqueues once maxDepth cap is reached and invokes onReject', () => {
      const rejected: string[] = [];
      const queue = new TurnQueue({
        maxDepth: 2,
        onReject: (turn) => rejected.push(turn.text),
      });

      const first = queue.enqueue(makeTurn({ text: 'keep-a' }));
      const second = queue.enqueue(makeTurn({ text: 'keep-b' }));
      // No processor set, so items stay queued and the cap stays full.
      const third = queue.enqueue(makeTurn({ text: 'overflow' }));

      expect(first).toBe(true);
      expect(second).toBe(true);
      expect(third).toBe(false);
      expect(queue.pending).toBe(2);
      expect(rejected).toEqual(['overflow']);
    });

    it('threads the distinct depth-cap reject reason to onReject (#1750)', () => {
      const reasons: Array<{ text: string; reason: string }> = [];
      const queue = new TurnQueue({
        maxDepth: 0,
        onReject: (turn, reason) => reasons.push({ text: turn.text, reason }),
      });

      expect(queue.enqueue(makeTurn({ text: 'shed' }))).toBe(false);
      expect(reasons).toEqual([{ text: 'shed', reason: 'queue_full' }]);
    });

    it('threads the distinct closed-admissions reject reason to onReject (#1750)', () => {
      const reasons: Array<{ text: string; reason: string }> = [];
      const queue = new TurnQueue({
        onReject: (turn, reason) => reasons.push({ text: turn.text, reason }),
      });

      // closeAndTakePendingTurns() stops accepting admissions.
      queue.closeAndTakePendingTurns();

      expect(queue.enqueue(makeTurn({ text: 'after-close' }))).toBe(false);
      expect(reasons).toEqual([{ text: 'after-close', reason: 'queue_closed' }]);
    });

    it('threads the distinct halted reject reason to onReject (#1750)', async () => {
      // A halt (deadlock) MUST be distinguishable from a benign closed/shed
      // reject so alerting can page on it — a copy-paste to 'queue_closed' here
      // would silently un-page the exact fault #1750 exists to surface.
      const reasons: Array<{ text: string; reason: string }> = [];
      const queue = new TurnQueue({
        onReject: (turn, reason) => reasons.push({ text: turn.text, reason }),
      });
      queue.setProcessor(async (turn) => {
        if (turn.text === 'bad') throw new Error('processor exploded');
      });

      // No onProcessorError finalizer → the processor throw halts the queue.
      queue.enqueue(makeTurn({ text: 'bad' }));
      await expect(queue.idle()).rejects.toThrow('processor exploded');
      expect(queue.haltedError).toBeInstanceOf(Error);

      expect(queue.enqueue(makeTurn({ text: 'after-halt' }))).toBe(false);
      expect(reasons).toEqual([{ text: 'after-halt', reason: 'queue_halted' }]);
    });

    it('pendingForChat counts only turns for the matching chat', async () => {
      const queue = new TurnQueue();

      // No processor → items remain queued for deterministic counting.
      queue.enqueue(makeTurn({ chatJid: '1555XXXXXXX@s.whatsapp.net', text: 'a' }));
      queue.enqueue(makeTurn({ chatJid: '1555YYYYYYY@s.whatsapp.net', text: 'b' }));
      queue.enqueue(makeTurn({ chatJid: '1555XXXXXXX@s.whatsapp.net', text: 'c' }));

      expect(queue.pendingForChat('1555XXXXXXX@s.whatsapp.net')).toBe(2);
      expect(queue.pendingForChat('1555YYYYYYY@s.whatsapp.net')).toBe(1);
      expect(queue.pendingForChat('1555ZZZZZZZ@s.whatsapp.net')).toBe(0);
    });

    it('idle resolves immediately when already empty and not processing', async () => {
      const queue = new TurnQueue();
      let resolved = false;

      // Fresh queue with no work — idle() returns on the early-exit branch
      // (line 72) without scheduling any timer. Resolve synchronously-ish to
      // prove the early exit was taken.
      await queue.idle().then(() => {
        resolved = true;
      });

      expect(resolved).toBe(true);
      expect(queue.isProcessing).toBe(false);
      expect(queue.pending).toBe(0);
    });

    it('idle polls via setTimeout while a turn is still processing', async () => {
      vi.useFakeTimers();
      try {
        const queue = new TurnQueue();
        const release = deferred();
        const seen: string[] = [];

        queue.setProcessor(async (turn) => {
          seen.push(turn.text);
          // Stay busy until released: idle()'s internal check() must take the
          // else-branch (line 78) and reschedule via setTimeout.
          await release.promise;
        });

        queue.enqueue(makeTurn({ text: 'held' }));
        expect(queue.isProcessing).toBe(true);

        let idleResolved = false;
        void queue.idle().then(() => {
          idleResolved = true;
        });

        // Advance fake time so the SUT's poller fires while the turn is still
        // held — this exercises the else-branch (line 78).
        await vi.advanceTimersByTimeAsync(5);
        expect(idleResolved).toBe(false);
        expect(queue.isProcessing).toBe(true);

        release.resolve();
        // Let the released microtasks and any pending poll timers drain.
        await vi.advanceTimersByTimeAsync(5);
        await vi.runAllTimersAsync();

        expect(seen).toEqual(['held']);
        expect(idleResolved).toBe(true);
        expect(queue.pending).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it('drain runs immediately when setProcessor is called after items are queued', async () => {
      const queue = new TurnQueue();
      const processed: string[] = [];

      // Enqueue before any processor exists — drain() must bail (line 86).
      const enqueued = queue.enqueue(makeTurn({ text: 'pre' }));
      expect(enqueued).toBe(true);
      expect(queue.pending).toBe(1);

      queue.setProcessor(async (turn) => {
        processed.push(turn.text);
      });

      // setProcessor triggers a drain of the already-queued turn.
      await queue.idle();

      expect(processed).toEqual(['pre']);
      expect(queue.pending).toBe(0);
    });
  });
});
