import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Database } from '../../src/core/database.ts';
import { DurabilityEngine } from '../../src/core/durability.ts';

type InboundContinuityRow = {
  processing_status: string;
  terminal_reason: string | null;
  continuity_candidate_reason: string | null;
  continuity_candidate_source: string | null;
  continuity_candidate_marked_at: string | null;
};

function makeDb(): Database {
  const db = new Database(':memory:');
  db.open();
  return db;
}

function getInboundContinuityRow(db: Database, seq: number): InboundContinuityRow {
  return db.raw.prepare(`
    SELECT
      processing_status,
      terminal_reason,
      continuity_candidate_reason,
      continuity_candidate_source,
      continuity_candidate_marked_at
    FROM inbound_events
    WHERE seq = ?
  `).get(seq) as InboundContinuityRow;
}

function countContinuityMarkers(db: Database): number {
  const row = db.raw.prepare(`
    SELECT COUNT(*) AS count
    FROM inbound_events
    WHERE continuity_candidate_reason IS NOT NULL
  `).get() as { count: number };
  return row.count;
}

function continuityMarkerSeqs(db: Database): number[] {
  const rows = db.raw.prepare(`
    SELECT seq
    FROM inbound_events
    WHERE continuity_candidate_reason IS NOT NULL
    ORDER BY seq ASC
  `).all() as Array<{ seq: number }>;
  return rows.map((row) => row.seq);
}

describe('DurabilityEngine continuity candidate marker', () => {
  let db: Database;
  let engine: DurabilityEngine;

  beforeEach(() => {
    db = makeDb();
    engine = new DurabilityEngine(db);
  });

  afterEach(() => {
    db.close();
  });

  it('marks restart-reclaimed processing inbound with no terminal outbound exactly once', () => {
    const seq = engine.journalInbound('marker-reclaim-1', 'continuity-key-1', 'continuity-jid-1', 'agent');

    engine.preConnectRecovery();
    const first = getInboundContinuityRow(db, seq);
    engine.preConnectRecovery();
    const second = getInboundContinuityRow(db, seq);

    expect(first.processing_status).toBe('failed');
    expect(first.terminal_reason).toBe('error');
    expect(first.continuity_candidate_reason).toBe('crash_reclaim_no_terminal_outbound');
    expect(first.continuity_candidate_source).toBe('pre_connect_recovery');
    expect(first.continuity_candidate_marked_at).toEqual(expect.any(String));
    expect(second).toEqual(first);
    expect(countContinuityMarkers(db)).toBe(1);
  });

  it('does not mark a by-design no-reply inbound', () => {
    const seq = engine.journalInbound('marker-no-reply-1', 'continuity-key-2', 'continuity-jid-2', 'agent');
    engine.markInboundSkipped(seq, 'no_reply_by_design');

    engine.preConnectRecovery();

    const row = getInboundContinuityRow(db, seq);
    expect(row.processing_status).toBe('complete');
    expect(row.terminal_reason).toBe('no_reply_by_design');
    expect(row.continuity_candidate_reason).toBeNull();
    expect(row.continuity_candidate_source).toBeNull();
    expect(row.continuity_candidate_marked_at).toBeNull();
    expect(countContinuityMarkers(db)).toBe(0);
  });

  it('does not mark an inbound that already has a terminal outbound op', () => {
    const seq = engine.journalInbound('marker-terminal-1', 'continuity-key-3', 'continuity-jid-3', 'agent');
    engine.createOutboundOp({
      conversationKey: 'continuity-key-3',
      chatJid: 'continuity-jid-3',
      opType: 'text',
      payload: '{"text":"already has terminal op"}',
      replayPolicy: 'unsafe',
      sourceInboundSeq: seq,
      isTerminal: true,
    });

    engine.preConnectRecovery();

    const row = getInboundContinuityRow(db, seq);
    expect(row.processing_status).toBe('processing');
    expect(row.continuity_candidate_reason).toBeNull();
    expect(row.continuity_candidate_source).toBeNull();
    expect(row.continuity_candidate_marked_at).toBeNull();
    expect(countContinuityMarkers(db)).toBe(0);
  });

  it('does not mark historical generic failed rows', () => {
    const seq = engine.journalInbound('marker-failed-1', 'continuity-key-4', 'continuity-jid-4', 'agent');
    engine.markInboundFailed(seq);

    engine.preConnectRecovery();

    const row = getInboundContinuityRow(db, seq);
    expect(row.processing_status).toBe('failed');
    expect(row.terminal_reason).toBe('error');
    expect(row.continuity_candidate_reason).toBeNull();
    expect(row.continuity_candidate_source).toBeNull();
    expect(row.continuity_candidate_marked_at).toBeNull();
    expect(countContinuityMarkers(db)).toBe(0);
  });

  it('marks exactly the restart-reclaimed no-terminal set in a mixed replay', () => {
    const firstReclaimed = engine.journalInbound('marker-mixed-reclaim-1', 'continuity-key-5', 'continuity-jid-5', 'agent');
    const secondReclaimed = engine.journalInbound('marker-mixed-reclaim-2', 'continuity-key-6', 'continuity-jid-6', 'agent');
    const terminalOutbound = engine.journalInbound('marker-mixed-terminal-1', 'continuity-key-7', 'continuity-jid-7', 'agent');
    const noReply = engine.journalInbound('marker-mixed-no-reply-1', 'continuity-key-8', 'continuity-jid-8', 'agent');
    const historicalFailed = engine.journalInbound('marker-mixed-failed-1', 'continuity-key-9', 'continuity-jid-9', 'agent');

    engine.createOutboundOp({
      conversationKey: 'continuity-key-7',
      chatJid: 'continuity-jid-7',
      opType: 'text',
      payload: '{"text":"terminal outbound exists"}',
      replayPolicy: 'unsafe',
      sourceInboundSeq: terminalOutbound,
      isTerminal: true,
    });
    engine.markInboundSkipped(noReply, 'no_reply_by_design');
    engine.markInboundFailed(historicalFailed);

    engine.preConnectRecovery();
    engine.preConnectRecovery();

    expect(continuityMarkerSeqs(db)).toEqual([firstReclaimed, secondReclaimed]);
    expect(countContinuityMarkers(db)).toBe(2);
    expect(getInboundContinuityRow(db, terminalOutbound).continuity_candidate_reason).toBeNull();
    expect(getInboundContinuityRow(db, noReply).continuity_candidate_reason).toBeNull();
    expect(getInboundContinuityRow(db, historicalFailed).continuity_candidate_reason).toBeNull();
  });

  it('stores runtime-fault markers only when no terminal outbound exists', () => {
    const runtimeFault = engine.journalInbound('marker-runtime-fault-1', 'continuity-key-10', 'continuity-jid-10', 'agent');
    const terminalOutbound = engine.journalInbound('marker-runtime-terminal-1', 'continuity-key-11', 'continuity-jid-11', 'agent');
    engine.createOutboundOp({
      conversationKey: 'continuity-key-11',
      chatJid: 'continuity-jid-11',
      opType: 'text',
      payload: '{"text":"terminal outbound exists"}',
      replayPolicy: 'unsafe',
      sourceInboundSeq: terminalOutbound,
      isTerminal: true,
    });

    expect(engine.markContinuityCandidateIfNoTerminalOutbound(
      runtimeFault,
      'runtime_fault_no_terminal_outbound',
      'runtime_fault_disarm',
    )).toBe(true);
    expect(engine.markContinuityCandidateIfNoTerminalOutbound(
      terminalOutbound,
      'runtime_fault_no_terminal_outbound',
      'runtime_fault_disarm',
    )).toBe(false);

    const marked = getInboundContinuityRow(db, runtimeFault);
    expect(marked.continuity_candidate_reason).toBe('runtime_fault_no_terminal_outbound');
    expect(marked.continuity_candidate_source).toBe('runtime_fault_disarm');
    expect(getInboundContinuityRow(db, terminalOutbound).continuity_candidate_reason).toBeNull();
  });
});
