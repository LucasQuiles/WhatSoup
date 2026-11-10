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
  QUEUED_TURN_RECEIPT_NO_STOP_TEXT,
  QUEUED_TURN_RECEIPT_OTHER_NO_STOP_TEXT,
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

/**
 * `admins` are the sender JIDs the /stop authority treats as authenticated
 * admins; their count is the configured admin count. The default, no admin,
 * leaves /stop open everywhere, so the older cases keep their /stop texts.
 */
function makeNotifier(opts: { enabled?: boolean; clock?: Clock; admins?: readonly string[] } = {}) {
  const send = vi.fn(async (_chatJid: string, _text: string) => {});
  const admins = opts.admins ?? [];
  const isAdmin = vi.fn((senderJid: string) => admins.includes(senderJid));
  const notifier = new QueuedTurnReceiptNotifier({
    enabled: () => opts.enabled ?? true,
    send,
    stopAuthority: { adminCount: () => admins.length, isAdmin },
    ...(opts.clock ? { clock: opts.clock } : {}),
  });
  return { notifier, send, isAdmin };
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

  it('says /stop cancels the running task AND what is queued without promising the outcome; the no-/stop texts drop only that sentence', () => {
    // Break caught: "Queued behind the current task" read as "some other task is
    // running"; the user asked again and again to cancel tasks that did not exist.
    // Review break: "Send /stop to cancel" read as a guarantee, but a permitted
    // /stop can end uncertain, and its reply says so.
    expect(QUEUED_TURN_RECEIPT_TEXT).toBe(
      "*Still working on your earlier request.* This message is next. Send /stop to cancel the earlier request and anything waiting; I'll say whether it stopped.",
    );
    expect(QUEUED_TURN_RECEIPT_OTHER_TEXT).toBe(
      "*Still working on an earlier request.* This message is queued behind it. Send /stop to cancel that request and anything waiting; I'll say whether it stopped.",
    );
    // For a sender the /stop gate refuses: the same status, no /stop, and no
    // one named to ask.
    expect(QUEUED_TURN_RECEIPT_NO_STOP_TEXT).toBe(
      '*Still working on your earlier request.* This message is next.',
    );
    expect(QUEUED_TURN_RECEIPT_OTHER_NO_STOP_TEXT).toBe(
      '*Still working on an earlier request.* This message is queued behind it.',
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

  it('picks the text from the running turn\'s sender and purpose, the waiting count, and the /stop authority', () => {
    const me = { senderJid: '15550001@s.whatsapp.net' };
    expect(queuedTurnReceiptText(me, me, 1, true)).toBe(QUEUED_TURN_RECEIPT_TEXT);
    expect(queuedTurnReceiptText(me, me, 2, true)).toBe(QUEUED_TURN_RECEIPT_OTHER_TEXT);
    expect(queuedTurnReceiptText({ senderJid: '15550002@s.whatsapp.net' }, me, 1, true))
      .toBe(QUEUED_TURN_RECEIPT_OTHER_TEXT);
    expect(queuedTurnReceiptText({ ...me, purpose: 'scheduled-agent-job' }, me, 1, true))
      .toBe(QUEUED_TURN_RECEIPT_OTHER_TEXT);
    expect(queuedTurnReceiptText(me, me, 1, false)).toBe(QUEUED_TURN_RECEIPT_NO_STOP_TEXT);
    expect(queuedTurnReceiptText(me, me, 2, false)).toBe(QUEUED_TURN_RECEIPT_OTHER_NO_STOP_TEXT);
    expect(queuedTurnReceiptText({ senderJid: '15550002@s.whatsapp.net' }, me, 1, false))
      .toBe(QUEUED_TURN_RECEIPT_OTHER_NO_STOP_TEXT);
  });

  it('a failing send is contained: the decision stays sent and nothing throws', async () => {
    const { queue } = makeBlockingQueue();
    const send = vi.fn(async () => { throw new Error('transport down'); });
    const notifier = new QueuedTurnReceiptNotifier({
      enabled: () => true,
      send,
      stopAuthority: { adminCount: () => 0, isAdmin: () => false },
    });
    queue.enqueue(makeTurn('first'));

    expect(admit(notifier, queue, makeTurn('second'))).toBe('sent');
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  });
});

// Review break: both texts told every recipient to send /stop, but in a
// per_chat group with admins configured the command gate refuses /stop from a
// non-admin ("_Not authorized._"). The /stop sentence now follows the gate's
// answer for the QUEUED message's sender. The contract against the real
// runtime gate is in queued-turn-receipt-runtime.test.ts.
describe('#2949 queued receipt: /stop is offered only to a sender the /stop gate accepts', () => {
  const admin = '15550009@s.whatsapp.net';
  const otherMember = '15550002@s.whatsapp.net';
  const queuedSender = '15550001@s.whatsapp.net'; // makeTurn's default sender

  function groupTurn(text: string, overrides: Partial<QueuedTurn> = {}): QueuedTurn {
    return makeTurn(text, { isGroup: true, ...overrides });
  }

  it('a non-admin group member, with admins configured, gets the receipt without /stop', () => {
    const { queue } = makeBlockingQueue();
    const { notifier, send, isAdmin } = makeNotifier({ admins: [admin] });
    queue.enqueue(groupTurn('running', { senderJid: otherMember }));

    expect(admit(notifier, queue, groupTurn('queued'))).toBe('sent');

    expect(send.mock.calls).toEqual([[chatJid, QUEUED_TURN_RECEIPT_OTHER_NO_STOP_TEXT]]);
    // The lookup asked about the queued message's sender, not the running turn's.
    expect(isAdmin.mock.calls).toEqual([[queuedSender]]);
  });

  it('an admin group member gets the receipt with /stop', () => {
    const { queue } = makeBlockingQueue();
    const { notifier, send, isAdmin } = makeNotifier({ admins: [queuedSender] });
    queue.enqueue(groupTurn('running', { senderJid: otherMember }));

    expect(admit(notifier, queue, groupTurn('queued'))).toBe('sent');

    expect(send.mock.calls).toEqual([[chatJid, QUEUED_TURN_RECEIPT_OTHER_TEXT]]);
    expect(isAdmin.mock.calls).toEqual([[queuedSender]]);
  });

  it('a non-admin group member behind their own request, with nothing else waiting, is told it is next, without /stop', () => {
    const { queue } = makeBlockingQueue();
    const { notifier, send } = makeNotifier({ admins: [admin] });
    queue.enqueue(groupTurn('my long request'));

    admit(notifier, queue, groupTurn('why is it taking so long'));

    expect(send.mock.calls).toEqual([[chatJid, QUEUED_TURN_RECEIPT_NO_STOP_TEXT]]);
  });

  it('a DM sender gets /stop with admins configured, and no admin lookup runs', () => {
    const { queue } = makeBlockingQueue();
    const { notifier, send, isAdmin } = makeNotifier({ admins: [admin] });
    queue.enqueue(makeTurn('first'));

    admit(notifier, queue, makeTurn('second'));

    expect(send.mock.calls).toEqual([[chatJid, QUEUED_TURN_RECEIPT_TEXT]]);
    expect(isAdmin).not.toHaveBeenCalled();
  });

  it('with no admin configured, a group member gets /stop, and no admin lookup runs', () => {
    const { queue } = makeBlockingQueue();
    const { notifier, send, isAdmin } = makeNotifier();
    queue.enqueue(groupTurn('running', { senderJid: otherMember }));

    admit(notifier, queue, groupTurn('queued'));

    expect(send.mock.calls).toEqual([[chatJid, QUEUED_TURN_RECEIPT_OTHER_TEXT]]);
    expect(isAdmin).not.toHaveBeenCalled();
  });

  it('runs the admin lookup only for an admission that sends a receipt', () => {
    const clock = fakeClock(1_000_000);
    const { queue } = makeBlockingQueue();
    const { notifier, isAdmin } = makeNotifier({ admins: [admin], clock });

    expect(admit(notifier, queue, groupTurn('running', { senderJid: otherMember }))).toBe('started_immediately');
    expect(admit(notifier, queue, groupTurn('job', { purpose: 'scheduled-agent-job' }))).toBe('scheduled_job');
    expect(admit(notifier, queue, groupTurn('single-scope waiter'), 'single')).toBe('scope_not_per_chat');
    expect(isAdmin).not.toHaveBeenCalled();

    expect(admit(notifier, queue, groupTurn('queued'))).toBe('sent');
    expect(admit(notifier, queue, groupTurn('within the cooldown'))).toBe('cooldown');

    expect(isAdmin).toHaveBeenCalledTimes(1);
  });

  it('a failing admin lookup falls back to the receipt without /stop, as a normal send that uses the cooldown', () => {
    // A true but less helpful receipt beats none: the sender is not offered a
    // command the gate might refuse.
    const { queue } = makeBlockingQueue();
    const send = vi.fn(async (_chatJid: string, _text: string) => {});
    const isAdmin = vi.fn((_senderJid: string): boolean => {
      throw new Error('phone lookup failed');
    });
    const notifier = new QueuedTurnReceiptNotifier({
      enabled: () => true,
      send,
      stopAuthority: { adminCount: () => 1, isAdmin },
    });
    queue.enqueue(groupTurn('running', { senderJid: otherMember }));

    expect(admit(notifier, queue, groupTurn('queued'))).toBe('sent');
    expect(admit(notifier, queue, groupTurn('again'))).toBe('cooldown');

    expect(isAdmin).toHaveBeenCalledTimes(1);
    expect(send.mock.calls).toEqual([[chatJid, QUEUED_TURN_RECEIPT_OTHER_NO_STOP_TEXT]]);
  });
});
