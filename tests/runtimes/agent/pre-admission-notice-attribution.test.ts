import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Database } from '../../../src/core/database.ts';
import { DurabilityEngine } from '../../../src/core/durability.ts';
import type { Messenger } from '../../../src/core/types.ts';
import { OutboundQueue } from '../../../src/runtimes/agent/outbound-queue.ts';
import { getQueueForChat, sendDirectWithReceipt, type ChatTransportPort, type SendDirectOutcome } from '../../../src/runtimes/agent/chat-transport.ts';
import { resolveAgentTurnMapKey } from '../../../src/runtimes/agent/scheduled-agent-job-isolation.ts';

vi.mock('../../../src/logger.ts', async () => {
  const { loggerMock } = await import('../../helpers/logger-mock.ts');
  return loggerMock();
});

// The proposed per-message contract is exercised against the existing real
// transport and queue first; the baseline ignores the extra argument.
const sendNotice = sendDirectWithReceipt as (
  port: ChatTransportPort, chatJid: string, text: string, bypass: boolean,
  attribution: { sourceInboundSeq: number | undefined; mapKey?: string },
) => Promise<SendDirectOutcome>;
const jid = 'notice-fixture@s.whatsapp.net';

describe('pre-admission notice attribution', () => {
  let db: Database;
  let engine: DurabilityEngine;
  let queue: OutboundQueue;
  let messenger: Messenger;
  let port: ChatTransportPort;
  let oldSeq: number;
  let failedSeq: number;

  beforeEach(() => {
    vi.useFakeTimers();
    db = new Database(':memory:');
    db.open();
    engine = new DurabilityEngine(db);
    oldSeq = engine.journalInbound('old-request', 'notice-fixture', jid, 'agent');
    failedSeq = engine.journalInbound('failed-request', 'notice-fixture', jid, 'agent');
    messenger = {
      sendMessage: vi.fn(async () => ({ waMessageId: 'synthetic-receipt' })),
      sendMedia: vi.fn(async () => ({ waMessageId: null })),
      setTyping: vi.fn(async () => undefined),
    };
    queue = new OutboundQueue(messenger, jid);
    queue.setDurability(engine);
    queue.setInboundSeq(oldSeq);
    queue.beginTurnEvidence('older-turn');
    port = { messenger, getQueueForChat: vi.fn(() => queue) } as unknown as ChatTransportPort;
  });

  afterEach(async () => {
    queue.abortTurn();
    await vi.runAllTimersAsync();
    db.close();
    const timers = vi.getTimerCount();
    vi.useRealTimers();
    vi.restoreAllMocks();
    expect(timers).toBe(0);
  });

  it.each([true, false])('persists explicit attribution (has sequence: %s), preserving later ordinary attribution', async (hasSequence) => {
    await sendNotice(port, jid, 'Failed request notice', false, {
      sourceInboundSeq: hasSequence ? failedSeq : undefined,
    });
    queue.enqueueText('Older turn answer');
    await vi.runAllTimersAsync();
    const rows = db.raw.prepare('SELECT source_inbound_seq, payload FROM outbound_ops ORDER BY id').all();
    expect(rows).toHaveLength(2);
    expect(rows[0].source_inbound_seq).toBe(hasSequence ? failedSeq : null);
    expect(rows[1].source_inbound_seq).toBe(oldSeq);
    const pending = queue.flushTurnEvidence('older-turn');
    await vi.runAllTimersAsync();
    const evidence = await pending;
    expect(evidence.answerOpIds).toHaveLength(1);
    expect(evidence.lifecycleOpIds).toEqual([]);
  });

  it('preserves deferred old-turn salvage and does not replace terminal operation identity', async () => {
    queue.setToolUpdateMode('minimal');
    queue.enqueueStreamingText('Previously owed answer');
    queue.discardPreToolAssistantText();
    const priorOpId = queue.getLastOpId();
    await sendNotice(port, jid, 'Failed request notice', false, { sourceInboundSeq: failedSeq });
    await vi.advanceTimersByTimeAsync(0);
    expect(queue.getLastOpId()).toBe(priorOpId);
    queue.abortTurn({ salvageOwedReply: true });
    await vi.runAllTimersAsync();
    const rows = db.raw.prepare('SELECT source_inbound_seq, payload FROM outbound_ops ORDER BY id').all();
    expect(rows).toHaveLength(2);
    expect(rows[1].source_inbound_seq).toBe(oldSeq);
    expect(String(rows[1].payload)).toContain('Previously owed answer');
  });

  it.each([false, true])('rejects an attributed notice without durable queue (bypass: %s)', async (bypass) => {
    port = { messenger, getQueueForChat: () => null } as unknown as ChatTransportPort;
    await expect(sendNotice(port, jid, 'Failed request notice', bypass, { sourceInboundSeq: failedSeq }))
      .resolves.toEqual({ accepted: false, messageId: null });
    expect(messenger.sendMessage).not.toHaveBeenCalled();
  });

  it('keeps the prior persisted terminal operation distinct from the notice', async () => {
    queue.enqueueText('Older turn answer');
    await vi.runAllTimersAsync();
    const priorOpId = queue.getLastOpId();
    await sendNotice(port, jid, 'Failed request notice', false, { sourceInboundSeq: failedSeq });
    await vi.runAllTimersAsync();
    expect(queue.getLastOpId()).toBe(priorOpId);
    queue.markLastTerminal();
    const rows = db.raw.prepare('SELECT id, is_terminal FROM outbound_ops ORDER BY id').all();
    expect(rows[0]).toMatchObject({ id: priorOpId, is_terminal: 1 });
    expect(rows[1].is_terminal).toBe(0);
    expect(queue.getLastOpId()).toBeUndefined();
  });

  it('leaves buffered text uncommitted until its own delivery boundary', async () => {
    queue.setToolUpdateMode('minimal');
    const onCommit = vi.fn();
    queue.enqueueStreamingText('Buffered older answer', 'answer', onCommit);
    await sendNotice(port, jid, 'Failed request notice', false, { sourceInboundSeq: failedSeq });
    await vi.advanceTimersByTimeAsync(0);
    expect(onCommit).not.toHaveBeenCalled();
    queue.commitStreamingText();
    await vi.runAllTimersAsync();
    const rows = db.raw.prepare('SELECT source_inbound_seq, payload FROM outbound_ops ORDER BY id').all();
    expect(rows).toHaveLength(2);
    expect(rows[0].source_inbound_seq).toBe(failedSeq);
    expect(rows[1].source_inbound_seq).toBe(oldSeq);
    expect(String(rows[1].payload)).toContain('Buffered older answer');
    expect(onCommit).toHaveBeenCalledOnce();
  });

  it.each([false, true])('selects the explicit namespace queue (scheduled: %s)', async (scheduled) => {
    const other = new OutboundQueue(messenger, jid);
    other.setDurability(engine);
    other.setInboundSeq(oldSeq);
    const mapKey = resolveAgentTurnMapKey(jid, scheduled);
    const queues = new Map([[jid, scheduled ? other : queue], [resolveAgentTurnMapKey(jid, true), scheduled ? queue : other]]);
    port = {
      messenger, sessionScope: 'per_chat', chatQueues: queues,
      resolvePerChatMapKey: () => jid,
      getQueueForChat: (chatJid: string, key?: string) => getQueueForChat(port, chatJid, key),
    } as unknown as ChatTransportPort;
    const target = vi.spyOn(queue, 'enqueuePreAdmissionNotice');
    const wrong = vi.spyOn(other, 'enqueuePreAdmissionNotice');
    await sendNotice(port, jid, 'Failed request notice', false, { sourceInboundSeq: failedSeq, mapKey });
    await vi.runAllTimersAsync();
    expect(target).toHaveBeenCalledWith('Failed request notice', failedSeq);
    expect(wrong).not.toHaveBeenCalled();
    expect(db.raw.prepare('SELECT source_inbound_seq FROM outbound_ops').get()?.source_inbound_seq).toBe(failedSeq);
  });

  it('rejects notices while closing and after closure', async () => {
    const closing = queue.shutdown();
    expect(queue.enqueuePreAdmissionNotice('Closing notice', failedSeq)).toBe(false);
    await vi.runAllTimersAsync();
    await closing;
    expect(queue.enqueuePreAdmissionNotice('Closed notice', failedSeq)).toBe(false);
    expect(messenger.sendMessage).not.toHaveBeenCalled();
  });

  it('rejects a queue without durability and a poisoned durable queue', async () => {
    const ephemeral = new OutboundQueue(messenger, jid);
    expect(ephemeral.enqueuePreAdmissionNotice('Undurable notice', failedSeq)).toBe(false);
    vi.spyOn(engine, 'createOutboundOp').mockImplementationOnce(() => { throw new Error('fixture storage failure'); });
    queue.enqueueText('Poison trigger');
    await vi.runAllTimersAsync();
    expect(queue.isPoisoned()).toBe(true);
    await expect(sendNotice(port, jid, 'Failed request notice', false, { sourceInboundSeq: failedSeq }))
      .resolves.toEqual({ accepted: false, messageId: null });
    expect(messenger.sendMessage).not.toHaveBeenCalled();
  });

  it('persists a new notice despite identical older terminal text, retaining ordinary dedupe', async () => {
    const text = 'Identical generic failure notice';
    queue.enqueueText(text);
    await vi.runAllTimersAsync();
    queue.markLastTerminal({ dedupeText: true });
    await expect(sendNotice(port, jid, text, false, { sourceInboundSeq: failedSeq }))
      .resolves.toEqual({ accepted: true, messageId: null });
    await vi.runAllTimersAsync();
    const rows = db.raw.prepare('SELECT source_inbound_seq FROM outbound_ops ORDER BY id').all();
    expect(rows.map((row) => row.source_inbound_seq)).toEqual([oldSeq, failedSeq]);
    queue.enqueueText(text);
    await vi.runAllTimersAsync();
    expect(db.raw.prepare('SELECT COUNT(*) AS count FROM outbound_ops').get()?.count).toBe(2);
  });
});
