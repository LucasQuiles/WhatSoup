import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Database } from '../../../src/core/database.ts';
import { DurabilityEngine } from '../../../src/core/durability.ts';
import type { Messenger } from '../../../src/core/types.ts';
import {
  parseClientOutputPolicies,
  type ClientOutputPolicyRegistry,
} from '../../../src/core/client-output-policy-config.ts';
import { ControlQueue } from '../../../src/runtimes/agent/control-queue.ts';
import { OutboundQueue, type OutboundQueueOptions } from '../../../src/runtimes/agent/outbound-queue.ts';
import { finalizeRuntimeTurn } from '../../../src/runtimes/agent/turn-finalizer.ts';

const emitAlert = vi.hoisted(() => vi.fn(() => ({
  ok: true,
  channel: 'outbox',
  status: 'durably_queued',
})));

vi.mock('../../../src/logger.ts', async () => {
  const { loggerMock } = await import('../../helpers/logger-mock.ts');
  const mock = loggerMock();
  const logger = mock.createChildLogger();
  return {
    ...mock,
    default: { ...logger, child: () => logger },
    flushLogger: vi.fn(),
  };
});

vi.mock('../../../src/lib/emit-alert.ts', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../src/lib/emit-alert.ts')>(),
  emitAlert,
  emitAlertChecked: emitAlert,
}));

const PHONE_KEY = 'mapped-phone';
const LID_JID = 'mapped-alias@lid';

function messenger(waMessageId: string): Messenger {
  return {
    sendMessage: vi.fn(async () => ({ waMessageId })),
    sendMedia: vi.fn(async () => ({ waMessageId: null })),
    setTyping: vi.fn(async () => undefined),
  };
}

// One chat under both of its aliases: the phone key and JID, and the LID key and JID.
const PHONE_DIGITS = PHONE_KEY;
const PHONE_JID = `${PHONE_DIGITS}@s.whatsapp.net`;
const LID_LOCAL = 'mapped-alias';
const BLOCKED_TERM = 'zebracorn';

type Attribution = { conversationKey: string; chatJid: string };
/** The queue's begin with a turn attribution; a one-parameter begin is assignable to it. */
type Begin = (turnId: string, attribution: Attribution) => void;

/** Records each text send as [jid, text] and returns a distinct transport id for it. */
function recordingMessenger(): { transport: Messenger; sends: Array<[string, string]>; waIds: string[] } {
  const sends: Array<[string, string]> = [];
  const waIds: string[] = [];
  const transport: Messenger = {
    sendMessage: vi.fn(async (jid: string, text: string) => {
      sends.push([jid, text]);
      const waMessageId = `wa-attributed-${sends.length}`;
      waIds.push(waMessageId);
      return { waMessageId };
    }),
    sendMedia: vi.fn(async () => ({ waMessageId: null })),
    setTyping: vi.fn(async () => undefined),
  };
  return { transport, sends, waIds };
}

// Copied from outbound-queue-client-output-policy.test.ts.
function registryFor(policy: Record<string, unknown>): ClientOutputPolicyRegistry {
  const parsed = parseClientOutputPolicies([policy]);
  if (!parsed.ok) throw new Error(`fixture policy invalid: ${parsed.error.field} ${parsed.error.reason}`);
  return parsed.registry;
}

const STRICT_POLICY = {
  conversationKey: PHONE_DIGITS,
  maxCodePoints: 4000,
  maxQuestionMarks: 1,
  blockedTerms: [{ value: BLOCKED_TERM, match: 'whole_word', caseSensitive: false }],
  rejectInternalArtifacts: true,
  rejectWhatsAppJids: true,
};

describe('outbound turn identity', () => {
  let db: Database;
  let durability: DurabilityEngine;

  beforeEach(() => {
    emitAlert.mockClear();
    db = new Database(':memory:');
    db.open();
    durability = new DurabilityEngine(db);
  });

  afterEach(() => {
    db.close();
  });

  it('finalizes a canonical-phone turn delivered through a LID exactly once', async () => {
    const inboundSeq = durability.journalInbound(
      'mapped-lid-inbound',
      PHONE_KEY,
      LID_JID,
      'agent',
    );
    const transport = messenger('wa-mapped-lid-answer');
    const queue = new OutboundQueue(transport, LID_JID, {
      conversationKey: PHONE_KEY,
    });
    queue.setDurability(durability);
    queue.setInboundSeq(inboundSeq);
    queue.beginTurnEvidence('turn-mapped-lid');

    queue.enqueueText('one delivered answer', 'answer');
    const evidence = await queue.flushTurnEvidence('turn-mapped-lid');

    expect(transport.sendMessage).toHaveBeenCalledTimes(1);
    expect(durability.matchEcho('wa-mapped-lid-answer')).toBe(true);

    const result = finalizeRuntimeTurn({
      instanceName: 'identity-test',
      durability,
      identity: {
        scope: 'per_chat',
        conversationKey: PHONE_KEY,
        deliveryJid: LID_JID,
        inboundSeq,
        logicalTurnId: 'turn-mapped-lid',
        managerId: 'manager-mapped-lid',
        generation: 1,
      },
      attemptOutcome: { kind: 'completed' },
      answerEvidence: { kind: 'ready', opIds: evidence.answerOpIds },
    });

    expect(result).toMatchObject({
      kind: 'terminal',
      terminal: {
        inboundDisposition: 'finalized_replied',
        deliveryEvidence: { kind: 'echoed', opId: evidence.answerOpIds[0] },
      },
    });
    expect(db.raw.prepare(
      'SELECT processing_status, terminal_reason FROM inbound_events WHERE seq = ?',
    ).get(inboundSeq)).toEqual({
      processing_status: 'complete',
      terminal_reason: 'response_echoed',
    });
    expect(db.raw.prepare('SELECT COUNT(*) AS count FROM turn_recovery_jobs').get())
      .toEqual({ count: 0 });
    expect(transport.sendMessage).toHaveBeenCalledTimes(1);
    expect(emitAlert).not.toHaveBeenCalled();
  });

  it('preserves ordinary group attribution when no explicit identity is needed', async () => {
    const groupJid = 'identity-control@g.us';
    const transport = messenger('wa-group-control');
    const queue = new OutboundQueue(transport, groupJid);
    queue.setDurability(durability);

    queue.enqueueText('group control', 'answer');
    await queue.flush();

    expect(db.raw.prepare(
      'SELECT conversation_key, chat_jid FROM outbound_ops ORDER BY id DESC LIMIT 1',
    ).get()).toEqual({
      conversation_key: 'identity-control_at_g.us',
      chat_jid: groupJid,
    });
    expect(transport.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('leaves the non-sending ControlQueue path unchanged', async () => {
    const transport = messenger('unused-control-id');
    const queue = new ControlQueue(LID_JID, transport);

    queue.beginTurnEvidence('control-turn');
    queue.enqueueText('buffer only', 'answer');

    await expect(queue.flushTurnEvidence('control-turn')).resolves.toEqual({
      turnId: 'control-turn',
      answerOpIds: [],
      lifecycleOpIds: [],
      statusOpIds: [],
    });
    expect(transport.sendMessage).not.toHaveBeenCalled();
  });

  describe('per-turn attribution', () => {
    /** A LID lane's queue after an alias migration: LID key, retargeted to the phone JID. */
    function migratedQueue(transport: Messenger, options: Partial<OutboundQueueOptions> = {}): OutboundQueue {
      const queue = new OutboundQueue(transport, LID_JID, { conversationKey: LID_LOCAL, ...options });
      queue.updateDeliveryJid(PHONE_JID);
      queue.setDurability(durability);
      return queue;
    }

    /** Journals the turn's inbound row under its attribution, then begins the turn with it. */
    function beginAttributed(queue: OutboundQueue, turnId: string, attribution: Attribution): number {
      const seq = durability.journalInbound(
        `inbound-${turnId}`,
        attribution.conversationKey,
        attribution.chatJid,
        'agent',
      );
      queue.setInboundSeq(seq);
      const begin: Begin = queue.beginTurnEvidence.bind(queue);
      begin(turnId, attribution);
      return seq;
    }

    function opRow(opId: number | undefined): unknown {
      return db.raw.prepare(
        'SELECT conversation_key, chat_jid, source_inbound_seq FROM outbound_ops WHERE id = ?',
      ).get(opId ?? -1);
    }

    /** Answers the turn, echoes every send, and finalizes the turn against its journaled row. */
    async function answerTurn(
      queue: OutboundQueue,
      recorder: ReturnType<typeof recordingMessenger>,
      turnId: string,
      attribution: Attribution,
      beforeAnswer: (queue: OutboundQueue) => void = () => undefined,
    ) {
      const seq = beginAttributed(queue, turnId, attribution);
      beforeAnswer(queue);
      queue.enqueueText('one attributed answer', 'answer');
      const evidence = await queue.flushTurnEvidence(turnId);
      for (const waId of recorder.waIds) durability.matchEcho(waId);
      const result = finalizeRuntimeTurn({
        instanceName: 'identity-test',
        durability,
        identity: {
          scope: 'per_chat',
          conversationKey: attribution.conversationKey,
          deliveryJid: attribution.chatJid,
          inboundSeq: seq,
          logicalTurnId: turnId,
          managerId: `manager-${turnId}`,
          generation: 1,
        },
        attemptOutcome: { kind: 'completed' },
        answerEvidence: { kind: 'ready', opIds: evidence.answerOpIds },
      });
      return { seq, opId: evidence.answerOpIds[0], sends: recorder.sends, result };
    }

    /** One combined assertion, so a failure shows the op row, the send targets and the outcome together. */
    function expectAttributedAnswer(
      run: Awaited<ReturnType<typeof answerTurn>>,
      expected: { key: string; jid: string },
    ): void {
      expect({
        op: opRow(run.opId),
        sentTo: run.sends.map(([to]) => to),
        outcome: {
          kind: run.result.kind,
          disposition: run.result.kind === 'terminal' ? run.result.terminal.inboundDisposition : null,
        },
        alerts: emitAlert.mock.calls.length,
      }).toEqual({
        op: { conversation_key: expected.key, chat_jid: expected.jid, source_inbound_seq: run.seq },
        sentTo: [expected.jid],
        outcome: { kind: 'terminal', disposition: 'finalized_replied' },
        alerts: 0,
      });
    }

    it('stamps a phone turn on a migrated LID queue with the phone key', async () => {
      const recorder = recordingMessenger();
      const queue = migratedQueue(recorder.transport);
      const run = await answerTurn(queue, recorder, 'turn-phone-key', {
        conversationKey: PHONE_DIGITS,
        chatJid: PHONE_JID,
      });

      expectAttributedAnswer(run, { key: PHONE_DIGITS, jid: PHONE_JID });
    });

    it('sends a LID turn on a migrated queue to the LID JID', async () => {
      const recorder = recordingMessenger();
      const queue = migratedQueue(recorder.transport);
      const run = await answerTurn(queue, recorder, 'turn-lid-delivery', {
        conversationKey: LID_LOCAL,
        chatJid: LID_JID,
      });

      expectAttributedAnswer(run, { key: LID_LOCAL, jid: LID_JID });
    });

    it('stamps a LID turn on a phone-keyed queue with the LID key', async () => {
      const recorder = recordingMessenger();
      const queue = new OutboundQueue(recorder.transport, LID_JID, { conversationKey: PHONE_DIGITS });
      queue.setDurability(durability);
      const run = await answerTurn(queue, recorder, 'turn-lid-key', {
        conversationKey: LID_LOCAL,
        chatJid: LID_JID,
      });

      expectAttributedAnswer(run, { key: LID_LOCAL, jid: LID_JID });
    });

    it('keeps the queue\'s own key and JID for operations outside an attributed turn', async () => {
      const recorder = recordingMessenger();
      const queue = migratedQueue(recorder.transport);
      beginAttributed(queue, 'turn-attributed', { conversationKey: PHONE_DIGITS, chatJid: PHONE_JID });
      queue.enqueueText('attributed answer', 'answer');
      await queue.flushTurnEvidence('turn-attributed');

      queue.enqueueText('later', 'status');
      queue.beginTurnEvidence('turn-unattributed');
      queue.enqueueText('unattributed answer', 'answer');
      await queue.flushTurnEvidence('turn-unattributed');

      expect(db.raw.prepare(
        'SELECT conversation_key, chat_jid FROM outbound_ops ORDER BY id DESC LIMIT 2',
      ).all()).toEqual([
        { conversation_key: LID_LOCAL, chat_jid: PHONE_JID },
        { conversation_key: LID_LOCAL, chat_jid: PHONE_JID },
      ]);
    });

    it('keeps the turn\'s JID when the queue is retargeted during the turn', async () => {
      const recorder = recordingMessenger();
      const queue = migratedQueue(recorder.transport);
      const run = await answerTurn(
        queue,
        recorder,
        'turn-retargeted',
        { conversationKey: PHONE_DIGITS, chatJid: PHONE_JID },
        (retargeted) => retargeted.updateDeliveryJid(LID_JID),
      );

      expectAttributedAnswer(run, { key: PHONE_DIGITS, jid: PHONE_JID });
    });

    it('keeps the turn\'s attribution through an abort that preserves its evidence', async () => {
      const recorder = recordingMessenger();
      const queue = migratedQueue(recorder.transport);
      const run = await answerTurn(
        queue,
        recorder,
        'turn-preserved-abort',
        { conversationKey: PHONE_DIGITS, chatJid: PHONE_JID },
        (aborted) => aborted.abortTurn({ preserveEvidence: true }),
      );

      expectAttributedAnswer(run, { key: PHONE_DIGITS, jid: PHONE_JID });
    });

    it('stamps and sends a turn\'s status operation under the turn\'s attribution', async () => {
      const recorder = recordingMessenger();
      const queue = migratedQueue(recorder.transport);
      const seq = beginAttributed(queue, 'turn-status', { conversationKey: PHONE_DIGITS, chatJid: LID_JID });
      queue.enqueueText('working on it', 'status');
      const evidence = await queue.flushTurnEvidence('turn-status');

      expect({
        statusOps: evidence.statusOpIds.map((opId) => opRow(opId)),
        sentTo: recorder.sends.map(([to]) => to),
      }).toEqual({
        statusOps: [{ conversation_key: PHONE_DIGITS, chat_jid: LID_JID, source_inbound_seq: seq }],
        sentTo: [LID_JID],
      });
    });

    it('still withholds an answer under the queue key\'s policy', async () => {
      const recorder = recordingMessenger();
      const queue = new OutboundQueue(recorder.transport, PHONE_JID, {
        conversationKey: PHONE_DIGITS,
        clientOutputPolicies: registryFor({ ...STRICT_POLICY, conversationKey: PHONE_DIGITS }),
      });
      queue.setDurability(durability);
      beginAttributed(queue, 'turn-queue-policy', { conversationKey: LID_LOCAL, chatJid: LID_JID });
      queue.enqueueText(`Please ask about the ${BLOCKED_TERM} launch.`, 'answer');
      const evidence = await queue.flushTurnEvidence('turn-queue-policy');

      expect({
        evidence: { answerOpIds: evidence.answerOpIds, withheldAnswerCount: evidence.withheldAnswerCount },
        sends: recorder.sends,
      }).toEqual({ evidence: { answerOpIds: [], withheldAnswerCount: 1 }, sends: [] });
    });

    it('withholds an answer under the turn key\'s policy', async () => {
      const recorder = recordingMessenger();
      const queue = migratedQueue(recorder.transport, {
        clientOutputPolicies: registryFor({ ...STRICT_POLICY, conversationKey: PHONE_DIGITS }),
      });
      beginAttributed(queue, 'turn-turn-policy', { conversationKey: PHONE_DIGITS, chatJid: PHONE_JID });
      queue.enqueueText(`Please ask about the ${BLOCKED_TERM} launch.`, 'answer');
      const evidence = await queue.flushTurnEvidence('turn-turn-policy');

      expect({
        evidence: { answerOpIds: evidence.answerOpIds, withheldAnswerCount: evidence.withheldAnswerCount },
        sends: recorder.sends,
      }).toEqual({ evidence: { answerOpIds: [], withheldAnswerCount: 1 }, sends: [] });
    });
  });
});
