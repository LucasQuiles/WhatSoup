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
  QUEUED_TURN_RECEIPT_GROUP_TEXT,
  QUEUED_TURN_RECEIPT_NO_STOP_TEXT,
  QUEUED_TURN_RECEIPT_OTHER_GROUP_TEXT,
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
 * `adminCount` is the configured admin count and `allowlistedOnly` the strict
 * group sender policy. Both reach the notifier as vi.fn, so a test can show
 * which one the receipt read. The defaults (no admin, any member may reach
 * the bot) offer /stop everywhere, so the older DM cases keep their /stop text.
 */
function makeNotifier(
  opts: { enabled?: boolean; clock?: Clock; adminCount?: number; allowlistedOnly?: boolean } = {},
) {
  const send = vi.fn(async (_chatJid: string, _text: string) => {});
  const adminCount = vi.fn(() => opts.adminCount ?? 0);
  const groupSendersAllowlistedOnly = vi.fn(() => opts.allowlistedOnly ?? false);
  const notifier = new QueuedTurnReceiptNotifier({
    enabled: () => opts.enabled ?? true,
    send,
    adminCount,
    groupSendersAllowlistedOnly,
    ...(opts.clock ? { clock: opts.clock } : {}),
  });
  return { notifier, send, adminCount, groupSendersAllowlistedOnly };
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

  it('says /stop cancels the running task AND what is queued and promises only a reply with the outcome; a group is told to mention the bot; the no-/stop texts drop only that sentence', () => {
    // Break caught: "Queued behind the current task" read as "some other task is
    // running"; the user asked again and again to cancel tasks that did not exist.
    // Review break: "Send /stop to cancel" read as a guarantee, but a permitted
    // /stop can end uncertain, and its reply says so.
    // Review break: a group that is not on the group allowlist dispatches only a
    // message that mentions the bot, so a bare /stop there never arrives.
    expect(QUEUED_TURN_RECEIPT_TEXT).toBe(
      "*Still working on your earlier request.* This message is next. Send /stop to cancel the earlier request and anything waiting; I'll reply with the outcome.",
    );
    expect(QUEUED_TURN_RECEIPT_GROUP_TEXT).toBe(
      "*Still working on your earlier request.* This message is next. Mention me with /stop to cancel the earlier request and anything waiting; I'll reply with the outcome.",
    );
    expect(QUEUED_TURN_RECEIPT_OTHER_TEXT).toBe(
      "*Still working on an earlier request.* This message is queued behind it. Send /stop to cancel that request and anything waiting; I'll reply with the outcome.",
    );
    expect(QUEUED_TURN_RECEIPT_OTHER_GROUP_TEXT).toBe(
      "*Still working on an earlier request.* This message is queued behind it. Mention me with /stop to cancel that request and anything waiting; I'll reply with the outcome.",
    );
    // Where the receipt offers no /stop: the same status, and no one named to
    // ask.
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

  it('a group member queued behind someone else\'s request gets the other-request receipt, with the mention copy', () => {
    const { queue } = makeBlockingQueue();
    const { notifier, send } = makeNotifier();
    queue.enqueue(makeTurn('alice asks', { senderJid: '15550002@s.whatsapp.net', isGroup: true }));

    admit(notifier, queue, makeTurn('bob asks', { isGroup: true }));

    expect(send.mock.calls).toEqual([[chatJid, QUEUED_TURN_RECEIPT_OTHER_GROUP_TEXT]]);
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

  it('picks the text from the running turn\'s sender and purpose, the waiting count, the /stop offer and the venue', () => {
    const me = { senderJid: '15550001@s.whatsapp.net', isGroup: false };
    const meInGroup = { ...me, isGroup: true };
    const other = { senderJid: '15550002@s.whatsapp.net' };
    expect(queuedTurnReceiptText(me, me, 1, true)).toBe(QUEUED_TURN_RECEIPT_TEXT);
    expect(queuedTurnReceiptText(me, me, 2, true)).toBe(QUEUED_TURN_RECEIPT_OTHER_TEXT);
    expect(queuedTurnReceiptText(other, me, 1, true)).toBe(QUEUED_TURN_RECEIPT_OTHER_TEXT);
    expect(queuedTurnReceiptText({ senderJid: me.senderJid, purpose: 'scheduled-agent-job' }, me, 1, true))
      .toBe(QUEUED_TURN_RECEIPT_OTHER_TEXT);
    expect(queuedTurnReceiptText(me, meInGroup, 1, true)).toBe(QUEUED_TURN_RECEIPT_GROUP_TEXT);
    expect(queuedTurnReceiptText(me, meInGroup, 2, true)).toBe(QUEUED_TURN_RECEIPT_OTHER_GROUP_TEXT);
    expect(queuedTurnReceiptText(other, meInGroup, 1, true)).toBe(QUEUED_TURN_RECEIPT_OTHER_GROUP_TEXT);
    expect(queuedTurnReceiptText(me, me, 1, false)).toBe(QUEUED_TURN_RECEIPT_NO_STOP_TEXT);
    expect(queuedTurnReceiptText(me, meInGroup, 1, false)).toBe(QUEUED_TURN_RECEIPT_NO_STOP_TEXT);
    expect(queuedTurnReceiptText(me, me, 2, false)).toBe(QUEUED_TURN_RECEIPT_OTHER_NO_STOP_TEXT);
    expect(queuedTurnReceiptText(other, meInGroup, 1, false)).toBe(QUEUED_TURN_RECEIPT_OTHER_NO_STOP_TEXT);
  });

  it('a failing send is contained: the decision stays sent and nothing throws', async () => {
    const { queue } = makeBlockingQueue();
    const send = vi.fn(async () => { throw new Error('transport down'); });
    const notifier = new QueuedTurnReceiptNotifier({
      enabled: () => true,
      send,
      adminCount: () => 0,
      groupSendersAllowlistedOnly: () => false,
    });
    queue.enqueue(makeTurn('first'));

    expect(admit(notifier, queue, makeTurn('second'))).toBe('sent');
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  });
});

// Review breaks:
// - Every group member reads the receipt, but its /stop sentence followed the
//   queued sender's authority, so in a per_chat group with admins configured
//   an admin's receipt told members the gate refuses ("_Not authorized._") to
//   send /stop. The receipt now asks the /stop gate for a reader who is not an
//   admin, and never asks whether anyone is an admin.
// - Under the allowlisted_only group sender policy, a member who is not
//   allowlisted never reaches the gate, so such a group gets no /stop either.
// - A group that is not on the group allowlist dispatches only a message that
//   mentions the bot, so the group copy says "Mention me with /stop" (the
//   ingest pin is in tests/core/ingest-group-approval.test.ts).
// The contract against the real runtime gate is in
// queued-turn-receipt-runtime.test.ts.
describe('#2949 queued receipt: /stop is offered only where every reader may run it', () => {
  const otherMember = '15550002@s.whatsapp.net';

  function groupTurn(text: string, overrides: Partial<QueuedTurn> = {}): QueuedTurn {
    return makeTurn(text, { isGroup: true, ...overrides });
  }

  it('in a group with admins configured, the receipt has no /stop: every member reads it, and the gate refuses members who are not admins', () => {
    const { queue } = makeBlockingQueue();
    const { notifier, send, adminCount } = makeNotifier({ adminCount: 1 });
    queue.enqueue(groupTurn('running', { senderJid: otherMember }));

    expect(admit(notifier, queue, groupTurn('queued'))).toBe('sent');

    expect(send.mock.calls).toEqual([[chatJid, QUEUED_TURN_RECEIPT_OTHER_NO_STOP_TEXT]]);
    expect(adminCount).toHaveBeenCalledTimes(1);
  });

  it('a group member behind their own request, with admins configured, is told it is next, without /stop', () => {
    const { queue } = makeBlockingQueue();
    const { notifier, send } = makeNotifier({ adminCount: 1 });
    queue.enqueue(groupTurn('my long request'));

    expect(admit(notifier, queue, groupTurn('why is it taking so long'))).toBe('sent');

    expect(send.mock.calls).toEqual([[chatJid, QUEUED_TURN_RECEIPT_NO_STOP_TEXT]]);
  });

  it('a DM gets the DM /stop copy whatever the admins and the group sender policy, and reads neither', () => {
    const { queue } = makeBlockingQueue();
    const { notifier, send, adminCount, groupSendersAllowlistedOnly } = makeNotifier({
      adminCount: 1,
      allowlistedOnly: true,
    });
    queue.enqueue(makeTurn('first'));

    expect(admit(notifier, queue, makeTurn('second'))).toBe('sent');

    expect(send.mock.calls).toEqual([[chatJid, QUEUED_TURN_RECEIPT_TEXT]]);
    expect(adminCount).not.toHaveBeenCalled();
    expect(groupSendersAllowlistedOnly).not.toHaveBeenCalled();
  });

  it('with no admin configured, a group gets the mention copy', () => {
    const { queue } = makeBlockingQueue();
    const { notifier, send } = makeNotifier();
    queue.enqueue(groupTurn('running', { senderJid: otherMember }));

    expect(admit(notifier, queue, groupTurn('queued'))).toBe('sent');

    expect(send.mock.calls).toEqual([[chatJid, QUEUED_TURN_RECEIPT_OTHER_GROUP_TEXT]]);
  });

  it('with no admin configured, a group member behind their own request gets the own-request mention copy', () => {
    const { queue } = makeBlockingQueue();
    const { notifier, send } = makeNotifier();
    queue.enqueue(groupTurn('my long request'));

    expect(admit(notifier, queue, groupTurn('why is it taking so long'))).toBe('sent');

    expect(send.mock.calls).toEqual([[chatJid, QUEUED_TURN_RECEIPT_GROUP_TEXT]]);
  });

  it('under the allowlisted_only group sender policy, a group gets no /stop even with no admin configured', () => {
    const { queue } = makeBlockingQueue();
    const { notifier, send } = makeNotifier({ allowlistedOnly: true });
    queue.enqueue(groupTurn('running', { senderJid: otherMember }));

    expect(admit(notifier, queue, groupTurn('queued'))).toBe('sent');

    expect(send.mock.calls).toEqual([[chatJid, QUEUED_TURN_RECEIPT_OTHER_NO_STOP_TEXT]]);
  });
});
