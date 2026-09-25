import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '../../src/core/database.ts';
import {
  CONTINUITY_CANDIDATE_FRESH_WINDOW_MS,
  DurabilityEngine,
} from '../../src/core/durability.ts';
import { resetEmitAlertThrottle } from '../../src/lib/emit-alert.ts';

function readAlerts(sink: string, source: string): Array<Record<string, unknown>> {
  if (!existsSync(sink)) return [];
  return readFileSync(sink, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((e) => e['source'] === source && e['eventType'] === 'alert');
}

const CONTINUITY_BACKLOG_ALERT_SOURCE = 'agent_continuity_candidate_backlog';

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

describe('DurabilityEngine continuity candidate reconciler', () => {
  let db: Database;
  let engine: DurabilityEngine;
  let sinkDir: string;
  let sink: string;

  beforeEach(() => {
    db = makeDb();
    engine = new DurabilityEngine(db);
    sinkDir = mkdtempSync(join(tmpdir(), 'continuity-reconcile-'));
    sink = join(sinkDir, 'alerts.jsonl');
    // Prove the in-process reconciler pages NOBODY — the out-of-process observer
    // owns the recovery-debt alert. Capture any stray emit to a file.
    process.env['WHATSOUP_ALERT_SINK'] = sink;
    process.env['EMIT_ALERT_THROTTLE_MS'] = '0';
    resetEmitAlertThrottle();
  });

  afterEach(() => {
    delete process.env['WHATSOUP_ALERT_SINK'];
    delete process.env['EMIT_ALERT_THROTTLE_MS'];
    rmSync(sinkDir, { recursive: true, force: true });
    db.close();
  });

  function markRuntimeFault(messageId: string, key: string, jid: string): number {
    const seq = engine.journalInbound(messageId, key, jid, 'agent');
    engine.markContinuityCandidateIfNoTerminalOutbound(
      seq,
      'runtime_fault_no_terminal_outbound',
      'runtime_fault_disarm',
    );
    return seq;
  }

  /** Insert a minimal terminal record so a mark's seq counts as resolved-elsewhere. */
  function resolveWithTerminalRecord(seq: number, key: string, jid: string): void {
    db.raw.prepare(`
      INSERT INTO turn_terminal_records
        (scope, conversation_key, delivery_jid, inbound_seq, inbound_seq_key,
         logical_turn_id, manager_id, generation, attempt_kind,
         inbound_disposition, delivery_kind, reply_guarantee_disarmed)
      VALUES ('per_chat', ?, ?, ?, ?, ?, 'mgr-1', 1, 'initial', 'delivered', 'sent', 0)
    `).run(key, jid, seq, seq, `lt-${seq}`);
  }

  it('reads marked-but-unconsumed rows, ordered and bounded', () => {
    const a = markRuntimeFault('reconcile-1', 'ck-1', 'jid-1');
    const b = markRuntimeFault('reconcile-2', 'ck-2', 'jid-2');

    const rows = engine.getUnconsumedContinuityCandidates();
    expect(rows.map((r) => r.seq)).toEqual([a, b]);
    expect(rows[0]).toMatchObject({
      reason: 'runtime_fault_no_terminal_outbound',
      source: 'runtime_fault_disarm',
    });
    expect(typeof rows[0].markedAt).toBe('string');

    expect(engine.getUnconsumedContinuityCandidates(1).map((r) => r.seq)).toEqual([a]);
    expect(engine.countUnconsumedContinuityCandidates()).toBe(2);
  });

  it('leaves unresolved fresh drops untouched and emits no alert', () => {
    markRuntimeFault('reconcile-1', 'ck-1', 'jid-1');
    markRuntimeFault('reconcile-2', 'ck-2', 'jid-2');

    const res = engine.reconcileContinuityCandidates(Date.now());
    expect(res).toMatchObject({ reconciled: 0, unresolvedFresh: 2, unresolvedStale: 0 });
    expect(res.newestUnresolvedMarkedAt).toEqual(expect.any(String));

    // Never auto-consumed: the observer still surfaces them; no page from us.
    expect(engine.countUnconsumedContinuityCandidates()).toBe(2);
    expect(readAlerts(sink, CONTINUITY_BACKLOG_ALERT_SOURCE).length).toBe(0);
  });

  it('reconciles a mark whose drop was resolved elsewhere: stamps consumed_at, no alert', () => {
    const a = markRuntimeFault('reconcile-1', 'ck-1', 'jid-1');
    markRuntimeFault('reconcile-2', 'ck-2', 'jid-2');
    resolveWithTerminalRecord(a, 'ck-1', 'jid-1');
    expect(engine.continuityCandidateHasTerminalOrRecovery(a)).toBe(true);

    const res = engine.reconcileContinuityCandidates(Date.now());
    expect(res).toMatchObject({ reconciled: 1, unresolvedFresh: 1, unresolvedStale: 0 });

    // Only the settled mark is stamped; the bare one is left surfaced.
    expect(engine.getUnconsumedContinuityCandidates().map((r) => r.seq)).not.toContain(a);
    expect(engine.countUnconsumedContinuityCandidates()).toBe(1);
    expect(readAlerts(sink, CONTINUITY_BACKLOG_ALERT_SOURCE).length).toBe(0);
  });

  it('is idempotent: a repeat reconcile over settled marks is a no-op', () => {
    const a = markRuntimeFault('reconcile-1', 'ck-1', 'jid-1');
    resolveWithTerminalRecord(a, 'ck-1', 'jid-1');
    engine.reconcileContinuityCandidates(Date.now());

    const res2 = engine.reconcileContinuityCandidates(Date.now());
    expect(res2).toMatchObject({ reconciled: 0, unresolvedFresh: 0, unresolvedStale: 0 });
    expect(readAlerts(sink, CONTINUITY_BACKLOG_ALERT_SOURCE).length).toBe(0);
  });

  it('no marks present is a safe no-op with no alert', () => {
    const res = engine.reconcileContinuityCandidates(Date.now());
    expect(res).toMatchObject({
      reconciled: 0,
      unresolvedFresh: 0,
      unresolvedStale: 0,
      newestUnresolvedMarkedAt: null,
    });
    expect(readAlerts(sink, CONTINUITY_BACKLOG_ALERT_SOURCE).length).toBe(0);
  });

  it('buckets unresolved drops older than the fresh window as stale, still untouched', () => {
    markRuntimeFault('reconcile-1', 'ck-1', 'jid-1');

    // The row is marked ~now; evaluate as if the clock advanced past the window.
    const future = Date.now() + CONTINUITY_CANDIDATE_FRESH_WINDOW_MS + 60_000;
    const res = engine.reconcileContinuityCandidates(future);
    expect(res).toMatchObject({ reconciled: 0, unresolvedFresh: 0, unresolvedStale: 1 });

    // Stale + unresolved is NOT reaped without a recovery path.
    expect(engine.countUnconsumedContinuityCandidates()).toBe(1);
    expect(readAlerts(sink, CONTINUITY_BACKLOG_ALERT_SOURCE).length).toBe(0);
  });

  it('a bare candidate has no terminal or recovery record (recovery deferred)', () => {
    const seq = markRuntimeFault('reconcile-1', 'ck-1', 'jid-1');
    expect(engine.continuityCandidateHasTerminalOrRecovery(seq)).toBe(false);

    const res = engine.reconcileContinuityCandidates(Date.now());
    expect(res).toMatchObject({ reconciled: 0, unresolvedFresh: 1 });
  });
});
