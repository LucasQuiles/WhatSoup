import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Database } from '../../src/core/database.ts';
import { DurabilityEngine } from '../../src/core/durability.ts';
import { storeMessageIfNew } from '../../src/core/messages.ts';

const GROUP_JID = 'replay-fixture@g.us';

function status(db: Database, seq: number): string {
  return (db.raw.prepare(
    'SELECT processing_status FROM inbound_events WHERE seq = ?',
  ).get(seq) as { processing_status: string }).processing_status;
}

function storeInbound(db: Database, messageId: string, content = 'queued turn'): void {
  storeMessageIfNew(db, {
    chatJid: GROUP_JID,
    conversationKey: GROUP_JID,
    senderJid: '15551234567@s.whatsapp.net',
    senderName: 'Owner',
    messageId,
    content,
    contentType: 'text',
    isFromMe: false,
    timestamp: 1_784_744_000,
    quotedMessageId: null,
  });
}

describe('durable inbound admission and restart replay', () => {
  let db: Database;
  let durability: DurabilityEngine;

  beforeEach(() => {
    db = new Database(':memory:');
    db.open();
    durability = new DurabilityEngine(db);
  });

  afterEach(() => db.close());

  it('journals replay-capable runtime input as pending without changing legacy journal semantics', () => {
    storeInbound(db, 'runtime-pending-1');
    const replayableSeq = durability.journalQueuedInbound(
      'runtime-pending-1',
      GROUP_JID,
      GROUP_JID,
      'agentruntime',
    );
    const legacySeq = durability.journalInbound(
      'legacy-processing-1',
      '15550000001',
      '15550000001@s.whatsapp.net',
      'control',
    );

    expect(status(db, replayableSeq)).toBe('pending');
    expect(status(db, legacySeq)).toBe('processing');
    expect(durability.getReplayableInbound()).toEqual([
      expect.objectContaining({
        seq: replayableSeq,
        message_id: 'runtime-pending-1',
        processing_status: 'pending',
        content: 'queued turn',
        content_type: 'text',
      }),
    ]);
  });

  it('moves only the expected owner through pending, preparation, queued, and execution states', () => {
    storeInbound(db, 'runtime-state-1');
    const seq = durability.journalQueuedInbound(
      'runtime-state-1',
      GROUP_JID,
      GROUP_JID,
      'agentruntime',
    );

    expect(durability.beginInboundPreparation(seq)).toBe(true);
    expect(status(db, seq)).toBe('preparing');
    expect(durability.markInboundQueued(seq)).toBe(true);
    expect(status(db, seq)).toBe('queued');
    expect(durability.markInboundProcessing(seq)).toBe(true);
    expect(status(db, seq)).toBe('processing');

    expect(durability.markInboundQueued(seq)).toBe(false);
    durability.markInboundComplete(seq, 'response_sent');
    expect(durability.markInboundProcessing(seq)).toBe(false);
    expect(status(db, seq)).toBe('complete');
  });

  it('preserves definitely undispatched rows while tombstoning preparing and processing rows', () => {
    storeInbound(db, 'restart-pending-1');
    storeInbound(db, 'restart-queued-1');
    storeInbound(db, 'restart-preparing-1');
    storeInbound(db, 'restart-processing-1');
    const pending = durability.journalQueuedInbound(
      'restart-pending-1', 'chat-a', 'chat-a@s.whatsapp.net', 'agentruntime',
    );
    const queued = durability.journalQueuedInbound(
      'restart-queued-1', 'chat-b', 'chat-b@s.whatsapp.net', 'agentruntime',
    );
    const preparing = durability.journalQueuedInbound(
      'restart-preparing-1', 'chat-c', 'chat-c@s.whatsapp.net', 'agentruntime',
    );
    const processing = durability.journalQueuedInbound(
      'restart-processing-1', 'chat-c', 'chat-c@s.whatsapp.net', 'agentruntime',
    );
    expect(durability.beginInboundPreparation(queued)).toBe(true);
    expect(durability.markInboundQueued(queued)).toBe(true);
    expect(durability.beginInboundPreparation(preparing)).toBe(true);
    expect(durability.beginInboundPreparation(processing)).toBe(true);
    expect(durability.markInboundQueued(processing)).toBe(true);
    expect(durability.markInboundProcessing(processing)).toBe(true);

    durability.preConnectRecovery();

    expect(status(db, pending)).toBe('pending');
    expect(status(db, queued)).toBe('queued');
    expect(status(db, preparing)).toBe('failed');
    expect(status(db, processing)).toBe('failed');
    expect(durability.getReplayableInbound().map((row) => row.seq)).toEqual([pending, queued]);
  });

  it('bounds and orders the restart backlog and excludes rows not owned by the agent runtime', () => {
    for (let i = 0; i < 4; i += 1) {
      const id = `ordered-${i}`;
      storeInbound(db, id, `turn ${i}`);
      durability.journalQueuedInbound(
        id,
        GROUP_JID,
        GROUP_JID,
        i === 2 ? 'chatruntime' : 'agentruntime',
      );
    }

    expect(durability.getReplayableInbound(2).map((row) => row.message_id)).toEqual([
      'ordered-0',
      'ordered-1',
    ]);
  });
});
