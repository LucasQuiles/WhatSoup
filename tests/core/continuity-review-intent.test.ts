import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Database } from '../../src/core/database.ts';
import { DurabilityEngine } from '../../src/core/durability.ts';

type ContinuityReviewIntentRow = {
  inbound_seq: number;
  status: string;
  reason: string;
  source: string;
  created_at: string;
  completed_at: string | null;
};

function makeDb(): Database {
  const db = new Database(':memory:');
  db.open();
  return db;
}

function reviewIntents(db: Database): ContinuityReviewIntentRow[] {
  return db.raw.prepare(`
    SELECT inbound_seq, status, reason, source, created_at, completed_at
    FROM continuity_review_intents
    ORDER BY inbound_seq ASC
  `).all() as ContinuityReviewIntentRow[];
}

describe('continuity review intent queue', () => {
  let db: Database;
  let engine: DurabilityEngine;

  beforeEach(() => {
    db = makeDb();
    engine = new DurabilityEngine(db);
  });

  afterEach(() => {
    db.close();
  });

  it('enqueues exactly one unsent human-review intent for a marked stranded inbound', () => {
    const seq = engine.journalInbound('review-intent-stranded', 'review-key-1', 'review-jid-1', 'agent');
    engine.preConnectRecovery();

    const first = engine.enqueueContinuityReviewIntents();
    const second = engine.enqueueContinuityReviewIntents();

    expect(first).toEqual({ inserted: 1 });
    expect(second).toEqual({ inserted: 0 });
    expect(reviewIntents(db)).toEqual([
      {
        inbound_seq: seq,
        status: 'pending_review',
        reason: 'crash_reclaim_no_terminal_outbound',
        source: 'pre_connect_recovery',
        created_at: expect.any(String),
        completed_at: null,
      },
    ]);
  });

  it('does not enqueue for unmarked terminal, intentional no-reply, or historical failed rows', () => {
    const terminal = engine.journalInbound('review-intent-terminal', 'review-key-2', 'review-jid-2', 'agent');
    engine.createOutboundOp({
      conversationKey: 'review-key-2',
      chatJid: 'review-jid-2',
      opType: 'text',
      payload: '{"text":"terminal outbound exists"}',
      replayPolicy: 'unsafe',
      sourceInboundSeq: terminal,
      isTerminal: true,
    });
    const noReply = engine.journalInbound('review-intent-no-reply', 'review-key-3', 'review-jid-3', 'agent');
    const failed = engine.journalInbound('review-intent-failed', 'review-key-4', 'review-jid-4', 'agent');
    engine.markInboundSkipped(noReply, 'chat_paused');
    engine.markInboundFailed(failed);

    engine.preConnectRecovery();

    expect(engine.enqueueContinuityReviewIntents()).toEqual({ inserted: 0 });
    expect(reviewIntents(db)).toEqual([]);
  });
});
