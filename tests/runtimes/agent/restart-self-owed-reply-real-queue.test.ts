// #3829 review items (a) and (b): restart_self's owed-reply gate driven through a
// REAL OutboundQueue, not a queue double. deliverOwedReplyBeforeRestart
// (src/runtimes/agent/self-restart.ts:242-266) treats a settled flush with an
// unchanged getSendFailureCount() as delivered, so every queue path that ends a
// send without counting a failure is checked here against the owed reply.
//
// Each test is marked:
//   guard        - expected to pass on d95f9f19; protects current behaviour.
//   expected-red - expected to fail on d95f9f19; proves a defect before its fix.
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
const SESSION = { tier: 'admin' } as SessionContext;
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
  const trigger = vi.fn(async (_opts: TriggerSelfRestartOptions) => ({ ok: true, markerPath: '/data/q/m' }));
  const sendAck = vi.fn(async (_chatJid: string, _text: string) => {});
  const tool = buildRestartSelfTool({
    instanceName: 'q',
    dataRoot: '/data/q',
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
    // guard: abortTurn (outbound-queue.ts:1272-1355) clears per-turn buffers but
    // leaves lifecycle 'open' (only shutdown changes it, 1256), keeps sendQueue and
    // drainFailure (1353), and preserveEvidence keeps the turn's evidence. A
    // terminal send failure returns normally (1910-1925) and does not poison it.
    it('keeps the queue usable for the rest of the turn and the next turn after an owed send fails', async () => {
      const { messenger, attempts } = makeMessenger(async (_jid, text) => {
        if (text === OWED) throw governorShed();
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

    // guard: on 'timeout' the pending send stays on the queue chain and finishes
    // on its own (self-restart.ts:239-240, 253-256); nothing is re-enqueued.
    it('lets an owed send still pending at the grace limit finish once, then keeps delivering', async () => {
      const owedSend = deferred<SubmissionReceipt>();
      const { messenger, attempts } = makeMessenger((_jid, text) => (
        text === OWED ? owedSend.promise : Promise.resolve({ waMessageId: null })
      ));
      const durability = makeDurabilityStub();
      const queue = new OutboundQueue(messenger, DM_JID);
      queue.setDurability(durability as unknown as DurabilityEngine);
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
    // expected-red: sendWithPacing returns at outbound-queue.ts:1754-1755 when the
    // echo guard (core/echo-guard.ts:37-52) holds a cross-session cooldown for the
    // group. No send, no failure count, so self-restart.ts:257-258 reports
    // delivered: true and the restart starts with the owed reply never sent.
    it('echo guard: an owed group reply dropped by the cross-session cooldown stops the restart', async () => {
      recordGroupOutbound(GROUP_JID, 'another-queue-token');
      const { messenger, attempts } = makeMessenger();
      const queue = new OutboundQueue(messenger, GROUP_JID);
      queue.enqueueStreamingText(OWED, 'answer');

      const { result, trigger, sendAck } = await callRestart(queue);

      // Premise: the owed reply never reached the transport.
      expect(attempts).toEqual([]);
      expect(result).toMatchObject({ ok: false, restarting: false });
      expect(sendAck).not.toHaveBeenCalled();
      expect(trigger).not.toHaveBeenCalled();
    });

    // guard: enqueue drops a chunk at outbound-queue.ts:1669 only when the same
    // chat + text key was promoted by markLastTerminal({ dedupeText: true })
    // (655-664) after a provider submission (1832), inside
    // TERMINAL_TEXT_DEDUPE_WINDOW_MS. The user already holds that exact text, so
    // delivered: true and a restart are correct. (No src caller passes
    // dedupeText: true at d95f9f19.)
    it('dedupe: an owed reply identical to terminal text already submitted to the chat counts as delivered', async () => {
      const { messenger, attempts } = makeMessenger();
      const queue = new OutboundQueue(messenger, DM_JID);
      queue.enqueueText(OWED, 'answer');
      await settle(queue.flush());
      queue.markLastTerminal({ dedupeText: true });
      queue.enqueueStreamingText(OWED, 'answer');

      const { result, trigger } = await callRestart(queue);

      expect(attempts.map((attempt) => attempt.text)).toEqual([OWED]);
      expect(result).toMatchObject({ ok: true, restarting: true });
      expect(trigger).toHaveBeenCalledTimes(1);
    });

    // guard: the dedupe key is set only on submission (outbound-queue.ts:1832), so
    // an earlier failed send of the same text cannot make dedupe hide the owed reply.
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
      queue.enqueueStreamingText(OWED, 'answer');

      const { result, trigger } = await callRestart(queue);

      expect(attempts.map((attempt) => attempt.text)).toEqual([OWED, OWED]);
      expect(queue.getSendFailureCount()).toBe(1);
      expect(result).toMatchObject({ ok: true, restarting: true });
      expect(trigger).toHaveBeenCalledTimes(1);
    });

    // guard: the redirect send at outbound-queue.ts:1612-1626 swallows its error
    // and is not counted. It carries tool status only, never the owed reply, so
    // it must not change the owed-reply outcome.
    it('redirect: a rejected tool-status redirect send neither blocks nor fails the owed reply', async () => {
      const { messenger, attempts } = makeMessenger(async (jid) => {
        if (jid === STATUS_JID) throw new Error('status channel down');
        return { waMessageId: null };
      });
      const queue = new OutboundQueue(messenger, DM_JID);
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

    // guard: the redirect send is chained on this.chain (outbound-queue.ts:1619)
    // with no SEND_TIMEOUT_MS race (1621), so the owed send waits behind a hung
    // one; flush() stays pending and self-restart.ts:253-256 refuses at the grace.
    it('redirect: an owed reply queued behind a hung redirect send stops the restart, then sends once', async () => {
      const statusSend = deferred<SubmissionReceipt>();
      const { messenger, attempts } = makeMessenger((jid) => (
        jid === STATUS_JID ? statusSend.promise : Promise.resolve({ waMessageId: null })
      ));
      const queue = new OutboundQueue(messenger, DM_JID);
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

    // guard: abortTurn re-roles the salvage to 'status' (outbound-queue.ts:1310)
    // but sends it through enqueuePreparedText and sendWithRetry, which counts the
    // failure (1920). The pen is emptied, so endTurn's path C cannot resend it.
    it('status role: a failed salvage send of deferred owed text stops the restart and is not resent', async () => {
      const { messenger, attempts } = makeMessenger(async (_jid, text) => {
        if (text.includes(SALVAGED_REPLY_NOTICE)) throw governorShed();
        return { waMessageId: null };
      });
      const durability = makeDurabilityStub();
      const queue = new OutboundQueue(messenger, DM_JID);
      queue.setDurability(durability as unknown as DurabilityEngine);
      queue.setToolUpdateMode('minimal');
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
});
