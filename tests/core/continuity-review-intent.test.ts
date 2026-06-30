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
  completed_by: string | null;
  completion_reason: string | null;
};

function makeDb(): Database {
  const db = new Database(':memory:');
  db.open();
  return db;
}

function reviewIntents(db: Database): ContinuityReviewIntentRow[] {
  return db.raw.prepare(`
    SELECT inbound_seq, status, reason, source, created_at, completed_at,
           completed_by, completion_reason
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
    expect(columns).toEqual([
      'inbound_seq',
      'status',
      'reason',
      'source',
      'created_at',
      'completed_at',
      'completed_by',
      'completion_reason',
    ]);
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
        completed_by: null,
        completion_reason: null,
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

  it('lists pending review intents with safe metadata and terminal-proof recheck only', () => {
    const seq = engine.journalInbound('review-intent-safe-export', 'review-key-7', 'review-jid-7', 'agent');
    expect(
      engine.markContinuityCandidateIfNoTerminalOutbound(
        seq,
        'runtime_fault_no_terminal_outbound',
        'runtime_fault_disarm',
      ),
    ).toBe(true);
    expect(engine.enqueueContinuityReviewIntents()).toEqual({ inserted: 1 });
    engine.createOutboundOp({
      conversationKey: 'review-key-7',
      chatJid: 'review-jid-7',
      opType: 'text',
      payload: '{"text":"terminal outbound appeared before review"}',
      replayPolicy: 'unsafe',
      sourceInboundSeq: seq,
      isTerminal: true,
    });

    const [item] = engine.listContinuityReviewIntentsSafe();

    expect(Object.keys(item).sort()).toEqual([
      'completedAt',
      'createdAt',
      'inboundSeq',
      'reason',
      'source',
      'status',
      'terminalOutboundExists',
    ]);
    expect(item).toEqual({
      inboundSeq: seq,
      status: 'pending_review',
      reason: 'runtime_fault_no_terminal_outbound',
      source: 'runtime_fault_disarm',
      createdAt: expect.any(String),
      completedAt: null,
      terminalOutboundExists: true,
    });
    expect(JSON.stringify(item)).not.toContain('review-jid-7');
    expect(JSON.stringify(item)).not.toContain('review-key-7');
    expect(JSON.stringify(item)).not.toContain('terminal outbound appeared before review');
  });

  it('requires operator metadata and terminal proof before resolving a review intent', () => {
    const seq = engine.journalInbound('review-intent-action', 'review-key-8', 'review-jid-8', 'agent');
    expect(
      engine.markContinuityCandidateIfNoTerminalOutbound(
        seq,
        'runtime_fault_no_terminal_outbound',
        'runtime_fault_disarm',
      ),
    ).toBe(true);
    expect(engine.enqueueContinuityReviewIntents()).toEqual({ inserted: 1 });

    expect(() =>
      engine.dismissContinuityReviewIntent(seq, {
        actor: '',
        reason: 'operator rejected duplicate candidate',
      }),
    ).toThrow(/actor/i);
    expect(() =>
      engine.dismissContinuityReviewIntent(seq, {
        actor: 'operator:q',
        reason: ' ',
      }),
    ).toThrow(/reason/i);

    expect(
      engine.resolveContinuityReviewIntent(seq, {
        actor: 'operator:q',
        reason: 'terminal proof appeared before review',
      }),
    ).toEqual({ updated: false, terminalOutboundExists: false });
    expect(reviewIntents(db)[0]).toMatchObject({
      inbound_seq: seq,
      status: 'pending_review',
      completed_at: null,
      completed_by: null,
      completion_reason: null,
    });

    engine.createOutboundOp({
      conversationKey: 'review-key-8',
      chatJid: 'review-jid-8',
      opType: 'text',
      payload: '{"text":"terminal proof for resolution"}',
      replayPolicy: 'unsafe',
      sourceInboundSeq: seq,
      isTerminal: true,
    });

    expect(
      engine.resolveContinuityReviewIntent(seq, {
        actor: 'operator:q',
        reason: 'terminal proof appeared before review',
      }),
    ).toEqual({ updated: true, terminalOutboundExists: true });
    expect(reviewIntents(db)[0]).toMatchObject({
      inbound_seq: seq,
      status: 'resolved',
      completed_at: expect.any(String),
      completed_by: 'operator:q',
      completion_reason: 'terminal proof appeared before review',
    });
  });

  it('requires operator metadata before dismissing a review intent', () => {
    const seq = engine.journalInbound('review-intent-dismiss', 'review-key-9', 'review-jid-9', 'agent');
    expect(
      engine.markContinuityCandidateIfNoTerminalOutbound(
        seq,
        'runtime_fault_no_terminal_outbound',
        'runtime_fault_disarm',
      ),
    ).toBe(true);
    expect(engine.enqueueContinuityReviewIntents()).toEqual({ inserted: 1 });

    expect(
      engine.dismissContinuityReviewIntent(seq, {
        actor: 'operator:q',
        reason: 'operator rejected duplicate candidate',
      }),
    ).toEqual({ updated: true });

    expect(reviewIntents(db)[0]).toMatchObject({
      inbound_seq: seq,
      status: 'dismissed',
      completed_at: expect.any(String),
      completed_by: 'operator:q',
      completion_reason: 'operator rejected duplicate candidate',
    });

    expect(engine.dismissContinuityReviewIntent(seq, {
      actor: 'operator:q',
      reason: 'second dismiss should not rewrite history',
    })).toEqual({ updated: false });
    expect(reviewIntents(db)[0]).toMatchObject({
      inbound_seq: seq,
      status: 'dismissed',
      completion_reason: 'operator rejected duplicate candidate',
    });
  });
});
