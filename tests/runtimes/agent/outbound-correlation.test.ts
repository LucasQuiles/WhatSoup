import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Database } from '../../../src/core/database.ts';
import { DurabilityEngine } from '../../../src/core/durability.ts';
import { storeMessageIfNew } from '../../../src/core/messages.ts';
import type { Messenger, SubmissionReceipt } from '../../../src/core/types.ts';
import { WhatSoupError } from '../../../src/errors.ts';
import { OutboundQueue } from '../../../src/runtimes/agent/outbound-queue.ts';

vi.mock('../../../src/logger.ts', async () => {
  const { loggerMock } = await import('../../helpers/logger-mock.ts');
  return loggerMock();
});
vi.mock('../../../src/lib/emit-alert.ts', () => ({
  emitAlert: () => true,
  emitAlertChecked: () => true,
  emitObservationChecked: () => true,
  clearAlertSource: () => true,
  clearAlertSourceChecked: () => true,
}));

const CHAT = 'test@s.whatsapp.net';
const CONVERSATION_KEY = 'test';
type OutboundRow = {
  id: number;
  status: string;
  conversation_key: string;
  wa_message_id: string | null;
  retry_count: number;
};

describe('outbound correlation after ambiguous sends', () => {
  let db: Database;
  let durability: DurabilityEngine;
  let queue: OutboundQueue;
  let requestedIds: string[];
  let pending: Array<(receipt: SubmissionReceipt) => void>;

  beforeEach(() => {
    vi.useFakeTimers();
    db = new Database(':memory:');
    db.open();
    durability = new DurabilityEngine(db);
    requestedIds = [];
    pending = [];
  });

  afterEach(async () => {
    for (const resolve of pending) resolve({ waMessageId: null });
    await vi.runAllTimersAsync();
    const timers = vi.getTimerCount();
    db.close();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    expect(timers).toBe(0);
  });

  function start(equivalent?: boolean, outcome: 'hang' | 'success' | 'shed' | 'hang-then-shed' = 'hang'): void {
    const messenger: Messenger = {
      requestedIdIsProviderId: equivalent,
      sendMessage: async (_jid, _text, opts) => {
        if (!opts?.messageId) return { waMessageId: null };
        requestedIds.push(opts.messageId);
        if (outcome === 'success') return { waMessageId: 'actual-provider-id' };
        if (outcome === 'shed' || (outcome === 'hang-then-shed' && requestedIds.length > 1)) {
          throw new WhatSoupError('outbound governor ceiling exceeded', 'OUTBOUND_GOVERNOR_SHED');
        }
        return new Promise<SubmissionReceipt>((resolve) => pending.push(resolve));
      },
      sendMedia: async () => ({ waMessageId: null }),
    };
    queue = new OutboundQueue(messenger, CHAT);
    queue.setDurability(durability);
    queue.enqueueText('answer', 'answer');
  }

  function row(): OutboundRow {
    return db.raw.prepare('SELECT id, status, conversation_key, wa_message_id, retry_count FROM outbound_ops').get() as OutboundRow;
  }

  async function exhaust(): Promise<void> {
    await vi.runAllTimersAsync();
    await queue.flush();
    expect(requestedIds).toHaveLength(3);
    expect(new Set(requestedIds).size).toBe(1);
    expect(row().status).toBe('maybe_sent');
    expect(row().retry_count).toBe(3);
    expect(row().conversation_key).toBe(CONVERSATION_KEY);
  }

  it('matches a late echo after exhaustion only when the transport preserves the requested ID', async () => {
    start(true);
    await exhaust();
    expect(row().wa_message_id).toBe(requestedIds[0]);
    expect(durability.matchEcho(requestedIds[0]!, CONVERSATION_KEY)).toBe(true);
    expect(row().status).toBe('echoed');
    expect(requestedIds).toHaveLength(3);
  });

  it.each([undefined, false])('retains unknown correlation on exhaustion for declaration %s', async (equivalent) => {
    start(equivalent);
    await exhaust();
    expect(row().wa_message_id).toBeNull();
    expect(durability.matchEcho(requestedIds[0]!, CONVERSATION_KEY)).toBe(false);
    expect(row().status).toBe('maybe_sent');
  });

  it.each([undefined, false, true])('qualifies shutdown correlation for declaration %s', async (equivalent) => {
    start(equivalent);
    await vi.advanceTimersByTimeAsync(0);
    expect(requestedIds).toHaveLength(1);
    queue.preemptForShutdown(Date.now());
    await queue.flush();
    expect(row().status).toBe('maybe_sent');
    expect(row().wa_message_id).toBe(equivalent === true ? requestedIds[0] : null);
  });

  it('reconciles an echo stored before exhaustion persisted the correlation ID', async () => {
    start(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(storeMessageIfNew(db, {
      chatJid: CHAT, conversationKey: CONVERSATION_KEY, senderJid: CHAT, senderName: null,
      messageId: requestedIds[0]!, content: 'answer', contentType: 'text',
      isFromMe: true, timestamp: Math.floor(Date.now() / 1000), quotedMessageId: null,
    })).toBe(true);
    expect(durability.matchEcho(requestedIds[0]!, CONVERSATION_KEY)).toBe(false);
    await exhaust();
    durability.postConnectRecovery();
    expect(row().status).toBe('echoed');
    expect(requestedIds).toHaveLength(3);
  });

  it('matches a retained ID after unsafe ambiguity enters quarantine', async () => {
    start(true);
    await exhaust();
    durability.postConnectRecovery();
    expect(row().status).toBe('quarantined');
    expect(durability.matchEcho(requestedIds[0]!, CONVERSATION_KEY)).toBe(true);
    expect(row().status).toBe('echoed');
    expect(requestedIds).toHaveLength(3);
  });

  it('stores the actual successful receipt even if it differs from the requested ID', async () => {
    start(true, 'success');
    await vi.runAllTimersAsync();
    await queue.flush();
    expect(row().status).toBe('submitted');
    expect(row().wa_message_id).toBe('actual-provider-id');
    expect(requestedIds).toHaveLength(1);
  });

  it('does not attach correlation to a deterministic non-send', async () => {
    start(true, 'shed');
    await vi.runAllTimersAsync();
    await queue.flush();
    expect(row().status).toBe('failed_permanent');
    expect(row().wa_message_id).toBeNull();
    expect(requestedIds).toHaveLength(1);
  });

  it.each([undefined, false, true])('retains prior ambiguity after a governor shed for declaration %s', async (equivalent) => {
    start(equivalent, 'hang-then-shed');
    await vi.runAllTimersAsync();
    await queue.flush();
    expect(requestedIds).toHaveLength(2);
    expect(new Set(requestedIds).size).toBe(1);
    expect(row().status).toBe('maybe_sent');
    expect(row().retry_count).toBe(2);
    expect(row().wa_message_id).toBe(equivalent === true ? requestedIds[0] : null);
    const evidence = JSON.parse((db.raw.prepare('SELECT error FROM outbound_ops').get() as { error: string }).error);
    expect(evidence).toMatchObject({
      mutation_state: 'ambiguous', provider_submission_count: 1, logical_attempt_count: 2,
      failure_code: 'outbound.governor_shed', retry_decision: 'stop',
    });
    durability.postConnectRecovery();
    expect(row().status).toBe('quarantined');
    expect(durability.matchEcho(requestedIds[0]!, CONVERSATION_KEY)).toBe(equivalent === true);
    expect(row().status).toBe(equivalent === true ? 'echoed' : 'quarantined');
    expect(requestedIds).toHaveLength(2);
  });
});
