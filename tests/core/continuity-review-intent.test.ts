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

function reviewIntentColumns(db: Database): string[] {
  return (
    db.raw.prepare("PRAGMA table_info('continuity_review_intents')").all() as Array<{ name: string }>
  ).map((c) => c.name);
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

  it('stores only review metadata and no chat, message, auth, send, or drain fields', () => {
    const columns = reviewIntentColumns(db);
    expect(columns).toEqual(['inbound_seq', 'status', 'reason', 'source', 'created_at', 'completed_at']);
    expect(columns).not.toEqual(
      expect.arrayContaining([
        'chat_jid',
        'conversation_key',
        'recipient',
        'text',
        'body',
        'payload',
        'auth',
        'token',
        'send',
        'drain',
      ]),
    );
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

  it('does not enqueue a marked row if terminal outbound proof appears before review capture', () => {
    const seq = engine.journalInbound('review-intent-late-terminal', 'review-key-5', 'review-jid-5', 'agent');
    expect(
      engine.markContinuityCandidateIfNoTerminalOutbound(
        seq,
        'crash_reclaim_no_terminal_outbound',
        'pre_connect_recovery',
      ),
    ).toBe(true);
    engine.createOutboundOp({
      conversationKey: 'review-key-5',
      chatJid: 'review-jid-5',
      opType: 'text',
      payload: '{"text":"terminal outbound appeared after marker"}',
      replayPolicy: 'unsafe',
      sourceInboundSeq: seq,
      isTerminal: true,
    });

    expect(engine.enqueueContinuityReviewIntents()).toEqual({ inserted: 0 });
    expect(reviewIntents(db)).toEqual([]);
  });

  it('does not enqueue rows with forged marker enums but no marker timestamp', () => {
    db.raw.prepare(`
      INSERT INTO inbound_events (
        message_id,
        conversation_key,
        chat_jid,
        processing_status,
        continuity_candidate_reason,
        continuity_candidate_source
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      'review-intent-forged-marker',
      'review-key-6',
      'review-jid-6',
      'failed',
      'runtime_fault_no_terminal_outbound',
      'runtime_fault_disarm',
    );

    expect(engine.enqueueContinuityReviewIntents()).toEqual({ inserted: 0 });
    expect(reviewIntents(db)).toEqual([]);
  });
});
