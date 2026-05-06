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
    chatJid: 'chat@s.whatsapp.net',
    senderJid: 'sender@s.whatsapp.net',
    senderName: 'Test User',
    text: 'hello',
    isGroup: false,
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

  it('processor error does not stop subsequent turns', async () => {
    const queue = new TurnQueue();
    const processed: string[] = [];

    queue.setProcessor(async (turn) => {
      if (turn.text === 'bad') {
        throw new Error('intentional error');
      }
      processed.push(turn.text);
    });

    queue.enqueue(makeTurn({ text: 'good-before' }));
    queue.enqueue(makeTurn({ text: 'bad' }));
    queue.enqueue(makeTurn({ text: 'good-after' }));

    await queue.idle();

    expect(processed).toEqual(['good-before', 'good-after']);
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
});
