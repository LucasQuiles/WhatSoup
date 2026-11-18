// #3829 review items (a) and (b): restart_self's owed-reply gate driven through a
// REAL OutboundQueue, not a queue double. deliverOwedReplyBeforeRestart
// (src/runtimes/agent/self-restart.ts) treats flushes that settle with an
// unchanged getSendFailureCount() as delivered, so every queue path that ends a
// send without counting a failure is checked here against the owed reply.
//
// Every case begins turn evidence, as each admitted runtime turn does
// (runtime-turn-coordinator.ts). The queue then holds the turn's streamed answer
// until the turn ends, which is the state restart_self meets.
//
// Each test is marked:
//   guard        - holds whether or not restart_self commits the deferred answer.
//   expected-red - fails while restart_self leaves the deferred answer to the turn
//                  abort, which salvages it as status text or drops it; passes
//                  once restart_self sends it as the turn's answer first.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/lib/emit-alert.ts', () => ({
  emitAlert: vi.fn(() => true),
  emitAlertChecked: vi.fn(() => true),
  emitObservationChecked: vi.fn(() => true),
  clearAlertSource: vi.fn(() => true),
  clearAlertSourceChecked: vi.fn(() => true),
}));

import {
  buildRestartSelfTool,
  deliverOwedReplyBeforeRestart,
  OWED_REPLY_FLUSH_GRACE_MS,
  type TriggerSelfRestartOptions,
} from '../../../src/runtimes/agent/self-restart.ts';
import {
  OutboundQueue,
  SALVAGED_REPLY_NOTICE,
  TOOL_BATCH_DELAY_MS,
} from '../../../src/runtimes/agent/outbound-queue.ts';
import { __resetForTests as resetEchoGuard, recordGroupOutbound } from '../../../src/core/echo-guard.ts';
import type { Messenger, SubmissionReceipt } from '../../../src/core/types.ts';
import type { DurabilityEngine } from '../../../src/core/durability.ts';
import type { SessionContext } from '../../../src/mcp/types.ts';
import { WhatSoupError } from '../../../src/errors.ts';
import { deferred } from '../../helpers/deferred.ts';

const DM_JID = '15550100111@s.whatsapp.net';
const GROUP_JID = '1111111000000000@g.us';
const STATUS_JID = 'status-log@g.us';
const OWED = 'On it, restarting.';
const LATER = 'Restart did not start, here is where things stand.';
const NEXT = 'Next turn reply.';
const SESSION: SessionContext = { tier: 'global' };
/** Covers MIN_SEND_GAP_MS pacing and flush spins; well under the 10 s grace. */
const SETTLE_MS = 1_000;

interface Attempt { jid: string; text: string }

interface RestartSelfResult {
  ok: boolean;
  restarting: boolean;
  cause?: string;
}

/** Messenger that records every send attempt (failed ones too) before `impl` decides the outcome. */
function makeMessenger(
  impl: (jid: string, text: string) => Promise<SubmissionReceipt> = async () => ({ waMessageId: null }),
): { messenger: Messenger; attempts: Attempt[] } {
  const attempts: Attempt[] = [];
  const messenger: Messenger = {
    sendMessage: vi.fn(async (jid: string, text: string) => {
      attempts.push({ jid, text });
      return impl(jid, text);
    }),
    sendMedia: vi.fn(async () => ({ waMessageId: null })),
    setTyping: vi.fn(async () => {}),
  };
  return { messenger, attempts };
}

function makeDurabilityStub() {
  let nextId = 0;
  return {
    createOutboundOp: vi.fn(() => ++nextId),
    markSending: vi.fn(),
    markSubmitted: vi.fn(),
    markMaybeSent: vi.fn(),
    markFailedPermanent: vi.fn(),
    markDeferred: vi.fn(),
    markTerminal: vi.fn(),
  };
}

const governorShed = (): WhatSoupError => new WhatSoupError('outbound governor shed', 'OUTBOUND_GOVERNOR_SHED');

async function settle<T>(pending: Promise<T>, ms = SETTLE_MS): Promise<T> {
  await vi.advanceTimersByTimeAsync(ms);
  return pending;
}

/** Call restart_self wired to the real queue exactly as runtime.ts wires it; only the trigger is a double. */
async function callRestart(queue: OutboundQueue, advanceMs = SETTLE_MS) {
  const trigger = vi.fn(async (_opts: TriggerSelfRestartOptions) => ({ ok: true, markerPath: '/data/bot-a/m' }));
  const sendAck = vi.fn(async (_chatJid: string, _text: string) => {});
  const tool = buildRestartSelfTool({
    instanceName: 'bot-a',
    dataRoot: '/data/bot-a',
    resolveChatJid: () => queue.targetChatJid,
    deliverOwedReply: () => deliverOwedReplyBeforeRestart(queue),
    sendAck,
    serviceManager: { restartSelf: vi.fn(async () => {}) },
    trigger,
    assertAdmin: () => {},
  });
  const result = await settle(tool.handler({ reason: 'load merged main' }, SESSION), advanceMs);
  return { result: result as RestartSelfResult, trigger, sendAck };
}

/** A full-mode turn whose first tool status was already sent, so the turn counts as visible. */
async function queueAfterVisibleToolStatus(messenger: Messenger, durability: ReturnType<typeof makeDurabilityStub>) {
  const queue = new OutboundQueue(messenger, DM_JID);
  queue.setDurability(durability as unknown as DurabilityEngine);
  queue.beginTurnEvidence('turn-1');
  queue.enqueueToolUpdate({ category: 'running', detail: 'Running deploy check' });
  // The tool batch timer sends the status. No queue.flush() here: it would reset
  // the turn's visible-output flag that the restart path meets in a live turn.
  await vi.advanceTimersByTimeAsync(TOOL_BATCH_DELAY_MS);
  queue.enqueueStreamingText(OWED, 'answer');
  return queue;
}

describe('restart_self owed reply through a real OutboundQueue (#3829)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetEchoGuard();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    resetEchoGuard();
    vi.restoreAllMocks();
  });

  describe('(a) continuity after a refused restart', () => {
    // expected-red: the failure is injected into whichever send carries the owed
    // text. A refused restart keeps the queue open and unpoisoned, keeps the
    // failed op attributed to its turn as an answer op, and keeps delivering for
    // the rest of the turn and the next turn.
    it('keeps the queue usable for the rest of the turn and the next turn after an owed send fails', async () => {
      const { messenger, attempts } = makeMessenger(async (_jid, text) => {
        if (text.includes(OWED)) throw governorShed();
        return { waMessageId: null };
      });
      const durability = makeDurabilityStub();
      const queue = new OutboundQueue(messenger, DM_JID);
      queue.setDurability(durability as unknown as DurabilityEngine);
      queue.beginTurnEvidence('turn-1');
      queue.enqueueStreamingText(OWED, 'answer');

      const { result, trigger } = await callRestart(queue);

      expect(result).toMatchObject({ ok: false, restarting: false, cause: 'send_failed' });
      expect(trigger).not.toHaveBeenCalled();
      // Not silently lost: tried once, its op holds the failure disposition.
      expect(durability.markFailedPermanent).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ failure_code: 'outbound.governor_shed' }),
      );
      expect(queue.isPoisoned()).toBe(false);

      // The model continues the same turn after the refused tool call.
      queue.enqueueStreamingText(LATER, 'answer');
      queue.commitStreamingText();
      queue.endTurn();
      const turnOne = await settle(queue.flushTurnEvidence('turn-1'));

      queue.beginTurnEvidence('turn-2');
      queue.enqueueText(NEXT, 'answer');
      const turnTwo = await settle(queue.flushTurnEvidence('turn-2'));

      expect(attempts).toEqual([
        { jid: DM_JID, text: OWED },
        { jid: DM_JID, text: LATER },
        { jid: DM_JID, text: NEXT },
      ]);
      expect(durability.markSubmitted.mock.calls.map((call) => call[0])).toEqual([2, 3]);
      // The failed owed op stays attributed to its turn so finalization sees it.
      expect(turnOne.answerOpIds).toEqual([1, 2]);
      expect(turnTwo.answerOpIds).toEqual([3]);
      expect(queue.getSendFailureCount()).toBe(1);
      expect(queue.isPoisoned()).toBe(false);
    });

    // expected-red: on 'timeout' the pending owed send stays on the queue chain and
    // finishes on its own (self-restart.ts); nothing is re-enqueued.
    it('lets an owed send still pending at the grace limit finish once, then keeps delivering', async () => {
      const owedSend = deferred<SubmissionReceipt>();
      const { messenger, attempts } = makeMessenger((_jid, text) => (
        text.includes(OWED) ? owedSend.promise : Promise.resolve({ waMessageId: null })
      ));
      const durability = makeDurabilityStub();
      const queue = new OutboundQueue(messenger, DM_JID);
      queue.setDurability(durability as unknown as DurabilityEngine);
      queue.beginTurnEvidence('turn-1');
      queue.enqueueStreamingText(OWED, 'answer');

      const { result, trigger } = await callRestart(queue, OWED_REPLY_FLUSH_GRACE_MS);

      expect(result).toMatchObject({ ok: false, restarting: false, cause: 'timeout' });
      expect(trigger).not.toHaveBeenCalled();

      owedSend.resolve({ waMessageId: 'wa-owed' });
      await vi.advanceTimersByTimeAsync(SETTLE_MS);
      queue.enqueueText(LATER, 'answer');
      await settle(queue.flush());

      expect(attempts.map((attempt) => attempt.text)).toEqual([OWED, LATER]);
      expect(durability.markSubmitted).toHaveBeenCalledWith(1, 'wa-owed', 1);
      expect(durability.markSubmitted.mock.calls.map((call) => call[0])).toEqual([1, 2]);
      expect(durability.markFailedPermanent).not.toHaveBeenCalled();
      expect(durability.markMaybeSent).not.toHaveBeenCalled();
      expect(queue.getSendFailureCount()).toBe(0);
      expect(queue.isPoisoned()).toBe(false);
    });
  });

  describe('(b) send outcomes that do not change getSendFailureCount', () => {
    // guard (was expected-red on c1815df9, failed in its slot run): sendWithPacing
    // drops the chunk when the echo guard (core/echo-guard.ts:37-52) holds a
    // cross-session cooldown for the group. The drop must count as undelivered so
    // self-restart.ts refuses the restart; the guard itself must still drop it.
    it('echo guard: an owed group reply dropped by the cross-session cooldown stops the restart', async () => {
      recordGroupOutbound(GROUP_JID, 'another-queue-token');
      const { messenger, attempts } = makeMessenger();
      const queue = new OutboundQueue(messenger, GROUP_JID);
      queue.beginTurnEvidence('turn-1');
      queue.enqueueStreamingText(OWED, 'answer');

      const { result, trigger, sendAck } = await callRestart(queue);

      // Echo guard preserved: the owed reply never reached the transport.
      expect(attempts).toEqual([]);
      expect(queue.getSendFailureCount()).toBe(1);
      expect(result).toMatchObject({ ok: false, restarting: false, cause: 'send_failed' });
      expect(sendAck).not.toHaveBeenCalled();
      expect(trigger).not.toHaveBeenCalled();
    });

    // expected-red: enqueue drops a chunk only when the same chat + text key was
    // promoted by markLastTerminal({ dedupeText: true }) after a provider
    // submission, inside TERMINAL_TEXT_DEDUPE_WINDOW_MS. The user already holds
    // that exact text, so delivered: true and a restart are correct. (No src
    // caller passes dedupeText: true at d95f9f19.)
    it('dedupe: an owed reply identical to terminal text already submitted to the chat counts as delivered', async () => {
      const { messenger, attempts } = makeMessenger();
      const queue = new OutboundQueue(messenger, DM_JID);
      queue.enqueueText(OWED, 'answer');
      await settle(queue.flush());
      queue.markLastTerminal({ dedupeText: true });
      queue.beginTurnEvidence('turn-1');
      queue.enqueueStreamingText(OWED, 'answer');

      const { result, trigger } = await callRestart(queue);

      expect(attempts.map((attempt) => attempt.text)).toEqual([OWED]);
      expect(result).toMatchObject({ ok: true, restarting: true });
      expect(trigger).toHaveBeenCalledTimes(1);
    });

    // expected-red: the dedupe key is set only on submission, so an earlier failed
    // send of the same text cannot make dedupe hide the owed reply.
    it('dedupe: an earlier failed send of the same text does not suppress the owed reply', async () => {
      let calls = 0;
      const { messenger, attempts } = makeMessenger(async () => {
        calls += 1;
        if (calls === 1) throw governorShed();
        return { waMessageId: null };
      });
      const queue = new OutboundQueue(messenger, DM_JID);
      queue.enqueueText(OWED, 'answer');
      await settle(queue.flush());
      queue.markLastTerminal({ dedupeText: true });
      queue.beginTurnEvidence('turn-1');
      queue.enqueueStreamingText(OWED, 'answer');

      const { result, trigger } = await callRestart(queue);

      expect(attempts.map((attempt) => attempt.text)).toEqual([OWED, OWED]);
      expect(queue.getSendFailureCount()).toBe(1);
      expect(result).toMatchObject({ ok: true, restarting: true });
      expect(trigger).toHaveBeenCalledTimes(1);
    });

    // expected-red: the tool-status redirect send swallows its error and is not
    // counted. It carries tool status only, never the owed reply, so it must not
    // change the owed-reply outcome.
    it('redirect: a rejected tool-status redirect send neither blocks nor fails the owed reply', async () => {
      const { messenger, attempts } = makeMessenger(async (jid) => {
        if (jid === STATUS_JID) throw new Error('status channel down');
        return { waMessageId: null };
      });
      const queue = new OutboundQueue(messenger, DM_JID);
      queue.beginTurnEvidence('turn-1');
      queue.setToolUpdateRedirectJid(STATUS_JID);
      queue.enqueueToolUpdate({ category: 'running', detail: 'Running deploy check' });
      await vi.advanceTimersByTimeAsync(TOOL_BATCH_DELAY_MS);
      queue.enqueueStreamingText(OWED, 'answer');

      const { result, trigger } = await callRestart(queue);

      expect(attempts.map((attempt) => attempt.jid)).toEqual([STATUS_JID, DM_JID]);
      expect(attempts[1]?.text).toBe(OWED);
      expect(queue.getSendFailureCount()).toBe(0);
      expect(result).toMatchObject({ ok: true, restarting: true });
      expect(trigger).toHaveBeenCalledTimes(1);
    });

    // expected-red: the redirect send is chained on the queue chain with no
    // SEND_TIMEOUT_MS race, so the owed send waits behind a hung one; the flush
    // stays pending and self-restart.ts refuses at the grace limit.
    it('redirect: an owed reply queued behind a hung redirect send stops the restart, then sends once', async () => {
      const statusSend = deferred<SubmissionReceipt>();
      const { messenger, attempts } = makeMessenger((jid) => (
        jid === STATUS_JID ? statusSend.promise : Promise.resolve({ waMessageId: null })
      ));
      const queue = new OutboundQueue(messenger, DM_JID);
      queue.beginTurnEvidence('turn-1');
      queue.setToolUpdateRedirectJid(STATUS_JID);
      queue.enqueueToolUpdate({ category: 'running', detail: 'Running deploy check' });
      await vi.advanceTimersByTimeAsync(TOOL_BATCH_DELAY_MS);
      queue.enqueueStreamingText(OWED, 'answer');

      const { result, trigger } = await callRestart(queue, OWED_REPLY_FLUSH_GRACE_MS);

      expect(attempts.map((attempt) => attempt.jid)).toEqual([STATUS_JID]);
      expect(result).toMatchObject({ ok: false, restarting: false, cause: 'timeout' });
      expect(trigger).not.toHaveBeenCalled();

      statusSend.resolve({ waMessageId: null });
      await settle(queue.flush());

      expect(attempts).toEqual([
        { jid: STATUS_JID, text: expect.stringContaining('Running deploy check') },
        { jid: DM_JID, text: OWED },
      ]);
    });

    // guard: minimal mode moves the streamed text into the deferred pen at the
    // tool boundary. The restart's abort salvages it with the status role and
    // sends it through enqueuePreparedText and sendWithRetry, which counts the
    // failure. The pen is emptied, so endTurn's path C cannot resend it.
    it('status role: a failed salvage send of deferred owed text stops the restart and is not resent', async () => {
      const { messenger, attempts } = makeMessenger(async (_jid, text) => {
        if (text.includes(SALVAGED_REPLY_NOTICE)) throw governorShed();
        return { waMessageId: null };
      });
      const durability = makeDurabilityStub();
      const queue = new OutboundQueue(messenger, DM_JID);
      queue.setDurability(durability as unknown as DurabilityEngine);
      queue.setToolUpdateMode('minimal');
      queue.beginTurnEvidence('turn-1');
      queue.enqueueStreamingText(OWED, 'answer');
      queue.discardPreToolAssistantText();

      const { result, trigger } = await callRestart(queue);

      expect(result).toMatchObject({ ok: false, restarting: false, cause: 'send_failed' });
      expect(trigger).not.toHaveBeenCalled();
      expect(durability.markFailedPermanent).toHaveBeenCalledTimes(1);

      queue.endTurn();
      await settle(queue.flush());

      expect(attempts).toHaveLength(1);
      expect(attempts[0]?.text).toContain(SALVAGED_REPLY_NOTICE);
      expect(attempts[0]?.text).toContain(OWED);
    });
  });

  describe('(c) owed answer after a visible tool status in full mode', () => {
    // expected-red: the default full mode sends tool statuses, and the first one
    // marks the turn visible. The turn abort then drops a deferred answer instead
    // of salvaging it, so the restart went ahead with the answer never sent.
    it('sends the deferred answer as a normal answer message before the restart', async () => {
      const { messenger, attempts } = makeMessenger();
      const durability = makeDurabilityStub();
      const queue = await queueAfterVisibleToolStatus(messenger, durability);
      expect(attempts).toEqual([{ jid: DM_JID, text: expect.stringContaining('Running deploy check') }]);

      const { result, trigger } = await callRestart(queue);

      expect(result).toMatchObject({ ok: true, restarting: true });
      expect(trigger).toHaveBeenCalledTimes(1);
      expect(attempts.at(-1)).toEqual({ jid: DM_JID, text: OWED });
      expect(attempts.some((attempt) => attempt.text.includes(SALVAGED_REPLY_NOTICE))).toBe(false);
      const sendOrder = vi.mocked(messenger.sendMessage).mock.invocationCallOrder;
      expect(sendOrder.at(-1)).toBeLessThan(trigger.mock.invocationCallOrder[0] ?? 0);
      // The status took op 1; the owed text is the turn's answer op.
      const evidence = await settle(queue.flushTurnEvidence('turn-1'));
      expect(evidence.answerOpIds).toEqual([2]);
    });

    // expected-red: the same turn with the answer send failing must refuse.
    it('refuses the restart with send_failed when that answer send fails', async () => {
      const { messenger, attempts } = makeMessenger(async (_jid, text) => {
        if (text.includes(OWED)) throw governorShed();
        return { waMessageId: null };
      });
      const durability = makeDurabilityStub();
      const queue = await queueAfterVisibleToolStatus(messenger, durability);

      const { result, trigger, sendAck } = await callRestart(queue);

      expect(result).toMatchObject({ ok: false, restarting: false, cause: 'send_failed' });
      expect(trigger).not.toHaveBeenCalled();
      expect(sendAck).not.toHaveBeenCalled();
      expect(attempts.at(-1)).toEqual({ jid: DM_JID, text: OWED });
      expect(durability.markFailedPermanent).toHaveBeenCalledWith(
        2,
        expect.objectContaining({ failure_code: 'outbound.governor_shed' }),
      );
      expect(queue.getSendFailureCount()).toBe(1);
    });
  });
});
