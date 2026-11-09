// #2949 first slice (owner decision 63): the truthful "queued behind the
// current task" receipt.
//
// The decision reads a REAL TurnQueue: TurnQueue.drain makes an admitted turn
// the active turn synchronously when the queue was idle, so these tests prove
// the idle/queued split against the real queue, not a hand-set flag.

import { describe, expect, it, vi } from 'vitest';
import { TurnQueue, type QueuedTurn } from '../../../src/runtimes/agent/turn-queue.ts';
import { fakeClock, type Clock } from '../../../src/lib/clock.ts';
import {
  DEFAULT_QUEUED_TURN_RECEIPT_COOLDOWN_MS,
  QUEUED_TURN_RECEIPT_OTHER_TEXT,
  QUEUED_TURN_RECEIPT_TEXT,
  QueuedTurnReceiptNotifier,
  queuedTurnReceiptText,
} from '../../../src/runtimes/agent/runtime-queued-receipt.ts';

const chatJid = 'receipt-chat@s.whatsapp.net';
const mapKey = 'receipt-chat';

function makeTurn(text: string, overrides: Partial<QueuedTurn> = {}): QueuedTurn {
  return {
    sourceMessageId: `wamid-${text}`,
    receivedAtUnixSeconds: 1_780_000_000,
    conversationKey: mapKey,
    chatJid,
    senderJid: '15550001@s.whatsapp.net',
    senderName: 'Test User',
    text,
    isGroup: false,
    contentType: 'text',
    ...overrides,
  };
}

/** A real TurnQueue whose processor holds every turn open until released. */
function makeBlockingQueue(): { queue: TurnQueue; releaseActive: () => void } {
  const queue = new TurnQueue();
  let release: (() => void) | null = null;
  queue.setProcessor(() => new Promise<void>((resolve) => { release = resolve; }));
  return {
    queue,
    releaseActive: () => {
      const fn = release;
      release = null;
      fn?.();
    },
  };
}

function makeNotifier(opts: { enabled?: boolean; clock?: Clock } = {}) {
  const send = vi.fn(async (_chatJid: string, _text: string) => {});
  const notifier = new QueuedTurnReceiptNotifier({
    enabled: () => opts.enabled ?? true,
    send,
    ...(opts.clock ? { clock: opts.clock } : {}),
  });
  return { notifier, send };
}

function admit(
  notifier: QueuedTurnReceiptNotifier,
  queue: TurnQueue,
  turn: QueuedTurn,
  scope: 'single' | 'shared' | 'per_chat' = 'per_chat',
) {
  const admitted = queue.enqueue(turn);
  return notifier.noteAdmission({ scope, mapKey, queue, turn, admitted });
}

describe('#2949 queued receipt: fires only for a turn waiting behind an active turn', () => {
  it('sends exactly one receipt for a message queued behind the running task', () => {
    const { queue } = makeBlockingQueue();
    const { notifier, send } = makeNotifier();

    expect(admit(notifier, queue, makeTurn('first'))).toBe('started_immediately');
    expect(admit(notifier, queue, makeTurn('second'))).toBe('sent');

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(chatJid, QUEUED_TURN_RECEIPT_TEXT);
    expect(queue.pending).toBe(1);
  });

  it('sends nothing when the message starts a turn on an idle queue', () => {
    const { queue } = makeBlockingQueue();
    const { notifier, send } = makeNotifier();

    const decision = admit(notifier, queue, makeTurn('only'));

    expect(decision).toBe('started_immediately');
    expect(queue.activeTurn?.text).toBe('only');
    expect(send).not.toHaveBeenCalled();
  });

  it('sends nothing once the earlier task finished and the queue went idle again', async () => {
    const { queue, releaseActive } = makeBlockingQueue();
    const { notifier, send } = makeNotifier();

    admit(notifier, queue, makeTurn('first'));
    releaseActive();
    await queue.idle();

    expect(admit(notifier, queue, makeTurn('after-idle'))).toBe('started_immediately');
    expect(send).not.toHaveBeenCalled();
  });

  it('the cooldown suppresses a second receipt for the same chat, and it re-arms after the window', () => {
    const clock = fakeClock(1_000_000);
    const { queue } = makeBlockingQueue();
    const { notifier, send } = makeNotifier({ clock });

    admit(notifier, queue, makeTurn('first'));
    expect(admit(notifier, queue, makeTurn('second'))).toBe('sent');
    clock.advance(DEFAULT_QUEUED_TURN_RECEIPT_COOLDOWN_MS - 1);
    expect(admit(notifier, queue, makeTurn('third'))).toBe('cooldown');
    expect(send).toHaveBeenCalledTimes(1);

    clock.advance(1);
    expect(admit(notifier, queue, makeTurn('fourth'))).toBe('sent');
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('the cooldown is per chat: another chat still gets its receipt', () => {
    const { notifier, send } = makeNotifier();
    const a = makeBlockingQueue().queue;
    const b = makeBlockingQueue().queue;
    const otherJid = 'other-chat@s.whatsapp.net';

    a.enqueue(makeTurn('a1'));
    const a2 = makeTurn('a2');
    notifier.noteAdmission({ scope: 'per_chat', mapKey: 'a', queue: a, turn: a2, admitted: a.enqueue(a2) });
    b.enqueue(makeTurn('b1', { chatJid: otherJid }));
    const b2 = makeTurn('b2', { chatJid: otherJid });
    const decision = notifier.noteAdmission({ scope: 'per_chat', mapKey: 'b', queue: b, turn: b2, admitted: b.enqueue(b2) });

    expect(decision).toBe('sent');
    expect(send.mock.calls.map((call) => call[0])).toEqual([chatJid, otherJid]);
  });

  it('never sends in single or shared scope, even when the turn is waiting', () => {
    const { queue } = makeBlockingQueue();
    const { notifier, send } = makeNotifier();
    queue.enqueue(makeTurn('first'));

    expect(admit(notifier, queue, makeTurn('single-waiter'), 'single')).toBe('scope_not_per_chat');
    expect(admit(notifier, queue, makeTurn('shared-waiter'), 'shared')).toBe('scope_not_per_chat');
    expect(send).not.toHaveBeenCalled();
  });

  it('never sends for a rejected admission', () => {
    const queue = new TurnQueue({ maxDepth: 1 });
    queue.setProcessor(() => new Promise<void>(() => {}));
    const { notifier, send } = makeNotifier();
    queue.enqueue(makeTurn('active'));
    queue.enqueue(makeTurn('fills-depth'));

    const decision = admit(notifier, queue, makeTurn('over-depth'));

    expect(decision).toBe('not_admitted');
    expect(send).not.toHaveBeenCalled();
  });

  it('never sends for a scheduled agent job, which has no human waiting', () => {
    const { queue } = makeBlockingQueue();
    const { notifier, send } = makeNotifier();
    queue.enqueue(makeTurn('first'));

    const job = makeTurn('job', { purpose: 'scheduled-agent-job' });
    expect(admit(notifier, queue, job)).toBe('scheduled_job');
    expect(send).not.toHaveBeenCalled();
  });

  it('never sends when the flag is off', () => {
    const { queue } = makeBlockingQueue();
    const { notifier, send } = makeNotifier({ enabled: false });
    queue.enqueue(makeTurn('first'));

    expect(admit(notifier, queue, makeTurn('second'))).toBe('disabled');
    expect(send).not.toHaveBeenCalled();
  });
});

describe('#2949 queued receipt: the text is truthful and content-free', () => {
  it('does not leak the queued message content', () => {
    const { queue } = makeBlockingQueue();
    const { notifier, send } = makeNotifier();
    const secret = 'wire 4,200 to account 99-1234 before noon';
    queue.enqueue(makeTurn('first'));

    admit(notifier, queue, makeTurn(secret));

    const sentText = send.mock.calls[0]?.[1];
    expect(sentText).toBe(QUEUED_TURN_RECEIPT_TEXT);
    expect(sentText).not.toContain('4,200');
    expect(sentText).not.toContain('99-1234');
  });

  it('says /stop cancels the running task AND what is queued, matching the per_chat teardown', () => {
    // Break caught: "Queued behind the current task" read as "some other task is
    // running"; the user asked again and again to cancel tasks that did not exist.
    expect(QUEUED_TURN_RECEIPT_TEXT).toBe(
      '*Still working on your earlier request.* This message is next. Send /stop to cancel.',
    );
    expect(QUEUED_TURN_RECEIPT_OTHER_TEXT).toBe(
      '*Still working on an earlier request.* This message is queued behind it. Send /stop to cancel the request and everything queued.',
    );
  });

  it('says "your earlier request ... next" only for the sender\'s own request with nothing else waiting', () => {
    const { queue } = makeBlockingQueue();
    const { notifier, send } = makeNotifier();
    queue.enqueue(makeTurn('my long request'));

    expect(admit(notifier, queue, makeTurn('why is it taking so long'))).toBe('sent');

    expect(send.mock.calls).toEqual([[chatJid, QUEUED_TURN_RECEIPT_TEXT]]);
  });

  it('a group member queued behind someone else\'s request gets the other-request receipt', () => {
    const { queue } = makeBlockingQueue();
    const { notifier, send } = makeNotifier();
    queue.enqueue(makeTurn('alice asks', { senderJid: '15550002@s.whatsapp.net', isGroup: true }));

    admit(notifier, queue, makeTurn('bob asks', { isGroup: true }));

    expect(send.mock.calls).toEqual([[chatJid, QUEUED_TURN_RECEIPT_OTHER_TEXT]]);
  });

  it('a message queued behind a scheduled job gets the other-request receipt', () => {
    const { queue } = makeBlockingQueue();
    const { notifier, send } = makeNotifier();
    queue.enqueue(makeTurn('daily report', { purpose: 'scheduled-agent-job' }));

    admit(notifier, queue, makeTurn('a question'));

    expect(send.mock.calls).toEqual([[chatJid, QUEUED_TURN_RECEIPT_OTHER_TEXT]]);
  });

  it('a message with others already waiting ahead of it is not told it is next', () => {
    const { queue } = makeBlockingQueue();
    const { notifier, send } = makeNotifier();
    queue.enqueue(makeTurn('running'));
    queue.enqueue(makeTurn('waiting ahead', { senderJid: '15550002@s.whatsapp.net' }));

    admit(notifier, queue, makeTurn('mine'));

    expect(queue.pending).toBe(2);
    expect(send.mock.calls).toEqual([[chatJid, QUEUED_TURN_RECEIPT_OTHER_TEXT]]);
  });

  it('picks the text from the running turn\'s sender and purpose and the waiting count', () => {
    const me = { senderJid: '15550001@s.whatsapp.net' };
    expect(queuedTurnReceiptText(me, me, 1)).toBe(QUEUED_TURN_RECEIPT_TEXT);
    expect(queuedTurnReceiptText(me, me, 2)).toBe(QUEUED_TURN_RECEIPT_OTHER_TEXT);
    expect(queuedTurnReceiptText({ senderJid: '15550002@s.whatsapp.net' }, me, 1))
      .toBe(QUEUED_TURN_RECEIPT_OTHER_TEXT);
    expect(queuedTurnReceiptText({ ...me, purpose: 'scheduled-agent-job' }, me, 1))
      .toBe(QUEUED_TURN_RECEIPT_OTHER_TEXT);
  });

  it('a failing send is contained: the decision stays sent and nothing throws', async () => {
    const { queue } = makeBlockingQueue();
    const send = vi.fn(async () => { throw new Error('transport down'); });
    const notifier = new QueuedTurnReceiptNotifier({ enabled: () => true, send });
    queue.enqueue(makeTurn('first'));

    expect(admit(notifier, queue, makeTurn('second'))).toBe('sent');
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  });
});
