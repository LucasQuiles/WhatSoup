import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Database } from '../../../src/core/database.ts';
import { DurabilityEngine } from '../../../src/core/durability.ts';
import type { Messenger } from '../../../src/core/types.ts';
import { ControlQueue } from '../../../src/runtimes/agent/control-queue.ts';
import { OutboundQueue } from '../../../src/runtimes/agent/outbound-queue.ts';
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

    queue.enqueueText('one delivered answer');
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

    queue.enqueueText('group control');
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
    queue.enqueueText('buffer only');

    await expect(queue.flushTurnEvidence('control-turn')).resolves.toEqual({
      turnId: 'control-turn',
      answerOpIds: [],
      lifecycleOpIds: [],
      statusOpIds: [],
    });
    expect(transport.sendMessage).not.toHaveBeenCalled();
  });
});
