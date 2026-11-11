// #2949 first slice (owner decision 63): the truthful "queued behind the
// current task" receipt.
//
// The decision reads a REAL TurnQueue: TurnQueue.drain makes an admitted turn
// the active turn synchronously when the queue was idle, so these tests prove
// the idle/queued split against the real queue, not a hand-set flag.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TurnQueue, type QueuedTurn } from '../../../src/runtimes/agent/turn-queue.ts';
import { fakeClock, type Clock } from '../../../src/lib/clock.ts';
import { config } from '../../../src/config.ts';
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
 * `adminCount` is the configured admin count. It reaches the notifier as a
 * vi.fn, so a test can show whether the receipt read it. The default, no
 * admin, offers /stop in a DM, so the older DM cases keep their /stop text.
 */
function makeNotifier(opts: { enabled?: boolean; clock?: Clock; adminCount?: number } = {}) {
  const send = vi.fn(async (_chatJid: string, _text: string) => {});
  const adminCount = vi.fn(() => opts.adminCount ?? 0);
  const notifier = new QueuedTurnReceiptNotifier({
    enabled: () => opts.enabled ?? true,
    send,
    adminCount,
    pausedChatSettings: config,
    ...(opts.clock ? { clock: opts.clock } : {}),
  });
  return { notifier, send, adminCount };
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

  it('says /stop cancels the running task AND what is queued and promises no reply; the no-/stop texts drop only that sentence', () => {
    // Break caught: "Queued behind the current task" read as "some other task is
    // running"; the user asked again and again to cancel tasks that did not exist.
    // Review break: "Send /stop to cancel" read as a guarantee, but a permitted
    // /stop can end uncertain. Review break (round 6): the fix that followed
    // promised a reply with the outcome, but that reply is sent without a check
    // that it arrived, so the sentence now promises no reply (next test).
    expect(QUEUED_TURN_RECEIPT_TEXT).toBe(
      '*Still working on your earlier request.* This message is next. Send /stop to cancel the earlier request and anything waiting.',
    );
    expect(QUEUED_TURN_RECEIPT_OTHER_TEXT).toBe(
      '*Still working on an earlier request.* This message is queued behind it. Send /stop to cancel that request and anything waiting.',
    );
    // Where the receipt offers no /stop: the same status, and no one named to
    // ask. Every group receipt is the second; the first is only for a 1:1 chat
    // where the receipt withholds /stop.
    expect(QUEUED_TURN_RECEIPT_NO_STOP_TEXT).toBe(
      '*Still working on your earlier request.* This message is next.',
    );
    expect(QUEUED_TURN_RECEIPT_OTHER_NO_STOP_TEXT).toBe(
      '*Still working on an earlier request.* This message is queued behind it.',
    );
  });

  // Review break (round 6): the /stop reply is sent without a check that it
  // arrived, and one sent through a poisoned outbound queue is refused (the
  // known-poisoned-queue tests B7 and T5 in chat-transport-send-direct.test.ts).
  // A receipt cannot know whether that reply will arrive, so no receipt
  // promises a reply.
  it('no receipt promises a reply: none of the four texts says "reply" or "outcome"', () => {
    const texts = {
      QUEUED_TURN_RECEIPT_TEXT,
      QUEUED_TURN_RECEIPT_OTHER_TEXT,
      QUEUED_TURN_RECEIPT_NO_STOP_TEXT,
      QUEUED_TURN_RECEIPT_OTHER_NO_STOP_TEXT,
    };
    // Four non-empty strings, so the check below cannot pass on a missing text.
    expect(Object.values(texts).filter((text) => typeof text === 'string' && text.length > 0)).toHaveLength(4);

    const promisingAReply = Object.entries(texts)
      .filter(([, text]) => /reply|outcome/i.test(text))
      .map(([name]) => name);
    expect(promisingAReply).toEqual([]);
  });

  it('says "your earlier request ... next" only for the sender\'s own request with nothing else waiting', () => {
    const { queue } = makeBlockingQueue();
    const { notifier, send } = makeNotifier();
    queue.enqueue(makeTurn('my long request'));

    expect(admit(notifier, queue, makeTurn('why is it taking so long'))).toBe('sent');

    expect(send.mock.calls).toEqual([[chatJid, QUEUED_TURN_RECEIPT_TEXT]]);
  });

  it('a group member queued behind someone else\'s request gets the other-request receipt, without /stop', () => {
    const { queue } = makeBlockingQueue();
    const { notifier, send } = makeNotifier();
    queue.enqueue(makeTurn('alice asks', { senderJid: '15550002@s.whatsapp.net', isGroup: true }));

    admit(notifier, queue, makeTurn('bob asks', { isGroup: true }));

    expect(send.mock.calls).toEqual([[chatJid, QUEUED_TURN_RECEIPT_OTHER_NO_STOP_TEXT]]);
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

  it('picks the text from the running turn\'s sender and purpose, the waiting count, and the /stop offer', () => {
    const me = { senderJid: '15550001@s.whatsapp.net', isGroup: false };
    const other = { senderJid: '15550002@s.whatsapp.net', isGroup: false };
    expect(queuedTurnReceiptText(me, me, 1, true)).toBe(QUEUED_TURN_RECEIPT_TEXT);
    expect(queuedTurnReceiptText(me, me, 2, true)).toBe(QUEUED_TURN_RECEIPT_OTHER_TEXT);
    expect(queuedTurnReceiptText(other, me, 1, true)).toBe(QUEUED_TURN_RECEIPT_OTHER_TEXT);
    expect(queuedTurnReceiptText({ ...me, purpose: 'scheduled-agent-job' }, me, 1, true))
      .toBe(QUEUED_TURN_RECEIPT_OTHER_TEXT);
    expect(queuedTurnReceiptText(me, me, 1, false)).toBe(QUEUED_TURN_RECEIPT_NO_STOP_TEXT);
    expect(queuedTurnReceiptText(me, me, 2, false)).toBe(QUEUED_TURN_RECEIPT_OTHER_NO_STOP_TEXT);
    expect(queuedTurnReceiptText(other, me, 1, false)).toBe(QUEUED_TURN_RECEIPT_OTHER_NO_STOP_TEXT);
  });

  // Review break (round 5): a group receipt took the own-request text from
  // sender equality alone, but it is sent to the whole group, so every other
  // member read a false or ambiguous "your". The other-request text is true
  // for every reader in either position.
  it('a group receipt never takes the own-request text: every member reads it, so "your" would be false for the others', () => {
    const meInGroup = { senderJid: '15550001@s.whatsapp.net', isGroup: true };
    const otherInGroup = { senderJid: '15550002@s.whatsapp.net', isGroup: true };
    expect(queuedTurnReceiptText(meInGroup, meInGroup, 1, false)).toBe(QUEUED_TURN_RECEIPT_OTHER_NO_STOP_TEXT);
    expect(queuedTurnReceiptText(meInGroup, meInGroup, 2, false)).toBe(QUEUED_TURN_RECEIPT_OTHER_NO_STOP_TEXT);
    expect(queuedTurnReceiptText(otherInGroup, meInGroup, 1, false)).toBe(QUEUED_TURN_RECEIPT_OTHER_NO_STOP_TEXT);
  });

  it('a failing send is contained: the decision stays sent and nothing throws', async () => {
    const { queue } = makeBlockingQueue();
    const send = vi.fn(async () => { throw new Error('transport down'); });
    const notifier = new QueuedTurnReceiptNotifier({
      enabled: () => true,
      send,
      adminCount: () => 0,
      pausedChatSettings: config,
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
//   send /stop.
// - No group receipt can promise every reader a working /stop: ingest drops
//   blocked and unresolved-LID members, and members who are not allowlisted
//   under the allowlisted_only sender policy; a mention-only group drops a
//   bare /stop (tests/core/ingest-group-approval.test.ts); and some transports
//   carry no mention data.
// So only a DM receipt offers /stop, and a group receipt reads no
// configuration. The contract against the real runtime gate is in
// queued-turn-receipt-runtime.test.ts.
describe('#2949 queued receipt: /stop is offered only where every reader may run it', () => {
  const otherMember = '15550002@s.whatsapp.net';

  function groupTurn(text: string, overrides: Partial<QueuedTurn> = {}): QueuedTurn {
    return makeTurn(text, { isGroup: true, ...overrides });
  }

  it.each([0, 1])('a group receipt has no /stop and reads no configuration, with %i admin(s) configured', (configured) => {
    const { queue } = makeBlockingQueue();
    const { notifier, send, adminCount } = makeNotifier({ adminCount: configured });
    queue.enqueue(groupTurn('running', { senderJid: otherMember }));

    expect(admit(notifier, queue, groupTurn('queued'))).toBe('sent');

    expect(send.mock.calls).toEqual([[chatJid, QUEUED_TURN_RECEIPT_OTHER_NO_STOP_TEXT]]);
    expect(adminCount).not.toHaveBeenCalled();
  });

  it('a group member behind their own request gets the other-request receipt, without /stop: every member reads it', () => {
    const { queue } = makeBlockingQueue();
    const { notifier, send } = makeNotifier();
    queue.enqueue(groupTurn('my long request'));

    expect(admit(notifier, queue, groupTurn('why is it taking so long'))).toBe('sent');

    expect(send.mock.calls).toEqual([[chatJid, QUEUED_TURN_RECEIPT_OTHER_NO_STOP_TEXT]]);
  });

  it('a DM gets the /stop copy with admins configured, and the admin count is never read', () => {
    const { queue } = makeBlockingQueue();
    const { notifier, send, adminCount } = makeNotifier({ adminCount: 1 });
    queue.enqueue(makeTurn('first'));

    expect(admit(notifier, queue, makeTurn('second'))).toBe('sent');

    expect(send.mock.calls).toEqual([[chatJid, QUEUED_TURN_RECEIPT_TEXT]]);
    expect(adminCount).not.toHaveBeenCalled();
  });
});

// Review break (round 4): a DM receipt offered /stop in a 1:1 chat listed in
// pausedChats. Ingest dispatches a paused chat's message only when it matches
// a pausedChatBypassPatterns entry, and /stop is not an admin command, so a
// bypass that admitted the queued message but not a bare /stop got the offer
// and then dropped the /stop. The offer now asks ingest's own paused-chat rule
// about the exact text it names. The rule pauses a chat by its conversation
// key or its chat JID, as ingest does. The ingest-to-runtime contract is in
// queued-turn-receipt-runtime.test.ts.
describe('#2949 queued receipt: a paused 1:1 chat is offered /stop only when ingest admits a bare /stop', () => {
  const otherChat = 'other-chat@s.whatsapp.net';
  const otherMember = '15550002@s.whatsapp.net';
  let pausedChats = new Set<string>();
  let bypassPatterns: string[] = [];
  // Every read of the two paused-chat settings, so a test can show which
  // receipts consult them.
  const pausedChatsRead = vi.fn(() => pausedChats);
  const bypassPatternsRead = vi.fn(() => bypassPatterns);
  let savedPausedChats: PropertyDescriptor | undefined;
  let savedBypassPatterns: PropertyDescriptor | undefined;

  function restoreConfigProp(key: string, descriptor: PropertyDescriptor | undefined): void {
    if (descriptor) Object.defineProperty(config, key, descriptor);
    else delete (config as Record<string, unknown>)[key];
  }

  beforeEach(() => {
    savedPausedChats = Object.getOwnPropertyDescriptor(config, 'pausedChats');
    savedBypassPatterns = Object.getOwnPropertyDescriptor(config, 'pausedChatBypassPatterns');
    pausedChats = new Set<string>();
    bypassPatterns = [];
    pausedChatsRead.mockClear();
    bypassPatternsRead.mockClear();
    Object.defineProperty(config, 'pausedChats', { configurable: true, enumerable: true, get: pausedChatsRead });
    Object.defineProperty(config, 'pausedChatBypassPatterns', { configurable: true, enumerable: true, get: bypassPatternsRead });
  });

  afterEach(() => {
    restoreConfigProp('pausedChats', savedPausedChats);
    restoreConfigProp('pausedChatBypassPatterns', savedBypassPatterns);
  });

  type Row = { title: string; paused: string[]; patterns: string[]; receipt: string };
  // makeTurn's conversation key is `mapKey` and its chat JID is `chatJid`.
  const rows: Row[] = [
    { title: 'paused by conversation key, no bypass pattern → not offered', paused: [mapKey], patterns: [], receipt: QUEUED_TURN_RECEIPT_NO_STOP_TEXT },
    { title: 'paused, a bypass pattern admits the queued message but not /stop → not offered', paused: [mapKey], patterns: ['^urgent:'], receipt: QUEUED_TURN_RECEIPT_NO_STOP_TEXT },
    { title: 'paused by chat JID only → not offered', paused: [chatJid], patterns: ['^urgent:'], receipt: QUEUED_TURN_RECEIPT_NO_STOP_TEXT },
    { title: 'paused, a bypass pattern admits /stop → offered', paused: [mapKey], patterns: ['^urgent:', '^/stop$'], receipt: QUEUED_TURN_RECEIPT_TEXT },
    { title: 'not paused, another chat is → offered', paused: [otherChat], patterns: [], receipt: QUEUED_TURN_RECEIPT_TEXT },
  ];

  it.each(rows.map((row) => [row.title, row] as const))('a DM receipt: %s', (_title, row) => {
    pausedChats = new Set(row.paused);
    bypassPatterns = row.patterns;
    const { queue } = makeBlockingQueue();
    const { notifier, send } = makeNotifier();
    queue.enqueue(makeTurn('urgent: first question'));

    expect(admit(notifier, queue, makeTurn('urgent: second question'))).toBe('sent');

    expect(send.mock.calls).toEqual([[chatJid, row.receipt]]);
  });

  it('a group receipt reads no paused-chat setting, even in a paused group whose bypass admits /stop', () => {
    pausedChats = new Set([mapKey, chatJid]);
    bypassPatterns = ['^/stop$'];
    const { queue } = makeBlockingQueue();
    const { notifier, send } = makeNotifier();
    queue.enqueue(makeTurn('running', { isGroup: true, senderJid: otherMember }));

    expect(admit(notifier, queue, makeTurn('queued', { isGroup: true }))).toBe('sent');

    expect(send.mock.calls).toEqual([[chatJid, QUEUED_TURN_RECEIPT_OTHER_NO_STOP_TEXT]]);
    expect(pausedChatsRead).not.toHaveBeenCalled();
    expect(bypassPatternsRead).not.toHaveBeenCalled();
  });

  it('positive control for the group pin: a DM receipt reads the paused chats', () => {
    pausedChats = new Set([otherChat]);
    const { queue } = makeBlockingQueue();
    const { notifier, send } = makeNotifier();
    queue.enqueue(makeTurn('first'));

    expect(admit(notifier, queue, makeTurn('second'))).toBe('sent');

    expect(send.mock.calls).toEqual([[chatJid, QUEUED_TURN_RECEIPT_TEXT]]);
    expect(pausedChatsRead).toHaveBeenCalled();
  });
});
