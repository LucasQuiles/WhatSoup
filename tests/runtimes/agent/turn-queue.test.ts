import { describe, it, expect, vi } from 'vitest';
import { TurnQueue, type QueuedTurn } from '../../../src/runtimes/agent/turn-queue.ts';

vi.mock('../../../src/logger.ts', () => ({
  createChildLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

function makeTurn(overrides: Partial<QueuedTurn> = {}): QueuedTurn {
  return {
    sourceMessageId: 'wamid-test',
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
